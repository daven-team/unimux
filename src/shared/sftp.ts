// The SFTP contract (0.9.8): sessions, remote and local entries, the transfer queue, the APIs the SFTP view uses, and pure
// helpers for POSIX remote paths, "keep both" names, permission strings and part files. No Node or Electron imports.
import type { Localized } from './ssh';
import type { SshErrorCode, SshPhase, SshPrompt } from './ssh';
import type { EditorRead, EditorSave, FileStamp } from './editorSource';
import type { ProjectFilePreview } from './types';

// ── sessions ────────────────────────────────────────────────────────────────

/** SFTP session ids live in their own namespace next to cell ids: "sftp:<uuid>". */
export const SFTP_SESSION_PREFIX = 'sftp:';
/** The queue of copies from the OS into a local folder (no connection needed). */
export const LOCAL_QUEUE_ID = 'local';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID = new RegExp(`^sftp:${UUID}$`, 'i');
export const sftpSessionId = (uuid: string): string => `${SFTP_SESSION_PREFIX}${uuid}`;
export const isSftpSessionId = (id: unknown): id is string => typeof id === 'string' && SESSION_ID.test(id);

export type SftpSessionStatus = 'connecting' | 'connected' | 'error' | 'closed';
/** Session errors: the SSH login ones plus the SFTP host's own. */
export type SftpSessionError = SshErrorCode;

export interface SftpSessionState {
  id: string;
  hostId: string;
  state: SftpSessionStatus;
  /** The SSH phase behind `state` (connecting / verifying / authenticating ...), for a finer label. */
  phase: SshPhase;
  since: number;
  error?: SftpSessionError;
  /** The folder the session started in (realpath of the asked folder, else of the login folder); set once connected. */
  path?: string;
}

export const sftpStatusOf = (phase: SshPhase): SftpSessionStatus =>
  phase === 'connected' ? 'connected' : phase === 'error' ? 'error' : phase === 'closed' || phase === 'idle' ? 'closed' : 'connecting';

export type SftpPromptAnswer =
  | { sessionId: string; promptId: string; cancel: true }
  | { sessionId: string; promptId: string; values: string[]; remember?: boolean }
  | { sessionId: string; promptId: string; hostKey: 'once' | 'save' | 'replace' };

export interface SftpSnapshot { sessions: SftpSessionState[]; prompts: Array<{ sessionId: string; prompt: SshPrompt }> }

// ── entries ─────────────────────────────────────────────────────────────────

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other';

export interface SftpEntry {
  name: string;
  /** Absolute POSIX path. */
  path: string;
  kind: EntryKind;
  size: number;
  /** Modification time in ms (0 when the server did not tell). */
  mtime: number;
  /** "drwxr-xr-x" */
  permissions: string;
  owner?: string;
  group?: string;
  /** For a symlink: what it points to ('other' when broken or unknown). */
  target?: 'file' | 'dir' | 'other';
  /** The server sent a name that cannot be used safely (it contains "\" or the like): shown, but never opened or transferred. */
  unsafeName?: true;
}

export interface LocalEntry {
  name: string;
  /** Absolute local path (Windows separators on Windows). */
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number;
  /** "-rw-r--r--" on macOS and Linux; empty on Windows. */
  permissions: string;
  /** A dotfile (the Windows hidden attribute is not read: it would cost a call per entry). */
  hidden: boolean;
  /** For a symlink or junction: what it points to. */
  target?: 'file' | 'dir' | 'other';
}

// ── errors ──────────────────────────────────────────────────────────────────

export type SftpErrorCode =
  | 'notFound' | 'exists' | 'permission' | 'notEmpty' | 'notADirectory' | 'isADirectory' | 'noSpace'
  | 'invalid' | 'noSession' | 'notConnected' | 'changed' | 'cancelled' | 'connectionLost' | 'sftpHostCrashed'
  | 'unsupported' | 'tooMany' | 'invalidName' | 'linkOutside' | 'linkFolder' | 'failed';

export type SftpResult<T> = { ok: true; value: T } | { ok: false; error: SftpErrorCode };

