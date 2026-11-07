// UI smoothness benchmark of the built app (Windows only; run `npm run build:check` first (MC_APP_TARGET=electron: `npm run build`), MC_NOMINIFY=1 for readable culprits).
// Measures dropped frames and hitches, not CPU: a page-side requestAnimationFrame recorder (frame intervals), Long Animation
// Frames (LoAF: the scripts of a slow frame, with their function and source position), long tasks and Event Timing (the
// time from a real input event to the frame that shows its effect).
// Setup: a scratch data dir and home (never the real %APPDATA%\unimux, ~/.claude or ~/.codex), three git projects, five grids
// (16, 12, 4, 12 and 6 cmd cells), some cells printing about 60 lines a second, some with a long scrollback; kills only the
// PIDs it started.
// The window is a real window but placed off screen (MC_OFFSCREEN) so it does not disturb the person at the machine; it is not
// focusable. Chromium still produces frames at the display rate there (the recorder checks the idle rate first), but the
// GPU presentation of an off-screen window may differ from an on-screen one: the numbers are main-thread frame pacing.
// Scenarios (each action repeated --reps times, idle frames between actions count too):
//   tabs      first visit of the other grids (once), grid tab to grid tab (16 -> 12 -> 4 cells), settings tab and back
//   projects  project to project (sidebar)
//   scroll    wheel over a terminal with 20k lines of scrollback, dragging its scrollbar, wheel while it prints
//   panels    settings (open, every section), Git panel and a commit, AI team, waiting, monitor, palette, all-tabs menu,
//             conversation search, limits panel fold
//   resize    window, sidebar edge, grid divider, limits panel handle
//   window    detach a grid into its own window and back, maximize a cell and back
// Usage: node scripts/bench-jank.mjs [--reps=5] [--profile=<scenario>] [--trace=<scenario>] [--gpu-cache=<dir>] [--only=tabs,projects,scroll,panels,resize,window] [--out=file.json]
//        node scripts/bench-jank.mjs --compare=a.json,b.json[,c.json,d.json]   (interleaved runs: a,c = before; b,d = after)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { isMainPage, isTauri } from './real-app.mjs';
import { launchApp, sleep } from './ssh-ui-lib.mjs';

const opt = (name, fallback) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : fallback; };

// ---------------------------------------------------------------- compare
const compare = opt('compare');
if (compare) {
  const files = compare.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8')));
  // Odd positions are "before", even ones "after" (interleaved runs); each metric is the median of its side.
  const sides = [files.filter((_, i) => i % 2 === 0), files.filter((_, i) => i % 2 === 1)];
  const med = (v) => { const s = v.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!s.length) return null; return +(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1); };
  const names = [...new Set(files.flatMap((f) => Object.keys(f.scenarios)))];
  const cols = ['p50', 'p95', 'p99', 'max', 'over17', 'over50', 'dropped', 'loafMax', 'inpMax'];
  console.log(`${'scenario'.padEnd(26)} ${cols.map((c) => c.padStart(15)).join(' ')}`);
  for (const n of names) {
    const cell = (c) => sides.map((side) => med(side.map((f) => f.scenarios[n]?.[c])) ?? '-').join(' / ');
    console.log(`${n.padEnd(26)} ${cols.map((c) => String(cell(c)).padStart(15)).join(' ')}`);
  }
  process.exit(0);
}

if (process.platform !== 'win32') throw new Error('bench-jank is Windows only');
const reps = Number(opt('reps', 5));
const only = new Set(opt('only', 'tabs,projects,scroll,panels,resize,window').split(','));
const outFile = opt('out');
/**
 * --app=<dir>: run the app from another folder (package.json, out\, resources\ and a node_modules junction), e.g. a saved
 * build of the previous commit, for interleaved before/after runs on a noisy machine.
 */
