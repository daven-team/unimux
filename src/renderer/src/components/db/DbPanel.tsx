// The "Bazy danych" rail panel (1.0.0): saved connections by group with their colour, type and state, and under a connected
// Postgres connection its databases, schemas, objects and, for tables and views, columns, keys and indexes. Lists load lazily
// (dbTree says what an expanded node waits for) and the rows are windowed, so schemas with thousands of tables stay light.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { openRedisTab, viewLabel } from '../../redis/redisClient';
import { dbEndpoint, type DbConnection } from '../../../../shared/db';
import { buildDbTree, nodeKey, toggleNode, type DbFolder, type DbPart, type DbTreeRow } from '../../../../shared/dbTree';
import { hasRows } from '../../../../shared/dbTabs';
import { quoteIdent } from '../../../../shared/dbSql';
import { rowWindow } from '../../../../shared/virtualRows';
import type { MessageKey } from '../../../../shared/i18n';
import { connectionState, ensureShared, initDb, isLive, refreshLoads, runLoad, sharedKey, useDbStore } from '../../db/dbClient';
import { disconnectAsking, initDbTabs, openDdlTab, openSqlTab, openTableTab, openTransactions, pruneStoredHistory, stagedTabsOf } from '../../db/tabs';
import { useI18n } from '../../i18n';
import { askChoice, setUi, toast, useStore } from '../../store';
import { openMenu, openMenuAt, type MenuItem } from '../ContextMenu';
import { IChevron, IColumn, IDatabase, IFolder, IFunction, IKey, IPlus, ISequence, ITable, IView } from '../icons';
import { EmptyLink, fillTokens, PanelEmpty } from '../PanelEmpty';
import { DbKindIcon } from './DbKindIcon';
import { DbLogin } from './DbLogin';
import './db.css';

const ROW = 24;
const FOLDER_LABEL: Record<DbFolder, MessageKey> = { tables: 'Tabele', views: 'Widoki', matviews: 'Widoki zmaterializowane', sequences: 'Sekwencje', functions: 'Funkcje' };
const PART_LABEL: Record<DbPart, MessageKey> = { columns: 'Kolumny', keys: 'Klucze', indexes: 'Indeksy' };
const formatCount = (n: number | null | undefined): string => (n === null || n === undefined || n < 0 ? '' : n >= 10000 ? `~${Math.round(n / 1000)}k` : `~${n}`);

export const openNewConnection = (kind: 'postgres' | 'redis' = 'postgres') => setUi({ modal: { kind: 'dbConnection', dbKind: kind } });
export const editConnection = (id: string) => setUi({ modal: { kind: 'dbConnection', connectionId: id } });

export async function deleteConnection(c: DbConnection, tr: (k: MessageKey, p?: Record<string, string | number>) => string): Promise<void> {
  const tx = openTransactions(c.id);
  const staged = stagedTabsOf(c.id);
  const body = [tr('Zapisane hasło też zostanie usunięte. Otwarte karty tego połączenia przestaną działać.'),
    ...(tx ? [tr('Otwarte transakcje: {count}. Zostaną wycofane (ROLLBACK).', { count: tx })] : []),
    ...(staged ? [tr('Tabele z niezapisanymi zmianami: {count}. Zmian nie będzie można zapisać.', { count: staged })] : [])].join('\n');
  const choice = await askChoice(tr('Usunąć połączenie {name}?', { name: c.name }), body, [
    { label: tr('Usuń połączenie'), value: 'delete', danger: true },
  ]);
  if (choice !== 'delete') return;
  const r = await window.mc.db.deleteConnection(c.id);
  if (!r.ok) toast(tr('Nie udało się zapisać zmian'), 'error');
}

