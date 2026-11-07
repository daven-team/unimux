// Golden rows of the account stores and identity helpers (1.2.0, PLAN A1), written by scripts/dump-goldens.mjs. The TS code
// they run is 1.1.4's (src/main/accounts and src/shared/{accounts,codexAccounts}.ts are unchanged since v1.1.4), so a Rust
// answer equal to a row is 1.1.4's answer, and a file the Rust store writes equal to `text` is the file 1.1.4 writes.
//
//   accounts-store.jsonl     {file, ops} -> {results, readOnly, version, list, live, notices, text, backups, dirs}
//                             file: the text of accounts.json (null: missing, {dir: true}: a directory)
//   codex-accounts.jsonl     the same for codex-accounts/accounts.json (list, live, readOnly, text, dirs)
//   accounts-identity.jsonl  {fn, args} -> {out} of the pure helpers
//
// New ids (prepare, addNotice) are `00000000-0000-4000-8000-<n, 12 digits>` counted from 1 per row on both sides.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

let uuidCounter = 0;
const realRandomUUID = crypto.randomUUID;
/** randomUUID of the store modules, counted per row (they import it from 'crypto'). */
function withIds(fn) {
  uuidCounter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
  syncBuiltinESMExports();
  try { return fn(); } finally { crypto.randomUUID = realRandomUUID; syncBuiltinESMExports(); }
}

const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '00000000-0000-4000-8000-000000000001'];
const BAD_IDS = ['11111111-1111-4111-8111-11111111111', 'AAAAAAAA-1111-4111-8111-111111111111', '', 'x', 42, null];
const HEX = ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'];
const BAD_HEX = ['BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD', 'abc', '', 7];
const TEXTS = ['a@x.pl', ' A@X.PL ', 'b@y.com', '', '   ', 'Org ąę', 'ACME', 'acme ', 'x'.repeat(120), 'y'.repeat(121), '\u{1F600}'.repeat(60), `${'\u{1F600}'.repeat(60)}a`,
  'İstanbul@x', 'ΣΑΣ', '　', 'z'.repeat(200), 'w'.repeat(201)];
const ODD = [42, null, true, {}, ['a']];
const NUMBERS = [1762430400123, 0, 1.5, 1e21, 0.1, -5, 1792067400000.25, 9007199254740993];

function maker(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const chance = (p) => r() < p;
  const text = () => (chance(0.1) ? pick(ODD) : pick(TEXTS));
  const id = () => (chance(0.12) ? pick(BAD_IDS) : pick(IDS));
  const hex = () => (chance(0.25) ? pick(BAD_HEX) : pick(HEX));
  const num = () => (chance(0.08) ? pick(['12', null, true]) : pick(NUMBERS));
  /** Fields in a shuffled order (JSON.parse keeps it; the store rebuilds its own order). */
  const shuffled = (o) => Object.fromEntries(Object.entries(o).sort(() => r() - 0.5));
  const identity = (o = {}) => {
    for (const key of ['email', 'org', 'accountUuid', 'organizationUuid']) if (chance(0.55)) o[key] = key.endsWith('Uuid') && chance(0.5) ? pick(IDS) : text();
    return o;
  };
  const account = () => {
    const o = { id: id(), addedAt: num() };
    identity(o);
    if (chance(0.5)) o.custody = pick(['app', 'live', 'foreign', 'quarantined', 'other', 3]);
    if (chance(0.5)) o.family = pick(['own', 'live', 'x']);
    if (chance(0.3)) o.duplicateOf = id();
    if (chance(0.25)) o.heldTokens = hex();
    if (chance(0.25)) o.deadTokens = hex();
    if (chance(0.3)) o.appSwap = chance(0.1) ? pick(ODD) : { at: num(), ...(chance(0.6) ? { from: hex() } : {}), ...(chance(0.5) ? { own: pick([true, false, 1]) } : {}) };
    if (chance(0.15)) o.extra = 'kept?';
    return shuffled(o);
  };
  const notice = () => {
    const o = { id: chance(0.1) ? pick(['', 'n'.repeat(65), 5]) : `n-${Math.floor(r() * 30)}`, kind: pick(['switchedOut', 'loggedOut', 'adopted', 'migrated', 'quarantined', 'quarantined', 'bogus']), at: num() };
    if (chance(0.5)) o.email = text();
    if (chance(0.4)) o.recordId = id();
    if (chance(0.4)) o.count = pick([0, 3, 1.5, -1, '2', -0]);
    return shuffled(o);
  };
  const live = () => {
    const o = identity({});
    if (chance(0.5)) o.recordId = id();
    return shuffled(o);
  };
  return { r, pick, chance, text, id, hex, num, identity, account, notice, live };
}

