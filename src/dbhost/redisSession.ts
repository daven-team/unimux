// One connected Redis session of the DB Host (1.0.0). Three ioredis connections at most (RESP2, binary replies, no offline
// queue, no resent commands): the main one for browsing (SCAN, value pages, writes, server views), opened at connect, whose
// drops are reported and retried a few times; a lazily opened "console" one for console commands and pattern counts/deletes,
// so a slow command never blocks the key browser (reset when a command times out); and a lazily opened subscriber for
// Pub/Sub whose messages go to the renderer over the DB port in batches with a capped buffer. Operations of a connection run
// one at a time; each carries main's deadline and is skipped when it would start after it (a write main reported as failed
// never runs later), and a browsing operation that hangs drops and reconnects the connection. Independent of Electron so it
// is tested in Node against the in-process RESP server.
import { createHash, randomUUID } from 'crypto';
import { isUtf8 } from 'buffer';
import type { ConnectionOptions } from 'tls';
import type { Duplex } from 'stream';
import Redis, { AbstractConnector, Command } from 'ioredis';
import type ConnectorConstructor from 'ioredis/built/connectors/ConnectorConstructor';
import type { NetStream } from 'ioredis/built/types';
import type { DbErrorCode, DbPortMessage, DbResult, DbServerError } from '../shared/db';
import {
  REDIS_LIMITS, REDIS_READ_COMMANDS, REDIS_READ_ONLY_REFUSED, classifyRedisCommand, parseRedisClientList, parseRedisInfo, parseRedisKeyspace,
  streamIdStep, type RedisBlob, type RedisCommandRequest, type RedisCommandResult, type RedisData, type RedisDbList, type RedisItemRequest,
  type RedisKeyInfo, type RedisNewValue, type RedisOp, type RedisPatternCount, type RedisPatternDelete, type RedisPubSubMessage, type RedisPubSubState,
  type RedisReadRequest, type RedisReadResult, type RedisReply, type RedisScanPage, type RedisScanRequest, type RedisSlowlogEntry, type RedisWrite,
  type RedisWriteResult,
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

/** ioredis puts the failed command on its errors (AUTH carries the password): it never stays on an error we keep. */
export function scrubError<T>(e: T): T {
  if (e && typeof e === 'object' && 'command' in e) { try { delete (e as { command?: unknown }).command; } catch { /* frozen */ } }
  return e;
}

/** The server's error reply as DbServerError: code is its first word (ERR, WRONGTYPE, NOPERM ...). */
export function redisServerError(e: unknown): DbServerError | null {
  if (!(e instanceof Error) || e.name !== 'ReplyError') return null;
  scrubError(e);
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
  if (code === 'ETUNNEL') return new RedisConnectError('tunnel');
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
  /**
   * Through an SSH tunnel: a connected stream (the forwarded channel, TLS already on top when wanted) for every connect,
   * reconnects included. Absent: ioredis connects to host:port itself (TLS from `tls`).
   */
  stream?: () => Promise<Duplex>;
  /** SELECT this DB after connecting. */
  dbIndex?: number;
}

/** The retry decision of a connected client: off until the session is connected (a failed first connect never retries). */
export interface RedisControl { enabled: boolean; onRetry(attempt: number): number | null }

export interface OpenedRedis { client: Redis; control: RedisControl; serverVersion?: string; lastError(): unknown }

/** An ioredis connector handing out an already connected stream (the SSH channel) instead of opening a socket itself. */
function streamConnector(open: () => Promise<Duplex>): ConnectorConstructor {
  return class TunnelConnector extends AbstractConnector {
    constructor() { super(2000); }
    connect(): Promise<NetStream> {
      this.connecting = true;
      return open().then((stream) => {
        if (!this.connecting) { stream.destroy(); throw new Error('Connection is closed.'); }
        this.stream = stream as unknown as NetStream;
        stream.once('error', (e) => { this.firstError = e; });
        return this.stream;
      });
    }
  } as unknown as ConnectorConstructor;
}

/** Connects, checks the login (PING answers NOAUTH when a password is needed), selects the DB and reads the version. */
export async function openRedis(o: RedisConnectOptions): Promise<OpenedRedis> {
  const control: RedisControl = { enabled: false, onRetry: () => null };
  let lastError: unknown;
  const client = new Redis({
    host: o.host, port: o.port, ...(o.stream ? { Connector: streamConnector(o.stream) } : o.tls ? { tls: o.tls } : {}),
    ...(o.user ? { username: o.user } : {}), ...(o.password !== undefined ? { password: o.password } : {}),
    lazyConnect: true, enableOfflineQueue: false, enableReadyCheck: false, maxRetriesPerRequest: 0, autoResendUnfulfilledCommands: false,
    autoResubscribe: false, protocol: 2, stringNumbers: true, connectTimeout: o.connectTimeoutMs, connectionName: 'unimux', disableClientInfo: true,
    keepAlive: 15_000, reconnectOnError: null,
    retryStrategy: (times: number) => {
      if (!control.enabled) return null;
      return control.onRetry(times);
    },
  });
  client.on('error', (e) => { lastError = scrubError(e); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; client.disconnect(); }, o.connectTimeoutMs + 2000);
  const fail = (e: unknown): never => {
    clearTimeout(timer);
    client.disconnect();
    throw timedOut ? new RedisConnectError('dbTimeout') : mapRedisConnectError(scrubError(lastError ?? e), o.viaTunnel);
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
  /** Another connection with the same endpoint and login on DB `dbIndex` (Pub/Sub and console use their own; own retry control). */
  openConnection(dbIndex: number): Promise<OpenedRedis>;
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

type Arg = string | Buffer | number;
type Cmd = (name: string, ...args: Arg[]) => Promise<unknown>;

const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const fail = (error: DbErrorCode, server?: DbServerError): DbResult<never> => ({ ok: false, error, ...(server ? { server } : {}) });
class OpError extends Error { constructor(readonly code: DbErrorCode, readonly server?: DbServerError) { super(code); } }

// ioredis turns every HGETALL reply into an object; the console needs the server's flat array (a typed reply, binary-safe
// fields). The host itself never relies on the object form.
Command.setReplyTransformer('hgetall', (result: unknown) => result);

const LENGTH_COMMAND: Record<string, string> = { string: 'strlen', hash: 'hlen', list: 'llen', set: 'scard', zset: 'zcard', stream: 'xlen' };
const RETRY_DELAYS = [300, 1000, 2000];
/** Console and pattern operations run on the console connection; everything else on the main one. */
const CONSOLE_KINDS = new Set<RedisOp['kind']>(['command', 'countPattern', 'deletePattern']);

const callOn = (client: Redis): Cmd => (name, ...args) =>
  (client.callBuffer(name, ...args.map((a) => (typeof a === 'number' ? String(a) : a))) as Promise<unknown>).catch((e: unknown) => { throw scrubError(e); });

/** Rejects with OpError(code) after ms; `onTimeout` runs first (drops the connection). */
function within<T>(p: Promise<T>, ms: number, onTimeout: () => void, code: DbErrorCode): Promise<T> {
  if (!Number.isFinite(ms)) return p;
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new OpError(code)); }, Math.max(1, ms)); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** One connection's queue: one operation at a time. */
class Lane {
  private queue: Promise<unknown> = Promise.resolve();
  pending = 0;
  constructor(private readonly changed: () => void) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    this.changed();
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined).finally(() => { this.pending--; this.changed(); });
    return next;
  }
}