export function sftpErrorText(code: SftpErrorCode): Localized {
  switch (code) {
    case 'notFound': return { key: 'Plik lub folder nie istnieje' };
    case 'exists': return { key: 'Element o tej nazwie już istnieje' };
    case 'permission': return { key: 'Brak uprawnień' };
    case 'notEmpty': return { key: 'Folder nie jest pusty' };
    case 'notADirectory': return { key: 'To nie jest folder' };
    case 'isADirectory': return { key: 'W miejscu docelowym jest folder' };
    case 'noSpace': return { key: 'Brak miejsca na dysku' };
    case 'invalid': return { key: 'Nieprawidłowa ścieżka lub nazwa' };
    case 'noSession':
    case 'notConnected': return { key: 'Brak połączenia SFTP' };
    case 'changed': return { key: 'Zawartość zmieniła się od potwierdzenia - sprawdź ponownie' };
    case 'cancelled': return { key: 'Anulowano' };
    case 'connectionLost': return { key: 'Połączenie zostało przerwane' };
    case 'sftpHostCrashed': return { key: 'Proces SFTP został uruchomiony ponownie' };
    case 'unsupported': return { key: 'Serwer nie obsługuje tej operacji' };
    case 'tooMany': return { key: 'Za dużo elementów naraz' };
    case 'invalidName': return { key: 'Nazwa, której nie można bezpiecznie zapisać w tym miejscu' };
    case 'linkFolder': return { key: 'Dowiązania do folderów nie są kopiowane' };
    case 'linkOutside': return { key: 'Dowiązanie wskazuje poza wybrany folder - pominięto' };
    default: return { key: 'Operacja nie powiodła się' };
  }
}

// ── transfers ───────────────────────────────────────────────────────────────

export type TransferDirection = 'upload' | 'download' | 'local-copy';
export type TransferState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'conflict';
export type ConflictChoice = 'overwrite' | 'skip' | 'keepBoth';
export interface ConflictAnswer { choice: ConflictChoice; applyToRest: boolean }

export interface TransferConflict {
  /** The final path that already exists. */
  target: string;
  existing: { kind: EntryKind; size: number; mtime: number };
  incoming: { size: number; mtime: number };
}

export interface TransferItem {
  id: string;
  /** One enqueue call (the "apply to rest" scope and the unit of a batch cancel). */
  batchId: string;
  /** "sftp:<uuid>", or LOCAL_QUEUE_ID for local copies. */
  sessionId: string;
  direction: TransferDirection;
  /** Absolute source path (local for upload/local-copy, POSIX remote for download). */
  source: string;
  /** Absolute final target path (changes to "name (1).ext" after a keep-both answer). */
  target: string;
  /** File name shown in the queue (relative to the dropped folder for files inside one). */
  name: string;
  bytesDone: number;
  bytesTotal: number;
  /** Bytes per second over the last few seconds (0 when not running). */
  speed: number;
  state: TransferState;
  error?: SftpErrorCode;
  /** Finished because the user chose Skip on a conflict. */
  skipped?: boolean;
  conflict?: TransferConflict;
  startedAt?: number;
  endedAt?: number;
}

export interface TransferRequest {
  direction: TransferDirection;
  /** Absolute paths (local for upload/local-copy, remote for download); folders transfer recursively. */
  sources: string[];
  /** Absolute folder the sources go into. */
  targetDir: string;
  /** Answer every conflict of this batch up front (no question). */
  policy?: ConflictChoice;
  /** A uuid chosen by the view: `cancel({ batchId })` then also stops the folder walk before enqueue answered. */
  batchId?: string;
}

/** Messages on the transfer port (SFTP host -> renderer, transferred as 'mc:sftp-port'). */
export type SftpPortMessage =
  /** Everything the host knows, sent when the port is attached (also after a renderer reload). */
  | { t: 'snapshot'; items: TransferItem[] }
  /** Changed items (full objects). Progress of a running item comes at most ~10 times a second. */
  | { t: 'items'; items: TransferItem[] }
  | { t: 'removed'; ids: string[] };

