// Tabs of the database viewer (1.0.0) and the staged edits of a table tab. Pure helpers shared by the renderer and tests:
// tab references and ids (also the keys of the drafts kept like file drafts), the staged edits model (one object per tab,
// serialized into the tab's draft text), the query history and the column/selection math of the data grid.
import { isTruncated, type DbObjectKind, type DbStagedEdit, type DbTxStatus, type DbValue, type DbValueKind } from './db';
import { parseDbInput } from './dbSql';
import type { MessageKey } from './i18n';
import { isUuid } from './ssh';

// ── tab references ──────────────────────────────────────────────────────────

export type DbTabRef =
  | { kind: 'table'; connectionId: string; database: string; schema: string; table: string; objectKind: DbObjectKind }
  | { kind: 'sql'; connectionId: string; database: string; uid: string }
  | { kind: 'ddl'; connectionId: string; database: string; schema: string; name: string; objectKind: DbObjectKind; args?: string };

const OBJECT_KINDS: readonly DbObjectKind[] = ['table', 'partitioned', 'view', 'matview', 'foreign', 'sequence', 'function', 'procedure'];
const NAME_MAX = 1024;
const okName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= NAME_MAX && !v.includes('\0');

/** The tab id of a reference: the same table (or DDL) opened twice is one tab, also across restarts. */
export function dbTabId(ref: DbTabRef): string {
  switch (ref.kind) {
    case 'table': return JSON.stringify(['db', 'table', ref.connectionId, ref.database, ref.schema, ref.table]);
    case 'sql': return JSON.stringify(['db', 'sql', ref.connectionId, ref.uid]);
    case 'ddl': return JSON.stringify(['db', 'ddl', ref.connectionId, ref.database, ref.schema, ref.name, ref.args ?? '']);
  }
}

export function validDbTabRef(value: unknown): value is DbTabRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  // An empty database: a MySQL connection without a default database.
  if (!isUuid(v.connectionId) || !(v.database === '' || okName(v.database))) return false;
  if (v.kind === 'sql') return isUuid(v.uid);
  if (v.kind === 'table') return okName(v.schema) && okName(v.table) && OBJECT_KINDS.includes(v.objectKind as DbObjectKind);
  if (v.kind === 'ddl') return okName(v.schema) && okName(v.name) && OBJECT_KINDS.includes(v.objectKind as DbObjectKind) && (v.args === undefined || (typeof v.args === 'string' && v.args.length <= 8192));
  return false;
}

/** The objects whose rows can be opened in a data tab. */
export const hasRows = (kind: DbObjectKind): boolean => kind === 'table' || kind === 'partitioned' || kind === 'view' || kind === 'matview' || kind === 'foreign';

/** "SQL 3": the first number not used by an open SQL tab of the connection. */
export function nextSqlName(used: readonly string[]): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`SQL ${n}`)) n++;
  return `SQL ${n}`;
}

// ── staged edits ────────────────────────────────────────────────────────────

/** Key values of a row (text forms), by edit key column. */
export type DbRowKey = Record<string, string>;
export interface DbStagedInsert { id: string; values: Record<string, string | null> }
/** Values a row was loaded with (text form, null for NULL); a save is a conflict when the row no longer has them. */
export type DbOriginal = Record<string, string | null>;
/** The edits of a table tab waiting for "Zapisz zmiany". */
export interface DbStaged {
  /** `original`: the loaded values of the edited columns (a truncated one is left out). */
  updates: Array<{ key: DbRowKey; set: Record<string, string | null>; original?: DbOriginal }>;
  inserts: DbStagedInsert[];
  /** `original`: the loaded values of the row (truncated ones left out). */
  deletes: Array<{ key: DbRowKey; original?: DbOriginal }>;
}

export const EMPTY_STAGED: DbStaged = { updates: [], inserts: [], deletes: [] };

/** One text per key (column order does not matter). */
export const keyText = (key: DbRowKey): string => JSON.stringify(Object.keys(key).sort().map((k) => [k, key[k]]));
const sameKey = (a: DbRowKey, b: DbRowKey): boolean => keyText(a) === keyText(b);

