// Real-app check of the state normalization (1.2.0, PLAN F8) on the `check` build: a damaged 1.1.4 state.json (retired
// profiles, a bad SSH host, garbage alerts, a dangling strip order, detached windows of closed grids, legacy settings) is
// loaded by Rust exactly as normalizeState + unlessRestoring of the TS code load it; a renderer edit with a layout that does
// not fit its cells is repaired like StateController.apply does, one over the cell limit is refused; the saved state.json
// loads back unchanged after a restart. Scratch data dir and home only; ends only the processes it started.
//
//   npm run build:check && node scripts/verify-tauri-normalize.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { connectPage, freePort, killTree, launchApp, readText, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';
import { richState } from './goldens-normalize.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ normalizeState, unlessRestoring }, { normalizeEditedState }] = await Promise.all([load('src/shared/state.ts'), load('src/main/stateController.ts')]);

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

/** Paths where two JSON values differ (key order counts, like JSON.stringify). */
function changedPaths(a, b, path = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (!Array.isArray(a) && ka.join('\n') !== kb.join('\n') && ka.length === kb.length && ka.every((k) => kb.includes(k))) out.push(`${path} (key order)`);
    for (const k of new Set([...ka, ...kb])) changedPaths(a[k], b[k], `${path}.${k}`, out);
    return out;
  }
  out.push(path || '.');
  return out;
}

// The input: the hand-made 1.1.4 state of the golden corpus with the inbox moved to now (retention keeps what it should) and
// what a 0.9.x file still carries.
const input = richState();
const shift = Date.now() - 1_762_430_400_000;
for (const list of [input.automation.tasks, input.automation.messages, input.automation.events]) {
  for (const item of list) for (const k of ['createdAt', 'updatedAt', 'readAt']) if (typeof item[k] === 'number') item[k] += shift;
}
input.settings = { ...input.settings, notifications: false, waitingSound: 'system', autoInstallUpdates: true };
delete input.settings.alerts;
input.projects[0].tabs[0].cells[2].ssh.resume = true;

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-normalize-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
const stateFile = join(dataDir, 'state.json');
writeFileSync(stateFile, JSON.stringify(input));
console.log(`scratch: ${scratch}`);

