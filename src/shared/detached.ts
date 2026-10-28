// Tabs pulled out of the main window into their own window (1.0.6): a grid (its terminals keep running) or a file / diff tab;
// 1.0.8 adds database (table, SQL, DDL), Redis and remote (SFTP) file tabs.
// The registry lives in AppState.detachedWindows and is written by main only (the renderer asks main to detach or attach).
// Pure logic: the registry, which window owns which cell, where a window opens, which messages go to which window, what a
// moving tab takes along and the unsaved work a detached window reports for the quit question.
import type { AppState, Project } from './types';
import { DB_LIMITS, isDbSessionId } from './db';
import { validDbTabRef, type DbTabRef } from './dbTabs';
import { REDIS_TAB_VIEWS, validRedisTabRef, type RedisTabRef, type RedisTabView } from './redisView';
import { validRemotePath } from './sftp';
import { isUuid } from './ssh';

/** Detached windows at most (each is a renderer process). */
export const DETACHED_LIMIT = 8;
/** Window sizes: the default of a new detached window, and the smallest one. */
export const DETACHED_DEFAULT_SIZE = { width: 1000, height: 700 } as const;
export const DETACHED_MIN_SIZE = { width: 480, height: 320 } as const;
/** Height of the detached window's title bar (the native window controls take the same height on Windows). */
export const DETACHED_TITLE_HEIGHT = 36;
const ID_MAX = 128;
const TEXT_MAX = 4096;

export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayArea { id: number; workArea: Rect }

/** How a detached file tab is read again after a restart (when no unsaved draft of it was kept). */
export type DetachedReopen =
  | { kind: 'project'; projectId: string; relativePath: string }
  | { kind: 'diff'; projectId: string; diff: { source: 'working' | 'staged' | 'commit' | 'untracked'; path: string; oldPath?: string; hash?: string; worktree?: string } }
  | { kind: 'local'; path: string }
  /** 1.0.8: a remote file of a saved SSH host (read again over SFTP, logging in with the usual prompts). */
  | { kind: 'remote'; hostId: string; path: string }
  /** 1.0.8: a database tab (table data, SQL editor or DDL), opened again on a new session; `path`: its tooltip line. */
  | { kind: 'db'; ref: DbTabRef; path: string }
  /** 1.0.8: a Redis view (the same tab id: its uid is kept). */
  | { kind: 'redis'; ref: RedisTabRef; path: string };

export type DetachedTarget =
  | { kind: 'grid'; projectId: string; tabId: string }
  | { kind: 'file'; fileId: string; projectId: string; name: string; reopen: DetachedReopen };

export interface DetachedWindow {
  id: string;
  target: DetachedTarget;
  /** The window's last normal bounds (screen coordinates) and the display it was on. */
  bounds?: Rect;
  displayId?: number;
  maximized?: boolean;
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= ID_MAX;
const isText = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= TEXT_MAX;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const DIFF_SOURCES = ['working', 'staged', 'commit', 'untracked'] as const;
type DiffSource = typeof DIFF_SOURCES[number];

function cleanRect(raw: unknown): Rect | undefined {
  if (!isRecord(raw) || !isNum(raw.x) || !isNum(raw.y) || !isNum(raw.width) || !isNum(raw.height)) return undefined;
  if (raw.width < 1 || raw.height < 1 || Math.abs(raw.x) > 1e6 || Math.abs(raw.y) > 1e6 || raw.width > 1e5 || raw.height > 1e5) return undefined;
  return { x: Math.round(raw.x), y: Math.round(raw.y), width: Math.round(raw.width), height: Math.round(raw.height) };
}

function cleanReopen(raw: unknown): DetachedReopen | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'project' && isId(raw.projectId) && isText(raw.relativePath)) return { kind: 'project', projectId: raw.projectId, relativePath: raw.relativePath };
  if (raw.kind === 'local' && isText(raw.path)) return { kind: 'local', path: raw.path };
  if (raw.kind === 'remote' && isUuid(raw.hostId) && validRemotePath(raw.path)) return { kind: 'remote', hostId: raw.hostId, path: raw.path };
  if (raw.kind === 'db' && validDbTabRef(raw.ref) && isText(raw.path)) return { kind: 'db', ref: raw.ref, path: raw.path };
  if (raw.kind === 'redis' && validRedisTabRef(raw.ref) && isText(raw.path)) return { kind: 'redis', ref: raw.ref, path: raw.path };
  if (raw.kind === 'diff' && isId(raw.projectId) && isRecord(raw.diff) && isText(raw.diff.path) && (DIFF_SOURCES as readonly unknown[]).includes(raw.diff.source)) {
    const d = raw.diff;
    return {
      kind: 'diff', projectId: raw.projectId,
      diff: {
        source: d.source as DiffSource, path: d.path as string,
        ...(isText(d.oldPath) ? { oldPath: d.oldPath } : {}), ...(isText(d.hash) ? { hash: d.hash } : {}), ...(isText(d.worktree) ? { worktree: d.worktree } : {}),
      },
    };
  }
  return undefined;
}

