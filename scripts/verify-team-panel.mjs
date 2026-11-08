// Real-app check of the "Zespół AI" panel and the MCP path behind it (npm run build:check first). A scratch data dir and home,
// MC_OFFSCREEN=1, MC_DEBUG_PORT, MC_CLI_NO_REGISTRY=1 and stand-ins for `claude` (no model, no network). The seeded project has
// tasks in every state (queued behind a prerequisite, in progress, blocked, completed with a result, cancelled) and messages
// (unread, read); the official MCP SDK client then works as the cells: a worker's wait_for wakes on a coordinator's
// create_task, a coordinator's wait_for wakes on the worker's update_task, a wait_for times out, and the panel follows.
// Screenshots go to argv[2] (default: a temp dir). Usage: npm run build:check && node scripts/verify-team-panel.mjs [shots]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { isMainPage, requireBuild, spawnApp } from './real-app.mjs';

requireBuild();
const root = mkdtempSync(join(tmpdir(), 'unimux-team-panel-'));
const shots = resolve(process.argv[2] ?? join(root, 'shots'));
const data = join(root, 'data'), agents = join(root, 'fake-agents'), project = join(root, 'project');
for (const dir of [data, agents, project, shots]) mkdirSync(dir, { recursive: true });
const win = process.platform === 'win32';
writeFileSync(join(agents, win ? 'claude.cmd' : 'claude'), win
  ? '@echo off\r\nif "%~1"=="--version" goto ver\r\necho unimux-fake-claude-ready\r\nping -n 100000 127.0.0.1 >nul\r\nexit /b 0\r\n:ver\r\necho 2.1.310 (Claude Code)\r\n'
  : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.310 (Claude Code)"; exit 0; fi\necho unimux-fake-claude-ready\nsleep 100000\n', { mode: 0o755 });

const now = Date.now(), min = 60_000;
const LEAD = 'team-lead', API = 'team-api', WEB = 'team-web', QA = 'team-qa';
const task = (id, cellId, title, status, extra = {}) => ({ id, projectId: 'p', cellId, fromCellId: LEAD, title, prompt: `${title}.\nKeep the public API stable and add tests.`, status, delivery: 'native', createdAt: now - (extra.age ?? 30) * min, updatedAt: now - (extra.age ?? 30) * min + 5 * min, ...extra, age: undefined });
const tasks = [
  task('t-done', API, 'Add the /orders endpoint', 'completed', { age: 95, result: { summary: 'Added GET/POST /orders with validation and pagination; 14 new tests pass.', files: ['src/api/orders.ts', 'src/api/orders.test.ts'], tests: ['npm test: 214 passed'], branch: 'feat/orders', commit: 'a1b2c3d' } }),
  task('t-progress', WEB, 'Orders page with filters', 'in_progress', { age: 42 }),
  task('t-blocked', QA, 'End-to-end checkout tests', 'blocked', { age: 25, blockedReason: 'The staging database has no seeded products; need a fixture or access.' }),
  task('t-queued', QA, 'Regression run after the orders page', 'queued', { age: 12, dependsOn: ['t-progress'], delivery: 'pending' }),
  task('t-cancelled', WEB, 'Old dashboard tweaks', 'cancelled', { age: 300, fromCellId: undefined }),
];
const message = (id, fromCellId, toCellId, text, age, readAt) => ({ id, projectId: 'p', fromCellId, toCellId, text, delivery: 'native', createdAt: now - age * min, ...(readAt ? { readAt: now - (age - 1) * min } : {}) });
const messages = [
  message('m1', LEAD, API, 'Please expose the order totals in cents, the web client needs integers.', 50, true),
  message('m2', API, LEAD, 'Done, totals are integers now (totalCents). Pushed to feat/orders.', 44, true),
  message('m3', QA, LEAD, 'Blocked on the staging data, see my task. Can you ask the user for a fixture?', 20, false),
  message('m4', undefined, WEB, 'Use the existing Table component for the orders list.', 8, false),
];
const cell = (id, name, role) => ({ id, name, profileId: 'claude', role });
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Shop', path: project, color: '#3b82f6', archive: [], activeTabId: 'g', tabs: [{
    id: 'g', name: 'Orders team', layout: { cols: 2, rows: 2, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }, { col: 0, row: 1, colSpan: 1, rowSpan: 1 }, { col: 1, row: 1, colSpan: 1, rowSpan: 1 }] },
    cells: [cell(LEAD, 'Lead', 'coordinator'), cell(API, 'API', 'worker'), cell(WEB, 'Web', 'worker'), cell(QA, 'QA', 'worker')],
  }] }],
  profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  automation: { paused: false, tasks, messages, events: [] },
  snippets: [], presets: [], settings: { language: process.env.TEAM_LANG ?? 'pl', fontSize: 13, notifications: false, shell: win ? 'cmd' : 'bash', lastProfileId: 'claude' },
  sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 228, snippetsWidth: 210,
}));

