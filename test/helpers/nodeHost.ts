// Dual host for the `.int` suites (docs/tauri/PLAN.md B1, docs/tauri/HOSTD.md): the same suite runs against the TS code in
// this process ("node") and against the Rust port through the unimux-hostd stdio binary ("rust"), so the suites and the
// Node fake servers (pgFakeServer, mysqlFakeServer, respServer, sshServer, pglite-socket) check the Rust code unchanged.
//
// Which hosts run: UNIMUX_HOST_TARGETS=node,rust (comma list). Default: node, plus rust when UNIMUX_HOSTD names a built
// binary. `npm run test:hostd` builds the binary and runs the rust host only.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import type { SpawnRequest } from '../../src/shared/ipc';

export type HostTarget = 'node' | 'rust';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function hostTargets(env: NodeJS.ProcessEnv = process.env): HostTarget[] {
  const list = env.UNIMUX_HOST_TARGETS?.split(',').map((t) => t.trim()).filter(Boolean);
  if (list?.length) {
    const bad = list.filter((t) => t !== 'node' && t !== 'rust');
    if (bad.length) throw new Error(`UNIMUX_HOST_TARGETS: unknown host ${bad.join(', ')} (node, rust)`);
    return [...new Set(list)] as HostTarget[];
  }
  return env.UNIMUX_HOSTD ? ['node', 'rust'] : ['node'];
}

/** The unimux-hostd binary: UNIMUX_HOSTD, else the debug build in CARGO_TARGET_DIR or src-tauri/target. */
export function hostdPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.UNIMUX_HOSTD) return resolve(env.UNIMUX_HOSTD);
  const target = env.CARGO_TARGET_DIR ? resolve(env.CARGO_TARGET_DIR) : join(ROOT, 'src-tauri', 'target');
  return join(target, 'debug', process.platform === 'win32' ? 'unimux-hostd.exe' : 'unimux-hostd');
}

/**
 * The folder with conpty.dll + OpenConsole.exe that node-pty uses (`useConptyDll`, the copy 1.1.4 ships), so both hosts run
 * on the same ConPTY build. UNIMUX_CONPTY_DIR wins.
 */
export function conptyDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.UNIMUX_CONPTY_DIR) return env.UNIMUX_CONPTY_DIR;
  const root = join(ROOT, 'node_modules', 'node-pty', 'third_party', 'conpty');
  if (!existsSync(root)) return undefined;
  const arch = process.arch === 'arm64' ? 'win10-arm64' : 'win10-x64';
  return readdirSync(root).sort().reverse().map((v) => join(root, v, arch)).find((d) => existsSync(join(d, 'conpty.dll')));
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; op: string }

