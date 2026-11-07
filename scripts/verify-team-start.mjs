// Real-app check (npm run build:check first; MC_APP_TARGET=electron: npm run build): workers a coordinator creates with create_grid start in the background with their
// task, exactly once, and showing their grid later does not start them again without it. Scratch data dir and home, a
// stand-in `claude` that records every start (its arguments, with the prompt when one came along) and stays running.
// Shell: Windows PowerShell (the `pwsh` kind without PowerShell 7 installed), so the prompt goes through Get-Content.
// Usage: npm run build && node scripts/verify-team-start.mjs   (and TEAM_SHELL=cmd for the order of the arguments)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { isMainPage, requireBuild, spawnApp } from './real-app.mjs';

if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(0); }
requireBuild();
const root = mkdtempSync(join(tmpdir(), 'unimux-team-start-'));
const data = join(root, 'data'), agents = join(root, 'fake-agents'), project = join(root, 'project');
for (const dir of [data, agents, project]) mkdirSync(dir, { recursive: true });
writeFileSync(join(root, 'burst.txt'), `\x1b[38;5;208m${'x'.repeat(150)}\x1b[0m\r\n`.repeat(Number(process.env.TEAM_BURST_LINES ?? 20000)));
const starts = join(root, 'starts');
mkdirSync(starts);
// The stand-in: --version answers; otherwise one line per start, then it waits like an interactive agent.
// A Node stand-in behind claude.cmd: it gets the arguments exactly as the shell passed them (a multi-line prompt included),
// records them in a file of its own (parallel starts never share one), prints a burst like a real first screen and waits.
writeFileSync(join(agents, 'fake-claude.mjs'), [
  "import { writeFileSync, readFileSync } from 'node:fs';",
  "import { randomUUID } from 'node:crypto';",
  "const args = process.argv.slice(2);",
  "if (args[0] === '--version') { console.log('2.1.318 (Claude Code)'); process.exit(0); }",
  `process.stdout.write(readFileSync(${JSON.stringify(join(root, 'burst.txt'))}, 'utf8'));`,
  `writeFileSync(${JSON.stringify(starts)} + '/' + randomUUID() + '.txt', 'START ' + JSON.stringify(args));`,
  // 1.1.4: a worker whose CLI ends at once (exit code 1), as the variadic --mcp-config made real workers do.
  "if (args.some((a) => a.includes('EXIT_NOW'))) process.exit(1);",
  "console.log('unimux-fake-claude-ready');",
  'setInterval(() => {}, 1 << 30);',
].join('\n'));
writeFileSync(join(agents, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${join(agents, 'fake-claude.mjs')}" %*\r\n`);
const LEAD = 'lead';
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Bot', path: project, color: '#3b82f6', archive: [], activeTabId: 'g', tabs: [{
    id: 'g', name: 'DAILY', layout: { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] },
    // A worker whose first start never got going (its session exists but was never confirmed) and still holds its task: the
    // next start resumes nothing, so it must start a new conversation with the task (1.1.3).
    cells: [{ id: LEAD, name: 'refactoring', profileId: 'claude', role: 'coordinator' },
      { id: 'pending', name: 'Pending worker', profileId: 'claude', role: 'worker', session: { cli: 'claude', id: '11111111-2222-4333-8444-555555555555' }, startupPrompt: '[Unimux task seeded] Seeded task' }],
  }] }],
  profiles: [{ id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  automation: { paused: false, tasks: [], messages: [], events: [] },
  snippets: [], presets: [], settings: { language: 'pl', fontSize: 13, notifications: false, shell: process.env.TEAM_SHELL ?? 'pwsh', lastProfileId: 'claude', backgroundLoad: 'project', delegation: { mode: 'auto', maxAgents: 20 } },
  sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 228, snippetsWidth: 210,
}));
const home = scratchHome(root);
const freePort = () => new Promise((ok) => { const p = createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => ok(n)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await freePort();
const sys = process.env.SystemRoot ?? 'C:\\Windows';
const env = { ...scrubAppEnv({ ...process.env }), ...home.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), MC_CLI_NO_REGISTRY: '1',
  PATH: [agents, join(sys, 'System32'), sys, join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(delimiter) };
delete env.Path;
const child = spawnApp({ cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
const until = async (fn, label, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error(`Timeout waiting for ${label}\n${output.slice(-1500)}`);
};
const startLines = () => readdirSync(starts).map((f) => ({ f, t: statSync(join(starts, f)).mtimeMs })).sort((a, b) => a.t - b.t)
  .map(({ f }) => readFileSync(join(starts, f), 'utf8').trim()).filter(Boolean);
let socket, client, failed = false;
const check = (ok, line) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${line}`); if (!ok) failed = true; };
try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(isMainPage); } catch { return null; } }, 'debugger');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  let n = 0; const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); pending.delete(m.id); });
  const evaluate = (expression) => new Promise((ok) => { const id = ++n; pending.set(id, (r) => ok(r?.result?.value)); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  await until(() => evaluate('Boolean(window.mc && document.querySelector(".cell"))'), 'renderer boot');
  const info = await until(async () => { const i = await evaluate('window.mc.getMcpInfo()'); return i?.running && i; }, 'MCP server');
  const config = join(data, 'mcp', `${LEAD}.json`);
  const screen = (id) => evaluate(`(() => { const x = window.__mc.terminals.xterm?.(${JSON.stringify(id)}); if (!x) return null; const b = x.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i)?.translateToString(true); if (l) out.push(l); } return out.join('\n').slice(-1500); })()`);
  await until(() => existsSync(config), 'the coordinator MCP config').catch(async (e) => { console.log(`coordinator screen: ${await screen(LEAD)}`); console.log(`page: ${await evaluate('document.body.innerText.slice(0, 2500)')}`); throw e; });
  await until(() => startLines().some((l) => l.includes(LEAD)), 'the coordinator start');
  const seeded = await until(() => startLines().find((l) => l.includes('11111111-2222-4333-8444-555555555555')), 'the pending worker start');
  check(seeded.includes('Seeded task') && seeded.includes('--session-id'), `a worker with an unconfirmed session starts a new conversation with its task: ${seeded.slice(0, 120)}`);
  const token = /^Bearer (\S+)$/.exec(JSON.parse(readFileSync(config, 'utf8')).mcpServers.unimux.headers.Authorization)[1];
  client = new Client({ name: 'verify-team-start', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const prompt = (m) => `Przeczytaj C:\\brief.md i wykonaj go dla {MODUL}=${m} (moduł \`${m.toLowerCase()}\`), grupy \`/warns clear|info|list\`. "Tylko" odczyt; $env:X & 100%.`;
  const created = JSON.parse((await client.callTool({ name: 'create_grid', arguments: { name: 'Paczka', cells: ['Moderacja', 'Tickety', 'Automod', 'Zaproszenia'].map((m) => ({ profileId: 'claude', role: 'worker', name: `Rozpoznanie ${m}`, prompt: prompt(m) })) } })).content[0].text);
  console.log(`create_grid: ${created.cellIds.length} cells`);
  const waited = client.callTool({ name: 'wait_for', arguments: { taskIds: Object.values(created.tasks), timeoutSec: 25 } }).then((r) => r.content[0].text);
  // Background start: time without opening the grid.
  await sleep(20000);
  let lines = startLines().filter((l) => !l.includes(`${LEAD}.json`) && !l.includes('11111111-2222'));
  check(lines.length === 4, `the 4 workers started in the background: ${lines.length} starts`);
  check(lines.length > 0 && lines.every((l) => l.includes('Unimux task')), `every start carried its task: ${lines.map((l) => l.slice(0, 140)).join(' | ')}`);
  // The task is the first argument, whole, and --mcp-config gets only its file (Claude Code reads every word after it up to the next option).
  // Through PowerShell the multi-line task reaches the .cmd stand-in cut at its first line break (cmd's batch argument
  // parsing; the real claude.exe gets it whole), so the argument order is checked with TEAM_SHELL=cmd.
  const argv = lines.map((l) => JSON.parse(l.slice('START '.length)));
  if (process.env.TEAM_SHELL === 'cmd') check(argv.length > 0 && argv.every((a) => a[0].startsWith('[Unimux task') && a[0].includes('Tylko') && a[a.indexOf('--mcp-config') + 1].endsWith('.json') && (a[a.indexOf('--mcp-config') + 2] ?? '--').startsWith('--')),
    'the task is the first argument and --mcp-config is followed by its file only');
  console.log(`wait_for: ${await waited}`);
  // Show the grid: nothing starts again.
  const shown = await evaluate(`(() => { const b = [...document.querySelectorAll('[role=tab], .grid-tab, .tab-item')].find((e) => e.textContent.includes('Paczka')); b?.click(); return !!b; })()`);
  console.log(`grid tab clicked: ${shown}`);
  await sleep(6000);
  lines = startLines().filter((l) => !l.includes(`${LEAD}.json`) && !l.includes('11111111-2222'));
  check(lines.length === 4, `showing the grid did not start the workers again: ${lines.length} starts`);
  // 1.1.4: the coordinator got its delegation rules as system instructions (default mode "Sam, gdy się opłaca").
  const leadStarts = () => startLines().filter((l) => l.includes(`${LEAD}.json`));
  check(leadStarts()[0]?.includes('--append-system-prompt') && leadStarts()[0].includes('create_grid'), `the coordinator starts with --append-system-prompt: ${leadStarts()[0]?.slice(0, 200)}`);
  const leadArgv = JSON.parse(leadStarts()[0].slice('START '.length));
  const rulesArg = leadArgv[leadArgv.indexOf('--append-system-prompt') + 1] ?? '';
  check(rulesArg.startsWith('unimux delegation rules') && rulesArg.endsWith('wait_for.'), `the rules reach the CLI as one whole argument: ${rulesArg.slice(0, 80)}...${rulesArg.slice(-30)}`);
  // 1.1.4: a worker whose CLI ends at once is "exited" for the team: wait_for hears it long before its timeout.
  const crash = JSON.parse((await client.callTool({ name: 'create_grid', arguments: { name: 'Crash', cells: [{ profileId: 'claude', role: 'worker', name: 'EXIT_NOW worker', prompt: 'Crash test task' }] } })).content[0].text);
  const crashId = crash.cellIds[0], crashTask = crash.tasks[crashId];
  const t0 = Date.now();
  const crashWait = JSON.parse((await client.callTool({ name: 'wait_for', arguments: { taskIds: [crashTask], timeoutSec: 40 } })).content[0].text);
  const waitedMs = Date.now() - t0;
  check(crashWait.event === 'exited' && waitedMs < 30000, `wait_for reports the crashed worker as exited after ${waitedMs} ms: ${JSON.stringify(crashWait).slice(0, 200)}`);
  const agentsText = (await client.callTool({ name: 'list_agents', arguments: {} })).content[0].text;
  const findRow = (v) => Array.isArray(v) ? v.map(findRow).find(Boolean) : v && typeof v === 'object' ? (Object.values(v).includes(crashId) ? v : Object.values(v).map(findRow).find(Boolean)) : undefined;
  const crashRow = JSON.stringify(findRow(JSON.parse(agentsText)) ?? agentsText);
  check(crashRow.includes('exited') && !crashRow.includes('unknown'), `list_agents shows it exited: ${crashRow.slice(0, 200)}`);
  // Restarting it (the user's restart: resume, downgraded to a new conversation as it never started) carries its task again.
  await evaluate(`window.__mc.actions.restartCell(${JSON.stringify(crashId)}, 'resume')`);
  const crashStarts = () => startLines().filter((l) => l.includes('EXIT_NOW'));
  await until(() => crashStarts().length >= 2, 'the restart of the crashed worker');
  check(crashStarts().every((l) => l.includes(`[Unimux task ${crashTask}]`)), `the restarted worker got its task again: ${crashStarts().map((l) => l.slice(0, 120)).join(' | ')}`);
  // "Tylko na prośbę": the next start of the coordinator has no delegation rules.
  await evaluate(`window.__mc.useStore.getState().update((s) => ({ ...s, settings: { ...s.settings, delegation: { mode: 'ask', maxAgents: 4 } } }))`);
  const before = leadStarts().length;
  await evaluate(`window.__mc.actions.restartCell(${JSON.stringify(LEAD)}, 'new')`);
  await until(() => leadStarts().length > before, 'the coordinator restart');
  check(!leadStarts().at(-1).includes('--append-system-prompt'), `in "Tylko na prośbę" the coordinator starts without --append-system-prompt: ${leadStarts().at(-1).slice(0, 200)}`);
  const left = existsSync(join(data, 'prompts')) ? readdirSync(join(data, 'prompts')) : [];
  console.log(`prompt files left: ${left.length}`);
  console.log(`terminal text of a worker: ${JSON.stringify(await evaluate(`(() => { const t = window.__mc.terminals; const id = ${JSON.stringify(created.cellIds[0])}; const x = t.xterm?.(id); if (!x) return null; const b = x.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i)?.translateToString(true); if (l) out.push(l); } return out.join('\\n').slice(-1500); })()`))}`);
} finally {
  try { await client?.close(); } catch { /* closed */ }
  try { socket?.close(); } catch { /* closed */ }
  spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
  await sleep(2000);
  removeScratch(root);
}
process.exit(failed ? 1 : 0);
