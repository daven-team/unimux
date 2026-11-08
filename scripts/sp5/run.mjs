// SP5 real-app checks (Windows): the Rust ConPTY data plane inside the Tauri `check` build, rendered by xterm cells with the
// options of TerminalManager.ts. The page (scripts/sp5/page.ts, bundled here) is served under the app origin through the
// DevTools Fetch domain, so the shipped renderer is untouched; it talks to the test-bridge-only commands spike_pty_attach /
// spike_pty (src-tauri/crates/unimux-app/src/spike_pty.rs). Scratch data dir and home (tauri-app.mjs), never the real ones.
//
//   npm run build:check && node scripts/sp5/run.mjs [render] [latency] [flood] [close]   (default: all)
//   options: --keys=60 --cells=20 --rate=1000000 --seconds=15 --batch=16 --focus=4 --timer=1 --webgl=1 --font=11 --keep
//
// Results: artifacts/sp5/results-<time>.json, screenshots artifacts/sp5/*.png.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { removeScratch } from '../app-env.mjs';
import { connectPage, freePort, killTree, launchApp, sleep, waitFor } from '../tauri-app.mjs';
import { measureLatency, PROBE } from './latency-probe.mjs';

if (process.platform !== 'win32') throw new Error('SP5 checks are Windows only');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'artifacts', 'sp5');
mkdirSync(out, { recursive: true });
const argv = process.argv.slice(2);
const opt = (name, def) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const wanted = argv.filter((a) => !a.startsWith('--'));
const runs = wanted.length ? wanted : ['render', 'latency', 'flood', 'close'];
const keys = Number(opt('keys', 60));
const cellCount = Number(opt('cells', 20));
const rate = Number(opt('rate', 1_000_000));
const seconds = Number(opt('seconds', 15));
const plane = { batchMs: Number(opt('batch', 16)), focusMs: Number(opt('focus', 4)), timer1ms: opt('timer', '1') !== '0', flow: opt('flow', '1') !== '0' };
const webgl = opt('webgl', '1') !== '0';
const fontSize = Number(opt('font', 11));
/** --source=pty (unimux-pty-flood in ConPTY) or synthetic (the same lines pushed into the plane, no ConPTY). */
const source = opt('source', 'pty');
const keep = argv.includes('--keep');

