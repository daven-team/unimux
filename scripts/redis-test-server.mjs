// node scripts/redis-test-server.mjs [--port <n>] [--password <pw>] [--user <name>:<pw>] [--seed <n keys>] [--tls-key <file> --tls-cert <file>]
// A local Redis-compatible server for real-app checks (1.0.0): test/helpers/respServer.ts in memory on 127.0.0.1 (RESP2/RESP3,
// every type, SCAN, Pub/Sub, INFO, SLOWLOG, CLIENT LIST). --seed fills db0 with sample keys of every type (and N strings).
// Prints one JSON line {"port","pid"} and runs until its PID is killed. Never use real credentials.
import { readFileSync } from 'node:fs';

const { startRespServer, addSlowlog } = await import('../test/helpers/respServer.ts');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const users = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--user') continue;
  const [name, pw] = (process.argv[i + 1] ?? '').split(':');
  if (name && pw) users[name] = pw;
}
const tls = arg('--tls-key') && arg('--tls-cert') ? { key: readFileSync(arg('--tls-key'), 'utf8'), cert: readFileSync(arg('--tls-cert'), 'utf8') } : undefined;
const server = await startRespServer({ port: Number(arg('--port')) || 0, password: arg('--password'), users, tls });
const seed = Number(arg('--seed') ?? '0');
if (seed > 0) {
  const db = server.dbs[0];
  const k = (s) => Buffer.from(s, 'utf8').toString('latin1');
  for (let i = 0; i < seed; i++) server.setString(`item:${i}`, `value ${i}`);
  db.set(k('user:1'), { value: { type: 'hash', v: new Map([[k('name'), Buffer.from('Ala')], [k('city'), Buffer.from('Kraków')]]) } });
  db.set(k('queue'), { value: { type: 'list', v: [Buffer.from('first'), Buffer.from('second')] } });
  db.set(k('tags'), { value: { type: 'set', v: new Map([[k('a'), Buffer.from('a')], [k('b'), Buffer.from('b')]]) } });
  db.set(k('scores'), { value: { type: 'zset', v: new Map([[k('ala'), { member: Buffer.from('ala'), score: 10 }], [k('ola'), { member: Buffer.from('ola'), score: 7.5 }]]) } });
  db.set(k('events'), { value: { type: 'stream', v: [{ id: [1n, 0n], fields: [Buffer.from('type'), Buffer.from('login')] }], last: [1n, 0n] } });
  server.setString(Buffer.from([0x62, 0x69, 0x6e, 0x00, 0xff]), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  addSlowlog(server, ['KEYS', '*'], 25_000);
}
process.stdout.write(`${JSON.stringify({ port: server.port, pid: process.pid })}\n`);
