// S4: the russh login core (src-tauri/crates/unimux-ssh/examples/ssh_matrix.rs, the real `login::login`) against the SP7
// Docker servers (OpenSSH 10 with four configs, OpenSSH 5.9, Dropbear 2025 and 2016), compared with what 1.1.4's ssh2 did
// on the same servers (test/golden/sp7/matrix.json, recorded by scripts/sp7/matrix.mjs under Electron): the outcome, the
// SshErrorCode and the sequence of methods sent ("-> none", "-> publickey", ..., "-> false"). Also checked: a host key is
// shown on every server that completes a key exchange, and the exec on a logged-in connection answers "sp7-ok".
// No Electron and no Node SSH code: this runs in CI after R1 too (job `ssh-matrix` in .github/workflows/tauri.yml).
//
//   cargo build -p unimux-ssh --example ssh_matrix   (in src-tauri)
//   node scripts/ssh-matrix.mjs [--build] [--only <server>]
//
// Containers are started with their ids recorded and removed by id at the end (never a prune). The servers that only
// offer SHA-1 key exchange or CBC ciphers must fail with `protocol`, as 1.1.4 did (unsupported legacy algorithms, see
// docs/tauri/spikes/SP7.md).
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = resolve(root, `src-tauri/target/${process.env.SSH_MATRIX_PROFILE ?? 'debug'}/examples/ssh_matrix${process.platform === 'win32' ? '.exe' : ''}`);
const keysDir = resolve(root, 'test/golden/sp7/keys');
const keysGolden = JSON.parse(readFileSync(resolve(root, 'test/golden/sp7/keys.json'), 'utf8'));
const matrix = JSON.parse(readFileSync(resolve(root, 'test/golden/sp7/matrix.json'), 'utf8'));
const PASS = keysGolden.passphrase;
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The same servers, images and keys as scripts/sp7/matrix.mjs.
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
  const byFile = new Map(keysGolden.entries.map((e) => [e.file, e]));
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

function runCases(cases, dir) {
  const file = join(dir, `cases-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(cases));
  return new Promise((done, fail) => {
    const p = spawn(exe, [`@${file}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      rmSync(file, { force: true });
      const lines = out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
      if (code !== 0 || lines.length !== cases.length) fail(new Error(`ssh_matrix exited ${code}: ${err.slice(0, 2000)}`)); else done(lines);
    });
  });
}

/** The login cases of scripts/sp7/matrix.mjs (ids equal to the golden rows). */
function loginCases(port) {
  const cases = [];
  for (const [label, file, enc] of USER_KEYS) {
    cases.push({ id: `publickey ${label}`, user: 'sp7', keyFile: join(keysDir, file), ...(enc ? { passphrase: PASS } : {}), answers: ['nope'], exec: 'echo sp7-ok' });
  }
  cases.push({ id: 'saved password', user: 'sp7', password: 'sp7-pw', exec: 'echo sp7-ok' });
  cases.push({ id: 'password prompt', user: 'sp7', allowPasswordPrompt: true, promptPassword: 'sp7-pw', exec: 'echo sp7-ok' });
  cases.push({ id: 'keyboard-interactive', user: 'kbd', answers: ['kbd-pw'], exec: 'echo sp7-ok' });
  cases.push({ id: 'wrong saved password', user: 'sp7', password: 'nope', answers: ['nope'] });
  return cases.map((c) => ({ host: '127.0.0.1', port, ...c }));
}

const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

async function serverRun(server, dir, akDir) {
  const id = docker('run', '-d', '-p', '127.0.0.1::22', '-v', `${akDir.replace(/\\/g, '/')}:/sp7:ro`, '--label', 'unimux-ssh-matrix=1', server.image, ...server.cmd);
  started.push(id);
  const port = Number(docker('port', id, '22/tcp').split('\n')[0].split(':').pop());
  const banner = await waitForSsh(port);
  const golden = matrix.results.find((r) => r.server === server.name);
  const results = await runCases(loginCases(port), dir);
  const rows = results.map((r) => {
    const g = golden?.logins.find((l) => l.id === r.id);
    const problems = [];
    if (!g) problems.push('no 1.1.4 row');
    else {
      const ssh2Ok = g.ssh2 === 'ok';
      if (ssh2Ok !== r.ok) problems.push(`outcome ${r.ok ? 'ok' : r.code} vs 1.1.4 ${g.ssh2}`);
      else if (!r.ok && r.code !== g.ssh2Code) problems.push(`code ${r.code} vs 1.1.4 ${g.ssh2Code}`);
      if (!same(r.methods, g.sent?.ssh2)) problems.push(`methods ${r.methods.join(', ')} vs 1.1.4 ${(g.sent?.ssh2 ?? []).join(', ')}`);
    }
    if (r.ok && r.exec && (r.exec.stdout !== 'sp7-ok\n' || r.exec.exitStatus !== 0)) problems.push(`exec ${JSON.stringify(r.exec)}`);
    if (r.code !== 'protocol' && !r.hostKey) problems.push('no host key shown');
    return { id: r.id, ok: r.ok, code: r.code, methods: r.methods, problems };
  });
  return { server: server.name, banner, rows };
}

const started = [];
const work = mkdtempSync(join(tmpdir(), 'unimux-ssh-matrix-'));
const akDir = mkdtempSync(join(tmpdir(), 'unimux-ssh-matrix-ak-'));
writeFileSync(join(akDir, 'authorized_keys'), authorizedKeys());
const results = [];
let failure = null;
try {
  if (argv.includes('--build')) {
    for (const [tag, file, extra] of IMAGES) docker('build', '--load', '-q', '-t', tag, '-f', resolve(root, 'scripts/sp7/docker', file), ...extra, resolve(root, 'scripts/sp7/docker'));
  }
  if (!existsSync(exe)) throw new Error(`build it first: cargo build -p unimux-ssh --example ssh_matrix (${exe})`);
  for (const server of SERVERS) {
    process.stderr.write(`${server.name} ...\n`);
    results.push(await serverRun(server, work, akDir));
  }
} catch (e) {
  failure = e;
} finally {
  for (const id of started) { try { docker('rm', '-f', id); } catch { /* already gone */ } }
  rmSync(work, { recursive: true, force: true });
  rmSync(akDir, { recursive: true, force: true });
}
if (failure) { console.error(failure.message); process.exit(1); }

for (const r of results) {
  console.log(`\n### ${r.server} (\`${r.banner}\`)\n`);
  console.log('| login | russh login core | methods sent | same as 1.1.4 |');
  console.log('|---|---|---|---|');
  for (const l of r.rows) console.log(`| ${l.id} | ${l.ok ? 'ok' : `fail (${l.code})`} | ${l.methods.map((m) => m.slice(3)).join(', ') || '-'} | ${l.problems.length ? `NO: ${l.problems.join('; ')}` : 'yes'} |`);
}
const bad = results.flatMap((r) => r.rows.filter((l) => l.problems.length).map((l) => `${r.server}: ${l.id}: ${l.problems.join('; ')}`));
console.log(bad.length ? `\nDIFFERENCES:\n${bad.join('\n')}` : '\nthe login core matches 1.1.4 on every server');
process.exit(bad.length ? 1 : 0);