export function cleanTarget(raw: unknown): DetachedTarget | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'grid' && isId(raw.projectId) && isId(raw.tabId)) return { kind: 'grid', projectId: raw.projectId, tabId: raw.tabId };
  if (raw.kind === 'file' && isText(raw.fileId) && typeof raw.projectId === 'string' && raw.projectId.length <= ID_MAX && isText(raw.name)) {
    const reopen = cleanReopen(raw.reopen);
    if (reopen) return { kind: 'file', fileId: raw.fileId, projectId: raw.projectId, name: raw.name, reopen };
  }
  return undefined;
}

/** Where a grid lives: its project id, by tab id (open grids only). */
export function openGrids(projects: readonly Project[]): Map<string, string> {
  return new Map(projects.flatMap((p) => p.tabs.map((t) => [t.id, p.id] as [string, string])));
}

/**
 * The stored registry, repaired: known shapes only, one window per tab, grids that are still open (a grid that moved to another
 * project follows it), at most DETACHED_LIMIT. Absent or empty stays undefined.
 */
export function normalizeDetachedWindows(raw: unknown, grids: ReadonlyMap<string, string>): DetachedWindow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DetachedWindow[] = [];
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || !isId(item.id) || ids.has(item.id)) continue;
    let target = cleanTarget(item.target);
    if (!target) continue;
    if (target.kind === 'grid') {
      const projectId = grids.get(target.tabId);
      if (!projectId) continue;
      if (projectId !== target.projectId) target = { ...target, projectId };
    }
    const key = targetKey(target);
    if (targets.has(key)) continue;
    const bounds = cleanRect(item.bounds);
    out.push({ id: item.id, target, ...(bounds ? { bounds } : {}), ...(isNum(item.displayId) ? { displayId: item.displayId } : {}), ...(item.maximized === true ? { maximized: true } : {}) });
    ids.add(item.id);
    targets.add(key);
    if (out.length >= DETACHED_LIMIT) break;
  }
  return out.length ? out : undefined;
}

/** One key per tab: the strip key of the grid or file. */
export const targetKey = (t: DetachedTarget): string => (t.kind === 'grid' ? `grid:${t.tabId}` : `file:${t.fileId}`);

export const detachedList = (s: Pick<AppState, 'detachedWindows'>): readonly DetachedWindow[] => s.detachedWindows ?? [];

/** The ids of the grids that are in their own window. */
export function detachedGridIds(s: Pick<AppState, 'detachedWindows'>): Set<string> {
  return new Set(detachedList(s).flatMap((w) => (w.target.kind === 'grid' ? [w.target.tabId] : [])));
}

export function findDetached(s: Pick<AppState, 'detachedWindows'>, id: string): DetachedWindow | undefined {
  return detachedList(s).find((w) => w.id === id);
}

