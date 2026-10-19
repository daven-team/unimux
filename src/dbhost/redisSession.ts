// One connected Redis session of the DB Host (1.0.0): an ioredis client (RESP2, binary replies, no offline queue, no silent
// retries: every reconnect attempt is reported and a few failed ones end the session), its operations run one at a time (key
// browsing with SCAN, value pages per type, writes, pattern deletes in batches, the console with the dangerous / blocking /
// read-only checks, server views) and a separate subscriber connection for Pub/Sub whose messages go to the renderer over the
// DB port in batches with a capped buffer. Independent of Electron so it is tested in Node against the in-process RESP server.
import { randomUUID } from 'crypto';
import { isUtf8 } from 'buffer';
import type { ConnectionOptions } from 'tls';
import Redis from 'ioredis';
import type { DbErrorCode, DbPortMessage, DbResult, DbServerError } from '../shared/db';
import {
  REDIS_LIMITS, REDIS_READ_COMMANDS, REDIS_READ_ONLY_REFUSED, classifyRedisCommand, parseRedisClientList, parseRedisInfo, parseRedisKeyspace,
  streamIdStep, type RedisBlob, type RedisCommandRequest, type RedisCommandResult, type RedisData, type RedisDbList, type RedisItemRequest,
  type RedisKeyInfo, type RedisNewValue, type RedisOp, type RedisPatternCount, type RedisPubSubMessage, type RedisPubSubState, type RedisReadRequest,
  type RedisReadResult, type RedisReply, type RedisScanPage, type RedisScanRequest, type RedisSlowlogEntry, type RedisWrite, type RedisWriteResult,
} from '../shared/dbRedis';

export type RedisLimits = { -readonly [K in keyof typeof REDIS_LIMITS]: number };

// ── bytes ────────────────────────────────────────────────────────────────────

export const toData = (b: Buffer): RedisData => (isUtf8(b) ? b.toString('utf8') : { b64: b.toString('base64') });
export const fromData = (d: RedisData): Buffer => (typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d.b64, 'base64'));
const asBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8'));
const text = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''));
const int = (v: unknown): number => Number(text(v));

/** Drops an incomplete UTF-8 character at the end (a page cut inside it), so a text page stays text. */
export function trimPartialUtf8(b: Buffer): Buffer {
  if (isUtf8(b)) return b;
  for (let k = 1; k <= 3 && k < b.length; k++) if (isUtf8(b.subarray(0, b.length - k))) return b.subarray(0, b.length - k);
  return b;
}

/** The first `max` bytes of a value; a cut inside a UTF-8 character moves back to the character's start (text stays text). */
export function cutBytes(b: Buffer, max: number): Buffer {
  return b.length <= max ? b : trimPartialUtf8(b.subarray(0, max));
}

export function blob(b: Buffer, max: number, total = b.length): RedisBlob {
  const part = cutBytes(b, max);
  return { data: toData(part), bytes: total, ...(part.length < total ? { truncated: true as const } : {}) };
}

// ── errors ───────────────────────────────────────────────────────────────────

export class RedisConnectError extends Error {
  constructor(readonly code: DbErrorCode, readonly serverMessage?: string, readonly needsPassword = false) { super(code); }
}


/** The server's error reply as DbServerError: code is its first word (ERR, WRONGTYPE, NOPERM ...). */
export function redisServerError(e: unknown): DbServerError | null {
  if (!(e instanceof Error) || e.name !== 'ReplyError') return null;
  const m = e.message.slice(0, 4000);
  const code = /^([A-Z][A-Z_-]*) /.exec(m)?.[1];
  return { message: m, ...(code ? { code } : {}) };
}

/** A connect error (Node socket, TLS or the server's reply) as the fixed codes. */
export function mapRedisConnectError(error: unknown, viaTunnel: boolean): RedisConnectError {
  if (error instanceof RedisConnectError) return error;
  const server = redisServerError(error);
  if (server) {
    if (/^NOAUTH/.test(server.message)) return new RedisConnectError('dbAuth', server.message, true);
    if (/^WRONGPASS|invalid password|invalid username-password/i.test(server.message)) return new RedisConnectError('dbAuth', server.message);
    if (/DB index is out of range/i.test(server.message)) return new RedisConnectError('dbNoDatabase', server.message);
    return new RedisConnectError('dbFailed', server.message);
  }
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (code === 'ECONNREFUSED') return new RedisConnectError(viaTunnel ? 'tunnel' : 'dbRefused');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return new RedisConnectError('dbDns');
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) return new RedisConnectError('dbTimeout');
  if (/^ERR_TLS|^ERR_SSL|CERT|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME|EPROTO/.test(code) || /certificate|SSL|TLS|wrong version number/i.test(message)) return new RedisConnectError('dbTls', message.slice(0, 500));
  if (/ECONNRESET|EPIPE|Connection is closed/i.test(code + message)) return new RedisConnectError(viaTunnel ? 'tunnel' : 'dbClosed');
  return new RedisConnectError('dbFailed', message.slice(0, 500) || undefined);
}

// ── connecting ───────────────────────────────────────────────────────────────

export interface RedisConnectOptions {
  host: string;
  port: number;
  tls: ConnectionOptions | null;
  /** ACL user (empty: the default user). */
  user: string;
  password: string | undefined;
  connectTimeoutMs: number;
  viaTunnel: boolean;
  /** Called before every TCP connect, reconnects included (an SSH tunnel admits one announced connection each time). */
  beforeConnect(): void;
  /** SELECT this DB after connecting. */
  dbIndex?: number;
}

/** The retry decision of a connected client: off until the session is connected (a failed first connect never retries). */
export interface RedisControl { enabled: boolean; onRetry(attempt: number): number | null }

export interface OpenedRedis { client: Redis; control: RedisControl; serverVersion?: string; lastError(): unknown }

