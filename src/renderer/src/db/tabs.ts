// Database tabs in the top strip (1.0.0): table data, SQL editor and DDL tabs are editor tabs (FileDocument with `db`), so
// the strip, its order, Mod+Tab, closing and drafts work as for files. What a tab shows (rows, results, its session) lives
// here, outside React, so switching tabs keeps it. Staged edits of a table tab are its draft text; a SQL tab's text is the script.
import { create } from 'zustand';
import type { DbColumn, DbConnection, DbConnectionInput, DbResult, DbObjectKind, DbSort, DbTableInfo, DbTxStatus, DbValue } from '../../../shared/db';
import { DB_LIMITS } from '../../../shared/db';
import { dbTabId, editRowLabel, failedTarget, isStagedEmpty, nextSqlName, parseHistory, parseStaged, serializeStaged, stagedCount, stagedEdits, withoutSent, type DbEditTarget, type DbStaged, type DbTabRef } from '../../../shared/dbTabs';
import { DB_HISTORY_LIMITS, type DbHistoryRecord } from '../../../shared/dbHistory';
import { uid } from '../../../shared/state';
import { splitSql, type SqlDialect } from '../../../shared/dbSql';
import { activateFile, editFile, setDbTabHooks, useFileStore, type FileDocument } from '../files';
import { tr } from '../i18n';
import { askChoice, getS, setUi } from '../store';
import { setDatabaseQuitWork } from '../closeGuard';
import { useSshStore } from '../sshStore';
import { confirmCloseRedis, redisDraftTotal, redisQuitLine, useRedisDrafts } from '../redis/redisDrafts';
import { connectTab, dbErrorMessage, disconnectConnection, ensureShared, initDb, liveSessionsOf, onQuery, releaseTab, resultError, useDbStore } from './dbClient';

// ── runtime state ───────────────────────────────────────────────────────────

export interface TableTabState {
  kind: 'table';
  sessionId: string | null;
  info: DbTableInfo | null;
  columns: DbColumn[];
  rows: DbValue[][];
  offset: number;
  pageSize: number;
  sort: DbSort[];
  /** The WHERE condition of the rows shown. */
  filter: string;
  hasMore: boolean;
  loading: boolean;
  saving: boolean;
  timeMs: number | null;
  error: string | null;
  notice: string | null;
  /** The row a failed save named (highlighted, and shown when it is on the page). */
  conflict: DbEditTarget | null;
  /** Bumped after each load: the grid scrolls back to the top. */
  loads: number;
}

export interface SqlResult {
  index: number;
  start: number;
  end: number;
  columns: DbColumn[] | null;
  rows: DbValue[][];
  command: string | null;
  rowCount: number | null;
  hasMore: boolean;
  /** The statement returned more rows than were read (not a plain read: its cursor closed at once). */
  truncated?: boolean;
  /** DB_UI_MAX_ROWS rows are loaded: no more are kept in this window. */
  capped?: boolean;
  /** Its cursor was closed: no more rows can be loaded. */
  closed: boolean;
  timeMs: number | null;
  error: string | null;
  /** The error was a read-only refusal (the run may be repeated with writes allowed). */
  readOnly?: boolean;
  /** 1-based position of the error in the submitted text. */
  position?: number;
  /** A further result set of the statement before it (2, 3, ...: a MySQL CALL). */
  set?: number;
  loadingMore?: boolean;
}

export interface SqlTabState {
  kind: 'sql';
  sessionId: string | null;
  connecting: boolean;
  running: boolean;
  queryId: string | null;
  /** The text the last run sent and where it starts in the editor. */
  runText: string;
  runOffset: number;
  results: SqlResult[];
  notices: string[];
  shown: number | 'messages';
  timeMs: number | null;
  cancelled: boolean;
  error: string | null;
}

export interface DdlTabState { kind: 'ddl'; loading: boolean; text: string; error: string | null }

export type TabState = TableTabState | SqlTabState | DdlTabState;
export const useDbTabs = create<Record<string, TabState>>(() => ({}));

