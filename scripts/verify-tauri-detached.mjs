// Real-app check of the detached windows and the event routing (1.2.0, PLAN W5) on the `check` build. A grid and a file
// tab with unsaved text go to their own windows through the renderer's own detach code ("Move to a new window"), each
// window hears only the events of its own cells (state and CLI status reach every window, the automation start list is
// split), a window moved to another display (mixed DPI when the machine has one) saves its place, a restart reopens both
// windows at the same physical place with the unsaved text, and closing a window puts its tab back into the main window.
//
// Nothing appears on the desktop: the main window runs offscreen (MC_OFFSCREEN) and the detached windows are created at
// their real place but never shown (MC_DETACHED_HIDDEN=1, check builds only). Scratch data dir and home only; ends only
// the processes it started.
//
//   npm run build:check && node scripts/verify-tauri-detached.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { connectPage, freePort, killTree, launchApp, readText, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ addProject, addTab, defaultState }, { layoutForCount }] = await Promise.all([load('src/shared/state.ts'), load('src/shared/layout.ts')]);

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-detached-'));
const dataDir = join(scratch, 'data');
const projectDir = join(scratch, 'project');
mkdirSync(dataDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'notes.txt'), 'saved text\n');
console.log(`scratch: ${scratch}`);

// Two grids: "Grid 1" (2 cells) stays in the main window, "Grid 5" (1 cell) goes to its own window.
let input = addProject(defaultState('win32'), { name: 'P', path: projectDir });
const projectId = input.projects[0].id;
input = addTab(input, projectId, { name: 'Grid 1', layout: layoutForCount(2), cells: [{ profileId: 'shell' }, { profileId: 'shell' }] });
input = addTab(input, projectId, { name: 'Grid 5', layout: layoutForCount(1), cells: [{ profileId: 'shell' }] });
input.activeProjectId = projectId;
const [gridA, gridB] = input.projects[0].tabs;
const [mainCell1, mainCell2] = gridA.cells.map((c) => c.id);
const detachedCell = gridB.cells[0].id;
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(input));
const MARKER = 'UNSAVED-W5-TEXT-7f3a';
const fileId = `file-${projectId}-notes`;

