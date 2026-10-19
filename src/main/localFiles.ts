// The local pane of the SFTP view (0.9.8): any folder the user browses (not only projects), the drives on Windows, the home
// folder, new folder, rename, trash and "show in Explorer/Finder". Absolute paths only; every channel is sender-checked.
import { lstat, mkdir, readdir, realpath, rename, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { permissionString, safeEntryName, SFTP_LIMITS, type LocalEntry, type LocalErrorCode, type LocalResult } from '../shared/sftp';
import type { IpcGuard } from './ipcGuard';
import { sameLocalFile } from '../sftphost/sides';
import { readLocalFile, statLocalFile, writeLocalFile } from './files';
import type { ProjectFilePreview } from '../shared/types';

export interface LocalFilesDeps {
  platform: NodeJS.Platform;
  trash(path: string): Promise<void>;
  openFolder(path: string): Promise<void>;
  showFile(path: string): void;
  home?(): string;
  /**
   * Folders the editor never reads or writes through local:readFile / local:writeFile (0.9.9): the app's data dir and userData
   * (state, vault, logs) and the install dir.
   */
  forbidden?: string[];
}

/** Files the window read through local:readFile in this page: the only ones local:writeFile accepts. */
export const OPENED_LIMIT = 500;
const EDIT_REFUSED = 'Tego miejsca nie można edytować w aplikacji.';
const NOT_OPENED = 'Ten plik nie został otwarty w edytorze.';

/** A UNC or device path (\\server\share, \\?\, \\.\): never read for the editor (a read could leak the Windows login to a server). */
export const isUncOrDevicePath = (path: string): boolean => /^[\\/]{2}/.test(path);

/** A macOS directory name Finder may treat as a package rather than a plain folder (any extension, e.g. Foo.app). */
export const isBundleName = (name: string): boolean => /\.[a-z0-9]+$/i.test(name) && !/^\.[^.]*$/.test(name);

const ok = <T>(value: T): LocalResult<T> => ({ ok: true, value });
const fail = (error: LocalErrorCode): LocalResult<never> => ({ ok: false, error });

function codeOf(error: unknown): LocalErrorCode {
  switch ((error as { code?: unknown } | null)?.code) {
    case 'ENOENT': return 'notFound';
    case 'EEXIST': return 'exists';
    case 'EACCES': case 'EPERM': case 'EBUSY': return 'permission';
    case 'ENOTEMPTY': return 'notEmpty';
    case 'ENOTDIR': return 'notADirectory';
    default: return 'failed';
  }
}

export function validLocalPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= SFTP_LIMITS.path && !path.includes('\0') && isAbsolute(path);
}

async function entryOf(dir: string, name: string, platform: NodeJS.Platform): Promise<LocalEntry | null> {
  const path = join(dir, name);
  try {
    const st = await lstat(path);
    const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    const entry: LocalEntry = { name, path, kind, size: kind === 'file' ? st.size : 0, mtime: Math.round(st.mtimeMs), permissions: platform === 'win32' ? '' : permissionString(st.mode), hidden: name.startsWith('.') };
    if (kind === 'symlink') {
      const real = await stat(path).catch(() => null);
      entry.target = real?.isDirectory() ? 'dir' : real?.isFile() ? 'file' : 'other';
      if (real?.isFile()) entry.size = real.size;
    }
    return entry;
  } catch { return null; } // vanished or unreadable (pagefile.sys): left out
}