const patchTab = <T extends TabState>(id: string, change: Partial<T> | ((t: T) => Partial<T>)) => useDbTabs.setState((st) => {
  const cur = st[id] as T | undefined;
  if (!cur) return st;
  return { ...st, [id]: { ...cur, ...(typeof change === 'function' ? change(cur) : change) } };
});

const newTable = (): TableTabState => ({ kind: 'table', sessionId: null, info: null, columns: [], rows: [], offset: 0, pageSize: 100, sort: [], filter: '', hasMore: false, loading: false, saving: false, timeMs: null, error: null, notice: null, conflict: null, loads: 0 });
const newSql = (): SqlTabState => ({ kind: 'sql', sessionId: null, connecting: false, running: false, queryId: null, runText: '', runOffset: 0, results: [], notices: [], shown: 0, timeMs: null, cancelled: false, error: null });
export function tabState<T extends TabState>(id: string, kind: T['kind']): T {
  const cur = useDbTabs.getState()[id];
  if (cur && cur.kind === kind) return cur as T;
  const fresh = (kind === 'table' ? newTable() : kind === 'sql' ? newSql() : { kind: 'ddl', loading: false, text: '', error: null }) as T;
  useDbTabs.setState((st) => ({ ...st, [id]: fresh }));
  return fresh;
}

export const docOf = (id: string): FileDocument | undefined => useFileStore.getState().documents.find((d) => d.id === id);
export const connectionOf = (ref: DbTabRef | undefined): DbConnection | undefined => (ref ? getS().dbConnections?.find((c) => c.id === ref.connectionId) : undefined);

// ── opening tabs ────────────────────────────────────────────────────────────

function openTab(ref: DbTabRef, name: string, relativePath: string, text = ''): string {
  initDb();
  setUi({ settingsActive: false });
  useSshStore.setState({ viewActive: false });
  const id = dbTabId(ref);
  if (!useFileStore.getState().documents.some((d) => d.id === id)) {
    const doc: FileDocument = { id, projectId: '', relativePath, name, db: ref, text, savedText: '', diskText: '', status: 'ready', saving: false, error: null, wrap: false };
    useFileStore.setState((s) => ({ documents: [...s.documents, doc] }));
  }
  activateFile(id);
  return id;
}

const connName = (connectionId: string) => getS().dbConnections?.find((c) => c.id === connectionId)?.name ?? '?';
/** The SQL a connection speaks (how its scripts split, how names are quoted). */
export const dialectOf = (connectionId: string): SqlDialect => {
  const kind = getS().dbConnections?.find((c) => c.id === connectionId)?.kind;
  return kind === 'mysql' ? 'mysql' : kind === 'sqlite' ? 'sqlite' : 'postgres';
};
/** The database part of a tab's path: MySQL without a default database shows none. */
const dbPart = (database: string) => (database ? `${database} · ` : '');

export function openTableTab(connectionId: string, database: string, schema: string, table: string, objectKind: DbObjectKind): string {
  const dialect = dialectOf(connectionId);
  const id = openTab({ kind: 'table', connectionId, database, schema, table, objectKind }, table, `${connName(connectionId)} · ${dialect === 'sqlite' ? table : dialect === 'mysql' ? `${schema}.${table}` : `${database} · ${schema}.${table}`}`);
  const st = tabState<TableTabState>(id, 'table');
  if (!st.columns.length && !st.loading) void loadPage(id);
  return id;
}

export function openSqlTab(connectionId: string, database: string, text = ''): string {
  const used = useFileStore.getState().documents.filter((d) => d.db?.kind === 'sql' && d.db.connectionId === connectionId).map((d) => d.name);
  const name = nextSqlName(used);
  const id = openTab({ kind: 'sql', connectionId, database, uid: uid() }, name, `${connName(connectionId)} · ${dialectOf(connectionId) === 'sqlite' ? '' : dbPart(database)}${name}`, text);
  tabState<SqlTabState>(id, 'sql');
  return id;
}