// ── accounts/accounts.json ───────────────────────────────────────────────────

const FIXED_FILES = [
  null, { dir: true }, '', 'not json', '{"claude": [', 'null', '[]', '"x"', '{}', '{"claude":{}}', '{"version":2}', '{"version":3,"claude":[]}',
  '{"version":"2","claude":[]}', '{"version":1.5,"claude":[]}', '{"version":0,"claude":[]}', '{"version":2.0,"claude":[]}', '{"version":1e0,"claude":[]}',
  '{"version":2,"claude":[],"notices":{}}', '{"version":2,"claude":[],"live":[]}', '{"version":2,"claude":[],"live":null}', '{"version":2,"claude":[],"notices":null}',
  '﻿{"version":2,"claude":[]}', '{"version":2,"claude":[{"id":"11111111-1111-4111-8111-111111111111","addedAt":-0,"email":"a@x.pl"}]}',
  '{"version":2,"claude":[{"id":"11111111-1111-4111-8111-111111111111","addedAt":1.0e3,"appSwap":{"at":2.50}}],"notices":[{"id":"a","kind":"adopted","at":1E2,"count":-0}]}',
  '{"version":2,"claude":[{"id":"11111111-1111-4111-8111-111111111111","addedAt":12345678901234567890}]}',
  '{"version":2,"claude":[{"id":"11111111-1111-4111-8111-111111111111","addedAt":1,"email":"a\\ud800b"}]}',
  '{"claude":[{"id":"11111111-1111-4111-8111-111111111111","addedAt":1,"email":"a@x.pl"},{"id":"11111111-1111-4111-8111-111111111111","addedAt":2}]}',
];

function storeOp(m, i) {
  const { pick, chance, id, hex, num, identity, account, live, notice, text } = m;
  const nullable = (f) => (chance(0.3) ? null : f());
  switch (i) {
    case 0: return ['markMigrated'];
    case 1: return ['setLive', chance(0.25) ? null : live()];
    case 2: { const n = notice(); return ['addNotice', { kind: pick(['switchedOut', 'loggedOut', 'adopted', 'migrated', 'quarantined']), at: pick([1762430400123, 1.5, 0]), ...(chance(0.5) ? { email: pick(['a@x.pl', '', 'y'.repeat(121)]) } : {}), ...(n.recordId && typeof n.recordId === 'string' ? { recordId: n.recordId } : {}), ...(chance(0.4) ? { count: pick([0, 2, 1.5, -1]) } : {}) }]; }
    case 3: return ['dismissNotice', pick(['n-1', 'n-2', 'n-3', '00000000-0000-4000-8000-000000000001', 'x'])];
    case 4: return ['commit', chance(0.15) ? { ...account(), id: pick(BAD_IDS) } : account()];
    case 5: { const p = {}; if (chance(0.6)) p.email = nullable(() => pick(TEXTS)); if (chance(0.6)) p.org = nullable(() => pick(TEXTS)); return ['update', id(), p]; }
    case 6: { const ident = {}; for (const [k, v] of Object.entries(identity({}))) if (typeof v === 'string') ident[k] = v; return ['updateIdentity', id(), ident, chance(0.5)]; }
    case 7: return ['setCustody', id(), pick(['app', 'live', 'foreign', 'quarantined']), nullable(() => id())];
    case 8: return ['setFamily', id(), pick(['own', 'live'])];
    case 9: return ['setHeldTokens', id(), nullable(() => String(hex()))];
    case 10: return ['setDeadTokens', id(), nullable(() => String(hex()))];
    case 11: return ['setAppSwap', id(), nullable(() => ({ at: num() === null ? 1 : Number(num()) || 0, ...(chance(0.6) ? { from: String(hex()) } : {}), ...(chance(0.5) ? { own: chance(0.5) } : {}) }))];
    case 12: return ['remove', chance(0.2) ? pick(['x', 'AAAAAAAA-1111-4111-8111-111111111111']) : id()];
    case 13: return ['prepare'];
    default: return ['noop', text()];
  }
}

