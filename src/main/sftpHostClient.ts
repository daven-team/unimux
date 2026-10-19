// Starts the SFTP Host utility process on first use and supervises it like the Pty Host: a crash fails what it was doing
// (pending requests answer 'sftpHostCrashed', the sessions end), and the next use starts it again (more than 5 crashes in a
// minute: it is not started again until the app restarts). Control messages only; progress goes host -> renderer directly.
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { EventEmitter } from 'events';
import { join } from 'path';
import type { SftpResult } from '../shared/sftp';
import type { MainToSftpHost, SftpHostToMain, SftpOp } from '../shared/sftpHostIpc';

export const SFTP_STDERR_TAIL_BYTES = 8 * 1024;

/**
 * How long main waits for an operation; null: no limit. An enqueue walks a folder and may take long: it has no limit here (a
 * timeout would answer 'failed' while the host goes on and adds the items later) and ends with the session, a host crash or
 * cancel({ batchId }) for the batchId the view chose.
 */
export const opTimeoutMs = (op: SftpOp): number | null => (op.op === 'enqueue' ? null
  : op.op === 'delete' || op.op === 'deleteCount' ? 10 * 60_000
    // An editor tab reads or writes up to 8 MB in one request (a slow link needs minutes).
    : op.op === 'readFile' || op.op === 'writeFile' ? 5 * 60_000 : 60_000);
/** Main waits this long for the host to close its sessions at app shutdown (the host itself takes at most about 2 s). */
export const SFTP_SHUTDOWN_WAIT_MS = 4000;

export interface SftpHostLink {
  /** Starts the host when it does not run; false when it may not (crashed too often, shutting down). */
  ensure(): boolean;
  running(): boolean;
  send(m: MainToSftpHost): boolean;
  request(id: string, op: SftpOp): Promise<SftpResult<unknown>>;
}

export class SftpHostClient extends EventEmitter implements SftpHostLink {
  private child: UtilityProcess | null = null;
  private renderer: WebContents | null = null;
  private crashes: number[] = [];
  private fatal = false;
  private shuttingDown = false;
  private stderrTail = '';
  private nextReq = 1;
  private pending = new Map<number, { resolve: (r: SftpResult<unknown>) => void; timer: NodeJS.Timeout | null }>();

  running(): boolean { return !!this.child; }

  ensure(): boolean {
    if (this.child) return true;
    if (this.fatal || this.shuttingDown) return false;
    this.start();
    return true;
  }

  private start(): void {
    const child = utilityProcess.fork(join(__dirname, 'sftphost.js'), [], {
      serviceName: 'unimux SFTP Host',
      // Own pipes for both streams, never 'inherit' (an app started without a console crashed on that, 0.9.3/0.9.4).
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderrTail = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { try { process.stdout.write(String(chunk)); } catch { /* no console */ } });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      try { process.stderr.write(text); } catch { /* no console */ }
      if (this.child === child) this.stderrTail = (this.stderrTail + text).slice(-SFTP_STDERR_TAIL_BYTES);
    });
    child.on('message', (m: SftpHostToMain) => {
      if (m.t === 'sftpResult') {
        const p = this.pending.get(m.reqId);
        if (p) { if (p.timer) clearTimeout(p.timer); this.pending.delete(m.reqId); p.resolve(m.result); }
        return;
      }
      this.emit('message', m);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending('sftpHostCrashed');
      if (this.shuttingDown) return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
      if (this.crashes.length > 5) this.fatal = true;
      this.emit('crashed', code, this.stderrTail);
    });
    if (this.renderer) this.connectRenderer(this.renderer);
  }

  private failPending(error: 'sftpHostCrashed'): void {
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.resolve({ ok: false, error }); }
    this.pending.clear();
  }

  /** Gives the renderer the transfer port (again after a renderer reload or a host restart). */
  connectRenderer(wc: WebContents): void {
    this.renderer = wc;
    if (!this.child || wc.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ t: 'port' }, [port1]);
    wc.postMessage('sftp-port', null, [port2]);
  }

  /** Never log these messages: sshConnect carries secrets. False when no host runs. */
  send(m: MainToSftpHost): boolean {
    if (!this.child) return false;
    this.child.postMessage(m);
    return true;
  }

  request(id: string, op: SftpOp): Promise<SftpResult<unknown>> {
    if (!this.child) return Promise.resolve({ ok: false, error: 'noSession' });
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      const ms = opTimeoutMs(op);
      const timer = ms === null ? null : setTimeout(() => { this.pending.delete(reqId); resolve({ ok: false, error: 'failed' }); }, ms);
      this.pending.set(reqId, { resolve, timer });
      this.child!.postMessage({ t: 'sftpOp', reqId, id, op } satisfies MainToSftpHost);
    });
  }

  /** Ends every session (closing the connections cleanly) and stops the host. */
  async shutdown(timeoutMs = SFTP_SHUTDOWN_WAIT_MS): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      child.on('message', (m: SftpHostToMain) => { if (m.t === 'shutdownDone') { clearTimeout(timer); resolve(); } });
      child.postMessage({ t: 'shutdown' } satisfies MainToSftpHost);
    });
    this.failPending('sftpHostCrashed');
    try { child.kill(); } catch { /* gone */ }
  }

  forceKill(): void {
    this.shuttingDown = true;
    try { this.child?.kill(); } catch { /* gone */ }
  }
}
