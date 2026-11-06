// SP7: russh 0.65.1 against 1.1.4's ssh2 1.17 on real servers in Docker (OpenSSH 10 with four configs, OpenSSH 5.9,
// Dropbear 2025 and 2016). For every server:
//   - logins: the 1.1.4 path (scripts/sp7/ssh2-side.mjs under Electron: SshLogin, auth order, prompts) and the russh probe
//     (src-tauri/crates/unimux-ssh/examples/sp7_probe.rs) with the same credentials; compared: success, negotiated algorithms;
//   - host keys: for each host key algorithm, ssh2 trusts the key into a 1.1.4 known_hosts.json (KnownHostsStore) and russh
//     must present the same bytes (base64 of the blob equal to the stored entry);
//   - profiles: russh's own defaults and the "legacy" profile (SHA-1 kex + CBC) next to the 1.1.4 offer;
//   - timing: 10 publickey logins per side on OpenSSH 10 (p50 / p95).
// Containers are started with ids recorded and removed by id at the end (never a prune). Images: scripts/sp7/docker/*.
//
//   cargo build -p unimux-ssh --example sp7_probe   (in src-tauri)
//   node scripts/sp7/matrix.mjs [--build] [--only <server>]
//
// Writes test/golden/sp7/matrix.json and test/golden/sp7/known_hosts/<server>.json (the 1.1.4 files of the last run; the
// host keys change with every image build) and prints
// the markdown tables used in docs/tauri/spikes/SP7.md.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'package.json'));
const electron = require('electron');
// SP7_PROBE_PROFILE=release for the timing numbers (cargo build --release -p unimux-ssh --example sp7_probe).
const probe = resolve(root, `src-tauri/target/${process.env.SP7_PROBE_PROFILE ?? 'debug'}/examples/sp7_probe${process.platform === 'win32' ? '.exe' : ''}`);
const keysDir = resolve(root, 'test/golden/sp7/keys');
const golden = JSON.parse(readFileSync(resolve(root, 'test/golden/sp7/keys.json'), 'utf8'));
const PASS = golden.passphrase;
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const SERVERS = [
  { name: 'openssh-10-current', image: 'unimux-sp7-openssh', cmd: ['current'] },
  { name: 'openssh-10-old-offer', image: 'unimux-sp7-openssh', cmd: ['old'] },
  { name: 'openssh-10-sha1-only', image: 'unimux-sp7-openssh', cmd: ['sha1'] },
  { name: 'openssh-10-cbc-only', image: 'unimux-sp7-openssh', cmd: ['cbc'] },
  { name: 'openssh-5.9-ubuntu1204', image: 'unimux-sp7-ubuntu1204', cmd: [] },
  { name: 'dropbear-2025', image: 'unimux-sp7-dropbear', cmd: ['256'] },
  { name: 'dropbear-2025-ecdsa521', image: 'unimux-sp7-dropbear', cmd: ['521'] },
  { name: 'dropbear-2016', image: 'unimux-sp7-dropbear-old', cmd: ['256'] },
].filter((s) => !only || s.name === only);

const IMAGES = [
  ['unimux-sp7-openssh', 'openssh.Dockerfile', []],
  ['unimux-sp7-ubuntu1204', 'ubuntu1204.Dockerfile', []],
  ['unimux-sp7-dropbear', 'dropbear.Dockerfile', []],
  ['unimux-sp7-dropbear-old', 'dropbear.Dockerfile', ['--build-arg', 'BASE=debian:stretch-slim', '--build-arg', 'ARCHIVE=1']],
];

const HOST_KEY_ALGS = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];

/** User keys for the publickey logins (1.1.4's own generated keys first, then pasted formats russh reads directly). */
const USER_KEYS = [
  ['ed25519', 'ssh2-ed25519.key', false],
  ['ecdsa256', 'ssh2-ecdsa256.key', false],
  ['ecdsa384', 'ssh2-ecdsa384.key', false],
  ['ecdsa521', 'ssh2-ecdsa521.key', false],
  ['rsa3072', 'ssh2-rsa3072.key', false],
  ['ed25519 enc (1.1.4 generated)', 'ssh2-ed25519-enc.key', true],
  ['rsa3072 enc (OpenSSH)', 'openssh-rsa3072-enc.key', true],
  ['rsa2048 PEM AES-128', 'pem-rsa2048-sshkeygen-enc.key', true],
  ['rsa2048 PPK v2 enc', 'ppk2-rsa-enc.ppk', true],
];

function authorizedKeys() {
  const byFile = new Map(golden.entries.map((e) => [e.file, e]));
  return USER_KEYS.map(([, f]) => { const e = byFile.get(f); return (e.noPassphrase.ok ? e.noPassphrase : e.passphrase).publicKey; }).join('\n') + '\n';
}

