// Pure helpers of the SFTP view (0.9.8): sorting, filtering and selecting entries, back/forward history, local path math
// (Windows drives or POSIX), the drag payload between the panes, sizes and the remembered folders in the app state.
// No DOM or Electron imports: tested in Node.
import type { MessageKey, MessageParams } from './i18n';
import {
  isFinished, planMove, posixNormalize, posixParent, symbolicMode, validRemotePath, type DeleteCount, type EntryKind, type TransferItem, type TransferRequest,
} from './sftp';

// ── entries ─────────────────────────────────────────────────────────────────

/** What both panes show of an entry (local and remote entries both fit). */
export interface PaneEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number;
  permissions: string;
  owner?: string;
  target?: 'file' | 'dir' | 'other';
  unsafeName?: true;
}

export type SortKey = 'name' | 'mtime' | 'size' | 'kind' | 'permissions' | 'owner';
export interface SortOrder { key: SortKey; desc: boolean }
export const DEFAULT_SORT: SortOrder = { key: 'name', desc: false };

/** A folder, or a link to one: opened by Enter and a double click, listed first. */
export const isFolderLike = (e: Pick<PaneEntry, 'kind' | 'target'>): boolean => e.kind === 'dir' || (e.kind === 'symlink' && e.target === 'dir');

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const extension = (name: string): string => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };

/** Folders first (in every order), then by the chosen column; ties by name. */
export function sortEntries<T extends PaneEntry>(entries: readonly T[], order: SortOrder): T[] {
  const sign = order.desc ? -1 : 1;
  const byName = (a: T, b: T) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const column = (a: T, b: T): number => {
    switch (order.key) {
      case 'mtime': return a.mtime - b.mtime;
      case 'size': return (isFolderLike(a) ? 0 : a.size) - (isFolderLike(b) ? 0 : b.size);
      case 'kind': return collator.compare(isFolderLike(a) ? '' : extension(a.name), isFolderLike(b) ? '' : extension(b.name));
      case 'permissions': return collator.compare(a.permissions, b.permissions);
      case 'owner': return collator.compare(a.owner ?? '', b.owner ?? '');
      default: return 0;
    }
  };
  return [...entries].sort((a, b) => {
    const folders = Number(isFolderLike(b)) - Number(isFolderLike(a));
    if (folders) return folders;
    return sign * (column(a, b) || byName(a, b));
  });
}

/** A click on a column header: the same column flips the direction, another one starts ascending. */
export const toggleSort = (current: SortOrder, key: SortKey): SortOrder => (current.key === key ? { key, desc: !current.desc } : { key, desc: false });

/** The filter field: entries whose name contains the text (case-insensitive); an empty text keeps everything. */
export function filterEntries<T extends Pick<PaneEntry, 'name'>>(entries: readonly T[], text: string): T[] {
  const needle = text.trim().toLocaleLowerCase();
  return needle ? entries.filter((e) => e.name.toLocaleLowerCase().includes(needle)) : [...entries];
}

/** The Kind column. */
export function kindLabel(e: Pick<PaneEntry, 'name' | 'kind' | 'target'>): { key: MessageKey; params?: MessageParams } {
  if (isFolderLike(e)) return { key: e.kind === 'symlink' ? 'Dowiązanie do folderu' : 'Folder' };
  if (e.kind === 'symlink') return { key: 'Dowiązanie' };
  if (e.kind === 'other') return { key: 'Inny' };
  const ext = extension(e.name);
  return ext && ext.length <= 12 ? { key: 'Plik {ext}', params: { ext: ext.toUpperCase() } } : { key: 'Plik' };
}

