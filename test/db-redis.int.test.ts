// Redis sessions of the DB Host (1.0.0) against the in-process RESP server: connecting (AUTH with a password or an ACL user,
// prompts, DB index, TLS modes), key browsing, every type read and written, binary values, big values in pages, the console
// (parsing, dangerous and refused commands, typed replies, read-only refusal, timeouts), pattern deletes, Pub/Sub with drops,
// reconnect reporting and a connection through the SSH tunnel.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dbSessionId, type DbErrorCode, type DbResult } from '../src/shared/db';
import type { DbOpenConfig } from '../src/shared/dbHostIpc';
import {
  parseRedisCommandLine, type RedisCommandResult, type RedisData, type RedisDbList, type RedisKeyInfo, type RedisOp, type RedisPatternCount,
  type RedisPubSubMessage, type RedisPubSubState, type RedisReadResult, type RedisScanPage, type RedisWriteResult,
} from '../src/shared/dbRedis';
import { dbHarness, waitFor } from './helpers/dbHarness';
import { addSlowlog, startRespServer, type RespServer, type RespServerOptions } from './helpers/respServer';
import { startTestServer, type TestServer } from './helpers/sshServer';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'pg-tls', name), 'utf8');
let servers: RespServer[] = [];
let sshServers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(sshServers.map((s) => s.close()));
  servers = []; sshServers = [];
});

async function server(opts: RespServerOptions = {}) { const s = await startRespServer(opts); servers.push(s); return s; }

function harness(opts: Parameters<typeof dbHarness>[0] = {}) {
  const h = dbHarness({ redisLimits: { scanBudgetMs: 5000 }, ...opts });
  const open = (s: RespServer, config: Partial<DbOpenConfig> = {}, wait = true) => h.open({ kind: 'redis', host: '127.0.0.1', port: s.port, user: '', database: '0', tls: 'disable', ...config }, dbSessionId(randomUUID()), wait);
  const r = <T>(id: string, req: RedisOp) => h.op<T>(id, { op: 'redis', req });
  const rv = async <T>(id: string, req: RedisOp): Promise<T> => {
    const res = await r<T>(id, req);
    if (!res.ok) throw new Error(`${req.kind} failed: ${res.error} ${res.server?.message ?? ''}`);
    return res.value;
  };
  const cmd = (id: string, line: string, extra: { readWrite?: boolean; confirmed?: boolean; timeoutMs?: number } = {}) => {
    const p = parseRedisCommandLine(line);
    if (!p.ok) throw new Error(line);
    return r<RedisCommandResult>(id, { kind: 'command', req: { argv: p.argv, ...extra } });
  };
  const write = (id: string, w: Extract<RedisOp, { kind: 'write' }>['write']) => r<RedisWriteResult>(id, { kind: 'write', write: w });
  return { ...h, openRedis: open, r, rv, cmd, write };
}

const errorOf = (res: DbResult<unknown>): DbErrorCode | undefined => (res.ok ? undefined : res.error);

