// What many terminals in many tabs and windows cost in the built app (Windows only; run `npm run build:check` first, MC_APP_BINARY picks another build).
// One project with three 5x4 grids (60 cmd cells) in a scratch data dir and home; every cell runs a Node writer that prints while its grid's flag file exists.
// Phases: first visit of grids 2 and 3 and grid switches (while grid 1 prints), the shown grid printing, all 60 printing, minimized and
// restored while 20 print, idle (shown and minimized), and the memory and CPU of two detached grids. The window stays off screen, nothing is activated.
// Usage: node scripts/perf-many.mjs [label] [--phases=visit,switch,busy,all,minimized,idle,detached] [--profile-visit]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';
import { measurementNeedsCompleteApp } from './real-app.mjs';

measurementNeedsCompleteApp();
if (process.platform !== 'win32') throw new Error('perf-many is Windows only');
const label = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'run';
const phaseArg = process.argv.find((a) => a.startsWith('--phases='))?.slice(9);
const phases = new Set((phaseArg ?? 'visit,switch,busy,all,minimized,idle,detached').split(','));
const root = mkdtempSync('D:\\Projekty\\_tmp-perfmany-');
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
const writer = join(root, 'writer.cjs');
writeFileSync(writer, `const fs = require('fs'); const flag = process.argv[2]; const colors = [31, 32, 33, 34, 35, 36, 90]; let n = 0;
setInterval(() => { if (!fs.existsSync(flag)) return; let out = ''; for (let i = 0; i < 4; i++, n++) out += '\\x1b[' + colors[n % colors.length] + 'm' + String(n).padStart(7) + '\\x1b[0m ' + 'lorem ipsum dolor sit amet '.repeat(3) + '\\r\\n'; process.stdout.write(out); }, 66);`);
const flag = (t) => join(root, `flag-${t}`);
const on = (...ts) => { for (const t of ts) writeFileSync(flag(t), ''); };
const off = (...ts) => { for (const t of ts) rmSync(flag(t), { force: true }); };

