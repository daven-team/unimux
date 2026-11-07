// M1 real-app check of the Tauri build: the MCP server starts with the app, `mcp:info` / `mcp:retry` answer the renderer
// like 1.1.4 (index.ts mcpInfo), the `mcp:info` push follows token changes and the first tool use, the server answers on
// 127.0.0.1 with the 1.1.4 checks, and the quit closes the port. Runs the check build offscreen on a scratch data dir and a
// scratch home (scripts/tauri-app.mjs); nothing is shown on the desktop and the real profile is not touched.
//
//   npm run build:check && node scripts/check-mcp-app.mjs          (--keep leaves the scratch dir)
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, readText, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const keep = process.argv.includes('--keep');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const ACCEPT = 'application/json, text/event-stream';
async function post(url, token, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
  return { status: res.status, type: res.headers.get('content-type'), session: res.headers.get('mcp-session-id'), text: await res.text() };
}
/** A raw request (fetch cannot send a foreign Host header). */
function rawStatus(url, head) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = connect(Number(u.port), u.hostname);
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(Number(out.split(' ')[1]) || 0));
    s.on('error', () => resolve(0));
    s.write(head);
  });
}
const portOpen = (url) => new Promise((resolve) => {
  const u = new URL(url);
  const s = connect(Number(u.port), u.hostname);
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-mcp-app-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
let child;
try {
  const port = await freePort();
  child = launchApp({ dataDir, scratch, port });
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  const bridge = (op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);

  const info = await waitFor(page, `window.mc.getMcpInfo().then((i) => i.running ? i : null)`, 15000, 'MCP running');
  check('mcp:info: running on 127.0.0.1 with the 1.1.4 keys', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(info.url)
    && JSON.stringify(Object.keys(info)) === '["running","url","configuredCellIds","connectedCellIds"]', JSON.stringify(info));
  const url = info.url;

  await page.evaluate(`window.__mcpPushes = []; window.__MC_TAURI__.transport.on('mcp:info', (i) => window.__mcpPushes.push(i)); 1`);
  await sleep(300);
  const { token } = await bridge('mcp-token', { cell: 'cell-m1' });
  const pushed = await waitFor(page, `window.__mcpPushes.find((i) => i.configuredCellIds?.includes('cell-m1'))`, 3000, 'mcp:info push').catch(() => null);
  check('a token issued for a cell is pushed as mcp:info (configuredCellIds)', !!pushed, JSON.stringify(pushed));

  const init = await post(url, token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'm1', version: '1' } } });
  const initBody = JSON.parse(init.text);
  check('stateless initialize: JSON, no session, serverInfo unimux 1.2.0', init.status === 200 && init.type === 'application/json' && !init.session
    && initBody.result?.serverInfo?.name === 'unimux' && initBody.result?.serverInfo?.version === '1.2.0', init.text.slice(0, 200));
  const list = await post(url, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  check('tools/list answers (no tool layer before M2: empty list)', list.status === 200 && list.text === '{"result":{"tools":[]},"jsonrpc":"2.0","id":1}', list.text);
  const seen = await waitFor(page, `window.__mcpPushes.find((i) => i.connectedCellIds?.includes('cell-m1'))`, 3000, 'connected push').catch(() => null);
  check('the first tool list marks the cell connected (mcp:info push)', !!seen, JSON.stringify(seen));
  const session = await post(url, token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'm1', version: '1' } } });
  check('an elicitation client gets an SSE session', session.status === 200 && session.type === 'text/event-stream' && /^[0-9a-f-]{36}$/.test(session.session ?? ''), `${session.status} ${session.type}`);
  const discover = await post(url, token, { jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
  check('the 2026-07-28 server/discover probe is refused like 1.1.4', discover.status === 400 && discover.text.includes('Unsupported protocol version: 2026-07-28'), discover.text.slice(0, 120));
  const u = new URL(url);
  check('foreign Host -> 403', await rawStatus(url, `POST /mcp HTTP/1.1\r\nHost: evil.example:${u.port}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`) === 403);
  check('unknown token -> 401', (await post(url, 'f'.repeat(64), { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);
  check('GET -> 405', (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status === 405);

  // A panic inside an MCP request (the check build's test_bridge_panic tool): 500 without echo, one 300-char
  // `MCP request failed` line, and nothing from the app's panic hook (no `panic:` line, so no error dialog either).
  const panicText = `m1-review-panic ${'p'.repeat(1000)}`;
  const boom = await post(url, token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'test_bridge_panic', arguments: { message: panicText } } });
  check('a panicking MCP request answers 500 without echo', boom.status === 500 && boom.text === '{"error":"MCP request failed."}', `${boom.status} ${boom.text}`);
  const inSession = await post(url, token, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'test_bridge_panic', arguments: { message: panicText } } },
    { 'mcp-session-id': session.session, 'mcp-protocol-version': '2025-11-25' });
  check('a panicking session call ends its stream without an answer', inSession.status === 200 && !inSession.text.includes('"id":10'), `${inSession.status} ${inSession.text.slice(0, 120)}`);
  await sleep(500);
  const crashNow = existsSync(join(dataDir, 'crash.log')) ? readText(join(dataDir, 'crash.log')) : '';
  const failed = crashNow.split('\n').filter((l) => l.includes('MCP request failed: '));
  check('each MCP panic is one cut crash.log line (300 chars from "MCP request failed")', failed.length === 2
    && failed.every((l) => l.slice(l.indexOf('MCP request failed: ')).length === 300 && l.includes('m1-review-panic')), failed.map((l) => l.length).join(', '));
  check('the app panic hook stays quiet for MCP panics (no panic: line, no dialog)', !/panic: m1-review-panic/.test(crashNow),
    crashNow.split('\n').filter((l) => l.includes('panic:')).map((l) => l.slice(0, 120)).join(' | '));

  const retried = await page.evaluate('window.mc.retryMcp()');
  check('mcp:retry on a running server keeps the same server', retried.running === true && retried.url === url, JSON.stringify(retried));

  await bridge('mcp-token', { cell: 'cell-m1', revoke: true });
  check('a revoked token gets 401', (await post(url, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);
  const off = await waitFor(page, `window.mc.getMcpInfo().then((i) => i.configuredCellIds.length === 0 ? i : null)`, 3000, 'revoked').catch(() => null);
  check('mcp:info after the revoke lists no cell', !!off, JSON.stringify(off));

  await bridge('quit').catch(() => undefined);
  page.close();
  const code = await waitExit(child, 15000);
  check('quit exits', code !== null, `exit ${code}`);
  check('the MCP port is closed after the quit', !(await portOpen(url)));
  const startup = existsSync(join(dataDir, 'startup.log')) ? readText(join(dataDir, 'startup.log')).trim().split('\n').at(-1) : '';
  check('startup.log has the mcp-started mark', startup.includes('mcp-started'), startup);
  const crash = existsSync(join(dataDir, 'crash.log')) ? readText(join(dataDir, 'crash.log')) : '';
  const other = crash.split('\n').filter((l) => /MCP/.test(l) && !l.includes('MCP request failed: Error: m1-review-panic'));
  check('no other MCP line in crash.log', other.length === 0, other.join(' | '));
} catch (error) {
  check('run', false, String(error?.stack ?? error));
} finally {
  killTree(child);
}
const markersAfter = realProfileMarkers();
check('isolation: nothing new in the real profile', JSON.stringify(markersBefore) === JSON.stringify(markersAfter), markersAfter.join(', ') || 'none');
if (!keep) removeScratch(scratch);
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} passed`);
process.exitCode = bad.length ? 1 : 0;