/** Applies one port message to a renderer-side list (order kept: enqueue order). */
export function applyPortMessage(items: readonly TransferItem[], m: SftpPortMessage): TransferItem[] {
  if (m.t === 'snapshot') return [...m.items];
  if (m.t === 'removed') { const gone = new Set(m.ids); return items.filter((i) => !gone.has(i.id)); }
  const changed = new Map(m.items.map((i) => [i.id, i]));
  const next = items.map((i) => changed.get(i.id) ?? i);
  const known = new Set(items.map((i) => i.id));
  for (const i of m.items) if (!known.has(i.id)) next.push(i);
  return next;
}

/** After the SFTP host restarted its queue is gone: what was not finished counts as failed (the view offers a new enqueue). */
export const failUnfinished = (items: readonly TransferItem[], now: number): TransferItem[] =>
  items.map((i) => (isFinished(i.state) ? i : { ...i, state: 'failed', error: 'sftpHostCrashed', speed: 0, endedAt: now, conflict: undefined }));

export const isFinished = (state: TransferState): boolean => state === 'done' || state === 'failed' || state === 'cancelled';
export const isActive = (state: TransferState): boolean => !isFinished(state);

/** Overall progress of a list (finished and cancelled items count as complete, skipped ones too). */
export function overallProgress(items: readonly TransferItem[]): { done: number; total: number; files: number; finished: number } {
  let done = 0, total = 0, finished = 0;
  for (const i of items) {
    total += i.bytesTotal;
    done += isFinished(i.state) ? i.bytesTotal : Math.min(i.bytesDone, i.bytesTotal);
    if (isFinished(i.state)) finished++;
  }
  return { done, total, files: items.length, finished };
}

// ── limits ──────────────────────────────────────────────────────────────────

export const SFTP_LIMITS = {
  path: 4096,
  name: 255,
  /** Paths in one delete / enqueue call. */
  paths: 1000,
  /** Entries returned by one listing. */
  listEntries: 20_000,
  /** Files one enqueue may expand to (recursive folders). */
  batchFiles: 50_000,
  /** Files moving at the same time per session. */
  concurrentFiles: 3,
  /** Progress events per running item per second (about). */
  progressPerSecond: 10,
  /** Idle disconnect after the view closed and the queue is empty. */
  idleDisconnectMs: 2 * 60_000,
} as const;

// ── POSIX remote paths ──────────────────────────────────────────────────────

/** Resolves "." and "..", collapses slashes; never produces a Windows separator. Relative input stays relative. */
export function posixNormalize(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!absolute) out.push('..'); continue; }
    out.push(part);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

/** Joins remote path parts with "/" (a later absolute part restarts the path, like path.posix.join would not). */
export function posixJoin(...parts: string[]): string {
  let acc = '';
  for (const part of parts) {
    if (!part) continue;
    acc = part.startsWith('/') || !acc ? part : `${acc.replace(/\/+$/, '')}/${part}`;
  }
  return posixNormalize(acc || '.');
}

/** "/a/b" -> "/a", "/a" -> "/", "/" -> "/". */
export function posixParent(path: string): string {
  const n = posixNormalize(path);
  if (n === '/' || !n.includes('/')) return n.startsWith('/') ? '/' : '.';
  const cut = n.slice(0, n.lastIndexOf('/'));
  return cut || '/';
}

export function posixBasename(path: string): string {
  const n = posixNormalize(path);
  return n === '/' ? '' : n.slice(n.lastIndexOf('/') + 1);
}

/** True when `child` is `parent` itself or inside it (both normalized, absolute). */
export function posixContains(parent: string, child: string): boolean {
  const p = posixNormalize(parent), c = posixNormalize(child);
  return c === p || c.startsWith(p === '/' ? '/' : `${p}/`);
}

/** An absolute POSIX path the host may be asked about. */
export function validRemotePath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && path.length <= SFTP_LIMITS.path && !/[\0\r\n]/.test(path) && !path.includes('\\');
}

/** One remote name (no separator, not "." or ".."). Backslashes are allowed: they are ordinary characters on POSIX. */
export function validRemoteName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= SFTP_LIMITS.name && name !== '.' && name !== '..' && !/[\/\0]/.test(name);
}

// ── names ───────────────────────────────────────────────────────────────────