describe('Redis: connecting', () => {
  it('connects directly, reports the version and the DB index, and closes', async () => {
    const s = await server({ version: '7.2.9' });
    const h = harness();
    const id = await h.openRedis(s, { database: '3' });
    expect(h.last(id)).toMatchObject({ phase: 'connected', serverVersion: '7.2.9', database: '3' });
    expect(h.statuses(id).map((x) => x.phase)).toEqual(['connecting', 'database', 'connected']);
    expect(s.log.some((l) => l.argv[0].toLowerCase() === 'select' && l.argv[1] === '3')).toBe(true);
    const list = await h.rv<RedisDbList>(id, { kind: 'databases' });
    expect(list).toMatchObject({ count: 16, current: 3, dbs: [] });
    h.host.close(id);
    expect(h.last(id)?.phase).toBe('closed');
    await waitFor(() => s.connections() === 0);
  });

  it('a password-only server: the saved password logs in; none asks; a wrong one asks again (retry) and can be cancelled', async () => {
    const s = await server({ password: 'sekret' });
    let h = harness();
    const ok = await h.openRedis(s, { password: 'sekret' });
    expect(h.last(ok)?.phase).toBe('connected');
    expect(s.log.find((l) => l.argv[0].toLowerCase() === 'auth')?.argv).toEqual(['auth', 'sekret']);

    const asked: boolean[] = [];
    h = harness({ onMain: (m, host) => {
      if (m.t !== 'dbPasswordPrompt') return false;
      asked.push(m.retry);
      void host.handle({ t: 'dbPasswordAnswer', id: m.id, promptId: m.promptId, value: asked.length === 1 ? 'wrong' : 'sekret' });
      return true;
    } });
    const prompted = await h.openRedis(s);
    expect(h.last(prompted)?.phase).toBe('connected');
    expect(asked).toEqual([false, true]);

    h = harness({ autoPassword: null });
    const cancelled = await h.openRedis(s, { password: 'bad' });
    expect(h.last(cancelled)).toMatchObject({ phase: 'error', error: 'cancelled' });
  });

  it('an ACL user is asked for the password before connecting and logs in with AUTH user password', async () => {
    const s = await server({ password: 'root', users: { alice: 'pw-a' } });
    const h = harness({ autoPassword: 'pw-a' });
    const id = await h.openRedis(s, { user: 'alice' });
    expect(h.last(id)?.phase).toBe('connected');
    expect(h.toMain.filter((m) => m.t === 'dbPasswordPrompt').map((m) => (m as { retry: boolean }).retry)).toEqual([false]);
    expect(s.log.find((l) => l.argv[0].toLowerCase() === 'auth')?.argv).toEqual(['auth', 'alice', 'pw-a']);
    const h2 = harness({ autoPassword: null });
    const wrong = await h2.openRedis(s, { user: 'alice', password: 'nope' });
    expect(h2.last(wrong)).toMatchObject({ phase: 'error', error: 'cancelled' });
    const h3 = harness();
    const bad = await h3.openRedis(s, { user: 'alice', password: 'nope' }, false);
    // No answer comes (no autoPassword): the prompt waits (retry: the saved one was refused); closing ends it.
    await waitFor(() => h3.toMain.some((m) => m.t === 'dbPasswordPrompt' && m.id === bad && m.retry), 5000);
    h3.host.close(bad);
    expect(h3.last(bad)?.phase).toBe('closed');
  });

  it('maps connect failures: refused, a missing DB index, TLS to a plain port', async () => {
    const s = await server({ databases: 4 });
    const h = harness();
    const noDb = await h.openRedis(s, { database: '9' });
    expect(h.last(noDb)).toMatchObject({ phase: 'error', error: 'dbNoDatabase' });
    expect(h.last(noDb)?.message).toMatch(/out of range/);
    const tls = await h.openRedis(s, { tls: 'require' });
    expect(h.last(tls)?.error).toMatch(/^(dbTls|dbClosed)$/);
    await s.close();
    const refused = await h.openRedis(s);
    expect(h.last(refused)).toMatchObject({ phase: 'error', error: 'dbRefused' });
  });

  it('TLS: require, verify-full with the CA (and a wrong CA refused), prefer falls back to plain', async () => {
    const secure = await server({ tls: { key: fixture('server.key'), cert: fixture('server.pem') } });
    const h = harness();
    const req = await h.openRedis(secure, { tls: 'require' });
    expect(h.last(req)?.phase).toBe('connected');
    const full = await h.openRedis(secure, { tls: 'verify-full', ca: fixture('ca.pem'), host: '127.0.0.1' });
    expect(h.last(full)?.phase).toBe('connected');
    const wrongCa = await h.openRedis(secure, { tls: 'verify-full', ca: fixture('other-ca.pem'), host: '127.0.0.1' });
    expect(h.last(wrongCa)).toMatchObject({ phase: 'error', error: 'dbTls' });
    const plain = await server();
    const pref = await h.openRedis(plain, { tls: 'prefer' });
    expect(h.last(pref)?.phase).toBe('connected');
    const pref2 = await h.openRedis(secure, { tls: 'prefer' });
    expect(h.last(pref2)?.phase).toBe('connected');
  });

  it('a dropped connection is reported as reconnecting and connected again; a server that stays away ends the session', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 'k', value: 'v' } });
    await h.rv(id, { kind: 'select', index: 2 });
    s.dropClients();
    await waitFor(() => h.statuses(id).some((x) => x.reconnect === 1), 5000);
    await waitFor(() => h.last(id)?.phase === 'connected', 5000);
    const phases = h.statuses(id).map((x) => `${x.phase}${x.reconnect ? `:${x.reconnect}` : ''}`);
    expect(phases.slice(-2)).toEqual(['database:1', 'connected']);
    // The DB index survives the reconnect.
    expect(h.last(id)?.database).toBe('2');
    const info = await h.rv<RedisCommandResult>(id, { kind: 'command', req: { argv: ['CLIENT', 'LIST'] } });
    expect(JSON.stringify(info.reply)).toContain('db=2');

    await s.stopListening();
    await waitFor(() => ['error', 'closed'].includes(h.last(id)?.phase ?? ''), 15000);
    expect(h.last(id)).toMatchObject({ phase: 'error', error: 'dbClosed' });
    expect(h.statuses(id).filter((x) => x.reconnect).map((x) => x.reconnect)).toEqual([1, 1, 2, 3]);
  }, 30000);
});

