// Owns every pseudo-terminal. Independent of Electron so it can be integration-tested in Node.
import { spawn as spawnProcess } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import * as pty from 'node-pty';
import type { SpawnRequest } from '../shared/ipc';
import type { ShellKind } from '../shared/types';
import { OutputChannel } from './output';
import type { TerminalBackend } from './router';

export interface PtySink {
  /**
   * Returns false when nobody received the data (no renderer connected). `echo`: the answer to a keystroke, sent at once
   * instead of with the rest of this event-loop turn's output.
   */
  data(id: string, data: string, echo?: boolean): unknown;
  exit(id: string, code: number): void;
}

interface Entry {
  proc: pty.IPty;
  /** Coalescing, replay tail, back-pressure and the exit drain of this terminal's output. */
  out: OutputChannel;
  exited: Promise<void>;
}

/**
 * Ends a terminal's process tree (the shell and whatever it started). Only ever called for a terminal whose exit node-pty has
 * not reported yet: node-pty still holds its process, so the pid cannot belong to another program.
 */
export function killTerminalTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    else process.kill(-pid, 'SIGKILL'); // the pty shell leads its own session and process group
  } catch { /* already gone */ }
}

/** Full path of `exe` in the PATH of `env` (the cell's PATH, which may be newer than this process's own); null when absent. */
function findOnPath(exe: string, env: Record<string, string>): string | null {
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return null;
}

export function resolveShell(kind: ShellKind, env: Record<string, string>, platform = process.platform): { file: string; args: string[] } {
  if (platform !== 'win32') {
    const shell = kind === 'bash' || (platform !== 'darwin' && kind !== 'zsh') ? 'bash' : 'zsh';
    // Login shells load the PATH used by Homebrew and user-installed agent CLIs.
    return { file: `/bin/${shell}`, args: ['-il'] };
  }
  if (kind === 'cmd') return { file: 'cmd.exe', args: [] };
  // An absolute path: node-pty resolves bare names only through this process's own (possibly stale) PATH.
  const pwsh = kind === 'pwsh' ? findOnPath('pwsh.exe', env) : null;
  if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
  return { file: 'powershell.exe', args: ['-NoLogo'] };
}

export class PtyManager implements TerminalBackend {
  private entries = new Map<string, Entry>();
  /**
   * node-pty 1.1.0 on Windows removes a finished terminal from one shared list on a thread per terminal, without
   * a lock. Two terminals ending at the same moment corrupt it and trip a native assertion ("remove_pty_baton"),
   * which pops up an error dialog. Terminals are therefore killed one at a time, each after the previous exited.
   */
  private ending: Promise<void> = Promise.resolve();
  /** Back-pressure from the renderer (acks) is only active while a renderer is connected. */
  private flowControl = false;

  /** Terminals whose exit node-pty has not reported yet (also killed ones that no longer are in `entries`). */
  private running = new Set<Entry>();

  constructor(private sink: PtySink, private readonly treeKill: (pid: number) => void = killTerminalTree) {}

  setSink(sink: PtySink): void {
    this.sink = sink;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  spawn(req: SpawnRequest): number {
    if (this.entries.has(req.id)) void this.kill(req.id);
    const { file, args } = resolveShell(req.shell, req.env);
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(2, req.cols),
      rows: Math.max(1, req.rows),
      cwd: req.cwd,
      env: { ...req.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'unimux' },
      ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
    });
    let resolveExit!: () => void;
    const out = new OutputChannel(req.id, () => this.sink, { pause: () => proc.pause(), resume: () => proc.resume() }, () => this.flowControl);
    const entry: Entry = { proc, out, exited: new Promise((r) => (resolveExit = r)) };
    this.entries.set(req.id, entry);
    this.running.add(entry);
    void entry.exited.then(() => this.running.delete(entry));

    let pendingCommand = req.command;
    proc.onData((data) => {
      if (this.entries.get(req.id) !== entry) return;
      out.push(data);
      if (pendingCommand) {
        const cmd = pendingCommand;
        pendingCommand = undefined;
        // Give the shell a moment to finish drawing its prompt.
        setTimeout(() => this.entries.get(req.id) === entry && proc.write(cmd + '\r'), 150);
      }
    });
    proc.onExit(({ exitCode }) => {
      if (this.entries.get(req.id) !== entry) {
        resolveExit();
        return;
      }
      // A paused pty still holds unread output: it is drained before the exit is reported.
      out.drain(() => {
        if (this.entries.get(req.id) === entry) {
          out.flush();
          out.dispose();
          this.entries.delete(req.id);
          this.sink.exit(req.id, exitCode);
        }
        resolveExit();
      });
    });
    return proc.pid;
  }

  /** The renderer parsed `chars` characters of this terminal's output. */
  ack(id: string, chars: number): void {
    this.entries.get(id)?.out.ack(chars);
  }

  /** Enables back-pressure for a freshly connected renderer; anything counted for the old one is forgotten. */
  setFlowControl(on: boolean): void {
    this.flowControl = on;
    for (const e of this.entries.values()) e.out.resetFlow();
  }

  write(id: string, data: string, reply = false): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (!reply) e.out.wrote();
    e.proc.write(data);
  }

  /** Resizes a live terminal; sizes for terminals that do not exist yet are kept by the HostRouter. */
  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    try {
      e.proc.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      // resizing a pty that is exiting throws; harmless
    }
  }

  /** Output history of every live terminal (for a reconnecting renderer). */
  histories(): Array<{ id: string; data: string }> {
    return [...this.entries].map(([id, e]) => ({ id, data: e.out.history() }));
  }

  /** Kills a terminal; resolves once it exited (bounded), so its cwd can be deleted afterwards. */
  kill(id: string, timeoutMs = 3000): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve();
    this.entries.delete(id);
    e.out.dispose();
    const turn = this.ending.then(() => {
      try {
        e.proc.kill();
      } catch {
        // already gone
      }
      return Promise.race([e.exited, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    });
    this.ending = turn.then(() => undefined, () => undefined);
    return turn;
  }

  /**
   * Kills every terminal and waits (bounded) for their exits; they end one after another (see `ending`). Terminals still
   * running when the time is up (the serial kills never reached them, or they ignored it) have their process tree ended, so
   * no dev server an agent started outlives the app.
   */
  async killAll(timeoutMs = 3000): Promise<void> {
    const kills = [...this.entries.keys()].map((id) => this.kill(id));
    await Promise.race([Promise.all(kills), new Promise((r) => setTimeout(r, timeoutMs))]);
    for (const entry of this.running) this.treeKill(entry.proc.pid);
  }
}
