import { useI18n } from '../i18n';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project, ProjectFileEntry } from '../../../shared/types';
import { setUi, toast } from '../store';
import { focusFileEditor, openFile, treeOpen } from '../files';
import { openBesideGrid } from '../splitView';
import { openMenu } from './ContextMenu';
import { FileIcon, FolderIcon, TreeChevron } from './FileIcon';
import { RefreshIcon, useHoldBusy } from './Spinner';
import { refreshGitBadges, useGitBadgeSync, useProjectBadges } from '../git/gitBadges';
import { badgeFor } from '../../../shared/gitBadges';
import { ProjectIconView } from './ProjectIcon';
import { fullProjectPath as projectPath } from '../../../shared/platform';
import { baseName, documentId, parentPath, renameSelectionEnd, summarizeNames, topLevelPaths, validateEntryName } from '../../../shared/fileOps';
import { matchesShortcut, shortcutText } from '../shortcuts';
import { buildPathPayload, PATH_MIME } from '../../../shared/pathDrop';
import { addTreePathsToFocusedCell, focusedCellId } from '../pathDrop';
import {
  bumpRefresh, cancelBusy, copyToClipboard, createEntry, duplicateEntries, kindOf, pasteInto, renameEntry,
  registerTreeFocus, selectPaths, selectedPaths, setExpanded, targetDirectory, toggleFolder, transferEntries, trashEntries, undoLast, useExplorer,
} from '../explorer';
import { useTreeListings } from '../treeListings';
import { onTurnRefresh, refreshMatches } from '../turnRefresh';
import {
  flattenTree, inIgnoredFolder, indentFor, indentGuides, scrollToShow, scrollTopForPinned, stabilizeRows, stickyIndent, stickyRows, TWISTIE, visibleRange, type TreeRow,
} from '../../../shared/treeRows';

export const fullProjectPath = (root: string, relative: string) =>
  projectPath(root, relative, window.mc.platform);

const TREE_MIME = 'application/x-mc-tree-entries';
/** Height of every tree row in pixels (the list is virtual: only the rows in view exist in the DOM). */
export const TREE_ROW_HEIGHT = 22;
/** Folder levels pinned at the top while scrolling. */
const STICKY_MAX = 5;
const OVERSCAN = 12;
/** What is being dragged inside the tree (dataTransfer content is not readable while dragging over). */
let dragging: { projectId: string; paths: string[] } | null = null;

/** Everything a row does goes through this object (kept in a ref, so rows only re-render when their own look changes). */
interface RowActions {
  click(e: React.MouseEvent, entry: ProjectFileEntry): void;
  /** Space on a file: the preview tab, the keyboard stays in the tree. */
  preview(path: string): void;
  stickyClick(e: React.MouseEvent, index: number): void;
  menu(e: React.MouseEvent, entry: ProjectFileEntry): void;
  dragStart(e: React.DragEvent, entry: ProjectFileEntry): void;
  dragOver(e: React.DragEvent, entry: ProjectFileEntry): void;
  drop(e: React.DragEvent, dir: string): void;
  dragEnd(): void;
  startRename(path: string): void;
  stopRename(): void;
  toggle(path: string, open: boolean): void;
  focused(path: string): void;
  retry(path: string): void;
}

function Guides({ depth }: { depth: number }) {
  if (!depth) return null;
  return <span className="tree-guides" aria-hidden>{indentGuides(depth).map((x) => <span key={x} style={{ left: x }} />)}</span>;
}

