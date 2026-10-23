// The DB Host (1.0.0): one session per "db:<uuid>" id. A session optionally goes through an SSH tunnel (one per connection,
// shared and reference counted; its owner session logs it in, host key and auth questions go to main's coordinator like a
// cell's), then connects pg with the connection's TLS mode (prefer falls
// back to plain when the server has no TLS), asks main for the password when the server wants one and none is saved (or the
// saved one is refused), and finally runs the session's operations (PgSession). Redis sessions connect ioredis the same way
// (TLS modes, the forwarded channel as its stream, password prompts) and run RedisSession. Independent of Electron (the process wrapper
// is index.ts) so it is tested in Node against PGlite, the fake server and the SSH test server.
import { randomUUID } from 'crypto';
import { stat } from 'fs/promises';
import type { Worker } from 'worker_threads';
import { Socket, isIP } from 'net';
import type { Duplex } from 'stream';
import { TLSSocket, checkServerIdentity, connect as tlsConnect, type ConnectionOptions } from 'tls';
import pg from 'pg';
import mysql from 'mysql2';
import type { SshConnectRequest } from '../shared/ipc';
import { mysqlFlavorOf, mysqlServerLabel, type DbErrorCode, type DbPhase, type DbPortMessage, type DbResult } from '../shared/db';
import { mysqlTimeoutSql } from '../shared/dbMysql';
import type { DbHostOp, DbHostToMain, DbOpenConfig, MainToDbHost } from '../shared/dbHostIpc';
import type { SshErrorCode } from '../shared/ssh';
import { PgSession, RAW_TYPES, serverError } from './pgSession';
import { MysqlSession, mysqlServerError } from './mysqlSession';
import { RedisConnectError, RedisSession, openRedis, type OpenedRedis, type RedisLimits } from './redisSession';
import { SqliteError, SqliteSession, sqliteErrorCode } from './sqliteSession';
import { ForwardSocket, SshTunnel, TUNNEL_TIMERS, TunnelForwardError, type TunnelTimers } from './tunnel';

export interface DbHostTimers extends TunnelTimers {
  /** One database connect attempt (TCP, TLS and the server's startup). */
  dbConnectMs: number;
  /** How long a session waits for main's sshConnect (main may first ask for a key passphrase). */
  sshWaitMs: number;
  /** An open result cursor without fetchMore is closed after this long (default DB_LIMITS.cursorIdleMs). */
  cursorIdleMs?: number;
}
export const DB_HOST_TIMERS: DbHostTimers = { ...TUNNEL_TIMERS, dbConnectMs: 20_000, sshWaitMs: 6 * 60_000 };

/** How SQLite sessions start their engine thread (index.ts: the built worker; tests: the TypeScript file). */
export interface DbHostSqlite {
  spawn(interrupt: SharedArrayBuffer): Worker;
  killGraceMs?: number;
  busyMs?: number;
}

export interface DbHostOutput {
  toMain(m: DbHostToMain): void;
  /** The DB port (no renderer attached: the message is dropped). */
  toRenderer(m: DbPortMessage): void;
}

const MAX_PASSWORD_PROMPTS = 3;

class NeedPassword extends Error { constructor() { super('password needed'); } }

interface Session {
  id: string;
  config: DbOpenConfig;
  phase: DbPhase;
  ended: boolean;
  /** Closed on request: the end reads "closed". */
  closing: boolean;
  /** The shared tunnel this session uses (null: direct). */
  tunnel: TunnelRecord | null;
  sshWait: { resolve(req: SshConnectRequest | null): void; timer: NodeJS.Timeout } | null;
  passwordAsk: { promptId: string; resolve(value: string | null): void } | null;
  client: pg.Client | null;
  pg: PgSession | null;
  redis: RedisSession | null;
  /** MySQL / MariaDB: the connection and its session. */
  mysqlConn: mysql.Connection | null;
  mysql: MysqlSession | null;
  /** SQLite (1.0.6): the session and its engine thread. */
  sqlite: SqliteSession | null;
  /** Redis: the connection uses TLS (prefer resolved); the Pub/Sub connection connects the same way. */
  redisTls: boolean;
  /** The password the connection used (side connections for cancel need it); dropped when the session ends. */
  password: string | undefined;
}

/** One SSH tunnel of a connection, shared by its sessions; `owner` is the session whose login (sshConnect) opened it. */
interface TunnelRecord {
  key: string;
  owner: string;
  tunnel: SshTunnel | null;
  state: 'waiting' | 'ready' | 'ended';
  ready: Promise<void>;
  settle(error?: DbErrorCode | SshErrorCode): void;
  refs: Set<string>;
  /** The login attempt: a session that takes over the login of a closed owner starts a new one (the old one's events are dropped). */
  attempt: number;
}

