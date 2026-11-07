// S2: what 1.1.4's src/main/ssh/keys.ts (ssh2 1.17) answers beyond the plain key corpus of SP7, written to
// test/golden/ssh-keys.json for the Rust port (src-tauri/crates/unimux-ssh/tests/keys.rs):
//
// - parse: parsePrivateKey on text variants of corpus keys (junk around the block, two blocks, CR / CRLF / U+2028 line ends,
//   indented or re-wrapped base64, a BOM, odd PEM headers, PPK oddities, public key texts), each with no passphrase, the
//   right one, a wrong one and an empty one;
// - publicMatches: publicKeyMatches(meta, text) for public lines, RFC 4716, certificates, private texts and junk;
// - metaFromPublic: keyMetaFromPublic(line);
// - certificate: certificateCheck(cert, meta);
// - drafts: scripted KeyDrafts sessions (create / unlock / take / discard / clock steps) with every result; draft ids are
//   replaced by `#<n>` in the order they appear.
//
//   node scripts/golden-ssh-keys.mjs           rewrite test/golden/ssh-keys.json
//   node scripts/golden-ssh-keys.mjs --check   fail when it would change
//
// Runs itself again under Electron 45 as Node (BoringSSL decides what ssh2 reads, like in the 1.1.4 app). Only throwaway
// test keys of test/golden/sp7/keys are used; nothing random ends up in the file.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = resolve(root, 'test/golden/sp7/keys');
const out = resolve(root, 'test/golden/ssh-keys.json');
const PASS = 'sp7-pass';
const WRONG = 'wrong-pass';
const args = new Set(process.argv.slice(2));
if (!process.versions.electron) {
  const electron = createRequire(resolve(root, 'package.json'))('electron');
  const r = spawnSync(electron, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exit(r.status ?? 1);
}

const keys = (await runnerImport(resolve(root, 'src/main/ssh/keys.ts'), { configFile: false, logLevel: 'silent', root })).module;
const { parsePrivateKey, publicKeyMatches, keyMetaFromPublic, certificateCheck, KeyDrafts } = keys;

const file = (name) => readFileSync(resolve(keysDir, name), 'utf8');
const metaView = (m) => ({ type: m.type, bits: m.bits, fingerprint: m.fingerprint, comment: m.comment, publicKey: m.publicKey, blob: m.blob.toString('base64') });
const view = (r) => (r.ok ? { ok: true, encrypted: r.encrypted, ...metaView(r.meta) } : { ok: false, error: r.error, ...(r.encrypted !== undefined ? { encrypted: r.encrypted } : {}) });
const metaOfFile = (name, pass) => { const r = parsePrivateKey(file(name), pass); if (!r.ok) throw new Error(`fixture ${name}`); return r.meta; };

const sshString = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
/** test/helpers/sshKeys.ts fakeCertificate. */
function fakeCertificate(publicLine) {
  const [type, b64] = publicLine.split(' ');
  const blob = Buffer.from(b64, 'base64');
  const rest = blob.subarray(4 + blob.readUInt32BE(0));
  return `${type}-cert-v01@openssh.com ${Buffer.concat([sshString(Buffer.from(`${type}-cert-v01@openssh.com`)), sshString(Buffer.alloc(32, 1)), rest, Buffer.alloc(40, 2)]).toString('base64')} cert`;
}
/** An RFC 4716 public key (ssh-keygen -e) for a public line. */
function rfc4716(publicLine, header = 'Comment: "sp7 rfc4716"') {
  const b64 = publicLine.split(' ')[1];
  return `---- BEGIN SSH2 PUBLIC KEY ----\n${header ? `${header}\n` : ''}${b64.match(/.{1,70}/g).join('\n')}\n---- END SSH2 PUBLIC KEY ----\n`;
}
const rewrap = (text, width) => text.replace(/(-----BEGIN [^\n]+-----\n)([\s\S]+?)(\n-----END)/, (_, a, body, c) => `${a}${body.replace(/\n/g, '').match(new RegExp(`.{1,${width}}`, 'g')).join('\n')}${c}`);

// ---- parse: text variants -------------------------------------------------------------------------------------------
const BASES = ['openssh-ed25519.key', 'openssh-ed25519-enc.key', 'ssh2-ecdsa256.key', 'pem-rsa2048.key', 'pem-rsa2048-aes128.key', 'pem-ec256.key',
  'pem-ec256-aes128.key', 'ppk2-rsa.ppk', 'ppk2-rsa-enc.ppk'];
const VARIANTS = {
  'as-is': (t) => t,
  'leading-junk': (t) => `junk\n${t}`,
  'trailing-junk': (t) => `${t}junk\n`,
  'two-blocks': (t) => `${t}${t}`,
  'crlf': (t) => t.replace(/\r?\n/g, '\r\n'),
  'cr-only': (t) => t.replace(/\r?\n/g, '\r'),
  'u2028-lines': (t) => t.replace(/\r?\n/g, ' '),
  'indented': (t) => t.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n'),
  'base64-junk': (t) => { const lines = t.split('\n'); const i = lines.findIndex((l, n) => n > 0 && /^[A-Za-z0-9+/]{20}/.test(l)); lines[i] = `${lines[i].slice(0, 10)}*!${lines[i].slice(10)}`; return lines.join('\n'); },
  'rewrapped-76': (t) => rewrap(t, 76),
  'one-line-body': (t) => rewrap(t, 100000),
  'bom-and-spaces': (t) => `﻿ \t${t}　\n`,
  'blank-line-in-body': (t) => { const lines = t.split('\n'); const i = lines.findIndex((l, n) => n > 0 && /^[A-Za-z0-9+/]{20}/.test(l)); lines.splice(i + 1, 0, ''); return lines.join('\n'); },
};
const parse = [];
const answers = (text) => ({ noPassphrase: view(parsePrivateKey(text)), passphrase: view(parsePrivateKey(text, PASS)), wrongPassphrase: view(parsePrivateKey(text, WRONG)), emptyPassphrase: view(parsePrivateKey(text, '')) });
for (const base of BASES) {
  for (const [name, fn] of Object.entries(VARIANTS)) {
    if (base.endsWith('.ppk') && /rewrapped|one-line/.test(name)) continue;
    const text = fn(file(base));
    parse.push({ name: `${base} ${name}`, text, ...answers(text) });
  }
}
// PEM header and PPK oddities, public key texts.
const pemAes = file('pem-rsa2048-aes128.key');
const ppkEnc = file('ppk2-rsa-enc.ppk');
const ppk = file('ppk2-rsa.ppk');
const edPublic = metaOfFile('openssh-ed25519.key').publicKey;
const rsaPublic = metaOfFile('pem-rsa2048.key').publicKey;
const SPECIAL = {
  'pem DEK-Info without Proc-Type': pemAes.replace(/Proc-Type: 4,ENCRYPTED\r?\n/, ''),
  'pem DEK-Info with two spaces': pemAes.replace('DEK-Info: ', 'DEK-Info:  '),
  'pem DEK-Info without a space': pemAes.replace('DEK-Info: ', 'DEK-Info:'),
  'pem AES-128-GCM without Proc-Type': pemAes.replace(/Proc-Type: 4,ENCRYPTED\r?\n/, '').replace(/DEK-Info: AES-128-CBC,([0-9A-F]{24})[0-9A-F]{8}/, 'DEK-Info: AES-128-GCM,$1'),
  'pem DEK-Info twice': pemAes.replace(/(DEK-Info: [^\n]+\n)/, '$1$1'),
  'pem extra header': pemAes.replace('Proc-Type: 4,ENCRYPTED', 'Comment: x\nProc-Type: 4,ENCRYPTED'),
  'pem END label differs': file('pem-rsa2048.key').replace('END RSA', 'END EC'),
  'pem lower-case BEGIN': file('pem-rsa2048.key').replace('BEGIN RSA PRIVATE', 'begin RSA PRIVATE'),
  'ppk upper-case MAC': ppk.replace(/Private-MAC: ([0-9a-f]+)/, (_, m) => `Private-MAC: ${m.toUpperCase()}`),
  'ppk wrong line counts': ppk.replace(/Public-Lines: \d+/, 'Public-Lines: 99').replace(/Private-Lines: \d+/, 'Private-Lines: 1'),
  'ppk trailing junk': `${ppk}junk line\n`,
  'ppk enc upper-case MAC': ppkEnc.replace(/Private-MAC: ([0-9a-f]+)/, (_, m) => `Private-MAC: ${m.toUpperCase()}`),
  'ppk Encryption aes128': ppkEnc.replace('Encryption: aes256-cbc', 'Encryption: aes128-cbc'),
  'public ed25519 line': edPublic,
  'public rsa line': rsaPublic,
  'public line with a second line': `${edPublic}\nnext`,
  'public certificate': fakeCertificate(edPublic),
  'public rfc4716': rfc4716(rsaPublic),
  'public rfc4716 no header': rfc4716(rsaPublic, ''),
  'public rfc4716 ed25519': rfc4716(edPublic),
  'public dss line': `ssh-dss ${Buffer.concat([sshString(Buffer.from('ssh-dss')), sshString(Buffer.from([1])), sshString(Buffer.from([2])), sshString(Buffer.from([3])), sshString(Buffer.from([4]))]).toString('base64')} dss`,
  'pkcs8 inside openssh armor': file('pkcs8-ed25519.key').replace(/PRIVATE KEY/g, 'OPENSSH PRIVATE KEY'),
  'empty': '',
  'only whitespace': ' \n\t ',
};
for (const [name, text] of Object.entries(SPECIAL)) parse.push({ name, text, ...answers(text) });

// ---- publicKeyMatches / keyMetaFromPublic / certificateCheck --------------------------------------------------------
const MATCH_KEYS = ['openssh-ed25519.key', 'ssh2-ecdsa384.key', 'pem-rsa2048.key', 'ssh2-ecdsa521.key'];
const others = { 'openssh-ed25519.key': 'ssh2-ed25519.key', 'ssh2-ecdsa384.key': 'openssh-ecdsa384.key', 'pem-rsa2048.key': 'pem-rsa4096.key', 'ssh2-ecdsa521.key': 'openssh-ecdsa521.key' };
const publicMatches = [];
const certificate = [];
for (const name of MATCH_KEYS) {
  const meta = metaOfFile(name);
  const other = metaOfFile(others[name]).publicKey;
  const [type, b64] = meta.publicKey.split(' ');
  const texts = {
    own: meta.publicKey, 'own other comment': `${type} ${b64} someone@else`, 'own padded': `\n  ${type} ${b64}  \n`, 'own two spaces': `${type}  ${b64}`,
    'own base64 cut': `${type} ${b64.slice(0, -8)}`, other, garbage: 'garbage', empty: '', 'own private text': file(name), 'own certificate': fakeCertificate(meta.publicKey),
    'own rfc4716': rfc4716(meta.publicKey), 'encrypted private text': file('openssh-ed25519-enc.key'),
  };
  for (const [label, text] of Object.entries(texts)) publicMatches.push({ key: name, name: label, text, match: publicKeyMatches(meta, text) });
  const certs = {
    own: fakeCertificate(meta.publicKey), other: fakeCertificate(other), 'short blob': `${type}-cert-v01@openssh.com AAAA`, 'not a certificate': 'not a certificate',
    'own no comment': fakeCertificate(meta.publicKey).replace(/ cert$/, ''), 'own multi-word comment': `${fakeCertificate(meta.publicKey)} with words`,
    'own on two lines': fakeCertificate(meta.publicKey).replace(' cert', '\ncert'), 'own padded': `  ${fakeCertificate(meta.publicKey)}\n`,
    'v00 certificate': fakeCertificate(meta.publicKey).replace('-cert-v01@', '-cert-v00@'), 'cut after nonce': `${type}-cert-v01@openssh.com ${Buffer.concat([sshString(Buffer.from(`${type}-cert-v01@openssh.com`)), sshString(Buffer.alloc(32, 1))]).toString('base64')}`,
    'type of another key': fakeCertificate(other).replace(/^[^ ]+/, `${type}-cert-v01@openssh.com`), 'base64 with junk': fakeCertificate(meta.publicKey).replace(' ', ' *'),
  };
  for (const [label, cert] of Object.entries(certs)) certificate.push({ key: name, name: label, cert, result: certificateCheck(cert, meta) });
}
const metaFromPublic = [];
const LINES = {
  ed25519: edPublic, rsa: rsaPublic, 'ecdsa 521': metaOfFile('ssh2-ecdsa521.key').publicKey, 'raw comment': `${edPublic.split(' ').slice(0, 2).join(' ')}  a\tcomment\u0001 `,
  padded: `\n ${edPublic} \n`, certificate: fakeCertificate(edPublic), dss: SPECIAL['public dss line'], garbage: 'garbage', rfc4716: rfc4716(rsaPublic),
  'private text': file('openssh-ed25519.key'), 'base64 cut': edPublic.slice(0, 40),
};
for (const [name, line] of Object.entries(LINES)) { const m = keyMetaFromPublic(line); metaFromPublic.push({ name, line, meta: m ? metaView(m) : null }); }

// ---- KeyDrafts sessions -------------------------------------------------------------------------------------------
// Steps: create {privateKey: <file>|text, publicKey?, certificate?, duplicate?}, unlock {ref, passphrase, duplicate?},
// take {ref}, discard {ref}, advance {ms}. `ref` is the index of an earlier create step.
const ED = { file: 'openssh-ed25519.key' };
const ED_ENC = { file: 'openssh-ed25519-enc.key' };
const SESSIONS = {
  'plain key, take twice': [{ op: 'create', input: ED }, { op: 'take', ref: 0 }, { op: 'take', ref: 0 }],
  'encrypted key unlock': [{ op: 'create', input: ED_ENC }, { op: 'take', ref: 0 }, { op: 'unlock', ref: 0, passphrase: WRONG }, { op: 'unlock', ref: 0, passphrase: '' },
    { op: 'unlock', ref: 0, passphrase: PASS, duplicate: 'existing-id' }, { op: 'unlock', ref: 0, passphrase: WRONG }, { op: 'take', ref: 0 }, { op: 'take', ref: 0 }],
  'legacy PEM unlock': [{ op: 'create', input: { file: 'pem-ec256-aes128.key' } }, { op: 'unlock', ref: 0, passphrase: PASS }, { op: 'take', ref: 0 }],
  'encrypted PPK unlock': [{ op: 'create', input: { file: 'ppk2-rsa-enc.ppk' } }, { op: 'unlock', ref: 0, passphrase: WRONG }, { op: 'unlock', ref: 0, passphrase: PASS }, { op: 'take', ref: 0 }],
  'unencrypted keys given a passphrase': [{ op: 'create', input: ED }, { op: 'unlock', ref: 0, passphrase: PASS }, { op: 'take', ref: 0 },
    { op: 'create', input: { file: 'ppk2-rsa.ppk' } }, { op: 'unlock', ref: 3, passphrase: PASS }, { op: 'take', ref: 3 }],
  'public key and certificate checks': [
    { op: 'create', input: { ...ED, publicKey: `  ${edPublic}\n` } },
    { op: 'create', input: { ...ED, publicKey: metaOfFile('ssh2-ed25519.key').publicKey } },
    { op: 'create', input: { ...ED, publicKey: '   ' } },
    { op: 'create', input: { ...ED, certificate: fakeCertificate(metaOfFile('ssh2-ed25519.key').publicKey) } },
    { op: 'create', input: { ...ED, certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA' } },
    { op: 'take', ref: 4 },
    { op: 'create', input: { ...ED, certificate: `${fakeCertificate(edPublic)}\n` } },
    { op: 'take', ref: 6 },
    { op: 'create', input: { ...ED_ENC, publicKey: metaOfFile('ssh2-ed25519.key').publicKey } },
    { op: 'unlock', ref: 8, passphrase: PASS },
    { op: 'take', ref: 8 },
  ],
  'refused texts take no slot': [{ op: 'create', input: { text: 'hello' } }, { op: 'create', input: { text: 'x'.repeat(64 * 1024 + 1) } }, { op: 'create', input: { text: edPublic } },
    { op: 'create', input: { file: 'ppk3-rsa.ppk' } }, { op: 'create', input: { file: 'pkcs8-ed25519.key' } }, { op: 'unlock', ref: 0, passphrase: PASS }, { op: 'unlock', ref: 9, passphrase: PASS }],
  'expiry after 10 minutes': [{ op: 'create', input: ED }, { op: 'create', input: ED_ENC }, { op: 'advance', ms: 600000 }, { op: 'take', ref: 0 }, { op: 'advance', ms: 1 },
    { op: 'unlock', ref: 1, passphrase: PASS }, { op: 'create', input: ED }, { op: 'advance', ms: 600001 }, { op: 'take', ref: 6 }],
  'discard': [{ op: 'create', input: ED }, { op: 'discard', ref: 0 }, { op: 'take', ref: 0 }, { op: 'unlock', ref: 0, passphrase: PASS }],
  'at most 20 drafts': [...Array.from({ length: 22 }, () => ({ op: 'create', input: ED })), { op: 'take', ref: 0 }, { op: 'take', ref: 1 }, { op: 'take', ref: 2 }, { op: 'take', ref: 21 },
    { op: 'create', input: { text: 'hello' } }, { op: 'take', ref: 3 }],
};
const drafts = [];
for (const [name, steps] of Object.entries(SESSIONS)) {
  let now = 1_000_000;
  const store = new KeyDrafts(() => now);
  const ids = new Map();
  const token = (id) => { if (!ids.has(id)) ids.set(id, `#${ids.size}`); return ids.get(id); };
  const created = [];
  const results = steps.map((s) => {
    const dup = s.duplicate ? () => s.duplicate : () => undefined;
    if (s.op === 'create') {
      const privateKey = s.input.file ? file(s.input.file) : s.input.text;
      const r = store.create({ privateKey, ...(s.input.publicKey !== undefined ? { publicKey: s.input.publicKey } : {}), ...(s.input.certificate !== undefined ? { certificate: s.input.certificate } : {}) }, dup);
      created.push(r.ok ? r.draftId : 'missing');
      return r.ok ? { ...r, draftId: token(r.draftId) } : r;
    }
    if (s.op === 'advance') { now += s.ms; created.push(null); return null; }
    const id = steps[s.ref] && created[s.ref] ? created[s.ref] : 'missing';
    created.push(null);
    if (s.op === 'unlock') { const r = store.unlock(id, s.passphrase, dup); return r.ok ? { ...r, draftId: token(r.draftId) } : r; }
    if (s.op === 'discard') { store.discard(id); return null; }
    const t = store.take(id);
    return t && { text: t.text === (steps[s.ref].input.file ? file(steps[s.ref].input.file) : steps[s.ref].input.text), ...metaView(t.meta), encrypted: t.encrypted, passphrase: t.passphrase ?? null, certificate: t.certificate ?? null };
  });
  drafts.push({ name, steps, results });
}

const json = `${JSON.stringify({ passphrase: PASS, wrongPassphrase: WRONG, ssh2: JSON.parse(readFileSync(resolve(root, 'node_modules/ssh2/package.json'), 'utf8')).version, parse, publicMatches, metaFromPublic, certificate, drafts }, null, 1)}\n`;
if (args.has('--check')) {
  if (readFileSync(out, 'utf8') !== json) { console.error('test/golden/ssh-keys.json is out of date'); process.exit(1); }
} else writeFileSync(out, json);
console.log(`${parse.length} parse cases, ${publicMatches.length} publicKeyMatches, ${metaFromPublic.length} keyMetaFromPublic, ${certificate.length} certificateCheck, ${drafts.length} draft sessions`);