function RenameRow({ entry, depth, pos, size, top, projectId, actions }: { entry: ProjectFileEntry; depth: number; pos: number; size: number; top: number; projectId: string; actions: React.MutableRefObject<RowActions> }) {
  const { tr } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const folder = entry.kind === 'directory';
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.setSelectionRange(0, renameSelectionEnd(entry.name, folder));
  }, []);
  const cancel = () => { finished.current = true; actions.current.stopRename(); };
  const commit = async (fromBlur: boolean) => {
    if (finished.current) return;
    const name = (input.current?.value ?? '').trim();
    if (name === entry.name) { cancel(); return; }
    const invalid = validateEntryName(name, window.mc.platform);
    if (invalid) {
      if (fromBlur) { cancel(); return; }
      setError(tr(invalid as Parameters<typeof tr>[0])); return;
    }
    finished.current = true;
    const done = await renameEntry(projectId, entry.path, name);
    if (done) actions.current.stopRename();
    else if (fromBlur) actions.current.stopRename();
    else { finished.current = false; input.current?.focus(); }
  };
  return (
    <div className="file-entry editing" style={{ top, height: TREE_ROW_HEIGHT, paddingLeft: indentFor(depth) }} role="treeitem" aria-selected aria-level={depth + 1} aria-posinset={pos} aria-setsize={size}>
      <Guides depth={depth} />
      {folder ? <span className="tree-chevron"><TreeChevron /></span> : <span className="tree-twistie" />}
      {folder ? <FolderIcon /> : <FileIcon name={entry.name} />}
      <input
        ref={input} className="file-rename" defaultValue={entry.name} aria-label={tr('Nowa nazwa')} aria-invalid={error ? true : undefined} title={error ?? undefined} spellCheck={false}
        onChange={() => setError(null)}
        onBlur={() => void commit(true)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); void commit(false); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
      />
      {error && <span className="file-rename-error" role="alert">{error}</span>}
    </div>
  );
}

/** Only primitives and stable objects: a re-flattened tree re-renders just the rows whose look changed. */
interface RowProps {
  entry: ProjectFileEntry;
  depth: number;
  open: boolean;
  pos: number;
  size: number;
  index: number;
  top: number;
  selected: boolean;
  cut: boolean;
  dropTarget: boolean;
  /** A dependency or build output folder, or inside one: drawn dimmed. */
  ignored: boolean;
  letter?: string;
  letterClass?: string;
  letterTitle?: string;
  dot?: string | null;
  /** Position in the pinned stack (sticky rows only). */
  sticky?: number;
  actions: React.MutableRefObject<RowActions>;
}

const TreeEntryRow = memo(function TreeEntryRow({ entry, depth, open, pos, size, index, top, selected, cut, dropTarget, ignored, letter, letterClass, letterTitle, dot, sticky, actions }: RowProps) {
  const folder = entry.kind === 'directory';
  const pinned = sticky !== undefined;
  // Pinned copies are mouse shortcuts only: hidden from assistive technology (the real row is in the tree).
  return (
    <button
      className={`file-entry ${folder ? 'folder' : ''} ${selected ? 'selected' : ''} ${cut ? 'cut' : ''} ${dropTarget ? 'drop-target' : ''} ${ignored ? 'ignored' : ''}`}
      role={pinned ? undefined : 'treeitem'}
      aria-expanded={folder && !pinned ? open : undefined}
      aria-selected={pinned ? undefined : selected}
      aria-level={pinned ? undefined : depth + 1}
      aria-posinset={pinned ? undefined : pos}
      aria-setsize={pinned ? undefined : size}
      tabIndex={pinned ? -1 : undefined}
      data-path={entry.path}
      data-kind={entry.kind}
      data-index={index}
      title={entry.kind === 'symlink' ? `${entry.path} · link` : entry.path}
      style={{ top, height: TREE_ROW_HEIGHT, paddingLeft: pinned ? stickyIndent(sticky) : indentFor(depth) }}
      draggable
      onClick={(e) => pinned ? actions.current.stickyClick(e, index) : actions.current.click(e, entry)}
      // A double click on a file keeps its tab (the second click opens it with 'keep'); on a folder it still renames it.
      onDoubleClick={(e) => { e.preventDefault(); if (!pinned && folder) actions.current.startRename(entry.path); }}
      onContextMenu={(e) => actions.current.menu(e, entry)}
      onDragStart={(e) => actions.current.dragStart(e, entry)}
      onDragOver={(e) => actions.current.dragOver(e, entry)}
      onDrop={(e) => actions.current.drop(e, folder ? entry.path : parentPath(entry.path))}
      onDragEnd={() => actions.current.dragEnd()}
      onFocus={() => { if (!pinned) actions.current.focused(entry.path); }}
      onKeyDown={(e) => {
        if (folder && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          e.preventDefault();
          e.stopPropagation();
          actions.current.toggle(entry.path, e.key === 'ArrowRight');
        } else if (!folder && !pinned && e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          e.preventDefault(); // no native button click (also on a held key): that one would keep the tab, like Enter
          if (!e.repeat) actions.current.preview(entry.path);
        }
      }}
    >
      {!pinned && <Guides depth={depth} />}
      {folder ? <span className={`tree-chevron ${open ? 'open' : ''}`}><TreeChevron /></span> : <span className="tree-twistie" />}
      {folder ? <FolderIcon open={open} dot={dot} /> : <FileIcon name={entry.name} />}
      <span className="file-name">{entry.name}</span>
      {entry.kind === 'symlink' && <span className="muted">↗</span>}
      {letter && <span className={`file-git git-letter ${letterClass ?? ''}`} title={letterTitle}>{letter}</span>}
    </button>
  );
});

