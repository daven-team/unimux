// Detached windows (1.0.6): a grid or a file tab pulled out of the main window into a window of its own, e.g. on a second
// monitor. The registry is AppState.detachedWindows (shared/detached.ts), written here only; a window exists for every entry.
// Terminals keep running: the Pty Host sends a detached grid's output to that window's port instead of the main window's, and
// the window adopts the running ptys (like a reloaded renderer). A file tab's document (unsaved text included) travels through
// main: the giving renderer hands it over, the window takes it once loaded, and gives it back when it is attached again.
// Closing a detached window attaches its tab back; quitting the app closes the windows and keeps the registry for the next start.
// 1.0.8: database, Redis and remote file tabs too. Every window gets its own DB port and SFTP port; the DB Host sends a query's
// rows to the window that asked, and a moving tab's Redis sessions (Pub/Sub) follow it. The tab's runtime state (rows, results,
// sessions, unsaved Redis values) travels as a handoff next to its document. A detached window reports its unsaved database
// work, so the main window's quit question counts it.
import { BrowserWindow, screen, shell, type WebContents } from 'electron';
import { randomUUID } from 'crypto';
import {
  addDetached, boundsAtPoint, boundsBeside, cellOwners, cleanOpenInMain, cleanTarget, cleanWork, DETACHED_DEFAULT_SIZE, DETACHED_MIN_SIZE, DETACHED_TITLE_HEIGHT, detachedList,
  detachedTitle, findDetached, handoffSessions, normalizeDetachedWindows, openGrids, removeDetached, restoreBounds, routeChanges, routeMessage, setDetachedPlace,
  splitHandoffs, targetKey, type DetachedWindow, type DetachedWork, type DisplayArea,
} from '../shared/detached';
import type { AppState } from '../shared/types';
import type { IpcGuard, IpcSenderEvent } from './ipcGuard';
import { isFromWindow, isLive, safeSend } from './safeWindow';

export interface DetachedDeps {
  state(): AppState;
  change(fn: (s: AppState) => AppState): void;
  mainWindow(): BrowserWindow | null;
  /** Loads the renderer into a window with a query (`detached=<id>`). */
  load(win: BrowserWindow, query: Record<string, string>): void;
  preload: string;
  icon(): string;
  pty: { route(id: string, window: string | null): void; connectRenderer(wc: WebContents, window: string): void; forgetRenderer(window: string): void };
  /** 1.0.8: the DB Host and the SFTP Host give every window its own port. */
  ports: Array<{ connectRenderer(wc: WebContents, window: string): void; forgetRenderer(window: string): void }>;
  /** A moved tab's DB sessions: their Pub/Sub messages go to `window` (null: the main window). */
  routeDbSessions(sessions: string[], window: string | null): void;
  /** A window's page went away (reload, crash, closed): its pins of DB and SFTP sessions go (a new page pins again). */
  rendererGone(window: string): void;
  isAlive(cellId: string): boolean;
  /** The app is winding down: windows close without attaching their tab. */
  quitting(): boolean;
  offscreen: boolean;
  devConsole: boolean;
  log(message: string): void;
}

/** Documents handed over with a detach or an attach: plain data, bounded (an editor tab holds at most a few MB). */
const HANDOFF_MAX_CHARS = 64 * 1024 * 1024;
/** How long a closing window may take to give its document back before it closes anyway. */
const ATTACH_TIMEOUT_MS = 3000;
const PLACE_SAVE_MS = 400;

const windows = new Map<string, BrowserWindow>();
/** Windows closing because the app quits (or the main window closed): no attach, the registry stays for the next start. */
let closingAll = false;
let deps: DetachedDeps | null = null;
let owners = new Map<string, string>();
const handoffs = new Map<string, unknown[]>();
const attaching = new Map<string, ReturnType<typeof setTimeout>>();
/** The unsaved database work each detached window reported (1.0.8), relayed to the main window for its quit question. */
const works = new Map<string, DetachedWork>();
let started = false;
let repairQueued = false;

/** The sender check (R9) for detached windows: only windows main created for detached tabs, top-level frames only. */
export function fromDetachedWindow(event: IpcSenderEvent): boolean {
  for (const w of windows.values()) if (isFromWindow(w, event)) return true;
  return false;
}

