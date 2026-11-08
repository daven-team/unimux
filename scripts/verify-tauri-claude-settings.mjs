// Real-app check of the Claude settings, the http hook fallback and the cell files (1.2.0, PLAN H2) on the `check` build:
//
// - at startup the app prunes the cell files of removed cells and every old startup prompt (mark `cell-files-pruned`);
// - a Claude spawn's hooks/claude-<cell>.json is byte-identical to what 1.1.4's claudeHookSettings writes for the same
//   token / nonce / port and version (exec 2.1.310, http 2.1.100, shell 2.1.50 and unknown);
// - its hooks, run the way Claude Code runs them (the shell-free curl of SessionStart with the payload on stdin, the http
//   hooks with their bearer header), reach the renderer as cell:hook;
// - an allowedHttpHookUrls list in the project settings that does not allow 127.0.0.1 gives command hooks;
// - a cell that works 20 s after its SessionStart without one http hook makes the app show one app:notice, write
//   claude-hook-fallback.json and give command hooks to later spawns; after a restart only that claude version keeps them.
//
// Scratch data dir and home only (the test-bridge op `claudeSpawn` stands in for P4's cell:spawn); ends only the processes
// it started; no window reaches the desktop (MC_OFFSCREEN, the notice is the page's own toast).
//
//   npm run build:check && node scripts/verify-tauri-claude-settings.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { connectPage, freePort, killTree, launchApp, listDir, readText, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ addProject, addTab, defaultState }, { layoutForCount }, hooksTs, { translate }] = await Promise.all([
  load('src/shared/state.ts'), load('src/shared/layout.ts'), load('src/main/hooks.ts'), load('src/shared/i18n.ts'),
]);

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const ID = '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091';
const NOTICE = 'Statusy Claude nie docierają przez hooki HTTP (blokuje je polityka allowedHttpHookUrls albo komórka uruchamia starszą wersję claude). Od następnego uruchomienia agenta unimux użyje hooków poleceń.';

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-h2-'));
const dataDir = join(scratch, 'data');
const project = join(scratch, 'project');
mkdirSync(join(project, '.claude'), { recursive: true });
let input = addProject(defaultState('win32'), { name: 'h2', path: project });
input = addTab(input, input.projects[0].id, { layout: layoutForCount(1), cells: [{ profileId: 'claude' }] });
const cell = input.projects[0].tabs[0].cells[0].id;
// Files of an earlier run: the cell's own hook and MCP files stay, a removed cell's go, every startup prompt goes.
for (const dir of ['hooks', 'mcp', 'prompts']) mkdirSync(join(dataDir, dir), { recursive: true });
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(input));
writeFileSync(join(dataDir, 'hooks', `claude-${cell}.json`), '{}');
writeFileSync(join(dataDir, 'hooks', 'claude-gone-cell.json'), '{}');
writeFileSync(join(dataDir, 'hooks', 'notes.txt'), 'x');
writeFileSync(join(dataDir, 'mcp', `${cell}.json`), '{}');
writeFileSync(join(dataDir, 'mcp', 'gone-cell.json'), '{}');
writeFileSync(join(dataDir, 'prompts', `${cell}-1.txt`), 'secret task');
console.log(`scratch: ${scratch}`);
// Since P4 the grid spawns the cell for real: with claude installed it runs Claude Code (in the scratch home) and its spawn,
// kill or exit at a moment the script does not control resets the 20 s watch of the test's own spawns. The app gets a PATH
// without any claude, so the grid's spawn ends held ("CLI missing", start() waits for it) and the test-bridge spawns stay
// the only ones.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const noClaude = (dir) => !['claude', 'claude.exe', 'claude.cmd', 'claude.ps1'].some((f) => existsSync(join(dir, f)));
const appEnv = { [pathKey]: (process.env[pathKey] ?? '').split(delimiter).filter((d) => d && noClaude(d)).join(delimiter), MC_CLI_NO_REGISTRY: '1' };

function send(url, body = '', headers = {}) {
  return new Promise((res, rej) => {
    const req = request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (r) => {
      r.resume();
      r.on('end', () => res(r.statusCode));
    });
    req.on('error', rej);
    req.end(body);
  });
}

