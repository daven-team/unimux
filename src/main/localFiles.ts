// The local pane of the SFTP view (0.9.8): any folder the user browses (not only projects), the drives on Windows, the home
// folder, new folder, rename, trash and "show in Explorer/Finder". Absolute paths only; every channel is sender-checked.
import { lstat, mkdir, readdir, rename, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { permissionString, safeEntryName, SFTP_LIMITS, type LocalEntry, type LocalErrorCode, type LocalResult } from '../shared/sftp';
import type { IpcGuard } from './ipcGuard';

export interface LocalFilesDeps {
  platform: NodeJS.Platform;
  trash(path: string): Promise<void>;
  openFolder(path: string): Promise<void>;
  showFile(path: string): void;
  home?(): string;
}

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
        const caseOnly = (windows || deps.platform === 'darwin') && from.toLowerCase() === to.toLowerCase();
        if (there && !caseOnly) return fail('exists');
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
        if (st.isDirectory()) await deps.openFolder(path); else deps.showFile(path);
        return ok(null);
      } catch (error) { return fail(codeOf(error)); }
    },
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
}
