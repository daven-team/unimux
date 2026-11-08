// window.mc in the Tauri build (1.2.0): the methods of mcApi.ts (1.1.4's preload table) over the Tauri transport. Built as its
// own classic script and run in <head> before the app (vite.config.tauri.ts), like 1.1.4's Electron preload.
import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createMcApi } from './mcApi';
import { createDropRecordFilePaths, createWebView2FilePaths, type WebView2Host } from './filePaths';
import { createPortPoster, createTauriTransport, McNotYetError, type BootInfo, type TauriTransport } from './transport';
import { installCompat, type CompatReport } from './webkitCompat';
import { installMacDrag, type DragGlobal } from './macDrag';
import { createPtyPort, listenSharedBuffers, runPull, type BridgePtyPort, type SharedBufferHost } from './ptyPort';
import { listenDbBuffers } from './dbPort';

declare global {
  interface Window {
    __MC_BOOT__?: BootInfo;
    __MC_TAURI__?: { McNotYetError: typeof McNotYetError; transport: TauriTransport };
    __MC_COMPAT__?: CompatReport;
    __MC_PTY_PORT__?: BridgePtyPort;
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
 * The MessagePorts of 1.1.4 (`mc:sftp-port`, `mc:db-port`; the pty port is attachPtyPort below): a real MessageChannel
 * whose far end is wired to a Tauri channel. The page gets port1 exactly as before (sftp.ts, dbClient.ts unchanged). Attached by this
 * page on every load (never pushed by Rust); a port whose service has not been ported yet is simply not posted. The DB port
 * on Windows (D12) brings its messages as WebView2 shared buffers of this attach (bridge/dbPort.ts) instead of the channel.
 */
async function attachPort(kind: 'sftp' | 'db'): Promise<void> {
  const pair = new MessageChannel();
  const channel = new Channel<unknown>();
  channel.onmessage = (message) => pair.port2.postMessage(message instanceof ArrayBuffer ? new Uint8Array(message) : message);
  const attach = newSession();
  const webview = (window as { chrome?: { webview?: Partial<SharedBufferHost> } }).chrome?.webview;
  // Listening before the attach: the host may post as soon as the port exists.
  if (kind === 'db' && webview?.addEventListener && webview.releaseBuffer) listenDbBuffers(webview as SharedBufferHost, attach, (m) => pair.port2.postMessage(m));
  try {
    await invoke('mc_port_attach', { kind, channel, attach });
  } catch (error) {
    if ((error as { code?: string })?.code !== 'MC_NOT_YET') console.warn(`[mc] ${kind} port: ${String((error as Error)?.message ?? JSON.stringify(error))}`);
    return;
  }
  pair.port2.start();
  // Messages the host sends before the page takes the port wait in port2's queue.
  await whenPageLoaded();
  if (kind === 'db') await whenDbHostStarted();
  window.postMessage(`mc:${kind}-port`, '*', [pair.port1]);
}

/**
 * 1.1.4 posted a port at `did-finish-load` at the earliest, when the app's modules (dbClient.ts, redisClient.ts, sftp.ts)
 * already listened for it. This bridge runs in <head> before the module scripts: a port posted before they ran was lost
 * (the page then never got any DB / SFTP result).
 */
const pageLoaded = new Promise<void>((resolve) => {
  // The window's load event, as 1.1.4's did-finish-load: it comes after the deferred app bundle ran and added its 'message'
  // listeners. readyState turns 'interactive' before the module scripts run, so only 'complete' means the page is ready.
  if (document.readyState === 'complete') setTimeout(resolve, 0);
  else window.addEventListener('load', () => resolve(), { once: true });
});
function whenPageLoaded(): Promise<void> {
  return pageLoaded;
}

/**
 * 1.1.4 started the DB Host with the first session (db:connect, a connection test) and only then gave the windows their DB
 * port (again at every load while it ran). Here the host is part of the app, so the page takes the port when this window
 * sees its first db:session event, or at once when sessions are already open (a reload, a detached DB window).
 */
async function whenDbHostStarted(): Promise<void> {
  let started!: () => void;
  const seen = new Promise<void>((resolve) => { started = resolve; });
  const off = window.mc.on('db:session', () => started());
  try {
    const open = await window.mc.db.sessions().catch(() => null);
    if (!open?.sessions.length) await seen;
  } finally {
    off();
  }
}

/**
 * The pty port (P2): binary frames on the transport Rust picked (bridge/ptyPort.ts), handed to TerminalManager through a
 * port object (an event and window.__MC_PTY_PORT__) instead of a MessagePort, so every message is handled before it is
 * released.
 */
async function attachPtyPort(): Promise<void> {
  const session = newSession();
  const post = createPortPoster('pty', session, (args) => invoke('mc_port_post', args));
  let transport = 'channel';
  const port = createPtyPort({ post }, transport);
  const channel = new Channel<unknown>();
  channel.onmessage = (message) => port.deliver(message instanceof ArrayBuffer ? new Uint8Array(message) : message);
  const webview = (window as { chrome?: { webview?: Partial<SharedBufferHost> } }).chrome?.webview;
  // Listening before the attach: the host posts the replay tails right after it. Buffers are matched to this attach.
  if (webview?.addEventListener && webview.releaseBuffer) listenSharedBuffers(webview as SharedBufferHost, port, session);
  let result: { transport?: string } | null;
  try {
    result = await invoke<{ transport?: string } | null>('mc_port_attach', { kind: 'pty', channel, attach: session });
  } catch (error) {
    if ((error as { code?: string })?.code !== 'MC_NOT_YET') console.warn(`[mc] pty port: ${String((error as Error)?.message ?? JSON.stringify(error))}`);
    return;
  }
  transport = result?.transport ?? 'channel';
  port.stats.transport = transport;
  let stopped = false;
  window.addEventListener('pagehide', (e) => { if (!e.persisted) stopped = true; });
  if (transport === 'pull') void runPull(() => invoke<ArrayBuffer>('mc_port_pull', { kind: 'pty' }), port, () => stopped);
  window.__MC_PTY_PORT__ = port;
  window.dispatchEvent(new CustomEvent('mc:pty-port', { detail: port }));
}

void attachPtyPort();
for (const kind of ['sftp', 'db'] as const) void attachPort(kind);