/** Connects, checks the login (PING answers NOAUTH when a password is needed), selects the DB and reads the version. */
export async function openRedis(o: RedisConnectOptions): Promise<OpenedRedis> {
  const control: RedisControl = { enabled: false, onRetry: () => null };
  let lastError: unknown;
  o.beforeConnect();
  const client = new Redis({
    host: o.host, port: o.port, ...(o.tls ? { tls: o.tls } : {}),
    ...(o.user ? { username: o.user } : {}), ...(o.password !== undefined ? { password: o.password } : {}),
    lazyConnect: true, enableOfflineQueue: false, enableReadyCheck: false, maxRetriesPerRequest: 0, autoResendUnfulfilledCommands: false,
    autoResubscribe: false, protocol: 2, stringNumbers: true, connectTimeout: o.connectTimeoutMs, connectionName: 'unimux', disableClientInfo: true,
    keepAlive: 15_000, reconnectOnError: null,
    retryStrategy: (times: number) => {
      if (!control.enabled) return null;
      const delay = control.onRetry(times);
      if (delay !== null) o.beforeConnect();
      return delay;
    },
  });
  client.on('error', (e) => { lastError = e; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; client.disconnect(); }, o.connectTimeoutMs + 2000);
  const fail = (e: unknown): never => {
    clearTimeout(timer);
    client.disconnect();
    throw timedOut ? new RedisConnectError('dbTimeout') : mapRedisConnectError(lastError ?? e, o.viaTunnel);
  };
  try { await client.connect(); } catch (e) { fail(e); }
  try { await client.callBuffer('ping'); } catch (e) {
    const s = redisServerError(e);
    // An ACL user may lack PING (unusual); only a missing login is a failure here.
    if (!s || /^NOAUTH|^WRONGPASS/.test(s.message)) fail(e);
  }
  if (o.dbIndex) { try { await client.callBuffer('select', String(o.dbIndex)); } catch (e) { fail(e); } }
  let serverVersion: string | undefined;
  try {
    const info = parseRedisInfo(text(await client.callBuffer('info', 'server')));
    const entries = new Map(info.flatMap((s) => s.entries));
    const v = entries.get('valkey_version') ? `Valkey ${entries.get('valkey_version')}` : entries.get('redis_version');
    if (v) serverVersion = v.slice(0, 200);
  } catch { /* INFO not allowed: the version stays unknown */ }
  clearTimeout(timer);
  if (timedOut) fail(new Error('timeout'));
  return { client, control, ...(serverVersion ? { serverVersion } : {}), lastError: () => lastError };
}

// ── the session ──────────────────────────────────────────────────────────────

export interface RedisSessionOptions {
  /** The "db:<uuid>" id: Pub/Sub port messages carry it. */
  sessionId: string;
  readOnly: boolean;
  dbIndex: number;
  /** A second connection with the same endpoint, login and DB for Pub/Sub (its own retry control). */
  openSubscriber(): Promise<OpenedRedis>;
  viaTunnel: boolean;
  limits?: Partial<RedisLimits>;
  now?(): number;
}

export interface RedisSessionOut {
  port(m: DbPortMessage): void;
  activity(busy: boolean): void;
  /** The connection dropped; attempt n of the reconnect is under way. */
  reconnecting(attempt: number): void;
  reconnected(): void;
  /** The connection is gone for good (no more attempts). */
  closed(error: DbErrorCode, message?: string): void;
  database(index: number): void;
}

const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const fail = (error: DbErrorCode, server?: DbServerError): DbResult<never> => ({ ok: false, error, ...(server ? { server } : {}) });
class OpError extends Error { constructor(readonly code: DbErrorCode, readonly server?: DbServerError) { super(code); } }

const LENGTH_COMMAND: Record<string, string> = { string: 'strlen', hash: 'hlen', list: 'llen', set: 'scard', zset: 'zcard', stream: 'xlen' };
const RETRY_DELAYS = [300, 1000, 2000];

export class RedisSession {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private ended = false;
  private db: number;
  private reconnectAttempt = 0;
  private memoryUsage = true;
  private scanType = true;
  private unlink = true;
  private commandInfo = true;
  private flags = new Map<string, string[] | null>();
  private patternToken: { token: string; match: string; type?: string; db: number } | null = null;
  private cancelFlag = false;
  private running = false;
  private readonly limits: RedisLimits;
  private sub: PubSub;