const children = [];
const start = async () => {
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port, extraEnv: { MC_DETACHED_HIDDEN: '1' } });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 30000, 'Tauri IPC');
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  return { child, page, port };
};
const bridge = (page, op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
const quit = async (run) => {
  await run.page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
  if ((await waitExit(run.child, 10000)) === null) killTree(run.child);
  run.page.close?.();
};
/** The DevTools page of a detached window (its target URL carries `?detached=<id>`). */
async function detachedPage(port, id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => []);
    const t = list.find((x) => x.type === 'page' && x.url.includes(`detached=${id}`));
    if (t) {
      const page = await connectPage(port, { match: t.id, timeoutMs: 10000 });
      await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 30000, `detached ${id} ready`);
      return page;
    }
    if (Date.now() > deadline) throw new Error(`no page for detached window ${id}`);
    await sleep(250);
  }
}
const registry = async (page) => (await bridge(page, 'state')).snapshot.state.detachedWindows ?? [];
const service = async (page) => (await bridge(page, 'detached')).service;
const bodyHas = (page, text) => page.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
const fileText = (page) => page.evaluate(`(window.__mc.useFileStore.getState().documents.find((d) => d.id === ${JSON.stringify(fileId)}) ?? {}).text ?? null`);
const listen = (page) => page.evaluate(`(() => {
  window.__w5 = [];
  if (window.__w5on) return true;
  window.__w5on = true;
  for (const ch of ['cell:hook', 'focus-cell', 'automation:start-cells', 'cli:changed', 'auth:state']) window.mc.on(ch, (...a) => window.__w5.push([ch, ...a]));
  return true;
})()`);
const heard = (page) => page.evaluate('JSON.stringify(window.__w5)').then((s) => JSON.parse(s));
const near = (a, b, tol = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

try {
  // ── first run: detach a grid and a file tab ────────────────────────────────
  const first = await start();
  const { page } = first;
  const screen = await bridge(page, 'detachedWindow', { action: 'screen' });
  const scales = [...new Set(screen.displays.map((d) => d.scale))];
  console.log(`info: displays ${screen.displays.map((d) => `${d.physical.join('x')}@${d.scale}`).join(', ')}; primary ${screen.primaryId}`);

  // The grid through the renderer's own "Move to a new window".
  const gridOk = await page.evaluate(`window.__mc.detach.detachKey('grid:${gridB.id}', 'menu')`);
  await waitFor(page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'detached', args: null }).then((d) => d.service.windows.length === 1)`, 20000, 'grid window');
  const reg1 = await registry(page);
  const gridWin = reg1.find((w) => w.target.kind === 'grid');
  check('a grid detaches into its own window (registry entry + window)', gridOk === true && gridWin?.target.tabId === gridB.id, JSON.stringify(reg1));

  // A file tab with unsaved text: opened in the main window's file store, changed, then moved.
  await page.evaluate(`(() => {
    const doc = { id: ${JSON.stringify(fileId)}, projectId: ${JSON.stringify(projectId)}, relativePath: 'notes.txt', name: 'notes.txt',
      text: ${JSON.stringify(`saved text\n${MARKER}\n`)}, savedText: 'saved text\\n', diskText: 'saved text\\n', status: 'ready', saving: false, error: null, wrap: false };
    window.__mc.useFileStore.setState((s) => ({ documents: [...s.documents, doc] }));
    window.__mc.files.activateFile(doc.id);
    return true;
  })()`);
  const fileOk = await page.evaluate(`window.__mc.detach.detachKey('file:${fileId}', 'menu')`);
  await waitFor(page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'detached', args: null }).then((d) => d.service.windows.length === 2)`, 20000, 'file window');
  const reg2 = await registry(page);
  const fileWin = reg2.find((w) => w.target.kind === 'file');
  check('a file tab detaches into its own window and leaves the main window', fileOk === true && fileWin?.target.fileId === fileId && (await fileText(page)) === null, JSON.stringify(fileWin?.target));

  const gridPage = await detachedPage(first.port, gridWin.id);
  const filePage = await detachedPage(first.port, fileWin.id);
  await waitFor(filePage, `(window.__mc.useFileStore.getState().documents.find((d) => d.id === ${JSON.stringify(fileId)}) ?? {}).text?.includes(${JSON.stringify(MARKER)})`, 15000, 'unsaved text in the file window');
  const svc1 = await service(page);
  check('the file window took its unsaved text (handoff taken once)', svc1.handoffs.length === 0 && (await fileText(filePage)).includes(MARKER));
  check('the detached windows run with the app label and the detached id', (await gridPage.evaluate('location.search')) === `?detached=${gridWin.id}`, await gridPage.evaluate('location.href'));
  const owners = Object.fromEntries(svc1.owners);
  check('the cell owner table moves the detached grid cell only', owners[detachedCell] === gridWin.id && !owners[mainCell1] && !owners[mainCell2], JSON.stringify(svc1.owners));

  // ── routing: each window hears only its own cells ────────────────────────────
  await Promise.all([listen(page), listen(gridPage), listen(filePage)]);
  const send = (channel, args) => bridge(page, 'send', { channel, args });
  await send('cell:hook', [mainCell1, 'stop']);
  await send('cell:hook', [detachedCell, 'stop']);
  await send('cell:hook', ['not-a-cell', 'stop']);
  await send('automation:start-cells', [[mainCell1, detachedCell, mainCell2]]);
  await send('cli:changed', [{ probe: 1 }]);
  await send('auth:state', [{ probe: 2 }]);
  await sleep(800);
  const [hm, hg, hf] = await Promise.all([heard(page), heard(gridPage), heard(filePage)]);
  const fmt = (h) => h.map((x) => `${x[0]}:${JSON.stringify(x[1])}`).join(' ');
  check('main hears its cells, the unknown cell, its part of the start list, the CLI status and auth',
    fmt(hm) === `cell:hook:"${mainCell1}" cell:hook:"not-a-cell" automation:start-cells:["${mainCell1}","${mainCell2}"] cli:changed:{"probe":1} auth:state:{"probe":2}`, fmt(hm));
  check('the grid window hears only its cell, its part of the start list and the broadcast',
    fmt(hg) === `cell:hook:"${detachedCell}" automation:start-cells:["${detachedCell}"] cli:changed:{"probe":1}`, fmt(hg));
  check('the file window hears only the broadcast', fmt(hf) === 'cli:changed:{"probe":1}', fmt(hf));
  // focus-cell brings the owner window up and reaches only it.
  await Promise.all([listen(page), listen(gridPage)]);
  await send('focus-cell', [detachedCell]);
  await sleep(400);
  const [fm, fg] = await Promise.all([heard(page), heard(gridPage)]);
  check('focus-cell of a detached cell goes to its window only', fm.length === 0 && fg.length === 1 && fg[0][1] === detachedCell, `${fmt(fm)} | ${fmt(fg)}`);

  // ── placement: the grid window moves to another display (or another place) ──
  const other = screen.displays.find((d) => d.id !== screen.primaryId) ?? screen.displays[0];
  const [wx, wy, ww, wh] = other.workArea; // DIPs
  const s = other.scale;
  const [px, py] = other.physical;
  // A physical rect inside the target display: 100 x 80 DIPs from its corner, 900 x 650 DIPs large.
  const moveTo = [Math.round(px + 100 * s), Math.round(py + 80 * s), Math.round(900 * s), Math.round(650 * s)];
  await bridge(page, 'detachedWindow', { id: gridWin.id, action: 'move', x: moveTo[0], y: moveTo[1], width: moveTo[2], height: moveTo[3] });
  await sleep(1200);
  const moved = (await registry(page)).find((w) => w.id === gridWin.id);
  const before = await bridge(page, 'detachedWindow', { id: gridWin.id, action: 'state' });
  check(`the moved window saved its place in DIPs on display ${other.id} (scale ${s})`,
    moved?.displayId === other.id && Math.abs(moved.bounds.width - 900) <= 2 && Math.abs(moved.bounds.height - 650) <= 2
      && moved.bounds.x >= wx - 1 && moved.bounds.y >= wy - 1 && moved.bounds.x < wx + ww && moved.bounds.y < wy + wh,
    JSON.stringify(moved));
  check('the window never became visible (hidden test mode)', before.visible === false && (await bridge(page, 'detachedWindow', { id: fileWin.id, action: 'state' })).visible === false);
  const filePlace = (await bridge(page, 'detachedWindow', { id: fileWin.id, action: 'state' })).physical;
  const flushed = await bridge(page, 'flush');
  check('flushed', flushed.saved === true);
  gridPage.close(); filePage.close();
  await quit(first);
  const saved = JSON.parse(readText(join(dataDir, 'state.json')));
  check('quitting keeps both windows in the registry', (saved.detachedWindows ?? []).length === 2, JSON.stringify(saved.detachedWindows?.map((w) => w.id)));

  // ── restart: same place, the unsaved text is still there ─────────────────────
  const second = await start();
  await waitFor(second.page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'detached', args: null }).then((d) => d.service.windows.length === 2)`, 20000, 'windows after the restart');
  const gridAgain = await bridge(second.page, 'detachedWindow', { id: gridWin.id, action: 'state' });
  const fileAgain = await bridge(second.page, 'detachedWindow', { id: fileWin.id, action: 'state' });
  check('after a restart the grid window opens at the same physical place', near(gridAgain.physical, before.physical), `${before.physical} -> ${gridAgain.physical}`);
  check('after a restart the file window opens at the same physical place', near(fileAgain.physical, filePlace), `${filePlace} -> ${fileAgain.physical}`);
  check('the window title names the grid', gridAgain.title === 'Grid 5 - P - unimux', gridAgain.title);
  const filePage2 = await detachedPage(second.port, fileWin.id);
  await waitFor(filePage2, `(window.__mc.useFileStore.getState().documents.find((d) => d.id === ${JSON.stringify(fileId)}) ?? {}).text?.includes(${JSON.stringify(MARKER)})`, 15000, 'unsaved text after the restart');
  check('the file window still has the unsaved text after the restart', true);

  // ── close = attach back ──────────────────────────────────────────────────────
  await bridge(second.page, 'detachedWindow', { id: fileWin.id, action: 'close' });
  await waitFor(second.page, `(window.__mc.useFileStore.getState().documents.find((d) => d.id === ${JSON.stringify(fileId)}) ?? {}).text?.includes(${JSON.stringify(MARKER)}) === true`, 15000, 'the file tab back in the main window');
  const reg3 = await registry(second.page);
  check('closing the file window returns its tab with the unsaved text to the main window', !reg3.some((w) => w.id === fileWin.id));
  await bridge(second.page, 'detachedWindow', { id: gridWin.id, action: 'close' });
  await waitFor(second.page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'detached', args: null }).then((d) => d.service.windows.length === 0)`, 15000, 'every window closed');
  const reg4 = await registry(second.page);
  const svc4 = await service(second.page);
  check('closing the grid window puts the grid back (registry empty, no owners)', reg4.length === 0 && svc4.owners.length === 0, JSON.stringify(svc4));
  const appWindows = (await bridge(second.page, 'detached')).appWindows;
  check('only the main window is left', JSON.stringify(appWindows) === '["main"]', JSON.stringify(appWindows));
  await quit(second);
} catch (error) {
  failed = true;
  console.log(`FAIL ${error?.stack ?? error}`);
} finally {
  for (const child of children) killTree(child);
  const markersAfter = realProfileMarkers();
  check('real profile untouched', JSON.stringify(markersAfter) === JSON.stringify(markersBefore));
  await sleep(500);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a webview may still hold a file */ }
}
console.log(failed ? 'FAILED' : 'all checks passed');
process.exit(failed ? 1 : 0);
