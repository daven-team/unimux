// One pane of the SFTP view (0.9.8): path bar (back, forward, up, crumbs), filter, Actions, sortable
// columns and a windowed list (folders with thousands of entries render only the rows on screen). Multi-select with
// Ctrl/Shift click and the keyboard (arrows, Home/End, Page keys, Enter opens, Backspace goes up, Delete, F2, Ctrl+A).
// Entries drag to the other pane; drops come from the other pane (SFTP_DRAG_MIME) or from the OS (Files).
// 0.9.9: a drag onto a folder row, a path segment or ".." of the same pane moves the entries there; Ctrl+X / Ctrl+V cut and
// paste, F5 and the turning refresh button list the folder again (the old rows stay, dimmed, until the new listing came).
// The right-click menus and Actions list only what can run (shared/sftpMenu.ts); upload and download live there too.
// 1.0.4: a drag that starts outside the entries' names (the empty list, the other columns of a row) draws a marquee like
// Explorer: the rows it touches are selected live (Ctrl/Cmd adds to the selection) and the list scrolls near its edges.
// An entry drags from its icon or name.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { rowSlots, rowWindow } from '../../../../shared/virtualRows';
import {
  clickSelect, EMPTY_SELECTION, filterEntries, formatBytes, isFolderLike, kindLabel, liveSelection, marqueeRows, marqueeSelect, moveSelect, resolveDrop, resolveMove, selectAll,
  SFTP_DRAG_MIME, sortEntries, toggleSort, DEFAULT_SORT, type Crumb, type PaneEntry, type ActiveDrag, type Selection, type SftpDragPayload, type SortKey, type SortOrder,
} from '../../../../shared/sftpView';
import type { MessageKey } from '../../../../shared/i18n';
import type { PaneMenuInput } from '../../../../shared/sftpMenu';
import { isFileLike } from '../../../../shared/editorSource';
import { useI18n } from '../../i18n';
import { openMenu, openMenuAt, type MenuItem } from '../ContextMenu';
import { FileIcon, FolderIcon } from '../FileIcon';
import { IArrowLeft, IArrowRight, IArrowUp, IChevron, ILink, ISearch } from '../icons';
import { RefreshIcon, useHoldBusy } from '../Spinner';

export const ROW_HEIGHT = 26;
/** A press moves this far (px) before it becomes a marquee; less is a click. */
const MARQUEE_SLOP = 4;
/** Near the list's top or bottom edge (px) a marquee scrolls the list. */
const MARQUEE_EDGE = 28;
/** Where a press starts an entry drag instead of a marquee. */
const DRAG_HANDLE = '.sftp-icon, .sftp-name, .sftp-link';

interface MarqueeBox { left: number; top: number; width: number; height: number }

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
  /** The folder above (the ".." row); null at the top. On Windows a drive root goes up to the drive list (DRIVES). */
  parentPath: string | null;
}

