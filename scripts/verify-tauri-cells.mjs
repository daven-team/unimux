// Real-app check of W7 (1.2.0): the core cell bookkeeping, the startup gates, the taskbar view and the small app commands on
// the `check` build, through window.mc exactly as the renderer calls them. Offscreen (MC_OFFSCREEN): nothing reaches the
// desktop. Scratch data dir and home only. The pty service (P3) does not exist yet, so the test bridge's `cells {alive}`
// stands in for the cells whose terminal runs.
//
//   npm run build:check && node scripts/verify-tauri-cells.mjs
//
// Checks: the startup steps open all three gates and write 1.1.4's marks to startup.log; every W7 hook is wired (MCP revoke,
// forgetCell parts, taskbar); closing a cell drops its hook nonce only when no process of it runs; a team cell that leaves the
// grids loses its MCP token; cell:runtime counts for the taskbar and never sets an overlay or a progress (1.1.2 / 1.1.0); a
// renderer error reaches crash.log, rate-limited; the renderer marks are kept once and a mark that is not a renderer mark is
// dropped; app:notice shows a toast. The taskbar check reads the counts behind the view too, so the Windows run (where the
// view is always empty) still proves that cell:runtime and the alive cells reach the taskbar.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ defaultState }, { layoutForCount }] = await Promise.all([load('src/shared/state.ts'), load('src/shared/layout.ts')]);

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-w7-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });

const state = defaultState('win32');
state.settings.language = 'en';
const claude = state.profiles.find((p) => p.cli === 'claude') ?? state.profiles[0];
const shell = state.profiles.find((p) => p.cli === 'shell') ?? state.profiles[0];
const ids = { run: 'w7-running', gone: 'w7-gone', lead: 'w7-lead', shell: 'w7-shell' };
state.projects = [{ id: 'proj-w7', name: 'W7 project', path: scratch, color: '#3b82f6', archive: [], activeTabId: 'tab-w7', tabs: [
  { id: 'tab-w7', name: 'Main', layout: layoutForCount(4), cells: [
    { id: ids.run, profileId: claude.id, name: 'Runs' },
    { id: ids.gone, profileId: claude.id, name: 'Gone' },
    { id: ids.lead, profileId: claude.id, name: 'Lead', role: 'lead' },
    { id: ids.shell, profileId: shell.id },
  ] },
] }];
state.activeProjectId = 'proj-w7';
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state));