/** pg and Node connect errors as the fixed codes the UI shows. */
export function mapConnectError(error: unknown, viaTunnel = false): DbErrorCode {
  if (error instanceof NeedPassword) return 'dbAuth';
  const server = serverError(error);
  if (server) {
    if (server.code === '28P01' || server.code === '28000') return 'dbAuth';
    if (server.code === '3D000') return 'dbNoDatabase';
    return 'dbFailed';
  }
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (code === 'ETUNNEL') return 'tunnel';
  if (/does not support SSL/i.test(message)) return 'dbTlsUnsupported';
  if (code === 'ECONNREFUSED') return viaTunnel ? 'tunnel' : 'dbRefused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dbDns';
  if (code === 'ETIMEDOUT' || /timeout/i.test(message)) return 'dbTimeout';
  if (/^ERR_TLS|^ERR_SSL|CERT|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME/.test(code) || /certificate|SSL|TLS/i.test(message)) return 'dbTls';
  if (/terminated unexpectedly|ECONNRESET|EPIPE/i.test(message + code)) return viaTunnel ? 'tunnel' : 'dbClosed';
  return 'dbFailed';
}

const ER_ACCESS_DENIED = 1045;
/** mysql2 and Node connect errors of a MySQL / MariaDB server as the fixed codes the UI shows. */
export function mapMysqlConnectError(error: unknown, viaTunnel = false): DbErrorCode {
  const e = (error ?? {}) as { code?: unknown; errno?: unknown; message?: unknown; fatal?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (typeof e.errno === 'number' && code.startsWith('ER_')) {
    // 1045 wrong password; 1044 no access to the database; 1698 (auth_socket and the like) and 1130 (host not allowed) refuse the login.
    if (e.errno === ER_ACCESS_DENIED || e.errno === 1044 || e.errno === 1698) return 'dbAuth';
    if (e.errno === 1049) return 'dbNoDatabase';
    if (e.errno === 1130) return 'dbRefused';
    return 'dbFailed';
  }
  if (code === 'ETUNNEL') return 'tunnel';
  if (code === 'HANDSHAKE_NO_SSL_SUPPORT') return 'dbTlsUnsupported';
  if (code === 'HANDSHAKE_SSL_ERROR') return 'dbTls';
  if (code === 'ECONNREFUSED') return viaTunnel ? 'tunnel' : 'dbRefused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dbDns';
  if (code === 'ETIMEDOUT' || /timeout/i.test(message)) return 'dbTimeout';
  if (/^ERR_TLS|^ERR_SSL|CERT|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME/.test(code) || /certificate|SSL|TLS/i.test(message)) return 'dbTls';
  if (/PROTOCOL_CONNECTION_LOST|ECONNRESET|EPIPE/.test(code)) return viaTunnel ? 'tunnel' : 'dbClosed';
  return 'dbFailed';
}

/** The detail of a MySQL connect error: the server's own text, or the TLS library's reason. */
function mysqlConnectMessage(error: unknown): string | undefined {
  const server = mysqlServerError(error)?.message;
  if (server) return server;
  return mapMysqlConnectError(error) === 'dbTls' && error instanceof Error ? error.message.slice(0, 500) : undefined;
}

/** The detail of a connect error: the server's own text, or the TLS library's reason (a certificate problem). */
function connectMessage(error: unknown): string | undefined {
  const server = serverError(error)?.message;
  if (server) return server;
  return mapConnectError(error) === 'dbTls' && error instanceof Error ? error.message.slice(0, 500) : undefined;
}

export class DbHost {
  private sessions = new Map<string, Session>();
  private tunnels = new Map<string, TunnelRecord>();
  private readonly timers: DbHostTimers;

  constructor(private readonly out: DbHostOutput, timers: Partial<DbHostTimers> = {}, private readonly redisLimits?: Partial<RedisLimits>, private readonly sqliteEngine?: DbHostSqlite) {
    this.timers = { ...DB_HOST_TIMERS, ...timers };
  }

  has(id: string): boolean { return this.sessions.has(id); }
  /** Tunnels alive or logging in (tests). */
  tunnelCount(): number { return this.tunnels.size; }

  private tunnelOf(ownerId: string): SshTunnel | null {
    for (const t of this.tunnels.values()) if (t.owner === ownerId) return t.tunnel;
    return null;
  }

  async handle(m: MainToDbHost): Promise<void> {
    switch (m.t) {
      case 'dbOpen': this.open(m.id, m.config); break;
      case 'sshConnect': {
        const s = this.sessions.get(m.req.id);
        if (s?.sshWait) { const w = s.sshWait; s.sshWait = null; clearTimeout(w.timer); w.resolve(m.req); }
        break;
      }
      case 'sshHostKeyAnswer': this.tunnelOf(m.id)?.answerHostKey(m.promptId, m.accept, m.error); break;
      case 'sshAuthAnswer': this.tunnelOf(m.id)?.answerAuth(m.promptId, m.values); break;
      case 'dbPasswordAnswer': {
        const s = this.sessions.get(m.id);
        if (s?.passwordAsk && s.passwordAsk.promptId === m.promptId) { const ask = s.passwordAsk; s.passwordAsk = null; ask.resolve(m.value); }
        break;
      }
      case 'dbOp': {
        let result: DbResult<unknown>;
        try { result = await this.op(m.id, m.op); } catch { result = { ok: false, error: 'dbFailed' }; }
        this.out.toMain({ t: 'dbResult', reqId: m.reqId, result });
        break;
      }
      case 'dbClose': this.close(m.id); break;
      case 'shutdown': await this.shutdown(); this.out.toMain({ t: 'shutdownDone' }); break;
    }
  }

  private live(s: Session): boolean { return this.sessions.get(s.id) === s && !s.ended; }

  private status(s: Session, phase: DbPhase, extra: { error?: DbErrorCode; message?: string; serverVersion?: string; database?: string; tls?: boolean; reconnect?: number } = {}): void {
    s.phase = phase;
    this.out.toMain({ t: 'dbStatus', id: s.id, phase, ...extra });
  }

  // ── opening ────────────────────────────────────────────────────────────────

  open(id: string, config: DbOpenConfig): void {
    if (this.sessions.has(id)) this.close(id);
    const s: Session = { id, config, phase: 'connecting', ended: false, closing: false, tunnel: null, sshWait: null, passwordAsk: null, client: null, pg: null, redis: null, mysqlConn: null, mysql: null, sqlite: null, redisTls: false, password: config.password };
    this.sessions.set(id, s);
    this.status(s, 'connecting');
    void this.start(s).catch(() => this.fail(s, 'dbFailed'));
  }

  private async start(s: Session): Promise<void> {
    if (s.config.kind !== 'postgres' && s.config.kind !== 'redis' && s.config.kind !== 'mysql' && s.config.kind !== 'sqlite') { this.fail(s, 'unsupported'); return; }
    if (s.config.kind === 'sqlite') { this.status(s, 'database'); await this.startSqlite(s); return; }
    if (s.config.ssh) {
      if (!(await this.joinTunnel(s)) || !this.live(s)) return;
    }
    this.status(s, 'database');
    if (s.config.kind === 'redis') { await this.startRedis(s); return; }
    if (s.config.kind === 'mysql') { await this.startMysql(s); return; }
    const client = await this.connectWithPassword(s);
    if (!client || !this.live(s)) { if (client) void client.end().catch(() => undefined); return; }
    s.client = client;
    client.on('error', () => this.fail(s, s.tunnel ? 'tunnel' : 'dbClosed'));
    client.on('end', () => this.fail(s, 'dbClosed'));
    const pgSession = new PgSession(client, {
      readOnly: s.config.readOnly,
      statementTimeoutMs: s.config.statementTimeoutMs ?? 0,
      sideConnection: () => this.sideConnection(s),
      cancelRequest: (pid, secret) => this.cancelRequest(s, pid, secret),
      fatal: () => this.fail(s, 'dbFailed'),
      ...(this.timers.cursorIdleMs !== undefined ? { cursorIdleMs: this.timers.cursorIdleMs } : {}),
    }, {
      port: (m) => this.out.toRenderer(m),
      tx: (tx) => { if (this.live(s)) this.out.toMain({ t: 'dbTx', id: s.id, tx }); },
      activity: (busy) => { if (this.live(s)) this.out.toMain({ t: 'dbActivity', id: s.id, busy }); },
    });
    let serverVersion: string | undefined;
    try {
      if (s.config.statementTimeoutMs) await client.query(`SET statement_timeout = ${Math.floor(s.config.statementTimeoutMs)}`);
      if (s.config.readOnly) await client.query('SET default_transaction_read_only = on');
      const v = await client.query({ text: 'SHOW server_version', rowMode: 'array', types: RAW_TYPES } as never) as unknown as { rows: string[][] };
      serverVersion = v.rows[0]?.[0]?.slice(0, 200);
      await pgSession.init();
    } catch (error) {
      if (this.live(s)) this.fail(s, mapConnectError(error), connectMessage(error));
      return;
    }
    if (!this.live(s)) return;
    s.pg = pgSession;
    const stream = (client as unknown as { connection: { stream: unknown } }).connection.stream;
    this.status(s, 'connected', { ...(serverVersion ? { serverVersion } : {}), database: s.config.database, tls: stream instanceof TLSSocket });
  }

  /**
   * The session's tunnel: the owner waits for main's sshConnect and logs in; other sessions of the connection wait for the
   * owner's tunnel. False when it failed (the session already reads the error).
   */
  private async joinTunnel(s: Session): Promise<boolean> {
    const cfg = s.config.ssh!;
    let rec = this.tunnels.get(cfg.tunnelKey);
    if (rec && rec.state === 'ended') { this.tunnels.delete(cfg.tunnelKey); rec = undefined; }
    if (!rec) {
      if (!cfg.owner) { this.fail(s, 'tunnel'); return false; }
      let settle!: TunnelRecord['settle'];
      const ready = new Promise<void>((resolve, reject) => { settle = (error) => (error ? reject(error) : resolve()); });
      ready.catch(() => undefined);
      rec = { key: cfg.tunnelKey, owner: s.id, tunnel: null, state: 'waiting', ready, settle, refs: new Set(), attempt: 0 };
      this.tunnels.set(cfg.tunnelKey, rec);
      void this.openTunnel(s, rec);
    }
    rec.refs.add(s.id);
    s.tunnel = rec;
    try { await rec.ready; } catch (error) {
      if (this.live(s)) this.fail(s, (error as DbErrorCode) ?? 'tunnel');
      return false;
    }
    return this.live(s);
  }

  private async openTunnel(owner: Session, rec: TunnelRecord): Promise<void> {
    const attempt = rec.attempt;
    // False once another session took the login over: this attempt's events no longer count.
    const mine = () => rec.attempt === attempt;
    const req = await new Promise<SshConnectRequest | null>((resolve) => {
      owner.sshWait = { resolve, timer: setTimeout(() => { owner.sshWait = null; resolve(null); }, this.timers.sshWaitMs) };
    });
    if (rec.state !== 'waiting' || !mine()) return;
    if (!req) { this.endTunnel(rec, this.live(owner) ? 'timeout' : 'cancelled'); return; }
    const target = owner.config.ssh!;
    const ownerLive = () => this.live(owner) && mine();
    const tunnel = new SshTunnel(req, { host: target.dbHost, port: target.dbPort }, {
      phase: (phase) => { if (ownerLive()) { this.status(owner, phase); this.out.toMain({ t: 'sshStatus', id: owner.id, phase }); } },
      hostKey: (promptId, key) => { if (mine()) this.out.toMain({ t: 'sshHostKey', id: owner.id, promptId, key }); },
      authPrompt: (promptId, prompt) => { if (mine()) this.out.toMain({ t: 'sshAuthPrompt', id: owner.id, promptId, ...prompt }); },
      ended: (error) => {
        if (!mine()) return;
        if (error && ownerLive()) this.out.toMain({ t: 'sshStatus', id: owner.id, phase: 'error', error });
        this.endTunnel(rec, error);
      },
      debug: (line) => console.log(`[db ${owner.id.slice(3, 11)}] ${line}`),
    }, this.timers);
    rec.tunnel = tunnel;
    if (ownerLive()) this.out.toMain({ t: 'sshStatus', id: owner.id, phase: 'connecting' });
    try {
      await tunnel.start();
    } catch { return; } // ended() reported it
    if (rec.state !== 'waiting' || !mine()) { tunnel.close(); return; }
    rec.state = 'ready';
    if (ownerLive()) this.out.toMain({ t: 'sshStatus', id: owner.id, phase: 'connected' });
    rec.settle();
  }

  /** The tunnel ended or could not start: every session on it ends (before connect: the tunnel's error is theirs). */
  private endTunnel(rec: TunnelRecord, error?: DbErrorCode | SshErrorCode): void {
    if (rec.state === 'ended') return;
    const before = rec.state === 'waiting';
    rec.state = 'ended';
    if (this.tunnels.get(rec.key) === rec) this.tunnels.delete(rec.key);
    rec.tunnel?.close();
    if (before) rec.settle(error ?? 'cancelled');
    for (const id of [...rec.refs]) { const s = this.sessions.get(id); if (s) this.fail(s, error ?? 'reset'); }
    rec.refs.clear();
  }

  private release(s: Session): void {
    const rec = s.tunnel;
    s.tunnel = null;
    if (!rec || rec.state === 'ended') return;
    rec.refs.delete(s.id);
    // Nobody uses the tunnel any more: it closes.
    if (rec.refs.size === 0) { this.endTunnel(rec, 'cancelled'); return; }
    // The owner was closed before the login finished while other sessions wait on the tunnel: one of them takes the login over.
    if (rec.state === 'waiting' && rec.owner === s.id) this.handOver(rec);
  }

  /**
   * A waiting session becomes the owner of a tunnel whose login is not finished: the old attempt is dropped, the new owner waits
   * for its own sshConnect, and main starts the coordinator's login for it ('dbTunnelOwner').
   */
  private handOver(rec: TunnelRecord): void {
    const next = [...rec.refs].map((id) => this.sessions.get(id)).find((x): x is Session => !!x && this.live(x));
    if (!next) { this.endTunnel(rec, 'cancelled'); return; }
    rec.attempt++;
    const old = rec.tunnel;
    rec.tunnel = null;
    old?.close();
    rec.owner = next.id;
    this.status(next, 'connecting');
    void this.openTunnel(next, rec);
    this.out.toMain({ t: 'dbTunnelOwner', id: next.id });
  }

  private endpoint(s: Session): { host: string; port: number; logicalHost: string } {
    if (s.config.ssh) return { host: s.config.ssh.dbHost, port: s.config.ssh.dbPort, logicalHost: s.config.ssh.dbHost };
    return { host: s.config.host, port: s.config.port, logicalHost: s.config.host };
  }

  /** A stream through the session's tunnel (null: direct connection). */
  private tunnelStream(s: Session): ForwardSocket | null {
    const t = s.tunnel?.tunnel;
    if (!s.config.ssh) return null;
    if (!t || !t.live()) throw new TunnelForwardError('tunnel closed');
    return t.socket();
  }

  private ssl(s: Session, on: boolean): false | ConnectionOptions {
    if (!on) return false;
    const { logicalHost } = this.endpoint(s);
    const servername = isIP(logicalHost) ? undefined : logicalHost;
    if (s.config.tls === 'verify-full') {
      return {
        ca: s.config.ca, rejectUnauthorized: true, ...(servername ? { servername } : {}),
        checkServerIdentity: (_host, cert) => checkServerIdentity(logicalHost, cert),
      };
    }
    return { rejectUnauthorized: false, ...(servername ? { servername } : {}) };
  }

  /** One pg client with the session's endpoint and TLS; `password` undefined: the server asking for one fails with NeedPassword. */
  private async connectOnce(s: Session, password: string | undefined, tlsOn: boolean): Promise<pg.Client> {
    const { host, port } = this.endpoint(s);
    // Through SSH pg gets the forwarded channel itself: no local port exists that anything else could connect to.
    const stream = this.tunnelStream(s);
    const client = new pg.Client({
      host, port, user: s.config.user, database: s.config.database,
      // Always a function: pg never falls back to PGPASSWORD or ~/.pgpass.
      password: async () => { if (password === undefined) throw new NeedPassword(); return password; },
      ssl: this.ssl(s, tlsOn) as never,
      connectionTimeoutMillis: this.timers.dbConnectMs,
      application_name: 'unimux', keepAlive: true, types: RAW_TYPES as never,
      ...(stream ? { stream: () => stream } : {}),
    } as never);
    // An error before connect() settled is reported by connect() itself.
    client.on('error', () => undefined);
    try {
      await client.connect();
      return client;
    } catch (error) {
      void client.end().catch(() => undefined);
      throw error;
    }
  }

  /** prefer: TLS first, plain when the server has none. */
  private async connectTls(s: Session, password: string | undefined): Promise<pg.Client> {
    const mode = s.config.tls;
    if (mode === 'disable') return this.connectOnce(s, password, false);
    try {
      return await this.connectOnce(s, password, true);
    } catch (error) {
      if (mode === 'prefer' && mapConnectError(error) === 'dbTlsUnsupported') return this.connectOnce(s, password, false);
      throw error;
    }
  }

  private async connectWithPassword(s: Session): Promise<pg.Client | null> {
    let password = s.config.password;
    let prompts = 0;
    for (;;) {
      if (!this.live(s)) return null;
      try {
        const client = await this.connectTls(s, password);
        s.password = password;
        return client;
      } catch (error) {
        if (!this.live(s)) return null;
        const needs = error instanceof NeedPassword || (password !== undefined && serverError(error)?.code === '28P01');
        if (!needs) { this.fail(s, mapConnectError(error, !!s.config.ssh), connectMessage(error)); return null; }
        if (prompts >= MAX_PASSWORD_PROMPTS) { this.fail(s, 'dbAuth', connectMessage(error)); return null; }
        const typed = await this.askPassword(s, password !== undefined);
        prompts++;
        if (!this.live(s)) return null;
        if (typed === null) { this.fail(s, 'cancelled'); return null; }
        password = typed;
      }
    }
  }

  private askPassword(s: Session, retry: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      const promptId = randomUUID();
      s.passwordAsk = { promptId, resolve };
      this.out.toMain({ t: 'dbPasswordPrompt', id: s.id, promptId, retry });
    });
  }

  // ── Redis ──────────────────────────────────────────────────────────────────

  /** One Redis connection with the session's endpoint, TLS and login (the main one or the Pub/Sub one). */
  private openRedisOnce(s: Session, password: string | undefined, tlsOn: boolean, dbIndex: number): Promise<OpenedRedis> {
    const { host, port } = this.endpoint(s);
    const tls = tlsOn ? this.ssl(s, true) as ConnectionOptions : null;
    return openRedis({
      host, port, tls, user: s.config.user, password, connectTimeoutMs: this.timers.dbConnectMs, viaTunnel: !!s.config.ssh, dbIndex,
      // Through SSH ioredis gets the forwarded channel itself (TLS on top of it): no local port exists, reconnects included.
      ...(s.config.ssh ? { stream: () => this.redisTunnelStream(s, tls) } : {}),
    });
  }

  /** A connected stream through the session's tunnel (TLS over it when on), for one Redis connect or reconnect. */
  private redisTunnelStream(s: Session, tls: ConnectionOptions | null): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      let sock: ForwardSocket;
      try { sock = this.tunnelStream(s)!; } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('connect ETIMEDOUT')); }, this.timers.dbConnectMs);
      const failed = (e: Error) => { clearTimeout(timer); reject(e); };
      sock.once('error', failed);
      sock.once('connect', () => {
        if (!tls) { clearTimeout(timer); sock.off('error', failed); resolve(sock); return; }
        const t = tlsConnect({ ...tls, socket: sock as unknown as Socket });
        t.once('error', failed);
        t.once('secureConnect', () => { clearTimeout(timer); sock.off('error', failed); t.off('error', failed); resolve(t); });
      });
      sock.connect();
    });
  }

  /** prefer: TLS first, plain when the TLS handshake fails (Redis has no TLS negotiation of its own). */
  private async openRedisTls(s: Session, password: string | undefined, dbIndex: number): Promise<OpenedRedis & { tls: boolean }> {
    const mode = s.config.tls;
    if (mode === 'disable') return { ...await this.openRedisOnce(s, password, false, dbIndex), tls: false };
    try {
      return { ...await this.openRedisOnce(s, password, true, dbIndex), tls: true };
    } catch (error) {
      const code = error instanceof RedisConnectError ? error.code : 'dbFailed';
      if (mode === 'prefer' && (code === 'dbTls' || code === 'dbClosed')) return { ...await this.openRedisOnce(s, password, false, dbIndex), tls: false };
      throw error;
    }
  }

  private async startRedis(s: Session): Promise<void> {
    const dbIndex = Number(s.config.database) || 0;
    let password = s.config.password;
    let prompts = 0;
    let opened: (OpenedRedis & { tls: boolean }) | null = null;
    // An ACL user without a saved password is asked first: connecting as the default user instead would be someone else.
    if (s.config.user && password === undefined) {
      const typed = await this.askPassword(s, false);
      prompts++;
      if (!this.live(s)) return;
      if (typed === null) { this.fail(s, 'cancelled'); return; }
      password = typed;
    }
    while (!opened) {
      if (!this.live(s)) return;
      try {
        opened = await this.openRedisTls(s, password, dbIndex);
      } catch (error) {
        if (!this.live(s)) return;
        const e = error instanceof RedisConnectError ? error : new RedisConnectError('dbFailed');
        const code = e.code;
        if (code !== 'dbAuth') { this.fail(s, code, e.serverMessage); return; }
        if (prompts >= MAX_PASSWORD_PROMPTS) { this.fail(s, 'dbAuth', e.serverMessage); return; }
        const typed = await this.askPassword(s, password !== undefined);
        prompts++;
        if (!this.live(s)) return;
        if (typed === null) { this.fail(s, 'cancelled'); return; }
        password = typed;
      }
    }
    if (!this.live(s)) { opened.client.disconnect(); return; }
    s.password = password;
    s.redisTls = opened.tls;
    const redis = new RedisSession(opened.client, opened.control, {
      sessionId: s.id, readOnly: s.config.readOnly, dbIndex, viaTunnel: !!s.config.ssh, ...(this.redisLimits ? { limits: this.redisLimits } : {}),
      openConnection: (db) => this.openRedisOnce(s, s.password, s.redisTls, db),
    }, {
      port: (m) => this.out.toRenderer(m),
      activity: (busy) => { if (this.live(s)) this.out.toMain({ t: 'dbActivity', id: s.id, busy }); },
      reconnecting: (attempt) => { if (this.live(s)) this.status(s, 'database', { reconnect: attempt }); },
      reconnected: () => { if (this.live(s)) this.status(s, 'connected', { database: String(redis.currentDb) }); },
      closed: (error, message) => this.fail(s, error, message),
      database: (index) => { if (this.live(s)) this.out.toMain({ t: 'dbDatabase', id: s.id, database: String(index) }); },
    }, opened.lastError);
    s.redis = redis;
    this.status(s, 'connected', { ...(opened.serverVersion ? { serverVersion: opened.serverVersion } : {}), database: String(dbIndex), tls: opened.tls });
  }

  // ── SQLite ─────────────────────────────────────────────────────────────────

  /** Opens the database file (it must exist: a moved file is never replaced by a new empty one) in an engine thread of its own. */
  private async startSqlite(s: Session): Promise<void> {
    const path = s.config.path;
    if (!this.sqliteEngine || !path) { this.fail(s, 'unsupported'); return; }
    try {
      const info = await stat(path);
      if (!info.isFile()) { this.fail(s, 'dbFileMissing', path); return; }
    } catch { this.fail(s, 'dbFileMissing', path); return; }
    if (!this.live(s)) return;
    const sqlite = new SqliteSession({
      path, readOnly: s.config.readOnly, spawn: (flag) => this.sqliteEngine!.spawn(flag),
      fatal: (error, message) => this.fail(s, error, message),
      ...(this.sqliteEngine.killGraceMs !== undefined ? { killGraceMs: this.sqliteEngine.killGraceMs } : {}),
      ...(this.sqliteEngine.busyMs !== undefined ? { busyMs: this.sqliteEngine.busyMs } : {}),
      ...(this.timers.cursorIdleMs !== undefined ? { cursorIdleMs: this.timers.cursorIdleMs } : {}),
    }, {
      port: (m) => this.out.toRenderer(m),
      tx: (tx) => { if (this.live(s)) this.out.toMain({ t: 'dbTx', id: s.id, tx }); },
      activity: (busy) => { if (this.live(s)) this.out.toMain({ t: 'dbActivity', id: s.id, busy }); },
      notice: (message) => this.out.toMain({ t: 'log', level: 'warn', message: `[db ${s.id.slice(3, 11)}] ${message}` }),
    });
    s.sqlite = sqlite;
    try {
      await sqlite.connect();
    } catch (error) {
      s.sqlite = null;
      if (this.live(s)) this.fail(s, error instanceof SqliteError ? sqliteErrorCode(error.info) : 'dbFailed', error instanceof Error ? error.message : undefined);
      return;
    }
    if (!this.live(s)) { sqlite.end(); return; }
    // No tls: a file on this computer is not a network connection (the tab shows no encryption badge).
    this.status(s, 'connected', { serverVersion: `SQLite ${sqlite.serverVersion}`, database: 'main' });
  }

  // ── MySQL / MariaDB ────────────────────────────────────────────────────────

  /**
   * One mysql2 connection with the session's endpoint, TLS and login. Through SSH it rides the forwarded channel (no local
   * port). verify-full checks the chain against the CA and the certificate against the host name (IP addresses included)
   * before the login goes out: mysql2 alone skips the name for IP addresses.
   */
  private openMysqlOnce(s: Session, password: string, tlsOn: boolean, database: string): Promise<mysql.Connection> {
    const { host, port, logicalHost } = this.endpoint(s);
    let stream: ForwardSocket | null;
    try { stream = this.tunnelStream(s); } catch (e) { return Promise.reject(e); }
    stream?.connect();
    const verify = tlsOn && s.config.tls === 'verify-full';
    const conn = mysql.createConnection({
      host: logicalHost, port, user: s.config.user, password, ...(database ? { database } : {}),
      charset: 'utf8mb4', connectTimeout: this.timers.dbConnectMs, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
      multipleStatements: false, enableKeepAlive: true,
      ...(tlsOn ? { ssl: verify ? { ca: s.config.ca, rejectUnauthorized: true, verifyIdentity: false } : { rejectUnauthorized: false } } : {}),
      ...(stream ? { stream } : { host }),
    } as mysql.ConnectionOptions);
    if (verify) {
      const c = conn as unknown as { startTLS(onSecure: (err?: Error) => void): void; stream: TLSSocket };
      const startTLS = c.startTLS.bind(conn);
      c.startTLS = (onSecure) => startTLS((err) => {
        if (err) { onSecure(err); return; }
        const identity = checkServerIdentity(logicalHost, c.stream.getPeerCertificate());
        onSecure(identity ?? undefined);
      });
    }
    // Errors after connect go to the session's handlers; one before is connect()'s.
    conn.on('error', () => undefined);
    return new Promise((resolve, reject) => {
      conn.connect((err) => {
        if (err) { try { conn.destroy(); } catch { /* gone */ } reject(err); return; }
        resolve(conn);
      });
    });
  }

  /** prefer: TLS first, plain when the server has none. */
  private async openMysqlTls(s: Session, password: string, database: string): Promise<{ conn: mysql.Connection; tls: boolean }> {
    const mode = s.config.tls;
    if (mode === 'disable') return { conn: await this.openMysqlOnce(s, password, false, database), tls: false };
    try {
      return { conn: await this.openMysqlOnce(s, password, true, database), tls: true };
    } catch (error) {
      if (mode === 'prefer' && mapMysqlConnectError(error) === 'dbTlsUnsupported') return { conn: await this.openMysqlOnce(s, password, false, database), tls: false };
      throw error;
    }
  }

  private async startMysql(s: Session): Promise<void> {
    // No saved password: an empty one first (a server without one for this user logs in); refused, the user is asked.
    let password = s.config.password;
    let prompts = 0;
    let opened: { conn: mysql.Connection; tls: boolean } | null = null;
    while (!opened) {
      if (!this.live(s)) return;
      try {
        opened = await this.openMysqlTls(s, password ?? '', s.config.database);
      } catch (error) {
        if (!this.live(s)) return;
        const code = mapMysqlConnectError(error, !!s.config.ssh);
        const wrongPassword = (error as { errno?: unknown }).errno === ER_ACCESS_DENIED;
        if (!wrongPassword) { this.fail(s, code, mysqlConnectMessage(error)); return; }
        if (prompts >= MAX_PASSWORD_PROMPTS) { this.fail(s, 'dbAuth', mysqlConnectMessage(error)); return; }
        const typed = await this.askPassword(s, password !== undefined);
        prompts++;
        if (!this.live(s)) return;
        if (typed === null) { this.fail(s, 'cancelled'); return; }
        password = typed;
      }
    }
    const conn = opened.conn;
    if (!this.live(s)) { conn.destroy(); return; }
    s.password = password ?? '';
    s.mysqlConn = conn;
    const query = (sql: string) => new Promise<unknown[][]>((resolve, reject) => {
      conn.query({ sql, rowsAsArray: true }, (err, rows) => (err ? reject(err) : resolve(Array.isArray(rows) ? rows as unknown[][] : [])));
    });
    let version = '';
    let comment = '';
    let database = s.config.database;
    try {
      const row = (await query('SELECT VERSION(), @@version_comment, DATABASE()'))[0] ?? [];
      version = String(row[0] ?? '');
      comment = String(row[1] ?? '');
      database = row[2] === null || row[2] === undefined ? '' : String(row[2]);
    } catch (error) {
      if (this.live(s)) this.fail(s, mapMysqlConnectError(error), mysqlConnectMessage(error));
      return;
    }
    const flavor = mysqlFlavorOf(version, comment);
    try {
      if (s.config.readOnly) await query('SET SESSION TRANSACTION READ ONLY');
      if (s.config.statementTimeoutMs) await query(mysqlTimeoutSql(flavor, s.config.statementTimeoutMs));
    } catch (error) {
      // A read-only connection that cannot be made read-only on the server is not opened.
      if (this.live(s)) this.fail(s, 'dbFailed', mysqlConnectMessage(error));
      return;
    }
    if (!this.live(s)) return;
    conn.on('error', () => this.fail(s, s.tunnel ? 'tunnel' : 'dbClosed'));
    conn.on('end', () => this.fail(s, 'dbClosed'));
    s.mysql = new MysqlSession(conn, {
      readOnly: s.config.readOnly, statementTimeoutMs: s.config.statementTimeoutMs ?? 0, flavor,
      sideConnection: () => this.mysqlSide(s),
      fatal: () => this.fail(s, 'dbFailed'),
      ...(this.timers.cursorIdleMs !== undefined ? { cursorIdleMs: this.timers.cursorIdleMs } : {}),
    }, {
      port: (m) => this.out.toRenderer(m),
      tx: (tx) => { if (this.live(s)) this.out.toMain({ t: 'dbTx', id: s.id, tx }); },
      activity: (busy) => { if (this.live(s)) this.out.toMain({ t: 'dbActivity', id: s.id, busy }); },
      database: (name) => { if (this.live(s)) this.out.toMain({ t: 'dbDatabase', id: s.id, database: name }); },
    });
    this.status(s, 'connected', { ...(version ? { serverVersion: mysqlServerLabel(version, comment) } : {}), database, tls: opened.tls });
  }

  /** A second connection for KILL QUERY (no default database: it may be gone meanwhile). */
  private async mysqlSide(s: Session): Promise<mysql.Connection> {
    if (!this.live(s)) throw new Error('ended');
    const side = (await this.openMysqlTls(s, s.password ?? '', '')).conn;
    side.on('error', () => undefined);
    return side;
  }

  private async sideConnection(s: Session): Promise<pg.Client> {
    if (!this.live(s)) throw new Error('ended');
    const side = await this.connectTls(s, s.password);
    side.on('error', () => undefined);
    return side;
  }

  /** The protocol CancelRequest (pid and secret key of the backend) on a new plain connection (through the tunnel when there is one). */
  private cancelRequest(s: Session, pid: number, secret: number): Promise<void> {
    const { host, port } = this.endpoint(s);
    return new Promise((resolve, reject) => {
      const b = Buffer.alloc(16);
      b.writeInt32BE(16, 0);
      b.writeInt32BE(80877102, 4);
      b.writeInt32BE(pid, 8);
      b.writeInt32BE(secret, 12);
      let tunnelSock: ForwardSocket | null;
      try { tunnelSock = this.tunnelStream(s); } catch (e) { reject(e); return; }
      const sock: Duplex = tunnelSock ?? new Socket();
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 5000);
      sock.once('connect', () => { clearTimeout(timer); sock.end(b); resolve(); });
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
      if (tunnelSock) tunnelSock.connect(); else (sock as Socket).connect({ host, port });
    });
  }

  // ── ending ─────────────────────────────────────────────────────────────────

  private fail(s: Session, error: DbErrorCode | SshErrorCode, message?: string): void {
    if (!this.live(s)) return;
    this.finish(s, s.closing ? undefined : error, message);
  }

  private finish(s: Session, error: DbErrorCode | undefined, message?: string): void {
    s.ended = true;
    this.sessions.delete(s.id);
    if (s.sshWait) { clearTimeout(s.sshWait.timer); const w = s.sshWait; s.sshWait = null; w.resolve(null); }
    if (s.passwordAsk) { const a = s.passwordAsk; s.passwordAsk = null; a.resolve(null); }
    s.pg?.end();
    s.redis?.end();
    s.redis = null;
    s.sqlite?.end();
    s.sqlite = null;
    const my = s.mysqlConn;
    const busy = s.mysql?.busy() ?? false;
    s.mysql?.end();
    s.mysql = null;
    s.mysqlConn = null;
    if (my) {
      // An idle connection says goodbye (COM_QUIT); one with a statement or an open result on it is cut.
      if (busy) my.destroy();
      else { my.end(() => undefined); setTimeout(() => { try { my.destroy(); } catch { /* gone */ } }, 2000).unref?.(); }
    }
    const client = s.client;
    s.client = null;
    if (client) void client.end().catch(() => undefined);
    this.release(s);
    s.password = undefined;
    delete s.config.password;
    if (error) this.status(s, 'error', { error, ...(message ? { message: message.slice(0, 2000) } : {}) });
    else this.status(s, 'closed');
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.ended) return;
    s.closing = true;
    this.finish(s, undefined);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.close(id);
    for (const rec of [...this.tunnels.values()]) this.endTunnel(rec, 'cancelled');
    // Let the Terminate messages and the SSH disconnects go out.
    await new Promise((r) => setTimeout(r, 200));
  }

  // ── operations ─────────────────────────────────────────────────────────────

  async op(id: string, op: DbHostOp): Promise<DbResult<unknown>> {
    const s = this.sessions.get(id);
    if (!s || s.ended) return { ok: false, error: 'noSession' };
    if (s.config.kind === 'redis') {
      if (op.op !== 'redis') return { ok: false, error: 'invalid' };
      if (!s.redis || s.phase !== 'connected') return { ok: false, error: 'notConnected' };
      return s.redis.handle(op.req, op.deadline);
    }
    if (op.op === 'redis') return { ok: false, error: 'invalid' };
    if (s.config.kind === 'sqlite') {
      if (!s.sqlite || s.phase !== 'connected') return { ok: false, error: 'notConnected' };
      return s.sqlite.handle(op);
    }
    if (s.config.kind === 'mysql') {
      if (!s.mysql || s.phase !== 'connected') return { ok: false, error: 'notConnected' };
      return s.mysql.handle(op);
    }
    if (!s.pg || s.phase !== 'connected') return { ok: false, error: 'notConnected' };
    return s.pg.handle(op);
  }
}
