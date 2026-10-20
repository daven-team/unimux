// The command history of SSH hosts for the terminal autocomplete (<data>/ssh/command_history.json, 0600 on POSIX). Local
// only: never synced, exported or sent anywhere but the app's own window. Loaded on first use; writes are batched and
// atomic (files.ts). A file from a newer version, or one that is not a history file, is never written over.
import { existsSync } from 'fs';
import { dirname } from 'path';
import { COMMAND_HISTORY_LIMITS, COMMAND_HISTORY_VERSION, historyCommand, normalizeCommandHistory, recordCommand, type CommandHistoryEntry, type SshHistoryStatus } from '../../shared/commandHistory';
import { isUuid } from '../../shared/ssh';
import type { IpcGuard } from '../ipcGuard';
import { ensurePrivateDir, readJsonFile, writePrivateFile } from './files';

export interface CommandHistoryOptions {
  /** The host is still saved (a deleted host's history is dropped at the next write). */
  hostExists(hostId: string): boolean;
  now?: () => number;
  /** How long changes wait before they are written (default 1500 ms). */
  writeDelayMs?: number;
}

export class CommandHistoryStore {
  private hosts: Map<string, CommandHistoryEntry[]> | null = null;
  private locked = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly file: string, private readonly opts: CommandHistoryOptions) {}

  private load(): Map<string, CommandHistoryEntry[]> {
    if (this.hosts) return this.hosts;
    const read = readJsonFile(this.file);
    if (!read.ok) {
      // Missing, or unparsable and moved to a .bak-<time> by readJsonFile: start empty. Still there means unreadable: keep it.
      this.locked = existsSync(this.file);
      return (this.hosts = new Map());
    }
    const parsed = normalizeCommandHistory(read.value);
    this.locked = parsed.newer || parsed.invalid;
    return (this.hosts = parsed.hosts);
  }

  private known(hostId: unknown): hostId is string {
    return isUuid(hostId) && this.opts.hostExists(hostId);
  }

  readOnly(): boolean { this.load(); return this.locked; }

  list(hostId: unknown): CommandHistoryEntry[] {
    if (!this.known(hostId)) return [];
    return [...(this.load().get(hostId) ?? [])];
  }

  /** Records a run; false when refused (unknown host, a line that is not kept, a read-only file). */
  record(hostId: unknown, command: unknown): boolean {
    if (!this.known(hostId) || typeof command !== 'string' || historyCommand(command) !== command) return false;
    const hosts = this.load();
    if (this.locked) return false;
    const before = hosts.get(hostId) ?? [];
    const next = recordCommand(before, command, (this.opts.now ?? Date.now)());
    if (next === before) return true;
    // Most recently used host last in the map, so the oldest host is the first one dropped over the limit.
    hosts.delete(hostId);
    hosts.set(hostId, next);
    while (hosts.size > COMMAND_HISTORY_LIMITS.hosts) hosts.delete(hosts.keys().next().value!);
    this.changed();
    return true;
  }

  /** Clears one host's history, or every host's (null). */
  clear(hostId: unknown): boolean {
    if (hostId !== null && !isUuid(hostId)) return false;
    const hosts = this.load();
    if (this.locked) return false;
    if (hostId === null) hosts.clear();
    else hosts.delete(hostId);
    this.changed();
    this.flush();
    return true;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, entries] of this.load()) if (this.opts.hostExists(id)) out[id] = entries.length;
    return out;
  }

  /** Settings > SSH: the counts, and the file with why nothing is recorded when it opened read-only. */
  status(): SshHistoryStatus {
    return { counts: this.counts(), readOnly: this.readOnly(), file: this.file };
  }

  private changed(): void {
    this.dirty = true;
    this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, this.opts.writeDelayMs ?? 1500);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Writes pending changes now (app quit). A failed write is tried again with the next change. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty || !this.hosts || this.locked) return;
    for (const id of [...this.hosts.keys()]) if (!this.opts.hostExists(id)) this.hosts.delete(id);
    const hosts: Record<string, CommandHistoryEntry[]> = {};
    for (const [id, entries] of this.hosts) hosts[id] = entries;
    try {
      ensurePrivateDir(dirname(this.file));
      writePrivateFile(this.file, JSON.stringify({ version: COMMAND_HISTORY_VERSION, hosts }));
      this.dirty = false;
    } catch { /* kept dirty: written with the next change or at quit */ }
  }
}

/** `window.mc.sshHistory`: from the app window only (the guard); bad arguments get the empty answer. */
export function registerCommandHistoryIpc(guard: IpcGuard, store: CommandHistoryStore): void {
  guard.guardedHandle('ssh:history:list', (_e, hostId: unknown) => store.list(hostId), () => []);
  guard.guardedOn('ssh:history:record', (_e, hostId: unknown, command: unknown) => { store.record(hostId, command); });
  guard.guardedHandle('ssh:history:clear', (_e, hostId: unknown) => ({ ok: store.clear(hostId) }), () => ({ ok: false }));
  guard.guardedHandle('ssh:history:status', () => store.status(), () => ({ counts: {}, readOnly: false, file: '' }));
}