export interface PaneProps {
  side: 'local' | 'remote';
  label: string;
  /** Left of the path bar: the pane title and its own buttons (drives, home, host chip); null when the placeholder brings
   *  its own head (the host picker). */
  head: ReactNode;
  folder: PaneFolder;
  crumbs: Crumb[];
  /** Remote panes add Permissions and Owner. */
  extraColumns: boolean;
  onOpen(path: string): void;
  /** A file was opened (double click, Enter): it opens in an editor tab (0.9.9). */
  onOpenFile?(entry: PaneEntry): void;
  onBack(): void;
  onForward(): void;
  onUp(): void;
  /** The menu of a right click on entries or on the empty list, or of the Actions button (empty: no menu). */
  menu(place: PaneMenuInput['place'], selected: PaneEntry[]): MenuItem[];
  onDelete(selected: PaneEntry[]): void;
  onRename(entry: PaneEntry): void;
  /** Entries dragged from the other pane were dropped into `targetDir`. */
  onDropEntries(payload: SftpDragPayload, targetDir: string): void;
  /** Files from the OS (Explorer, Finder, the desktop) were dropped into `targetDir`. */
  onDropFiles(paths: string[], targetDir: string): void;
  /** Entries of this pane dragged onto one of its folders (a row, a path segment or ".."): a move. */
  onMoveEntries(paths: string[], targetDir: string): void;
  /** F5, the refresh button. */
  onRefresh(): void;
  /** Ctrl+X: these entries are cut (shown dimmed until pasted). */
  onCut(selected: PaneEntry[]): void;
  /** Ctrl+V: the cut entries go into the shown folder. */
  onPaste(): void;
  /** Paths cut from this pane (dimmed rows). */
  cutPaths?: ReadonlySet<string>;
  /** No drop target (the drive list, a remote pane without a session). */
  dropDisabled?: boolean;
  /** Shown instead of the path bar and the list (no session yet, the host picker, a login prompt); the filter and Actions
   *  stay hidden until there is a listing. */
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
  // The ".." row sits above the windowed rows (one row height).
  const upRow = p.folder.parentPath !== null && p.folder.path !== null;
  const offset = upRow ? ROW_HEIGHT : 0;
  const slots = rowSlots(rowWindow(Math.max(0, view.top - offset), view.height, ROW_HEIGHT, rows.length), rows.length, focusIndex >= 0 ? [focusIndex] : []);
  const refreshing = useHoldBusy(p.folder.loading, 400);

  const reveal = (index: number) => {
    const el = list.current;
    if (!el || index < 0) return;
    const top = index * ROW_HEIGHT + offset;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  };
  const move = (m: number | 'home' | 'end', extend: boolean) => {
    const next = moveSelect(sel, order, m, extend);
    setSel(next);
    reveal(rows.findIndex((r) => r.path === next.focus));
  };
  const open = (e: PaneEntry) => {
    if (e.unsafeName) return;
    if (isFolderLike(e)) p.onOpen(e.path);
    else if (isFileLike(e)) p.onOpenFile?.(e);
  };

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
        case 'F5': p.onRefresh(); return true;
        case 'a': case 'A': if (mod) { setSel(selectAll(order)); return true; } return false;
        case 'x': case 'X': if (mod && !e.shiftKey && !e.altKey) { if (selected.length) p.onCut(selected); return true; } return false;
        case 'v': case 'V': if (mod && !e.shiftKey && !e.altKey) { p.onPaste(); return true; } return false;
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
  /** A right click on an entry selects it first (unless it is selected); one on the empty list or on an entry that cannot be
   *  selected (an unsafe name) shows the menu of the folder. */
  const onRowMenu = (e: MouseEvent, entry: PaneEntry | null) => {
    e.preventDefault();
    let items: MenuItem[];
    if (entry && !entry.unsafeName) {
      const chosen = sel.paths.includes(entry.path) ? selected : [entry];
      if (!sel.paths.includes(entry.path)) setSel(clickSelect(sel, order, entry.path));
      items = p.menu('entries', chosen);
    } else items = p.menu('empty', []);
    if (items.length) openMenu(e.clientX, e.clientY, items);
  };
  /** The empty part of the list: anything in it but an entry or ".." (the list itself, the empty-folder note, the row gaps). */
  const onEmptyPart = (e: MouseEvent) => !(e.target as Element).closest('.sftp-row, .sftp-uprow');

  // ── marquee (rubber band) ──
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  /** What a marquee in progress reads (its window listeners outlive the render that started it). */
  const latest = useRef({ rows, order, offset, sel });
  latest.current = { rows, order, offset, sel };
  const endMarquee = useRef<(() => void) | null>(null);
  /** A marquee just ended: the click of its release selects nothing. */
  const swallowClick = useRef(false);
  useEffect(() => () => endMarquee.current?.(), []);

