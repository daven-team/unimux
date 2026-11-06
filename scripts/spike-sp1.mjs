// Spike SP1 (docs/tauri/spikes/SP1.md): WebView2 shell behaviour of the Tauri check build, measured in the real app.
//
//   1. Two app windows on one WebView2 data folder with the full browser-args string: no 0x8007139F; a third window with
//      different arguments shows the failure.
//   2. A hidden window (never shown) reaches renderer-boot.
//   3. Tauri IPC goes through the custom protocol (http://ipc.localhost on WebView2) under the CSP of tauri.conf.json, not
//      the postMessage fallback; the CSP is active (a foreign fetch is blocked).
//   4. The 400 ms status tick of TerminalManager (and a plain 400 ms setInterval) keeps running while the window is
//      minimized, hidden, or its WebView2 controller is IsVisible(false).
//   5. Raw binary Channel frames (InvokeResponseBody::Raw) into 20 xterm instances at 1 MB/s each: latency p50/p95/p99, fps.
//
//   npm run build:check && node scripts/spike-sp1.mjs [--long] [--keep] [--phase-seconds=N] [--bench-seconds=N]
//
// Results: artifacts/tauri-sp1/results.json (and the console). Scratch data dir and scratch home only.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'artifacts', 'tauri-sp1');
mkdirSync(outDir, { recursive: true });
const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const keep = process.argv.includes('--keep');
const long = process.argv.includes('--long');
const phaseSeconds = arg('phase-seconds', 12);
const longSeconds = arg('long-seconds', 390);
const benchSeconds = arg('bench-seconds', 15);
const skipTimers = process.argv.includes('--no-timers');

