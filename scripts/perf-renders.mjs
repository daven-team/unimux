// React renders, timers and CPU hot spots of the built app (Windows only; run `npm run build` first, for readable names in
// the profiles build with MC_NOMINIFY=1 npx electron-vite build). A grid of cmd cells in a git project, the sidebar open,
// in a scratch data dir and home (never the real ones). Two phases of `seconds` each:
//   idle - every cell sits at its prompt;
//   busy - half of the cells run a writer that prints about 60 colored lines a second.
// Per phase it prints the React components that rendered (count per name, from a DevTools-style commit hook installed before
// the page loads), the timers / animation frames the renderer asked for (count per call site), the CPU of every process type
// and the top functions by self time of the renderer and of the main process (CDP Profiler).
// Usage: node scripts/perf-renders.mjs [cells, default 12] [seconds, default 10] [--json] [--no-profile]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';

if (process.platform !== 'win32') throw new Error('perf-renders is Windows only');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const asJson = process.argv.includes('--json');
const profile = !process.argv.includes('--no-profile');
/** --no-dot: the working dot's pulse is switched off by an injected style (its own cost is measured by perf-check). */
const noDot = process.argv.includes('--no-dot');
/** --no-timers: no counting wrappers around the timer functions (they cost time of their own in a CPU profile). */
const noTimers = process.argv.includes('--no-timers');
const count = Number(args[0] ?? 12);
const seconds = Number(args[1] ?? 10);

const root = mkdtempSync(join(tmpdir(), 'unimux-perfrenders-'));
const project = join(root, 'project');
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'ignore', windowsHide: true });
git('init', '-q');
for (let i = 0; i < 20; i++) writeFileSync(join(project, `file${i}.txt`), `line ${i}\n`);
git('add', '.');
git('-c', 'user.name=perf', '-c', 'user.email=perf@example.invalid', 'commit', '-qm', 'init');
writeFileSync(join(project, 'file0.txt'), 'changed\n');
const writer = join(root, 'writer.cjs');
writeFileSync(writer, `
const colors = [31, 32, 33, 34, 35, 36, 90];
let n = 0;
setInterval(() => {
  let out = '';
  for (let i = 0; i < 4; i++, n++) out += '\\x1b[' + colors[n % colors.length] + 'm' + String(n).padStart(7) + '\\x1b[0m ' + 'lorem ipsum dolor sit amet '.repeat(3) + '\\r\\n';
  process.stdout.write(out);
}, 66);
`);
// An agent at work redraws one status line about 8 times a second (spinner and timer), without scrolling.
const spinner = join(root, 'spinner.cjs');
writeFileSync(spinner, `
const frames = ['·', '✢', '✳', '✶', '✻', '✽']; let n = 0; const t0 = Date.now();
process.stdout.write('\\r\\n');
setInterval(() => { n++; process.stdout.write('\\x1b[2K\\r\\x1b[38;5;174m' + frames[n % frames.length] + ' Working\\u2026 \\x1b[90m(' + Math.round((Date.now() - t0) / 1000) + 's \\u00b7 esc to interrupt)\\x1b[0m'); }, 120);
`);
const cols = 4;
const rows = Math.max(1, Math.ceil(count / cols));
const areas = Array.from({ length: count }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 }));
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Grid', path: project, color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
    id: 't', name: 'Grid', layout: { cols, rows, areas }, cells: areas.map((_, i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
  }, { id: 't2', name: 'Second', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }, cells: [{ id: 'x0', name: 'Hidden', profileId: 'shell' }] }] }],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'visible' },
  sidebarCollapsed: false, snippetsOpen: true,
}));

// Installed before the page's scripts: a React DevTools hook that counts the components each commit rendered, and counters of
// the timers and animation frames by call site.
const PROBE = `(() => {
  const renders = new Map(); let commits = 0;
  const nameOf = (f) => { const t = f.type; if (!t) return null; if (typeof t === 'string') return null;
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
  const site = (kind) => { const line = (new Error().stack ?? '').split('\\n')[3] ?? '?'; const k = kind + ' ' + line.trim().replace(/^at /, '').replace(/file:\\/\\/\\/.*\\/assets\\//, ''); sites.set(k, (sites.get(k) ?? 0) + 1); };
  const wrap = (name) => { const orig = window[name]; window[name] = function (...a) { site(name); return orig.apply(this, a); }; };
  if (!window.__perfNoTimers) {
  wrap('setTimeout'); wrap('setInterval'); wrap('requestAnimationFrame'); wrap('requestIdleCallback');
  // Callbacks of the intervals run without a new call: count them where they fire.
  const origInterval = window.setInterval;
  window.setInterval = function (fn, ms, ...rest) { const k = 'interval-tick ' + ((new Error().stack ?? '').split('\\n')[2] ?? '?').trim().replace(/^at /, '').replace(/file:\\/\\/\\/.*\\/assets\\//, '') + ' ' + ms + 'ms';
    return origInterval.call(this, (...b) => { sites.set(k, (sites.get(k) ?? 0) + 1); return typeof fn === 'function' ? fn(...b) : undefined; }, ms, ...rest); };
  }
  window.__perf = { reset() { renders.clear(); sites.clear(); commits = 0; },
    read() { return { commits, renders: Object.fromEntries([...renders].sort((a, b) => b[1] - a[1])), sites: Object.fromEntries([...sites].sort((a, b) => b[1] - a[1]).slice(0, 25)) }; } };
})()`;