const home = scratchHome(root);
const freePort = () => new Promise((ok, fail) => { const p = createServer(); p.on('error', fail); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => ok(n)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(`ok   ${line}`);
const port = Number(process.env.MC_DEBUG_PORT ?? await freePort());
const systemPath = win ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows'] : ['/usr/bin', '/bin'];
const env = { ...scrubAppEnv({ ...process.env }), ...home.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), MC_CLI_NO_REGISTRY: '1', PATH: [agents, ...systemPath].join(delimiter) };
delete env.Path;
const child = spawnApp({ cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', exited = false;
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
child.once('exit', () => { exited = true; });
const until = async (fn, label, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; if (exited) throw new Error(`App exited during ${label}: ${output.slice(-2000)}`); await sleep(120); }
  throw new Error(`Timeout waiting for ${label}`);
};
const clients = [];
let socket;
try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(isMainPage); } catch { return null; } }, 'debugger');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  let n = 0; const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  const cdp = (method, params = {}) => new Promise((ok, fail) => { const id = ++n; pending.set(id, { resolve: ok, reject: fail }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    await sleep(250);
    const { data: png } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(png, 'base64'));
    console.log(`     screenshot ${join(shots, `${name}.png`)}`);
  };
  const click = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  const clickText = (selector, text) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  await until(() => evaluate('Boolean(window.mc && document.querySelector(".cell"))'), 'renderer boot');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });
  const info = await until(async () => { const i = await evaluate('window.mc.getMcpInfo()'); return i.running && i; }, 'MCP server');
  const configFile = (cellId) => join(data, 'mcp', `${cellId}.json`);
  await until(() => [LEAD, API, WEB, QA].every((id) => existsSync(configFile(id))), 'per-cell MCP configs');
  const tokenOf = (cellId) => /^Bearer ([0-9a-f]{64})$/.exec(JSON.parse(readFileSync(configFile(cellId), 'utf8')).mcpServers.unimux.headers.Authorization)[1];
  const connect = async (cellId, elicit = false) => {
    const client = new Client({ name: 'verify-team-panel', version: '1' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${tokenOf(cellId)}` } } }));
    clients.push(client);
    return client;
  };
  const json = (r) => JSON.parse(r.content[0].text);

  assert.ok(await click('.team-toggle'), 'the team toggle in the title bar');
  await until(() => evaluate('Boolean(document.querySelector(".automation-panel"))'), 'team panel');
  await shot('01-tasks');

  // Live MCP: the session client (like Claude Code) for the coordinator, a stateless one for the worker.
  const lead = await connect(LEAD, true);
  const api = await connect(API);
  assert.deepEqual(json(await api.callTool({ name: 'wait_for', arguments: { timeoutSec: 1 } })), { event: 'timeout' });
  log('wait_for with nothing new times out after timeoutSec');
  const started = performance.now();
  const waiting = api.callTool({ name: 'wait_for', arguments: { timeoutSec: 30 } });
  await sleep(300);
  const created = json(await lead.callTool({ name: 'create_task', arguments: { cellId: API, title: 'Order totals in the CSV export', prompt: 'Add totalCents to the CSV export and test it.' } }));
  const woke = json(await waiting);
  const wake = performance.now() - started - 300;
  assert.equal(woke.event, 'inbox');
  log(`worker wait_for woke on create_task after ${wake.toFixed(0)} ms: ${JSON.stringify(woke)}`);
  const inbox = json(await api.callTool({ name: 'read_inbox', arguments: {} }));
  assert.ok(inbox.tasks.some((t) => t.id === created.id && t.prompt));
  await api.callTool({ name: 'update_task', arguments: { taskId: created.id, status: 'in_progress' } });
  const watch = lead.callTool({ name: 'wait_for', arguments: { taskIds: [created.id], timeoutSec: 30 } });
  await sleep(200);
  const doneAt = performance.now();
  await api.callTool({ name: 'update_task', arguments: { taskId: created.id, status: 'completed', result: { summary: 'CSV export has totalCents; 3 tests added.', files: ['src/export/csv.ts'], tests: ['npm test: 217 passed'] } } });
  const finished = json(await watch);
  assert.equal(finished.event, 'tasks');
  log(`coordinator wait_for on the task woke after ${(performance.now() - doneAt).toFixed(0)} ms: ${JSON.stringify(finished)}`);
  await api.callTool({ name: 'send_message', arguments: { toCellId: LEAD, text: 'CSV export is done, see the task result.' } });
  // The live task is done: in the old panel its card shows; in the new one the done group (collapsed while tasks are open) counts it.
  await until(() => evaluate(`(() => { const p = document.querySelector('.automation-panel'); if (!p) return false; if (!p.querySelector('.team-panel, .team-group')) return p.textContent.includes('Order totals in the CSV export'); return [...p.querySelectorAll('.team-group-toggle')].some((g) => g.textContent === 'Zakończone3'); })()`), 'panel shows the live task');
  log('the panel shows the task created over MCP');
  await shot('02-tasks-live');

  const tabs = await evaluate(`[...document.querySelectorAll('.automation-panel [role=tab]')].map((t) => t.textContent)`);
  console.log(`     tabs: ${tabs.join(' | ')}`);
  // A task's details.
  if (!(await click('.team-task-row'))) await click('.task-open');
  await shot('03-task-detail');
  await click('.team-task-back, .task-back');
  for (let i = 0; i < tabs.length; i++) {
    await evaluate(`document.querySelectorAll('.automation-panel [role=tab]')[${i}].click()`);
    await shot(`04-tab-${i + 1}`);
  }
  // The thread with one agent (new panel only) and the inline task form.
  if (await clickText('.automation-panel [role=tab]', process.env.TEAM_LANG === 'en' ? 'Messages' : 'Wiadomości') && await click('.team-thread-agent')) await shot('05-thread');
  if (await clickText('.automation-panel [role=tab]', process.env.TEAM_LANG === 'en' ? 'Tasks' : 'Zadania') && await click('.team-new-task, .automation-head .btn.small')) await shot('06-new-task');

  // The 1.1.2 panel: groups, the inline form, a reply in a thread, "assign again" (only when the new panel is built).
  if (await evaluate(`Boolean(document.querySelector('.team-panel'))`)) {
    const type = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const snapshot = () => evaluate('window.mc.loadSnapshot().then((s) => s.state.automation)');
    const groups = await evaluate(`[...document.querySelectorAll('.team-group-toggle')].map((g) => g.textContent)`);
    assert.deepEqual(groups.map((g) => g.replace(/\d+$/, '')), ['W trakcie', 'Otwarte', 'Zakończone']);
    assert.ok(/Zakończone3/.test(groups[2]), `done group counts the live task: ${groups[2]}`);
    log(`task groups: ${groups.join(', ')}`);
    await type('.team-compose-title', 'Check the invoice totals');
    await type('.team-compose-text', 'Compare totalCents with the invoice PDF and report differences.');
    await evaluate(`document.querySelector('.team-compose-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
    const added = await until(async () => (await snapshot()).tasks.find((t) => t.title === 'Check the invoice totals'), 'task from the inline form');
    assert.equal(added.cellId, LEAD);
    assert.equal(await evaluate(`Boolean(document.querySelector('.team-compose'))`), false);
    log('inline "Nowe zadanie" form: Ctrl+Enter assigned the task and closed the form');
    // Done group: open it, pick the cancelled task and assign it again.
    await evaluate(`[...document.querySelectorAll('.team-group-toggle')].find((g) => g.textContent.startsWith('Zakończone') && g.getAttribute('aria-expanded') === 'false')?.click()`);
    assert.ok(await clickText('.team-task-row', 'Old dashboard tweaks'));
    await shot('07-done-task');
    const before = (await snapshot()).tasks.filter((t) => t.title === 'Old dashboard tweaks').length;
    assert.ok(await clickText('.team-actions .btn', 'Przydziel ponownie'));
    await until(async () => (await snapshot()).tasks.filter((t) => t.title === 'Old dashboard tweaks').length === before + 1, 'assigned again');
    log('"Przydziel ponownie" made a new task from the cancelled one');
    assert.ok(await clickText('.team-task-row', 'Add the /orders endpoint'));
    assert.ok(await evaluate(`[...document.querySelectorAll('.team-actions .btn')].some((b) => b.textContent.includes('Kopiuj wynik'))`));
    await shot('08-result');
    // A reply in the thread with QA.
    await clickText('.automation-panel [role=tab]', 'Wiadomości');
    assert.ok(await clickText('.team-thread-agent', 'QA'));
    await type('.team-reply-text', 'I asked the user for a fixture; use the seed script meanwhile.');
    await click('.team-reply button[type=submit]');
    await until(async () => (await snapshot()).messages.some((m) => m.toCellId === QA && m.text.startsWith('I asked the user')), 'reply sent');
    await until(() => evaluate(`document.querySelector('.team-messages').textContent.includes('I asked the user')`), 'reply shown in the thread');
    log('a reply in the QA thread reached the QA inbox and shows in the thread');
    await shot('09-thread-reply');
    // The worker's wait_for wakes on the user's message from the panel too.
    const qa = await connect(QA);
    await qa.callTool({ name: 'read_inbox', arguments: { acknowledge: true } });
    const qaWait = qa.callTool({ name: 'wait_for', arguments: { timeoutSec: 20 } });
    await sleep(200);
    await type('.team-reply-text', 'One more thing: keep the old fixture.');
    await click('.team-reply button[type=submit]');
    assert.equal(json(await qaWait).event, 'inbox');
    log('a worker wait_for woke on a message sent from the panel');
  }
  console.log(`screenshots in ${shots}`);
} finally {
  await Promise.race([Promise.all(clients.map((c) => c.close().catch(() => undefined))), sleep(3000)]);
  try { socket?.close(); } catch { /* gone */ }
  if (!exited) { if (win) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } } else child.kill('SIGTERM'); }
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  removeScratch(join(root, 'data'));
  removeScratch(join(root, 'home'));
}
