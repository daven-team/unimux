// Real-app check of the Redis backend (1.0.0, no UI yet): the built app with a scratch data dir and home, a local Redis-like
// server (scripts/redis-test-server.mjs, password protected, seeded) and the local SSH test server. Through window.mc.db.redis it
// saves a connection (password only in the sealed vault), connects, lists DBs, scans keys with details, reads and writes values
// (binary included), runs console commands (dangerous ones refused without confirmation), receives Pub/Sub messages over the DB
// port, reads INFO/SLOWLOG/CLIENT LIST and connects read-only through an SSH tunnel. Run `npm run build` first. Never touches
// real hosts or the user's data dir; kills only the PIDs it started.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { killTree, launchApp, scratchRoot, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

async function startRedis() {
  const child = spawn(process.execPath, ['scripts/redis-test-server.mjs', '--password', 'redis-check-pw', '--seed', '300'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('redis test server did not start')), 30000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`redis test server exited (${code})`)); });
    child.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); } });
  });
  return { ...info, stop: () => killTree(child.pid) };
}

const check = (cond, label) => { if (!cond) throw new Error(`FAILED: ${label}`); console.log(`ok - ${label}`); };
const j = JSON.stringify;

const root = scratchRoot('redis');
const redis = await startRedis();
const ssh = await startTestServer();
let app;
try {
  const host = testHost(ssh.port);
  writeKnownHost(root, ssh);
  writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host] }));
  app = await launchApp(root);
  await app.evaluate(`(() => {
    window.__db = { port: null, msgs: [], sessions: [], prompts: [] };
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data !== 'mc:db-port' || !e.ports[0]) return;
      window.__db.port = e.ports[0];
      e.ports[0].onmessage = (m) => window.__db.msgs.push(m.data);
    });
    window.mc.on('db:session', (s) => window.__db.sessions.push(s));
    window.mc.on('db:prompt', (id, p) => window.__db.prompts.push({ id, p }));
    return true;
  })()`);
  const saved = await app.evaluate(`window.mc.db.saveConnection({ kind: 'redis', name: 'local redis', host: '127.0.0.1', port: ${redis.port}, user: '', dbIndex: 0, tls: 'disable', ssh: null, readOnly: false }, { set: 'redis-check-pw' })`);
  check(saved.ok, 'a Redis connection is saved');
  await app.until(`(async () => (await window.mc.db.vaultInfo()).saved.length === 1)()`, 'vault saved');
  const state = readFileSync(join(root, 'data', 'state.json'), 'utf8');
  const vault = readFileSync(join(root, 'data', 'db', 'vault.json'), 'utf8');
  check(!state.includes('redis-check-pw') && !vault.includes('redis-check-pw'), 'the password is in neither state.json nor vault.json in plain text');

  const c = await app.evaluate(`window.mc.db.connect(${j(saved.connection.id)})`);
  check(c.ok && c.sessionId.startsWith('db:'), 'connect answers at once with a db: session id');
  const sid = c.sessionId;
  await app.until(`window.__db.sessions.some((s) => s.id === ${j(sid)} && s.state === 'connected')`, 'connected', 30000);
  const st = await app.evaluate(`window.__db.sessions.filter((s) => s.id === ${j(sid)}).at(-1)`);
  check(st.kind === 'redis' && st.database === '0' && st.serverVersion === '7.2.4' && st.tls === false, 'the session state reports Redis, DB 0, the version and no TLS');
  await app.until('!!window.__db.port', 'DB port received');

  const dbs = await app.evaluate(`window.mc.db.redis.databases(${j(sid)})`);
  check(dbs.ok && dbs.value.count === 16 && dbs.value.dbs[0].keys === 306, 'databases: 16, db0 holds the seeded keys');
  const page = await app.evaluate(`window.mc.db.redis.scan(${j(sid)}, { cursor: '0', match: 'user:*', count: 1000, details: true })`);
  check(page.ok && page.value.keys.length === 1 && page.value.keys[0].type === 'hash' && page.value.keys[0].length === 2, 'SCAN with MATCH and details finds the hash with its length');
  const hash = await app.evaluate(`window.mc.db.redis.read(${j(sid)}, { type: 'hash', key: 'user:1', cursor: '0', count: 100 })`);
  check(hash.ok && hash.value.entries.some((e) => e.field === 'city' && e.value.data === 'Kraków'), 'a hash page reads UTF-8 values');
  const bin = await app.evaluate(`window.mc.db.redis.read(${j(sid)}, { type: 'string', key: { b64: 'YmluAP8=' } })`);
  check(bin.ok && bin.value.value.data.b64 === '3q2+7w==', 'a binary key and value arrive as base64');
  const w = await app.evaluate(`window.mc.db.redis.write(${j(sid)}, { op: 'zadd', key: 'scores', entries: [['ola', '42']], mode: 'xx' })`);
  const z = await app.evaluate(`window.mc.db.redis.read(${j(sid)}, { type: 'zset', key: 'scores', start: 0, count: 10, rev: true })`);
  check(w.ok && z.ok && z.value.entries[0].member === 'ola' && z.value.entries[0].score === '42', 'a sorted-set score is edited');
  const ren = await app.evaluate(`window.mc.db.redis.write(${j(sid)}, { op: 'rename', key: 'queue', newKey: 'tags' })`);
  check(!ren.ok && ren.error === 'keyExists', 'rename refuses an existing name');

  const danger = await app.evaluate(`window.mc.db.redis.command(${j(sid)}, { argv: ['FLUSHALL'] })`);
  check(!danger.ok && danger.error === 'needsConfirm', 'FLUSHALL needs a confirmation');
  const sub = await app.evaluate(`window.mc.db.redis.command(${j(sid)}, { argv: ['SUBSCRIBE', 'x'] })`);
  check(!sub.ok && sub.error === 'subscribeCommand', 'SUBSCRIBE in the console points to Pub/Sub');
  const get = await app.evaluate(`window.mc.db.redis.command(${j(sid)}, { argv: ['LRANGE', 'queue', '0', '-1'] })`);
  check(get.ok && get.value.reply.t === 'array' && get.value.reply.items[0].v === 'first', 'a console command answers a typed reply');

  const ps = await app.evaluate(`window.mc.db.redis.subscribe(${j(sid)}, { channels: ['news'], patterns: ['ev:*'] })`);
  check(ps.ok && ps.value.state === 'ready', 'Pub/Sub subscribes on its own connection');
  const n = await app.evaluate(`window.mc.db.redis.publish(${j(sid)}, 'ev:1', 'hello from the check')`);
  check(n.ok && n.value === 1, 'publish reaches the subscriber');
  await app.until(`window.__db.msgs.some((m) => m.t === 'redisPubSub' && m.sessionId === ${j(sid)} && m.messages.some((x) => x.pattern === 'ev:*' && x.payload.data === 'hello from the check'))`, 'pub/sub message on the DB port');
  check(true, 'the message arrives over the DB port with its pattern');

  const info = await app.evaluate(`window.mc.db.redis.info(${j(sid)}, 'server')`);
  const slow = await app.evaluate(`window.mc.db.redis.slowlog(${j(sid)}, 10)`);
  const clients = await app.evaluate(`window.mc.db.redis.clients(${j(sid)})`);
  check(info.ok && info.value[0].name === 'Server' && slow.ok && slow.value[0].args[0] === 'KEYS' && clients.ok && clients.value.length >= 2, 'INFO, SLOWLOG and CLIENT LIST are read');
  const counted = await app.evaluate(`window.mc.db.redis.countPattern(${j(sid)}, 'item:*')`);
  const deleted = counted.ok && await app.evaluate(`window.mc.db.redis.deletePattern(${j(sid)}, ${j(counted.value.token)})`);
  check(counted.ok && counted.value.count === 300 && deleted.ok && deleted.value.deleted === 300 && deleted.value.more === false, 'a pattern delete removes exactly the counted keys (console connection)');
  const sel = await app.evaluate(`window.mc.db.redis.select(${j(sid)}, 3)`);
  await app.until(`window.__db.sessions.some((s) => s.id === ${j(sid)} && s.database === '3')`, 'db 3 in the state');
  check(sel.ok, 'SELECT moves the session to DB 3');

  // Read-only through the SSH tunnel: the SSH password arrives as a db:prompt.
  const tun = await app.evaluate(`window.mc.db.saveConnection({ kind: 'redis', name: 'via ssh', host: 'localhost', port: 6379, user: '', dbIndex: 0, tls: 'disable', ssh: { hostId: ${j(host.id)}, dbHost: '127.0.0.1', dbPort: ${redis.port} }, readOnly: true }, { set: 'redis-check-pw' })`);
  check(tun.ok, 'a read-only tunnel connection is saved');
  const t = await app.evaluate(`window.mc.db.connect(${j(tun.connection.id)})`);
  await app.until(`window.__db.prompts.some((x) => x.id === ${j(t.sessionId)} && x.p && x.p.kind === 'password')`, 'SSH password prompt', 30000);
  const prompt = await app.evaluate(`window.__db.prompts.filter((x) => x.id === ${j(t.sessionId)} && x.p).at(-1).p`);
  await app.evaluate(`window.mc.db.answer({ sessionId: ${j(t.sessionId)}, promptId: ${j(prompt.id)}, values: [${j(ssh.password)}] })`);
  await app.until(`window.__db.sessions.some((s) => s.id === ${j(t.sessionId)} && s.state === 'connected')`, 'tunnel connected', 30000);
  const tget = await app.evaluate(`window.mc.db.redis.command(${j(t.sessionId)}, { argv: ['HGET', 'user:1', 'name'] })`);
  const tset = await app.evaluate(`window.mc.db.redis.command(${j(t.sessionId)}, { argv: ['SET', 'x', '1'] })`);
  const twrite = await app.evaluate(`window.mc.db.redis.write(${j(t.sessionId)}, { op: 'delete', keys: ['tags'] })`);
  check(tget.ok && tget.value.reply.v === 'Ala' && !tset.ok && tset.error === 'readOnly' && !twrite.ok && twrite.error === 'readOnly', 'through the SSH tunnel reads work and the read-only connection refuses writes');

  for (const id of [sid, t.sessionId]) await app.evaluate(`window.mc.db.disconnect(${j(id)})`);
  await app.until(`(async () => (await window.mc.db.sessions()).sessions.length === 0)()`, 'all disconnected');
  check(true, 'sessions disconnect');
  console.log('Redis real-app check passed');
} finally {
  await app?.close();
  redis.stop();
  ssh.stop();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a locked file stays until the next run */ }
}