/** Top functions by self time of a CDP Profiler profile. */
function topSelf(prof, n = 20) {
  const self = new Map();
  const dt = new Map();
  for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
  let total = 0;
  for (const node of prof.nodes) {
    const t = (dt.get(node.id) ?? 0) / 1000;
    total += t;
    const f = node.callFrame;
    if (['(idle)', '(program)'].includes(f.functionName)) continue;
    const key = `${f.functionName || '(anon)'} ${(f.url.split('/').pop() || '')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + t);
  }
  return { totalMs: +total.toFixed(0), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(1)} ms  ${k}`) };
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
    pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

/** A CDP client of the page that also delivers events (tracing). */
async function connectEvents(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } else listeners.get(m.method)?.forEach((l) => l(m.params));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, l) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(l); };
  return { send, on, close: () => ws.close() };
}

const freePort = async () => { const { createServer } = await import('node:net'); return new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); };

let app;
let mainc;
const result = { count, seconds };
try {
  const inspectPort = await freePort();
  app = await launchApp(root, {}, [`--inspect=${inspectPort}`]);
  const nodeTarget = (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0];
  mainc = await connect(nodeTarget.webSocketDebuggerUrl);
  await mainc.send('Runtime.enable');
  const mainEval = async (expression) => {
    const r = await mainc.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await app.cdp('Page.addScriptToEvaluateOnNewDocument', { source: (noTimers ? 'window.__perfNoTimers = true;' : '') + PROBE });
  await app.cdp('Page.reload', {});
  await sleep(1500);
  await app.until(`!!window.__perf && document.querySelectorAll('.cell .xterm').length >= ${count}`, `${count} terminals`, 40000);
  await sleep(5000);
  if (noDot) await app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '.dot.working::after { animation: none !important; }'; document.head.appendChild(s); return true; })()`);
  const page = (await (await fetch(`http://127.0.0.1:${app.debugPort}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('detached='));
  const rc = await connectEvents(page.webSocketDebuggerUrl);
  /** Frames drawn by the renderer's compositor per second (CDP trace). */
  const frames = async (secs) => {
    const events = [];
    let done;
    const finished = new Promise((r) => { done = r; });
    rc.on('Tracing.dataCollected', (p) => events.push(...p.value));
    rc.on('Tracing.tracingComplete', () => done());
    await rc.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'] } });
    await sleep(secs * 1000);
    await rc.send('Tracing.end');
    await finished;
    const per = (name) => +(events.filter((e) => e.name === name).length / secs).toFixed(1);
    // Main-thread time of the renderer by trace event (complete events of the thread that runs the page's tasks).
    const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
    const byName = new Map();
    for (const e of events) if (e.ph === 'X' && main && e.tid === main.tid && e.pid === main.pid) byName.set(e.name, (byName.get(e.name) ?? 0) + (e.dur ?? 0) / 1000);
    const mainMsPerS = Object.fromEntries([...byName].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, +(v / secs).toFixed(2)]));
    return { drawFramePerS: per('DrawFrame'), beginMainFramePerS: per('BeginMainThreadFrame'), mainMsPerS };
  };

  const metrics = () => mainEval(`process.mainModule.require('electron').app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type === 'Utility' ? (m.name || m.serviceName || 'Utility') : m.type, cpuS: m.cpu.cumulativeCPUUsage, priv: m.memory.privateBytes ?? 0 }))`);
  const kind = (type) => ({ Browser: 'main', GPU: 'gpu', Tab: 'renderer', 'unimux Pty Host': 'ptyhost', 'unimux SFTP Host': 'sftphost' }[type] ?? type);
  if (profile) {
    await app.cdp('Profiler.enable');
    await app.cdp('Profiler.setSamplingInterval', { interval: 200 });
    await mainc.send('Profiler.enable');
    await mainc.send('Profiler.setSamplingInterval', { interval: 200 });
  }
  const phase = async (name) => {
    await app.evaluate('window.__perf.reset(), true');
    if (profile) { await app.cdp('Profiler.start'); await mainc.send('Profiler.start'); }
    const m0 = await metrics();
    const t0 = Date.now();
    await sleep(seconds * 1000);
    const m1 = await metrics();
    const s = (Date.now() - t0) / 1000;
    const cpu = {};
    const memMB = {};
    for (const p of m1) {
      const k = kind(p.type);
      const q = m0.find((x) => x.pid === p.pid);
      if (q) cpu[k] = +((cpu[k] ?? 0) + (p.cpuS - q.cpuS) / s * 100).toFixed(1);
      memMB[k] = +((memMB[k] ?? 0) + p.priv / 1024).toFixed(1);
    }
    const counts = await app.evaluate('window.__perf.read()');
    const out = { cpu, memMB, commitsPerS: +(counts.commits / s).toFixed(1), renders: counts.renders, timers: counts.sites };
    if (profile) {
      out.rendererProfile = topSelf((await app.cdp('Profiler.stop')).profile);
      out.mainProfile = topSelf((await mainc.send('Profiler.stop')).profile, 12);
    }
    out.frames = await frames(4);
    result[name] = out;
  };
  await phase('idle');
  // Agent-like hook traffic, sent by main as for real hooks: half of the cells start a turn, then a tool call starts or ends
  // in one of them every 100 ms (Bash, Edit, Read in turns), as Claude Code's Pre/PostToolUse hooks do.
  const agents = Array.from({ length: Math.ceil(count / 2) }, (_, i) => `c${i * 2 + 1}`);
  await mainEval(`(() => { const { BrowserWindow } = process.mainModule.require('electron'); const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html') && !w.webContents.getURL().includes('detached=')).webContents;
    const cells = ${JSON.stringify(agents)}; for (const c of cells) wc.send('cell:hook', c, 'prompt', {});
    const tools = ['Bash', 'Edit', 'Read']; let n = 0;
    globalThis.__perfHooks = setInterval(() => { const c = cells[n % cells.length]; const k = Math.floor(n / cells.length); const tool = tools[k % 3];
      wc.send('cell:hook', c, 'busy', { tool, toolUseId: 'u' + Math.floor(k / 2) + c, ...(k % 2 ? { toolEnd: true } : {}) }); n++; }, 100); return true; })()`);
  await sleep(1000);
  await phase('hooks');
  await mainEval(`(() => { clearInterval(globalThis.__perfHooks); const { BrowserWindow } = process.mainModule.require('electron'); const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html') && !w.webContents.getURL().includes('detached=')).webContents;
    for (const c of ${JSON.stringify(agents)}) wc.send('cell:hook', c, 'stop', {}); return true; })()`);
  await sleep(2000);
  // Every cell runs the spinner (all of them "working"), then the writers replace it in half of the cells.
  const run = async (i, file) => {
    await app.evaluate(`document.querySelectorAll('.cell .xterm-helper-textarea')[${i}].focus(), true`);
    await app.insertText(`"${process.execPath}" "${file}"`);
    await app.press('Enter');
    await sleep(100);
  };
  for (let i = 0; i < count; i++) await run(i, spinner);
  await app.evaluate('document.activeElement?.blur(), true');
  await sleep(3000);
  await phase('spin');
  for (let i = 0; i < count; i++) {
    await app.evaluate(`document.querySelectorAll('.cell .xterm-helper-textarea')[${i}].focus(), true`);
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    await sleep(60);
  }
  await sleep(2500);
  await app.evaluate('window.__perf.reset(), true');
  const ts = Date.now();
  for (let i = 0; i < count; i += 2) {
    await app.evaluate(`document.querySelectorAll('.cell .xterm-helper-textarea')[${i}].focus(), true`);
    await app.insertText(`"${process.execPath}" "${writer}"`);
    await app.press('Enter');
    await sleep(100);
  }
  await app.evaluate('document.activeElement?.blur(), true');
  await sleep(3000);
  const st = await app.evaluate('window.__perf.read()');
  result.start = { secs: (Date.now() - ts) / 1000, commits: st.commits, renders: st.renders };
  await phase('busy');
} finally {
  mainc?.close();
  await app?.close();
  removeScratch(root);
}
if (asJson) console.log(JSON.stringify(result, null, 1));
else {
  console.log(`start of the writers (${result.start?.secs} s): commits ${result.start?.commits} renders ${JSON.stringify(result.start?.renders)}`);
  for (const name of ['idle', 'hooks', 'spin', 'busy']) {
    const r = result[name];
    if (!r) continue;
    console.log(`\n== ${name}: cpu ${JSON.stringify(r.cpu)} mem ${JSON.stringify(r.memMB)} commits/s ${r.commitsPerS} frames ${JSON.stringify(r.frames)}`);
    console.log('renders:', JSON.stringify(r.renders));
    console.log('timers:'); for (const [k, v] of Object.entries(r.timers)) console.log(`  ${v}  ${k}`);
    if (r.rendererProfile) { console.log(`renderer self time (of ${r.rendererProfile.totalMs} ms):`); r.rendererProfile.top.forEach((l) => console.log('  ' + l)); }
    if (r.mainProfile) { console.log(`main self time (of ${r.mainProfile.totalMs} ms):`); r.mainProfile.top.forEach((l) => console.log('  ' + l)); }
  }
}
