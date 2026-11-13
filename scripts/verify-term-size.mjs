// Checks that the program in a terminal always sees the size its xterm has (Windows: ConPTY; run `npm run build:check` first).
// Two 2x2 grids of cmd cells in a scratch data dir and home; every cell of grid a runs a Node watcher that polls
// process.stdout.columns / rows every 100 ms and writes them to a file. After each layout change (window resize, maximize and
// restore, grid switch, side panel, font size, hidden window, parked with its context given back, a shown terminal losing its
// WebGL context, display scale) the watcher's size is compared with the
// xterm's cols / rows. The window stays off screen. Usage: node scripts/verify-term-size.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, sleep } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';

if (process.platform !== 'win32') throw new Error('verify-term-size is Windows only');
const root = mkdtempSync('D:\\Projekty\\_tmp-termsize-');
for (const dir of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, dir), { recursive: true });
const watcher = join(root, 'watch.cjs');
// It reads its input in raw mode as a TUI does (Claude Code, Codex): on Windows libuv learns about a console resize only while it
// reads the console (a Node program that never reads its input keeps its first size under ConPTY, also in Windows Terminal).
writeFileSync(watcher, `const fs = require('fs'); const file = process.argv[2]; let last = '';
process.stdin.setRawMode(true); process.stdin.resume();
const tick = () => { const now = process.stdout.columns + ' ' + process.stdout.rows; if (now !== last) { last = now; fs.writeFileSync(file, now); process.stdout.write('size ' + now + '\\r\\n'); } };
tick(); setInterval(tick, 100);`);
const sizeFile = (id) => join(root, `size-${id}.txt`);

const areas = [0, 1, 2, 3].map((i) => ({ col: i % 2, row: Math.floor(i / 2), colSpan: 1, rowSpan: 1 }));
const TABS = ['a', 'b'];
const cellIds = (t) => areas.map((_, i) => `${t}${i}`);
writeFileSync(join(root, 'data', 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Sizes', path: join(root, 'project'), color: '#3b82f6', archive: [], activeTabId: 'a',
    tabs: TABS.map((t) => ({ id: t, name: `Grid ${t}`, layout: { cols: 2, rows: 2, areas }, cells: cellIds(t).map((id) => ({ id, name: id, profileId: 'shell' })) })) }],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 12, shell: 'cmd', lastProfileId: 'shell', backgroundLoad: 'off' },
  sidebarCollapsed: true, snippetsOpen: false,
}));

