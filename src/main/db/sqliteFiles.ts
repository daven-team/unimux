// The database files of SQLite connections (1.0.6): picking one in the open dialog, and creating a new, empty one (in the save
// dialog, or at a path typed into the connection form). An empty file is a valid SQLite database; an existing file is never
// written over. Only paths go back to the renderer.
import { openSync, closeSync, statSync } from 'fs';
import { dirname } from 'path';
import { validDbFilePath, type DbSqliteCreateResult } from '../../shared/db';
import type { IpcGuard } from '../ipcGuard';

export interface SqliteFileDialogs {
  open(): Promise<string | null>;
  save(): Promise<string | null>;
}

export type SqliteCreateResult = DbSqliteCreateResult;

/**
 * A new empty database file at `path` (exclusive create: an existing file is left as it is). `allowExisting`: a file the save
 * dialog confirmed is opened as it is (`existed`), if it is a file.
 */
export function createSqliteFile(path: string, allowExisting = false): SqliteCreateResult {
  if (!validDbFilePath(path)) return { ok: false, error: 'invalid' };
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    if (info) return allowExisting && info.isFile() ? { ok: true, path, existed: true } : { ok: false, error: 'exists' };
    const dir = statSync(dirname(path), { throwIfNoEntry: false });
    if (!dir?.isDirectory()) return { ok: false, error: 'noFolder' };
    closeSync(openSync(path, 'wx'));
    return { ok: true, path, existed: false };
  } catch (e) {
    return { ok: false, error: (e as { code?: string }).code === 'EEXIST' ? 'exists' : 'failed' };
  }
}

export function registerSqliteFileIpc(guard: IpcGuard, dialogs: SqliteFileDialogs): void {
  guard.guardedHandle('db:sqlite:pick', async () => dialogs.open(), () => null);
  // No path: the save dialog asks where. A typed path: created there (it must not exist yet).
  guard.guardedHandle('db:sqlite:create', async (_e, path: unknown) => {
    if (path === undefined || path === null) {
      const picked = await dialogs.save();
      return picked ? createSqliteFile(picked, true) : { ok: false, error: 'cancelled' };
    }
    return typeof path === 'string' ? createSqliteFile(path) : { ok: false, error: 'invalid' };
  }, () => ({ ok: false, error: 'invalid' }));
}
