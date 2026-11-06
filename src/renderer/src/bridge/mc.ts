// window.mc in the Tauri build (1.2.0): the same methods as the Electron preload (src/preload/mcApi.ts, shared), over the Tauri
// transport. Built as its own classic script and run in <head> before the app (vite.config.tauri.ts), like the Electron preload.
import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createMcApi } from '../../../preload/mcApi';
import { createTauriTransport, McNotYetError, type BootInfo } from './transport';

declare global {
  interface Window {
    __MC_BOOT__?: BootInfo;
    __MC_TAURI__?: { McNotYetError: typeof McNotYetError; transport: ReturnType<typeof createTauriTransport> };
  }
}

const fallbackBoot = (): BootInfo => ({ platform: /Mac/.test(navigator.platform) ? 'darwin' : 'win32', windowsBuild: 0, label: 'main' });
const boot: BootInfo = window.__MC_BOOT__ ?? fallbackBoot();
const current = getCurrentWebviewWindow();

const transport = createTauriTransport(boot, {
  invoke: (command, args) => invoke(command, args),
  listen: (event, cb) => current.listen(event, (e) => cb(e.payload)),
  log: (message) => console.warn(`[mc] ${message}`),
  storage: (() => { try { return window.sessionStorage; } catch { return null; } })(),
  newSession: () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
});

window.mc = createMcApi(transport);
window.__MC_TAURI__ = { McNotYetError, transport };
void transport.replayJournal();

/**
 * The MessagePorts of 1.1.4 (`mc:pty-port`, `mc:sftp-port`, `mc:db-port`): a real MessageChannel whose far end is wired to a
 * Tauri channel. The page gets port1 exactly as before (TerminalManager, sftp.ts, dbClient.ts unchanged). Attached by this
 * page on every load (never pushed by Rust); a port whose service has not been ported yet is simply not posted.
 */
async function attachPort(kind: 'pty' | 'sftp' | 'db'): Promise<void> {
  const pair = new MessageChannel();
  const channel = new Channel<unknown>();
  channel.onmessage = (message) => pair.port2.postMessage(message instanceof ArrayBuffer ? new Uint8Array(message) : message);
  try {
    await invoke('mc_port_attach', { kind, channel });
  } catch (error) {
    if ((error as { code?: string })?.code !== 'MC_NOT_YET') console.warn(`[mc] ${kind} port: ${String((error as Error)?.message ?? JSON.stringify(error))}`);
    return;
  }
  if (kind === 'pty') pair.port2.onmessage = (e) => { void invoke('mc_port_post', { kind, message: e.data }).catch(() => undefined); };
  pair.port2.start();
  window.postMessage(`mc:${kind}-port`, '*', [pair.port1]);
}

for (const kind of ['pty', 'sftp', 'db'] as const) void attachPort(kind);
