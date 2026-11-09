// P2 real-app checks (Windows): the Rust pty output engine and data plane under the real renderer (TerminalManager) of
// the Tauri check build. The app starts the cmd cells of a scratch state itself (cell:spawn), so everything is the shipped
// path: OutputChannel, FlowGate, the per-window batcher, the transport (shared buffers by default), the bridge's pty port,
// TerminalManager.
//
//   npm run build:check && (cd src-tauri && node ../scripts/msvc-run.mjs cargo build --release -p unimux-pty --bins)
//   node scripts/verify-tauri-pty.mjs [replay] [latency] [grid] [reload] [--cells=20] [--rate=1000000] [--seconds=15]
//        [--keys=60] [--load] [--reloads=8] [--reload-rate=2000000] [--transport=sharedBuffer|pull|channel] [--keep]
//
// replay   a cmd cell is narrowed and widened (recorded sizes), the page reloads, the replay draws the same screen;
//          the transport is the expected one and the frames path is in use.
// latency  keystroke -> echo drawn in a cmd cell (the perf-latency.mjs probe), idle; with --load while the 19 other cells
//          of a 5x4 grid run unimux-pty-flood at --rate (the 1.1.4 numbers: docs/tauri/spikes/SP5.md).
// grid     20 cells x --rate for --seconds: fps / frame times like the SP5 run of 1.1.4, plus the P2 bounds:
//          shared buffers posted and not released per window (host and page side) and unacked bytes per terminal.
// reload   4 cells x --reload-rate, --reloads page reloads: after each the host keeps posting, its queue stays bounded
//          and no in-flight cap needed the timeout (buffers of the old attach are dropped by the new page).
// Results: artifacts/p2/results-<time>.json. Scratch data dir and home only (ssh-ui-lib launchApp), offscreen window.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch } from './app-env.mjs';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { cdpKey, measureLatency, PROBE } from './sp5/latency-probe.mjs';

if (process.platform !== 'win32') throw new Error('verify-tauri-pty is Windows only (macOS: the pull transport, open in PROGRESS.md)');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'artifacts', 'p2');
mkdirSync(outDir, { recursive: true });
const argv = process.argv.slice(2);
const opt = (name, def) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const wanted = argv.filter((a) => !a.startsWith('--'));
const runs = wanted.length ? wanted : ['replay', 'latency', 'grid', 'reload'];
const cellCount = Number(opt('cells', 20));
const rate = Number(opt('rate', 1_000_000));
const seconds = Number(opt('seconds', 15));
const keys = Number(opt('keys', 60));
const load = argv.includes('--load');
const transport = opt('transport', '');
const keep = argv.includes('--keep');
const flood = join(root, 'src-tauri', 'target', 'release', 'unimux-pty-flood.exe');
if ((runs.includes('grid') || load) && !existsSync(flood)) throw new Error('build the flood helper first: cd src-tauri && node ../scripts/msvc-run.mjs cargo build --release -p unimux-pty --bins');

const results = { date: new Date().toISOString(), runs, transport: transport || 'default' };
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

/** The 5x4 grid state of 1.1.4's SP5 reference run (scripts/sp5/electron-grid.mjs until R1: same cells, font, shell). */
function gridState(scratch, count) {
  const cols = Math.min(5, count);
  const rows = Math.ceil(count / cols);
  const areas = Array.from({ length: count }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 }));
  return {
    version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Grid', path: join(scratch, 'project'), color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
      id: 't', name: 'Grid', layout: { cols, rows, areas }, cells: areas.map((_, i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
    }] }],
    profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
    snippets: [], presets: [], settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'off' },
    sidebarCollapsed: true, snippetsOpen: false,
  };
}

async function withApp(count, fn) {
  const scratch = mkdtempSync('D:\\Projekty\\_tmp-p2pty-');
  for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(scratch, dir), { recursive: true });
  writeFileSync(join(scratch, 'data', 'state.json'), JSON.stringify(gridState(scratch, count)));
  const app = await launchApp(scratch, transport ? { MC_PTY_TRANSPORT: transport } : {});
  try {
    await app.until(`document.querySelectorAll('.cell .xterm').length >= ${count} && window.__mc.terminals.entries.size >= ${count}`, `${count} terminals`, 60000);
    // The app starts the cells itself (cell:spawn, P3 / P4: cmd from the settings, at the terminal's size); a second start
    // through the test bridge would replace those terminals under a running page.
    await app.until(`[...window.__mc.terminals.entries.values()].every((e) => { const b = e.term.buffer.active; for (let i = 0; i < b.length; i++) if (/>\\s*$/.test(b.getLine(i)?.translateToString(true) ?? '')) return true; return false; })`, 'every prompt', 60000);
    return await fn(app, scratch);
  } finally {
    try { await app.bridge('pty', { action: 'killAll' }); } catch { /* gone */ }
    await app.close();
    await sleep(800);
    if (!keep) removeScratch(scratch); else console.log(`kept ${scratch}`);
  }
}

