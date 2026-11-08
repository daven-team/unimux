// Real-app check of the AI team's reliability fixes (1.1.4): the built app (npm run build:check) with isolated data, a scratch home
// and fake agents that stay running but never call a model or MCP, driven over CDP and the official MCP SDK client.
// Checks: an orphaned task of an archived grid from an older state.json is cancelled at start ("agent closed"); a task for a
// running worker becomes a short notice in its prompt queue (no "Paste" instruction to the model); a dependent task is
// delivered when its prerequisite completes; a worker that never connects to MCP is reported by wait_for as "stalled"
// (after ~90 s); closing a grid with an open task cancels it and the waiting coordinator hears it.
// Usage: npm run build:check && node scripts/verify-mcp-team.mjs   (about two minutes: the stall threshold is 90 s)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { isMainPage, quitApp, spawnApp } from './real-app.mjs';

const root = mkdtempSync(join(tmpdir(), 'unimux-mcp-team-'));
const data = join(root, 'data'), agents = join(root, 'fake-agents'), project = join(root, 'project');
for (const dir of [data, agents, project]) mkdirSync(dir);
const win = process.platform === 'win32';
// A fake Claude Code that stays running (like an agent at its prompt) and never talks to MCP or a model.
writeFileSync(join(agents, win ? 'claude.cmd' : 'claude'), win
  ? '@echo off\r\nif "%~1"=="--version" goto ver\r\necho unimux-fake-claude-ready\r\nping -n 3600 127.0.0.1 >nul\r\nexit /b 0\r\n:ver\r\necho 2.1.310 (Claude Code)\r\n'
  : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.310 (Claude Code)"; exit 0; fi\necho unimux-fake-claude-ready\nsleep 3600\n');
if (!win) chmodSync(join(agents, 'claude'), 0o755);
const LEAD = 'team-lead', WORKER = 'team-worker', OLD = 'old-cell';
const two = { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] };
const now = Date.now();
const oldTask = (id, cellId, status = 'queued') => ({ id, projectId: 'p', cellId, title: id, prompt: 'p', status, delivery: 'pending', createdAt: now, updatedAt: now });
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Team check', path: project, color: '#3b82f6', activeTabId: 'g',
    tabs: [{ id: 'g', name: 'Team', layout: two, cells: [{ id: LEAD, name: 'Lead', profileId: 'claude', role: 'coordinator' }, { id: WORKER, name: 'Worker', profileId: 'claude', role: 'worker' }] }],
    archive: [{ id: 'old', name: 'Old', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }, cells: [{ id: OLD, name: 'Old worker', profileId: 'claude', role: 'worker' }] }] }],
  profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  snippets: [], presets: [], settings: { language: 'en', fontSize: 13, notifications: false, shell: win ? 'cmd' : 'bash', lastProfileId: 'claude' },
  automation: { paused: false, events: [], messages: [], tasks: [oldTask('orphan-archived', OLD), oldTask('orphan-removed', 'gone-cell'), oldTask('kept', WORKER)] },
  sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 228, snippetsWidth: 210,
}));
const home = scratchHome(root);
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (line) => console.log(`ok   ${line}`);