const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A single entry name that is safe to join onto a folder path: never empty, ".", "..", and never containing "/", "\" or NUL
 * (a name from a server is never trusted: "../x" would leave the chosen folder). With `windows` (the name becomes a local
 * Windows path) also no ":" (drive letters, alternate data streams), no <>"|?* or control characters, no reserved device
 * name (CON, NUL, COM1 ...) and no trailing dot or space.
 */
export function safeEntryName(name: unknown, opts: { windows?: boolean } = {}): name is string {
  if (typeof name !== 'string' || !name || name.length > SFTP_LIMITS.name || name === '.' || name === '..') return false;
  if (/[\/\\\0]/.test(name)) return false;
  if (opts.windows) {
    if (/[:<>"|?*\x00-\x1f]/.test(name)) return false;
    if (/[. ]$/.test(name)) return false;
    if (WINDOWS_DEVICE.test(name)) return false;
  }
  return true;
}

export const PART_SUFFIX = '.unimux-part';
/** The temporary name a file is written under until it is complete. */
export const partName = (name: string): string => `${name}${PART_SUFFIX}`;
export const isPartName = (name: string): boolean => name.endsWith(PART_SUFFIX) && name.length > PART_SUFFIX.length;

/**
 * "report.pdf" -> "report (1).pdf", then "(2)" ... skipping every name in `existing`. A trailing " (n)" is replaced, not
 * stacked. Folders and dotfiles without another dot keep their whole name as the stem; "a.tar.gz" keeps ".gz" as the extension.
 */
export function keepBothName(name: string, existing: Iterable<string>, opts: { directory?: boolean; caseInsensitive?: boolean } = {}): string {
  const fold = (s: string) => (opts.caseInsensitive ? s.toLowerCase() : s);
  const taken = new Set([...existing].map(fold));
  const dot = opts.directory ? -1 : name.lastIndexOf('.');
  const hasExt = dot > 0;
  const stem = (hasExt ? name.slice(0, dot) : name).replace(/ \(\d+\)$/, '');
  const ext = hasExt ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(fold(candidate)) && !taken.has(fold(partName(candidate)))) return candidate;
  }
}

// ── modes ───────────────────────────────────────────────────────────────────

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

export function kindFromMode(mode: number | undefined): EntryKind {
  switch ((mode ?? 0) & S_IFMT) {
    case S_IFDIR: return 'dir';
    case S_IFREG: return 'file';
    case S_IFLNK: return 'symlink';
    default: return 'other';
  }
}

const TYPE_CHAR: Record<number, string> = { 0o140000: 's', 0o120000: 'l', 0o100000: '-', 0o060000: 'b', 0o040000: 'd', 0o020000: 'c', 0o010000: 'p' };

/** Mode bits -> "drwxr-xr-x" (setuid/setgid/sticky as s/S and t/T, like ls). */
export function permissionString(mode: number | undefined): string {
  if (mode === undefined || mode === null || !Number.isFinite(mode)) return '';
  const m = mode;
  const type = TYPE_CHAR[m & S_IFMT] ?? '-';
  const triplet = (r: number, w: number, x: number, special: number, on: string, off: string) =>
    `${m & r ? 'r' : '-'}${m & w ? 'w' : '-'}${m & special ? (m & x ? on : off) : m & x ? 'x' : '-'}`;
  return type
    + triplet(0o400, 0o200, 0o100, 0o4000, 's', 'S')
    + triplet(0o040, 0o020, 0o010, 0o2000, 's', 'S')
    + triplet(0o004, 0o002, 0o001, 0o1000, 't', 'T');
}

/** Owner and group from an `ls -l` style longname ("-rw-r--r--  1 alice staff 12 Jan 1 00:00 a.txt"), when the server sent one. */
export function ownerFromLongname(longname: string | undefined): { owner?: string; group?: string } {
  if (!longname) return {};
  const parts = longname.trim().split(/\s+/);
  if (parts.length < 5 || !/^[-dlcbps][-rwxsStT]{9}/.test(parts[0])) return {};
  return { owner: parts[2], group: parts[3] };
}

// ── APIs ────────────────────────────────────────────────────────────────────

export interface DeleteCount { files: number; dirs: number }

