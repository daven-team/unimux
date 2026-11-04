// Performance benchmark of the built app (Windows only; run `npm run build` first). Re-runnable, prints one JSON per run and,
// with --compare, a before/after table of two saved runs.
// Every launch uses a fresh scratch data dir and home next to the repo (never the real %APPDATA%\unimux, ~/.claude or ~/.codex)
// and kills only the PIDs it started.
//   startup - `runs` cold launches of a 4x3 grid of cmd cells: the marks of startup.log (ms since process start) and the wall
//             time until the window's page exists and until every cell's terminal shows its prompt (an interactive grid).
//   idle    - `cells` cmd cells at their prompt in a git project, sidebar open: CPU of every process type, renderer timers and
//             animation frames by call site, React commits, IPC messages between main and the window by channel, state file
//             writes, CDP Performance metrics (style recalcs, layouts, task time per second).
//   hooks   - half of the cells get agent hook events (a turn, then a tool call start or end every 100 ms): the same numbers.
//   busy    - the same cells each print about 60 colored lines a second: the same numbers plus long tasks.
//   memory  - after the busy phase and a GC: renderer JS heap, DOM nodes and the private memory of every process; then a tab of
//             4 cells is opened and closed `cycles` times: what stays behind (leaks of closed cells).
// Usage: node scripts/bench-perf.mjs [--cells=16] [--seconds=15] [--runs=3] [--startup-cells=12] [--cycles=5] [--only=startup,idle,hooks,busy,memory] [--profile] [--sites]
//          [--out=file.json]
//        node scripts/bench-perf.mjs --compare=before.json,after.json
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import electron from 'electron';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { killTree, launchApp, sleep } from './ssh-ui-lib.mjs';

const opt = (name, fallback) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : fallback; };

// ---------------------------------------------------------------- compare
const compare = opt('compare');
if (compare) {
  const [a, b] = compare.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const flat = (o, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
      else if (typeof v === 'number') out[key] = v;
    }
    return out;
  };
  const fa = flat(a.summary);
  const fb = flat(b.summary);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])];
  const w = Math.max(...keys.map((k) => k.length));
  console.log(`${'metric'.padEnd(w)}  ${'before'.padStart(10)}  ${'after'.padStart(10)}  change`);
  for (const k of keys) {
    const x = fa[k];
    const y = fb[k];
    const change = x !== undefined && y !== undefined && x !== 0 ? `${(((y - x) / Math.abs(x)) * 100).toFixed(0)} %` : '';
    console.log(`${k.padEnd(w)}  ${String(x ?? '-').padStart(10)}  ${String(y ?? '-').padStart(10)}  ${change}`);
  }
  process.exit(0);
}

if (process.platform !== 'win32') throw new Error('bench-perf is Windows only');
const cells = Number(opt('cells', 16));
const seconds = Number(opt('seconds', 15));
const runs = Number(opt('runs', 3));
const cycles = Number(opt('cycles', 5));
const only = new Set(opt('only', 'startup,idle,hooks,busy,memory').split(','));
const outFile = opt('out');
/** --profile: a CPU profile of the renderer in every phase (top functions by self time; it costs some CPU of its own). */
const profile = process.argv.includes('--profile');
const SCRATCH = 'D:\\Projekty';
const BASE_ENV = { MC_CLI_NO_REGISTRY: '1' };

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const median = (values) => { const v = values.filter((x) => typeof x === 'number').sort((p, q) => p - q); if (!v.length) return null; return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
const grid = (n, cols) => ({ cols, rows: Math.max(1, Math.ceil(n / cols)), areas: Array.from({ length: n }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 })) });

function scratch(name) {
  const root = mkdtempSync(join(SCRATCH, `_tmp-bench-${name}-`));
  for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

function writeGridState(root, n, extra = {}) {
  const layout = grid(n, 4);
  writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
    version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Bench', path: join(root, 'project'), color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
      id: 't', name: 'Grid', layout, cells: layout.areas.map((_, i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
    }] }],
    profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
    snippets: [], presets: [], settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'visible' },
    sidebarCollapsed: false, ...extra,
  }));
}