interface CommandInfo { flags: string[]; categories: string[]; /** A container command whose subcommand has an entry of its own. */ subFound: boolean }

export class RedisSession {
  private ended = false;
  private db: number;
  private reconnectAttempt = 0;
  private memoryUsage = true;
  private scanType = true;
  private unlink = true;
  private keepTtl = true;
  private commandInfo = true;
  private infos = new Map<string, CommandInfo | null>();
  private patternToken: { token: string; match: string; type?: string; db: number; count: number; at: number } | null = null;
  /** A cancel stops every console operation enqueued before it (each op remembers the generation it was enqueued in). */
  private cancelGen = 0;
  private wasBusy = false;
  private readonly limits: RedisLimits;
  private readonly main: Lane;
  private readonly consoleLane: Lane;
  private consoleConn: { client: Redis; db: number } | null = null;
  private consoleOpening: Promise<{ client: Redis; db: number }> | null = null;
  private sub: PubSub;
  private readonly mainCmd: Cmd;

  constructor(readonly client: Redis, private readonly control: RedisControl, private readonly opts: RedisSessionOptions, private readonly out: RedisSessionOut, private readonly lastError: () => unknown = () => undefined) {
    this.limits = { ...REDIS_LIMITS, ...opts.limits } as RedisLimits;
    this.db = opts.dbIndex;
    this.mainCmd = callOn(client);
    const changed = () => {
      const busy = this.main.pending + this.consoleLane.pending > 0;
      if (busy !== this.wasBusy) { this.wasBusy = busy; this.out.activity(busy); }
    };
    this.main = new Lane(changed);
    this.consoleLane = new Lane(changed);
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
    this.cancelGen++;
    this.control.enabled = false;
    try { this.client.disconnect(); } catch { /* gone */ }
    this.dropConsole();
    this.sub.end();
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  /** The main connection hangs: drop it; ioredis reconnects (reported like any drop) and the pending commands fail. */
  private resetMain(): void { if (!this.ended) { try { this.client.disconnect(true); } catch { /* gone */ } } }

  private dropConsole(): void {
    const c = this.consoleConn;
    this.consoleConn = null;
    try { c?.client.disconnect(); } catch { /* gone */ }
  }

  /** The console connection, opened on first use and kept on the session's DB. */
  private async consoleCmd(): Promise<Cmd> {
    if (!this.consoleConn) {
      this.consoleOpening ??= (async () => {
        try {
          const opened = await this.opts.openConnection(this.db);
          if (this.ended) { opened.client.disconnect(); throw new OpError('noSession'); }
          const conn = { client: opened.client, db: this.db };
          opened.client.on('end', () => { if (this.consoleConn === conn) this.consoleConn = null; });
          this.consoleConn = conn;
          return conn;
        } catch (e) {
          if (e instanceof RedisConnectError) throw new OpError(e.code, e.serverMessage ? { message: e.serverMessage } : undefined);
          throw e;
        } finally { this.consoleOpening = null; }
      })();
      await this.consoleOpening;
    }
    const conn = this.consoleConn!;
    const c = callOn(conn.client);
    if (conn.db !== this.db) { await c('select', this.db); conn.db = this.db; }
    return c;
  }

  private toFailure(error: unknown): DbResult<never> {
    scrubError(error);
    if (error instanceof OpError) return fail(error.code, error.server);
    const server = redisServerError(error);
    if (server) return fail(/^WRONGTYPE/.test(server.message) ? 'wrongType' : 'server', server);
    if (this.ended) return fail('noSession');
    return fail('dbClosed');
  }

  /**
   * One operation. cancel answers at once; Pub/Sub has its own connection; console commands and pattern operations queue on
   * the console connection, everything else on the main one. `deadline`: main's own limit; an operation that would only start
   * after it is skipped ('dbTimeout'), and one on the main connection is cut at it (or at opTimeoutMs).
   */
  handle(op: RedisOp, deadline?: number): Promise<DbResult<unknown>> {
    if (this.ended) return Promise.resolve(fail('noSession'));
    if (op.kind === 'cancel') { const was = this.consoleLane.pending > 0; this.cancelGen++; return Promise.resolve(ok(was)); }
    if (op.kind === 'subscribe' || op.kind === 'unsubscribe' || op.kind === 'pubsubState') return this.sub.handle(op).catch((e) => this.toFailure(e));
    const gen = this.cancelGen;
    const expired = () => deadline !== undefined && this.now() >= deadline;
    if (CONSOLE_KINDS.has(op.kind)) {
      return this.consoleLane.run(async () => {
        if (expired()) return fail('dbTimeout');
        try { return ok(await this.runConsole(op, gen, deadline)); } catch (error) { return this.toFailure(error); }
      });
    }
    return this.main.run(async () => {
      if (expired()) return fail('dbTimeout');
      const left = deadline !== undefined ? deadline - this.now() : Infinity;
      try { return ok(await within(this.run(op), Math.min(this.limits.opTimeoutMs, left), () => this.resetMain(), 'dbTimeout')); } catch (error) { return this.toFailure(error); }
    });
  }

  private writable(): void { if (this.opts.readOnly) throw new OpError('readOnly'); }

  private async run(op: RedisOp): Promise<unknown> {
    const c = this.mainCmd;
    switch (op.kind) {
      case 'databases': return this.databases();
      case 'select': return this.select(op.index);
      case 'scan': return this.scan(op.req);
      case 'keyInfo': return this.keyInfo(op.keys.slice(0, this.limits.infoKeys).map(fromData));
      case 'read': return this.read(op.req);
      case 'readItem': return this.readItem(op.req);
      case 'write': this.writable(); return this.write(op.write);
      case 'info': return parseRedisInfo(text(await (op.section ? c('info', op.section) : c('info'))));
      case 'slowlog': return this.slowlog(op.count ?? 50);
      case 'clients': return parseRedisClientList(text(await c('client', 'list')));
      case 'publish': {
        if (this.opts.readOnly && !op.readWrite) throw new OpError('readOnly');
        return int(await c('publish', fromData(op.channel), fromData(op.message)));
      }
      default: throw new OpError('invalid');
    }
  }

  private async runConsole(op: RedisOp, gen: number, deadline: number | undefined): Promise<unknown> {
    switch (op.kind) {
      case 'command': return this.command(op.req, deadline);
      case 'countPattern': return this.countPattern(op.match, op.type, gen);
      case 'deletePattern': this.writable(); return this.deletePattern(op.token, gen);
      default: throw new OpError('invalid');
    }
  }

  // ── databases ──────────────────────────────────────────────────────────────

  private async databases(): Promise<RedisDbList> {
    const c = this.mainCmd;
    let count: number | null = null;
    try {
      const r = await c('config', 'get', 'databases') as unknown[];
      if (Array.isArray(r) && r.length >= 2) { const n = int(r[1]); if (Number.isInteger(n) && n > 0) count = n; }
    } catch { /* CONFIG not allowed (ACL, managed services) */ }
    let dbs: RedisDbList['dbs'] = [];
    try { dbs = parseRedisKeyspace(parseRedisInfo(text(await c('info', 'keyspace')))); } catch { /* INFO not allowed */ }
    return { count, current: this.db, dbs };
  }

  private async select(index: number): Promise<number> {
    try { await this.mainCmd('select', index); } catch (e) {
      const s = redisServerError(e);
      if (s && /out of range/i.test(s.message)) throw new OpError('dbNoDatabase', s);
      throw e;
    }
    if (index !== this.db) { this.db = index; this.out.database(index); }
    return index;
  }

  // ── keys ───────────────────────────────────────────────────────────────────

  private async scanOnce(c: Cmd, cursor: string, match: string | undefined, count: number, type: string | undefined): Promise<{ cursor: string; keys: Buffer[] }> {
    const args: Arg[] = [cursor];
    if (match !== undefined) args.push('MATCH', Buffer.from(match, 'utf8'));
    args.push('COUNT', count);
    const serverType = type && this.scanType;
    if (serverType) args.push('TYPE', type);
    let r: unknown[];
    try { r = await c('scan', ...args) as unknown[]; } catch (e) {
      if (serverType && /syntax/i.test(redisServerError(e)?.message ?? '')) { this.scanType = false; return this.scanOnce(c, cursor, match, count, type); }
      throw e;
    }
    let keys = (r[1] as unknown[]).map(asBuffer);
    if (type && !serverType) {
      const types = await Promise.all(keys.map((k) => c('type', k).then(text, () => '')));
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
      const page = await this.scanOnce(this.mainCmd, cursor, req.match, count, req.type);
      cursor = page.cursor;
      for (const k of page.keys) { const id = k.toString('latin1'); if (!seen.has(id)) { seen.add(id); keys.push(k); } }
    } while (cursor !== '0' && keys.length < limit && this.now() - started < this.limits.scanBudgetMs && !this.ended);
    return { cursor, keys: req.details ? await this.keyInfo(keys) : keys.map((k) => ({ key: toData(k) })) };
  }

  /** Type, TTL, length and memory of each key: all commands go out at once (pipelined on the connection). */
  private async keyInfo(keys: Buffer[]): Promise<RedisKeyInfo[]> {
    const c = this.mainCmd;
    const memory = this.memoryUsage;
    return Promise.all(keys.map(async (k): Promise<RedisKeyInfo> => {
      const [type, pttl] = await Promise.all([c('type', k).then(text, () => ''), c('pttl', k).then(int, () => NaN)]);
      if (!type || type === 'none') return { key: toData(k) };
      const info: RedisKeyInfo = { key: toData(k), type, ttlMs: pttl >= 0 ? pttl : null };
      const lengthCmd = LENGTH_COMMAND[type];
      const [length, mem] = await Promise.all([
        lengthCmd ? c(lengthCmd, k).then(int, () => undefined) : Promise.resolve(undefined),
        memory ? this.memoryOf(c, k) : Promise.resolve(undefined),
      ]);
      if (length !== undefined && Number.isFinite(length)) info.length = length;
      if (mem !== undefined && Number.isFinite(mem)) info.memory = mem;
      return info;
    }));
  }

  /** MEMORY USAGE (undefined when the server has none or does not allow it; then never asked again). */
  private memoryOf(c: Cmd, k: Buffer): Promise<number | undefined> {
    if (!this.memoryUsage) return Promise.resolve(undefined);
    return c('memory', 'usage', k).then((v) => (v === null ? undefined : int(v)), (e) => {
      if (/unknown command|unknown subcommand|NOPERM/i.test(redisServerError(e)?.message ?? '')) this.memoryUsage = false;
      return undefined;
    });
  }

  // ── values ─────────────────────────────────────────────────────────────────

  private async typeOf(key: Buffer, expected: string): Promise<number | null> {
    const c = this.mainCmd;
    const [type, pttl] = await Promise.all([c('type', key).then(text), c('pttl', key).then(int)]);
    if (type === 'none') throw new OpError('notFound');
    if (type !== expected) throw new OpError('wrongType');
    return pttl >= 0 ? pttl : null;
  }

  private items(count: number): number { return Math.min(Math.max(Math.floor(count), 1), this.limits.pageItems); }

  /**
   * HSCAN / SSCAN / ZSCAN in sub-batches until `count` items, the page byte budget or the end; duplicates within the page are
   * dropped (the cursor may still return an item again on a later page).
   */
  private async scanPage(cmd: 'hscan' | 'sscan' | 'zscan', key: Buffer, cursor: string, count: number, match: string | undefined, perItem: 1 | 2): Promise<{ cursor: string; flat: Buffer[] }> {
    const c = this.mainCmd;
    const seen = new Set<string>();
    const flat: Buffer[] = [];
    let bytes = 0;
    let items = 0;
    do {
      const want = Math.min(this.limits.pageBatch, count - items);
      const r = await c(cmd, key, cursor, ...(match !== undefined ? ['MATCH', Buffer.from(match)] : []), 'COUNT', want) as unknown[];
      cursor = text(r[0]);
      const got = (r[1] as unknown[]).map(asBuffer);
      for (let i = 0; i + perItem - 1 < got.length; i += perItem) {
        const id = got[i].toString('latin1');
        if (seen.has(id)) continue;
        seen.add(id);
        for (let j = 0; j < perItem; j++) { flat.push(got[i + j]); bytes += Math.min(got[i + j].length, this.limits.itemBytes); }
        items++;
      }
    } while (cursor !== '0' && items < count && bytes < this.limits.pageBytes && !this.ended);
    return { cursor, flat };
  }

  private async read(req: RedisReadRequest): Promise<RedisReadResult> {
    const c = this.mainCmd;
    const key = fromData(req.key);
    const ttlMs = await this.typeOf(key, req.type);
    const ib = this.limits.itemBytes;
    switch (req.type) {
      case 'string': {
        const length = int(await c('strlen', key));
        const offset = Math.min(Math.max(req.offset ?? 0, 0), length);
        const max = Math.min(Math.max(req.maxBytes ?? this.limits.stringBytes, 1), this.limits.stringBytesMax);
        const raw = length === 0 || offset >= length ? Buffer.alloc(0) : asBuffer(await c('getrange', key, offset, offset + max - 1));
        const part = offset + raw.length < length ? trimPartialUtf8(raw) : raw;
        const value: RedisBlob = { data: toData(part), bytes: length, ...(offset + part.length < length ? { truncated: true as const } : {}) };
        return { type: 'string', ttlMs, length, offset, pageBytes: part.length, value };
      }
      case 'hash': {
        const length = int(await c('hlen', key));
        const p = await this.scanPage('hscan', key, req.cursor, this.items(req.count), req.match, 2);
        const entries = [];
        for (let i = 0; i + 1 < p.flat.length; i += 2) entries.push({ field: toData(p.flat[i]), value: blob(p.flat[i + 1], ib) });
        return { type: 'hash', ttlMs, length, cursor: p.cursor, entries };
      }
      case 'list': {
        const length = int(await c('llen', key));
        const start = Math.max(0, Math.floor(req.start));
        const count = this.items(req.count);
        const items: RedisBlob[] = [];
        let bytes = 0;
        // Sub-batches with a byte budget: the page may come back shorter (the next one starts at start + items.length).
        while (items.length < count && bytes < this.limits.pageBytes) {
          const from = start + items.length;
          const n = Math.min(this.limits.pageBatch, count - items.length);
          const r = await c('lrange', key, from, from + n - 1) as unknown[];
          for (const x of r) { const b = asBuffer(x); bytes += b.length; items.push(blob(b, ib)); }
          if (r.length < n) break;
        }
        return { type: 'list', ttlMs, length, start, items };
      }
      case 'set': {
        const length = int(await c('scard', key));
        const p = await this.scanPage('sscan', key, req.cursor, this.items(req.count), req.match, 1);
        return { type: 'set', ttlMs, length, cursor: p.cursor, members: p.flat.map(toData) };
      }
      case 'zset': {
        const length = int(await c('zcard', key));
        const pairs = (flat: unknown[]) => { const out = []; for (let i = 0; i + 1 < flat.length; i += 2) out.push({ member: toData(asBuffer(flat[i])), score: text(flat[i + 1]) }); return out; };
        if ('cursor' in req) {
          const p = await this.scanPage('zscan', key, req.cursor, this.items(req.count), req.match, 2);
          return { type: 'zset', ttlMs, length, cursor: p.cursor, entries: pairs(p.flat) };
        }
        const start = Math.max(0, Math.floor(req.start));
        const count = this.items(req.count);
        const entries: Array<{ member: RedisData; score: string }> = [];
        let bytes = 0;
        while (entries.length < count && bytes < this.limits.pageBytes) {
          const from = start + entries.length;
          const stop = from + Math.min(this.limits.pageBatch, count - entries.length) - 1;
          let r: unknown[];
          if (req.rev) {
            try { r = await c('zrange', key, from, stop, 'REV', 'WITHSCORES') as unknown[]; } catch (e) {
              if (!/syntax/i.test(redisServerError(e)?.message ?? '')) throw e;
              r = await c('zrevrange', key, from, stop, 'WITHSCORES') as unknown[];
            }
          } else r = await c('zrange', key, from, stop, 'WITHSCORES') as unknown[];
          for (const x of r) bytes += asBuffer(x).length;
          entries.push(...pairs(r));
          if (r.length / 2 < stop - from + 1) break;
        }
        return { type: 'zset', ttlMs, length, start, entries };
      }
      case 'stream': {
        const length = int(await c('xlen', key));
        const count = this.items(req.count);
        const entries: Array<{ id: string; fields: Array<{ field: RedisData; value: RedisBlob }> }> = [];
        let bytes = 0;
        let from: string | null = req.start;
        let exhausted = false;
        while (from !== null && entries.length < count && bytes < this.limits.pageBytes) {
          const n = Math.min(this.limits.pageBatch, count - entries.length);
          const r = await c(req.rev ? 'xrevrange' : 'xrange', key, from, req.end, 'COUNT', n) as unknown[];
          for (const e of r) {
            const [id, flat] = e as [unknown, unknown[]];
            const f = (flat ?? []).map(asBuffer);
            const fields = [];
            for (let i = 0; i + 1 < f.length; i += 2) { fields.push({ field: toData(f[i]), value: blob(f[i + 1], ib) }); bytes += f[i].length + f[i + 1].length; }
            entries.push({ id: text(id), fields });
          }
          if (r.length < n) { exhausted = true; break; }
          from = streamIdStep(entries.at(-1)!.id, req.rev ? -1 : 1);
        }
        const last = entries.at(-1)?.id;
        return { type: 'stream', ttlMs, length, entries, next: !exhausted && last ? streamIdStep(last, req.rev ? -1 : 1) : null };
      }
    }
  }

  private async readItem(req: RedisItemRequest): Promise<RedisBlob> {
    const c = this.mainCmd;
    const key = fromData(req.key);
    const max = this.limits.stringBytesMax;
    await this.typeOf(key, req.type);
    let v: unknown;
    if (req.type === 'hash') v = await c('hget', key, fromData(req.field));
    else if (req.type === 'list') v = await c('lindex', key, req.index);
    else {
      const r = await c('xrange', key, req.id, req.id) as unknown[];
      const flat = ((r[0] as [unknown, unknown[]] | undefined)?.[1] ?? []).map(asBuffer);
      const want = fromData(req.field);
      v = null;
      for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i].equals(want)) { v = flat[i + 1]; break; }
    }
    if (v === null || v === undefined) throw new OpError('notFound');
    return blob(asBuffer(v), max);
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** WATCH key, check, MULTI ... EXEC; a null EXEC (the key changed meanwhile) is `onAbort`. Commands may be built by the check. */
  private async atomically(key: Buffer, check: () => Promise<void>, commands: Arg[][] | (() => Arg[][]), onAbort: DbErrorCode): Promise<unknown[]> {
    const c = this.mainCmd;
    await c('watch', key);
    let list: Arg[][];
    try { await check(); list = typeof commands === 'function' ? commands() : commands; } catch (e) { await c('unwatch').catch(() => undefined); throw e; }
    await c('multi');
    try {
      for (const x of list) await c(String(x[0]), ...x.slice(1));
    } catch (e) {
      await c('discard').catch(() => undefined);
      throw e;
    }
    const r = await c('exec') as unknown[] | null;
    if (r === null) throw new OpError(onAbort);
    const failed = r.find((x) => x instanceof Error);
    if (failed) throw failed;
    return r;
  }