/** The detached window a sender belongs to (null: not one). */
function windowIdOf(sender: unknown): string | null {
  for (const [id, w] of windows) if (isLive(w) && w.webContents === sender) return id;
  return null;
}

/** The window an IPC message came from (1.0.8): a detached window's id, else 'main'. */
export function senderWindow(event: IpcSenderEvent): string {
  return windowIdOf(event.sender) ?? 'main';
}

/** A detached window's report of unsaved work changed (null: none): the main window learns it. */
function setWork(id: string, work: DetachedWork | null): void {
  const before = works.get(id);
  if (!work && !before) return;
  if (work && before && JSON.stringify(work) === JSON.stringify(before)) return;
  if (work) works.set(id, work); else works.delete(id);
  safeSend(deps?.mainWindow() ?? null, 'detach:work', id, work);
}

/** A detached window's page went away: its ports and pins go (a reloaded page gets new ones), its reported work too. */
function pageGone(id: string, closed: boolean): void {
  deps?.rendererGone(id);
  if (closed) for (const p of deps?.ports ?? []) p.forgetRenderer(id);
  setWork(id, null);
}

/**
 * Sends a main-to-renderer message to the windows that need it: state and status to all, a cell's messages to the window that
 * shows the cell, everything else to the main window (see routeMessage).
 */
export function sendRouted(main: BrowserWindow | null, channel: string, args: unknown[]): void {
  if (!windows.size) { safeSend(main, channel, ...args); return; }
  for (const { window, args: a } of routeMessage(channel, args, owners)) {
    if (window === '*') {
      safeSend(main, channel, ...a);
      for (const w of windows.values()) safeSend(w, channel, ...a);
    } else if (window === null) safeSend(main, channel, ...a);
    else {
      const w = windows.get(window);
      if (!w) { safeSend(main, channel, ...a); continue; }
      // A notification click on a cell of a detached grid brings that window up.
      if (channel === 'focus-cell') showWindow(w);
      safeSend(w, channel, ...a);
    }
  }
}

/** A detached window reported a cell status: the main window learns it too (its badges, its quit question). */
export function relayCellStatus(event: IpcSenderEvent, cellId: unknown, status: unknown): void {
  if (!deps || typeof cellId !== 'string' || typeof status !== 'string' || windowIdOf(event.sender) === null) return;
  safeSend(deps.mainWindow(), 'detach:status', cellId, status);
}

function displays(): { list: DisplayArea[]; primaryId: number } {
  const list = screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea }));
  return { list, primaryId: screen.getPrimaryDisplay().id };
}

function showWindow(w: BrowserWindow): void {
  if (!isLive(w)) return;
  if (w.isMinimized()) w.restore();
  if (deps?.offscreen) w.showInactive(); else { w.show(); w.focus(); }
}

/** Starts following the state: windows for the saved registry open now (after the main window). */
export function initDetachedWindows(d: DetachedDeps, guard: Pick<IpcGuard, 'guardedHandle' | 'guardedOn'>): void {
  deps = d;
  registerIpc(guard);
}

/** Opens the windows of the saved registry; called once the main window exists. */
export function startDetachedWindows(): void {
  started = true;
  if (deps) stateChanged(deps.state());
}

/** Every state change: the registry repaired (closed grids), routes of moved cells, windows opened, closed and renamed. */
export function stateChanged(state: AppState): void {
  const d = deps;
  if (!d) return;
  const repaired = normalizeDetachedWindows(state.detachedWindows, openGrids(state.projects));
  if (JSON.stringify(repaired) !== JSON.stringify(state.detachedWindows)) {
    // A grid closed by MCP or a resync: its window goes (the change is made outside this listener).
    if (!repairQueued) {
      repairQueued = true;
      setImmediate(() => {
        repairQueued = false;
        d.change((s) => {
          const list = normalizeDetachedWindows(s.detachedWindows, openGrids(s.projects));
          if (JSON.stringify(list) === JSON.stringify(s.detachedWindows)) return s;
          const next = { ...s };
          if (list) next.detachedWindows = list; else delete next.detachedWindows;
          return next;
        });
      });
    }
  }
  const nextOwners = cellOwners(state);
  for (const [cellId, window] of routeChanges(owners, nextOwners)) d.pty.route(cellId, window);
  owners = nextOwners;
  if (!started) return;
  const list = detachedList(state);
  for (const entry of list) {
    const w = windows.get(entry.id);
    if (!w) createWindow(entry, state);
    else if (isLive(w)) {
      const title = detachedTitle(state, entry.target);
      if (w.getTitle() !== title) w.setTitle(title);
    }
  }
  for (const [id, w] of [...windows]) {
    if (list.some((e) => e.id === id)) continue;
    windows.delete(id);
    d.pty.forgetRenderer(id);
    pageGone(id, true);
    try { w.destroy(); } catch { /* already gone */ }
  }
}

