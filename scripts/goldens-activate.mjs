// Golden rows of "make main" and its recoveries (1.2.0, PLAN A2), written by scripts/dump-goldens.mjs. The TS code they run is
// 1.1.4's (src/main/accounts/{activate,swap,store,claudeLocks,refresh,dead,guards,refs,cswap,resync}.ts are unchanged since
// v1.1.4), so a Rust run that leaves the same files is 1.1.4's behaviour, byte for byte.
//
//   accounts-activate.jsonl  {kind: 'activate' | 'recover' | 'legacy', input} -> {result, flags, files}
//     input: home files (live credentials / .claude.json texts), accounts.json, profile files, swap-backup files, cswap roster,
//            the renewal answer, one failing rename (activate) or a held Claude Code lock (recover)
//     files: every file under the scratch root afterwards (path relative to it, '/' separated) -> text
//
// New ids are `00000000-0000-4000-8000-<n, 12 digits>` counted from 1 per row on both sides (only `prepare` asks for one
// before any temp file is named). The clock is fixed.
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

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

export const ACTIVATE_NOW = Date.parse('2026-10-16T12:00:00Z');
const NOW = ACTIVATE_NOW;
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const PEOPLE = {
  A: { email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A', org: 'Org A' },
  B: { email: 'b@x.com', accountUuid: 'uuid-B', organizationUuid: 'org-B', org: 'Org ą' },
  X: { email: 'x@x.com', accountUuid: 'uuid-X', organizationUuid: 'org-X', org: 'Org X' },
  Y: { email: 'Y@x.com', org: 'y org' },
};
const hash = (t) => createHash('sha256').update(t).digest('hex');
const ODD_VALUES = [1e21, 0.1, -0, 12345678901234567890, 'ż😀', '\u2028', { 2: 'b', 1: 'a', z: [1, { q: null }] }, [], true, null];

function maker(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const chance = (p) => r() < p;
  const shuffled = (o) => Object.fromEntries(Object.entries(o).sort(() => r() - 0.5));
  const extras = () => { const o = {}; for (let i = Math.floor(r() * 3); i > 0; i--) o[pick(['k', 'mcpOAuth', '7', '0', 'ü', 'nested'])] = pick(ODD_VALUES); return o; };
  const expiry = () => pick([NOW + 3_600_000, NOW + 3_600_000, NOW + 2 * 60_000, NOW + 30_000, NOW - 1000, NOW + 4.5 * 60_000, 'soon', NOW + 0.5]);
  /** Claude Code's credentials file text (or a broken / missing one). */
  const credsText = (tag) => {
    if (chance(0.05)) return pick([null, '{', '[]', '"x"', '']);
    const oauth = chance(0.08)
      ? pick([{ accessToken: '', refreshToken: '', expiresAt: 0, subscriptionType: 'max' }, { accessToken: `acc-${tag}` }, 'x'])
      : shuffled({ accessToken: `acc-${tag}`, refreshToken: `ref-${tag}`, expiresAt: expiry(), scopes: ['user:inference', 'user:profile'], ...(chance(0.5) ? { subscriptionType: pick(['max', 'pro']) } : {}) });
    const body = shuffled({ ...extras(), ...(chance(0.95) ? { claudeAiOauth: oauth } : {}) });
    return JSON.stringify(body, null, chance(0.2) ? 2 : 0);
  };
  const oauthAccount = (who) => {
    if (chance(0.05)) return pick([null, 'x', {}]);
    const p = PEOPLE[who];
    return shuffled({
      emailAddress: chance(0.08) ? pick(['', '  ', 5]) : p.email,
      ...(chance(0.8) && p.org ? { organizationName: p.org } : {}),
      ...(p.accountUuid && chance(0.8) ? { accountUuid: p.accountUuid } : {}),
      ...(p.organizationUuid && chance(0.7) ? { organizationUuid: p.organizationUuid } : {}),
      ...(chance(0.3) ? { displayName: pick(['Zoë', '名前']) } : {}),
    });
  };
  /** A .claude.json text: the live config holds much more than the login. */
  const jsonText = (who) => {
    if (chance(0.05)) return pick([null, '{', '7']);
    const body = shuffled({ ...extras(), ...(who && chance(0.92) ? { oauthAccount: oauthAccount(who) } : {}), ...(chance(0.6) ? { projects: { 'C:\\p': { allowedTools: [] } }, numStartups: 4 } : {}) });
    return JSON.stringify(body, null, pick([2, 2, 0]));
  };
  const record = (id, who) => {
    const p = PEOPLE[who];
    const o = { id, addedAt: pick([1, 1762430400123, 2.5]) };
    for (const k of ['email', 'org', 'accountUuid', 'organizationUuid']) if (p[k] && chance(0.85)) o[k] = p[k];
    if (chance(0.8)) o.custody = pick(['app', 'app', 'live', 'foreign', 'quarantined']);
    if (o.custody === 'quarantined' && chance(0.7)) o.duplicateOf = pick(IDS);
    if (chance(0.8)) o.family = pick(['own', 'live']);
    if (chance(0.15)) o.heldTokens = hash(`ref-${pick(['L', 'A', 'X', 'Q'])}`);
    if (chance(0.15)) o.deadTokens = hash(`ref-${pick(['A', 'X', 'B', 'Q'])}`);
    if (chance(0.3)) o.appSwap = { at: pick([NOW - 60_000, 5]), ...(chance(0.6) ? { from: hash(`ref-${pick(['L', 'X', 'A'])}`) } : {}), ...(chance(0.5) ? { own: true } : {}) };
    return o;
  };
  const roster = () => (chance(0.5) ? { present: false } : chance(0.15) ? { present: true, accounts: null }
    : { present: true, accounts: Object.keys(PEOPLE).filter(() => chance(0.4)).map((w) => ({ email: PEOPLE[w].email, ...(PEOPLE[w].accountUuid ? { accountUuid: PEOPLE[w].accountUuid } : {}) })) });
  return { r, pick, chance, credsText, jsonText, record, roster, oauthAccount };
}

/** Accounts, live identity and profile files of one row. */
function accountsFixture(m) {
  const who = ['A', 'B', 'X', 'Y'].filter(() => m.chance(0.7));
  if (!who.includes('X')) who.push('X');
  const records = who.map((w, i) => m.record(IDS[i], w));
  const liveWho = m.pick(['A', 'A', 'B', 'X', 'Y', null]);
  const body = { version: 2, claude: records };
  if (m.chance(0.85) && liveWho) {
    const p = PEOPLE[liveWho];
    const holder = records.find((rec, i) => who[i] === liveWho);
    body.live = { email: p.email, ...(p.accountUuid ? { accountUuid: p.accountUuid } : {}), ...(holder && m.chance(0.8) ? { recordId: holder.id } : {}) };
  }
  const profiles = {};
  records.forEach((rec, i) => {
    const tag = m.chance(0.85) ? who[i] : `${who[i]}${Math.floor(m.r() * 9)}`;
    profiles[rec.id] = { creds: m.chance(0.85) ? m.credsText(tag) : null, json: m.chance(0.7) ? m.jsonText(who[i]) : null };
  });
  // Mostly a target the rule lets in (another person, held by the app), so the swap itself runs often.
  const others = who.filter((w) => w !== liveWho);
  const targetWho = m.chance(0.7) && others.length ? m.pick(others) : m.pick(who);
  const targetRecord = records[who.indexOf(targetWho)];
  if (m.chance(0.6)) {
    targetRecord.custody = 'app';
    targetRecord.family = m.pick(['own', 'own', 'live']);
    delete targetRecord.deadTokens;
    delete targetRecord.duplicateOf;
    profiles[targetRecord.id].creds = JSON.stringify({ claudeAiOauth: { accessToken: `acc-${targetWho}`, refreshToken: `ref-${targetWho}`, expiresAt: m.pick([NOW + 3_600_000, NOW + 2 * 60_000]) }, ...(m.chance(0.5) ? { mcpOAuth: { s: 1 } } : {}) });
  }
  const target = m.chance(0.05) ? m.pick(['../x', IDS[3]]) : targetRecord.id;
  return { who, liveWho, accounts: JSON.stringify(body, null, 2), profiles, target, records };
}

function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    const path = join(root, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    if (typeof text === 'object') mkdirSync(path, { recursive: true });
    else writeFileSync(path, text);
  }
}

