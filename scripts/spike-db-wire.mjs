// SP9 (Tauri migration spike, DB wire fidelity): starts our own Docker servers (PostgreSQL 13 and 18, MySQL 8.4,
// MariaDB 11, Redis 8), writes or checks the 1.1.4 driver goldens (test/db-wire-sp9.int.test.ts, vitest) and runs the Rust
// comparison (src-tauri/crates/unimux-db/tests/wire_servers.rs), then removes exactly the containers it started (by id).
//
//   node scripts/spike-db-wire.mjs            check the committed goldens, then the Rust side
//   node scripts/spike-db-wire.mjs --write    rewrite the goldens from the Node drivers first
//   node scripts/spike-db-wire.mjs --keep     leave the containers running and print MC_SP9_SERVERS
//   node scripts/spike-db-wire.mjs --only=pg18,redis8
import { execFileSync, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7).split(',');

const SERVERS = [
  { label: 'pg13', kind: 'postgres', image: 'postgres:13', port: 5432, env: ['POSTGRES_PASSWORD=pw'], user: 'postgres', password: 'pw' },
  { label: 'pg18', kind: 'postgres', image: 'postgres:18', port: 5432, env: ['POSTGRES_PASSWORD=pw'], user: 'postgres', password: 'pw' },
  { label: 'mysql84', kind: 'mysql', image: 'mysql:8.4', port: 3306, env: ['MYSQL_ROOT_PASSWORD=pw'], user: 'root', password: 'pw' },
  { label: 'mariadb11', kind: 'mariadb', image: 'mariadb:11', port: 3306, env: ['MARIADB_ROOT_PASSWORD=pw'], user: 'root', password: 'pw' },
  { label: 'redis8', kind: 'redis', image: 'redis:8', port: 6379, env: [], user: '', password: '' },
].filter((s) => !only || only.includes(s.label));

const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const started = [];

function cleanup() {
  if (args.has('--keep')) return;
  for (const s of started) {
    try { docker('rm', '-f', s.id); console.log(`removed ${s.label} ${s.id.slice(0, 12)}`); } catch (e) { console.error(`could not remove ${s.id}: ${e.message}`); }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tcpOpen = (port) => new Promise((resolve) => {
  const c = createConnection(port, '127.0.0.1');
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('error', () => resolve(false));
});

async function waitReady(s) {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const logs = spawnSync('docker', ['logs', s.id], { encoding: 'utf8' });
    const text = (logs.stdout ?? '') + (logs.stderr ?? '');
    const ready = s.kind === 'postgres' ? (text.match(/database system is ready to accept connections/g) ?? []).length >= 2
      : s.kind === 'redis' ? /Ready to accept connections/.test(text)
        // the entrypoint's temporary server says "ready for connections" first, with port 0
        : /ready for connections[\s\S]*port: 3306/.test(text);
    if (ready && await tcpOpen(s.hostPort)) return;
    await sleep(500);
  }
  throw new Error(`${s.label} did not get ready`);
}

try {
  for (const s of SERVERS) {
    const id = docker('run', '-d', '--name', `unimux-sp9-${s.label}-${process.pid}`, '-p', `127.0.0.1::${s.port}`, ...s.env.flatMap((e) => ['-e', e]), s.image);
    started.push({ label: s.label, id });
    s.id = id;
    s.hostPort = Number(docker('port', id, `${s.port}/tcp`).split('\n')[0].split(':').pop());
    console.log(`${s.label}: ${s.image} on 127.0.0.1:${s.hostPort} (${id.slice(0, 12)})`);
  }
  for (const s of SERVERS) await waitReady(s);
  const env = JSON.stringify(SERVERS.map((s) => ({ label: s.label, kind: s.kind, host: '127.0.0.1', port: s.hostPort, user: s.user, password: s.password })));
  console.log(`MC_SP9_SERVERS=${env}`);
  const vitest = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'test/db-wire-sp9.int.test.ts'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, MC_SP9_SERVERS: env, ...(args.has('--write') ? { MC_SP9_WRITE: '1' } : {}) },
  });
  if (vitest.status !== 0) throw new Error('vitest (Node goldens) failed');
  const t0 = Date.now();
  const cargo = spawnSync(process.execPath, [join(ROOT, 'scripts', 'msvc-run.mjs'), 'cargo', 'test', '-p', 'unimux-db', '--test', 'wire_servers', '--', '--nocapture', '--test-threads=1'], {
    cwd: join(ROOT, 'src-tauri'), stdio: 'inherit', env: { ...process.env, MC_SP9_SERVERS: env },
  });
  console.log(`cargo wire_servers: ${Date.now() - t0} ms`);
  if (cargo.status !== 0) throw new Error('cargo wire_servers failed');
  console.log('SP9 wire goldens: Node and Rust agree');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
