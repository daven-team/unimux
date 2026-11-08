// The real-app harness of every verify-*, perf-*, bench-* and capture script (PLAN X1, on top of F13's tauri-app.mjs).
//
// Target: the Tauri `check` build (npm run build:check). Every launch gets a scratch data dir and home from the script;
// nothing here ever reaches the real %APPDATA%\unimux, ~/.claude or ~/.codex.
//
// "Blocked by <package>": the check build records every window.mc command a page asked for that no package implements yet
// (MC_NOT_YET_LOG, written by test_record.rs as it happens). The UI calls a set of them at every launch (cli:status,
// usage:get, update:get ...: the startup baseline of real-app-baseline.mjs), so a failed script is blocked only by what it
// exercised itself (real-app-owners.mjs classifyRun): a test-bridge op a later package adds, a not-yet command outside the
// baseline, or a baseline command of a package the script tests (SCRIPT_PACKAGES). Then it prints
// `BLOCKED by W4 (notify), P4 (cell:spawn)` and exits with 2 instead of 1: not a regression, a package that has not landed.
// Any other failure stays a failure (exit 1), with the boot-time not-yet calls printed as info. MC_REAL_APP_REPORT=<file>
// also writes the result as JSON (scripts/real-app-run.mjs runs them all and collects these).
//
// Exit codes: 0 pass, 1 fail, 2 blocked.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedBaseline } from './real-app-baseline.mjs';
import { BRIDGE_OP_OWNERS, SCRIPT_PACKAGES, blockedBy, classifyRun, formatBlocked } from './real-app-owners.mjs';
import { appBinary, freePort, sleep } from './tauri-app.mjs';

export { appBinary, freePort, sleep };

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Electron target (MC_APP_TARGET=electron / --target=electron, the 1.1.4 reference) was removed with Electron (R1); a
// script that still asks for it fails right away instead of silently testing something else.
const legacyTarget = process.argv.find((a, i) => i > 1 && a.startsWith('--target=')) ?? (process.env.MC_APP_TARGET ? `MC_APP_TARGET=${process.env.MC_APP_TARGET}` : null);
if (legacyTarget && !/(^|=)tauri$/i.test(legacyTarget)) throw new Error(`${legacyTarget}: the Electron target was removed in 1.2.0; the harness runs the Tauri check build only`);
{
  const index = process.argv.findIndex((a, i) => i > 1 && a.startsWith('--target='));
  // Taken out, so a script's own positional arguments (a screenshot folder, the parts to run) never see it.
  if (index > 1) process.argv.splice(index, 1);
}
/** The app under test: always the Tauri check build (kept as names for the scripts written against both targets). */
export const APP_TARGET = 'tauri';
export const isTauri = true;

/** The version the app under test reports (its status bar): the one of tauri.conf.json. */
export function appVersion(checkout = ROOT) {
  return JSON.parse(readFileSync(join(checkout, 'src-tauri', 'crates', 'unimux-app', 'tauri.conf.json'), 'utf8')).version;
}

/** Throws with what to build when the app under test is missing. */
export function requireBuild() {
  appBinary();
}

