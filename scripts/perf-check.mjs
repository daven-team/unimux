// Performance regression check of the built app (Windows only; run `npm run build` first).
// A grid of cmd cells in a scratch data dir and home (never the real ones). Four phases:
//   idle  - every cell sits at its prompt;
//   dot   - one cell runs a ticker that keeps it "working" without visible output (the working dot is on screen, no
//           terminal has the keyboard focus, so no cursor blinks);
//   flood - the other cells print 12,000 lines each (their scrollback fills up): memory after a garbage collection;
//   busy  - the other cells run a writer that prints about 60 colored lines a second (every dot is "working").
// Per phase it prints the CPU (% of one core, from app.getAppMetrics() in the main process) and the private memory of every
// process type, the running CSS / Web animations (document.getAnimations()) and the frames the renderer's compositor drew
// (CDP trace, no rAF probe: a probe would itself force a frame at every vsync).
// It fails (exit code 1) when an animation runs continuously while cells work, when the idle phase costs 1 % of a core or
// more, when the dot phase costs DOT_BUDGET or draws DOT_FRAMES frames a second or more, when the Pty Host's private memory
// at idle is over PTY_HOST_BASE_MB + PTY_HOST_PER_CELL_MB per terminal, or when restarting one cell RESTARTS times leaves
// RESTART_GROWTH_MB or more behind in the Pty Host.
// Usage: node scripts/perf-check.mjs [cells, default 20] [seconds per measured window, default 15] [--json] [--scrollback=N]
//   [--projects=N]: N projects (1.0.0 grid tabs across projects); every extra project has an open grid of 4 cmd cells that is
//   shown once at the start (its shells start) and then stays hidden behind the measured grid, all in one tab strip.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';

if (process.platform !== 'win32') throw new Error('perf-check is Windows only');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const asJson = process.argv.includes('--json');
/** --scrollback=N starts the app with that scrollback setting (A/B of the renderer memory after the flood phase). */
const scrollbackArg = process.argv.find((a) => a.startsWith('--scrollback='));
const scrollback = scrollbackArg ? Number(scrollbackArg.split('=')[1]) : NaN;
/** The choices of Settings > Terminal (src/shared/terminalLimits.ts SCROLLBACK_CHOICES): anything else would be normalized away. */
const SCROLLBACK_CHOICES = [1000, 2500, 5000, 10_000, 25_000];
if (scrollbackArg && !SCROLLBACK_CHOICES.includes(scrollback)) {
  console.error(`--scrollback must be one of ${SCROLLBACK_CHOICES.join(', ')}`);
  process.exit(2);
}
const projectsArg = process.argv.find((a) => a.startsWith('--projects='));
const projectCount = projectsArg ? Math.max(1, Math.min(10, Number(projectsArg.split('=')[1]) || 1)) : 1;
const count = Number(args[0] ?? 20);
const seconds = Number(args[1] ?? 15);
/** Budget of the idle phase, in % of one core for all app processes together. */
const IDLE_BUDGET = 1;
/**
 * Budget of the dot phase: the 1 Hz blink presents two frames a second, about 0.5 % of a core each on a 240 Hz display with
 * 20 WebGL cells, plus the ticker; any continuous animation costs 30-45 % here. And the frames the compositor may draw per
 * second in it (the display rate when something animates).
 */
const DOT_BUDGET = 2.5;
const DOT_FRAMES = 10;
/**
 * Pty Host memory at idle: one shared ConPTY output thread (src/ptyhost/sharedConout.ts) instead of a node-pty Worker per
 * terminal (1.0.4: about 9 MB each, 288 MB for 28 cmd cells; 1.0.5: 56 MB).
 */
const PTY_HOST_BASE_MB = 40;
const PTY_HOST_PER_CELL_MB = 2;
/** Restarts of one cell, and what they may leave in the Pty Host (1.0.4 kept a Worker per ended terminal: about 98 MB for 10). */
const RESTARTS = 10;
const RESTART_GROWTH_MB = 25;

