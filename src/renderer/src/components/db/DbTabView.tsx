// What a database tab shows (1.0.0): table data (paged, sorted, filtered, edited through staged changes), a SQL editor with
// its results, or the DDL of an object. The data and results live in db/tabs.ts, so switching tabs keeps them.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DbSort, DbValue } from '../../../../shared/db';
import { DB_LIMITS, isTruncated } from '../../../../shared/db';
import { formatDbValue, parseDbInput, rowsToCsv, rowsToJson, splitSql, statementAt } from '../../../../shared/dbSql';
import { addInsert, conflictRowIndex, isDeleted, rowOriginal, txToggle, parseStaged, removeInserts, rowKey, setInsertValue, stageCell, stagedCell, stagedCount, toggleDeletes, type DbRowKey, type DbStaged } from '../../../../shared/dbTabs';
import { uid } from '../../../../shared/state';
import type { SQLNamespace } from '@codemirror/lang-sql';
import { closeFile, editFile, useFileStore, type FileDocument } from '../../files';
import { resultError, useDbStore } from '../../db/dbClient';
import {
  applyStaged, cancelSql, clearHistory, connectionOf, loadDdl, loadMore, loadPage, openSqlTab, previewStaged, readHistory, readOnlyReason, runSql, setStaged, sqlTransaction,
  tabState, useDbTabs, type SqlResult, type SqlTabState, type TableTabState, type DdlTabState,
} from '../../db/tabs';
import { useI18n } from '../../i18n';
import { askChoice, toast, useStore } from '../../store';
import { openMenuAt } from '../ContextMenu';
import { IPlay, IStop, IX } from '../icons';
import { Select } from '../Select';
import { RefreshIcon } from '../Spinner';
import { DbGrid, type GridCell, type GridColumn, type RowState } from './DbGrid';
import { DbLogin } from './DbLogin';
import { SqlEditor, type SqlEditorApi, type SqlRunRequest } from './SqlEditor';
import './db.css';

const useDoc = (): FileDocument | undefined => useFileStore((s) => s.documents.find((d) => d.id === s.activeFileId));

export function DbTabView() {
  const doc = useDoc();
  if (!doc?.db) return null;
  if (doc.db.kind === 'table') return <DbTableView key={doc.id} id={doc.id} />;
  if (doc.db.kind === 'sql') return <DbSqlView key={doc.id} id={doc.id} />;
  return <DbDdlView key={doc.id} id={doc.id} />;
}

/** Connection colour, name and database of the tab, and its session's login question. */
function TabHeader({ doc, sessionId, children }: { doc: FileDocument; sessionId: string | null; children?: React.ReactNode }) {
  const { tr } = useI18n();
  const connection = useStore((st) => st.s.dbConnections.find((c) => c.id === doc.db?.connectionId));
  const session = useDbStore((st) => (sessionId ? st.sessions[sessionId] : undefined));
  const ref = doc.db!;
  return (
    <div className="db-tab-head">
      <span className="db-color" style={{ background: connection?.color ?? 'var(--muted)' }} />
      <strong className="db-tab-conn">{connection?.name ?? tr('To połączenie zostało usunięte')}</strong>
      <span className="db-tab-path">{ref.database}{ref.kind === 'table' ? ` · ${ref.schema}.${ref.table}` : ref.kind === 'ddl' ? ` · ${ref.schema}.${ref.name}` : ''}</span>
      {(session ? session.readOnly : connection?.readOnly) && <span className="db-ro" data-field="ro" title={tr('To połączenie jest tylko do odczytu')}>RO</span>}
      {session && connection && session.readOnly !== connection.readOnly && <span className="db-meta" data-field="ro-pending" title={tr('Zmiana trybu tylko do odczytu zadziała po ponownym połączeniu')}>{tr(connection.readOnly ? 'RO po ponownym połączeniu' : 'zapis po ponownym połączeniu')}</span>}
      {session?.state === 'connected' && session.tls !== undefined && <span className={`db-tls ${session.tls ? 'on' : 'off'}`} data-field="tls"
        title={session.tls && connection?.tls !== 'verify-full' ? tr('Szyfrowane, ale certyfikat serwera nie jest sprawdzany') : undefined}>
        {!session.tls ? tr('Połączenie nieszyfrowane') : connection?.tls === 'verify-full' ? tr('Połączenie szyfrowane (TLS)') : tr('TLS bez weryfikacji certyfikatu')}</span>}
      {session?.serverVersion && <span className="db-meta" title={session.serverVersion}>{session.serverVersion.split(' ').slice(0, 2).join(' ')}</span>}
      <span className="grow" />
      {children}
    </div>
  );
}

// ── value viewer ────────────────────────────────────────────────────────────

interface ViewerTarget { title: string; kind: GridColumn['kind']; typeName: string; value: DbValue | undefined; load?: () => Promise<{ ok: true; value: string | null } | { ok: false; error: string }>; onApply?: (value: string | null) => void }

function ValueViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const { tr } = useI18n();
  const [full, setFull] = useState<{ value: string | null } | null>(() => (target.value === undefined || target.value === null || !isTruncated(target.value) ? { value: target.value ?? null } : null));
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  useEffect(() => {
    if (full || !target.load) return;
    void target.load().then((r) => (r.ok ? setFull({ value: r.value }) : setError(r.error)));
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = full ? formatDbValue(full.value, target.kind, { pretty: true }) : null;
  useEffect(() => { setText(shown ?? ''); }, [shown]);
  const apply = (asNull: boolean, compact = false) => {
    // Unchanged text (also a re-indented JSON view or line breaks the text box normalized) stages nothing.
    const norm = (t: string) => t.replace(/\r\n?/g, '\n');
    if (!asNull && full && full.value !== null && norm(text) === norm(shown ?? '')) { onClose(); return; }
    let typed = text;
    if (compact) { try { typed = JSON.stringify(JSON.parse(text)); } catch { /* checked below */ } }
    const r = parseDbInput(target.kind, typed, { asNull, typeName: target.typeName });
    if (!r.ok) { setInputError(tr(r.error)); return; }
    if (r.value === full?.value) { onClose(); return; }
    target.onApply?.(r.value);
    onClose();
  };
  return (
    <aside className="db-viewer" aria-label={target.title}>
      <div className="db-viewer-head">
        <strong>{target.title}</strong><span className="db-meta">{target.typeName}</span><span className="grow" />
        <button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={onClose}><IX /></button>
      </div>
      {error ? <div className="db-error" role="alert">{error}</div>
        : !full ? <div className="db-status">{tr('Wczytywanie…')}</div>
          : full.value === null && !target.onApply ? <div className="db-null big">NULL</div>
            : <textarea className="input mono db-viewer-text" value={text} readOnly={!target.onApply} spellCheck={false} onChange={(e) => { setText(e.target.value); setInputError(null); }} />}
      {inputError && <div className="db-error" role="alert">{inputError}</div>}
      <div className="db-viewer-foot">
        <button className="btn small" disabled={!full} onClick={() => window.mc.clipboardWrite(full?.value ?? '')}>{tr('Kopiuj')}</button>
        {target.onApply && full && <>
          <span className="grow" />
          <button className="btn small" onClick={() => apply(true)}>{tr('Ustaw NULL')}</button>
          {target.kind === 'json' && <button className="btn small" title={tr('Zapisz JSON bez wcięć')} onClick={() => apply(false, true)}>{tr('Zastosuj zwięźle')}</button>}
          <button className="btn small primary" data-action="viewer-apply" onClick={() => apply(false)}>{tr('Zastosuj')}</button>
        </>}
      </div>
    </aside>
  );
}

function SqlPreview({ sql, onClose, onSave }: { sql: string; onClose: () => void; onSave?: () => void }) {
  const { tr } = useI18n();
  return (
    <div className="db-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="modal db-preview" role="dialog" aria-label={tr('SQL zmian')}>
        <div className="modal-head"><h3>{tr('SQL zmian')}</h3><button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={onClose}><IX /></button></div>
        <div className="modal-body"><pre className="db-preview-sql">{sql}</pre></div>
        <div className="modal-foot">
          <button className="btn" onClick={() => window.mc.clipboardWrite(sql)}>{tr('Kopiuj')}</button>
          <span className="grow" />
          <button className="btn" autoFocus onClick={onClose}>{tr('Zamknij')}</button>
          {onSave && <button className="btn primary" data-action="preview-save" onClick={onSave}>{tr('Zapisz zmiany')}</button>}
        </div>
      </div>
    </div>
  );
}

async function exportRows(name: string, columns: GridColumn[], rows: DbValue[][], format: 'csv' | 'json', tr: ReturnType<typeof useI18n>['tr']): Promise<void> {
  const text = format === 'csv' ? rowsToCsv(columns, rows) : rowsToJson(columns, rows);
  const safe = name.replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 120) || 'result';
  const r = await window.mc.dbExport(`${safe}.${format}`, text);
  if (r.ok) toast(tr('Wyeksportowano: {path}', { path: r.path ?? '' }));
  else if (!r.cancelled) toast(tr('Nie udało się zapisać pliku'), 'error');
}

// ── table data ──────────────────────────────────────────────────────────────