function createWindow(entry: DetachedWindow, state: AppState): void {
  const d = deps!;
  const { list, primaryId } = displays();
  const { bounds } = restoreBounds(entry.bounds, list, primaryId);
  const w = new BrowserWindow({
    ...(d.offscreen ? { x: -6000 + windows.size * 40, y: 40 + windows.size * 40, width: bounds.width, height: bounds.height } : bounds),
    minWidth: DETACHED_MIN_SIZE.width,
    minHeight: DETACHED_MIN_SIZE.height,
    backgroundColor: '#0d0d0d',
    title: detachedTitle(state, entry.target),
    icon: d.icon(),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: { color: '#0d0d0d', symbolColor: '#8a8a8a', height: DETACHED_TITLE_HEIGHT } }),
    show: false,
    // The same preload and sandbox as the main window (R9: main trusts only windows it created here).
    webPreferences: { preload: d.preload, sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false },
    ...(d.offscreen ? { skipTaskbar: true, focusable: false } : {}),
  });
  const id = entry.id;
  windows.set(id, w);
  w.once('ready-to-show', () => {
    if (!isLive(w)) return;
    if (entry.maximized && !d.offscreen) w.maximize();
    if (d.offscreen) w.showInactive(); else w.show();
  });
  const sendShown = () => { if (isLive(w)) safeSend(w, 'window:shown', w.isVisible() && !w.isMinimized()); };
  for (const event of ['minimize', 'restore', 'hide', 'show'] as const) w.on(event as 'show', sendShown);
  w.webContents.on('did-finish-load', () => {
    if (!isLive(w)) return;
    d.pty.connectRenderer(w.webContents, id);
    for (const p of d.ports) p.connectRenderer(w.webContents, id);
    sendShown();
  });
  // A reload (or the reload after a crash): the new page pins its sessions and reports its work again.
  w.webContents.on('did-start-loading', () => pageGone(id, false));
  if (d.devConsole) w.webContents.on('console-message', (e) => e.level !== 'debug' && console.log(`[detached ${id.slice(0, 8)}]`, e.level, e.message));
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // A crashed renderer comes back: its terminals live on in the Pty Host and are replayed.
  w.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || closingAll || d.quitting() || !isLive(w)) return;
    d.log(`detached window renderer gone (${details.reason})`);
    try { w.webContents.reload(); } catch { /* the window is going away */ }
  });
  let placeTimer: ReturnType<typeof setTimeout> | undefined;
  const savePlace = () => {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      if (!isLive(w) || d.offscreen) return;
      const normal = w.getNormalBounds();
      const displayId = screen.getDisplayMatching(normal).id;
      d.change((s) => setDetachedPlace(s, id, { bounds: normal, displayId, maximized: w.isMaximized() }));
    }, PLACE_SAVE_MS);
  };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize'] as const) w.on(event as 'move', savePlace);
  // The close button (or Alt+F4, Cmd+W) puts the tab back into the main window; it never closes the grid or its terminals.
  w.on('close', (e) => {
    if (closingAll || d.quitting() || !findDetached(d.state(), id)) return;
    e.preventDefault();
    requestAttach(id);
  });
  w.on('closed', () => {
    clearTimeout(placeTimer);
    const current = windows.get(id) === w;
    if (current) windows.delete(id);
    d.pty.forgetRenderer(id);
    if (current) pageGone(id, true);
    // Gone without giving its tab back (the page closed itself, a forced close): the tab still returns; the main window
    // finds a file's unsaved text in this window's draft storage.
    if (current && !closingAll && !d.quitting() && findDetached(d.state(), id)) attach(id, null);
  });
  d.load(w, { detached: id });
}

