// Redis backend fix round 1 (1.0.0): data safety at the edges against the in-process RESP server. Pattern deletes bounded by the
// confirmed count with an expiring token, SET never replaces another type, deadlines (a write main gave up on never runs),
// size checks before big console reads, byte-budgeted pages, Pub/Sub that keeps its names across a new connection, the
// console's own connection, strict read-only on old servers, renamed dangerous commands, cancel generations, deduplication,
// `existing` edits, no password in any message, per-operation timeouts with a reported reconnect.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { dbSessionId, type DbErrorCode, type DbResult } from '../src/shared/db';
import type { DbOpenConfig } from '../src/shared/dbHostIpc';
import {
  parseRedisCommandLine, type RedisCommandResult, type RedisOp, type RedisPatternCount, type RedisPatternDelete, type RedisPubSubMessage,
  type RedisPubSubState, type RedisReadResult,
} from '../src/shared/dbRedis';
import type { RedisLimits } from '../src/dbhost/redisSession';
import { dbHarness, waitFor } from './helpers/dbHarness';
import { startRespServer, type RespServer, type RespServerOptions } from './helpers/respServer';

let servers: RespServer[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => s.close())); servers = []; });
async function server(opts: RespServerOptions = {}) { const s = await startRespServer(opts); servers.push(s); return s; }

function harness(limits: Partial<RedisLimits> = {}, opts: Parameters<typeof dbHarness>[0] = {}) {
  const h = dbHarness({ ...opts, redisLimits: { scanBudgetMs: 5000, ...limits } });
  const open = (s: RespServer, config: Partial<DbOpenConfig> = {}, wait = true) => h.open({ kind: 'redis', host: '127.0.0.1', port: s.port, user: '', database: '0', tls: 'disable', ...config }, dbSessionId(randomUUID()), wait);
  const r = <T>(id: string, req: RedisOp, deadline?: number) => h.op<T>(id, { op: 'redis', req, ...(deadline !== undefined ? { deadline } : {}) });
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
  /** Starts an operation without waiting for its answer (the answer lands in h.toMain). */
  const start = (id: string, req: RedisOp) => { void r(id, req); };
  return { ...h, openRedis: open, r, rv, cmd, start };
}
const errorOf = (res: DbResult<unknown>): DbErrorCode | undefined => (res.ok ? undefined : res.error);
const ops = (s: RespServer, name: string) => s.log.filter((l) => l.argv[0].toLowerCase() === name);