if (opt('app')) process.chdir(opt('app'));
/** --profile=<scenario prefix>[,...]: a CPU profile of those scenarios (saved to D:\Projekty\_jank, top functions printed). */
const profileOf = opt('profile', '').split(',').filter(Boolean);
/**
 * --trace=<scenario prefix>[,...]: a Chromium trace of those scenarios (saved to D:\Projekty\_jank, opens in DevTools'
 * Performance panel); the main-thread tasks over 25 ms are printed with what they spent their time on. For slow frames
 * without a long script (LoAF lists scripts only), e.g. style, paint or a first use of a font.
 */
const traceOf = opt('trace', '').split(',').filter(Boolean);
/**
 * --gpu-cache=<dir>: Chromium's GPU shader caches are kept in <dir> between runs (copied into the scratch data dir before the
 * start and back after the exit). A fresh data dir compiles every raster shader on first use (a 30 to 50 ms frame in the GPU
 * process the first time a panel shows a new kind of drawing); an installed app has them on disk after its first sessions.
 */
const gpuCache = opt('gpu-cache');
const GPU_CACHE_DIRS = ['GPUCache', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];

/** Main-thread tasks of the renderer over 25 ms in a trace, each with its heaviest nested events. */
function traceTop(events) {
  const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  if (!main) return ['no renderer main thread in the trace'];
  const own = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && typeof e.dur === 'number').sort((a, b) => a.ts - b.ts);
  const tasks = own.filter((e) => e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask');
  const t0 = own[0]?.ts ?? 0;
  const lines = [];
  for (const task of tasks.filter((t) => t.dur > 25_000).sort((a, b) => b.dur - a.dur).slice(0, 8)) {
    const inside = own.filter((e) => e !== task && e.ts >= task.ts && e.ts + e.dur <= task.ts + task.dur);
    const by = new Map();
    for (const e of inside) { const k = e.name + (e.args?.data?.functionName ? ` ${e.args.data.functionName}` : '') + (e.args?.data?.url ? ` ${String(e.args.data.url).split('/').pop()}` : ''); by.set(k, (by.get(k) ?? 0) + e.dur); }
    const top = [...by].filter(([, d]) => d >= 2000).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, d]) => `${(d / 1000).toFixed(1)} ${k}`);
    lines.push(`${(task.dur / 1000).toFixed(1)} ms at +${((task.ts - t0) / 1000).toFixed(0)}: ${top.join(' | ')}`);
  }
  return lines;
}
const SCRATCH = 'D:\\Projekty';

/** Top functions of a CDP profile by self time and by total (inclusive) time. */
function profileTop(prof, n = 18) {
  const byId = new Map(prof.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of prof.nodes) for (const c of node.children ?? []) parent.set(c, node.id);
  const dt = new Map();
  for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000);
  const label = (f) => `${f.functionName || '(anon)'} ${f.url.split('/').pop() || ''}:${f.lineNumber + 1}`;
  const self = new Map(); const total = new Map();
  for (const [id, t] of dt) {
    const f = byId.get(id).callFrame;
    if (['(idle)', '(program)', '(garbage collector)'].includes(f.functionName)) { self.set(f.functionName, (self.get(f.functionName) ?? 0) + t); continue; }
    self.set(label(f), (self.get(label(f)) ?? 0) + t);
    const seen = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) { const k = label(byId.get(x).callFrame); if (seen.has(k)) continue; seen.add(k); total.set(k, (total.get(k) ?? 0) + t); }
  }
  const top = (m) => [...m].filter(([k]) => k !== '(idle)').sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms ${k}`);
  return ['self:', ...top(self), 'total:', ...top(total).filter((l) => !/\(root\)|\(program\)/.test(l))];
}

const layoutOf = (n, cols) => ({ cols, rows: Math.ceil(n / cols), areas: Array.from({ length: n }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 })) });

// ---------------------------------------------------------------- setup
const root = mkdtempSync(join(SCRATCH, '_tmp-bench-jank-'));
for (const dir of ['data', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });

/** A git repository with `commits` commits (git fast-import: seconds, not minutes) and a small tree of files. */
function makeRepo(name, commits) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { windowsHide: true });
  let stream = '';
  for (let i = 0; i < commits; i++) {
    const msg = `Change ${i}: ${['fix the parser', 'add a test', 'refactor the grid', 'update docs', 'tune the cache'][i % 5]}`;
    const content = `version ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i + 1}\ncommitter Bench <bench@example.invalid> ${1700000000 + i * 3600} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n`;
    if (i > 0) stream += `from :${i}\n`;
    stream += `M 644 inline src/file${i % 40}.ts\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  execFileSync('git', ['-C', dir, 'fast-import', '--quiet'], { input: stream, windowsHide: true });
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-f', 'main'], { windowsHide: true });
  writeFileSync(join(dir, 'src', 'file0.ts'), 'changed\n');
  return dir;
}
const paths = { a: makeRepo('alpha', 3000), b: makeRepo('beta', 400), c: makeRepo('gamma', 50) };

