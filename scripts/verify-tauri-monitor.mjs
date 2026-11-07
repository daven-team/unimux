// Real-app check of the Monitor panel on the Tauri build (1.2.0, PLAN G8): the `check` build on a scratch data dir and a scratch
// home, offscreen. Two cells of the saved grid get a running process tree each (cmd.exe -> PING.EXE started by this script and
// handed to the app through the test-bridge op `monitorCells`, until P3 tracks the real pty shells). Checks:
//   - the panel lists both cells with their trees (cmd.exe, PING.EXE) and their grid labels;
//   - the "Aplikacja" section lists the main process and the WebView2 processes by kind (browser, renderer, GPU, services),
//     exactly the msedgewebview2.exe processes under unimux.exe that Windows reports (Win32_Process, read independently);
//   - a sample answers within 20 ms (queryMs, 10 samples) and the round trip from the page stays small;
//   - ending PING.EXE through the row's button and the confirmation ends exactly that process; monitor:kill refuses the app,
//     a WebView2 process and a pid outside every cell;
//   - nothing new in the real profile.
// Screenshots go to artifacts/tauri-monitor/. Windows only (the macOS half is compile-checked).
//
//   npm run build:check && node scripts/verify-tauri-monitor.mjs        (--keep leaves the scratch dir for inspection)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitFor } from './tauri-app.mjs';

if (process.platform !== 'win32') {
  console.log('SKIP verify-tauri-monitor: Windows only (the macOS monitor is compile-checked)');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'artifacts', 'tauri-monitor');
mkdirSync(shots, { recursive: true });
const keep = process.argv.includes('--keep');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ addProject, addTab, defaultState }, { layoutForCount }] = await Promise.all([load('src/shared/state.ts'), load('src/shared/layout.ts')]);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

/** Every process of the system as Windows reports it (an independent reading, not through the app). */
function systemProcesses() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name }));
}

function descendants(procs, pid) {
  const out = [];
  const queue = [pid];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const p of procs) if (p.ppid === parent && !seen.has(p.pid)) { seen.add(p.pid); out.push(p); queue.push(p.pid); }
  }
  return out;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const scratch = mkdtempSync(join(tmpdir(), 'unimux-g8-monitor-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
let state = addProject(defaultState('win32'), { name: 'monitor', path: scratch });
state = addTab(state, state.projects[0].id, { layout: layoutForCount(2), cells: [{ profileId: 'claude' }, { profileId: 'codex' }] });
state.settings.language = 'pl';
state.settings.sidePanels = { monitor: true };
const [cellA, cellB] = state.projects[0].tabs[0].cells;
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state));

// The stand-ins of the cells' shells: cmd.exe with a long PING.EXE under it.
const shells = [0, 1].map(() => spawn('cmd.exe', ['/d', '/c', 'ping -n 300 127.0.0.1 >nul'], { stdio: 'ignore', windowsHide: true }));

