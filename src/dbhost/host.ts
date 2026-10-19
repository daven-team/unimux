// The DB Host (1.0.0): one session per "db:<uuid>" id. A session optionally goes through an SSH tunnel (one per connection,
// shared and reference counted; its owner session logs it in, host key and auth questions go to main's coordinator like a
// cell's), then connects pg with the connection's TLS mode (prefer falls
// back to plain when the server has no TLS), asks main for the password when the server wants one and none is saved (or the
// saved one is refused), and finally runs the session's operations (PgSession). Redis sessions connect ioredis the same way
// (TLS modes, the forwarded channel as its stream, password prompts) and run RedisSession. Independent of Electron (the process wrapper
// is index.ts) so it is tested in Node against PGlite, the fake server and the SSH test server.
import { randomUUID } from 'crypto';
import { Socket, isIP } from 'net';
import type { Duplex } from 'stream';
import { TLSSocket, checkServerIdentity, connect as tlsConnect, type ConnectionOptions } from 'tls';
import pg from 'pg';
import type { SshConnectRequest } from '../shared/ipc';
import type { DbErrorCode, DbPhase, DbPortMessage, DbResult } from '../shared/db';
import type { DbHostOp, DbHostToMain, DbOpenConfig, MainToDbHost } from '../shared/dbHostIpc';
import type { SshErrorCode } from '../shared/ssh';
import { PgSession, RAW_TYPES, serverError } from './pgSession';
import { RedisConnectError, RedisSession, openRedis, type OpenedRedis, type RedisLimits } from './redisSession';
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

  constructor(private readonly out: DbHostOutput, timers: Partial<DbHostTimers> = {}, private readonly redisLimits?: Partial<RedisLimits>) {
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
    const s: Session = { id, config, phase: 'connecting', ended: false, closing: false, tunnel: null, sshWait: null, passwordAsk: null, client: null, pg: null, redis: null, redisTls: false, password: config.password };
    this.sessions.set(id, s);
    this.status(s, 'connecting');
    void this.start(s).catch(() => this.fail(s, 'dbFailed'));
  }

  private async start(s: Session): Promise<void> {
    if (s.config.kind !== 'postgres' && s.config.kind !== 'redis') { this.fail(s, 'unsupported'); return; }
    if (s.config.ssh) {
      if (!(await this.joinTunnel(s)) || !this.live(s)) return;
    }
    this.status(s, 'database');
    if (s.config.kind === 'redis') { await this.startRedis(s); return; }
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
      rec = { key: cfg.tunnelKey, owner: s.id, tunnel: null, state: 'waiting', ready, settle, refs: new Set() };
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
    const req = await new Promise<SshConnectRequest | null>((resolve) => {
      owner.sshWait = { resolve, timer: setTimeout(() => { owner.sshWait = null; resolve(null); }, this.timers.sshWaitMs) };
    });
    if (rec.state !== 'waiting') return;
    if (!req) { this.endTunnel(rec, this.live(owner) ? 'timeout' : 'cancelled'); return; }
    const target = owner.config.ssh!;
    const ownerLive = () => this.live(owner);
    const tunnel = new SshTunnel(req, { host: target.dbHost, port: target.dbPort }, {
      phase: (phase) => { if (ownerLive()) { this.status(owner, phase); this.out.toMain({ t: 'sshStatus', id: owner.id, phase }); } },
      hostKey: (promptId, key) => this.out.toMain({ t: 'sshHostKey', id: owner.id, promptId, key }),
      authPrompt: (promptId, prompt) => this.out.toMain({ t: 'sshAuthPrompt', id: owner.id, promptId, ...prompt }),
      ended: (error) => {
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
    if (rec.state !== 'waiting') { tunnel.close(); return; }
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
    // The owner gave up before the login finished, or nobody uses the tunnel any more: it closes.
    if (rec.refs.size === 0 || (rec.state === 'waiting' && rec.owner === s.id)) this.endTunnel(rec, 'cancelled');
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
    if (!s.pg || s.phase !== 'connected') return { ok: false, error: 'notConnected' };
    return s.pg.handle(op);
  }
}