describe('pattern deletes', () => {
  it('stop near the confirmed count and answer more when keys appeared meanwhile; tokens expire', async () => {
    const s = await server();
    const h = harness({ deleteBatch: 50 });
    const id = await h.openRedis(s);
    for (let i = 0; i < 200; i++) s.setString(`sess:${i}`, 'x');
    const counted = await h.rv<RedisPatternCount>(id, { kind: 'countPattern', match: 'sess:*' });
    expect(counted.count).toBe(200);
    // A busy namespace: 500 more keys arrive before the user confirms.
    for (let i = 200; i < 700; i++) s.setString(`sess:${i}`, 'x');
    const del = await h.rv<RedisPatternDelete>(id, { kind: 'deletePattern', token: counted.token });
    expect(del).toEqual({ deleted: 300, cancelled: false, more: true });
    expect([...s.dbs[0].keys()].filter((k) => k.startsWith('sess:'))).toHaveLength(400);

    const h2 = harness({ tokenTtlMs: 50 });
    const id2 = await h2.openRedis(s);
    const c2 = await h2.rv<RedisPatternCount>(id2, { kind: 'countPattern', match: 'sess:*' });
    await new Promise((r) => setTimeout(r, 120));
    expect(errorOf(await h2.r(id2, { kind: 'deletePattern', token: c2.token }))).toBe('staleToken');
    expect([...s.dbs[0].keys()].filter((k) => k.startsWith('sess:'))).toHaveLength(400);
  });

  it('delete over several SCAN pages, counts deduplicated (repeated keys), cancel mid-way and cancel while still queued', async () => {
    const s = await server({ scanRepeat: true });
    const h = harness({ deleteBatch: 100 });
    const id = await h.openRedis(s);
    for (let i = 0; i < 2500; i++) s.setString(`k:${i}`, 'x');
    const counted = await h.rv<RedisPatternCount>(id, { kind: 'countPattern', match: 'k:*' });
    expect(counted).toMatchObject({ count: 2500, complete: true });
    expect(ops(s, 'scan').length).toBeGreaterThan(2);
    expect(await h.rv(id, { kind: 'deletePattern', token: counted.token })).toEqual({ deleted: 2500, cancelled: false, more: false });

    for (let i = 0; i < 1000; i++) s.setString(`m:${i}`, 'x');
    const c2 = await h.rv<RedisPatternCount>(id, { kind: 'countPattern', match: 'm:*' });
    s.commandDelays.UNLINK = 150;
    const before = ops(s, 'unlink').length;
    const pending = h.r<RedisPatternDelete>(id, { kind: 'deletePattern', token: c2.token });
    await waitFor(() => ops(s, 'unlink').length > before);
    expect(await h.rv(id, { kind: 'cancel' })).toBe(true);
    const mid = await pending;
    if (!mid.ok) throw new Error(mid.error);
    expect(mid.value.cancelled).toBe(true);
    expect(mid.value.deleted).toBeGreaterThanOrEqual(100);
    expect(mid.value.deleted).toBeLessThan(1000);
    delete s.commandDelays.UNLINK;

    // Cancelled while it still waits behind a slow console command: it never deletes anything.
    const c3 = await h.rv<RedisPatternCount>(id, { kind: 'countPattern', match: 'm:*' });
    const left = c3.count;
    const sleep = h.cmd(id, 'DEBUG SLEEP 0.4', { confirmed: true });
    const queued = h.r<RedisPatternDelete>(id, { kind: 'deletePattern', token: c3.token });
    await new Promise((r) => setTimeout(r, 50));
    await h.rv(id, { kind: 'cancel' });
    await sleep;
    expect(await queued).toEqual({ ok: true, value: { deleted: 0, cancelled: true, more: true } });
    expect([...s.dbs[0].keys()].filter((k) => k.startsWith('m:'))).toHaveLength(left);
    // A cancel only stops what was queued before it.
    const c4 = await h.rv<RedisPatternCount>(id, { kind: 'countPattern', match: 'm:*' });
    expect(await h.rv(id, { kind: 'deletePattern', token: c4.token })).toMatchObject({ deleted: left, cancelled: false });
  }, 30000);
});

describe('writes', () => {
  it('SET never replaces another type; KEEPTTL fallback reads the TTL under WATCH', async () => {
    const s = await server({ noKeepTtl: true });
    const h = harness();
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: 'f', value: 'v' } });
    expect(errorOf(await h.r(id, { kind: 'write', write: { op: 'set', key: 'h', value: 'oops' } }))).toBe('wrongType');
    expect(s.dbs[0].get('h')?.value.type).toBe('hash');
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 's', value: 'a', ttlMs: 100_000 } });
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 's', value: 'b' } });
    await h.rv(id, { kind: 'write', write: { op: 'set', key: 's', value: 'c' } });
    const read = await h.rv<RedisReadResult & { type: 'string' }>(id, { kind: 'read', req: { type: 'string', key: 's' } });
    expect(read.value.data).toBe('c');
    expect(read.ttlMs).toBeGreaterThan(90_000);
    const watchThenPttl = s.log.map((l) => l.argv[0].toLowerCase()).join(' ');
    expect(watchThenPttl).toContain('watch type pttl multi set pexpire exec');
  });

  it('`existing` edits answer notFound for a vanished key and wrongType for another type, creating nothing', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    for (const w of [
      { op: 'hset', key: 'gone', field: 'f', value: 'v', existing: true }, { op: 'rpush', key: 'gone', items: ['x'], existing: true },
      { op: 'sadd', key: 'gone', members: ['x'], existing: true }, { op: 'zadd', key: 'gone', entries: [['m', '1']], existing: true },
      { op: 'zincrby', key: 'gone', member: 'm', by: '1', existing: true }, { op: 'xadd', key: 'gone', fields: [['f', 'v']], existing: true },
    ] as const) {
      expect(errorOf(await h.r(id, { kind: 'write', write: w as never })), w.op).toBe('notFound');
    }
    expect(s.dbs[0].has('gone')).toBe(false);
    s.setString('str', 'x');
    expect(errorOf(await h.r(id, { kind: 'write', write: { op: 'lpush', key: 'str', items: ['y'], existing: true } }))).toBe('wrongType');
    await h.rv(id, { kind: 'write', write: { op: 'rpush', key: 'l', items: ['a'] } });
    expect(await h.rv(id, { kind: 'write', write: { op: 'rpush', key: 'l', items: ['b'], existing: true } })).toEqual({ changed: 2 });
  });
});

