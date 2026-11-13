// Typing latency of a terminal while the machine is saturated (Windows only; run `npm run build:check` first, MC_APP_BINARY picks
// another build). One cmd cell in a scratch data dir and home; a key typed into the cell (xterm input, as a key press) until its
// echo is parsed and painted, measured idle and with one busy-loop process per core, in several priority setups:
//   idle          no load
//   load          busy loops at normal priority (what a cargo build in another cell does today)
//   load-below    busy loops at below-normal priority (programs in terminals run below normal)
//   load-webview  busy loops at normal priority, the app's WebView2 processes above normal
// The window stays off screen, nothing is activated. Usage: node scripts/perf-latency-load.mjs [--samples=40]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';

if (process.platform !== 'win32') throw new Error('perf-latency is Windows only');
const samples = Number(process.argv.find((a) => a.startsWith('--samples='))?.slice(10) ?? 40);
const root = mkdtempSync('D:\\Projekty\\_tmp-perflat-');
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
const areas = [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }];
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p',
  projects: [{ id: 'p', name: 'p', path: join(root, 'project'), color: '#3b82f6', activeTabId: 't', archive: [],
    tabs: [{ id: 't', name: 'Grid', layout: { cols: 1, rows: 1, areas }, cells: [{ id: 'a0', name: 'a0', profileId: 'shell' }] }] }],
}));

const ps = (script) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
const PRIORITY = { normal: 'Normal', below: 'BelowNormal', above: 'AboveNormal' };
const setPriority = (pids, level) => { if (pids.length) ps(`foreach ($p in @(${pids.join(',')})) { try { (Get-Process -Id $p -ErrorAction Stop).PriorityClass = '${PRIORITY[level]}' } catch {} }`); };
const webviewPids = () => ps(`Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${root.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`).split(/\s+/).filter(Boolean).map(Number);

let burners = [];
const startLoad = (level) => {
  burners = cpus().map(() => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  setPriority(burners.map((b) => b.pid), level);
};
const stopLoad = () => { for (const b of burners) b.kill(); burners = []; };

let app;
const out = {};
try {
  app = await launchApp(root, { MC_CLI_NO_REGISTRY: '1' }, [], { main: true });
  const ev = async (expression) => {
    const r = await app.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  // The prompt first.
  for (let i = 0; i < 100; i++) {
    if (await ev(`(() => { const x = window.__mc.terminals.xterm('a0'); if (!x) return false; const b = x.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true).trimEnd().endsWith('>')) return true; return false; })()`)) break;
    await sleep(200);
  }
  await ev(`window.__mc.terminals.focus('a0'), true`);
  // One key: from the key press to its echo parsed and the frame after it.
  const typeOnce = `new Promise((res) => {
    const x = window.__mc.terminals.xterm('a0');
    const t0 = performance.now();
    const d = x.onWriteParsed(() => { d.dispose(); requestAnimationFrame(() => res(performance.now() - t0)); });
    x.input('x', true);
    setTimeout(() => { d.dispose(); res(5000); }, 5000);
  })`;
  const clear = `(() => { const x = window.__mc.terminals.xterm('a0'); x.input('\\x1b', true); return true; })()`;
  const run = async (name) => {
    const ms = [];
    for (let i = 0; i < samples; i++) {
      ms.push(await ev(typeOnce));
      await sleep(40 + (i % 5) * 13);
      if (i % 20 === 19) { await ev(clear); await sleep(150); }
    }
    await ev(clear);
    ms.sort((a, b) => a - b);
    const q = (f) => Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * f))]);
    out[name] = { median: q(0.5), p90: q(0.9), max: Math.round(ms[ms.length - 1]) };
    console.log(name, JSON.stringify(out[name]));
  };
  await sleep(1500);
  await run('idle');
  startLoad('normal'); await sleep(1500); await run('load'); stopLoad(); await sleep(1500);
  startLoad('below'); await sleep(1500); await run('load-below'); stopLoad(); await sleep(1500);
  const wv = webviewPids();
  setPriority(wv, 'above');
  startLoad('normal'); await sleep(1500); await run('load-webview'); stopLoad();
  setPriority(wv, 'normal');
  out.cores = cpus().length;
  out.webviewProcesses = wv.length;
  console.log(JSON.stringify(out));
} finally {
  stopLoad();
  await app?.close();
  await sleep(500);
  removeScratch(root);
}
