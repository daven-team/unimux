// SP7: what 1.1.4 answers for every key in test/golden/sp7/keys (the real parsePrivateKey of src/main/ssh/keys.ts over ssh2
// 1.17), written to test/golden/sp7/keys.json. The Rust side (src-tauri/crates/unimux-ssh/tests/sp7_keys.rs) loads the same
// files with russh and compares type, bits, public blob, fingerprint and comment.
//
//   node scripts/sp7/golden-keys.mjs            rewrite keys.json from the fixture files
//   node scripts/sp7/golden-keys.mjs --ssh2     also (re)generate the ssh2-*.key files with 1.1.4's own generateKey first
//   node scripts/sp7/golden-keys.mjs --check    fail when keys.json would change
//
// The other fixture files come from scripts/sp7/gen-keys.sh (keytools Docker image, see docs/tauri/spikes/SP7.md). The
// ssh2c-*.key files (comments with astral characters, a BOM, control characters) are written with 1.1.4's generateKey when
// they are missing, the crafted-*.key files (DEK-Info ciphers OpenSSL does not write) with Node's crypto. Runs itself again
// under Electron 45 as Node (BoringSSL decides which DEK-Info ciphers ssh2 reads, exactly like the 1.1.4 app), so plain `node`
// gives the 1.1.4 answers too. Every file is answered with no passphrase, the right one and a wrong one.
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(root, 'test/golden/sp7/keys');
const out = resolve(root, 'test/golden/sp7/keys.json');
const PASS = 'sp7-pass';
const WRONG = 'wrong-pass';
const args = new Set(process.argv.slice(2));
if (!process.versions.electron) {
  const electron = createRequire(resolve(root, 'package.json'))('electron');
  const r = spawnSync(electron, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exit(r.status ?? 1);
}

const { parsePrivateKey, generateKey } = (await runnerImport(resolve(root, 'src/main/ssh/keys.ts'), { configFile: false, logLevel: 'silent', root })).module;

if (args.has('--ssh2')) {
  const plan = [['ed25519', undefined], ['ecdsa', 256], ['ecdsa', 384], ['ecdsa', 521], ['rsa', 2048], ['rsa', 3072], ['rsa', 4096]];
  for (const [type, bits] of plan) {
    for (const enc of [false, true]) {
      const name = `ssh2-${type}${bits && type !== 'ed25519' ? bits : ''}${enc ? '-enc' : ''}.key`;
      const { privateKey } = await generateKey({ type, bits, comment: `sp7 ssh2 ${type}${bits ?? ''}${enc ? ' enc' : ''}`, ...(enc ? { passphrase: PASS } : {}) });
      writeFileSync(resolve(dir, name), privateKey);
    }
  }
}

// Comments that tell the UTF-16 rules of 1.1.4's metaOf apart (`.trim().slice(0, 200)` on a JS string).
const COMMENTS = [
  ['ssh2c-ed25519-astral.key', '\u{1F600}'.repeat(150)],
  ['ssh2c-ed25519-astral-split.key', `x${'\u{1F600}'.repeat(150)}`],
  ['ssh2c-ed25519-bom.key', '\uFEFF\u0085 sp7 bom \u0085\u3000\uFEFF'],
  ['ssh2c-ed25519-ctrl.key', '\tsp7\u2028ctrl\u0001x\u2029'],
];
for (const [name, comment] of COMMENTS) {
  if (!existsSync(resolve(dir, name))) writeFileSync(resolve(dir, name), (await generateKey({ type: 'ed25519', comment })).privateKey);
}

// Hand-made DEK-Info keys OpenSSL refuses to write (AEAD, ECB): ssh2 knows the cipher names but fails to decrypt them.
// (RC4 with its empty IV is left out: ssh2 1.17 throws a RangeError on it instead of returning an error.)
const CRAFTED = [['AES-128-GCM', 'aes-128-gcm', 16, 12, 1], ['AES-128-ECB', 'aes-128-ecb', 16, 16, 16], ['DES-EDE3', 'des-ede3', 24, 8, 8]];
for (const [name, ssl, keyLen, ivLen, block] of CRAFTED) {
  const file = resolve(dir, `crafted-pem-rsa2048-${ssl}.key`);
  if (existsSync(file)) continue;
  const der = createPrivateKey(readFileSync(resolve(dir, 'pem-rsa2048.key'), 'utf8')).export({ type: 'pkcs1', format: 'der' });
  const iv = randomBytes(ivLen);
  let key = Buffer.alloc(0);
  for (let prev = Buffer.alloc(0); key.length < keyLen;) { prev = createHash('md5').update(prev).update(PASS).update(iv.subarray(0, 8)).digest(); key = Buffer.concat([key, prev]); }
  const c = createCipheriv(ssl, key.subarray(0, keyLen), /ecb|^des-ede3$/.test(ssl) ? null : iv);
  c.setAutoPadding(block > 1);
  const body = Buffer.concat([c.update(der), c.final()]).toString('base64').replace(/.{64}/g, '$&\n');
  writeFileSync(file, `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: ${name},${iv.toString('hex').toUpperCase()}\n\n${body}${body.endsWith('\n') ? '' : '\n'}-----END RSA PRIVATE KEY-----\n`);
}

const view = (r) => (r.ok
  ? { ok: true, encrypted: r.encrypted, type: r.meta.type, bits: r.meta.bits, fingerprint: r.meta.fingerprint, comment: r.meta.comment, publicKey: r.meta.publicKey, blob: r.meta.blob.toString('base64') }
  : { ok: false, error: r.error, ...(r.encrypted !== undefined ? { encrypted: r.encrypted } : {}) });

const files = readdirSync(dir).filter((f) => /\.(key|ppk)$/.test(f)).sort();
const entries = files.map((file) => {
  const text = readFileSync(resolve(dir, file), 'utf8');
  return { file, noPassphrase: view(parsePrivateKey(text)), passphrase: view(parsePrivateKey(text, PASS)), wrongPassphrase: view(parsePrivateKey(text, WRONG)) };
});
const json = `${JSON.stringify({ passphrase: PASS, wrongPassphrase: WRONG, ssh2: JSON.parse(readFileSync(resolve(root, 'node_modules/ssh2/package.json'), 'utf8')).version, entries }, null, 1)}\n`;
if (args.has('--check')) {
  if (readFileSync(out, 'utf8') !== json) { console.error('test/golden/sp7/keys.json is out of date'); process.exit(1); }
} else writeFileSync(out, json);
const accepted = entries.filter((e) => e.noPassphrase.ok || e.passphrase.ok).length;
console.log(`${entries.length} keys, ${accepted} accepted by 1.1.4`);