const results = { date: new Date().toISOString(), checks: [], numbers: {} };
const check = (name, ok, detail = '') => {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

async function fixtureState() {
  const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
  const [{ defaultState }, { layoutForCount }] = await Promise.all([load('src/shared/state.ts'), load('src/shared/layout.ts')]);
  const s = defaultState('win32');
  const profiles = s.profiles.map((p) => p.id);
  const cells = Array.from({ length: 20 }, (_, i) => ({ id: `cell-${i + 1}`, profileId: profiles[i % profiles.length] }));
  s.projects = [{ id: 'proj-sp1', name: 'sp1', path: tmpdir(), color: '#7c5cff', tabs: [{ id: 'tab-wall', name: '5x4', layout: layoutForCount(20), cells }], archive: [], activeTabId: 'tab-wall' }];
  s.activeProjectId = 'proj-sp1';
  s.settings.language = 'en';
  return s;
}

const tb = (op, args = {}) => `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: ${JSON.stringify(op)}, args: ${JSON.stringify(args)} })`;

function stats(values) {
  if (!values.length) return { n: 0 };
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const r = (x) => Math.round(x * 1000) / 1000;
  return { n: v.length, min: r(v[0]), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(v[v.length - 1]), mean: r(v.reduce((a, b) => a + b, 0) / v.length) };
}

/** The resource entries of Tauri's IPC in a page: custom-protocol fetches (WebView2 http://ipc.localhost/<cmd>). */
const ipcProbe = `(() => {
  const entries = performance.getEntriesByType('resource').map((e) => e.name);
  const ipc = entries.filter((n) => /^(https?:\\/\\/ipc\\.localhost|ipc:)/.test(n));
  return { ipc: ipc.length, sample: ipc.slice(0, 3), total: entries.length };
})()`;

/** Installs the timer recorders in a page: the real 400 ms status tick (patched instance method) and a plain setInterval. */
const timerInstall = `(() => {
  const rec = window.__sp1Timers = { tick: [], plain: [], vis: [], raf: 0 };
  const t = window.__mc?.terminals;
  if (t && typeof t.tickStatuses === 'function' && !t.__sp1) {
    const orig = t.tickStatuses.bind(t);
    t.tickStatuses = () => { rec.tick.push(performance.now()); return orig(); };
    t.__sp1 = true;
  }
  setInterval(() => { rec.plain.push(performance.now()); rec.vis.push(document.visibilityState); }, 400);
  const raf = () => { rec.raf++; requestAnimationFrame(raf); }; requestAnimationFrame(raf);
  return { hasStatusTick: !!t?.__sp1, statusTimer: !!t?.statusTimer };
})()`;

const timerSnapshot = `(() => { const r = window.__sp1Timers; return { now: performance.now(), tick: r.tick.length, plain: r.plain.length, raf: r.raf }; })()`;
const timerSince = (from) => `(() => { const r = window.__sp1Timers; const f = ${JSON.stringify(from)};
  return { now: performance.now(), tick: r.tick.slice(f.tick), plain: r.plain.slice(f.plain), vis: [...new Set(r.vis.slice(f.plain))], raf: r.raf - f.raf, visibility: document.visibilityState, hidden: document.hidden }; })()`;

function gaps(times, start, end) {
  const t = [start, ...times, end];
  const g = [];
  for (let i = 1; i < t.length; i++) g.push(t[i] - t[i - 1]);
  return g;
}

async function timerPhase(page, name, seconds, enter, leave) {
  if (enter) await enter();
  await sleep(300);
  const from = await page.evaluate(timerSnapshot);
  await sleep(seconds * 1000);
  const got = await page.evaluate(timerSince(from));
  if (leave) await leave();
  const span = got.now - from.now;
  const expected = span / 400;
  const plainGaps = gaps(got.plain, from.now, got.now);
  const tickGaps = gaps(got.tick, from.now, got.now);
  const row = {
    phase: name, seconds: Math.round(span) / 1000, expected: Math.floor(expected),
    plain: got.plain.length, plainMaxGapMs: Math.round(Math.max(...plainGaps)), plainGaps: stats(plainGaps.slice(1, -1)),
    tick: got.tick.length, tickMaxGapMs: got.tick.length ? Math.round(Math.max(...tickGaps)) : null,
    rafPerSec: Math.round((got.raf / span) * 1000 * 10) / 10, visibility: got.vis.join('|') || got.visibility,
  };
  console.log(`  ${name}: plain ${row.plain}/${row.expected} (max gap ${row.plainMaxGapMs} ms), status tick ${row.tick} (max gap ${row.tickMaxGapMs} ms), rAF ${row.rafPerSec}/s, visibility ${row.visibility}`);
  return row;
}

/**
 * Runs one data-plane bench in the page: `streams` streams at `bytesPerSec` into the 20 cell terminals (`sink: 'none'`
 * only receives). `mode`: perFrame | batched | pull | sharedBuffer (see src-tauri/crates/unimux-app/src/channel_bench.rs).
 */
let benchId = 0;
function benchScript({ streams, bytesPerSec, chunk, seconds, sink, mode, flushMs = 4 }, offset) {
  const id = ++benchId;
  return `(async () => {
    const streams = ${streams}, offset = ${offset}, sink = ${JSON.stringify(sink)}, mode = ${JSON.stringify(mode)};
    const I = window.__TAURI_INTERNALS__;
    const terms = [];
    if (sink === 'xterm') for (let i = 1; i <= streams; i++) {
      const t = window.__mc.terminals.xterm('cell-' + i);
      if (!t) throw new Error('no xterm for cell-' + i);
      terms.push(t);
    }
    const clock = () => performance.timeOrigin + performance.now();
    const arrive = [], parsed = [], lastSeq = new Array(streams).fill(-1);
    let frames = 0, bytes = 0, messages = 0, outOfOrder = 0, rafs = 0, longTasks = 0, longTaskMs = 0, running = true, maxFrameGap = 0, lastRaf = performance.now();
    const raf = () => { const n = performance.now(); maxFrameGap = Math.max(maxFrameGap, n - lastRaf); lastRaf = n; rafs++; if (running) requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { longTasks++; longTaskMs += e.duration; } });
    try { po.observe({ type: 'longtask', buffered: false }); } catch {}
    // One frame: [f64 produced][u32 seq][u32 stream][payload]. 'u8' must not be a view of a shared buffer (it is copied).
    const deliver = (u8, now) => {
      const dv = new DataView(u8.buffer, u8.byteOffset, 16);
      const sent = dv.getFloat64(0, true) - offset;
      const seq = dv.getUint32(8, true), s = dv.getUint32(12, true);
      if (seq !== lastSeq[s] + 1) outOfOrder++;
      lastSeq[s] = seq;
      arrive.push(now - sent);
      frames++; bytes += u8.byteLength;
      if (sink === 'xterm') terms[s].write(u8.subarray(16), () => parsed.push(clock() - sent));
    };
    const batch = (buf, copy) => {
      const now = clock(); messages++;
      const dv = new DataView(buf);
      for (let off = 0; off + 4 <= buf.byteLength;) {
        const len = dv.getUint32(off, true); off += 4;
        const view = new Uint8Array(buf, off, len);
        deliver(copy ? view.slice() : view, now); off += len;
      }
    };
    let next = 0; const pending = {};
    const onMessage = (m) => mode === 'perFrame' ? (messages++, deliver(new Uint8Array(m), clock())) : batch(m, false);
    const cb = I.transformCallback((raw) => {
      if ('end' in raw) return;
      if (raw.index === next) { onMessage(raw.message); next++; while (next in pending) { onMessage(pending[next]); delete pending[next]; next++; } }
      else pending[raw.index] = raw.message;
    });
    let onShared;
    if (mode === 'sharedBuffer') {
      onShared = (e) => { const b = e.getBuffer(); batch(b, true); window.chrome.webview.releaseBuffer(b); };
      window.chrome.webview.addEventListener('sharedbufferreceived', onShared);
    }
    const t0 = performance.now();
    let done = false;
    // 'local': the page makes the same kind of output itself (no IPC at all): the ceiling of 20 xterm on this machine.
    if (mode === 'local') {
      let txt = '';
      const E = String.fromCharCode(27), CRLF = String.fromCharCode(13, 10), CR = String.fromCharCode(13);
      for (let n = 1; txt.length < 200000; n++) {
        const c = 31 + (n % 7);
        txt += [
          E + '[' + c + 'm* ' + E + '[0m Read ' + E + '[1msrc/renderer/src/terminals/TerminalManager.ts' + E + '[0m (' + n + ' lines)' + CRLF,
          '  ' + E + '[2m|' + E + '[0m ' + String(n).padStart(6) + ' ' + E + '[32m+' + E + '[0m   const value = compute("zazolc gesla jazn", ' + n + ');' + CRLF,
          CR + E + '[K' + E + '[36m.' + E + '[0m Thinking... (' + (n % 60) + 's - ' + n * 7 + ' tokens)',
          CRLF + E + '[38;5;' + (n % 256) + 'm' + '-'.repeat(40) + E + '[0m' + CRLF,
          n.toString(16).padStart(8, '0') + '  64 61 74 61 20 66 72 61 6d 65 20 74 65 73 74 21  |data frame test!|' + CRLF,
        ][n % 5];
      }
      const pool = new TextEncoder().encode(txt);
      const interval = ${chunk} / ${bytesPerSec} * 1000, total = Math.ceil(${seconds} * ${bytesPerSec} / ${chunk});
      const seq = new Array(streams).fill(0), off = Array.from({ length: streams }, (_, s) => (s * 7919) % pool.length);
      const start = performance.now() + 20;
      await new Promise((res) => {
        const tick = () => {
          const now = performance.now();
          let left = false;
          for (let s = 0; s < streams; s++) {
            while (seq[s] < total && start + (interval * s) / streams + seq[s] * interval <= now) {
              const u8 = new Uint8Array(${chunk});
              for (let i = 16; i < u8.length;) { const take = Math.min(u8.length - i, pool.length - off[s]); u8.set(pool.subarray(off[s], off[s] + take), i); i += take; off[s] = (off[s] + take) % pool.length; }
              const dv = new DataView(u8.buffer);
              dv.setFloat64(0, clock() + offset, true); dv.setUint32(8, seq[s], true); dv.setUint32(12, s, true);
              messages++; deliver(u8, clock()); seq[s]++;
            }
            if (seq[s] < total) left = true;
          }
          if (left) setTimeout(tick, 1); else res();
        };
        tick();
      });
      done = true;
    }
    const result = mode === 'local' ? Promise.resolve({ frames: frames, maxSendMs: 0, avgSendMs: 0, maxLagMs: 0, sendErrors: 0, maxMessageBytes: 0 }) : I.invoke('test_channel_bench', { channel: '__CHANNEL__:' + cb, args: { id: ${id}, streams, bytesPerSec: ${bytesPerSec}, chunk: ${chunk}, seconds: ${seconds}, mode, flushMs: ${flushMs} } })
      .finally(() => { done = true; });
    if (mode === 'pull') {
      for (;;) {
        const buf = await I.invoke('test_channel_pull', { id: ${id} });
        if (buf.byteLength) batch(buf, false); else if (done) break;
      }
    }
    const sender = await result;
    const deadline = performance.now() + 60000;
    while (frames < sender.frames && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const drainedMs = performance.now() - t0 - ${seconds} * 1000;
    await new Promise((r) => setTimeout(r, 300));
    running = false; po.disconnect();
    if (onShared) window.chrome.webview.removeEventListener('sharedbufferreceived', onShared);
    I.unregisterCallback?.(cb);
    const wall = (performance.now() - t0) / 1000;
    return { arrive, parsed, frames, bytes, messages, wall, drainedMs, fps: rafs / wall, maxFrameGap, longTasks, longTaskMs, outOfOrder, sender };
  })()`;
}

/** Machine-wide CPU use between two samples (other programs included: the numbers are only comparable at similar load). */
const cpuSample = () => cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return { idle: a.idle + c.times.idle, total: a.total + t }; }, { idle: 0, total: 0 });
const cpuBusy = (a, b) => Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100);

