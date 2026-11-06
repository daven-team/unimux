// SP7: what 1.1.4 answers for every key in test/golden/sp7/keys (the real parsePrivateKey of src/main/ssh/keys.ts over ssh2
// 1.17), written to test/golden/sp7/keys.json. The Rust side (src-tauri/crates/unimux-ssh/tests/sp7_keys.rs) loads the same
// files with russh and compares type, bits, public blob, fingerprint and comment.
//
//   node scripts/sp7/golden-keys.mjs            rewrite keys.json from the fixture files
//   node scripts/sp7/golden-keys.mjs --ssh2     also (re)generate the ssh2-*.key files with 1.1.4's own generateKey first
//   node scripts/sp7/golden-keys.mjs --check    fail when keys.json would change
//
// The other fixture files come from scripts/sp7/gen-keys.sh (keytools Docker image, see docs/tauri/spikes/SP7.md).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(root, 'test/golden/sp7/keys');
const out = resolve(root, 'test/golden/sp7/keys.json');
const PASS = 'sp7-pass';
const args = new Set(process.argv.slice(2));

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

const view = (r) => (r.ok
  ? { ok: true, encrypted: r.encrypted, type: r.meta.type, bits: r.meta.bits, fingerprint: r.meta.fingerprint, comment: r.meta.comment, publicKey: r.meta.publicKey, blob: r.meta.blob.toString('base64') }
  : { ok: false, error: r.error, ...(r.encrypted !== undefined ? { encrypted: r.encrypted } : {}) });

const files = readdirSync(dir).filter((f) => /\.(key|ppk)$/.test(f)).sort();
const entries = files.map((file) => {
  const text = readFileSync(resolve(dir, file), 'utf8');
  return { file, noPassphrase: view(parsePrivateKey(text)), passphrase: view(parsePrivateKey(text, PASS)) };
});
const json = `${JSON.stringify({ passphrase: PASS, ssh2: JSON.parse(readFileSync(resolve(root, 'node_modules/ssh2/package.json'), 'utf8')).version, entries }, null, 1)}\n`;
if (args.has('--check')) {
  if (readFileSync(out, 'utf8') !== json) { console.error('test/golden/sp7/keys.json is out of date'); process.exit(1); }
} else writeFileSync(out, json);
const accepted = entries.filter((e) => e.noPassphrase.ok || e.passphrase.ok).length;
console.log(`${entries.length} keys, ${accepted} accepted by 1.1.4`);