const root = mkdtempSync(join(tmpdir(), 'unimux-perfcheck-'));
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
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
// 12,000 lines as fast as the terminal takes them: fills the scrollback of a cell (memory after the flood phase).
const flood = join(root, 'flood.cjs');
writeFileSync(flood, `
const line = (n) => String(n).padStart(6) + ' ' + 'abcdefghij'.repeat(10) + '\\r\\n';
let n = 0;
const step = () => { let s = ''; for (let i = 0; i < 200 && n < 12000; i++) s += line(n++); if (process.stdout.write(s)) { if (n < 12000) setImmediate(step); } else process.stdout.once('drain', () => n < 12000 && step()); };
step();
`);
// Cursor save + restore: output that keeps the status "working" but changes nothing on the screen.
const ticker = join(root, 'ticker.cjs');
writeFileSync(ticker, `setInterval(() => process.stdout.write('\\x1b7\\x1b8'), 1500);\n`);
const cols = 5;
const rows = Math.max(1, Math.ceil(count / cols));
const areas = Array.from({ length: count }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 }));
const extraAreas = Array.from({ length: 4 }, (_, i) => ({ col: i % 2, row: Math.floor(i / 2), colSpan: 1, rowSpan: 1 }));
const extraProjects = Array.from({ length: projectCount - 1 }, (_, k) => {
  mkdirSync(join(root, `project${k + 2}`), { recursive: true });
  return { id: `p${k + 2}`, name: `Project ${k + 2}`, path: join(root, `project${k + 2}`), color: ['#22c55e', '#f59e0b', '#a855f7', '#ec4899'][k % 4], archive: [], activeTabId: `t${k + 2}`, tabs: [{
    id: `t${k + 2}`, name: 'Grid', layout: { cols: 2, rows: 2, areas: extraAreas }, cells: extraAreas.map((_, i) => ({ id: `p${k + 2}c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
  }] };
});
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Grid', path: join(root, 'project'), color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
    id: 't', name: 'Grid', layout: { cols, rows, areas }, cells: areas.map((_, i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
  }] }, ...extraProjects],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'visible', ...(Number.isFinite(scrollback) ? { scrollbackLines: scrollback } : {}) },
  sidebarCollapsed: true, snippetsOpen: false,
}));

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** A raw CDP client (the main process inspector). */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 30000);
    pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

/** The renderer's own CDP connection for tracing (launchApp's helper does not deliver events). */
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
  /** Adds a listener; the returned function removes it. */
  const on = (method, l) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(l);
    return () => listeners.set(method, listeners.get(method).filter((x) => x !== l));
  };
  return { send, on, close: () => ws.close() };
}

let app;
let mainc;
let rc;
const failures = [];
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
  const debugPort = await mainEval("process.mainModule.require('electron').app.commandLine.getSwitchValue('remote-debugging-port')");
  const page = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('index.html'));
  rc = await connectEvents(page.webSocketDebuggerUrl);

  // Utility processes by their name (serviceName in utilityProcess.fork): the Pty Host and the SFTP Host are both Node services.
  const metrics = () => mainEval(`process.mainModule.require('electron').app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type === 'Utility' ? (m.name || m.serviceName || 'Utility') : m.type, priv: m.memory.privateBytes ?? 0, ws: m.memory.workingSetSize, cpuS: m.cpu.cumulativeCPUUsage }))`);
  const kind = (type) => ({ Browser: 'main', GPU: 'gpu', Tab: 'renderer', 'unimux Pty Host': 'ptyhost', 'unimux SFTP Host': 'sftphost' }[type] ?? type);
  /** CPU % of one core per process type over `secs`, private and working set MB per type at the end. */
  const measure = async (secs) => {
    const m0 = await metrics();
    const t0 = Date.now();
    await sleep(secs * 1000);
    const m1 = await metrics();
    const s = (Date.now() - t0) / 1000;
    const cpu = {};
    const mem = {};
    for (const p of m1) {
      const k = kind(p.type);
      if (k === 'Tracing Service' || k === 'tracing.mojom.TracingService') continue; // started by this check's own trace
      const q = m0.find((x) => x.pid === p.pid);
      if (q) cpu[k] = +((cpu[k] ?? 0) + (p.cpuS - q.cpuS) / s * 100).toFixed(1);
      mem[k] ??= { privMB: 0, wsMB: 0 };
      mem[k].privMB = +(mem[k].privMB + p.priv / 1024).toFixed(1);
      mem[k].wsMB = +(mem[k].wsMB + p.ws / 1024).toFixed(1);
    }
    cpu.total = +Object.values(cpu).reduce((a, b) => a + b, 0).toFixed(1);
    mem.total = { privMB: +Object.values(mem).reduce((a, b) => a + b.privMB, 0).toFixed(1), wsMB: +Object.values(mem).reduce((a, b) => a + b.wsMB, 0).toFixed(1) };
    return { secs: +s.toFixed(1), cpu, mem };
  };
  /** Running animations, grouped by name and target; `infinite` counts those that never end on their own. */
  const animations = () => app.evaluate(`(() => {
    const running = document.getAnimations().filter((a) => a.playState === 'running');
    const byName = {};
    for (const a of running) {
      const el = a.effect?.target;
      const k = (a.animationName || a.transitionProperty || a.constructor.name) + ' ' + (el ? el.tagName.toLowerCase() + [...el.classList].map((c) => '.' + c).join('') : '?') + (a.effect?.pseudoElement ?? '');
      byName[k] = (byName[k] ?? 0) + 1;
    }
    return { running: running.length, infinite: running.filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length, byName };
  })()`);
  /** Frames drawn by the renderer's compositor per second (CDP trace, devtools frame events). */
  const frames = async (secs) => {
    const events = [];
    const onData = (p) => events.push(...p.value);
    let done;
    const finished = new Promise((r) => { done = r; });
    const offData = rc.on('Tracing.dataCollected', onData);
    const offDone = rc.on('Tracing.tracingComplete', () => done());
    try {
      await rc.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'] } });
      await sleep(secs * 1000);
      await rc.send('Tracing.end');
      await finished;
    } finally {
      offData();
      offDone();
    }
    const per = (name) => +(events.filter((e) => e.name === name).length / secs).toFixed(1);
    return { drawFramePerS: per('DrawFrame'), beginMainFramePerS: per('BeginMainThreadFrame') };
  };
  /** Several looks over a few seconds: an animation that is there every time runs continuously. */
  const continuous = async () => {
    const looks = [];
    for (let i = 0; i < 4; i++) { looks.push(await animations()); await sleep(700); }
    return { ...looks[looks.length - 1], continuous: Math.min(...looks.map((l) => l.infinite)) };
  };
  const run = async (cell, command) => {
    await app.evaluate(`document.querySelectorAll('.cell .xterm-helper-textarea')[${cell}].focus(), true`);
    await app.insertText(command);
    await app.press('Enter');
    await sleep(150);
  };
  const working = () => app.evaluate(`document.querySelectorAll('.cell .dot.working').length`);

  // The other projects' grids: each shown once from the tab strip (its shells start), then the measured grid comes back.
  const showGrid = (id) => app.evaluate(`[...document.querySelectorAll('.tab.grid-tab')].find((t) => t.dataset.workspaceId === 'grid:${id}').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })), true`);
  for (const p of extraProjects) {
    await app.until(`!!document.querySelector('.tab.grid-tab[data-workspace-id="grid:${p.tabs[0].id}"]')`, `tab of ${p.name}`);
    await showGrid(p.tabs[0].id);
    await app.until(`document.querySelectorAll('.cell .xterm').length === 4`, `terminals of ${p.name}`, 30000);
    await sleep(1500);
  }
  if (extraProjects.length) await showGrid('t');
  await app.until(`document.querySelectorAll('.cell .xterm').length >= ${count}`, `${count} terminals`, 60000);
  // Start-up work (session scans, first usage read) settles before the idle window.
  await sleep(15000);
  const display = await mainEval(`(() => { const d = process.mainModule.require('electron').screen.getPrimaryDisplay(); return { hz: d.displayFrequency, width: d.size.width, height: d.size.height }; })()`);
  const result = { count, projects: projectCount, display };

  // Two windows, the quieter one counts, and a third one when both are over the budget: one-off work of a fresh start (the
  // first update check, CLI detection) or another program may land in a window, a steady cost shows in all of them.
  const idleWindows = [await measure(seconds), await measure(seconds)];
  if (Math.min(...idleWindows.map((w) => w.cpu.total)) >= IDLE_BUDGET) idleWindows.push(await measure(seconds));
  const quiet = idleWindows.reduce((a, b) => (b.cpu.total < a.cpu.total ? b : a));
  result.idle = { working: await working(), ...quiet, windowsTotalCpu: idleWindows.map((w) => w.cpu.total), animations: await continuous(), frames: await frames(4) };

  // One cell restarted again and again (a closed or restarted cell, a relaunched CLI): nothing of the ended terminals stays.
  const ptyHostMB = async () => (await metrics()).filter((p) => kind(p.type) === 'ptyhost').reduce((a, p) => a + p.priv / 1024, 0);
  const restartBefore = await ptyHostMB();
  const profile = { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' };
  for (let i = 0; i < RESTARTS; i++) {
    await app.evaluate(`(async () => { await window.mc.killCellAndWait('c0'); return window.mc.spawnCell({ cellId: 'c0', cwd: ${JSON.stringify(join(root, 'project'))}, cols: 80, rows: 24, profile: ${JSON.stringify(profile)}, mode: 'new' }); })()`);
    await sleep(700);
  }
  await sleep(4000);
  result.restarts = { count: RESTARTS, ptyHostBeforeMB: +restartBefore.toFixed(1), ptyHostAfterMB: +(await ptyHostMB()).toFixed(1) };

  await run(0, `"${process.execPath}" "${ticker}"`);
  await app.until(`document.querySelectorAll('.cell .dot.working').length >= 1`, 'a working dot', 15000);
  // Nobody types now: the focused terminal's cursor blink is not what this phase measures.
  await app.evaluate(`(document.activeElement?.blur(), true)`);
  await sleep(3000);
  result.dot = { working: await working(), animations: await continuous(), frames: await frames(4), ...(await measure(seconds)) };

  // Every other cell prints 12,000 lines; memory is read after a garbage collection once they are done.
  for (let i = 1; i < count; i++) await run(i, `"${process.execPath}" "${flood}"`);
  await app.evaluate(`(document.activeElement?.blur(), true)`);
  await sleep(20000);
  await rc.send('HeapProfiler.collectGarbage');
  await sleep(1000);
  result.flood = { scrollback: Number.isFinite(scrollback) ? scrollback : 'default', ...(await measure(3)) };

  for (let i = 1; i < count; i++) await run(i, `"${process.execPath}" "${writer}"`);
  // Background cells only: no focused cell (short output window, blinking cursor).
  await app.evaluate(`(document.activeElement?.blur(), true)`);
  await sleep(6000);
  result.busy = { working: await working(), animations: await continuous(), ...(await measure(seconds)), frames: await frames(4) };

  for (const phase of ['idle', 'dot', 'busy']) {
    if (result[phase].animations.continuous > 0) failures.push(`${phase}: ${result[phase].animations.continuous} animation(s) run continuously: ${JSON.stringify(result[phase].animations.byName)}`);
  }
  const terminals = count + (projectCount - 1) * 4;
  const ptyHostBudget = PTY_HOST_BASE_MB + PTY_HOST_PER_CELL_MB * terminals;
  if ((result.idle.mem.ptyhost?.privMB ?? 0) >= ptyHostBudget) failures.push(`idle: the Pty Host holds ${result.idle.mem.ptyhost.privMB} MB for ${terminals} terminals (budget ${ptyHostBudget} MB)`);
  const growth = result.restarts.ptyHostAfterMB - result.restarts.ptyHostBeforeMB;
  if (growth >= RESTART_GROWTH_MB) failures.push(`restarts: ${RESTARTS} restarts of one cell left ${growth.toFixed(1)} MB in the Pty Host (budget ${RESTART_GROWTH_MB} MB)`);
  if (result.dot.working < 1) failures.push('dot: no working dot on screen, the check measured nothing');
  if (result.idle.cpu.total >= IDLE_BUDGET) failures.push(`idle: ${result.idle.cpu.total} % of a core (budget ${IDLE_BUDGET} %)`);
  if (result.dot.cpu.total >= DOT_BUDGET) failures.push(`dot: ${result.dot.cpu.total} % of a core (budget ${DOT_BUDGET} %)`);
  if (result.dot.frames.drawFramePerS >= DOT_FRAMES) failures.push(`dot: ${result.dot.frames.drawFramePerS} frames drawn a second (budget ${DOT_FRAMES}): something animates continuously`);
  result.failures = failures;
  if (asJson) console.log(JSON.stringify(result, null, 1));
  else {
    console.log(`display ${display.width}x${display.height} at ${display.hz} Hz, ${count} cells${projectCount > 1 ? `, ${projectCount} projects (${(projectCount - 1) * 4} hidden cells)` : ''}`);
    const types = ['main', 'gpu', 'renderer', 'ptyhost', 'sftphost'];
    console.log(['phase', 'working', ...types.map((t) => `${t} cpu%`), 'total cpu%', ...types.map((t) => `${t} privMB`), 'total privMB', 'draw/s', 'anims'].join('\t'));
    for (const phase of ['idle', 'dot', 'flood', 'busy']) {
      const r = result[phase];
      console.log([phase, r.working ?? '', ...types.map((t) => r.cpu[t] ?? 0), r.cpu.total, ...types.map((t) => r.mem[t]?.privMB ?? 0), r.mem.total.privMB, r.frames?.drawFramePerS ?? '', r.animations?.continuous ?? ''].join('\t'));
    }
    console.log(`restarts: ${RESTARTS} restarts of one cell, Pty Host ${result.restarts.ptyHostBeforeMB} -> ${result.restarts.ptyHostAfterMB} MB`);
    console.log(failures.length ? `FAIL\n- ${failures.join('\n- ')}` : `OK: no continuous animation, idle under ${IDLE_BUDGET} % and the working dot under ${DOT_BUDGET} % of a core, the Pty Host within its memory budgets`);
  }
} finally {
  try { mainc?.close(); } catch { /* closed */ }
  try { rc?.close(); } catch { /* closed */ }
  await app?.close();
  await sleep(1000);
  removeScratch(root);
}
process.exitCode = failures.length ? 1 : 0;