const WRITER = join(root, 'writer.cjs');
writeFileSync(WRITER, `const colors = [31, 32, 33, 34, 35, 36, 90]; let n = 0;
setInterval(() => { let out = ''; for (let i = 0; i < 4; i++, n++) out += '\\x1b[' + colors[n % colors.length] + 'm' + String(n).padStart(7) + '\\x1b[0m ' + 'lorem ipsum dolor sit amet '.repeat(3) + '\\r\\n'; process.stdout.write(out); }, 66);`);
const FILL = join(root, 'fill.cjs');
writeFileSync(FILL, `let out = ''; for (let i = 0; i < 20000; i++) out += String(i).padStart(6) + ' the quick brown fox jumps over the lazy dog ' + (i % 7 ? '' : '\\x1b[33mwarn\\x1b[0m') + '\\r\\n'; process.stdout.write(out);`);

let cellSeq = 0;
const tab = (id, name, n, cols) => {
  const layout = layoutOf(n, cols);
  return { id, name, layout, cells: layout.areas.map(() => ({ id: `${id}c${cellSeq++}`, profileId: 'shell' })) };
};
const T = {
  a16: tab('a16', 'Main 16', 16, 4), a12: tab('a12', 'Review 12', 12, 4), a4: tab('a4', 'Small 4', 4, 2),
  b12: tab('b12', 'Beta 12', 12, 4), c6: tab('c6', 'Gamma 6', 6, 3),
};
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'pa',
  projects: [
    { id: 'pa', name: 'Alpha', path: paths.a, color: '#3b82f6', archive: [], activeTabId: 'a16', tabs: [T.a16, T.a12, T.a4] },
    { id: 'pb', name: 'Beta', path: paths.b, color: '#22c55e', archive: [], activeTabId: 'b12', tabs: [T.b12] },
    { id: 'pc', name: 'Gamma', path: paths.c, color: '#f59e0b', archive: [], activeTabId: 'c6', tabs: [T.c6] },
  ],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [],
  settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'all', showAiUsage: true, sidePanels: { monitor: true, waiting: true } },
  sidebarCollapsed: false,
}));