async function bench(page, offset, cfg) {
  const c0 = cpuSample();
  const r = await page.evaluate(benchScript(cfg, offset));
  const machineCpu = cpuBusy(c0, cpuSample());
  const s = r.sender;
  const row = {
    ...cfg,
    framesSent: s.frames, framesReceived: r.frames, messages: r.messages, maxMessageBytes: s.maxMessageBytes,
    mbPerSecReceived: Math.round((r.bytes / cfg.seconds / 1048576) * 100) / 100, drainedAfterMs: Math.round(r.drainedMs),
    arriveMs: stats(r.arrive), parsedMs: stats(r.parsed), fps: Math.round(r.fps * 10) / 10, maxFrameGapMs: Math.round(r.maxFrameGap),
    longTasks: r.longTasks, longTaskMs: Math.round(r.longTaskMs), outOfOrder: r.outOfOrder,
    senderMaxSendMs: Math.round(s.maxSendMs * 1000) / 1000, senderAvgSendMs: Math.round(s.avgSendMs * 1000) / 1000,
    senderMaxLagMs: Math.round(s.maxLagMs * 10) / 10, sendErrors: s.sendErrors, machineCpuPercent: machineCpu,
  };
  const flush = cfg.mode === 'batched' || cfg.mode === 'sharedBuffer' ? ` flush ${cfg.flushMs ?? 4} ms` : '';
  console.log(`  ${cfg.mode} ${cfg.streams} x ${cfg.bytesPerSec / 1048576} MB/s chunk ${cfg.chunk}${flush} -> ${cfg.sink}: arrive p50 ${row.arriveMs.p50} p95 ${row.arriveMs.p95} p99 ${row.arriveMs.p99} max ${row.arriveMs.max} ms; parsed p50 ${row.parsedMs.p50 ?? '-'} p95 ${row.parsedMs.p95 ?? '-'} ms; ${row.framesReceived}/${row.framesSent} frames in ${row.messages} messages, ${row.mbPerSecReceived} MB/s, drained +${row.drainedAfterMs} ms, fps ${row.fps}, max frame gap ${row.maxFrameGapMs} ms, long tasks ${row.longTasks} (${row.longTaskMs} ms), machine CPU ${machineCpu}%`);
  return row;
}