// conpty.dll 1.23 + OpenConsole.exe, committed (1.1.4 took them from node-pty).
const conptyDir = join(root, 'src-tauri', 'resources', 'conpty', 'x64');
const flood = join(root, 'src-tauri', 'target', 'release', 'unimux-pty-flood.exe');
if (runs.includes('flood') || runs.includes('close')) {
  if (!existsSync(flood)) throw new Error('build the flood helper first: npm run cargo -- build --release -p unimux-pty --bins (in src-tauri)');
}
const findExe = (name) => { try { return execFileSync('where.exe', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { return null; } };
const powershell = findExe('pwsh.exe') ?? findExe('powershell.exe');
const claude = findExe('claude.exe') ?? findExe('claude');

// The page: one IIFE with xterm and the Tauri API, plus xterm's CSS.
const bundle = await rolldown({ input: join(root, 'scripts', 'sp5', 'page.ts'), platform: 'browser', logLevel: 'silent' });
const js = (await bundle.generate({ format: 'iife' })).output[0].code;
await bundle.close();
const css = readFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>SP5</title><style>${css}
html, body { margin: 0; height: 100%; background: #0d0d0d; overflow: hidden; }
#grid { display: grid; gap: 4px; padding: 4px; box-sizing: border-box; height: 100%; width: 100%; }
.sp5-cell { background: #131313; border-radius: 6px; padding: 4px; min-width: 0; min-height: 0; overflow: hidden; }
.sp5-cell .xterm { height: 100%; }
</style></head><body><script src="/sp5/page.js"></script></body></html>`;

const scratch = mkdtempSync(join(tmpdir(), 'unimux-sp5-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
const claudeHome = join(scratch, 'claude-config');
mkdirSync(claudeHome, { recursive: true });
const port = await freePort();
const results = { when: new Date().toISOString(), plane, webgl, fontSize, conptyDir, powershell, claude, runs: {} };
const child = launchApp({ dataDir, scratch, port, extraEnv: { UNIMUX_CONPTY_DIR: conptyDir } });
let page;
const log = (...a) => console.log('[sp5]', ...a);
const shot = async (name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'));
};
const ev = (expr) => page.evaluate(expr);
const key = async (ch) => {
  const named = { Enter: ['Enter', 'Enter', 13, '\r'], Backspace: ['Backspace', 'Backspace', 8, ''] }[ch];
  const [k, code, vk, text] = named ?? [ch, /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch === ' ' ? 'Space' : /\d/.test(ch) ? `Digit${ch}` : '', ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0), ch];
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, unmodifiedText: text, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const typeText = async (s) => { for (const ch of s) await key(ch); };
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
/** CPU seconds of the app tree without the shells and writers (the same filter as scripts/perf-grid.mjs). */
const appCpu = (pid) => Number(ps(`$all = Get-CimInstance Win32_Process; $ids = @(${Number(pid)}); $i = 0; while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $_.Name -notin @('cmd.exe','node.exe','conhost.exe','OpenConsole.exe','unimux-pty-flood.exe') } | ForEach-Object { $_.ProcessId }); $i++ }; $t = ($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { $_.UserModeTime + $_.KernelModeTime } | Measure-Object -Sum).Sum; ([math]::Round($t / 1e7, 2)).ToString([cultureinfo]::InvariantCulture)`));
const screenText = async (id) => (await ev(`sp5.screen(${JSON.stringify(id)})`)).join('\n');

try {
  page = await connectPage(port);
  await waitFor(page, `document.readyState === 'complete'`, 30000, 'app page');
  // Serve the spike page under the app origin.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'http://tauri.localhost/sp5/*' }] });
  page.onEvent((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const url = m.params.request.url;
    const body = url.endsWith('page.js') ? js : html;
    const type = url.endsWith('page.js') ? 'text/javascript' : 'text/html';
    void page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: `${type}; charset=utf-8` }], body: Buffer.from(body).toString('base64') });
  });
  await page.send('Page.enable');
  // The offscreen window never gets the OS focus: emulate a focused page so focus events (?1004) fire like on screen.
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.navigate', { url: 'http://tauri.localhost/sp5/index.html' });
  await waitFor(page, `!!window.sp5`, 30000, 'spike page');
  results.viewport = await ev(`[innerWidth, innerHeight, devicePixelRatio]`);
  log('page up', results.viewport);

  if (runs.includes('render')) {
    const r = {};
    await ev(`sp5.init(${JSON.stringify(plane)})`);
    await ev(`sp5.open('ps', ${JSON.stringify({ file: powershell, args: ['-NoLogo'], cwd: scratch, fontSize: 13, webgl })})`);
    if (claude) await ev(`sp5.open('claude', ${JSON.stringify({ file: claude, args: [], cwd: scratch, env: { CLAUDE_CONFIG_DIR: claudeHome }, fontSize: 13, webgl })})`);
    await waitFor(page, `sp5.screen('ps').some((l) => /PS .*>/.test(l))`, 30000, 'powershell prompt');
    const ps = await ev(`sp5.cell('ps')`);
    r.ptyRequested = { win32InputMode: ps.win32, da1Answered: ps.sent.some((s) => s.startsWith('\x1b[?') && s.endsWith('c')) };
    // Focus events (?1004h from ConPTY): xterm reports focus in / out to the pty.
    await ev(`sp5.blur()`);
    await ev(`sp5.focus('ps')`);
    await sleep(200);
    await ev(`sp5.blur()`);
    await sleep(200);
    const sent = (await ev(`sp5.cell('ps')`)).sent;
    r.focus1004 = { focusIn: sent.includes('\x1b[I'), focusOut: sent.includes('\x1b[O') };
    // win32-input-mode: typed keys travel as CSI ... _ sequences and PowerShell gets the text.
    await ev(`sp5.focus('ps')`);
    await typeText('echo w32ok');
    await key('Enter');
    await waitFor(page, `sp5.screen('ps').filter((l) => l.includes('w32ok')).length >= 2`, 15000, 'win32 echo');
    const sent2 = (await ev(`sp5.cell('ps')`)).sent;
    r.win32Keys = { encoded: sent2.filter((s) => /^\x1b\[\d+;\d+;\d+;[01];\d+;\d+_/.test(s)).length, echoed: true };
    // Resize reflow: a wrapped command line, the cell narrowed, more typing; the line must stay whole (no text over the prompt).
    const long = 'echo ' + 'abcdefghij'.repeat(9);
    await typeText(long);
    await sleep(300);
    await shot('render-before-resize');
    const before = await ev(`sp5.cell('ps')`);
    await ev(`document.querySelector('.sp5-cell[data-id="ps"]').style.width = '55%'; sp5.fitAll(); true`);
    await sleep(800);
    const after = await ev(`sp5.cell('ps')`);
    await typeText('XYZ');
    await key('Enter');
    await waitFor(page, `sp5.screen('ps').join('').includes('abcdefghijXYZ')`, 15000, 'reflowed echo');
    await sleep(500);
    const text = (await screenText('ps')).split('\n');
    const joined = text.join('');
    r.resize = { before: [before.cols, before.rows], after: [after.cols, after.rows], commandIntact: joined.includes(long + 'XYZ'), outputIntact: joined.includes('abcdefghij'.repeat(9) + 'XYZ') };
    await shot('render-after-resize');
    // Back to the full width (as electron-ref.mjs does), then the screens are compared.
    await ev(`document.querySelector('.sp5-cell[data-id="ps"]').style.width = ''; sp5.fitAll(); true`);
    await sleep(1500);
    if (claude) {
      await waitFor(page, `sp5.screen('claude').join('').trim().length > 40`, 30000, 'claude screen');
      await sleep(4000);
      r.claude = { screen: await screenText('claude'), cell: await ev(`(() => { const c = sp5.cell('claude'); return { win32: c.win32, cols: c.cols, rows: c.rows }; })()`) };
    }
    r.powershellScreen = await screenText('ps');
    await shot('render-powershell-claude');
    await ev(`sp5.killAll()`);
    results.runs.render = r;
    log('render', JSON.stringify({ ...r, claude: r.claude && { ...r.claude, screen: undefined }, powershellScreen: undefined }));
  }

  if (runs.includes('latency')) {
    // The probe and the typing of scripts/perf-latency.mjs (local shell cell: cmd), unchanged (latency-probe.mjs).
    const r = {};
    await ev(`sp5.init(${JSON.stringify(plane)})`);
    await ev(`sp5.open('local-shell', ${JSON.stringify({ file: 'cmd.exe', args: [], cwd: scratch, fontSize: 13, webgl })})`);
    await waitFor(page, `sp5.screen('local-shell').some((l) => />\\s*$/.test(l))`, 30000, 'cmd prompt');
    // --load=N: N other cells flood (the --source generator at --rate) while the focused cell is typed into.
    const load = Number(opt('load', 0));
    for (let i = 0; i < load; i++) await ev(`sp5.open('load${i}', ${JSON.stringify({ file: flood, args: [String(rate), '0'], cwd: scratch, fontSize, webgl, ...(source === 'synthetic' ? { synthetic: { rate } } : {}) })})`);
    r.load = { cells: load, source: load ? source : null, rate: load ? rate : null };
    await sleep(load ? 3000 : 1500);
    await ev(PROBE);
    Object.assign(r, await measureLatency({ ev, key, sleep, focus: (cell) => ev(`sp5.focus(${JSON.stringify(cell)}), true`), cell: 'local-shell', keys }));
    await ev(`sp5.killAll()`);
    results.runs.latency = r;
    log('latency', JSON.stringify(r));
  }

  if (runs.includes('flood')) {
    await ev(`sp5.init(${JSON.stringify(plane)})`);
    for (let i = 0; i < cellCount; i++) await ev(`sp5.open('f${i}', ${JSON.stringify({ file: flood, args: [String(rate), '0'], cwd: scratch, fontSize, webgl, ...(source === 'synthetic' ? { synthetic: { rate } } : {}) })})`);
    await sleep(3000);
    const before = await ev(`sp5.rustStats()`);
    await page.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    await ev(`(() => { window.__long = []; new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); return true; })()`);
    const m0 = await metrics();
    const cpu0 = appCpu(child.pid);
    const t0 = Date.now();
    const frames = await ev(`sp5.frames(${seconds * 1000})`);
    const secs = (Date.now() - t0) / 1000;
    const cpu = appCpu(child.pid) - cpu0;
    const m1 = await metrics();
    const after = await ev(`sp5.rustStats()`);
    const per = (name) => Math.round((m1[name] - m0[name]) / secs * 1000);
    const longTasks = await ev(`(() => { const l = window.__long; return { count: l.length, totalMs: Math.round(l.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...l)) }; })()`);
    const r = {
      cells: cellCount, source, rateBytesPerCell: rate, frames, longTasks, cpuSeconds: +cpu.toFixed(2), cpuPercentOfOneCore: Math.round(cpu / secs * 1000) / 10,
      mainThreadMsPerS: { task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration') },
      channel: { messagesPerS: Math.round((after.messages - before.messages) / secs), framesPerS: Math.round((after.frames - before.frames) / secs), MBps: +((after.bytes - before.bytes) / secs / 1e6).toFixed(2), pauses: after.pauses - before.pauses },
      page: await ev(`sp5.stats`),
    };
    await shot(`flood-${source}-${cellCount}x${rate}-batch${plane.batchMs}-${webgl ? 'webgl' : 'dom'}`);
    results.runs.flood = r;
    log('flood', JSON.stringify(r));
    const f = r.frames;
    log(`flood summary ${source} ${cellCount}x${rate} batch ${plane.batchMs}: fps ${f.fps.toFixed(0)} p95 ${f.p95.toFixed(1)} ms max ${f.max.toFixed(0)} ms over50 ${f.over50}, xterm ${f.parsedMBps.toFixed(1)} MB/s, script ${r.mainThreadMsPerS.script} ms/s, cpu ${r.cpuPercentOfOneCore}%, channel ${r.channel.messagesPerS} msg/s, decode ${r.page.decodeMs.toFixed(0)} ms`);
  }

  if (runs.includes('close')) {
    // ClosePseudoConsole while every cell floods (and the page is behind): all exits arrive, nothing hangs.
    if (!runs.includes('flood')) {
      await ev(`sp5.init(${JSON.stringify(plane)})`);
      for (let i = 0; i < cellCount; i++) await ev(`sp5.open('f${i}', ${JSON.stringify({ file: flood, args: [String(rate), '0'], cwd: scratch, fontSize, webgl })})`);
      await sleep(3000);
    }
    const t0 = Date.now();
    await ev(`sp5.killAll()`);
    await waitFor(page, `Array.from({ length: ${cellCount} }, (_, i) => sp5.cell('f' + i)).every((c) => c && c.exit !== null)`, 10000, 'all exits');
    results.runs.close = { cells: cellCount, allExitedMs: Date.now() - t0, rustTerminalsLeft: (await ev(`sp5.rustStats()`)).terminals };
    log('close', JSON.stringify(results.runs.close));
  }
} finally {
  const file = join(out, `results-${results.when.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(results, null, 1));
  log('results', file);
  try { page?.close(); } catch { /* gone */ }
  killTree(child);
  await sleep(500);
  if (!keep) removeScratch(scratch);
}
