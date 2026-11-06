// Real-app check of the hook server (1.2.0, PLAN H1) on the `check` build: the app starts its own hook server on 127.0.0.1
// (mark `hooks-started`), the hooks a Claude / Codex cell posts (curl form with the token in the path, http form with the
// token as a bearer header) reach the renderer as `cell:hook` / `cell:session` exactly like 1.1.4 sends them, stale nonces,
// wrong tokens and unknown cells are answered and dropped, a 2 MB Stop and a 1.5 MB Codex payload still count, and
// MC_HOOK_DEBUG=1 writes hook-debug.log into the data dir. Scratch data dir and home only; ends only the processes it started.
//
//   npm run build:check && node scripts/verify-tauri-hooks.mjs
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
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

const ID = '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091';
const ID2 = 'a1b2c3d4-e5f6-4789-8abc-def012345678';

// One project, one grid: a Claude cell (following ID2 already) and a Codex cell.
let input = addProject(defaultState('win32'), { name: 'hooks', path: tmpdir() });
input = addTab(input, input.projects[0].id, { layout: layoutForCount(2), cells: [{ profileId: 'claude' }, { profileId: 'codex' }] });
const [claudeCell, codexCell] = input.projects[0].tabs[0].cells;
claudeCell.session = { cli: 'claude', id: ID2, confirmed: true };

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-hooks-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(input));
console.log(`scratch: ${scratch}`);

