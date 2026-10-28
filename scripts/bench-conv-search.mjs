// Times the conversation search thread (out/main/convsearch.js, run as an eval'd worker like main runs it) on real transcript
// folders. Read-only: the transcripts are only read; the index cache goes to a temporary folder (or --cache <file>).
// Usage: npm run build && node scripts/bench-conv-search.mjs [--claude <dir>] [--codex <dir>] [--cache <file>] [query ...]
import { readFileSync, mkdtempSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { Worker } from 'worker_threads';

const args = process.argv.slice(2);
const take = (flag, fallback) => { const i = args.indexOf(flag); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v; };
const claude = take('--claude', process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
const codex = take('--codex', process.env.CODEX_HOME || join(homedir(), '.codex'));
const tmp = mkdtempSync(join(tmpdir(), 'conv-bench-'));
const cacheFile = take('--cache', join(tmp, 'conversation-index.bin'));
const queries = args.length ? args : ['atomicWrite', 'release', 'zakładki restart', '"git worktree"', 'xyzzy-nothing'];

const source = readFileSync(new URL('../out/main/convsearch.js', import.meta.url), 'utf8');
function start() {
  const w = new Worker(source, { eval: true, workerData: { claudeRoots: [claude], codexRoots: [codex], cacheFile } });
  let seq = 0;
  const pending = new Map();
  w.on('message', (m) => { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result); });
  const call = (req) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); w.postMessage({ ...req, id }); });
  return { w, call };
}

const t0 = performance.now();
let { w, call } = start();
let first = await call({ t: 'search', query: { text: queries[0] } });
console.log(`first answer (cold, nothing indexed): ${(performance.now() - t0).toFixed(0)} ms, indexing ${JSON.stringify(first.indexing)}`);
let lastLog = 0;
for (;;) {
  const r = await call({ t: 'search', query: { text: queries[0] } });
  if (!r.indexing) break;
  if (performance.now() - lastLog > 2000) { lastLog = performance.now(); console.log(`  ... ${r.indexing.done}/${r.indexing.total} files, ${r.total} hits so far, search ${r.tookMs} ms`); }
  await new Promise((res) => setTimeout(res, 250));
}
const cold = performance.now() - t0;
const stats = await call({ t: 'stats' });
console.log(`full index built: ${(cold / 1000).toFixed(1)} s; files ${stats.files}, full reads ${stats.fullReads}, bytes consumed ${(stats.bytesRead / 1e6).toFixed(0)} MB, pass ${stats.lastPassMs} ms, thread heap ${Math.round(stats.heapUsed / 1e6)} MB`);
for (const q of queries) {
  const times = [];
  let r;
  for (let i = 0; i < 5; i++) { const s = performance.now(); r = await call({ t: 'search', query: { text: q } }); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  console.log(`search ${JSON.stringify(q)}: ${r.total} conversations of ${r.conversations}; in-thread ${r.tookMs} ms; round trip median ${times[2].toFixed(1)} ms`);
}
await call({ t: 'search', query: { text: '' } });
await new Promise((res) => setTimeout(res, 4100));
const re = performance.now();
await call({ t: 'search', query: { text: 'x' } });
for (;;) { const r = await call({ t: 'search', query: { text: 'x' } }); if (!r.indexing) break; await new Promise((res) => setTimeout(res, 50)); }
const st2 = await call({ t: 'stats' });
console.log(`refresh pass with nothing changed (list + stat every file): ${(performance.now() - re).toFixed(0)} ms (pass ${st2.lastPassMs} ms)`);
await call({ t: 'shutdown' });
await w.terminate();
try { console.log(`cache file: ${(statSync(cacheFile).size / 1e6).toFixed(0)} MB`); } catch { console.log('cache file: not written'); }

const t1 = performance.now();
({ w, call } = start());
await call({ t: 'search', query: { text: queries[0] } });
for (;;) { const r = await call({ t: 'search', query: { text: queries[0] } }); if (!r.indexing) break; await new Promise((res) => setTimeout(res, 50)); }
const warm = await call({ t: 'stats' });
console.log(`restart with the cache: ready in ${(performance.now() - t1).toFixed(0)} ms (full reads ${warm.fullReads}, appends ${warm.appendReads})`);
await w.terminate();
if (!args.includes('--keep')) rmSync(tmp, { recursive: true, force: true });
