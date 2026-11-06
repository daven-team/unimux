// Real-app harness of the Tauri build (1.2.0, PLAN F13): start the `check` build (release profile with the dev-overrides and
// test-bridge features) on a scratch data dir and a scratch home, drive it over the WebView2 DevTools protocol, and end only
// the processes it started. Never the real %APPDATA%\unimux, ~/.claude or ~/.codex.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchHome, scrubAppEnv } from './app-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The check build (npm run build:check: release profile + dev-overrides + test-bridge, in src-tauri/target/check). Never the
 * release flavour in target/release: it ignores MC_DATA_DIR and would run on the real profile. MC_APP_BINARY overrides.
 */
export function appBinary() {
  if (process.env.MC_APP_BINARY) return process.env.MC_APP_BINARY;
  const file = join(root, 'src-tauri', 'target', 'check', 'release', process.platform === 'win32' ? 'unimux.exe' : 'unimux');
  if (existsSync(file)) return file;
  throw new Error('no check build found: run `npm run build:check` first');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((res, rej) => {
    const server = createServer();
    server.unref();
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
}

/** Starts the app; `dataDir` and `scratch` (a root for the scratch home) must exist. */
export function launchApp({ dataDir, scratch, port, offscreen = true, extraEnv = {} }) {
  const { env: homeEnv } = scratchHome(scratch);
  const env = scrubAppEnv({ ...process.env, ...homeEnv, MC_DATA_DIR: dataDir, ...(port ? { MC_DEBUG_PORT: String(port) } : {}), ...(offscreen ? { MC_OFFSCREEN: '1' } : {}), ...extraEnv });
  // Never inherit and pipe at once: everything is ignored (the app logs to crash.log).
  const child = spawn(appBinary(), [], { env, stdio: 'ignore', windowsHide: true });
  return child;
}

/** Waits for the child to exit (resolves to its code) or the timeout (resolves to null). */
export function waitExit(child, ms) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((res) => {
    const timer = setTimeout(() => res(null), ms);
    child.once('exit', (code) => { clearTimeout(timer); res(code); });
  });
}

/** Ends the process tree we started (unimux.exe and its msedgewebview2.exe children), never anything else. */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** A minimal DevTools protocol client for the app page (`match`: a target id, for pages that are not the Tauri app). */
export async function connectPage(port, { timeoutMs = 30000, match } = {}) {
  const deadline = Date.now() + timeoutMs;
  let target;
  while (!target) {
    if (Date.now() > deadline) throw new Error(`no app page on the DevTools port ${port}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => (match ? t.id === match : t.type === 'page' && /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)\/(index\.html)?(\?|#|$)/.test(t.url) && !t.url.includes('detached=')));
    } catch { /* not up yet */ }
    if (!target) await sleep(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  // A page that goes away (quit, crash) rejects what is still waiting instead of leaving it unsettled.
  ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('DevTools connection closed')); pending.clear(); };
  const send = (method, params = {}) => new Promise((res, rej) => {
    if (ws.readyState !== WebSocket.OPEN) { rej(new Error('DevTools connection closed')); return; }
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { target, send, evaluate, onEvent: (l) => listeners.push(l), close: () => ws.close() };
}

/** Polls `expression` in the page until it is truthy. */
export async function waitFor(page, expression, timeoutMs = 30000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await page.evaluate(expression); if (v) return v; } catch { /* page reloading */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

/**
 * Isolation test: files only the Tauri build would create in the REAL profile (the installed Electron app and the user's own
 * Claude Code / Codex keep changing %APPDATA%\unimux, ~/.claude and ~/.codex while a check runs, so their contents cannot be
 * compared). Each entry is `path size mtime`; the list must be the same before and after a run.
 */
export function realProfileMarkers() {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const real = join(appData, 'unimux');
  const markers = [
    join(real, 'instance.lock'), join(real, 'webview2'), join(real, 'webview-import.json'), join(real, 'migrated-from.json'),
    join(localAppData, 'com.unimux.app'), join(localAppData, 'com.unimux.app.dev'), join(localAppData, 'unimux'),
    join(home, '.claude', 'unimux-tauri'), join(home, '.codex', 'unimux-tauri'),
  ];
  return markers.filter((p) => existsSync(p)).map((p) => { const s = statSync(p); return `${p} ${s.size} ${Math.round(s.mtimeMs)}`; });
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const readText = (file) => readFileSync(file, 'utf8');
export const listDir = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
