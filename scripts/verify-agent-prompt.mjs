// Real-app check of "Wyślij prompt do wielu agentów" (1.1.1; npm run build first). A scratch data dir and home, MC_OFFSCREEN=1 and
// MC_DEBUG_PORT (default 9419). Scripted stand-ins for `claude` and `codex` (no model, no network) post the status hooks a real
// Claude Code would and log every byte they receive: in the grid "Agenci" one Claude cell finished its turn, one is fresh, one
// works (a turn that never ends), one asks for a Bash permission, plus a Codex cell and a shell cell; the grid "Recenzja" (one
// finished Claude cell) is moved to its own window. The checks: the shortcut opens the dialog with the agents of the active grid,
// "Agenci wszystkich gridów" adds the detached cell, the states and planned actions per row, a multi-line prompt sent with
// Ctrl+Enter reaches exactly the idle agents (the detached one too) as one paste plus Enter, the toast summary, then a second
// send with "add to the queue" lands in the busy cells' prompt queues, and the grid tab's menu entry. Screenshots go to argv[2].
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import electron from 'electron';
import { removeScratch, scrubAppEnv } from './app-env.mjs';
import { killTree, sleep } from './ssh-ui-lib.mjs';

const checkout = process.cwd();
if (!existsSync(join(checkout, 'out/main/index.js'))) throw new Error('Build first: npm run build');
const port = Number(process.env.MC_DEBUG_PORT ?? 9419);
const root = mkdtempSync(join(tmpdir(), 'unimux-agentprompt-'));
const shots = resolve(process.argv[2] ?? join(root, 'shots'));
const home = join(root, 'home'), data = join(root, 'data'), project = join(root, 'atlas'), bin = join(home, '.local', 'bin'), logs = join(root, 'logs');
for (const dir of [data, project, bin, shots, logs, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true });

