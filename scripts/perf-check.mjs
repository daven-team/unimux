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
// more, or when the dot phase costs DOT_BUDGET or draws DOT_FRAMES frames a second or more.
// Usage: node scripts/perf-check.mjs [cells, default 20] [seconds per measured window, default 15] [--json] [--scrollback=N]
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
const scrollback = Number(process.argv.find((a) => a.startsWith('--scrollback='))?.split('=')[1] ?? NaN);
const count = Number(args[0] ?? 20);
const seconds = Number(args[1] ?? 15);
/** Budget of the idle phase, in % of one core for all app processes together. */
const IDLE_BUDGET = 1;
/**
 * Budget of the dot phase: the blink's two frames a second plus the ticker (any continuous animation costs 30-45 % here on a
 * 240 Hz display), and the frames the compositor may draw per second in it (the display rate when something animates).
 */
const DOT_BUDGET = 2.5;
const DOT_FRAMES = 10;

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
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Grid', path: join(root, 'project'), color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
    id: 't', name: 'Grid', layout: { cols, rows, areas }, cells: areas.map((_, i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
  }] }],
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
  const on = (method, l) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(l); };
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

  const metrics = () => mainEval(`process.mainModule.require('electron').app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type === 'Utility' ? (m.serviceName || m.name || 'Utility') : m.type, priv: m.memory.privateBytes ?? 0, ws: m.memory.workingSetSize, cpuS: m.cpu.cumulativeCPUUsage }))`);
  const kind = (type) => ({ Browser: 'main', GPU: 'gpu', Tab: 'renderer', 'node.mojom.NodeService': 'ptyhost' }[type] ?? type);
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
      if (k === 'tracing.mojom.TracingService') continue; // started by this check's own trace
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
    rc.on('Tracing.dataCollected', onData);
    rc.on('Tracing.tracingComplete', () => done());
    await rc.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'] } });
    await sleep(secs * 1000);
    await rc.send('Tracing.end');
    await finished;
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

  await app.until(`document.querySelectorAll('.cell .xterm').length >= ${count}`, `${count} terminals`, 60000);
  // Start-up work (session scans, first usage read) settles before the idle window.
  await sleep(15000);
  const display = await mainEval(`(() => { const d = process.mainModule.require('electron').screen.getPrimaryDisplay(); return { hz: d.displayFrequency, width: d.size.width, height: d.size.height }; })()`);
  const result = { count, display };

  // Two windows, the quieter one counts: one-off work of a fresh start (the first update check, CLI detection) may land in
  // either, a steady cost shows in both.
  const idleWindows = [await measure(seconds), await measure(seconds)];
  const quiet = idleWindows.reduce((a, b) => (b.cpu.total < a.cpu.total ? b : a));
  result.idle = { working: await working(), ...quiet, windowsTotalCpu: idleWindows.map((w) => w.cpu.total), animations: await continuous(), frames: await frames(4) };

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
  await sleep(6000);
  result.busy = { working: await working(), animations: await continuous(), ...(await measure(seconds)), frames: await frames(4) };

  for (const phase of ['idle', 'dot', 'busy']) {
    if (result[phase].animations.continuous > 0) failures.push(`${phase}: ${result[phase].animations.continuous} animation(s) run continuously: ${JSON.stringify(result[phase].animations.byName)}`);
  }
  if (result.dot.working < 1) failures.push('dot: no working dot on screen, the check measured nothing');
  if (result.idle.cpu.total >= IDLE_BUDGET) failures.push(`idle: ${result.idle.cpu.total} % of a core (budget ${IDLE_BUDGET} %)`);
  if (result.dot.cpu.total >= DOT_BUDGET) failures.push(`dot: ${result.dot.cpu.total} % of a core (budget ${DOT_BUDGET} %)`);
  if (result.dot.frames.drawFramePerS >= DOT_FRAMES) failures.push(`dot: ${result.dot.frames.drawFramePerS} frames drawn a second (budget ${DOT_FRAMES}): something animates continuously`);
  result.failures = failures;
  if (asJson) console.log(JSON.stringify(result, null, 1));
  else {
    console.log(`display ${display.width}x${display.height} at ${display.hz} Hz, ${count} cells`);
    const types = ['main', 'gpu', 'renderer', 'ptyhost'];
    console.log(['phase', 'working', ...types.map((t) => `${t} cpu%`), 'total cpu%', ...types.map((t) => `${t} privMB`), 'total privMB', 'draw/s', 'anims'].join('\t'));
    for (const phase of ['idle', 'dot', 'flood', 'busy']) {
      const r = result[phase];
      console.log([phase, r.working ?? '', ...types.map((t) => r.cpu[t] ?? 0), r.cpu.total, ...types.map((t) => r.mem[t]?.privMB ?? 0), r.mem.total.privMB, r.frames?.drawFramePerS ?? '', r.animations?.continuous ?? ''].join('\t'));
    }
    console.log(failures.length ? `FAIL\n- ${failures.join('\n- ')}` : `OK: no continuous animation, idle under ${IDLE_BUDGET} % and the working dot under ${DOT_BUDGET} % of a core`);
  }
} finally {
  try { mainc?.close(); } catch { /* closed */ }
  try { rc?.close(); } catch { /* closed */ }
  await app?.close();
  await sleep(1000);
  removeScratch(root);
}
process.exitCode = failures.length ? 1 : 0;
