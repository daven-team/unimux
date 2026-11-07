// H5 bench (1.2.0): the Rust conversation index against 1.1.4's TS indexer (src/convsearch/indexer.ts, run in this Node
// process like the worker ran it) on the same folders. Two sets:
//
//   fixture  test/fixtures/convsearch as it is (4 transcripts)
//   scaled   a generated set in a scratch folder: Claude projects and Codex rollouts shaped like the fixtures, with large tool
//            outputs and thinking blocks the prefilters skip (--files N, default 600; --kb K average size, default 250)
//
// Measured (medians over --rounds, default 3): cold full pass without a cache, forced rescan with nothing changed, load of a
// saved cache plus a pass (after all cold rounds), a search per query (20 runs each) and the transcript preview of the
// largest file. Both sides must find the same number of hits per query. Exits 1 when Rust is not faster on every measure of
// both sets (the fixture timings are a few ms: a busy machine can flip one, run it again).
//
//   node scripts/bench-convsearch.mjs [--files 600] [--kb 250] [--rounds 3] [--keep]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { rng } from './goldens-normalize.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
const FILES = arg('files', 600);
const KB = arg('kb', 250);
const ROUNDS = arg('rounds', 3);
const KEEP = process.argv.includes('--keep');
const QUERIES = ['redis', 'atomicWrite', 'zażółć', 'state json', '"pool API"', 'nonexistentwordxyz', 'ΣΟΦΟΣ'];

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

// ---------- the generated set ----------

const WORDS = ['Napraw', 'zapis', 'stanu', 'zakładki', 'Zażółć', 'gęślą', 'jaźń', 'redis', 'pool', 'API', 'atomicWrite', 'state.json', 'migrate',
  'the', 'client', 'to', 'new', 'test', 'failing', 'because', 'ΣΟΦΟΣ', 'σοφός', 'İstanbul', 'straße', 'naïve', 'résumé', '日本語', 'emoji😀',
  'function', 'returns', 'undefined', 'when', 'called', 'twice', 'renderer', 'terminal', 'grid', 'cell', 'agent', 'worktree', 'commit'];

function gen(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  return { pick, words };
}

function claudeFile(r, sid, cwd, targetBytes, t0) {
  const { pick, words } = gen(r);
  const lines = [];
  let size = 0;
  let t = t0;
  let n = 0;
  const push = (o) => { const s = JSON.stringify(o); lines.push(s); size += s.length + 1; };
  const base = () => ({ parentUuid: null, isSidechain: false, uuid: `u${n++}`, timestamp: new Date(t += 1500).toISOString(), cwd, sessionId: sid });
  push({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(t).toISOString(), sessionId: sid, content: words(4) });
  while (size < targetBytes) {
    const roll = r();
    if (roll < 0.15) push({ ...base(), type: 'user', message: { role: 'user', content: words(10 + Math.floor(r() * 60)) } });
    else if (roll < 0.4) push({ ...base(), type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: words(20 + Math.floor(r() * 200)) }] } });
    else if (roll < 0.5) push({ ...base(), type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: words(100 + Math.floor(r() * 400)) }] } });
    else if (roll < 0.7) push({ ...base(), type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: pick(['Bash', 'Read', 'Edit', 'Grep']), input: { command: `npm test -- ${pick(WORDS)}`, file_path: `src/${pick(WORDS)}.ts` } }] } });
    else if (roll < 0.95) push({ ...base(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: words(200 + Math.floor(r() * 1500)) }] }, toolUseResult: { stdout: words(100) } });
    else push({ ...base(), type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: words(30) }] } });
  }
  push({ type: 'summary', summary: words(6), leafUuid: `u${n - 1}` });
  return lines.join('\n') + '\n';
}