const errorName = (e) => (e?.name === 'AccountsReadOnlyError' || e?.constructor?.name === 'CodexAccountsReadOnlyError' ? 'readOnly' : e?.message === 'invalid account' ? 'invalidAccount' : e?.message === 'invalid account id' ? 'invalidId' : `other: ${e?.message}`);
const und = (v) => (v === null ? undefined : v);

function runStoreOp(store, op) {
  const [name, ...a] = op;
  switch (name) {
    case 'markMigrated': return store.markMigrated();
    case 'setLive': return store.setLive(a[0]);
    case 'addNotice': return store.addNotice(a[0]);
    case 'dismissNotice': return store.dismissNotice(a[0]);
    case 'commit': return store.commit(a[0]);
    case 'update': return store.update(a[0], Object.fromEntries(Object.entries(a[1]).map(([k, v]) => [k, und(v)])));
    case 'updateIdentity': return store.updateIdentity(a[0], a[1], { replace: a[2] });
    case 'setCustody': return store.setCustody(a[0], a[1], und(a[2]));
    case 'setFamily': return store.setFamily(a[0], a[1]);
    case 'setHeldTokens': return store.setHeldTokens(a[0], und(a[1]));
    case 'setDeadTokens': return store.setDeadTokens(a[0], und(a[1]));
    case 'setAppSwap': return store.setAppSwap(a[0], und(a[1]));
    case 'remove': return store.remove(a[0]);
    case 'prepare': return store.prepare().id;
    // The no-op rewrite of a 1.1.4 file: the live identity set to itself.
    case 'noop': return store.setLive(store.live());
    default: throw new Error(name);
  }
}

function writeInput(root, file) {
  mkdirSync(root, { recursive: true });
  if (file === null) return;
  if (typeof file === 'object') { mkdirSync(join(root, 'accounts.json')); return; }
  writeFileSync(join(root, 'accounts.json'), file);
}

function outputOf(root, extra) {
  const path = join(root, 'accounts.json');
  let text = null;
  try { text = readFileSync(path, 'utf8'); } catch { /* missing or a directory */ }
  const names = existsSync(root) ? readdirSync(root) : [];
  const backups = names.filter((n) => n.startsWith('accounts.json.bak-')).map((n) => readFileSync(join(root, n), 'utf8'));
  const sub = (d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).sort() : []);
  return { ...extra, text, backups, dirs: { claude: sub('claude'), profiles: sub('profiles') }, temps: names.filter((n) => n.endsWith('.tmp')).length };
}

