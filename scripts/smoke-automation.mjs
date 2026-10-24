// Exercise the built Electron app using isolated data and fake agents (no model calls).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import electron from 'electron';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'unimux-automation-'));
/** Screenshots are kept; the scratch root (data, home, fake agents) is deleted at the end. */
const shots = mkdtempSync(join(tmpdir(), 'unimux-automation-shots-'));
const data = join(root, 'data'), agents = join(root, 'fake-agents'), tokens = join(root, 'tokens');
for (const dir of [data, agents, tokens]) mkdirSync(dir);
for (const name of ['claude', 'codex']) {
  const path = join(agents, process.platform === 'win32' ? `${name}.cmd` : name);
  // The fake agent records what its environment says about the MCP token (Claude cells must not have one there).
  writeFileSync(path, process.platform === 'win32'
    ? `@echo off\r\n> "${tokens}\\%MC_CELL_ID%.env" echo.%UNIMUX_MCP_TOKEN%\r\necho unimux-smoke-agent-ready\r\n`
    : '#!/bin/sh\nprintf "%s" "$UNIMUX_MCP_TOKEN" > "$UNIMUX_SMOKE_TOKENS/$MC_CELL_ID.env"\nprintf "unimux-smoke-agent-ready\\n"\n');
  if (process.platform !== 'win32') chmodSync(path, 0o755);
}
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'smoke-project',
  projects: [{ id: 'smoke-project', name: 'Automation smoke', path: root, color: '#3b82f6', archive: [], activeTabId: 'smoke-grid', tabs: [{
    id: 'smoke-grid', name: 'Team', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] },
    cells: [{ id: 'smoke-coordinator', name: 'Coordinator', profileId: 'claude', role: 'coordinator' }, { id: 'smoke-worker', name: 'Worker', profileId: 'claude', role: 'worker' }],
  }] }],
  profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' }, { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  snippets: [], presets: [], settings: { language: 'pl', fontSize: 13, notifications: false, shell: process.platform === 'win32' ? 'cmd' : 'bash', lastProfileId: 'claude' },
  sidebarCollapsed: false, snippetsOpen: true, sidebarWidth: 228, snippetsWidth: 210,
}));

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
});
const home = scratchHome(root); // never the real home: the app reads ~/.claude and ~/.codex, Electron its appData
const env = { ...scrubAppEnv({ ...process.env }), MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), UNIMUX_SMOKE_TOKENS: tokens,
  PATH: agents + delimiter + (process.env.PATH ?? process.env.Path ?? ''), ...home.env };