const COLS = 5, ROWS = 4, COUNT = COLS * ROWS;
const areas = Array.from({ length: COUNT }, (_, i) => ({ col: i % COLS, row: Math.floor(i / COLS), colSpan: 1, rowSpan: 1 }));
const TABS = ['a', 'b', 'c'];
const cellIds = (t) => areas.map((_, i) => `${t}${i}`);
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Many', path: join(root, 'project'), color: '#3b82f6', archive: [], activeTabId: 'a',
    tabs: TABS.map((t) => ({ id: t, name: `Grid ${t}`, layout: { cols: COLS, rows: ROWS, areas }, cells: cellIds(t).map((id) => ({ id, name: id, profileId: 'shell' })) })) }],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'off' },
  sidebarCollapsed: true, snippetsOpen: false,
}));

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const TREE = (pid) => `$all = Get-CimInstance Win32_Process; $ids = @(${Number(pid)}); $i = 0; while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $_.Name -notin @('cmd.exe','node.exe','conhost.exe','OpenConsole.exe') } | ForEach-Object { $_.ProcessId }); $i++ }; $tree = @($all | Where-Object { $ids -contains $_.ProcessId })`;
const KIND = `$c = [string]$_.CommandLine; $k = if ($_.Name -eq 'unimux.exe') { 'host' } elseif ($c -match '--type=renderer') { 'renderer' } elseif ($c -match '--type=gpu-process') { 'gpu' } elseif ($c -match 'network.mojom.NetworkService') { 'network' } elseif ($c -match '--type=') { 'utility' } else { 'browser' }`;
/** CPU seconds per process kind of the app tree (shells and writers excluded). */
const cpuBy = (pid) => JSON.parse(ps(`${TREE(pid)}; $by = @{}; $tree | ForEach-Object { ${KIND}; $by[$k] = [double]$by[$k] + ($_.UserModeTime + $_.KernelModeTime) / 1e7 }; $by | ConvertTo-Json -Compress`));
/** Working set and private bytes (MiB) of the tree, per kind, and the renderer processes one by one. */
const memory = (pid) => JSON.parse(ps(`${TREE(pid)}; $by = @{}; $r = @(); $tree | ForEach-Object { ${KIND}; if (-not $by[$k]) { $by[$k] = @{ n = 0; ws = 0; priv = 0 } }; $by[$k].n++; $by[$k].ws += $_.WorkingSetSize / 1MB; $by[$k].priv += $_.PrivatePageCount / 1MB; if ($k -eq 'renderer') { $r += [math]::Round($_.WorkingSetSize / 1MB) } }; @{ by = $by; renderers = $r; ws = [math]::Round(($tree | Measure-Object WorkingSetSize -Sum).Sum / 1MB); priv = [math]::Round(($tree | Measure-Object PrivatePageCount -Sum).Sum / 1MB) } | ConvertTo-Json -Compress -Depth 4`));
const machineTimes = () => cpus().reduce((a, c) => ({ busy: a.busy + c.times.user + c.times.sys + c.times.irq, idle: a.idle + c.times.idle }), { busy: 0, idle: 0 });
const user32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); public delegate bool P(System.IntPtr h, System.IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(P f, System.IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);'`;
/** ShowWindow on the visible top-level windows of `pid`, without activating them: 7 = SW_SHOWMINNOACTIVE, 4 = SW_SHOWNOACTIVATE. */
const showWindows = (pid, cmd) => ps(`${user32}; $out = @(); [W.U]::EnumWindows({ param($h, $l) $p = 0; [void][W.U]::GetWindowThreadProcessId($h, [ref]$p); if ($p -eq ${Number(pid)} -and [W.U]::IsWindowVisible($h)) { [void][W.U]::ShowWindow($h, ${cmd}); $script:out += [W.U]::IsIconic($h) }; $true }, [System.IntPtr]::Zero) | Out-Null; $out -join ','`);

const RECORDER = `(() => { if (window.__rec) return true; const frames = []; const loafs = []; let on = false; let last = 0; let t0 = 0;
  const loop = (t) => { if (!on) return; if (last) frames.push(t - last); last = t; requestAnimationFrame(loop); };
  try { new PerformanceObserver((l) => { if (on) for (const e of l.getEntries()) loafs.push(Math.round(e.duration)); }).observe({ type: 'long-animation-frame', buffered: false }); } catch {}
  addEventListener('pointerdown', () => { t0 = performance.now(); }, { capture: true, passive: true });
  window.__rec = { start() { frames.length = 0; loafs.length = 0; last = 0; if (!on) { on = true; requestAnimationFrame(loop); } return true; }, t0: () => t0,
    stop() { on = false; const s = [...frames].sort((a, b) => a - b); const q = (p) => s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null;
      return { frames: frames.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.length ? +s[s.length - 1].toFixed(1) : null, over17: frames.filter((f) => f > 17).length, over33: frames.filter((f) => f > 33.4).length, over50: frames.filter((f) => f > 50).length, loafMax: Math.max(0, ...loafs), loafs: loafs.length }; } };
  return true; })()`;

let app;
const out = { label };
const stamp = () => ({ m: machineTimes(), t: Date.now() });
const machineBusy = (a) => { const b = machineTimes(); const busy = b.busy - a.m.busy, idle = b.idle - a.m.idle; return Math.round(busy / (busy + idle) * 1000) / 10; };
const perCore = (a, b, s) => { const o = { total: 0 }; for (const k of Object.keys(b)) { const v = Math.round(((b[k] ?? 0) - (a[k] ?? 0)) / s * 1000) / 10; o[k] = v; o.total = Math.round((o.total + v) * 10) / 10; } return o; };
try {
  app = await launchApp(root, { MC_CLI_NO_REGISTRY: '1' }, [], { main: true });
  const ev = app.evaluate;
  await app.until(`document.querySelectorAll('.cell .xterm').length >= ${COUNT}`, 'first grid', 60000);
  await sleep(3000);
  await ev(RECORDER);
  await app.cdp('Performance.enable');
  const metrics = async () => Object.fromEntries((await app.cdp('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await ev(`(() => { window.__invokes = {}; const orig = window.fetch.bind(window);
    window.fetch = (url, ...rest) => { const u = String(url); if (u.startsWith('http://ipc.localhost/') || u.startsWith('ipc://')) { const cmd = decodeURIComponent(u.split('/').pop()); window.__invokes[cmd] = (window.__invokes[cmd] ?? 0) + 1; } return orig(url, ...rest); }; return true; })()`);
  const webgl = () => ev(`(() => { const cells = [...document.querySelectorAll('.cell')].filter((c) => c.querySelector('.xterm')); const gl = cells.filter((c) => c.querySelector('.xterm-screen canvas')).length; return { cells: cells.length, webgl: gl }; })()`);
  const typeWriters = async (t) => {
    for (const id of cellIds(t)) {
      await ev(`window.__mc.terminals.focus(${JSON.stringify(id)}), true`);
      await app.insertText(`"${process.execPath}" "${writer}" "${flag(t)}"`);
      await app.press('Enter');
      await sleep(80);
    }
    await ev('document.activeElement?.blur(), true');
  };
  const clickTab = async (t) => {
    const p = await ev(`(() => { const el = document.querySelector('.tab.grid-tab[data-workspace-id="grid:${t}"]'); if (!el) throw new Error('no tab ${t}'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const mouse = (type, extra = {}) => app.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, ...extra });
    await mouse('mouseMoved', { button: 'none' }); await mouse('mousePressed'); await mouse('mouseReleased');
  };
  const shownTab = (t) => `(() => { const ids = ${JSON.stringify(cellIds(t))}; if (window.__mc.useStore.getState().s.projects[0].activeTabId !== ${JSON.stringify(t)}) return false; return ids.every((id) => window.__mc.terminals.xterm(id)?.element?.offsetParent != null); })()`;
  const prompted = (t) => `${JSON.stringify(cellIds(t))}.every((id) => { const x = window.__mc.terminals.xterm(id); if (!x) return false; const b = x.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true).trimEnd().endsWith('>')) return true; return false; })`;
  /** Page-side ms from the last click to the second frame after `expression` holds. */
  const sinceClick = (expression) => ev(`new Promise((res, rej) => { const until = performance.now() + 15000; const step = () => { if (${expression}) { requestAnimationFrame(() => requestAnimationFrame(() => res(+(performance.now() - window.__rec.t0()).toFixed(1)))); return; } if (performance.now() > until) { rej(new Error('timeout')); return; } requestAnimationFrame(step); }; step(); })`);

  await typeWriters('a');
  on('a');
  await sleep(5000);
  out.grid1 = await webgl();

  if (phases.has('visit')) {
    out.firstVisit = {};
    for (const t of ['b', 'c']) {
      await ev('__rec.start()');
      const profiling = process.argv.includes('--profile-visit');
      if (profiling) { await app.cdp('Profiler.enable'); await app.cdp('Profiler.setSamplingInterval', { interval: 500 }); await app.cdp('Profiler.start'); }
      await clickTab(t);
      const ms = await sinceClick(`(${shownTab(t)}) && (${prompted(t)})`);
      await sleep(1500);
      if (profiling) {
        const { profile } = await app.cdp('Profiler.stop');
        const total = (profile.timeDeltas ?? []).reduce((a, b) => a + b, 0) / 1000;
        const self = new Map(); const ids = new Map(profile.nodes.map((n) => [n.id, n]));
        profile.samples.forEach((id, i) => { const n = ids.get(id); const k = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`; self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000); });
        console.error(`first visit ${t}: profile ${Math.round(total)} ms; top self:`);
        for (const [k, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 28)) console.error(`  ${ms.toFixed(1)} ms  ${k}`);
      }
      out.firstVisit[t] = { ms, frames: await ev('__rec.stop()'), renderers: await webgl() };
      await typeWriters(t);
      await sleep(300);
    }
    await clickTab('a');
    await sleep(2000);
  }

  if (phases.has('switch')) {
    await sleep(800);
    const mark = stamp();
    await ev('__rec.start()');
    const ms = [];
    for (let i = 0; i < 3; i++) for (const t of ['b', 'c', 'a']) {
      await clickTab(t);
      ms.push(await sinceClick(shownTab(t)));
      await sleep(700);
    }
    const f = await ev('__rec.stop()');
    ms.sort((a, b) => a - b);
    out.switch = { median: ms[ms.length >> 1], max: ms[ms.length - 1], frames: f, machineBusy: machineBusy(mark) };
    await sleep(500);
  }

  // `frames`: count frames with a rAF loop (it keeps the page drawing, so never in the idle and minimized phases).
  const measureCpu = async (name, seconds, frames = true) => {
    await ev(`window.__invokes = {}, ${frames ? '__rec.start()' : 'true'}`);
    const m0 = await metrics();
    const mark = stamp();
    const c0 = cpuBy(app.pid);
    const t0 = Date.now();
    await sleep(seconds * 1000);
    const c1 = cpuBy(app.pid);
    const s = (Date.now() - t0) / 1000;
    const m1 = await metrics();
    const per = (k) => Math.round((m1[k] - m0[k]) / s * 1000);
    const f = frames ? await ev('__rec.stop()') : null;
    out[name] = { cpu: perCore(c0, c1, s), frames: f && { fps: Math.round(f.frames / s), p95: f.p95, max: f.max, over50: f.over50 }, mainMsPerS: { task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration') },
      invokesPerS: await ev(`Object.fromEntries(Object.entries(window.__invokes).map(([k, v]) => [k, Math.round(v / ${s} * 10) / 10]))`), machineBusy: machineBusy(mark) };
  };

  if (phases.has('busy')) { await sleep(2000); await measureCpu('busyShown', 15); }
  if (phases.has('all') && phases.has('visit')) { on('b', 'c'); await sleep(3000); await measureCpu('busyAll60', 15); off('b', 'c'); await sleep(1500); }

  if (phases.has('minimized')) {
    await sleep(1500);
    const baseY = () => ev(`${JSON.stringify(cellIds('a'))}.reduce((n, id) => n + window.__mc.terminals.xterm(id).buffer.active.baseY, 0)`);
    // The counter the writer prints last, read from the buffer of a cell: output kept while minimized, whatever the scrollback cap does to baseY.
    const counter = () => ev(`(() => { const b = window.__mc.terminals.xterm('a0').buffer.active; for (let y = b.length - 1; y >= 0; y--) { const m = /^ *([0-9]{1,7}) lorem/.exec(b.getLine(y)?.translateToString(true) ?? ''); if (m) return Number(m[1]); } return -1; })()`);
    const y0 = await baseY();
    const n0 = await counter();
    out.iconic = showWindows(app.pid, 7);
    await sleep(1500);
    await ev(`(() => { window.__ticks = []; clearInterval(window.__probe); window.__probe = setInterval(() => window.__ticks.push(performance.now()), 400); return true; })()`);
    await measureCpu('minimizedBusy', 30, false);
    out.minimizedBusy.scrolledLines = (await baseY()) - y0;
    out.minimizedBusy.printedLines = (await counter()) - n0;
    out.minimizedBusy.cadence = await ev(`(() => { const t = window.__ticks; const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b); return d.length ? { median: Math.round(d[d.length >> 1]), p95: Math.round(d[Math.floor(d.length * 0.95)]), max: Math.round(d[d.length - 1]) } : null; })()`);
    out.minimizedBusy.visibility = await ev('({ visibility: document.visibilityState, shown: document.documentElement.dataset.windowShown ?? null })');
    out.minimizedBusy.mem = memory(app.pid);
    await ev('clearInterval(window.__probe), __rec.start()');
    out.restored = showWindows(app.pid, 4);
    await sleep(5000);
    out.restore = { frames: await ev('__rec.stop()'), renderers: await webgl() };
    // Output order and loss: the writer numbers its lines, so the numbers in a cell's buffer must go up by one (the buffer's start is cut by the scrollback only).
    out.restore.continuity = await ev(`['a0', 'a7', 'a19'].map((id) => { const b = window.__mc.terminals.xterm(id).buffer.active; let last = -1, lines = 0, gaps = 0; for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (!l || l.isWrapped) continue; const m = /^ *([0-9]{1,7}) lorem/.exec(l.translateToString(true)); if (!m) continue; const n = Number(m[1]); if (last >= 0 && n !== last + 1) gaps++; last = n; lines++; } return { id, lines, gaps, last }; })`);
    await app.screenshot(`perf-many-restore-${label}.png`);
  }

  if (phases.has('idle')) {
    off('a', 'b', 'c');
    await sleep(3000);
    await measureCpu('idleShown', 15, false);
    showWindows(app.pid, 7);
    await sleep(3000);
    await measureCpu('idleMinimized', 15, false);
    showWindows(app.pid, 4);
    await sleep(2000);
    on('a');
    await sleep(2000);
  }

  if (phases.has('detached') && phases.has('visit')) {
    await clickTab('a');
    await sleep(2500);
    const detached = () => ev(`(window.__mc.useStore.getState().s.detachedWindows ?? []).length`);
    out.detached = { memBefore: memory(app.pid) };
    for (const t of ['b', 'c']) {
      const n = await detached();
      await ev(`window.__mc.detach.detachKey('grid:${t}', 'menu')`);
      await app.until(`(window.__mc.useStore.getState().s.detachedWindows ?? []).length > ${n}`, `detach ${t}`, 30000);
      await sleep(6000);
    }
    await sleep(4000);
    out.detached.memAfter2 = memory(app.pid);
    off('a');
    await sleep(2500);
    await measureCpu('detachedIdle', 15, false);
    on('a', 'b', 'c');
    await sleep(3000);
    await measureCpu('detachedBusyAll60', 15);
    out.detached.memBusy = memory(app.pid);
    showWindows(app.pid, 7);
    await sleep(3000);
    await measureCpu('detachedMinimizedBusy', 20, false);
    showWindows(app.pid, 4);
    off('a', 'b', 'c');
    await sleep(1000);
  }
  console.log(JSON.stringify(out));
} finally {
  await app?.close();
  await sleep(500);
  removeScratch(root);
}
