// SSH typing latency of the Pty Host's output path, without the app: keystroke -> echo received by a stand-in renderer, for
// several network round trips, echo shapes (one packet / echo plus a redraw) and with busy agent terminals in the same host.
// Prints p50 / p95 / max per scenario and where the time goes (network, host pipeline, input queue, delivery).
// See test/helpers/sshLatencyBench.ts for the model. Local only: the server is a child process on 127.0.0.1.
// Usage: node scripts/ssh-latency-bench.mjs [--keys <n, default 60>] [--only <scenario name>[,<name>...]] [--json <file>]
//   [--src <the src folder of another checkout, e.g. an export of the previous release: its Pty Host is measured instead>]
//   [--coarse-timers: the host's setTimeout fires on 15.625 ms ticks, like Windows without a finer timer resolution requested]
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const keys = Number(arg('--keys') ?? 60);
const only = arg('--only');
const json = arg('--json');
const src = arg('--src');
const coarse = args.includes('--coarse-timers');
/** Points the bench's imports of ../../src/... at another checkout's sources (before / after comparisons). */
const otherSrc = src ? [{ name: 'other-src', setup(b) {
  b.onResolve({ filter: /^\.\.\/\.\.\/src\// }, (a) => ({ path: `${resolve(src, a.path.slice('../../src/'.length))}.ts` }));
} }] : [];

const dir = mkdtempSync(join(tmpdir(), 'unimux-ssh-bench-'));
// CommonJS: ssh2 uses __dirname.
const out = join(dir, 'bench.cjs');
try {
  // nodePaths: an exported `src` has no node_modules of its own on the way up; it takes this checkout's.
  await build({ entryPoints: [resolve('test/helpers/sshLatencyBench.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out,
    external: ['electron', 'node-pty', 'cpu-features'], logLevel: 'error', plugins: otherSrc, nodePaths: [resolve('node_modules')] });
  const { SCENARIOS, coarseTimers, runScenario, summarize } = createRequire(import.meta.url)(out);
  if (coarse) coarseTimers();
  const results = [];
  for (const s of SCENARIOS.filter((x) => !only || only.split(',').includes(x.name))) {
    const r = await runScenario(s, keys);
    results.push(r);
    console.log(JSON.stringify(summarize(r)));
  }
  console.log(`\nkeystroke -> echo in the renderer, ms (p50 / p95 / max), ${keys} keys per scenario`);
  console.table(results.map(summarize));
  if (json) writeFileSync(json, JSON.stringify(results, null, 1));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
