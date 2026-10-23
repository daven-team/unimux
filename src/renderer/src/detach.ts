// Tabs in their own window (1.0.6), the renderer's side: detaching a tab of the main window (its menu, or dragging it out of
// the window), the main window following what is detached (it lets go of those cells' terminals and takes them back), and the
// documents that travel with a file tab. Main owns the registry and the windows (main/detachedWindows.ts).
import { detachedGridIds, findDetached, type DetachedReopen, type DetachedTarget } from '../../shared/detached';
import type { CellStatus } from '../../shared/status';
import { neighbourAfterClose, parseWorkspaceKey } from '../../shared/workspaceOrder';
import { adoptCells, handOverCell, isStarted, selectTab } from './actions';
import { activateFile, draftStorageKey, dropTab, openDiffTab, openFile, openLocalFile, retryFile, useFileStore, type FileDocument } from './files';
import { tr } from './i18n';
import { getS, setUi, toast, useStore } from './store';
import { terminals } from './terminals/TerminalManager';
import { cellShownHere, detachedId } from './windowRole';
import { activateWorkspaceKey, currentStrip } from './workspaceStrip';

/** A file tab that can go to its own window: an editor or diff of a project file or a local file (not a database view, not a remote file). */
export function canDetachFile(doc: Pick<FileDocument, 'db' | 'redis' | 'source' | 'saving'>): boolean {
  return !doc.db && !doc.redis && doc.source?.kind !== 'remote' && !doc.saving;
}

function reopenOf(doc: FileDocument): DetachedReopen {
  if (doc.diff) return { kind: 'diff', projectId: doc.projectId, diff: { ...doc.diff } };
  if (doc.source?.kind === 'local') return { kind: 'local', path: doc.source.path };
  return { kind: 'project', projectId: doc.projectId, relativePath: doc.relativePath };
}

/** The document as it travels to the other window: plain data, never the in-flight flags of this window. */
export const portableDoc = (doc: FileDocument): FileDocument => ({ ...doc, saving: false, preview: undefined });

/** The target and the documents of a strip key ('grid:<id>' or 'file:<id>'); null when that tab cannot be detached. */
function detachRequest(key: string): { target: DetachedTarget; docs: FileDocument[] } | null {
  const parsed = parseWorkspaceKey(key);
  if (parsed?.kind === 'grid') {
    const project = getS().projects.find((p) => p.tabs.some((t) => t.id === parsed.id));
    return project ? { target: { kind: 'grid', projectId: project.id, tabId: parsed.id }, docs: [] } : null;
  }
  if (parsed?.kind === 'file') {
    const doc = useFileStore.getState().documents.find((d) => d.id === parsed.id);
    if (!doc || !canDetachFile(doc)) return null;
    return { target: { kind: 'file', fileId: doc.id, projectId: doc.projectId, name: doc.name, reopen: reopenOf(doc) }, docs: [portableDoc(doc)] };
  }
  return null;
}

/** Can the strip key go to its own window (the tab menu shows the item only then)? */
export const canDetachKey = (key: string): boolean => detachedId === null && detachRequest(key) !== null;

/**
 * "Przenieś do nowego okna" (`menu`: on another display when there is one) or a tab dropped outside the window (`drop`: under
 * the cursor; a drop inside the window does nothing). The tab in front goes: its neighbour in the strip comes to the front.
 */
export async function detachKey(key: string, how: 'menu' | 'drop'): Promise<boolean> {
  if (detachedId !== null) return false;
  const request = detachRequest(key);
  if (!request) return false;
  const strip = currentStrip();
  const neighbour = strip.active === key ? neighbourAfterClose(strip.shown, key) : null;
  const result = await (how === 'menu' ? window.mc.detach.open(request.target, request.docs) : window.mc.detach.dropOutside(request.target, request.docs));
  if (!result.ok) {
    if (result.error === 'limit') toast(tr('Osobnych okien może być najwyżej {count}.', { count: 8 }), 'error');
    return false;
  }
  // The document now lives in the other window (main holds it until that window takes it); here the tab goes without asking.
  if (request.target.kind === 'file') dropTab(request.target.fileId);
  if (neighbour && neighbour !== key) activateWorkspaceKey(neighbour);
  return true;
}

