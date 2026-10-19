// Editor tabs of files outside projects (0.9.9): a remote file of a saved SSH host (opened from the SFTP view) and a local file
// from the SFTP view's local pane. Pure helpers shared by the renderer, main and the SFTP Host: tab ids (also the keys of the
// unsaved drafts: host + path, never a session or a secret), what opening a remote file does by its size and name, the stamp
// comparison of a save, and text decoding / encoding that keeps a file's encoding, BOM and line endings.

/** Where an editor tab's text comes from when it is not a project file. */
export type FileSource =
  | { kind: 'remote'; hostId: string; path: string }
  | { kind: 'local'; path: string };

export type TextEncodingName = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';
export const TEXT_ENCODINGS: readonly TextEncodingName[] = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'];

/** Size and modification time (ms) of a file: a remote save goes ahead only while they are what the tab was opened from. */
export interface FileStamp { size: number; mtimeMs: number }

/** Remote text files up to this size open editable (the editor's large-file limit); bigger ones offer a download. */
export const EDITOR_TEXT_BYTES = 8 * 1024 * 1024;
/** Remote images up to this size open as a preview. */
export const EDITOR_IMAGE_BYTES = 20 * 1024 * 1024;

export const IMAGE_MIME: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };

const extensionOf = (name: string): string => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };
const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

/** The tab id of a source (the same remote or local file opened twice is one tab, also across restarts). */
export function sourceDocumentId(source: FileSource): string {
  return source.kind === 'remote' ? JSON.stringify(['sftp', source.hostId, source.path]) : JSON.stringify(['local', source.path]);
}

export function validSource(value: unknown): value is FileSource {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'remote') return typeof v.hostId === 'string' && !!v.hostId && typeof v.path === 'string' && v.path.startsWith('/');
  if (v.kind === 'local') return typeof v.path === 'string' && v.path.length > 0;
  return false;
}

/** An SFTP pane entry that opens in an editor tab: a file, or a link to one. */
export const isFileLike = (e: { kind: string; target?: string; unsafeName?: true }): boolean =>
  !e.unsafeName && (e.kind === 'file' || (e.kind === 'symlink' && e.target === 'file'));

export const sourceName =(source: FileSource): string => baseName(source.path) || source.path;

/** The tab tooltip: "host:/full/path" for a remote file, the local path otherwise. */
export const sourceTitle = (source: FileSource, hostLabel?: string): string =>
  (source.kind === 'remote' ? `${hostLabel ?? '?'}:${source.path}` : source.path);

export type OpenPlan = { kind: 'image'; mime: string } | { kind: 'text' } | { kind: 'tooLarge' };

/** What opening a remote file of `size` bytes does: images preview, text up to the editor limit loads, the rest offers a download. */
export function remoteOpenPlan(name: string, size: number): OpenPlan {
  const mime = IMAGE_MIME[extensionOf(name)];
  if (mime) return size <= EDITOR_IMAGE_BYTES ? { kind: 'image', mime } : { kind: 'tooLarge' };
  return size <= EDITOR_TEXT_BYTES ? { kind: 'text' } : { kind: 'tooLarge' };
}

export const sameStamp = (a: FileStamp | undefined | null, b: FileStamp | undefined | null): boolean =>
  !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Control characters that never appear in a text file (tab, line breaks, form feed and the like are fine). */
const CONTROL = /[\x00-\x08\x0e-\x1f]/;

/** Text of a file's bytes with its encoding; null for a binary file or an unsupported encoding. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncodingName } | null {
  const encoding: TextEncodingName = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
      : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8-bom' : 'utf-8';
  if ((encoding === 'utf-8' || encoding === 'utf-8-bom') && bytes.includes(0)) return null;
  try {
    // The decoder drops the BOM; encodeText writes it back.
    const text = new TextDecoder(encoding === 'utf-8-bom' ? 'utf-8' : encoding, { fatal: true }).decode(bytes);
    return CONTROL.test(text) ? null : { text, encoding };
  } catch { return null; }
}

/** The editor's text (line breaks normalized to "\n") with each line break of `baseline` back in place (mixed files too). */
export function restoreLineEndings(text: string, baseline: string): string {
  const endings = baseline.match(/\r\n|\r|\n/g) ?? [];
  let index = 0;
  return text.replace(/\r\n|\r|\n/g, () => endings[index++] ?? endings[0] ?? '\n');
}

