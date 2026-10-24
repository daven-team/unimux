// Starts the DB Host utility process on first use and supervises it like the SFTP Host (1.0.0): a crash fails what it was doing
// (pending requests answer 'dbHostCrashed', the sessions end) and the next use starts it again (more than 5 crashes in a minute:
// not again until the app restarts). Control messages only; result rows go host -> renderer directly over the DB port.
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { EventEmitter } from 'events';
import { join } from 'path';
import type { DbResult } from '../shared/db';
import type { DbHostOp, DbHostPortControl, DbHostToMain, MainToDbHost } from '../shared/dbHostIpc';

export const DB_STDERR_TAIL_BYTES = 8 * 1024;
/** How long main waits for an operation's answer (a run itself answers once accepted; its rows go to the port). */
export const dbOpTimeoutMs = (op: DbHostOp): number => {
  if (op.op === 'redis') {
    // Pattern counts and deletes walk the whole keyspace; a console command has its own (shorter) limit in the host.
    const k = op.req.kind;
    return k === 'countPattern' || k === 'deletePattern' ? 60 * 60_000 : k === 'command' ? 6 * 60_000 : k === 'write' || k === 'readItem' ? 5 * 60_000 : 2 * 60_000;
  }
  return op.op === 'applyEdits' || op.op === 'ddl' || op.op === 'databases' ? 10 * 60_000 : op.op === 'cellValue' ? 5 * 60_000 : 2 * 60_000;
};
/** The deadline a Redis operation carries: main's timeout less a margin (the answer must still reach main in time). */
export const redisDeadline = (now: number, timeoutMs: number): number => now + Math.max(1000, timeoutMs - Math.min(10_000, timeoutMs / 10));
export const DB_SHUTDOWN_WAIT_MS = 3000;

export interface DbHostLink {
  ensure(): boolean;
  running(): boolean;
  send(m: MainToDbHost): boolean;
  /** `window`: the window that asked (1.0.8; absent: the main window): the results on the DB port go there. */
  request(id: string, op: DbHostOp, window?: string): Promise<DbResult<unknown>>;
}

export class DbHostClient extends EventEmitter implements DbHostLink {
  private child: UtilityProcess | null = null;
  /** The windows with a port (1.0.8): 'main', and detached windows by id; connected again after a host restart. */
  private renderers = new Map<string, WebContents>();
  private crashes: number[] = [];
  private fatal = false;
  private shuttingDown = false;
  private stderrTail = '';
  private nextReq = 1;
  private pending = new Map<number, { resolve: (r: DbResult<unknown>) => void; timer: NodeJS.Timeout }>();

  running(): boolean { return !!this.child; }

  ensure(): boolean {
    if (this.child) return true;
    if (this.fatal || this.shuttingDown) return false;
    this.start();
    return true;
  }

  private start(): void {
    const child = utilityProcess.fork(join(__dirname, 'dbhost.js'), [], {
      serviceName: 'unimux DB Host',
      // Own pipes for both streams, never 'inherit' (an app started without a console crashed on that, 0.9.3/0.9.4).
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderrTail = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { try { process.stdout.write(String(chunk)); } catch { /* no console */ } });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      try { process.stderr.write(text); } catch { /* no console */ }
      if (this.child === child) this.stderrTail = (this.stderrTail + text).slice(-DB_STDERR_TAIL_BYTES);
    });
    child.on('message', (m: DbHostToMain) => {
      if (m.t === 'dbResult') {
        const p = this.pending.get(m.reqId);
        if (p) { clearTimeout(p.timer); this.pending.delete(m.reqId); p.resolve(m.result); }
        return;
      }
      this.emit('message', m);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending();
      if (this.shuttingDown) return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
      if (this.crashes.length > 5) this.fatal = true;
      this.emit('crashed', code, this.stderrTail);
    });
    for (const [window, wc] of [...this.renderers]) this.connectRenderer(wc, window);
  }

  private failPending(): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'dbHostCrashed' }); }
    this.pending.clear();
  }

  /** Gives a window its DB port (again after a reload or a host restart). `window`: 'main', or a detached window's id (1.0.8). */
  connectRenderer(wc: WebContents, window = 'main'): void {
    this.renderers.set(window, wc);
    if (!this.child || wc.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage(window === 'main' ? { t: 'port' } : { t: 'port', window }, [port1]);
    wc.postMessage('db-port', null, [port2]);
  }

  /** A detached window closed: a restarted host does not connect it again. */
  forgetRenderer(window: string): void {
    if (window !== 'main') this.renderers.delete(window);
  }

  /** Never log these messages: dbOpen and sshConnect carry secrets. False when no host runs. */
  send(m: MainToDbHost): boolean {
    if (!this.child) return false;
    this.child.postMessage(m);
    return true;
  }

  /** A tab moved to another window (1.0.8): the Pub/Sub messages of its sessions follow it (null: the main window). */
  route(sessions: string[], window: string | null): void {
    if (this.child && sessions.length) this.child.postMessage({ t: 'dbRoute', sessions, window } satisfies DbHostPortControl);
  }

  request(id: string, op: DbHostOp, window?: string): Promise<DbResult<unknown>> {
    if (!this.child) return Promise.resolve({ ok: false, error: 'noSession' });
    const reqId = this.nextReq++;
    const timeoutMs = dbOpTimeoutMs(op);
    // Redis operations carry the moment main gives up (with a margin): the host skips them when they only start later.
    const sent: DbHostOp = op.op === 'redis' ? { ...op, deadline: redisDeadline(Date.now(), timeoutMs) } : op;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); resolve({ ok: false, error: 'dbTimeout' }); }, timeoutMs);
      this.pending.set(reqId, { resolve, timer });
      this.child!.postMessage({ t: 'dbOp', reqId, id, op: sent, ...(window && window !== 'main' ? { window } : {}) } satisfies MainToDbHost);
    });
  }

  async shutdown(timeoutMs = DB_SHUTDOWN_WAIT_MS): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      child.on('message', (m: DbHostToMain) => { if (m.t === 'shutdownDone') { clearTimeout(timer); resolve(); } });
      child.postMessage({ t: 'shutdown' } satisfies MainToDbHost);
    });
    this.failPending();
    try { child.kill(); } catch { /* gone */ }
  }

  forceKill(): void {
    this.shuttingDown = true;
    try { this.child?.kill(); } catch { /* gone */ }
  }
}