describe('Redis: keys', () => {
  it('scans with MATCH, TYPE and pages, with details (type, TTL, length, memory), dedupes, and lists DBs', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    for (let i = 0; i < 120; i++) await h.rv(id, { kind: 'write', write: { op: 'set', key: `user:${i}`, value: `v${i}` } });
    await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'user:h', field: 'f', value: 'x' } });
    await h.rv(id, { kind: 'write', write: { op: 'expire', key: 'user:1', ttlMs: 60_000 } });
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 'other', value: 'o' } });
    let cursor = '0';
    const seen: RedisData[] = [];
    let pages = 0;
    do {
      const page = await h.rv<RedisScanPage>(id, { kind: 'scan', req: { cursor, match: 'user:*', count: 25, limit: 40 } });
      seen.push(...page.keys.map((k) => k.key));
      cursor = page.cursor;
      pages++;
    } while (cursor !== '0');
    expect(seen).toHaveLength(121);
    expect(new Set(seen).size).toBe(121);
    expect(pages).toBeGreaterThan(1);
    const hashes = await h.rv<RedisScanPage>(id, { kind: 'scan', req: { cursor: '0', type: 'hash', count: 1000 } });
    expect(hashes).toEqual({ cursor: '0', keys: [{ key: 'user:h' }] });
    expect(s.log.some((l) => l.argv[0].toLowerCase() === 'scan' && l.argv.includes('TYPE'))).toBe(true);
    const detailed = await h.rv<RedisScanPage>(id, { kind: 'scan', req: { cursor: '0', match: 'user:1', details: true, count: 1000 } });
    expect(detailed.keys).toHaveLength(1);
    const k = detailed.keys[0];
    expect(k).toMatchObject({ key: 'user:1', type: 'string', length: 2 });
    expect(k.ttlMs).toBeGreaterThan(50_000);
    expect(k.memory).toBeGreaterThan(0);
    const info = await h.rv<RedisKeyInfo[]>(id, { kind: 'keyInfo', keys: ['user:h', 'gone'] });
    expect(info).toEqual([{ key: 'user:h', type: 'hash', ttlMs: null, length: 1, memory: expect.any(Number) }, { key: 'gone' }]);
    const dbs = await h.rv<RedisDbList>(id, { kind: 'databases' });
    expect(dbs.dbs).toEqual([{ index: 0, keys: 122, expires: 1, avgTtlMs: 0 }]);
    expect(await h.rv(id, { kind: 'select', index: 5 })).toBe(5);
    expect(h.toMain.filter((m) => m.t === 'dbDatabase')).toEqual([{ t: 'dbDatabase', id, database: '5' }]);
    expect((await h.rv<RedisScanPage>(id, { kind: 'scan', req: { cursor: '0' } })).keys).toEqual([]);
    expect(errorOf(await h.r(id, { kind: 'select', index: 99 }))).toBe('dbNoDatabase');
  });

  it('older servers: SCAN without TYPE filters by TYPE itself; no MEMORY USAGE or UNLINK is fine', async () => {
    const s = await server({ noScanType: true, noUnlink: true, deny: ['MEMORY USAGE', 'CONFIG GET'] });
    const h = harness();
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 'a', value: '1' } });
    await h.rv(id, { kind: 'write', write: { op: 'sadd', key: 'b', members: ['x'] } });
    const sets = await h.rv<RedisScanPage>(id, { kind: 'scan', req: { cursor: '0', type: 'set', details: true } });
    expect(sets.keys).toEqual([{ key: 'b', type: 'set', ttlMs: null, length: 1 }]);
    expect((await h.rv<RedisDbList>(id, { kind: 'databases' })).count).toBeNull();
    expect(await h.rv(id, { kind: 'write', write: { op: 'delete', keys: ['a', 'b', 'c'] } })).toEqual({ changed: 2 });
    expect(s.log.some((l) => l.argv[0].toLowerCase() === 'del')).toBe(true);
  });

  it('binary keys and values round-trip exactly', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    const key = { b64: Buffer.from([0x6b, 0x00, 0xff]).toString('base64') };
    const value = { b64: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]).toString('base64') };
    await h.rv(id, { kind: 'write', write: { op: 'set', key, value } });
    expect(s.dbs[0].get(Buffer.from([0x6b, 0x00, 0xff]).toString('latin1'))?.value).toEqual({ type: 'string', v: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]) });
    const page = await h.rv<RedisScanPage>(id, { kind: 'scan', req: { cursor: '0' } });
    expect(page.keys).toEqual([{ key }]);
    const read = await h.rv<RedisReadResult>(id, { kind: 'read', req: { type: 'string', key } });
    expect(read).toMatchObject({ type: 'string', length: 5, offset: 0, pageBytes: 5, value: { data: value, bytes: 5 } });
    await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: { b64: 'gA==' }, value: 'ż' } });
    const hash = await h.rv<RedisReadResult>(id, { kind: 'read', req: { type: 'hash', key: 'h', cursor: '0', count: 10 } });
    expect(hash).toMatchObject({ entries: [{ field: { b64: 'gA==' }, value: { data: 'ż', bytes: 2 } }] });
  });
});