/** POST (or another method) straight to the app's hook server; resolves to the status code. */
function send(url, body = '', { method = 'POST', headers = {} } = {}) {
  return new Promise((res, rej) => {
    const req = request(url, { method, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (r) => {
      r.resume();
      r.on('end', () => res(r.statusCode));
    });
    req.on('error', rej);
    req.end(body);
  });
}

let child;
try {
  const port = await freePort();
  child = launchApp({ dataDir, scratch, port, extraEnv: { MC_HOOK_DEBUG: '1' } });
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 30000, 'Tauri IPC');
  const bridge = (op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');

  // Everything the renderer receives, in order.
  await page.evaluate(`(() => {
    window.__hookSeen = [];
    window.mc.on('cell:hook', (cell, event, info) => window.__hookSeen.push(['cell:hook', cell, event, info ?? null]));
    window.mc.on('cell:session', (cell, session) => window.__hookSeen.push(['cell:session', cell, session]));
    return true;
  })()`);
  const seen = async (settle = 300) => {
    await sleep(settle);
    return page.evaluate(`window.__hookSeen.splice(0)`);
  };

  await waitFor(page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'hooks', args: null }).then((h) => h.port > 0)`, 15000, 'hook server listening');
  const startupLog = join(dataDir, 'startup.log');
  check('the hook server starts with the app (mark hooks-started)', existsSync(startupLog) && readText(startupLog).includes('hooks-started'));

  // P3 tracks running processes; until then the harness says which cells count as alive.
  const info = await bridge('hooks', { cell: claudeCell.id, alive: [claudeCell.id, codexCell.id] });
  check('16-byte token, port on 127.0.0.1', /^[0-9a-f]{32}$/.test(info.token) && info.port > 0, `port ${info.port}`);
  const curlUrl = (event) => info.cell.url.replace('/EVENT/', `/${event}/`);
  const httpUrl = (event) => info.cell.headerUrl.replace('/EVENT/', `/${event}/`);
  const bearer = { authorization: `Bearer ${info.token}` };

  // Status events of a Claude cell, curl form and http form.
  const answers = [
    await send(curlUrl('prompt')),
    await send(httpUrl('notify'), JSON.stringify({ notification_type: 'permission_prompt' }), { headers: bearer }),
    await send(httpUrl('pre'), JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'x'.repeat(50000) } }), { headers: bearer }),
    await send(curlUrl('stop'), JSON.stringify({ background_tasks: [{ type: 'local_agent', status: 'running' }] })),
    await send(curlUrl('fail'), JSON.stringify({ error: 'rate_limit' })),
  ];
  check('every hook is answered 204', answers.every((s) => s === 204), answers.join(','));
  const statusEvents = await seen();
  const want = [
    ['cell:hook', claudeCell.id, 'prompt', null],
    ['cell:hook', claudeCell.id, 'notify', { need: 'permission' }],
    ['cell:hook', claudeCell.id, 'busy', { tool: 'Bash', toolUseId: 'toolu_1' }],
    ['cell:hook', claudeCell.id, 'stopbg', { tasks: 1, active: 1, statuses: ['running'], types: ['local_agent'], continuation: false, workflows: 0 }],
    ['cell:hook', claudeCell.id, 'fail', { error: 'rate_limit' }],
  ];
  check('the renderer gets cell:hook like 1.1.4 sends it', JSON.stringify(statusEvents) === JSON.stringify(want), JSON.stringify(statusEvents));

  // SessionStart: the followed conversation (a live Claude cell switched to ID) first, then the session hook (hooks.ts emits
  // 'session' before 'sessionstart').
  check('SessionStart answered 204', (await send(curlUrl('session'), JSON.stringify({ session_id: ID, source: 'resume' }))) === 204);
  const sessionEvents = await seen();
  const wantSession = [
    ['cell:session', claudeCell.id, { cli: 'claude', id: ID, confirmed: true }],
    ['cell:hook', claudeCell.id, 'session', { source: 'resume' }],
  ];
  check('SessionStart gives the session hook and cell:session', JSON.stringify(sessionEvents) === JSON.stringify(wantSession), JSON.stringify(sessionEvents));

  // Credentials: a stale nonce, a wrong token, a missing bearer, a GET, a bad cell id.
  const staleUrl = curlUrl('prompt');
  await bridge('hooks', { cell: claudeCell.id, renew: true });
  const rejected = [
    await send(staleUrl),
    await send(curlUrl('prompt').replace(info.token, '0'.repeat(32))),
    await send(httpUrl('prompt')),
    await send(curlUrl('prompt'), '', { method: 'GET' }),
    await send(curlUrl('prompt').replace(`/${claudeCell.id}/`, '/bad%20id/')),
    await send(curlUrl('prompt').replace(`/${claudeCell.id}/`, '/%E0%A4%A/')),
  ];
  check('stale nonce 204, wrong token / no bearer / GET 403, bad cell id 400', JSON.stringify(rejected) === JSON.stringify([204, 403, 403, 403, 400, 400]), rejected.join(','));
  check('none of them reaches the renderer', (await seen()).length === 0);

  // Large payloads still count: a 2 MB Stop (plain stop) and a 1.5 MB Codex notify (a turn end without ids).
  const fresh = await bridge('hooks', { cell: claudeCell.id });
  const freshCurl = (event) => fresh.cell.url.replace('/EVENT/', `/${event}/`);
  const bigStop = JSON.stringify({ last_assistant_message: 'x'.repeat(2 * 1024 * 1024) });
  check('a 2 MB Stop is answered 204', (await send(freshCurl('stop'), bigStop)) === 204);
  const codex = await bridge('hooks', { cell: codexCell.id, renew: true });
  const notify = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': ID, 'turn-id': 'turn-1', 'last-assistant-message': 'y'.repeat(1536 * 1024) });
  check('a 1.5 MB Codex notify is answered 204', (await send(codex.cell.codex, notify)) === 204);
  const small = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': ID, 'turn-id': 'turn-2' });
  check('a Codex notify is answered 204', (await send(codex.cell.codex, small)) === 204);
  const bigEvents = await seen(500);
  const wantBig = [
    ['cell:hook', claudeCell.id, 'stop', { tasks: 0, active: 0, statuses: [], types: [], continuation: false, workflows: 0, tasksUnknown: true }],
    ['cell:hook', codexCell.id, 'stop', { codex: true }],
    ['cell:hook', codexCell.id, 'stop', { codex: true, turnId: 'turn-2', threadId: ID }],
  ];
  check('oversized Stop / Codex still end the turn', JSON.stringify(bigEvents) === JSON.stringify(wantBig), JSON.stringify(bigEvents));

  // A Codex turn end of a cell that is not alive (a late hook of an old process) is dropped.
  await bridge('hooks', { alive: [claudeCell.id] });
  await send(codex.cell.codex, small);
  check('a Codex notify of a cell that does not run is dropped', (await seen()).length === 0);

  // The end of the agent CLI: answered, no renderer event of its own (P3 / M3 take it from here).
  const exit = await send(`${codex.cell.exit}/3`);
  check('the CLI exit route answers 204', exit === 204);

  const log = join(dataDir, 'hook-debug.log');
  const logText = existsSync(log) ? readText(log) : '';
  check('MC_HOOK_DEBUG=1 writes hook-debug.log with shapes only', /keys=background_tasks tasks=\[local_agent\/running\]/.test(logText) && logText.includes('fail error=rate_limit')
    && logText.includes('session source=resume') && !logText.includes('xxxx'), logText.split('\n').length - 1 + ' lines');

  await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
  if ((await waitExit(child, 10000)) === null) killTree(child);
  page.close?.();
  const closed = await send(curlUrl('prompt')).then(() => false, () => true);
  check('the port is closed after quit', closed);
} catch (e) {
  failed = true;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  killTree(child);
  await sleep(500);
  check('the real profile was not touched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a WebView2 file may still be locked */ }
}
console.log(failed ? 'verify-tauri-hooks: FAILED' : 'verify-tauri-hooks: all checks passed');
process.exit(failed ? 1 : 0);