function DbTableView({ id }: { id: string }) {
  const { tr, language } = useI18n();
  const doc = useFileStore((s) => s.documents.find((d) => d.id === id))!;
  const ref = doc.db as Extract<NonNullable<FileDocument['db']>, { kind: 'table' }>;
  const st = useDbTabs((s) => s[id] as TableTabState | undefined) ?? tabState<TableTabState>(id, 'table');
  const prompt = useDbStore((s) => Object.values(s.sessions).find((x) => x.connectionId === ref.connectionId && s.prompts[x.id] && !x.test)?.id ?? null);
  const staged: DbStaged = useMemo(() => parseStaged(doc.text), [doc.text]);
  const [filter, setFilter] = useState(st.filter);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [preview, setPreview] = useState<{ sql: string; staged: string } | null>(null);
  const sessionReadOnly = useDbStore((s) => (st.sessionId ? s.sessions[st.sessionId]?.readOnly : undefined));
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selRows, setSelRows] = useState<number[]>([]);
  const [reveal, setReveal] = useState<{ row: number; seq: number } | null>(null);
  useEffect(() => { if (!st.columns.length && !st.loading && !st.error) void loadPage(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const readOnly = readOnlyReason(ref, st.info, sessionReadOnly);
  const locked = !!readOnly || st.saving;
  const info = st.info;
  const keyCols = info?.editKey ?? null;
  const columns: GridColumn[] = useMemo(() => (st.columns.length ? st.columns : (info?.columns ?? []).map((c) => ({ name: c.name, typeName: c.typeName, kind: c.kind, typeOid: c.typeOid })))
    .map((c) => ({ name: c.name, typeName: c.typeName, kind: c.kind, key: !!keyCols?.includes(c.name) })), [st.columns, info, keyCols]);
  const fixed = useMemo(() => new Set((info?.columns ?? []).filter((c) => c.generated || c.identity).map((c) => c.name)), [info]);
  const generated = useMemo(() => new Set((info?.columns ?? []).filter((c) => c.generated).map((c) => c.name)), [info]);
  const keys = useMemo(() => st.rows.map((row) => rowKey(row, st.columns, keyCols)), [st.rows, st.columns, keyCols]);
  const rowCount = st.rows.length + staged.inserts.length;
  const insertAt = (r: number) => staged.inserts[r - st.rows.length];

  const cell = (r: number, c: number): GridCell => {
    const name = columns[c].name;
    if (r >= st.rows.length) { const ins = insertAt(r); return { value: ins && Object.hasOwn(ins.values, name) ? ins.values[name] : undefined, changed: !!ins && Object.hasOwn(ins.values, name) }; }
    const key = keys[r];
    const s = key ? stagedCell(staged, key, name) : null;
    return s ? { value: s.value, changed: true } : { value: st.rows[r][c] ?? null };
  };
  const conflictRow = conflictRowIndex(st.conflict, keys, staged, st.rows.length);
  const rowState = (r: number): RowState => (r === conflictRow ? 'conflict' : r >= st.rows.length ? 'inserted' : keys[r] && isDeleted(staged, keys[r]!) ? 'deleted' : null);
  useEffect(() => { if (conflictRow !== null) setReveal((v) => ({ row: conflictRow, seq: (v?.seq ?? 0) + 1 })); }, [st.conflict]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = (r: number, c: number) => {
    if (locked) return false;
    const name = columns[c].name;
    if (r >= st.rows.length) return !generated.has(name);
    return !!keys[r] && !fixed.has(name) && !isDeleted(staged, keys[r]!);
  };
  const onEdit = (r: number, c: number, value: string | null) => {
    const name = columns[c].name;
    if (r >= st.rows.length) { setStaged(id, setInsertValue(staged, insertAt(r).id, name, value)); return; }
    const key = keys[r];
    if (!key) return;
    const original = st.rows[r][c];
    setStaged(id, stageCell(staged, key, name, value, original === null ? null : isTruncated(original) ? undefined : original));
  };
  const openValue = (r: number, c: number) => {
    const col = columns[c];
    const value = cell(r, c).value;
    const key = r < st.rows.length ? keys[r] : null;
    setViewer({
      title: col.name, kind: col.kind, typeName: col.typeName, value,
      ...(key && value !== undefined && value !== null && isTruncated(value) && st.sessionId ? {
        load: async () => {
          const res = await window.mc.db.pg.cellValue(st.sessionId!, { schema: ref.schema, table: ref.table, key, column: col.name });
          return res.ok ? { ok: true as const, value: res.value } : { ok: false as const, error: resultError(res, ref.connectionId) };
        },
      } : {}),
      ...(canEdit(r, c) ? { onApply: (v: string | null) => onEdit(r, c, v) } : {}),
    });
  };
  const changeSort = (column: string, add: boolean) => {
    const cur = st.sort.find((s) => s.column === column);
    const next: DbSort | null = !cur ? { column, desc: false } : !cur.desc ? { column, desc: true } : null;
    const others = add ? st.sort.filter((s) => s.column !== column) : [];
    const sort = next ? [...others, next] : others;
    void loadPage(id, { sort: add ? sort : next ? [next] : [], offset: 0 });
  };
  const keysOf = (rows: number[]): Array<{ key: DbRowKey; original: Record<string, string | null> }> => rows.filter((r) => r < st.rows.length && keys[r])
    .map((r) => ({ key: keys[r]!, original: rowOriginal(st.rows[r], st.columns) }));
  const deleteRows = (rows: number[]) => {
    if (locked) return;
    const inserts = rows.filter((r) => r >= st.rows.length).map((r) => insertAt(r)?.id).filter(Boolean) as string[];
    let next = removeInserts(staged, inserts);
    next = toggleDeletes(next, keysOf(rows));
    setStaged(id, next);
  };
  const duplicateRows = (rows: number[]) => {
    if (locked) return;
    let next = staged;
    for (const r of rows) {
      const values: Record<string, string | null> = {};
      columns.forEach((col, c) => {
        const ci = info?.columns.find((x) => x.name === col.name);
        // Generated and identity columns, and key columns with a default (serial ids), are left to the server.
        if (fixed.has(col.name) || (col.key && ci?.default !== null && ci?.default !== undefined)) return;
        const v = cell(r, c).value;
        if (v === undefined || (v !== null && isTruncated(v))) return;
        values[col.name] = v;
      });
      next = addInsert(next, uid(), values);
    }
    setStaged(id, next);
  };
  const showSql = async () => {
    const r = await previewStaged(id);
    if (r.ok) setPreview({ sql: r.sql, staged: r.staged }); else toast(r.error, 'error');
  };
  const discard = async () => {
    const choice = await askChoice(tr('Cofnąć zmiany?'), tr('Zmiany czekające na zapis: {count}.', { count: stagedCount(staged) }), [{ label: tr('Cofnij zmiany'), value: 'discard', danger: true }]);
    if (choice === 'discard') setStaged(id, { updates: [], inserts: [], deletes: [] });
  };
  const nf = new Intl.NumberFormat(language);
  const pending = stagedCount(staged);
  const from = st.offset + 1;
  const to = st.offset + st.rows.length;

  return (
    <section className="db-tab db-table-tab" aria-label={doc.name}>
      <TabHeader doc={doc} sessionId={st.sessionId}>
        {info?.rowEstimate !== null && info?.rowEstimate !== undefined && info.rowEstimate >= 0 && <span className="db-meta" title={tr('Szacunek z pg_class.reltuples')}>{tr('około {count} wierszy', { count: nf.format(Math.round(info.rowEstimate)) })}</span>}
        {st.timeMs !== null && <span className="db-meta">{st.timeMs} ms</span>}
      </TabHeader>
      <div className="db-toolbar">
        <button className="btn small ghost" title={tr('Odśwież')} aria-label={tr('Odśwież')} data-action="refresh" onClick={() => void loadPage(id)}><RefreshIcon spinning={st.loading} /></button>
        <form className="db-where" onSubmit={(e) => { e.preventDefault(); void loadPage(id, { filter, offset: 0 }); }}>
          <span className="db-where-label">WHERE</span>
          <input className="input mono" data-field="where" value={filter} spellCheck={false} placeholder="id > 100 AND name ILIKE '%a%'" maxLength={DB_LIMITS.filter}
            title={tr('Warunek działa w transakcji tylko do odczytu, ale nie jest piaskownicą: wpisuj tylko warunki, którym ufasz.')}
            onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); void loadPage(id, { filter: '', offset: 0 }); } }} />
          {st.filter && <button type="button" className="btn small ghost" onClick={() => { setFilter(''); void loadPage(id, { filter: '', offset: 0 }); }}>{tr('Wyczyść')}</button>}
        </form>
        <span className="db-sep" />
        <Select className="select db-pagesize" value={String(st.pageSize)} aria-label={tr('Wierszy na stronę')} onChange={(e) => void loadPage(id, { pageSize: Number(e.target.value), offset: 0 })}>
          {DB_LIMITS.pageSizes.map((n) => <option key={n} value={String(n)}>{n}</option>)}
        </Select>
        <button className="btn small ghost" disabled={st.offset === 0 || st.loading} aria-label={tr('Pierwsza strona')} onClick={() => void loadPage(id, { offset: 0 })}>«</button>
        <button className="btn small ghost" disabled={st.offset === 0 || st.loading} aria-label={tr('Poprzednia strona')} data-action="prev-page" onClick={() => void loadPage(id, { offset: Math.max(0, st.offset - st.pageSize) })}>‹</button>
        <span className="db-pageinfo" data-field="pageinfo">{st.rows.length ? `${nf.format(from)}-${nf.format(to)}` : '0'}</span>
        <button className="btn small ghost" disabled={!st.hasMore || st.loading} aria-label={tr('Następna strona')} data-action="next-page" onClick={() => void loadPage(id, { offset: st.offset + st.pageSize })}>›</button>
      </div>
      <div className="db-toolbar db-edit-bar">
        {readOnly ? <span className="db-note" data-field="readonly-note">{readOnly}</span> : <>
          <button className="btn small" data-action="add-row" disabled={st.saving} onClick={() => { setStaged(id, addInsert(staged, uid())); setReveal((r) => ({ row: rowCount, seq: (r?.seq ?? 0) + 1 })); }}>{tr('Dodaj wiersz')}</button>
          <button className="btn small" disabled={!selRows.length || st.saving} onClick={() => duplicateRows(selRows)}>{tr('Duplikuj')}</button>
          <button className="btn small" disabled={!selRows.length || st.saving} data-action="delete-rows" onClick={() => deleteRows(selRows)}>{tr('Usuń')}</button>
        </>}
        <span className="grow" />
        {pending > 0 && <span className="db-pending" data-field="pending">{tr('Zmiany do zapisania: {count}', { count: pending })}</span>}
        {pending > 0 && <button className="btn small" data-action="show-sql" onClick={() => void showSql()}>{tr('Pokaż SQL')}</button>}
        {pending > 0 && <button className="btn small" data-action="discard" disabled={st.saving} onClick={() => void discard()}>{tr('Cofnij zmiany')}</button>}
        {pending > 0 && <button className="btn small primary" data-action="save" disabled={st.saving || !!readOnly} onClick={() => void applyStaged(id)}>{st.saving ? tr('Zapisywanie…') : tr('Zapisz zmiany')}</button>}
        <button className="btn small ghost" disabled={!st.rows.length} onClick={(e) => openMenuAt(e.currentTarget, [
          { header: tr('Eksportuj stronę') },
          { label: 'CSV', onClick: () => void exportRows(ref.table, columns, st.rows, 'csv', tr) },
          { label: 'JSON', onClick: () => void exportRows(ref.table, columns, st.rows, 'json', tr) },
        ])}>{tr('Eksport')}</button>
      </div>
      {prompt && <div className="db-tab-login"><DbLogin sessionId={prompt} /></div>}
      {st.error && <div className="db-error" role="alert" data-field="error">{st.error}<button className="btn small ghost" onClick={() => void loadPage(id)}>{tr('Ponów')}</button></div>}
      {st.notice && <div className="db-notice" role="status">{st.notice}</div>}
      <div className="db-tab-body">
        <DbGrid label={doc.name} columns={columns} rowCount={rowCount} cell={cell} rowState={rowState} firstNumber={from} sort={st.sort}
          onSort={changeSort} canEdit={canEdit} onEdit={onEdit} onOpenValue={openValue} onDeleteKey={locked ? undefined : deleteRows}
          resetKey={st.loads} widths={widths} onWidths={setWidths} emptyText={st.loading ? tr('Wczytywanie…') : st.error ? ' ' : undefined}
          onSelectRows={setSelRows} reveal={reveal}
          menuItems={(rows) => locked ? [] : [
            { label: tr('Duplikuj wiersz'), onClick: () => duplicateRows(rows) },
            { label: rows.every((r) => rowState(r) === 'deleted') ? tr('Przywróć wiersze') : tr('Usuń wiersze'), danger: true, onClick: () => deleteRows(rows) },
          ]} />
        {viewer && <ValueViewer target={viewer} onClose={() => setViewer(null)} />}
      </div>
      {preview !== null && <SqlPreview sql={preview.sql} onClose={() => setPreview(null)}
        onSave={readOnly || st.saving ? undefined : () => { const expect = preview.staged; setPreview(null); void applyStaged(id, expect); }} />}
    </section>
  );
}