let child;
try {
  const port = await freePort();
  child = launchApp({ dataDir, scratch, port });
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 30000, 'Tauri IPC');
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  const bridge = (op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
  const mc = (expr) => page.evaluate(expr);
  const cells = (args) => bridge('cells', args);
  const setState = async (fn) => {
    await mc(`window.__mc.useStore.getState().update(${fn})`);
    await sleep(700);
  };

  // ── startup gates and marks ────────────────────────────────────────────
  await waitFor(page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'cells', args: null }).then((r) => r.gates.cellServices && r.gates.accountsReady)`, 20000, 'gates open');
  let report = await cells();
  check('the startup steps open every gate', JSON.stringify(report.gates) === JSON.stringify({ cellServices: true, accountsRecovered: true, accountsReady: true }), JSON.stringify(report.gates));
  const { startupLog, crashLog } = await bridge('paths');
  const line = readFileSync(startupLog, 'utf8').trim().split('\n').at(-1);
  const order = ['hooks-started', 'mcp-started', 'cell-services-ready', 'accounts-recovered', 'accounts-migrated', 'renderer-boot'].map((m) => [m, line.match(new RegExp(`\\b${m}=(\\d+)`))?.[1]]);
  check('startup.log has the marks of the startup steps', order.every(([, ms]) => ms !== undefined), line);
  const ms = Object.fromEntries(order.map(([m, v]) => [m, Number(v)]));
  check('accounts-recovered comes before accounts-migrated (1.1.4 marks it also with nothing to recover)', ms['accounts-recovered'] <= ms['accounts-migrated'], JSON.stringify(ms));
  check('cell-services-ready comes after the hook and MCP servers', ms['cell-services-ready'] >= ms['hooks-started'] && ms['cell-services-ready'] >= ms['mcp-started'], JSON.stringify(ms));
  const want = { revoke: ['mcp'], forget: ['codexHooked'], forgetUnlessAlive: ['contextTracker', 'hooks', 'taskbar'], stateChanged: ['taskbar'] };
  check('the domains are wired into the cell bookkeeping', Object.entries(want).every(([k, v]) => v.every((n) => report.hooks[k]?.includes(n))), JSON.stringify(report.hooks));

  // ── renderer marks: first one wins ─────────────────────────────────────
  await mc(`window.mc.startupMark('first-output'), true`);
  await sleep(300);
  const once = readFileSync(startupLog, 'utf8').trim().split('\n').at(-1);
  await mc(`(window.mc.startupMark('first-output'), window.mc.startupMark('renderer-boot'), true)`);
  await sleep(300);
  const twice = readFileSync(startupLog, 'utf8').trim().split('\n').at(-1);
  check('a renderer mark is kept once', once.includes('first-output=') && twice === once, twice);
  // Names the main process never marks: only the renderer's fixed marks are taken from it.
  await mc(`(window.mc.startupMark('w7-bogus'), window.mc.startupMark('app-ready-x'), true)`);
  await sleep(300);
  const bogus = readFileSync(startupLog, 'utf8');
  check('a mark that is not a renderer mark is dropped', !bogus.includes('w7-bogus') && !bogus.includes('app-ready-x'), bogus.trim().split('\n').at(-1));

  // ── forgetCell and revokeCell ──────────────────────────────────────────
  const hooks = await bridge('hooks', { cell: ids.run });
  await bridge('hooks', { cell: ids.gone });
  check('the hook server runs', typeof hooks.port === 'number' && hooks.port > 0, JSON.stringify(hooks.port));
  const token = await bridge('mcp-token', { cell: ids.lead });
  let info = await mc(`window.mc.getMcpInfo()`);
  check('the team cell has an MCP token', typeof token.token === 'string' && info.configuredCellIds.includes(ids.lead), JSON.stringify(info));
  report = await cells({ alive: [ids.run], nonces: [ids.run, ids.gone] });
  check('both cells have a hook nonce', report.nonces[ids.run] && report.nonces[ids.gone], JSON.stringify(report.nonces));
  await setState(`(s) => ({ ...s, projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, cells: t.cells.filter((c) => c.id === ${JSON.stringify(ids.shell)}) })) })) })`);
  report = await cells({ nonces: [ids.run, ids.gone] });
  check('closing cells drops the hook nonce only of the one without a process', report.nonces[ids.run] && report.nonces[ids.gone] === null, JSON.stringify(report.nonces));
  await sleep(400); // mcp:info is pushed 250 ms after a change
  info = await mc(`window.mc.getMcpInfo()`);
  check('the closed team cell lost its MCP token', !info.configuredCellIds.includes(ids.lead), JSON.stringify(info));

  // ── taskbar ────────────────────────────────────────────────────────────
  check('taskbar {stub: true} starts the recording', (await bridge('taskbar', { stub: true })) === true);
  await setState(`(s) => ({ ...s, projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, cells: [...t.cells, { id: 'w7-agent', profileId: ${JSON.stringify(claude.id)} }] })) })) })`);
  await cells({ alive: [ids.run, 'w7-agent'] });
  await mc(`(window.mc.reportCellStatus('w7-agent', 'working', undefined, true), true)`);
  await sleep(400);
  await mc(`(window.mc.reportCellStatus('w7-agent', 'waiting', 'attention', true), true)`);
  await sleep(400);
  const calls = await bridge('taskbar');
  check('a working or waiting agent sets no taskbar progress or overlay', Array.isArray(calls) && !calls.some((e) => 'progress' in e || ('overlay' in e && e.overlay)), JSON.stringify(calls));
  let view = await bridge('taskbar', { view: true });
  check('cell:runtime reaches the taskbar: the waiting agent counts', view.attention === 1 && view.working === 0, JSON.stringify(view));
  check(process.platform === 'darwin' ? 'the Dock shows the waiting agent' : 'Windows shows no taskbar badge (1.1.2)', view.dock === (process.platform === 'darwin' ? '1' : ''), JSON.stringify(view));
  // The alive set is wired: an agent whose terminal does not run never counts; the running one now works.
  await setState(`(s) => ({ ...s, projects: s.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, cells: [...t.cells, { id: 'w7-dead', profileId: ${JSON.stringify(claude.id)} }] })) })) })`);
  await mc(`(window.mc.reportCellStatus('w7-dead', 'waiting', 'attention', true), window.mc.reportCellStatus('w7-agent', 'working', undefined, true), true)`);
  await sleep(400);
  view = await bridge('taskbar', { view: true });
  check('only agents whose terminal runs count (the alive set)', view.attention === 0 && view.working === 1, JSON.stringify(view));
  check('cell:runtime is answered (no not-yet call)', !Object.keys(await bridge('notYet')).includes('cell:runtime'));

  // ── reportError and app:notice ─────────────────────────────────────────
  await mc(`(window.mc.reportError('boundary', 'w7 boom', 'at w7'), window.mc.reportError('Bad Kind', 'w7 bad'), true)`);
  for (let i = 0; i < 25; i++) await mc(`(window.mc.reportError('loop', 'w7 n${i}'), true)`);
  await sleep(500);
  const crash = readFileSync(crashLog, 'utf8');
  const loops = crash.split('\n').filter((l) => l.includes('renderer loop: w7 n')).length;
  const reports = crash.split('\n').filter((l) => / error renderer [a-z-]+: /.test(l)).length;
  check('a renderer error reaches crash.log, malformed ones do not', crash.includes('renderer boundary: w7 boom\nat w7') && !crash.includes('w7 bad'), crash.slice(-400));
  // 20 a minute in all (the renderer may have reported something of its own before).
  const own = crash.split('\n').filter((l) => / error renderer [a-z-]+: /.test(l) && !l.includes(' w7 ')).map((l) => l.slice(25, 160));
  check('renderer reports are limited to 20 a minute', reports === 20 && loops >= 1 && loops < 25, `${reports} reports, ${loops} loop lines${own.length ? `, the renderer's own: ${JSON.stringify(own)}` : ''}`);
  await bridge('appNotice', { text: 'W7 notice text' });
  await waitFor(page, `window.__mc.useStore.getState().ui.toast?.text === 'W7 notice text'`, 5000, 'app:notice toast');
  check('app:notice shows a toast in the main window', true);

  await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
  const code = await waitExit(child, 15000);
  check('the app quit', code !== null, `exit ${code}`);
  page.close?.();
} catch (error) {
  failed = true;
  console.log(`FAIL ${error?.stack ?? error}`);
} finally {
  killTree(child);
  check('real profile untouched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
  await sleep(500);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a webview may still hold a file */ }
}
console.log(failed ? 'verify-tauri-cells: FAILED' : 'verify-tauri-cells: all checks passed');
process.exit(failed ? 1 : 0);
