// The project-files part of the golden corpus (1.2.0, PLAN G5), used by scripts/dump-goldens.mjs. Every answer comes from the
// real TS code of 1.1.4 (src/main/files.ts on files in a scratch folder, Node's path module, V8's Intl.Collator):
//
//   test/golden/files-collate.jsonl  {names} -> the order of Intl.Collator('pl', {numeric, sensitivity: 'base'}) (stable sort)
//   test/golden/files-path.jsonl     {flavor, root, rel} -> path[flavor].resolve(root, rel), isAbsolute(rel) and 1.1.4's isInside
//   test/golden/files-preview.jsonl  {name, prefix, padA, bytes, large} -> readProjectFile (the file is `prefix`, `padA` bytes of 'a',
//                                     then `bytes`, base64; a text answer of a padded row keeps only what follows the padding)
//   test/golden/files-save.jsonl     {bytes, text, expected, padText} -> writeProjectFile and the file's bytes afterwards
//   test/golden/files-parquet.jsonl  {name} -> readProjectFile(test/golden/parquet, name, LARGE_VIEW_BYTES) (hyparquet's table);
//                                     the .parquet files come from `cargo run -p unimux-files --example parquet_fixtures`
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import { rng } from './goldens-normalize.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const utf16 = (text, be = false) => {
  const out = Buffer.from('\ufeff' + text, 'utf16le');
  return be ? out.swap16() : out;
};
const utf8 = (text, bom = false) => Buffer.from((bom ? '\ufeff' : '') + text, 'utf8');

function collate() {
  const order = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });
  const pieces = ['a', 'A', 'ą', 'Ą', 'b', 'c', 'ć', 'Ć', 'e', 'ę', 'l', 'ł', 'Ł', 'n', 'ń', 'o', 'ó', 'Ó', 's', 'ś', 'z', 'ź', 'ż', 'Ż',
    'x', 'X', '0', '00', '1', '2', '9', '10', '11', '007', '42', '100', '1000000000000000000000', '.', '-', '_', ' ', '~', '#', '(', ')',
    'ä', 'ö', 'ü', 'ß', 'é', 'è', 'ñ', 'č', 'ř', 'ž', 'å', 'ø', 'æ', 'œ', 'ı', 'İ', '日本', '中文', 'ж', 'Я', '😀', '👍🏽', 'v1.2', 'file',
    'File', 'README', 'readme', '.git', '.env', 'node_modules', 'index', 'tsx', 'ts', 'md', '½', '²', '٣', '①', 'ﬁ', 'ǅ', '\u00a0', '\u0301'];
  const r = rng(1501);
  const pick = () => pieces[Math.floor(r() * pieces.length)];
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const n = 2 + Math.floor(r() * 25);
    const names = Array.from({ length: n }, () => Array.from({ length: 1 + Math.floor(r() * 4) }, pick).join(''));
    rows.push({ names, order: [...names].sort((a, b) => order.compare(a, b)) });
  }
  const hand = [
    ['file10.txt', 'file2.txt', 'File1.txt', 'file01.txt', 'file1.txt', 'file001.txt'],
    ['Zebra', 'żaba', 'zebra', 'źrebak', 'Żuraw', 'ząb', 'zab'],
    ['a-b', 'a_b', 'a b', 'a.b', 'ab', 'a~b', 'a#b', 'a(b'],
    ['img12.png', 'img2.png', 'img1.png', 'img100.png', 'IMG3.PNG', 'img02.png'],
    ['Łódź', 'lodz', 'Lódz', 'łódź', 'Lodz'],
    ['.gitignore', '.github', '_config', '-x', '0start', 'Start', 'start'],
  ];
  for (const names of hand) rows.push({ names, order: [...names].sort((a, b) => order.compare(a, b)) });
  return rows;
}