export function openDdlTab(connectionId: string, database: string, schema: string, name: string, objectKind: DbObjectKind, args?: string): string {
  const dialect = dialectOf(connectionId);
  const id = openTab({ kind: 'ddl', connectionId, database, schema, name, objectKind, ...(args ? { args } : {}) }, name, `${connName(connectionId)} · ${dialect === 'sqlite' ? name : `${dialect === 'mysql' ? '' : `${database} · `}${schema}.${name}`} (DDL)`);
  void loadDdl(id);
  return id;
}

export async function loadDdl(id: string): Promise<void> {
  const ref = docOf(id)?.db;
  if (ref?.kind !== 'ddl') return;
  useDbTabs.setState((st) => ({ ...st, [id]: { kind: 'ddl', loading: true, text: (st[id] as DdlTabState | undefined)?.text ?? '', error: null } }));
  const s = await ensureShared(ref.connectionId, ref.database);
  if (!s.ok) { patchTab<DdlTabState>(id, { loading: false, error: s.error }); return; }
  const r = await window.mc.db.pg.ddl(s.sessionId, ref.schema, ref.name, ref.objectKind, ref.args);
  patchTab<DdlTabState>(id, r.ok ? { loading: false, text: r.value } : { loading: false, error: resultError(r, ref.connectionId) });
}

// ── table data ──────────────────────────────────────────────────────────────

export const stagedOf = (id: string): DbStaged => parseStaged(docOf(id)?.text ?? '');
export const setStaged = (id: string, staged: DbStaged): void => editFile(id, serializeStaged(staged));

/** Why a table tab cannot be edited (null: it can). */
export function readOnlyReason(ref: DbTabRef | undefined, info: DbTableInfo | null, sessionReadOnly?: boolean): string | null {
  if (ref?.kind !== 'table') return null;
  // Read-only when the saved connection or the session (it keeps the mode it connected with) says so.
  if (connectionOf(ref)?.readOnly || sessionReadOnly) return tr('To połączenie jest tylko do odczytu');
  if (ref.objectKind === 'view' || ref.objectKind === 'matview') return tr('Widoki są tylko do odczytu');
  if (info && !info.editKey) return tr('Tabela nie ma klucza głównego ani unikalnego - edycja jest wyłączona');
  return null;
}

export async function loadPage(id: string, change: Partial<Pick<TableTabState, 'offset' | 'pageSize' | 'sort' | 'filter'>> = {}): Promise<void> {
  const ref = docOf(id)?.db;
  if (ref?.kind !== 'table') return;
  tabState<TableTabState>(id, 'table');
  patchTab<TableTabState>(id, { ...change, loading: true, error: null, notice: null });
  const s = await ensureShared(ref.connectionId, ref.database);
  if (!s.ok) { patchTab<TableTabState>(id, { loading: false, error: s.error }); return; }
  const sid = s.sessionId;
  let st = useDbTabs.getState()[id] as TableTabState | undefined;
  if (!st) return;
  if (!st.info || st.sessionId !== sid) {
    const info = await window.mc.db.pg.tableInfo(sid, ref.schema, ref.table);
    if (!info.ok) { patchTab<TableTabState>(id, { loading: false, error: resultError(info, ref.connectionId) }); return; }
    patchTab<TableTabState>(id, { info: info.value, sessionId: sid });
    st = useDbTabs.getState()[id] as TableTabState;
  }
  const queryId = uid();
  let columns: DbColumn[] = [];
  const rows: DbValue[][] = [];
  let failed: string | null = null;
  let hasMore = false;
  let timeMs: number | null = null;
  const done = new Promise<void>((resolve) => {
    const off = onQuery(queryId, (m) => {
      if (m.t === 'columns') columns = m.columns;
      else if (m.t === 'rows') rows.push(...m.rows);
      else if (m.t === 'statementEnd') { hasMore = m.hasMore; timeMs = m.timeMs; }
      else if (m.t === 'statementError') failed = m.error === 'inTransaction' ? tr('Najpierw zakończ otwartą transakcję') : dbErrorMessage(m.error, m.server, ref.connectionId);
      else if (m.t === 'queryEnd') { off(); resolve(); }
    });
  });
  const r = await window.mc.db.pg.tablePage(sid, { queryId, schema: ref.schema, table: ref.table, limit: st.pageSize, offset: st.offset, sort: st.sort, ...(st.filter.trim() ? { filter: st.filter } : {}) });
  if (!r.ok) { patchTab<TableTabState>(id, { loading: false, error: resultError(r, ref.connectionId) }); return; }
  await done;
  if (failed) { patchTab<TableTabState>(id, { loading: false, error: failed }); return; }
  patchTab<TableTabState>(id, (t) => ({ loading: false, columns, rows, hasMore, timeMs, loads: t.loads + 1 }));
}

