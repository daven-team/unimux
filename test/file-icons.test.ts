// File-type icons: which glyph a name gets (shared/fileIcons.ts), the pixel-grid paths, and the rendered glyphs
// (components/FileIcon.tsx, with no DOM): every glyph is a 16 px SVG drawn 1:1, without SVG text.
import { beforeAll, describe, expect, it } from 'vitest';
import { FILE_ICON_IDS, fileIconId, pixelPath, type FileIconId } from '../src/shared/fileIcons';

let mod: any;
let react: any;
let server: any;
beforeAll(async () => {
  const modulePath = '../src/renderer/src/components/FileIcon';
  mod = await import(/* @vite-ignore */ modulePath);
  react = await import('react');
  server = await import('react-dom/server');
});
const render = (type: unknown, props: object): string => server.renderToStaticMarkup(react.createElement(type, props));

describe('file icon mapping', () => {
  const cases: [string, FileIconId][] = [
    ['index.ts', 'ts'], ['types.d.ts', 'ts'], ['vite.mts', 'ts'], ['App.tsx', 'tsx'], ['main.js', 'js'], ['x.mjs', 'js'], ['x.cjs', 'js'], ['Button.jsx', 'jsx'],
    ['data.json', 'json'], ['settings.jsonc', 'json'], ['tsconfig.node.tsbuildinfo', 'json'],
    ['README.md', 'markdown'], ['page.mdx', 'mdx'], ['styles.css', 'css'], ['theme.scss', 'scss'], ['index.html', 'html'], ['pom.xml', 'xml'],
    ['ci.yml', 'yaml'], ['config.yaml', 'yaml'], ['pyproject.toml', 'toml'], ['setup.cfg', 'config'], ['php.ini', 'config'], ['.editorconfig', 'config'],
    ['.env', 'env'], ['.env.local', 'env'], ['.env.production', 'env'], ['prod.env', 'env'],
    ['yarn.lock', 'lock'], ['Cargo.lock', 'lock'], ['pnpm-lock.yaml', 'lock'], ['deps.lock', 'lock'],
    ['build.sh', 'shell'], ['.bashrc', 'shell'], ['install.ps1', 'powershell'], ['run.bat', 'batch'], ['run.cmd', 'batch'],
    ['main.py', 'python'], ['main.go', 'go'], ['go.mod', 'go'], ['lib.rs', 'rust'], ['App.java', 'java'],
    ['main.c', 'c'], ['main.cpp', 'cpp'], ['util.h', 'header'], ['util.hpp', 'header'], ['Program.cs', 'csharp'], ['index.php', 'php'], ['app.rb', 'ruby'], ['Gemfile', 'ruby'],
    ['schema.sql', 'sql'], ['app.sqlite', 'sql'], ['data.csv', 'csv'], ['logo.svg', 'svg'],
    ['a.png', 'image'], ['a.jpg', 'image'], ['a.gif', 'image'], ['a.webp', 'image'], ['favicon.ico', 'image'],
    ['doc.pdf', 'pdf'], ['dist.zip', 'archive'], ['src.tar.gz', 'archive'], ['notes.txt', 'text'], ['debug.log', 'log'],
    ['Dockerfile', 'docker'], ['Dockerfile.dev', 'docker'], ['docker-compose.yml', 'docker'], ['.dockerignore', 'docker'],
    ['Makefile', 'make'], ['CMakeLists.txt', 'make'], ['LICENSE', 'license'], ['LICENSE.md', 'license'], ['license-mit', 'license'], ['COPYING', 'license'],
    ['.gitignore', 'git'], ['.gitattributes', 'git'], ['.gitmodules', 'git'], ['.npmrc', 'npm'],
    ['package.json', 'node'], ['package-lock.json', 'node'], ['.nvmrc', 'node'],
    ['tsconfig.json', 'tsconfig'], ['tsconfig.web.json', 'tsconfig'], ['tsconfig.node.json', 'tsconfig'], ['jsconfig.json', 'jsconfig'],
    ['vite.config.ts', 'vite'], ['vite.config.mjs', 'vite'], ['vitest.config.ts', 'vitest'], ['vitest.workspace.ts', 'vitest'],
    ['App.vue', 'vue'], ['App.svelte', 'svelte'],
  ];
  it.each(cases)('%s -> %s', (name, id) => expect(fileIconId(name)).toBe(id));

  it('ignores case and folders in either separator style', () => {
    expect(fileIconId('SRC/Main.TS')).toBe('ts');
    expect(fileIconId('C:\\repo\\docs\\README.MD')).toBe('markdown');
    expect(fileIconId('a/b/.GITIGNORE')).toBe('git');
  });

  it('keeps names that only look like a special file on their extension', () => {
    expect(fileIconId('electron.vite.config.ts')).toBe('ts');
    expect(fileIconId('my-tsconfig.json')).toBe('json');
    expect(fileIconId('package.json.bak')).toBe('file');
    expect(fileIconId('licenses.ts')).toBe('ts');
  });

  it('falls back to the plain file for unknown, missing and dot-only extensions', () => {
    for (const name of ['bash.exe.stackdump', 'README', 'archive.unknownext', '', '.', 'name.']) expect(fileIconId(name)).toBe('file');
  });
});

