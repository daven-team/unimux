// `npm run porting:count`: how many main-side test cases have a Rust port (PLAN F10, release gate item 4).
//
// A main-side test file imported code that ran in the Electron main process or one of its hosts (src/main, src/ptyhost,
// src/dbhost, src/sftphost, src/convsearch, src/exechost, src/sshcore, src/updatesplash). Every `it()` / `test()` case of such a
// file got a row in test/PORTING.md: `| file | case | rust test | status |` with status `ported`, `partial`, `renderer-only` or
// `obsolete` (and a reason). R1 removed those sources and test files, so the count runs from PORTING.md against the historical
// total it records (`<!-- porting-total: N cases in M files -->`).
//
// `--check` fails when
//   - the rows do not add up to the historical total, or a row is `partial` / has an unknown status (a case name may repeat:
//     1.1.4 had a few cases with the same name in different describe blocks);
//   - a test file imports one of the removed folders again;
//   - a `renderer-only` row names a case that is not in its test file any more (those cases stayed in vitest).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');
const MAIN_SIDE = /from ['"]\.\.\/src\/(main|preload|ptyhost|dbhost|sftphost|convsearch|exechost|sshcore|updatesplash)\//;
const CASE = /^\s*(?:it|test)(?:\.(?:skip|only|each\([^)]*\)))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm;
const STATUSES = ['ported', 'partial', 'renderer-only', 'obsolete'];

const text = readFileSync(join(testDir, 'PORTING.md'), 'utf8');
const total = /<!-- porting-total: (\d+) cases in (\d+) files -->/.exec(text);
if (!total) throw new Error('test/PORTING.md has no <!-- porting-total: N cases in M files --> marker');
const [historicalCases, historicalFiles] = [Number(total[1]), Number(total[2])];
const end = text.indexOf('<!-- porting-rows-end -->');
const rows = (end < 0 ? text : text.slice(0, end)).split('\n')
  .filter((l) => /^\|[^-]/.test(l) && !/^\|\s*file\s*\|/i.test(l))
  .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  .map(([file, name, rust, status]) => ({ file, name, rust, status }));

const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
const problems = [];
for (const row of rows) {
  if (!STATUSES.includes(row.status)) problems.push(`unknown status "${row.status}": ${row.file}: ${row.name}`);
  else counts[row.status]++;
  const key = `${row.file}\n${row.name}`;
}
if (rows.length !== historicalCases) problems.push(`${rows.length} rows, the historical total is ${historicalCases}`);
if (counts.partial) problems.push(`${counts.partial} partial row(s): every case must be ported, renderer-only or obsolete`);
const files = new Set(rows.map((r) => r.file));
if (files.size !== historicalFiles) problems.push(`rows name ${files.size} files, the historical total is ${historicalFiles}`);

// The test files of today: none may reach a removed folder; the renderer-only cases must still be there.
const casesOf = new Map();
for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).sort()) {
  const source = readFileSync(join(testDir, file), 'utf8');
  if (MAIN_SIDE.test(source)) problems.push(`${file} imports a folder R1 removed`);
  casesOf.set(file.replace(/\.test\.ts$/, ''), [...source.matchAll(CASE)].map((m) => m[2].replace(/\\(.)/g, '$1')));
}
for (const row of rows.filter((r) => r.status === 'renderer-only')) {
  if (!casesOf.get(row.file)?.includes(row.name)) problems.push(`renderer-only case missing from test/${row.file}.test.ts: ${row.name}`);
}
for (const folder of ['main', 'preload', 'ptyhost', 'dbhost', 'sftphost', 'convsearch', 'exechost', 'sshcore']) {
  if (existsSync(join(root, 'src', folder))) problems.push(`src/${folder} exists again`);
}

const done = counts.ported + counts['renderer-only'] + counts.obsolete;
console.log(`main-side test files (historical, removed in R1): ${historicalFiles}, cases: ${historicalCases}`);
console.log(`PORTING.md rows: ${rows.length} (ported ${counts.ported}, partial ${counts.partial}, renderer-only ${counts['renderer-only']}, obsolete ${counts.obsolete})`);
console.log(`done: ${done} / ${historicalCases} (${((100 * done) / Math.max(1, historicalCases)).toFixed(1)} percent)`);
if (problems.length) {
  console.error(`problems:\n  ${problems.join('\n  ')}`);
  if (process.argv.includes('--check')) process.exit(1);
}