/** The SQL a save would run, with the staged set it was built from (a save from the preview applies only that set). */
export async function previewStaged(id: string): Promise<{ ok: true; sql: string; staged: string } | { ok: false; error: string }> {
  const ref = docOf(id)?.db;
  const staged = stagedOf(id);
  const edits = stagedEdits(staged);
  if (ref?.kind !== 'table' || !edits.length) return { ok: false, error: tr('Brak zmian do zapisania') };
  // The shared session may have ended since the page loaded (it reconnects here, as a save does).
  const s = await ensureShared(ref.connectionId, ref.database);
  if (!s.ok) return { ok: false, error: s.error };
  const r = await retryBusy(() => window.mc.db.pg.previewEdits(s.sessionId, { schema: ref.schema, table: ref.table, edits }));
  return r.ok ? { ok: true, sql: r.value.sql, staged: serializeStaged(staged) } : { ok: false, error: resultError(r, ref.connectionId) };
}

/** A call the host answers `busy` while a page or query runs on the session: tried again each second for up to a minute. */
async function retryBusy<T>(call: () => Promise<DbResult<T>>): Promise<DbResult<T>> {
  let r = await call();
  for (let i = 0; i < 60 && !r.ok && r.error === 'busy'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    r = await call();
  }
  return r;
}

/**
 * "Zapisz zmiany": every staged edit in one transaction; a conflict or a refusal keeps them all staged and names (and marks)
 * the row. Editing is off while it runs; afterwards exactly the sent edits leave the staged set. `expect`: the serialized set
 * the user confirmed (the SQL preview); a different set is not saved.
 */
export async function applyStaged(id: string, expect?: string): Promise<boolean> {
  const ref = docOf(id)?.db;
  const tab = useDbTabs.getState()[id] as TableTabState | undefined;
  if (tab?.saving) return false;
  const staged = stagedOf(id);
  const edits = stagedEdits(staged);
  if (ref?.kind !== 'table' || !edits.length) return true;
  if (expect !== undefined && serializeStaged(staged) !== expect) {
    tabState<TableTabState>(id, 'table');
    patchTab<TableTabState>(id, { error: tr('Zmiany różnią się od pokazanego SQL - otwórz podgląd ponownie') });
    return false;
  }
  tabState<TableTabState>(id, 'table');
  patchTab<TableTabState>(id, { saving: true, error: null, notice: null, conflict: null });
  const s = await ensureShared(ref.connectionId, ref.database);
  if (!s.ok) { patchTab<TableTabState>(id, { saving: false, error: s.error }); return false; }
  const r = await retryBusy(() => window.mc.db.pg.applyEdits(s.sessionId, { schema: ref.schema, table: ref.table, edits }));
  if (!r.ok) {
    const row = r.index !== undefined ? editRowLabel(edits[r.index]) : null;
    const error = r.error === 'conflict'
      ? tr('Wiersz {row} zmienił się lub zniknął w międzyczasie - nic nie zapisano', { row: row ?? '?' })
      : row ? `${tr('Wiersz {row}', { row })}: ${resultError(r, ref.connectionId)}` : resultError(r, ref.connectionId);
    patchTab<TableTabState>(id, { saving: false, error, conflict: failedTarget(staged, r.index) });
    return false;
  }
  setStaged(id, withoutSent(stagedOf(id), staged));
  patchTab<TableTabState>(id, { saving: false });
  await loadPage(id);
  patchTab<TableTabState>(id, { notice: tr('Zapisano zmiany: {count}', { count: r.value.affected }) });
  return true;
}

// ── SQL editor ──────────────────────────────────────────────────────────────

