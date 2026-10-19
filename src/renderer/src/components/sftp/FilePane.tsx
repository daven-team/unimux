// One pane of the SFTP view (0.9.8): path bar (back, forward, up, crumbs), filter, Actions, the transfer button, sortable
// columns and a windowed list (folders with thousands of entries render only the rows on screen). Multi-select with
// Ctrl/Shift click and the keyboard (arrows, Home/End, Page keys, Enter opens, Backspace goes up, Delete, F2, Ctrl+A).
// Entries drag to the other pane; drops come from the other pane (SFTP_DRAG_MIME) or from the OS (Files).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { rowSlots, rowWindow } from '../../../../shared/virtualRows';
import {
  clickSelect, EMPTY_SELECTION, filterEntries, formatBytes, isFolderLike, kindLabel, liveSelection, moveSelect, resolveDrop, selectAll,
  SFTP_DRAG_MIME, sortEntries, toggleSort, DEFAULT_SORT, type Crumb, type PaneEntry, type ActiveDrag, type Selection, type SftpDragPayload, type SortKey, type SortOrder,
} from '../../../../shared/sftpView';
import type { MessageKey } from '../../../../shared/i18n';
import { useI18n } from '../../i18n';
import { openMenu, openMenuAt, type MenuItem } from '../ContextMenu';
import { FileIcon } from '../FileIcon';
import { IArrowLeft, IArrowRight, IArrowUp, IChevron, IFolder, ILink, ISearch } from '../icons';

export const ROW_HEIGHT = 26;

export interface PaneFolder {
  /** null until the first listing arrived. */
  path: string | null;
  entries: PaneEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
}

export interface PaneProps {
  side: 'local' | 'remote';
  label: string;
  /** Left of the path bar: the pane title and its own buttons (drives, home, host chip). */
  head: ReactNode;
  folder: PaneFolder;
  crumbs: Crumb[];
  /** Remote panes add Permissions and Owner. */
  extraColumns: boolean;
  onOpen(path: string): void;
  onBack(): void;
  onForward(): void;
  onUp(): void;
  actions(selected: PaneEntry[]): MenuItem[];
  transfer: { label: string; icon: ReactNode; disabled: boolean; run(selected: PaneEntry[]): void };
  onDelete(selected: PaneEntry[]): void;
  onRename(entry: PaneEntry): void;
  /** Entries dragged from the other pane were dropped into `targetDir`. */
  onDropEntries(payload: SftpDragPayload, targetDir: string): void;
  /** Files from the OS (Explorer, Finder, the desktop) were dropped into `targetDir`. */
  onDropFiles(paths: string[], targetDir: string): void;
  /** No drop target (the drive list, a remote pane without a session). */
  dropDisabled?: boolean;
  /** Text shown instead of the list (no entries yet, an empty state). */
  placeholder?: ReactNode;
}

/** The drag started in a pane of this window (dragover cannot read the data, only its types). */
let activeDrag: ActiveDrag | null = null;

const COLUMNS: Array<{ key: SortKey; label: MessageKey; remote?: true }> = [
  { key: 'name', label: 'Nazwa' },
  { key: 'mtime', label: 'Data modyfikacji' },
  { key: 'size', label: 'Rozmiar' },
  { key: 'kind', label: 'Rodzaj' },
  { key: 'permissions', label: 'Uprawnienia', remote: true },
  { key: 'owner', label: 'Właściciel', remote: true },
];