describe('Redis: values', () => {
  it('strings: page through a big value without splitting UTF-8; TTL kept or cleared on SET', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    const big = 'ż'.repeat(1_500_000); // 3 MB
    s.setString('big', big);
    const first = await h.rv<RedisReadResult & { type: 'string' }>(id, { kind: 'read', req: { type: 'string', key: 'big', maxBytes: 1_000_001 } });
    expect(first.length).toBe(3_000_000);
    expect(first.pageBytes).toBe(1_000_000);
    expect(first.value).toMatchObject({ bytes: 3_000_000, truncated: true });
    expect(typeof first.value.data).toBe('string');
    let text = first.value.data as string;
    let offset = first.pageBytes;
    while (offset < first.length) {
      const next = await h.rv<RedisReadResult & { type: 'string' }>(id, { kind: 'read', req: { type: 'string', key: 'big', offset, maxBytes: 1_000_001 } });
      text += next.value.data as string;
      offset += next.pageBytes;
    }
    expect(text === big).toBe(true);
    const def = await h.rv<RedisReadResult & { type: 'string' }>(id, { kind: 'read', req: { type: 'string', key: 'big' } });
    expect(def.pageBytes).toBe(1024 * 1024 - 1024 * 1024 % 2);

    await h.rv(id, { kind: 'write', write: { op: 'set', key: 's', value: 'a', ttlMs: 100_000 } });
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 's', value: 'b' } });
    const kept = await h.rv<RedisReadResult>(id, { kind: 'read', req: { type: 'string', key: 's' } });
    expect(kept.ttlMs).toBeGreaterThan(90_000);
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 's', value: 'c', keepTtl: false } });
    expect((await h.rv<RedisReadResult>(id, { kind: 'read', req: { type: 'string', key: 's' } })).ttlMs).toBeNull();
    expect(errorOf(await h.r(id, { kind: 'read', req: { type: 'hash', key: 's', cursor: '0', count: 10 } }))).toBe('wrongType');
    expect(errorOf(await h.r(id, { kind: 'read', req: { type: 'string', key: 'missing' } }))).toBe('notFound');
  });

  it('hashes: HSCAN pages, big values cut and read whole, set/delete fields', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    for (let i = 0; i < 30; i++) await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: `f${i}`, value: `v${i}` } });
    await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: 'big', value: 'x'.repeat(100_000) } });
    const fields: string[] = [];
    let cursor = '0';
    do {
      const p = await h.rv<RedisReadResult & { type: 'hash' }>(id, { kind: 'read', req: { type: 'hash', key: 'h', cursor, count: 7 } });
      expect(p.length).toBe(31);
      for (const e of p.entries) {
        fields.push(e.field as string);
        if (e.field === 'big') expect(e.value).toMatchObject({ bytes: 100_000, truncated: true });
      }
      cursor = p.cursor;
    } while (cursor !== '0');
    expect(fields).toHaveLength(31);
    const whole = await h.rv<{ data: string; bytes: number }>(id, { kind: 'readItem', req: { type: 'hash', key: 'h', field: 'big' } });
    expect(whole.bytes).toBe(100_000);
    expect(whole.data.length).toBe(100_000);
    expect(await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: 'f1', value: 'new', onlyNew: true } })).toEqual({ changed: 0 });
    expect(await h.rv(id, { kind: 'write', write: { op: 'hdel', key: 'h', fields: ['f1', 'f2', 'nope'] } })).toEqual({ changed: 2 });
    expect(errorOf(await h.r(id, { kind: 'readItem', req: { type: 'hash', key: 'h', field: 'f1' } }))).toBe('notFound');
  });

  it('lists: pages, push, set (with the expected value), remove by value and by index', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'rpush', key: 'l', items: Array.from({ length: 25 }, (_, i) => `i${i}`) } });
    await h.rv(id, { kind: 'write', write: { op: 'lpush', key: 'l', items: ['head'] } });
    const p = await h.rv<RedisReadResult & { type: 'list' }>(id, { kind: 'read', req: { type: 'list', key: 'l', start: 20, count: 10 } });
    expect(p).toMatchObject({ length: 26, start: 20 });
    expect(p.items.map((x) => x.data)).toEqual(['i19', 'i20', 'i21', 'i22', 'i23', 'i24']);
    expect(await h.rv(id, { kind: 'write', write: { op: 'lset', key: 'l', index: 0, value: 'HEAD', expected: 'head' } })).toEqual({ changed: 1 });
    expect(errorOf(await h.r(id, { kind: 'write', write: { op: 'lset', key: 'l', index: 0, value: 'x', expected: 'head' } }))).toBe('conflict');
    expect(await h.rv(id, { kind: 'write', write: { op: 'ldel', key: 'l', index: 1, expected: 'i0' } })).toEqual({ changed: 1 });
    expect(errorOf(await h.r(id, { kind: 'write', write: { op: 'ldel', key: 'l', index: 1, expected: 'i0' } }))).toBe('conflict');
    expect(await h.rv(id, { kind: 'write', write: { op: 'lrem', key: 'l', count: 0, value: 'i5' } })).toEqual({ changed: 1 });
    const all = await h.rv<RedisReadResult & { type: 'list' }>(id, { kind: 'read', req: { type: 'list', key: 'l', start: 0, count: 5 } });
    expect(all.items.map((x) => x.data)).toEqual(['HEAD', 'i1', 'i2', 'i3', 'i4']);
    expect(all.length).toBe(24);
    expect((await h.rv<{ data: string }>(id, { kind: 'readItem', req: { type: 'list', key: 'l', index: 0 } })).data).toBe('HEAD');
  });

  it('sets and sorted sets: scans, rank pages (also reversed), add, remove, scores', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'sadd', key: 's', members: ['a', 'b', 'c'] } });
    expect(await h.rv(id, { kind: 'write', write: { op: 'srem', key: 's', members: ['b'] } })).toEqual({ changed: 1 });
    const set = await h.rv<RedisReadResult & { type: 'set' }>(id, { kind: 'read', req: { type: 'set', key: 's', cursor: '0', count: 100 } });
    expect(set).toMatchObject({ length: 2, cursor: '0', members: ['a', 'c'] });
    await h.rv(id, { kind: 'write', write: { op: 'zadd', key: 'z', entries: [['one', '1'], ['two', '2'], ['half', '0.5'], ['big', '1e3']] } });
    expect(await h.rv(id, { kind: 'write', write: { op: 'zadd', key: 'z', entries: [['two', '20'], ['new', '9']], mode: 'xx' } })).toEqual({ changed: 1 });
    expect(await h.rv(id, { kind: 'write', write: { op: 'zincrby', key: 'z', member: 'one', by: '0.25' } })).toEqual({ changed: 1 });
    const ranked = await h.rv<RedisReadResult & { type: 'zset' }>(id, { kind: 'read', req: { type: 'zset', key: 'z', start: 0, count: 10 } });
    expect(ranked.entries).toEqual([{ member: 'half', score: '0.5' }, { member: 'one', score: '1.25' }, { member: 'two', score: '20' }, { member: 'big', score: '1000' }]);
    const rev = await h.rv<RedisReadResult & { type: 'zset' }>(id, { kind: 'read', req: { type: 'zset', key: 'z', start: 1, count: 2, rev: true } });
    expect(rev.entries.map((e) => e.member)).toEqual(['two', 'one']);
    const scanned = await h.rv<RedisReadResult & { type: 'zset' }>(id, { kind: 'read', req: { type: 'zset', key: 'z', cursor: '0', count: 100, match: 't*' } });
    expect(scanned).toMatchObject({ cursor: '0', entries: [{ member: 'two', score: '20' }] });
    expect(await h.rv(id, { kind: 'write', write: { op: 'zrem', key: 'z', members: ['big'] } })).toEqual({ changed: 1 });
  });

  it('streams: add (with MAXLEN), page forward and backward, delete, trim, read a field', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    for (let i = 1; i <= 12; i++) await h.rv(id, { kind: 'write', write: { op: 'xadd', key: 'st', id: `${i}-0`, fields: [['n', String(i)], ['bin', { b64: 'AP8=' }]] } });
    const auto = await h.rv<RedisWriteResult>(id, { kind: 'write', write: { op: 'xadd', key: 'st', fields: [['n', 'auto']] } });
    expect(auto.id).toMatch(/^\d+-\d+$/);
    let start = '-';
    const ids: string[] = [];
    for (;;) {
      const p = await h.rv<RedisReadResult & { type: 'stream' }>(id, { kind: 'read', req: { type: 'stream', key: 'st', start, end: '+', count: 5 } });
      ids.push(...p.entries.map((e) => e.id));
      if (!p.next) break;
      start = p.next;
    }
    expect(ids).toHaveLength(13);
    expect(ids.slice(0, 3)).toEqual(['1-0', '2-0', '3-0']);
    const back = await h.rv<RedisReadResult & { type: 'stream' }>(id, { kind: 'read', req: { type: 'stream', key: 'st', start: '12-0', end: '-', count: 3, rev: true } });
    expect(back.entries.map((e) => e.id)).toEqual(['12-0', '11-0', '10-0']);
    expect(back.next).toBe('9-18446744073709551615');
    expect(back.entries[0].fields).toEqual([{ field: 'n', value: { data: '12', bytes: 2 } }, { field: 'bin', value: { data: { b64: 'AP8=' }, bytes: 2 } }]);
    expect(await h.rv(id, { kind: 'write', write: { op: 'xdel', key: 'st', ids: ['1-0', '99-0'] } })).toEqual({ changed: 1 });
    expect(await h.rv(id, { kind: 'write', write: { op: 'xtrim', key: 'st', strategy: 'maxlen', threshold: '5' } })).toEqual({ changed: 7 });
    expect((await h.rv<{ data: string }>(id, { kind: 'readItem', req: { type: 'stream', key: 'st', id: '12-0', field: 'n' } })).data).toBe('12');
    await h.rv(id, { kind: 'write', write: { op: 'xadd', key: 'st', fields: [['n', 'x']], maxLen: 2, approx: true } });
    expect((await h.rv<RedisReadResult>(id, { kind: 'read', req: { type: 'stream', key: 'st', start: '-', end: '+', count: 10 } })).length).toBe(2);
  });

  it('rename refuses an existing name unless overwriting; expire/persist; new keys of every type; deletes', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 'a', value: '1' } });
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 'b', value: '2' } });
    expect(errorOf(await h.write(id, { op: 'rename', key: 'a', newKey: 'b' }))).toBe('keyExists');
    expect(s.log.filter((l) => l.argv[0].toLowerCase().startsWith('rename')).map((l) => l.argv[0].toLowerCase())).toEqual(['renamenx']);
    expect(await h.rv(id, { kind: 'write', write: { op: 'rename', key: 'a', newKey: 'b', overwrite: true } })).toEqual({ changed: 1 });
    expect(errorOf(await h.write(id, { op: 'rename', key: 'a', newKey: 'c' }))).toBe('notFound');
    expect(await h.rv(id, { kind: 'write', write: { op: 'expire', key: 'b', ttlMs: 5000 } })).toEqual({ changed: 1 });
    expect(errorOf(await h.write(id, { op: 'expire', key: 'zzz', ttlMs: 5000 }))).toBe('notFound');
    expect(await h.rv(id, { kind: 'write', write: { op: 'persist', key: 'b' } })).toEqual({ changed: 1 });
    const creates = [
      { type: 'string', value: 'x' }, { type: 'hash', entries: [['f', 'v']] }, { type: 'list', items: ['1', '2'] },
      { type: 'set', members: ['m'] }, { type: 'zset', entries: [['m', '1']] }, { type: 'stream', fields: [['f', 'v']] },
    ] as const;
    for (const v of creates) {
      const r = await h.write(id, { op: 'create', key: `new:${v.type}`, value: v as never, ttlMs: 60_000 });
      expect(r.ok, v.type).toBe(true);
      const info = await h.rv<RedisKeyInfo[]>(id, { kind: 'keyInfo', keys: [`new:${v.type}`] });
      expect(info[0].type).toBe(v.type);
      expect(info[0].ttlMs).toBeGreaterThan(0);
    }
    expect(errorOf(await h.write(id, { op: 'create', key: 'new:string', value: { type: 'string', value: 'again' } }))).toBe('keyExists');
    expect(await h.rv(id, { kind: 'write', write: { op: 'delete', keys: ['new:string', 'new:hash', 'none'] } })).toEqual({ changed: 2 });
    expect(s.log.some((l) => l.argv[0].toLowerCase() === 'unlink')).toBe(true);
  });

  it('pattern deletes: count first (token), then UNLINK in batches; a token is used once', async () => {
    const s = await server();
    const h = harness({ redisLimits: { deleteBatch: 50, scanBudgetMs: 5000 } });
    const id = await h.openRedis(s);
    for (let i = 0; i < 230; i++) s.setString(`tmp:${i}`, 'x');
    s.setString('keep', 'x');
    const counted = await h.rv<RedisPatternCount>(id, { kind: 'countPattern', match: 'tmp:*' });
    expect(counted).toMatchObject({ count: 230, complete: true });
    expect(errorOf(await h.r(id, { kind: 'deletePattern', token: '00000000-0000-4000-8000-000000000000' }))).toBe('staleToken');
    const before = s.log.length;
    expect(await h.rv(id, { kind: 'deletePattern', token: counted.token })).toEqual({ deleted: 230, cancelled: false, more: false });
    const unlinks = s.log.slice(before).filter((l) => l.argv[0].toLowerCase() === 'unlink');
    expect(unlinks.every((l) => l.argv.length - 1 <= 50)).toBe(true);
    expect(s.dbs[0].size).toBe(1);
    expect(errorOf(await h.r(id, { kind: 'deletePattern', token: counted.token }))).toBe('staleToken');
  });
});