// ── SQL editor ──────────────────────────────────────────────────────────────

function DbSqlView({ id }: { id: string }) {
  const { tr } = useI18n();
  const doc = useFileStore((s) => s.documents.find((d) => d.id === id))!;
  const ref = doc.db as Extract<NonNullable<FileDocument['db']>, { kind: 'sql' }>;
  const st = useDbTabs((s) => s[id] as SqlTabState | undefined) ?? tabState<SqlTabState>(id, 'sql');
  const session = useDbStore((s) => (st.sessionId ? s.sessions[st.sessionId] : undefined));
  const prompt = useDbStore((s) => (st.sessionId && s.prompts[st.sessionId] ? st.sessionId : null));
  const tx = session?.tx ?? 'idle';
  const api = useRef<SqlEditorApi | null>(null);
  const loads = useDbStore((s) => s.loads);
  const schema = useMemo<SQLNamespace | undefined>(() => {
    const ns: Record<string, Record<string, string[]>> = {};
    for (const [key, load] of Object.entries(loads)) {
      const k = JSON.parse(key) as string[];
      if (k[0] !== 'objects' || k[1] !== ref.connectionId || k[2] !== ref.database || load.status !== 'ready') continue;
      ns[k[3]] = Object.fromEntries((load.value as Array<{ name: string }>).map((o) => [o.name, []]));
    }
    return Object.keys(ns).length ? ns : undefined;
  }, [loads, ref.connectionId, ref.database]);
  const [split, setSplit] = useState(0.5);
  const body = useRef<HTMLDivElement>(null);

  const run = (req: SqlRunRequest, opts: { readWrite?: boolean } = {}) => {
    if (req.kind === 'script') { void runSql(id, req.text, 0, opts); return; }
    if (req.to > req.from) { void runSql(id, req.text.slice(req.from, req.to), req.from, opts); return; }
    const span = statementAt(req.text, req.cursor);
    if (!span) return;
    api.current?.select(span.start, span.end);
    void runSql(id, span.text, span.start, opts);
  };
  const shown = st.shown === 'messages' ? null : st.results.find((r) => r.index === st.shown) ?? st.results[0] ?? null;
  const showError = (r: SqlResult) => {
    if (!r.position) return;
    const at = st.runOffset + r.start + r.position - 1;
    api.current?.markError(at, Math.min(at + 1, st.runOffset + r.end));
  };
  useEffect(() => { const err = st.results.find((r) => r.error && r.position); if (err && !st.running) showError(err); }, [st.running]); // eslint-disable-line react-hooks/exhaustive-deps
  const overrideRun = async () => {
    // Nothing of the refused run ran (read-only is checked before the first statement): the whole run goes again, shown here.
    const statements = splitSql(st.runText);
    const listed = statements.slice(0, 8).map((s, i) => `${i + 1}. ${s.text.replace(/\s+/g, ' ').slice(0, 160)}`);
    const more = statements.length > listed.length ? `\n${tr('…i jeszcze {count}', { count: statements.length - listed.length })}` : '';
    const body = `${tr('To połączenie jest tylko do odczytu. Ten jeden raz zapytanie może zmienić dane.')}\n\n${tr('Instrukcje do uruchomienia: {count}', { count: statements.length })}\n${listed.join('\n')}${more}`;
    const choice = await askChoice(tr('Uruchomić z zapisem?'), body, [{ label: tr('Uruchom z zapisem'), value: 'run', danger: true }]);
    if (choice === 'run') void runSql(id, st.runText, st.runOffset, { readWrite: true });
  };
  const toggleTx = async (on: boolean) => {
    const action = txToggle(tx, on);
    if (action === 'begin' || action === 'rollback') { void sqlTransaction(id, action); return; }
    if (action !== 'ask') return;
    const choice = await askChoice(tr('Zakończyć transakcję?'), tr('Zatwierdź zmiany (COMMIT) albo je wycofaj (ROLLBACK).'), [
      { label: 'COMMIT', value: 'commit', primary: true },
      { label: 'ROLLBACK', value: 'rollback', danger: true },
    ]);
    if (choice === 'commit' || choice === 'rollback') void sqlTransaction(id, choice);
  };
  const historyMenu = (el: HTMLElement) => {
    const list = readHistory(ref.connectionId).slice(0, 30);
    openMenuAt(el, list.length ? [
      { header: tr('Historia zapytań') },
      { label: tr('Wyczyść historię'), danger: true, onClick: () => clearHistory(ref.connectionId) },
      { sep: true },
      ...list.map((h) => ({ label: h.sql.replace(/\s+/g, ' ').slice(0, 90), hint: `${h.ok ? '' : '! '}${new Date(h.at).toLocaleTimeString()}`, onClick: () => useFileStore.setState((s) => ({ documents: s.documents.map((d) => (d.id === id ? { ...d, text: d.text ? `${d.text.replace(/\s*$/, '')}\n\n${h.sql}` : h.sql } : d)) })) })),
    ] : [{ header: tr('Historia zapytań jest pusta') }]);
  };
  const dragSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = body.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => setSplit(Math.max(0.15, Math.min(0.85, (ev.clientY - box.top) / box.height)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const rowsCountLabel = (r: SqlResult) => (r.columns ? tr('{count} wierszy', { count: r.rows.length }) + (r.hasMore ? '+' : '') : r.error ? tr('błąd') : r.command ?? '');

  return (
    <section className="db-tab db-sql-tab" aria-label={doc.name}>
      <TabHeader doc={doc} sessionId={st.sessionId}>
        {st.connecting && <span className="db-meta">{tr('łączenie…')}</span>}
        {session?.state === 'connected' && <span className="db-state connected" title={tr('połączono')} />}
      </TabHeader>
      <div className="db-toolbar">
        <button className="btn small primary" data-action="run" disabled={st.running} title={tr('Uruchom instrukcję pod kursorem lub zaznaczenie (Ctrl+Enter)')} onClick={() => api.current && run(api.current.request('auto'))}><IPlay /> {tr('Uruchom')}</button>
        <button className="btn small" data-action="run-script" disabled={st.running} title={tr('Uruchom cały skrypt (Ctrl+Shift+Enter)')} onClick={() => api.current && run(api.current.request('script'))}>{tr('Uruchom skrypt')}</button>
        <button className="btn small" data-action="cancel" disabled={!st.running} onClick={() => void cancelSql(id)}><IStop /> {tr('Anuluj')}</button>
        <span className="db-sep" />
        <label className="check db-txmode" title={tr('Tryb transakcji: zmiany czekają na COMMIT albo ROLLBACK')}>
          <input type="checkbox" data-field="txmode" checked={tx !== 'idle'} disabled={st.running} onChange={(e) => void toggleTx(e.target.checked)} />
          {tr('Transakcja')}
        </label>
        {tx !== 'idle' && <>
          <span className={`db-tx ${tx}`} data-field="tx">{tx === 'failed' ? tr('transakcja przerwana - tylko ROLLBACK') : tr('transakcja otwarta')}</span>
          <button className="btn small" data-action="commit" disabled={st.running || tx === 'failed'} onClick={() => void sqlTransaction(id, 'commit')}>COMMIT</button>
          <button className="btn small" data-action="rollback" disabled={st.running} onClick={() => void sqlTransaction(id, 'rollback')}>ROLLBACK</button>
        </>}
        <span className="grow" />
        {st.timeMs !== null && !st.running && <span className="db-meta">{st.cancelled ? tr('anulowano') : ''} {st.timeMs} ms</span>}
        {st.running && <span className="db-meta"><RefreshIcon spinning /> {tr('Wykonywanie…')}</span>}
        <button className="btn small ghost" onClick={(e) => historyMenu(e.currentTarget)}>{tr('Historia')}</button>
      </div>
      {prompt && <div className="db-tab-login"><DbLogin sessionId={prompt} /></div>}
      {st.error && <div className="db-error" role="alert" data-field="error">{st.error}</div>}
      <div className="db-sql-body" ref={body}>
        <div className="db-sql-top" style={{ flexBasis: `${split * 100}%` }}>
          <SqlEditor text={doc.text} label={doc.name} schema={schema} onApi={(a) => { api.current = a; }}
            onChange={(text) => editFile(id, text)}
            onRun={(req) => run(req)} />
        </div>
        <div className="db-split" onMouseDown={dragSplit} role="separator" aria-orientation="horizontal" />
        <div className="db-results">
          <div className="db-result-tabs" role="tablist">
            {st.results.map((r, i) => (
              <button key={r.index} role="tab" aria-selected={shown?.index === r.index} className={`db-result-tab ${shown?.index === r.index ? 'on' : ''} ${r.error ? 'error' : ''}`}
                onClick={() => { useDbTabs.setState((s) => ({ ...s, [id]: { ...(s[id] as SqlTabState), shown: r.index } })); if (r.error) showError(r); }}>
                {tr('Wynik {n}', { n: i + 1 })} <span className="db-meta">{rowsCountLabel(r)}</span>
              </button>
            ))}
            <button role="tab" aria-selected={st.shown === 'messages'} className={`db-result-tab ${st.shown === 'messages' ? 'on' : ''}`} data-tab="messages"
              onClick={() => useDbTabs.setState((s) => ({ ...s, [id]: { ...(s[id] as SqlTabState), shown: 'messages' } }))}>{tr('Wiadomości')}</button>
          </div>
          {st.shown === 'messages' || !shown ? (
            <div className="db-messages" data-field="messages">
              {!st.results.length && !st.running && <div className="db-status">{tr('Uruchom zapytanie: Ctrl+Enter (instrukcja pod kursorem) albo Ctrl+Shift+Enter (cały skrypt).')}</div>}
              {st.results.map((r, i) => (
                <div key={r.index} className={`db-msg ${r.error ? 'error' : ''}`}>
                  <span className="db-msg-n">{i + 1}</span>
                  <span className="db-msg-sql">{st.runText.slice(r.start, r.end).replace(/\s+/g, ' ').slice(0, 160)}</span>
                  <span className="db-msg-res">{r.error ?? `${r.command ?? ''}${r.rowCount !== null ? ` · ${tr('wiersze: {count}', { count: r.rowCount })}` : ''}`}{r.timeMs !== null ? ` · ${r.timeMs} ms` : ''}</span>
                  {r.readOnly && <button className="btn small" onClick={() => void overrideRun()}>{tr('Uruchom z zapisem (jednorazowo)')}</button>}
                </div>
              ))}
              {st.cancelled && <div className="db-msg error">{tr('Zapytanie anulowano')}</div>}
              {st.notices.map((n, i) => <div key={`n${i}`} className="db-msg notice">{n}</div>)}
            </div>
          ) : shown.error ? (
            <div className="db-messages"><div className="db-msg error" data-field="result-error">{shown.error}
              {shown.readOnly && <button className="btn small" onClick={() => void overrideRun()}>{tr('Uruchom z zapisem (jednorazowo)')}</button>}</div></div>
          ) : shown.columns ? (
            <ResultGrid key={`${st.queryId}:${shown.index}`} id={id} result={shown} name={doc.name} />
          ) : (
            <div className="db-messages"><div className="db-msg" data-field="affected">{shown.command}{shown.rowCount !== null ? ` · ${tr('wiersze: {count}', { count: shown.rowCount })}` : ''}{shown.timeMs !== null ? ` · ${shown.timeMs} ms` : ''}</div></div>
          )}
        </div>
      </div>
    </section>
  );
}

function ResultGrid({ id, result, name }: { id: string; result: SqlResult; name: string }) {
  const { tr } = useI18n();
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const columns: GridColumn[] = (result.columns ?? []).map((c) => ({ name: c.name, typeName: c.typeName, kind: c.kind }));
  const cell = (r: number, c: number): GridCell => ({ value: result.rows[r]?.[c] ?? null });
  return (
    <div className="db-result-body">
      <div className="db-tab-body">
        <DbGrid label={name} columns={columns} rowCount={result.rows.length} cell={cell} widths={widths} onWidths={setWidths}
          onOpenValue={(r, c) => setViewer({ title: columns[c].name, kind: columns[c].kind, typeName: columns[c].typeName, value: result.rows[r][c] })} />
        {viewer && <ValueViewer target={viewer} onClose={() => setViewer(null)} />}
      </div>
      <div className="db-result-foot">
        <span className="db-meta" data-field="result-rows">{tr('{count} wierszy', { count: result.rows.length })}{result.timeMs !== null ? ` · ${result.timeMs} ms` : ''}</span>
        {result.capped && <span className="db-note" data-field="capped">{tr('Wczytano {count} wierszy - więcej nie mieści się w tym widoku', { count: result.rows.length })}</span>}
        {result.hasMore && !result.closed && !result.capped && <button className="btn small" data-action="load-more" disabled={result.loadingMore} onClick={() => void loadMore(id, result.index)}>{result.loadingMore ? tr('Wczytywanie…') : tr('Wczytaj więcej')}</button>}
        {result.truncated && <span className="db-note">{tr('Wynik obcięty do {count} wierszy (instrukcja nie jest zwykłym odczytem)', { count: result.rows.length })}</span>}
        {result.hasMore && result.closed && <span className="db-note">{tr('Wynik zamknięty - uruchom zapytanie ponownie, aby wczytać więcej')}</span>}
        <span className="grow" />
        <button className="btn small ghost" disabled={!result.rows.length} onClick={(e) => openMenuAt(e.currentTarget, [
          { header: tr('Eksportuj wynik') },
          { label: 'CSV', onClick: () => void exportRows(name, columns, result.rows, 'csv', tr) },
          { label: 'JSON', onClick: () => void exportRows(name, columns, result.rows, 'json', tr) },
        ])}>{tr('Eksport')}</button>
      </div>
    </div>
  );
}

// ── DDL ─────────────────────────────────────────────────────────────────────

function DbDdlView({ id }: { id: string }) {
  const { tr } = useI18n();
  const doc = useFileStore((s) => s.documents.find((d) => d.id === id))!;
  const ref = doc.db as Extract<NonNullable<FileDocument['db']>, { kind: 'ddl' }>;
  const st = useDbTabs((s) => s[id] as DdlTabState | undefined);
  useEffect(() => { if (!st) void loadDdl(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const connection = connectionOf(ref);
  return (
    <section className="db-tab db-ddl-tab" aria-label={doc.name}>
      <TabHeader doc={doc} sessionId={null}>
        <span className="db-meta">DDL</span>
      </TabHeader>
      <div className="db-toolbar">
        <button className="btn small ghost" aria-label={tr('Odśwież')} onClick={() => void loadDdl(id)}><RefreshIcon spinning={!!st?.loading} /></button>
        <button className="btn small" disabled={!st?.text} onClick={() => window.mc.clipboardWrite(st?.text ?? '')}>{tr('Kopiuj')}</button>
        <button className="btn small" disabled={!st?.text || !connection} onClick={() => openSqlTab(ref.connectionId, ref.database, st?.text ?? '')}>{tr('Otwórz w edytorze SQL')}</button>
        <span className="grow" />
        <button className="btn small ghost" onClick={() => void closeFile(id)}>{tr('Zamknij')}</button>
      </div>
      {st?.error && <div className="db-error" role="alert">{st.error}</div>}
      <div className="db-tab-body">{st?.text ? <SqlEditor text={st.text} readOnly label={doc.name} /> : <div className="db-status">{st?.loading ? tr('Wczytywanie…') : ''}</div>}</div>
    </section>
  );
}