function TreeMessageRow({ row, top, actions }: { row: Extract<TreeRow, { type: 'message' }>; top: number; actions: React.MutableRefObject<RowActions> }) {
  const { tr, errorText } = useI18n();
  const text = row.message === 'loading' ? tr('Wczytywanie…')
    : row.message === 'empty' ? tr('Pusty folder')
      : row.message === 'truncated' ? tr('Wyświetlono pierwsze 2000 elementów. Pełna lista jest w menedżerze plików.')
        : errorText(row.error ?? '');
  return (
    <div className={`tree-message tree-row-message ${row.message === 'error' ? 'error' : ''}`} style={{ top, height: TREE_ROW_HEIGHT, paddingLeft: indentFor(row.depth) + TWISTIE + 4 }} role="none" title={text}>
      <Guides depth={row.depth} />
      <span className="tree-message-text">{text}</span>
      {row.message === 'error' && <button className="btn small" onClick={() => actions.current.retry(row.dir)}>{tr('Spróbuj ponownie')}</button>}
    </div>
  );
}

export function ProjectExplorer({ project }: { project: Project }) {
  const { tr, language } = useI18n();
  const actionsLabel = {
    en: 'Project actions', pl: 'Akcje projektu', de: 'Projektaktionen',
    es: 'Acciones del proyecto', fr: 'Actions du projet', pt: 'Ações do projeto',
  }[language];
  const expandedPaths = useExplorer((s) => s.expanded[project.id]);
  const selection = useExplorer((s) => s.selection[project.id]);
  const clipboard = useExplorer((s) => s.clipboard);
  const renaming = useExplorer((s) => s.renaming?.projectId === project.id ? s.renaming.path : null);
  const reveal = useExplorer((s) => s.reveal);
  const refresh = useExplorer((s) => s.refresh);
  const busy = useExplorer((s) => s.busy);
  const badges = useProjectBadges(project.id);
  const [manualRefresh, setManualRefresh] = useState(false);
  const spinning = useHoldBusy(manualRefresh, 700);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hover = useRef<{ path: string; timer: number } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  /** The last focused row: it stays rendered while scrolled away, so the keyboard keeps working. */
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const revealing = useRef<{ path: string; until: number } | null>(null);

  const expanded = useMemo(() => new Set(expandedPaths ?? []), [expandedPaths]);
  const selected = useMemo(() => new Set(selection?.paths ?? []), [selection]);
  const cut = useMemo(() => new Set(clipboard && clipboard.mode === 'cut' && clipboard.projectId === project.id ? clipboard.paths : []), [clipboard, project.id]);
  const listings = useTreeListings(project.id, expandedPaths, refresh);
  const lastRows = useRef<TreeRow[] | null>(null);
  const rows = useMemo(() => (lastRows.current = stabilizeRows(lastRows.current, flattenTree(listings.get, expanded))), [listings.version, listings.get, expanded]);
  const index = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => { if (row.type === 'entry') map.set(row.entry.path, i); });
    return map;
  }, [rows]);
  const entryPaths = useMemo(() => rows.flatMap((row) => row.type === 'entry' ? [row.entry.path] : []), [rows]);

  useGitBadgeSync(project.id, project.path);
  // An agent turn in this project (not in one of its worktrees) may have changed files: the open folders and marks are read again.
  useEffect(() => onTurnRefresh((target) => {
    if (!refreshMatches(target, project.id)) return;
    bumpRefresh();
    refreshGitBadges(project.id, 0);
  }), [project.id]);
  const reload = () => { bumpRefresh(); refreshGitBadges(project.id, 0); setManualRefresh(true); setTimeout(() => setManualRefresh(false), 50); };
  const expandAll = async () => {
    try {
      const result = await window.mc.listProjectDirectories(project.id);
      if (!result.ok) { toast(result.error, 'error'); return; }
      setExpanded(project.id, result.paths);
      if (result.truncated) toast(tr('Rozwinięto pierwsze {count} folderów.', { count: result.paths.length }));
    } catch (error) { toast(String(error), 'error'); }
  };
  const anyOpen = expanded.size > 0;
  const toggleAll = () => (anyOpen ? setExpanded(project.id, []) : void expandAll());
  const toggleAllLabel = anyOpen ? tr("Zwiń wszystkie foldery") : tr("Rozwiń wszystkie foldery");
  const findInFiles = () => setUi({ modal: { kind: 'search', projectId: project.id } });

  const startRename = (path: string) => useExplorer.setState({ renaming: { projectId: project.id, path } });
  const stopRename = () => useExplorer.setState({ renaming: null });
  const clearHover = () => { if (hover.current) window.clearTimeout(hover.current.timer); hover.current = null; };
  const endDrag = () => { dragging = null; setDropTarget(null); clearHover(); };

  // ---------- scrolling and the rendered window ----------

  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = treeRef.current;
    if (el) setViewport((v) => v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight });
  };
  const scrollTo = (top: number) => {
    const el = treeRef.current;
    if (!el) return;
    el.scrollTop = top;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
  };
  /** Scrolls a row into view (below the folders that will be pinned above it) and focuses it once it is rendered. */
  const showRow = (path: string, focus: boolean, center = false) => {
    const i = index.get(path);
    const el = treeRef.current;
    if (i === undefined || !el) return;
    const reserved = Math.min(rows[i].depth, STICKY_MAX) * TREE_ROW_HEIGHT;
    scrollTo(scrollToShow(i, el.scrollTop, el.clientHeight, TREE_ROW_HEIGHT, reserved, center));
    if (focus) { pendingFocus.current = path; setFocusedPath(path); }
  };
  useLayoutEffect(() => {
    const path = pendingFocus.current;
    if (!path) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`.tree-rows .file-entry[data-path="${CSS.escape(path)}"]`);
    if (el) { pendingFocus.current = null; el.focus({ preventScroll: true }); }
  });

  // The rows changed (listings arrived, folders opened or closed): the first visible row stays where it is on screen.
  const anchorRows = useRef<TreeRow[] | null>(null);
  useLayoutEffect(() => {
    const before = anchorRows.current;
    anchorRows.current = rows;
    const el = treeRef.current;
    if (!before || before === rows || !el || el.scrollTop <= 0) return;
    const was = Math.floor(el.scrollTop / TREE_ROW_HEIGHT);
    const anchor = before[was];
    const now = anchor?.type === 'entry' ? index.get(anchor.entry.path) : undefined;
    if (now === undefined || now === was) return;
    scrollTo(now * TREE_ROW_HEIGHT + (el.scrollTop - was * TREE_ROW_HEIGHT));
  }, [rows]);

  // After a dialog: the selected row is scrolled into view and focused (see refocusTree in explorer.ts).
  const showSelected = useRef<() => boolean>(() => false);
  showSelected.current = () => {
    const path = selection?.paths[0];
    if (!path || !index.has(path)) return false;
    showRow(path, true);
    return true;
  };
  useEffect(() => {
    const fn = () => showSelected.current();
    registerTreeFocus(fn);
    return () => registerTreeFocus(null);
  }, []);

  // "Locate in Files": the folders are expanded already; wait for their listings, then scroll the item into view.
  useEffect(() => {
    if (!reveal || reveal.projectId !== project.id) return;
    const target = { path: reveal.path, until: Date.now() + 5000 };
    revealing.current = target;
    const timer = window.setTimeout(() => { if (revealing.current === target) revealing.current = null; }, 5000);
    return () => window.clearTimeout(timer);
  }, [reveal?.nonce, project.id]);
  useEffect(() => {
    const target = revealing.current;
    if (!target) return;
    if (Date.now() > target.until) { revealing.current = null; return; }
    if (!index.has(target.path)) return;
    revealing.current = null;
    showRow(target.path, true, true);
  }, [rows, reveal?.nonce]);
  useEffect(() => () => { clearHover(); }, []);

  const [first, last] = visibleRange(rows.length, viewport.top, viewport.height, TREE_ROW_HEIGHT, OVERSCAN);
  const sticky = useMemo(() => stickyRows(rows, viewport.top, TREE_ROW_HEIGHT, STICKY_MAX), [rows, viewport.top]);
  const rendered: number[] = [];
  for (let i = first; i < last; i++) rendered.push(i);
  // The focused row and the row being renamed stay in the DOM when scrolled away (focus and the input survive).
  for (const path of [focusedPath, renaming]) {
    const i = path ? index.get(path) : undefined;
    if (i !== undefined && (i < first || i >= last) && !rendered.includes(i)) rendered.push(i);
  }

  // ---------- commands ----------

  const canDrop = (paths: string[], dir: string, copy: boolean) =>
    paths.every((p) => dir !== p && !dir.startsWith(`${p}/`)) && (copy || paths.some((p) => parentPath(p) !== dir));
  const isCopy = (e: React.DragEvent | React.KeyboardEvent) => e.ctrlKey || (window.mc.platform === 'darwin' && e.altKey);

  const activePath = (): string | undefined => {
    const active = document.activeElement as HTMLElement | null;
    return active?.closest('.tree-rows') ? active.dataset?.path : undefined;
  };
  const commandTargets = (): string[] => {
    const current = selectedPaths(project.id);
    if (current.length) return current;
    const focused = activePath();
    return focused ? [focused] : [];
  };

  const actions: RowActions = {
    startRename, stopRename, dragEnd: endDrag,
    toggle: (path, open) => toggleFolder(project.id, path, open),
    focused: (path) => setFocusedPath(path),
    retry: (path) => listings.retry(path),
    click: (e, entry) => {
      const folder = entry.kind === 'directory';
      if (e.shiftKey) {
        const anchor = selection?.anchor ?? entry.path;
        const a = entryPaths.indexOf(anchor), b = entryPaths.indexOf(entry.path);
        if (a >= 0 && b >= 0) selectPaths(project.id, entryPaths.slice(Math.min(a, b), Math.max(a, b) + 1), anchor);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const next = selected.has(entry.path) ? [...selected].filter((p) => p !== entry.path) : [...selected, entry.path];
        selectPaths(project.id, next, entry.path);
        return;
      }
      selectPaths(project.id, [entry.path], entry.path);
      if (folder) toggleFolder(project.id, entry.path);
      // A single click opens the preview tab and leaves the keyboard in the tree; the second click of a double click or Enter
      // keep the tab and move the keyboard into its editor (like VS Code). Space is the row's onKeyDown (preview).
      else {
        treeOpen.keyboard = e.detail === 0;
        void openFile(project.id, entry.path, e.detail === 1 ? 'preview' : 'keep');
        if (e.detail !== 1) focusFileEditor(documentId(project.id, entry.path));
      }
    },
    preview: (path) => {
      selectPaths(project.id, [path], path);
      treeOpen.keyboard = false;
      void openFile(project.id, path, 'preview');
    },
    // A pinned folder: a click scrolls to it (it becomes a normal row under its own pinned parents);
    // a click on its chevron collapses it, like VS Code.
    stickyClick: (e, i) => {
      const row = rows[i];
      if (row?.type !== 'entry') return;
      const path = row.entry.path;
      selectPaths(project.id, [path], path);
      if ((e.target as HTMLElement).closest('.tree-chevron')) toggleFolder(project.id, path, false);
      scrollTo(scrollTopForPinned(i, row.depth, TREE_ROW_HEIGHT, STICKY_MAX));
      pendingFocus.current = path;
      setFocusedPath(path);
    },
    menu: (e, entry) => {
      e.preventDefault();
      e.stopPropagation();
      const targets = selected.has(entry.path) ? selectedPaths(project.id) : [entry.path];
      if (!selected.has(entry.path)) selectPaths(project.id, [entry.path], entry.path);
      const fullPath = fullProjectPath(project.path, entry.path);
      const folder = entry.kind === 'directory';
      const dir = folder ? entry.path : parentPath(entry.path);
      const multi = targets.length > 1;
      const { shown, more } = summarizeNames(targets.map(baseName), 3);
      const canPaste = !!clipboard && clipboard.projectId === project.id;
      openMenu(e.clientX, e.clientY, [
        { header: multi ? shown.join(', ') + (more ? ` +${more}` : '') : entry.name },
        ...(multi ? [] : [
          folder
            ? { label: expanded.has(entry.path) ? tr("Zwiń folder") : tr("Rozwiń folder"), onClick: () => toggleFolder(project.id, entry.path) }
            : { label: tr("Podgląd pliku"), onClick: () => void openFile(project.id, entry.path, 'preview') },
          ...(!folder ? [{ label: tr('Otwórz obok gridu'), onClick: () => { void openFile(project.id, entry.path, 'keep'); openBesideGrid(); } }] : []),
          ...(!folder ? [{ label: tr("Otwórz w edytorze"), onClick: () => window.mc.openInEditor(fullPath) }] : []),
          { label: tr("Pokaż w menedżerze plików"), onClick: () => window.mc.revealPath(fullPath) },
          { sep: true as const },
          { label: tr("Nowy plik") + '…', onClick: () => void createEntry(project.id, dir, 'file') },
          { label: tr("Nowy folder") + '…', onClick: () => void createEntry(project.id, dir, 'directory') },
        ]),
        { sep: true },
        ...(multi ? [] : [{ label: tr("Zmień nazwę"), hint: shortcutText('tree.rename') || undefined, onClick: () => { showRow(entry.path, false); startRename(entry.path); } }]),
        { label: tr("Dodaj do rozmowy"), disabled: !focusedCellId(), onClick: () => addTreePathsToFocusedCell(project.id, targets) },
        { label: tr("Duplikuj"), onClick: () => void duplicateEntries(project.id, targets) },
        { label: tr("Wytnij"), hint: shortcutText('tree.cut') || undefined, onClick: () => copyToClipboard(project.id, targets, 'cut') },
        { label: tr("Kopiuj"), hint: shortcutText('tree.copy') || undefined, onClick: () => copyToClipboard(project.id, targets, 'copy') },
        { label: tr("Wklej"), hint: shortcutText('tree.paste') || undefined, disabled: !canPaste || multi, onClick: () => void pasteInto(project.id, dir) },
        ...(multi ? [] : [
          { sep: true as const },
          { label: tr("Kopiuj ścieżkę"), onClick: () => window.mc.clipboardWrite(fullPath) },
          { label: tr("Kopiuj ścieżkę względną"), onClick: () => window.mc.clipboardWrite(entry.path) },
        ]),
        { sep: true },
        { label: tr("Przenieś do kosza"), danger: true, hint: shortcutText('tree.delete') || undefined, onClick: () => void trashEntries(project.id, targets) },
      ]);
    },
    dragStart: (e, entry) => {
      const paths = topLevelPaths(selected.has(entry.path) ? [...selected] : [entry.path]);
      if (!selected.has(entry.path)) selectPaths(project.id, [entry.path], entry.path);
      dragging = { projectId: project.id, paths };
      e.dataTransfer.setData(TREE_MIME, JSON.stringify(dragging));
      e.dataTransfer.setData('text/plain', paths.map((p) => fullProjectPath(project.path, p)).join('\n'));
      // For cells: identifiers only, the receiver rebuilds and checks the paths (see shared/pathDrop.ts).
      e.dataTransfer.setData(PATH_MIME, buildPathPayload(project.id, project.path, paths.map((p) => ({ relPath: p, kind: kindOf(project.id, p) })), window.mc.platform));
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    dragOver: (e, entry) => {
      if (!dragging || dragging.projectId !== project.id) return;
      e.stopPropagation();
      const folder = entry.kind === 'directory';
      const dir = folder ? entry.path : parentPath(entry.path);
      const copy = isCopy(e);
      if (!canDrop(dragging.paths, dir, copy)) { setDropTarget(null); clearHover(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
      setDropTarget(dir);
      if (folder && !expanded.has(entry.path)) {
        if (hover.current?.path !== entry.path) {
          clearHover();
          hover.current = { path: entry.path, timer: window.setTimeout(() => { toggleFolder(project.id, entry.path, true); hover.current = null; }, 600) };
        }
      } else clearHover();
    },
    drop: (e, dir) => {
      if (!dragging || dragging.projectId !== project.id) return;
      e.preventDefault();
      e.stopPropagation();
      const dropped = dragging;
      const copy = isCopy(e);
      endDrag();
      if (!canDrop(dropped.paths, dir, copy)) return;
      void transferEntries({ projectId: project.id, kind: copy ? 'copy' : 'move', paths: dropped.paths, destination: dir });
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const onTreeKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    const targets = commandTargets();
    // The key of each file operation comes from the shortcut settings (shared/shortcuts.ts).
    if (matchesShortcut('tree.rename', e) && targets.length === 1) { e.preventDefault(); showRow(targets[0], false); startRename(targets[0]); }
    else if (matchesShortcut('tree.delete', e) && targets.length) { e.preventDefault(); void trashEntries(project.id, targets); }
    else if (matchesShortcut('tree.copy', e) && targets.length) { e.preventDefault(); copyToClipboard(project.id, targets, 'copy'); }
    else if (matchesShortcut('tree.cut', e) && targets.length) { e.preventDefault(); copyToClipboard(project.id, targets, 'cut'); }
    else if (matchesShortcut('tree.paste', e)) { e.preventDefault(); void pasteInto(project.id, targetDirectory(project.id)); }
    else if (matchesShortcut('tree.undo', e)) { e.preventDefault(); void undoLast(project.id); }
    else if (matchesShortcut('tree.selectAll', e)) { e.preventDefault(); selectPaths(project.id, entryPaths); }
    else if (!mod && !e.altKey && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) {
      const list = entryPaths;
      if (!list.length) return;
      const focused = activePath() ?? selection?.anchor ?? undefined;
      const current = focused ? list.indexOf(focused) : -1;
      const page = Math.max(1, Math.floor(viewport.height / TREE_ROW_HEIGHT) - 1);
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? page : -page;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
        : current < 0 ? 0 : Math.min(list.length - 1, Math.max(0, current + step));
      e.preventDefault();
      const path = list[next];
      showRow(path, true);
      if (e.shiftKey) {
        const anchor = selection?.anchor ?? list[Math.max(0, current)];
        const a = list.indexOf(anchor);
        selectPaths(project.id, list.slice(Math.min(a, next), Math.max(a, next) + 1), anchor);
      } else selectPaths(project.id, [path], path);
    }
  };

  const menu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { header: project.name },
      { label: tr("Nowy plik") + '…', onClick: () => void createEntry(project.id, '', 'file') },
      { label: tr("Nowy folder") + '…', onClick: () => void createEntry(project.id, '', 'directory') },
      { label: tr("Wklej"), hint: shortcutText('tree.paste') || undefined, disabled: !clipboard || clipboard.projectId !== project.id, onClick: () => void pasteInto(project.id, '') },
      { sep: true },
      { label: tr("Odśwież pliki"), onClick: reload },
      { label: tr("Znajdź i zamień w plikach…"), onClick: findInFiles },
      { label: toggleAllLabel, onClick: toggleAll },
      { label: tr("Otwórz folder w menedżerze plików"), onClick: () => window.mc.openPath(project.path) },
      { label: tr("Otwórz projekt w edytorze"), onClick: () => window.mc.openInEditor(project.path) },
      { sep: true },
      { label: tr("Kopiuj ścieżkę projektu"), onClick: () => window.mc.clipboardWrite(project.path) },
      { label: tr("Wróć do projektów"), onClick: () => setUi({ sidebarView: 'projects' }) },
    ]);
  };
  const moreActions = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    openMenu(rect.right, rect.bottom, [
      { header: project.name },
      { label: tr('Znajdź i zamień w plikach…'), onClick: findInFiles },
      { label: toggleAllLabel, onClick: toggleAll },
      { sep: true },
      { label: tr('Otwórz folder w menedżerze plików'), onClick: () => window.mc.openPath(project.path) },
      { label: tr('Otwórz projekt w edytorze'), onClick: () => window.mc.openInEditor(project.path) },
      { label: tr('Wróć do projektów'), onClick: () => setUi({ sidebarView: 'projects' }) },
    ]);
  };

  const entryRow = (i: number, top: number, position?: number) => {
    const row = rows[i];
    if (row.type !== 'entry') return <TreeMessageRow key={row.key} row={row} top={top} actions={actionsRef} />;
    const path = row.entry.path;
    if (position === undefined && renaming === path) return <RenameRow key={`rename:${path}`} entry={row.entry} depth={row.depth} pos={row.pos} size={row.size} top={top} projectId={project.id} actions={actionsRef} />;
    const mark = badgeFor(badges, path, row.entry.kind === 'directory');
    return (
      <TreeEntryRow
        key={path} entry={row.entry} depth={row.depth} open={row.open} pos={row.pos} size={row.size} index={i} top={top} actions={actionsRef} sticky={position}
        selected={selected.has(path)} cut={cut.has(path)} dropTarget={dropTarget === path} ignored={inIgnoredFolder(rows, i)}
        letter={mark.letter?.letter} letterClass={mark.letter?.cls} letterTitle={mark.letter ? tr(mark.letter.title) : undefined} dot={mark.dot}
      />
    );
  };
  const entryCount = entryPaths.length;
  return (
    <div className="project-explorer file-workspace-explorer" onContextMenu={menu} onKeyDown={onTreeKey}>
      <div className="explorer-heading">
        <ProjectIconView project={project} />
        <span className="explorer-project" title={project.path}>{project.name}</span>
        <div className="explorer-heading-actions">
          <button className="btn ghost icon" title={tr('Nowy plik')} aria-label={tr('Nowy plik')} onClick={() => void createEntry(project.id, targetDirectory(project.id), 'file')}><NewEntryIcon /></button>
          <button className="btn ghost icon" title={tr('Nowy folder')} aria-label={tr('Nowy folder')} onClick={() => void createEntry(project.id, targetDirectory(project.id), 'directory')}><NewEntryIcon folder /></button>
          <button className="btn ghost icon" title={tr('Odśwież pliki')} aria-label={tr('Odśwież pliki')} onClick={reload}><RefreshIcon spinning={spinning} /></button>
          <button className="btn ghost icon" title={actionsLabel} aria-label={actionsLabel} aria-haspopup="menu" onClick={moreActions}><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="13" cy="8" r="1" /></svg></button>
        </div>
      </div>
      <div
        ref={treeRef}
        className={`explorer-tree ${dropTarget === '' ? 'drop-root' : ''}`}
        data-rows={entryCount}
        data-loading={listings.pending}
        onScroll={onScroll}
        onDragOver={(e) => {
          if (!dragging || dragging.projectId !== project.id) return;
          const copy = isCopy(e);
          if (!canDrop(dragging.paths, '', copy)) { setDropTarget(null); return; }
          e.preventDefault();
          e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
          setDropTarget('');
          clearHover();
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDropTarget(null); clearHover(); } }}
        onDrop={(e) => actions.drop(e, '')}
      >
        {sticky.rows.length > 0 && (
          <div className="tree-sticky" aria-hidden>
            <div className="tree-sticky-rows" style={{ height: sticky.rows.length * TREE_ROW_HEIGHT + sticky.offset }}>
              {sticky.rows.map((i, position) => entryRow(i, position * TREE_ROW_HEIGHT + (position === sticky.rows.length - 1 ? sticky.offset : 0), position))}
            </div>
          </div>
        )}
        <div
          className="tree-rows" role="tree" aria-multiselectable aria-label={tr('Pliki projektu {name}', { name: project.name })}
          style={{ height: rows.length * TREE_ROW_HEIGHT }}
        >
          {rendered.map((i) => entryRow(i, i * TREE_ROW_HEIGHT))}
        </div>
      </div>
      {busy && (
        <div className="explorer-busy" role="status">
          <span>{tr('Kopiowanie… ({count})', { count: busy.entries })}</span>
          <button className="btn small" onClick={cancelBusy}>{tr('Anuluj')}</button>
        </div>
      )}
    </div>
  );
}

/** 1 px outlines on half pixels at 16 px, so the header icons stay as thin and sharp as the tree's. */
function NewEntryIcon({ folder = false }: { folder?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinejoin="round" aria-hidden="true">
    {folder ? <path d="M8.5 13.5h-7v-10h4l2 2h7v3" /> : <path d="M8.5 14.5h-5v-13h6l3 3v4M9.5 1.5v3h3" />}
    <path d="M12.5 10v5M10 12.5h5" />
  </svg>;
}
