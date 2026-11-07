// Output throughput and timer cadence of the built app while its window is minimized (Windows only; run `npm run build:check` first, MC_APP_TARGET=electron: `npm run build`).
// Two cmd cells in a scratch data dir and home; one runs a Node writer that prints 16 MB in 200-byte lines whenever a trigger
// file appears and records how long its writes took (the pty holds the writer back while the renderer does not ack).
// The window is minimized and restored with user32 ShowWindow on the window of the process this script started.
// Usage: node scripts/perf-hidden.mjs [label]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';
import { measurementNeedsCompleteApp } from './real-app.mjs';

// Numbers from an app that still answers MC_NOT_YET mean nothing: blocked until every package it calls landed.
measurementNeedsCompleteApp();

if (process.platform !== 'win32') throw new Error('perf-hidden is Windows only');
const label = process.argv[2] ?? 'run';
const root = mkdtempSync('D:\\Projekty\\_tmp-093build-'); // outside the repo; never the real home or data dir
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
const project = join(root, 'project');
const writer = join(root, 'writer.cjs');
writeFileSync(writer, `
const fs = require('fs'); const path = require('path');
const dir = ${JSON.stringify(root)}; const line = 'x'.repeat(198) + '\\r\\n'; const total = 16 * 1024 * 1024;
let n = 0;
const write = (s) => new Promise((r) => { if (process.stdout.write(s)) r(); else process.stdout.once('drain', r); });
(async () => { for (;;) {
  const go = path.join(dir, 'go-' + n);
  if (!fs.existsSync(go)) { await new Promise((r) => setTimeout(r, 50)); continue; }
  const t0 = Date.now(); let sent = 0;
  while (sent < total) { await write(line.repeat(50)); sent += line.length * 50; }
  fs.writeFileSync(path.join(dir, 'result-' + n), String(Date.now() - t0)); n++;
} })();
`);
const areas = [0, 1].map((col) => ({ col, row: 0, colSpan: 1, rowSpan: 1 }));
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Hidden', path: project, color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
    id: 't', name: 'Grid', layout: { cols: 2, rows: 1, areas }, cells: [0, 1].map((i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
  }] }],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 13, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'off' },
}));

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const user32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); public delegate bool P(System.IntPtr h, System.IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(P f, System.IntPtr l); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);';`;
/** ShowWindow on the visible top-level windows of `pid` (6 = SW_MINIMIZE, 9 = SW_RESTORE); prints whether they are iconic. */
const showWindow = (pid, cmd) => ps(`${user32} $out = @(); [W.U]::EnumWindows({ param($h, $l) $p = 0; [void][W.U]::GetWindowThreadProcessId($h, [ref]$p); if ($p -eq ${Number(pid)} -and [W.U]::IsWindowVisible($h)) { [void][W.U]::ShowWindow($h, ${cmd}); $script:out += [W.U]::IsIconic($h) }; $true }, [IntPtr]::Zero) | Out-Null; $out -join ','`);
/** CPU seconds (user + kernel) of `pid` and all its descendants. */
const treeCpu = (pid) => Number(ps(`$all = Get-CimInstance Win32_Process; $ids = @(${Number(pid)}); $i = 0; while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { $_.ProcessId }); $i++ }; $t = ($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { $_.UserModeTime + $_.KernelModeTime } | Measure-Object -Sum).Sum; ([math]::Round($t / 1e7, 2)).ToString([cultureinfo]::InvariantCulture)`));

let app;
const results = {};
try {
  app = await launchApp(root);
  await app.until(`document.querySelectorAll('.cell .xterm').length >= 2`, 'two terminals');
  await sleep(2500);
  await app.evaluate(`document.querySelector('.cell .xterm-helper-textarea').focus(), true`);
  await app.insertText(`"${process.execPath}" "${writer}"`);
  await app.press('Enter');
  await sleep(1500);
  let run = 0;
  const writeOnce = async () => {
    const n = run++;
    writeFileSync(join(root, `go-${n}`), '');
    const t0 = Date.now();
    while (!existsSync(join(root, `result-${n}`))) { if (Date.now() - t0 > 60000) return '>60000 (still writing)'; await sleep(50); }
    return Number(readFileSync(join(root, `result-${n}`), 'utf8'));
  };
  const probe = `(() => { window.__ticks = []; clearInterval(window.__probe); window.__probe = setInterval(() => window.__ticks.push(performance.now()), 400); return true; })()`;
  const cadence = async () => app.evaluate(`(() => { const t = window.__ticks; const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b); return d.length ? { ticks: t.length, median: Math.round(d[d.length >> 1]), p95: Math.round(d[Math.floor(d.length * 0.95)]), max: Math.round(d[d.length - 1]) } : null; })()`);
  const state = () => app.evaluate(`({ visibility: document.visibilityState, windowShown: document.documentElement.dataset.windowShown ?? null, hostsHidden: [...document.querySelectorAll('.cell .xterm')].filter((x) => !x.offsetParent).length })`);

  // Visible: warm-up, then the measured run.
  await writeOnce();
  const cpu0 = treeCpu(app.pid);
  results.visibleMs = await writeOnce();
  results.visibleCpuS = +(treeCpu(app.pid) - cpu0).toFixed(2);

  /** One 16 MB run and 10 s idle in the current window state: writer time, timer cadence, CPU of the whole process tree. */
  const measure = async () => {
    const out = { state: await state() };
    await app.evaluate(probe);
    const cpu = treeCpu(app.pid);
    out.writeMs = await writeOnce();
    if (typeof out.writeMs === 'string') { out.cadenceWhileWriting = await cadence(); return out; }
    out.writeCpuS = +(treeCpu(app.pid) - cpu).toFixed(2);
    await app.evaluate(probe);
    const idle = treeCpu(app.pid);
    await sleep(10000);
    out.idleCpuS = +(treeCpu(app.pid) - idle).toFixed(2);
    out.idleCadence = await cadence();
    return out;
  };
  // Minimized. The test window is off-screen and not focusable, so Chromium still calls the page visible here.
  results.iconic = showWindow(app.pid, 6);
  await sleep(2000);
  results.minimized = await measure();
  // Restored: the off-screen window is now seen as occluded, so the page is hidden: the state Chromium throttles.
  results.restored = showWindow(app.pid, 9);
  await sleep(300);
  results.afterRestore = { ...(await state()), focusInTerminal: await app.evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea') ?? false`), canvases: await app.evaluate(`document.querySelectorAll('.cell .xterm canvas').length`) };
  await sleep(2000);
  results.occluded = await measure();
  console.log(JSON.stringify({ label, ...results }, null, 1));
} finally {
  await app?.close();
  removeScratch(root);
}