function waitForSsh(port, ms = 30_000) {
  const until = Date.now() + ms;
  return new Promise((done, fail) => {
    const attempt = () => {
      const s = connect(port, '127.0.0.1');
      let buf = '';
      s.setTimeout(3000);
      s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); done(buf.split(/\r?\n/)[0]); } });
      const retry = () => { s.destroy(); if (Date.now() > until) fail(new Error(`no SSH banner on ${port}`)); else setTimeout(attempt, 300); };
      s.on('error', retry);
      s.on('timeout', retry);
      s.on('close', () => { if (!buf.includes('\n')) retry(); });
    };
    attempt();
  });
}

function runLines(cmd, args, env) {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      const lines = out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
      if (code !== 0 && !lines.length) fail(new Error(`${cmd} exited ${code}: ${err.slice(0, 2000)}`)); else done(lines);
    });
  });
}

const ssh2Side = (cases, dir) => {
  const file = join(dir, `ssh2-cases-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(cases));
  return runLines(electron, [resolve(root, 'scripts/sp7/ssh2-side.mjs'), file], { ELECTRON_RUN_AS_NODE: '1' });
};
const russhSide = (specs, dir) => {
  const file = join(dir, `russh-specs-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(specs));
  return runLines(probe, [`@${file}`], {});
};

const fp = (b64) => `SHA256:${createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')}`;
const blobType = (b64) => { const b = Buffer.from(b64, 'base64'); return b.subarray(4, 4 + b.readUInt32BE(0)).toString('latin1'); };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

/** Login cases: the 1.1.4 request and the russh steps that send the same methods in the same order (SshLogin's order). */
function loginCases(port) {
  const cases = [];
  for (const [label, file, enc] of USER_KEYS) {
    const text = readFileSync(join(keysDir, file), 'utf8');
    // A refused key goes on to keyboard-interactive in 1.1.4 (3 tries, answered "nope"); russh does the same steps.
    cases.push({ id: `publickey ${label}`, ssh2: { user: 'sp7', privateKey: text, ...(enc ? { passphrase: PASS } : {}), answers: ['nope'], exec: 'echo sp7-ok' },
      russh: { user: 'sp7', steps: [{ method: 'publickey', keyFile: join(keysDir, file), ...(enc ? { passphrase: PASS } : {}) }, ...Array.from({ length: 3 }, () => ({ method: 'kbd', answers: ['nope'] }))], exec: 'echo sp7-ok' } });
  }
  cases.push({ id: 'saved password', ssh2: { user: 'sp7', password: 'sp7-pw', exec: 'echo sp7-ok' }, russh: { user: 'sp7', steps: [{ method: 'password', password: 'sp7-pw' }], exec: 'echo sp7-ok' } });
  cases.push({ id: 'password prompt', ssh2: { user: 'sp7', password: undefined, allowPasswordPrompt: true, promptPassword: 'sp7-pw', exec: 'echo sp7-ok' },
    russh: { user: 'sp7', steps: [{ method: 'none' }, { method: 'password', password: 'sp7-pw' }], exec: 'echo sp7-ok' } });
  cases.push({ id: 'keyboard-interactive', ssh2: { user: 'kbd', answers: ['kbd-pw'], exec: 'echo sp7-ok' },
    russh: { user: 'kbd', steps: [{ method: 'none' }, { method: 'kbd', answers: ['kbd-pw'] }], exec: 'echo sp7-ok' } });
  // 1.1.4 goes on to keyboard-interactive after a refused saved password (3 tries, each answered "nope" here).
  cases.push({ id: 'wrong saved password', ssh2: { user: 'sp7', password: 'nope', answers: ['nope'] },
    russh: { user: 'sp7', steps: [{ method: 'password', password: 'nope' }, ...Array.from({ length: 3 }, () => ({ method: 'kbd', answers: ['nope'] }))] } });
  return cases.map((c) => ({ ...c, ssh2: { kind: 'login', id: c.id, host: '127.0.0.1', port, ...c.ssh2 }, russh: { host: '127.0.0.1', port, profile: 'ssh2', ...c.russh } }));
}