/**
 * The query history (1.0.6) lives in main (<data>/db/query_history.json, window.mc.db.history). The history of 1.0.0 to 1.0.5
 * (this window's storage, whole runs) moves there once, oldest first, and leaves the storage.
 */
const OLD_HISTORY_KEY = 'mc-db-history-v1';
function migrateOldHistory(): void {
  let old: ReturnType<typeof parseHistory> = {};
  try { old = parseHistory(JSON.parse(localStorage.getItem(OLD_HISTORY_KEY) ?? '{}')); } catch { /* nothing to move */ }
  try { localStorage.removeItem(OLD_HISTORY_KEY); } catch { /* storage unavailable */ }
  const live = new Set((getS().dbConnections ?? []).map((c) => c.id));
  for (const [connectionId, entries] of Object.entries(old)) {
    if (!live.has(connectionId) || !entries.length) continue;
    window.mc.db.history.record(connectionId, entries.slice(0, DB_HISTORY_LIMITS.perRun).reverse().map((e) => ({ sql: e.sql, at: e.at, timeMs: e.timeMs, rows: null, ok: e.ok })));
  }
}

/** Listeners of a connection's history (the History panel loads again after a run). */
const historyListeners = new Set<(connectionId: string) => void>();
export function onHistoryChanged(fn: (connectionId: string) => void): () => void { historyListeners.add(fn); return () => { historyListeners.delete(fn); }; }
export function historyChanged(connectionId: string): void { for (const fn of historyListeners) fn(connectionId); }

/** Records the statements of a run (main keeps them unless the history is off). */
function recordHistory(connectionId: string, records: DbHistoryRecord[]): void {
  if (!records.length) return;
  window.mc.db.history.record(connectionId, records.slice(0, DB_HISTORY_LIMITS.perRun));
  historyChanged(connectionId);
}

const queryListeners = new Map<string, () => void>();

async function sqlSession(id: string): Promise<string | null> {
  const ref = docOf(id)?.db;
  if (ref?.kind !== 'sql') return null;
  const st = tabState<SqlTabState>(id, 'sql');
  const live = st.sessionId && useDbStore.getState().sessions[st.sessionId]?.state === 'connected' ? st.sessionId : null;
  if (live) return live;
  patchTab<SqlTabState>(id, { connecting: true, error: null });
  const s = await connectTab(id, ref.connectionId, ref.database);
  patchTab<SqlTabState>(id, s.ok ? { connecting: false, sessionId: s.sessionId } : { connecting: false, error: s.error });
  return s.ok ? s.sessionId : null;
}