describe('Redis: console', () => {
  it('runs commands with typed replies and keeps integers exact', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    const reply = async (line: string) => { const r = await h.cmd(id, line); if (!r.ok) throw new Error(r.error); return r.value.reply; };
    expect(await reply('SET greeting "hello world"')).toEqual({ t: 'simple', v: 'OK' });
    expect(await reply('GET greeting')).toEqual({ t: 'bulk', v: 'hello world', bytes: 11 });
    expect(await reply('GET nothing')).toEqual({ t: 'null' });
    expect(await reply('RPUSH l a b')).toEqual({ t: 'integer', v: '2' });
    expect(await reply('LRANGE l 0 -1')).toEqual({ t: 'array', items: [{ t: 'bulk', v: 'a', bytes: 1 }, { t: 'bulk', v: 'b', bytes: 1 }], length: 2 });
    expect(await reply('HSET greeting f v')).toMatchObject({ t: 'error', v: expect.stringMatching(/^WRONGTYPE/) });
    expect(await reply('NOSUCHCMD x')).toMatchObject({ t: 'error', v: expect.stringMatching(/unknown command/) });
    expect(await reply('TYPE l')).toEqual({ t: 'simple', v: 'list' });
    expect(await reply('PING')).toEqual({ t: 'simple', v: 'PONG' });
    expect(await reply('SET k "\\x00\\xff"')).toEqual({ t: 'simple', v: 'OK' });
    expect(await reply('GET k')).toEqual({ t: 'bulk', v: { b64: 'AP8=' }, bytes: 2 });
    expect(await reply('PEXPIRE k 9007199254740993')).toEqual({ t: 'integer', v: '1' });
    expect(await reply('PTTL k')).toMatchObject({ t: 'integer' });
    const sel = await h.cmd(id, 'SELECT 4');
    expect(sel.ok && sel.value).toMatchObject({ reply: { t: 'simple', v: 'OK' }, db: 4 });
    expect(h.toMain.some((m) => m.t === 'dbDatabase' && m.database === '4')).toBe(true);
    expect(await reply('SELECT 99')).toMatchObject({ t: 'error' });
    const big = await h.cmd(id, 'SET big ' + 'x'.repeat(10));
    expect(big.ok).toBe(true);
  });

  it('caps big replies: arrays by node count, bulk strings by bytes', async () => {
    const s = await server();
    const h = harness({ redisLimits: { replyNodes: 50, replyBulkBytes: 8, scanBudgetMs: 5000 } });
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'rpush', key: 'l', items: Array.from({ length: 200 }, (_, i) => String(i)) } });
    const r = await h.cmd(id, 'LRANGE l 0 -1');
    if (!r.ok || r.value.reply.t !== 'array') throw new Error('array');
    expect(r.value.reply.length).toBe(200);
    expect(r.value.reply.items.length).toBeLessThan(50);
    s.setString('s', '0123456789abcdef');
    const b = await h.cmd(id, 'GET s');
    expect(b.ok && b.value.reply).toEqual({ t: 'bulk', v: '01234567', bytes: 16, truncated: true });
  });

  it('dangerous commands need confirmation; blocking, subscribe, transaction and connection commands are refused', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    s.setString('k', 'v');
    expect(errorOf(await h.cmd(id, 'FLUSHALL'))).toBe('needsConfirm');
    expect(errorOf(await h.cmd(id, 'KEYS *'))).toBe('needsConfirm');
    expect(errorOf(await h.cmd(id, 'CONFIG SET maxmemory 1'))).toBe('needsConfirm');
    expect(s.log.some((l) => ['flushall', 'keys', 'config'].includes(l.argv[0].toLowerCase()))).toBe(false);
    const keys = await h.cmd(id, 'KEYS *', { confirmed: true });
    expect(keys.ok && keys.value.reply).toEqual({ t: 'array', items: [{ t: 'bulk', v: 'k', bytes: 1 }], length: 1 });
    expect(errorOf(await h.cmd(id, 'BLPOP l 0'))).toBe('blockingCommand');
    expect(errorOf(await h.cmd(id, 'MONITOR'))).toBe('blockingCommand');
    expect(errorOf(await h.cmd(id, 'XREAD BLOCK 0 STREAMS s $'))).toBe('blockingCommand');
    expect(errorOf(await h.cmd(id, 'SUBSCRIBE news'))).toBe('subscribeCommand');
    expect(errorOf(await h.cmd(id, 'MULTI'))).toBe('consoleUnsupported');
    expect(errorOf(await h.cmd(id, 'AUTH x'))).toBe('consoleUnsupported');
    expect(errorOf(await h.cmd(id, 'QUIT'))).toBe('consoleUnsupported');
    // The connection still works normally afterwards.
    const get = await h.cmd(id, 'GET k');
    expect(get.ok && get.value.reply).toEqual({ t: 'bulk', v: 'v', bytes: 1 });
  });

  it('a slow command times out without breaking the session', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    expect(errorOf(await h.cmd(id, 'DEBUG SLEEP 1', { confirmed: true, timeoutMs: 100 }))).toBe('statementTimeout');
    await new Promise((r) => setTimeout(r, 1100));
    const ping = await h.cmd(id, 'PING');
    expect(ping.ok && ping.value.reply).toEqual({ t: 'simple', v: 'PONG' });
  });

  it('server views: INFO sections, SLOWLOG GET, CLIENT LIST', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    addSlowlog(s, ['SET', 'k', 'v'], 15_000);
    const info = await h.rv<Array<{ name: string; entries: Array<[string, string]> }>>(id, { kind: 'info', section: 'server' });
    expect(info[0].name).toBe('Server');
    expect(info[0].entries).toContainEqual(['redis_version', '7.2.4']);
    const all = await h.rv<Array<{ name: string }>>(id, { kind: 'info' });
    expect(all.map((x) => x.name)).toContain('Keyspace');
    expect(await h.rv(id, { kind: 'slowlog', count: 10 })).toEqual([{ id: 0, time: expect.any(Number), durationUs: 15_000, args: ['SET', 'k', 'v'], client: '127.0.0.1:50000' }]);
    const clients = await h.rv<Array<Record<string, string>>>(id, { kind: 'clients' });
    expect(clients.some((c) => c.name === 'unimux')).toBe(true);
  });
});

