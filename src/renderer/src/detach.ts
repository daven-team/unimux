// Tabs in their own window (1.0.6), the renderer's side: detaching a tab of the main window (its menu, or dragging it out of
// the window), the main window following what is detached (it lets go of those cells' terminals and takes them back), and the
// documents that travel with a file tab. Main owns the registry and the windows (main/detachedWindows.ts).
// 1.0.8: database, Redis and remote file tabs move too. Next to its document a database or Redis tab takes a handoff along
// (what it shows, its sessions, its unsaved Redis values); a query that runs is stopped first (the user is asked).
import { detachedGridIds, findDetached, splitHandoffs, type DetachedReopen, type DetachedTarget, type TabHandoff } from '../../shared/detached';
import type { DbSessionState } from '../../shared/db';
import type { CellStatus } from '../../shared/status';
import { neighbourAfterClose, parseWorkspaceKey } from '../../shared/workspaceOrder';
import { adoptCells, handOverCell, isStarted, selectTab } from './actions';
import { setDetachedWork } from './closeGuard';
import { adoptDbTab, exportDbTab, forgetMovedDbTab, openSqlTab, reopenDbTab, settleQueryBeforeMove, waitDbTabIdle } from './db/tabs';
import { activateFile, draftStorageKey, dropTab, openDiffTab, openFile, openLocalFile, openRemoteFile, retryFile, useFileStore, type FileDocument } from './files';
import { tr } from './i18n';
import { adoptRedisTab, exportRedisTab, markRedisTabMoved, openRedisTab, reopenRedisTab } from './redis/redisClient';
import { getS, setUi, toast, useStore } from './store';
import { terminals } from './terminals/TerminalManager';
import { cellShownHere, detachedId } from './windowRole';
import { activateWorkspaceKey, currentStrip } from './workspaceStrip';

/**
 * A file tab that can go to its own window: an editor or diff of a project, local or remote file, and (1.0.8) a database or
 * Redis tab. Not a note (it lives in the Notes panel), not a tab that is saving.
 */
export function canDetachFile(doc: Pick<FileDocument, 'db' | 'redis' | 'source' | 'saving' | 'note'>): boolean {
  return !doc.note && !doc.saving;
}

function reopenOf(doc: FileDocument): DetachedReopen {
  if (doc.db) return { kind: 'db', ref: { ...doc.db }, path: doc.relativePath };
  if (doc.redis) return { kind: 'redis', ref: { ...doc.redis }, path: doc.relativePath };
  if (doc.diff) return { kind: 'diff', projectId: doc.projectId, diff: { ...doc.diff } };
  if (doc.source?.kind === 'local') return { kind: 'local', path: doc.source.path };
  if (doc.source?.kind === 'remote') return { kind: 'remote', hostId: doc.source.hostId, path: doc.source.path };
  return { kind: 'project', projectId: doc.projectId, relativePath: doc.relativePath };
}

/** The document as it travels to the other window: plain data, never the in-flight flags of this window. */
export const portableDoc = (doc: FileDocument): FileDocument => ({ ...doc, saving: false, preview: undefined });

/**
 * What a database or Redis tab takes along (null: a file tab, nothing more). `moving`: the move is about to happen, so a query
 * that runs is asked about (false: the user kept the tab here) and a page or a save that loads is waited for.
 */
export async function tabHandoff(doc: FileDocument): Promise<TabHandoff | null | false> {
  if (doc.db) {
    if (!await settleQueryBeforeMove(doc.id)) return false;
    // A page, a save or a DDL that loads ends in a moment; what it brings must arrive in this tab before it moves.
    await waitDbTabIdle(doc.id, 30_000);
    const db = exportDbTab(doc.id);
    const sessions = db ? [db.session.own, db.session.shared?.sessionId].filter((x): x is string => typeof x === 'string') : [];
    return { handoff: 'tab', fileId: doc.id, dbSessions: sessions, ...(db ? { db } : {}) };
  }
  if (doc.redis) {
    const redis = exportRedisTab(doc.id);
    return { handoff: 'tab', fileId: doc.id, dbSessions: redis.sessionId ? [redis.sessionId] : [], redis };
  }
  return null;
}

/** The tab left this window (its document and handoff went to another one): what it kept here goes, its sessions do not end. */
export function forgetMovedTab(doc: FileDocument, handoff: TabHandoff | null): void {
  if (doc.db) forgetMovedDbTab(doc.id);
  if (doc.redis) markRedisTabMoved(doc.id, handoff?.dbSessions[0] ?? null);
}

/** The target and the documents of a strip key ('grid:<id>' or 'file:<id>'); null when that tab cannot be detached. */
function detachRequest(key: string): { target: DetachedTarget; doc: FileDocument | null } | null {
  const parsed = parseWorkspaceKey(key);
  if (parsed?.kind === 'grid') {
    const project = getS().projects.find((p) => p.tabs.some((t) => t.id === parsed.id));
    return project ? { target: { kind: 'grid', projectId: project.id, tabId: parsed.id }, doc: null } : null;
  }
  if (parsed?.kind === 'file') {
    const doc = useFileStore.getState().documents.find((d) => d.id === parsed.id);
    if (!doc || !canDetachFile(doc)) return null;
    return { target: { kind: 'file', fileId: doc.id, projectId: doc.projectId, name: doc.name, reopen: reopenOf(doc) }, doc };
  }
  return null;
}