const markersBefore = realProfileMarkers();
const port = await freePort();
const child = launchApp({ dataDir, scratch, port });
let page;
try {
  page = await connectPage(port, { timeoutMs: 60000 });
  const { evaluate, send } = page;
  const until = (expr, label, ms = 20000) => waitFor(page, expr, ms, label);
  const shot = async (name) => { await sleep(250); const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64')); };
  const click = async (selector) => {
    const box = await until(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`, selector);
    // A move first: the row's buttons take the pointer only while the row is hovered (monitorPanel.css).
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(250);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(`typeof window.__TAURI_INTERNALS__?.invoke === 'function' && !!document.querySelector('#monitor-view')`, 'app UI with the Monitor tab', 60000);
  const bridge = (op, args) => evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);

  // The pings run under their cmd.exe before the app is told about the cells.
  const pingOf = new Map();
  await waitFor({ evaluate: async () => {
    const procs = systemProcesses();
    for (const s of shells) { const ping = descendants(procs, s.pid).find((p) => /^ping\.exe$/i.test(p.name)); if (ping) pingOf.set(s.pid, ping.pid); }
    return pingOf.size === 2;
  } }, '', 15000, 'PING.EXE under each cmd.exe');
  const told = await bridge('monitorCells', { cells: [{ cellId: cellA.id, pid: shells[0].pid }, { cellId: cellB.id, pid: shells[1].pid }] });
  check('test bridge takes the running cells', told.cells === 2 && told.mainPid === child.pid, JSON.stringify(told));

  await click('#monitor-view');
  await until(`document.querySelectorAll('.monitor-cell').length === 2 && document.querySelectorAll('.monitor-row.app').length > 1`, 'both cells and the app rows', 20000);
  const cells = await evaluate(`[...document.querySelectorAll('.monitor-cell')].map((c) => ({ id: c.dataset.cell, label: c.querySelector('.monitor-cell-label').textContent, rows: [...c.querySelectorAll('.monitor-proc')].map((r) => r.textContent) }))`);
  for (const cell of [cellA, cellB]) {
    const shown = cells.find((c) => c.id === cell.id);
    check(`cell ${cell.profileId} is listed with its tree`, shown && /^cmd\.exe$/i.test(shown.rows[0]) && shown.rows.some((r) => /^ping\.exe$/i.test(r)), JSON.stringify(shown));
    check(`cell ${cell.profileId} has its grid label`, shown && /^[12]\. /.test(shown.label), shown?.label);
  }
  const appRows = await evaluate(`[...document.querySelectorAll('.monitor-row.app .monitor-proc')].map((r) => r.textContent)`);
  // 1.1.4 sorts the app rows by CPU (then memory), so the main process is anywhere in the list.
  check('the app section lists the main process once', appRows.filter((r) => r === 'Proces główny').length === 1, JSON.stringify(appRows));
  for (const label of ['Przeglądarka (WebView2)', 'Okno aplikacji', 'Grafika (GPU)']) check(`the app section lists "${label}"`, appRows.includes(label), JSON.stringify(appRows));
  check('the app section lists a WebView2 service by name', appRows.some((r) => /^Usługa: \S/.test(r)), JSON.stringify(appRows));
  await shot('01-monitor');

  // The WebView2 processes: exactly the msedgewebview2.exe processes under unimux.exe that Windows reports.
  const sample = await evaluate(`window.mc.monitorSample()`);
  const procs = systemProcesses();
  const webviews = descendants(procs, child.pid).filter((p) => /^msedgewebview2\.exe$/i.test(p.name)).map((p) => p.pid).sort((a, b) => a - b);
  const listed = sample.app.filter((a) => a.pid !== child.pid).map((a) => a.pid).sort((a, b) => a - b);
  check('the app rows are the WebView2 processes Windows reports under unimux.exe', JSON.stringify(listed) === JSON.stringify(webviews), `${JSON.stringify(listed)} vs ${JSON.stringify(webviews)}`);
  const kinds = [...new Set(sample.app.map((a) => a.kind))].sort();
  check('kinds: main, webview, renderer, gpu, utility', ['gpu', 'main', 'renderer', 'utility', 'webview'].every((k) => kinds.includes(k)), JSON.stringify(sample.app.map((a) => `${a.kind}${a.name ? `:${a.name}` : ''}`)));
  check('one browser process', sample.app.filter((a) => a.kind === 'webview').length === 1);

  // Timing: 10 samples, the system query within 20 ms each; the round trip from the page for the record.
  const times = await evaluate(`(async () => { const out = []; for (let i = 0; i < 10; i++) { const t = performance.now(); const s = await window.mc.monitorSample(); out.push({ query: s.queryMs, trip: Math.round((performance.now() - t) * 10) / 10 }); } return out; })()`);
  const queries = times.map((t) => t.query);
  const trips = times.map((t) => t.trip).sort((a, b) => a - b);
  check('a sample takes under 20 ms (queryMs, 10 samples)', queries.every((q) => q < 20), `queryMs ${JSON.stringify(queries)}, round trip median ${trips[5]} ms, max ${trips[9]} ms`);

  // Kills: refused outside a cell tree, done through the panel for PING.EXE of cell A.
  const webview = sample.app.find((a) => a.kind === 'webview')?.pid;
  const refused = await evaluate(`Promise.all([window.mc.monitorKill(${child.pid}), window.mc.monitorKill(${webview ?? 0}), window.mc.monitorKill(${process.pid}), window.mc.monitorKill('${pingOf.get(shells[0].pid)}')])`);
  check('monitor:kill refuses the app, a WebView2 process, a foreign pid and a string', refused.every((r) => r === false) && alive(child.pid) && alive(webview), JSON.stringify(refused));
  const pingA = pingOf.get(shells[0].pid);
  const pingB = pingOf.get(shells[1].pid);
  // The panel re-renders every 2 s; a click that lands during a re-render is tried again.
  for (let attempt = 1; ; attempt++) {
    await click(`.monitor-cell[data-cell="${cellA.id}"] .monitor-row[title$="PID ${pingA}"] button`);
    try { await until(`!!document.querySelector('button[data-value="kill"]')`, 'the confirmation', 3000); break; } catch (error) { if (attempt === 3) throw error; }
  }
  const question = await evaluate(`document.body.innerText.includes('Zakończyć proces') && document.body.innerText.includes('PID ${pingA}')`);
  check('ending a process asks first, naming it and its PID', question);
  await shot('02-confirm');
  await click('button[data-value="kill"]');
  await waitFor({ evaluate: async () => !alive(pingA) }, '', 10000, 'PING.EXE of cell A ended');
  check('the confirmed kill ends exactly that process', !alive(pingA) && alive(pingB) && alive(shells[1].pid) && alive(child.pid));
  await until(`![...document.querySelectorAll('.monitor-row')].some((r) => r.title.endsWith('PID ${pingA}'))`, 'the ended process leaves the panel', 10000);
  check('the panel drops the ended process', true);
  await shot('03-after-kill');
} catch (error) {
  check('run', false, error.stack ?? String(error));
} finally {
  page?.close();
  killTree(child);
  for (const s of shells) killTree(s);
  await sleep(500);
}
const markersAfter = realProfileMarkers();
check('nothing new in the real profile', JSON.stringify(markersBefore) === JSON.stringify(markersAfter));
if (!keep) removeScratch(scratch); else console.log(`scratch kept: ${scratch}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