// ---------------------------------------------------------------- page recorder
const RECORDER = `(() => {
  if (window.__jank) return true;
  const frames = []; const loafs = []; const longs = []; const events = []; let on = false; let last = 0;
  const slow = []; const loop = (t) => { if (on) { if (last) { frames.push(t - last); if (t - last > 30) slow.push([Math.round(last), Math.round(t - last)]); } last = t; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const short = (u) => (u || '').replace(/^.*\\/assets\\//, '').replace(/\\?.*$/, '');
  try { new PerformanceObserver((l) => { if (!on) return; for (const e of l.getEntries()) loafs.push({ d: Math.round(e.duration), block: Math.round(e.blockingDuration),
    render: Math.round(e.startTime + e.duration - e.renderStart), style: Math.round(e.startTime + e.duration - (e.styleAndLayoutStart || e.renderStart)),
    scripts: e.scripts.map((s) => ({ d: Math.round(s.duration), layout: Math.round(s.forcedStyleAndLayoutDuration), inv: s.invoker, fn: s.sourceFunctionName, src: short(s.sourceURL) + ':' + s.sourceCharPosition })).sort((a, b) => b.d - a.d).slice(0, 4) }); })
    .observe({ type: 'long-animation-frame', buffered: false }); } catch {}
  try { new PerformanceObserver((l) => { if (on) for (const e of l.getEntries()) longs.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch {}
  try { new PerformanceObserver((l) => { if (on) for (const e of l.getEntries()) events.push({ name: e.name, d: e.duration }); }).observe({ type: 'event', durationThreshold: 16, buffered: false }); } catch {}
  window.__jank = {
    start() { slow.length = 0; frames.length = 0; loafs.length = 0; longs.length = 0; events.length = 0; last = 0; on = true; return true; },
    stop(vsync) {
      on = false;
      const s = [...frames].sort((a, b) => a - b); const q = (p) => s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null;
      const dropped = frames.reduce((n, f) => n + Math.max(0, Math.round(f / vsync) - 1), 0);
      const worst = [...loafs].sort((a, b) => b.d - a.d).slice(0, 5);
      return { frames: frames.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.length ? +s[s.length - 1].toFixed(1) : null,
        over50: frames.filter((f) => f > 50).length, over17: frames.filter((f) => f > 17).length, over33: frames.filter((f) => f > 33.4).length, dropped,
        loafs: loafs.length, loafMax: worst[0]?.d ?? 0, longTasks: longs.length, longMax: Math.round(Math.max(0, ...longs)),
        inpMax: Math.round(Math.max(0, ...events.map((e) => e.d))), slowEvents: events.length, worst, slowFrames: slow.slice(0, 40) };
    },
  };
  return true;
})()`;