/** Can the strip key go to its own window (the tab menu shows the item only then)? */
export const canDetachKey = (key: string): boolean => detachedId === null && detachRequest(key) !== null;

let detaching = false;
/**
 * "Przenieś do nowego okna" (`menu`: on another display when there is one) or a tab dropped outside the window (`drop`: under
 * the cursor; a drop inside the window does nothing). The tab in front goes: its neighbour in the strip comes to the front.
 */
export async function detachKey(key: string, how: 'menu' | 'drop'): Promise<boolean> {
  if (detachedId !== null || detaching) return false;
  const first = detachRequest(key);
  if (!first) return false;
  detaching = true;
  try {
    const handoff = first.doc ? await tabHandoff(first.doc) : null;
    if (handoff === false) return false;
    // The document as it is now (a page or a save that was waited for may have changed it).
    const request = detachRequest(key);
    if (!request) return false;
    const docs: unknown[] = request.doc ? [portableDoc(request.doc), ...(handoff ? [handoff] : [])] : [];
    const strip = currentStrip();
    const neighbour = strip.active === key ? neighbourAfterClose(strip.shown, key) : null;
    const result = await (how === 'menu' ? window.mc.detach.open(request.target, docs) : window.mc.detach.dropOutside(request.target, docs));
    if (!result.ok) {
      if (result.error === 'limit') toast(tr('Osobnych okien może być najwyżej {count}.', { count: 8 }), 'error');
      return false;
    }
    // The document now lives in the other window (main holds it until that window takes it); here the tab goes without asking,
    // and a database or Redis tab leaves its sessions running (the other window uses them now).
    if (request.doc) { forgetMovedTab(request.doc, handoff); dropTab(request.doc.id); }
    if (neighbour && neighbour !== key) activateWorkspaceKey(neighbour);
    return true;
  } finally { detaching = false; }
}

/**
 * Puts documents that came from another window into this one's tabs (the same file replaces its tab) and shows the first. A
 * database or Redis tab takes its handoff over first (its sessions and what it showed), so its view never logs in again.
 */
export async function adoptDocuments(raw: readonly unknown[]): Promise<string | null> {
  const { docs: plain, handoffs } = splitHandoffs(raw);
  const docs = plain.filter((d): d is FileDocument => {
    const x = d as Partial<FileDocument> | null;
    return !!x && typeof x.id === 'string' && typeof x.projectId === 'string' && typeof x.relativePath === 'string' && typeof x.name === 'string'
      && typeof x.text === 'string' && typeof x.savedText === 'string' && typeof x.diskText === 'string';
  }).map((d) => ({ ...d, saving: false, preview: undefined }));
  if (!docs.length) return null;
  if (handoffs.length) {
    const sessions: DbSessionState[] = (await window.mc.db.sessions().catch(() => null))?.sessions ?? [];
    for (const h of handoffs) {
      const doc = docs.find((d) => d.id === h.fileId);
      try {
        if (doc?.db) adoptDbTab(doc.id, doc.db, h.db, sessions);
        else if (doc?.redis) adoptRedisTab(doc.id, h.redis, sessions);
      } catch { /* the tab opens without what it showed: it loads again */ }
    }
  }
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
  else if (r.kind === 'remote') await openRemoteFile(r.hostId, r.path);
  else if (r.kind === 'db') reopenDbTab(r.ref, target.name, r.path);
  else if (r.kind === 'redis') reopenRedisTab(r.ref, target.name, r.path);
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
      return;
    }
    const target = back.target;
    void (async () => {
      if (!await adoptDocuments(back.docs)) {
        // The window went without handing its document over (it crashed or closed itself): its stored draft, else the file again.
        if (!await adoptDocuments(storedDrafts(back.id).filter((d) => (d as { id?: unknown }).id === target.fileId))) await reopenTarget(target);
      }
      // The detached window's own draft storage is not needed any more (its documents are here now).
      try { localStorage.removeItem(draftStorageKey(back.id)); } catch { /* nothing stored */ }
    })();
  });
  window.mc.on('detach:status', (cellId: string, status: CellStatus) => {
    if (cellShownHere(cellId)) return;
    setUi((ui) => (ui.statuses[cellId] === status ? {} : { statuses: { ...ui.statuses, [cellId]: status } }));
  });
  // 1.0.8: the unsaved database work of the detached windows counts in this window's quit question.
  window.mc.on('detach:work', (id, work) => setDetachedWork(id, work));
  void window.mc.detach.works().then((list) => { for (const { id, work } of list) setDetachedWork(id, work); }).catch(() => undefined);
  // A detached database or Redis tab opens another tab here ("Otwórz w edytorze SQL", another Redis view).
  window.mc.on('detach:openInMain', (request) => {
    if (request.kind === 'sql') openSqlTab(request.connectionId, request.database, request.text);
    else openRedisTab(request.connectionId, request.view, request.db);
  });
}

/** Asks a detached window to give its tab back (from the main window). */
export function requestAttach(id: string): void {
  if (findDetached(getS(), id)) window.mc.detach.requestAttach(id);
}