  /** A press outside the entries' names: a plain click on the empty list clears the selection (one on a row's other
   *  columns selects it on click); moving past the slop draws the marquee. */
  const onListMouseDown = (e: MouseEvent) => {
    const el = list.current;
    if (e.button !== 0 || !el || (e.target as Element).closest(DRAG_HANDLE)) return;
    const box = el.getBoundingClientRect();
    if (e.clientX >= box.left + el.clientWidth || e.clientY >= box.top + el.clientHeight) return; // a scroll bar
    const add = e.ctrlKey || e.metaKey;
    if (onEmptyPart(e) && !add) setSel(EMPTY_SELECTION);
    e.preventDefault(); // no text selection and no entry drag from here
    el.focus({ preventScroll: true });
    endMarquee.current?.();
    const base = add ? latest.current.sel : EMPTY_SELECTION;
    /** A pointer position in the list's content coordinates (scroll included), clamped to the content. */
    const point = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.min(el.scrollWidth, x - r.left + el.scrollLeft)), y: Math.max(0, Math.min(el.scrollHeight, y - r.top + el.scrollTop)) };
    };
    const start = point(e.clientX, e.clientY);
    const pressX = e.clientX, pressY = e.clientY;
    let last = { x: pressX, y: pressY };
    let active = false;
    let frame = 0;
    const update = () => {
      const now = point(last.x, last.y);
      setMarquee({ left: Math.min(start.x, now.x), top: Math.min(start.y, now.y), width: Math.abs(now.x - start.x), height: Math.abs(now.y - start.y) });
      const { rows: shown, order: ids, offset: above } = latest.current;
      const span = marqueeRows(start.y, now.y, above, ROW_HEIGHT, shown.length);
      const hit = span ? shown.slice(span.first, span.last + 1).filter((r) => !r.unsafeName).map((r) => r.path) : [];
      setSel(marqueeSelect(base, ids, hit, add));
    };
    // Near the top or bottom edge the list scrolls (faster the further out) and the band grows with it.
    const scroll = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const upper = r.top + MARQUEE_EDGE, lower = r.top + el.clientHeight - MARQUEE_EDGE;
      const d = last.y < upper ? last.y - upper : last.y > lower ? last.y - lower : 0;
      if (!d) return;
      const before = el.scrollTop;
      el.scrollTop += Math.max(-40, Math.min(40, Math.round(d / 2))) || Math.sign(d);
      if (el.scrollTop === before) return;
      update();
      frame = requestAnimationFrame(scroll);
    };
    const onMove = (ev: globalThis.MouseEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!active && Math.hypot(ev.clientX - pressX, ev.clientY - pressY) < MARQUEE_SLOP) return;
      active = true;
      update();
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const finish = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', finish);
      cancelAnimationFrame(frame);
      endMarquee.current = null;
      setMarquee(null);
    };
    const onUp = () => {
      if (active) { swallowClick.current = true; setTimeout(() => { swallowClick.current = false; }); }
      finish();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', finish);
    endMarquee.current = finish;
  };

  // ── drag and drop ──
  // The entries of an in-app drag stay in `activeDrag`; the drag data carries only its nonce (see resolveDrop).
  const onDragStart = (e: DragEvent, entry: PaneEntry) => {
    if (entry.unsafeName) { e.preventDefault(); return; }
    const paths = sel.paths.includes(entry.path) ? sel.paths : [entry.path];
    if (!sel.paths.includes(entry.path)) setSel(clickSelect(sel, order, entry.path));
    activeDrag = { side: p.side, paths: [...paths], nonce: crypto.randomUUID() };
    e.dataTransfer.setData(SFTP_DRAG_MIME, activeDrag.nonce);
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  /** The folder element under the pointer (a folder row, a path segment, ".."), or null. */
  const folderUnder = (e: DragEvent): string | null => (e.target as HTMLElement).closest<HTMLElement>('[data-folder-path]')?.dataset.folderPath ?? null;
  /** A drag from this pane moves onto one of its folders, never onto the shown folder itself or onto a dragged entry. */
  const moveTarget = (e: DragEvent): string | null => {
    const target = folderUnder(e);
    if (target === null || target === p.folder.path || !activeDrag || activeDrag.side !== p.side) return null;
    return activeDrag.paths.includes(target) ? null : target;
  };
  /** An in-app drag from the other pane, or files from the OS; custom data without an in-app drag behind it never counts. */
  const accepts = (e: DragEvent): boolean => {
    if (p.dropDisabled || p.folder.path === null) return false;
    const types = Array.from(e.dataTransfer.types);
    if (types.includes(SFTP_DRAG_MIME) && activeDrag) return activeDrag.side !== p.side || moveTarget(e) !== null;
    return types.includes('Files');
  };
  const targetOf = (e: DragEvent): string => folderUnder(e) ?? p.folder.path ?? '';
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) { if (over !== null && activeDrag?.side === p.side) setOver(null); return; }
    e.preventDefault();
    const moving = activeDrag?.side === p.side;
    e.dataTransfer.dropEffect = moving ? 'move' : 'copy';
    const target = moving ? moveTarget(e)! : targetOf(e);
    if (over !== target) setOver(target);
  };
  const onDrop = (e: DragEvent) => {
    const ok = accepts(e);
    const active = activeDrag;
    const target = active?.side === p.side ? moveTarget(e) : targetOf(e);
    activeDrag = null;
    setOver(null);
    if (!ok || target === null) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData(SFTP_DRAG_MIME);
    const moved = resolveMove(active, raw, p.side);
    if (moved) { p.onMoveEntries(moved, target); return; }
    const payload = resolveDrop(active, raw, p.side);
    if (payload) { p.onDropEntries(payload, target); return; }
    if (active) return;
    const paths = Array.from(e.dataTransfer.files).map((f) => window.mc.pathForFile(f)).filter(Boolean);
    if (paths.length) p.onDropFiles(paths, target);
  };

  const columns = COLUMNS.filter((c) => !c.remote || p.extraColumns);
  const f = p.folder;
  // Actions opens whenever it has something to offer (a session whose start folder could not be listed still has Disconnect).
  const toolbarMenu = p.head !== null && !p.placeholder ? p.menu('toolbar', selected) : [];
  const empty = !rows.length && !f.loading && f.path !== null && !f.error;
  return (
    <section className={`sftp-pane sftp-pane-${p.side}${p.extraColumns ? ' wide' : ''}`} aria-label={p.label}
      onDragOver={onDragOver} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }} onDrop={onDrop}>
      {p.head !== null && (
        <div className="sftp-pane-head">
          {p.head}
          <span className="grow" />
          {!p.placeholder && (
            <>
              <div className="sftp-filter">
                <ISearch />
                <input className="input" type="search" value={filter} placeholder={tr('Filtruj')} aria-label={tr('Filtruj')} spellCheck={false}
                  onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); } }} />
              </div>
              <button type="button" className="btn small sftp-actions" aria-haspopup="menu" disabled={!toolbarMenu.length}
                onClick={(e) => openMenuAt(e.currentTarget, toolbarMenu)}>{tr('Akcje')} <IChevron /></button>
            </>
          )}
        </div>
      )}
      <div className="sftp-pathbar" style={p.placeholder ? { display: 'none' } : undefined}>
        <button type="button" className="btn ghost icon" aria-label={tr('Wstecz')} title={tr('Wstecz')} disabled={!f.canBack} onClick={p.onBack}><IArrowLeft /></button>
        <button type="button" className="btn ghost icon" aria-label={tr('Do przodu')} title={tr('Do przodu')} disabled={!f.canForward} onClick={p.onForward}><IArrowRight /></button>
        <button type="button" className="btn ghost icon" aria-label={tr('W górę')} title={tr('W górę')} disabled={!f.canUp} onClick={p.onUp}><IArrowUp /></button>
        <nav ref={crumbBar} className="sftp-crumbs" aria-label={tr('Ścieżka')}>
          {p.crumbs.map((c, i) => (
            <span key={c.path} className="sftp-crumb">
              {i > 0 && c.label !== '/' && p.crumbs[i - 1].label !== '/' && <span className="sftp-crumb-sep">/</span>}
              <button type="button" className={`${i === p.crumbs.length - 1 ? 'on' : ''}${over === c.path && c.path !== f.path ? ' drop' : ''}`} title={c.path} data-folder-path={c.path} onClick={() => p.onOpen(c.path)}>{c.label}</button>
            </span>
          ))}
        </nav>
        <button type="button" className={`btn ghost icon sftp-refresh${refreshing ? ' busy' : ''}`} aria-label={tr('Odśwież')} title={refreshing ? tr('Odświeżanie…') : tr('Odśwież')} aria-busy={refreshing}
          disabled={f.path === null} onClick={p.onRefresh}><RefreshIcon spinning={refreshing} /></button>
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
          <div ref={list} className={`sftp-list${over === f.path ? ' drop' : ''}${f.loading && f.path !== null ? ' loading' : ''}`} role="grid" aria-label={p.label} aria-multiselectable tabIndex={0} aria-busy={f.loading}
            aria-rowcount={rows.length} onKeyDown={onKeyDown} onScroll={(e) => { const t = e.currentTarget.scrollTop; setView((v) => (v.top === t ? v : { ...v, top: t })); }}
            onContextMenu={(e) => { if (onEmptyPart(e)) onRowMenu(e, null); }}
            onMouseDown={onListMouseDown} onClickCapture={(e) => { if (swallowClick.current) { swallowClick.current = false; e.stopPropagation(); } }}>
            {upRow && (
              <div className={`sftp-uprow${over !== null && over === f.parentPath ? ' drop' : ''}`} role="row" title={tr('Folder nadrzędny')}
                {...(f.parentPath ? { 'data-folder-path': f.parentPath } : {})}
                onDoubleClick={p.onUp} onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); }}>
                <span className="sftp-col sftp-col-name"><span className="sftp-icon"><FolderIcon /></span><span className="sftp-name">..</span></span>
              </div>
            )}
            {slots.map((slot, i) => {
              if (slot.kind === 'gap') return <div key={`gap-${i}`} style={{ height: slot.rows * ROW_HEIGHT }} aria-hidden />;
              const e = rows[slot.index];
              const on = sel.paths.includes(e.path);
              const folder = isFolderLike(e) && !e.unsafeName;
              const kind = kindLabel(e);
              return (
                <div key={e.path || `unsafe-${slot.index}`} role="row" aria-rowindex={slot.index + 1} aria-selected={on}
                  className={`sftp-row${on ? ' on' : ''}${sel.focus === e.path ? ' focus' : ''}${e.unsafeName ? ' unsafe' : ''}${over === e.path && folder ? ' drop' : ''}${p.cutPaths?.has(e.path) ? ' cut' : ''}`}
                  data-path={e.path} data-name={e.name} {...(folder ? { 'data-folder-path': e.path } : {})}
                  draggable={!e.unsafeName} onDragStart={(ev) => onDragStart(ev, e)} onDragEnd={() => { activeDrag = null; setOver(null); }}
                  onClick={(ev) => onRowClick(ev, e)} onDoubleClick={() => open(e)} onContextMenu={(ev) => { ev.stopPropagation(); onRowMenu(ev, e); }}
                  title={e.unsafeName ? tr('Nazwa, której nie można bezpiecznie zapisać w tym miejscu') : undefined}>
                  <span className="sftp-col sftp-col-name">
                    <span className="sftp-icon">{isFolderLike(e) ? <FolderIcon /> : <FileIcon name={e.name} />}</span>
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
            {marquee && <div className="sftp-marquee" style={marquee} aria-hidden />}
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