  /** The key holds `type` (else wrongType); missing: notFound, or fine when `allowMissing`. */
  private async expectType(key: Buffer, type: string, allowMissing: boolean): Promise<void> {
    const t = text(await this.mainCmd('type', key));
    if (t === 'none') { if (!allowMissing) throw new OpError('notFound'); return; }
    if (t !== type) throw new OpError('wrongType');
  }

  /** A write that would create the key: with `existing` it runs only while the key still exists with that type. */
  private async guarded(key: Buffer, type: string, existing: boolean | undefined, command: Arg[]): Promise<unknown> {
    if (!existing) return this.mainCmd(String(command[0]), ...command.slice(1));
    const r = await this.atomically(key, () => this.expectType(key, type, false), [command], 'conflict');
    return r[0];
  }

  private async setString(key: Buffer, w: Extract<RedisWrite, { op: 'set' }>): Promise<void> {
    const value = fromData(w.value);
    const check = () => this.expectType(key, 'string', true);
    if (w.ttlMs) { await this.atomically(key, check, [['set', key, value, 'PX', w.ttlMs]], 'conflict'); return; }
    if (w.keepTtl === false) { await this.atomically(key, check, [['set', key, value]], 'conflict'); return; }
    if (this.keepTtl) {
      try { await this.atomically(key, check, [['set', key, value, 'KEEPTTL']], 'conflict'); return; } catch (e) {
        if (!/syntax/i.test(redisServerError(e)?.message ?? '')) throw e;
        this.keepTtl = false;
      }
    }
    // Before Redis 6 there is no KEEPTTL: the TTL is read under WATCH and set again in the same transaction.
    let pttl = -1;
    await this.atomically(key, async () => { await check(); pttl = int(await this.mainCmd('pttl', key)); },
      () => [['set', key, value], ...(pttl > 0 ? [['pexpire', key, pttl] as Arg[]] : [])], 'conflict');
  }

