// Writes the golden corpus (1.2.0, PLAN F10): what the TS reference code answers for a fixed set of inputs, so the Rust ports
// are checked against the real behaviour (src-tauri/crates/*/tests/golden.rs). Inputs are generated from a seeded PRNG, so the
// files are reproducible; CI runs `--check` and fails on any difference.
//
//   test/golden/default-state.json   defaultState(win32 | darwin)
//   test/golden/state-merge.jsonl    {current, base, next} -> mergeStateEdit
//   test/golden/state-diff.jsonl     {prev, next} -> diffState
//   test/golden/translate.jsonl      {language, key, params} -> translate
//   test/golden/atomic-write.jsonl   {file, pid, ms, counter} -> the temp name tempPathFor would give
//   test/golden/state-load.jsonl     {text} (JSON.stringify output, lone surrogates included) -> what 1.2.0 reads: JSON.parse
//                                     accepts it, a lone surrogate becomes U+FFFD (a Rust string cannot hold one)
//   test/golden/normalize-state.jsonl   {platform, now, input} -> normalizeState (see scripts/goldens-normalize.mjs)
//   test/golden/state-after-edit.jsonl  {prev, next} -> normalizeEditedState of main's StateController
//   test/golden/js-sort.jsonl        {keys} (null is NaN) -> the order V8's Array.prototype.sort gives indexes compared by
//                                     keys[a] - keys[b], an inconsistent comparator included (the inbox retention sort)
//   test/golden/update-progress.jsonl, update-strings.json, update-config.json   the update window (see scripts/goldens-update.mjs)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { afterEditRows, normalizeRows } from './goldens-normalize.mjs';
import { updateConfigGolden, updateProgressRows, updateStringsGolden } from './goldens-update.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'test/golden');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;

const [{ defaultState, normalizeState }, { mergeStateEdit }, { diffState }, { translate }, { messages }, { normalizeEditedState }, { UpdateProgressModel, closeAction }] = await Promise.all([
  load('src/shared/state.ts'), load('src/shared/stateEdits.ts'), load('src/shared/statePatch.ts'), load('src/shared/i18n.ts'), load('src/shared/messages.ts'),
  load('src/main/stateController.ts'), load('src/shared/updateProgress.ts'),
]);

// ── a small seeded PRNG (mulberry32) ────────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random state-like tree: objects with a few keys, keyed lists (id), plain lists and scalars. */
function generator(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const keys = ['a', 'b', 'c', 'name', 'tabs', 'cells', 'settings', 'x', 'y', 'z', 'fontSize', 'z9'];
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 't1', 't2'];
  const scalar = () => pick([0, 1, 2, 1.5, -3, 13, 'pl', 'en', '', 'ąę €', true, false, null, 1e21, 0.1]);
  const value = (depth) => {
    const roll = r();
    if (depth <= 0 || roll < 0.35) return scalar();
    if (roll < 0.65) {
      const o = {};
      for (let i = Math.floor(r() * 4); i >= 0; i--) o[pick(keys)] = value(depth - 1);
      return o;
    }
    if (roll < 0.9) {
      const used = new Set();
      const list = [];
      for (let i = Math.floor(r() * 4); i >= 0; i--) {
        const id = pick(ids);
        if (used.has(id) && r() < 0.9) continue;
        used.add(id);
        list.push({ id, ...(r() < 0.7 ? { v: value(depth - 2) } : {}) });
      }
      return list;
    }
    return [scalar(), scalar()];
  };
  /** A copy of `v` with random edits (changed scalars, added/removed keys, list inserts/removals/moves). */
  const mutate = (v, depth) => {
    if (Array.isArray(v)) {
      let out = v.map((x) => (r() < 0.4 ? mutate(x, depth - 1) : x));
      if (r() < 0.3 && out.length) out.splice(Math.floor(r() * out.length), 1);
      if (r() < 0.3) out.splice(Math.floor(r() * (out.length + 1)), 0, { id: pick(ids), v: scalar() });
      if (r() < 0.2 && out.length > 1) out = [...out.slice(1), out[0]];
      return out;
    }
    if (v && typeof v === 'object') {
      const out = { ...v };
      for (const k of Object.keys(out)) if (r() < 0.4) out[k] = mutate(out[k], depth - 1);
      if (r() < 0.2) delete out[pick(Object.keys(out).concat(['none']))];
      if (r() < 0.3) out[pick(keys)] = value(depth - 1);
      return out;
    }
    return r() < 0.6 ? scalar() : v;
  };
  return { value, mutate, r };
}

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

function stateMerge() {
  const g = generator(1201);
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const base = { version: 1, projects: g.value(3), settings: g.value(2), notes: g.value(2) };
    const current = g.mutate(base, 4);
    const next = g.mutate(base, 4);
    rows.push({ current, base, next, out: mergeStateEdit(current, { base, next }) });
  }
  return rows;
}