async function launch() {
  const port = await freePort();
  const env = { ...scrubAppEnv({ ...process.env }), MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), PATH: agents + delimiter + (process.env.PATH ?? process.env.Path ?? ''), ...home.env };
  const child = spawnApp({ cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const app = { child, output: '', exited: false, clients: [] };
  child.stdout.on('data', (d) => { app.output += d; });
  child.stderr.on('data', (d) => { app.output += d; });
  child.once('exit', () => { app.exited = true; });
  app.until = async (fn, label, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; if (app.exited) throw new Error(`App exited during ${label}: ${app.output.slice(-3000)}`); await sleep(150); }
    throw new Error(`Timeout waiting for ${label}: ${app.output.slice(-3000)}`);
  };
  const target = await app.until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(isMainPage); } catch { return null; } }, 'debugger');
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
    const bounded = (promise) => Promise.race([promise.catch(() => undefined), sleep(3000)]);
    await bounded(Promise.all(app.clients.map((c) => c.close())));
    // A normal quit (Tauri: the test bridge; Electron: Browser.close), then our own tree kill.
    await bounded(quitApp({ child, evaluate: app.evaluate, cdp: app.cdp, ms: 5000 }));
    socket.close();
    for (let i = 0; i < 50 && !app.exited; i++) await sleep(100);
    if (!app.exited) { if (win) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM'); }
    for (let i = 0; i < 50 && !app.exited; i++) await sleep(100);
  };
  await app.until(() => app.evaluate('Boolean(window.mc && document.querySelector(".cell"))'), 'renderer boot');
  return app;
}
const configFile = (cellId) => join(data, 'mcp', `${cellId}.json`);
const tokenOf = (cellId) => /^Bearer ([0-9a-f]{64})$/.exec(JSON.parse(readFileSync(configFile(cellId), 'utf8')).mcpServers.unimux.headers.Authorization)?.[1];
async function connect(app, url, token) {
  const client = new Client({ name: 'verify-mcp-team', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  app.clients.push(client);
  return client;
}
const json = (result) => { if (result.isError) throw new Error(result.content[0].text); return JSON.parse(result.content[0].text); };

let app;
try {
  app = await launch();
  const snapshot = () => app.evaluate('window.mc.loadSnapshot()').then((s) => s.state);
  const info = await app.until(async () => { const i = await app.evaluate('window.mc.getMcpInfo()'); return i.running && i; }, 'MCP server');
  await app.until(() => existsSync(configFile(LEAD)) && existsSync(configFile(WORKER)), 'per-cell MCP configs');

  // 1. Orphans of an older state.json.
  const start = await snapshot();
  const byId = Object.fromEntries(start.automation.tasks.map((t) => [t.id, t]));
  assert.equal(byId['orphan-archived'].status, 'cancelled');
  assert.equal(byId['orphan-archived'].cancelReason, 'agent closed');
  assert.equal(byId['orphan-removed'].status, 'cancelled');
  assert.equal(byId.kept.status, 'queued');
  ok('at start, open tasks of an archived grid and of a removed cell were cancelled ("agent closed"); the live one stayed');

  // 2. A task for a running worker: a notice in its prompt queue, no Paste instruction for the model.
  const lead = await connect(app, info.url, tokenOf(LEAD));
  await lead.listTools();
  const a = json(await lead.callTool({ name: 'create_task', arguments: { cellId: WORKER, title: 'First', prompt: 'Do the first part' } }));
  assert.equal(a.delivery, 'notified', JSON.stringify(a));
  assert.doesNotMatch(JSON.stringify(a), /Paste/);
  const queue = await app.until(async () => (await snapshot()).projects[0].tabs[0].cells.find((c) => c.id === WORKER).promptQueue, 'worker notice');
  assert.ok(queue.items.some((item) => item.auto && item.text.includes(a.id) && item.text.endsWith('read_inbox')), JSON.stringify(queue));
  ok(`create_task -> ${JSON.stringify(a)}; the worker's prompt queue holds "${queue.items.at(-1).text}"`);

  // 3. A dependent task is delivered when its prerequisite completes.
  const b = json(await lead.callTool({ name: 'create_task', arguments: { cellId: WORKER, title: 'Second', prompt: 'Then this', dependsOn: [a.id] } }));
  assert.deepEqual(b.blockedBy, [a.id]);
  assert.equal((await snapshot()).automation.tasks.find((t) => t.id === b.id).delivery, 'pending');
  const worker = await connect(app, info.url, tokenOf(WORKER));
  json(await worker.callTool({ name: 'update_task', arguments: { taskId: a.id, status: 'completed', result: { summary: 'first part done' } } }));
  await app.until(async () => (await snapshot()).automation.tasks.find((t) => t.id === b.id).delivery === 'native', 'dependent delivered');
  const merged = (await snapshot()).projects[0].tabs[0].cells.find((c) => c.id === WORKER).promptQueue;
  assert.ok(merged.items.some((item) => item.text.includes(b.id)), JSON.stringify(merged));
  ok(`completing ${a.id} delivered the dependent ${b.id}: "${merged.items.find((item) => item.text.includes(b.id)).text}"`);

  // 4. A worker that never connects to MCP is "stalled" for a waiting coordinator.
  const side = json(await lead.callTool({ name: 'create_grid', arguments: { name: 'Silent', cells: [{ profileId: 'claude', role: 'worker', name: 'Silent', prompt: 'Work quietly' }] } }));
  const silentTask = side.tasks[side.cellIds[0]];
  const agents1 = json(await lead.callTool({ name: 'list_agents', arguments: {} })).agents;
  assert.ok(['waiting', 'off'].includes(agents1.find((x) => x.id === side.cellIds[0])?.mcp), JSON.stringify(agents1));
  const startedAt = Date.now();
  const stalled = json(await lead.callTool({ name: 'wait_for', arguments: { taskIds: [silentTask], timeoutSec: 150 } }, undefined, { timeout: 200000 }));
  assert.equal(stalled.event, 'stalled', JSON.stringify(stalled));
  assert.equal(stalled.stalled[0].cellId, side.cellIds[0]);
  ok(`wait_for on the silent worker's task answered "stalled" after ${Math.round((Date.now() - startedAt) / 1000)} s: ${stalled.stalled[0].reason}`);
  const agents2 = json(await lead.callTool({ name: 'list_agents', arguments: { verbose: true } })).agents;
  ok(`list_agents: ${JSON.stringify(agents2.map((x) => ({ id: x.id, status: x.status, since: x.since, mcp: x.mcp })))}`);

  // 5. The user closes that grid: its open task is cancelled and a waiting coordinator hears it.
  const waiting = lead.callTool({ name: 'wait_for', arguments: { taskIds: [silentTask], timeoutSec: 60 } });
  await sleep(500);
  await app.evaluate(`window.__mc.actions.closeTab('p', ${JSON.stringify(side.gridId)})`);
  const closed = json(await waiting);
  assert.equal(closed.event, 'tasks', JSON.stringify(closed));
  assert.deepEqual(closed.tasks.map((t) => [t.status, t.reason]), [['cancelled', 'agent closed']]);
  ok(`closing the grid in the app cancelled its task; the waiting coordinator got ${JSON.stringify(closed)}`);
  console.log('MCP team real-app check passed.');
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  await app?.close().catch(() => undefined);
  removeScratch(root);
}