/** Lone surrogates cannot be written in any of the encodings. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export const validEditorText = (text: string): boolean => !CONTROL.test(text) && !LONE_SURROGATE.test(text);

/** The bytes to write for `text` in the file's encoding and line endings (baseline: the file's text the edits started from). */
export function encodeText(text: string, baseline: string, encoding: TextEncodingName): Uint8Array {
  const body = restoreLineEndings(text, baseline);
  if (encoding === 'utf-8' || encoding === 'utf-8-bom') return new TextEncoder().encode((encoding === 'utf-8-bom' ? '\ufeff' : '') + body);
  const full = `\ufeff${body}`;
  const out = new Uint8Array(full.length * 2);
  for (let i = 0; i < full.length; i++) {
    const code = full.charCodeAt(i);
    const [first, second] = encoding === 'utf-16le' ? [code & 0xff, code >> 8] : [code >> 8, code & 0xff];
    out[i * 2] = first;
    out[i * 2 + 1] = second;
  }
  return out;
}

/** A remote file read for an editor tab (by the SFTP Host). */
export type EditorRead =
  | { kind: 'text'; text: string; encoding: TextEncodingName; size: number; stamp: RemoteStamp }
  | { kind: 'image'; mime: string; dataUrl: string; size: number; stamp: RemoteStamp }
  | { kind: 'binary'; size: number }
  | { kind: 'tooLarge'; size: number };

/**
 * A save of a remote editor tab. `expected` null (a draft restored without its stamp): the server text is compared instead.
 * `allowOwnerChange`: the user agreed that the saved file will belong to the SSH user (the server file has another owner).
 */
export interface EditorSave { text: string; baseline: string; encoding: TextEncodingName; expected: RemoteStamp | null; allowOwnerChange?: boolean }

/**
 * The stamp of a remote read or save: size and time, plus the sha256 of the bytes and when they were read. SFTP times have a
 * resolution of one second, so a save compares the hash too when the file changed close to the read.
 */
export interface RemoteStamp extends FileStamp { hash?: string; readAt?: number }

/** The save compares the content hash (a re-read) when the time cannot tell a change apart: within 2 s of the read, or small files. */
export const HASH_CHECK_WINDOW_MS = 2000;
export const HASH_CHECK_SMALL_BYTES = 64 * 1024;
export const needsHashCheck = (s: RemoteStamp): boolean =>
  !!s.hash && (s.readAt === undefined || Math.abs(s.readAt - s.mtimeMs) <= HASH_CHECK_WINDOW_MS || s.size <= HASH_CHECK_SMALL_BYTES);

export interface FileOwner { uid: number; gid: number }

/** Something the save could not keep as it was (shown in the tab; the save itself went through). */
export type EditorWarning = { kind: 'mode'; mode: number } | { kind: 'owner'; from: FileOwner; to: FileOwner };

export type EditorWriteResult =
  /** `stamp` null: the server file could not be read back after the rename (the next save compares the text). */
  | { kind: 'saved'; stamp: RemoteStamp | null; warnings: EditorWarning[] }
  /** The server file belongs to another user and the saved one would not: nothing was written, the user is asked. */
  | { kind: 'ownerChange'; from: FileOwner; to: FileOwner }
  /** The new file could not be renamed in and the old one could not be put back: both copies stay on the server. */
  | { kind: 'stranded'; part: string; aside: string | null };

const validStampShape = (stamp: unknown): boolean => !!stamp && typeof stamp === 'object'
  && Number.isFinite((stamp as FileStamp).size) && Number.isFinite((stamp as FileStamp).mtimeMs)
  && ((stamp as RemoteStamp).hash === undefined || (typeof (stamp as RemoteStamp).hash === 'string' && /^[0-9a-f]{64}$/.test((stamp as RemoteStamp).hash!)))
  && ((stamp as RemoteStamp).readAt === undefined || Number.isFinite((stamp as RemoteStamp).readAt));

/** Rejects a save request that does not have the shape main expects (the IPC also validates it). */
export function validEditorSave(value: unknown): value is EditorSave {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const stampOk = v.expected === null || validStampShape(v.expected);
  return typeof v.text === 'string' && typeof v.baseline === 'string' && v.text.length <= EDITOR_TEXT_BYTES && v.baseline.length <= EDITOR_TEXT_BYTES
    && TEXT_ENCODINGS.includes(v.encoding as TextEncodingName) && stampOk && (v.allowOwnerChange === undefined || typeof v.allowOwnerChange === 'boolean');
}

/** A stamp restored from a draft or sent over IPC: only the known fields. */
export function cleanStamp(stamp: unknown): RemoteStamp | null {
  if (!validStampShape(stamp)) return null;
  const s = stamp as RemoteStamp;
  return { size: s.size, mtimeMs: s.mtimeMs, ...(s.hash ? { hash: s.hash } : {}), ...(s.readAt !== undefined ? { readAt: s.readAt } : {}) };
}

/** `child` is inside the folder `root` (a local path; case-insensitive on Windows and macOS). Relative path with "/" or null. */
export function localRelativePath(root: string, child: string, caseInsensitive: boolean): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root), c = norm(child);
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  if (!r || !fold(c).startsWith(`${fold(r)}/`)) return null;
  const rel = c.slice(r.length + 1);
  return rel && !rel.split('/').some((part) => part === '..' || part === '.' || !part) ? rel : null;
}

