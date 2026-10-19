// Keystroke-to-echo latency of the built app (run `npm run build` first). Windows and macOS.
// One tab with an SSH cell (the local test server, scripts/ssh-test-server.mjs, which echoes every character like a shell)
// and a local shell cell, in a scratch data dir and home (never the real ones). Each cell gets the keyboard focus and is sent
// single characters over CDP (Input.dispatchKeyEvent); the renderer times each one from its keydown to the frame xterm drew
// with the echo (onRender after the echo was parsed). Two typing paces: "spaced" (one key every ~120 ms, every echo stands
// alone) and "burst" (runs of 6 keys 25 ms apart: keys leave while earlier ones are in flight, which on a real network
// is where Nagle's algorithm would hold small writes back; on loopback it mostly shows coalescing effects).
// Prints median / p95 per cell and pace; fails (exit code 1) when the SSH median exceeds MAX_SSH_MEDIAN_MS or the local
// median by more than MAX_EXTRA_MS, or the SSH p95 exceeds MAX_SSH_P95_MS.
// Usage: node scripts/perf-latency.mjs [keys per pace, default 60] [--json] [--app <dir of a built unimux checkout>]
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

const args = process.argv.slice(2);
const appArg = args.indexOf('--app');
const appDir = appArg >= 0 ? args[appArg + 1] : process.cwd();
const keys = Number(args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--app') ?? 60);
const asJson = args.includes('--json');
/** The SSH echo may take this much longer than the local shell's (median). */
const MAX_EXTRA_MS = 8;
/** Absolute limits of the SSH echo (drawn): before 0.9.9 the median was about 15.6 ms on Windows (one timer tick). */
const MAX_SSH_MEDIAN_MS = 8;
const MAX_SSH_P95_MS = 15;

if (!existsSync(join(appDir, 'out/main/index.js'))) throw new Error(`Build first: npm run build (in ${appDir})`);
const here = process.cwd();
const server = await startTestServer(['--no-auth']);
const root = scratchRoot('latency');
let app;
const results = {};
try {
  const host = testHost(server.port, { label: 'lab' });
  const state = sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] });
  const tab = state.projects[0].tabs[0];
  tab.layout = { cols: 2, rows: 1, areas: [0, 1].map((i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) };
  tab.cells.push({ id: 'local-shell', profileId: 'shell' });
  state.settings = { ...state.settings, shell: process.platform === 'win32' ? 'cmd' : undefined };
  state.sidebarCollapsed = true;
  writeState(root, state);
  writeKnownHost(root, server);
  // launchApp starts the app in the current directory: the checkout under test.
  process.chdir(appDir);
  try { app = await launchApp(root); } finally { process.chdir(here); }
  const sshCell = tab.cells[0].id;
  await app.until(`!!document.querySelector('.ssh-card button')`, 'connect card');
  await app.click('.ssh-card button');
  await app.until(`(() => { const t = window.__mc.terminals.entries.get(${JSON.stringify(sshCell)})?.term; if (!t) return false; const b = t.buffer.active; for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString(true).startsWith('$')) return true; return false; })()`, 'SSH prompt', 30000);
  await app.until(`(() => { const t = window.__mc.terminals.entries.get('local-shell')?.term; if (!t) return false; const b = t.buffer.active; for (let i = 0; i < b.length; i++) if (/>\\s*$|\\$\\s*$|%\\s*$/.test(b.getLine(i)?.translateToString(true) ?? '')) return true; return false; })()`, 'local prompt', 30000);
  await sleep(1500);
  // The probe: each keydown (capture, before xterm sees it) is queued with its character; after every parse the text of the
  // cursor row from the column where typing started is compared with the typed characters, and the newly visible ones count
  // as echoed; the next xterm render after that is when they were drawn.
  await app.evaluate(`(() => {
    const probe = window.__latency = { cell: null, queue: [], typed: '', echoed: 0, row: 0, col: 0, parsed: [], done: [] };
    window.addEventListener('keydown', (ev) => { if (probe.cell && ev.key.length === 1) { probe.queue.push(performance.now()); probe.typed += ev.key; } }, true);
    for (const [id, e] of window.__mc.terminals.entries) {
      e.term.onWriteParsed(() => {
        if (probe.cell !== id || probe.echoed >= probe.typed.length) return;
        const now = performance.now();
        const text = e.term.buffer.active.getLine(probe.row)?.translateToString(true, probe.col) ?? '';
        let n = 0;
        while (n < probe.typed.length && text[n] === probe.typed[n]) n++;
        for (; probe.echoed < n; probe.echoed++) probe.parsed.push([probe.queue.shift(), now]);
      });
      e.term.onRender(() => {
        if (probe.cell !== id || !probe.parsed.length) return;
        const now = performance.now();
        for (const [t0, t1] of probe.parsed.splice(0)) probe.done.push([t1 - t0, now - t0]);
      });
    }
    probe.arm = (id) => { const b = window.__mc.terminals.entries.get(id).term.buffer.active; Object.assign(probe, { cell: id, queue: [], typed: '', echoed: 0, parsed: [], row: b.cursorY + b.baseY, col: b.cursorX }); };
    return true;
  })()`);
  const letters = 'asdfghjklqwertyuiop';
  const typeKey = async (ch) => {
    const code = `Key${ch.toUpperCase()}`;
    const vk = ch.toUpperCase().charCodeAt(0);
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const arm = (cell) => app.evaluate(`window.__latency.arm(${JSON.stringify(cell)}), true`);
  const enter = async (cell) => {
    await app.evaluate(`window.__latency.cell = null, true`);
    await app.press('Enter');
    await sleep(700);
    await arm(cell);
  };
  const measure = async (cell, pace) => {
    await app.evaluate(`(() => { const e = window.__mc.terminals.entries.get(${JSON.stringify(cell)}); e.term.focus(); return document.activeElement === e.term.textarea; })()`);
    await sleep(300);
    await enter(cell);
    await app.evaluate(`window.__latency.done = [], true`);
    let typed = 0;
    let count = 0;
    let stalled = 0;
    while (count < keys) {
      // A key whose echo is never recognized (the probe lost track of the row) must not keep the check running forever.
      if (stalled > 10) throw new Error(`${cell} ${pace}: no echo recognized for 10 rounds (${count} of ${keys} measured)`);
      if (typed >= 12) { await enter(cell); typed = 0; }
      // Spaced: every echo stands alone. Burst: 6 keys 25 ms apart (data in flight while the next key leaves).
      const batch = pace === 'spaced' ? 1 : 6;
      for (let i = 0; i < batch; i++) {
        await typeKey(letters[(count + i) % letters.length]);
        typed++;
        if (pace === 'burst') await sleep(25);
      }
      const t = Date.now();
      while (Date.now() - t < 2000 && (await app.evaluate(`window.__latency.queue.length + window.__latency.parsed.length`)) > 0) await sleep(2);
      const now = await app.evaluate(`window.__latency.done.length`);
      stalled = now > count ? 0 : stalled + 1;
      count = now;
      // Keys still unanswered would be matched against later echoes: start a fresh row instead.
      if (await app.evaluate(`window.__latency.queue.length > 0`)) { await enter(cell); typed = 0; }
      await sleep(80 + Math.random() * 60);
    }
    await app.evaluate(`window.__latency.cell = null, true`);
    return (await app.evaluate(`window.__latency.done.splice(0)`)).slice(0, keys);
  };
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { n: s.length, median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
  };
  for (const pace of ['spaced', 'burst']) {
    for (const [name, cell] of [['local', 'local-shell'], ['ssh', sshCell]]) {
      const samples = await measure(cell, pace);
      results[`${name}/${pace}`] = { parsed: stats(samples.map((x) => x[0])), drawn: stats(samples.map((x) => x[1])) };
    }
  }
} finally {
  await app?.close();
  server.stop();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* still locked */ }
}