async function serverRun(server, dir, akDir) {
  const args = ['run', '-d', '-p', '127.0.0.1::22', '-v', `${akDir.replace(/\\/g, '/')}:/sp7:ro`, '--label', 'unimux-sp7=1', server.image, ...server.cmd];
  const id = docker(...args);
  started.push(id);
  let port;
  try {
    port = Number(docker('port', id, '22/tcp').split('\n')[0].split(':').pop());
  } catch {
    throw new Error(`${server.name} did not start: ${execFileSync('docker', ['logs', id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })}`);
  }
  const banner = await waitForSsh(port);
  const result = { server: server.name, banner, logins: [], hostKeys: [], profiles: [] };
  const known = join(dir, `known_hosts-${server.name}.json`);

  // Logins. The password prompt answer goes through SshLogin's prompt hook (prompt kind "password").
  const cases = loginCases(port);
  const s2 = await ssh2Side(cases.map((c) => ({ ...c.ssh2, promptAnswer: c.ssh2.promptPassword })), dir);
  const ru = await russhSide(cases.map((c) => c.russh), dir);
  const rl = await russhSide(cases.map((c) => ({ ...c.russh, profile: 'legacy' })), dir);
  cases.forEach((c, i) => result.logins.push({ id: c.id, ssh2: s2[i], russh: ru[i], legacy: rl[i] }));

  // Host keys, one algorithm at a time.
  const hk2 = await ssh2Side(HOST_KEY_ALGS.map((alg) => ({ kind: 'hostkey', id: alg, host: '127.0.0.1', port, user: 'sp7', hostKeyAlg: alg, knownHostsFile: known })), dir);
  const hkr = await russhSide(HOST_KEY_ALGS.map((alg) => ({ host: '127.0.0.1', port, user: 'sp7', profile: 'legacy', hostKeyAlgs: [alg], steps: [] })), dir);
  const stored = existsSync(known) ? JSON.parse(readFileSync(known, 'utf8')).entries : [];
  HOST_KEY_ALGS.forEach((alg, i) => {
    const a = hk2[i];
    const b = hkr[i];
    const r = b.hostKey?.base64 ?? null;
    const entry = r ? stored.find((e) => e.host === '127.0.0.1' && e.port === port && e.keyType === blobType(r)) : null;
    result.hostKeys.push({
      alg, ssh2: a.ok ? a.base64 : null, ssh2Error: a.ok ? undefined : a.error, russh: r, russhError: r ? undefined : b.error,
      knownHostsEntry: entry ? { keyType: entry.keyType, key: entry.key, fingerprint: entry.fingerprint } : null,
      equal: !!(a.ok && r && a.base64 === r && entry && entry.key === r && entry.fingerprint === fp(r)),
    });
  });
  if (existsSync(known)) {
    mkdirSync(resolve(root, 'test/golden/sp7/known_hosts'), { recursive: true });
    copyFileSync(known, resolve(root, `test/golden/sp7/known_hosts/${server.name}.json`));
  }

  // Offer profiles: one saved-password login each.
  const pw = { host: '127.0.0.1', port, user: 'sp7', steps: [{ method: 'password', password: 'sp7-pw' }] };
  const prof = await russhSide(['ssh2', 'russh', 'legacy'].map((profile) => ({ ...pw, profile })), dir);
  result.profiles = ['ssh2', 'russh', 'legacy'].map((profile, i) => ({ profile, ok: prof[i].ok, names: prof[i].names, error: prof[i].error }));

  // Timing on the main server only.
  if (server.name === 'openssh-10-current') {
    const key = join(keysDir, 'ssh2-ed25519.key');
    const n = 10;
    const t2 = await ssh2Side(Array.from({ length: n }, (_, i) => ({ kind: 'login', id: `t${i}`, host: '127.0.0.1', port, user: 'sp7', privateKey: readFileSync(key, 'utf8') })), dir);
    const tr = await russhSide(Array.from({ length: n }, () => ({ host: '127.0.0.1', port, user: 'sp7', profile: 'ssh2', steps: [{ method: 'publickey', keyFile: key }] })), dir);
    result.timing = {
      runs: n,
      ssh2: { p50: pct(t2.map((x) => x.ms.ready), 50), p95: pct(t2.map((x) => x.ms.ready), 95), kexP50: pct(t2.map((x) => x.ms.kex), 50) },
      russh: { p50: pct(tr.map((x) => x.ms.total), 50), p95: pct(tr.map((x) => x.ms.total), 95), kexP50: pct(tr.map((x) => x.ms.kex), 50) },
    };
  }
  return result;
}

const started = [];
const work = mkdtempSync(join(tmpdir(), 'unimux-sp7-'));
const akDir = mkdtempSync(join(tmpdir(), 'unimux-sp7-ak-'));
writeFileSync(join(akDir, 'authorized_keys'), authorizedKeys());
const results = [];
try {
  if (argv.includes('--build')) {
    for (const [tag, file, extra] of IMAGES) docker('build', '--load', '-q', '-t', tag, '-f', resolve(root, 'scripts/sp7/docker', file), ...extra, resolve(root, 'scripts/sp7/docker'));
  }
  if (!existsSync(probe)) throw new Error(`build the probe first: cargo build -p unimux-ssh --example sp7_probe (${probe})`);
  for (const server of SERVERS) {
    process.stderr.write(`${server.name} ...\n`);
    results.push(await serverRun(server, work, akDir));
  }
} finally {
  for (const id of started) { try { docker('rm', '-f', id); } catch { /* already gone */ } }
  rmSync(work, { recursive: true, force: true });
  rmSync(akDir, { recursive: true, force: true });
}

