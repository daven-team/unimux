// Database tabs in the top strip (1.0.0): table data, SQL editor and DDL tabs are editor tabs (FileDocument with `db`), so
// the strip, its order, Mod+Tab, closing and drafts work as for files. What a tab shows (rows, results, its session) lives
// here, outside React, so switching tabs keeps it. Staged edits of a table tab are its draft text; a SQL tab's text is the script.
import { create } from 'zustand';
import type { DbColumn, DbConnection, DbObjectKind, DbSort, DbTableInfo, DbTxStatus, DbValue } from '../../../shared/db';
import { DB_LIMITS } from '../../../shared/db';
import { dbTabId, editRowLabel, EMPTY_STAGED, isStagedEmpty, nextSqlName, parseHistory, parseStaged, pushHistory, serializeStaged, stagedCount, stagedEdits, type DbHistoryEntry, type DbStaged, type DbTabRef } from '../../../shared/dbTabs';
import { uid } from '../../../shared/state';
import { activateFile, editFile, setDbTabHooks, useFileStore, type FileDocument } from '../files';
import { tr } from '../i18n';
import { askChoice, getS, setUi } from '../store';
import { useSshStore } from '../sshStore';
import { connectTab, dbErrorMessage, ensureShared, initDb, onQuery, releaseTab, resultError, useDbStore } from './dbClient';

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
  /** Its cursor was closed: no more rows can be loaded. */
  closed: boolean;
  timeMs: number | null;
  error: string | null;
  /** The error was a read-only refusal (the run may be repeated with writes allowed). */
  readOnly?: boolean;
  /** 1-based position of the error in the submitted text. */
  position?: number;
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
  /** The explicit transaction mode is on (BEGIN was sent from the toolbar). */
  txMode: boolean;
}

export interface DdlTabState { kind: 'ddl'; loading: boolean; text: string; error: string | null }

export type TabState = TableTabState | SqlTabState | DdlTabState;
export const useDbTabs = create<Record<string, TabState>>(() => ({}));

const patchTab = <T extends TabState>(id: string, change: Partial<T> | ((t: T) => Partial<T>)) => useDbTabs.setState((st) => {
  const cur = st[id] as T | undefined;
  if (!cur) return st;
  return { ...st, [id]: { ...cur, ...(typeof change === 'function' ? change(cur) : change) } };
});

const newTable = (): TableTabState => ({ kind: 'table', sessionId: null, info: null, columns: [], rows: [], offset: 0, pageSize: 100, sort: [], filter: '', hasMore: false, loading: false, saving: false, timeMs: null, error: null, notice: null, loads: 0 });
const newSql = (): SqlTabState => ({ kind: 'sql', sessionId: null, connecting: false, running: false, queryId: null, runText: '', runOffset: 0, results: [], notices: [], shown: 0, timeMs: null, cancelled: false, error: null, txMode: false });
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

export function openTableTab(connectionId: string, database: string, schema: string, table: string, objectKind: DbObjectKind): string {
  const id = openTab({ kind: 'table', connectionId, database, schema, table, objectKind }, table, `${connName(connectionId)} · ${database} · ${schema}.${table}`);
  const st = tabState<TableTabState>(id, 'table');
  if (!st.columns.length && !st.loading) void loadPage(id);
  return id;
}

export function openSqlTab(connectionId: string, database: string, text = ''): string {
  const used = useFileStore.getState().documents.filter((d) => d.db?.kind === 'sql' && d.db.connectionId === connectionId).map((d) => d.name);
  const name = nextSqlName(used);
  const id = openTab({ kind: 'sql', connectionId, database, uid: uid() }, name, `${connName(connectionId)} · ${database} · ${name}`, text);
  tabState<SqlTabState>(id, 'sql');
  return id;
}

