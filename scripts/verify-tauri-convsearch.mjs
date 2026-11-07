// Real-app check of the conversation search (1.2.0, PLAN H5) on the `check` build: a scratch home holds the test fixtures
// as ~/.claude/projects and ~/.codex/sessions; window.mc.conversations.search / transcript / exportData answer exactly what
// 1.1.4's TS indexer and exporter answer on the same folders (tookMs aside); bad requests get main's answers; on quit the
// index is saved to conversation-index-v2.bin and a 1.1.4 conversation-index.bin in the data dir stays byte for byte.
// Scratch data dir and home only; ends only the processes it started.
//
//   npm run build:check && node scripts/verify-tauri-convsearch.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sha256, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ ConvIndexer }, { locateSession, readExport }] = await Promise.all([load('src/convsearch/indexer.ts'), load('src/convsearch/exporter.ts')]);

const ALPHA = '11111111-aaaa-4bbb-8ccc-000000000001';
const CODEX = '0199aaaa-bbbb-7ccc-8ddd-000000000010';

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// tookMs differs by nature; indexing too when a search starts a background pass (more than 4 s after the last one).
const noTime = (r) => { const { tookMs, indexing, ...rest } = r; return rest; };

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-convsearch-'));
const dataDir = join(scratch, 'data');
const home = join(scratch, 'home');
mkdirSync(dataDir, { recursive: true });
cpSync(join(root, 'test/fixtures/convsearch/claude'), join(home, '.claude'), { recursive: true });
cpSync(join(root, 'test/fixtures/convsearch/codex'), join(home, '.codex'), { recursive: true });
// What 1.1.4 left in the data dir: never read or written by 1.2.0.
const oldIndex = join(dataDir, 'conversation-index.bin');
writeFileSync(oldIndex, Buffer.from('ff0f6f22077665727369 1.1.4 v8 index stand-in'));
const oldHash = sha256(readFileSync(oldIndex));
console.log(`scratch: ${scratch}`);

// The TS reference on the same folders (what the 1.1.4 worker answers).
const roots = { claudeRoots: [join(home, '.claude')], codexRoots: [join(home, '.codex')] };
const ts = new ConvIndexer({ ...roots, freshMs: 0 });
await ts.load();
await ts.refresh(true);
const tsExport = async (source) => {
  if ('file' in source) { const cli = ts.cliOf(source.file); return cli ? readExport(source.file, cli) : null; }
  const file = ts.fileOf(source.cli, source.id) ?? await locateSession(source.cli, source.id, roots);
  return file ? readExport(file, source.cli) : null;
};

let child;
try {
  const port = await freePort();
  child = launchApp({ dataDir, scratch, port });
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.mc?.conversations?.search === 'function'`, 30000, 'window.mc');
  const call = (expr) => page.evaluate(expr);

  // The first search answers at once (a pass runs in the background); later ones come from the full index.
  const first = await call(`window.mc.conversations.search({ text: 'zapis' })`);
  check('the first search answers with the result shape of 1.1.4', Array.isArray(first.hits) && 'indexing' in first && typeof first.tookMs === 'number', JSON.stringify(first).slice(0, 200));
  await waitFor(page, `window.mc.conversations.search({ text: '' }).then((r) => r.indexing === null && r.conversations > 0)`, 30000, 'index pass');

  for (const query of [{ text: 'zapis' }, { text: 'Zażółć' }, { text: 'redis pool' }, { text: '"pool API"' }, { text: '' }, { text: 'atomicwrite', role: 'assistant' }, { text: 'a', cli: 'codex' }, { text: 'x', limit: 1 }, { text: 'nothing-like-this' }]) {
    const rust = await call(`window.mc.conversations.search(${JSON.stringify(query)})`);
    const want = ts.search(query);
    check(`search ${JSON.stringify(query)} equals 1.1.4 (${rust.total} hits)`, same(noTime(rust), noTime(want)), same(noTime(rust), noTime(want)) ? '' : `${JSON.stringify(noTime(rust)).slice(0, 300)} vs ${JSON.stringify(noTime(want)).slice(0, 300)}`);
  }
  const bad = await call(`window.mc.conversations.search({ text: 7, cli: 'gemini', limit: 1e9, extra: 1 })`);
  check('a malformed query is sanitized like sanitizeQuery', same(noTime(bad), noTime(ts.search({ text: '', limit: 500 }))));

  const files = [...ts.entries.keys()];
  for (const file of files) {
    const rust = await call(`window.mc.conversations.transcript(${JSON.stringify(file)})`);
    check(`transcript of ${file.split(/[\\/]/).pop()} equals 1.1.4`, same(rust, await ts.transcript(file)));
  }
  check('transcript of a file the index does not know', same(await call(`window.mc.conversations.transcript(${JSON.stringify(join(home, 'x.jsonl'))})`), { ok: false, messages: [], capped: false, error: 'unknown' }));
  check('transcript without a file', same(await call(`window.mc.conversations.transcript('')`), { ok: false, messages: [], capped: false }));

  for (const source of [{ file: files[0] }, { cli: 'claude', id: ALPHA }, { cli: 'codex', id: CODEX }]) {
    const rust = await call(`window.mc.conversations.exportData(${JSON.stringify(source)})`);
    const want = await tsExport(source);
    check(`export ${JSON.stringify(source).replaceAll(JSON.stringify(home).slice(1, -1), '~')} equals 1.1.4 (${rust.items?.length} items)`, rust.ok === true && same(rust, want));
  }
  const noExport = { ok: false, cli: 'claude', id: '', title: '', cwd: '', startedAt: 0, updatedAt: 0, items: [], capped: false };
  check('export of an id that could be a path is refused', same(await call(`window.mc.conversations.exportData({ cli: 'claude', id: '../state' })`), noExport));
  const exportFailed = (error, cli) => ({ ok: false, error, cli, id: '', title: '', cwd: '', startedAt: 0, updatedAt: 0, items: [], capped: false });
  check('export of an unknown session', same(await call(`window.mc.conversations.exportData({ cli: 'codex', id: 'nope' })`), exportFailed('not-found', 'codex')));
  check('export of a file the index does not know', same(await call(`window.mc.conversations.exportData({ file: ${JSON.stringify(join(home, 'x.jsonl'))} })`), exportFailed('unknown', 'claude')));

  // Quit: the index saves itself into the v2 file; 1.1.4's file is not touched.
  await call(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
  const code = await waitExit(child, 15000);
  check('the app quits', code !== null);
  check('the index is saved to conversation-index-v2.bin on quit', existsSync(join(dataDir, 'conversation-index-v2.bin')));
  check('the 1.1.4 conversation-index.bin is untouched', sha256(readFileSync(oldIndex)) === oldHash);
  page.close?.();
} catch (error) {
  failed = true;
  console.log(`FAIL ${error?.stack ?? error}`);
} finally {
  killTree(child);
  check('real profile untouched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
  await sleep(500);
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* a webview may still hold a file */ }
}
console.log(failed ? 'verify-tauri-convsearch: FAILED' : 'verify-tauri-convsearch: all checks passed');
process.exit(failed ? 1 : 0);