describe('deadlines and timeouts', () => {
  it('an operation that would start after main gave up is skipped; the retry runs once', async () => {
    const s = await server({ commandDelays: { HLEN: 400 } });
    const h = harness();
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: 'f', value: 'v' } });
    const slow = h.r(id, { kind: 'read', req: { type: 'hash', key: 'h', cursor: '0', count: 10 } });
    const late = await h.r(id, { kind: 'write', write: { op: 'rpush', key: 'l', items: ['once'] } }, Date.now() + 100);
    expect(errorOf(late)).toBe('dbTimeout');
    expect((await slow).ok).toBe(true);
    expect(ops(s, 'rpush')).toHaveLength(0);
    expect(await h.rv(id, { kind: 'write', write: { op: 'rpush', key: 'l', items: ['once'] } })).toEqual({ changed: 1 });
    expect(ops(s, 'rpush')).toHaveLength(1);
  });

  it('a hanging browsing operation times out, the connection is reconnected (reported) and works again', async () => {
    const s = await server({ commandDelays: { HLEN: 2000 } });
    const h = harness({ opTimeoutMs: 300 });
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: 'f', value: 'v' } });
    expect(errorOf(await h.r(id, { kind: 'read', req: { type: 'hash', key: 'h', cursor: '0', count: 10 } }))).toBe('dbTimeout');
    await waitFor(() => h.statuses(id).some((x) => x.reconnect === 1), 5000);
    await waitFor(() => h.last(id)?.phase === 'connected', 5000);
    delete s.commandDelays.HLEN;
    expect((await h.r(id, { kind: 'read', req: { type: 'hash', key: 'h', cursor: '0', count: 10 } })).ok).toBe(true);
  });

  it('the console has its own connection: browsing goes on during a slow command, and a timed-out command takes only that connection', async () => {
    const s = await server();
    const h = harness();
    const id = await h.openRedis(s);
    s.setString('k', 'v');
    const sleeping = h.cmd(id, 'DEBUG SLEEP 1', { confirmed: true });
    const t0 = Date.now();
    expect((await h.r(id, { kind: 'scan', req: { cursor: '0' } })).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(700);
    expect((await sleeping).ok).toBe(true);
    expect(errorOf(await h.cmd(id, 'DEBUG SLEEP 2', { confirmed: true, timeoutMs: 100 }))).toBe('statementTimeout');
    const t1 = Date.now();
    const ping = await h.cmd(id, 'PING');
    expect(ping.ok && ping.value.reply).toEqual({ t: 'simple', v: 'PONG' });
    expect(Date.now() - t1).toBeLessThan(1000);
    // The console follows the session's DB.
    await h.rv(id, { kind: 'select', index: 3 });
    s.setString('in3', 'yes', 3);
    const got = await h.cmd(id, 'GET in3');
    expect(got.ok && got.value).toMatchObject({ reply: { t: 'bulk', v: 'yes' }, db: 3 });
  });
});

