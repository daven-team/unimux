// IPC handlers for file operations of the project tree. All paths are project-relative and validated in fileOps.ts.
import { app, ipcMain, shell } from 'electron';
import { mkdir, rename } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, join } from 'path';
import { appPlatform } from '../shared/platform';
import type { FileOpRequest } from '../shared/fileOps';
import { createIpcGuard, type IpcSenderEvent } from './ipcGuard';
import { createProjectEntry, deleteProjectEntries, renameProjectEntry, transferProjectEntries, type TrashFn } from './fileOps';

const GONE = 'Projekt już nie istnieje.';

export interface FilesIpcDeps {
  projectPath(projectId: string): string | undefined;
  send(channel: string, ...args: unknown[]): void;
  /** The sender check (R9): every channel here changes files, so only the app window may call them. */
  allowed(event: IpcSenderEvent): boolean;
}

/** The OS trash. Unpackaged builds can redirect it into a folder (MC_TRASH_DIR) so UI checks never touch the real recycle bin. */
function createTrash(): TrashFn {
  const dir = !app.isPackaged ? process.env.MC_TRASH_DIR : undefined;
  if (!dir) return (path) => shell.trashItem(path);
  return async (path) => {
    await mkdir(dir, { recursive: true });
    await rename(path, join(dir, `${randomUUID().slice(0, 8)}-${basename(path)}`));
  };
}

export function registerFileOpsIpc(deps: FilesIpcDeps): void {
  const trash = createTrash();
  const platform = appPlatform(process.platform);
  const running = new Map<string, AbortController>();
  const { guardedHandle, guardedOn } = createIpcGuard(ipcMain, deps.allowed);
  const refused = () => ({ ok: false, error: GONE });
  guardedHandle('fs:renameEntry', (_e, projectId: string, path: string, newName: string) => {
    const root = deps.projectPath(projectId);
    return root ? renameProjectEntry(root, path, newName, { platform }) : { ok: false, error: GONE };
  }, refused);
  guardedHandle('fs:createEntry', (_e, projectId: string, directory: string, name: string, kind: 'file' | 'directory') => {
    const root = deps.projectPath(projectId);
    return root ? createProjectEntry(root, directory, name, kind === 'directory' ? 'directory' : 'file', { platform }) : { ok: false, error: GONE };
  }, refused);
  guardedHandle('fs:deleteEntries', (_e, projectId: string, paths: string[]) => {
    const root = deps.projectPath(projectId);
    return root ? deleteProjectEntries(root, paths, { trash }) : { ok: false, error: GONE };
  }, refused);
  guardedHandle('fs:transfer', async (_e, projectId: string, request: FileOpRequest) => {
    const root = deps.projectPath(projectId);
    if (!root) return { ok: false, error: GONE };
    const opId = typeof request?.opId === 'string' && request.opId.length <= 100 ? request.opId : undefined;
    const controller = new AbortController();
    if (opId) running.set(opId, controller);
    try {
      return await transferProjectEntries(root, request, {
        trash, platform, signal: controller.signal,
        onProgress: opId ? (progress) => deps.send('fs:progress', { opId, ...progress }) : undefined,
      });
    } finally { if (opId) running.delete(opId); }
  }, refused);
  guardedOn('fs:cancelOp', (_e, opId: string) => { running.get(opId)?.abort(); });
}