  private async write(w: RedisWrite): Promise<RedisWriteResult> {
    const c = this.mainCmd;
    const key = 'key' in w ? fromData(w.key) : Buffer.alloc(0);
    const n = (v: unknown): RedisWriteResult => ({ changed: int(v) });
    switch (w.op) {
      case 'set': await this.setString(key, w); return { changed: 1 };
      case 'hset': return n(await this.guarded(key, 'hash', w.existing, [w.onlyNew ? 'hsetnx' : 'hset', key, fromData(w.field), fromData(w.value)]));
      case 'hdel': return n(await c('hdel', key, ...w.fields.map(fromData)));
      case 'lpush': case 'rpush': return n(await this.guarded(key, 'list', w.existing, [w.op, key, ...w.items.map(fromData)]));
      case 'lset': {
        if (w.expected === undefined) { await c('lset', key, w.index, fromData(w.value)); return { changed: 1 }; }
        const expected = fromData(w.expected);
        await this.atomically(key, async () => {
          const cur = await c('lindex', key, w.index);
          if (cur === null || !asBuffer(cur).equals(expected)) throw new OpError('conflict');
        }, [['lset', key, w.index, fromData(w.value)]], 'conflict');
        return { changed: 1 };
      }
      case 'lrem': return n(await c('lrem', key, w.count, fromData(w.value)));
      case 'ldel': {
        const expected = fromData(w.expected);
        const marker = Buffer.from(`__unimux_removed_${randomUUID()}__`);
        await this.atomically(key, async () => {
          const cur = await c('lindex', key, w.index);
          if (cur === null || !asBuffer(cur).equals(expected)) throw new OpError('conflict');
        }, [['lset', key, w.index, marker], ['lrem', key, 1, marker]], 'conflict');
        return { changed: 1 };
      }
      case 'sadd': return n(await this.guarded(key, 'set', w.existing, ['sadd', key, ...w.members.map(fromData)]));
      case 'srem': return n(await c('srem', key, ...w.members.map(fromData)));
      case 'zadd': return n(await this.guarded(key, 'zset', w.existing, ['zadd', key, ...(w.mode ? [w.mode.toUpperCase()] : []), ...(w.mode === 'xx' ? ['CH'] : []), ...w.entries.flatMap(([m, s]) => [s, fromData(m)])]));
      case 'zrem': return n(await c('zrem', key, ...w.members.map(fromData)));
      case 'zincrby': await this.guarded(key, 'zset', w.existing, ['zincrby', key, w.by, fromData(w.member)]); return { changed: 1 };
      case 'xadd': {
        const trim = w.maxLen !== undefined ? ['MAXLEN', ...(w.approx ? ['~'] : []), w.maxLen] : [];
        const id = text(await this.guarded(key, 'stream', w.existing, ['xadd', key, ...trim, w.id ?? '*', ...w.fields.flatMap(([f, v]) => [fromData(f), fromData(v)])]));
        return { changed: 1, id };
      }
      case 'xdel': return n(await c('xdel', key, ...w.ids));
      case 'xtrim': return n(await c('xtrim', key, w.strategy.toUpperCase(), ...(w.approx ? ['~'] : []), w.threshold));
      case 'rename': {
        try {
          if (w.overwrite) { await c('rename', key, fromData(w.newKey)); return { changed: 1 }; }
          const r = int(await c('renamenx', key, fromData(w.newKey)));
          if (r === 0) throw new OpError('keyExists');
          return { changed: 1 };
        } catch (e) {
          if (/no such key/i.test(redisServerError(e)?.message ?? '')) throw new OpError('notFound');
          throw e;
        }
      }
      case 'expire': { const r = int(await c('pexpire', key, w.ttlMs)); if (r === 0) throw new OpError('notFound'); return { changed: r }; }
      case 'persist': return n(await c('persist', key));
      case 'delete': return { changed: await this.unlinkKeys(c, w.keys.map(fromData)) };
      case 'create': return this.create(key, w.value, w.ttlMs);
    }
  }