describe('big replies', () => {
  it('console reads of big collections or values ask first', async () => {
    const s = await server();
    const h = harness({ consoleItemsConfirm: 10, consoleBytesConfirm: 90 });
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'write', write: { op: 'rpush', key: 'l', items: Array.from({ length: 30 }, (_, i) => String(i)) } });
    await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: 'f', value: 'v' } });
    for (let i = 0; i < 20; i++) await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'bigh', field: `f${i}`, value: 'v' } });
    s.setString('big', 'x'.repeat(100));
    expect(errorOf(await h.cmd(id, 'LRANGE l 0 -1'))).toBe('needsConfirm');
    expect((await h.cmd(id, 'LRANGE l 0 4')).ok).toBe(true);
    expect(errorOf(await h.cmd(id, 'HGETALL bigh'))).toBe('needsConfirm');
    expect((await h.cmd(id, 'HGETALL h')).ok).toBe(true);
    expect(errorOf(await h.cmd(id, 'GET big'))).toBe('needsConfirm');
    expect(errorOf(await h.cmd(id, 'MGET big big'))).toBe('needsConfirm');
    expect((await h.cmd(id, 'HGETALL bigh', { confirmed: true })).ok).toBe(true);
    expect(ops(s, 'hgetall')).toHaveLength(2);
  });

  it('list, stream and hash pages stop at the byte budget and go on from where they stopped; scan pages drop duplicates', async () => {
    const s = await server({ scanRepeat: true });
    const h = harness({ pageBytes: 1000, pageBatch: 4 });
    const id = await h.openRedis(s);
    const v = 'x'.repeat(100);
    await h.rv(id, { kind: 'write', write: { op: 'rpush', key: 'l', items: Array.from({ length: 50 }, () => v) } });
    const p1 = await h.rv<RedisReadResult & { type: 'list' }>(id, { kind: 'read', req: { type: 'list', key: 'l', start: 0, count: 50 } });
    expect(p1.items.length).toBeGreaterThanOrEqual(10);
    expect(p1.items.length).toBeLessThan(50);
    const p2 = await h.rv<RedisReadResult & { type: 'list' }>(id, { kind: 'read', req: { type: 'list', key: 'l', start: p1.items.length, count: 50 } });
    expect(p2.start).toBe(p1.items.length);
    for (let i = 1; i <= 30; i++) await h.rv(id, { kind: 'write', write: { op: 'xadd', key: 'st', id: `${i}-0`, fields: [['f', v]] } });
    const ids: string[] = [];
    let start = '-';
    let pages = 0;
    for (;;) {
      const p = await h.rv<RedisReadResult & { type: 'stream' }>(id, { kind: 'read', req: { type: 'stream', key: 'st', start, end: '+', count: 30 } });
      ids.push(...p.entries.map((e) => e.id));
      pages++;
      if (!p.next) break;
      start = p.next;
    }
    expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => `${i + 1}-0`));
    expect(pages).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: `f${i}`, value: v } });
    const fields: string[] = [];
    let cursor = '0';
    do {
      const p = await h.rv<RedisReadResult & { type: 'hash' }>(id, { kind: 'read', req: { type: 'hash', key: 'h', cursor, count: 40 } });
      const names = p.entries.map((e) => e.field as string);
      expect(new Set(names).size).toBe(names.length);
      fields.push(...names);
      cursor = p.cursor;
    } while (cursor !== '0');
    // Across pages an element may come again (the UI dedupes by redisDataKey); every field arrives.
    expect(new Set(fields).size).toBe(40);
  });

  it('a small hash comes back whole whatever the COUNT (listpack behaviour)', async () => {
    const s = await server({ wholeSmall: 128 });
    const h = harness();
    const id = await h.openRedis(s);
    for (let i = 0; i < 10; i++) await h.rv(id, { kind: 'write', write: { op: 'hset', key: 'h', field: `f${i}`, value: 'v' } });
    const p = await h.rv<RedisReadResult & { type: 'hash' }>(id, { kind: 'read', req: { type: 'hash', key: 'h', cursor: '0', count: 3 } });
    expect(p).toMatchObject({ cursor: '0' });
    expect(p.entries).toHaveLength(10);
  });
});

