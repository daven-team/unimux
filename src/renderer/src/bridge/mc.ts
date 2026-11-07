// window.mc in the Tauri build (1.2.0): the same methods as the Electron preload (src/preload/mcApi.ts, shared), over the Tauri
// transport. Built as its own classic script and run in <head> before the app (vite.config.tauri.ts), like the Electron preload.
import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createMcApi } from '../../../preload/mcApi';
import { createDropRecordFilePaths, createWebView2FilePaths, type WebView2Host } from './filePaths';
import { createPortPoster, createTauriTransport, McNotYetError, type BootInfo, type TauriTransport } from './transport';
import { installCompat, type CompatReport } from './webkitCompat';
import { installMacDrag, type DragGlobal } from './macDrag';

declare global {
  interface Window {
    __MC_BOOT__?: BootInfo;
    __MC_TAURI__?: { McNotYetError: typeof McNotYetError; transport: TauriTransport };
    __MC_COMPAT__?: CompatReport;
  }
}

const fallbackBoot = (): BootInfo => ({ platform: /Mac/.test(navigator.platform) ? 'darwin' : 'win32', windowsBuild: 0, label: 'main' });
const boot: BootInfo = window.__MC_BOOT__ ?? fallbackBoot();
// First, before anything reads requestIdleCallback / crypto.randomUUID / AudioContext (WebKit on macOS, PLAN W2).
window.__MC_COMPAT__ = Object.freeze(installCompat(window as unknown as Parameters<typeof installCompat>[0], boot.platform));
const current = getCurrentWebviewWindow();
// macOS: the title bar's drag area (WKWebView ignores -webkit-app-region; PLAN W2).
if (boot.platform === 'darwin') {
  installMacDrag(window as unknown as DragGlobal, { startDragging: () => current.startDragging(), doubleClick: () => invoke('mac_title_double_click') });
}
const newSession = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

/** OS paths of dropped Files: WebView2's ICoreWebView2File on Windows, the recorded drop on macOS (W3). */
function filePaths(): ((files: File[]) => Promise<string[]>) | undefined {
  const webview = (window as { chrome?: { webview?: WebView2Host } }).chrome?.webview;
  if (webview?.postMessageWithAdditionalObjects) return createWebView2FilePaths(webview, newSession);
  if (boot.platform === 'darwin') return createDropRecordFilePaths(() => invoke<string[]>('mc_dropped_paths'));
  return undefined;
}

const transport = createTauriTransport(boot, {
  invoke: (command, args, options) => invoke(command, args, options),
  listen: (event, cb) => current.listen(event, (e) => cb(e.payload)),
  log: (message) => console.warn(`[mc] ${message}`),
  storage: (() => { try { return window.sessionStorage; } catch { return null; } })(),
  newSession,
  pathsForFiles: filePaths(),
});

window.mc = createMcApi(transport);
window.__MC_TAURI__ = { McNotYetError, transport };
void transport.replayJournal();

// A reload or navigation: Tauri would keep this page's listeners for the window's whole life (they are keyed by webview
// label), so they are dropped here. A page kept in the back/forward cache (persisted) keeps them.
window.addEventListener('pagehide', (e) => { if (!e.persisted) transport.dispose(); });

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
  if (kind === 'pty') {
    // In order, like the MessagePort of 1.1.4: batched per task and numbered (Rust delivers by number).
    const post = createPortPoster(kind, newSession(), (args) => invoke('mc_port_post', args));
    pair.port2.onmessage = (e) => post(e.data);
  }
  pair.port2.start();
  window.postMessage(`mc:${kind}-port`, '*', [pair.port1]);
}

for (const kind of ['pty', 'sftp', 'db'] as const) void attachPort(kind);
