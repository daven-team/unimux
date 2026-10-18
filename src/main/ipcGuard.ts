// The sender check (R9) of every IPC channel that changes something (0.9.6): it runs only for the app's own window. A foreign
// sender (another window, a foreign frame, a webContents that is not ours) gets the refusal the channel's renderer caller already
// handles on failure and the handler never runs; a refused send is ignored. No Electron imports, so it is tested in Node.
//
// How a new channel stays covered: test/ipc-guard.test.ts scans src/main for `ipcMain.handle` / `ipcMain.on` registrations
// that bypass this wrapper and fails unless the channel is on OPEN_IPC_CHANNELS below (read-only, with the reason it may stay
// open). It also asserts that the known mutating channels are registered through `guardedHandle` / `guardedOn`.
import type { IpcMain } from 'electron';

export interface IpcSenderEvent { sender: unknown; senderFrame?: unknown }

/** What a refused invoke answers, from the call's arguments; it may throw or reject where the handler itself would. */
export type Refusal = (...args: unknown[]) => unknown;

export interface IpcGuard {
  /** `ipcMain.handle` that runs `handler` only for an allowed sender; any other sender gets `fallback`. */
  guardedHandle<A extends unknown[]>(channel: string, handler: (event: IpcSenderEvent, ...args: A) => unknown, fallback: Refusal): void;
  /** `ipcMain.on` that runs `listener` only for an allowed sender; any other send is ignored. */
  guardedOn<A extends unknown[]>(channel: string, listener: (event: IpcSenderEvent, ...args: A) => void): void;
}

export function createIpcGuard(ipc: Pick<IpcMain, 'handle' | 'on'>, allowed: (event: IpcSenderEvent) => boolean): IpcGuard {
  return {
    guardedHandle(channel, handler, fallback) {
      ipc.handle(channel, (event, ...args) => {
        if (allowed(event)) return handler(event, ...(args as never));
        return fallback(...args);
      });
    },
    guardedOn(channel, listener) {
      ipc.on(channel, (event, ...args) => { if (allowed(event)) listener(event, ...(args as never)); });
    },
  };
}

/**
 * Channels registered with plain `ipcMain.handle` / `ipcMain.on`, open to any sender. Only reads that change nothing may be
 * here, each with the reason. Anything else goes through `guardedHandle` / `guardedOn` (the test enforces it).
 */
export const OPEN_IPC_CHANNELS: Readonly<Record<string, string>> = {
  'state:load': 'reads the state in memory',
  'state:snapshot': 'reads the state in memory',
  'mcp:info': 'reads the MCP server status',
  'cell:alive': 'lists running cell ids',
  'cli:status': 'reads the cached CLI detection',
  'install:options': 'lists the install methods of a CLI',
  'install:current': 'reads the running install, if any',
  'sound:load': 'reads the sound file saved in the settings (the path never comes from the renderer)',
  'fs:exists': 'checks whether a path exists',
  'fs:pathKinds': 'stats dropped paths',
  'fs:listProjectDirectory': 'lists a project folder',
  'fs:listProjectDirectoryBatch': 'lists project folders',
  'fs:listProjectDirectories': 'lists project folders',
  'fs:searchProject': 'searches project files (the running search is kept per sender, so no other window can stop it)',
  'fs:readProjectFile': 'reads a project file',
  'sessions:list': 'lists conversation files of a project',
  'git:isRepo': 'checks whether a folder is a git repository',
  'git:probe': 'checks whether the project is a repository',
  'git:worktrees': 'lists the worktrees of the project',
  // gitIpc.ts registers the read-only git channels of GIT_READ_CHANNELS in one loop.
  'git:${channel}': 'the read-only git channels (status, log, show, diff, branches, trust info)',
  'changelog:get': 'reads the release notes (from GitHub or its cache file)',
  'update:get': 'reads the update state',
};