const names = (n) => (n ? `${n.kex} / ${n.hostKey} / ${n.cipher}${aead(n.cipher) ? '' : ` / ${n.mac}`}` : '-');
// With an AEAD cipher (GCM, chacha20-poly1305) no MAC is used: ssh2 reports '' and russh the first common name.
const aead = (c) => /gcm|poly1305/.test(c ?? '');
const sameNames = (a, b) => !!(a && b && a.kex === b.kex && a.hostKey === b.hostKey && a.cipher === b.cipher && (aead(a.cipher) || a.mac === b.mac));
/** A short form of a russh failure for the tables (the full text stays in matrix.json). */
const russhShort = (x) => {
  if (x.ok) return 'ok';
  const m = /No common (\w+) algorithm/.exec(x.error ?? '');
  if (m) return `fail (no common ${m[1].toLowerCase()})`;
  return `fail (${x.error ?? x.steps?.map((st) => st.error ?? (st.success ? 'ok' : 'denied')).join(',')})`;
};
const summary = results.map((r) => ({
  server: r.server, banner: r.banner,
  logins: r.logins.map((l) => ({
    id: l.id, ssh2: l.ssh2.ok ? 'ok' : `fail (${l.ssh2.code ?? l.ssh2.error})`, russh: russhShort(l.russh), legacy: russhShort(l.legacy), russhError: l.russh.error, legacyNames: l.legacy.names,
    sameOutcome: !!l.ssh2.ok === !!l.russh.ok, sameAlgorithms: !l.ssh2.ok || sameNames(l.ssh2.names, l.russh.names),
    ssh2Names: l.ssh2.names, russhNames: l.russh.names, ssh2Methods: l.ssh2.methodsSeen, ssh2Events: l.ssh2.events, ssh2Error: l.ssh2.error, russhSteps: l.russh.steps, ssh2Prompts: l.ssh2.prompts, banner: { ssh2: l.ssh2.banner ?? null, russh: l.russh.banner ?? null },
  })),
  hostKeys: r.hostKeys, profiles: r.profiles, timing: r.timing,
}));
// A partial run (--only) never replaces the full matrix.
if (!only) writeFileSync(resolve(root, 'test/golden/sp7/matrix.json'),`${JSON.stringify({ when: new Date().toISOString().slice(0, 10), results: summary }, null, 1)}\n`);

for (const r of summary) {
  console.log(`\n### ${r.server} (\`${r.banner}\`)\n`);
  console.log('| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |');
  console.log('|---|---|---|---|---|');
  for (const l of r.logins) console.log(`| ${l.id} | ${l.ssh2} | ${l.russh} | ${l.sameAlgorithms ? 'yes' : `NO: ${names(l.ssh2Names)} vs ${names(l.russhNames)}`} | ${l.legacy} |`);
  const first = r.logins.find((l) => l.ssh2Names || l.russhNames || l.legacyNames);
  console.log(`\nnegotiated: 1.1.4 ${names(first?.ssh2Names)}; russh ${names(first?.russhNames)}; russh legacy offer ${names(first?.legacyNames)}\n`);
  console.log('| host key algorithm | ssh2 | russh | known_hosts.json entry equal |');
  console.log('|---|---|---|---|');
  for (const h of r.hostKeys) console.log(`| ${h.alg} | ${h.ssh2 ? 'presented' : 'absent'} | ${h.russh ? 'presented' : 'absent'} | ${h.ssh2 || h.russh ? (h.equal ? 'yes (byte-identical)' : 'NO') : '-'} |`);
  console.log('\n| russh profile | saved-password login | negotiated |');
  console.log('|---|---|---|');
  for (const p of r.profiles) console.log(`| ${p.profile} | ${russhShort(p)} | ${names(p.names)} |`);
  if (r.timing) console.log(`\ntiming (${r.timing.runs} publickey ed25519 logins, ms to authenticated): ssh2 p50 ${r.timing.ssh2.p50} p95 ${r.timing.ssh2.p95} (kex ${r.timing.ssh2.kexP50}); russh p50 ${r.timing.russh.p50} p95 ${r.timing.russh.p95} (kex ${r.timing.russh.kexP50})`);
}
const bad = summary.flatMap((r) => [...r.logins.filter((l) => !l.sameOutcome || !l.sameAlgorithms).map((l) => `${r.server}: ${l.id}`), ...r.hostKeys.filter((h) => (h.ssh2 || h.russh) && !h.equal).map((h) => `${r.server}: host key ${h.alg}`)]);
console.log(bad.length ? `\nDIFFERENCES:\n${bad.join('\n')}` : '\nno differences between 1.1.4 and russh (1.1.4 offer)');
process.exit(bad.length ? 1 : 0);