/** "12 B", "3,4 KB", "1,2 MB" ... in the UI language. */
export function formatBytes(bytes: number, language: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value)} ${units[unit]}`;
}

// ── selection ───────────────────────────────────────────────────────────────

/** Selected entries by path, the anchor of a Shift range and the focused row (keyboard). */
export interface Selection { paths: readonly string[]; anchor: string | null; focus: string | null }
export const EMPTY_SELECTION: Selection = { paths: [], anchor: null, focus: null };

function range(order: readonly string[], from: string | null, to: string): string[] {
  const a = from === null ? -1 : order.indexOf(from), b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** A click on a row: plain = only it, Ctrl/Cmd = toggle it, Shift = the range from the anchor (added to the rest with Ctrl). */
export function clickSelect(sel: Selection, order: readonly string[], path: string, mods: { shift?: boolean; toggle?: boolean } = {}): Selection {
  if (mods.shift) {
    const span = range(order, sel.anchor, path);
    const paths = mods.toggle ? [...new Set([...sel.paths, ...span])] : span;
    return { paths, anchor: sel.anchor ?? path, focus: path };
  }
  if (mods.toggle) {
    const paths = sel.paths.includes(path) ? sel.paths.filter((p) => p !== path) : [...sel.paths, path];
    return { paths, anchor: path, focus: path };
  }
  return { paths: [path], anchor: path, focus: path };
}

/** Arrow keys, Home/End and Page keys: the focus moves; with Shift the range from the anchor follows it. */
export function moveSelect(sel: Selection, order: readonly string[], move: number | 'home' | 'end', extend = false): Selection {
  if (!order.length) return EMPTY_SELECTION;
  const at = sel.focus === null ? -1 : order.indexOf(sel.focus);
  const target = move === 'home' ? 0 : move === 'end' ? order.length - 1
    : at < 0 ? (move > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + move));
  const path = order[target];
  if (extend) return { paths: range(order, sel.anchor ?? sel.focus ?? path, path), anchor: sel.anchor ?? sel.focus ?? path, focus: path };
  return { paths: [path], anchor: path, focus: path };
}

export const selectAll = (order: readonly string[]): Selection => ({ paths: [...order], anchor: order[0] ?? null, focus: order[order.length - 1] ?? null });

/** After a refresh or a filter change: only entries still shown stay selected. */
export function liveSelection(sel: Selection, order: readonly string[]): Selection {
  const shown = new Set(order);
  const paths = sel.paths.filter((p) => shown.has(p));
  if (paths.length === sel.paths.length && (sel.focus === null || shown.has(sel.focus)) && (sel.anchor === null || shown.has(sel.anchor))) return sel;
  return { paths, anchor: sel.anchor && shown.has(sel.anchor) ? sel.anchor : null, focus: sel.focus && shown.has(sel.focus) ? sel.focus : null };
}

// ── history ─────────────────────────────────────────────────────────────────

export interface NavHistory { back: readonly string[]; forward: readonly string[] }
export const EMPTY_HISTORY: NavHistory = { back: [], forward: [] };
const HISTORY_MAX = 50;

/** Going to a new folder from `from`: it joins the back list, the forward list is dropped. */
export function pushHistory(h: NavHistory, from: string | null, to: string): NavHistory {
  if (from === null || from === to) return h;
  return { back: [...h.back, from].slice(-HISTORY_MAX), forward: [] };
}

export function goBack(h: NavHistory, current: string): { path: string; history: NavHistory } | null {
  if (!h.back.length) return null;
  return { path: h.back[h.back.length - 1], history: { back: h.back.slice(0, -1), forward: [current, ...h.forward].slice(0, HISTORY_MAX) } };
}

export function goForward(h: NavHistory, current: string): { path: string; history: NavHistory } | null {
  if (!h.forward.length) return null;
  return { path: h.forward[0], history: { back: [...h.back, current].slice(-HISTORY_MAX), forward: h.forward.slice(1) } };
}

// ── local paths ─────────────────────────────────────────────────────────────

export type PathFlavor = 'win32' | 'posix';
/** The local pane on Windows can show the list of drives: this pseudo folder (never a real path). */
export const DRIVES = '';

const DRIVE_ROOT = /^[A-Za-z]:\\?$/;
const UNC_ROOT = /^\\\\[^\\]+\\[^\\]+\\?$/;

/** The folder above `path`; null at the top (POSIX "/"); a Windows drive root goes up to the drive list. */
export function localParent(path: string, flavor: PathFlavor): string | null {
  if (flavor === 'posix') return path === '/' || !path.startsWith('/') ? null : posixParent(path);
  if (path === DRIVES) return null;
  if (DRIVE_ROOT.test(path) || UNC_ROOT.test(path)) return DRIVES;
  const trimmed = path.replace(/\\+$/, '');
  const cut = trimmed.lastIndexOf('\\');
  if (cut < 0) return DRIVES;
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

export function localJoin(dir: string, name: string, flavor: PathFlavor): string {
  const sep = flavor === 'win32' ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function localBasename(path: string, flavor: PathFlavor): string {
  const trimmed = flavor === 'win32' ? path.replace(/\\+$/, '') : path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf(flavor === 'win32' ? '\\' : '/');
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

export interface Crumb { label: string; path: string }

/** The path bar: one crumb per folder ("C:" ... on Windows, "/" first on POSIX). */
export function localCrumbs(path: string, flavor: PathFlavor): Crumb[] {
  if (flavor === 'posix') return remoteCrumbs(path);
  if (path === DRIVES) return [];
  const out: Crumb[] = [];
  let at: string | null = path;
  while (at !== null && at !== DRIVES) {
    out.unshift({ label: DRIVE_ROOT.test(at) ? at.replace(/\\$/, '') : localBasename(at, flavor) || at, path: at });
    at = localParent(at, flavor);
  }
  return out;
}

export function remoteCrumbs(path: string): Crumb[] {
  const n = posixNormalize(path);
  const out: Crumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of n.split('/').filter(Boolean)) { acc += `/${part}`; out.push({ label: part, path: acc }); }
  return out;
}

const localKey = (p: string, flavor: PathFlavor): string => {
  const t = flavor === 'win32' ? p.replace(/[\\/]+$/, '') : p.replace(/\/+$/, '');
  return flavor === 'win32' ? t.toLowerCase() : t || '/';
};

/** `child` is `parent` or inside it (local paths; Windows case-insensitive). */
export function localContains(parent: string, child: string, flavor: PathFlavor): boolean {
  const p = localKey(parent, flavor), c = localKey(child, flavor);
  if (c === p) return true;
  const sep = flavor === 'win32' ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

/** planMove (shared/sftp.ts) for local paths: entries already in `targetDir` are left out, a folder into itself is refused. */
export const planLocalMove = (sources: readonly string[], targetDir: string, flavor: PathFlavor) =>
  planMove(sources, targetDir, {
    contains: (a, b) => localContains(a, b, flavor),
    dirname: (p) => localParent(p, flavor) ?? '',
    same: (a, b) => localKey(a, flavor) === localKey(b, flavor),
  });

/** An absolute local path the app may remember (no control characters). */
export function validLocalPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/[\u0000-\u001f]/.test(path)
    && (path.startsWith('/') || /^[A-Za-z]:\\/.test(path) || path.startsWith('\\\\'));
}

// ── drag between the panes ──────────────────────────────────────────────────

export const SFTP_DRAG_MIME = 'application/x-unimux-sftp';
export interface SftpDragPayload { side: 'local' | 'remote'; paths: string[] }
/** A drag started in one of the panes of this window. Only its nonce travels in the drag data. */
export interface ActiveDrag extends SftpDragPayload { nonce: string }

/**
 * The entries a drop of SFTP_DRAG_MIME data carries. The data is never trusted: other apps (a web page in a browser) can put
 * any text under this type, so only the nonce of the drag that started in this window counts, and the paths come from that
 * drag. A drop onto the pane the drag started in carries nothing.
 */
export function resolveDrop(active: ActiveDrag | null, raw: string, onto: 'local' | 'remote'): SftpDragPayload | null {
  if (!active || !raw || raw !== active.nonce || active.side === onto || !active.paths.length) return null;
  return { side: active.side, paths: [...active.paths] };
}

/**
 * The entries of an in-app drag dropped onto a folder of the pane it started in (0.9.9: a move). Like resolveDrop only the
 * nonce of the drag that started in this window counts; null for a drag from the other pane or without a matching nonce.
 */
export function resolveMove(active: ActiveDrag | null, raw: string, onto: 'local' | 'remote'): string[] | null {
  if (!active || !raw || raw !== active.nonce || active.side !== onto || !active.paths.length) return null;
  return [...active.paths];
}

/**
 * Files dropped from Explorer/Finder onto the local pane: the ones already in `targetDir` are left out (a copy onto itself
 * would be a conflict with itself).
 */
export function outsideFolder(paths: readonly string[], targetDir: string, flavor: PathFlavor): string[] {
  const key = (p: string) => { const t = flavor === 'win32' ? p.replace(/[\\/]+$/, '') : p.replace(/\/+$/, ''); return flavor === 'win32' ? t.toLowerCase() : t || '/'; };
  const dir = key(targetDir);
  return paths.filter((p) => { const parent = localParent(p, flavor); return parent === null || key(parent) !== dir; });
}

/**
 * What a drop does: local entries onto the remote pane upload, remote entries onto the local pane download; a drop onto the
 * pane it came from is no transfer (null). `targetDir` is the folder under the pointer or the pane's folder.
 */
export function dropRequest(payload: SftpDragPayload, onto: 'local' | 'remote', targetDir: string): TransferRequest | null {
  if (payload.side === onto) return null;
  return { direction: onto === 'remote' ? 'upload' : 'download', sources: payload.paths, targetDir };
}

// ── transfers ───────────────────────────────────────────────────────────────

export const percentOf = (i: Pick<TransferItem, 'bytesDone' | 'bytesTotal' | 'state'>): number =>
  i.state === 'done' ? 100 : i.bytesTotal > 0 ? Math.min(100, Math.floor((i.bytesDone / i.bytesTotal) * 100)) : 0;

/**
 * A port snapshot after an SFTP Host restart has an empty queue: the items failed by the crash stay in the list (with Retry)
 * until cleared. Everything else comes from the snapshot.
 */
export function mergeSnapshot(local: readonly TransferItem[], snapshot: readonly TransferItem[]): TransferItem[] {
  const known = new Set(snapshot.map((i) => i.id));
  return [...local.filter((i) => i.error === 'sftpHostCrashed' && !known.has(i.id)), ...snapshot];
}

/** A retry of an item whose queue died with the SFTP Host: a new enqueue of the same source into the same folder. */
export function reenqueueRequest(item: Pick<TransferItem, 'direction' | 'source' | 'target'>, flavor: PathFlavor): TransferRequest {
  const targetDir = item.direction === 'upload' || item.direction === 'move' ? posixParent(item.target) : localParent(item.target, flavor) ?? item.target;
  return { direction: item.direction, sources: [item.source], targetDir };
}

/** Entries a folder transfer leaves out for good (unsafe names, links): a retry would only be refused again. */
const FINAL_ERRORS = new Set(['invalidName', 'linkOutside', 'linkFolder', 'unsupported', 'tooMany']);
export const canRetry = (i: Pick<TransferItem, 'state' | 'error'>): boolean => (i.state === 'failed' || i.state === 'cancelled') && !FINAL_ERRORS.has(i.error ?? '');
export const canCancel = (i: Pick<TransferItem, 'state'>): boolean => !isFinished(i.state);

// ── permissions dialog ──────────────────────────────────────────────────────

/** The rwx grid: owner, group, others x read, write, execute (bits). */
export const PERM_GRID: ReadonlyArray<{ who: 'owner' | 'group' | 'others'; bits: readonly [number, number, number] }> = [
  { who: 'owner', bits: [0o400, 0o200, 0o100] },
  { who: 'group', bits: [0o040, 0o020, 0o010] },
  { who: 'others', bits: [0o004, 0o002, 0o001] },
];
export const SPECIAL_BITS: readonly number[] = [0o4000, 0o2000, 0o1000];

/** "rwxr-xr-x" where a bit outside `mask` (differs in the selection, stays as it is) reads "?". */
export function symbolicPreview(bits: number, mask: number): string {
  const s = symbolicMode(bits).split('');
  const at: Array<[number, number]> = [[0, 0o400], [1, 0o200], [3, 0o040], [4, 0o020], [6, 0o004], [7, 0o002]];
  for (const [i, b] of at) if (!(mask & b)) s[i] = '?';
  // The x places also carry setuid / setgid / sticky.
  for (const [i, x, special] of [[2, 0o100, 0o4000], [5, 0o010, 0o2000], [8, 0o001, 0o1000]] as const) if (!(mask & x) || !(mask & special)) s[i] = '?';
  return s.join('');
}

/** A checkbox of the grid clicked: the bit becomes defined (in `mask`) and flips (an indeterminate one turns on). */
export function toggleModeBit(state: { bits: number; mask: number }, bit: number): { bits: number; mask: number } {
  const on = (state.mask & bit) !== 0 && (state.bits & bit) !== 0;
  return { bits: on ? state.bits & ~bit : state.bits | bit, mask: state.mask | bit };
}

// ── delete confirmation ─────────────────────────────────────────────────────

/** The names listed in the delete question (at most `max`, then "and n more"). */
export function deleteNames(names: readonly string[], max = 5): { shown: string[]; more: number } {
  return { shown: names.slice(0, max), more: Math.max(0, names.length - max) };
}

/** What a recursive delete removes, for the question ("Plików: 3, folderów: 1"). */
export const deleteCountText = (count: DeleteCount): { key: MessageKey; params: MessageParams } =>
  ({ key: 'Plików: {files}, folderów: {dirs}', params: { files: count.files, dirs: count.dirs } });

// ── remembered folders (app state) ──────────────────────────────────────────

/** The last local folder and, per saved host, the last remote folder (no secrets). */
export interface SftpPlaces { localPath?: string; remotePaths: Record<string, string> }
export const MAX_REMOTE_PLACES = 200;
export const defaultSftpPlaces = (): SftpPlaces => ({ remotePaths: {} });

const HOST_ID = /^[\w-]{1,64}$/;

export function normalizeSftpPlaces(raw: unknown): SftpPlaces {
  const out = defaultSftpPlaces();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (validLocalPath(r.localPath)) out.localPath = r.localPath;
  const remote = r.remotePaths;
  if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
    const kept = Object.entries(remote as Record<string, unknown>)
      .filter((e): e is [string, string] => HOST_ID.test(e[0]) && e[0] !== '__proto__' && validRemotePath(e[1]))
      .slice(-MAX_REMOTE_PLACES);
    for (const [id, path] of kept) out.remotePaths[id] = posixNormalize(path);
  }
  return out;
}

export function rememberLocalPath(places: SftpPlaces, path: string): SftpPlaces {
  return validLocalPath(path) && places.localPath !== path ? { ...places, localPath: path } : places;
}

/** The newest host goes last, so the cap drops the hosts used longest ago. */
export function rememberRemotePath(places: SftpPlaces, hostId: string, path: string): SftpPlaces {
  if (!HOST_ID.test(hostId) || !validRemotePath(path)) return places;
  const n = posixNormalize(path);
  const keys = Object.keys(places.remotePaths);
  if (places.remotePaths[hostId] === n && keys[keys.length - 1] === hostId) return places;
  const { [hostId]: _old, ...rest } = places.remotePaths;
  const entries = [...Object.entries(rest), [hostId, n] as [string, string]].slice(-MAX_REMOTE_PLACES);
  return { ...places, remotePaths: Object.fromEntries(entries) };
}

export function forgetRemotePlace(places: SftpPlaces, hostId: string): SftpPlaces {
  if (!(hostId in places.remotePaths)) return places;
  const { [hostId]: _gone, ...rest } = places.remotePaths;
  return { ...places, remotePaths: rest };
}