export function createLocalFiles(deps: LocalFilesDeps) {
  const windows = deps.platform === 'win32';
  const caseInsensitive = windows || deps.platform === 'darwin';
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const inside = (root: string, child: string) => {
    const rel = relative(fold(root), fold(child));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const opened = new Set<string>();
  const remember = (real: string) => {
    opened.delete(fold(real));
    opened.add(fold(real));
    if (opened.size > OPENED_LIMIT) opened.delete(opened.values().next().value!);
  };
  let forbiddenReal: Promise<string[]> | null = null;
  const forbidden = () => (forbiddenReal ??= Promise.all((deps.forbidden ?? []).filter(Boolean).map((f) => realpath(resolve(f)).catch(() => resolve(f)))));
  /** The real path of a file the editor may read or write, or null. */
  const editablePath = async (path: unknown): Promise<string | null> => {
    if (!validLocalPath(path) || (windows && isUncOrDevicePath(path))) return null;
    let real: string;
    try { real = await realpath(resolve(path)); } catch { return null; }
    if (windows && isUncOrDevicePath(real)) return null;
    const roots = [...(deps.forbidden ?? []).map((f) => resolve(f)), ...(await forbidden())];
    if (roots.some((root) => inside(root, real) || inside(root, resolve(path)))) return null;
    return real;
  };
  const validName = (path: string) => safeEntryName(basename(path), { windows });
  return {
    async list(path: unknown): Promise<LocalResult<{ path: string; entries: LocalEntry[]; truncated: boolean }>> {
      if (!validLocalPath(path)) return fail('invalid');
      const dir = resolve(path);
      try {
        const st = await stat(dir);
        if (!st.isDirectory()) return fail('notADirectory');
        const names = await readdir(dir);
        const truncated = names.length > SFTP_LIMITS.listEntries;
        const picked = names.slice(0, SFTP_LIMITS.listEntries);
        const entries: LocalEntry[] = [];
        for (let i = 0; i < picked.length; i += 64) {
          const batch = await Promise.all(picked.slice(i, i + 64).map((n) => entryOf(dir, n, deps.platform)));
          for (const e of batch) if (e) entries.push(e);
        }
        return ok({ path: dir, entries, truncated });
      } catch (error) { return fail(codeOf(error)); }
    },
    async roots(): Promise<{ home: string; drives: string[] }> {
      const home = deps.home?.() ?? homedir();
      if (!windows) return { home, drives: [] };
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      const found = await Promise.all(letters.map(async (l) => {
        try { await stat(`${l}:\\`); return `${l}:\\`; } catch { return null; }
      }));
      return { home, drives: found.filter((d): d is string => d !== null) };
    },
    async mkdir(path: unknown): Promise<LocalResult<null>> {
      if (!validLocalPath(path) || !validName(path)) return fail('invalid');
      try { await mkdir(path); return ok(null); } catch (error) { return fail(codeOf(error)); }
    },
    async rename(from: unknown, to: unknown): Promise<LocalResult<null>> {
      if (!validLocalPath(from) || !validLocalPath(to) || !validName(to)) return fail('invalid');
      if (resolve(dirname(from)) !== resolve(dirname(to))) return fail('invalid'); // a rename, not a move
      try {
        const there = await lstat(to).catch(() => null);
        // A case-only rename is allowed only when both names are the same file (a case-insensitive disk); on a case-sensitive
        // volume "A" next to "a" is another file and stays.
        if (there && !(await sameLocalFile(from, to))) return fail('exists');
        await rename(from, to);
        return ok(null);
      } catch (error) { return fail(codeOf(error)); }
    },
    async trash(paths: unknown): Promise<LocalResult<null>> {
      if (!Array.isArray(paths) || !paths.length || paths.length > SFTP_LIMITS.paths || !paths.every(validLocalPath)) return fail(Array.isArray(paths) && paths.length > SFTP_LIMITS.paths ? 'tooMany' : 'invalid');
      // A drive root or the home folder never goes to the trash by a click.
      const home = resolve(deps.home?.() ?? homedir());
      if (paths.some((p) => { const r = resolve(p); return dirname(r) === r || r === home; })) return fail('invalid');
      try { for (const p of paths) await deps.trash(p); return ok(null); } catch (error) { return fail(codeOf(error)); }
    },
    async reveal(path: unknown): Promise<LocalResult<null>> {
      if (!validLocalPath(path)) return fail('invalid');
      try {
        const st = await stat(path);
        // On macOS a directory with an extension (Foo.app, .bundle, .pkg, .prefPane, .workflow) is a bundle: opening it would launch
        // it, and a downloaded bundle carries no quarantine flag. It is shown selected in Finder instead.
        if (st.isDirectory() && !(deps.platform === 'darwin' && isBundleName(basename(resolve(path))))) await deps.openFolder(path);
        else deps.showFile(path);
        return ok(null);
      } catch (error) { return fail(codeOf(error)); }
    },
    // An editor tab of a local file outside the projects (0.9.9): read and saved like a project file, only outside the app's own
    // folders, never over UNC or device paths, and a write only for a file this window opened (read) before.
    async readFile(path: unknown): Promise<ProjectFilePreview> {
      const real = await editablePath(path);
      if (!real) return { kind: 'error', message: EDIT_REFUSED };
      const result = await readLocalFile(real);
      if (result.kind !== 'error') remember(real);
      return result;
    },
    async statFile(path: unknown): Promise<{ size: number; mtimeMs: number } | null> {
      const real = await editablePath(path);
      return real ? statLocalFile(real) : null;
    },
    async writeFile(path: unknown, text: unknown, expectedText: unknown): Promise<{ ok: true } | { ok: false; error: string; code?: 'conflict' }> {
      const real = await editablePath(path);
      if (!real) return { ok: false, error: EDIT_REFUSED };
      if (!opened.has(fold(real))) return { ok: false, error: NOT_OPENED };
      return writeLocalFile(real, text, expectedText);
    },
    /** The page reloaded or crashed: what it opened counts no more (restored drafts read again before they save). */
    rendererGone(): void { opened.clear(); },
  };
}

export type LocalFiles = ReturnType<typeof createLocalFiles>;

/** The local pane's channels. Listing an arbitrary folder is a read, but it is guarded like the rest (only the app window). */
export function registerLocalFilesIpc(guard: IpcGuard, files: LocalFiles): void {
  const refused = () => ({ ok: false, error: 'invalid' });
  guard.guardedHandle('local:list', (_e, path: unknown) => files.list(path), refused);
  guard.guardedHandle('local:roots', () => files.roots(), () => ({ home: '', drives: [] }));
  guard.guardedHandle('local:mkdir', (_e, path: unknown) => files.mkdir(path), refused);
  guard.guardedHandle('local:rename', (_e, from: unknown, to: unknown) => files.rename(from, to), refused);
  guard.guardedHandle('local:trash', (_e, paths: unknown) => files.trash(paths), refused);
  guard.guardedHandle('local:reveal', (_e, path: unknown) => files.reveal(path), refused);
  guard.guardedHandle('local:readFile', (_e, path: unknown) => files.readFile(path), () => ({ kind: 'error', message: 'Nieprawidłowa ścieżka lub nazwa' }));
  guard.guardedHandle('local:statFile', (_e, path: unknown) => files.statFile(path), () => null);
  guard.guardedHandle('local:writeFile', (_e, path: unknown, text: unknown, expectedText: unknown) => files.writeFile(path, text, expectedText), () => ({ ok: false, error: 'Nieprawidłowa ścieżka lub nazwa' }));
}