describe('Redis: read-only connections', () => {
  it('refuse every write (structured writes, write commands, unknown commands, PUBLISH) unless overridden for one command', async () => {
    const s = await server();
    s.setString('k', 'v');
    const h = harness();
    const id = await h.openRedis(s, { readOnly: true });
    expect(errorOf(await h.write(id, { op: 'set', key: 'k', value: 'x' }))).toBe('readOnly');
    expect(errorOf(await h.r(id, { kind: 'countPattern', match: '*' }))).toBeUndefined();
    expect(errorOf(await h.cmd(id, 'SET k x'))).toBe('readOnly');
    expect(errorOf(await h.cmd(id, 'DEL k'))).toBe('readOnly');
    expect(errorOf(await h.cmd(id, 'EVAL "return 1" 0'))).toBe('readOnly');
    expect(errorOf(await h.cmd(id, 'NOSUCH k'))).toBe('readOnly');
    expect(errorOf(await h.cmd(id, 'FLUSHDB', { confirmed: true }))).toBe('readOnly');
    expect(errorOf(await h.cmd(id, 'CONFIG SET a b', { confirmed: true }))).toBe('readOnly');
    expect(errorOf(await h.r(id, { kind: 'publish', channel: 'c', message: 'm' }))).toBe('readOnly');
    expect(s.log.some((l) => ['set', 'del', 'eval', 'nosuch', 'flushdb', 'publish'].includes(l.argv[0].toLowerCase()))).toBe(false);
    for (const line of ['GET k', 'TTL k', 'CONFIG GET databases', 'CLIENT LIST', 'INFO keyspace', 'SCAN 0']) {
      expect((await h.cmd(id, line)).ok, line).toBe(true);
    }
    const forced = await h.cmd(id, 'SET k forced', { readWrite: true });
    expect(forced.ok).toBe(true);
    expect(s.dbs[0].get('k')?.value).toEqual({ type: 'string', v: Buffer.from('forced') });
    expect((await h.r(id, { kind: 'publish', channel: 'c', message: 'm', readWrite: true })).ok).toBe(true);
  });

  it('without COMMAND INFO (ACL) only known read commands run', async () => {
    const s = await server({ deny: ['COMMAND INFO'] });
    const h = harness();
    const id = await h.openRedis(s, { readOnly: true });
    expect((await h.cmd(id, 'GET k')).ok).toBe(true);
    expect((await h.cmd(id, 'HGETALL k')).ok).toBe(true);
    expect(errorOf(await h.cmd(id, 'SETNX k v'))).toBe('readOnly');
    expect(errorOf(await h.cmd(id, 'OBJECT FREQ k'))).toBe('readOnly');
  });
});