export const DbPanel = memo(function DbPanel() {
  const { tr } = useI18n();
  useEffect(() => { initDb(); initDbTabs(); }, []);
  const connections = useStore((st) => st.s.dbConnections);
  const sshHosts = useStore((st) => st.s.sshHosts);
  const sessions = useDbStore((st) => st.sessions);
  const shared = useDbStore((st) => st.shared);
  const prompts = useDbStore((st) => st.prompts);
  const loads = useDbStore((st) => st.loads);
  const openList = useDbStore((st) => st.open);
  const filter = useDbStore((st) => st.filter);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const open = useMemo(() => new Set(openList), [openList]);
  const live = (connectionId: string) => connectionState({ sessions }, connectionId) !== 'closed';
  const { rows, needed } = useMemo(() => buildDbTree({ connections, open, loads, filter, live }), [connections, open, loads, filter, sessions, shared]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { for (const req of needed) void runLoad(req); }, [needed]);
  // History of deleted connections goes with them.
  useEffect(() => { pruneStoredHistory(); }, [connections]);

  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const win = rowWindow(view.top, view.height, ROW, rows.length, 12);

  const setOpen = (next: Set<string>) => useDbStore.setState({ open: [...next] });
  const connect = async (c: DbConnection) => {
    // Redis: the key browser opens in a tab of the top strip (its session and login live there).
    if (c.kind === 'redis') { openRedisTab(c.id, 'keys'); return; }
    setErrors((e) => { const n = { ...e }; delete n[c.id]; return n; });
    const key = nodeKey.connection(c.id);
    if (!open.has(key)) setOpen(new Set([...open, key]));
    const r = await ensureShared(c.id);
    if (!r.ok) setErrors((e) => ({ ...e, [c.id]: r.error }));
  };
  const toggle = (row: DbTreeRow) => {
    if (row.type === 'connection') {
      if (row.connection.kind === 'redis') { openRedisTab(row.connection.id, 'keys'); return; }
      if (!live(row.connection.id)) { void connect(row.connection); return; }
      setOpen(toggleNode(open, row));
      return;
    }
    if (row.type === 'database' && !row.current && !row.expanded && !sharedSessionLive(row.connectionId, row.database)) {
      // Another database of the server: its own session (prompts may appear above).
      void ensureShared(row.connectionId, row.database).then((r) => { if (!r.ok) setErrors((e) => ({ ...e, [row.connectionId]: r.error })); });
    }
    setOpen(toggleNode(open, row));
  };
  const sharedSessionLive = (connectionId: string, database: string) => isLive(sessions[shared[sharedKey(connectionId, database)]]);

  const connectionMenu = (c: DbConnection, x: number, y: number) => {
    const isOn = live(c.id);
    openMenu(x, y, [
      { header: c.name },
      ...(c.kind === 'postgres' ? [
        isOn ? { label: tr('Rozłącz'), onClick: () => void disconnectAsking(c.id, c.name) } : { label: tr('Połącz'), onClick: () => void connect(c) },
        { label: tr('Nowy edytor SQL'), onClick: () => openSqlTab(c.id, c.database ?? 'postgres') },
        ...(isOn ? [{ label: tr('Odśwież'), onClick: () => refreshLoads((k) => k[1] === c.id) }] : []),
        { sep: true } as MenuItem,
      ] : []),
      ...(c.kind === 'redis' ? [
        // Disconnecting ends the sessions of its tabs (they offer to connect again).
        ...(isOn ? [{ label: tr('Rozłącz'), onClick: () => void disconnectAsking(c.id, c.name) }] : []),
        ...(['keys', 'console', 'pubsub', 'info'] as const).map((view) => ({ label: view === 'keys' ? tr('Otwórz przeglądarkę kluczy') : viewLabel(view), onClick: () => { openRedisTab(c.id, view); } })),
        { sep: true } as MenuItem,
      ] : []),
      { label: tr('Edytuj…'), onClick: () => editConnection(c.id) },
      { label: tr('Duplikuj'), onClick: () => void window.mc.db.duplicateConnection(c.id) },
      { label: tr('Kopiuj adres'), onClick: () => window.mc.clipboardWrite(dbEndpoint(c)) },
      { sep: true },
      { label: tr('Usuń połączenie'), danger: true, onClick: () => void deleteConnection(c, tr) },
    ]);
  };
  const rowMenu = (row: DbTreeRow, x: number, y: number) => {
    if (row.type === 'connection') { connectionMenu(row.connection, x, y); return; }
    const items: MenuItem[] = [];
    if (row.type === 'database') {
      items.push({ header: row.database }, { label: tr('Nowy edytor SQL tutaj'), onClick: () => openSqlTab(row.connectionId, row.database) },
        { label: tr('Kopiuj nazwę'), onClick: () => window.mc.clipboardWrite(row.database) },
        { label: tr('Odśwież'), onClick: () => refreshLoads((k) => k[1] === row.connectionId && k[2] === row.database) });
    } else if (row.type === 'schema' || row.type === 'folder') {
      const schema = row.type === 'schema' ? row.schema.name : row.schema;
      items.push({ header: schema }, { label: tr('Nowy edytor SQL tutaj'), onClick: () => openSqlTab(row.connectionId, row.database, `SET search_path TO ${quoteIdent(schema)};\n\n`) },
        { label: tr('Kopiuj nazwę'), onClick: () => window.mc.clipboardWrite(schema) },
        { label: tr('Odśwież'), onClick: () => refreshLoads((k) => k[1] === row.connectionId && k[2] === row.database && k[3] === schema) });
    } else if (row.type === 'object') {
      const o = row.object;
      const qualified = `${quoteIdent(o.schema)}.${quoteIdent(o.name)}`;
      items.push({ header: `${o.schema}.${o.name}` });
      if (hasRows(o.kind)) items.push({ label: tr('Otwórz dane'), onClick: () => openTableTab(row.connectionId, row.database, o.schema, o.name, o.kind) });
      items.push({ label: tr('Nowy edytor SQL tutaj'), onClick: () => openSqlTab(row.connectionId, row.database, hasRows(o.kind) ? `SELECT * FROM ${qualified} LIMIT 100;\n` : '') });
      items.push({ label: tr('Kopiuj nazwę'), onClick: () => window.mc.clipboardWrite(o.name) });
      items.push({ label: tr('Kopiuj pełną nazwę'), onClick: () => window.mc.clipboardWrite(qualified) });
      items.push({ label: tr('Pokaż DDL'), onClick: () => openDdlTab(row.connectionId, row.database, o.schema, o.name, o.kind, o.args) });
      items.push({ sep: true }, { label: tr('Odśwież'), onClick: () => refreshLoads((k) => k[1] === row.connectionId && k[2] === row.database && k[3] === o.schema && (k[0] === 'objects' || k[4] === o.name)) });
    } else if (row.type === 'column') {
      items.push({ header: row.column.name }, { label: tr('Kopiuj nazwę'), onClick: () => window.mc.clipboardWrite(row.column.name) });
    } else if (row.type === 'constraint' || row.type === 'index') {
      const name = row.type === 'constraint' ? row.constraint.name : row.index.name;
      const def = row.type === 'constraint' ? row.constraint.definition : row.index.definition;
      items.push({ header: name }, { label: tr('Kopiuj nazwę'), onClick: () => window.mc.clipboardWrite(name) }, { label: tr('Kopiuj definicję'), onClick: () => window.mc.clipboardWrite(def) });
    } else return;
    openMenu(x, y, items);
  };
  /** Keyboard of the tree (like the Files tree): arrows move and fold, Enter opens, the menu key or Shift+F10 opens the menu. */
  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const at = Math.max(0, rows.findIndex((r) => r.key === selected));
    const row = rows[at];
    const go = (i: number) => {
      const index = Math.max(0, Math.min(rows.length - 1, i));
      setSelected(rows[index].key);
      const el = scroller.current;
      if (el) {
        const top = index * ROW;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
      }
    };
    const expandable = 'expanded' in row && (row.type !== 'object' || row.expandable);
    switch (e.key) {
      case 'ArrowDown': go(selected ? at + 1 : 0); break;
      case 'ArrowUp': go(at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(rows.length - 1); break;
      case 'PageDown': go(at + Math.max(1, Math.floor(view.height / ROW) - 1)); break;
      case 'PageUp': go(at - Math.max(1, Math.floor(view.height / ROW) - 1)); break;
      case 'ArrowRight':
        if (expandable && !row.expanded) toggle(row);
        else if (expandable) go(at + 1);
        break;
      case 'ArrowLeft': {
        if (expandable && row.expanded) { toggle(row); break; }
        for (let i = at - 1; i >= 0; i--) if (rows[i].depth < row.depth) { go(i); break; }
        break;
      }
      case 'Enter':
        if (row.type === 'object') activate(row);
        else if (expandable || (row.type === 'status' && row.retry)) activate(row);
        break;
      case 'ContextMenu': case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return;
        const el = scroller.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(row.key)}"]`);
        const b = el?.getBoundingClientRect();
        rowMenu(row, (b?.left ?? 0) + 24, (b?.top ?? 0) + ROW);
        break;
      }
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const activate = (row: DbTreeRow) => {
    if (row.type === 'object') {
      if (hasRows(row.object.kind)) openTableTab(row.connectionId, row.database, row.object.schema, row.object.name, row.object.kind);
      else openDdlTab(row.connectionId, row.database, row.object.schema, row.object.name, row.object.kind, row.object.args);
    } else if (row.type === 'status' && row.retry) refreshLoads((k) => JSON.stringify(k) === row.retry);
    else if ('expanded' in row) toggle(row);
  };

  const hostLabel = (id: string) => sshHosts.find((h) => h.id === id)?.label ?? '?';
  // Redis sessions belong to Redis tabs, which show their own login.
  const promptSessions = Object.values(sessions).filter((s) => !s.test && s.kind !== 'redis' && prompts[s.id]);
  const connName = (id: string) => connections.find((c) => c.id === id)?.name ?? '?';

  const renderRow = (row: DbTreeRow, index: number) => {
    const style = { top: index * ROW, paddingLeft: 6 + row.depth * 14 } as CSSProperties;
    const expandable = 'expanded' in row && (row.type !== 'object' || row.expandable);
    const chevron = <span className={`db-chev ${expandable ? '' : 'none'} ${'expanded' in row && row.expanded ? 'open' : ''}`} aria-hidden="true">{expandable && <IChevron />}</span>;
    let body: React.ReactNode = null;
    let title: string | undefined;
    switch (row.type) {
      case 'group': body = <><IFolder /><span className="db-name">{row.name}</span><span className="db-meta">{row.count}</span></>; break;
      case 'connection': {
        const c = row.connection;
        const state = connectionState({ sessions }, c.id);
        title = `${c.name}\n${c.user ? `${c.user}@` : ''}${dbEndpoint(c)}${c.ssh ? `\n${tr('przez SSH: {host}', { host: hostLabel(c.ssh.hostId) })}` : ''}${c.readOnly ? `\n${tr('Tylko do odczytu')}` : ''}`;
        body = <>
          <span className="db-color" style={{ background: c.color ?? 'var(--muted)' }} />
          <span title={c.kind === 'postgres' ? 'PostgreSQL' : 'Redis'}><DbKindIcon kind={c.kind} /></span>
          <span className="db-name">{c.name}</span>
          {c.readOnly && <span className="db-ro" title={tr('Tylko do odczytu')}>RO</span>}
          {c.ssh && <span className="db-meta">SSH</span>}
          <span className={`db-state ${state}`} aria-label={state === 'connected' ? tr('połączono') : state === 'connecting' ? tr('łączenie…') : tr('rozłączono')} />
        </>;
        break;
      }
      case 'database': body = <><IDatabase /><span className="db-name">{row.database}</span>{row.current && <span className="db-meta">{tr('domyślna')}</span>}</>; break;
      case 'schema': body = <><IFolder /><span className={`db-name ${row.schema.system ? 'dim' : ''}`}>{row.schema.name}</span></>; break;
      case 'folder': body = <><span className="db-folder-name">{tr(FOLDER_LABEL[row.folder])}</span><span className="db-meta">{row.count}</span></>; break;
      case 'object': {
        const o = row.object;
        const Icon = o.kind === 'view' || o.kind === 'matview' ? IView : o.kind === 'sequence' ? ISequence : o.kind === 'function' || o.kind === 'procedure' ? IFunction : ITable;
        title = `${o.schema}.${o.name}${o.args !== undefined ? `(${o.args})` : ''}${o.returns ? ` → ${o.returns}` : ''}${o.comment ? `\n${o.comment}` : ''}`;
        body = <><Icon /><span className="db-name">{o.name}{o.args !== undefined ? <span className="db-args">({o.args})</span> : null}</span><span className="db-meta">{formatCount(o.rowEstimate)}</span></>;
        break;
      }
      case 'part': body = <><span className="db-folder-name">{tr(PART_LABEL[row.part])}</span><span className="db-meta">{row.count}</span></>; break;
      case 'column': {
        const c = row.column;
        title = `${c.name} ${c.typeName}${c.nullable ? '' : ' NOT NULL'}${c.default !== null ? ` DEFAULT ${c.default}` : ''}${c.comment ? `\n${c.comment}` : ''}`;
        body = <>{row.primary ? <span className="db-pk"><IKey /></span> : <IColumn />}<span className="db-name">{c.name}</span><span className="db-type">{c.typeName}{c.nullable ? '' : '!'}</span></>;
        break;
      }
      case 'constraint': title = row.constraint.definition; body = <><IKey /><span className="db-name">{row.constraint.name}</span><span className="db-type">{row.constraint.type === 'p' ? 'PK' : row.constraint.type === 'u' ? 'UNIQUE' : 'FK'}</span></>; break;
      case 'index': title = row.index.definition; body = <><span className="db-idx">ix</span><span className="db-name">{row.index.name}</span><span className="db-type">{row.index.unique ? 'UNIQUE' : ''}</span></>; break;
      case 'status':
        body = row.status === 'loading' ? <span className="db-status">{tr('Wczytywanie…')}</span>
          : row.status === 'empty' ? <span className="db-status">{tr('Brak obiektów')}</span>
            : <span className="db-status error" title={row.message}>{row.message} · {tr('Ponów')}</span>;
        break;
    }
    return (
      <div key={row.key} className={`db-row db-${row.type} ${selected === row.key ? 'sel' : ''}`} style={style} title={title} data-key={row.key}
        role="treeitem" id={`db-tree-row-${index}`} aria-selected={selected === row.key} aria-expanded={'expanded' in row ? row.expanded : undefined} aria-level={row.depth + 1}
        onClick={() => { setSelected(row.key); if (row.type === 'connection' || row.type === 'group' || row.type === 'database' || row.type === 'schema' || row.type === 'folder' || row.type === 'part' || (row.type === 'status' && row.retry)) activate(row); }}
        onDoubleClick={() => { if (row.type === 'object') activate(row); }}
        onContextMenu={(e) => { e.preventDefault(); setSelected(row.key); rowMenu(row, e.clientX, e.clientY); }}>
        {row.type === 'object' && row.expandable
          ? <span className="db-chev-hit" onClick={(e) => { e.stopPropagation(); toggle(row); }}>{chevron}</span>
          : chevron}
        {body}
      </div>
    );
  };

  return (
    <div className="sidebar-content db-panel">
      {/* An empty panel has no head: its text starts under the title and offers both kinds itself. */}
      {connections.length > 0 && (
        <div className="db-panel-head">
          <input className="input db-filter" placeholder={tr('Filtruj obiekty…')} aria-label={tr('Filtruj obiekty…')} value={filter} spellCheck={false}
            onChange={(e) => useDbStore.setState({ filter: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') useDbStore.setState({ filter: '' }); }} />
          <button className="btn ghost icon" title={tr('Nowe połączenie')} aria-label={tr('Nowe połączenie')} data-action="new-connection"
            onClick={(e) => openMenuAt(e.currentTarget, [
              { header: tr('Nowe połączenie') },
              { label: 'PostgreSQL', onClick: () => openNewConnection('postgres') },
              { label: 'Redis', onClick: () => openNewConnection('redis') },
            ])}><IPlus /></button>
        </div>
      )}
      {promptSessions.map((s) => (
        <div key={s.id} className="db-panel-login">
          <div className="db-panel-login-title">{connName(s.connectionId)}{s.database ? ` · ${s.database}` : ''}</div>
          <DbLogin sessionId={s.id} />
        </div>
      ))}
      {Object.entries(errors).filter(([id]) => connections.some((c) => c.id === id)).map(([id, message]) => (
        <div key={id} className="db-panel-error" role="alert">
          <strong>{connName(id)}</strong>: {message}
          <button className="btn ghost icon small" aria-label={tr('Zamknij')} onClick={() => setErrors((e) => { const n = { ...e }; delete n[id]; return n; })}>×</button>
        </div>
      ))}
      {!connections.length ? (
        <PanelEmpty className="db-empty">
          <p>{fillTokens(tr('Dodaj połączenie z bazą {postgres} lub {redis}.'), {
            postgres: <EmptyLink label={`${tr('Nowe połączenie')}: PostgreSQL`} onClick={() => openNewConnection('postgres')}>PostgreSQL</EmptyLink>,
            redis: <EmptyLink label={`${tr('Nowe połączenie')}: Redis`} onClick={() => openNewConnection('redis')}>Redis</EmptyLink>,
          })}</p>
          <button className="btn primary" onClick={() => openNewConnection('postgres')}>{tr('Nowe połączenie')}</button>
          <p>{tr('Bazy dostępne tylko na serwerze otworzysz przez tunel SSH.')}</p>
        </PanelEmpty>
      ) : (
        <div className="db-tree" ref={scroller} role="tree" tabIndex={0} aria-label={tr('Bazy danych')} onKeyDown={onTreeKey}
          aria-activedescendant={selected && rows.some((r) => r.key === selected) ? `db-tree-row-${rows.findIndex((r) => r.key === selected)}` : undefined}
          onMouseDown={(e) => { if ((e.target as HTMLElement).closest('.db-row')) scroller.current?.focus(); }} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
          <div style={{ height: rows.length * ROW, position: 'relative' }}>
            {rows.slice(win.start, win.end).map((row, i) => renderRow(row, win.start + i))}
          </div>
        </div>
      )}
    </div>
  );
});
