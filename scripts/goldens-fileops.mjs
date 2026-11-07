// The file-operations part of the golden corpus (1.2.0, PLAN G6), used by scripts/dump-goldens.mjs. Every answer comes from the
// real TS code of 1.1.4 (src/shared/fileOps.ts, src/shared/sftp.ts, src/main/fileOps.ts and src/main/localFiles.ts on files in a
// scratch folder, Node's path module):
//
//   test/golden/files-ops.jsonl  {fn, args, out}            the pure helpers (toPosix, topLevelPaths, validPathList,
//                                                            validateEntryName, copyName, safeEntryName, permissionString,
//                                                            isBundleName, path.win32 / path.posix dirname and basename)
//                                {op, args, out, tree, trash} one operation of src/main/fileOps.ts on a fresh copy of the
//                                                            fixture project (rename / create / delete / transfer); `tree` is
//                                                            the project afterwards ({path: text, folder: null}), `trash` the
//                                                            names that went to the trash in order
//                                {pane, args, out, tree}     one call of the local pane (createLocalFiles) on a fresh scratch
//                                                            folder; absolute paths are written `<dir>` and listing times
//                                                            `<mtime>`
// The rows are made on Windows (the dev box): their names follow `platform: 'win32'`; rows whose answer depends on a
// case-insensitive disk say `caseFold: true`.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { basename, join } from 'node:path';

const BASE = {
  'a.txt': 'A',
  'src/b.txt': 'B',
  'src/deep/c.txt': 'C',
  'docs/a.txt': 'other A',
};

function build(root, files, dirs = []) {
  mkdirSync(root, { recursive: true });
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

/** The project as {rel: text | null}, names in code-unit order. */
function tree(root, prefix = '', out = {}) {
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) { out[rel] = null; tree(root, rel, out); } else out[rel] = readFileSync(join(root, rel), 'utf8');
  }
  return out;
}

function helperRows({ shared, sftp, localFiles }) {
  const rows = [];
  const add = (fn, args, out) => rows.push({ fn, args, out });
  for (const p of ['', '/', '//', 'a', '/a/', '\\a\\\\b\\', 'a//b///c', 'x\\y/z', 'ł/ż\\ź', '///a///']) add('toPosix', [p], shared.toPosix(p));
  for (const list of [['a/b', 'a', 'c', 'c'], ['a-b', 'a', 'a/c', 'a-b/d', 'z/y', 'z'], ['', 'a', 'b/c'], ['a/b/c', 'a/b', 'a'], ['x', 'x/', 'x//y'],
    ['src/deep/c.txt', 'src'], ['/a', 'a'], ['ą/ę', 'ą']]) add('topLevelPaths', [list], shared.topLevelPaths(list));
  for (const list of [['a'], [], 'a', [1], ['a'.repeat(4096)], ['a'.repeat(4097)], ['ł'.repeat(4096)], Array(5000).fill('a'), Array(5001).fill('a'), [null], [{}]]) {
    add('validPathList', [list.length > 10 ? { repeat: list[0], count: list.length } : list], shared.validPathList(list));
  }
  const names = ['ok.txt', '', '  ', '\u00a0', '\u3000x', '\u0085', '\ufeff', '\u180e', '.', '..', '...', 'a/b', 'a\\b', 'a\0b', 'x.', 'x ', ' x', 'con', 'CON', 'Con.txt',
    'console.txt', 'nul.tar.gz', 'aux.', 'prn ', 'conin$', 'CONOUT$.log', 'clock$', 'com0', 'COM1', 'com¹', 'LPT².x', 'lpt³', 'com10', 'lpt', 'con.\u2028', 'con.\n',
    'con.x\u2029', 'a:b', 'a?b', 'a*b', 'a"b', 'a<b>', 'a|b', 'tab\tx', '\u001f', '\u007f', 'a'.repeat(255), 'a'.repeat(256), 'ż'.repeat(255), '😀'.repeat(127), '😀'.repeat(128),
    'ſon', 'ᴄon', 'ﬁle', 'Ꮯon'];
  for (const name of names) for (const platform of ['win32', 'darwin', 'linux']) add('validateEntryName', [name, platform], shared.validateEntryName(name, platform));
  for (const name of names) for (const windows of [true, false]) add('safeEntryName', [name, { windows }], sftp.safeEntryName(name, { windows }));
  for (const [name, n, dir] of [['a.txt', 1, false], ['a.txt', 2, false], ['a copy.txt', 1, false], ['a copy 2.txt', 3, false], ['.env', 1, false], ['v1.2', 1, true],
    ['archive.tar.gz', 1, false], ['a copy copy', 1, false], ['a copy x.txt', 2, false], ['a copy  2', 1, false], ['a copy 12', 4, false], ['.', 1, false], ['a.', 1, false],
    ['noext', 9999, false], ['folder.d', 1, true], ['łódź.md', 2, false], ['x copy ٣.txt', 1, false], ['😀.txt', 1, false]]) add('copyName', [name, n, dir], shared.copyName(name, n, dir));
  for (const mode of [0o40755, 0o100644, 0o104755, 0o102755, 0o41777, 0o41776, 0o120777, 0o140755, 0o60660, 0o20620, 0o10644, 0o7777, 0, 0o104644, 0o102644, 0o101644]) {
    add('permissionString', [mode], sftp.permissionString(mode));
  }
  for (const name of ['Foo.app', '.config.d', '.app', 'Plain', 'a.', 'a.b-c', 'x.PKG', 'a.b.c', '.a.b', 'ł.app', 'a.ą']) add('isBundleName', [name], localFiles.isBundleName(name));
  const winPaths = ['', 'C:', 'C:\\', 'C:\\a', 'C:\\a\\', 'C:\\a\\b', 'C:a', 'c:/x/y', '\\', '\\\\', '\\\\server', '\\\\server\\share', '\\\\server\\share\\', '\\\\server\\share\\a',
    '\\\\?\\C:\\a', '/a/b', 'a', 'a\\b', 'D:\\Projekt Ł\\plik.txt', 'C:\\a\\\\b\\\\', 'x:'];
  for (const p of winPaths) { add('win32.dirname', [p], path.win32.dirname(p)); add('win32.basename', [p], path.win32.basename(p)); }
  for (const p of ['', '/', '//', '///a', '/a', '/a/', '/a/b', 'a', 'a/b', '/a//b//', '/Users/Ł/x.app', '//x']) { add('posix.dirname', [p], path.posix.dirname(p)); add('posix.basename', [p], path.posix.basename(p)); }
  return rows;
}