/** Puts documents that came from another window into this one's tabs (the same file replaces its tab) and shows the first. */
export function adoptDocuments(raw: readonly unknown[]): string | null {
  const docs = raw.filter((d): d is FileDocument => {
    const x = d as Partial<FileDocument> | null;
    return !!x && typeof x.id === 'string' && typeof x.projectId === 'string' && typeof x.relativePath === 'string' && typeof x.name === 'string'
      && typeof x.text === 'string' && typeof x.savedText === 'string' && typeof x.diskText === 'string';
  }).map((d) => ({ ...d, saving: false, preview: undefined }));
  if (!docs.length) return null;
  const ids = new Set(docs.map((d) => d.id));
  useFileStore.setState((s) => ({ documents: [...s.documents.filter((d) => !ids.has(d.id)), ...docs] }));
  for (const d of docs) if (d.status === 'loading') void retryFile(d.id);
  activateFile(docs[0].id);
  return docs[0].id;
}

/** The drafts a detached window kept in its own storage (the same origin: the windows share localStorage). */
function storedDrafts(windowId: string): unknown[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(draftStorageKey(windowId)) ?? '[]');
    return Array.isArray(value) ? value.map((d) => ({ ...(d as object), status: 'ready', saving: false, error: null })) : [];
  } catch { return []; }
}

/** Opens a detached file tab's file again (a restart without a draft, or a window that went without its document). */
export async function reopenTarget(target: DetachedTarget): Promise<void> {
  if (target.kind !== 'file') return;
  const r = target.reopen;
  if (r.kind === 'project') await openFile(r.projectId, r.relativePath, 'keep');
  else if (r.kind === 'diff') openDiffTab(r.projectId, r.diff, 'keep');
  else await openLocalFile(r.path);
}

let following = false;
/** The main window follows the detached windows: their cells' terminals go and come back, their statuses keep arriving. */
export function initDetachFollow(): void {
  if (following || detachedId !== null) return;
  following = true;
  let away = detachedGridIds(getS());
  /** Grids that came back and are brought to the front once the state says they are here again. */
  const returning = new Set<string>();
  const handOver = () => {
    for (const p of getS().projects) for (const t of p.tabs) for (const c of t.cells) {
      if (!cellShownHere(c.id) && (terminals.has(c.id) || isStarted(c.id))) handOverCell(c.id);
    }
  };
  handOver();
  useStore.subscribe((st, prev) => {
    if (st.s.detachedWindows === prev.s.detachedWindows && st.s.projects === prev.s.projects) return;
    handOver();
    const now = detachedGridIds(st.s);
    for (const tabId of away) {
      if (now.has(tabId) || !returning.delete(tabId)) continue;
      const project = st.s.projects.find((p) => p.tabs.some((t) => t.id === tabId));
      const tab = project?.tabs.find((t) => t.id === tabId);
      if (project && tab) selectTab(project.id, tab);
    }
    away = now;
  });
  window.mc.on('detach:returned', (back) => {
    if (back.target.kind === 'grid') {
      adoptCells(back.alive);
      returning.add(back.target.tabId);
    } else if (!adoptDocuments(back.docs)) {
      // The window went without handing its document over (it crashed or closed itself): its stored draft, else the file again.
      if (!adoptDocuments(storedDrafts(back.id).filter((d) => (d as { id?: unknown }).id === (back.target as { fileId: string }).fileId))) void reopenTarget(back.target);
    }
    // The detached window's own draft storage is not needed any more (its documents are here now).
    try { localStorage.removeItem(draftStorageKey(back.id)); } catch { /* nothing stored */ }
  });
  window.mc.on('detach:status', (cellId: string, status: CellStatus) => {
    if (cellShownHere(cellId)) return;
    setUi((ui) => (ui.statuses[cellId] === status ? {} : { statuses: { ...ui.statuses, [cellId]: status } }));
  });
}

/** Asks a detached window to give its tab back (from the main window). */
export function requestAttach(id: string): void {
  if (findDetached(getS(), id)) window.mc.detach.requestAttach(id);
}
