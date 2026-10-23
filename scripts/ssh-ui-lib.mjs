// Helpers for real-app SSH checks: scratch data dirs and homes, the local test SSH server, the built app over CDP.
// Never uses the user's data dir, home, ~/.ssh or real hosts. Kills only the PIDs it started.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import electron from 'electron';
import { scrubAppEnv } from './app-env.mjs';

export const SHOTS = 'D:\\Projekty\\_shots';
/** Scratch dirs live outside the repo, next to it: D:\Projekty\_tmp-ssh-<name>-<rand>. */
export const SCRATCH = 'D:\\Projekty';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const killTree = (pid) => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
};
/** Direct children of a process this script started whose command line contains `match` (Windows only). */
export function childPids(pid, match) {
  if (process.platform !== 'win32') throw new Error('childPids is Windows only');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).filter((line) => line.includes(match)).map((line) => Number(line.split(' ')[0])).filter(Boolean);
}
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** A fresh scratch root with data\, project\ and a scratch home (home\AppData\Roaming, home\AppData\Local: Electron needs both). */
export function scratchRoot(name) {
  const root = mkdtempSync(join(SCRATCH, `_tmp-ssh-${name}-`));
  for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

const rowLayout = (n) => ({ cols: n, rows: 1, areas: Array.from({ length: n }, (_, i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) });

/** UI language of the checks: Polish by default, SSH_CHECK_LANGUAGE=en for the English pass. */
export const LANGUAGE = process.env.SSH_CHECK_LANGUAGE ?? 'pl';

/** A minimal state.json: UI in LANGUAGE (no onboarding), one project, optional hosts and one tab of SSH cells (hostIds). */
export function sshState({ projectPath, hosts = [], cells = [] }) {
  const projectId = randomUUID();
  const tabs = cells.length ? [{ id: randomUUID(), name: 'SSH', color: '#60a5fa', layout: rowLayout(cells.length), cells: cells.map((hostId) => ({ id: randomUUID(), profileId: 'shell', ssh: { hostId } })) }] : [];
  return { version: 1, settings: { language: LANGUAGE }, sshHosts: hosts, activeProjectId: projectId,
    projects: [{ id: projectId, name: 'ssh-check', path: projectPath, color: '#3b82f6', tabs, archive: [], activeTabId: tabs[0]?.id ?? null }] };
}

/** Pre-trusts the test server's host key in a scratch data dir (format of src/main/ssh/knownHosts.ts), so a grid connects without the host key card. */
export function writeKnownHost(root, server) {
  const blob = Buffer.from(server.hostKey, 'base64');
  const keyType = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('latin1');
  const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  mkdirSync(join(root, 'data', 'ssh'), { recursive: true });
  writeFileSync(join(root, 'data', 'ssh', 'known_hosts.json'), JSON.stringify({ version: 1, entries: [{ id: randomUUID(), host: '127.0.0.1', port: server.port, keyType, key: server.hostKey, fingerprint, addedAt: 0 }] }));
}

export const testHost = (port, patch = {}) => ({ id: randomUUID(), label: 'test-server', address: '127.0.0.1', port, username: 'alice', createdAt: 0, updatedAt: 0, ...patch });
export const writeState = (root, state) => writeFileSync(join(root, 'data', 'state.json'), JSON.stringify(state, null, 1));

/** scripts/ssh-test-server.mjs on 127.0.0.1: resolves to its JSON line plus stop(). */
export async function startTestServer(args = []) {
  const child = spawn(process.execPath, ['scripts/ssh-test-server.mjs', ...args], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('test server did not start')), 20000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`test server exited (${code})`)); });
    child.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); } });
  });
  return { ...info, stop: () => killTree(child.pid) };
}

/** CDP of the main process (Node inspector): evaluates with the app's own electron module. */
export async function mainInspector(port) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0]; } catch { await sleep(200); }
  }
  if (!target) throw new Error('main inspector not reachable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (m) => (m.error || m.result.exceptionDetails ? reject(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails))) : resolve(m.result.result.value)));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  await evaluate(`globalThis.__el = process.mainModule.require('electron'); globalThis.__notes = [];
    __el.ipcMain.on('notify', (_e, n) => __notes.push(n)); true`);
  return {
    evaluate,
    hook: (cellId, event) => evaluate(`__el.BrowserWindow.getAllWindows()[0].webContents.send('cell:hook', ${JSON.stringify(cellId)}, ${JSON.stringify(event)}), true`),
    notes: () => evaluate('__notes.splice(0)'),
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
}

export async function launchApp(root, extraEnv = {}, extraArgs = []) {
  const port = await freePort();
  const home = join(root, 'home');
  // Login variables of the real user are dropped first; extraEnv may still point them at a fake home.
  const env = {
    ...scrubAppEnv({ ...process.env }), MC_DATA_DIR: join(root, 'data'), MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port),
    // Never the real profile: the app reads ~/.claude and ~/.codex, Electron its appData.
    USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    ...extraEnv,
  };
  // A key set to null in extraEnv removes an inherited variable.
  for (const [key, value] of Object.entries(env)) if (value === null) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = spawn(electron, [...extraArgs, '.'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch { /* starting */ }
  }
  if (!target) { killTree(child.pid); throw new Error(`the app window did not appear\n${stderr}`); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, label, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await evaluate(expression).catch(() => false)) return; await sleep(150); }
    throw new Error(`timeout: ${label}`);
  };
  const click = (selector, text) => evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});
    if (!el) throw new Error(${JSON.stringify(`not found: ${selector} ${text ?? ''}`)});
    el.click(); return true; })()`);
  /** Sets the value of a React-controlled input or textarea. */
  const setValue = (selector, value) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error(${JSON.stringify(`not found: ${selector}`)});
    el.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const press = async (key, modifiers = 0) => {
    const codes = { Enter: 13, Escape: 27, ArrowUp: 38 };
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key] ?? 0, modifiers, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
  };
  const insertText = (text) => cdp('Input.insertText', { text });
  /** Screenshots of a non-Polish pass get a language suffix: ssh-cell-idle-en.png. */
  const screenshot = async (name) => {
    if (LANGUAGE !== 'pl') name = name.replace(/\.png$/, `-${LANGUAGE}.png`);
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
  };
  const close = async () => { try { ws.close(); } catch { /* closed */ } killTree(child.pid); await sleep(800); };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await until(`!!document.querySelector('.app .workspace-tabs')`, 'app ready');
  return { pid: child.pid, cdp, evaluate, until, click, setValue, press, insertText, screenshot, close };
}

/**
 * Waits until `count` SSH cells are connected (M1): no card and no phase label in any of them.
 * A failed sign-in shows the card and a phase label, so it never passes as "connected".
 */
export async function connected(app, count = 1, ms = 20000) {
  await app.until(`(() => {
    const cells = [...document.querySelectorAll('.cell')].filter((c) => c.querySelector('.cell-head .ssh-host'));
    return cells.length >= ${count} && cells.every((c) => !c.querySelector('.ssh-card') && !c.querySelector('.status-text.ssh'));
  })()`, `${count} SSH cell(s) connected`, ms);
}

/** Answers the password prompt of the first SSH cell that shows one (L22), optionally ticking "Zapisz hasło". */
export async function connectWithPassword(app, password, { save = false } = {}) {
  await app.until(`!!document.querySelector('.ssh-card input[type=password]')`, 'password prompt');
  await app.setValue('.ssh-card input[type=password]', password);
  if (save) await app.click('.ssh-card label.check input');
  await app.click('.ssh-card button[type=submit]');
}
