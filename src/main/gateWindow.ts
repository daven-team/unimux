import { app, BrowserWindow, ipcMain } from 'electron';
import { windowIcon } from './appIcon';
import { join } from 'path';
import type { UpdateStage } from '../shared/updateProgress';
import type { GateView } from './startupGate';
import { isFromWindow, safeSend } from './safeWindow';
import { createIpcGuard } from './ipcGuard';

export interface GateTexts {
  checking: string;
  downloading: string;
  /** Title of the update, with the version filled in. */
  updating: (version: string) => string;
  hint: string;
  preparing: string;
  failed: string;
  close: string;
  /** Title of the 'ask' prompt, with the new version filled in. */
  available: (version: string) => string;
  askMessage: string;
  askHint: string;
  install: string;
  later: string;
}

interface SplashState {
  stage: UpdateStage; percent: number; message: string; title?: string; versions?: string; hint?: string; closable?: boolean;
  /** Labels of the two buttons of the 'ask' prompt. */
  primary?: string; secondary?: string;
}

/** Maps what the startup check is doing to what the update window shows. */
export function gateState(view: GateView, texts: GateTexts, currentVersion: string): SplashState {
  switch (view.kind) {
    case 'checking':
      return { stage: 'checking', percent: 0, message: '', title: texts.checking, versions: currentVersion, hint: '', closable: true };
    case 'ask':
      return { stage: 'ask', percent: 0, message: texts.askMessage, title: texts.available(view.version), versions: `${currentVersion} → ${view.version}`, hint: texts.askHint, closable: true, primary: texts.install, secondary: texts.later };
    case 'downloading':
      return { stage: 'downloading', percent: view.percent, message: texts.downloading, title: texts.updating(view.version), versions: `${currentVersion} → ${view.version}`, hint: texts.hint, closable: true };
    // From here the installer is being started and the window cannot be cancelled any more.
    case 'installing':
      return { stage: 'downloading', percent: 100, message: texts.preparing, title: texts.updating(view.version), versions: `${currentVersion} → ${view.version}`, hint: texts.hint, closable: false };
    case 'failed':
      return { stage: 'failed', percent: 0, message: texts.failed, title: texts.updating(view.version), versions: `${currentVersion} → ${view.version}`, hint: '', closable: false };
  }
}

/**
 * The update window shown inside the app process while the startup check runs. It reuses the page of the
 * detached update window; the detached one takes over (same size and place) when the installer starts.
 */
export function createGateWindow(texts: GateTexts, currentVersion: string): { show(view: GateView): void; hide(): void; onCancel(cancel: () => void): void; onInstall(install: () => void): void } {
  let win: BrowserWindow | null = null;
  let latest: SplashState | undefined;
  let loaded = false;

  let cancel: (() => void) | undefined;
  let install: (() => void) | undefined;
  /** True while `hide()` destroys the window itself, so its 'closed' event is not mistaken for a crash. */
  let closing = false;
  const push = () => { if (loaded && latest) safeSend(win, 'update-splash:state', latest); };
  /** The user closed the window (X, Escape, Alt+F4); the gate decides whether that is still allowed. */
  const requestClose = () => { if (latest?.closable) cancel?.(); };
  /** "Install now" of the 'ask' prompt; ignored at any other stage. */
  const requestInstall = () => { if (latest?.stage === 'ask') install?.(); };

  // The gate window's own channels answer only the gate window itself (R9); the main window never uses them.
  const { guardedHandle, guardedOn } = createIpcGuard(ipcMain, (event) => isFromWindow(win, event));

  const create = () => {
    ipcMain.removeHandler('update-splash:init');
    guardedHandle('update-splash:init', () => ({
      title: latest?.title ?? '', hint: latest?.hint ?? '', fromVersion: currentVersion, version: '', state: latest, open: '', close: texts.close,
    }), () => null);
    win = new BrowserWindow({
      width: 440, height: 200, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      frame: false, show: false, center: true, alwaysOnTop: true, backgroundColor: '#0d0d0d', title: 'unimux',
      icon: windowIcon(),
      ...(!app.isPackaged && process.env.MC_OFFSCREEN ? { x: -6000, y: 0, skipTaskbar: true, focusable: false } : {}),
      webPreferences: { preload: join(__dirname, '../preload/updatesplash.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenu(null);
    ipcMain.removeAllListeners('update-splash:close');
    guardedOn('update-splash:close', requestClose);
    ipcMain.removeAllListeners('update-splash:open');
    guardedOn('update-splash:open', requestInstall);
    win.on('close', (e) => { if (latest?.closable) { e.preventDefault(); requestClose(); } });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Closed by the user: forget the window so the next update shows a new one.
    const created = win;
    created.once('closed', () => {
      if (win !== created) return;
      win = null; loaded = false;
      // Gone without `hide()` (crashed or destroyed): nobody could answer the prompt, so start the current version.
      if (!closing) cancel?.();
    });
    // A window that cannot render must never leave the app waiting for an answer nobody can give.
    win.webContents.on('render-process-gone', () => cancel?.());
    win.webContents.on('did-fail-load', (_e, code, _d, _u, isMainFrame) => { if (isMainFrame && code !== -3) cancel?.(); });
    win.webContents.on('did-finish-load', () => { loaded = true; push(); });
    win.once('ready-to-show', () => { if (!app.isPackaged && process.env.MC_OFFSCREEN) win?.showInactive(); else win?.show(); });
    void win.loadFile(join(app.getAppPath(), 'resources', 'update-splash', 'index.html'));
  };

  return {
    show(view) {
      latest = gateState(view, texts, currentVersion);
      if (!win) create(); else push();
    },
    onCancel(callback) { cancel = callback; },
    onInstall(callback) { install = callback; },
    hide() {
      ipcMain.removeHandler('update-splash:init');
      ipcMain.removeAllListeners('update-splash:close');
      ipcMain.removeAllListeners('update-splash:open');
      closing = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } finally { closing = false; }
      win = null;
      loaded = false;
    },
  };
}
