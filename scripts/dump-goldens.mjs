// The golden corpus (1.2.0, PLAN F10): what the TS reference code answers for a fixed set of inputs, so the Rust ports are
// checked against the real behaviour (src-tauri/crates/*/tests/golden*.rs). Inputs come from a seeded PRNG, so the files are
// reproducible; CI runs `--check` (npm run gen:check) and fails on any difference.
//
// Two kinds of files since R1 removed Electron and its TS main process:
//
// - LIVE: made from TS that still exists (src/shared, Node itself), regenerated here and compared byte for byte:
//   test/golden/default-state.json   defaultState(win32 | darwin)
//   test/golden/state-merge.jsonl    {current, base, next} -> mergeStateEdit
//   test/golden/state-diff.jsonl     {prev, next} -> diffState
//   test/golden/translate.jsonl      {language, key, params} -> translate
//   test/golden/atomic-write.jsonl   {file, pid, ms, counter} -> the temp name tempPathFor gave
//   test/golden/state-load.jsonl     {text} (JSON.stringify output, lone surrogates included) -> what 1.2.0 reads: JSON.parse
//                                     accepts it, a lone surrogate becomes U+FFFD (a Rust string cannot hold one)
//   test/golden/normalize-state.jsonl   {platform, now, input} -> normalizeState (see scripts/goldens-normalize.mjs)
//   test/golden/js-sort.jsonl        {keys} (null is NaN) -> the order V8's Array.prototype.sort gives indexes compared by
//                                     keys[a] - keys[b], an inconsistent comparator included (the inbox retention sort)
//   test/golden/update-progress.jsonl   the update window's progress model (see scripts/goldens-update.mjs)
//   test/golden/detached.jsonl       {fn, args, out} of src/shared/detached.ts (see scripts/goldens-detached.mjs)
//   test/golden/route-message.jsonl  {channel, args, owners, out} -> routeMessage (shared with vitest)
//   test/golden/git-text.jsonl       {value, max} -> trimGitText(value, max) and redactSecrets(value) of src/shared/git.ts
//   test/golden/git-resolve.jsonl    {args} -> path.win32.resolve / path.posix.resolve of Node with process.cwd() C:\work\cwd
//                                     (win32) or /work/cwd (posix) and the drive cwds =C: C:\work\cwd, =D: D:\dcwd\x, =E:
//                                     C:\not-e, =F: '' (the env of the run is replaced while the rows are made)
//   test/golden/git-shared.jsonl     src/shared/git.ts (PLAN G2; see scripts/goldens-git.mjs)
//   test/golden/db-sql.jsonl, db-redis.jsonl  {fn, args} -> the DB helpers of src/shared (see scripts/goldens-db.mjs)
//   test/golden/changelog.jsonl, monitor.jsonl   parseReleases / compareVersions and the Monitor panel's trees (see
//                                     scripts/goldens-g8.mjs)
//   test/golden/context-scan.jsonl   the context meter's line scan of src/shared/contextUsage.ts (scripts/goldens-sessions.mjs)
//   test/golden/ssh-history-rules.jsonl   the command history rules of src/shared/commandHistory.ts (scripts/goldens-ssh.mjs)
//
// - FROZEN: made until R1 by 1.1.4's main-process code (state-after-edit, git-spelling, git-trust, files-*, search-*,
//   hook-*, conv-*, db-ipc, the account stores, sessions-*, context-backward, the SSH stores, accounts-activate, launch,
//   mcp-*, update-strings / update-config). That code is gone, so these files are fixed: test/golden/FROZEN.sha256 holds
//   their hashes and `--check` fails when one changes or disappears. A deliberate change (a translation inside
//   update-strings.json, say) edits the file by hand and runs `node scripts/dump-goldens.mjs --refreeze` to record the new
//   hashes; review that diff like code.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeRows } from './goldens-normalize.mjs';
import { updateProgressRows } from './goldens-update.mjs';
import { detachedRows, routeMessageRows } from './goldens-detached.mjs';
import path, { dirname, resolve } from 'node:path';
import { DB_MODULES, dbGoldens } from './goldens-db.mjs';
import { gitSharedRows } from './goldens-git.mjs';
import { g8Goldens } from './goldens-g8.mjs';
import { contextScanRows } from './goldens-sessions.mjs';
import { historyRuleRows } from './goldens-ssh.mjs';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'test/golden');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;