const screenLines = (id) => `(() => { const b = window.__mc.terminals.entries.get(${JSON.stringify(id)}).term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i).translateToString(true).trimEnd(); if (l) out.push(l); } return out; })()`;
const portStats = `(() => { const p = window.__MC_PTY_PORT__; return p ? { ...p.stats } : null; })()`;

async function typeLine(app, id, text) {
  await app.evaluate(`window.__mc.terminals.entries.get(${JSON.stringify(id)}).term.focus(), true`);
  await app.insertText(text);
  await app.press('Enter');
}

if (runs.includes('replay')) {
  await withApp(2, async (app) => {
    const port = await app.evaluate(portStats);
    check(port && port.received > 0, `the pty port receives frames (transport ${port?.transport}, ${port?.received} messages)`);
    if (!transport) check(port?.transport === 'sharedBuffer', 'Windows uses the WebView2 shared buffers by default');
    const marker = `P2REPLAY${Date.now() % 100000}`;
    // A long command typed at the cell's width, then the window narrowed and widened again: three recorded sizes.
    await typeLine(app, 'c0', `echo ${marker} ${'x'.repeat(70)} end`);
    await app.until(`${screenLines('c0')}.some((l) => l.startsWith('${marker}'))`, 'echo output');
    for (const width of [520, 1100]) {
      await app.cdp('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
      await sleep(1500);
      await typeLine(app, 'c0', `echo ${marker}-${width}`);
      await app.until(`${screenLines('c0')}.some((l) => l.startsWith('${marker}-${width}'))`, `echo at ${width}`);
      await sleep(500);
    }
    const tail = await app.bridge('pty', { action: 'replay', id: 'c0' });
    check(tail.sizes.length >= 3, `the tail recorded ${tail.sizes.length} sizes (${tail.sizes.map((s) => `${s.cols}x${s.rows}@${s.at}`).join(', ')})`);
    const before = await app.evaluate(screenLines('c0'));
    await app.cdp('Page.reload');
    await sleep(1000);
    await app.until(`!!document.querySelector('.app .workspace-tabs') && window.__mc?.terminals?.entries?.has('c0')`, 'reloaded', 60000);
    await app.until(`${screenLines('c0')}.some((l) => l.startsWith('${marker}-1100'))`, 'replayed', 30000);
    await sleep(1500);
    const after = await app.evaluate(screenLines('c0'));
    const mine = (lines) => lines.filter((l) => l.includes(marker));
    results.replay = { sizes: tail.sizes, before: mine(before), after: mine(after), port: await app.evaluate(portStats) };
    check(JSON.stringify(mine(before)) === JSON.stringify(mine(after)), `the reloaded renderer draws the replay like before (${mine(after).length} marker lines)`);
    const host = await app.bridge('pty', { action: 'stats' });
    check(host.replays >= 2, `the host sent ${host.replays} replay tails`);
    await app.cdp('Emulation.clearDeviceMetricsOverride');
  });
}

if (runs.includes('latency')) {
  const count = load ? cellCount : 1;
  await withApp(count, async (app) => {
    for (let i = 1; i < count; i++) {
      await typeLine(app, `c${i}`, `"${flood}" ${rate} 0`);
      await sleep(150);
    }
    if (count > 1) await sleep(3000);
    const ev = (e) => app.evaluate(e);
    await app.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await ev(PROBE);
    const r = await measureLatency({ ev, key: (k) => cdpKey(app.cdp, k), sleep, focus: (cell) => ev(`window.__mc.terminals.entries.get(${JSON.stringify(cell)}).term.focus(), true`), cell: 'c0', keys });
    results[load ? 'latencyLoaded' : 'latency'] = { load: load ? { cells: count - 1, rate } : null, ...r };
    console.log(JSON.stringify({ app: 'tauri-p2', load: load ? { cells: count - 1, rate } : null, ...r }));
  });
}

if (runs.includes('grid')) {
  await withApp(cellCount, async (app) => {
    await app.evaluate(`(() => { window.__chars = 0; for (const e of window.__mc.terminals.entries.values()) { const w = e.term.write.bind(e.term); e.term.write = (d, cb) => { window.__chars += typeof d === 'string' ? d.length : d.byteLength; return w(d, cb); }; } return true; })()`);
    for (let i = 0; i < cellCount; i++) {
      await typeLine(app, `c${i}`, `"${flood}" ${rate} 0`);
      await sleep(150);
    }
    await sleep(3000);
    await app.evaluate(`(() => {
      window.__frames = []; window.__long = [];
      const loop = (t) => { window.__frames.push(t); if (window.__frames.length < 100000) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: false });
      return true; })()`);
    await app.cdp('Performance.enable');
    const metrics = async () => Object.fromEntries((await app.cdp('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const m0 = await metrics();
    const c0 = await app.evaluate('window.__chars');
    const t0 = Date.now();
    let maxUnacked = 0;
    let maxHostInFlight = 0;
    let samples = 0;
    while (Date.now() - t0 < seconds * 1000) {
      const s = await app.bridge('pty', { action: 'stats' });
      for (const t of Object.values(s.terminals)) maxUnacked = Math.max(maxUnacked, t.unacked);
      for (const w of Object.values(s.windows)) maxHostInFlight = Math.max(maxHostInFlight, w.inFlight, w.maxInFlight);
      samples++;
      await sleep(100);
    }
    const secs = (Date.now() - t0) / 1000;
    const m1 = await metrics();
    const g = { cells: cellCount, rate, seconds: Math.round(secs) };
    const per = (name) => Math.round((m1[name] - m0[name]) / secs * 1000);
    g.mainThreadMsPerS = { task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration') };
    g.charsPerS = Math.round((await app.evaluate('window.__chars') - c0) / secs);
    g.frames = await app.evaluate(`(() => { const t = window.__frames; const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
      const q = (p) => d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(d.length * p))] * 10) / 10 : null;
      return { fps: Math.round(t.length / ${secs} * 10) / 10, median: q(0.5), p95: q(0.95), max: q(1), over33ms: d.filter((x) => x > 33.4).length, over50ms: d.filter((x) => x > 50).length }; })()`);
    g.longTasks = await app.evaluate(`(() => { const l = window.__long; return { count: l.length, totalMs: Math.round(l.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...l)) }; })()`);
    const host = await app.bridge('pty', { action: 'stats' });
    g.host = { window: host.windows.main, maxUnackedBytes: maxUnacked, maxInFlightSeen: maxHostInFlight, samples };
    g.page = await app.evaluate(portStats);
    results.grid = g;
    console.log(JSON.stringify(g));
    const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `tauri-p2-flood-${cellCount}x${rate}.png`), Buffer.from(data, 'base64'));
    if (g.page?.transport === 'sharedBuffer') check(g.page.maxInFlight <= 9, `shared buffers posted and not released, page side: at most ${g.page.maxInFlight} (cap 8 small / 2 big messages, one more with an echo)`);
    if (g.page?.transport !== 'pull') check(maxHostInFlight <= 9, `messages in flight per window, host side: at most ${maxHostInFlight} (cap 8 small / 2 big messages, one more with an echo)`);
    // FlowGate: 1 MiB, plus the flush that crossed it (at most 128 KiB) and one read in progress.
    check(maxUnacked <= 1024 * 1024 + 128 * 1024 + 64 * 1024, `unacked bytes per terminal stay within the FlowGate limit (max ${maxUnacked})`);
  });
}

if (runs.includes('reload')) {
  // Page reloads while 4 cells flood (P2 review): buffers the old page's batcher still posts must not put the new page's
  // release count ahead of the host (window frozen at the in-flight cap, host queue growing). After every reload the host
  // keeps posting and its queue stays bounded.
  const cells = 4;
  const reloads = Number(opt('reloads', 8));
  const reloadRate = Number(opt('reload-rate', 2_000_000));
  await withApp(cells, async (app) => {
    for (let i = 0; i < cells; i++) {
      await typeLine(app, `c${i}`, `"${flood}" ${reloadRate} 0`);
      await sleep(150);
    }
    await sleep(2000);
    const rounds = [];
    let stale = 0;
    for (let round = 1; round <= reloads; round++) {
      await app.cdp('Page.reload');
      await sleep(1000);
      await app.until(`!!document.querySelector('.app .workspace-tabs') && window.__mc?.terminals?.entries?.size >= ${cells} && !!window.__MC_PTY_PORT__`, 'reloaded', 60000);
      await sleep(3000);
      const a = (await app.bridge('pty', { action: 'stats' })).windows.main;
      await sleep(3000);
      const b = (await app.bridge('pty', { action: 'stats' })).windows.main;
      const page = await app.evaluate(portStats);
      stale += page?.stale ?? 0;
      const r = { round, posts: [a.posts, b.posts], inFlight: [a.inFlight, b.inFlight], queued: [a.queued, b.queued], capTimeouts: b.capTimeouts, page };
      rounds.push(r);
      console.log(JSON.stringify(r));
      check(b.posts > a.posts, `reload ${round}: the host keeps posting (${a.posts} -> ${b.posts})`);
      check(b.queued <= 1024 * 1024, `reload ${round}: the host queue stays bounded (${a.queued} -> ${b.queued} bytes)`);
      check(b.capTimeouts === 0, `reload ${round}: no in-flight cap had to be lifted by the timeout (${b.capTimeouts})`);
    }
    results.reload = { cells, rate: reloadRate, rounds, staleBuffersDropped: stale };
    console.log(`stale shared buffers dropped by the new pages: ${stale}`);
  });
}

const file = join(outDir, `results-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ ...results, failures }, null, 1));
console.log(`results: ${file}`);
if (failures.length) { console.error(`FAILED: ${failures.join('; ')}`); process.exit(1); }