/** Runs `sql` (a statement, the selection or the whole script; `offset`: where it starts in the editor). */
export async function runSql(id: string, sql: string, offset: number, opts: { readWrite?: boolean } = {}): Promise<void> {
  const ref = docOf(id)?.db;
  if (ref?.kind !== 'sql' || !sql.trim()) return;
  const cur = tabState<SqlTabState>(id, 'sql');
  if (cur.running) return;
  const sid = await sqlSession(id);
  if (!sid) return;
  queryListeners.get(id)?.();
  const queryId = uid();
  const started = Date.now();
  patchTab<SqlTabState>(id, { running: true, cancelled: false, queryId, runText: sql, runOffset: offset, results: [], notices: [], shown: 0, timeMs: null, error: null });
  let pending: SqlResult[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => { timer = null; const results = pending; patchTab<SqlTabState>(id, { results: [...results] }); };
  const soon = () => { if (!timer) timer = setTimeout(flush, 60); };
  const at = (index: number) => pending.findIndex((r) => r.index === index);
  const edit = (index: number, change: (r: SqlResult) => SqlResult) => {
    const i = at(index);
    if (i < 0) return;
    pending = pending.map((r, j) => (j === i ? change(r) : r));
    soon();
  };
  const off = onQuery(queryId, (m) => {
    if (m.t === 'statement') { pending = [...pending, { index: m.index, start: m.start, end: m.end, columns: null, rows: [], command: null, rowCount: null, hasMore: false, closed: false, timeMs: null, error: null, ...(m.set ? { set: m.set } : {}) }]; soon(); }
    else if (m.t === 'columns') edit(m.index, (r) => ({ ...r, columns: m.columns }));
    // Rows are appended in place (no copy per chunk); the result object is new so the grid redraws. At most DB_UI_MAX_ROWS.
    else if (m.t === 'rows') edit(m.index, (r) => {
      const room = DB_UI_MAX_ROWS - r.rows.length;
      for (let k = 0; k < Math.min(room, m.rows.length); k++) r.rows.push(m.rows[k]);
      return { ...r, ...(m.rows.length >= room ? { capped: true } : {}) };
    });
    else if (m.t === 'statementEnd') edit(m.index, (r) => ({ ...r, command: m.command, rowCount: m.rowCount, hasMore: m.hasMore, truncated: m.truncated === true, timeMs: m.timeMs, loadingMore: false }));
    else if (m.t === 'statementError') {
      // Refused before it ran (read-only): no 'statement' message came, the split of the text says where it is.
      const span = at(m.index) < 0 ? splitSql(sql, dialectOf(ref.connectionId))[m.index] : undefined;
      if (at(m.index) < 0) pending = [...pending, { index: m.index, start: span?.start ?? 0, end: span?.end ?? 0, columns: null, rows: [], command: null, rowCount: null, hasMore: false, closed: true, timeMs: null, error: null }];
      edit(m.index, (r) => ({ ...r, error: dbErrorMessage(m.error, m.server, ref.connectionId), readOnly: m.error === 'readOnly', ...(m.server?.position ? { position: m.server.position } : {}), timeMs: m.timeMs, loadingMore: false }));
    } else if (m.t === 'resultClosed') edit(m.index, (r) => ({ ...r, closed: true, loadingMore: false }));
    else if (m.t === 'notice') patchTab<SqlTabState>(id, (t) => ({ notices: [...t.notices, m.message].slice(-500) }));
    else if (m.t === 'queryEnd') {
      if (timer) { clearTimeout(timer); flush(); }
      const results = pending;
      // The first result with rows, else the messages.
      const withRows = results.findIndex((r) => r.columns);
      patchTab<SqlTabState>(id, { running: false, timeMs: m.timeMs, cancelled: m.cancelled, results: [...results], shown: withRows >= 0 ? withRows : 'messages' });
      // Every statement that ran (further result sets of a CALL belong to their statement), with its own time and row count.
      recordHistory(ref.connectionId, results.filter((r) => !r.set && (r.command !== null || r.error !== null)).map((r) => ({
        sql: sql.slice(r.start, r.end), at: started, timeMs: r.timeMs ?? 0, rows: r.columns ? r.rows.length : r.rowCount, ok: !r.error, ...(r.error ? { error: r.error } : {}),
      })));
    }
  });
  queryListeners.set(id, off);
  const r = await window.mc.db.pg.query(sid, { queryId, sql, rowCap: DB_LIMITS.rowCap, ...(opts.readWrite ? { readWrite: true } : {}) });
  if (!r.ok) { off(); patchTab<SqlTabState>(id, { running: false, error: resultError(r, ref.connectionId) }); }
}

/** Rows one result keeps in this window; "Wczytaj więcej" stops there (with a note). */
export const DB_UI_MAX_ROWS = 200_000;

export async function loadMore(id: string, index: number): Promise<void> {
  const st = useDbTabs.getState()[id] as SqlTabState | undefined;
  const ref = docOf(id)?.db;
  if (!st?.sessionId || !st.queryId || st.running) return;
  if (st.results.find((r) => r.index === index)?.capped) return;
  patchTab<SqlTabState>(id, (t) => ({ results: t.results.map((r) => (r.index === index ? { ...r, loadingMore: true } : r)) }));
  const r = await window.mc.db.pg.fetchMore(st.sessionId, st.queryId, DB_LIMITS.rowCap);
  if (!r.ok) {
    patchTab<SqlTabState>(id, (t) => ({ results: t.results.map((x) => (x.index === index ? { ...x, loadingMore: false, hasMore: false, closed: true, ...(r.error === 'notFound' ? {} : { error: resultError(r, ref?.connectionId) }) } : x)) }));
  }
}

export async function cancelSql(id: string): Promise<void> {
  const st = useDbTabs.getState()[id] as SqlTabState | undefined;
  if (st?.sessionId && st.running) await window.mc.db.pg.cancel(st.sessionId);
}

/** BEGIN / COMMIT / ROLLBACK from the toolbar. */
export async function sqlTransaction(id: string, action: 'begin' | 'commit' | 'rollback'): Promise<void> {
  const ref = docOf(id)?.db;
  const sid = await sqlSession(id);
  if (!sid) return;
  const r = await window.mc.db.pg.transaction(sid, action);
  if (!r.ok) { patchTab<SqlTabState>(id, { error: resultError(r, ref?.connectionId) }); return; }
  patchTab<SqlTabState>(id, { error: null });
}

export const sqlTx = (id: string): DbTxStatus => {
  const st = useDbTabs.getState()[id] as SqlTabState | undefined;
  return (st?.sessionId && useDbStore.getState().sessions[st.sessionId]?.tx) || 'idle';
};

/** Open transactions of the SQL tabs (all, or of one connection): the quit, disconnect and delete questions. */
export function openTransactions(connectionId?: string): number {
  const tabs = useDbTabs.getState();
  return Object.keys(tabs).filter((id) => tabs[id].kind === 'sql' && sqlTx(id) !== 'idle' && (!connectionId || docOf(id)?.db?.connectionId === connectionId)).length;
}

/** Ends every session of a connection; SQL tabs with an open transaction are asked about first (they roll back). */
export async function disconnectAsking(connectionId: string, name: string): Promise<boolean> {
  const tx = openTransactions(connectionId);
  if (tx) {
    const choice = await askChoice(tr('Rozłączyć {name}?', { name }), tr('Otwarte transakcje: {count}. Zostaną wycofane (ROLLBACK).', { count: tx }), [
      { label: tr('Wycofaj i rozłącz'), value: 'go', danger: true },
    ]);
    if (choice !== 'go') return false;
  }
  disconnectConnection(connectionId);
  return true;
}

/** The fields of a connection its sessions were opened with (name, colour and group are not among them). */
const sessionFields = (c: DbConnection | DbConnectionInput): string =>
  JSON.stringify([c.host, c.port, c.user, c.database ?? null, c.dbIndex ?? null, c.tls, c.caPath ?? null, c.ssh ?? null, c.readOnly, c.statementTimeoutMs ?? null, c.path ?? null]);

/**
 * After a connection was changed: its live sessions still use the old settings (read-only, address, TLS, timeout). Asks to
 * reconnect them (open transactions roll back; tabs reconnect on their next action).
 */
export async function offerReconnect(before: DbConnection, after: DbConnectionInput): Promise<void> {
  if (sessionFields(before) === sessionFields(after)) return;
  const sessions = liveSessionsOf(before.id);
  if (!sessions) return;
  const tx = openTransactions(before.id);
  const body = [tr('Otwarte sesje tego połączenia ({count}) działają jeszcze z poprzednimi ustawieniami.', { count: sessions }),
    ...(tx ? [tr('Otwarte transakcje: {count}. Zostaną wycofane (ROLLBACK).', { count: tx })] : [])].join('\n');
  const choice = await askChoice(tr('Połączyć ponownie?'), body, [
    { label: tr('Połącz ponownie'), value: 'reconnect', primary: true, ...(tx ? { danger: true } : {}) },
    { label: tr('Później'), value: 'later' },
  ]);
  if (choice !== 'reconnect') return;
  const shared = Object.keys(useDbStore.getState().shared).filter((k) => k.startsWith(`${before.id}\n`)).map((k) => k.split('\n')[1]);
  disconnectConnection(before.id);
  // The tree comes back on the new settings.
  for (const database of shared) void ensureShared(before.id, database);
}

/** Table tabs of a connection with staged edits. */
export const stagedTabsOf = (connectionId: string): number =>
  useFileStore.getState().documents.filter((d) => d.db?.kind === 'table' && d.db.connectionId === connectionId && d.text).length;
export const stagedTabs = (): number => useFileStore.getState().documents.filter((d) => d.db?.kind === 'table' && d.text).length;

// ── closing ─────────────────────────────────────────────────────────────────

async function confirmClose(doc: FileDocument): Promise<boolean> {
  if (doc.redis) return confirmCloseRedis(doc);
  const ref = doc.db!;
  if (ref.kind === 'table') {
    const staged = stagedOf(doc.id);
    if (isStagedEmpty(staged)) return true;
    const choice = await askChoice(tr('Zapisać zmiany w tabeli {name}?', { name: ref.table }), tr('Zmiany czekające na zapis: {count}.', { count: stagedCount(staged) }), [
      { label: tr('Zapisz zmiany'), value: 'save', primary: true },
      { label: tr('Odrzuć zmiany'), value: 'discard', danger: true },
    ]);
    if (choice === 'save') return applyStaged(doc.id);
    return choice === 'discard';
  }
  if (ref.kind === 'sql') {
    if (sqlTx(doc.id) !== 'idle') {
      const choice = await askChoice(tr('Transakcja jest otwarta'), tr('Zamknięcie karty wycofa niezatwierdzone zmiany (ROLLBACK).'), [
        { label: tr('Wycofaj i zamknij'), value: 'rollback', danger: true },
      ]);
      if (choice !== 'rollback') return false;
      return true;
    }
    if (doc.text.trim() && doc.text !== doc.savedText) {
      const choice = await askChoice(tr('Zamknąć skrypt SQL?'), tr('Tekst zapytania w karcie {name} zostanie utracony.', { name: doc.name }), [
        { label: tr('Zamknij bez zapisywania'), value: 'discard', danger: true },
      ]);
      return choice === 'discard';
    }
  }
  return true;
}

function closed(doc: FileDocument): void {
  queryListeners.get(doc.id)?.();
  queryListeners.delete(doc.id);
  // The own session of a SQL tab ends with it (an open transaction rolls back on the server).
  if (doc.db?.kind === 'sql') releaseTab(doc.id);
  useDbTabs.setState((st) => { const next = { ...st }; delete next[doc.id]; return next; });
}

let hooked = false;
export function initDbTabs(): void {
  if (hooked) return;
  hooked = true;
  initDb();
  migrateOldHistory();
  setDbTabHooks({ confirmClose, closed });
  setDatabaseQuitWork({
    pending: () => openTransactions() > 0 || stagedTabs() > 0 || redisDraftTotal() > 0,
    ask: confirmQuitDatabase,
    subscribe: (changed) => {
      useDbStore.subscribe((st, prev) => { if (st.sessions !== prev.sessions || st.tabSessions !== prev.tabSessions) changed(); });
      useFileStore.subscribe((st, prev) => { if (st.documents !== prev.documents) changed(); });
      useRedisDrafts.subscribe((st, prev) => { if (st.drafts !== prev.drafts) changed(); });
    },
  });
}

/**
 * Resolves true when quitting may go on: no SQL tab has an open transaction, no table tab has staged edits and no Redis tab has
 * unsaved values, or the user chose "Quit anyway" (transactions roll back; staged edits stay as drafts for the next start; Redis
 * values are lost).
 */
async function confirmQuitDatabase(): Promise<boolean> {
  const tx = openTransactions();
  const staged = stagedTabs();
  const redis = redisQuitLine();
  if (!tx && !staged && !redis) return true;
  const lines = [
    ...(tx ? [tr('Otwarte transakcje: {count}. Zostaną wycofane (ROLLBACK).', { count: tx })] : []),
    ...(staged ? [tr('Tabele z niezapisanymi zmianami: {count}. Zmiany zostaną zachowane jako szkic.', { count: staged })] : []),
    ...(redis ? [redis] : []),
  ];
  const choice = await askChoice(tr('Zamknąć aplikację z niezapisaną pracą w bazach danych?'), lines.join(' '), [
    { label: tr('Zakończ mimo to'), value: 'quit', danger: true },
  ]);
  return choice === 'quit';
}
