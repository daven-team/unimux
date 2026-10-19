import { open, readdir, realpath, rename, stat, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { isAbsolute, relative, resolve, sep } from 'path';
import { IGNORED_FOLDERS } from '../shared/search';
import type { ProjectDirectory, ProjectFilePreview } from '../shared/types';

export const PREVIEW_BYTES = 256 * 1024;
const DIRECTORY_LIMIT = 2000;

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Check both the requested path and its real target, including directory junctions. */
async function projectFilePath(projectRoot: string, relativePath: string, rootReal?: Promise<string>): Promise<string> {
  if (typeof relativePath !== 'string' || isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Ścieżka jest poza projektem.');
  const root = resolve(projectRoot);
  const requested = resolve(root, relativePath);
  if (!isInside(root, requested)) throw new Error('Ścieżka jest poza projektem.');
  const [realRoot, target] = await Promise.all([rootReal ?? realpath(root), realpath(requested)]);
  if (!isInside(realRoot, target)) throw new Error('Ten link prowadzi poza folder projektu.');
  return target;
}

/** Size and modification time of a project file (null when it cannot be read): a cheap "did it change?" before reading it. */
export async function statProjectFile(root: string, path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(await projectFilePath(root, path));
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch { return null; }
}

/** Natural, case-insensitive order of names (one collator: much faster than localeCompare with a locale per call). */
const nameOrder = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });

function fileError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Plik lub folder już nie istnieje. Odśwież listę.';
  if (code === 'EACCES' || code === 'EPERM') return 'Brak uprawnień do odczytu tego pliku lub folderu.';
  return error instanceof Error ? error.message : 'Nie udało się odczytać pliku lub folderu.';
}

export async function listProjectDirectory(root: string, path = '', rootReal?: Promise<string>): Promise<ProjectDirectory> {
  try {
    const target = await projectFilePath(root, path, rootReal);
    const items = await readdir(target, { withFileTypes: true });
    const entries = items.filter((item) => item.isDirectory() || item.isFile() || item.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || nameOrder.compare(a.name, b.name))
      .slice(0, DIRECTORY_LIMIT)
      .map((item) => ({
        name: item.name,
        path: [path.replace(/\\/g, '/').replace(/\/$/, ''), item.name].filter(Boolean).join('/'),
        kind: item.isDirectory() ? 'directory' as const : item.isSymbolicLink() ? 'symlink' as const : 'file' as const,
      }));
    return { ok: true, entries, truncated: items.length > DIRECTORY_LIMIT };
  } catch (error) {
    return { ok: false, error: fileError(error) };
  }
}

const LIST_CONCURRENCY = 24;
/** At most this many folders per batch request of the tree. */
export const BATCH_LIMIT = 500;

/** `fn` over `items` with at most `limit` running at once; results in the order of `items`. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Listings of many folders in one call (the tree loads every open folder at once instead of one request per folder). */
export async function listProjectDirectoryBatch(root: string, paths: unknown): Promise<Record<string, ProjectDirectory>> {
  const list = Array.isArray(paths) ? [...new Set(paths.filter((p): p is string => typeof p === 'string'))].slice(0, BATCH_LIMIT) : [];
  const rootReal = realpath(resolve(root));
  rootReal.catch(() => undefined);
  const listings = await mapLimited(list, LIST_CONCURRENCY, (path) => listProjectDirectory(root, path, rootReal));
  const result: Record<string, ProjectDirectory> = {};
  list.forEach((path, i) => { result[path] = listings[i]; });
  return result;
}

export type ProjectDirectories = { ok: true; paths: string[]; truncated: boolean } | { ok: false; error: string };

/** Every folder of the project (dependency and build folders excluded), breadth first, for "expand all". */
export async function listProjectDirectories(root: string, limit = 2500): Promise<ProjectDirectories> {
  try {
    const base = await projectFilePath(root, '');
    const paths: string[] = [];
    // Level by level; the folders of one level are read in parallel, the order stays breadth first and sorted.
    let level = [''];
    while (level.length) {
      const listed = await mapLimited(level, LIST_CONCURRENCY, (directory) => readdir(resolve(base, directory), { withFileTypes: true }).catch(() => []));
      const next: string[] = [];
      for (let i = 0; i < level.length; i++) {
        const directory = level[i];
        const items = listed[i].filter((item) => item.isDirectory() && !IGNORED_FOLDERS.has(item.name)).sort((a, b) => nameOrder.compare(a.name, b.name));
        for (const item of items) {
          if (paths.length >= limit) return { ok: true, paths, truncated: true };
          const path = directory ? `${directory}/${item.name}` : item.name;
          paths.push(path);
          next.push(path);
        }
      }
      level = next;
    }
    return { ok: true, paths, truncated: false };
  } catch (error) {
    return { ok: false, error: fileError(error) };
  }
}