describe('Pub/Sub', () => {
  type PortMsg = { t: string; sessionId?: string; messages?: RedisPubSubMessage[]; dropped?: number; state?: RedisPubSubState };
  it('a subscriber connection that ended for good: the next subscribe takes over every listed name again', async () => {
    const s = await server();
    const h = harness({ reconnectAttempts: 0 });
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'subscribe', channels: ['old'], patterns: ['p:*'] });
    s.dropSubscribers();
    await waitFor(() => (h.port as unknown as PortMsg[]).some((m) => m.t === 'redisPubSubState' && m.state?.state === 'closed'));
    expect(h.last(id)?.phase).toBe('connected');
    const st = await h.rv<RedisPubSubState>(id, { kind: 'subscribe', channels: ['new'] });
    expect(st).toMatchObject({ state: 'ready', channels: ['old', 'new'], patterns: ['p:*'] });
    for (const ch of ['old', 'new', 'p:1']) expect(await h.rv(id, { kind: 'publish', channel: ch, message: ch })).toBe(1);
    await waitFor(() => (h.port as unknown as PortMsg[]).filter((m) => m.t === 'redisPubSub').flatMap((m) => m.messages!).length === 3);
  });

  it('the buffer accounting returns to zero after drops and flushes', async () => {
    const s = await server();
    const h = harness({ pubsubBuffer: 10, pubsubBufferBytes: 300, pubsubBatch: 3, pubsubFlushMs: 30 });
    const id = await h.openRedis(s);
    await h.rv(id, { kind: 'subscribe', channels: ['c'] });
    await Promise.all(Array.from({ length: 40 }, (_, i) => h.r(id, { kind: 'publish', channel: 'c', message: `payload number ${i}` })));
    const total = () => (h.port as unknown as PortMsg[]).filter((m) => m.t === 'redisPubSub').reduce((n, m) => n + m.messages!.length + m.dropped!, 0);
    await waitFor(() => total() === 40, 5000);
    const session = (h.host as unknown as { sessions: Map<string, { redis: { sub: { buffered: number } } }> }).sessions.get(id)!;
    expect(session.redis.sub.buffered).toBe(0);
    expect((await h.rv<RedisPubSubState>(id, { kind: 'pubsubState' })).dropped).toBeGreaterThan(0);
  });
});

describe('console safety', () => {
  it('read-only on a Redis 6 style server: subcommands without their own entry and admin commands are refused; XREAD runs', async () => {
    const s = await server({ noSubcommandInfo: true });
    const h = harness();
    const id = await h.openRedis(s, { readOnly: true });
    await h.rv(id, { kind: 'command', req: { argv: ['PING'] } });
    s.setString('k', 'v');
    expect(errorOf(await h.cmd(id, 'CLIENT UNBLOCK 5'))).toBe('readOnly');
    expect(errorOf(await h.cmd(id, 'REPLCONF listening-port 1'))).toBe('readOnly');
    expect((await h.cmd(id, 'CLIENT LIST')).ok).toBe(true);
    expect((await h.cmd(id, 'XREAD STREAMS st 0')).ok).toBe(true);
    expect(ops(s, 'replconf')).toHaveLength(0);
  });

  it('a renamed dangerous command still asks (its @dangerous category)', async () => {
    const s = await server({ renames: { NUKE: 'FLUSHALL' } });
    const h = harness();
    const id = await h.openRedis(s);
    s.setString('k', 'v');
    expect(errorOf(await h.cmd(id, 'NUKE'))).toBe('needsConfirm');
    expect(s.dbs[0].size).toBe(1);
    expect((await h.cmd(id, 'NUKE', { confirmed: true })).ok).toBe(true);
    expect(s.dbs[0].size).toBe(0);
  });

  it('TLS prefer does not fall back to plain text when the TLS server is only slow', async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as { port: number }).port;
    try {
      const h = harness({}, { timers: { dbConnectMs: 400 } });
      const id = await h.open({ kind: 'redis', host: '127.0.0.1', port, user: '', database: '0', tls: 'prefer', password: 'never-in-clear' }, dbSessionId(randomUUID()));
      expect(h.last(id)).toMatchObject({ phase: 'error', error: 'dbTimeout' });
    } finally { silent.close(); }
  });

  it('a refused login never puts the password into any message', async () => {
    const s = await server({ password: 'right-one' });
    const h = harness({}, { autoPassword: null });
    const id = await h.openRedis(s, { password: 'secret-wrong-pw' });
    expect(h.last(id)?.phase).toBe('error');
    expect(JSON.stringify(h.toMain)).not.toContain('secret-wrong-pw');
    const h2 = harness({}, { autoPassword: null });
    const id2 = await h2.openRedis(s, { user: 'alice', password: 'secret-acl-pw' });
    expect(h2.last(id2)?.phase).toBe('error');
    expect(JSON.stringify(h2.toMain)).not.toContain('secret-acl-pw');
  });
});
