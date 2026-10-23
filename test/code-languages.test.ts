import { beforeAll, describe, expect, it } from 'vitest';
import { escapeHtml, highlightRuns, normalizeCodeLanguage, resolveCodeLanguage, runsToHtml } from '../src/shared/codeLanguages';
import { normalizeNotes, notePreviewMarkdown } from '../src/shared/notes';
import type { HighlightRange } from '../src/shared/codeLanguages';

// The renderer is not part of the node tsconfig: loaded through a variable, so tsc does not follow the imports.
const highlightPath = '../src/renderer/src/codeHighlight';
let highlightHtml: (text: string, id: string, marks?: readonly HighlightRange[]) => string;
beforeAll(async () => { ({ highlightHtml } = await import(/* @vite-ignore */ highlightPath)); });

describe('code languages of notes and snippets', () => {
  it('resolves fence info strings and aliases', () => {
    expect(resolveCodeLanguage('ts')).toBe('typescript');
    expect(resolveCodeLanguage('bash title="x"')).toBe('shell');
    expect(resolveCodeLanguage('{.python}')).toBe('python');
    expect(resolveCodeLanguage('language-sql')).toBe('sql');
    expect(resolveCodeLanguage('C++')).toBe('cpp');
    expect(resolveCodeLanguage('pwsh')).toBe('powershell');
    expect(resolveCodeLanguage('cobol')).toBeNull();
    expect(resolveCodeLanguage('')).toBeNull();
    expect(resolveCodeLanguage(undefined)).toBeNull();
  });

  it('keeps only known saved languages', () => {
    expect(normalizeCodeLanguage('sql')).toBe('sql');
    expect(normalizeCodeLanguage('ts')).toBeUndefined();
    expect(normalizeCodeLanguage(3)).toBeUndefined();
  });

  it('keeps the language of a note and drops an unknown one, old notes stay as they were', () => {
    const [withLanguage, unknown, old] = normalizeNotes([
      { id: 'a', name: 'A', text: 'select 1', updatedAt: 1, language: 'sql' },
      { id: 'b', name: 'B', text: 'x', updatedAt: 1, language: 'klingon' },
      { id: 'c', name: 'C', text: 'plain', updatedAt: 1 },
    ]);
    expect(withLanguage.language).toBe('sql');
    expect(unknown).not.toHaveProperty('language');
    expect(old).toEqual({ id: 'c', name: 'C', text: 'plain', updatedAt: 1 });
  });

  it('previews a Markdown note as it is and a code note as one fenced block', () => {
    expect(notePreviewMarkdown('# A', 'markdown')).toBe('# A');
    expect(notePreviewMarkdown('# A')).toBe('# A');
    expect(notePreviewMarkdown('select 1', 'sql')).toBe('```sql\nselect 1\n```\n');
    expect(notePreviewMarkdown('a ```` b', 'text')).toBe('`````\na ```` b\n`````\n');
  });

  it('lays marks over highlighted ranges', () => {
    const text = 'echo "a {{x}} b" c';
    const runs = highlightRuns(text, [{ from: 0, to: 4, cls: 'kw' }, { from: 5, to: 16, cls: 'str' }], [{ from: 8, to: 13, cls: 'var' }]);
    expect(runs).toEqual([
      { text: 'echo', cls: 'kw' }, { text: ' ', cls: '' }, { text: '"a ', cls: 'str' }, { text: '{{x}}', cls: 'str var' },
      { text: ' b"', cls: 'str' }, { text: ' c', cls: '' },
    ]);
    expect(runs.map((r) => r.text).join('')).toBe(text);
    expect(highlightRuns('', [])).toEqual([]);
  });

  it('escapes HTML of the text and the classes', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(runsToHtml([{ text: '<b>', cls: 'tok-x' }, { text: '&', cls: '' }])).toBe('<span class="tok-x">&lt;b&gt;</span>&amp;');
  });

  it('highlights code statically, also the fenced blocks of Markdown', () => {
    const ts = highlightHtml('const x: number = 1; // c', 'typescript');
    expect(ts).toContain('<span class="tok-keyword">const</span>');
    expect(ts).toContain('tok-comment');
    const shell = highlightHtml('echo "hi" # c', 'shell');
    expect(shell).toContain('tok-string');
    expect(shell).toContain('tok-comment');
    const md = highlightHtml('# Title\n\n```ts\nconst a = 1;\n```\n', 'markdown');
    expect(md).toContain('tok-heading');
    expect(md).toContain('<span class="tok-keyword">const</span>');
    const sql = highlightHtml('SELECT 1 FROM t', 'sql');
    expect(sql).toContain('tok-keyword');
    expect(highlightHtml('<b> & {{x}}', 'text', [{ from: 6, to: 11, cls: 'snip-var' }])).toBe('&lt;b&gt; &amp; <span class="snip-var">{{x}}</span>');
  });
});
