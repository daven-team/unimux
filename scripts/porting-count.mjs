// `npm run porting:count`: how many main-side test cases have a Rust port (PLAN F10, release gate item 4). A main-side test
// file imports code that runs in the Electron main process or one of its hosts (src/main, src/ptyhost, src/dbhost,
// src/sftphost, src/convsearch, src/exechost, src/sshcore, src/updatesplash). Every `it()` / `test()` case of such a file must
// get a row in test/PORTING.md: `| file | case | rust test | status |` with status `ported`, `partial`, `renderer-only` or
// `obsolete` (and a reason). `--check` fails when a row names a case that no longer exists.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');
const MAIN_SIDE = /from ['"]\.\.\/src\/(main|ptyhost|dbhost|sftphost|convsearch|exechost|sshcore|updatesplash)\//;
const CASE = /^\s*(?:it|test)(?:\.(?:skip|only|each\([^)]*\)))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm;

const files = readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).sort();
const cases = new Map();
let mainSide = 0;
for (const file of files) {
  const text = readFileSync(join(testDir, file), 'utf8');
  if (!MAIN_SIDE.test(text)) continue;
  const names = [...text.matchAll(CASE)].map((m) => m[2].replace(/\\(.)/g, '$1'));
  cases.set(file.replace(/\.test\.ts$/, ''), names);
  mainSide += names.length;
}

const rows = readFileSync(join(testDir, 'PORTING.md'), 'utf8').split('\n')
  .filter((l) => /^\|[^-]/.test(l) && !/^\|\s*file\s*\|/i.test(l))
  .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  .map(([file, name, rust, status]) => ({ file, name, rust, status }));

const counts = { ported: 0, partial: 0, 'renderer-only': 0, obsolete: 0 };
const unknown = [];
for (const row of rows) {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  const known = cases.get(row.file);
  if (!known || !known.includes(row.name)) unknown.push(`${row.file}: ${row.name}`);
}
const done = counts.ported + counts['renderer-only'] + counts.obsolete;
console.log(`main-side test files: ${cases.size}, cases: ${mainSide}`);
console.log(`PORTING.md rows: ${rows.length} (ported ${counts.ported}, partial ${counts.partial}, renderer-only ${counts['renderer-only']}, obsolete ${counts.obsolete})`);
console.log(`done: ${done} / ${mainSide} (${((100 * done) / Math.max(1, mainSide)).toFixed(1)} percent)`);
if (unknown.length) {
  console.error(`rows naming cases that do not exist:\n  ${unknown.join('\n  ')}`);
  if (process.argv.includes('--check')) process.exit(1);
}