function paths() {
  const inside = (p, root, target) => {
    const rel = p.relative(root, target);
    return rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
  };
  const cases = {
    win32: {
      roots: ['C:\\proj', 'C:\\proj\\', 'c:\\Users\\Ania\\Projekt Ł', 'D:/work/app', '\\\\server\\share\\repo', 'C:\\'],
      rels: ['', '.', 'a', 'a/b', 'a\\b\\..\\c', '..', '../x', '..\\proj\\x', '..foo', 'a/../../x', 'C:\\proj\\a', 'C:x', '/x', '\\x',
        'D:\\proj', 'a//b///c', 'a/./b/.', './../proj/a', 'a/b/', 'ŁĄKA/ż', '..\\..\\..', 'a\\..\\..\\proj\\b', '...', '. ./x', 'a:b',
        '\\\\other\\share', '//?/C:/x', 'PROJ', 'x/../../PROJ/y', 'repo/../../share/repo/z'],
    },
    posix: {
      roots: ['/home/ania/proj', '/home/ania/proj/', '/', '/Users/A/Projekt Ł', '//double'],
      rels: ['', '.', 'a', 'a/b', 'a/b/../c', '..', '../x', '../proj/x', '..foo', 'a/../../x', '/home/ania/proj/a', '/x', 'a//b',
        'a/./b/.', './../proj/a', 'a\\b', 'ŁĄKA/ż', '../../..', '...', 'PROJ', 'x/../../proj/y'],
    },
  };
  const rows = [];
  for (const [flavor, { roots, rels }] of Object.entries(cases)) {
    const p = path[flavor];
    for (const root of roots) {
      for (const rel of rels) {
        // A drive-relative path to another drive ('C:x' under D:) resolves against that drive's own current folder on Windows
        // (process.env['=C:']) and against nothing elsewhere: no fixed answer, so not a golden.
        if (flavor === 'win32' && /^[A-Za-z]:(?![\\/])/.test(rel) && !root.toLowerCase().startsWith(rel.slice(0, 2).toLowerCase())) continue;
        const resolvedRoot = p.resolve(root);
        const resolved = p.resolve(resolvedRoot, rel);
        rows.push({ flavor, root, rel, resolvedRoot, resolved, relAbsolute: p.isAbsolute(rel), relative: p.relative(resolvedRoot, resolved), inside: inside(p, resolvedRoot, resolved) });
      }
    }
  }
  return rows;
}

