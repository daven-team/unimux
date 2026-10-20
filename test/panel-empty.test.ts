// The empty state of the side panels (PanelEmpty.tsx), drawn with no DOM: sentences with links at their tokens, links that
// are real buttons, and the panels that use it instead of the old centred block with a big icon.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { translate } from '../src/shared/i18n';
import { LANGUAGES } from '../src/shared/languages';

let mod: any;
let react: any;
let server: any;
beforeAll(async () => {
  const modulePath = '../src/renderer/src/components/PanelEmpty';
  mod = await import(/* @vite-ignore */ modulePath);
  react = await import('react');
  server = await import('react-dom/server');
});

const html = (node: unknown) => server.renderToStaticMarkup(node);

describe('PanelEmpty', () => {
  it('puts elements at the tokens of a sentence and keeps the rest of the text in its order', () => {
    const { fillTokens } = mod;
    const b = (text: string) => react.createElement('b', null, text);
    expect(html(fillTokens('Add a {postgres} or {redis} connection.', { postgres: b('PG'), redis: b('RD') })))
      .toBe('Add a <b>PG</b> or <b>RD</b> connection.');
    expect(html(fillTokens('{link} first', { link: b('L') }))).toBe('<b>L</b> first');
    // A token without an element stays as text (never an empty hole in the sentence).
    expect(html(fillTokens('keep {other}', { link: b('L') }))).toBe('keep {other}');
  });

  it('draws a link as a keyboard-reachable button with its accessible name, and the main action as a full-width primary button', () => {
    const { PanelEmpty, EmptyLink } = mod;
    const out = html(react.createElement(PanelEmpty, { className: 'db-empty', role: 'alert' },
      react.createElement('p', null, react.createElement(EmptyLink, { onClick: () => {}, label: 'New connection: Redis' }, 'Redis')),
      react.createElement('button', { className: 'btn primary' }, 'New connection')));
    expect(out).toContain('<div class="panel-empty db-empty" role="alert">');
    // No href: nothing can open it as a page (a middle click, a drag onto a terminal).
    expect(out).toContain('<a class="panel-empty-link" role="button" tabindex="0" title="New connection: Redis" aria-label="New connection: Redis">Redis</a>');
    expect(out).toContain('<button class="btn primary">New connection</button>');
    const css = readFileSync('src/renderer/src/components/panelEmpty.css', 'utf8');
    expect(css).toMatch(/\.panel-empty > \.btn \{ width: 100%; \}/);
    expect(css).toMatch(/\.panel-empty-link:focus-visible \{ outline:/);
    expect(css).not.toMatch(/justify-content: center|text-align: center/);
  });

  it('runs a link with a click, Enter or Space, and leaves other keys alone', () => {
    const { EmptyLink } = mod;
    let runs = 0;
    const link = EmptyLink({ onClick: () => { runs++; }, children: 'Redis' });
    link.props.onClick();
    const press = (key: string) => {
      let prevented = false;
      link.props.onKeyDown({ key, preventDefault: () => { prevented = true; } });
      return prevented;
    };
    expect(press('Enter')).toBe(true);
    expect(press(' ')).toBe(true);
    expect(press('Tab')).toBe(false);
    expect(runs).toBe(3);
  });

  it('keeps both links of the database sentence in every language', () => {
    for (const { code } of LANGUAGES) {
      const text = translate(code, 'Dodaj połączenie z bazą {postgres} lub {redis}.');
      expect(text, code).toContain('{postgres}');
      expect(text, code).toContain('{redis}');
      expect(translate(code, 'Możesz też {link}.'), code).toContain('{link}');
    }
  });

  it('is what the side panels show when they are empty (no centred block with a big icon left)', () => {
    const read = (file: string) => readFileSync(`src/renderer/src/components/${file}`, 'utf8');
    for (const file of ['ProjectsPanel.tsx', 'SnippetPanel.tsx', 'db/DbPanel.tsx', 'LazyScreen.tsx']) {
      const source = read(file);
      expect(source, file).toMatch(/<PanelEmpty[ >]/);
      expect(source, file).not.toMatch(/empty-state|es-icon/);
    }
    const db = read('db/DbPanel.tsx');
    expect(db).toContain("onClick={() => openNewConnection('postgres')}>PostgreSQL</EmptyLink>");
    expect(db).toContain("onClick={() => openNewConnection('redis')}>Redis</EmptyLink>");
    expect(readFileSync('src/renderer/src/styles.css', 'utf8')).not.toMatch(/\.empty-state|\.es-icon/);
    // A side panel that fails to load says so at its top too.
    const registry = readFileSync('src/renderer/src/panelRegistry.tsx', 'utf8');
    expect(registry).toContain('<LazyScreen load={loadDbPanel} panel />');
  });
});
