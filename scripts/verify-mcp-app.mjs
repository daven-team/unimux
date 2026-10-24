// Real-app check of the MCP server and the Claude status hooks: the built app (npm run build) with isolated data, a scratch
// home and fake agents (no model calls), driven over CDP, and the official MCP SDK client connecting the way a cell does
// (the per-cell --mcp-config file of a Claude cell: URL + literal bearer header).
// Checks: tools per role, valid and invalid calls, auth (no token, another cell's token or session, a restarted cell's old
// token), elicitation sessions, mcp:retry, reconnect after an app restart, http hooks -> command hooks fallback (no http hook
// within 20 s of output-driven work after SessionStart) and a blocking allowedHttpHookUrls in the user's settings.
// Usage: npm run build && node scripts/verify-mcp-app.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import electron from 'electron';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'unimux-mcp-app-'));
const data = join(root, 'data'), agents = join(root, 'fake-agents'), project = join(root, 'project');
for (const dir of [data, agents, project]) mkdirSync(dir);
const win = process.platform === 'win32';
// A fake Claude Code 2.1.310: `--version` answers like the real one (http hooks), anything else just stays at the prompt.
writeFileSync(join(agents, win ? 'claude.cmd' : 'claude'), win
  ? '@echo off\r\nif "%~1"=="--version" goto ver\r\necho unimux-fake-claude-ready\r\nexit /b 0\r\n:ver\r\necho 2.1.310 (Claude Code)\r\n'
  : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.310 (Claude Code)"; exit 0; fi\necho unimux-fake-claude-ready\n');
if (!win) chmodSync(join(agents, 'claude'), 0o755);
const LEAD = 'mcp-lead', WORKER = 'mcp-worker';
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'MCP audit', path: project, color: '#3b82f6', archive: [], activeTabId: 'g', tabs: [{
    id: 'g', name: 'Team', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] },
    cells: [{ id: LEAD, name: 'Lead', profileId: 'claude', role: 'coordinator' }, { id: WORKER, name: 'Worker', profileId: 'claude', role: 'worker' }],
  }] }],
  profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 13, notifications: false, shell: win ? 'cmd' : 'bash', lastProfileId: 'claude' },
  sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 228, snippetsWidth: 210,
}));
const home = scratchHome(root);
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];
const ok = (line) => { report.push(`ok   ${line}`); console.log(`ok   ${line}`); };