/** Every file under `root` (relative, '/' separated) -> text; directories that hold nothing are listed with null. */
function filesOf(root) {
  const out = {};
  const walk = (dir) => {
    const names = readdirSync(dir).sort();
    if (!names.length && dir !== root) out[relative(root, dir).split(sep).join('/')] = null;
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path).split(sep).join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

let uuidCounter = 0;
const realRandomUUID = crypto.randomUUID;
async function withIds(fn) {
  uuidCounter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
  syncBuiltinESMExports();
  try { return await fn(); } finally { crypto.randomUUID = realRandomUUID; syncBuiltinESMExports(); }
}

const rel = (...parts) => parts.join('/');
const LIVE_CREDS = rel('home', '.claude', '.credentials.json');
const LIVE_JSON = rel('home', '.claude.json');
const profile = (id, name) => rel('accounts', 'claude', id, name);
const backup = (name) => rel('accounts', 'swap-backup', name);

function activateInput(seed) {
  const m = maker(seed);
  const f = accountsFixture(m);
  const files = { [LIVE_CREDS]: m.chance(0.9) ? m.credsText(f.liveWho ? (m.chance(0.85) ? 'L' : f.liveWho) : 'L') : null, [LIVE_JSON]: m.chance(0.95) ? m.jsonText(f.liveWho) : null, 'accounts/accounts.json': f.accounts };
  for (const [id, p] of Object.entries(f.profiles)) { files[profile(id, '.credentials.json')] = p.creds; files[profile(id, '.claude.json')] = p.json; }
  if (m.chance(0.04)) files[backup('swap-journal.json')] = '{"version":1}';
  const refresh = m.pick(['ok', 'ok', 'renew', 'dead', 'transient', 'unusable', 'throw']);
  const renewed = refresh === 'renew' ? m.credsText('R') : null;
  const fail = m.chance(0.3) ? { to: m.pick(['liveCreds', 'liveJson', 'journal', 'outCreds', 'outJson', 'liveBackup']), times: m.pick([1, 1, 99]) } : null;
  const env = m.chance(0.04) ? m.pick([{ CLAUDE_CODE_OAUTH_TOKEN: ' t ' }, { CLAUDE_CONFIG_DIR: 'relative' }, { CLAUDE_CODE_OAUTH_TOKEN: '  ' }]) : {};
  return { files, target: f.target, roster: m.roster(), wroteSince: m.pick([null, true, false]), refresh, renewed, fail, env, darwin: m.chance(0.02) };
}

const PHASES = ['backed-up', 'outgoing-saved', 'live-creds-written', 'live-json-written', 'verified'];
function recoverInput(seed) {
  const m = maker(seed);
  const f = accountsFixture(m);
  const files = { [LIVE_CREDS]: m.chance(0.9) ? m.credsText(m.pick(['L', 'X', 'A', 'N'])) : null, [LIVE_JSON]: m.chance(0.95) ? m.jsonText(m.pick(['A', 'X', 'B', null])) : null, 'accounts/accounts.json': f.accounts };
  for (const [id, p] of Object.entries(f.profiles)) { files[profile(id, '.credentials.json')] = p.creds; files[profile(id, '.claude.json')] = p.json; }
  const outgoing = m.pick([...f.records.map((r) => r.id), null, 'bad']);
  const journal = m.chance(0.06) ? m.pick(['{', 'null', '[]', '{"version":3}'])
    : JSON.stringify(m.chance(0.1) ? { version: 1, accountId: f.target, phase: 'backed-up' } : {
      version: 2, phase: m.chance(0.05) ? 'nope' : m.pick(PHASES), outgoingId: outgoing, targetId: m.chance(0.05) ? 'x' : f.target, created: m.chance(0.3),
      outCredsExisted: m.chance(0.5), outJsonExisted: m.chance(0.5), ...(m.chance(0.8) ? { liveCredsExisted: m.chance(0.8) } : {}), ...(m.chance(0.9) ? { startedAt: m.pick([NOW - 5000, 'x']) } : {}),
    });
  if (m.chance(0.92)) files[backup('swap-journal.json')] = journal;
  if (m.chance(0.85)) files[backup('live-credentials.json')] = m.credsText(m.pick(['L', 'A']));
  if (m.chance(0.85)) files[backup('live-claude.json')] = m.jsonText(m.pick(['A', 'A', 'B', null]));
  if (m.chance(0.4)) files[backup('outgoing-credentials.json')] = m.credsText('A');
  if (m.chance(0.4)) files[backup('outgoing-claude.json')] = m.jsonText('A');
  if (m.chance(0.1)) files[backup('live-claude.json.123e4567-e89b-42d3-a456-426614174000.tmp')] = '{}';
  if (m.chance(0.1)) files[backup('main-credentials.json')] = m.credsText('A');
  const locked = m.chance(0.08);
  return { files, locked };
}

const LEGACY_PHASES = ['backed-up', 'target-written', 'main-creds-written', 'main-json-written', 'rolling-back', 'verified'];
function legacyInput(seed) {
  const m = maker(seed);
  const f = accountsFixture(m);
  const id = f.records.find((r) => r.id === f.target)?.id ?? IDS[0];
  const blob = (tag) => (m.chance(0.1) ? m.credsText(tag) : JSON.stringify({ claudeAiOauth: { accessToken: `acc-${tag}`, refreshToken: `ref-${tag}`, expiresAt: NOW + 3_600_000 }, ...(m.chance(0.5) ? { mcpOAuth: { s: tag } } : {}) }));
  const lineage = () => m.pick(['A', 'X', 'A2', 'Q', null]);
  const files = { 'accounts/accounts.json': f.accounts };
  const mainTag = lineage(); const targetTag = lineage();
  files[LIVE_CREDS] = mainTag ? blob(mainTag) : null;
  files[LIVE_JSON] = m.chance(0.95) ? m.jsonText(m.pick(['A', 'X', 'B'])) : null;
  files[profile(id, '.credentials.json')] = targetTag ? blob(targetTag) : null;
  files[profile(id, '.claude.json')] = m.chance(0.8) ? m.jsonText(m.pick(['X', 'A'])) : null;
  if (m.chance(0.9)) files[backup('swap-journal.json')] = m.chance(0.05) ? 'nope' : JSON.stringify({ version: 1, accountId: m.chance(0.05) ? 'x' : id, startedAt: 1, phase: m.pick(LEGACY_PHASES), targetJsonExisted: m.chance(0.7) });
  if (m.chance(0.9)) files[backup('main-credentials.json')] = blob(m.chance(0.9) ? 'A' : 'Q');
  if (m.chance(0.9)) files[backup('main-claude.json')] = m.jsonText('A');
  if (m.chance(0.9)) files[backup('target-credentials.json')] = blob(m.chance(0.9) ? 'X' : 'Q');
  if (m.chance(0.7)) files[backup('target-claude.json')] = m.jsonText('X');
  if (m.chance(0.15)) files[rel('home', '.claude', '.credentials.json.123e4567-e89b-42d3-a456-426614174000.tmp')] = 'x';
  if (m.chance(0.1)) files[rel('home', '.claude', 'notes.tmp')] = 'x';
  return { files };
}

/** `{ ...nodeSwapFs, rename }` that fails renames onto the named file `times` times (EIO). */
function failingFs(nodeSwapFs, root, fail, records) {
  if (!fail) return nodeSwapFs;
  const targets = {
    liveCreds: [join(root, 'home', '.claude', '.credentials.json')], liveJson: [join(root, 'home', '.claude.json')],
    journal: [join(root, 'accounts', 'swap-backup', 'swap-journal.json')], liveBackup: [join(root, 'accounts', 'swap-backup', 'live-credentials.json')],
    outCreds: records.map((id) => join(root, 'accounts', 'claude', id, '.credentials.json')), outJson: records.map((id) => join(root, 'accounts', 'claude', id, '.claude.json')),
  }[fail.to];
  let left = fail.times;
  return { ...nodeSwapFs, rename: async (from, to) => { if (targets.includes(to) && left > 0) { left--; throw Object.assign(new Error('boom'), { code: 'EIO' }); } return nodeSwapFs.rename(from, to); } };
}

export async function activateRows({ activate, swap, AccountsStore }) {
  const base = mkdtempSync(join(tmpdir(), 'unimux-goldens-activate-'));
  const rows = [];
  const deps = (root, input, extra = {}) => ({
    home: join(root, 'home'), env: input.env ?? {}, platform: input.darwin ? 'darwin' : 'win32', store: new AccountsStore(join(root, 'accounts')),
    backupDir: join(root, 'accounts', 'swap-backup'), now: () => NOW, delay: async () => undefined, locks: { timeoutMs: 50 },
    refresh: async (dir) => {
      switch (input.refresh) {
        case 'renew': if (input.renewed !== null) writeFileSync(join(dir, '.credentials.json'), input.renewed); return { kind: 'ok' };
        case 'throw': throw new Error('network');
        case undefined: return { kind: 'ok' };
        default: return { kind: input.refresh };
      }
    },
    cswap: async () => input.roster ?? { present: false },
    ...(input.wroteSince === null || input.wroteSince === undefined ? {} : { cswapWroteSince: async () => input.wroteSince }),
    ...extra,
  });
  try {
    let n = 0;
    for (let s = 0; s < 220; s++) {
      const input = activateInput(31_000 + s);
      const root = join(base, String(n++));
      mkdirSync(root, { recursive: true });
      writeFiles(root, input.files);
      const ids = Object.keys(input.files).filter((p) => p.startsWith('accounts/claude/')).map((p) => p.split('/')[2]);
      swap.setSwapUnresolved(false);
      const result = await withIds(() => activate.activateAccount(deps(root, input, { fs: failingFs(swap.nodeSwapFs, root, input.fail, [...new Set(ids)]) }), input.target));
      rows.push({ kind: 'activate', input, out: { result, flags: { unresolved: swap.isSwapUnresolved() }, files: filesOf(root) } });
    }
    for (let s = 0; s < 160; s++) {
      const input = recoverInput(32_000 + s);
      const root = join(base, String(n++));
      mkdirSync(root, { recursive: true });
      writeFiles(root, input.files);
      if (input.locked) mkdirSync(join(root, 'home', '.claude.lock'), { recursive: true });
      swap.setSwapUnresolved(false);
      const result = await withIds(() => activate.recoverInterruptedActivation(deps(root, {})));
      if (input.locked) rmSync(join(root, 'home', '.claude.lock'), { recursive: true, force: true });
      rows.push({ kind: 'recover', input, out: { result, flags: { unresolved: swap.isSwapUnresolved(), recoveryPending: activate.isActivationRecoveryPending() }, files: filesOf(root) } });
    }
    for (let s = 0; s < 120; s++) {
      const input = legacyInput(33_000 + s);
      const root = join(base, String(n++));
      mkdirSync(root, { recursive: true });
      writeFiles(root, input.files);
      swap.setSwapUnresolved(false);
      const result = await withIds(() => swap.recoverInterruptedSwap(deps(root, {})));
      rows.push({ kind: 'legacy', input, out: { result, flags: { unresolved: swap.isSwapUnresolved() }, files: filesOf(root) } });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  return rows;
}

