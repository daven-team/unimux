import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createMcApi } from './mcApi';
import { appPlatform, windowsBuildFromRelease } from '../shared/platform';

// MessagePorts can't cross the context bridge; forward the pty data port to the page.
ipcRenderer.on('pty-port', (e) => window.postMessage('mc:pty-port', '*', e.ports));
// The SFTP transfer port (progress straight from the SFTP Host, 0.9.8): the page receives it as 'mc:sftp-port'.
ipcRenderer.on('sftp-port', (e) => window.postMessage('mc:sftp-port', '*', e.ports));
// The DB port (result rows straight from the DB Host, 1.0.0): the page receives it as 'mc:db-port'.
ipcRenderer.on('db-port', (e) => window.postMessage('mc:db-port', '*', e.ports));

// The methods themselves (and their argument shaping) live in mcApi.ts, shared with the Tauri bridge (1.2.0).
const api = createMcApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => {
    const listener = (_e: unknown, ...args: any[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: appPlatform(process.platform),
  // The window is sandboxed (no `os` module): the sandbox's process object still reports the OS version ("10.0.26200").
  windowsBuild: windowsBuildFromRelease(process.platform, process.getSystemVersion?.() ?? ''),
  pathsForFiles: async (files) => Array.from(files, (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } }),
});

contextBridge.exposeInMainWorld('mc', api);