/** The editor opens bigger files read-only: this much of the beginning is loaded (the rest stays on disk). */
export const LARGE_VIEW_BYTES = 8 * 1024 * 1024;
const IMAGE_BYTES = 20 * 1024 * 1024;
const PARQUET_ROWS = 1000;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
const extensionOf = (path: string): string => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

/** A cell as shown in the table: dates, bigints, nested values and bytes become readable text. */
function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `<${value.byteLength} B>`;
  if (typeof value === 'object') {
    try { return JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? `<${v.byteLength} B>` : v); } catch { return String(value); }
  }
  return String(value);
}

async function readParquet(target: string, size: number): Promise<ProjectFilePreview> {
  try {
    const { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } = await import('hyparquet');
    const { compressors } = await import('hyparquet-compressors');
    const file = await asyncBufferFromFile(target);
    const metadata = await parquetMetadataAsync(file);
    const fields = parquetSchema(metadata).children;
    const columns = fields.map((field) => field.element.name);
    const types = fields.map((field) => String(field.element.logical_type?.type ?? field.element.converted_type ?? field.element.type ?? ''));
    const objects = await parquetReadObjects({ file, metadata, compressors, rowStart: 0, rowEnd: PARQUET_ROWS, utf8: true });
    const rows = objects.map((row) => columns.map((name) => cellText((row as Record<string, unknown>)[name])));
    return { kind: 'table', format: 'parquet', columns, types, rows, totalRows: Number(metadata.num_rows), size };
  } catch {
    return { kind: 'error', message: 'Nie udało się odczytać pliku Parquet.' };
  }
}

/** `limit` is how much of the beginning of a text file is returned (the preview modal and search keep the small default). */
export async function readProjectFile(root: string, path: string, limit = PREVIEW_BYTES): Promise<ProjectFilePreview> {
  try {
    return await readFileAt(await projectFilePath(root, path), path, limit);
  } catch (error) {
    return { kind: 'error', message: fileError(error) };
  }
}

/** A local file outside the projects (an editor tab opened from the SFTP view's local pane, 0.9.9): read like a project file. */
export async function readLocalFile(path: unknown): Promise<ProjectFilePreview> {
  try {
    return await readFileAt(await localFilePath(path), path as string, LARGE_VIEW_BYTES);
  } catch (error) {
    return { kind: 'error', message: fileError(error) };
  }
}

export async function statLocalFile(path: unknown): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(await localFilePath(path));
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch { return null; }
}

/** An absolute local path, resolved through links (the editor writes the file a link points to). */
async function localFilePath(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') || !isAbsolute(path)) throw new Error('Nieprawidłowa ścieżka lub nazwa');
  return realpath(resolve(path));
}

