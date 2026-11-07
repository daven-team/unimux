// Frame times, long tasks and CPU of the built app with a large grid of busy shells (Windows only; run `npm run build:check` first, MC_APP_TARGET=electron: `npm run build`).
// A 5x4 grid of cmd cells in a scratch data dir and home; every cell runs a Node writer that prints colored lines all the time.
// Reports per run: how many cells draw through WebGL and how many through the DOM renderer, rAF frame intervals, long tasks
// and the CPU seconds of the whole process tree over the measured window. Screenshot to D:\Projekty\_shots\094-grid-<label>.png.
// Usage: node scripts/perf-grid.mjs [label] [cells] [lines per 66 ms tick per cell, default 4]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';
import { measurementNeedsCompleteApp } from './real-app.mjs';

// Numbers from an app that still answers MC_NOT_YET mean nothing: blocked until every package it calls landed.
measurementNeedsCompleteApp();

if (process.platform !== 'win32') throw new Error('perf-grid is Windows only');
const label = process.argv[2] ?? 'run';
const count = Number(process.argv[3] ?? 20);
const lines = Number(process.argv[4] ?? 4);
const cols = 5;
const rows = Math.ceil(count / cols);
const root = mkdtempSync('D:\\Projekty\\_tmp-094rend-'); // outside the repo; never the real home or data dir
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
const writer = join(root, 'writer.cjs');
// About 60 lines a second per cell by default, in bursts like an agent streaming a diff.
writeFileSync(writer, `
const colors = [31, 32, 33, 34, 35, 36, 90];
let n = 0;
setInterval(() => {
  let out = '';
  for (let i = 0; i < ${lines}; i++, n++) out += '\\x1b[' + colors[n % colors.length] + 'm' + String(n).padStart(7) + '\\x1b[0m ' + 'lorem ipsum dolor sit amet '.repeat(3) + '\\r\\n';
  process.stdout.write(out);
}, 66);
`);
const areas = Array.from({ length: count }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 }));
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Grid', path: join(root, 'project'), color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
    id: 't', name: 'Grid', layout: { cols, rows, areas }, cells: areas.map((_, i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
  }] }],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'off' },
  sidebarCollapsed: true, snippetsOpen: false,
}));

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
/** CPU seconds (user + kernel) of `pid` and all its descendants, without the shells and writers (their cost is not the app's). */
const appCpu = (pid) => Number(ps(`$all = Get-CimInstance Win32_Process; $ids = @(${Number(pid)}); $i = 0; while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $_.Name -notin @('cmd.exe','node.exe','conhost.exe','OpenConsole.exe') } | ForEach-Object { $_.ProcessId }); $i++ }; $t = ($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { $_.UserModeTime + $_.KernelModeTime } | Measure-Object -Sum).Sum; ([math]::Round($t / 1e7, 2)).ToString([cultureinfo]::InvariantCulture)`));

let app;
try {
  app = await launchApp(root);
  await app.until(`document.querySelectorAll('.cell .xterm').length >= ${count}`, `${count} terminals`, 40000);
  await sleep(3000);
  for (let i = 0; i < count; i++) {
    await app.evaluate(`document.querySelectorAll('.cell .xterm-helper-textarea')[${i}].focus(), true`);
    await app.insertText(`"${process.execPath}" "${writer}"`);
    await app.press('Enter');
    await sleep(150);
  }
  // The last cell keeps the focus, as after typing into it.
  await sleep(6000);
  const renderers = () => app.evaluate(`(() => { const cells = [...document.querySelectorAll('.cell')].filter((c) => c.querySelector('.xterm'));
    const webgl = cells.filter((c) => c.querySelector('.xterm-screen canvas')).length; return { cells: cells.length, webgl, dom: cells.length - webgl, visibility: document.visibilityState }; })()`);
  const results = { label, count, lines, before: await renderers() };
  await app.evaluate(`(() => {
    window.__frames = []; window.__long = [];
    const loop = (t) => { window.__frames.push(t); if (window.__frames.length < 100000) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: false });
    return true; })()`);
  await app.cdp('Performance.enable');
  const metrics = async () => Object.fromEntries((await app.cdp('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const m0 = await metrics();
  const cpu0 = appCpu(app.pid);
  const t0 = Date.now();
  await sleep(15000);
  const cpu = +(appCpu(app.pid) - cpu0).toFixed(2);
  const m1 = await metrics();
  const seconds = (Date.now() - t0) / 1000;
  results.frames = await app.evaluate(`(() => { const t = window.__frames; const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
    const q = (p) => d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(d.length * p))] * 10) / 10 : null;
    return { frames: t.length, fps: Math.round(t.length / ${seconds} * 10) / 10, median: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), over50ms: d.filter((x) => x > 50).length }; })()`);
  results.longTasks = await app.evaluate(`(() => { const l = window.__long; return { count: l.length, totalMs: Math.round(l.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...l)) }; })()`);
  // Renderer main thread busy time per second of wall clock (CDP Performance metrics).
  const per = (name) => Math.round((m1[name] - m0[name]) / seconds * 1000);
  results.mainThreadMsPerS = { task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration') };
  results.cpuSeconds = cpu;
  results.cpuPercentOfOneCore = Math.round(cpu / seconds * 1000) / 10;
  results.after = await renderers();
  await app.screenshot(`094-grid-${label}.png`);
  console.log(JSON.stringify(results, null, 1));
} finally {
  await app?.close();
  removeScratch(root);
}
