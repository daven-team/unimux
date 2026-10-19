// The DB Host (1.0.0): one session per "db:<uuid>" id. A session optionally logs in to an SSH host first (the tunnel; host key
// and auth questions go to main's coordinator like a cell's), then connects pg with the connection's TLS mode (prefer falls
// back to plain when the server has no TLS), asks main for the password when the server wants one and none is saved (or the
// saved one is refused), and finally runs the session's operations (PgSession). Independent of Electron (the process wrapper
// is index.ts) so it is tested in Node against PGlite, the fake server and the SSH test server.
import { randomUUID } from 'crypto';
import { connect as netConnect, isIP } from 'net';
import { checkServerIdentity, type ConnectionOptions } from 'tls';
import pg from 'pg';
import type { SshConnectRequest } from '../shared/ipc';
import type { DbErrorCode, DbPhase, DbPortMessage, DbResult } from '../shared/db';
import type { DbHostOp, DbHostToMain, DbOpenConfig, MainToDbHost } from '../shared/dbHostIpc';
import type { SshErrorCode } from '../shared/ssh';
import { PgSession, RAW_TYPES, serverError } from './pgSession';
import { SshTunnel, TUNNEL_TIMERS, type TunnelTimers } from './tunnel';

export interface DbHostTimers extends TunnelTimers {
  /** One database connect attempt (TCP, TLS and the server's startup). */
  dbConnectMs: number;
  /** How long a session waits for main's sshConnect (main may first ask for a key passphrase). */
  sshWaitMs: number;
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
  tunnel: SshTunnel | null;
  tunnelPort: number | null;
  sshWait: { resolve(req: SshConnectRequest | null): void; timer: NodeJS.Timeout } | null;
  passwordAsk: { promptId: string; resolve(value: string | null): void } | null;
  client: pg.Client | null;
  pg: PgSession | null;
  /** The password the connection used (side connections for cancel need it); dropped when the session ends. */
  password: string | undefined;
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
  private readonly timers: DbHostTimers;

  constructor(private readonly out: DbHostOutput, timers: Partial<DbHostTimers> = {}) {
    this.timers = { ...DB_HOST_TIMERS, ...timers };
  }

  has(id: string): boolean { return this.sessions.has(id); }

