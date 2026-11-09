// What idle cells cost in the built app (Windows only; run `npm run build:check` first, MC_APP_BINARY picks another build).
// One project with three 5x4 grids (60 cmd cells at their prompts) in a scratch data dir and home. After a settle: CPU seconds and context
// switches (wakeups) per process kind of unimux.exe plus its WebView2 tree over a window (shells and their consoles excluded), shown and
// minimized, the memory per kind, and the start times. The window stays off screen, nothing is activated.
// Usage: node scripts/perf-idle.mjs [label] [--seconds=30] [--settle=12] [--threads] [--no-visit] [--fill]
// --no-visit leaves grids b and c unvisited (20 live terminals), --fill prints 1.6 MB in every live cell and records the memory afterwards.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';
import { measurementNeedsCompleteApp } from './real-app.mjs';

measurementNeedsCompleteApp();
if (process.platform !== 'win32') throw new Error('perf-idle is Windows only');
const arg = (name, dflt) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt);
const label = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'run';
const SECONDS = arg('seconds', 30);
const SETTLE = arg('settle', 12) * 1000;
const root = mkdtempSync('D:\\Projekty\\_tmp-perfidle-');
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
const COLS = 5, ROWS = 4, COUNT = COLS * ROWS;
const areas = Array.from({ length: COUNT }, (_, i) => ({ col: i % COLS, row: Math.floor(i / COLS), colSpan: 1, rowSpan: 1 }));
const TABS = ['a', 'b', 'c'];
const cellIds = (t) => areas.map((_, i) => `${t}${i}`);
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Idle', path: join(root, 'project'), color: '#3b82f6', archive: [], activeTabId: 'a',
    tabs: TABS.map((t) => ({ id: t, name: `Grid ${t}`, layout: { cols: COLS, rows: ROWS, areas }, cells: cellIds(t).map((id) => ({ id, name: id, profileId: 'shell' })) })) }],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 11, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'off' },
  sidebarCollapsed: true, snippetsOpen: false,
}));

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 }).trim();
// Every thread's cumulative context switches, from NtQuerySystemInformation(SystemProcessInformation); Get-Process does not have them.
const SPI = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class Spi {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr b, int l, out int r);
  public static string Dump(HashSet<long> pids) {
    int size = 1 << 22; IntPtr buf = Marshal.AllocHGlobal(size); int got; int st;
    while ((st = NtQuerySystemInformation(5, buf, size, out got)) != 0) { Marshal.FreeHGlobal(buf); size *= 2; buf = Marshal.AllocHGlobal(size); if (size > 1 << 28) throw new Exception("SPI " + st); }
    var sb = new StringBuilder(); long at = buf.ToInt64();
    while (true) {
      IntPtr p = new IntPtr(at); int next = Marshal.ReadInt32(p); int threads = Marshal.ReadInt32(p, 4);
      long pid = Marshal.ReadIntPtr(p, 80).ToInt64();
      if (pids.Contains(pid)) for (int i = 0; i < threads; i++) {
        IntPtr t = new IntPtr(at + 256 + i * 80);
        long tid = Marshal.ReadIntPtr(t, 48).ToInt64(); int cs = Marshal.ReadInt32(t, 64); long start = Marshal.ReadIntPtr(t, 32).ToInt64();
        long kt = Marshal.ReadInt64(t, 0), ut = Marshal.ReadInt64(t, 8);
        sb.Append(pid).Append(' ').Append(tid).Append(' ').Append(cs).Append(' ').Append(kt + ut).Append(' ').Append(start.ToString("x")).Append(';');
      }
      if (next == 0) break; at += next;
    }
    Marshal.FreeHGlobal(buf); return sb.ToString();
  }
}
'@`;
const TREE = (pid) => `$all = Get-CimInstance Win32_Process; $ids = @(${Number(pid)}); $i = 0; while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $_.Name -notin @('cmd.exe','node.exe','conhost.exe','OpenConsole.exe') } | ForEach-Object { $_.ProcessId }); $i++ }; $tree = @($all | Where-Object { $ids -contains $_.ProcessId })`;
const KIND = `$c = [string]$_.CommandLine; $k = if ($_.Name -eq 'unimux.exe') { 'host' } elseif ($c -match '--type=renderer') { 'renderer' } elseif ($c -match '--type=gpu-process') { 'gpu' } elseif ($c -match 'network.mojom.NetworkService') { 'network' } elseif ($c -match '--type=') { 'utility' } else { 'browser' }`;
const kinds = (pid) => JSON.parse(ps(`${TREE(pid)}; $m = @{}; $tree | ForEach-Object { ${KIND}; $m[[string]$_.ProcessId] = $k }; $m | ConvertTo-Json -Compress`));
/** { thread key: { kind, cs, cpu100ns, start } } */
const threads = (kindOf) => {
  const add = Object.keys(kindOf).map((p) => `[void]$s.Add(${Number(p)})`).join(';');
  const line = ps(`${SPI}; $s = New-Object 'System.Collections.Generic.HashSet[long]'; ${add}; [Spi]::Dump($s)`);
  const map = new Map();
  for (const e of line.split(';')) { if (!e) continue; const [p, t, cs, cpu, start] = e.split(' '); map.set(`${p}:${t}`, { kind: kindOf[p], cs: Number(cs), cpu: Number(cpu), start }); }
  return map;
};
const memory = (pid) => JSON.parse(ps(`${TREE(pid)}; $by = @{}; $tree | ForEach-Object { ${KIND}; if (-not $by[$k]) { $by[$k] = @{ n = 0; ws = 0; priv = 0 } }; $by[$k].n++; $by[$k].ws += $_.WorkingSetSize / 1MB; $by[$k].priv += $_.PrivatePageCount / 1MB }; @{ by = $by; ws = [math]::Round(($tree | Measure-Object WorkingSetSize -Sum).Sum / 1MB); priv = [math]::Round(($tree | Measure-Object PrivatePageCount -Sum).Sum / 1MB) } | ConvertTo-Json -Compress -Depth 4`));
const machineTimes = () => cpus().reduce((a, c) => ({ busy: a.busy + c.times.user + c.times.sys + c.times.irq, idle: a.idle + c.times.idle }), { busy: 0, idle: 0 });
const user32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); public delegate bool P(System.IntPtr h, System.IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(P f, System.IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);'`;
const showWindows = (pid, cmd) => ps(`${user32}; [W.U]::EnumWindows({ param($h, $l) $p = 0; [void][W.U]::GetWindowThreadProcessId($h, [ref]$p); if ($p -eq ${Number(pid)} -and [W.U]::IsWindowVisible($h)) { [void][W.U]::ShowWindow($h, ${cmd}) }; $true }, [System.IntPtr]::Zero) | Out-Null`);

const out = { label };
let app;
try {
  const t0 = performance.now();
  app = await launchApp(root, { MC_CLI_NO_REGISTRY: '1' }, [], { main: true });
  const ev = app.evaluate;
  out.startup = { pageMs: Math.round(performance.now() - t0) };
  await app.until(`document.querySelectorAll('.cell .xterm').length >= ${COUNT}`, 'first grid', 60000);
  out.startup.gridMs = Math.round(performance.now() - t0);
  const clickTab = async (t) => {
    const p = await ev(`(() => { const el = document.querySelector('.tab.grid-tab[data-workspace-id="grid:${t}"]'); if (!el) throw new Error('no tab ${t}'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const mouse = (type, extra = {}) => app.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, ...extra });
    await mouse('mouseMoved', { button: 'none' }); await mouse('mousePressed'); await mouse('mouseReleased');
  };
  const prompted = (t) => `${JSON.stringify(cellIds(t))}.every((id) => { const x = window.__mc.terminals.xterm(id); if (!x) return false; const b = x.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true).trimEnd().endsWith('>')) return true; return false; })`;
  await app.until(prompted('a'), 'prompts of grid a', 60000);
  out.startup.promptMs = Math.round(performance.now() - t0);
  try { out.startup.log = readFileSync(join(root, 'data', 'startup.log'), 'utf8').trim().split(/\r?\n/).slice(-12); } catch { /* older builds */ }
  const visit = !process.argv.includes('--no-visit');
  if (visit) for (const t of ['b', 'c']) { await clickTab(t); await app.until(prompted(t), `prompts of grid ${t}`, 60000); await sleep(1500); }
  if (visit) await clickTab('a');
  await sleep(SETTLE);
  const kindOf = kinds(app.pid);
  await ev(`(() => { window.__invokes = {}; const orig = window.fetch.bind(window);
    window.fetch = (url, ...rest) => { const u = String(url); if (u.startsWith('http://ipc.localhost/') || u.startsWith('ipc://')) { const cmd = decodeURIComponent(u.split('/').pop()); window.__invokes[cmd] = (window.__invokes[cmd] ?? 0) + 1; } return orig(url, ...rest); }; return true; })()`);
  await app.cdp('Performance.enable');
  const metrics = async () => Object.fromEntries((await app.cdp('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const measure = async (name, seconds) => {
    await ev('window.__invokes = {}, true');
    const page0 = await metrics();
    const m0 = machineTimes(); const a = threads(kindOf); const t = performance.now();
    await sleep(seconds * 1000);
    const b = threads(kindOf); const dt = (performance.now() - t) / 1000; const m1 = machineTimes();
    const page1 = await metrics();
    const invokes = await ev('window.__invokes');
    const by = {}; const per = [];
    for (const [key, n] of b) {
      const o = a.get(key) ?? { cs: 0, cpu: 0 };
      const cs = n.cs - o.cs, cpu = n.cpu - o.cpu;
      const e = by[n.kind] ??= { cpu: 0, wakes: 0 };
      e.cpu += cpu; e.wakes += cs;
      per.push({ kind: n.kind, start: n.start, key, wakes: Math.round(cs / dt), cpu: +(cpu / 1e7 / dt * 100).toFixed(2) });
    }
    const r = { total: { cpu: 0, wakes: 0 } };
    for (const [k, e] of Object.entries(by)) { r[k] = { cpu: +(e.cpu / 1e7 / dt * 100).toFixed(2), wakes: Math.round(e.wakes / dt) }; r.total.cpu = +(r.total.cpu + r[k].cpu).toFixed(2); r.total.wakes += r[k].wakes; }
    r.page = { taskMsPerS: +((page1.TaskDuration - page0.TaskDuration) * 1000 / dt).toFixed(2), scriptMsPerS: +((page1.ScriptDuration - page0.ScriptDuration) * 1000 / dt).toFixed(2), layoutsPerS: +((page1.LayoutCount - page0.LayoutCount) / dt).toFixed(2), recalcsPerS: +((page1.RecalcStyleCount - page0.RecalcStyleCount) / dt).toFixed(2) };
    r.invokesPerS = Object.fromEntries(Object.entries(invokes).map(([k, v]) => [k, +(v / dt).toFixed(2)]));
    r.machineBusy = Math.round((m1.busy - m0.busy) / (m1.busy - m0.busy + m1.idle - m0.idle) * 1000) / 10;
    if (process.argv.includes('--threads')) {
      r.top = per.sort((x, y) => y.wakes - x.wakes).slice(0, 25);
      const list = r.top.map((e) => e.key.split(':')[1]).join(',');
      const names = ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class T { [DllImport("kernel32.dll")] public static extern IntPtr OpenThread(int a, bool i, uint t); [DllImport("kernel32.dll")] public static extern int GetThreadDescription(IntPtr h, out IntPtr n); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p); public static string Name(uint t) { IntPtr h = OpenThread(0x0800, false, t); if (h == IntPtr.Zero) return ""; IntPtr n; string s = ""; if (GetThreadDescription(h, out n) >= 0) { s = Marshal.PtrToStringUni(n); LocalFree(n); } CloseHandle(h); return s; } }'; foreach ($t in @(${list})) { "$t=" + [T]::Name([uint32]$t) }`);
      const byTid = Object.fromEntries(names.split(String.fromCharCode(10)).map((x) => x.trim().split('=')));
      for (const e of r.top) { const tid = e.key.split(':')[1]; e.name = byTid[tid] ?? ''; }
    }
    out[name] = r;
  };
  out.memShown = memory(app.pid);
  out.animations = await ev(`document.getAnimations().map((a) => a.animationName ?? a.transitionProperty ?? 'other').slice(0, 20)`);
  out.browserArgs = ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${app.pid}" | Where-Object { $_.Name -eq 'msedgewebview2.exe' } | Select-Object -First 1 -ExpandProperty CommandLine)`).slice(0, 700);
  out.pageMem = { jsHeapUsedMiB: Math.round((await metrics()).JSHeapUsedSize / 1048576), jsHeapTotalMiB: Math.round((await metrics()).JSHeapTotalSize / 1048576), webgl: await ev(`(() => { const c = [...document.querySelectorAll('.cell')].filter((e) => e.querySelector('.xterm')); return { cells: c.length, webgl: c.filter((e) => e.querySelector('.xterm-screen canvas')).length, documents: document.querySelectorAll('canvas').length }; })()`), scripts: await ev(`performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js')).map((r) => [r.name.split('/').pop(), Math.round(r.decodedBodySize / 1024), Math.round(r.responseEnd)])`) };
  await measure('idleShown', SECONDS);
  if (process.argv.includes('--fill')) {
    const writer = join(root, 'fill.cjs');
    writeFileSync(writer, "let out = ''; for (let n = 0; n < 16000; n++) out += String(n).padStart(8) + ' lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' + String.fromCharCode(13, 10); process.stdout.write(out);");
    for (const id of cellIds('a')) { await ev(`window.__mc.terminals.focus(${JSON.stringify(id)}), true`); await app.insertText(`"${process.execPath}" "${writer}"`); await app.press('Enter'); await sleep(120); }
    await ev('document.activeElement?.blur(), true');
    await sleep(20000);
    out.memFilled = memory(app.pid);
    out.fillCheck = await ev(`${JSON.stringify(cellIds('a'))}.map((id) => { const b = window.__mc.terminals.xterm(id).buffer.active; return b.length; }).slice(0, 3)`);
  }
  showWindows(app.pid, 7);
  await sleep(4000);
  await measure('idleMinimized', SECONDS);
  out.memMinimized = memory(app.pid);
  showWindows(app.pid, 4);
  await sleep(1500);
  console.log(JSON.stringify(out));
} finally {
  await app?.close();
  await sleep(500);
  removeScratch(root);
}
