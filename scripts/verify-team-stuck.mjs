// Real-app check of stuck tasks in the "Zespół AI" panel (1.1.4; npm run build first). Scratch data dir and home, MC_OFFSCREEN=1,
// MC_DEBUG_PORT, Windows PowerShell as the shell and a Node stand-in behind claude.cmd that records every start. The seeded
// team: a coordinator and a worker that connect over MCP (the official SDK client works as their cells), a worker whose CLI
// fails 1 s after its start (exit code 1, today's incident), a worker that runs but never connects to MCP, and a worker of a
// closed grid (the project's history), each with an open task. Checks the time-in-state labels, the badges, the banner, the
// Agents tab, "Przydziel ponownie" of the archived agent's task and "Uruchom ponownie z zadaniem" (the start carries the
// task). The "never started" badge needs 90 s without MCP, so the run takes about 2.5 minutes.
// Screenshots go to argv[2] (default: a temp dir). Usage: npm run build && node scripts/verify-team-stuck.mjs [shots]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import electron from 'electron';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';

if (process.platform !== 'win32') { console.log('skip: Windows only (PowerShell and the claude.cmd stand-in)'); process.exit(0); }
if (!existsSync(join(process.cwd(), 'out/main/index.js'))) throw new Error('Build first: npm run build');
const root = mkdtempSync(join(tmpdir(), 'unimux-team-stuck-'));
const shots = resolve(process.argv[2] ?? join(root, 'shots'));
const data = join(root, 'data'), agents = join(root, 'fake-agents'), project = join(root, 'project'), starts = join(root, 'starts');
for (const dir of [data, agents, project, shots, starts]) mkdirSync(dir, { recursive: true });
const LEAD = 'team-lead', WEB = 'team-web', API = 'team-api', QA = 'team-qa', DOCS = 'team-docs';
// The stand-in: --version answers; every start is recorded (cell, arguments); the API worker fails like a CLI with a bad
// option, the others wait like an interactive agent.
writeFileSync(join(agents, 'fake-claude.mjs'), [
  "import { writeFileSync } from 'node:fs';",
  "import { randomUUID } from 'node:crypto';",
  'const args = process.argv.slice(2);',
  "if (args[0] === '--version') { console.log('2.1.318 (Claude Code)'); process.exit(0); }",
  `writeFileSync(${JSON.stringify(starts)} + '/' + randomUUID() + '.txt', JSON.stringify({ cell: process.env.MC_CELL_ID, at: Date.now(), args }));`,
  "console.log('unimux-fake-claude-ready');",
  `if (process.env.MC_CELL_ID === ${JSON.stringify(API)}) setTimeout(() => { console.error('error: unknown option --bogus'); process.exit(1); }, 1000);`,
  'else setInterval(() => {}, 1 << 30);',
].join('\n'));
writeFileSync(join(agents, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${join(agents, 'fake-claude.mjs')}" %*\r\nexit /b %errorlevel%\r\n`);

const now = Date.now(), min = 60_000;
const task = (id, cellId, title, status, age, extra = {}) => ({ id, projectId: 'p', cellId, fromCellId: LEAD, title, prompt: `${title}.\nKeep the public API stable and add tests.`, status, delivery: 'native', createdAt: now - age * min, updatedAt: now - age * min, ...extra });
const tasks = [
  task('t-web', WEB, 'Orders page with filters', 'in_progress', 12, { createdAt: now - 20 * min }),
  task('t-api', API, 'Add the /orders endpoint', 'queued', 4, { delivery: 'pending' }),
  task('t-qa', QA, 'End-to-end checkout tests', 'queued', 6, { delivery: 'pending' }),
  task('t-qa2', QA, 'Regression run after the orders page', 'queued', 3, { delivery: 'pending' }),
  task('t-docs', DOCS, 'Document the orders API', 'queued', 9, { delivery: 'pending' }),
  task('t-done', WEB, 'Old dashboard tweaks', 'completed', 90, { result: { summary: 'Done.', files: [], tests: [] } }),
];
const cell = (id, name, role) => ({ id, name, profileId: 'claude', role });
const area = (col, row) => ({ col, row, colSpan: 1, rowSpan: 1 });
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Shop', path: project, color: '#3b82f6', activeTabId: 'g',
    tabs: [{ id: 'g', name: 'Orders team', layout: { cols: 2, rows: 2, areas: [area(0, 0), area(1, 0), area(0, 1), area(1, 1)] },
      cells: [cell(LEAD, 'Lead', 'coordinator'), cell(WEB, 'Web', 'worker'), cell(API, 'API', 'worker'), cell(QA, 'QA', 'worker')] }],
    archive: [{ id: 'g-old', name: 'Docs team', closedAt: now - 30 * min, layout: { cols: 1, rows: 1, areas: [area(0, 0)] }, cells: [cell(DOCS, 'Docs', 'worker')] }],
  }],
  profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  automation: { paused: false, tasks, messages: [], events: [] },
  snippets: [], presets: [], settings: { language: process.env.TEAM_LANG ?? 'pl', fontSize: 13, notifications: false, shell: 'pwsh', lastProfileId: 'claude' },
  sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 228, snippetsWidth: 210,
}));

