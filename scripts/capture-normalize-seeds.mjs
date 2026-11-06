// Records the states the TS test suite hands to normalizeState (src/shared/state.ts), as the seed inputs of the normalize
// golden corpus (1.2.0, PLAN F8): test/golden/normalize-seeds.jsonl. Every vitest case that loads, repairs or migrates a
// state is one realistic input written by people who knew the case (old versions, damaged files, every domain), and no
// user's real state.json is ever read. Runs vitest once with a transform that wraps normalizeState; only the inputs are kept
// (the outputs are computed again by scripts/dump-goldens.mjs, so the corpus never trusts a recording).
//
//   node scripts/capture-normalize-seeds.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVitest } from 'vitest/node';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'unimux-seeds-'));
const log = join(scratch, 'calls.jsonl');
process.env.UNIMUX_NORMALIZE_CAPTURE = log;

const wrap = {
  name: 'capture-normalize-state',
  enforce: 'pre',
  transform(code, id) {
    if (!id.replace(/\\/g, '/').endsWith('/src/shared/state.ts')) return null;
    const renamed = code.replace('export function normalizeState(', 'function normalizeStateOriginal(');
    if (renamed === code) throw new Error('normalizeState not found in state.ts');
    return `${renamed}
import { appendFileSync as __append } from 'node:fs';
export function normalizeState(raw: unknown, platform: AppPlatform = 'win32'): AppState | null {
  const file = process.env.UNIMUX_NORMALIZE_CAPTURE;
  if (file) { try { const text = JSON.stringify(raw); if (typeof text === 'string') __append(file, JSON.stringify({ platform, text }) + '\\n'); } catch { /* not JSON */ } }
  return normalizeStateOriginal(raw, platform);
}
`;
  },
};

const vitest = await startVitest('test', [], { run: true, watch: false, reporters: ['dot'] }, { plugins: [wrap] });
await vitest?.close();

const seen = new Set();
const rows = [];
if (existsSync(log)) {
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { platform, text } = JSON.parse(line);
    // Only inputs that are JSON (what a state.json can hold) and of a sane size.
    if (text.length > 200_000) continue;
    const key = `${platform}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ platform, input: JSON.parse(text) });
  }
}
rmSync(scratch, { recursive: true, force: true });
writeFileSync(resolve(root, 'test/golden/normalize-seeds.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${rows.length} seed states to test/golden/normalize-seeds.jsonl`);