/** One run of the app: launch, CDP, helpers; `close` ends it. */
async function launch() {
  const port = await freePort();
  const env = { ...scrubAppEnv({ ...process.env }), MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), PATH: agents + delimiter + (process.env.PATH ?? process.env.Path ?? ''), ...home.env };
  const child = spawn(electron, ['.'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const app = { child, output: '', exited: false, clients: [] };
  child.stdout.on('data', (d) => { app.output += d; });
  child.stderr.on('data', (d) => { app.output += d; });
  child.once('exit', () => { app.exited = true; });
  app.until = async (fn, label, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; if (app.exited) throw new Error(`App exited during ${label}: ${app.output.slice(-3000)}`); await sleep(150); }
    throw new Error(`Timeout waiting for ${label}: ${app.output.slice(-3000)}`);
  };
  const target = await app.until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { return null; } }, 'debugger');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  app.cdp = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params })); });
  app.evaluate = async (expression) => {
    const r = await app.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  app.close = async () => {
    // Browser.close never gets an answer once the app is gone: neither wait is allowed to hang.
    const bounded = (promise) => Promise.race([promise.catch(() => undefined), sleep(3000)]);
    await bounded(Promise.all(app.clients.map((c) => c.close())));
    await bounded(app.cdp('Browser.close'));
    socket.close();
    for (let i = 0; i < 50 && !app.exited; i++) await sleep(100);
    if (!app.exited) { if (win) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM'); }
    for (let i = 0; i < 50 && !app.exited; i++) await sleep(100);
  };
  await app.until(() => app.evaluate('Boolean(window.mc && document.querySelector(".cell"))'), 'renderer boot');
  return app;
}
const configFile = (cellId) => join(data, 'mcp', `${cellId}.json`);
const hookFile = (cellId) => join(data, 'hooks', `claude-${cellId}.json`);
const tokenOf = (cellId) => /^Bearer ([0-9a-f]{64})$/.exec(JSON.parse(readFileSync(configFile(cellId), 'utf8')).mcpServers.unimux.headers.Authorization)?.[1];
async function connect(app, url, token, elicit) {
  const client = new Client({ name: 'verify-mcp-app', version: '1' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (request) => elicit(request));
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  app.clients.push(client);
  return { client, transport };
}
const json = (result) => JSON.parse(result.content[0].text);
const post = (url, headers, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

let app;
try {
  app = await launch();
  const info = await app.until(async () => { const i = await app.evaluate('window.mc.getMcpInfo()'); return i.running && i; }, 'MCP server');
  await app.until(() => existsSync(configFile(LEAD)) && existsSync(configFile(WORKER)), 'per-cell MCP configs');
  const config = JSON.parse(readFileSync(configFile(LEAD), 'utf8')).mcpServers.unimux;
  assert.equal(config.type, 'http');
  assert.equal(config.url, info.url);
  ok(`server listens at ${info.url}; Claude cells got private --mcp-config files with their own token`);

  // Tools and calls as the coordinator, with an elicitation-capable client (like Claude Code).
  const asked = [];
  const lead = await connect(app, info.url, tokenOf(LEAD), (request) => { asked.push(request.params.message); return { action: 'decline' }; });
  assert.ok(lead.transport.sessionId, 'an elicitation client gets a session');
  const leadTools = (await lead.client.listTools()).tools.map((t) => t.name);
  assert.ok(leadTools.includes('create_grid') && leadTools.includes('wait_for'));
  const ctx = json(await lead.client.callTool({ name: 'get_context', arguments: {} }));
  assert.equal(ctx.cellId, LEAD);
  assert.equal(ctx.role, 'coordinator');
  const agentsList = json(await lead.client.callTool({ name: 'list_agents', arguments: { verbose: true } }));
  assert.deepEqual(agentsList.agents.map((a) => a.id).sort(), [LEAD, WORKER].sort());
  ok(`coordinator: ${leadTools.length} tools, get_context and list_agents answer for ${LEAD}`);
  const bad = await lead.client.callTool({ name: 'update_task', arguments: { taskId: 5 } });
  assert.equal(bad.isError, true);
  const missing = await lead.client.callTool({ name: 'update_task', arguments: { taskId: 'nope', status: 'completed', result: { summary: 'x' } } });
  assert.match(missing.content[0].text, /Task not found: nope.*read_inbox/);
  await assert.rejects(lead.client.callTool({ name: 'no_such_tool', arguments: {} }), /Unknown tool/);
  ok(`invalid input: "${bad.content[0].text.slice(0, 60)}...", unknown task: "${missing.content[0].text}", unknown tool: protocol error`);
  const byName = json(await lead.client.callTool({ name: 'create_task', arguments: { cellId: 'worker', title: 'Audit', prompt: 'Report back' } }));
  const task = (await app.evaluate('window.mc.loadSnapshot()')).state.automation.tasks.find((t) => t.id === byName.id);
  assert.equal(task.cellId, WORKER);
  ok('create_task with the agent name "worker" went to the worker cell');

  // The worker: own tools only, sees its task, cannot use coordinator tools.
  const worker = await connect(app, info.url, tokenOf(WORKER));
  assert.equal(worker.transport.sessionId, undefined, 'a client without elicitation stays stateless');
  const workerTools = (await worker.client.listTools()).tools.map((t) => t.name);
  assert.ok(!workerTools.includes('create_grid'));
  assert.equal(json(await worker.client.callTool({ name: 'read_inbox', arguments: {} })).tasks[0].id, byName.id);
  const denied = await worker.client.callTool({ name: 'create_grid', arguments: { name: 'x', cells: [{ profileId: 'claude' }] } });
  assert.equal(denied.isError, true);
  await worker.client.callTool({ name: 'update_task', arguments: { taskId: byName.id, status: 'completed', result: { summary: 'done' } } });
  ok(`worker: ${workerTools.length} tools (no coordinator tools), read_inbox shows the task, create_grid refused: "${denied.content[0].text}"`);

  // Auth.
  assert.equal((await post(info.url, {}, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await post(info.url, { Authorization: 'Bearer ' + '0'.repeat(64) }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await post(info.url, { Authorization: `Bearer ${tokenOf(WORKER)}`, 'Mcp-Session-Id': lead.transport.sessionId, 'Mcp-Protocol-Version': '2025-11-25' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 404);
  // fetch cannot set Host: a raw request (DNS rebinding hardening).
  const foreignHost = await new Promise((resolveStatus, reject) => {
    const req = request(info.url, { method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${tokenOf(WORKER)}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolveStatus(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(foreignHost, 403);
  ok('no token, a wrong token, another cell\'s session and a foreign Host are refused (401/401/404/403)');

  // Elicitation through the real app: close a grid with an unfinished task; the client declines.
  const side = json(await lead.client.callTool({ name: 'create_grid', arguments: { name: 'Side', cells: [{ profileId: 'claude', role: 'worker', name: 'Side', prompt: 'Work' }] } }));
  const declined = await lead.client.callTool({ name: 'close_grid', arguments: { gridId: side.gridId } });
  assert.equal(declined.isError, true);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Lead wants to close the grid "Side"/);
  assert.ok((await app.evaluate('window.mc.loadSnapshot()')).state.projects[0].tabs.some((t) => t.id === side.gridId));
  ok(`close_grid asked the user (in the app language): "${asked[0]}" - declined, nothing closed`);

  // A restarted cell gets a new token; the old one is refused.
  const oldWorkerToken = tokenOf(WORKER);
  await app.evaluate(`window.__mc.actions.restartCell(${JSON.stringify(WORKER)}, 'new')`);
  await app.until(() => existsSync(configFile(WORKER)) && tokenOf(WORKER) !== oldWorkerToken, 'new worker token');
  assert.equal((await post(info.url, { Authorization: `Bearer ${oldWorkerToken}` }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  const reconnected = await connect(app, info.url, tokenOf(WORKER));
  assert.equal(json(await reconnected.client.callTool({ name: 'get_context', arguments: {} })).cellId, WORKER);
  ok('a restarted cell gets a fresh token; its old token is refused, the new one works');
  const retried = await app.evaluate('window.mc.retryMcp()');
  assert.equal(retried.running, true);
  assert.equal(retried.url, info.url);
  ok('mcp:retry on a running server keeps the same server');

  // Hooks: the fake claude says 2.1.310, so the cells get http hooks (SessionStart stays a curl command).
  const hooksBefore = JSON.parse(readFileSync(hookFile(LEAD), 'utf8')).hooks;
  assert.equal(hooksBefore.Stop[0].hooks[0].type, 'http');
  assert.equal(hooksBefore.SessionStart[0].hooks[0].type, 'command');
  // SessionStart arrives (curl), then the cell "works" by its output for 20 s without one http hook.
  const sessionUrl = hooksBefore.SessionStart[0].hooks[0].args.at(-1);
  assert.equal((await fetch(sessionUrl, { method: 'POST', body: JSON.stringify({ session_id: '3f0b3f2a-4a6e-4b2f-9a59-6f8f0f5f3a11', source: 'startup' }) })).status, 204);
  await app.evaluate(`window.mc.reportCellStatus(${JSON.stringify(LEAD)}, 'working', 'heuristic', false)`);
  const notice = await app.until(() => app.evaluate('document.querySelector(".toast, .toasts")?.textContent ?? ""').then((t) => t.includes('HTTP hooks') && t), 'fallback notice', 30000);
  assert.ok(existsSync(join(data, 'claude-hook-fallback.json')));
  await app.evaluate(`window.__mc.actions.restartCell(${JSON.stringify(LEAD)}, 'new')`);
  await app.until(() => JSON.parse(readFileSync(hookFile(LEAD), 'utf8')).hooks.Stop[0].hooks[0].type === 'command', 'command hooks after the fallback');
  ok(`no http hook for 20 s of work after SessionStart: notice "${notice.trim().slice(0, 80)}...", the next spawn uses command hooks`);

  // App restart: a new port and new tokens; the old ones are useless, the new config works.
  const oldUrl = info.url, oldLeadToken = tokenOf(LEAD), oldSession = lead.transport.sessionId;
  await app.close();
  // Next run: the fallback is forgotten, but the user's settings carry an allowedHttpHookUrls list that blocks 127.0.0.1.
  rmSync(join(data, 'claude-hook-fallback.json'));
  rmSync(configFile(LEAD), { force: true });
  mkdirSync(join(home.home, '.claude'), { recursive: true });
  writeFileSync(join(home.home, '.claude', 'settings.json'), JSON.stringify({ allowedHttpHookUrls: ['https://hooks.example.com/*'] }));
  app = await launch();
  const info2 = await app.until(async () => { const i = await app.evaluate('window.mc.getMcpInfo()'); return i.running && i; }, 'MCP server after restart');
  await app.until(() => existsSync(configFile(LEAD)) && tokenOf(LEAD) !== oldLeadToken, 'new lead token after restart');
  assert.equal((await post(info2.url, { Authorization: `Bearer ${oldLeadToken}` }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await post(info2.url, { Authorization: `Bearer ${tokenOf(LEAD)}`, 'Mcp-Session-Id': oldSession, 'Mcp-Protocol-Version': '2025-11-25' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 404);
  const again = await connect(app, info2.url, tokenOf(LEAD), () => ({ action: 'cancel' }));
  assert.equal(json(await again.client.callTool({ name: 'get_context', arguments: {} })).cellId, LEAD);
  ok(`after an app restart (${oldUrl} -> ${info2.url}): old token 401, old session 404, the new config connects`);
  assert.equal(JSON.parse(readFileSync(hookFile(LEAD), 'utf8')).hooks.Stop[0].hooks[0].type, 'command');
  ok('a blocking allowedHttpHookUrls in the user settings gives the cell command hooks from the start');
  console.log('MCP real-app check passed.');
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  await app?.close().catch(() => undefined);
  removeScratch(root);
}