/** A URL of an app page: `http://tauri.localhost/` (WebView2 may list it without index.html) or `tauri://localhost/` (WKWebView). */
export const isAppUrl = (url) => /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)\/(index\.html)?([?#]|$)/.test(url) || /\/index\.html([?#]|$)/.test(url);
/** A page of the app that is the main window (not a detached one, not DevTools). */
export const isMainPage = (t) => t.type === 'page' && isAppUrl(t.url) && !t.url.includes('detached=');

// ── not-yet logs and the exit report ─────────────────────────────────────────────────────────────────────────────────────
let reportDir = null;
let launches = 0;
const bridgeBlocks = new Map();
const children = [];

// The runner (real-app-run.mjs) names the folder, so it can still read the logs of a script it had to stop at its timeout.
const runnerLogDir = process.env.MC_REAL_APP_LOG_DIR || null;
function notYetLogPath() {
  if (!reportDir) {
    reportDir = runnerLogDir ?? mkdtempSync(join(tmpdir(), 'unimux-real-app-'));
    mkdirSync(reportDir, { recursive: true });
  }
  return join(reportDir, `not-yet-${process.pid}-${++launches}.log`);
}

/** The not-yet commands of every launch of this script so far (first seen first). */
export function notYetCommands() {
  if (!reportDir || !existsSync(reportDir)) return [];
  const seen = new Set();
  for (const file of readdirSync(reportDir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    for (const line of readFileSync(join(reportDir, file), 'utf8').split('\n')) if (line.trim()) seen.add(line.trim());
  }
  return [...seen];
}

/** A step that needs a package that has not landed (a test-bridge op it adds). Thrown by the main-side control. */
export class BlockedError extends Error {
  constructor(owner, what) {
    super(`blocked by ${owner}: ${what} is not in this check build yet`);
    this.name = 'BlockedError';
    this.owner = owner;
    if (!bridgeBlocks.has(owner)) bridgeBlocks.set(owner, new Set());
    bridgeBlocks.get(owner).add(what);
  }
}

/** Every package whose not-yet command or test-bridge op this run hit so far: [{owner, commands}] (not only the cause). */
export function blockers() {
  const groups = blockedBy(notYetCommands());
  for (const [owner, ops] of bridgeBlocks) {
    const group = groups.find((g) => g.owner === owner);
    if (group) group.commands.push(...ops);
    else groups.push({ owner, commands: [...ops] });
  }
  return groups.sort((a, b) => a.owner.localeCompare(b.owner, 'en', { numeric: true }));
}

let strict = false;
/**
 * For measurements (perf-*, bench-*, measure-startup): numbers taken while the app answered MC_NOT_YET mean nothing, so any
 * not-yet call makes the run "blocked" even when the script itself ended with 0.
 */
export function measurementNeedsCompleteApp() { strict = true; }

/**
 * The not-yet commands of a bare launch of the check build under test (real-app-baseline.mjs), null when they cannot be had.
 * Synchronous (the exit handler needs it): the cache of the current binary, else one bare launch in a child process.
 */
export function startupBaselineSync() {
  try {
    const cached = cachedBaseline();
    if (cached) return cached;
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'real-app-baseline.mjs')], { cwd: ROOT, stdio: 'ignore', windowsHide: true, timeout: 120000 });
    return cachedBaseline();
  } catch {
    return null;
  }
}

const script = basename(process.argv[1] ?? 'script');
process.on('exit', (code) => {
  // Our own app processes only (a script that ended in an exception may have left one).
  for (const child of children) if (child.exitCode === null && child.signalCode === null) killAppTree(child.pid);
  const notYet = notYetCommands();
  const bridge = [...bridgeBlocks].map(([owner, ops]) => ({ owner, commands: [...ops] }));
  // Only a failure with not-yet calls needs the baseline; a pass never waits for a bare launch.
  const baseline = notYet.length && code !== 0 ? startupBaselineSync() : null;
  const run = classifyRun({ code, strict, notYet, baseline, packages: SCRIPT_PACKAGES[script] ?? [], bridge });
  if (run.result === 'blocked') {
    console.log(`\nBLOCKED by ${formatBlocked(run.blocked)}`);
    process.exitCode = 2;
  } else if (run.seen.length) {
    const why = code === 0 ? '' : baseline ? ' (boot-time calls of the UI, not the cause)' : ' (no startup baseline: node scripts/real-app-baseline.mjs)';
    console.log(`\ninfo: not-yet commands during the run${why}: ${formatBlocked(run.seen)}`);
  }
  if (process.env.MC_REAL_APP_REPORT) {
    try {
      writeFileSync(process.env.MC_REAL_APP_REPORT, JSON.stringify({ script, target: APP_TARGET, code, result: run.result, blocked: run.blocked, seen: run.seen }, null, 1));
    } catch { /* the runner reports a missing file */ }
  }
  if (reportDir && !runnerLogDir) try { rmSync(reportDir, { recursive: true, force: true }); } catch { /* a log still open */ }
});

