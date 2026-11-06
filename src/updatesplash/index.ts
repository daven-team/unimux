/**
 * Detached update window. It runs from a private copy of the Electron runtime so the installer can
 * replace the installed app while this window keeps showing what is happening.
 */
import { spawn } from 'child_process';
import { app, BrowserWindow, ipcMain } from 'electron';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { safeSend } from '../main/safeWindow';
import { closeAction, UpdateProgressModel, type UpdateSplashConfig, type UpdateStage } from '../shared/updateProgress';

// The installer replaces resources/app.asar while this window is alive: reading an archive as a file (directoryBytes
// stats the install dir) would make Electron keep it open without delete sharing and block the installer.
process.noAsar = true;

const configPath = process.argv.find((arg) => arg.startsWith('--update-config='))?.slice('--update-config='.length);
if (!configPath) app.exit(2);
const config: UpdateSplashConfig = JSON.parse(readFileSync(configPath!, 'utf8'));

app.setPath('userData', join(config.workDir, 'splash-profile'));
app.commandLine.appendSwitch('lang', 'en-US');
app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.exit(0);

const TICK_MS = 250;
const SIZE_EVERY_MS = 1000;
const FINISH_DELAY_MS = 1100;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Total size of a directory tree; unreadable entries are skipped because the installer is rewriting it. */
function directoryBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        const info = statSync(path);
        if (info.isDirectory()) stack.push(path); else total += info.size;
      } catch { /* removed or locked mid-install */ }
    }
  }
  return total;
}

let win: BrowserWindow | null = null;
let finished = false;
let currentStage: UpdateStage = 'preparing';
let lastPercent = 0;
let ending = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const HIDE_NOTE_MS = 2200;
const HEARTBEAT_EVERY_MS = 1000;

function push(stage: UpdateStage, percent: number, message: string, extra: Record<string, unknown> = {}): void {
  safeSend(win, 'update-splash:state', { stage, percent, message, ...extra });
}

/**
 * X, Escape and Alt+F4. The installer is already running independently of this window, so while work is in
 * flight closing only hides the window (after a short note); it is shown again if the update runs into trouble.
 */
function requestClose(): void {
  if (closeAction(currentStage) === 'exit') { cleanupAndExit(); return; }
  if (hideTimer || !win || win.isDestroyed()) return;
  push(currentStage, lastPercent, config.strings.background, { closable: false });
  hideTimer = setTimeout(() => { hideTimer = undefined; if (!finished && win && !win.isDestroyed()) win.hide(); }, HIDE_NOTE_MS);
}

/** Once this window stops supervising (error, open, exit) the app must not treat the update as still running. */
function dropHeartbeat(): void {
  try { rmSync(config.heartbeatFlag, { force: true }); } catch { /* it goes stale within seconds anyway */ }
}

function cleanupAndExit(): void {
  dropHeartbeat();
  // The runtime copy is locked while this process lives. A GUI-subsystem Electron in node mode removes it
  // afterwards without ever creating a console window (no shell involved). It starts outside the copy: a working directory
  // inside it would keep the emptied folder itself locked.
  try {
    const script = `setTimeout(()=>{try{require('fs').rmSync(${JSON.stringify(config.runtimeDir)},{recursive:true,force:true,maxRetries:10,retryDelay:500})}catch{}},3000)`;
    spawn(config.appExe, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true, cwd: tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref();
  } catch { /* the app removes leftovers on its next start */ }
  app.exit(0);
}

function run(): void {
  const started = Date.now();
  const baseline = directoryBytes(config.installDir);
  const model = new UpdateProgressModel(baseline);
  let dirBytes: number | undefined;
  let sampling = false;
  let lastSample = 0;
  let timedOut = false;
  let lastBeat = 0;
  const { strings } = config;

  const timer = setInterval(() => {
    if (finished) return;
    const elapsedMs = Date.now() - started;
    const closed = !alive(config.oldPid);
    if (closed && !sampling && elapsedMs - lastSample >= SIZE_EVERY_MS) {
      sampling = true; lastSample = elapsedMs;
      setImmediate(() => { dirBytes = directoryBytes(config.installDir); sampling = false; });
    }
    // The app checks this to know a splash is still supervising an installer, however long that takes.
    if (elapsedMs - lastBeat >= HEARTBEAT_EVERY_MS) {
      lastBeat = elapsedMs;
      try { writeFileSync(config.heartbeatFlag, String(Date.now())); } catch { /* best effort */ }
    }
    if (existsSync(config.abortFlag)) { finished = true; clearInterval(timer); cleanupAndExit(); return; }
    const installed = existsSync(config.installedFlag);
    const ready = existsSync(config.readyFlag);
    const { stage, percent, note } = model.update({ elapsedMs, closed, installed, ready, dirBytes });
    currentStage = stage; lastPercent = percent;

    if (stage === 'done') {
      finished = true; clearInterval(timer);
      push('done', 100, strings.done);
      setTimeout(cleanupAndExit, FINISH_DELAY_MS);
      return;
    }
    if (elapsedMs > config.timeoutMs) {
      if (!timedOut) {
        timedOut = true; clearInterval(timer); currentStage = 'error'; dropHeartbeat();
        clearTimeout(hideTimer); hideTimer = undefined;
        if (win && !win.isDestroyed()) { win.showInactive(); win.flashFrame(true); }
        push('error', percent, strings.slow, { detail: strings.slowHint });
      }
      return;
    }
    // While the close note is up it must not be overwritten by the next tick.
    if (hideTimer) return;
    // Say what the stage is really waiting for instead of showing a frozen percentage.
    push(stage, percent, note ? strings[note] : strings.stages[stage as keyof typeof strings.stages] ?? '');
  }, TICK_MS);
}

ipcMain.on('update-splash:close', requestClose);
ipcMain.on('update-splash:open', () => {
  dropHeartbeat();
  try { spawn(config.appExe, [], { detached: true, stdio: 'ignore', cwd: config.installDir }).unref(); } catch { /* nothing else to try */ }
  cleanupAndExit();
});
ipcMain.handle('update-splash:init', () => ({
  title: config.strings.title, hint: config.strings.hint, fromVersion: config.fromVersion, version: config.version,

  open: config.strings.open, close: config.strings.close,
}));

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 440, height: 200, resizable: false, maximizable: false, minimizable: true, fullscreenable: false,
    frame: false, show: false, center: true, alwaysOnTop: false, backgroundColor: '#0d0d0d', title: 'unimux',
    icon: join(__dirname, '../ui/icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/updatesplash.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setMenu(null);
  // A closing session (logout, shutdown) must be able to close this window.
  win.on('session-end', () => { ending = true; });
  win.on('close', (e) => { if (!finished && !ending && closeAction(currentStage) === 'hide') { e.preventDefault(); requestClose(); } });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => {
    // Shown without taking the focus: a game or a full-screen app the user is in stays in front (and is not minimized);
    // the window waits behind it, and the taskbar button flashes once so the update is not missed.
    win?.showInactive();
    win?.flashFrame(true);
    try { writeFileSync(config.shownFlag, String(Date.now())); } catch { /* the app only waits a few seconds for this */ }
    run();
  });
  void win.loadFile(join(__dirname, '../ui/index.html'));
});
app.on('before-quit', () => { ending = true; });
app.on('window-all-closed', () => { if (!finished) cleanupAndExit(); });