describe('pixelPath', () => {
  it('turns runs of pixels into whole-pixel rectangles', () => {
    expect(pixelPath(['##.#'], 1, 2)).toBe('M1 2h2v1h-2zM4 2h1v1h-1z');
    expect(pixelPath([])).toBe('');
    expect(pixelPath(['....'])).toBe('');
  });

  it('grows one rectangle over rows with the same run and starts a new one when the run changes', () => {
    expect(pixelPath(['##', '##', '#.'])).toBe('M0 0h2v2h-2zM0 2h1v1h-1z');
    // A run interrupted by an empty row is two rectangles.
    expect(pixelPath(['#', '', '#'], 3, 0)).toBe('M3 0h1v1h-1zM3 2h1v1h-1z');
  });

  it('draws only the requested pixel character', () => {
    expect(pixelPath(['by', 'yb'], 0, 0, 'y')).toBe('M1 0h1v1h-1zM0 1h1v1h-1z');
  });
});

describe('FileIcon glyphs', () => {
  it.each(FILE_ICON_IDS)('%s is a 16 px SVG drawn at 1:1, without text', (id) => {
    const html = render(mod.FileTypeIcon, { id });
    expect(html).toMatch(/^<span class="file-type-icon" data-icon="[a-z]+" style="color:#[0-9a-f]{6}" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"/);
    expect(html).toContain(`data-icon="${id}"`);
    expect(html).not.toMatch(/<text|<image|font-size/i);
    // The pixel-grid shapes use whole-pixel coordinates only.
    for (const [, d] of html.matchAll(/<path d="([^"]+)"[^>]*shape-rendering="crispEdges"/g)) expect(d).toMatch(/^[MhvzZ\d -]+$/);
  });

  it('no two icons are drawn the same', () => {
    const drawn = new Map<string, FileIconId>();
    for (const id of FILE_ICON_IDS) {
      const html = render(mod.FileTypeIcon, { id }).replace(/data-icon="[a-z]+"/, '').replace(/id="[^"]*"|url\(#[^)]*\)/g, '');
      const same = drawn.get(html);
      expect(same, `${id} is drawn exactly like ${same}`).toBeUndefined();
      drawn.set(html, id);
    }
  });

  it('FileIcon draws the icon of the name', () => {
    expect(render(mod.FileIcon, { name: 'src/App.tsx' })).toContain('data-icon="tsx"');
    expect(render(mod.FileIcon, { name: 'whatever.unknown' })).toContain('data-icon="file"');
  });

  it('folders are thin outlines, open when expanded, with the git dot cut into the corner', () => {
    const closed = render(mod.FolderIcon, {});
    const open = render(mod.FolderIcon, { open: true });
    expect(closed).toContain('class="explorer-folder-icon "');
    expect(open).toContain('class="explorer-folder-icon open"');
    expect(closed).not.toBe(open.replace(' open"', ' "'));
    expect(closed).not.toContain('<mask');
    const dotted = render(mod.FolderIcon, { dot: 'mod' });
    expect(dotted).toContain('class="folder-dot mod"');
    const mask = /<mask id="([^"]+)"/.exec(dotted)?.[1];
    expect(mask).toBeTruthy();
    expect(dotted).toContain(`mask="url(#${mask})"`);
  });

  it('the chevron is a 16 px box like the icons', () => {
    expect(render(mod.TreeChevron, {})).toMatch(/^<svg width="16" height="16" viewBox="0 0 16 16"/);
  });
});