// ── launching ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Starts the app under test with `env` (the full environment: scripts build it from scrubAppEnv(process.env) plus the
 * scratch home, MC_DATA_DIR, MC_OFFSCREEN, MC_DEBUG_PORT). A key set to null removes an inherited variable.
 */
export function spawnApp({ env, args = [], cwd = ROOT, stdio = 'ignore' } = {}) {
  const e = { ...env };
  for (const [key, value] of Object.entries(e)) if (value === null || value === undefined) delete e[key];
  e.MC_NOT_YET_LOG = notYetLogPath();
  // OS notifications of a harness run go to the test bridge (`toasts`), never to the desktop (W4 honours it).
  e.MC_TEST_TOASTS = '1';
  const child = spawn(appBinary(), args, { cwd, env: e, windowsHide: true, stdio });
  children.push(child);
  return child;
}

/** Ends the process tree of an app this script started (unimux.exe and its children), nothing else. */
export function killAppTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

/**
 * The process tree of a process this script started (Windows): [{pid, ppid, name, workingSet}], the root first: unimux.exe,
 * its msedgewebview2.exe processes and the shells of the cells.
 */
export function processTree(pid) {
  if (process.platform !== 'win32') return [];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.WorkingSetSize)|$($_.Name)" }'], { encoding: 'utf8', windowsHide: true });
  const rows = out.split(/\r?\n/).filter(Boolean).map((line) => { const [p, pp, ws, name] = line.split('|'); return { pid: Number(p), ppid: Number(pp), workingSet: Number(ws), name }; });
  const tree = rows.filter((r) => r.pid === pid);
  for (let i = 0; i < tree.length; i++) for (const r of rows) if (r.ppid === tree[i].pid && r.pid !== r.ppid && !tree.includes(r)) tree.push(r);
  return tree;
}

/** Waits until the DevTools port lists the main window's page; returns that target. */
export async function waitForMainPage(port, { ms = 30000, child, match = isMainPage } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child && child.exitCode !== null) throw new Error(`the app exited (${child.exitCode}) before its window appeared`);
    try {
      const found = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(match);
      if (found) return found;
    } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('the app window did not appear');
}

/** Waits for the child to exit (true) or the timeout (false). */
export function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((res) => {
    const timer = setTimeout(() => res(false), ms);
    child.once('exit', () => { clearTimeout(timer); res(true); });
  });
}

/**
 * A normal quit of the app (its windows close, the state is saved) through the test bridge (`quit`), then our own tree kill
 * for anything left. `evaluate`: of the main page.
 */
export async function quitApp({ child, evaluate, ms = 10000 }) {
  const tree = treePids(child);
  await bridgeCall(evaluate, 'quit').catch(() => undefined);
  const exited = await waitForExit(child, ms);
  if (!exited) killAppTree(child.pid);
  await waitForPidsGone(tree, 5000);
  return exited;
}