const OPS = [
  // rename
  ['rename', 'a.txt', 'z.txt'], ['rename', 'src/deep', 'inner'], ['rename', 'a.txt', 'docs'], ['rename', 'a.txt', 'a.txt'], ['rename', 'a.txt', 'A.txt', { caseFold: true }],
  ['rename', 'docs', 'DOCS', { caseFold: true }], ['rename', 'a.txt', 'src', {}], ['rename', '', 'x'], ['rename', '../outside.txt', 'x'], ['rename', 'src/../../outside.txt', 'x'],
  ['rename', './a.txt', 'x'], ['rename', 'C:a.txt', 'x'], ['rename', '\\a.txt', 'x'], ['rename', 'src\\b.txt', 'B2.txt'], ['rename', 'src//deep/', 'd2'], ['rename', 'ghost', 'x'],
  ['rename', 'ghost/x', 'y'], ['rename', 'a.txt', ''], ['rename', 'a.txt', '  '], ['rename', 'a.txt', 'CON'], ['rename', 'a.txt', 'nul.txt'], ['rename', 'a.txt', 'a.'],
  ['rename', 'a.txt', 'a:b'], ['rename', 'a.txt', 'x/y'], ['rename', 'a.txt', '..'], ['rename', 'a.txt', 5], ['rename', 5, 'x'], ['rename', 'a.txt', 'a'.repeat(256)],
  ['rename', 'a.txt', 'żółć.txt'], ['rename', 'a.txt', 'clock$'], ['rename', 'a'.repeat(4097), 'x'],
  // create
  ['create', 'src', 'new.txt', 'file'], ['create', '', 'dir', 'directory'], ['create', 'src', 'b.txt', 'file'], ['create', 'src', 'deep', 'directory'], ['create', '..', 'x.txt', 'file'],
  ['create', 'a.txt', 'x.txt', 'file'], ['create', 'nope', 'x.txt', 'file'], ['create', 'src', 5, 'file'], ['create', 'src', 'A.TXT', 'file'], ['create', 5, 'x', 'file'],
  ['create', 'docs', 'A.txt', 'file', { caseFold: true }], ['create', 'src/deep', 'x?', 'file'], ['create', 'src', 'x', 'weird'],
  // delete
  ['delete', ['a.txt', 'src']], ['delete', ['src', 'src/b.txt']], ['delete', ['']], ['delete', []], ['delete', ['../outside.txt']], ['delete', 'a.txt'], ['delete', [5]],
  ['delete', ['ghost', 'a.txt']], ['delete', ['ghost/x']], ['delete', ['a.txt', 'a.txt', 'docs/a.txt']], ['delete', ['', 'a.txt']],
  // transfer
  ['transfer', { kind: 'move', paths: ['a.txt'], destination: 'docs', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['a.txt'], destination: 'docs', conflict: 'replace' }],
  ['transfer', { kind: 'move', paths: ['a.txt'], destination: 'docs', conflict: 'keepBoth' }],
  ['transfer', { kind: 'move', paths: ['a.txt', 'src/b.txt'], destination: 'docs', conflict: 'skip' }],
  ['transfer', { kind: 'move', paths: ['a.txt', 'src'], destination: 'docs', conflict: 'replace' }],
  ['transfer', { kind: 'move', paths: ['src/deep'], destination: '', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['src/deep'], conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['src'], destination: 'src', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['src'], destination: 'src/deep', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['src'], destination: 'src/deep', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['src/b.txt'], destination: 'src', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['a.txt'], destination: 'src/b.txt', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['a.txt'], destination: 'nope', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['src', 'src/deep/c.txt'], destination: 'docs', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['ghost.txt'], destination: 'docs', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['src'], destination: 'docs', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['a.txt'], destination: '', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['src'], destination: '', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['a.txt', 'docs/a.txt'], destination: 'src', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['a.txt', 'docs/a.txt'], destination: 'src', conflict: 'replace' }],
  ['transfer', { kind: 'copy', paths: ['a.txt', 'docs/a.txt'], destination: 'src', conflict: 'skip' }],
  ['transfer', { kind: 'copy', paths: ['a.txt', 'docs/a.txt'], destination: '', conflict: 'replace' }],
  ['transfer', { kind: 'copy', paths: ['docs/a.txt'], destination: '', conflict: 'replace' }],
  ['transfer', { kind: 'copy', paths: ['docs'], destination: '', conflict: null }],
  ['transfer', { kind: 'copy', paths: ['a.txt'], destination: 'docs', conflict: 'keepBoth', force: 1 }],
  ['transfer', { kind: 'move', paths: ['a.txt'], destination: 'docs', conflict: 'bogus' }],
  ['transfer', { kind: 'move', paths: ['a.txt'], destination: 'docs', conflict: 'REPLACE' }],
  ['transfer', { kind: 'move', paths: ['a.txt'], destination: 'docs', conflict: 1 }],
  ['transfer', { kind: 'cut', paths: ['a.txt'], destination: 'docs', conflict: 'ask' }],
  ['transfer', { paths: ['a.txt'], destination: 'docs' }],
  ['transfer', { kind: 'copy', paths: 'a.txt', destination: 'docs', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: [], destination: 'docs', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: [42], destination: 'docs', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['a.txt'], destination: 5, conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['a.txt'], destination: '../', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: [''], destination: 'docs', conflict: 'ask' }],
  ['transfer', null], ['transfer', [1]], ['transfer', 'x'],
  ['transfer', { kind: 'move', paths: ['docs/a.txt', 'a.txt'], destination: 'src', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['docs/a.txt', 'a.txt'], destination: 'src', conflict: 'replace' }],
  ['transfer', { kind: 'move', paths: ['docs/a.txt', 'a.txt'], destination: 'src', conflict: 'skip' }],
  ['transfer', { kind: 'move', paths: ['docs/a.txt', 'a.txt'], destination: 'src', conflict: 'keepBoth' }],
  ['transfer', { kind: 'move', paths: ['src/deep/c.txt'], destination: '', conflict: 'ask' }],
  ['transfer', { kind: 'move', paths: ['docs'], destination: 'src', conflict: 'ask' }],
  ['transfer', { kind: 'copy', paths: ['a.txt'], destination: 'DOCS', conflict: 'ask' }, { caseFold: true }],
  ['transfer', { kind: 'move', paths: ['A.TXT'], destination: 'docs', conflict: 'ask' }, { caseFold: true }],
];

