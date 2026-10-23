// The SQL query history (1.0.6): every statement a SQL editor ran, per saved connection, kept on this computer by main
// (<data>/db/query_history.json). An entry is the statement's text (passwords masked, nothing else of its values), when it ran,
// how long it took, its row count and whether it worked. Starred entries are favourites: they stay when the history is cleared
// or over its cap. Pure: shared by main (the store), the renderer (the panel) and tests.
import { isUuid } from './ssh';
import { redactSql } from './dbTabs';

export interface DbHistoryItem {
  /** Unique within the connection's history. */
  id: string;
  sql: string;
  /** When it started (ms since epoch). */
  at: number;
  timeMs: number;
  /** Affected or read rows (null: none reported). */
  rows: number | null;
  ok: boolean;
  /** The error's first line (capped). */
  error?: string;
  star?: true;
}

/** What the renderer records: one statement that ran. */
export type DbHistoryRecord = Omit<DbHistoryItem, 'id' | 'star'>;

export interface DbHistoryState { enabled: boolean; entries: DbHistoryItem[] }

export const DB_HISTORY_LIMITS = {
  /** Entries kept per connection (favourites do not count against it). */
  perConnection: 1000,
  /** Favourites kept per connection. */
  stars: 500,
  /** A longer statement is not recorded (it would be a whole script or a dump). */
  sqlChars: 16 * 1024,
  errorChars: 300,
  /** Statements one run records at most. */
  perRun: 100,
  connections: 500,
} as const;
export const DB_HISTORY_VERSION = 1;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** An entry as stored or sent, or null when it cannot be used. */
export function normalizeHistoryItem(raw: unknown): DbHistoryItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id) || typeof r.sql !== 'string' || !r.sql.trim() || r.sql.length > DB_HISTORY_LIMITS.sqlChars) return null;
  if (!finite(r.at) || r.at < 0 || !finite(r.timeMs) || r.timeMs < 0 || typeof r.ok !== 'boolean') return null;
  const item: DbHistoryItem = { id: r.id, sql: r.sql, at: r.at, timeMs: Math.round(r.timeMs), rows: finite(r.rows) && r.rows >= 0 ? Math.round(r.rows) : null, ok: r.ok };
  if (typeof r.error === 'string' && r.error) item.error = r.error.slice(0, DB_HISTORY_LIMITS.errorChars);
  if (r.star === true) item.star = true;
  return item;
}

/** A record from the renderer as it is stored: the text trimmed and masked, the error cut to one line; null when not kept. */
export function historyRecord(raw: unknown): DbHistoryRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sql !== 'string' || typeof r.ok !== 'boolean' || !finite(r.at) || !finite(r.timeMs)) return null;
  const sql = redactSql(r.sql.trim());
  if (!sql || sql.length > DB_HISTORY_LIMITS.sqlChars) return null;
  const rec: DbHistoryRecord = { sql, at: Math.max(0, r.at), timeMs: Math.max(0, Math.round(r.timeMs)), rows: finite(r.rows) && r.rows >= 0 ? Math.round(r.rows) : null, ok: r.ok };
  if (typeof r.error === 'string' && r.error.trim()) rec.error = r.error.trim().split('\n')[0].slice(0, DB_HISTORY_LIMITS.errorChars);
  return rec;
}

/**
 * Adds records (newest last in `records`) to a connection's entries (newest first), then drops the oldest entries that are not
 * favourites beyond the cap. `nextId` names each new entry.
 */
export function addHistory(entries: readonly DbHistoryItem[], records: readonly DbHistoryRecord[], nextId: () => string, limit: number = DB_HISTORY_LIMITS.perConnection): DbHistoryItem[] {
  const added: DbHistoryItem[] = records.map((r) => ({ ...r, id: nextId() })).reverse();
  const all: DbHistoryItem[] = [...added, ...entries];
  let plain = 0;
  return all.filter((e) => e.star || ++plain <= limit);
}

/** Stars or unstars one entry (favourites beyond their cap are refused: false). */
export function starHistory(entries: readonly DbHistoryItem[], id: string, star: boolean): DbHistoryItem[] | null {
  const at = entries.findIndex((e) => e.id === id);
  if (at < 0) return null;
  if (star && !entries[at].star && entries.filter((e) => e.star).length >= DB_HISTORY_LIMITS.stars) return null;
  return entries.map((e, i) => {
    if (i !== at) return e;
    const { star: _old, ...rest } = e;
    return star ? { ...rest, star: true as const } : rest;
  });
}

/** Clears a connection's history: the favourites stay unless `stars` too. */
export const clearHistoryEntries = (entries: readonly DbHistoryItem[], stars = false): DbHistoryItem[] => (stars ? [] : entries.filter((e) => e.star));

/** The stored file: { version, enabled, connections: { id: entries } }; `newer`: written by a later version (kept as it is). */
export function normalizeHistoryFile(raw: unknown): { enabled: boolean; connections: Map<string, DbHistoryItem[]>; newer: boolean; invalid: boolean } {
  const empty = { enabled: true, connections: new Map<string, DbHistoryItem[]>(), newer: false, invalid: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...empty, invalid: raw !== undefined };
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'number') return { ...empty, invalid: true };
  if (r.version > DB_HISTORY_VERSION) return { ...empty, newer: true };
  const connections = new Map<string, DbHistoryItem[]>();
  const list = r.connections && typeof r.connections === 'object' && !Array.isArray(r.connections) ? r.connections as Record<string, unknown> : {};
  for (const [id, entries] of Object.entries(list)) {
    if (!isUuid(id) || !Array.isArray(entries)) continue;
    const seen = new Set<string>();
    const items = entries.map(normalizeHistoryItem).filter((e): e is DbHistoryItem => !!e && !seen.has(e.id) && !!seen.add(e.id));
    if (items.length) connections.set(id, items.slice(0, DB_HISTORY_LIMITS.perConnection + DB_HISTORY_LIMITS.stars));
    if (connections.size >= DB_HISTORY_LIMITS.connections) break;
  }
  return { enabled: r.enabled !== false, connections, newer: false, invalid: false };
}

/** The entries a search shows: every word of the query in the statement (any case); only favourites with `starred`. */
export function searchHistory(entries: readonly DbHistoryItem[], query: string, opts: { starred?: boolean } = {}): DbHistoryItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => (!opts.starred || e.star) && words.every((w) => e.sql.toLowerCase().includes(w)));
}

/** `window.mc.db.history` (src/preload); every call is validated in src/main/db/history.ts. */
export interface DbHistoryApi {
  list(connectionId: string): Promise<DbHistoryState>;
  /** Records the statements of a run (ignored while the history is off). */
  record(connectionId: string, records: DbHistoryRecord[]): void;
  star(connectionId: string, id: string, star: boolean): Promise<{ ok: boolean }>;
  /** Clears a connection's history (favourites stay unless `stars`). */
  clear(connectionId: string, stars?: boolean): Promise<{ ok: boolean }>;
  setEnabled(enabled: boolean): Promise<{ ok: boolean }>;
}