  constructor(readonly client: Redis, private readonly control: RedisControl, private readonly opts: RedisSessionOptions, private readonly out: RedisSessionOut, private readonly lastError: () => unknown = () => undefined) {
    this.limits = { ...REDIS_LIMITS, ...opts.limits } as RedisLimits;
    this.db = opts.dbIndex;
    control.enabled = true;
    control.onRetry = (attempt) => {
      if (this.ended || attempt > this.limits.reconnectAttempts) return null;
      this.reconnectAttempt = attempt;
      this.out.reconnecting(attempt);
      return RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)];
    };
    client.on('ready', () => {
      if (this.ended || !this.reconnectAttempt) return;
      this.reconnectAttempt = 0;
      this.out.reconnected();
    });
    client.on('end', () => {
      if (this.ended) return;
      const e = this.lastError();
      const mapped = mapRedisConnectError(e ?? new Error('Connection is closed.'), opts.viaTunnel);
      this.out.closed(mapped.code === 'dbAuth' ? 'dbAuth' : opts.viaTunnel ? mapped.code : 'dbClosed', mapped.serverMessage);
    });
    this.sub = new PubSub(this.limits, opts, out, () => this.ended);
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  get currentDb(): number { return this.db; }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.cancelFlag = true;
    this.control.enabled = false;
    try { this.client.disconnect(); } catch { /* gone */ }
    this.sub.end();
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private cmd(name: string, ...args: Array<string | Buffer | number>): Promise<unknown> {
    return this.client.callBuffer(name, ...args.map((a) => (typeof a === 'number' ? String(a) : a))) as Promise<unknown>;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending++ === 0) this.out.activity(true);
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined).finally(() => { if (--this.pending === 0) this.out.activity(false); });
    return next;
  }

  private toFailure(error: unknown): DbResult<never> {
    if (error instanceof OpError) return fail(error.code, error.server);
    const server = redisServerError(error);
    if (server) return fail(/^WRONGTYPE/.test(server.message) ? 'wrongType' : /^NOPERM/.test(server.message) ? 'server' : 'server', server);
    if (this.ended) return fail('noSession');
    return fail('dbClosed');
  }

  /** One operation; cancel answers at once, everything else waits its turn. */
  handle(op: RedisOp): Promise<DbResult<unknown>> {
    if (this.ended) return Promise.resolve(fail('noSession'));
    if (op.kind === 'cancel') { const was = this.running; this.cancelFlag = true; return Promise.resolve(ok(was)); }
    if (op.kind === 'subscribe' || op.kind === 'unsubscribe' || op.kind === 'pubsubState') return this.sub.handle(op).catch((e) => this.toFailure(e));
    return this.serial(async () => {
      this.cancelFlag = false;
      try { return ok(await this.run(op)); } catch (error) { return this.toFailure(error); }
    });
  }

  private writable(): void { if (this.opts.readOnly) throw new OpError('readOnly'); }

  private async run(op: RedisOp): Promise<unknown> {
    switch (op.kind) {
      case 'databases': return this.databases();
      case 'select': return this.select(op.index);
      case 'scan': return this.scan(op.req);
      case 'keyInfo': return this.keyInfo(op.keys.slice(0, this.limits.infoKeys).map(fromData));
      case 'read': return this.read(op.req);
      case 'readItem': return this.readItem(op.req);
      case 'write': this.writable(); return this.write(op.write);
      case 'countPattern': return this.countPattern(op.match, op.type);
      case 'deletePattern': this.writable(); return this.deletePattern(op.token);
      case 'command': return this.command(op.req);
      case 'info': return parseRedisInfo(text(await (op.section ? this.cmd('info', op.section) : this.cmd('info'))));
      case 'slowlog': return this.slowlog(op.count ?? 50);
      case 'clients': return parseRedisClientList(text(await this.cmd('client', 'list')));
      case 'publish': {
        if (this.opts.readOnly && !op.readWrite) throw new OpError('readOnly');
        return int(await this.cmd('publish', fromData(op.channel), fromData(op.message)));
      }
      default: throw new OpError('invalid');
    }
  }

  // ── databases ──────────────────────────────────────────────────────────────

  private async databases(): Promise<RedisDbList> {
    let count: number | null = null;
    try {
      const r = await this.cmd('config', 'get', 'databases') as unknown[];
      if (Array.isArray(r) && r.length >= 2) { const n = int(r[1]); if (Number.isInteger(n) && n > 0) count = n; }
    } catch { /* CONFIG not allowed (ACL, managed services) */ }
    let dbs: RedisDbList['dbs'] = [];
    try { dbs = parseRedisKeyspace(parseRedisInfo(text(await this.cmd('info', 'keyspace')))); } catch { /* INFO not allowed */ }
    return { count, current: this.db, dbs };
  }

  private async select(index: number): Promise<number> {
    try { await this.cmd('select', index); } catch (e) {
      const s = redisServerError(e);
      if (s && /out of range/i.test(s.message)) throw new OpError('dbNoDatabase', s);
      throw e;
    }
    if (index !== this.db) { this.db = index; this.out.database(index); }
    return index;
  }

  // ── keys ───────────────────────────────────────────────────────────────────

  private async scanOnce(cursor: string, match: string | undefined, count: number, type: string | undefined): Promise<{ cursor: string; keys: Buffer[] }> {
    const args: Array<string | Buffer | number> = [cursor];
    if (match !== undefined) args.push('MATCH', Buffer.from(match, 'utf8'));
    args.push('COUNT', count);
    const serverType = type && this.scanType;
    if (serverType) args.push('TYPE', type);
    let r: unknown[];
    try { r = await this.cmd('scan', ...args) as unknown[]; } catch (e) {
      if (serverType && /syntax/i.test(redisServerError(e)?.message ?? '')) { this.scanType = false; return this.scanOnce(cursor, match, count, type); }
      throw e;
    }
    let keys = (r[1] as unknown[]).map(asBuffer);
    if (type && !serverType) {
      const types = await Promise.all(keys.map((k) => this.cmd('type', k).then(text, () => '')));
      keys = keys.filter((_, i) => types[i] === type);
    }
    return { cursor: text(r[0]), keys };
  }

  private async scan(req: RedisScanRequest): Promise<RedisScanPage> {
    const limit = Math.min(Math.max(req.limit ?? 500, 1), this.limits.scanKeys);
    const count = Math.min(Math.max(req.count ?? this.limits.scanCountDefault, 1), this.limits.scanCountMax);
    const started = this.now();
    const seen = new Set<string>();
    const keys: Buffer[] = [];
    let cursor = req.cursor;
    do {
      const page = await this.scanOnce(cursor, req.match, count, req.type);
      cursor = page.cursor;
      for (const k of page.keys) { const id = k.toString('latin1'); if (!seen.has(id)) { seen.add(id); keys.push(k); } }
    } while (cursor !== '0' && keys.length < limit && this.now() - started < this.limits.scanBudgetMs && !this.ended);
    return { cursor, keys: req.details ? await this.keyInfo(keys) : keys.map((k) => ({ key: toData(k) })) };
  }

  /** Type, TTL, length and memory of each key: all commands go out at once (pipelined on the connection). */
  private async keyInfo(keys: Buffer[]): Promise<RedisKeyInfo[]> {
    const memory = this.memoryUsage;
    return Promise.all(keys.map(async (k): Promise<RedisKeyInfo> => {
      const [type, pttl] = await Promise.all([this.cmd('type', k).then(text, () => ''), this.cmd('pttl', k).then(int, () => NaN)]);
      if (!type || type === 'none') return { key: toData(k) };
      const info: RedisKeyInfo = { key: toData(k), type, ttlMs: pttl >= 0 ? pttl : null };
      const lengthCmd = LENGTH_COMMAND[type];
      const [length, mem] = await Promise.all([
        lengthCmd ? this.cmd(lengthCmd, k).then(int, () => undefined) : Promise.resolve(undefined),
        memory ? this.cmd('memory', 'usage', k).then((v) => (v === null ? undefined : int(v)), (e) => {
          if (/unknown command|unknown subcommand|NOPERM/i.test(redisServerError(e)?.message ?? '')) this.memoryUsage = false;
          return undefined;
        }) : Promise.resolve(undefined),
      ]);
      if (length !== undefined && Number.isFinite(length)) info.length = length;
      if (mem !== undefined && Number.isFinite(mem)) info.memory = mem;
      return info;
    }));
  }

  // ── values ─────────────────────────────────────────────────────────────────

  private async typeOf(key: Buffer, expected: string): Promise<number | null> {
    const [type, pttl] = await Promise.all([this.cmd('type', key).then(text), this.cmd('pttl', key).then(int)]);
    if (type === 'none') throw new OpError('notFound');
    if (type !== expected) throw new OpError('wrongType');
    return pttl >= 0 ? pttl : null;
  }

  private items(count: number): number { return Math.min(Math.max(Math.floor(count), 1), this.limits.pageItems); }

  private async read(req: RedisReadRequest): Promise<RedisReadResult> {
    const key = fromData(req.key);
    const ttlMs = await this.typeOf(key, req.type);
    const ib = this.limits.itemBytes;
    switch (req.type) {
      case 'string': {
        const length = int(await this.cmd('strlen', key));
        const offset = Math.min(Math.max(req.offset ?? 0, 0), length);
        const max = Math.min(Math.max(req.maxBytes ?? this.limits.stringBytes, 1), this.limits.stringBytesMax);
        const raw = length === 0 || offset >= length ? Buffer.alloc(0) : asBuffer(await this.cmd('getrange', key, offset, offset + max - 1));
        const part = offset + raw.length < length ? trimPartialUtf8(raw) : raw;
        const value: RedisBlob = { data: toData(part), bytes: length, ...(offset + part.length < length ? { truncated: true as const } : {}) };
        return { type: 'string', ttlMs, length, offset, pageBytes: part.length, value };
      }
      case 'hash': {
        const length = int(await this.cmd('hlen', key));
        const r = await this.cmd('hscan', key, req.cursor, ...(req.match !== undefined ? ['MATCH', Buffer.from(req.match)] : []), 'COUNT', this.items(req.count)) as unknown[];
        const flat = (r[1] as unknown[]).map(asBuffer);
        const entries = [];
        for (let i = 0; i + 1 < flat.length; i += 2) entries.push({ field: toData(flat[i]), value: blob(flat[i + 1], ib) });
        return { type: 'hash', ttlMs, length, cursor: text(r[0]), entries };
      }
      case 'list': {
        const length = int(await this.cmd('llen', key));
        const start = Math.max(0, Math.floor(req.start));
        const r = await this.cmd('lrange', key, start, start + this.items(req.count) - 1) as unknown[];
        return { type: 'list', ttlMs, length, start, items: r.map((x) => blob(asBuffer(x), ib)) };
      }
      case 'set': {
        const length = int(await this.cmd('scard', key));
        const r = await this.cmd('sscan', key, req.cursor, ...(req.match !== undefined ? ['MATCH', Buffer.from(req.match)] : []), 'COUNT', this.items(req.count)) as unknown[];
        return { type: 'set', ttlMs, length, cursor: text(r[0]), members: (r[1] as unknown[]).map((x) => toData(asBuffer(x))) };
      }
      case 'zset': {
        const length = int(await this.cmd('zcard', key));
        const pairs = (flat: unknown[]) => { const out = []; for (let i = 0; i + 1 < flat.length; i += 2) out.push({ member: toData(asBuffer(flat[i])), score: text(flat[i + 1]) }); return out; };
        if ('cursor' in req) {
          const r = await this.cmd('zscan', key, req.cursor, ...(req.match !== undefined ? ['MATCH', Buffer.from(req.match)] : []), 'COUNT', this.items(req.count)) as unknown[];
          return { type: 'zset', ttlMs, length, cursor: text(r[0]), entries: pairs(r[1] as unknown[]) };
        }
        const start = Math.max(0, Math.floor(req.start));
        const stop = start + this.items(req.count) - 1;
        let r: unknown[];
        if (req.rev) {
          try { r = await this.cmd('zrange', key, start, stop, 'REV', 'WITHSCORES') as unknown[]; } catch (e) {
            if (!/syntax/i.test(redisServerError(e)?.message ?? '')) throw e;
            r = await this.cmd('zrevrange', key, start, stop, 'WITHSCORES') as unknown[];
          }
        } else r = await this.cmd('zrange', key, start, stop, 'WITHSCORES') as unknown[];
        return { type: 'zset', ttlMs, length, start, entries: pairs(r) };
      }
      case 'stream': {
        const length = int(await this.cmd('xlen', key));
        const count = this.items(req.count);
        const r = await this.cmd(req.rev ? 'xrevrange' : 'xrange', key, req.start, req.end, 'COUNT', count) as unknown[];
        const entries = r.map((e) => {
          const [id, flat] = e as [unknown, unknown[]];
          const fields = [];
          const f = (flat ?? []).map(asBuffer);
          for (let i = 0; i + 1 < f.length; i += 2) fields.push({ field: toData(f[i]), value: blob(f[i + 1], ib) });
          return { id: text(id), fields };
        });
        const last = entries.at(-1)?.id;
        return { type: 'stream', ttlMs, length, entries, next: entries.length === count && last ? streamIdStep(last, req.rev ? -1 : 1) : null };
      }
    }
  }

  private async readItem(req: RedisItemRequest): Promise<RedisBlob> {
    const key = fromData(req.key);
    const max = this.limits.stringBytesMax;
    await this.typeOf(key, req.type);
    let v: unknown;
    if (req.type === 'hash') v = await this.cmd('hget', key, fromData(req.field));
    else if (req.type === 'list') v = await this.cmd('lindex', key, req.index);
    else {
      const r = await this.cmd('xrange', key, req.id, req.id) as unknown[];
      const flat = ((r[0] as [unknown, unknown[]] | undefined)?.[1] ?? []).map(asBuffer);
      const want = fromData(req.field);
      v = null;
      for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i].equals(want)) { v = flat[i + 1]; break; }
    }
    if (v === null || v === undefined) throw new OpError('notFound');
    return blob(asBuffer(v), max);
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** WATCH key, check, MULTI ... EXEC; a null EXEC (the key changed meanwhile) is `onAbort`. */
  private async atomically(key: Buffer, check: () => Promise<void>, commands: Array<Array<string | Buffer | number>>, onAbort: DbErrorCode): Promise<unknown[]> {
    await this.cmd('watch', key);
    try { await check(); } catch (e) { await this.cmd('unwatch').catch(() => undefined); throw e; }
    await this.cmd('multi');
    try {
      for (const c of commands) await this.cmd(String(c[0]), ...c.slice(1));
    } catch (e) {
      await this.cmd('discard').catch(() => undefined);
      throw e;
    }
    const r = await this.cmd('exec') as unknown[] | null;
    if (r === null) throw new OpError(onAbort);
    const failed = r.find((x) => x instanceof Error);
    if (failed) throw failed;
    return r;
  }

  private async write(w: RedisWrite): Promise<RedisWriteResult> {
    const key = 'key' in w ? fromData(w.key) : Buffer.alloc(0);
    const n = (v: unknown): RedisWriteResult => ({ changed: int(v) });
    switch (w.op) {
      case 'set': {
        const value = fromData(w.value);
        if (w.ttlMs) { await this.cmd('set', key, value, 'PX', w.ttlMs); return { changed: 1 }; }
        if (w.keepTtl === false) { await this.cmd('set', key, value); return { changed: 1 }; }
        try { await this.cmd('set', key, value, 'KEEPTTL'); } catch (e) {
          if (!/syntax/i.test(redisServerError(e)?.message ?? '')) throw e;
          // Before Redis 6 there is no KEEPTTL: read the TTL and set it again in one transaction.
          const pttl = int(await this.cmd('pttl', key));
          await this.atomically(key, async () => undefined, [['set', key, value], ...(pttl > 0 ? [['pexpire', key, pttl]] : [])], 'conflict');
        }
        return { changed: 1 };
      }
      case 'hset': return n(await this.cmd(w.onlyNew ? 'hsetnx' : 'hset', key, fromData(w.field), fromData(w.value)));
      case 'hdel': return n(await this.cmd('hdel', key, ...w.fields.map(fromData)));
      case 'lpush': case 'rpush': return n(await this.cmd(w.op, key, ...w.items.map(fromData)));
      case 'lset': {
        if (w.expected === undefined) { await this.cmd('lset', key, w.index, fromData(w.value)); return { changed: 1 }; }
        const expected = fromData(w.expected);
        await this.atomically(key, async () => {
          const cur = await this.cmd('lindex', key, w.index);
          if (cur === null || !asBuffer(cur).equals(expected)) throw new OpError('conflict');
        }, [['lset', key, w.index, fromData(w.value)]], 'conflict');
        return { changed: 1 };
      }
      case 'lrem': return n(await this.cmd('lrem', key, w.count, fromData(w.value)));
      case 'ldel': {
        const expected = fromData(w.expected);
        const marker = Buffer.from(`__unimux_removed_${randomUUID()}__`);
        await this.atomically(key, async () => {
          const cur = await this.cmd('lindex', key, w.index);
          if (cur === null || !asBuffer(cur).equals(expected)) throw new OpError('conflict');
        }, [['lset', key, w.index, marker], ['lrem', key, 1, marker]], 'conflict');
        return { changed: 1 };
      }
      case 'sadd': case 'srem': return n(await this.cmd(w.op, key, ...w.members.map(fromData)));
      case 'zadd': return n(await this.cmd('zadd', key, ...(w.mode ? [w.mode.toUpperCase()] : []), ...(w.mode === 'xx' ? ['CH'] : []), ...w.entries.flatMap(([m, s]) => [s, fromData(m)])));
      case 'zrem': return n(await this.cmd('zrem', key, ...w.members.map(fromData)));
      case 'zincrby': await this.cmd('zincrby', key, w.by, fromData(w.member)); return { changed: 1 };
      case 'xadd': {
        const trim = w.maxLen !== undefined ? ['MAXLEN', ...(w.approx ? ['~'] : []), w.maxLen] : [];
        const id = text(await this.cmd('xadd', key, ...trim, w.id ?? '*', ...w.fields.flatMap(([f, v]) => [fromData(f), fromData(v)])));
        return { changed: 1, id };
      }
      case 'xdel': return n(await this.cmd('xdel', key, ...w.ids));
      case 'xtrim': return n(await this.cmd('xtrim', key, w.strategy.toUpperCase(), ...(w.approx ? ['~'] : []), w.threshold));
      case 'rename': {
        try {
          if (w.overwrite) { await this.cmd('rename', key, fromData(w.newKey)); return { changed: 1 }; }
          const r = int(await this.cmd('renamenx', key, fromData(w.newKey)));
          if (r === 0) throw new OpError('keyExists');
          return { changed: 1 };
        } catch (e) {
          if (/no such key/i.test(redisServerError(e)?.message ?? '')) throw new OpError('notFound');
          throw e;
        }
      }
      case 'expire': { const r = int(await this.cmd('pexpire', key, w.ttlMs)); if (r === 0) throw new OpError('notFound'); return { changed: r }; }
      case 'persist': return n(await this.cmd('persist', key));
      case 'delete': return { changed: await this.unlinkKeys(w.keys.map(fromData)) };
      case 'create': return this.create(key, w.value, w.ttlMs);
    }
  }

  private async unlinkKeys(keys: Buffer[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += this.limits.deleteBatch) {
      const batch = keys.slice(i, i + this.limits.deleteBatch);
      if (this.unlink) {
        try { deleted += int(await this.cmd('unlink', ...batch)); continue; } catch (e) {
          if (!/unknown command/i.test(redisServerError(e)?.message ?? '')) throw e;
          this.unlink = false;
        }
      }
      deleted += int(await this.cmd('del', ...batch));
    }
    return deleted;
  }

  private async create(key: Buffer, v: RedisNewValue, ttlMs?: number): Promise<RedisWriteResult> {
    const cmds: Array<Array<string | Buffer | number>> = [];
    switch (v.type) {
      case 'string': cmds.push(['set', key, fromData(v.value)]); break;
      case 'hash': cmds.push(['hset', key, ...v.entries.flatMap(([f, x]) => [fromData(f), fromData(x)])]); break;
      case 'list': cmds.push(['rpush', key, ...v.items.map(fromData)]); break;
      case 'set': cmds.push(['sadd', key, ...v.members.map(fromData)]); break;
      case 'zset': cmds.push(['zadd', key, ...v.entries.flatMap(([m, s]) => [s, fromData(m)])]); break;
      case 'stream': cmds.push(['xadd', key, v.id ?? '*', ...v.fields.flatMap(([f, x]) => [fromData(f), fromData(x)])]); break;
    }
    if (ttlMs) cmds.push(['pexpire', key, ttlMs]);
    const r = await this.atomically(key, async () => {
      if (int(await this.cmd('exists', key)) > 0) throw new OpError('keyExists');
    }, cmds, 'keyExists');
    return { changed: 1, ...(v.type === 'stream' ? { id: text(r[0]) } : {}) };
  }

  // ── pattern deletes ────────────────────────────────────────────────────────

  private async eachMatch(match: string, type: string | undefined, max: number, fn: (keys: Buffer[]) => Promise<void>): Promise<{ complete: boolean; cancelled: boolean }> {
    let cursor = '0';
    let seen = 0;
    this.running = true;
    try {
      do {
        if (this.cancelFlag || this.ended) return { complete: false, cancelled: true };
        const page = await this.scanOnce(cursor, match, 1000, type);
        cursor = page.cursor;
        if (page.keys.length) await fn(page.keys);
        seen += page.keys.length;
        if (seen >= max) return { complete: cursor === '0', cancelled: false };
      } while (cursor !== '0');
      return { complete: true, cancelled: false };
    } finally { this.running = false; }
  }

  private async countPattern(match: string, type?: string): Promise<RedisPatternCount> {
    const ids = new Set<string>();
    const r = await this.eachMatch(match, type, this.limits.countKeys, async (keys) => { for (const k of keys) ids.add(k.toString('latin1')); });
    if (r.cancelled) throw new OpError('cancelled');
    const token = randomUUID();
    this.patternToken = { token, match, ...(type ? { type } : {}), db: this.db };
    return { token, count: ids.size, complete: r.complete };
  }

  private async deletePattern(token: string): Promise<{ deleted: number; cancelled: boolean }> {
    const t = this.patternToken;
    if (!t || t.token !== token || t.db !== this.db) throw new OpError('staleToken');
    this.patternToken = null;
    let deleted = 0;
    const r = await this.eachMatch(t.match, t.type, Number.MAX_SAFE_INTEGER, async (keys) => { deleted += await this.unlinkKeys(keys); });
    return { deleted, cancelled: r.cancelled };
  }

  // ── console ────────────────────────────────────────────────────────────────

  /** The flags of a command (and subcommand) from COMMAND INFO; null: the server does not know it; undefined: not allowed. */
  private async commandFlags(name: string, sub: string | null): Promise<string[] | null | undefined> {
    if (!this.commandInfo) return undefined;
    const id = sub ? `${name}|${sub}` : name;
    if (this.flags.has(id)) return this.flags.get(id)!;
    let r: unknown[];
    try { r = await this.cmd('command', 'info', name) as unknown[]; } catch { this.commandInfo = false; return undefined; }
    const entry = r?.[0] as unknown[] | null | undefined;
    if (!Array.isArray(entry)) { this.flags.set(id, null); return null; }
    let flags = ((entry[2] as unknown[]) ?? []).map((f) => text(f).toLowerCase());
    const subs = entry[9];
    if (sub && Array.isArray(subs)) {
      const s = subs.find((x) => Array.isArray(x) && text(x[0]).toLowerCase() === id) as unknown[] | undefined;
      if (s) flags = ((s[2] as unknown[]) ?? []).map((f) => text(f).toLowerCase());
    }
    this.flags.set(id, flags);
    return flags;
  }

  /** Strict: refused lists, then the server's flags (write, may_replicate), unknown commands refused; without COMMAND INFO only known reads. */
  private async onlyReads(argv: Buffer[], name: string): Promise<boolean> {
    const first = name.split(' ')[0];
    if (REDIS_READ_ONLY_REFUSED.has(name) || REDIS_READ_ONLY_REFUSED.has(first)) return false;
    const sub = name.includes(' ') ? argv[1].toString('utf8').toLowerCase() : null;
    const flags = await this.commandFlags(first.toLowerCase(), sub);
    if (flags === undefined) return REDIS_READ_COMMANDS.has(name) || (!name.includes(' ') && REDIS_READ_COMMANDS.has(first));
    if (flags === null) return false;
    return !flags.includes('write') && !flags.includes('may_replicate') && !flags.includes('blocking');
  }

  private reply(v: unknown, status: boolean, budget: { nodes: number }, top = true): RedisReply {
    budget.nodes--;
    if (v === null || v === undefined) return { t: 'null' };
    if (v instanceof Error) return { t: 'error', v: v.message.slice(0, 4000) };
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return { t: 'integer', v: String(v) };
    if (Buffer.isBuffer(v)) {
      if (top && status && v.length < 1024 && isUtf8(v)) return { t: 'simple', v: v.toString('utf8') };
      const b = blob(v, this.limits.replyBulkBytes);
      return { t: 'bulk', v: b.data, bytes: b.bytes, ...(b.truncated ? { truncated: true as const } : {}) };
    }
    if (Array.isArray(v)) {
      const items: RedisReply[] = [];
      for (const x of v) { if (budget.nodes <= 0) break; items.push(this.reply(x, status, budget, false)); }
      return { t: 'array', items, length: v.length };
    }
    return { t: 'bulk', v: String(v), bytes: Buffer.byteLength(String(v)) };
  }

  private async command(req: RedisCommandRequest): Promise<RedisCommandResult> {
    if (!req.argv.length || typeof req.argv[0] !== 'string') throw new OpError('invalid');
    const cls = classifyRedisCommand(req.argv);
    if (cls.refused) throw new OpError(cls.refused === 'blocking' ? 'blockingCommand' : cls.refused === 'subscribe' ? 'subscribeCommand' : 'consoleUnsupported');
    if (cls.dangerous && !req.confirmed) throw new OpError('needsConfirm');
    const argv = req.argv.map(fromData);
    if (this.opts.readOnly && !req.readWrite && !(await this.onlyReads(argv, cls.name))) throw new OpError('readOnly');
    const started = this.now();
    const name = argv[0].toString('utf8').toLowerCase();
    if (name === 'select') {
      const n = Number(argv[1]?.toString());
      if (argv.length !== 2 || !Number.isInteger(n) || n < 0) return { reply: { t: 'error', v: 'ERR value is not an integer or out of range' }, timeMs: 0, db: this.db };
      try { await this.select(n); } catch (e) {
        const s = e instanceof OpError ? e.server : redisServerError(e);
        if (s) return { reply: { t: 'error', v: s.message }, timeMs: this.now() - started, db: this.db };
        throw e;
      }
      return { reply: { t: 'simple', v: 'OK' }, timeMs: this.now() - started, db: this.db };
    }
    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? this.limits.consoleTimeoutMs, 1), this.limits.consoleTimeoutMaxMs);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OpError('statementTimeout')), timeoutMs); });
    let raw: unknown;
    try {
      raw = await Promise.race([this.cmd(name, ...argv.slice(1)), timeout]);
    } catch (e) {
      if (e instanceof OpError) throw e;
      const s = redisServerError(e);
      if (!s) throw e;
      raw = e;
    } finally { clearTimeout(timer); }
    return { reply: this.reply(raw, cls.status, { nodes: this.limits.replyNodes }), timeMs: this.now() - started, db: this.db };
  }

  private async slowlog(count: number): Promise<RedisSlowlogEntry[]> {
    const r = await this.cmd('slowlog', 'get', Math.min(Math.max(Math.floor(count), 1), this.limits.slowlogMax)) as unknown[];
    return r.map((e) => {
      const x = e as unknown[];
      const entry: RedisSlowlogEntry = { id: int(x[0]), time: int(x[1]), durationUs: int(x[2]), args: ((x[3] as unknown[]) ?? []).map((a) => toData(asBuffer(a))) };
      if (x[4] !== undefined && x[4] !== null) entry.client = text(x[4]);
      if (x[5] !== undefined && x[5] !== null && text(x[5])) entry.clientName = text(x[5]);
      return entry;
    });
  }
}