function stateDiff() {
  const g = generator(1202);
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const prev = { projects: g.value(4), automation: { tasks: g.value(2), events: g.value(2) }, settings: g.value(2) };
    const next = g.mutate(prev, 5);
    const patch = diffState(prev, next);
    rows.push({ prev, next, patch: patch ?? null });
  }
  return rows;
}

function translations() {
  const keys = Object.keys(messages);
  const r = rng(1203);
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const key = keys[Math.floor(r() * keys.length)];
    const params = {};
    for (const m of key.matchAll(/\{(\w+)\}/g)) if (r() < 0.8) params[m[1]] = `v${i}`;
    for (const language of ['en', 'pl', 'de', 'es', 'fr', 'pt']) rows.push({ language, key, params, out: translate(language, key, params) });
  }
  rows.push({ language: 'en', key: 'not a key {x} {y}', params: { x: 1 }, out: translate('en', 'not a key {x} {y}', { x: 1 }) });
  return rows;
}

function atomicWriteNames() {
  // tempPathFor: `${file}.${pid}.${Date.now().toString(36)}${(counter++).toString(36)}.tmp`
  return [[1234, 1762430400123, 0], [1, 0, 35], [99999, 1792067400000, 36]].map(([pid, ms, counter]) => ({ file: 'state.json', pid, ms, counter, out: `state.json.${pid}.${ms.toString(36)}${counter.toString(36)}.tmp` }));
}

/** Texts JSON.stringify writes for strings and keys with unpaired surrogates (a 1.1.x state.json): JSON.parse accepts them. */
function stateLoad() {
  const hi = '\ud83d';
  const lo = '\ude00';
  const strings = [`Proj ${hi}`, `${lo}x`, `${hi}${hi}${lo}`, `${hi}${lo}`, `a${lo}${hi}b`, '\\ud800 literal', '\u{1F600}'.slice(0, 1), 'plain ąę €', ''];
  const wellFormed = (v) => {
    if (typeof v === 'string') return v.toWellFormed();
    if (Array.isArray(v)) return v.map(wellFormed);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toWellFormed(), wellFormed(x)]));
    return v;
  };
  return strings.map((s, i) => {
    const text = JSON.stringify({ version: 1, projects: [{ id: `p${i}`, name: s, dir: 'C:/x', tabs: [] }], notes: { [s || 'k']: [s, 1] } });
    const parsed = JSON.parse(text);
    return { text, jsonParseAccepts: JSON.stringify(parsed) === text, out: JSON.stringify(wellFormed(parsed)) };
  });
}

/** V8's sort of indexes by `key(a) - key(b)` with NaN keys: the order only TimSort itself reproduces. */
function jsSort() {
  const r = rng(1211);
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(r() * (i < 200 ? 100 : 1500));
    const nan = [0, 0.05, 0.3, 0.7][i % 4];
    const runs = i % 5 === 0;
    const keys = Array.from({ length: n }, (_, k) => (r() < nan ? null : runs ? (i % 10 === 0 ? n - k : k) + Math.floor(r() * 3) : Math.floor(r() * (i % 3 ? 50 : 100_000))));
    const key = (k) => (keys[k] === null ? NaN : keys[k]);
    rows.push({ keys, order: keys.map((_, k) => k).sort((a, b) => key(a) - key(b)) });
  }
  return rows;
}

const files = {
  'default-state.json': `${JSON.stringify({ win32: defaultState('win32'), darwin: defaultState('darwin') }, null, 1)}\n`,
  'state-merge.jsonl': jsonl(stateMerge()),
  'state-diff.jsonl': jsonl(stateDiff()),
  'translate.jsonl': jsonl(translations()),
  'atomic-write.jsonl': jsonl(atomicWriteNames()),
  'state-load.jsonl': jsonl(stateLoad()),
  'normalize-state.jsonl': jsonl(normalizeRows({ normalizeState, root })),
  'state-after-edit.jsonl': jsonl(afterEditRows({ normalizeState, normalizeEditedState })),
  'js-sort.jsonl': jsonl(jsSort()),
  'update-progress.jsonl': jsonl(updateProgressRows({ UpdateProgressModel, closeAction })),
};
const updateStrings = updateStringsGolden({ root, translate });
files['update-strings.json'] = `${JSON.stringify(updateStrings, null, 1)}\n`;
files['update-config.json'] = `${JSON.stringify(updateConfigGolden({ strings: updateStrings }), null, 1)}\n`;

const check = process.argv.includes('--check');
let stale = [];
mkdirSync(dir, { recursive: true });
for (const [name, text] of Object.entries(files)) {
  const path = resolve(dir, name);
  if (check) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* missing */ }
    if (current !== text) stale.push(name);
  } else writeFileSync(path, text);
}
if (check && stale.length) {
  console.error(`golden corpus out of date: ${stale.join(', ')} (run \`npm run gen:goldens\`)`);
  process.exit(1);
}
console.log(check ? 'golden corpus up to date' : `wrote ${Object.keys(files).length} golden files to test/golden`);