/** The text 1.1.4 writes for this token / nonce / port and version (src/main/hooks.ts, the same JSON.stringify). */
function reference(spawned, port, version) {
  const url = (event) => `http://127.0.0.1:${port}/h/${spawned.token}/${encodeURIComponent(cell)}/${event}/${spawned.nonce}`;
  const headerUrl = (event) => url(event).replace(`/h/${spawned.token}/`, '/k/');
  return JSON.stringify(hooksTs.claudeHookSettings({ url, headerUrl, token: spawned.token }, hooksTs.claudeHookForm(version), hooksTs.claudeExtendedHooks(version)), null, 2);
}

const hookOf = (text, name) => JSON.parse(text).hooks[name][0].hooks[0];

async function start(label) {
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port, extraEnv: appEnv });
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 30000, `${label}: Tauri IPC`);
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, `${label}: renderer ready`);
  const bridge = (op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
  await waitFor(page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'hooks', args: null }).then((h) => h.port > 0)`, 15000, `${label}: hook server`);
  // The cell files right after the startup prune, before the grid's spawn ends (its kill drops the cell's MCP config).
  const files = { hooks: listDir(join(dataDir, 'hooks')), mcp: listDir(join(dataDir, 'mcp')) };
  // The grid's own spawn of the cell ends once main finds claude missing (the cell is held and killed, which forgets the
  // watch and the alive mark): wait for that before the test's spawns, then mark the cell alive (the stand-in for a running
  // Claude whose hooks reach the renderer).
  await bridge('record', { channels: ['cell:kill'] });
  const killed = Date.now() + 30000;
  while (Date.now() < killed && !(await bridge('recorded', { channel: 'cell:kill' })).some((c) => c.args?.[0] === cell)) await sleep(250);
  const { port: hookPort } = await bridge('hooks', { alive: [cell] });
  await page.evaluate(`(() => {
    window.__seen = [];
    window.mc.on('cell:hook', (c, event, info) => window.__seen.push(['cell:hook', c, event, info ?? null]));
    window.mc.on('app:notice', (text) => window.__seen.push(['app:notice', text]));
    return true;
  })()`);
  const seen = async (settle = 300) => { await sleep(settle); return page.evaluate('window.__seen.splice(0)'); };
  const spawnCell = (version, env = []) => bridge('claudeSpawn', { cell, version, env, cwd: project });
  const quit = async () => {
    await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
    if ((await waitExit(child, 10000)) === null) killTree(child);
    page.close?.();
  };
  return { child, page, bridge, hookPort, files, seen, spawnCell, quit };
}

let app;
try {
  app = await start('first run');
  const log = readText(join(dataDir, 'startup.log'));
  check('the startup marks cell-files-pruned', log.includes('cell-files-pruned'));
  check('the hook and MCP files of removed cells went, the cell\'s own stayed', JSON.stringify(app.files.hooks) === JSON.stringify([`claude-${cell}.json`, 'notes.txt'])
    && JSON.stringify(app.files.mcp) === JSON.stringify([`${cell}.json`]), `${app.files.hooks} | ${app.files.mcp}`);
  check('every old startup prompt went', listDir(join(dataDir, 'prompts')).length === 0);

  // The settings file per version, byte for byte against 1.1.4.
  for (const version of ['2.1.310 (Claude Code)', '2.1.100', '2.1.50', undefined]) {
    const spawned = await app.spawnCell(version);
    check(`settings for ${version ?? 'an unknown version'} are byte-identical to 1.1.4 (${hooksTs.claudeHookForm(version)})`,
      spawned.text === reference(spawned, app.hookPort, version) && spawned.path === join(dataDir, 'hooks', `claude-${cell}.json`));
  }

  // The hooks of an exec-form file, run like Claude Code runs them.
  const exec = await app.spawnCell('2.1.310');
  const session = hookOf(exec.text, 'SessionStart');
  const curl = spawnSync(session.command, session.args, { input: JSON.stringify({ session_id: ID, source: 'startup' }), encoding: 'utf8', windowsHide: true });
  check('SessionStart: the shell-free curl posts its stdin and prints nothing', curl.status === 0 && curl.stdout === '', `status ${curl.status} ${curl.stderr}`);
  const stop = hookOf(exec.text, 'Stop');
  const permission = hookOf(exec.text, 'PermissionRequest');
  const answers = [
    await send(permission.url, JSON.stringify({ tool_name: 'Bash', tool_input: {} }), { ...permission.headers, 'content-type': 'application/json' }),
    await send(stop.url, JSON.stringify({ background_tasks: [] }), { ...stop.headers, 'content-type': 'application/json' }),
  ];
  check('http hooks with their bearer header are answered 204', answers.every((s) => s === 204), answers.join(','));
  const got = await app.seen();
  const want = [
    ['cell:hook', cell, 'session', { source: 'startup' }],
    ['cell:hook', cell, 'notify', { need: 'permission', immediate: true, tool: 'Bash' }],
    ['cell:hook', cell, 'stop', { tasks: 0, active: 0, statuses: [], types: [], continuation: false, workflows: 0 }],
  ];
  check('the renderer gets the hooks of the written file', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  check('without the header the http hook is refused', (await send(stop.url, '{}')) === 403);

  // allowedHttpHookUrls in the project settings.
  const local = join(project, '.claude', 'settings.local.json');
  writeFileSync(local, JSON.stringify({ allowedHttpHookUrls: ['https://example.com/*'] }));
  check('a project list without 127.0.0.1 gives command hooks', hookOf((await app.spawnCell('2.1.310')).text, 'Stop').type === 'command');
  writeFileSync(local, JSON.stringify({ allowedHttpHookUrls: ['http://127.0.0.1:*'] }));
  check('a list that allows 127.0.0.1 keeps http hooks', hookOf((await app.spawnCell('2.1.310')).text, 'Stop').type === 'http');
  rmSync(local);

  // The fallback: SessionStart arrives, the cell works from output for 20 s, no http hook.
  const watched = await app.spawnCell('2.1.310');
  const s2 = hookOf(watched.text, 'SessionStart');
  spawnSync(s2.command, s2.args, { input: JSON.stringify({ session_id: ID, source: 'startup' }), encoding: 'utf8', windowsHide: true });
  await app.seen();
  await app.bridge('hookWatch', { cell, status: 'working', hooked: false });
  await sleep(19000);
  check('no notice before the 20 s grace is over', (await app.seen(0)).length === 0);
  await sleep(2500);
  const notices = await app.seen(0);
  const translations = ['pl', 'en', 'de', 'es', 'fr', 'pt'].map((language) => translate(language, NOTICE));
  check('one translated app:notice after 20 s', notices.length === 1 && notices[0][0] === 'app:notice' && translations.includes(notices[0][1]), JSON.stringify(notices));
  const fb = join(dataDir, 'claude-hook-fallback.json');
  check('claude-hook-fallback.json remembers the version', existsSync(fb) && readText(fb) === '{"claudeVersion":"2.1.310"}', existsSync(fb) ? readText(fb) : 'missing');
  check('later spawns get command hooks, whatever the version', hookOf((await app.spawnCell('2.1.400')).text, 'Stop').type === 'command');
  const again = await app.spawnCell('2.1.310');
  check('a spawn after the fallback writes the 1.1.4 shell form', again.text === reference(again, app.hookPort, '2.1.50'));
  await app.quit();
  app = undefined;

  // A restart: only the remembered version keeps command hooks.
  app = await start('second run');
  check('after a restart the remembered version gets command hooks', hookOf((await app.spawnCell('2.1.310')).text, 'Stop').type === 'command');
  check('a newer version tries http hooks again', hookOf((await app.spawnCell('2.1.311')).text, 'Stop').type === 'http');
  check('the restart pruned nothing of the live cell', listDir(join(dataDir, 'hooks')).includes(`claude-${cell}.json`));
  await app.quit();
  app = undefined;
} catch (e) {
  failed = true;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  if (app) killTree(app.child);
  await sleep(500);
  check('the real profile was not touched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a WebView2 file may still be locked */ }
}
console.log(failed ? 'verify-tauri-claude-settings: FAILED' : 'verify-tauri-claude-settings: all checks passed');
process.exit(failed ? 1 : 0);