// ── scripted agents ──────────────────────────────────────────────────────────
const ids = { done: 'a-done', fresh: 'a-fresh', busy: 'a-busy', perm: 'a-perm', codex: 'a-codex', shell: 'a-shell', side: 'a-side' };
const sid = (n) => `00000000-0000-4000-8000-00000000010${n}`;
const sessions = { done: sid(1), fresh: sid(2), busy: sid(3), perm: sid(4), side: sid(5) };
const screens = {
  [sessions.done]: { name: 'done', title: 'Done: the catalog filter is in place.', hooks: [['prompt', {}], ['stop', {}]] },
  [sessions.fresh]: { name: 'fresh', title: 'Claude Code (fresh)', hooks: [] },
  [sessions.busy]: { name: 'busy', title: 'Refactoring the importer...', hooks: [['prompt', {}], ['pre', { tool_name: 'Edit', tool_use_id: 'toolu_b1', tool_input: {} }]] },
  [sessions.perm]: { name: 'perm', title: 'Bash(rm -rf build)  Do you want to run this command?', hooks: [['prompt', {}], ['permission', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }]] },
  [sessions.side]: { name: 'side', title: 'Review finished.', hooks: [['prompt', {}], ['stop', {}]] },
};
writeFileSync(join(bin, 'demo-sessions.json'), JSON.stringify(screens));
writeFileSync(join(bin, 'demo-agent.mjs'), `import { appendFileSync, readFileSync } from 'node:fs';
const [cli, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log(cli === 'codex' ? 'codex-cli 0.50.0' : '2.1.120 (Claude Code)'); process.exit(0); }
const screens = JSON.parse(readFileSync(new URL('./demo-sessions.json', import.meta.url), 'utf8'));
const after = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const id = after('--resume') ?? after('--session-id');
const screen = cli === 'codex' ? { name: 'codex', title: 'OpenAI Codex (demo)', hooks: [] } : screens[id] ?? { name: 'other', title: 'claude (demo)', hooks: [] };
const log = ${JSON.stringify(logs)} + '/' + screen.name + '.log';
// Bracketed paste on, like Claude Code and Codex: a multi-line paste arrives as one block.
process.stdout.write('\\u001b[?2004h\\u001b[2J\\u001b[H' + screen.title + '\\r\\n> ');
const settingsAt = args.indexOf('--settings');
const hooks = settingsAt >= 0 ? JSON.parse(readFileSync(args[settingsAt + 1].replace(/^["']|["']$/g, ''), 'utf8')).hooks ?? {} : {};
const names = { prompt: 'UserPromptSubmit', pre: 'PreToolUse', permission: 'PermissionRequest', stop: 'Stop' };
const post = async (list) => {
  for (const [event, body] of list) {
    const hook = hooks[names[event]]?.[0]?.hooks?.[0];
    const url = hook?.url ?? hook?.args?.find((a) => /^http/.test(a));
    if (url) await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(hook.headers ?? {}) }, body: JSON.stringify({ hook_event_name: names[event], session_id: id, ...body }) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
  }
};
setTimeout(() => void post(screen.hooks), 1500);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (d) => {
  appendFileSync(log, d);
  buffer += d;
  // Enter outside a paste block submits: a turn starts and ends (an idle agent answers).
  const outside = buffer.replace(/\\u001b\\[200~[\\s\\S]*?\\u001b\\[201~/g, '');
  if (/\\r|\\u001b\\[13;/.test(outside) && !/\\u001b\\[200~(?![\\s\\S]*\\u001b\\[201~)/.test(buffer)) {
    buffer = '';
    process.stdout.write('\\r\\n(answer)\\r\\n> ');
    void post([['prompt', {}], ['stop', {}]]);
  }
});
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`);
for (const cli of ['claude', 'codex']) {
  if (process.platform === 'win32') writeFileSync(join(bin, `${cli}.cmd`), `@"${process.execPath}" "%~dp0demo-agent.mjs" ${cli} %*\r\n`);
  else { writeFileSync(join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/demo-agent.mjs" ${cli} "$@"\n`); chmodSync(join(bin, cli), 0o755); }
}

const area = (col, row) => ({ col, row, colSpan: 1, rowSpan: 1 });
const claudeCell = (key, name) => ({ id: ids[key], profileId: 'claude', name, session: { cli: 'claude', id: sessions[key], confirmed: true } });
const tabA = 'tab-agents', tabB = 'tab-review';
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p-atlas',
  profiles: [
    { id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#d97757' },
    { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#e8e8e8' },
    { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' },
  ],
  projects: [{ id: 'p-atlas', name: 'Atlas', path: project, color: '#3b82f6', archive: [], activeTabId: tabA, tabs: [
    { id: tabA, name: 'Agenci', layout: { cols: 3, rows: 2, areas: [area(0, 0), area(1, 0), area(2, 0), area(0, 1), area(1, 1), area(2, 1)] },
      cells: [claudeCell('done', 'Katalog'), claudeCell('fresh', 'Nowy'), claudeCell('busy', 'Importer'), claudeCell('perm', 'Porządki'),
        { id: ids.codex, profileId: 'codex', name: 'Codex API' }, { id: ids.shell, profileId: 'shell', name: 'Konsola' }] },
    { id: tabB, name: 'Recenzja', layout: { cols: 1, rows: 1, areas: [area(0, 0)] }, cells: [claudeCell('side', 'Recenzent')] },
  ] }],
  settings: { language: 'pl', shell: process.platform === 'win32' ? 'cmd' : 'bash', backgroundLoad: 'all', lastProfileId: 'claude', alerts: { enabled: false } },
}));

const env = { ...process.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), CODEX_HOME: join(home, '.codex') };
scrubAppEnv(env);
env.CODEX_HOME = join(home, '.codex');
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`;
const child = spawn(electron, ['.'], { cwd: checkout, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log = (log + d).slice(-6000); });
child.stderr.on('data', (d) => { log = (log + d).slice(-6000); });

const results = [];
const check = (ok, label, detail = '') => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`); };

