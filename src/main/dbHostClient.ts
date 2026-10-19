// Starts the DB Host utility process on first use and supervises it like the SFTP Host (1.0.0): a crash fails what it was doing
// (pending requests answer 'dbHostCrashed', the sessions end) and the next use starts it again (more than 5 crashes in a minute:
// not again until the app restarts). Control messages only; result rows go host -> renderer directly over the DB port.
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { EventEmitter } from 'events';
import { join } from 'path';
import type { DbResult } from '../shared/db';
import type { DbHostOp, DbHostToMain, MainToDbHost } from '../shared/dbHostIpc';

export const DB_STDERR_TAIL_BYTES = 8 * 1024;
/** How long main waits for an operation's answer (a run itself answers once accepted; its rows go to the port). */
export const dbOpTimeoutMs = (op: DbHostOp): number => (op.op === 'applyEdits' || op.op === 'ddl' || op.op === 'databases' ? 10 * 60_000 : op.op === 'cellValue' ? 5 * 60_000 : 2 * 60_000);
export const DB_SHUTDOWN_WAIT_MS = 3000;

export interface DbHostLink {
  ensure(): boolean;
  running(): boolean;
  send(m: MainToDbHost): boolean;
  request(id: string, op: DbHostOp): Promise<DbResult<unknown>>;
}

export class DbHostClient extends EventEmitter implements DbHostLink {
  private child: UtilityProcess | null = null;
  private renderer: WebContents | null = null;
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
    if (this.renderer) this.connectRenderer(this.renderer);
  }

  private failPending(): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'dbHostCrashed' }); }
    this.pending.clear();
  }

  /** Gives the renderer the DB port (again after a renderer reload or a host restart). */
  connectRenderer(wc: WebContents): void {
    this.renderer = wc;
    if (!this.child || wc.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ t: 'port' }, [port1]);
    wc.postMessage('db-port', null, [port2]);
  }

  /** Never log these messages: dbOpen and sshConnect carry secrets. False when no host runs. */
  send(m: MainToDbHost): boolean {
    if (!this.child) return false;
    this.child.postMessage(m);
    return true;
  }

  request(id: string, op: DbHostOp): Promise<DbResult<unknown>> {
    if (!this.child) return Promise.resolve({ ok: false, error: 'noSession' });
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); resolve({ ok: false, error: 'dbTimeout' }); }, dbOpTimeoutMs(op));
      this.pending.set(reqId, { resolve, timer });
      this.child!.postMessage({ t: 'dbOp', reqId, id, op } satisfies MainToDbHost);
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