const PANE = [
  ['list', '<dir>'], ['list', 'relative'], ['list', '<dir>/a.txt'], ['list', '<dir>/gone'], ['list', 5], ['list', ''],
  ['mkdir', '<dir>/new'], ['mkdir', '<dir>/sub'], ['mkdir', '<dir>/x?y'], ['mkdir', '<dir>/NUL'], ['mkdir', '<dir>/gone/deeper'], ['mkdir', 'rel'], ['mkdir', '<dir>/dot.'],
  ['rename', '<dir>/a.txt', '<dir>/sub'], ['rename', '<dir>/a.txt', '<dir>/sub/moved.txt'], ['rename', '<dir>/a.txt', '<dir>/b.txt'], ['rename', '<dir>/a.txt', '<dir>/A.TXT', { caseFold: true }],
  ['rename', '<dir>/gone', '<dir>/x'], ['rename', '<dir>/a.txt', '<dir>/con'], ['rename', '<dir>/a.txt', 'rel'], ['rename', '<dir>/sub', '<dir>/Sub2'],
  ['trash', ['<dir>/a.txt']], ['trash', ['<dir>']], ['trash', []], ['trash', 'x'], ['trash', ['<dir>/a.txt', '<dir>/gone', '<dir>/sub']], ['trash', ['C:\\']], ['trash', ['rel']],
  ['reveal', '<dir>/sub'], ['reveal', '<dir>/a.txt'], ['reveal', '<dir>/gone'], ['reveal', 'rel'],
];