// ── Pub/Sub ──────────────────────────────────────────────────────────────────

class PubSub {
  private client: Redis | null = null;
  private control: RedisControl | null = null;
  private opening: Promise<Redis> | null = null;
  private channels = new Map<string, Buffer>();
  private patterns = new Map<string, Buffer>();
  private state: RedisPubSubState['state'] = 'idle';
  private reconnect: number | undefined;
  private error: string | undefined;
  private buffer: RedisPubSubMessage[] = [];
  private bufferBytes = 0;
  private droppedSince = 0;
  private droppedTotal = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly sessionId: string;

  constructor(private readonly limits: RedisLimits, private readonly opts: RedisSessionOptions, private readonly out: RedisSessionOut, private readonly sessionEnded: () => boolean) {
    this.sessionId = opts.sessionId;
  }

  snapshot(): RedisPubSubState {
    return {
      state: this.state, channels: [...this.channels.values()].map(toData), patterns: [...this.patterns.values()].map(toData), dropped: this.droppedTotal,
      ...(this.reconnect ? { reconnect: this.reconnect } : {}), ...(this.error ? { error: this.error } : {}),
    };
  }

  private emitState(): void { this.out.port({ t: 'redisPubSubState', sessionId: this.sessionId, state: this.snapshot() }); }

