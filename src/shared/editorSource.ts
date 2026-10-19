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
  if (encoding === 'utf-8' || encoding === 'utf-8-bom') return new TextEncoder().encode((encoding === 'utf-8-bom' ? '﻿' : '') + body);
  const full = `﻿${body}`;
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
  | { kind: 'text'; text: string; encoding: TextEncodingName; size: number; stamp: FileStamp }
  | { kind: 'image'; mime: string; dataUrl: string; size: number; stamp: FileStamp }
  | { kind: 'binary'; size: number }
  | { kind: 'tooLarge'; size: number };

/** A save of a remote editor tab. `expected` null (a draft restored without its stamp): the server text is compared instead. */
export interface EditorSave { text: string; baseline: string; encoding: TextEncodingName; expected: FileStamp | null }

/** Rejects a save request that does not have the shape main expects (the IPC also validates it). */
export function validEditorSave(value: unknown): value is EditorSave {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const stamp = v.expected;
  const stampOk = stamp === null || (!!stamp && typeof stamp === 'object'
    && Number.isFinite((stamp as FileStamp).size) && Number.isFinite((stamp as FileStamp).mtimeMs));
  return typeof v.text === 'string' && typeof v.baseline === 'string' && v.text.length <= EDITOR_TEXT_BYTES && v.baseline.length <= EDITOR_TEXT_BYTES
    && TEXT_ENCODINGS.includes(v.encoding as TextEncodingName) && stampOk;
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