/** `window.mc.sftp` (src/preload). Every call is validated in src/main/sftp/ipc.ts. */
export interface SftpApi {
  /** Starts a login with the saved host data; follow 'sftp:session' / 'sftp:prompt' for the outcome. */
  connect(hostId: string, initialPath?: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: SshErrorCode }>;
  disconnect(sessionId: string): Promise<{ ok: boolean }>;
  sessions(): Promise<SftpSnapshot>;
  answer(answer: SftpPromptAnswer): Promise<{ ok: boolean }>;
  list(sessionId: string, path: string): Promise<SftpResult<{ path: string; entries: SftpEntry[]; truncated: boolean }>>;
  stat(sessionId: string, path: string): Promise<SftpResult<SftpEntry>>;
  realpath(sessionId: string, path: string): Promise<SftpResult<string>>;
  mkdir(sessionId: string, path: string): Promise<SftpResult<null>>;
  /** Never overwrites: an existing target answers 'exists'. */
  rename(sessionId: string, from: string, to: string): Promise<SftpResult<null>>;
  /** What a delete of `paths` would remove (folders recursively): show it in the confirmation. */
  deleteCount(sessionId: string, paths: string[]): Promise<SftpResult<DeleteCount>>;
  /** Deletes only when the count is still the confirmed one ('changed' otherwise). */
  delete(sessionId: string, paths: string[], confirmed: DeleteCount): Promise<SftpResult<null>>;
  /** `sessionId` null for 'local-copy' (OS drops onto the local pane). Items show up on the transfer port. */
  enqueue(sessionId: string | null, req: TransferRequest): Promise<SftpResult<{ batchId: string }>>;
  cancel(sessionId: string | null, target: { itemIds?: string[]; batchId?: string }): Promise<{ ok: boolean }>;
  answerConflict(sessionId: string | null, itemId: string, answer: ConflictAnswer): Promise<{ ok: boolean }>;
  retry(sessionId: string | null, itemIds: string[]): Promise<{ ok: boolean }>;
  /** Drops finished items (done, failed, cancelled) from the queue. */
  clearFinished(sessionId: string | null): Promise<{ ok: boolean }>;
  /** A remote file for an editor tab (0.9.9): text, an image preview, or binary / too large (offer a download). */
  readFile(sessionId: string, path: string): Promise<SftpResult<EditorRead>>;
  /** Saves an editor tab through a part file; 'changed' when the server file is not the one the tab was opened from. */
  writeFile(sessionId: string, path: string, save: EditorSave): Promise<SftpResult<{ stamp: FileStamp }>>;
  /** Hosts of editor tabs with unsaved changes: their sessions are kept while the view is closed. */
  pinHosts(hostIds: string[]): void;
  /** The SFTP view became visible / was closed (idle disconnect 2 minutes after close with an empty queue). */
  viewOpened(): void;
  viewClosed(): void;
}

export type LocalErrorCode = 'notFound' | 'exists' | 'permission' | 'notEmpty' | 'notADirectory' | 'invalid' | 'tooMany' | 'failed';
export type LocalResult<T> = { ok: true; value: T } | { ok: false; error: LocalErrorCode };

/** `window.mc.localFs` (src/preload): any folder the user browses, validated and guarded in src/main/localFiles.ts. */
export interface LocalFilesApi {
  list(path: string): Promise<LocalResult<{ path: string; entries: LocalEntry[]; truncated: boolean }>>;
  /** Home folder, and the drives on Windows ("C:\\", "D:\\" ...; empty elsewhere). */
  roots(): Promise<{ home: string; drives: string[] }>;
  mkdir(path: string): Promise<LocalResult<null>>;
  /** Never overwrites. */
  rename(from: string, to: string): Promise<LocalResult<null>>;
  /** To the OS trash (Recycle Bin / Trash). */
  trash(paths: string[]): Promise<LocalResult<null>>;
  /** Opens a folder in Explorer/Finder, or shows a file selected in its folder. */
  reveal(path: string): Promise<LocalResult<null>>;
  /** A local file outside the projects in an editor tab (0.9.9): the same reads and safe saves as a project file. */
  readFile(path: string): Promise<ProjectFilePreview>;
  statFile(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  writeFile(path: string, text: string, expectedText: string): Promise<{ ok: true } | { ok: false; error: string; code?: 'conflict' }>;
}