/** The window that shows a strip key ('grid:<id>' / 'file:<id>'), if it is detached. */
export function detachedByKey(s: Pick<AppState, 'detachedWindows'>, key: string): DetachedWindow | undefined {
  return detachedList(s).find((w) => targetKey(w.target) === key);
}

/** Adds a window (the same tab twice keeps the existing one); null when the limit is reached. */
export function addDetached(s: AppState, w: DetachedWindow): { state: AppState; window: DetachedWindow } | null {
  const existing = detachedByKey(s, targetKey(w.target));
  if (existing) return { state: s, window: existing };
  if (detachedList(s).length >= DETACHED_LIMIT) return null;
  return { state: { ...s, detachedWindows: [...detachedList(s), w] }, window: w };
}

export function removeDetached(s: AppState, id: string): AppState {
  const list = detachedList(s);
  if (!list.some((w) => w.id === id)) return s;
  const rest = list.filter((w) => w.id !== id);
  const next: AppState = { ...s, detachedWindows: rest };
  if (!rest.length) delete next.detachedWindows;
  return next;
}

/** The window moved or was resized (main follows it, debounced). Unchanged values keep the state's identity. */
export function setDetachedPlace(s: AppState, id: string, place: { bounds?: Rect; displayId?: number; maximized: boolean }): AppState {
  const list = detachedList(s);
  const w = list.find((x) => x.id === id);
  if (!w) return s;
  const next: DetachedWindow = { ...w, ...(place.bounds ? { bounds: place.bounds } : {}), ...(place.displayId !== undefined ? { displayId: place.displayId } : {}) };
  if (place.maximized) next.maximized = true; else delete next.maximized;
  if (JSON.stringify(next) === JSON.stringify(w)) return s;
  return { ...s, detachedWindows: list.map((x) => (x.id === id ? next : x)) };
}

/** Which detached window owns each cell of a detached grid; cells not listed belong to the main window. */
export function cellOwners(s: Pick<AppState, 'detachedWindows' | 'projects'>): Map<string, string> {
  const owners = new Map<string, string>();
  const byTab = new Map(detachedList(s).flatMap((w) => (w.target.kind === 'grid' ? [[w.target.tabId, w.id] as [string, string]] : [])));
  if (!byTab.size) return owners;
  for (const p of s.projects) for (const t of p.tabs) {
    const owner = byTab.get(t.id);
    if (owner) for (const c of t.cells) owners.set(c.id, owner);
  }
  return owners;
}

/** Does the window `windowId` (null: the main window) show the cell? Unknown cells belong to the main window. */
export function ownsCell(owners: ReadonlyMap<string, string>, windowId: string | null, cellId: string): boolean {
  return (owners.get(cellId) ?? null) === windowId;
}

/** The route changes between two owner maps: [cell id, new owner (null = main window)]. */
export function routeChanges(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  for (const [id, owner] of next) if (prev.get(id) !== owner) out.push([id, owner]);
  for (const id of prev.keys()) if (!next.has(id)) out.push([id, null]);
  return out;
}

/**
 * What a detached window's renderer shows as "active": its own project (and grid). All the code that acts on the active grid
 * (add a cell, maximize, move the focus) then acts on the detached one. The same fields are set before and after any edit,
 * so the overlay never travels to main (mergeStateEdit applies changed fields only).
 */
export function viewOverlay(s: AppState, target: DetachedTarget | null): AppState {
  if (!target) return s;
  const projectId = target.projectId;
  if (!projectId || !s.projects.some((p) => p.id === projectId)) return s;
  const tabId = target.kind === 'grid' ? target.tabId : null;
  const retab = tabId !== null && s.projects.some((p) => p.id === projectId && p.activeTabId !== tabId && p.tabs.some((t) => t.id === tabId));
  if (s.activeProjectId === projectId && !retab) return s;
  const projects = retab ? s.projects.map((p) => (p.id === projectId ? { ...p, activeTabId: tabId } : p)) : s.projects;
  return { ...s, activeProjectId: projectId, projects };
}