async function preview({ readProjectFile, LARGE_VIEW_BYTES, PREVIEW_BYTES }) {
  const P = PREVIEW_BYTES;
  const cases = [];
  const add = (name, bytes, padA = 0, large = false) => cases.push({ name, bytes: Buffer.from(bytes), padA, large });
  for (const large of [false, true]) {
    add('plain.txt', utf8('Cześć, świecie!\n'), 0, large);
    add('bom.txt', utf8('z BOM\r\n', true), 0, large);
    add('bom-only.txt', [0xef, 0xbb, 0xbf], 0, large);
    add('double-bom.txt', utf8('\ufeffx', true), 0, large);
    add('empty.txt', [], 0, large);
    add('u16le.txt', utf16('Polskie znaki: ąęć 😀\n'), 0, large);
    add('u16be.txt', utf16('Big endian ż\n', true), 0, large);
    add('u16-bom-only.txt', [0xff, 0xfe], 0, large);
    add('u16-odd.txt', [0xff, 0xfe, 0x61, 0x00, 0x62], 0, large);
    add('u16-lone-high.txt', [0xff, 0xfe, 0x61, 0x00, 0x3d, 0xd8, 0x62, 0x00], 0, large);
    add('u16-lone-low.txt', [0xff, 0xfe, 0x00, 0xde, 0x62, 0x00], 0, large);
    add('u16-high-at-end.txt', [0xff, 0xfe, 0x61, 0x00, 0x3d, 0xd8], 0, large);
    add('u16-control.txt', utf16('a\u0001b'), 0, large);
    add('u16-nul.txt', utf16('a\u0000b'), 0, large);
    add('nul.bin', [0x61, 0x00, 0x62], 0, large);
    add('overlong.txt', [0x61, 0xc0, 0x80], 0, large);
    add('surrogate-utf8.txt', [0x61, 0xed, 0xa0, 0x80], 0, large);
    add('above-max.txt', [0xf4, 0x90, 0x80, 0x80], 0, large);
    add('f8.txt', [0xf8, 0x88, 0x80, 0x80, 0x80], 0, large);
    add('cut-in-middle.txt', [0x61, 0xc4, 0x62], 0, large);
    add('cut-at-end.txt', [0x61, 0xc4], 0, large);
    add('latin1.txt', [0x7a, 0xb3, 0x6f, 0x74, 0x79], 0, large);
    for (const c of [0x01, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x1b, 0x1f, 0x7f]) add(`ctl-${c.toString(16)}.txt`, [0x61, c, 0x62], 0, large);
    add('c1.txt', utf8('a\u0085b\u009bc'), 0, large);
    add('ok-controls.txt', utf8('tab\tvt\u000bff\u000ccr\r\n'), 0, large);
    add('pic.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01], 0, large);
    add('PIC.JPEG', [0xff, 0xd8, 0xff, 0xe0, 0x00], 0, large);
    for (const ext of ['jpg', 'gif', 'webp', 'bmp', 'ico', 'avif']) add(`x.${ext}`, utf8('not really an image'), 0, large);
    add('x.svg', utf8('<svg xmlns="http://www.w3.org/2000/svg"/>'), 0, large);
    add('Makefile', utf8('all:\n\techo ok\n'), 0, large);
    // The cut at the limit (256 KiB, or 8 MiB for the editor's large view).
    const cap = large ? LARGE_VIEW_BYTES : P;
    if (!large) {
      add('cut-2byte.txt', utf8('ątail'), P - 1);
      add('cut-3byte.txt', utf8('€tail'), P - 2);
      add('cut-3byte-b.txt', utf8('€tail'), P - 1);
      add('cut-4byte.txt', utf8('😀tail'), P - 3);
      add('cut-4byte-b.txt', utf8('😀tail'), P - 1);
      add('fits.txt', utf8('ą'), P - 2);
      add('exact.txt', utf8('b'), P - 1);
      add('one-more.txt', utf8('bc'), P - 1);
      add('bad-before-cut.txt', [0xc3, 0x28, 0x61, 0x61], P - 5);
      add('nul-after-cut.txt', [0x61, 0x00], P - 1);
      add('ctl-after-cut.txt', [0x61, 0x01], P - 1);
      add('img-small-view.png', [0x89, 0x50, 0x4e, 0x47], 10);
    }
    add(large ? 'big-large.txt' : 'big-small.txt', utf8('end'), P + 1000, large);
    if (large) add('cut-large.txt', utf8('ątail'), cap - 1, true);
  }
  // UTF-16 cut at the limit: the BOM goes before the padding (`prefix`).
  const u16cut = (name, tail) => cases.push({ name, prefix: Buffer.from([0xff, 0xfe]), bytes: Buffer.from(tail), padA: P - 3, large: false });
  u16cut('u16-cut-unit.txt', [0x62, 0x00, 0x63, 0x00]);
  u16cut('u16-cut-pair.txt', [0x00, 0x3d, 0xd8, 0x00, 0xde]);

  const dir = mkdtempSync(join(tmpdir(), 'mc-goldens-files-'));
  const rows = [];
  try {
    for (const c of cases) {
      const data = Buffer.concat([c.prefix ?? Buffer.alloc(0), Buffer.alloc(c.padA, 0x61), c.bytes]);
      writeFileSync(join(dir, c.name), data);
      const out = await readProjectFile(dir, c.name, c.large ? LARGE_VIEW_BYTES : undefined);
      if (out.kind === 'text' && c.name.startsWith('u16-cut')) {
        // A UTF-16 row: its length and tail only.
        out.textLength = out.text.length;
        out.textTail = out.text.slice(-4);
        delete out.text;
      } else if (out.kind === 'text' && c.padA > 0) {
        if (!out.text.startsWith('a'.repeat(Math.min(c.padA, out.text.length)))) throw new Error(`${c.name}: padding not kept`);
        out.textAfterPad = out.text.slice(c.padA);
        delete out.text;
      } else if (out.kind === 'text' && out.text.length > 10_000) {
        throw new Error(`${c.name}: an unpadded text row would be huge`);
      }
      rows.push({ name: c.name, prefix: c.prefix ? b64(c.prefix) : '', padA: c.padA, bytes: b64(c.bytes), large: c.large, out });
      rmSync(join(dir, c.name));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}

async function save({ writeProjectFile, PREVIEW_BYTES }) {
  const cases = [];
  const add = (bytes, text, expected, padText = 0) => cases.push({ bytes: Buffer.from(bytes), text, expected, padText });
  const orig = 'Cześć\r\nświat\r\n';
  for (const [bytes, label] of [[utf8(orig), 'utf8'], [utf8(orig, true), 'bom'], [utf16(orig), 'le'], [utf16(orig, true), 'be']]) {
    add(bytes, 'Cześć\nnowy świat\n', orig);
    add(bytes, 'jedna linia', orig);
    add(bytes, 'a\nb\nc\nd\ne\n', orig);
    add(bytes, 'a\r\nb\rc\n', orig);
    add(bytes, '😀 emoji\n', orig);
    add(bytes, 'x', `${orig}-${label}`);
  }
  add(utf8('one\r\ntwo\nthree\r'), 'ONE\nTWO\nTHREE\n', 'one\r\ntwo\nthree\r');
  add(utf8('one\r\ntwo\nthree\r'), 'ONE\nTWO\nTHREE\nFOUR\nFIVE', 'one\r\ntwo\nthree\r');
  add(utf8('no breaks'), 'now\nthree\nlines', 'no breaks');
  add(utf8('cr\ronly\r'), 'a\nb\nc\n', 'cr\ronly\r');
  add(utf8(''), 'ą\n', '');
  add(utf8('ą\n'), '', 'ą\n');
  add([0xef, 0xbb, 0xbf], 'after bom', '');
  add([0xff, 0xfe], 'utf16 from empty', '');
  add(utf8('\ufeffx', true), '\ufeffy', '\ufeffx');
  add(utf8('tab\tok'), 'tab\tstill\u000bok\u000c', 'tab\tok');
  add(utf8('ok'), 'a\u0001b', 'ok');
  add(utf8('ok'), 'a\u001fb', 'ok');
  add(utf8('ok'), 'a\u007fb', 'ok');
  add(utf8('ok'), 'null\u0000byte', 'ok');
  add(utf8('external'), 'draft', 'original');
  add(utf8('external'), 'draft', 'external');
  add([0x00, 0x01, 0x02, 0xff], 'replacement', '');
  add([0xc3, 0x28], 'replacement', '');
  add(utf8('a\u0001b'), 'x', 'a\u0001b');
  add(utf16('a\u0001b'), 'x', 'a\u0001b');
  add([0xff, 0xfe, 0x61], 'x', '');
  add(utf8('x'), 'big', 'x', PREVIEW_BYTES + 1);
  add(utf8('x'), 'fits', 'x', PREVIEW_BYTES - 4);
  add(utf16('x'), 'too big in utf16', 'x', PREVIEW_BYTES / 2);
  add(utf8('x', true), 'too big with bom', 'x', PREVIEW_BYTES - 3);
  add(Buffer.alloc(PREVIEW_BYTES + 1, 0x61), 'small', 'a'.repeat(PREVIEW_BYTES + 1));

  const dir = mkdtempSync(join(tmpdir(), 'mc-goldens-save-'));
  const rows = [];
  try {
    for (const [i, c] of cases.entries()) {
      const name = `f${i}.txt`;
      writeFileSync(join(dir, name), c.bytes);
      const text = 'p'.repeat(c.padText) + c.text;
      const result = await writeProjectFile(dir, name, text, c.expected);
      const after = readFileSync(join(dir, name));
      const big = after.length > 10_000;
      rows.push({ bytes: c.bytes.length > 10_000 ? null : b64(c.bytes), bytesA: c.bytes.length > 10_000 ? c.bytes.length : 0, text: c.text, expected: c.expected.length > 10_000 ? null : c.expected, expectedA: c.expected.length > 10_000 ? c.expected.length : 0, padText: c.padText, result, after: big ? null : b64(after), afterLength: after.length });
      rmSync(join(dir, name));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}

// readParquet imports hyparquet lazily, which a closed runnerImport runner refuses: files.ts is loaded through a vite SSR
// server that stays open until every row is read.
async function parquet() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = join(root, 'test/golden/parquet');
  const server = await createServer({ configFile: false, logLevel: 'silent', root, appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false } });
  const rows = [];
  try {
    const { readProjectFile, LARGE_VIEW_BYTES } = await server.ssrLoadModule('/src/main/files.ts');
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.parquet')).sort()) {
      rows.push({ name, out: await readProjectFile(dir, name, LARGE_VIEW_BYTES) });
    }
  } finally {
    await server.close();
  }
  return rows;
}

export async function filesGoldens(files) {
  return {
    collate: collate(),
    paths: paths(),
    preview: await preview(files),
    save: await save(files),
    parquet: await parquet(),
  };
}