const result = { cells, seconds, at: new Date().toISOString(), summary: {} };

// ---------------------------------------------------------------- startup
/** True once every cell's terminal has a non-empty line (cmd printed its prompt). */
const GRID_READY = (n) => `(() => { const mc = window.__mc; if (!mc) return false; let ok = 0;
  for (let i = 0; i < ${n}; i++) { const t = mc.terminals.xterm('c' + i); if (!t) return false; const b = t.buffer.active;
    for (let y = 0; y < b.length; y++) { if (b.getLine(y)?.translateToString(true).trim()) { ok++; break; } } }
  return ok === ${n}; })()`;

async function startupOnce(n) {
  const root = scratch('start');
  writeGridState(root, n);
  const { env: homeEnv } = scratchHome(root);
  const port = await freePort();
  const env = { ...scrubAppEnv({ ...process.env }), ...homeEnv, ...BASE_ENV, MC_DATA_DIR: join(root, 'data'), MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port) };
  const t0 = performance.now();
  const child = spawn(electron, ['.'], { cwd: process.cwd(), env, windowsHide: true, stdio: 'ignore' });
  const out = {};
  try {
    let target;
    while (!target && performance.now() - t0 < 30000) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch { /* starting */ }
      if (!target) await sleep(25);
    }
    if (!target) throw new Error('no window');
    out.wallPageMs = Math.round(performance.now() - t0);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
    const ev = (expression) => new Promise((resolve) => { const i = ++id; pending.set(i, (m) => resolve(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
    while (performance.now() - t0 < 40000) {
      if (await ev(GRID_READY(n))) { out.wallGridReadyMs = Math.round(performance.now() - t0); break; }
      await sleep(25);
    }
    ws.close();
    const log = join(root, 'data', 'startup.log');
    for (let i = 0; i < 40; i++) {
      if (existsSync(log) && /first-output=/.test(readFileSync(log, 'utf8'))) break;
      await sleep(100);
    }
    const line = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').at(-1) : '';
    for (const m of line.matchAll(/([a-z-]+)=(\d+)/g)) out[m[1]] = Number(m[2]);
  } finally {
    killTree(child.pid);
    await sleep(1000);
    removeScratch(root);
  }
  return out;
}

if (only.has('startup')) {
  const n = Number(opt('startup-cells', 12));
  await startupOnce(n).catch(() => null); // warm-up (disk cache), not counted
  const list = [];
  for (let i = 0; i < runs; i++) {
    const r = await startupOnce(n);
    console.error(`startup ${i + 1}: ${JSON.stringify(r)}`);
    list.push(r);
  }
  result.startup = list;
  const keys = ['modules-loaded', 'state-loaded', 'app-ready', 'window-created', 'did-finish-load', 'renderer-boot', 'first-spawn', 'first-output', 'wallPageMs', 'wallGridReadyMs'];
  result.summary.startup = Object.fromEntries(keys.map((k) => [k, median(list.map((r) => r[k]))]).filter(([, v]) => v !== null));
}

// ---------------------------------------------------------------- idle / busy / memory
// Installed before the page's scripts: a React DevTools hook counting commits and rendered components, timers by call site,
// and long tasks.
const PROBE = `(() => {
  const renders = new Map(); let commits = 0;
  const nameOf = (f) => { const t = f.type; if (!t || typeof t === 'string') return null;
    return t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || null; };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const walk = (next, prev) => {
    if (COMPONENT.has(next.tag) && (!prev || (next.flags & 1))) { const n = nameOf(next); if (n) renders.set(n, (renders.get(n) ?? 0) + 1); }
    if (prev && next.child === prev.child) return;
    for (let c = next.child; c; c = c.sibling) walk(c, c.alternate);
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; }, checkDCE() {},
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) { commits++; const cur = root.current; walk(cur, cur.alternate); } };
  const sites = new Map();
  // Call sites (a stack per call) only with --sites: they cost more renderer time than a busy grid itself.
  const where = window.__benchSites ? (depth) => ((new Error().stack ?? '').split('\\n')[depth] ?? '?').trim().replace(/^at /, '').replace(/file:\\/\\/\\/.*\\/assets\\//, '').replace(/\\?[^:)]*/, '') : () => '';
  const count = (k) => sites.set(k, (sites.get(k) ?? 0) + 1);
  for (const name of ['setTimeout', 'requestAnimationFrame', 'requestIdleCallback']) {
    const orig = window[name]; window[name] = function (...a) { count(name + ' ' + where(3)); return orig.apply(this, a); };
  }
  const origInterval = window.setInterval;
  window.setInterval = function (fn, ms, ...rest) { const k = 'interval ' + where(3) + ' ' + ms + 'ms';
    return origInterval.call(this, (...b) => { count(k); return typeof fn === 'function' ? fn(...b) : undefined; }, ms, ...rest); };
  const long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch {}
  window.__bench = { reset() { renders.clear(); sites.clear(); commits = 0; long.length = 0; },
    read() { return { commits, renders: Object.fromEntries([...renders].sort((a, b) => b[1] - a[1]).slice(0, 25)),
      timers: Object.fromEntries([...sites].sort((a, b) => b[1] - a[1]).slice(0, 25)),
      longTasks: { count: long.length, totalMs: Math.round(long.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...long)) } }; } };
})()`;

// Installed in main: IPC between main and the main window by channel, and file writes by file name.
const MAIN_PROBE = `(() => {
  const { BrowserWindow, ipcMain } = process.mainModule.require('electron');
  const fs = process.mainModule.require('fs');
  const fsp = process.mainModule.require('fs/promises');
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html') && !w.webContents.getURL().includes('detached='));
  const wc = win.webContents;
  const p = globalThis.__benchMain = { out: new Map(), outBytes: 0, in: new Map(), writes: new Map() };
  const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const size = (a) => { try { return JSON.stringify(a)?.length ?? 0; } catch { return 0; } };
  const send = wc.send.bind(wc);
  wc.send = (ch, ...a) => { inc(p.out, ch); p.outBytes += size(a); return send(ch, ...a); };
  wc.on('ipc-message', (_e, ch) => inc(p.in, ch));
  wc.on('ipc-message-sync', (_e, ch) => inc(p.in, ch + ' (sync)'));
  const handlers = ipcMain._invokeHandlers;
  if (handlers) for (const [ch, fn] of handlers) handlers.set(ch, (...a) => { inc(p.in, ch + ' (invoke)'); return fn(...a); });
  const base = (f) => String(f).split(/[\\\\/]/).pop();
  for (const name of ['writeFileSync', 'writeFile', 'renameSync', 'rename', 'appendFileSync', 'appendFile']) {
    const orig = fs[name]; fs[name] = function (f, ...a) { inc(p.writes, name + ' ' + base(f)); return orig.call(this, f, ...a); };
  }
  for (const name of ['writeFile', 'rename', 'appendFile']) {
    const orig = fsp[name]; fsp[name] = function (f, ...a) { inc(p.writes, 'promises.' + name + ' ' + base(f)); return orig.call(this, f, ...a); };
  }
  globalThis.__benchMainRead = () => ({ ipcOut: Object.fromEntries([...p.out].sort((a, b) => b[1] - a[1])), ipcOutKB: Math.round(p.outBytes / 1024),
    ipcIn: Object.fromEntries([...p.in].sort((a, b) => b[1] - a[1])), writes: Object.fromEntries([...p.writes].sort((a, b) => b[1] - a[1])) });
  globalThis.__benchMainReset = () => { p.out.clear(); p.in.clear(); p.writes.clear(); p.outBytes = 0; };
  return true;
})()`;

const WRITER = `
const colors = [31, 32, 33, 34, 35, 36, 90];
let n = 0;
setInterval(() => {
  let out = '';
  for (let i = 0; i < 4; i++, n++) out += '\\x1b[' + colors[n % colors.length] + 'm' + String(n).padStart(7) + '\\x1b[0m ' + 'lorem ipsum dolor sit amet '.repeat(3) + '\\r\\n';
  process.stdout.write(out);
}, 66);
`;

/** Top functions by self time of a CDP Profiler profile. */
function topSelf(prof, n = 25) {
  const dt = new Map();
  for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
  const self = new Map();
  let total = 0;
  for (const node of prof.nodes) {
    const t = (dt.get(node.id) ?? 0) / 1000;
    const f = node.callFrame;
    if (['(idle)', '(program)'].includes(f.functionName)) continue;
    total += t;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop() || ''}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + t);
  }
  return { busyMs: Math.round(total), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0)} ms ${k}`) };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 60000);
    pending.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

if (only.has('idle') || only.has('hooks') || only.has('busy') || only.has('memory')) {
  const root = scratch('grid');
  const project = join(root, 'project');
  const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'ignore', windowsHide: true });
  git('init', '-q');
  for (let i = 0; i < 20; i++) writeFileSync(join(project, `file${i}.txt`), `line ${i}\n`);
  git('add', '.');
  git('-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'init');
  writeFileSync(join(project, 'file0.txt'), 'changed\n');
  const writer = join(root, 'writer.cjs');
  writeFileSync(writer, WRITER);
  writeGridState(root, cells);
  let app;
  let mainc;
  try {
    const inspectPort = await freePort();
    app = await launchApp(root, BASE_ENV, [`--inspect=${inspectPort}`]);
    const nodeTarget = (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0];
    mainc = await connect(nodeTarget.webSocketDebuggerUrl);
    const mainEval = async (expression) => {
      const r = await mainc.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    await app.cdp('Page.addScriptToEvaluateOnNewDocument', { source: (process.argv.includes('--sites') ? 'window.__benchSites = true;' : '') + PROBE });
    await app.cdp('Page.reload', {});
    await sleep(1500);
    await app.until(`!!window.__bench && ${GRID_READY(cells)}`, `${cells} terminals`, 60000);
    await mainEval(MAIN_PROBE);
    await app.cdp('Performance.enable');
    await sleep(5000);

    const kind = (type) => ({ Browser: 'main', GPU: 'gpu', Tab: 'renderer', 'unimux Pty Host': 'ptyhost', 'unimux SFTP Host': 'sftphost', 'unimux DB Host': 'dbhost' }[type] ?? type);
    const appMetrics = () => mainEval(`process.mainModule.require('electron').app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type === 'Utility' ? (m.name || m.serviceName || 'Utility') : m.type, cpuS: m.cpu.cumulativeCPUUsage, priv: m.memory.privateBytes ?? m.memory.workingSetSize ?? 0 }))`);
    const perfMetrics = async () => Object.fromEntries((await app.cdp('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const memory = async () => {
      await app.cdp('HeapProfiler.collectGarbage');
      await app.cdp('HeapProfiler.collectGarbage');
      await mainEval('typeof gc === "function" ? gc() : 0').catch(() => 0);
      await sleep(500);
      const m = await perfMetrics();
      const dom = await app.cdp('Memory.getDOMCounters').catch(() => ({}));
      const procs = {};
      for (const p of await appMetrics()) procs[kind(p.type)] = +((procs[kind(p.type)] ?? 0) + p.priv / 1024).toFixed(1);
      // Attached elements by tag and first class: what a growth consists of (a node count alone also counts detached ones).
      const attached = await app.evaluate(`(() => { const m = {}; const walk = (n) => { if (n.nodeType === 1) { const k = n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.split(' ')[0] : ''); m[k] = (m[k] ?? 0) + 1; } for (const c of n.childNodes) walk(c); }; walk(document); return m; })()`);
      return { rendererHeapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), domNodes: dom.nodes, listeners: dom.jsEventListeners, privateMB: procs, attached };
    };

    const phase = async (name) => {
      await app.evaluate('window.__bench.reset(), true');
      await mainEval('__benchMainReset()');
      if (profile) { await app.cdp('Profiler.enable'); await app.cdp('Profiler.setSamplingInterval', { interval: 250 }); await app.cdp('Profiler.start'); }
      const a0 = await appMetrics();
      const p0 = await perfMetrics();
      const t0 = Date.now();
      await sleep(seconds * 1000);
      const a1 = await appMetrics();
      const p1 = await perfMetrics();
      const s = (Date.now() - t0) / 1000;
      const prof = profile ? topSelf((await app.cdp('Profiler.stop')).profile) : undefined;
      const cpu = {};
      for (const p of a1) {
        const q = a0.find((x) => x.pid === p.pid);
        if (q) cpu[kind(p.type)] = +((cpu[kind(p.type)] ?? 0) + (p.cpuS - q.cpuS) / s * 100).toFixed(1);
      }
      cpu.total = +Object.values(cpu).reduce((x, y) => x + y, 0).toFixed(1);
      const per = (k, scale = 1) => +(((p1[k] - p0[k]) / s) * scale).toFixed(1);
      const page = await app.evaluate('window.__bench.read()');
      const main = await mainEval('__benchMainRead()');
      const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
      const out = {
        cpu,
        perS: {
          styleRecalcs: per('RecalcStyleCount'), layouts: per('LayoutCount'),
          taskMs: per('TaskDuration', 1000), scriptMs: per('ScriptDuration', 1000), styleMs: per('RecalcStyleDuration', 1000), layoutMs: per('LayoutDuration', 1000),
          reactCommits: +(page.commits / s).toFixed(1), ipcOut: +(sum(main.ipcOut) / s).toFixed(1), ipcIn: +(sum(main.ipcIn) / s).toFixed(1),
          ipcOutKB: +(main.ipcOutKB / s).toFixed(1), fileWrites: +(sum(main.writes) / s).toFixed(2),
          timers: +(sum(page.timers) / s).toFixed(1),
        },
        longTasks: page.longTasks,
        detail: { renders: page.renders, timers: page.timers, ipcOut: main.ipcOut, ipcIn: main.ipcIn, writes: main.writes },
      };
      if (prof) out.profile = prof;
      result[name] = out;
      result.summary[name] = { cpu, perS: out.perS, longTasks: { count: page.longTasks.count, totalMs: page.longTasks.totalMs } };
      console.error(`${name}: ${JSON.stringify(result.summary[name])}`);
    };

    if (only.has('idle')) await phase('idle');
    if (only.has('hooks')) {
      // Agent-like hook traffic sent by main as for real hooks: half of the cells start a turn, then a tool call starts or ends
      // in one of them every 100 ms (Bash, Edit, Read in turns), as Claude Code's Pre/PostToolUse hooks do.
      const agents = Array.from({ length: Math.ceil(cells / 2) }, (_, i) => `c${i * 2 + 1}`);
      const wc = `process.mainModule.require('electron').BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html') && !w.webContents.getURL().includes('detached=')).webContents`;
      await mainEval(`(() => { const wc = ${wc}; const cells = ${JSON.stringify(agents)}; for (const c of cells) wc.send('cell:hook', c, 'prompt', {});
        const tools = ['Bash', 'Edit', 'Read']; let n = 0;
        globalThis.__benchHooks = setInterval(() => { const c = cells[n % cells.length]; const k = Math.floor(n / cells.length);
          wc.send('cell:hook', c, 'busy', { tool: tools[k % 3], toolUseId: 'u' + Math.floor(k / 2) + c, ...(k % 2 ? { toolEnd: true } : {}) }); n++; }, 100); return true; })()`);
      await sleep(1000);
      await phase('hooks');
      await mainEval(`(() => { clearInterval(globalThis.__benchHooks); const wc = ${wc}; for (const c of ${JSON.stringify(agents)}) wc.send('cell:hook', c, 'stop', {}); return true; })()`);
      await sleep(2000);
    }
    if (only.has('busy') || only.has('memory')) {
      for (let i = 0; i < cells; i++) {
        await app.evaluate(`window.__mc.terminals.focus('c${i}'), true`);
        await app.insertText(`"${process.execPath}" "${writer}"`);
        await app.press('Enter');
        await sleep(80);
      }
      await app.evaluate('document.activeElement?.blur(), true');
      await sleep(4000);
      if (only.has('busy')) await phase('busy');
    }
    if (only.has('memory')) {
      // Every cell's scrollback is full by now (60 lines a second); stop the writers.
      await sleep(Math.max(0, 20000 - seconds * 1000));
      for (let i = 0; i < cells; i++) {
        await app.evaluate(`window.__mc.terminals.focus('c${i}'), true`);
        await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
        await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
        await sleep(50);
      }
      await sleep(3000);
      const afterFlood = await memory();
      const cycle = async () => {
        await app.evaluate(`window.__mc.actions.openTab('p', ${JSON.stringify(grid(4, 2))}, [0, 1, 2, 3].map(() => ({ profileId: 'shell', worktree: false })), 'Cycle')`);
        await app.until(`(() => { const s = window.__mc.useStore.getState().s; const t = s.projects[0].tabs.find((x) => x.name === 'Cycle');
          return !!t && t.cells.every((c) => { const x = window.__mc.terminals.xterm(c.id); return x && x.buffer.active.getLine(0)?.translateToString(true).trim(); }); })()`, 'cycle tab ready', 30000);
        await app.evaluate(`(() => { const s = window.__mc.useStore.getState().s; const t = s.projects[0].tabs.find((x) => x.name === 'Cycle'); return window.__mc.actions.closeTab('p', t.id).then(() => true); })()`);
        await sleep(1500);
      };
      // The toast of a closed tab stays a few seconds: measured once it is gone.
      await cycle(); // warm-up: first-time code and caches
      await sleep(8000);
      const beforeCycles = await memory();
      for (let i = 0; i < cycles; i++) await cycle();
      await sleep(8000);
      const afterCycles = await memory();
      const growth = {
        rendererHeapMB: +(afterCycles.rendererHeapMB - beforeCycles.rendererHeapMB).toFixed(1),
        domNodes: afterCycles.domNodes - beforeCycles.domNodes,
        listeners: afterCycles.listeners - beforeCycles.listeners,
        ptyhostMB: +((afterCycles.privateMB.ptyhost ?? 0) - (beforeCycles.privateMB.ptyhost ?? 0)).toFixed(1),
        rendererMB: +((afterCycles.privateMB.renderer ?? 0) - (beforeCycles.privateMB.renderer ?? 0)).toFixed(1),
        mainMB: +((afterCycles.privateMB.main ?? 0) - (beforeCycles.privateMB.main ?? 0)).toFixed(1),
        attachedElements: Object.fromEntries(Object.entries(afterCycles.attached).map(([k, v]) => [k, v - (beforeCycles.attached[k] ?? 0)])
          .filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12)),
      };
      for (const snap of [afterFlood, beforeCycles, afterCycles]) delete snap.attached;
      result.memory = { afterFlood, beforeCycles, afterCycles, growthPer4CellTabCycles: growth };
      result.summary.memory = {
        rendererHeapMB: afterFlood.rendererHeapMB, rendererHeapPerCellMB: +(afterFlood.rendererHeapMB / cells).toFixed(2), domNodes: afterFlood.domNodes,
        privateMB: afterFlood.privateMB, leakAfterCycles: growth,
      };
      console.error(`memory: ${JSON.stringify(result.summary.memory)}`);
    }
  } finally {
    mainc?.close();
    await app?.close();
    removeScratch(root);
  }
}

const text = JSON.stringify(result, null, 1);
if (outFile) writeFileSync(outFile, text);
console.log(text);