  async handle(m: MainToDbHost): Promise<void> {
    switch (m.t) {
      case 'dbOpen': this.open(m.id, m.config); break;
      case 'sshConnect': {
        const s = this.sessions.get(m.req.id);
        if (s?.sshWait) { const w = s.sshWait; s.sshWait = null; clearTimeout(w.timer); w.resolve(m.req); }
        break;
      }
      case 'sshHostKeyAnswer': this.sessions.get(m.id)?.tunnel?.answerHostKey(m.promptId, m.accept, m.error); break;
      case 'sshAuthAnswer': this.sessions.get(m.id)?.tunnel?.answerAuth(m.promptId, m.values); break;
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

  private status(s: Session, phase: DbPhase, extra: { error?: DbErrorCode; message?: string; serverVersion?: string; database?: string } = {}): void {
    s.phase = phase;
    this.out.toMain({ t: 'dbStatus', id: s.id, phase, ...extra });
  }

  // ── opening ────────────────────────────────────────────────────────────────

  open(id: string, config: DbOpenConfig): void {
    if (this.sessions.has(id)) this.close(id);
    const s: Session = { id, config, phase: 'connecting', ended: false, closing: false, tunnel: null, tunnelPort: null, sshWait: null, passwordAsk: null, client: null, pg: null, password: config.password };
    this.sessions.set(id, s);
    this.status(s, 'connecting');
    void this.start(s).catch(() => this.fail(s, 'dbFailed'));
  }

  private async start(s: Session): Promise<void> {
    if (s.config.kind !== 'postgres') { this.fail(s, 'unsupported'); return; }
    if (s.config.ssh) {
      const port = await this.openTunnel(s);
      if (port === null || !this.live(s)) return;
      s.tunnelPort = port;
    }
    this.status(s, 'database');
    const client = await this.connectWithPassword(s);
    if (!client || !this.live(s)) { if (client) void client.end().catch(() => undefined); return; }
    s.client = client;
    client.on('error', () => this.fail(s, s.tunnel?.lastForwardFailed ? 'tunnel' : 'dbClosed'));
    client.on('end', () => this.fail(s, 'dbClosed'));
    const pgSession = new PgSession(client, {
      readOnly: s.config.readOnly,
      statementTimeoutMs: s.config.statementTimeoutMs ?? 0,
      sideConnection: () => this.sideConnection(s),
      cancelRequest: (pid, secret) => this.cancelRequest(s, pid, secret),
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
    this.status(s, 'connected', { ...(serverVersion ? { serverVersion } : {}), database: s.config.database });
  }

  /** Waits for main's sshConnect, logs in and listens locally; null when it failed (the session already reads the error). */
  private async openTunnel(s: Session): Promise<number | null> {
    const req = await new Promise<SshConnectRequest | null>((resolve) => {
      s.sshWait = { resolve, timer: setTimeout(() => { s.sshWait = null; resolve(null); }, this.timers.sshWaitMs) };
    });
    if (!this.live(s)) return null;
    if (!req) { this.fail(s, 'timeout'); return null; }
    const target = s.config.ssh!;
    const tunnel = new SshTunnel(req, { host: target.dbHost, port: target.dbPort }, {
      phase: (phase) => { if (this.live(s)) { this.status(s, phase); this.out.toMain({ t: 'sshStatus', id: s.id, phase }); } },
      hostKey: (promptId, key) => this.out.toMain({ t: 'sshHostKey', id: s.id, promptId, key }),
      authPrompt: (promptId, prompt) => this.out.toMain({ t: 'sshAuthPrompt', id: s.id, promptId, ...prompt }),
      ended: (error) => {
        // Before the database connected, the tunnel's own error is the session's; afterwards the connection just dropped.
        if (!this.live(s)) return;
        if (error) this.out.toMain({ t: 'sshStatus', id: s.id, phase: 'error', error });
        this.fail(s, error ?? 'reset');
      },
      debug: (line) => console.log(`[db ${s.id.slice(3, 11)}] ${line}`),
    }, this.timers);
    s.tunnel = tunnel;
    this.out.toMain({ t: 'sshStatus', id: s.id, phase: 'connecting' });
    try {
      const port = await tunnel.start();
      if (this.live(s)) this.out.toMain({ t: 'sshStatus', id: s.id, phase: 'connected' });
      return port;
    } catch {
      return null; // ended() reported it
    }
  }

  private endpoint(s: Session): { host: string; port: number; logicalHost: string } {
    if (s.config.ssh && s.tunnelPort !== null) return { host: '127.0.0.1', port: s.tunnelPort, logicalHost: s.config.ssh.dbHost };
    return { host: s.config.host, port: s.config.port, logicalHost: s.config.host };
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
    s.tunnel?.allow(1);
    const client = new pg.Client({
      host, port, user: s.config.user, database: s.config.database,
      // Always a function: pg never falls back to PGPASSWORD or ~/.pgpass.
      password: async () => { if (password === undefined) throw new NeedPassword(); return password; },
      ssl: this.ssl(s, tlsOn) as never,
      connectionTimeoutMillis: this.timers.dbConnectMs,
      application_name: 'unimux', keepAlive: true, types: RAW_TYPES as never,
    });
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

  private async sideConnection(s: Session): Promise<pg.Client> {
    if (!this.live(s)) throw new Error('ended');
    const side = await this.connectTls(s, s.password);
    side.on('error', () => undefined);
    return side;
  }

  /** The protocol CancelRequest (pid and secret key of the backend) on a new plain connection. */
  private cancelRequest(s: Session, pid: number, secret: number): Promise<void> {
    const { host, port } = this.endpoint(s);
    s.tunnel?.allow(1);
    return new Promise((resolve, reject) => {
      const sock = netConnect({ host, port }, () => {
        const b = Buffer.alloc(16);
        b.writeInt32BE(16, 0);
        b.writeInt32BE(80877102, 4);
        b.writeInt32BE(pid, 8);
        b.writeInt32BE(secret, 12);
        sock.end(b);
        resolve();
      });
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
      sock.on('error', reject);
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
    const client = s.client;
    s.client = null;
    if (client) void client.end().catch(() => undefined);
    s.tunnel?.close();
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
    // Let the Terminate messages and the SSH disconnects go out.
    await new Promise((r) => setTimeout(r, 200));
  }

  // ── operations ─────────────────────────────────────────────────────────────

  async op(id: string, op: DbHostOp): Promise<DbResult<unknown>> {
    const s = this.sessions.get(id);
    if (!s || s.ended) return { ok: false, error: 'noSession' };
    if (!s.pg || s.phase !== 'connected') return { ok: false, error: 'notConnected' };
    return s.pg.handle(op);
  }
}