const treePids = (child) => { try { return processTree(child.pid).map((p) => p.pid); } catch { return [child.pid]; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * Waits until the processes of a tree we started (listed before it was told to end) are gone; whatever is left after `ms` (a
 * WebView2 browser process that outlived its parent) is ended by pid. Afterwards nothing of ours holds the scratch folder.
 */
async function waitForPidsGone(pids, ms) {
  const t0 = Date.now();
  while (pids.some(alive) && Date.now() - t0 < ms) await sleep(100);
  for (const pid of pids.filter(alive)) killAppTree(pid);
  const t1 = Date.now();
  while (pids.some(alive) && Date.now() - t1 < 3000) await sleep(100);
}

/** Ends the process tree of an app this script started and waits until all of it is gone (scratch folders can go then). */
export async function killAppTreeAndWait(child, ms = 10000) {
  if (!child?.pid) return;
  const tree = treePids(child);
  killAppTree(child.pid);
  await waitForExit(child, ms);
  await waitForPidsGone(tree, ms);
}

// ── the main-side control (replaces 1.1.4's mainInspector) ───────────────────────────────────────────────────────────────
/** Calls a test-bridge op through the main page; an op this check build does not know throws BlockedError(owner). */
export async function bridgeCall(evaluate, op, args = null) {
  const r = await evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args })}).then((value) => ({ ok: true, value }), (e) => ({ ok: false, message: String(e?.message ?? e), code: e?.code ?? null }))`);
  if (r.ok) return r.value;
  if (/unknown op/.test(r.message) && BRIDGE_OP_OWNERS[op]) throw new BlockedError(BRIDGE_OP_OWNERS[op], `test-bridge ${op}`);
  throw new Error(`test_bridge ${op}: ${r.message}`);
}

/**
 * The app-process side of a running app, over the test bridge of the check build:
 *   hook(cellId, event, info?)   a status hook to the main window (`cell:hook`), hookAll(...) to every window
 *   emit(event, args, {label?})  any renderer event
 *   windows()                    [{label, visible, minimized}] of the app windows, main first
 *   requestClose()               a click on the main window's close button (the quit question may keep it)
 *   minimize()                   a click on its minimize button; setBounds({x, y, width, height}) in DIP
 *   record(channels, {swallow})  record the renderer's calls of these channels (swallow: answer them without running)
 *   recorded(channel?)           the recorded calls [{channel, args}] since the last read
 *   stubToasts() / toasts() / toastClick(i) / toastAction(i, action)   the OS notifications the app shows (W4 adds them);
 *                                stubToasts keeps what was shown since the launch (every harness launch routes toasts to
 *                                the list from the start), so a toast at startup is still seen
 *   stubTaskbar() / taskbar()    record the taskbar overlay / progress calls, read them (W7 adds them)
 * `evaluate`: of the main page.
 */
export async function mainControl({ evaluate }) {
  const call = (op, args) => bridgeCall(evaluate, op, args);
  const toArgs = (cellId, event, info) => [cellId, event, ...(info === undefined ? [] : [info])];
  return {
    bridge: call,
    hook: (cellId, event, info) => call('emit', { event: 'cell:hook', args: toArgs(cellId, event, info), label: 'main' }),
    hookAll: (cellId, event, info) => call('emit', { event: 'cell:hook', args: toArgs(cellId, event, info) }),
    emit: (event, args = [], { label } = {}) => call('emit', { event, args, ...(label ? { label } : {}) }),
    windows: () => call('windows'),
    requestClose: () => call('window', { label: 'main', action: 'requestClose' }),
    minimize: () => call('window', { label: 'main', action: 'sysMinimize' }),
    setBounds: (bounds) => call('window', { label: 'main', action: 'setBounds', ...bounds }),
    record: (channels, { swallow = false } = {}) => call('record', { channels, swallow }),
    recorded: async (channel) => (await call('recorded', { take: true, ...(channel ? { channel } : {}) })).map((c) => ({ channel: c.channel, args: c.args })),
    stubToasts: () => call('toasts', { stub: true }),
    toasts: () => call('toasts'),
    toastClick: (index) => call('toastAction', { index, action: 'click' }),
    toastAction: (index, actionIndex) => call('toastAction', { index, action: actionIndex }),
    stubTaskbar: () => call('taskbar', { stub: true }),
    taskbar: () => call('taskbar'),
    evaluateMain: () => { throw new Error('evaluateMain was the Electron main inspector (removed in R1): use a test-bridge op'); },
    close: () => {},
  };
}

/** The scratch screenshots folder of the checks (outside the repo). */
export const SHOTS = process.env.MC_SHOTS_DIR ?? (process.platform === 'win32' ? 'D:\\Projekty\\_shots' : join(tmpdir(), 'unimux-shots'));
export function ensureShots() { mkdirSync(SHOTS, { recursive: true }); return SHOTS; }