export function accountsStoreRows({ AccountsStore }) {
  const base = mkdtempSync(join(tmpdir(), 'unimux-goldens-accounts-'));
  const rows = [];
  try {
    const files = [...FIXED_FILES];
    // Files 1.1.4 wrote itself (its own writes from random records), then random hand-made ones.
    for (let s = 0; s < 260; s++) {
      const m = maker(9000 + s);
      const body = { version: m.pick([2, 2, 2, 1]), claude: Array.from({ length: Math.floor(m.r() * 5) }, m.account) };
      if (m.chance(0.6)) body.live = m.live();
      if (m.chance(0.5)) body.notices = Array.from({ length: Math.floor(m.r() * 4) }, m.notice);
      if (m.chance(0.3)) delete body.version;
      files.push(JSON.stringify(body, null, m.pick([0, 1, 2, '\t'])));
    }
    let n = 0;
    for (const [index, file] of files.entries()) {
      const m = maker(500 + index);
      const opCount = index < FIXED_FILES.length ? 2 : Math.floor(m.r() * 6);
      const ops = [];
      if (index < FIXED_FILES.length) ops.push(['noop', ''], storeOp(m, 2));
      else for (let k = 0; k < opCount; k++) ops.push(storeOp(m, Math.floor(m.r() * 15)));
      // Every 1.1.4-written file (TS store output) also gets a pure no-op row: rewritten byte-identically.
      rows.push(storeRow(AccountsStore, join(base, String(n++)), file, ops));
    }
    // 1.1.4 accounts dirs written through the 1.1.4 store itself, then a no-op: the text must stay byte-identical.
    for (let s = 0; s < 60; s++) {
      const m = maker(20000 + s);
      const root = join(base, `own-${s}`);
      mkdirSync(root, { recursive: true });
      withIds(() => {
        const store = new AccountsStore(root);
        for (let k = 0; k < 4 + Math.floor(m.r() * 10); k++) { try { runStoreOp(store, storeOp(m, Math.floor(m.r() * 14))); } catch { /* refused ops are part of the history */ } }
      });
      let text = null;
      try { text = readFileSync(join(root, 'accounts.json'), 'utf8'); } catch { /* none written */ }
      if (text !== null) rows.push({ ...storeRow(AccountsStore, join(base, String(n++)), text, [['noop', '']]), written114: true });
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
  return rows;
}

function storeRow(AccountsStore, root, file, ops) {
  writeInput(root, file);
  return withIds(() => {
    const store = new AccountsStore(root);
    const results = ops.map((op) => { try { const out = runStoreOp(store, op); return out === undefined ? null : { ok: out }; } catch (e) { return { error: errorName(e) }; } });
    return { file, ops, out: outputOf(root, { results, readOnly: store.readOnly(), version: store.version(), list: store.list(), live: store.live(), notices: store.notices() }) };
  });
}

// ── codex-accounts/accounts.json ─────────────────────────────────────────────

const CODEX_FIXED = [null, { dir: true }, '', 'nope', 'null', '[]', '7', '{}', '{"version":2,"accounts":[]}', '{"version":"1","accounts":[]}', '{"version":1.0,"accounts":[]}',
  '{"accounts":{}}', '{"version":1,"accounts":[{"id":"11111111-1111-4111-8111-111111111111","addedAt":-0}],"live":{"recordId":"11111111-1111-4111-8111-111111111111"}}',
  '{"version":1,"accounts":[{"id":"11111111-1111-4111-8111-111111111111","addedAt":1,"email":"a@x"},{"id":"11111111-1111-4111-8111-111111111111","addedAt":2}]}',
  '﻿{"version":1,"accounts":[]}'];

function codexMaker(seed) {
  const m = maker(seed);
  const { pick, chance } = m;
  const ident = (o = {}) => { for (const key of ['email', 'userId', 'accountId']) if (chance(0.55)) o[key] = chance(0.1) ? pick(ODD) : pick(TEXTS); return o; };
  const account = () => {
    const o = { id: m.id(), addedAt: m.num() };
    ident(o);
    if (chance(0.3)) o.liveFamily = pick([true, false, 1]);
    if (chance(0.3)) o.outdated = pick([true, false, 'yes']);
    if (chance(0.1)) o.extra = 1;
    return Object.fromEntries(Object.entries(o).sort(() => m.r() - 0.5));
  };
  const live = () => { const o = ident({}); if (chance(0.5)) o.recordId = m.id(); return o; };
  const strIdent = () => Object.fromEntries(Object.entries(ident({})).filter(([, v]) => typeof v === 'string'));
  return { ...m, ident, account, live, strIdent };
}

function codexOp(m, i) {
  const { pick, chance } = m;
  switch (i) {
    case 0: return ['setLive', chance(0.25) ? null : { ...m.strIdent(), ...(chance(0.5) ? { recordId: pick(IDS) } : {}) }];
    case 1: { const a = { id: chance(0.1) ? 'bad' : pick(IDS), addedAt: pick([1, 1.5, 1762430400123]), ...m.strIdent() }; if (chance(0.3)) a.liveFamily = true; if (chance(0.3)) a.outdated = true; return ['commit', a]; }
    case 2: {
      const p = {};
      for (const key of ['email', 'userId', 'accountId']) if (chance(0.4)) p[key] = chance(0.3) ? null : pick(TEXTS);
      for (const key of ['liveFamily', 'outdated']) if (chance(0.4)) p[key] = chance(0.3) ? null : chance(0.5);
      return ['patch', pick(IDS), p];
    }
    case 3: return ['updateIdentity', pick(IDS), m.strIdent()];
    case 4: return ['remove', chance(0.15) ? 'x' : pick(IDS)];
    case 5: return ['prepare'];
    default: return ['noop'];
  }
}

function runCodexOp(store, op) {
  const [name, ...a] = op;
  switch (name) {
    case 'setLive': return store.setLive(a[0]);
    case 'commit': return store.commit(a[0]);
    case 'patch': return store.patch(a[0], Object.fromEntries(Object.entries(a[1]).map(([k, v]) => [k, und(v)])));
    case 'updateIdentity': return store.updateIdentity(a[0], a[1]);
    case 'remove': return store.remove(a[0]);
    case 'prepare': return store.prepare().id;
    case 'noop': return store.setLive(store.live());
    default: throw new Error(name);
  }
}

export function codexStoreRows({ CodexAccountsStore }) {
  const base = mkdtempSync(join(tmpdir(), 'unimux-goldens-codex-'));
  const rows = [];
  try {
    const files = [...CODEX_FIXED];
    for (let s = 0; s < 160; s++) {
      const m = codexMaker(30000 + s);
      const body = { version: m.pick([1, 1, 1, undefined]), accounts: Array.from({ length: Math.floor(m.r() * 5) }, m.account) };
      if (m.chance(0.6)) body.live = m.chance(0.1) ? m.pick(ODD) : m.live();
      files.push(JSON.stringify(body, null, m.pick([0, 1, 2])));
    }
    let n = 0;
    const row = (root, file, ops) => {
      writeInput(root, file);
      return withIds(() => {
        const store = new CodexAccountsStore(root);
        const results = ops.map((op) => { try { const out = runCodexOp(store, op); return out === undefined ? null : { ok: out }; } catch (e) { return { error: errorName(e) }; } });
        return { file, ops, out: outputOf(root, { results, readOnly: store.readOnly(), list: store.list(), live: store.live() }) };
      });
    };
    for (const [index, file] of files.entries()) {
      const m = codexMaker(700 + index);
      const ops = index < CODEX_FIXED.length ? [['noop'], codexOp(m, 1)] : Array.from({ length: Math.floor(m.r() * 6) }, () => codexOp(m, Math.floor(m.r() * 7)));
      rows.push(row(join(base, String(n++)), file, ops));
    }
    for (let s = 0; s < 40; s++) {
      const m = codexMaker(40000 + s);
      const root = join(base, `own-${s}`);
      mkdirSync(root, { recursive: true });
      withIds(() => {
        const store = new CodexAccountsStore(root);
        for (let k = 0; k < 3 + Math.floor(m.r() * 8); k++) { try { runCodexOp(store, codexOp(m, Math.floor(m.r() * 6))); } catch { /* part of the history */ } }
      });
      let text = null;
      try { text = readFileSync(join(root, 'accounts.json'), 'utf8'); } catch { /* none written */ }
      if (text !== null) rows.push({ ...row(join(base, String(n++)), text, [['noop']]), written114: true });
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
  return rows;
}

// ── pure identity helpers ─────────────────────────────────────────────────────

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `h.${b64(claims)}.s`;

export function identityRows({ accounts, codex, parseCodexAuth, decodeJwtClaims }) {
  const rows = [];
  const add = (fn, args, out) => rows.push({ fn, args, out: out === undefined ? null : out });
  const m = maker(4242);
  const c = codexMaker(4343);
  const strIdentity = () => Object.fromEntries(Object.entries(m.identity({})).filter(([, v]) => typeof v === 'string'));
  for (let i = 0; i < 300; i++) {
    const raw = m.identity({});
    add('identityFields', [raw], accounts.identityFields(raw));
    const oauth = m.chance(0.1) ? m.pick(ODD) : { emailAddress: m.text(), organizationName: m.text(), accountUuid: m.pick([...IDS, '', ' ']), organizationUuid: m.pick([...IDS, 5]) };
    add('identityFromOauthAccount', [oauth], accounts.identityFromOauthAccount(oauth));
    const a = strIdentity();
    const b = m.chance(0.3) ? { ...a, ...strIdentity() } : strIdentity();
    add('compareIdentity', [a, b], accounts.compareIdentity(a, b));
    add('identityKey', [a], accounts.identityKey(a));
    add('fillMissingIdentity', [a, b], accounts.fillMissingIdentity(a, b));
    const ca = c.strIdent();
    const cb = c.chance(0.3) ? { ...ca, ...c.strIdent() } : c.strIdent();
    add('compareCodexIdentity', [ca, cb], codex.compareCodexIdentity(ca, cb));
    add('codexIdentityKey', [ca], codex.codexIdentityKey(ca));
  }
  for (let i = 0; i < 200; i++) {
    const body = { version: c.pick([1, 2, undefined]), accounts: c.chance(0.05) ? {} : Array.from({ length: Math.floor(c.r() * 5) }, c.account) };
    if (c.chance(0.7)) body.live = c.chance(0.1) ? c.pick(ODD) : c.live();
    const input = c.chance(0.03) ? c.pick([null, [], 'x', 3]) : body;
    const file = codex.normalizeCodexAccounts(input);
    add('normalizeCodexAccounts', [input], file);
    const now = c.chance(0.2) ? null : c.strIdent();
    add('outsideSwitch', [file, now], codex.outsideSwitch(file, now));
    add('liveRecordOf', [file.accounts, now], codex.liveRecordOf(file.accounts, now));
    const record = c.chance(0.2) ? null : c.pick(file.accounts.length ? file.accounts : [null]);
    add('codexActivationRefusal', [record, now], codex.codexActivationRefusal(record ?? undefined, now));
  }
  const tomls = [null, '', 'cli_auth_credentials_store = "keyring"', "cli_auth_credentials_store='auto'", 'cli_auth_credentials_store = file', '  cli_auth_credentials_store="keyring"\n',
    '[x]\ncli_auth_credentials_store = "keyring"', 'model = "o3"\n\ncli_auth_credentials_store = "auto" # c\n[profiles.a]\n', 'cli_auth_credentials_store = "KEYRING"',
    'cli_auth_credentials_store = "keyringx"', ' [t]\ncli_auth_credentials_store = "keyring"', 'a=1\r\ncli_auth_credentials_store = "keyring"\r\n', 'x = "[y]"\ncli_auth_credentials_store = "keyring"',
    '#cli_auth_credentials_store = "keyring"', 'cli_auth_credentials_store\t=\t"auto"', ' cli_auth_credentials_store = "keyring"', 'cli_auth_credentials_store = keyring2'];
  for (const t of tomls) add('codexStoresInKeyring', [t], codex.codexStoresInKeyring(t));
  const AUTH = 'https://api.openai.com/auth';
  const tokens = [
    'a.b', '', 'x', 'a..b', `h.${b64('[1]')}.s`, `h.${b64('null')}.s`, `h.${b64('{"a":1')}.s`, jwt({ email: 'a@x' }), `h.${b64({ e: 'ą€😀' })}`, `h.${b64({ a: 1 })}==.s`, `h.e${b64({ a: 1 })}.s`,
    `h.${Buffer.from(JSON.stringify({ a: 'ż' })).toString('base64')}.s`, `.${b64({ a: 2 })}`, `h.${b64({ 1: 'x', b: 2, 0: 'y' })}.s`,
  ];
  for (const t of tokens) add('decodeJwtClaims', [t], decodeJwtClaims(t));
  const auths = [null, '', 'x', '[]', '{}', '{"OPENAI_API_KEY":"sk"}', '{"OPENAI_API_KEY":""}', '{"tokens":{}}', '{"tokens":{"access_token":""},"OPENAI_API_KEY":"k"}'];
  for (let i = 0; i < 80; i++) {
    const claims = () => (c.chance(0.2) ? c.pick([null, 'x', 5]) : {
      ...(c.chance(0.6) ? { email: c.pick(['a@x.pl', '', 5]) } : {}),
      ...(c.chance(0.7) ? { [AUTH]: c.chance(0.15) ? c.pick([null, 'x', [1]]) : { ...(c.chance(0.5) ? { chatgpt_user_id: c.pick(['u1', '', 3]) } : {}), ...(c.chance(0.5) ? { user_id: c.pick(['u2', '']) } : {}), ...(c.chance(0.6) ? { chatgpt_account_id: c.pick(['w1', '', 0]) } : {}) } } : {}),
    });
    const t = {};
    if (c.chance(0.9)) t.access_token = c.chance(0.1) ? c.pick(['', 5, 'plain']) : `h.${b64(claims() ?? 'null')}.s`;
    if (c.chance(0.7)) t.id_token = c.chance(0.1) ? 7 : `h.${b64(claims() ?? 'null')}.s`;
    if (c.chance(0.5)) t.account_id = c.pick(['acc', '', 4]);
    if (c.chance(0.6)) t.refresh_token = c.pick(['rt-1', '', 'rt-ż']);
    const auth = { ...(c.chance(0.1) ? { OPENAI_API_KEY: 'sk' } : {}), tokens: c.chance(0.05) ? 'x' : t };
    auths.push(JSON.stringify(auth, null, c.pick([0, 2])));
  }
  for (const a of auths) add('parseCodexAuth', [a], parseCodexAuth(a));
  return rows;
}
