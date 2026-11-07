// Golden rows of the SSH stores (1.2.0, PLAN S1), written by scripts/dump-goldens.mjs. The TS code they run is 1.1.4's
// (src/main/ssh/{vault,knownHosts,commandHistory,files}.ts and src/shared/commandHistory.ts are unchanged since v1.1.4), so
// a Rust answer equal to a row is 1.1.4's answer, and a file the Rust store writes equal to `text` is the file 1.1.4 writes.
//
//   ssh-vault.jsonl          {file, cipher, ops} -> {results, info, readOnly, text, backups, temps, reopened}
//                             file: the text of ssh/vault.json (null: missing, {dir: true}: a directory);
//                             cipher: fake | broken | off | keychain | v10 (see CIPHERS); reopened: info() of a new vault on
//                             the file the ops left (the same cipher)
//   ssh-known-hosts.jsonl    {file, ops} -> {results, list, info, readOnly, text, backups, temps}
//   ssh-command-history.jsonl {file, hosts, ops} -> {results, status, text, backups, temps}; hosts: the saved host ids
//   ssh-history-rules.jsonl  {fn, args} -> {out} of historyCommand / recordCommand / frecency / normalizeCommandHistory
//
// New ids (randomUUID) are `00000000-0000-4000-8000-<n, 12 digits>` counted from 1 per row on both sides; the clock is
// 1762430400000 + 1000 * n (n counted from 1 per row, every now() call).
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
let nonceCounter = 0;
const realRandomUUID = crypto.randomUUID;
const counted = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function withIds(fn) {
  uuidCounter = 0;
  nonceCounter = 0;
  crypto.randomUUID = () => counted(++uuidCounter);
  syncBuiltinESMExports();
  try { return fn(); } finally { crypto.randomUUID = realRandomUUID; syncBuiltinESMExports(); }
}
const clock = () => { let n = 0; return () => 1762430400000 + 1000 * ++n; };

// The fixed AES-256-GCM key of the v10 rows (Chromium's Windows format: "v10" + 12-byte nonce + ciphertext + 16-byte tag).
const V10_KEY = Buffer.alloc(32, 7);
const v10 = {
  encrypt(text) {
    // Counted nonces (per row) keep the corpus reproducible; the Rust side only decrypts these blobs.
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(++nonceCounter, 8);
    const c = crypto.createCipheriv('aes-256-gcm', V10_KEY, nonce);
    const body = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]);
    return Buffer.concat([Buffer.from('v10'), nonce, body, c.getAuthTag()]);
  },
  decrypt(data) {
    if (data.length < 3 + 12 + 16 || data.subarray(0, 3).toString() !== 'v10') throw new Error('not v10');
    const d = crypto.createDecipheriv('aes-256-gcm', V10_KEY, data.subarray(3, 15));
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(15, data.length - 16)), d.final()]).toString('utf8');
  },
};