// ---------------------------------------------------------------- app
// Chromium's caches: Electron keeps them in the data dir, WebView2 (Tauri) in data\webview2\EBWebView.
const gpuBase = isTauri ? join(root, 'data', 'webview2', 'EBWebView') : join(root, 'data');
if (gpuCache) for (const d of GPU_CACHE_DIRS) if (existsSync(join(gpuCache, d))) cpSync(join(gpuCache, d), join(gpuBase, d), { recursive: true });
const app = await launchApp(root, { MC_CLI_NO_REGISTRY: '1' }, [], { main: true });
const result = { at: new Date().toISOString(), reps, scenarios: {} };
const main = app.main;
try {
  // A fixed size and place (off screen, as MC_OFFSCREEN put it): the same layout in every run.
  await main.setBounds({ x: -6000, y: 0, width: 1600, height: 1000 });
  const ev = app.evaluate;
  const cellsReady = (ids) => `(() => ${JSON.stringify(ids)}.every((id) => { const t = window.__mc.terminals.xterm(id); if (!t) return false; const b = t.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true).trim()) return true; return false; }))()`;
  await app.until(cellsReady(T.a16.cells.map((c) => c.id)), 'grid ready', 60000);
  await ev(RECORDER);
  await app.cdp('Performance.enable');
  // --instrument=<file>: page code evaluated after the recorder (diagnostics: wrappers that log into window.__inst).
  if (opt('instrument')) await ev(readFileSync(opt('instrument'), 'utf8'));

  const center = (selector, text) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'e.getClientRects().length > 0'});
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const mouse = (type, x, y, extra = {}) => app.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  /** A real click (trusted mouse events, so Event Timing sees it) at an element's center. */
  const click = async (selector, text) => {
    const p = await center(selector, text);
    if (!p) throw new Error(`not found: ${selector} ${text ?? ''}`);
    await mouse('mouseMoved', p.x, p.y, { button: 'none' });
    await mouse('mousePressed', p.x, p.y);
    await mouse('mouseReleased', p.x, p.y);
  };
  const drag = async (from, dx, dy, steps = 30, ms = 16) => {
    await mouse('mouseMoved', from.x, from.y, { button: 'none' });
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', Math.round(from.x + (dx * i) / steps), Math.round(from.y + (dy * i) / steps), { buttons: 1 }); await sleep(ms); }
    await mouse('mouseReleased', from.x + dx, from.y + dy);
  };
  const key = async (k, code, vk, modifiers) => {
    for (const type of ['rawKeyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const type = async (cellId, text) => { await ev(`window.__mc.terminals.focus(${JSON.stringify(cellId)}), true`); await app.insertText(text); await app.press('Enter'); };
  const idleFrame = async () => { await ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'); };

  // The display rate as the page sees it (frame interval at rest): the unit of a dropped frame.
  await ev('__jank.start()');
  await sleep(2000);
  const rest = await ev('__jank.stop(16.67)');
  const vsync = rest.p50 || 16.67;
  result.vsync = vsync;
  console.error(`frame interval at rest: p50 ${rest.p50} ms, p95 ${rest.p95}, max ${rest.max} (${rest.frames} frames in 2 s)`);

  const measure = async (name, body) => {
    await sleep(600);
    const profiling = profileOf.some((p) => name.startsWith(p));
    if (profiling) { await app.cdp('Profiler.enable'); await app.cdp('Profiler.setSamplingInterval', { interval: 200 }); await app.cdp('Profiler.start'); }
    // A trace goes through a connection of its own (its data comes as events).
    let tracer = null;
    if (traceOf.some((p) => name.startsWith(p))) {
      const page = (await (await fetch(`http://127.0.0.1:${app.debugPort}/json/list`)).json()).find(isMainPage);
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      const events = [];
      let done;
      const complete = new Promise((resolve) => { done = resolve; });
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); if (m.method === 'Tracing.tracingComplete') done(); };
      ws.send(JSON.stringify({ id: 1, method: 'Tracing.start', params: { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'toplevel', 'v8.execute', 'blink.user_timing', 'loading'] } } }));
      await sleep(300);
      tracer = { ws, events, complete };
    }
    const metrics = async () => Object.fromEntries((await app.cdp('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const m0 = await metrics();
    await ev('__jank.start()');
    try { await body(); } catch (error) { console.error(`${name}: ${error.message}`); }
    await sleep(400);
    const r = await ev(`__jank.stop(${vsync})`);
    const m1 = await metrics();
    // Main-thread time of the scenario by kind (ms): script, style, layout and all tasks.
    r.ms = Object.fromEntries([['script', 'ScriptDuration'], ['style', 'RecalcStyleDuration'], ['layout', 'LayoutDuration'], ['task', 'TaskDuration']].map(([k, m]) => [k, Math.round((m1[m] - m0[m]) * 1000)]));
    if (profiling) {
      const { profile } = await app.cdp('Profiler.stop');
      const file = join(SCRATCH, '_jank', `${name.replace(/\W+/g, '-')}.cpuprofile`);
      mkdirSync(join(SCRATCH, '_jank'), { recursive: true });
      writeFileSync(file, JSON.stringify(profile));
      console.error(`    profile: ${file}`);
      for (const line of profileTop(profile)) console.error(`    ${line}`);
    }
    if (tracer) {
      tracer.ws.send(JSON.stringify({ id: 2, method: 'Tracing.end' }));
      await tracer.complete;
      tracer.ws.close();
      const file = join(SCRATCH, '_jank', `${name.replace(/\W+/g, '-')}.trace.json`);
      mkdirSync(join(SCRATCH, '_jank'), { recursive: true });
      writeFileSync(file, JSON.stringify({ traceEvents: tracer.events }));
      console.error(`    trace: ${file}`);
      for (const line of traceTop(tracer.events)) console.error(`    ${line}`);
    }
    if (opt('instrument')) r.inst = await ev('(window.__inst || []).splice(0)');
    result.scenarios[name] = r;
    console.error(`${name.padEnd(24)} p50 ${r.p50} p95 ${r.p95} p99 ${r.p99} max ${r.max} >17ms ${r.over17} >50ms ${r.over50} dropped ${r.dropped} LoAF max ${r.loafMax} INP max ${r.inpMax} | script ${r.ms.script} style ${r.ms.style} layout ${r.ms.layout} task ${r.ms.task} ms`);
    for (const w of r.worst.slice(0, 3)) console.error(`    ${w.d} ms (style/layout ${w.style}): ${w.scripts.map((s) => `${s.d} ${s.inv} ${s.fn} ${s.src}`).join(' | ')}`);
  };

  // Output: four cells of the 16-cell grid print all the time, four have 20k lines of scrollback; two cells of the 12-cell grid print too.
  for (let i = 0; i < 4; i++) await type(T.a16.cells[i].id, `"${process.execPath}" "${WRITER}"`);
  for (let i = 4; i < 8; i++) await type(T.a16.cells[i].id, `"${process.execPath}" "${FILL}"`);
  await app.until(`(() => { const t = window.__mc.terminals.xterm(${JSON.stringify(T.a16.cells[4].id)}); return t && t.buffer.active.length > 5000; })()`, 'scrollback filled', 60000);
  await ev('document.activeElement?.blur(), true');
  // Every grid visited once (its cells start, its WebGL contexts exist): the runs measure switching, not first starts.
  const selectTab = (id) => click(`.tab.grid-tab[data-workspace-id="grid:${id}"]`);
  const selectProject = (name) => click('.sidebar .project .name', name);
  /** A rail tile: a click on the tile of the open panel would fold the side panel instead. */
  const showPanel = async (id) => { if (!(await ev(`document.querySelector('#${id}-view')?.getAttribute('aria-selected') === 'true' && !document.querySelector('.sidebar.collapsed')`))) await click(`#${id}-view`); };
  await showPanel('projects');
  // The first visits are measured once (no reps), after the background start (BACKGROUND_MAX_CELLS = 12) started the 12-cell
  // grid and the window was idle for a while; the 4-cell grid was not started.
  if (only.has('tabs')) {
    await app.until(`${JSON.stringify(T.a12.cells.map((c) => c.id))}.every((id) => window.__mc.terminals.has(id))`, 'background start', 60000).catch(() => console.error('    the 12-cell grid was not started in the background'));
    await sleep(4000);
  }
  if (only.has('tabs')) await measure('tab first visit', async () => { for (const id of ['a12', 'a4', 'a16']) { await selectTab(id); await sleep(1500); } });
  else for (const id of ['a12', 'a4', 'a16']) { await selectTab(id); await sleep(1500); }
  for (let i = 0; i < 2; i++) await type(T.a12.cells[i].id, `"${process.execPath}" "${WRITER}"`).catch(() => {});
  for (const p of ['Beta', 'Gamma', 'Alpha']) { await selectProject(p); await sleep(2000); }
  await ev('document.activeElement?.blur(), true');
  await sleep(2000);

  if (only.has('tabs')) {
    await measure('tab grid16-grid12-grid4', async () => {
      for (let i = 0; i < reps; i++) for (const id of ['a12', 'a4', 'a16']) { await selectTab(id); await sleep(700); }
    });
    await measure('tab settings-grid', async () => {
      for (let i = 0; i < reps; i++) {
        await click('.tb-btn[aria-label="Settings"]'); await sleep(700);
        await selectTab('a16'); await sleep(700);
      }
    });
  }
  if (only.has('projects')) {
    await measure('project switch', async () => {
      for (let i = 0; i < reps; i++) for (const p of ['Beta', 'Gamma', 'Alpha']) { await selectProject(p); await sleep(800); }
    });
  }
  if (only.has('scroll')) {
    const quiet = T.a16.cells[5].id;
    const box = async (id) => ev(`(() => { const el = window.__mc.terminals.xterm(${JSON.stringify(id)}).element; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()`);
    const viewportY = (id) => ev(`window.__mc.terminals.xterm(${JSON.stringify(id)}).buffer.active.viewportY`);
    const wheel = async (id, n, dy) => {
      const p = await box(id);
      const y0 = await viewportY(id);
      for (let i = 0; i < n; i++) { await mouse('mouseWheel', p.x, p.y, { button: 'none', deltaX: 0, deltaY: dy }); await sleep(16); }
      if (dy < 0 && (await viewportY(id)) === y0) console.error(`    the wheel did not scroll ${id} (viewportY ${y0})`);
    };
    await measure('scroll wheel long', async () => { for (let i = 0; i < reps; i++) { await wheel(quiet, 40, -120); await wheel(quiet, 40, 120); } });
    await measure('scroll scrollbar drag', async () => {
      for (let i = 0; i < reps; i++) {
        const p = await ev(`(() => { const el = window.__mc.terminals.xterm(${JSON.stringify(quiet)}).element.querySelector('.scrollbar.vertical .slider'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.max(2, r.height / 2)) }; })()`);
        if (!p) throw new Error('no scrollbar slider');
        const b = await box(quiet);
        await drag(p, 0, -(p.y - b.top - 4), 40);
        await drag({ x: p.x, y: b.top + 4 }, 0, p.y - b.top - 4, 40);
      }
    });
    await measure('scroll wheel printing', async () => { for (let i = 0; i < reps; i++) { await wheel(T.a16.cells[1].id, 30, -120); await wheel(T.a16.cells[1].id, 30, 120); } });
  }
  if (only.has('panels')) {
    await measure('settings sections', async () => {
      await click('.tb-btn[aria-label="Settings"]'); await sleep(800);
      const n = await ev(`document.querySelectorAll('.settings-nav [role=tab]').length`);
      for (let r = 0; r < Math.max(1, Math.round(reps / 2)); r++) for (let i = 0; i < n; i++) {
        const p = await ev(`(() => { const r = document.querySelectorAll('.settings-nav [role=tab]')[${i}].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y); await sleep(450);
      }
      await selectTab('a16');
    });
    await measure('git panel + commit', async () => {
      for (let i = 0; i < reps; i++) {
        await showPanel('git'); await sleep(900);
        await click('.git-commit'); await sleep(700);
        await key('Escape', 'Escape', 27, 0); await sleep(300);
        await showPanel('projects'); await sleep(600);
      }
    });
    await measure('git history scroll', async () => {
      await showPanel('git'); await sleep(900);
      const p = await center('.git-log');
      for (let i = 0; i < reps * 10; i++) { await mouse('mouseWheel', p.x, p.y, { button: 'none', deltaX: 0, deltaY: 200 }); await sleep(16); }
      for (let i = 0; i < reps * 10; i++) { await mouse('mouseWheel', p.x, p.y, { button: 'none', deltaX: 0, deltaY: -200 }); await sleep(16); }
      await showPanel('projects'); await sleep(400);
    });
    for (const id of ['files', 'waiting', 'monitor']) {
      await measure(`${id} panel`, async () => { for (let i = 0; i < reps; i++) { await showPanel(id); await sleep(700); await showPanel('projects'); await sleep(600); } });
    }
    await measure('ai team panel', async () => { for (let i = 0; i < reps; i++) { await click('.team-toggle'); await sleep(700); await click('.team-toggle'); await sleep(600); } });
    await measure('command palette', async () => { for (let i = 0; i < reps; i++) { await key('k', 'KeyK', 75, 2); await sleep(500); await app.insertText('gr'); await sleep(400); await key('Escape', 'Escape', 27, 0); await sleep(500); } });
    await measure('all tabs menu', async () => { for (let i = 0; i < reps; i++) { await click('.tabs-all'); await sleep(500); await key('Escape', 'Escape', 27, 0); await sleep(500); } });
    await measure('conversation search', async () => { for (let i = 0; i < reps; i++) { await key('f', 'KeyF', 70, 3); await sleep(700); await key('Escape', 'Escape', 27, 0); await sleep(500); } });
    await measure('limits fold', async () => { for (let i = 0; i < reps; i++) { await click('.usage-head'); await sleep(500); await click('.usage-head'); await sleep(500); } });
  }
  if (only.has('resize')) {
    await measure('resize window', async () => {
      for (let i = 0; i < reps; i++) {
        for (let s = 1; s <= 20; s++) { await main.setBounds({ x: -6000, y: 0, width: 1600 - s * 15, height: 1000 - s * 10 }); await sleep(16); }
        for (let s = 19; s >= 0; s--) { await main.setBounds({ x: -6000, y: 0, width: 1600 - s * 15, height: 1000 - s * 10 }); await sleep(16); }
        await sleep(400);
      }
    });
    await measure('resize sidebar', async () => {
      for (let i = 0; i < reps; i++) { const p = await center('.panel-resize.edge-sidebar'); await drag(p, 120, 0); await sleep(300); await drag({ x: p.x + 120, y: p.y }, -120, 0); await sleep(400); }
    });
    await measure('resize grid divider', async () => {
      for (let i = 0; i < reps; i++) { const p = await center('.grid-divider.col, .grid-divider'); await drag(p, 100, 0); await sleep(300); await drag({ x: p.x + 100, y: p.y }, -100, 0); await sleep(400); }
    });
    await measure('resize limits handle', async () => {
      for (let i = 0; i < reps; i++) { const p = await center('.usage-resize'); if (!p) throw new Error('no limits handle'); await drag(p, 0, -80); await sleep(300); await drag({ x: p.x, y: p.y - 80 }, 0, 80); await sleep(400); }
    });
  }
  if (only.has('window')) {
    await measure('maximize cell', async () => {
      for (let i = 0; i < reps; i++) { await ev(`window.__mc.actions.toggleMaximize(${JSON.stringify(T.a16.cells[5].id)}), true`); await sleep(700); await ev(`window.__mc.actions.toggleMaximize(${JSON.stringify(T.a16.cells[5].id)}), true`); await sleep(700); }
    });
    await measure('detach grid and back', async () => {
      for (let i = 0; i < Math.min(3, reps); i++) {
        await selectTab('a4'); await sleep(600);
        await ev(`window.__mc.detach.detachKey('grid:a4', 'menu')`);
        await app.until(`(window.__mc.useStore.getState().s.detachedWindows ?? []).length === 1`, 'detached', 15000);
        await sleep(1500);
        await ev(`window.__mc.detach.requestAttach(window.__mc.useStore.getState().s.detachedWindows[0].id), true`);
        await app.until(`(window.__mc.useStore.getState().s.detachedWindows ?? []).length === 0`, 'attached', 15000);
        await sleep(1500);
      }
      await selectTab('a16');
    });
  }
  await idleFrame();
} finally {
  try { main?.close(); } catch { /* closed */ }
  await app.close();
  if (gpuCache) for (const d of GPU_CACHE_DIRS) if (existsSync(join(gpuBase, d))) cpSync(join(gpuBase, d), join(gpuCache, d), { recursive: true, force: true });
  removeScratch(root);
}
const text = JSON.stringify(result, null, 1);
if (outFile) writeFileSync(outFile, text);
console.log(Object.entries(result.scenarios).map(([k, v]) => `${k}\t${v.p50}\t${v.p95}\t${v.max}\t${v.over50}\t${v.dropped}\t${v.loafMax}\t${v.inpMax}`).join('\n'));