export function openDdlTab(connectionId: string, database: string, schema: string, name: string, objectKind: DbObjectKind, args?: string): string {
  const id = openTab({ kind: 'ddl', connectionId, database, schema, name, objectKind, ...(args ? { args } : {}) }, name, `${connName(connectionId)} · ${database} · ${schema}.${name} (DDL)`);
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
export function readOnlyReason(ref: DbTabRef | undefined, info: DbTableInfo | null): string | null {
  if (ref?.kind !== 'table') return null;
  if (connectionOf(ref)?.readOnly) return tr('To połączenie jest tylko do odczytu');
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

export async function previewStaged(id: string): Promise<{ ok: true; sql: string } | { ok: false; error: string }> {
  const ref = docOf(id)?.db;
  const st = useDbTabs.getState()[id] as TableTabState | undefined;
  const edits = stagedEdits(stagedOf(id));
  if (ref?.kind !== 'table' || !st?.sessionId || !edits.length) return { ok: false, error: tr('Brak zmian do zapisania') };
  const r = await window.mc.db.pg.previewEdits(st.sessionId, { schema: ref.schema, table: ref.table, edits });
  return r.ok ? { ok: true, sql: r.value.sql } : { ok: false, error: resultError(r, ref.connectionId) };
}

/** "Zapisz zmiany": every staged edit in one transaction; a conflict or a refusal keeps them all staged and names the row. */
export async function applyStaged(id: string): Promise<boolean> {
  const ref = docOf(id)?.db;
  const staged = stagedOf(id);
  const edits = stagedEdits(staged);
  if (ref?.kind !== 'table' || !edits.length) return true;
  const s = await ensureShared(ref.connectionId, ref.database);
  if (!s.ok) { patchTab<TableTabState>(id, { error: s.error }); return false; }
  patchTab<TableTabState>(id, { saving: true, error: null, notice: null });
  const r = await window.mc.db.pg.applyEdits(s.sessionId, { schema: ref.schema, table: ref.table, edits });
  if (!r.ok) {
    const row = r.index !== undefined ? editRowLabel(edits[r.index]) : null;
    const error = r.error === 'conflict'
      ? tr('Wiersz {row} zmienił się lub zniknął w międzyczasie - nic nie zapisano', { row: row ?? '?' })
      : row ? `${tr('Wiersz {row}', { row })}: ${resultError(r, ref.connectionId)}` : resultError(r, ref.connectionId);
    patchTab<TableTabState>(id, { saving: false, error });
    return false;
  }
  // Edits staged while saving stay staged.
  const now = stagedOf(id);
  if (serializeStaged(now) === serializeStaged(staged)) setStaged(id, EMPTY_STAGED);
  patchTab<TableTabState>(id, { saving: false });
  await loadPage(id);
  patchTab<TableTabState>(id, { notice: tr('Zapisano zmiany: {count}', { count: r.value.affected }) });
  return true;
}

// ── SQL editor ──────────────────────────────────────────────────────────────

const HISTORY_KEY = 'mc-db-history-v1';
export function readHistory(connectionId: string): DbHistoryEntry[] {
  try { return parseHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}'))[connectionId] ?? []; } catch { return []; }
}
function addHistory(connectionId: string, entry: DbHistoryEntry): void {
  try {
    const all = parseHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}'));
    all[connectionId] = pushHistory(all[connectionId] ?? [], entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch { /* history is a convenience */ }
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
    if (m.t === 'statement') { pending = [...pending, { index: m.index, start: m.start, end: m.end, columns: null, rows: [], command: null, rowCount: null, hasMore: false, closed: false, timeMs: null, error: null }]; soon(); }
    else if (m.t === 'columns') edit(m.index, (r) => ({ ...r, columns: m.columns }));
    else if (m.t === 'rows') edit(m.index, (r) => ({ ...r, rows: r.rows.concat(m.rows) }));
    else if (m.t === 'statementEnd') edit(m.index, (r) => ({ ...r, command: m.command, rowCount: m.rowCount, hasMore: m.hasMore, timeMs: m.timeMs, loadingMore: false }));
    else if (m.t === 'statementError') {
      if (at(m.index) < 0) pending = [...pending, { index: m.index, start: 0, end: 0, columns: null, rows: [], command: null, rowCount: null, hasMore: false, closed: true, timeMs: null, error: null }];
      edit(m.index, (r) => ({ ...r, error: dbErrorMessage(m.error, m.server, ref.connectionId), readOnly: m.error === 'readOnly', ...(m.server?.position ? { position: m.server.position } : {}), timeMs: m.timeMs, loadingMore: false }));
    } else if (m.t === 'resultClosed') edit(m.index, (r) => ({ ...r, closed: true, loadingMore: false }));
    else if (m.t === 'notice') patchTab<SqlTabState>(id, (t) => ({ notices: [...t.notices, m.message].slice(-500) }));
    else if (m.t === 'queryEnd') {
      if (timer) { clearTimeout(timer); flush(); }
      const results = pending;
      const ok = m.ok && !results.some((r) => r.error);
      // The first result with rows, else the messages.
      const withRows = results.findIndex((r) => r.columns);
      patchTab<SqlTabState>(id, { running: false, timeMs: m.timeMs, cancelled: m.cancelled, results: [...results], shown: withRows >= 0 ? withRows : 'messages' });
      addHistory(ref.connectionId, { sql, at: started, ok, timeMs: m.timeMs });
    }
  });
  queryListeners.set(id, off);
  const r = await window.mc.db.pg.query(sid, { queryId, sql, rowCap: DB_LIMITS.rowCap, ...(opts.readWrite ? { readWrite: true } : {}) });
  if (!r.ok) { off(); patchTab<SqlTabState>(id, { running: false, error: resultError(r, ref.connectionId) }); }
}

export async function loadMore(id: string, index: number): Promise<void> {
  const st = useDbTabs.getState()[id] as SqlTabState | undefined;
  const ref = docOf(id)?.db;
  if (!st?.sessionId || !st.queryId || st.running) return;
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
  patchTab<SqlTabState>(id, { txMode: action === 'begin', error: null });
}

export const sqlTx = (id: string): DbTxStatus => {
  const st = useDbTabs.getState()[id] as SqlTabState | undefined;
  return (st?.sessionId && useDbStore.getState().sessions[st.sessionId]?.tx) || 'idle';
};

/** Open transactions of all SQL tabs (the quit question). */
export function openTransactions(): number {
  const tabs = useDbTabs.getState();
  return Object.keys(tabs).filter((id) => tabs[id].kind === 'sql' && sqlTx(id) !== 'idle').length;
}
export const stagedTabs = (): number => useFileStore.getState().documents.filter((d) => d.db?.kind === 'table' && d.text).length;

// ── closing ─────────────────────────────────────────────────────────────────

async function confirmClose(doc: FileDocument): Promise<boolean> {
  const ref = doc.db!;
  if (ref.kind === 'table') {
    const staged = stagedOf(doc.id);
    if (isStagedEmpty(staged)) return true;
    const choice = await askChoice(tr('Zapisać zmiany w tabeli {name}?', { name: ref.table }), tr('Zmiany czekające na zapis: {count}.', { count: stagedCount(staged) }), [
      { label: tr('Zapisz zmiany'), value: 'save', primary: true },
      { label: tr('Odrzuć zmiany'), value: 'discard', danger: true },
      { label: tr('Anuluj'), value: 'cancel' },
    ]);
    if (choice === 'save') return applyStaged(doc.id);
    return choice === 'discard';
  }
  if (ref.kind === 'sql') {
    if (sqlTx(doc.id) !== 'idle') {
      const choice = await askChoice(tr('Transakcja jest otwarta'), tr('Zamknięcie karty wycofa niezatwierdzone zmiany (ROLLBACK).'), [
        { label: tr('Wycofaj i zamknij'), value: 'rollback', danger: true },
        { label: tr('Anuluj'), value: 'cancel' },
      ]);
      if (choice !== 'rollback') return false;
      return true;
    }
    if (doc.text.trim() && doc.text !== doc.savedText) {
      const choice = await askChoice(tr('Zamknąć skrypt SQL?'), tr('Tekst zapytania w karcie {name} zostanie utracony.', { name: doc.name }), [
        { label: tr('Zamknij bez zapisywania'), value: 'discard', danger: true },
        { label: tr('Anuluj'), value: 'cancel' },
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
  setDbTabHooks({ confirmClose, closed });
}