/** Asks the window to give its tab back (its document, pending edits); attaches without it after a timeout. */
function requestAttach(id: string): void {
  const w = windows.get(id);
  if (attaching.has(id)) return;
  if (!w || !isLive(w)) { attach(id, null); return; }
  attaching.set(id, setTimeout(() => { attaching.delete(id); attach(id, null); }, ATTACH_TIMEOUT_MS));
  safeSend(w, 'detach:closing');
}

/** Puts the tab back into the main window: the main renderer adopts the cells (or the documents), then the window goes. */
function attach(id: string, docs: unknown[] | null): boolean {
  const d = deps;
  if (!d) return false;
  clearTimeout(attaching.get(id));
  attaching.delete(id);
  const entry = findDetached(d.state(), id);
  if (!entry) return false;
  const main = d.mainWindow();
  const alive = entry.target.kind === 'grid' ? cellIdsOf(d.state(), entry.target.tabId).filter((c) => d.isAlive(c)) : [];
  // The tab's Redis sessions come back with it: their Pub/Sub messages go to the main window again.
  if (docs?.length) d.routeDbSessions(handoffSessions(splitHandoffs(docs).handoffs), null);
  // Before the state change: the main renderer marks the running cells as adopted, so the grid it shows again never respawns them.
  safeSend(main, 'detach:returned', { id, target: entry.target, docs: docs ?? [], alive });
  d.change((s) => removeDetached(s, id));
  if (main && isLive(main)) showWindow(main);
  return true;
}

function cellIdsOf(state: AppState, tabId: string): string[] {
  for (const p of state.projects) { const t = p.tabs.find((x) => x.id === tabId); if (t) return t.cells.map((c) => c.id); }
  return [];
}

function cleanDocs(raw: unknown): unknown[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 4) return null;
  try { if (JSON.stringify(raw).length > HANDOFF_MAX_CHARS) return null; } catch { return null; }
  return raw.filter((x) => !!x && typeof x === 'object' && !Array.isArray(x));
}