/** One running unimux-hostd: JSON lines over stdio (src-tauri/crates/unimux-hostd/src/protocol.rs). */
export class HostdClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(args: any) => void>>();
  private stderr = '';
  private ended: Error | null = null;
  /** Resolves with the exit code once the process is gone. */
  readonly exited: Promise<number | null>;

  private constructor(private readonly proc: ChildProcessWithoutNullStreams, private readonly label: string) {
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => { this.stderr = (this.stderr + d).slice(-8000); });
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.onLine(line));
    this.exited = new Promise((resolveExit) => {
      proc.on('error', (error) => { this.fail(new Error(`${label}: ${error.message}`)); resolveExit(null); });
      proc.on('exit', (code, signal) => {
        this.fail(new Error(`${label} exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
        resolveExit(code);
      });
    });
    // stdin closing (close(), or this process ending) ends the host and its terminals.
    proc.unref();
  }

  /** Starts the binary (hostdPath() unless given); fails with a hint when it was not built. */
  static start(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): HostdClient {
    const path = opts.path ?? hostdPath();
    if (!existsSync(path)) throw new Error(`unimux-hostd not found at ${path}; build it with \`npm run test:hostd\` or \`npm run cargo -- build --manifest-path src-tauri/Cargo.toml -p unimux-hostd\``);
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    const dll = process.platform === 'win32' ? conptyDir(env) : undefined;
    if (dll) env.UNIMUX_CONPTY_DIR = dll;
    // All three pipes (never inherit mixed with pipe: a Windows start without a console must not attach one).
    const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    return new HostdClient(proc, 'unimux-hostd');
  }

  /** Wraps an already started process speaking the protocol (tests of the client itself). */
  static attach(proc: ChildProcessWithoutNullStreams, label = 'host'): HostdClient {
    return new HostdClient(proc, label);
  }

  get pid(): number | undefined { return this.proc.pid; }

  request<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    return new Promise<T>((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest as (v: unknown) => void, reject, op });
      this.proc.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  /** Listens for an event (`pty.data`, ...); returns the unsubscribe. */
  on(event: string, cb: (args: any) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Closes stdin (the host kills what it started and exits); kills the process after `timeoutMs`. */
  async close(timeoutMs = 8000): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.stdin.end();
      const timer = setTimeout(() => this.proc.kill(), timeoutMs);
      await this.exited;
      clearTimeout(timer);
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.stderr = (this.stderr + `\n[stdout] ${line}`).slice(-8000);
      return;
    }
    if (typeof msg.event === 'string') {
      for (const cb of [...(this.listeners.get(msg.event) ?? [])]) cb(msg.args);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(`${this.label} ${p.op}: ${msg.error}`));
  }

  private fail(error: Error): void {
    this.ended ??= error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}

/** PtyManager's sink (src/ptyhost/manager.ts PtySink). */
export interface PtySinkLike {
  data(id: string, data: string): unknown;
  exit(id: string, code: number): void;
}

/**
 * The PtyManager surface the suites use. On the node host the calls are synchronous as in 1.1.4; on the rust host they
 * are requests, so a suite awaits `has` / `histories` (awaiting works for both).
 */
export interface PtyHost {
  readonly target: HostTarget;
  spawn(req: SpawnRequest): number | Promise<number>;
  write(id: string, data: string): void | Promise<void>;
  resize(id: string, cols: number, rows: number): void | Promise<void>;
  has(id: string): boolean | Promise<boolean>;
  histories(): { id: string; data: string }[] | Promise<{ id: string; data: string }[]>;
  kill(id: string, timeoutMs?: number): Promise<void>;
  killAll(timeoutMs?: number): Promise<void>;
  /** Ends the host (rust: the hostd process with every terminal it still has; node: nothing). */
  close(): Promise<void>;
}

class RustPtyHost implements PtyHost {
  readonly target = 'rust' as const;
  constructor(private readonly host: HostdClient, sink: PtySinkLike) {
    host.on('pty.data', (a: { id: string; data: string }) => sink.data(a.id, a.data));
    host.on('pty.exit', (a: { id: string; code: number }) => sink.exit(a.id, a.code));
  }

  async spawn(req: SpawnRequest): Promise<number> {
    return (await this.host.request<{ pid: number }>('pty.spawn', { ...req })).pid;
  }

  async write(id: string, data: string): Promise<void> { await this.host.request('pty.write', { id, data }); }
  async resize(id: string, cols: number, rows: number): Promise<void> { await this.host.request('pty.resize', { id, cols, rows }); }
  has(id: string): Promise<boolean> { return this.host.request<boolean>('pty.has', { id }); }
  histories(): Promise<{ id: string; data: string }[]> { return this.host.request('pty.histories'); }
  async kill(id: string, timeoutMs?: number): Promise<void> { await this.host.request('pty.kill', { id, timeoutMs }); }
  async killAll(timeoutMs?: number): Promise<void> { await this.host.request('pty.killAll', { timeoutMs }); }
  close(): Promise<void> { return this.host.close(); }
}

/** A PtyManager on the chosen host. */
export async function createPtyManager(target: HostTarget, sink: PtySinkLike): Promise<PtyHost> {
  if (target === 'rust') return new RustPtyHost(HostdClient.start(), sink);
  // Loaded only for the node host: node-pty is a native module the rust-only runs (macOS CI) do not need.
  const { PtyManager } = await import('../../src/ptyhost/manager');
  const m = new PtyManager(sink);
  return {
    target: 'node',
    spawn: (req) => m.spawn(req),
    write: (id, data) => m.write(id, data),
    resize: (id, cols, rows) => m.resize(id, cols, rows),
    has: (id) => m.has(id),
    histories: () => m.histories(),
    kill: (id, timeoutMs) => m.kill(id, timeoutMs),
    killAll: (timeoutMs) => m.killAll(timeoutMs),
    close: async () => { await m.killAll(); },
  };
}
