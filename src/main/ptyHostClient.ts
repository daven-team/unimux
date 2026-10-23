// Spawns and supervises the Pty Host utility process; restarts it if it crashes.
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { EventEmitter } from 'events';
import { join } from 'path';
import type { HostToMain, MainToHost, SpawnRequest } from '../shared/ipc';
import type { SshHostCommand } from './ssh/coordinator';

/** Messages kept while the Pty Host restarts (spawns of the cells the renderer starts again at once); more are dropped. */
export const RESTART_QUEUE_LIMIT = 500;
/** Bytes of the host's stderr kept for the crash log (node-pty's native assertion text ends up there). */
export const STDERR_TAIL_BYTES = 8 * 1024;

export class PtyHostClient extends EventEmitter {
  private child: UtilityProcess | null = null;
  private shuttingDown = false;
  private fatal = false;
  /** The renderer windows with a data port: 'main', and detached windows by id (1.0.6). */
  private renderers = new Map<string, WebContents>();
  /** Terminals routed to a detached window; sent again to a restarted host before the ports. */
  private routes = new Map<string, string>();
  private crashes: number[] = [];
  /** Control messages sent while no host runs between a crash and its restart; delivered once the new host is up. */
  private queue: MainToHost[] = [];
  private stderrTail = '';

  start(): void {
    const child = utilityProcess.fork(join(__dirname, 'ptyhost.js'), [], {
      serviceName: 'unimux Pty Host',
      // Both streams are our own pipes: with only stderr piped, Electron on Windows hands the host this process's stdout handle
      // unchecked, and an app started from a shortcut or the installer has none, so launching the host killed the app.
      // stderr is kept (the last few KB) for the crash log; both still reach the console of a development run.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderrTail = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      try { process.stdout.write(String(chunk)); } catch { /* no console */ }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      try { process.stderr.write(text); } catch { /* no console */ }
      if (this.child === child) this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
    });
    // Terminals of detached windows (1.0.6) keep their window across a host restart.
    for (const [id, window] of this.routes) child.postMessage({ t: 'route', id, window } satisfies MainToHost);
    child.on('message', (m: HostToMain) => this.emit('message', m));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.shuttingDown) return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
      if (this.crashes.length > 5) {
        this.fatal = true;
        this.queue = [];
        this.emit('fatal', code, this.stderrTail);
        return;
      }
      this.emit('crashed', code, this.stderrTail);
      setTimeout(() => {
        if (this.shuttingDown || this.fatal || this.child) return;
        this.restart();
      }, 500 * 2 ** (this.crashes.length - 1));
    });
  }

  /** Starts a new host, gives the renderer its data channel and delivers what was sent meanwhile. */
  private restart(): void {
    this.start();
    for (const [window, wc] of [...this.renderers]) if (!wc.isDestroyed()) this.connectRenderer(wc, window);
    const queued = this.queue;
    this.queue = [];
    for (const m of queued) this.child?.postMessage(m);
  }

  /** True after the host crashed too often; nothing runs until `restartAfterFatal`. */
  isFatal(): boolean { return this.fatal; }

  /** The user chose "Restart terminals" after the host crashed too often: the crash count starts again. */
  restartAfterFatal(): void {
    if (!this.fatal || this.shuttingDown) return;
    this.fatal = false;
    this.crashes = [];
    this.restart();
  }

  /**
   * Gives a renderer a direct data channel to the host (call again after a renderer reload). `window`: 'main', or the id of a
   * detached window (1.0.6), which gets only the terminals routed to it.
   */
  connectRenderer(wc: WebContents, window = 'main'): void {
    this.renderers.set(window, wc);
    if (!this.child || wc.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage(window === 'main' ? { t: 'port' } : { t: 'port', window }, [port1]);
    wc.postMessage('pty-port', null, [port2]);
  }

  /** A detached window closed: a restarted host does not connect it again. */
  forgetRenderer(window: string): void {
    if (window !== 'main') this.renderers.delete(window);
  }

  /** Routes a terminal's output to a detached window (null: the main window). */
  route(id: string, window: string | null): void {
    if (window === null) this.routes.delete(id); else this.routes.set(id, window);
    if (this.child) this.child.postMessage({ t: 'route', id, window } satisfies MainToHost);
  }

  private send(m: MainToHost): void {
    if (this.child) { this.child.postMessage(m); return; }
    // Between a crash and the restart: the renderer respawns its cells right away, which must not be lost.
    if (this.shuttingDown || this.fatal || this.queue.length >= RESTART_QUEUE_LIMIT) return;
    this.queue.push(m);
  }

  spawn(req: SpawnRequest): void {
    this.send({ t: 'spawn', req });
  }

  /** SSH control messages (they may carry secrets: never log them). False when no Pty Host runs (restarting or fatal). */
  sendSsh(m: SshHostCommand): boolean {
    if (!this.child) return false;
    this.child.postMessage(m);
    return true;
  }

  kill(id: string): void {
    this.send({ t: 'kill', id });
  }

  /** Kills a terminal and waits until its processes are gone (or `timeoutMs`). */
  killAndWait(id: string, timeoutMs = 4000): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('message', onMsg);
        resolve();
      };
      const onMsg = (m: HostToMain) => m.t === 'killed' && m.id === id && done();
      const timer = setTimeout(done, timeoutMs);
      this.on('message', onMsg);
      this.send({ t: 'kill', id, ack: true });
    });
  }

  /** Stops the host at once, without waiting for terminals (used when shutdown overran its limit). */
  forceKill(): void {
    this.shuttingDown = true;
    this.queue = [];
    try { this.child?.kill(); } catch { /* already gone */ }
  }

  /** Kills all terminals (waiting for ConPTY to wind down), then stops the host. */
  async shutdown(timeoutMs = 4000): Promise<void> {
    this.shuttingDown = true;
    this.queue = [];
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const onMsg = (m: HostToMain) => {
        if (m.t === 'killedAll') {
          clearTimeout(timer);
          resolve();
        }
      };
      child.on('message', onMsg);
      child.postMessage({ t: 'killAll' } satisfies MainToHost);
    });
    child.kill();
  }
}