/** The edit key of a row; null when a key value is NULL or arrived truncated (such a row cannot be edited). */
export function rowKey(row: readonly DbValue[], columns: ReadonlyArray<{ name: string }>, editKey: readonly string[] | null): DbRowKey | null {
  if (!editKey?.length) return null;
  const key: DbRowKey = {};
  for (const k of editKey) {
    const i = columns.findIndex((c) => c.name === k);
    const v = i < 0 ? null : row[i];
    if (v === null || v === undefined || isTruncated(v)) return null;
    key[k] = v;
  }
  return key;
}

export const stagedCount = (s: DbStaged): number => s.updates.length + s.inserts.length + s.deletes.length;
export const isStagedEmpty = (s: DbStaged): boolean => stagedCount(s) === 0;

/** The staged change of one cell, if any. */
export function stagedCell(s: DbStaged, key: DbRowKey, column: string): { value: string | null } | null {
  const u = s.updates.find((x) => sameKey(x.key, key));
  return u && Object.hasOwn(u.set, column) ? { value: u.set[column] } : null;
}

/** Stages a new value of a cell; typing the original value back removes the change (`original` undefined: not known whole). */
export function stageCell(s: DbStaged, key: DbRowKey, column: string, value: string | null, original: string | null | undefined): DbStaged {
  const at = s.updates.findIndex((x) => sameKey(x.key, key));
  const set = { ...(at >= 0 ? s.updates[at].set : {}) };
  const originals: DbOriginal = { ...(at >= 0 ? s.updates[at].original ?? {} : {}) };
  if (original !== undefined && value === original) { delete set[column]; delete originals[column]; } else {
    set[column] = value;
    if (original !== undefined && !Object.hasOwn(originals, column)) originals[column] = original;
  }
  const updates = s.updates.filter((_, i) => i !== at);
  if (Object.keys(set).length) updates.splice(at >= 0 ? at : updates.length, 0, { key, set, ...(Object.keys(originals).length ? { original: originals } : {}) });
  return { ...s, updates };
}

export const isDeleted = (s: DbStaged, key: DbRowKey): boolean => s.deletes.some((d) => sameKey(d.key, key));

/** Marks rows for deletion, or (all already marked) takes the mark away again. */
export function toggleDeletes(s: DbStaged, rows: ReadonlyArray<{ key: DbRowKey; original?: DbOriginal }>): DbStaged {
  if (!rows.length) return s;
  if (rows.every((r) => isDeleted(s, r.key))) return { ...s, deletes: s.deletes.filter((d) => !rows.some((r) => sameKey(r.key, d.key))) };
  return { ...s, deletes: [...s.deletes, ...rows.filter((r) => !isDeleted(s, r.key)).map((r) => ({ key: r.key, ...(r.original ? { original: r.original } : {}) }))] };
}

/** The loaded values of a row for the conflict check (truncated values left out; the DB Host compares each in its own type). */
export function rowOriginal(row: readonly DbValue[], columns: ReadonlyArray<{ name: string }>): DbOriginal {
  const out: DbOriginal = {};
  columns.forEach((c, i) => { const v = row[i]; if (v === null || typeof v === 'string') out[c.name] = v; });
  return out;
}

export const addInsert = (s: DbStaged, id: string, values: Record<string, string | null> = {}): DbStaged => ({ ...s, inserts: [...s.inserts, { id, values }] });

export function setInsertValue(s: DbStaged, id: string, column: string, value: string | null | undefined): DbStaged {
  return {
    ...s,
    inserts: s.inserts.map((i) => {
      if (i.id !== id) return i;
      const values = { ...i.values };
      if (value === undefined) delete values[column]; else values[column] = value;
      return { ...i, values };
    }),
  };
}

export const removeInserts = (s: DbStaged, ids: readonly string[]): DbStaged => ({ ...s, inserts: s.inserts.filter((i) => !ids.includes(i.id)) });

/**
 * The edits as the save sends them: changes of rows that are also deleted are dropped; updates first, then deletes, then
 * inserts (a deleted key can be inserted again in the same save).
 */
export function stagedEdits(s: DbStaged): DbStagedEdit[] {
  return [
    ...s.updates.filter((u) => !isDeleted(s, u.key)).map((u): DbStagedEdit => ({ op: 'update', key: u.key, set: u.set, ...(u.original ? { original: u.original } : {}) })),
    ...s.deletes.map((d): DbStagedEdit => ({ op: 'delete', key: d.key, ...(d.original ? { original: d.original } : {}) })),
    ...s.inserts.map((i): DbStagedEdit => ({ op: 'insert', values: i.values })),
  ];
}