const [
  { defaultState, normalizeState }, { mergeStateEdit }, { diffState }, { translate }, { messages }, { UpdateProgressModel, closeAction },
  gitShared,
] = await Promise.all([
  load('src/shared/state.ts'), load('src/shared/stateEdits.ts'), load('src/shared/statePatch.ts'), load('src/shared/i18n.ts'), load('src/shared/messages.ts'),
  load('src/shared/updateProgress.ts'), load('src/shared/git.ts'),
]);
const { trimGitText, redactSecrets } = gitShared;
const [detached, { normalizeWaitMark }] = await Promise.all([load('src/shared/detached.ts'), load('src/shared/waiting.ts')]);
const dbModules = Object.fromEntries(await Promise.all(Object.entries(DB_MODULES).map(async ([name, file]) => [name, await load(file)])));
const db = dbGoldens(dbModules);
const [contextShared, historyRules] = await Promise.all([load('src/shared/contextUsage.ts'), load('src/shared/commandHistory.ts')]);
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

/** Node's path.win32.resolve / path.posix.resolve (git.ts resolves the common git dir and the clone lock key with it), with a
 *  fixed process.cwd() and drive cwds (process.env['=D:']) so the rows do not depend on the machine. */
const RESOLVE_CWD = { win32: 'C:\\work\\cwd', posix: '/work/cwd' };
const RESOLVE_DRIVE_CWDS = { '=C:': 'C:\\work\\cwd', '=D:': 'D:\\dcwd\\x', '=E:': 'C:\\not-e', '=F:': '' };
function gitResolve() {
  const B = '\\';
  const bases = [
    'C:/x/repo', `C:${B}x${B}repo${B}`, `c:${B}x`, `C:${B}`, 'C:', `C:rel${B}dir`, 'D:sub', 'd:', 'E:sub', 'F:sub', `${B}${B}server${B}share${B}dir`,
    '//server/share', `${B}${B}server${B}share`, `${B}${B}?${B}C:${B}x`, `${B}${B}.${B}pipe${B}x`, '/abs/posix/', 'rel/dir', '', '.', `${B}rooted`, 'C:/a',
  ];
  const ps = [
    '.git', '../a/b.', 'sub/ ', 'x/', 'x/./y/../z/', 'b.', 'b ', '..', '../../../../..', '/etc', 'C:/other/.git', `D:${B}y`, 'd:rel', 'E:', 'F:x',
    `${B}${B}srv${B}sh${B}.git`, '', '.', `C:${B}x${B}repo${B}.git${B}worktrees${B}wt`, 'ZAŻÓŁĆ/..', '😀/x', `a//b${B}${B}c`, '...', '.../x', '..a/..b', 'con', 'nul.txt',
  ];
  const rows = [[]];
  for (const p of [...bases, ...ps]) rows.push([p]);
  for (const base of bases) for (const p of ps) rows.push([base, p]);
  rows.push(['C:/a', 'D:b', 'c']);
  rows.push(['C:/a', 'b', '//server/share/c', '..']);
  const savedCwd = process.cwd;
  const savedEnv = process.env;
  try {
    const env = {};
    for (const [k, v] of Object.entries(RESOLVE_DRIVE_CWDS)) env[k] = env[k.toLowerCase()] = v;
    process.env = env;
    return rows.map((args) => {
      process.cwd = () => RESOLVE_CWD.win32;
      const win32 = path.win32.resolve(...args);
      process.cwd = () => RESOLVE_CWD.posix;
      const posix = path.posix.resolve(...args);
      return { args, win32, posix };
    });
  } finally {
    process.cwd = savedCwd;
    process.env = savedEnv;
  }
}