async function readFileAt(target: string, path: string, limit: number): Promise<ProjectFilePreview> {
  {
    const file = await open(target, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return { kind: 'error', message: 'Wybierz plik, aby zobaczyć jego treść.' };
      const extension = extensionOf(path);
      const mime = IMAGE_MIME[extension];
      if (mime && limit > PREVIEW_BYTES) {
        if (stat.size > IMAGE_BYTES) return { kind: 'binary', size: stat.size };
        const bytes = await file.readFile();
        return { kind: 'image', mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, size: stat.size };
      }
      if (extension === 'parquet' && limit > PREVIEW_BYTES) return await readParquet(target, stat.size);
      const cap = Math.max(PREVIEW_BYTES, Math.min(limit, LARGE_VIEW_BYTES));
      const buffer = Buffer.alloc(Math.min(stat.size, cap) + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const truncated = bytesRead > cap;
      const data = buffer.subarray(0, Math.min(bytesRead, cap));
      const utf16 = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
        : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : null;
      if (!utf16 && data.includes(0)) return { kind: 'binary', size: stat.size };
      try {
        const text = new TextDecoder(utf16 ?? 'utf-8', { fatal: true }).decode(data, { stream: truncated });
        if (/[\x00-\x08\x0e-\x1f]/.test(text)) return { kind: 'binary', size: stat.size };
        return { kind: 'text', text, size: stat.size, truncated };
      } catch {
        return { kind: 'binary', size: stat.size };
      }
    } finally {
      await file.close();
    }
  }
}

/** 'conflict': the file on disk is not the text the editor started from (nothing was written). */
export type ProjectFileWriteResult = { ok: true } | { ok: false; error: string; code?: 'conflict' };
const CONFLICT = 'Plik zmienił się poza edytorem. Twój szkic został zachowany.';
class SaveConflict extends Error { constructor() { super(CONFLICT); } }

// Serialize our own saves so two tabs cannot both overwrite the same baseline.
const saves = new Map<string, Promise<ProjectFileWriteResult>>();
export function writeProjectFile(root: string, path: string, text: string, expectedText: string): Promise<ProjectFileWriteResult> {
  return writeFileWith(() => projectFilePath(root, path), text, expectedText);
}

/** A local file outside the projects: the same checks as a project file (unchanged since it was read, size limit, staged write). */
export function writeLocalFile(path: unknown, text: unknown, expectedText: unknown): Promise<ProjectFileWriteResult> {
  return writeFileWith(() => localFilePath(path), text, expectedText);
}

async function writeFileWith(resolveTarget: () => Promise<string>, text: unknown, expectedText: unknown): Promise<ProjectFileWriteResult> {
  try {
    if (typeof text !== 'string' || typeof expectedText !== 'string') throw new Error('Nieprawidłowa treść pliku.');
    const target = await resolveTarget();
    const previous = saves.get(target);
    const pending = (async () => {
      if (previous) await previous;
      return saveText(resolveTarget, target, text, expectedText);
    })();
    saves.set(target, pending);
    try { return await pending; }
    finally { if (saves.get(target) === pending) saves.delete(target); }
  } catch (error) { return { ok: false, error: fileError(error) }; }
}

async function saveText(resolveTarget: () => Promise<string>, target: string, text: string, expectedText: string): Promise<ProjectFileWriteResult> {
  let temporary: string | undefined;
  try {
    const file = await open(target, 'r');
    let bytes: Buffer;
    let mode: number;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Wybierz plik, aby zapisać jego treść.');
      if (stat.size > PREVIEW_BYTES) throw new Error('Plik jest zbyt duży do bezpiecznej edycji.');
      mode = stat.mode;
      bytes = Buffer.alloc(PREVIEW_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, bytesRead);
      if (bytes.length > PREVIEW_BYTES) throw new Error('Plik jest zbyt duży do bezpiecznej edycji.');
    } finally { await file.close(); }
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    let baseline: string;
    try { baseline = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { throw new Error('Nie można edytować pliku binarnego lub nieobsługiwanego kodowania.'); }
    if (/[\x00-\x08\x0e-\x1f]/.test(baseline)) throw new Error('Nie można edytować pliku binarnego.');
    if (baseline !== expectedText) throw new SaveConflict();
    if (/[\x00-\x08\x0e-\x1f]/.test(text) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error('Nieprawidłowa treść pliku.');
    // Textareas normalize line breaks. Keep each original separator (including mixed files).
    const endings = baseline.match(/\r\n|\r|\n/g) ?? [];
    let index = 0;
    const normalized = text.replace(/\r\n|\r|\n/g, () => endings[index++] ?? endings[0] ?? '\n');
    let output: Buffer;
    if (encoding !== 'utf-8') {
      output = Buffer.from('\ufeff' + normalized, 'utf16le');
      if (encoding === 'utf-16be') output.swap16();
    } else {
      const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      output = Buffer.from((bom ? '\ufeff' : '') + normalized, 'utf8');
    }
    if (output.length > PREVIEW_BYTES) throw new Error('Plik jest zbyt duży do bezpiecznej edycji.');
    temporary = `${target}.mc-save-${randomUUID()}`;
    const staged = await open(temporary, 'wx', mode);
    try { await staged.writeFile(output); await staged.sync(); }
    finally { await staged.close(); }
    if (await resolveTarget() !== target) throw new SaveConflict();
    const current = await open(target, 'r');
    let unchanged = false;
    try {
      const stat = await current.stat();
      if (stat.isFile() && stat.size === bytes.length) {
        const check = Buffer.alloc(PREVIEW_BYTES + 1);
        const { bytesRead } = await current.read(check, 0, check.length, 0);
        unchanged = check.subarray(0, bytesRead).equals(bytes);
      }
    } finally { await current.close(); }
    if (!unchanged) throw new SaveConflict();
    await rename(temporary, target);
    temporary = undefined;
    return { ok: true };
  } catch (error) { return error instanceof SaveConflict ? { ok: false, code: 'conflict', error: CONFLICT } : { ok: false, error: fileError(error) }; }
  finally { if (temporary) await unlink(temporary).catch(() => undefined); }
}