describe('Redis: Pub/Sub', () => {
  type PortMsg = { t: string; sessionId?: string; messages?: RedisPubSubMessage[]; dropped?: number; state?: RedisPubSubState };
  const received = (h: ReturnType<typeof harness>, id: string) => (h.port as unknown as PortMsg[]).filter((m) => m.t === 'redisPubSub' && m.sessionId === id).flatMap((m) => m.messages!);

  it('subscribes channels and patterns on its own connection, streams binary-safe messages with time, publishes, unsubscribes', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    const st = await h.rv<RedisPubSubState>(id, { kind: 'subscribe', channels: ['news', { b64: 'AP8=' }], patterns: ['ev:*'] });
    expect(st).toMatchObject({ state: 'ready', channels: ['news', { b64: 'AP8=' }], patterns: ['ev:*'], dropped: 0 });
    expect(s.connections()).toBe(2);
    expect(await h.rv(id, { kind: 'publish', channel: 'news', message: 'hello' })).toBe(1);
    await h.rv(id, { kind: 'publish', channel: 'ev:1', message: { b64: '3q2+7w==' } });
    await h.rv(id, { kind: 'publish', channel: { b64: 'AP8=' }, message: 'bin channel' });
    await h.rv(id, { kind: 'publish', channel: 'other', message: 'nobody' });
    await waitFor(() => received(h, id).length === 3);
    const got = received(h, id);
    expect(got.map((m) => ({ channel: m.channel, pattern: m.pattern, payload: m.payload }))).toEqual([
      { channel: 'news', pattern: undefined, payload: { data: 'hello', bytes: 5 } },
      { channel: 'ev:1', pattern: 'ev:*', payload: { data: { b64: '3q2+7w==' }, bytes: 4 } },
      { channel: { b64: 'AP8=' }, pattern: undefined, payload: { data: 'bin channel', bytes: 11 } },
    ]);
    expect(got[0].time).toBeGreaterThan(Date.now() - 10_000);
    // The main connection keeps working while subscribed.
    expect((await h.cmd(id, 'PING')).ok).toBe(true);
    const after = await h.rv<RedisPubSubState>(id, { kind: 'unsubscribe', channels: ['news'] });
    expect(after.channels).toEqual([{ b64: 'AP8=' }]);
    const none = await h.rv<RedisPubSubState>(id, { kind: 'unsubscribe', all: true });
    expect(none).toMatchObject({ state: 'idle', channels: [], patterns: [] });
    // Left: the main connection and the console's own one (the PING above).
    await waitFor(() => s.connections() === 2);
    expect((h.port as unknown as PortMsg[]).some((m) => m.t === 'redisPubSubState' && m.sessionId === id && m.state?.state === 'idle')).toBe(true);
  });

  it('caps the buffered messages and reports the drops; big payloads arrive cut', async () => {
    const s = await server();
    const h = harness({ redisLimits: { pubsubBuffer: 20, pubsubBatch: 5, pubsubFlushMs: 200, pubsubPayloadBytes: 4, scanBudgetMs: 5000 } });
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'subscribe', channels: ['flood'] });
    await Promise.all(Array.from({ length: 60 }, (_, i) => h.r(id, { kind: 'publish', channel: 'flood', message: `message ${i}` })));
    await waitFor(() => ((h.port as unknown as PortMsg[]).filter((m) => m.t === 'redisPubSub').reduce((n, m) => n + m.messages!.length + m.dropped!, 0)) === 60, 10_000);
    const batches = (h.port as unknown as PortMsg[]).filter((m) => m.t === 'redisPubSub');
    const delivered = batches.reduce((n, m) => n + m.messages!.length, 0);
    const dropped = batches.reduce((n, m) => n + m.dropped!, 0);
    expect(delivered).toBe(20);
    expect(dropped).toBe(40);
    expect(batches.every((b) => b.messages!.length <= 5)).toBe(true);
    expect(batches[0].messages![0].payload).toEqual({ data: 'mess', bytes: 9, truncated: true });
    expect((await h.rv<RedisPubSubState>(id, { kind: 'pubsubState' })).dropped).toBe(40);
  });

  it('the subscriber reconnects (reported) and resubscribes; closing the session closes it', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'subscribe', channels: ['c'] });
    s.dropClients();
    await waitFor(() => (h.port as unknown as PortMsg[]).some((m) => m.t === 'redisPubSubState' && m.state?.reconnect === 1), 5000);
    await waitFor(() => h.last(id)?.phase === 'connected' && s.connections() === 2 && s.log.filter((l) => l.argv[0].toLowerCase() === 'subscribe').length === 2, 5000);
    await waitFor(() => (h.port as unknown as PortMsg[]).filter((m) => m.t === 'redisPubSubState').at(-1)?.state?.state === 'ready', 5000);
    await h.rv(id, { kind: 'publish', channel: 'c', message: 'again' });
    await waitFor(() => received(h, id).length === 1);
    h.host.close(id);
    await waitFor(() => s.connections() === 0);
  }, 20000);
});