/** What each edit of `stagedEdits(s)` came from (same order): a staged row change or delete by key, or a new row by id. */
export type DbEditTarget = { kind: 'row'; key: DbRowKey } | { kind: 'insert'; id: string };
export function stagedEditTargets(s: DbStaged): DbEditTarget[] {
  return [
    ...s.updates.filter((u) => !isDeleted(s, u.key)).map((u): DbEditTarget => ({ kind: 'row', key: u.key })),
    ...s.deletes.map((d): DbEditTarget => ({ kind: 'row', key: d.key })),
    ...s.inserts.map((i): DbEditTarget => ({ kind: 'insert', id: i.id })),
  ];
}

/** Where a failed save's row is in a table tab: its index among the page rows (then the new rows), or null when not on the page. */
export function conflictRowIndex(target: DbEditTarget | null, keys: ReadonlyArray<DbRowKey | null>, s: DbStaged, pageRows: number): number | null {
  if (!target) return null;
  if (target.kind === 'insert') { const i = s.inserts.findIndex((x) => x.id === target.id); return i < 0 ? null : pageRows + i; }
  const i = keys.findIndex((k) => !!k && sameKey(k, target.key));
  return i < 0 ? null : i;
}

/** The row a failed save names (the edit at `index` of the edits built from `s`), or null. */
export const failedTarget = (s: DbStaged, index: number | undefined): DbEditTarget | null =>
  index === undefined ? null : stagedEditTargets(s)[index] ?? null;

/**
 * The staged set after a successful save of `sent`: exactly what was sent is gone, anything staged meanwhile stays. A cell
 * changed again after it was sent stays staged, and its loaded value is now what the save wrote.
 */
export function withoutSent(current: DbStaged, sent: DbStaged): DbStaged {
  const sentDeleted = (key: DbRowKey) => sent.deletes.some((d) => sameKey(d.key, key));
  const updates: DbStaged['updates'] = [];
  for (const u of current.updates) {
    // An update of a row the save deleted was never sent (stagedEdits drops it); the row is gone now.
    if (sentDeleted(u.key)) continue;
    const s = sent.updates.find((x) => sameKey(x.key, u.key));
    if (!s) { updates.push(u); continue; }
    const set: Record<string, string | null> = {};
    const original: DbOriginal = { ...(u.original ?? {}) };
    for (const [column, value] of Object.entries(u.set)) {
      if (Object.hasOwn(s.set, column)) {
        if (s.set[column] === value) { delete original[column]; continue; }
        if (Object.hasOwn(original, column)) original[column] = s.set[column];
      }
      set[column] = value;
    }
    for (const column of Object.keys(original)) if (!Object.hasOwn(set, column)) delete original[column];
    if (Object.keys(set).length) updates.push({ key: u.key, set, ...(Object.keys(original).length ? { original } : {}) });
  }
  return {
    updates,
    deletes: current.deletes.filter((d) => !sentDeleted(d.key)),
    inserts: current.inserts.filter((i) => !sent.inserts.some((x) => x.id === i.id)),
  };
}

/**
 * What leaving the inline cell editor stages: nothing when the user typed nothing (a NULL or DEFAULT cell entered and left
 * stays as it was; never an empty string), NULL when chosen, else the typed text checked for the column's kind.
 */
export type CellCommit = { kind: 'none' } | { kind: 'value'; value: string | null } | { kind: 'error'; error: MessageKey };
export function cellCommit(input: { touched: boolean; asNull: boolean; text: string; kind: DbValueKind; typeName?: string }): CellCommit {
  if (input.asNull) return { kind: 'value', value: null };
  if (!input.touched) return { kind: 'none' };
  const r = parseDbInput(input.kind, input.text, { typeName: input.typeName });
  return r.ok ? { kind: 'value', value: r.value } : { kind: 'error', error: r.error };
}

/**
 * The transaction toggle of a SQL tab follows the session's state only: on while a transaction is open (BEGIN from the
 * toolbar or typed in the script), off after COMMIT / ROLLBACK (typed too) and after a reconnect. What switching it does.
 */