// ── tabs that follow moves (0.9.9) ─────────────────────────────────────────

/** The text of a tab whose file was moved, renamed or deleted outside the tab (a Polish key, translated where it is shown). */
export const FILE_GONE = 'Plik został przeniesiony lub usunięty.';

/** How paths of one side compare: a server is POSIX and case-sensitive; Windows takes either slash and, like macOS, ignores case. */
export interface PathRules { caseInsensitive: boolean; backslash: boolean }
export const POSIX_PATHS: PathRules = { caseInsensitive: false, backslash: false };

/** Where a move or rename of `from` to `to` took `path`: the new path when `path` is `from` or lies under it, else null. */
export function movedPath(path: string, from: string, to: string, rules: PathRules): string | null {
  const sep = rules.backslash ? '\\' : '/';
  const norm = (p: string) => (rules.backslash ? p.replace(/\//g, '\\') : p);
  const trim = (p: string) => (rules.backslash ? p.replace(/\\+$/, '') : p.replace(/\/+$/, ''));
  const fold = (p: string) => (rules.caseInsensitive ? p.toLowerCase() : p);
  const p = norm(path);
  const f = trim(norm(from));
  const t = trim(norm(to));
  if (!f || !t) return null;
  if (fold(p) === fold(f)) return t;
  return fold(p).startsWith(`${fold(f)}${sep}`) ? `${t}${p.slice(f.length)}` : null;
}

/** The files of one side a move or delete happened on: a saved host's server, or this computer. */
export type SourceScope = { kind: 'remote'; hostId: string } | { kind: 'local' };

/** The source a move took `source` to (same side only), or null when the move does not touch it. */
export function movedSource(source: FileSource, scope: SourceScope, from: string, to: string, rules: PathRules): FileSource | null {
  if (source.kind !== scope.kind) return null;
  if (source.kind === 'remote' && scope.kind === 'remote' && source.hostId !== scope.hostId) return null;
  const path = movedPath(source.path, from, to, rules);
  return path === null ? null : { ...source, path };
}

/** Whether `source` is one of `paths` or lies under one of them. */
export const sourceUnder = (source: FileSource, scope: SourceScope, paths: string[], rules: PathRules): boolean =>
  paths.some((p) => movedSource(source, scope, p, p, rules) !== null);

interface SourceDoc { id: string; source?: FileSource; relativePath: string; name: string }
export interface SourceRetarget<T> {
  documents: T[];
  activeId: string | null;
  /** Old tab id -> new tab id (an in-flight load or save still reports under the old one). */
  idMap: Map<string, string>;
  /** Clean tabs of the target that a moved tab replaced (their id now belongs to the moved tab). */
  closed: string[];
  /** Moved tabs that could not take their new id (a tab with unsaved changes is open on the target): marked as gone instead. */
  gone: string[];
}

/**
 * Editor tabs of files outside the projects follow a move or rename done in the SFTP view: source, path, name and id change,
 * text and unsaved changes stay. A clean tab already open on the target is closed (the moved file replaced it); one with unsaved
 * changes is never dropped, so the moved tab then keeps its old id and is marked as gone.
 */
export function retargetSourceDocuments<T extends SourceDoc>(
  documents: T[], activeId: string | null, move: (source: FileSource) => FileSource | null, isDirty: (doc: T) => boolean,
): SourceRetarget<T> {
  const idMap = new Map<string, string>();
  const plans = new Map<string, FileSource>();
  for (const doc of documents) {
    const next = doc.source ? move(doc.source) : null;
    if (next && sourceDocumentId(next) !== doc.id) plans.set(doc.id, next);
  }
  const closed = new Set<string>();
  const gone: string[] = [];
  for (const [id, next] of plans) {
    const newId = sourceDocumentId(next);
    const there = documents.find((d) => d.id === newId && !plans.has(d.id));
    if (there && isDirty(there)) { gone.push(id); continue; }
    if (there) closed.add(there.id);
    idMap.set(id, newId);
  }
  const result: T[] = [];
  for (const doc of documents) {
    if (closed.has(doc.id)) continue;
    const newId = idMap.get(doc.id);
    if (!newId) { result.push(doc); continue; }
    const source = plans.get(doc.id)!;
    result.push({ ...doc, id: newId, source, relativePath: source.path, name: sourceName(source) });
  }
  // A closed target tab's id now belongs to the moved tab, so the active id always names a tab that is still open.
  const nextActive = activeId === null ? null : idMap.get(activeId) ?? activeId;
  return { documents: result, activeId: nextActive, idMap, closed: [...closed], gone };
}