export async function fileOpsGoldens(load) {
  const [shared, sftp, ops, localFiles] = await Promise.all([
    load('src/shared/fileOps.ts'), load('src/shared/sftp.ts'), load('src/main/fileOps.ts'), load('src/main/localFiles.ts'),
  ]);
  const rows = helperRows({ shared, sftp, localFiles });
  const scratch = mkdtempSync(join(tmpdir(), 'unimux-g6-goldens-'));
  try {
    let n = 0;
    for (const [op, ...rest] of OPS) {
      const fixture = join(scratch, `op${n++}`);
      const root = join(fixture, 'project');
      const trashDir = join(fixture, 'trash');
      build(root, BASE);
      mkdirSync(trashDir);
      writeFileSync(join(fixture, 'outside.txt'), 'outside');
      const trashed = [];
      const trash = async (p) => { trashed.push(basename(p)); renameSync(p, join(trashDir, `${trashed.length}-${basename(p)}`)); };
      const last = rest.at(-1);
      const extra = last && typeof last === 'object' && !Array.isArray(last) && op !== 'transfer' ? rest.pop() : op === 'transfer' && rest.length > 1 ? rest.pop() : {};
      const args = rest;
      let out;
      if (op === 'rename') out = await ops.renameProjectEntry(root, args[0], args[1], { platform: 'win32' });
      else if (op === 'create') out = await ops.createProjectEntry(root, args[0], args[1], args[2] === 'directory' ? 'directory' : 'file', { platform: 'win32' });
      else if (op === 'delete') out = await ops.deleteProjectEntries(root, args[0], { trash });
      else out = await ops.transferProjectEntries(root, args[0], { trash, platform: 'win32' });
      rows.push({ op, args, out, tree: tree(root), trash: trashed, ...(extra.caseFold ? { caseFold: true } : {}) });
    }
    for (const [fn, ...rest] of PANE) {
      const dir = join(scratch, `pane${n++}`);
      build(dir, { 'a.txt': 'abc', 'sub/x.txt': 'x', '.hidden': '' });
      const extra = rest.length > 1 && rest.at(-1) && typeof rest.at(-1) === 'object' && !Array.isArray(rest.at(-1)) ? rest.pop() : {};
      const args = rest;
      const fill = (v) => (typeof v === 'string' ? v.replace('<dir>', dir).replace(/\//g, path.sep) : Array.isArray(v) ? v.map(fill) : v);
      const calls = [];
      const lf = localFiles.createLocalFiles({
        platform: 'win32', home: () => dir,
        trash: async (p) => { calls.push(`trash ${p}`); rmSync(p, { recursive: true }); if (p.endsWith('gone')) throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
        openFolder: async (p) => { calls.push(`open ${p}`); }, showFile: (p) => { calls.push(`show ${p}`); },
      });
      const filled = args.map((a) => (fn === 'trash' ? (Array.isArray(a) ? a.map(fill) : a) : fill(a)));
      let out = await lf[fn](...filled);
      const mask = (v) => {
        if (typeof v === 'string') return v.split(dir).join('<dir>');
        if (Array.isArray(v)) return v.map(mask);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'mtime' ? '<mtime>' : mask(x)]));
        return v;
      };
      out = mask(out);
      if (out?.ok && Array.isArray(out.value?.entries)) out.value.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      rows.push({ pane: fn, args, out, calls: mask(calls), tree: tree(dir), ...(extra.caseFold ? { caseFold: true } : {}) });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return rows;
}