export function txToggle(tx: DbTxStatus | undefined, wantOn: boolean): 'begin' | 'ask' | 'rollback' | null {
  const state = tx ?? 'idle';
  if (wantOn) return state === 'idle' ? 'begin' : null;
  if (state === 'transaction') return 'ask';
  if (state === 'failed') return 'rollback';
  return null;
}

/** "id = 5" or "a = 1, b = 'x'": names the row of a failed edit. */
export function keyLabel(key: DbRowKey): string {
  return Object.entries(key).map(([k, v]) => `${k} = ${/^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`}`).join(', ');
}

/** The row an edit of the save names (for a conflict message); an insert has no key. */
export function editRowLabel(edit: DbStagedEdit | undefined): string | null {
  if (!edit || edit.op === 'insert') return null;
  return keyLabel(edit.key);
}

const isTextRecord = (v: unknown, nullable: boolean): boolean => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string' || (nullable && x === null));

/** The staged edits of a draft text (a damaged one counts as none). */
export function parseStaged(text: string): DbStaged {
  if (!text) return EMPTY_STAGED;
  try {
    const v = JSON.parse(text) as Partial<DbStaged>;
    const okOriginal = (o: unknown) => o === undefined || isTextRecord(o, true);
    const updates = Array.isArray(v.updates) ? v.updates.filter((u) => u && isTextRecord(u.key, false) && Object.keys(u.key).length > 0 && isTextRecord(u.set, true) && okOriginal(u.original)) : [];
    const inserts = Array.isArray(v.inserts) ? v.inserts.filter((i) => i && typeof i.id === 'string' && isTextRecord(i.values, true)) : [];
    const deletes = Array.isArray(v.deletes) ? v.deletes.filter((d) => d && isTextRecord(d.key, false) && Object.keys(d.key).length > 0 && okOriginal(d.original)) : [];
    return { updates, inserts, deletes };
  } catch { return EMPTY_STAGED; }
}

/** The draft text of staged edits: '' when there are none (the tab is clean again). */
export const serializeStaged = (s: DbStaged): string => (isStagedEmpty(s) ? '' : JSON.stringify(s));

// ── query history ───────────────────────────────────────────────────────────

export interface DbHistoryEntry { sql: string; at: number; ok: boolean; timeMs: number }
export const DB_HISTORY_LIMIT = 200;
/** A longer entry is not kept; the whole history (all connections) stays under DB_HISTORY_TOTAL characters. */
export const HISTORY_SQL_MAX = 8 * 1024;
export const DB_HISTORY_TOTAL = 1024 * 1024;

/**
 * The history text of a statement: passwords in it are masked (PASSWORD '...', IDENTIFIED BY '...', password=... inside
 * connection strings), so the history never keeps a secret typed into a script.
 */
export function redactSql(sql: string): string {
  return sql
    .replace(/\b(PASSWORD|IDENTIFIED\s+BY)(\s+)(E?'(?:[^']|'')*'|\$([A-Za-z_]*)\$[\s\S]*?\$\4\$)/gi, (_m, word: string, space: string) => `${word}${space}'***'`)
    .replace(/\b(password\s*=\s*)('[^']*'|[^\s']+)/gi, (_m, head: string) => `${head}***`);
}

/** The stored history kept within its limits: only live connections, entries under the size cap, the total under its cap (oldest go first). */
export function pruneHistory(all: Record<string, DbHistoryEntry[]>, liveIds: ReadonlySet<string>, total = DB_HISTORY_TOTAL): Record<string, DbHistoryEntry[]> {
  const out: Record<string, DbHistoryEntry[]> = {};
  for (const [id, list] of Object.entries(all)) if (liveIds.has(id)) out[id] = list.filter((e) => e.sql.length <= HISTORY_SQL_MAX);
  let size = Object.values(out).reduce((n, list) => n + list.reduce((m, e) => m + e.sql.length + 48, 0), 0);
  while (size > total) {
    let oldest: { id: string; at: number } | null = null;
    for (const [id, list] of Object.entries(out)) { const last = list[list.length - 1]; if (last && (!oldest || last.at < oldest.at)) oldest = { id, at: last.at }; }
    if (!oldest) break;
    const dropped = out[oldest.id].pop()!;
    size -= dropped.sql.length + 48;
  }
  return out;
}

/** The newest entry first; running the same text again moves it to the top. Very long scripts are not kept. */
export function pushHistory(list: readonly DbHistoryEntry[], entry: DbHistoryEntry, limit = DB_HISTORY_LIMIT): DbHistoryEntry[] {
  const sql = redactSql(entry.sql.trim());
  if (!sql || sql.length > HISTORY_SQL_MAX) return [...list];
  return [{ ...entry, sql }, ...list.filter((e) => e.sql !== sql)].slice(0, limit);
}

export function parseHistory(raw: unknown): Record<string, DbHistoryEntry[]> {
  const out: Record<string, DbHistoryEntry[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!isUuid(id) || !Array.isArray(list)) continue;
    out[id] = list.filter((e): e is DbHistoryEntry => !!e && typeof e.sql === 'string' && typeof e.at === 'number' && typeof e.ok === 'boolean' && typeof e.timeMs === 'number').slice(0, DB_HISTORY_LIMIT);
  }
  return out;
}

// ── data grid math ──────────────────────────────────────────────────────────

/** Columns [start, end) to render for a horizontal scroll position, with the left edge of each column. */
export interface ColumnWindow { start: number; end: number; lefts: number[]; total: number }

export function columnWindow(widths: readonly number[], scrollLeft: number, viewport: number, overscan = 2): ColumnWindow {
  const lefts: number[] = [];
  let x = 0;
  for (const w of widths) { lefts.push(x); x += w; }
  if (!widths.length) return { start: 0, end: 0, lefts, total: 0 };
  let start = 0;
  while (start < widths.length - 1 && lefts[start] + widths[start] <= scrollLeft) start++;
  let end = start;
  while (end < widths.length && lefts[end] < scrollLeft + Math.max(0, viewport)) end++;
  return { start: Math.max(0, start - overscan), end: Math.min(widths.length, Math.max(end, start + 1) + overscan), lefts, total: x };
}

/** A first width for a column from its name and type (the user can drag it wider). */
export function defaultColumnWidth(name: string, kind: string): number {
  const base = kind === 'bool' ? 70 : kind === 'int' || kind === 'bigint' || kind === 'float' || kind === 'numeric' ? 100
    : kind === 'uuid' ? 290 : kind === 'timestamp' || kind === 'timestamptz' ? 200 : kind === 'json' ? 260 : 180;
  return Math.max(base, Math.min(320, 24 + name.length * 8));
}

export const COLUMN_MIN = 48;
export const COLUMN_MAX = 2000;
export const clampColumnWidth = (w: number): number => Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, Math.round(w)));

/** A rectangle of cells: rows [r0, r1] and columns [c0, c1], inclusive. */
export interface CellRange { r0: number; r1: number; c0: number; c1: number }
export interface CellPos { row: number; col: number }

export const rangeOf = (a: CellPos, b: CellPos): CellRange => ({ r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row), c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col) });
export const inRange = (r: CellRange | null, row: number, col: number): boolean => !!r && row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1;

/** The cells of a range (rows and columns clipped to what exists). */
export function sliceRange<T>(rows: readonly T[][], r: CellRange): T[][] {
  const out: T[][] = [];
  for (let i = Math.max(0, r.r0); i <= Math.min(rows.length - 1, r.r1); i++) out.push(rows[i].slice(Math.max(0, r.c0), r.c1 + 1));
  return out;
}

/** A cursor move inside the grid (arrow keys, Home/End, page keys), clamped to its edges. */
export function moveCell(pos: CellPos, key: string, rows: number, cols: number, page = 20): CellPos {
  const clamp = (p: CellPos): CellPos => ({ row: Math.max(0, Math.min(rows - 1, p.row)), col: Math.max(0, Math.min(cols - 1, p.col)) });
  switch (key) {
    case 'ArrowUp': return clamp({ ...pos, row: pos.row - 1 });
    case 'ArrowDown': return clamp({ ...pos, row: pos.row + 1 });
    case 'ArrowLeft': return clamp({ ...pos, col: pos.col - 1 });
    case 'ArrowRight': case 'Tab': return clamp({ ...pos, col: pos.col + 1 });
    case 'Home': return clamp({ ...pos, col: 0 });
    case 'End': return clamp({ ...pos, col: cols - 1 });
    case 'PageUp': return clamp({ ...pos, row: pos.row - page });
    case 'PageDown': return clamp({ ...pos, row: pos.row + page });
    default: return pos;
  }
}