const child = spawn(electron, ['.'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appOutput = '', exited = false;
child.on('error', (error) => { appOutput += error.message; exited = true; });
child.stdout.on('data', (data) => { appOutput += data; });
child.stderr.on('data', (data) => { appOutput += data; });
child.once('exit', () => { exited = true; });
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function until(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; if (exited) throw new Error(`App exited during ${label}: ${appOutput}`); await sleep(100); }
  throw new Error(`Timeout waiting for ${label}: ${appOutput}`);
}
let socket;
const clients = [];
let requestId = 0;
const requests = new Map();
const exceptions = [];
async function cdp(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    requests.set(id, { resolve: (value) => { clearTimeout(timer); resolveRequest(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function snapshot() { return evaluate('window.mc.loadSnapshot()'); }
async function mcpClient(cellId) {
  await until(() => existsSync(join(tokens, `${cellId}.env`)), 'fake agent start');
  const fromEnv = readFileSync(join(tokens, `${cellId}.env`), 'utf8').trim();
  const configFile = join(data, 'mcp', `${cellId}.json`);
  let token;
  if (existsSync(configFile)) {
    // Claude cells get the token only as a literal header in their per-cell --mcp-config file, never in the environment.
    token = /^Bearer ([0-9a-f]{64})$/.exec(JSON.parse(readFileSync(configFile, 'utf8')).mcpServers.unimux.headers.Authorization)?.[1];
    assert.ok(token, 'the MCP config carries the cell token');
    assert.equal(fromEnv, '', 'no MCP token in a Claude agent environment');
  } else {
    // Codex can read the token only from its variable (bearer_token_env_var).
    token = fromEnv;
  }
  assert.match(token, /^[0-9a-f]{64}$/);
  const { url } = await evaluate('window.mc.getMcpInfo()');
  const client = new Client({ name: 'electron-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}
async function screenshot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}
try {
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((tab) => tab.type === 'page'); } catch { return null; }
  }, 'Electron debugger');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveSocket, reject) => { socket.addEventListener('open', resolveSocket, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    const pending = requests.get(message.id);
    if (pending) { requests.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
  });
  await cdp('Runtime.enable');
  await until(() => evaluate('Boolean(document.querySelector(".team-toggle"))'), 'renderer boot');
  assert.equal((await evaluate('window.mc.getMcpInfo()')).running, true);
  await evaluate('document.querySelector(".team-toggle").click()');
  await until(() => evaluate('Boolean(document.querySelector(".automation-panel"))'), 'team panel');

  // Compact task cards keep the composer hidden until requested.
  assert.equal(await evaluate('!!document.querySelector(".automation-compose")'), false);
  await evaluate('Array.from(document.querySelectorAll(".automation-head button")).find(b => b.textContent.includes("Nowe zadanie")).click()');
  await until(() => evaluate('!!document.querySelector(".automation-compose")'), 'task composer');
  // Submit the actual React form.
  await evaluate(`(() => {
    const form = document.querySelector('.automation-compose');
    const set = (el, value, prototype) => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(form.querySelector('input'), 'Zadanie z formularza', HTMLInputElement.prototype);
    set(form.querySelector('textarea'), 'Sprawdź panel zadań', HTMLTextAreaElement.prototype);
  })()`);
  await evaluate('document.querySelector(".automation-compose").requestSubmit()');
  await until(async () => (await snapshot()).state.automation.tasks.some((t) => t.title === 'Zadanie z formularza'), 'task form submit');

  const coordinator = await mcpClient('smoke-coordinator');
  const focusedBefore = await evaluate('document.activeElement?.tagName');
  const created = await call(coordinator, 'create_grid', { name: 'Background team', rows: [2], cells: [
    { profileId: 'codex', role: 'worker', name: 'Backend', prompt: 'Review the backend' },
    { profileId: 'claude', role: 'worker', name: 'Frontend', prompt: 'Review the frontend' },
  ] });
  assert.equal((await snapshot()).state.projects[0].activeTabId, 'smoke-grid');
  assert.equal(await evaluate('document.activeElement?.tagName'), focusedBefore);
  assert.equal(await evaluate('document.querySelectorAll(".grid > .cell").length'), 2);
  const backend = await mcpClient(created.cellIds[0]);
  const inbox = (await call(backend, 'read_inbox')).tasks;
  assert.equal(inbox.length, 1);
  await call(backend, 'update_task', { taskId: inbox[0].id, status: 'in_progress' });
  await call(backend, 'update_task', { taskId: inbox[0].id, status: 'completed', result: { summary: 'Backend sprawdzony - testy przeszły.', files: ['src/backend.ts'], tests: ['smoke: passed'], branch: 'mc/backend' } });
  const message = await call(coordinator, 'send_message', { toCellId: created.cellIds[0], text: 'Dziękuję, przekazuję do review.' });
  const combined = await call(backend, 'read_inbox', { acknowledge: true });
  assert.equal(combined.messages[0].id, message.id);
  assert.deepEqual(combined.acknowledgedMessageIds, [message.id]);
  assert.equal((await call(backend, 'read_inbox')).messages.length, 0);
  await call(coordinator, 'snippets', { action: 'save', name: 'Review checklist', text: 'Sprawdź testy i regresje' });
  await call(coordinator, 'save_preset', { name: 'Review team', cells: [{ profileId: 'codex', role: 'worker', prompt: 'Review changes' }] });
  assert.equal((await call(coordinator, 'snippets')).snippets[0].name, 'Review checklist');
  assert.equal((await call(backend, 'wait_for', { timeoutSec: 1 })).event, 'timeout');
  assert.equal((await backend.listTools()).tools.some((tool) => tool.name === 'create_grid'), false);
  await until(() => evaluate('!!Array.from(document.querySelectorAll(".task-open")).find(b => b.textContent.includes("Backend"))'), 'compact task cards');
  await evaluate('Array.from(document.querySelectorAll(".task-open")).find(b => b.textContent.includes("Backend")).click()');
  await until(() => evaluate('document.querySelector(".automation-list").textContent.includes("Backend sprawdzony")'), 'task result rendering');
  await screenshot('tasks');

  await evaluate('Array.from(document.querySelectorAll(".automation-tabs button")).find(b => b.textContent === "Agenci").click()');
  await screenshot('agents');
  await evaluate('Array.from(document.querySelectorAll(".automation-head button")).find(b => b.textContent.includes("Wstrzymaj")).click()');
  await until(async () => (await snapshot()).state.automation.paused, 'pause control');
  const denied = await coordinator.callTool({ name: 'send_message', arguments: { toCellId: 'smoke-worker', text: 'Denied while paused' } });
  assert.equal(denied.isError, true);
  await evaluate('Array.from(document.querySelectorAll(".automation-head button")).find(b => b.textContent.includes("Wznów")).click()');
  await until(async () => !(await snapshot()).state.automation.paused, 'resume control');

  // Check the grid editor and narrow-window layout.
  await evaluate('Array.from(document.querySelectorAll(".workspace-tabs button")).find(b => b.title.includes("Nowy grid")).click()');
  await until(() => evaluate('Boolean(document.querySelector(".cell-table"))'), 'grid editor');
  assert.equal(await evaluate('document.querySelector(".cell-table").textContent.includes("Rola / MCP")'), true);
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".cell-table .role-select")).every(s => s.dataset.role === "")'), true);
  await screenshot('grid-editor');
  await evaluate('Array.from(document.querySelectorAll(".presets span.btn")).find(b => b.textContent.includes("Review team")).click()');
  await until(() => evaluate('document.querySelector(".cell-table .role-select").dataset.role === "worker"'), 'preset MCP role');
  await evaluate('document.querySelector(".cell-table .role-select").click()');
  await until(() => evaluate('!!document.querySelector(".menu")'), 'styled role menu');
  await evaluate('Array.from(document.querySelectorAll(".menu-item")).find(b => b.textContent.includes("Bez MCP")).click()');
  await evaluate('Array.from(document.querySelectorAll(".modal-foot button")).find(b => b.textContent.startsWith("Otwórz grid")).click()');
  await until(async () => (await snapshot()).state.projects[0].tabs.length === 3, 'ordinary UI grid');
  // The new grid opens next to the active one, so it is found by id, not by position.
  const plainGrid = (await snapshot()).state.projects[0].tabs.find((t) => t.id !== 'smoke-grid' && t.id !== created.gridId);
  assert.equal(plainGrid.cells[0].role, undefined);
  assert.equal(plainGrid.cells[0].startupPrompt?.includes('update_task') ?? false, false);
  await until(() => evaluate('document.querySelectorAll(".cell").length === 1'), 'ordinary grid rendered');
  await evaluate('Array.from(document.querySelectorAll(".workspace-tabs .tab")).find(b => b.textContent.includes("Team")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))');
  await until(async () => (await snapshot()).state.projects[0].activeTabId === 'smoke-grid', 'return to original grid');
  await until(() => evaluate('innerWidth <= 1100 && innerHeight <= 700 && document.querySelector(".automation-panel").getBoundingClientRect().bottom <= innerHeight && document.querySelector(".automation-panel").getBoundingClientRect().height >= 180'), 'narrow panel layout');
  await evaluate('Array.from(document.querySelectorAll(".automation-tabs button")).find(b => b.textContent.startsWith("Zadania")).click()');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await screenshot('tasks-narrow');
  await until(() => {
    const saved = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
    return saved.automation?.tasks.some((t) => t.result?.summary.includes('Backend sprawdzony')) && saved.snippets.length === 1 && saved.presets.length === 1;
  }, 'durable state save');
  await call(coordinator, 'update_grid', { gridId: created.gridId, name: 'Finished review', color: '#a78bfa' });
  assert.equal((await snapshot()).state.projects[0].tabs.find(t => t.id === created.gridId).color, '#a78bfa');
  await call(coordinator, 'close_grid', { gridId: created.gridId, cancelTasks: true });
  assert.ok((await snapshot()).state.projects[0].archive.some(t => t.id === created.gridId));
  // The common dropdown opens as a styled listbox, supports keyboard selection and restores focus.
  await evaluate('window.__mc.useStore.setState(st => ({ ui: { ...st.ui, automationOpen: false, settingsTabOpen: true, settingsActive: true } }))');
  await until(() => evaluate('!!document.querySelector("#settings-language.styled-select")'), 'settings dropdown');
  await evaluate('document.querySelector("#settings-language").click()');
  await until(() => evaluate('!!document.querySelector(".select-popup")'), 'custom language list');
  assert.equal(await evaluate('document.querySelectorAll(".select-popup [role=option]").length'), 6);
  await screenshot('language-dropdown');
  await evaluate('document.querySelector(".select-popup").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))');
  await until(() => evaluate('document.querySelector(".select-popup .focused")?.textContent.includes("English")'), 'Home selects first language');
  await evaluate('document.querySelector(".select-popup").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
  await until(async () => (await snapshot()).state.settings.language === 'en', 'keyboard language selection');
  assert.equal(await evaluate('document.activeElement.id'), 'settings-language');
  await evaluate('document.querySelector("#settings-language").click()');
  await until(() => evaluate('!!document.querySelector(".select-popup")'), 'language reopen');
  await evaluate('document.querySelector(".select-popup").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))');
  await evaluate('document.querySelector(".select-popup").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
  await until(async () => (await snapshot()).state.settings.language === 'pl', 'return to Polish');
  await evaluate('document.querySelector("#settings-language").click()');
  await until(() => evaluate('!!document.querySelector(".select-popup")'), 'escape dropdown');
  await evaluate('document.querySelector(".select-popup").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.equal(await evaluate('!!document.querySelector(".select-popup")'), false);
  assert.equal(await evaluate('document.activeElement.id'), 'settings-language');
  await evaluate('Array.from(document.querySelectorAll(".settings-nav button")).find(button => button.textContent === "Terminal").click()');
  await until(() => evaluate('!!document.querySelector("#settings-shell")'), 'terminal settings');
  assert.ok(await evaluate('(() => { const rows = [...document.querySelectorAll(".settings-card > .setting-row")]; return rows.length === 3 && rows.every((row, index) => index === 0 || row.getBoundingClientRect().top >= rows[index - 1].getBoundingClientRect().bottom); })()'), 'one terminal setting per row');
  await evaluate('document.querySelector("#settings-shell").click()');
  await until(() => evaluate('!!document.querySelector(".select-popup")'), 'shell dropdown');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#settings-shell")).outlineStyle'), 'none');
  assert.ok(await evaluate('[...document.querySelectorAll(".select-option-label")].every(label => getComputedStyle(label).whiteSpace === "nowrap" && label.scrollWidth <= label.clientWidth)'), 'shell names fit on one line');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".select-option[aria-selected=true]")).backgroundColor'), 'rgba(0, 0, 0, 0)');
  await screenshot('shell-dropdown');
  await evaluate('document.querySelector(".select-popup").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.deepEqual(exceptions, []);
  console.log(`Automation Electron smoke passed. Screenshots: ${shots}`);
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  console.error(appOutput.slice(-4000));
} finally {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  if (socket?.readyState === WebSocket.OPEN) { await cdp('Browser.close').catch(() => {}); socket.close(); }
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  if (!exited) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  removeScratch(root);
}