const children = [];
const start = async () => {
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 30000, 'Tauri IPC');
  return { child, page };
};
const bridge = (page, op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
const quit = async (run) => {
  await run.page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
  if ((await waitExit(run.child, 10000)) === null) killTree(run.child);
  run.page.close?.();
};

try {
  const expected = unlessRestoring(normalizeState(JSON.parse(JSON.stringify(input)), 'win32'));
  const first = await start();
  const { page } = first;
  // The loaded state, before the renderer could change anything: state:load answers what main holds at revision 0 or later.
  const peek = await bridge(page, 'state');
  const loaded = peek.snapshot.state;
  const atLoad = peek.snapshot.revision === 0;
  const diff = changedPaths(expected, loaded);
  // Edited by the renderer before the peek (revision > 0): only what the UI itself adds may differ, the strip order and the
  // `shell` a started terminal records on a cell that had none.
  const sessionAdd = (p) => p.startsWith('.workspaceOrder') || (/^\.projects\.\d+\.tabs\.\d+\.cells\.\d+\.shell$/.test(p) && p.split('.').slice(1).reduce((o, k) => o?.[k], expected) === undefined);
  check(`Rust loads the state like normalizeState + unlessRestoring of 1.1.4 (revision ${peek.snapshot.revision})`, atLoad ? diff.length === 0 : diff.every(sessionAdd), diff.join(', '));
  check('retired profiles folded, legacy alert keys gone, bad SSH host dropped', !loaded.profiles.some((p) => p.id === 'claude-opus') && loaded.projects[0].tabs[0].cells[1].profileId === 'claude'
    && !('notifications' in loaded.settings) && loaded.settings.alerts.events.done.sound.kind === 'system' && loaded.settings.updateMode === 'ask' && loaded.sshHosts.length === 2);
  check('SSH resume mark dropped (session restore off)', loaded.projects[0].tabs[0].cells[2].ssh.resume === undefined);
  check('detached windows of closed grids dropped, strip order repaired', loaded.detachedWindows.length === 6 && !loaded.workspaceOrder.includes('grid:gone'));

  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  await sleep(1500);
  const view = await page.evaluate(`(() => { const s = window.__mc.useStore.getState().s; return s.projects.map((p) => p.tabs.map((t) => t.cells.length + ':' + t.layout.areas.length).join(',')).join(' | '); })()`);
  check('the UI boots on the normalized state', view === '3:3,2:2 | 2:2', view);

  // A renderer edit with a layout that does not fit its cells: StateController.apply rebuilds it.
  const snap = (await bridge(page, 'state')).snapshot;
  const next = JSON.parse(JSON.stringify(snap.state));
  next.projects[1].tabs[0].layout = { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] };
  next.settings.alerts = { ...next.settings.alerts, volume: 7, events: { done: { sound: { kind: 'preset', id: 'nope' } } } };
  next.settings.scrollbackLines = 123;
  next.sshHosts = [...next.sshHosts, { id: 'bad', address: 'x', username: 'y' }];
  const want = normalizeEditedState(JSON.parse(JSON.stringify(next)), JSON.parse(JSON.stringify(snap.state)));
  const answer = await page.evaluate(`window.mc.applyStateEdit(${JSON.stringify({ id: 'verify-1', base: snap.state, next })})`);
  const after = (await bridge(page, 'state')).snapshot.state;
  const editDiff = changedPaths(want, after);
  check('a renderer edit is normalized like StateController.apply', editDiff.length === 0 && after.projects[1].tabs[0].layout.areas.length === 2 && answer.editId === 'verify-1', editDiff.join(', '));

  // Over the cell limit: refused, nothing changes.
  const tooMany = JSON.parse(JSON.stringify(after));
  tooMany.projects[1].tabs[0].cells = Array.from({ length: 21 }, (_, i) => ({ id: `x${i}`, profileId: 'claude' }));
  const refused = await page.evaluate(`window.mc.applyStateEdit(${JSON.stringify({ id: 'verify-2', base: after, next: tooMany })}).then(() => 'accepted', (e) => String(e?.message ?? e))`);
  const unchanged = (await bridge(page, 'state')).snapshot.state;
  check('an edit over the cell limit is refused', refused.includes('cell limit') && JSON.stringify(unchanged) === JSON.stringify(after), refused);

  const flushed = await bridge(page, 'flush');
  check('flushed', flushed.saved === true);
  const savedText = readText(stateFile);
  const final = (await bridge(page, 'state')).snapshot.state;
  check('state.json is JSON.stringify of the state in main', savedText === JSON.stringify(final));
  await quit(first);

  // Restart: the written state (with what the running session added, like the `shell` of a started terminal) loads like
  // 1.1.4 loads it.
  const restartWant = unlessRestoring(normalizeState(JSON.parse(savedText), 'win32'));
  const second = await start();
  const again = (await bridge(second.page, 'state')).snapshot;
  const restartDiff = changedPaths(restartWant, again.state);
  const session = changedPaths(JSON.parse(savedText), restartWant);
  // Like the first load: when the renderer edited before the peek (revision > 0) it may only have put back what the running
  // session adds (the `shell` of a terminal it started), never anything else.
  const restartOk = again.revision === 0 ? restartDiff.length === 0 : restartDiff.every((p) => session.includes(p));
  check(`a restart loads the saved state like 1.1.4 (revision ${again.revision})`, restartOk, restartDiff.join(', '));
  console.log(`info: fields a restart drops or repairs: ${session.join(', ') || 'none'}`);
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
console.log(failed ? 'verify-tauri-normalize: FAILED' : 'verify-tauri-normalize: all checks passed');
process.exit(failed ? 1 : 0);
