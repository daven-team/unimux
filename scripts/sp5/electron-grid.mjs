// SP5 reference of 1.1.4 for the flood check (the Electron build of this tree, `npm run build` first): a 5x4 grid of cmd
// cells, each running the same generator as scripts/sp5/run.mjs flood (unimux-pty-flood <rate> 0), measured like
// scripts/perf-grid.mjs (rAF intervals, long tasks, main-thread time, CPU of the app tree) plus the characters xterm got
// (term.write wrapped). Scratch data dir and home only.
//
//   node scripts/sp5/electron-grid.mjs [cells=20] [rate=1000000] [seconds=15] [--latency[=keys]]
// --latency: cell 1 stays a plain cmd prompt and is typed into (the perf-latency.mjs probe) while the other cells flood.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, sleep } from '../ssh-ui-lib.mjs';
import { cdpKey, measureLatency, PROBE } from './latency-probe.mjs';
import { removeScratch } from '../app-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const count = Number(pos[0] ?? 20);
const rate = Number(pos[1] ?? 1_000_000);
const seconds = Number(pos[2] ?? 15);
const latencyArg = process.argv.find((a) => a.startsWith('--latency'));
const latencyKeys = latencyArg ? Number(latencyArg.split('=')[1] ?? 60) : 0;
const flood = join(root, 'src-tauri', 'target', 'release', 'unimux-pty-flood.exe');
if (!existsSync(flood)) throw new Error('build the flood helper first (cargo build --release -p unimux-pty --bins)');
const cols = 5;
const rows = Math.ceil(count / cols);
const scratch = mkdtempSync('D:\\Projekty\\_tmp-sp5grid-');
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(scratch, dir), { recursive: true });
const areas = Array.from({ length: count }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 }));
writeFileSync(join(scratch, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Grid', path: join(scratch, 'project'), color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
    id: 't', name: 'Grid', layout: { cols, rows, areas }, cells: areas.map((_, i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
  }] }],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'off' },
  sidebarCollapsed: true, snippetsOpen: false,
}));
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const appCpu = (pid) => Number(ps(`$all = Get-CimInstance Win32_Process; $ids = @(${Number(pid)}); $i = 0; while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $_.Name -notin @('cmd.exe','node.exe','conhost.exe','OpenConsole.exe','unimux-pty-flood.exe') } | ForEach-Object { $_.ProcessId }); $i++ }; $t = ($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { $_.UserModeTime + $_.KernelModeTime } | Measure-Object -Sum).Sum; ([math]::Round($t / 1e7, 2)).ToString([cultureinfo]::InvariantCulture)`));

let app;
try {
  app = await launchApp(scratch);
  await app.until(`document.querySelectorAll('.cell .xterm').length >= ${count}`, `${count} terminals`, 40000);
  await sleep(3000);
  await app.evaluate(`(() => { window.__chars = 0; for (const e of window.__mc.terminals.entries.values()) { const w = e.term.write.bind(e.term); e.term.write = (d, cb) => { window.__chars += typeof d === 'string' ? d.length : d.byteLength; return w(d, cb); }; } return true; })()`);
  for (let i = latencyKeys ? 1 : 0; i < count; i++) {
    await app.evaluate(`document.querySelectorAll('.cell .xterm-helper-textarea')[${i}].focus(), true`);
    await app.insertText(`"${flood}" ${rate} 0`);
    await app.press('Enter');
    await sleep(150);
  }
  await sleep(3000);
  if (latencyKeys) {
    const ev = (e) => app.evaluate(e);
    await app.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await ev(PROBE);
    const r = await measureLatency({ ev, key: (k) => cdpKey(app.cdp, k), sleep, focus: (cell) => ev(`window.__mc.terminals.entries.get(${JSON.stringify(cell)}).term.focus(), true`), cell: 'c0', keys: latencyKeys });
    console.log(JSON.stringify({ app: 'electron-1.1.4', load: { cells: count - 1, rate }, ...r }));
  }
  const results = { count, rate, viewport: await app.evaluate(`[innerWidth, innerHeight, devicePixelRatio]`) };
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
  const cpu0 = appCpu(app.pid);
  const t0 = Date.now();
  await sleep(seconds * 1000);
  const cpu = appCpu(app.pid) - cpu0;
  const m1 = await metrics();
  const secs = (Date.now() - t0) / 1000;
  results.charsPerS = Math.round((await app.evaluate('window.__chars') - c0) / secs);
  results.frames = await app.evaluate(`(() => { const t = window.__frames; const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
    const q = (p) => d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(d.length * p))] * 10) / 10 : null;
    return { fps: Math.round(t.length / ${secs} * 10) / 10, median: q(0.5), p95: q(0.95), max: q(1), over33ms: d.filter((x) => x > 33.4).length, over50ms: d.filter((x) => x > 50).length }; })()`);
  results.longTasks = await app.evaluate(`(() => { const l = window.__long; return { count: l.length, totalMs: Math.round(l.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...l)) }; })()`);
  const per = (name) => Math.round((m1[name] - m0[name]) / secs * 1000);
  results.mainThreadMsPerS = { task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration') };
  results.cpuPercentOfOneCore = Math.round(cpu / secs * 1000) / 10;
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'artifacts', 'sp5', `electron-1.1.4-flood-${count}x${rate}.png`), Buffer.from(data, 'base64'));
  console.log(JSON.stringify(results));
} finally {
  await app?.close();
  await sleep(1000);
  removeScratch(scratch);
}
