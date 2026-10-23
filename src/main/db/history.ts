// The SQL query history of saved connections (1.0.6): <data>/db/query_history.json (0600 on POSIX), local only, never synced
// or sent anywhere but the app's own window. Loaded on first use; writes are batched and atomic. A file from a newer version,
// or one that is not a history file, is never written over. "Zapisuj historię zapytań" (on by default) is kept in the file too.
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import {
  DB_HISTORY_LIMITS, DB_HISTORY_VERSION, addHistory, clearHistoryEntries, historyRecord, normalizeHistoryFile, starHistory, type DbHistoryItem, type DbHistoryRecord, type DbHistoryState,
} from '../../shared/dbHistory';
import { isUuid } from '../../shared/ssh';
import type { IpcGuard } from '../ipcGuard';
import { ensurePrivateDir, readJsonFile, writePrivateFile } from '../ssh/files';

export interface DbHistoryOptions {
  /** The connection is still saved (a deleted connection's history is dropped at the next write). */
  connectionExists(id: string): boolean;
  writeDelayMs?: number;
}

const newId = (): string => randomBytes(9).toString('base64url');

export class DbHistoryStore {
  private connections: Map<string, DbHistoryItem[]> | null = null;
  private enabled = true;
  private locked = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly file: string, private readonly opts: DbHistoryOptions) {}

  private load(): Map<string, DbHistoryItem[]> {
    if (this.connections) return this.connections;
    const read = readJsonFile(this.file);
    if (!read.ok) {
      // Missing, or unparsable and moved aside by readJsonFile: start empty. Still there means unreadable: keep it.
      this.locked = existsSync(this.file);
      return (this.connections = new Map());
    }
    const parsed = normalizeHistoryFile(read.value);
    this.locked = parsed.newer || parsed.invalid;
    this.enabled = parsed.enabled;
    return (this.connections = parsed.connections);
  }

  private known(id: unknown): id is string { return isUuid(id) && this.opts.connectionExists(id); }

  list(connectionId: unknown): DbHistoryState {
    const all = this.load();
    return { enabled: this.enabled, entries: this.known(connectionId) ? [...(all.get(connectionId) ?? [])] : [] };
  }

  /** Records the statements of a run; false when refused (unknown connection, history off, a read-only file). */
  record(connectionId: unknown, raw: unknown): boolean {
    if (!this.known(connectionId) || !Array.isArray(raw)) return false;
    const all = this.load();
    if (this.locked || !this.enabled) return false;
    const records = raw.slice(0, DB_HISTORY_LIMITS.perRun).map(historyRecord).filter((r): r is DbHistoryRecord => !!r);
    if (!records.length) return true;
    const next = addHistory(all.get(connectionId) ?? [], records, newId);
    // The connection used last goes last in the map: the oldest one is the first dropped over the limit.
    all.delete(connectionId);
    all.set(connectionId, next);
    while (all.size > DB_HISTORY_LIMITS.connections) all.delete(all.keys().next().value!);
    this.changed();
    return true;
  }

  star(connectionId: unknown, id: unknown, star: unknown): boolean {
    if (!this.known(connectionId) || typeof id !== 'string' || typeof star !== 'boolean') return false;
    const all = this.load();
    if (this.locked) return false;
    const next = starHistory(all.get(connectionId) ?? [], id, star);
    if (!next) return false;
    all.set(connectionId, next);
    this.changed();
    return true;
  }

  clear(connectionId: unknown, stars: unknown): boolean {
    if (!isUuid(connectionId)) return false;
    const all = this.load();
    if (this.locked) return false;
    const left = clearHistoryEntries(all.get(connectionId) ?? [], stars === true);
    if (left.length) all.set(connectionId, left); else all.delete(connectionId);
    this.changed();
    this.flush();
    return true;
  }

  setEnabled(enabled: unknown): boolean {
    if (typeof enabled !== 'boolean') return false;
    this.load();
    if (this.locked) return false;
    this.enabled = enabled;
    this.changed();
    this.flush();
    return true;
  }

  private changed(): void {
    this.dirty = true;
    this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, this.opts.writeDelayMs ?? 1500);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Writes pending changes now (app quit). A failed write is tried again with the next change. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty || !this.connections || this.locked) return;
    for (const id of [...this.connections.keys()]) if (!this.opts.connectionExists(id)) this.connections.delete(id);
    const connections: Record<string, DbHistoryItem[]> = {};
    for (const [id, entries] of this.connections) connections[id] = entries;
    try {
      ensurePrivateDir(dirname(this.file));
      writePrivateFile(this.file, JSON.stringify({ version: DB_HISTORY_VERSION, enabled: this.enabled, connections }));
      this.dirty = false;
    } catch { /* kept dirty: written with the next change or at quit */ }
  }
}

const uuid = z.string().uuid();

/** `window.mc.db.history`: from the app window only (the guard); bad arguments get the empty answer. */
export function registerDbHistoryIpc(guard: IpcGuard, store: DbHistoryStore): void {
  guard.guardedHandle('db:history:list', (_e, connectionId: unknown) => store.list(connectionId), () => ({ enabled: true, entries: [] }));
  guard.guardedOn('db:history:record', (_e, connectionId: unknown, records: unknown) => { store.record(connectionId, records); });
  guard.guardedHandle('db:history:star', (_e, connectionId: unknown, id: unknown, star: unknown) => ({ ok: uuid.safeParse(connectionId).success && store.star(connectionId, id, star) }), () => ({ ok: false }));
  guard.guardedHandle('db:history:clear', (_e, connectionId: unknown, stars: unknown) => ({ ok: store.clear(connectionId, stars) }), () => ({ ok: false }));
  guard.guardedHandle('db:history:enabled', (_e, enabled: unknown) => ({ ok: store.setEnabled(enabled) }), () => ({ ok: false }));
}