/** git output with credentials, Authorization headers, tokens, ANSI, CRLF, hint lines, blank runs, JS white space and long tails. */
function gitText() {
  const r = rng(1302);
  const E = '\u001b';
  const fixed = [
    '', '   ', 'hint: only hints\nHINT: here', 'error: x\r\nhint: y\n\n\n\nfatal: z\n', `${E}[31mred${E}[0m ${E}[?25lcursor`,
    "fatal: unable to access 'https://user:s3cr3t-token@127.0.0.1:1/nope.git/': Failed to connect",
    'remote: Authorization: Bearer abc.def\nauthorization:basic Zm9vOmJhcg== x', 'AUTHORIZATION: Token  t0k3n', 'Authorization:\u00a0bearer\u3000x',
    'ghp_0123456789abcdefghijABCD ghs_0123456789abcdefghijABCD_x github_pat_0123456789abcdefghij_KLM glpat-0123456789abcdef-x',
    'żghp_0123456789abcdefghijABCD aghp_0123456789abcdefghijABCD ghp_0123456789abcdefghijABCDé', 'ssh://git@host:22/x git+ssh://a:b@c/d ſsh://u@h',
    '\u00a0\ufeff text \u0085\u2028', '\u0085 nel stays \u0085', 'line1\n\n\nline2\n\n\n\n\nline3', 'hint: a\nreal\nhint: b\n', 'hınt: dotless\nhint: x',
  ];
  const parts = ['error: ', 'fatal: ', 'hint: ', 'remote: ', 'https://u:p@h/x ', 'ghp_0123456789abcdefghijABCDEFG ', 'zażółć ', '😀', '\n', '\r\n',
    '\n\n\n', `${E}[1;32m`, `${E}[0m`, '\t', ' ', '\u3000', '\u0085', 'Authorization: basic xyz ', 'warning: LF will be replaced ', 'x'.repeat(50)];
  const rows = fixed.map((value) => ({ value, max: 600 }));
  for (let i = 0; i < 300; i++) {
    let value = '';
    for (let n = 1 + Math.floor(r() * (i < 150 ? 12 : 80)); n > 0; n--) value += parts[Math.floor(r() * parts.length)];
    rows.push({ value, max: [600, 600, 400, 50, 7][i % 5] });
  }
  // a cut right inside a surrogate pair: the tail starts with a lone half (JSON.stringify writes it as \udXXX)
  rows.push({ value: `${'a'.repeat(10)}😀${'b'.repeat(9)}`, max: 10 });
  return rows.map(({ value, max }) => ({ value, max, trimmed: trimGitText(value, max), redacted: redactSecrets(value) }));
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
  'js-sort.jsonl': jsonl(jsSort()),
  'update-progress.jsonl': jsonl(updateProgressRows({ UpdateProgressModel, closeAction })),
  'detached.jsonl': jsonl(detachedRows({ ...detached, normalizeWaitMark })),
  'route-message.jsonl': jsonl(routeMessageRows(detached)),
  'git-text.jsonl': jsonl(gitText()),
  'git-resolve.jsonl': jsonl(gitResolve()),
  'git-shared.jsonl': jsonl(gitSharedRows(gitShared)),
  'db-sql.jsonl': jsonl(db['db-sql.jsonl']),
  'db-redis.jsonl': jsonl(db['db-redis.jsonl']),
  ...Object.fromEntries(Object.entries(await g8Goldens(load)).map(([name, rows]) => [name, jsonl(rows)])),
  'context-scan.jsonl': jsonl(contextScanRows(contextShared)),
  'ssh-history-rules.jsonl': jsonl(historyRuleRows(historyRules)),
};

// ── the frozen files ─────────────────────────────────────────────────────────────────────────────────────────────────────
const FROZEN = resolve(dir, 'FROZEN.sha256');
/** The hash of a file's text with LF line ends (a checkout with CRLF ends hashes the same). */
const sha256 = (file) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
/** [{hash, name}] of FROZEN.sha256 (`<sha256>  <file>` per line, `#` comments). */
const frozenList = () => readFileSync(FROZEN, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => { const [hash, name] = l.trim().split(/\s+/); return { hash, name }; });

if (process.argv.includes('--refreeze')) {
  const header = readFileSync(FROZEN, 'utf8').split('\n').filter((l) => l.startsWith('#'));
  const rows = frozenList().map(({ name }) => `${sha256(resolve(dir, name))}  ${name}`);
  writeFileSync(FROZEN, `${[...header, ...rows].join('\n')}\n`);
  console.log(`recorded the hashes of ${rows.length} frozen golden files`);
  process.exit(0);
}

const check = process.argv.includes('--check');
const stale = [];
mkdirSync(dir, { recursive: true });
for (const [name, text] of Object.entries(files)) {
  const file = resolve(dir, name);
  if (check) {
    let current = '';
    try { current = readFileSync(file, 'utf8'); } catch { /* missing */ }
    if (current !== text) stale.push(name);
  } else writeFileSync(file, text);
}
const frozen = frozenList();
const live = new Set(Object.keys(files));
const changed = frozen.filter(({ hash, name }) => {
  if (live.has(name)) return true; // listed twice: a frozen file must not be regenerated
  try { return sha256(resolve(dir, name)) !== hash; } catch { return true; }
}).map(({ name }) => name);
if (stale.length) console.error(`golden corpus out of date: ${stale.join(', ')} (run \`npm run gen:goldens\`)`);
if (changed.length) console.error(`frozen golden files changed or missing: ${changed.join(', ')} (made by 1.1.4's main-process code; see the header of scripts/dump-goldens.mjs)`);
if (stale.length || changed.length) process.exit(1);
console.log(check ? `golden corpus up to date (${live.size} live, ${frozen.length} frozen)` : `wrote ${live.size} golden files to test/golden; ${frozen.length} frozen files unchanged`);