  private push(channel: Buffer, pattern: Buffer | undefined, message: Buffer): void {
    if (this.buffer.length >= this.limits.pubsubBuffer || this.bufferBytes + message.length > this.limits.pubsubBufferBytes) {
      this.droppedSince++;
      this.droppedTotal++;
    } else {
      const payload = blob(message, this.limits.pubsubPayloadBytes);
      this.buffer.push({ channel: toData(channel), ...(pattern ? { pattern: toData(pattern) } : {}), time: this.opts.now?.() ?? Date.now(), payload });
      this.bufferBytes += Math.min(message.length, this.limits.pubsubPayloadBytes) + channel.length;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.limits.pubsubFlushMs);
  }

  private flush(): void {
    this.timer = null;
    if (!this.buffer.length && !this.droppedSince) return;
    const messages = this.buffer.splice(0, this.limits.pubsubBatch);
    this.bufferBytes = this.buffer.reduce((n, m) => n + Math.min(m.payload.bytes, this.limits.pubsubPayloadBytes), 0);
    const dropped = this.droppedSince;
    this.droppedSince = 0;
    this.out.port({ t: 'redisPubSub', sessionId: this.sessionId, messages, dropped });
    if (this.buffer.length) this.schedule();
  }

  private async ensure(): Promise<Redis> {
    if (this.client) return this.client;
    if (this.opening) return this.opening;
    this.state = 'connecting';
    this.error = undefined;
    this.emitState();
    this.opening = (async () => {
      let opened: OpenedRedis;
      try { opened = await this.opts.openSubscriber(); } catch (e) {
        this.state = 'closed';
        this.error = e instanceof RedisConnectError ? e.code : 'dbFailed';
        this.emitState();
        throw e instanceof RedisConnectError ? new OpError(e.code, e.serverMessage ? { message: e.serverMessage } : undefined) : e;
      } finally { this.opening = null; }
      if (this.sessionEnded()) { opened.client.disconnect(); throw new OpError('noSession'); }
      const c = opened.client;
      this.client = c;
      this.control = opened.control;
      opened.control.enabled = true;
      opened.control.onRetry = (attempt) => {
        if (this.sessionEnded() || this.client !== c || attempt > this.limits.reconnectAttempts) return null;
        this.state = 'connecting';
        this.reconnect = attempt;
        this.emitState();
        return RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)];
      };
      c.on('messageBuffer', (channel: Buffer, message: Buffer) => this.push(asBuffer(channel), undefined, asBuffer(message)));
      c.on('pmessageBuffer', (pattern: string | Buffer, channel: Buffer, message: Buffer) => this.push(asBuffer(channel), this.patterns.get(asBuffer(pattern).toString('latin1')) ?? asBuffer(pattern), asBuffer(message)));
      c.on('ready', () => {
        if (this.client !== c || !this.reconnect) return;
        this.reconnect = undefined;
        // Our own resubscribe keeps binary channel names exact.
        void this.resubscribe(c).then(() => { this.state = 'ready'; this.emitState(); }, () => undefined);
      });
      c.on('end', () => {
        if (this.client !== c) return;
        this.client = null;
        this.control = null;
        this.state = 'closed';
        this.reconnect = undefined;
        const e = opened.lastError();
        this.error = e ? mapRedisConnectError(e, this.opts.viaTunnel).code : 'dbClosed';
        if (!this.sessionEnded()) this.emitState();
      });
      this.state = 'ready';
      this.emitState();
      return c;
    })();
    return this.opening;
  }

  private async resubscribe(c: Redis): Promise<void> {
    if (this.channels.size) await c.callBuffer('subscribe', ...this.channels.values());
    if (this.patterns.size) await c.callBuffer('psubscribe', ...this.patterns.values());
  }

  async handle(op: Extract<RedisOp, { kind: 'subscribe' | 'unsubscribe' | 'pubsubState' }>): Promise<DbResult<RedisPubSubState>> {
    if (op.kind === 'pubsubState') return ok(this.snapshot());
    if (op.kind === 'subscribe') {
      const channels = (op.channels ?? []).map(fromData), patterns = (op.patterns ?? []).map(fromData);
      if (this.channels.size + this.patterns.size + channels.length + patterns.length > this.limits.pubsubChannels) return fail('invalid');
      if (!channels.length && !patterns.length) return ok(this.snapshot());
      const c = await this.ensure();
      if (channels.length) await c.callBuffer('subscribe', ...channels);
      if (patterns.length) await c.callBuffer('psubscribe', ...patterns);
      for (const ch of channels) this.channels.set(ch.toString('latin1'), ch);
      for (const p of patterns) this.patterns.set(p.toString('latin1'), p);
      this.emitState();
      return ok(this.snapshot());
    }
    const c = this.client;
    const channels = op.all ? [...this.channels.values()] : (op.channels ?? []).map(fromData);
    const patterns = op.all ? [...this.patterns.values()] : (op.patterns ?? []).map(fromData);
    if (c && channels.length) await c.callBuffer('unsubscribe', ...channels);
    if (c && patterns.length) await c.callBuffer('punsubscribe', ...patterns);
    for (const ch of channels) this.channels.delete(ch.toString('latin1'));
    for (const p of patterns) this.patterns.delete(p.toString('latin1'));
    if (!this.channels.size && !this.patterns.size && c) {
      // Nothing left to listen to: the subscriber connection closes.
      this.client = null;
      if (this.control) this.control.enabled = false;
      this.control = null;
      c.disconnect();
      this.state = 'idle';
      this.reconnect = undefined;
    }
    this.emitState();
    return ok(this.snapshot());
  }

  end(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.client;
    this.client = null;
    if (this.control) this.control.enabled = false;
    try { c?.disconnect(); } catch { /* gone */ }
    this.buffer = [];
  }
}