// ---------------------------------------------------------------------------------------------------------------------

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-sp1-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(await fixtureState()));
console.log(`scratch: ${scratch}`);
const port = await freePort();
const child = launchApp({ dataDir, scratch, port });
let page;
try {
  page = await connectPage(port, { timeoutMs: 60000 });
  await waitFor(page, `${tb('marks')}.then((m) => m.some((x) => x.label === 'main' && x.name === 'renderer-boot'))`, 60000, 'main renderer-boot');
  const shotMain = async (name) => { try { const s = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, `${name}.png`), Buffer.from(s.data, 'base64')); } catch { /* minimized */ } };

  // --- 3. IPC transport and CSP --------------------------------------------------------------------------------------
  await page.evaluate(`window.__sp1Csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__sp1Csp.push(e.violatedDirective + ' ' + e.blockedURI)); 1`);
  // Tauri's fallback transport is window.chrome.webview.postMessage (JS -> Rust): count its calls during the probes.
  await page.evaluate(`(() => { const w = window.chrome.webview; window.__sp1Posts = 0; performance.setResourceTimingBufferSize(100000); performance.clearResourceTimings(); const orig = w.postMessage.bind(w); w.postMessage = (...a) => { window.__sp1Posts++; return orig(...a); }; return 1; })()`);
  const entriesBefore = await page.evaluate(ipcProbe);
  const rtt = [];
  for (let i = 0; i < 200; i++) rtt.push(await page.evaluate(`(async () => { const t = performance.now(); await ${tb('clock')}; return performance.now() - t; })()`));
  const mcRtt = [];
  for (let i = 0; i < 100; i++) mcRtt.push(await page.evaluate(`(async () => { const t = performance.now(); await window.mc.loadState?.(); return performance.now() - t; })()`).catch(() => NaN));
  const ipc = await page.evaluate(ipcProbe);
  ipc.duringProbe = ipc.ipc - entriesBefore.ipc;
  ipc.postMessageCalls = await page.evaluate('window.__sp1Posts');
  const foreign = await page.evaluate(`fetch('http://127.0.0.1:9/').then(() => 'allowed', (e) => 'blocked: ' + e.message)`);
  await sleep(300);
  const csp = await page.evaluate('window.__sp1Csp');
  const header = await page.evaluate(`fetch('/index.html').then((r) => r.headers.get('content-security-policy'))`);
  results.numbers.ipc = { ...ipc, invokeRttMs: stats(rtt), loadStateRttMs: stats(mcRtt.filter((x) => !Number.isNaN(x))), cspHeader: header, foreignFetch: foreign, cspViolations: csp };
  check('IPC uses the custom protocol (http://ipc.localhost), not postMessage', ipc.duringProbe >= 300 && ipc.postMessageCalls === 0, `${ipc.duringProbe} ipc.localhost fetches for 300 invokes, ${ipc.postMessageCalls} postMessage calls; sample ${ipc.sample.join(', ')}`);
  check('CSP of tauri.conf.json is applied and enforced', !!header && header.includes("connect-src 'self' ipc: http://ipc.localhost") && foreign.startsWith('blocked') && csp.some((v) => v.startsWith('connect-src')), `${foreign}; violations ${csp.join('; ')}`);
  check('no CSP violation from the IPC itself', !csp.some((v) => /ipc/.test(v)), csp.join('; '));
  console.log(`  invoke round trip (test_bridge clock) p50 ${results.numbers.ipc.invokeRttMs.p50} ms p95 ${results.numbers.ipc.invokeRttMs.p95} ms; state:load p50 ${results.numbers.ipc.loadStateRttMs.p50} ms`);

  // --- 1 + 2. second window, hidden, same browser args -----------------------------------------------------------------
  const opened = await page.evaluate(tb('openWindow', { label: 'detached-sp1', url: 'index.html?sp1=hidden', visible: false }));
  check('a second window with the same browser args opens (no 0x8007139F)', opened.ok, JSON.stringify(opened));
  const boot2 = await waitFor(page, `${tb('marks')}.then((m) => m.find((x) => x.label === 'detached-sp1' && x.name === 'renderer-boot'))`, 60000, 'hidden window renderer-boot').catch(() => null);
  const state2 = await page.evaluate(tb('window', { label: 'detached-sp1', action: 'state' }));
  check('the hidden window reaches renderer-boot while never shown', !!boot2 && state2.hwndVisible === false && state2.visible === false, `boot ${boot2 ? 'yes' : 'no'}, ${JSON.stringify(state2)}`);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const hiddenTarget = list.find((t) => t.url.includes('sp1=hidden'));
  let hidden;
  if (hiddenTarget) {
    hidden = await connectPage(port, { match: hiddenTarget.id });
    const hipc = await hidden.evaluate(ipcProbe);
    const hvis = await hidden.evaluate('document.visibilityState');
    results.numbers.hiddenWindow = { ipc: hipc, visibility: hvis, state: state2, bootAt: boot2?.at };
    check('the hidden window uses the custom protocol too', hipc.ipc > 0, `${hipc.ipc} ipc.localhost fetches, visibility ${hvis}`);
    await hidden.evaluate(timerInstall);
  } else check('the hidden window is a DevTools target', false, list.map((t) => t.url).join(', '));

  const bad = await page.evaluate(tb('openWindow', { label: 'detached-sp1bad', url: 'index.html?sp1=bad', visible: false, browserArgs: 'different', register: false }));
  results.numbers.mismatchedArgs = bad;
  check('a window with DIFFERENT browser args on the same data folder fails (the reason every webview uses the same string)', !bad.ok && /8007139F/i.test(bad.error ?? ''), JSON.stringify(bad));
  await sleep(500);

  // --- 4. timers while minimized / hidden / IsVisible(false) -----------------------------------------------------------
  if (!skipTimers) {
  const inst = await page.evaluate(timerInstall);
  check('the 400 ms status tick of TerminalManager is running (20 cells)', inst.hasStatusTick && inst.statusTimer, JSON.stringify(inst));
  const win = (action) => page.evaluate(tb('window', { label: 'main', action }));
  const phases = [];
  phases.push(await timerPhase(page, 'visible', phaseSeconds));
  let st;
  phases.push(await timerPhase(page, 'minimized', phaseSeconds, async () => { st = await win('minimize'); console.log(`  minimize -> ${JSON.stringify(st)}`); }, async () => { await win('unminimize'); }));
  phases[phases.length - 1].windowState = st;
  phases.push(await timerPhase(page, 'restored', phaseSeconds / 2));
  phases.push(await timerPhase(page, 'window hidden (ShowWindow SW_HIDE)', phaseSeconds, async () => { st = await win('hide'); console.log(`  hide -> ${JSON.stringify(st)}`); }, async () => { await win('show'); }));
  phases[phases.length - 1].windowState = st;
  phases.push(await timerPhase(page, 'WebView2 controller IsVisible(false)', phaseSeconds, async () => { st = await win('webviewHide'); console.log(`  IsVisible(false) -> ${JSON.stringify(st)}`); }, async () => { await win('webviewShow'); }));
  phases[phases.length - 1].windowState = st;
  phases.push(await timerPhase(page, 'minimized + IsVisible(false)', phaseSeconds, async () => { await win('minimize'); st = await win('webviewHide'); }, async () => { await win('webviewShow'); await win('unminimize'); }));
  phases[phases.length - 1].windowState = st;
  if (long) phases.push(await timerPhase(page, `minimized ${longSeconds} s (intensive throttling starts after 5 min hidden)`, longSeconds, async () => { await win('minimize'); }, async () => { await win('unminimize'); }));
  phases.push(await timerPhase(page, 'restored again', phaseSeconds / 2));
  if (hidden) {
    const from = { tick: 0, plain: 0, raf: 0 };
    const h = await hidden.evaluate(timerSince(from));
    const g = gaps(h.plain, h.plain[0] ?? 0, h.now);
    results.numbers.hiddenWindowTimer = { plain: h.plain.length, maxGapMs: Math.round(Math.max(...g.slice(1))), raf: h.raf, visibility: h.visibility };
    console.log(`  never-shown window: plain ${h.plain.length} ticks, max gap ${results.numbers.hiddenWindowTimer.maxGapMs} ms, rAF ${h.raf}, visibility ${h.visibility}`);
  }
  results.numbers.timers = phases;
  for (const p of phases) {
    const okPlain = p.plain >= p.expected * 0.9 && p.plainMaxGapMs < 1200;
    const okTick = p.tick >= p.expected * 0.9 && p.tickMaxGapMs < 1200;
    const detail = `plain ${p.plain}/${p.expected} max gap ${p.plainMaxGapMs} ms, tick ${p.tick} max gap ${p.tickMaxGapMs} ms, visibility ${p.visibility}`;
    // IsVisible(false) is what wry does for Webview::hide() only, never on minimize or window hide (wry 0.57.1
    // parent_subclass_proc): recorded to show why the app must never call it, not a gate.
    if (p.phase.includes('IsVisible(false)')) console.log(`INFO 400 ms timers with ${p.phase}: ${detail}`);
    else check(`400 ms timers keep running: ${p.phase}`, okPlain && okTick, detail);
  }
  await shotMain('after-timers');
  }

  // --- 5. Channel bench --------------------------------------------------------------------------------------------------
  const cal = [];
  for (let i = 0; i < 60; i++) cal.push(await page.evaluate(`(async () => { const c = () => performance.timeOrigin + performance.now(); const a = c(); const r = await ${tb('clock')}; const b = c(); return { rtt: b - a, offset: r.now - (a + b) / 2 }; })()`));
  cal.sort((a, b) => a.rtt - b.rtt);
  const offset = cal[0].offset;
  results.numbers.clock = { offsetMs: offset, bestRttMs: cal[0].rtt, offsetSpreadMs: Math.max(...cal.slice(0, 10).map((c) => c.offset)) - Math.min(...cal.slice(0, 10).map((c) => c.offset)) };
  console.log(`  clock offset Rust - page ${offset.toFixed(3)} ms (best rtt ${cal[0].rtt.toFixed(3)} ms, spread of the 10 best ${results.numbers.clock.offsetSpreadMs.toFixed(3)} ms)`);
  const xtermCount = await page.evaluate(`Array.from({ length: 20 }, (_, i) => window.__mc.terminals.xterm('cell-' + (i + 1))).filter((t) => t && t.element?.isConnected).length`);
  check('20 xterm instances are on screen (5x4 grid)', xtermCount === 20, `${xtermCount}`);
  const MB = 1048576;
  const runs = [];
  const only = process.argv.find((x) => x.startsWith('--modes='))?.split('=')[1].split(',');
  const Q = MB / 4;
  const plan = [
    // The renderer alone: the same output made in the page, no IPC (what 20 xterm can take on this machine).
    { mode: 'local', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'xterm' },
    { mode: 'local', streams: 20, bytesPerSec: Q, chunk: 16384, sink: 'xterm' },
    // Transport only (the page receives and checks the frames, nothing parses them): 20 x 1 MB/s.
    { mode: 'perFrame', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'none' },
    { mode: 'batched', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'none', flushMs: 0 },
    { mode: 'batched', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'none', flushMs: 4 },
    { mode: 'pull', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'none' },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'none', flushMs: 0 },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'none', flushMs: 1 },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'none', flushMs: 2 },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'none', flushMs: 4 },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: MB, chunk: 4096, sink: 'none', flushMs: 0 },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: 2 * MB, chunk: 16384, sink: 'none', flushMs: 0 },
    // Into the 20 cell terminals at a rate they can parse (20 x 256 KiB/s): what each transport adds to 'local'.
    { mode: 'perFrame', streams: 20, bytesPerSec: Q, chunk: 16384, sink: 'xterm' },
    { mode: 'batched', streams: 20, bytesPerSec: Q, chunk: 16384, sink: 'xterm', flushMs: 4 },
    { mode: 'pull', streams: 20, bytesPerSec: Q, chunk: 16384, sink: 'xterm' },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: Q, chunk: 16384, sink: 'xterm', flushMs: 0 },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: Q, chunk: 4096, sink: 'xterm', flushMs: 0 },
    // Into the 20 terminals at 20 x 1 MB/s (the renderer is saturated even without IPC, see 'local').
    { mode: 'perFrame', streams: 1, bytesPerSec: MB, chunk: 16384, sink: 'xterm' },
    { mode: 'perFrame', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'xterm' },
    { mode: 'pull', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'xterm' },
    { mode: 'sharedBuffer', streams: 20, bytesPerSec: MB, chunk: 16384, sink: 'xterm', flushMs: 0 },
  ].filter((c) => !only || only.includes(c.mode));
  for (const c of plan) runs.push(await bench(page, offset, { ...c, seconds: benchSeconds }));
  results.numbers.channel = runs;
  await shotMain('after-bench');
  const at = (mode, { chunk = 16384, sink = 'xterm', rate = MB, flush, streams = 20 } = {}) => runs.find((r) => r.mode === mode && r.chunk === chunk && r.sink === sink && r.streams === streams && r.bytesPerSec === rate && (flush === undefined || r.flushMs === flush));
  const info = (name, r) => r && console.log(`INFO ${name}: arrive p50 ${r.arriveMs.p50} p95 ${r.arriveMs.p95} p99 ${r.arriveMs.p99} ms, parsed p50 ${r.parsedMs.p50 ?? '-'} ms, ${r.mbPerSecReceived} MB/s, fps ${r.fps}`);
  info('Tauri Channel, one raw message per frame, 20 x 1 MB/s, transport only', at('perFrame', { sink: 'none' }));
  info('Tauri Channel, one batched message per flush, 20 x 1 MB/s, transport only', at('batched', { sink: 'none', flush: 0 }));
  info('pull (raw invoke long poll), 20 x 1 MB/s, transport only', at('pull', { sink: 'none' }));
  const shared = at('sharedBuffer', { sink: 'none', flush: 0 });
  if (shared) check('chosen data plane (WebView2 shared buffer, one post in flight, no timer): 20 x 1 MB/s p50 < 2 ms at the full rate', shared.arriveMs.p50 < 2 && shared.mbPerSecReceived >= 19.5, `p50 ${shared.arriveMs.p50} ms, p95 ${shared.arriveMs.p95} ms, p99 ${shared.arriveMs.p99} ms, ${shared.mbPerSecReceived} MB/s, ${shared.messages} messages, fps ${shared.fps}`);
  const local = at('local', { rate: Q });
  const sharedQ = at('sharedBuffer', { rate: Q, flush: 0 });
  // Into xterm the renderer's own parse and paint dominate (see 'local'); recorded, compared in SP1.md, not a gate.
  if (local && sharedQ) console.log(`INFO into 20 xterm at 20 x 256 KiB/s: shared buffer parsed p50 ${sharedQ.parsedMs.p50} ms (fps ${sharedQ.fps}) vs the renderer alone ${local.parsedMs.p50} ms (fps ${local.fps})`);
  check('every frame arrives, in order, no send error', runs.every((r) => r.framesReceived === r.framesSent && r.outOfOrder === 0 && r.sendErrors === 0), runs.map((r) => `${r.mode}:${r.framesReceived}/${r.framesSent}/${r.outOfOrder}`).join(' '));

  const crash = await page.evaluate(tb('paths'));
  results.numbers.paths = crash;
} catch (e) {
  check('spike run', false, e.stack ?? String(e));
} finally {
  try { await page?.evaluate(tb('quit')); } catch { /* gone */ }
  await sleep(1500);
  killTree(child);
  const markersAfter = realProfileMarkers();
  check('real profile untouched', JSON.stringify(markersBefore) === JSON.stringify(markersAfter), markersAfter.join(', '));
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`results: ${join(outDir, 'results.json')}`);
  if (!keep) removeScratch(scratch);
  const failed = results.checks.filter((c) => !c.ok);
  console.log(`${results.checks.length - failed.length}/${results.checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