  private async unlinkKeys(c: Cmd, keys: Buffer[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += this.limits.deleteBatch) {
      const batch = keys.slice(i, i + this.limits.deleteBatch);
      if (this.unlink) {
        try { deleted += int(await c('unlink', ...batch)); continue; } catch (e) {
          if (!/unknown command/i.test(redisServerError(e)?.message ?? '')) throw e;
          this.unlink = false;
        }
      }
      deleted += int(await c('del', ...batch));
    }
    return deleted;
  }

  private async create(key: Buffer, v: RedisNewValue, ttlMs?: number): Promise<RedisWriteResult> {
    const cmds: Arg[][] = [];
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
      if (int(await this.mainCmd('exists', key)) > 0) throw new OpError('keyExists');
    }, cmds, 'keyExists');
    return { changed: 1, ...(v.type === 'stream' ? { id: text(r[0]) } : {}) };
  }

  // ── pattern deletes (console connection) ───────────────────────────────────

  /** One console-connection command bounded by opTimeoutMs (a hang drops that connection, never the browser's). */
  private async consoleStep<T>(fn: (c: Cmd) => Promise<T>): Promise<T> {
    const c = await this.consoleCmd();
    return within(fn(c), this.limits.opTimeoutMs, () => this.dropConsole(), 'dbTimeout');
  }

  private async countPattern(match: string, type: string | undefined, gen: number): Promise<RedisPatternCount> {
    // Keys are deduplicated on a 64-bit hash (SCAN may return a key twice): memory stays small even near the cap.
    const ids = new Set<string>();
    let cursor = '0';
    let complete = true;
    do {
      if (gen !== this.cancelGen || this.ended) throw new OpError('cancelled');
      const page = await this.consoleStep((c) => this.scanOnce(c, cursor, match, 1000, type));
      cursor = page.cursor;
      for (const k of page.keys) ids.add(createHash('sha1').update(k).digest('hex').slice(0, 16));
      if (ids.size >= this.limits.countKeys) { complete = cursor === '0'; break; }
    } while (cursor !== '0');
    const token = randomUUID();
    this.patternToken = { token, match, ...(type ? { type } : {}), db: this.db, count: ids.size, at: this.now() };
    return { token, count: ids.size, complete };
  }

  /**
   * Deletes what matches the counted pattern, at most the confirmed count plus a small slack: keys created after the count can
   * only be deleted after another count. The token is used once and is valid for tokenTtlMs.
   */
  private async deletePattern(token: string, gen: number): Promise<RedisPatternDelete> {
    const t = this.patternToken;
    if (!t || t.token !== token || t.db !== this.db || this.now() - t.at > this.limits.tokenTtlMs) throw new OpError('staleToken');
    this.patternToken = null;
    const cap = t.count + Math.max(this.limits.deleteSlackMin, Math.ceil(t.count * this.limits.deleteSlack));
    let deleted = 0;
    let sent = 0;
    let cursor = '0';
    do {
      if (gen !== this.cancelGen || this.ended) return { deleted, cancelled: true, more: true };
      const page = await this.consoleStep((c) => this.scanOnce(c, cursor, t.match, 1000, t.type));
      cursor = page.cursor;
      const room = cap - sent;
      const batch = page.keys.slice(0, room);
      if (batch.length) {
        sent += batch.length;
        for (let i = 0; i < batch.length; i += this.limits.deleteBatch) {
          if (gen !== this.cancelGen || this.ended) return { deleted, cancelled: true, more: true };
          const part = batch.slice(i, i + this.limits.deleteBatch);
          deleted += await this.consoleStep((c) => this.unlinkKeys(c, part));
        }
      }
      if (page.keys.length > room) return { deleted, cancelled: false, more: true };
      if (sent >= cap && cursor !== '0') return { deleted, cancelled: false, more: true };
    } while (cursor !== '0');
    return { deleted, cancelled: false, more: false };
  }

  // ── console ────────────────────────────────────────────────────────────────

  /** COMMAND INFO of a command (and subcommand); null: the server does not know it; undefined: not allowed. */
  private async infoOf(c: Cmd, name: string, sub: string | null): Promise<CommandInfo | null | undefined> {
    if (!this.commandInfo) return undefined;
    const id = sub ? `${name}|${sub}` : name;
    if (this.infos.has(id)) return this.infos.get(id)!;
    let r: unknown[];
    try { r = await c('command', 'info', name) as unknown[]; } catch { this.commandInfo = false; return undefined; }
    const entry = r?.[0] as unknown[] | null | undefined;
    if (!Array.isArray(entry)) { this.infos.set(id, null); return null; }
    const list = (x: unknown) => (Array.isArray(x) ? x.map((f) => text(f).toLowerCase()) : []);
    let info: CommandInfo = { flags: list(entry[2]), categories: list(entry[6]), subFound: false };
    const subs = entry[9];
    if (sub && Array.isArray(subs)) {
      const s = subs.find((x) => Array.isArray(x) && text(x[0]).toLowerCase() === id) as unknown[] | undefined;
      if (s) info = { flags: list(s[2]), categories: list(s[6]), subFound: true };
    }
    this.infos.set(id, info);
    return info;
  }

  /**
   * Strict read-only check: the refused lists; then the server's command table (write, may_replicate and admin refused unless
   * a known read; unknown commands refused); a subcommand without its own entry, or no COMMAND INFO at all: only known reads.
   * The blocking flag is not used here (XREAD carries it; its blocking forms are refused by classifyRedisCommand).
   */
  private onlyReads(info: CommandInfo | null | undefined, name: string, sub: string | null): boolean {
    const first = name.split(' ')[0];
    if (REDIS_READ_ONLY_REFUSED.has(name) || REDIS_READ_ONLY_REFUSED.has(first)) return false;
    const known = REDIS_READ_COMMANDS.has(name) || (!sub && REDIS_READ_COMMANDS.has(first));
    if (info === undefined) return known;
    if (info === null) return false;
    if (sub && !info.subFound) return known;
    if (info.flags.includes('write') || info.flags.includes('may_replicate')) return false;
    if (info.flags.includes('admin') && !known) return false;
    return true;
  }

  /** Collection reads that would bring back a very big reply: their size is checked first (needsConfirm above the limits). */
  private async bigRead(c: Cmd, argv: Buffer[], name: string): Promise<boolean> {
    const k = argv[1];
    if (!k) return false;
    const items = this.limits.consoleItemsConfirm, bytes = this.limits.consoleBytesConfirm;
    const n = (v: unknown) => int(v);
    const memory = async () => ((await this.memoryOf(c, k)) ?? 0) > bytes;
    try {
      switch (name) {
        case 'GET': case 'GETEX': case 'GETDEL': case 'DUMP': return n(await c('strlen', k)) > bytes || (name === 'DUMP' && await memory());
        case 'MGET': {
          let sum = 0;
          for (const key of argv.slice(1, 10_001)) { sum += n(await c('strlen', key).catch(() => 0)); if (sum > bytes) return true; }
          return false;
        }
        case 'HGETALL': case 'HKEYS': case 'HVALS': return n(await c('hlen', k)) > items || await memory();
        case 'SMEMBERS': return n(await c('scard', k)) > items || await memory();
        case 'SINTER': case 'SUNION': case 'SDIFF': {
          let sum = 0;
          for (const key of argv.slice(1, 1001)) sum += n(await c('scard', key).catch(() => 0));
          return sum > items;
        }
        case 'LRANGE': {
          const len = n(await c('llen', k));
          let a = Number(argv[2]?.toString()), b = Number(argv[3]?.toString());
          if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
          if (a < 0) a = Math.max(0, len + a);
          if (b < 0) b = len + b;
          const count = Math.max(0, Math.min(b, len - 1) - a + 1);
          if (count > items) return true;
          // Few but big elements: the average element size from MEMORY USAGE times the range.
          const mem = len > 0 && count > 0 ? (await this.memoryOf(c, k)) ?? 0 : 0;
          return len > 0 && (mem / len) * count > bytes;
        }
        case 'ZRANGE': case 'ZREVRANGE': case 'ZRANGEBYSCORE': case 'ZREVRANGEBYSCORE': case 'ZRANGEBYLEX': case 'ZREVRANGEBYLEX':
          return (n(await c('zcard', k)) > items && !argv.some((a) => a.toString().toUpperCase() === 'LIMIT')) || await memory();
        case 'XRANGE': case 'XREVRANGE': {
          const at = argv.findIndex((a) => a.toString().toUpperCase() === 'COUNT');
          const limit = at > 0 ? Number(argv[at + 1]?.toString()) : Infinity;
          return Math.min(limit, n(await c('xlen', k))) > items || (limit > items && await memory());
        }
        default: return false;
      }
    } catch { return false; }
  }

  private reply(v: unknown, status: boolean, budget: { nodes: number }, top = true): RedisReply {
    budget.nodes--;
    if (v === null || v === undefined) return { t: 'null' };
    if (v instanceof Error) return { t: 'error', v: scrubError(v).message.slice(0, 4000) };
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

  private async command(req: RedisCommandRequest, deadline: number | undefined): Promise<RedisCommandResult> {
    if (!req.argv.length || typeof req.argv[0] !== 'string') throw new OpError('invalid');
    const cls = classifyRedisCommand(req.argv);
    if (cls.refused) throw new OpError(cls.refused === 'blocking' ? 'blockingCommand' : cls.refused === 'subscribe' ? 'subscribeCommand' : 'consoleUnsupported');
    if (cls.dangerous && !req.confirmed) throw new OpError('needsConfirm');
    const argv = req.argv.map(fromData);
    const name = argv[0].toString('utf8').toLowerCase();
    const started = this.now();
    if (name === 'select') {
      const n = Number(argv[1]?.toString());
      if (argv.length !== 2 || !Number.isInteger(n) || n < 0) return { reply: { t: 'error', v: 'ERR value is not an integer or out of range' }, timeMs: 0, db: this.db };
      // The session's DB changes on the browsing connection (its queue), the console connection follows before its next command.
      const r = await this.main.run(async () => { try { await this.select(n); return null; } catch (e) { return e; } });
      if (r) {
        const s = r instanceof OpError ? r.server : redisServerError(r);
        if (s) return { reply: { t: 'error', v: s.message }, timeMs: this.now() - started, db: this.db };
        throw r;
      }
      return { reply: { t: 'simple', v: 'OK' }, timeMs: this.now() - started, db: this.db };
    }
    const c = await this.consoleCmd();
    const sub = cls.name.includes(' ') ? argv[1].toString('utf8').toLowerCase() : null;
    const needInfo = this.opts.readOnly && !req.readWrite || !req.confirmed;
    const info = needInfo ? await this.infoOf(c, name, sub) : undefined;
    if (this.opts.readOnly && !req.readWrite && !this.onlyReads(info, cls.name, sub)) throw new OpError('readOnly');
    if (!req.confirmed) {
      // A renamed dangerous command still carries its category; a huge collection read asks first.
      const known = REDIS_READ_COMMANDS.has(cls.name) || (!sub && REDIS_READ_COMMANDS.has(cls.name.split(' ')[0]));
      if (info && info.categories.includes('@dangerous') && !known) throw new OpError('needsConfirm');
      if (await this.bigRead(c, argv, cls.name)) throw new OpError('needsConfirm');
    }
    const limit = Math.min(Math.max(req.timeoutMs ?? this.limits.consoleTimeoutMs, 1), this.limits.consoleTimeoutMaxMs, deadline !== undefined ? deadline - this.now() : Infinity);
    let raw: unknown;
    try {
      // A command that times out takes the console connection with it (a new one opens for the next command).
      raw = await within(c(name, ...argv.slice(1)), limit, () => this.dropConsole(), 'statementTimeout');
    } catch (e) {
      if (e instanceof OpError) throw e;
      const s = redisServerError(e);
      if (!s) throw e;
      raw = e;
    }
    return { reply: this.reply(raw, cls.status, { nodes: this.limits.replyNodes }), timeMs: this.now() - started, db: this.db };
  }

  private async slowlog(count: number): Promise<RedisSlowlogEntry[]> {
    const r = await this.mainCmd('slowlog', 'get', Math.min(Math.max(Math.floor(count), 1), this.limits.slowlogMax)) as unknown[];
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

interface Buffered { message: RedisPubSubMessage; size: number }

class PubSub {
  private client: Redis | null = null;
  private control: RedisControl | null = null;
  private opening: Promise<Redis> | null = null;
  private channels = new Map<string, Buffer>();
  private patterns = new Map<string, Buffer>();
  private state: RedisPubSubState['state'] = 'idle';
  private reconnect: number | undefined;
  private error: string | undefined;
  private buffer: Buffered[] = [];
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
    // One size per entry, added here and taken off when it is sent: the byte cap never drifts.
    const size = Math.min(message.length, this.limits.pubsubPayloadBytes) + channel.length + (pattern?.length ?? 0);
    if (this.buffer.length >= this.limits.pubsubBuffer || this.bufferBytes + size > this.limits.pubsubBufferBytes) {
      this.droppedSince++;
      this.droppedTotal++;
    } else {
      const payload = blob(message, this.limits.pubsubPayloadBytes);
      this.buffer.push({ message: { channel: toData(channel), ...(pattern ? { pattern: toData(pattern) } : {}), time: this.opts.now?.() ?? Date.now(), payload }, size });
      this.bufferBytes += size;
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
    const sent = this.buffer.splice(0, this.limits.pubsubBatch);
    for (const b of sent) this.bufferBytes -= b.size;
    const dropped = this.droppedSince;
    this.droppedSince = 0;
    this.out.port({ t: 'redisPubSub', sessionId: this.sessionId, messages: sent.map((b) => b.message), dropped });
    if (this.buffer.length) this.schedule();
  }

  /** Bytes waiting for the renderer (tests). */
  get buffered(): number { return this.bufferBytes; }

  private async ensure(): Promise<Redis> {
    if (this.client) return this.client;
    if (this.opening) return this.opening;
    this.state = 'connecting';
    this.error = undefined;
    this.emitState();
    this.opening = (async () => {
      let opened: OpenedRedis;
      try { opened = await this.opts.openConnection(0); } catch (e) {
        this.state = 'closed';
        this.error = e instanceof RedisConnectError ? e.code : 'dbFailed';
        this.emitState();
        throw e instanceof RedisConnectError ? new OpError(e.code, e.serverMessage ? { message: e.serverMessage } : undefined) : e;
      } finally { this.opening = null; }
      if (this.sessionEnded()) { opened.client.disconnect(); throw new OpError('noSession'); }
      const c = opened.client;
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
        // The names stay: the next subscribe opens a new connection and subscribes all of them again.
        this.state = 'closed';
        this.reconnect = undefined;
        const e = opened.lastError();
        this.error = e ? mapRedisConnectError(e, this.opts.viaTunnel).code : 'dbClosed';
        if (!this.sessionEnded()) this.emitState();
      });
      // A connection opened after an earlier one ended takes over every name still listed.
      try { await this.resubscribe(c); } catch (e) { c.disconnect(); this.state = 'closed'; this.emitState(); throw e; }
      this.client = c;
      this.control = opened.control;
      opened.control.enabled = true;
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
      if (!channels.length && !patterns.length && this.client) return ok(this.snapshot());
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
    if (!this.channels.size && !this.patterns.size) {
      // Nothing left to listen to: the subscriber connection closes.
      this.client = null;
      if (this.control) this.control.enabled = false;
      this.control = null;
      c?.disconnect();
      this.state = 'idle';
      this.reconnect = undefined;
      this.error = undefined;
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
    this.bufferBytes = 0;
  }
}