function codexFile(r, id, cwd, targetBytes, t0) {
  const { pick, words } = gen(r);
  const lines = [];
  let size = 0;
  let t = t0;
  const push = (o) => { const s = JSON.stringify(o); lines.push(s); size += s.length + 1; };
  const ts = () => new Date(t += 1200).toISOString();
  push({ timestamp: ts(), type: 'session_meta', payload: { id, timestamp: new Date(t0).toISOString(), cwd, originator: 'codex_cli_rs', cli_version: '0.99.0', instructions: words(300) } });
  push({ timestamp: ts(), type: 'turn_context', payload: { cwd, model: 'gpt-6.1-sol', approval_policy: 'never' } });
  while (size < targetBytes) {
    const roll = r();
    if (roll < 0.12) {
      const text = words(10 + Math.floor(r() * 60));
      push({ timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      push({ timestamp: ts(), type: 'event_msg', payload: { type: 'user_message', message: text } });
    } else if (roll < 0.35) push({ timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: words(20 + Math.floor(r() * 200)) }] } });
    else if (roll < 0.45) push({ timestamp: ts(), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: words(80) }], encrypted_content: 'x'.repeat(2000) } });
    else if (roll < 0.65) push({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', `rg ${pick(WORDS)} src`] }), call_id: `c${size}` } });
    else push({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call_output', call_id: `c${size}`, output: words(200 + Math.floor(r() * 1500)) } });
  }
  return lines.join('\n') + '\n';
}

function generate(dir) {
  const r = rng(0xb5e7);
  const claude = join(dir, 'claude');
  const codex = join(dir, 'codex');
  const nCodex = Math.floor(FILES / 3);
  const nClaude = FILES - nCodex;
  const t0 = Date.UTC(2026, 0, 1);
  let bytes = 0;
  for (let i = 0; i < nClaude; i++) {
    const project = `D--work-p${i % 20}`;
    const folder = join(claude, 'projects', project);
    mkdirSync(folder, { recursive: true });
    const sid = `${String(i).padStart(8, '0')}-aaaa-4bbb-8ccc-${String(i).padStart(12, '0')}`;
    const body = claudeFile(r, sid, `D:\\work\\p${i % 20}`, KB * 1024 * (0.2 + r() * 1.6), t0 + i * 3_600_000);
    writeFileSync(join(folder, `${sid}.jsonl`), body);
    bytes += Buffer.byteLength(body);
  }
  for (let i = 0; i < nCodex; i++) {
    const day = join(codex, 'sessions', '2026', String(1 + (i % 12)).padStart(2, '0'), String(1 + (i % 28)).padStart(2, '0'));
    mkdirSync(day, { recursive: true });
    const id = `0199${String(i).padStart(4, '0')}-bbbb-7ccc-8ddd-${String(i).padStart(12, '0')}`;
    const body = codexFile(r, id, `D:\\work\\c${i % 10}`, KB * 1024 * (0.2 + r() * 1.6), t0 + i * 3_600_000);
    writeFileSync(join(day, `rollout-2026-01-01T00-00-00-${id}.jsonl`), body);
    bytes += Buffer.byteLength(body);
  }
  return { claude, codex, bytes };
}

// ---------- the two sides ----------

async function benchTs(set, scratch) {
  const { ConvIndexer } = (await runnerImport(resolve(root, 'src/convsearch/indexer.ts'), { configFile: false, logLevel: 'silent', root })).module;
  const opts = (cacheFile) => ({ claudeRoots: [set.claude], codexRoots: [set.codex], cacheFile, freshMs: 0 });
  const cold = [], rescan = [], cached = [];
  let ix = null;
  for (let round = 0; round < ROUNDS; round++) {
    const cacheFile = join(scratch, `conversation-index-ts-${round}.bin`);
    const a = new ConvIndexer(opts(cacheFile));
    let t = performance.now();
    await a.load();
    await a.refresh(true);
    cold.push(performance.now() - t);
    t = performance.now();
    await a.refresh(true);
    rescan.push(performance.now() - t);
    await a.save();
    ix = a;
  }
  // The saved files are read after all cold rounds, like the app reads its cache at a start (not right after writing it).
  for (let round = 0; round < ROUNDS; round++) {
    const b = new ConvIndexer(opts(join(scratch, `conversation-index-ts-${round}.bin`)));
    const t = performance.now();
    await b.load();
    await b.refresh(true);
    cached.push(performance.now() - t);
  }
  const search = {}, hits = {};
  for (const q of QUERIES) {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const res = ix.search({ text: q });
      times.push(performance.now() - t);
      hits[q] = res.total;
    }
    search[q] = median(times);
  }
  let largest = '', size = -1;
  for (const e of ix.entries.values()) if (e.size > size) { size = e.size; largest = e.file; }
  const transcript = [];
  for (let i = 0; i < Math.max(ROUNDS, 3); i++) {
    const t = performance.now();
    const res = await ix.transcript(largest);
    transcript.push(performance.now() - t);
    if (!res.ok) throw new Error(`TS transcript failed: ${res.error}`);
  }
  return { files: ix.size(), cold: median(cold), rescan: median(rescan), cached: median(cached), search, hits, transcript: median(transcript) };
}

let built = false;
function benchRust(set, scratch) {
  const env = { ...process.env, PATH: `${join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  const cargo = ['--release', '-p', 'unimux-agents', '--example', 'conv_bench'];
  if (!built) { execFileSync('cargo', ['build', ...cargo], { cwd: join(root, 'src-tauri'), env, stdio: ['ignore', 'ignore', 'inherit'] }); built = true; }
  const out = execFileSync('cargo', ['run', '-q', ...cargo, '--', set.claude, set.codex, scratch, String(ROUNDS), ...QUERIES], { cwd: join(root, 'src-tauri'), env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function report(name, ts, rs) {
  const rows = [['cold pass', ts.cold, rs.cold], ['rescan', ts.rescan, rs.rescan], ['cache load + pass', ts.cached, rs.cached], ['transcript (largest)', ts.transcript, rs.transcript]];
  for (const q of QUERIES) rows.push([`search ${q}`, ts.search[q], rs.search[q]]);
  console.log(`\n${name}: ${ts.files} files (TS) / ${rs.files} files (Rust)`);
  console.log('measure'.padEnd(26) + '1.1.4 TS ms'.padStart(14) + 'Rust ms'.padStart(12) + 'x faster'.padStart(10));
  let slower = [];
  for (const [label, a, b] of rows) {
    console.log(label.padEnd(26) + a.toFixed(2).padStart(14) + b.toFixed(2).padStart(12) + (a / Math.max(b, 1e-6)).toFixed(1).padStart(10));
    if (b >= a) slower.push(label);
  }
  const mismatched = QUERIES.filter((q) => ts.hits[q] !== rs.hits[q]);
  for (const q of mismatched) console.log(`hits differ for ${q}: TS ${ts.hits[q]}, Rust ${rs.hits[q]}`);
  if (ts.files !== rs.files) mismatched.push('file count');
  return { slower, mismatched };
}

const scratch = mkdtempSync(join(tmpdir(), 'unimux-convbench-'));
let failed = false;
try {
  const fixture = { claude: join(root, 'test/fixtures/convsearch/claude'), codex: join(root, 'test/fixtures/convsearch/codex') };
  const fx = report('fixture', await benchTs(fixture, mkdtempSync(join(scratch, 'ts-'))), benchRust(fixture, mkdtempSync(join(scratch, 'rs-'))));
  if (fx.mismatched.length || fx.slower.length) failed = true;
  if (fx.slower.length) console.log(`fixture: Rust not faster on ${fx.slower.join(', ')}`);

  const set = generate(join(scratch, 'scaled'));
  console.log(`\ngenerated ${FILES} files, ${(set.bytes / 1048576).toFixed(1)} MB in ${scratch}`);
  void statSync(set.claude);
  const sc = report('scaled', await benchTs(set, mkdtempSync(join(scratch, 'ts-'))), benchRust(set, mkdtempSync(join(scratch, 'rs-'))));
  if (sc.mismatched.length || sc.slower.length) failed = true;
  if (sc.slower.length) console.log(`Rust not faster on: ${sc.slower.join(', ')}`);
} finally {
  if (!KEEP) rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? '\nFAIL' : '\nOK: Rust faster on every measure of both sets, same hits');
process.exit(failed ? 1 : 0);