async function connect(match) {
  let target;
  for (let i = 0; i < 200 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && match(t.url)); } catch { /* starting */ }
  }
  if (!target) throw new Error(`page did not appear\n${log}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const cdp = (method, params = {}) => new Promise((r, j) => { const id = ++next; pending.set(id, (m) => (m.error ? j(new Error(m.error.message)) : r(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, label, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evaluate(expression).catch(() => false)) return true; await sleep(150); }
    check(false, `timeout: ${label}`);
    return false;
  };
  const shot = async (name) => {
    await sleep(400);
    const { data: png } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(png, 'base64'));
    console.log(`     screenshot ${join(shots, `${name}.png`)}`);
  };
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { ws, cdp, evaluate, until, shot };
}

const store = 'window.__mc.useStore.getState()';
const rows = `[...document.querySelectorAll('.agent-prompt-row')].map((r) => ({ name: r.querySelector('.agent-prompt-name')?.textContent, place: r.querySelector('.agent-prompt-place')?.textContent, state: r.querySelector('.agent-prompt-state')?.textContent, action: r.querySelector('.agent-prompt-action')?.textContent, on: r.querySelector('input').checked }))`;
const readLog = (name) => { try { return readFileSync(join(logs, `${name}.log`), 'utf8'); } catch { return ''; } };
const mod = process.platform === 'darwin' ? 4 : 2; // Cmd / Ctrl
const key = async (app, k, code, vk, modifiers) => { for (const type of ['rawKeyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, modifiers, key: k, code, windowsVirtualKeyCode: vk }); };
const setText = (app, text) => app.evaluate(`(() => { const t = document.querySelector('.agent-prompt-text'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); return true; })()`);
const clickButton = (app, label) => app.evaluate(`(() => { const b = [...document.querySelectorAll('.agent-prompt button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return !!b; })()`);

const PROMPT = 'Sprawdź testy w swoim folderze.\nNapisz krótko, co poprawiłeś.';
let main, side;
try {
  main = await connect((url) => url.includes('index.html') && !url.includes('detached='));
  await main.cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
  await main.until(`!!window.__mc && document.querySelectorAll('.cell').length === 6`, 'the Agenci grid');
  await main.until(`(() => { const u = ${store}.ui; return u.statuses['${ids.done}'] === 'waiting' && u.statuses['${ids.busy}'] === 'working' && u.statusDetails['${ids.perm}']?.kind === 'permission'; })()`, 'scripted turns settled', 40000);

  // "Recenzja" goes to its own window: its agent is a target too, served by that window.
  await main.evaluate(`window.__mc.detach.detachKey('grid:${tabB}', 'menu')`);
  side = await connect((url) => url.includes('detached='));
  await side.cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 560, deviceScaleFactor: 1, mobile: false });
  await side.until(`document.querySelectorAll('.cell').length === 1 && window.__mc.useStore.getState().ui.statuses['${ids.side}'] === 'waiting'`, 'the detached agent finished its turn', 30000);
  await main.until(`!!window.__mc.terminals.has('${ids.codex}') && !window.__mc.terminals.has('${ids.side}')`, 'terminals in place');

  // The shortcut (Ctrl+Shift+U) opens the dialog with the agents of the active grid checked.
  await main.evaluate(`document.activeElement?.blur(); true`);
  await key(main, 'U', 'KeyU', 85, mod | 8);
  await main.until(`!!document.querySelector('.agent-prompt')`, 'the dialog opens from the shortcut') && check(true, 'Ctrl+Shift+U opens "Wyślij prompt do wielu agentów"');
  await main.until(`${rows}.length === 6`, 'six agent rows (the shell cell is no target)');
  let list = await main.evaluate(rows);
  check(list.length === 6 && !list.some((r) => r.name === 'Konsola'), 'lists the five agents of Agenci and the detached one, not the shell cell', JSON.stringify(list.map((r) => r.name)));
  check(list.filter((r) => r.on).map((r) => r.name).join() === 'Katalog,Nowy,Importer,Porządki,Codex API', 'the active grid\'s agents are checked first', JSON.stringify(list.filter((r) => r.on).map((r) => r.name)));
  await clickButton(main, 'Agenci wszystkich gridów');
  await setText(main, PROMPT);
  await main.until(`(() => { const r = ${rows}; const by = Object.fromEntries(r.map((x) => [x.name, x])); return by.Katalog?.state === 'wolny' && by.Importer?.state === 'pracuje' && by['Porządki']?.state === 'czeka na zgodę' && by.Recenzent?.state === 'wolny' && by.Nowy?.state === 'wolny' && by['Codex API']?.state === 'wolny'; })()`, 'probed states');
  list = await main.evaluate(rows);
  console.log(list);
  const by = Object.fromEntries(list.map((r) => [r.name, r]));
  check(by.Recenzent?.place.includes('osobne okno') && by.Recenzent?.on, 'the detached cell is listed, checked and marked "osobne okno"', JSON.stringify(by.Recenzent));
  check(by.Katalog?.place === 'Agenci · Atlas', 'grid and project per row', by.Katalog?.place);

  // With "add to the queue" off, the busy ones are skipped.
  const queueBox = `document.querySelector('.agent-prompt-options input')`;
  if (await main.evaluate(`${queueBox}.checked`)) await main.evaluate(`${queueBox}.click()`);
  await main.until(`document.querySelector('.agent-prompt-plan').textContent.includes('Teraz: 4 · do kolejki: 0 · pominięte: 2')`, 'plan without the queue');
  list = await main.evaluate(rows);
  check(list.find((r) => r.name === 'Importer')?.action === 'pominie' && list.find((r) => r.name === 'Katalog')?.action === 'wyśle teraz', 'per-row planned action');
  await main.shot('01-dialog-skip-busy');
  await main.evaluate(`${queueBox}.click()`);
  await main.until(`document.querySelector('.agent-prompt-plan').textContent.includes('Teraz: 4 · do kolejki: 2 · pominięte: 0')`, 'plan with the queue');
  await main.shot('02-dialog-queue-busy');
  await main.evaluate(`${queueBox}.click()`);

  // Ctrl+Enter sends: idle agents get it now, the busy ones are skipped.
  await main.evaluate(`document.querySelector('.agent-prompt-text').focus(); true`);
  await key(main, 'Enter', 'Enter', 13, mod);
  await main.until(`!document.querySelector('.agent-prompt') && !!${store}.ui.toast`, 'sent and closed');
  const toast1 = await main.evaluate(`${store}.ui.toast?.text`);
  check(/^Wysłano do 4, w kolejce 0, pominięto 2: /.test(toast1 ?? '') && toast1.includes('Importer (pracuje)') && toast1.includes('Porządki (czeka na zgodę)'), 'toast summary with the skipped cells and why', toast1);
  await main.shot('03-toast');
  await sleep(2500);
  const line1 = 'Sprawdź testy w swoim folderze.', line2 = 'Napisz krótko, co poprawiłeś.';
  for (const name of ['done', 'fresh', 'codex', 'side']) {
    const got = readLog(name);
    const paste = /\u001b\[200~([\s\S]*?)\u001b\[201~/.exec(got);
    check(!!paste && paste[1].includes(line1) && paste[1].includes(line2), `${name}: the multi-line prompt arrived as one bracketed paste`, JSON.stringify(got.slice(0, 200)));
    check(/\u001b\[201~[\s\S]*(\r|\u001b\[13;)/.test(got), `${name}: Enter after the paste`, JSON.stringify(got.slice(-80)));
  }
  for (const name of ['busy', 'perm']) check(!readLog(name).includes(line1), `${name}: a busy agent got nothing`);
  // The idle agents started a turn (their stand-ins answer, posting UserPromptSubmit and Stop).
  await side.until(`${store}.ui.statuses['${ids.side}'] === 'waiting'`, 'detached agent answered');
  await side.shot('04-detached-window');
  await main.shot('05-grid-after-send');

  // Second round from the grid tab's menu: only the busy ones checked, "add to the queue" on.
  await main.evaluate(`(() => { const t = document.querySelector('.grid-tab[data-project-id="p-atlas"]'); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 })); return true; })()`);
  await main.until(`[...document.querySelectorAll('.ctx-menu button, .context-menu button, [role=menuitem]')].some((b) => b.textContent.includes('Wyślij prompt do agentów tego gridu'))`, 'tab menu entry');
  await main.shot('06-tab-menu');
  await main.evaluate(`[...document.querySelectorAll('.ctx-menu button, .context-menu button, [role=menuitem]')].find((b) => b.textContent.includes('Wyślij prompt do agentów tego gridu')).click()`);
  await main.until(`${rows}.length === 6`, 'dialog from the tab menu') && check(true, 'the grid tab menu opens the dialog');
  await clickButton(main, 'Odznacz wszystkie');
  await main.evaluate(`(() => { for (const r of document.querySelectorAll('.agent-prompt-row')) { const n = r.querySelector('.agent-prompt-name').textContent; if (n === 'Importer' || n === 'Porządki') r.querySelector('input').click(); } return true; })()`);
  if (!await main.evaluate(`${queueBox}.checked`)) await main.evaluate(`${queueBox}.click()`);
  await setText(main, 'Potem: uruchom lint.');
  await main.until(`document.querySelector('.agent-prompt-plan').textContent.includes('Teraz: 0 · do kolejki: 2 · pominięte: 0')`, 'plan: two to the queue');
  await main.shot('07-dialog-queue');
  await clickButton(main, 'Wyślij teraz do wolnych, resztę dodaj do kolejki');
  await main.until(`!document.querySelector('.agent-prompt') && /w kolejce 2/.test(${store}.ui.toast?.text ?? '')`, 'queued');
  check(await main.evaluate(`${store}.ui.toast?.text`) === 'Wysłano do 0, w kolejce 2, pominięto 0', 'toast: queued 2');
  const queues = await main.evaluate(`(() => { const s = ${store}.s; const q = (id) => s.projects[0].tabs[0].cells.find((c) => c.id === id).promptQueue?.items.map((i) => i.text); return { busy: q('${ids.busy}'), perm: q('${ids.perm}') }; })()`);
  check(queues.busy?.[0] === 'Potem: uruchom lint.' && queues.perm?.[0] === 'Potem: uruchom lint.', 'the prompt waits in both busy cells\' queues', JSON.stringify(queues));
  await main.shot('08-queued');
} catch (error) {
  check(false, String(error?.stack ?? error));
} finally {
  try { main?.ws.close(); side?.ws.close(); } catch { /* closed */ }
  killTree(child.pid);
  await sleep(1500);
  if (!process.argv[2]) console.log(`screenshots in ${shots}`);
  removeScratch(join(root, 'home'));
  removeScratch(data);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