const home = scratchHome(root);
const freePort = () => new Promise((ok, fail) => { const p = createServer(); p.on('error', fail); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => ok(n)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(`ok   ${line}`);
const port = Number(process.env.MC_DEBUG_PORT ?? await freePort());
const sys = process.env.SystemRoot ?? 'C:\\Windows';
const env = { ...scrubAppEnv({ ...process.env }), ...home.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), MC_CLI_NO_REGISTRY: '1',
  PATH: [agents, join(sys, 'System32'), sys, join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(delimiter) };
delete env.Path;
const child = spawn(electron, ['.'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', exited = false;
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
child.once('exit', () => { exited = true; });
const until = async (fn, label, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; if (exited) throw new Error(`App exited during ${label}: ${output.slice(-2000)}`); await sleep(200); }
  throw new Error(`Timeout waiting for ${label}`);
};
const startsOf = (cellId) => readdirSync(starts).map((f) => JSON.parse(readFileSync(join(starts, f), 'utf8'))).filter((s) => s.cell === cellId).sort((a, b) => a.at - b.at);
const clients = [];
let socket;
try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { return null; } }, 'debugger');
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
    await sleep(300);
    const { data: png } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(png, 'base64'));
    console.log(`     screenshot ${join(shots, `${name}.png`)}`);
  };
  const click = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  const clickText = (selector, text) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  const text = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`);
  const snapshot = () => evaluate('window.mc.loadSnapshot().then((s) => s.state.automation)');

  await until(() => evaluate('Boolean(window.mc && document.querySelector(".cell"))'), 'renderer boot');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  const info = await until(async () => { const i = await evaluate('window.mc.getMcpInfo()'); return i.running && i; }, 'MCP server');
  const configFile = (cellId) => join(data, 'mcp', `${cellId}.json`);
  await until(() => [LEAD, WEB].every((id) => existsSync(configFile(id))), 'MCP configs of the lead and the web worker');
  const tokenOf = (cellId) => /^Bearer ([0-9a-f]{64})$/.exec(JSON.parse(readFileSync(configFile(cellId), 'utf8')).mcpServers.unimux.headers.Authorization)[1];
  for (const id of [LEAD, WEB]) {
    const client = new Client({ name: 'verify-team-stuck', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${tokenOf(id)}` } } }));
    await client.callTool({ name: 'read_inbox', arguments: {} });
    clients.push(client);
  }
  await until(async () => (await evaluate('window.mc.getMcpInfo()')).connectedCellIds?.includes(WEB), 'the web worker connected');

  assert.ok(await click('.team-toggle'), 'the team toggle in the title bar');
  await until(() => evaluate('Boolean(document.querySelector(".automation-panel"))'), 'team panel');
  // The API worker's CLI fails 1 s after its start; the archived Docs agent's task is stuck at once.
  await until(async () => (await text('.team-stuck-row')).some((t) => t.includes('API')), 'the banner names the API worker', 30000);
  const exitCode = await evaluate(`window.__mc?.terminals?.detail?.(${JSON.stringify(API)}) ?? null`);
  console.log(`     API terminal detail: ${JSON.stringify(exitCode)}`);
  const rows = await text('.team-task-row');
  assert.ok(rows.some((r) => r.includes('Orders page with filters') && /W trakcie od 12 min/.test(r)), `time in progress: ${rows.join(' | ')}`);
  assert.ok(rows.some((r) => r.includes('Add the /orders endpoint') && /W kolejce od 4 min/.test(r)), 'time queued');
  log('rows show how long a task is in its state');
  const tags = await text('.team-task-row .team-stuck-tag');
  assert.ok(tags.some((t) => t.startsWith('Agent zakończył działanie')), `ended badge: ${tags}`);
  assert.ok(tags.includes('Agent zamknięty'), 'closed badge');
  assert.ok(!(await text('.team-task-row')).find((r) => r.includes('Orders page'))?.includes('Agent'), 'the running web worker has no badge');
  log(`badges: ${tags.join(', ')}`);
  const head = await text('.team-stuck-title');
  console.log(`     banner: ${head[0]} | ${(await text('.team-stuck-row')).join(' | ')}`);
  await shot('10-stuck-banner');

  // The QA worker runs but never connects: after 90 s without MCP (plus up to one 30 s tick of the panel's clock).
  await until(async () => (await text('.team-stuck-row')).some((t) => t.includes('QA')), 'the never-started QA worker', 140000);
  const all = await text('.team-stuck-title');
  assert.equal(all[0], '4 zadania stoją: agent nie działa');
  log(`banner: ${all[0]}`);
  await shot('11-stuck-banner-all');
  assert.ok(await clickText('.team-task-row', 'End-to-end checkout tests'));
  await until(() => evaluate(`Boolean(document.querySelector('.team-stuck-callout'))`), 'the reason in the task detail');
  await shot('12-stuck-detail-never-started');
  assert.ok(await clickText('.team-task-row', 'Document the orders API'));
  await shot('13-stuck-detail-closed');
  assert.ok(await clickText('.automation-panel [role=tab]', 'Agenci'));
  const agentRuns = await text('.team-agent-run');
  console.log(`     agents: ${agentRuns.join(' | ')}`);
  assert.ok(agentRuns.some((t) => t === 'Nie wystartował'), 'never started on the agent row');
  assert.ok(agentRuns.some((t) => t.startsWith('Zakończony')), 'ended on the agent row');
  assert.ok(await evaluate(`Boolean(document.querySelector('.team-agent.stuck.ended .smark.error') && document.querySelector('.team-agent.stuck.never-started .smark.idle'))`), 'the error mark and the dashed ring');
  const apiTitle = await evaluate(`document.querySelector('.team-agent-run.ended')?.title`);
  console.log(`     ended agent tooltip: ${apiTitle}`);
  await shot('14-stuck-agents');
  assert.ok(await clickText('.automation-panel [role=tab]', 'Zadania'));

  // "Przydziel ponownie" of the archived agent's task: a new task for the chosen worker, the old one cancelled.
  // The picker offers a worker that runs first (Web; API and QA are stuck themselves).
  const picked = await evaluate(`[...document.querySelectorAll('.team-stuck-row')].find((r) => r.textContent.includes('Docs'))?.querySelector('.team-reassign-agent')?.textContent`);
  assert.ok(picked?.startsWith('Web'), `the picker offers the running worker: ${picked}`);
  assert.ok(await evaluate(`(() => { const row = [...document.querySelectorAll('.team-stuck-row')].find((r) => r.textContent.includes('Docs')); const b = [...row.querySelectorAll('button')].find((x) => x.textContent.includes('Przydziel ponownie')); b?.click(); return !!b; })()`));
  const moved = await until(async () => { const a = await snapshot(); return a.tasks.find((t) => t.title === 'Document the orders API' && t.cellId === WEB) && a.tasks.find((t) => t.id === 't-docs')?.status === 'cancelled' && a; }, 'reassigned to the web worker');
  assert.ok(moved);
  log('"Przydziel ponownie" gave the archived agent\'s task to the web worker and cancelled the old one');

  // "Uruchom ponownie z zadaniem" of the API worker: it starts again with its task.
  const before = startsOf(API).length;
  assert.ok(await evaluate(`(() => { const row = [...document.querySelectorAll('.team-stuck-row')].find((r) => r.textContent.includes('API')); const b = row?.querySelector('.btn.primary'); b?.click(); return !!b; })()`));
  const again = await until(() => startsOf(API).length > before && startsOf(API).at(-1), 'the API worker started again', 20000);
  assert.ok(again.args.some((a) => a.includes('[Unimux task t-api]')), `the start carries the task: ${JSON.stringify(again.args).slice(0, 200)}`);
  log(`"Uruchom ponownie z zadaniem" started the API worker again with its task: ${JSON.stringify(again.args).slice(0, 120)}`);
  await shot('15-after-fixes');
  console.log(`screenshots in ${shots}`);
} finally {
  await Promise.race([Promise.all(clients.map((c) => c.close().catch(() => undefined))), sleep(3000)]);
  try { socket?.close(); } catch { /* gone */ }
  if (!exited) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ } }
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  removeScratch(join(root, 'data'));
  removeScratch(join(root, 'home'));
}