export function FilePane(p: PaneProps) {
  const { tr, language } = useI18n();
  const [sort, setSort] = useState<SortOrder>(DEFAULT_SORT);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [over, setOver] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const crumbBar = useRef<HTMLElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  // A compact date in the column, the long one in its tooltip.
  const dates = useMemo(() => new Intl.DateTimeFormat(language, { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), [language]);
  const longDates = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' }), [language]);

  // A new folder starts unfiltered, unselected and at the top.
  useEffect(() => { setFilter(''); setSel(EMPTY_SELECTION); if (list.current) list.current.scrollTop = 0; }, [p.folder.path]);

  // The end of a long path (the current folder) stays in view.
  useLayoutEffect(() => { const el = crumbBar.current; if (el) el.scrollLeft = el.scrollWidth; }, [p.crumbs]);
  const rows = useMemo(() => sortEntries(filterEntries(p.folder.entries, filter), sort), [p.folder.entries, filter, sort]);
  const order = useMemo(() => rows.filter((r) => !r.unsafeName).map((r) => r.path), [rows]);
  const byPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  useEffect(() => setSel((s) => liveSelection(s, order)), [order]);
  const selected = sel.paths.map((x) => byPath.get(x)).filter((e): e is PaneEntry => !!e);
  const focusIndex = sel.focus ? rows.findIndex((r) => r.path === sel.focus) : -1;

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => setView((v) => (v.height === el.clientHeight && v.top === el.scrollTop ? v : { top: el.scrollTop, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const slots = rowSlots(rowWindow(view.top, view.height, ROW_HEIGHT, rows.length), rows.length, focusIndex >= 0 ? [focusIndex] : []);

  const reveal = (index: number) => {
    const el = list.current;
    if (!el || index < 0) return;
    if (index * ROW_HEIGHT < el.scrollTop) el.scrollTop = index * ROW_HEIGHT;
    else if ((index + 1) * ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = (index + 1) * ROW_HEIGHT - el.clientHeight;
  };
  const move = (m: number | 'home' | 'end', extend: boolean) => {
    const next = moveSelect(sel, order, m, extend);
    setSel(next);
    reveal(rows.findIndex((r) => r.path === next.focus));
  };
  const open = (e: PaneEntry) => { if (isFolderLike(e) && !e.unsafeName) p.onOpen(e.path); };

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor(view.height / ROW_HEIGHT) - 1);
    const handled = (() => {
      switch (e.key) {
        case 'ArrowDown': move(1, e.shiftKey); return true;
        case 'ArrowUp': move(-1, e.shiftKey); return true;
        case 'PageDown': move(page, e.shiftKey); return true;
        case 'PageUp': move(-page, e.shiftKey); return true;
        case 'Home': move('home', e.shiftKey); return true;
        case 'End': move('end', e.shiftKey); return true;
        case 'Enter': { const f = sel.focus ? byPath.get(sel.focus) : undefined; if (f) open(f); return true; }
        case 'Backspace': if (p.folder.canUp) p.onUp(); return true;
        case 'Delete': if (selected.length) p.onDelete(selected); return true;
        case 'F2': { const f = (sel.focus ? byPath.get(sel.focus) : undefined) ?? selected[0]; if (f) p.onRename(f); return true; }
        case 'a': case 'A': if (mod) { setSel(selectAll(order)); return true; } return false;
        case 'Escape': if (sel.paths.length) { setSel(EMPTY_SELECTION); return true; } return false;
        default: return false;
      }
    })();
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const onRowClick = (e: MouseEvent, entry: PaneEntry) => {
    if (entry.unsafeName) return;
    setSel((s) => clickSelect(s, order, entry.path, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }));
  };
  const onRowMenu = (e: MouseEvent, entry: PaneEntry | null) => {
    e.preventDefault();
    let chosen = selected;
    if (entry && !entry.unsafeName && !sel.paths.includes(entry.path)) {
      setSel(clickSelect(sel, order, entry.path));
      chosen = [entry];
    }
    openMenu(e.clientX, e.clientY, p.actions(entry ? chosen : []));
  };

  // ── drag and drop ──
  // The entries of an in-app drag stay in `activeDrag`; the drag data carries only its nonce (see resolveDrop).
  const onDragStart = (e: DragEvent, entry: PaneEntry) => {
    if (entry.unsafeName) { e.preventDefault(); return; }
    const paths = sel.paths.includes(entry.path) ? sel.paths : [entry.path];
    if (!sel.paths.includes(entry.path)) setSel(clickSelect(sel, order, entry.path));
    activeDrag = { side: p.side, paths: [...paths], nonce: crypto.randomUUID() };
    e.dataTransfer.setData(SFTP_DRAG_MIME, activeDrag.nonce);
    e.dataTransfer.effectAllowed = 'copy';
  };
  /** An in-app drag from the other pane, or files from the OS; custom data without an in-app drag behind it never counts. */
  const accepts = (e: DragEvent): boolean => {
    if (p.dropDisabled || p.folder.path === null) return false;
    const types = Array.from(e.dataTransfer.types);
    if (types.includes(SFTP_DRAG_MIME) && activeDrag) return activeDrag.side !== p.side;
    return types.includes('Files');
  };
  const targetOf = (e: DragEvent): string => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-folder-path]');
    return row?.dataset.folderPath ?? p.folder.path ?? '';
  };
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const target = targetOf(e);
    if (over !== target) setOver(target);
  };
  const onDrop = (e: DragEvent) => {
    const ok = accepts(e);
    const active = activeDrag;
    activeDrag = null;
    setOver(null);
    if (!ok) return;
    e.preventDefault();
    const target = targetOf(e);
    const payload = resolveDrop(active, e.dataTransfer.getData(SFTP_DRAG_MIME), p.side);
    if (payload) { p.onDropEntries(payload, target); return; }
    if (active) return;
    const paths = Array.from(e.dataTransfer.files).map((f) => window.mc.pathForFile(f)).filter(Boolean);
    if (paths.length) p.onDropFiles(paths, target);
  };

  const columns = COLUMNS.filter((c) => !c.remote || p.extraColumns);
  const f = p.folder;
  const empty = !rows.length && !f.loading && f.path !== null && !f.error;
  return (
    <section className={`sftp-pane sftp-pane-${p.side}${p.extraColumns ? ' wide' : ''}`} aria-label={p.label}
      onDragOver={onDragOver} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }} onDrop={onDrop}>
      <div className="sftp-pane-head">
        {p.head}
        <span className="grow" />
        <div className="sftp-filter">
          <ISearch />
          <input className="input" type="search" value={filter} placeholder={tr('Filtruj')} aria-label={tr('Filtruj')} spellCheck={false}
            onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); } }} />
        </div>
        <button type="button" className="btn small sftp-actions" disabled={f.path === null} onClick={(e) => openMenuAt(e.currentTarget, p.actions(selected))}>{tr('Akcje')} <IChevron /></button>
        <button type="button" className="btn small sftp-send" disabled={p.transfer.disabled || !selected.length} title={p.transfer.label} aria-label={p.transfer.label} onClick={() => p.transfer.run(selected)}>
          {p.transfer.icon}<span className="sftp-send-label">{p.transfer.label}</span>
        </button>
      </div>
      <div className="sftp-pathbar" style={p.placeholder ? { display: 'none' } : undefined}>
        <button type="button" className="btn ghost icon" aria-label={tr('Wstecz')} title={tr('Wstecz')} disabled={!f.canBack} onClick={p.onBack}><IArrowLeft /></button>
        <button type="button" className="btn ghost icon" aria-label={tr('Do przodu')} title={tr('Do przodu')} disabled={!f.canForward} onClick={p.onForward}><IArrowRight /></button>
        <button type="button" className="btn ghost icon" aria-label={tr('W górę')} title={tr('W górę')} disabled={!f.canUp} onClick={p.onUp}><IArrowUp /></button>
        <nav ref={crumbBar} className="sftp-crumbs" aria-label={tr('Ścieżka')}>
          {p.crumbs.map((c, i) => (
            <span key={c.path} className="sftp-crumb">
              {i > 0 && c.label !== '/' && p.crumbs[i - 1].label !== '/' && <span className="sftp-crumb-sep">/</span>}
              <button type="button" className={i === p.crumbs.length - 1 ? 'on' : ''} title={c.path} onClick={() => p.onOpen(c.path)}>{c.label}</button>
            </span>
          ))}
        </nav>
      </div>
      {p.placeholder ?? (
        <div className="sftp-table">
          <div className="sftp-row sftp-columns" role="row">
            {columns.map((c) => (
              <button key={c.key} type="button" role="columnheader" className={`sftp-col sftp-col-${c.key}`}
                aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'} onClick={() => setSort((s) => toggleSort(s, c.key))}>
                {tr(c.label)}{sort.key === c.key && <span className={`sftp-sort${sort.desc ? ' desc' : ''}`}><IChevron /></span>}
              </button>
            ))}
          </div>
          <div ref={list} className={`sftp-list${over === f.path ? ' drop' : ''}`} role="grid" aria-label={p.label} aria-multiselectable tabIndex={0}
            aria-rowcount={rows.length} onKeyDown={onKeyDown} onScroll={(e) => { const t = e.currentTarget.scrollTop; setView((v) => (v.top === t ? v : { ...v, top: t })); }}
            onContextMenu={(e) => { if (e.target === e.currentTarget) onRowMenu(e, null); }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) setSel(EMPTY_SELECTION); }}>
            {slots.map((slot, i) => {
              if (slot.kind === 'gap') return <div key={`gap-${i}`} style={{ height: slot.rows * ROW_HEIGHT }} aria-hidden />;
              const e = rows[slot.index];
              const on = sel.paths.includes(e.path);
              const folder = isFolderLike(e) && !e.unsafeName;
              const kind = kindLabel(e);
              return (
                <div key={e.path || `unsafe-${slot.index}`} role="row" aria-rowindex={slot.index + 1} aria-selected={on}
                  className={`sftp-row${on ? ' on' : ''}${sel.focus === e.path ? ' focus' : ''}${e.unsafeName ? ' unsafe' : ''}${over === e.path && folder ? ' drop' : ''}`}
                  data-path={e.path} data-name={e.name} {...(folder ? { 'data-folder-path': e.path } : {})}
                  draggable={!e.unsafeName} onDragStart={(ev) => onDragStart(ev, e)} onDragEnd={() => { activeDrag = null; setOver(null); }}
                  onClick={(ev) => onRowClick(ev, e)} onDoubleClick={() => open(e)} onContextMenu={(ev) => { ev.stopPropagation(); onRowMenu(ev, e); }}
                  title={e.unsafeName ? tr('Nazwa, której nie można bezpiecznie zapisać w tym miejscu') : undefined}>
                  <span className="sftp-col sftp-col-name">
                    <span className="sftp-icon">{isFolderLike(e) ? <IFolder /> : <FileIcon name={e.name} />}</span>
                    <span className="sftp-name">{e.name}</span>
                    {e.kind === 'symlink' && <span className="sftp-link" title={tr('Dowiązanie')}><ILink /></span>}
                  </span>
                  <span className="sftp-col sftp-col-mtime" title={e.mtime ? longDates.format(e.mtime) : undefined}>{e.mtime ? dates.format(e.mtime) : ''}</span>
                  <span className="sftp-col sftp-col-size">{isFolderLike(e) || e.kind === 'other' ? '' : formatBytes(e.size, language)}</span>
                  <span className="sftp-col sftp-col-kind">{tr(kind.key, kind.params)}</span>
                  {p.extraColumns && <span className="sftp-col sftp-col-permissions">{e.permissions}</span>}
                  {p.extraColumns && <span className="sftp-col sftp-col-owner">{e.owner ?? ''}</span>}
                </div>
              );
            })}
            {empty && <div className="sftp-empty-list">{filter ? tr('Brak wyników dla filtra') : tr('Folder jest pusty')}</div>}
          </div>
          <div className="sftp-status" role="status">
            {f.error ? <span className="sftp-error">{f.error}</span>
              : f.loading ? <span>{tr('Wczytywanie…')}</span>
                : <span>{tr('Elementy: {count}', { count: rows.length })}{selected.length ? ` · ${tr('Zaznaczone: {count}', { count: selected.length })}` : ''}{f.truncated ? ` · ${tr('Lista jest niepełna (za dużo elementów)')}` : ''}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