if (asJson) console.log(JSON.stringify(results));
else {
  console.log('keystroke -> echo (ms)       parsed median / p95       drawn median / p95 (max)');
  for (const [k, v] of Object.entries(results)) {
    console.log(`${k.padEnd(14)} ${String(v.parsed.median).padStart(12)} / ${String(v.parsed.p95).padEnd(10)} ${String(v.drawn.median).padStart(12)} / ${v.drawn.p95} (${v.drawn.max})  n=${v.drawn.n}`);
  }
}
const failures = [];
for (const pace of ['spaced', 'burst']) {
  const ssh = results[`ssh/${pace}`].drawn;
  const local = results[`local/${pace}`].drawn;
  if (ssh.median > local.median + MAX_EXTRA_MS) failures.push(`${pace}: SSH median ${ssh.median} ms > local ${local.median} ms + ${MAX_EXTRA_MS}`);
  if (ssh.median > MAX_SSH_MEDIAN_MS) failures.push(`${pace}: SSH median ${ssh.median} ms > ${MAX_SSH_MEDIAN_MS}`);
  if (ssh.p95 > MAX_SSH_P95_MS) failures.push(`${pace}: SSH p95 ${ssh.p95} ms > ${MAX_SSH_P95_MS}`);
}
if (failures.length) { console.error(`FAIL\n${failures.join('\n')}`); process.exit(1); }
console.log('OK');