describe('Redis: through the SSH tunnel', () => {
  it('connects through the tunnel (every connection announced), runs commands and Pub/Sub, reports a refused forward as "tunnel"', async () => {
    const s = await server({ password: 'r-pw' });
    const ssh = await startTestServer({ password: 'pw' });
    sshServers.push(ssh);
    const h = harness({ onMain: (m, host) => {
      if (m.t === 'sshAuthPrompt') { void host.handle({ t: 'sshAuthAnswer', id: m.id, promptId: m.promptId, values: ['pw'] }); return true; }
      return false;
    } });
    const sid = await h.openRedis(s, { ssh: { dbHost: '127.0.0.1', dbPort: s.port, tunnelKey: 'redis-tunnel-1', owner: true }, host: 'ignored.example', port: 1, password: 'r-pw' }, false);
    await h.host.handle({ t: 'sshConnect', req: { id: sid, host: '127.0.0.1', port: ssh.port, username: 'alice', cols: 80, rows: 24, allowPasswordPrompt: true } });
    await waitFor(() => ['connected', 'error'].includes(h.last(sid)?.phase ?? ''), 15000);
    expect(h.last(sid)?.phase).toBe('connected');
    expect(ssh.forwards).toEqual([{ host: '127.0.0.1', port: s.port, accepted: true }]);
    await h.rv(sid, { kind: 'write', write: { op: 'set', key: 'through', value: 'ssh' } });
    const got = await h.cmd(sid, 'GET through');
    expect(got.ok && got.value.reply).toEqual({ t: 'bulk', v: 'ssh', bytes: 3 });
    await h.rv(sid, { kind: 'subscribe', channels: ['t'] });
    // Main, console (the GET) and subscriber: each its own forwarded channel.
    expect(ssh.forwards).toHaveLength(3);
    expect(h.last(sid)?.tls).toBe(false);
    // A second session of the same connection rides the same tunnel (no second login) and survives a dropped connection.
    const second = await h.openRedis(s, { ssh: { dbHost: '127.0.0.1', dbPort: s.port, tunnelKey: 'redis-tunnel-1', owner: false }, password: 'r-pw' });
    expect(h.last(second)?.phase).toBe('connected');
    expect(h.host.tunnelCount()).toBe(1);
    s.dropClients();
    await waitFor(() => h.statuses(second).some((x) => x.reconnect === 1) && h.last(second)?.phase === 'connected', 10000);
    const again = await h.cmd(second, 'GET through');
    expect(again.ok && again.value.reply).toEqual({ t: 'bulk', v: 'ssh', bytes: 3 });
    h.host.close(second);
    h.host.close(sid);
    await waitFor(() => h.host.tunnelCount() === 0);

    const s2 = await server();
    const port = s2.port;
    await s2.close();
    const h2 = harness({ onMain: (m, host) => {
      if (m.t === 'sshAuthPrompt') { void host.handle({ t: 'sshAuthAnswer', id: m.id, promptId: m.promptId, values: ['pw'] }); return true; }
      return false;
    } });
    const sid2 = await h2.openRedis(s2, { ssh: { dbHost: '127.0.0.1', dbPort: port, tunnelKey: 'redis-tunnel-2', owner: true } }, false);
    await h2.host.handle({ t: 'sshConnect', req: { id: sid2, host: '127.0.0.1', port: ssh.port, username: 'alice', cols: 80, rows: 24, allowPasswordPrompt: true } });
    await waitFor(() => ['connected', 'error'].includes(h2.last(sid2)?.phase ?? ''), 15000);
    expect(h2.last(sid2)).toMatchObject({ phase: 'error', error: 'tunnel' });
  }, 30000);
});