/** The main window's bounds hold the cursor (a tab dragged back over it, or one dropped onto it). */
function cursorOverMain(): boolean {
  const main = deps?.mainWindow();
  if (!main || !isLive(main) || main.isMinimized() || !main.isVisible()) return false;
  const p = screen.getCursorScreenPoint();
  const b = main.getBounds();
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

type DetachResult = { ok: true; id: string } | { ok: false; error: string };

/** Opens a window for a tab of the main window: at the cursor (dropped outside) or on another display (the menu). */
function detach(rawTarget: unknown, rawDocs: unknown, at: 'cursor' | 'beside'): DetachResult {
  const d = deps;
  if (!d) return { ok: false, error: 'not ready' };
  const target = cleanTarget(rawTarget);
  const docs = cleanDocs(rawDocs);
  if (!target || !docs) return { ok: false, error: 'invalid' };
  const state = d.state();
  if (target.kind === 'grid' && openGrids(state.projects).get(target.tabId) !== target.projectId) return { ok: false, error: 'invalid' };
  // A file tab: its one document (and, 1.0.8, the handoff of a database or Redis tab next to it).
  const parts = splitHandoffs(docs);
  if (target.kind === 'file' && (parts.docs.length !== 1 || parts.handoffs.length > 1)) return { ok: false, error: 'invalid' };
  const existing = detachedList(state).find((w) => targetKey(w.target) === targetKey(target));
  if (existing) { const w = windows.get(existing.id); if (w) showWindow(w); return { ok: true, id: existing.id }; }
  const { list, primaryId } = displays();
  const main = d.mainWindow();
  const size = DETACHED_DEFAULT_SIZE;
  const place = at === 'cursor' ? boundsAtPoint(screen.getCursorScreenPoint(), size, list, primaryId) : boundsBeside(main && isLive(main) ? main.getBounds() : null, size, list, primaryId);
  const entry: DetachedWindow = { id: randomUUID(), target, bounds: place.bounds, ...(place.displayId !== undefined ? { displayId: place.displayId } : {}) };
  let added: DetachedWindow | null = null;
  d.change((s) => { const r = addDetached(s, entry); added = r?.window ?? null; return r?.state ?? s; });
  if (!added) return { ok: false, error: 'limit' };
  if ((added as DetachedWindow).id === entry.id && target.kind === 'file') {
    handoffs.set(entry.id, docs);
    // A Redis tab's Pub/Sub messages go to its new window from now on (the window takes the rest when it loads).
    d.routeDbSessions(handoffSessions(parts.handoffs), entry.id);
  }
  return { ok: true, id: (added as DetachedWindow).id };
}

function registerIpc({ guardedHandle, guardedOn }: Pick<IpcGuard, 'guardedHandle' | 'guardedOn'>): void {
  const refused = (): DetachResult => ({ ok: false, error: 'refused' });
  // From the main window only: its tab goes to a new window.
  guardedHandle('detach:open', (e, target: unknown, docs: unknown) => (windowIdOf(e.sender) === null ? detach(target, docs, 'beside') : refused()), refused);
  // A tab dragged out of the main window and dropped outside it: a new window under the cursor (inside: nothing happens).
  guardedHandle('detach:dropOutside', (e, target: unknown, docs: unknown) => {
    if (windowIdOf(e.sender) !== null) return refused();
    return cursorOverMain() ? { ok: false, error: 'inside' } : detach(target, docs, 'cursor');
  }, refused);
  // The detached window takes the documents handed over for it (once).
  guardedHandle('detach:take', (e) => {
    const id = windowIdOf(e.sender);
    if (id === null) return [];
    const docs = handoffs.get(id) ?? [];
    handoffs.delete(id);
    return docs;
  }, () => []);
  // The detached window gives its tab back ("Przypnij z powrotem", its close button, its tab dragged onto the main window).
  // `overMain`: only when the cursor is over the main window (the end of a drag).
  guardedHandle('detach:attach', (e, docs: unknown, overMain: unknown) => {
    const id = windowIdOf(e.sender);
    const clean = cleanDocs(docs);
    if (id === null || clean === null) return false;
    if (overMain === true && !cursorOverMain()) return false;
    return attach(id, clean);
  }, () => false);
  // The detached window's tab was closed there (its file tab's close button): the window goes, nothing comes back.
  guardedHandle('detach:dismiss', (e) => {
    const id = windowIdOf(e.sender);
    if (id === null || !deps || !findDetached(deps.state(), id)) return false;
    deps.change((s) => removeDetached(s, id));
    return true;
  }, () => false);
  // The main window asks for a tab back (its dimmed chip's menu, a detached tab dropped onto its strip): the window gives it.
  guardedOn('detach:requestAttach', (e, id: unknown) => {
    if (typeof id === 'string' && windowIdOf(e.sender) === null && windows.has(id)) requestAttach(id);
  });
  // 1.0.8: a closing detached window needs longer to give its tab back (it asks about a running query first): no timeout.
  guardedOn('detach:stay', (e) => {
    const id = windowIdOf(e.sender);
    if (id === null) return;
    clearTimeout(attaching.get(id));
    attaching.delete(id);
  });
  // 1.0.8: a detached window's unsaved database work (open transactions, staged edits, Redis values) for the quit question.
  guardedOn('detach:work', (e, raw: unknown) => {
    const id = windowIdOf(e.sender);
    if (id !== null && deps && findDetached(deps.state(), id)) setWork(id, cleanWork(raw));
  });
  // The main window (after a reload) asks what the detached windows hold.
  guardedHandle('detach:works', (e) => (windowIdOf(e.sender) === null ? [...works].map(([id, work]) => ({ id, work })) : []), () => []);
  // A detached database or Redis tab opens another tab ("Open in the SQL editor", another Redis view): in the main window.
  guardedOn('detach:openInMain', (e, raw: unknown) => {
    const request = cleanOpenInMain(raw);
    const main = deps?.mainWindow() ?? null;
    if (windowIdOf(e.sender) === null || !request || !main || !isLive(main)) return;
    safeSend(main, 'detach:openInMain', request);
    showWindow(main);
  });
  guardedOn('detach:focus', (_e, id: unknown) => {
    const w = typeof id === 'string' ? windows.get(id) : undefined;
    if (w) showWindow(w);
  });
}

/** The app quits or the main window closed: every detached window closes as it is (the next start reopens it). */
export function closeAllDetached(): void {
  closingAll = true;
  for (const w of [...windows.values()]) { try { if (isLive(w)) w.close(); } catch { /* already gone */ } }
}