let app;
let failures = 0;
const results = [];
try {
  app = await launchApp(root, { MC_CLI_NO_REGISTRY: '1' });
  const ev = app.evaluate;
  await app.until(`document.querySelectorAll('.cell .xterm').length >= 4`, 'first grid', 60000);
  await app.until(`${JSON.stringify(cellIds('a'))}.every((id) => { const x = window.__mc.terminals.xterm(id); if (!x) return false; const b = x.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true).trimEnd().endsWith('>')) return true; return false; })`, 'prompts', 30000);
  for (const id of cellIds('a')) {
    await ev(`window.__mc.terminals.focus(${JSON.stringify(id)}), true`);
    await app.insertText(`"${process.execPath}" "${watcher}" "${sizeFile(id)}"`);
    await app.press('Enter');
    await sleep(100);
  }
  await ev('document.activeElement?.blur(), true');
  await sleep(1500);

  const xtermSizes = () => ev(`Object.fromEntries(${JSON.stringify(cellIds('a'))}.map((id) => { const x = window.__mc.terminals.xterm(id); return [id, x ? x.cols + ' ' + x.rows : null]; }))`);
  // The columns the cell's box holds at the terminal's current cell width (what a fit would give): the terminal fills its cell.
  const boxCols = () => ev(`Object.fromEntries(${JSON.stringify(cellIds('a'))}.map((id) => { const x = window.__mc.terminals.xterm(id); const w = x?._core?._renderService?.dimensions?.css?.cell?.width; const host = x?.element?.parentElement; if (!w || !host || !x.element.offsetParent) return [id, null]; return [id, Math.max(2, Math.floor((parseInt(getComputedStyle(host).width) - 14) / w))]; }))`);
  const check = async (label, settle = 1200) => {
    await sleep(settle);
    const xs = await xtermSizes();
    const fills = await boxCols();
    const row = { label, cells: {} };
    for (const id of cellIds('a')) {
      let pty = null;
      try { pty = readFileSync(sizeFile(id), 'utf8'); } catch { /* not yet */ }
      const ok = pty === xs[id];
      const fill = fills[id] === null || String(fills[id]) === xs[id]?.split(' ')[0];
      if (!ok || !fill) failures++;
      row.cells[id] = !ok ? `MISMATCH xterm ${xs[id]} / program ${pty}` : !fill ? `NOT FITTED xterm ${xs[id]} / box ${fills[id]} cols` : xs[id];
    }
    results.push(row);
    console.log(`${label.padEnd(34)} ${Object.entries(row.cells).map(([id, v]) => `${id}=${v}`).join('  ')}`);
  };
  const tabOf = (t) => `window.__mc.useStore.getState().s.projects[0].tabs.find((x) => x.id === ${JSON.stringify(t)})`;
  const viewport = (width, height) => app.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });

  await check('start');
  await viewport(1400, 900); await check('viewport 1400x900');
  // A window edge dragged: many sizes in a row (the hold, then one fit).
  for (let w = 1400; w >= 1000; w -= 20) { await viewport(w, 820); await sleep(15); }
  await check('window drag to 1000x820');
  await viewport(1600, 1000); await check('viewport 1600x1000');
  await ev(`window.__mc.actions.toggleMaximize('a0'), true`); await check('maximize a0');
  await ev(`window.__mc.actions.toggleMaximize('a0'), true`); await check('restore a0');
  await ev(`window.__mc.actions.toggleMaximize('a1'), true`); await sleep(30); await ev(`window.__mc.actions.toggleMaximize('a1'), true`); await check('maximize + restore a1 quickly');
  await ev(`window.__mc.actions.selectTab('p', ${tabOf('b')}), true`); await sleep(800);
  await viewport(1300, 850); await sleep(500);
  await ev(`window.__mc.actions.selectTab('p', ${tabOf('a')}), true`); await check('resized while grid a was parked');
  const sidebar = () => ev(`window.__mc.useStore.getState().update((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed })), true`);
  await sidebar(); await check('side panel shown');
  await sidebar();
  await check('side panel hidden');
  for (const id of cellIds('a')) await ev(`window.__mc.terminals.setFontSize(${JSON.stringify(id)}, 14), true`);
  await check('font size 14');
  for (const id of cellIds('a')) await ev(`window.__mc.terminals.setFontSize(${JSON.stringify(id)}, 12), true`);
  await check('font size 12');
  await viewport(1250, 800); await sleep(5); await viewport(1500, 950); await sleep(5); await viewport(1250, 800);
  await check('three quick window sizes');
  // Parked for longer than WEBGL_PARKED_MS: the contexts of grid a are given back (releaseWebgl, as releaseStale does), the
  // window changes size meanwhile, grid a comes back (a new context before its fit).
  const ids = JSON.stringify(cellIds('a'));
  await ev(`window.__mc.actions.selectTab('p', ${tabOf('b')}), true`); await sleep(800);
  await ev(`(() => { const t = window.__mc.terminals; for (const id of ${ids}) { const e = t.entries.get(id); if (e) t.releaseWebgl(e); } return true; })()`);
  await viewport(1350, 870); await sleep(500);
  await ev(`window.__mc.actions.selectTab('p', ${tabOf('a')}), true`); await check('parked, context given back, resized');
  // A hidden (minimized) window that changes size, then shows again.
  await ev(`window.__mc.terminals.setWindowShown(false), true`); await sleep(300);
  await viewport(1200, 780); await sleep(500);
  await ev(`window.__mc.terminals.setWindowShown(true), true`); await check('resized while the window was hidden');
  // A shown terminal whose WebGL context goes (lost by the GPU, or moved to another cell by the pool) draws with the DOM
  // renderer until it gets one again: its column count must not follow the renderer (each change is a pty resize, and an
  // agent redraws its screen at every resize).
  await ev(`(() => { const t = window.__mc.terminals; window.__resizes = []; if (!t.__post) { t.__post = t.post.bind(t); t.post = (m) => { if (m.t === 'resize') window.__resizes?.push(m.id + ' ' + m.cols + 'x' + m.rows); return t.__post(m); }; } return true; })()`);
  for (const font of [11, 13, 14, 12]) {
    for (const id of cellIds('a')) await ev(`window.__mc.terminals.setFontSize(${JSON.stringify(id)}, ${font}), true`);
    await sleep(800);
    await ev('window.__resizes = [], true');
    const before = await xtermSizes();
    await ev(`(() => { const t = window.__mc.terminals; const e = t.entries.get('a0'); t.releaseWebgl(e); e.webglBlockedUntil = performance.now() + 1500; return true; })()`);
    await sleep(600);
    const during = await xtermSizes();
    await check(`font ${font}: shown a0 lost its context`, 3000);
    const resizes = await ev('window.__resizes');
    console.log(`  a0 with WebGL ${before.a0}, on the DOM renderer ${during.a0}; pty resizes: ${JSON.stringify(resizes)}`);
    if (during.a0 !== before.a0 || resizes.length) { failures++; console.log('  FAIL: the renderer change resized the terminal'); }
  }
  // Another display scale (the window moved to another monitor, Windows scaling changed): same CSS box, other cell width.
  await viewport(1250, 800); await sleep(300);
  for (const scale of [1.5, 1.25, 1]) { await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1250, height: 800, deviceScaleFactor: scale, mobile: false }); await check(`display scale ${scale}`, 1500); }
  await app.cdp('Emulation.clearDeviceMetricsOverride');
  await check('viewport override cleared');
  console.log(failures ? `FAILED: ${failures} mismatch(es)` : 'OK: every program saw its xterm size');
} finally {
  await app?.close();
  removeScratch(root);
}
process.exit(failures ? 1 : 0);
