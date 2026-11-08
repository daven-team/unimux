// Real-app check (npm run build:check first) of the start card of agent cells (1.1.5, shared/startScreen.ts, CellStartCard.tsx):
// - while an agent starts its cell shows the card (provider mark, "Uruchamianie Claude…"), never the long launch line;
// - once the CLI drew its screen the card goes and neither the screen nor the scrollback holds the launch line;
// - a CLI that exits 1 at its start with an error line turns the card into an error card (the code, the error, the output,
//   Uruchom ponownie / Pokaż terminal / Kopiuj błąd); Pokaż terminal shows the terminal with the error;
// - a restart shows the card again, a click on the card gives the keyboard to the terminal, a detached window shows it too.
// Scratch data dir and home; stand-ins for `claude` and `codex` (Node behind .cmd files) that draw a banner after a delay and
// stay running, or (profile args --fail-now) print an error and exit 1. Screenshots: D:\Projekty\_shots\115-start-*.png.
// Usage: npm run build:check && node scripts/verify-start-screen.mjs   (START_SHELL=cmd for cmd.exe)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { isMainPage, requireBuild, spawnApp } from './real-app.mjs';

if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(0); }
requireBuild();
const SHELL = process.env.START_SHELL ?? 'pwsh';
const SHOTS = process.env.START_SHOTS ?? 'D:\\Projekty\\_shots';
const tag = SHELL === 'pwsh' ? '' : `-${SHELL}`;
mkdirSync(SHOTS, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'unimux-start-screen-'));
const data = join(root, 'data'), agents = join(root, 'fake-agents'), project = join(root, 'project'), starts = join(root, 'starts');
for (const dir of [data, agents, project, starts]) mkdirSync(dir, { recursive: true });
const fake = (name, version, banner) => [
  "import { writeFileSync } from 'node:fs';",
  "import { randomUUID } from 'node:crypto';",
  'const args = process.argv.slice(2);',
  `if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }`,
  `writeFileSync(${JSON.stringify(starts)} + '/' + randomUUID() + '.txt', ${JSON.stringify(name)} + ' ' + JSON.stringify(args));`,
  "if (args.includes('--fail-now')) {",
  "  console.error('Error: Invalid MCP configuration:');",
  "  console.error('MCP config file not found: C:\\\\nope\\\\mcp-config.json');",
  '  process.exit(1);',
  '}',
  `setTimeout(() => process.stdout.write(${JSON.stringify(banner)}), Number(process.env.FAKE_DELAY_MS ?? 2500));`,
  'setInterval(() => {}, 1 << 30);',
].join('\n');
const claudeBanner = '\x1b[38;5;174m╭───────────────────────────────────────╮\x1b[0m\r\n\x1b[38;5;174m│\x1b[0m ✻ Welcome to Claude Code (stand-in)    \x1b[38;5;174m│\x1b[0m\r\n\x1b[38;5;174m╰───────────────────────────────────────╯\x1b[0m\r\n\r\n> unimux-fake-claude-ready\r\n';
const codexBanner = '\x1b[1m>_ OpenAI Codex (stand-in)\x1b[0m\r\n\r\n  model: fake   directory: ~/project\r\n\r\n› unimux-fake-codex-ready\r\n';
writeFileSync(join(agents, 'fake-claude.mjs'), fake('claude', '2.1.318 (Claude Code)', claudeBanner));
writeFileSync(join(agents, 'fake-codex.mjs'), fake('codex', 'codex-cli 0.60.0', codexBanner));
for (const name of ['claude', 'codex']) writeFileSync(join(agents, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${join(agents, `fake-${name}.mjs`)}" %*\r\n`);
const area = (col) => ({ col, row: 0, colSpan: 1, rowSpan: 1 });
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Start', path: project, color: '#3b82f6', archive: [], activeTabId: 'g', tabs: [{
    id: 'g', name: 'Agents', layout: { cols: 3, rows: 1, areas: [area(0), area(1), area(2)] },
    cells: [{ id: 'ok', profileId: 'claude' }, { id: 'fail', profileId: 'claude-bad', role: 'worker' }, { id: 'cx', profileId: 'codex' }],
  }] }],
  profiles: [
    { id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' },
    { id: 'claude-bad', name: 'Claude', cli: 'claude', args: '--fail-now', color: '#d97757' },
    { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#e8e8e8' },
    { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' },
  ],
  automation: { paused: false, tasks: [], messages: [], events: [] },
  snippets: [], presets: [], settings: { language: 'pl', fontSize: 13, notifications: false, shell: SHELL, lastProfileId: 'claude', backgroundLoad: 'project' },
  sidebarCollapsed: false, snippetsOpen: false, sidebarWidth: 228, snippetsWidth: 210,
}));
const home = scratchHome(root);
const freePort = () => new Promise((ok) => { const p = createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => ok(n)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await freePort();
const sys = process.env.SystemRoot ?? 'C:\\Windows';
const env = { ...scrubAppEnv({ ...process.env }), ...home.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), MC_CLI_NO_REGISTRY: '1', FAKE_DELAY_MS: process.env.FAKE_DELAY_MS ?? '5000',
  PATH: [agents, join(sys, 'System32'), sys, join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(delimiter) };
delete env.Path;
const child = spawnApp({ cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
let failed = false;
const check = (ok, line) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${line}`); if (!ok) failed = true; };

/** A DevTools connection to the first page target `pick` accepts. */
async function connect(pick, ms = 30000) {
  const end = Date.now() + ms;
  let target;
  while (!target && Date.now() < end) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && pick(t)); } catch { /* starting */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error(`no page target\n${output.slice(-1500)}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  let n = 0; const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
  const cdp = (method, params = {}) => new Promise((ok, no) => { const id = ++n; pending.set(id, (m) => (m.error ? no(new Error(m.error.message)) : ok(m.result))); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.value; };
  const until = async (expression, label, wait = 30000, every = 100) => {
    const stop = Date.now() + wait;
    while (Date.now() < stop) { const v = await evaluate(expression).catch(() => null); if (v) return v; await sleep(every); }
    throw new Error(`Timeout waiting for ${label}`);
  };
  const shot = async (name) => { await sleep(250); /* the card's fade-in */ const { data: png } = await cdp('Page.captureScreenshot', { format: 'png' }); const file = join(SHOTS, name); writeFileSync(file, Buffer.from(png, 'base64')); console.log(`screenshot ${file}`); };
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 640, deviceScaleFactor: 1, mobile: false });
  return { socket, cdp, evaluate, until, shot, url: target.url };
}

// Page helpers (evaluated in the renderer).
const card = (id) => `document.querySelector('[data-cell-id=${JSON.stringify(id)}] .cell-start')`;
const bufferText = (id, viewOnly) => `(() => { const x = window.__mc.terminals.xterm(${JSON.stringify(id)}); if (!x) return null; const b = x.buffer.active; const out = []; const from = ${viewOnly ? 'b.baseY' : '0'}; const to = ${viewOnly ? 'b.baseY + x.rows' : 'b.length'}; for (let i = from; i < to; i++) { const l = b.getLine(i)?.translateToString(true); if (l) out.push(l); } return out.join('\\n'); })()`;
const LAUNCH = /Clear-Host|cls &|--session-id|finally \{|NonInteractive|tui\.notifications/;
let main, win;
try {
  main = await connect((t) => isMainPage(t));
  await main.until('Boolean(window.__mc && document.querySelector(".cell"))', 'renderer boot');

  // ── 1. starting: every agent cell shows its card, the launch line is not to be seen ──
  await main.until(`!!(${card('ok')} && ${card('cx')} && ${card('fail')})`, 'the start cards of all three cells', 20000, 50);
  const starting = await main.evaluate(`(() => { const c = ${card('ok')}; if (!c) return null; const r = c.getBoundingClientRect(); const body = c.closest('.cell').querySelector('.cell-body').getBoundingClientRect();
    return { text: c.innerText, ring: !!c.querySelector('.busy-ring'), mark: !!c.querySelector('.provider-icon'), covers: r.top <= body.top + 1 && r.bottom >= body.bottom - 1 && r.left <= body.left + 1 && r.right >= body.right - 1,
      codex: ${card('cx')}?.innerText ?? '' }; })()`);
  check(!!starting && starting.text.includes('Uruchamianie Claude') && starting.ring && starting.mark, `the Claude cell shows the start card with its mark and spinner: ${JSON.stringify(starting?.text)}`);
  check(!!starting?.covers, 'the card covers the whole terminal of the cell');
  check(!!starting && starting.codex.includes('Uruchamianie Codex'), `the Codex cell shows "Uruchamianie Codex…": ${JSON.stringify(starting?.codex)}`);
  await main.shot(`115-start-starting${tag}.png`);

  // ── 2. failed start: an error card with the CLI's error, the code and the output ──
  const failText = await main.until(`${card('fail')}?.classList.contains('failed') && ${card('fail')}.innerText`, 'the error card of the failing cell', 20000);
  check(failText.includes('Nie udało się uruchomić Claude') && failText.includes('MCP config file not found'), `the error card names the failure and shows the error line: ${JSON.stringify(failText)}`);
  check(SHELL === 'cmd' ? failText.includes('CLI zakończył działanie') : failText.includes('kod wyjścia 1'), 'the error card shows how the CLI ended (its exit code where the shell reports one)');
  check(['Uruchom ponownie', 'Pokaż terminal', 'Kopiuj błąd', 'Ostatnie polecenia / wyjście'].every((t) => failText.includes(t)), 'the error card offers Uruchom ponownie, Pokaż terminal, Kopiuj błąd and the recent output');
  check(!LAUNCH.test(failText), 'the error card holds no part of the launch line');

  // ── 3. up: the cards of the running agents go, their screens show the CLI and no launch line ──
  await main.until(`!${card('ok')} && !${card('cx')}`, 'the start cards going once the agents drew', 20000);
  const okView = await main.evaluate(bufferText('ok', true)), okAll = await main.evaluate(bufferText('ok', false)), cxAll = await main.evaluate(bufferText('cx', false));
  check(okView.includes('unimux-fake-claude-ready') && !LAUNCH.test(okView), `the Claude cell shows the agent, not the launch line: ${JSON.stringify(okView.slice(0, 300))}`);
  check(!LAUNCH.test(okAll) && !LAUNCH.test(cxAll), 'the scrollback holds no launch line either (Claude and Codex)');
  check(cxAll.includes('unimux-fake-codex-ready'), 'the Codex cell shows the agent');
  await main.evaluate(`document.querySelector('[data-cell-id="fail"] .cell-start-toggle')?.click()`);
  await sleep(300);
  const tail = await main.evaluate(`document.querySelector('[data-cell-id="fail"] .cell-start-tail')?.innerText ?? ''`);
  check(tail.includes('Invalid MCP configuration') && !LAUNCH.test(tail), `the recent output opens with the CLI's lines: ${JSON.stringify(tail)}`);
  await main.shot(`115-start-up-and-failed${tag}.png`);

  // ── 4. Pokaż terminal: the raw terminal with the error ──
  await main.evaluate(`[...document.querySelectorAll('[data-cell-id="fail"] .cell-start button')].find((b) => b.textContent === 'Pokaż terminal').click()`);
  await main.until(`!${card('fail')}`, 'the error card going on Pokaż terminal', 3000);
  const failAll = await main.evaluate(bufferText('fail', false));
  check(failAll.includes('MCP config file not found') && !LAUNCH.test(failAll), `the terminal shows the error and no launch line: ${JSON.stringify(failAll.slice(0, 300))}`);
  await main.shot(`115-start-failed-terminal${tag}.png`);

  // ── 5. restarts show the card again; a click on the card gives the keyboard to the terminal ──
  await main.evaluate(`window.__mc.actions.restartCell('ok', 'new')`);
  await main.until(`!!${card('ok')}`, 'the start card after a restart', 5000, 30);
  const box = await main.evaluate(`(() => { const r = ${card('ok')}.getBoundingClientRect(); return { x: r.left + 20, y: r.bottom - 20 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await main.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  const focusedTerm = await main.evaluate(`(() => { const a = document.activeElement; return !!a && a.classList.contains('xterm-helper-textarea') && !!a.closest('[data-cell-id="ok"]'); })()`);
  check(focusedTerm, 'a click on the start card focuses the terminal under it (typing reaches the CLI)');
  check(await main.evaluate(`!!${card('ok')}`), 'the card stays after the click until the agent is up');
  await main.shot(`115-start-restart${tag}.png`);
  await main.until(`!${card('ok')}`, 'the card going after the restarted agent drew', 20000);
  const okAfter = await main.evaluate(bufferText('ok', false));
  check(okAfter.includes('unimux-fake-claude-ready') && !LAUNCH.test(okAfter), 'after the restart the terminal shows the agent only');
  // The error card's own restart (a role cell: the restart that carries its tasks) starts it again: it fails again.
  const before = readdirSync(starts).length;
  await main.evaluate(`document.querySelector('[data-cell-id="fail"] .cell-head .restart').click()`);
  await sleep(200);
  const menu = await main.evaluate(`(() => { const i = [...document.querySelectorAll('.menu-item')].find((e) => /Nowa rozmowa|Uruchom ponownie/.test(e.textContent)); i?.click(); return !!i; })()`);
  if (!menu) console.log('(restart ran without a menu)');
  await main.until(`${card('fail')}?.classList.contains('failed')`, 'the error card after the restart of the failing cell', 20000);
  await main.evaluate(`[...document.querySelectorAll('[data-cell-id="fail"] .cell-start button')].find((b) => b.textContent === 'Uruchom ponownie').click()`);
  await sleep(500);
  await main.until(`${card('fail')}?.classList.contains('failed')`, 'the error card again after its own Uruchom ponownie', 20000);
  check(readdirSync(starts).length >= before + 2, `both restarts started the CLI again: ${readdirSync(starts).length - before} starts`);

  // ── 6. a detached window: its cells show the card too ──
  const moved = await main.evaluate(`window.__mc.detach.detachKey('grid:g', 'menu')`);
  check(moved === true, 'the grid moved to its own window');
  win = await connect((t) => t.url.includes('detached='));
  await win.until('Boolean(window.__mc && document.querySelector("[data-cell-id=ok] .cell-body"))', 'the detached window with the cells');
  await sleep(1500);
  await win.evaluate(`window.__mc.actions.restartCell('ok', 'new')`);
  const detachedCard = await win.until(`${card('ok')}?.innerText`, 'the start card in the detached window', 5000, 30);
  check(detachedCard.includes('Uruchamianie Claude'), `the detached window shows the start card: ${JSON.stringify(detachedCard)}`);
  await win.shot(`115-start-detached${tag}.png`);
  await win.until(`!${card('ok')}`, 'the card going in the detached window', 20000);
  const detachedText = await win.evaluate(bufferText('ok', false));
  check(detachedText.includes('unimux-fake-claude-ready') && !LAUNCH.test(detachedText), 'the detached cell shows the agent and no launch line');
} catch (error) {
  failed = true;
  console.error(error);
  await main?.shot(`115-start-error${tag}.png`).catch(() => undefined);
} finally {
  for (const page of [win, main]) { try { page?.socket.close(); } catch { /* closed */ } }
  spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
  await sleep(2000);
  removeScratch(root);
}
process.exit(failed ? 1 : 0);