/** The ciphers of the rows; `fake` is test/helpers/sshKeys.ts fakeCipher (deterministic, so files compare byte for byte). */
export const CIPHERS = {
  fake: () => fakeCipher({}),
  broken: () => fakeCipher({ broken: true }),
  off: () => fakeCipher({ available: false }),
  keychain: () => ({ ...fakeCipher({}), storage: 'keychain' }),
  v10: () => ({ storage: 'dpapi', available: () => true, encrypt: v10.encrypt, decrypt: v10.decrypt }),
};
function fakeCipher(opts) {
  const available = opts.available ?? true;
  return {
    storage: available ? 'dpapi' : 'unavailable',
    available: () => available,
    encrypt: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('hex')}`),
    decrypt: (data) => {
      const s = data.toString();
      if (opts.broken || !s.startsWith('enc:')) throw new Error('cannot decrypt');
      return Buffer.from(s.slice(4), 'hex').toString('utf8');
    },
  };
}

const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex');
const fakeSecret = (s) => Buffer.from(`enc:${hexOf(s)}`).toString('base64');

const HOSTS = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '11111111-1111-4111-8111-111111111111', 'AAAAAAAA-1111-4111-8111-111111111111'];
const BAD_IDS = ['', 'x', 'x'.repeat(65), 'not-a-uuid', 42, null];
const LABELS = ['laptop', 'work key', '', 'ą'.repeat(81), `${'x'.repeat(79)}\u{1F600}`, 'Klucz łódź'];
const TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
const FPS = ['SHA256:abc', 'SHA256:def', 'SHA256:ghi', 'SHA256:jkl'];
const PRIVATE = ['-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-a\n-----END OPENSSH PRIVATE KEY-----\n', '-----BEGIN RSA PRIVATE KEY-----\nb\n-----END RSA PRIVATE KEY-----\n', 'PuTTY-User-Key-File-2: ssh-rsa\nłódź'];
const PASSPHRASES = ['very-secret', '', 'pąss "q"', undefined];
const PASSWORDS = ['hunter2', 'pąss\u{1F600}', 'a', '"quoted"\\'];
const CERTS = ['ssh-ed25519-cert-v01@openssh.com AAAA cert', '', undefined];

function maker(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const chance = (p) => r() < p;
  return { r, pick, chance };
}

// ── ssh/vault.json ───────────────────────────────────────────────────────────

const VAULT_FIXED = [
  null, { dir: true }, '', 'not json', '{ nope', 'null', '[]', '"x"', '7', '{}', '{"version":1}', '{"version":2,"keys":[],"passwords":[]}',
  '{"version":3,"keys":[],"passwords":[]}', '{"version":9,"keys":[],"passwords":[{"hostId":"00000000-0000-4000-8000-00000000000a","updatedAt":1,"secret":"x"}]}',
  '{"version":1e400,"keys":[]}', '{"version":-1e400,"keys":[]}', '{"version":"3","keys":[]}', '{"version":2.5,"keys":[]}',
  '{"version":1,"keys":{},"passwords":[]}', '{"version":1,"keys":[],"passwords":null}', '{"version":1,"identityPasswords":{}}',
  '{"version":1,"keys":[null,{"id":5}],"passwords":[{"hostId":"x"}]}',
  '﻿{"version":1,"keys":[],"passwords":[]}',
  `{"version":1,"keys":[{"id":"k1","label":"","type":"ssh-ed25519","bits":1e400,"fingerprint":"SHA256:abc","publicKey":"ssh-ed25519 AAAA","comment":5,"encrypted":1,"passphraseSaved":true,"certificate":"","source":"other","createdAt":-1e400,"secret":"${fakeSecret(JSON.stringify({ privateKey: 'p' }))}","extra":true}],"passwords":[{"hostId":"00000000-0000-4000-8000-00000000000a","updatedAt":1e400,"secret":"${fakeSecret('pw')}"}]}`,
  `{"version":1,"keys":[{"id":"k1","label":"a","type":"ssh-dss","bits":1024,"fingerprint":"SHA256:x","publicKey":"p","secret":"s"}],"passwords":[]}`,
  `{"keys":[{"certificate":"cert","createdAt":2.5,"source":"generated","secret":"${fakeSecret(JSON.stringify({ privateKey: 'p', passphrase: 'pp' }))}","publicKey":"pk","fingerprint":"SHA256:z","bits":"256","type":"ssh-rsa","label":"x","id":"k2"}],"passwords":[],"identityPasswords":[{"identityId":"11111111-1111-4111-8111-111111111111","updatedAt":3,"secret":"${fakeSecret('ip')}"}]}`,
  `{"version":2,"keys":[],"passwords":[],"identityPasswords":[]}`,
  `{"version":1,"keys":[{"id":"k3","label":"l","type":"ssh-ed25519","bits":256,"fingerprint":"SHA256:q","publicKey":"pk","secret":"${fakeSecret('not json')}"},{"id":"k4","label":"l","type":"ssh-ed25519","bits":256,"fingerprint":"SHA256:r","publicKey":"pk","secret":"${fakeSecret('{"privateKey":5}')}"},{"id":"k5","label":"l","type":"ssh-ed25519","bits":256,"fingerprint":"SHA256:s","publicKey":"pk","secret":"garbage"}],"passwords":[{"hostId":"h","secret":"${fakeSecret('')}"}]}`,
  `{"version":1,"keys":[{"id":"${'i'.repeat(65)}","label":"l","type":"ssh-ed25519","fingerprint":"f","publicKey":"p","secret":"s"}],"passwords":[]}`,
  `{"version":1,"keys":[{"id":"k6","label":"${'l'.repeat(81)}","type":"ssh-ed25519","fingerprint":"f","publicKey":"p","secret":"s"}],"passwords":[]}`,
];

function newKey(m) {
  const { pick, chance } = m;
  const k = {
    label: pick(LABELS), type: pick(TYPES), bits: pick([256, 384, 521, 3072, 4096, 1.5]), fingerprint: pick(FPS), publicKey: `${pick(TYPES)} AAAA${Math.floor(m.r() * 9)}`,
    comment: pick(['me@laptop', '', 'ąę']), encrypted: chance(0.5), privateKey: pick(PRIVATE), savePassphrase: chance(0.6), source: pick(['generated', 'imported']),
  };
  const pp = pick(PASSPHRASES);
  if (pp !== undefined) k.passphrase = pp;
  const cert = pick(CERTS);
  if (cert !== undefined) k.certificate = cert;
  return k;
}

function vaultOp(m, keyIds, i) {
  const { pick, chance } = m;
  const kid = () => (chance(0.15) ? pick(['missing', counted(99)]) : pick(keyIds.length ? keyIds : ['missing']));
  const host = () => (chance(0.1) ? pick(BAD_IDS.filter((x) => typeof x === 'string')) : pick(HOSTS));
  switch (i) {
    case 0: case 1: return ['addKey', newKey(m)];
    case 2: return ['keySecret', kid()];
    case 3: {
      const patch = {};
      if (chance(0.4)) patch.label = pick(LABELS);
      if (chance(0.4)) patch.certificate = chance(0.3) ? null : pick(['cert-b', '', 'cert-c']);
      if (chance(0.4)) patch.passphrase = chance(0.5) ? { forget: true } : { save: pick(['new-pp', '', 'ł']) };
      return ['updateKey', kid(), patch];
    }
    case 4: {
      const k = newKey(m);
      delete k.label; delete k.certificate; delete k.source;
      return ['replaceKey', kid(), k];
    }
    case 5: return ['removeKey', kid()];
    case 6: return ['setPassword', host(), pick(PASSWORDS)];
    case 7: return ['clearPassword', host()];
    case 8: return ['password', host()];
    case 9: return ['prunePasswords', HOSTS.filter(() => chance(0.6))];
    case 10: return ['setIdentityPassword', host(), pick(PASSWORDS)];
    case 11: return ['clearIdentityPassword', host()];
    case 12: return ['identityPassword', host()];
    case 13: return ['pruneIdentityPasswords', HOSTS.filter(() => chance(0.6))];
    case 14: return ['remember', kid(), pick(PASSWORDS), chance(0.5) ? pick([0, 1]) : null];
    case 15: return ['remembered', kid()];
    case 16: return ['forgetRemembered'];
    case 17: return ['markVerified', kid(), pick(PASSWORDS)];
    case 18: return ['isVerified', kid(), pick(PASSWORDS)];
    case 19: return ['generation', kid()];
    case 20: return ['info'];
    case 21: return ['noop', kid()];
    case 22: return [chance(0.5) ? 'breakFile' : 'fixFile'];
    default: return ['readOnly'];
  }
}

const VAULT_OPS = 24;
const undef = (v) => (v === null ? undefined : v);

function runVaultOp(vault, op, file) {
  const [name, ...a] = op;
  switch (name) {
    case 'addKey': return vault.addKey(a[0]);
    case 'keySecret': return vault.keySecret(a[0]);
    case 'updateKey': return vault.updateKey(a[0], a[1]);
    case 'replaceKey': return vault.replaceKey(a[0], a[1]);
    case 'removeKey': return vault.removeKey(a[0]);
    case 'setPassword': return vault.setPassword(a[0], a[1]);
    case 'clearPassword': return vault.clearPassword(a[0]);
    case 'password': return vault.password(a[0]);
    case 'prunePasswords': return vault.prunePasswords(new Set(a[0]));
    case 'setIdentityPassword': return vault.setIdentityPassword(a[0], a[1]);
    case 'clearIdentityPassword': return vault.clearIdentityPassword(a[0]);
    case 'identityPassword': return vault.identityPassword(a[0]);
    case 'pruneIdentityPasswords': return vault.pruneIdentityPasswords(new Set(a[0]));
    case 'remember': return vault.remember(a[0], a[1], undef(a[2]));
    case 'remembered': return vault.remembered(a[0]) ?? null;
    case 'forgetRemembered': return vault.forgetRemembered();
    case 'markVerified': return vault.markVerified(a[0], a[1]);
    case 'isVerified': return vault.isVerified(a[0], a[1]);
    case 'generation': return vault.generation(a[0]);
    case 'info': return vault.info();
    // The no-op rewrite of a 1.1.4 file: an empty patch on a key (written again, nothing changed).
    case 'noop': return vault.updateKey(a[0], {});
    // A non-empty directory where the file belongs makes every write throw; fixFile takes it away again.
    case 'breakFile': {
      if (existsSync(file) && !statSync(file).isDirectory()) rmSync(file);
      mkdirSync(join(file, 'child'), { recursive: true });
      return null;
    }
    case 'fixFile': {
      if (existsSync(file) && statSync(file).isDirectory()) rmSync(file, { recursive: true, force: true });
      return null;
    }
    case 'readOnly': return vault.readOnly();
    default: throw new Error(name);
  }
}

function writeInput(dir, name, file) {
  mkdirSync(dir, { recursive: true });
  if (file === null) return;
  if (typeof file === 'object') { mkdirSync(join(dir, name, 'child'), { recursive: true }); return; }
  writeFileSync(join(dir, name), file);
}

function filesOf(dir, name) {
  const path = join(dir, name);
  let text = null;
  try { if (!statSync(path).isDirectory()) text = readFileSync(path, 'utf8'); } catch { /* missing */ }
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const backups = names.filter((n) => n.startsWith(`${name}.bak-`)).map((n) => readFileSync(join(dir, n), 'utf8')).sort();
  return { text, backups, temps: names.filter((n) => n.endsWith('.tmp')).length };
}

const keyIdsOf = (file) => {
  try { return (JSON.parse(file).keys ?? []).map((k) => k?.id).filter((id) => typeof id === 'string'); } catch { return []; }
};

function vaultRow(SshVault, root, file, cipher, ops) {
  const dir = join(root, 'ssh');
  const path = join(dir, 'vault.json');
  writeInput(dir, 'vault.json', file);
  return withIds(() => {
    const vault = new SshVault(path, CIPHERS[cipher](), clock());
    const results = ops.map((op) => {
      try { const out = runVaultOp(vault, op, path); return out === undefined ? null : { ok: out }; } catch { return { throw: true }; }
    });
    const out = { results, info: vault.info(), readOnly: vault.readOnly(), ...filesOf(dir, 'vault.json') };
    // The file as the ops left it, read by a new vault (with the same cipher): what 1.1.4 shows after a restart.
    runVaultOp(vault, ['fixFile'], path);
    out.reopened = new SshVault(path, CIPHERS[cipher](), clock()).info();
    return { file, cipher, ops, out };
  });
}

/** A vault 1.1.4 wrote itself through random ops (with the given cipher). */
function ownVault(SshVault, root, m, cipher) {
  const dir = join(root, 'ssh');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'vault.json');
  withIds(() => {
    const vault = new SshVault(path, CIPHERS[cipher](), clock());
    const ids = () => vault.info().keys.map((k) => k.id);
    for (let k = 0; k < 3 + Math.floor(m.r() * 10); k++) {
      const op = vaultOp(m, ids(), Math.floor(m.r() * 14));
      try { runVaultOp(vault, op, path); } catch { /* refused ops are part of the history */ }
    }
  });
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

export function vaultRows({ SshVault }) {
  const base = mkdtempSync(join(tmpdir(), 'unimux-goldens-vault-'));
  const rows = [];
  let n = 0;
  const next = () => join(base, String(n++));
  try {
    for (const [index, file] of VAULT_FIXED.entries()) {
      for (const cipher of ['fake', 'broken', 'off', 'keychain']) {
        const m = maker(100 + index * 7 + cipher.length);
        const ids = typeof file === 'string' ? keyIdsOf(file) : [];
        const ops = [['noop', ids[0] ?? 'k1'], ['info'], ...Array.from({ length: 3 }, () => vaultOp(m, ids, Math.floor(m.r() * 21)))];
        rows.push(vaultRow(SshVault, next(), file, cipher, ops));
      }
    }
    // Random op sequences on an empty data dir and on 1.1.4-written vaults (each one also as a pure no-op rewrite).
    for (let s = 0; s < 220; s++) {
      const m = maker(7000 + s);
      const cipher = m.pick(['fake', 'fake', 'fake', 'off', 'broken', 'keychain']);
      const file = m.chance(0.3) ? null : ownVault(SshVault, next(), m, cipher === 'broken' ? 'fake' : cipher);
      const ids = file ? keyIdsOf(file) : [];
      const ops = [];
      const added = [];
      for (let k = 0; k < 2 + Math.floor(m.r() * 12); k++) {
        const op = vaultOp(m, [...ids, ...added], Math.floor(m.r() * VAULT_OPS));
        ops.push(op);
        if (op[0] === 'addKey') added.push(counted(added.length + 1));
      }
      rows.push(vaultRow(SshVault, next(), file, cipher, ops));
      if (file !== null) {
        const row = vaultRow(SshVault, next(), file, cipher === 'broken' ? 'fake' : cipher, [['noop', ids[0] ?? 'k1']]);
        rows.push({ ...row, written114: true });
      }
    }
    // Real v10 blobs: 1.1.4's file read, decrypted and rewritten byte-identically by a no-op.
    for (let s = 0; s < 40; s++) {
      const m = maker(9100 + s);
      const file = ownVault(SshVault, next(), m, 'v10');
      if (file === null) continue;
      const ids = keyIdsOf(file);
      const ops = [['noop', ids[0] ?? 'k1'], ...ids.map((id) => ['keySecret', id]), ...HOSTS.flatMap((h) => [['password', h], ['identityPassword', h]]), ['info']];
      rows.push({ ...vaultRow(SshVault, next(), file, 'v10', ops), written114: true });
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
  return rows;
}

// ── ssh/known_hosts.json ─────────────────────────────────────────────────────

const sshString = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b); const len = Buffer.alloc(4); len.writeUInt32BE(buf.length); return Buffer.concat([len, buf]); };
const BLOBS = [
  Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIs', 'base64'),
  Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 9))]),
  Buffer.concat([sshString('ssh-rsa'), sshString(Buffer.from([1, 0, 1])), sshString(Buffer.alloc(256, 7))]),
  Buffer.concat([sshString('ecdsa-sha2-nistp256'), sshString('nistp256'), sshString(Buffer.alloc(65, 4))]),
  Buffer.from([0, 0, 0, 99, 1]),
  Buffer.alloc(0),
  Buffer.concat([sshString('SSH-RSA'), sshString('x')]),
];
const KH_HOSTS = ['example.com', 'Example.COM', '10.0.0.1', '::1', 'host.local', 'İstanbul.tr'];
const PORTS = [22, 2222, 1, 65535];

const KH_FIXED = [
  null, { dir: true }, '', '{ broken', 'null', '[]', '{}', '{"version":1}', '{"version":2,"entries":[]}', '{"version":1e400,"entries":[]}',
  '{"version":1,"entries":{}}', '{"version":1,"entries":null}', '{"version":1,"entries":[]}', '{"version":1,"entries":[{"id":"x","host":5},null]}',
  `{"version":1,"entries":[{"id":"e1","host":"A.example","port":22.0,"keyType":"ignored","key":"${BLOBS[2].toString('base64').replace(/=+$/, '')}","fingerprint":"stale","addedAt":1e400,"extra":1},{"id":"e2","host":"b","port":0,"key":"${BLOBS[0].toString('base64')}"},{"id":"e3","host":"c","port":22,"key":"not base64!!"},{"id":"e4","host":"","port":22,"key":"${BLOBS[0].toString('base64')}"},{"id":"e5","host":"d","port":1.5,"key":"${BLOBS[0].toString('base64')}"},{"id":"e6","host":"e","port":22,"key":"${BLOBS[4].toString('base64')}"},["x"]]}`,
  `{"entries":[{"addedAt":"7","key":"${BLOBS[1].toString('base64')}","port":2222,"host":"x","id":"z"}]}`,
  '﻿{"version":1,"entries":[]}',
];

function khOp(m, ids, i) {
  const { pick, chance } = m;
  const blob = () => pick(BLOBS).toString('base64');
  switch (i) {
    case 0: case 1: case 2: return ['trust', pick(KH_HOSTS), pick(PORTS), blob(), chance(0.3) ? 'replace' : 'save'];
    case 3: return ['judge', pick(KH_HOSTS), pick(PORTS), blob()];
    case 4: return ['remove', chance(0.2) ? 'missing' : pick(ids.length ? ids : ['missing'])];
    case 5: return ['info'];
    case 6: return [chance(0.5) ? 'breakFile' : 'fixFile'];
    default: return ['readOnly'];
  }
}

function runKhOp(store, op, file) {
  const [name, ...a] = op;
  switch (name) {
    case 'trust': return store.trust(a[0], a[1], Buffer.from(a[2], 'base64'), a[3]);
    case 'judge': return store.judge(a[0], a[1], Buffer.from(a[2], 'base64'));
    case 'remove': return store.remove(a[0]);
    case 'info': return store.info();
    case 'readOnly': return store.readOnly();
    // The no-op rewrite: trusting a key that is already saved writes the same entries again.
    case 'noop': { const e = store.list()[0]; return e ? store.trust(e.host, e.port, Buffer.from(e.key, 'base64'), 'save') : null; }
    default: return runVaultOp(null, op, file);
  }
}

export function knownHostsRows({ KnownHostsStore }) {
  const base = mkdtempSync(join(tmpdir(), 'unimux-goldens-kh-'));
  const rows = [];
  let n = 0;
  const row = (file, ops, extra = {}) => {
    const dir = join(base, String(n++), 'ssh');
    const path = join(dir, 'known_hosts.json');
    writeInput(dir, 'known_hosts.json', file);
    return withIds(() => {
      const store = new KnownHostsStore(path, clock());
      const results = ops.map((op) => { try { const out = runKhOp(store, op, path); return out === undefined ? null : { ok: out }; } catch { return { throw: true }; } });
      return { file, ops, ...extra, out: { results, list: store.list(), info: store.info(), readOnly: store.readOnly(), ...filesOf(dir, 'known_hosts.json') } };
    });
  };
  try {
    for (const [index, file] of KH_FIXED.entries()) {
      const m = maker(300 + index);
      rows.push(row(file, [['noop'], ['info'], ...Array.from({ length: 4 }, () => khOp(m, [], Math.floor(m.r() * 6)))]));
    }
    for (let s = 0; s < 160; s++) {
      const m = maker(11000 + s);
      // A file 1.1.4 wrote itself, then random ops on it (and the pure no-op).
      let file = null;
      if (m.chance(0.7)) {
        const dir = join(base, String(n++), 'ssh');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'known_hosts.json');
        withIds(() => {
          const store = new KnownHostsStore(path, clock());
          for (let k = 0; k < 1 + Math.floor(m.r() * 6); k++) { try { runKhOp(store, khOp(m, store.list().map((e) => e.id), Math.floor(m.r() * 5)), path); } catch { /* refused */ } }
        });
        try { file = readFileSync(path, 'utf8'); } catch { /* none written */ }
      }
      const ids = (() => { try { return JSON.parse(file).entries.map((e) => e.id); } catch { return []; } })();
      const ops = Array.from({ length: 1 + Math.floor(m.r() * 8) }, () => khOp(m, [...ids, counted(1), counted(2)], Math.floor(m.r() * 8)));
      rows.push(row(file, ops));
      if (file !== null) rows.push(row(file, [['noop']], { written114: true }));
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
  return rows;
}

// ── ssh/command_history.json ─────────────────────────────────────────────────

const COMMANDS = ['ls -la', 'uptime', 'df -h', 'ls', ' secret', '', 'a', 'a\x1bb', 'ls   ', '****', 'echo "x', 'cd /var/log && tail -f syslog', 'grep -r "łódź" .', '\u{1F600}\u{1F600}', 'x'.repeat(1001), 'make &&', 'sudo systemctl restart nginx', 'git status'];
const HIST_HOSTS = [...HOSTS, '00000000-0000-4000-8000-0000000000ff'];

const HIST_FIXED = [
  null, { dir: true }, '', '{ broken', 'null', '[1,2]', '"x"', '{}', '{"version":1}', '{"version":2,"hosts":{}}', '{"version":1e400,"hosts":{}}', '{"version":1,"hosts":[]}',
  '{"version":1,"hosts":null}', '{"version":1,"hosts":5}',
  `{"version":1,"hosts":{"${HOSTS[0]}":[{"command":"ls","count":2,"lastUsed":5},{"command":"ls","count":9,"lastUsed":9},{"command":" bad","count":1,"lastUsed":1},{"command":"pwd","count":1.5,"lastUsed":-1},{"command":"top","count":0,"lastUsed":1e400},{"command":"htop","count":1e400,"lastUsed":3.5},{"command":"vim  ","count":1,"lastUsed":1},null,["x"]],"not-a-uuid":[{"command":"ls","count":1,"lastUsed":1}],"${HOSTS[1]}":[],"${HOSTS[2]}":"x","${HOSTS[3]}":[{"command":"whoami","count":1,"lastUsed":0}]}}`,
  `{"hosts":{"${HOSTS[1]}":[{"lastUsed":3,"count":1,"command":"id"}],"${HOSTS[0]}":[{"command":"uname -a","count":4,"lastUsed":2}]},"version":1}`,
  '﻿{"version":1,"hosts":{}}',
];

function histOp(m, i) {
  const { pick, chance } = m;
  const host = () => (chance(0.1) ? pick(['nope', null, 42]) : pick(HIST_HOSTS));
  switch (i) {
    case 0: case 1: case 2: case 3: return ['record', host(), chance(0.1) ? 42 : pick(COMMANDS)];
    case 4: return ['list', host()];
    case 5: return ['clear', chance(0.4) ? null : host()];
    case 6: return ['flush'];
    case 7: return ['status'];
    case 8: return ['readOnly'];
    case 9: return [chance(0.5) ? 'breakFile' : 'fixFile'];
    default: return ['counts'];
  }
}

function runHistOp(store, op, file) {
  const [name, ...a] = op;
  switch (name) {
    case 'record': return store.record(a[0], a[1]);
    case 'list': return store.list(a[0]);
    case 'clear': return store.clear(a[0]);
    case 'flush': return store.flush();
    case 'status': return { ...store.status(), file: '<file>' };
    case 'counts': return store.counts();
    case 'readOnly': return store.readOnly();
    default: return runVaultOp(null, op, file);
  }
}

export function historyRows({ CommandHistoryStore }) {
  const base = mkdtempSync(join(tmpdir(), 'unimux-goldens-hist-'));
  const rows = [];
  let n = 0;
  const row = (file, hosts, ops, extra = {}) => {
    const dir = join(base, String(n++), 'ssh');
    const path = join(dir, 'command_history.json');
    writeInput(dir, 'command_history.json', file);
    const saved = new Set(hosts);
    const store = new CommandHistoryStore(path, { hostExists: (id) => saved.has(id), now: clock(), writeDelayMs: 3_600_000 });
    const results = ops.map((op) => { try { const out = runHistOp(store, op, path); return out === undefined ? null : { ok: out }; } catch { return { throw: true }; } });
    // The quit flush, then the status the next start shows.
    try { runHistOp(store, ['fixFile'], path); store.flush(); } catch { /* kept dirty */ }
    const out = { results, status: store.status(), ...filesOf(dir, 'command_history.json') };
    out.status.file = '<file>';
    return { file, hosts, ops, ...extra, out };
  };
  try {
    for (const [index, file] of HIST_FIXED.entries()) {
      const m = maker(500 + index);
      rows.push(row(file, HIST_HOSTS.slice(0, 4), [['clear', '00000000-0000-4000-8000-0000000000ee'], ['status'], ...Array.from({ length: 5 }, () => histOp(m, Math.floor(m.r() * 11)))]));
    }
    for (let s = 0; s < 200; s++) {
      const m = maker(13000 + s);
      const hosts = HIST_HOSTS.filter(() => m.chance(0.7));
      let file = null;
      if (m.chance(0.7)) {
        const dir = join(base, String(n++), 'ssh');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'command_history.json');
        const store = new CommandHistoryStore(path, { hostExists: () => true, now: clock(), writeDelayMs: 3_600_000 });
        for (let k = 0; k < 2 + Math.floor(m.r() * 30); k++) store.record(m.pick(HIST_HOSTS), m.pick(COMMANDS));
        store.flush();
        try { file = readFileSync(path, 'utf8'); } catch { /* none written */ }
      }
      rows.push(row(file, hosts, Array.from({ length: 1 + Math.floor(m.r() * 14) }, () => histOp(m, Math.floor(m.r() * 11)))));
      // The no-op rewrite: clearing a host without a history writes the same hosts again (every host saved).
      if (file !== null) rows.push(row(file, HIST_HOSTS, [['clear', '00000000-0000-4000-8000-0000000000ee']], { written114: true }));
    }
    // The per-host limit (2000 entries, frecency eviction) and the host limit (500, the least recently used goes).
    const big = {};
    for (let h = 0; h < 503; h++) {
      const id = `00000000-0000-4000-8000-${String(h).padStart(12, '0')}`;
      big[id] = [{ command: `cmd ${h}`, count: 1 + (h % 3), lastUsed: 1000 + h }];
    }
    big[HOSTS[0]] = Array.from({ length: 2001 }, (_, i) => ({ command: `c${i}`, count: 1 + (i % 5), lastUsed: 1762430400000 - (i % 7) * 86_400_000 * 3 - i }));
    rows.push(row(JSON.stringify({ version: 1, hosts: big }), [HOSTS[0], counted(5)], [['record', HOSTS[0], 'brand new'], ['record', counted(5), 'cmd 5'], ['record', counted(5), 'other'], ['counts']]));
  } finally { rmSync(base, { recursive: true, force: true }); }
  return rows;
}

export function historyRuleRows({ historyCommand, recordCommand, frecency, normalizeCommandHistory }) {
  const rows = [];
  const lines = [...COMMANDS, ' ls', '\tls', 'ls ', 'ls ', 'a\u0085b', 'a\u009fb', 'a\u007fb', '••', '●●●', '*a', 'echo \'a', "echo 'a'", 'echo "a\\"b"', "echo 'a\\'", 'echo a\\', 'x|', 'x ||', 'a && b', 'x'.repeat(1000), '\u{1F600}'.repeat(500), '\u{1F600}'.repeat(501), 'ab\ud800', '𐀀x', '﻿ls', 'ls﻿'];
  for (const line of lines) rows.push({ fn: 'historyCommand', args: [line], out: historyCommand(line) });
  const r = rng(77);
  for (let s = 0; s < 150; s++) {
    const now = 1762430400000;
    const entries = Array.from({ length: Math.floor(r() * 8) }, (_, i) => ({ command: `c${Math.floor(r() * 6)}${i}`, count: 1 + Math.floor(r() * 9), lastUsed: now - Math.floor(r() * 40 * 86_400_000) }));
    const command = r() < 0.4 && entries.length ? entries[Math.floor(r() * entries.length)].command : `n${s}`;
    const limit = 1 + Math.floor(r() * 6);
    rows.push({ fn: 'recordCommand', args: [entries, command, now, limit], out: recordCommand(entries, command, now, limit) });
    for (const e of entries) rows.push({ fn: 'frecency', args: [e, now], out: frecency(e, now) });
  }
  for (const file of HIST_FIXED) {
    if (typeof file !== 'string') continue;
    let raw;
    try { raw = JSON.parse(file); } catch { continue; }
    const out = normalizeCommandHistory(raw);
    rows.push({ fn: 'normalizeCommandHistory', args: [file], out: { hosts: [...out.hosts.entries()], newer: out.newer, invalid: out.invalid } });
  }
  return rows;
}