// ── where a window opens ─────────────────────────────────────────────────────

const area = (r: Rect) => r.width * r.height;
function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
const contains = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/** The rectangle moved and shrunk until it lies inside `bounds` (a window never opens partly off its display). */
export function clampRect(r: Rect, bounds: Rect): Rect {
  const width = Math.max(1, Math.min(r.width, bounds.width));
  const height = Math.max(1, Math.min(r.height, bounds.height));
  const x = Math.min(Math.max(r.x, bounds.x), bounds.x + bounds.width - width);
  const y = Math.min(Math.max(r.y, bounds.y), bounds.y + bounds.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function primaryOf(displays: readonly DisplayArea[], primaryId: number): DisplayArea | undefined {
  return displays.find((d) => d.id === primaryId) ?? displays[0];
}

/** The display a point lies on, else the one nearest to it, else the primary one. */
export function displayAt(displays: readonly DisplayArea[], p: { x: number; y: number }, primaryId: number): DisplayArea | undefined {
  const hit = displays.find((d) => contains(d.workArea, p));
  if (hit) return hit;
  let best: DisplayArea | undefined;
  let bestDist = Infinity;
  for (const d of displays) {
    const cx = Math.min(Math.max(p.x, d.workArea.x), d.workArea.x + d.workArea.width);
    const cy = Math.min(Math.max(p.y, d.workArea.y), d.workArea.y + d.workArea.height);
    const dist = (cx - p.x) ** 2 + (cy - p.y) ** 2;
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best ?? primaryOf(displays, primaryId);
}

function centered(size: { width: number; height: number }, on: Rect): Rect {
  return clampRect({ x: on.x + (on.width - size.width) / 2, y: on.y + (on.height - size.height) / 2, width: size.width, height: size.height }, on);
}

/**
 * The bounds a saved window reopens with: where it was while its title bar is still visible on a display (at least 100 px of
 * it), else centered on the primary display (the monitor it was on is gone or rearranged).
 */
export function restoreBounds(saved: Rect | undefined, displays: readonly DisplayArea[], primaryId: number, fallback: { width: number; height: number } = DETACHED_DEFAULT_SIZE): { bounds: Rect; displayId?: number } {
  const primary = primaryOf(displays, primaryId);
  const size = { width: Math.max(DETACHED_MIN_SIZE.width, saved?.width ?? fallback.width), height: Math.max(DETACHED_MIN_SIZE.height, saved?.height ?? fallback.height) };
  if (saved) {
    const title: Rect = { x: saved.x, y: saved.y, width: saved.width, height: DETACHED_TITLE_HEIGHT };
    let best: { d: DisplayArea; seen: number } | null = null;
    for (const d of displays) {
      const hit = intersect(title, d.workArea);
      if (hit && hit.width >= Math.min(100, saved.width) && (!best || area(hit) > best.seen)) best = { d, seen: area(hit) };
    }
    if (best) return { bounds: clampRect({ ...saved, ...size }, best.d.workArea), displayId: best.d.id };
  }
  if (!primary) return { bounds: { x: 80, y: 80, ...size } };
  return { bounds: centered(size, primary.workArea), displayId: primary.id };
}

/** A tab dropped outside the window: the new window's title bar comes under the pointer, on the display the pointer is on. */
export function boundsAtPoint(point: { x: number; y: number }, size: { width: number; height: number }, displays: readonly DisplayArea[], primaryId: number): { bounds: Rect; displayId?: number } {
  const d = displayAt(displays, point, primaryId);
  const want: Rect = { x: point.x - Math.min(160, size.width / 2), y: point.y - DETACHED_TITLE_HEIGHT / 2, width: size.width, height: size.height };
  return d ? { bounds: clampRect(want, d.workArea), displayId: d.id } : { bounds: want };
}

/**
 * "Move to a new window" from a menu: on another display when there is one (the point of a second monitor), centered there;
 * otherwise beside the main window, a little down and to the right.
 */
export function boundsBeside(main: Rect | null, size: { width: number; height: number }, displays: readonly DisplayArea[], primaryId: number): { bounds: Rect; displayId?: number } {
  const center = main ? { x: main.x + main.width / 2, y: main.y + main.height / 2 } : null;
  const home = center ? displayAt(displays, center, primaryId) : primaryOf(displays, primaryId);
  const other = displays.find((d) => d.id !== home?.id);
  if (other) return { bounds: centered(size, other.workArea), displayId: other.id };
  if (!home) return { bounds: { x: 80, y: 80, ...size } };
  const want = main ? { x: main.x + 48, y: main.y + 48, ...size } : { ...centered(size, home.workArea) };
  return { bounds: clampRect(want, home.workArea), displayId: home.id };
}

// ── which window hears what ──────────────────────────────────────────────────

/** Messages every window of the app needs (the state, the CLI and MCP status, a Pty Host restart, the quit). */
export const BROADCAST_CHANNELS: ReadonlySet<string> = new Set([
  'state:changed', 'cli:changed', 'mcp:info', 'ptyhost:crashed', 'ptyhost:fatal', 'app:before-quit', 'ssh:vault:changed',
  // 1.0.8: database, Redis and remote file tabs live in any window; each window shows the sessions and prompts of its own tabs.
  'db:session', 'db:prompt', 'db:hostCrashed', 'db:vault:changed', 'sftp:session', 'sftp:prompt', 'sftp:hostCrashed',
]);
/** Messages about one cell (its id is the first argument, or `cellId` of the first argument): they go to the window showing it. */
export const CELL_CHANNELS: ReadonlySet<string> = new Set([
  'cell:hook', 'cell:session', 'cell:context', 'cell:restarted', 'cell:spawnError', 'focus-cell', 'ssh:session', 'ssh:prompt',
]);

/** A message's receivers: null = the main window, '*' = every window, else a detached window's id. */
export function routeMessage(channel: string, args: readonly unknown[], owners: ReadonlyMap<string, string>): Array<{ window: string | null | '*'; args: unknown[] }> {
  if (BROADCAST_CHANNELS.has(channel)) return [{ window: '*', args: [...args] }];
  if (CELL_CHANNELS.has(channel)) {
    const first = args[0];
    const cellId = typeof first === 'string' ? first : isRecord(first) && typeof first.cellId === 'string' ? first.cellId : null;
    return [{ window: cellId === null ? null : owners.get(cellId) ?? null, args: [...args] }];
  }
  if (channel === 'automation:start-cells' && Array.isArray(args[0])) {
    const groups = new Map<string | null, string[]>();
    for (const id of args[0] as unknown[]) {
      if (typeof id !== 'string') continue;
      const owner = owners.get(id) ?? null;
      groups.set(owner, [...(groups.get(owner) ?? []), id]);
    }
    return [...groups].map(([window, ids]) => ({ window, args: [ids] }));
  }
  return [{ window: null, args: [...args] }];
}

/** The app-wide shortcuts that work in a detached window (no strip, no side panels, no new grids there). */
export const DETACHED_GRID_SHORTCUTS: ReadonlySet<string> = new Set([
  'agent.add', 'cell.maximize', 'cell.focus.left', 'cell.focus.right', 'cell.focus.up', 'cell.focus.down',
  'cell.move.left', 'cell.move.right', 'cell.move.up', 'cell.move.down', 'terminal.find', 'waiting.next', 'waiting.prev',
]);
/** 1.0.9: "next / previous waiting cell" works from any window (the main window picks the cell). */
export const DETACHED_FILE_SHORTCUTS: ReadonlySet<string> = new Set(['waiting.next', 'waiting.prev']);

/** The window's title: the tab's name and the app's. */
export function detachedTitle(s: Pick<AppState, 'projects'>, target: DetachedTarget): string {
  if (target.kind === 'file') return `${target.name} - unimux`;
  const project = s.projects.find((p) => p.id === target.projectId);
  const tab = project?.tabs.find((t) => t.id === target.tabId);
  return tab ? `${tab.name} - ${project!.name} - unimux` : 'unimux';
}

// -- what a moving tab takes along (1.0.8) ------------------------------------

/**
 * The runtime state of a database or Redis tab that travels with it to the other window (next to its document): the tab's
 * own state (rows, results; staged edits and the script live in the document), the sessions it keeps using and its unsaved
 * Redis values. `dbSessions`: the DB sessions whose Pub/Sub messages must follow the tab (main reroutes them).
 */
export interface TabHandoff { handoff: 'tab'; fileId: string; dbSessions: string[]; db?: unknown; redis?: unknown }

export const isTabHandoff = (x: unknown): x is TabHandoff => isRecord(x) && x.handoff === 'tab' && isText(x.fileId) && Array.isArray(x.dbSessions);

/** Documents and handoffs of a detach or attach, apart (only handoffs of documents that travel too). */
export function splitHandoffs(items: readonly unknown[]): { docs: unknown[]; handoffs: TabHandoff[] } {
  const docs = items.filter((x) => !isTabHandoff(x));
  const ids = new Set(docs.map((d) => (isRecord(d) && typeof d.id === 'string' ? d.id : null)));
  return { docs, handoffs: items.filter(isTabHandoff).filter((h) => ids.has(h.fileId)) };
}

/** The DB sessions the handoffs take along: valid session ids only, each once, at most 32. */
export function handoffSessions(handoffs: readonly TabHandoff[]): string[] {
  return [...new Set(handoffs.flatMap((h) => h.dbSessions.filter((id) => isDbSessionId(id))))].slice(0, 32);
}

// -- unsaved work of a detached window (1.0.8) --------------------------------

/** What a detached window holds that quitting would lose or end: open transactions, tables with staged edits, unsaved Redis values. */
export interface DetachedWork { tx: number; staged: number; redis: number }
export const NO_WORK: DetachedWork = { tx: 0, staged: 0, redis: 0 };
const workCount = (x: unknown): number => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? Math.min(x, 100_000) : 0);
export const hasWork = (w: DetachedWork): boolean => w.tx + w.staged + w.redis > 0;

/** A report from a window, repaired (null: nothing pending). */
export function cleanWork(raw: unknown): DetachedWork | null {
  if (!isRecord(raw)) return null;
  const work = { tx: workCount(raw.tx), staged: workCount(raw.staged), redis: workCount(raw.redis) };
  return hasWork(work) ? work : null;
}

export function sumWork(list: Iterable<DetachedWork>): DetachedWork {
  const out = { ...NO_WORK };
  for (const w of list) { out.tx += w.tx; out.staged += w.staged; out.redis += w.redis; }
  return out;
}

// -- tabs a detached window opens in the main window (1.0.8) ------------------

/** "Open in the SQL editor" of a DDL tab, the view switch of a Redis tab: the new tab opens in the main window, not in the detached one. */
export type OpenInMain =
  | { kind: 'sql'; connectionId: string; database: string; text: string }
  | { kind: 'redis'; connectionId: string; view: RedisTabView; db: number };

export function cleanOpenInMain(raw: unknown): OpenInMain | null {
  if (!isRecord(raw) || !isUuid(raw.connectionId)) return null;
  if (raw.kind === 'sql' && typeof raw.database === 'string' && raw.database.length <= DB_LIMITS.database && typeof raw.text === 'string' && raw.text.length <= DB_LIMITS.sql) {
    return { kind: 'sql', connectionId: raw.connectionId, database: raw.database, text: raw.text };
  }
  if (raw.kind === 'redis' && (REDIS_TAB_VIEWS as readonly unknown[]).includes(raw.view) && typeof raw.db === 'number' && Number.isInteger(raw.db) && raw.db >= 0 && raw.db <= 10_000) {
    return { kind: 'redis', connectionId: raw.connectionId, view: raw.view as RedisTabView, db: raw.db };
  }
  return null;
}
