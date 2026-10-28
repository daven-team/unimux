// Real-app check of "Czeka na Ciebie" (1.0.9; npm run build first). A scratch data dir and home, MC_OFFSCREEN=1 and
// MC_DEBUG_PORT (default 9418). Scripted stand-ins for `claude` (no model, no network) post the status hooks a real Claude Code
// would: in the grid "Agenci" one cell asks for a Bash permission, one asks a question (AskUserQuestion), one finishes its turn;
// in the grid "Recenzja" one turn fails on a rate limit and a muted cell finishes. The checks: the list (order, texts, the
// badge without the muted cell), "w osobnym oknie" after "Recenzja" moves to its own window, a new permission in that window
// reaching the main window's list, a click on a finished turn (it is read and leaves the list), the next / previous
// shortcut (also into the detached window), the palette and "Ukryj wyciszone". Screenshots go to argv[2] (default: a temp dir).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import electron from 'electron';
import { removeScratch, scrubAppEnv } from './app-env.mjs';
import { killTree, sleep } from './ssh-ui-lib.mjs';

const checkout = process.cwd();
if (!existsSync(join(checkout, 'out/main/index.js'))) throw new Error('Build first: npm run build');
const port = Number(process.env.MC_DEBUG_PORT ?? 9418);
const root = mkdtempSync(join(tmpdir(), 'unimux-waiting-'));
const shots = resolve(process.argv[2] ?? join(root, 'shots'));
const home = join(root, 'home'), data = join(root, 'data'), project = join(root, 'atlas'), bin = join(home, '.local', 'bin');
for (const dir of [data, project, bin, shots, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true });

// ── scripted claude ──────────────────────────────────────────────────────────
const ids = { perm: 'w-perm', ask: 'w-ask', done: 'w-done', shell: 'w-shell', fail: 'w-fail', quiet: 'w-quiet' };
const sid = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const sessions = { perm: sid(1), ask: sid(2), done: sid(3), fail: sid(4), quiet: sid(5) };
const screens = {
  [sessions.perm]: { title: 'Bash(rm -rf build)  Do you want to run this command?', hooks: [['prompt', {}], ['permission', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }]] },
  [sessions.ask]: { title: 'Which database should the tests use?', hooks: [['prompt', {}], ['pre', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_ask1', tool_input: {} }]] },
  [sessions.done]: { title: 'Done: the catalog filter is in place.', hooks: [['prompt', {}], ['stop', {}]] },
  [sessions.fail]: { title: 'API Error: rate limit', hooks: [['prompt', {}], ['fail', { error: 'rate_limit' }]] },
  [sessions.quiet]: { title: 'Review finished.', hooks: [['prompt', {}], ['stop', {}]], later: [['prompt', {}], ['permission', { tool_name: 'Edit', tool_input: { file_path: 'src/a.mjs' } }]] },
};
writeFileSync(join(bin, 'demo-sessions.json'), JSON.stringify(screens));
writeFileSync(join(bin, 'demo-agent.mjs'), `import { readFileSync } from 'node:fs';
const [cli, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.120 (Claude Code)'); process.exit(0); }
const screens = JSON.parse(readFileSync(new URL('./demo-sessions.json', import.meta.url), 'utf8'));
const after = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const id = after('--resume') ?? after('--session-id');
const screen = screens[id] ?? { title: 'claude (demo)', hooks: [] };
process.stdout.write('\\u001b[2J\\u001b[H' + screen.title + '\\r\\n');
const settingsAt = args.indexOf('--settings');
const hooks = settingsAt >= 0 ? JSON.parse(readFileSync(args[settingsAt + 1].replace(/^["']|["']$/g, ''), 'utf8')).hooks ?? {} : {};
const names = { prompt: 'UserPromptSubmit', pre: 'PreToolUse', permission: 'PermissionRequest', stop: 'Stop', fail: 'StopFailure' };
const post = async (list) => {
  for (const [event, body] of list) {
    const hook = hooks[names[event]]?.[0]?.hooks?.[0];
    const url = hook?.url ?? hook?.args?.find((a) => /^http/.test(a));
    if (url) await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(hook.headers ?? {}) }, body: JSON.stringify({ hook_event_name: names[event], session_id: id, ...body }) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
  }
};
setTimeout(() => void post(screen.hooks), 1500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { if (/again/.test(d) && screen.later) { process.stdout.write('again\\r\\n'); void post(screen.later); } });
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`);
if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0demo-agent.mjs" claude %*\r\n`);
else { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/demo-agent.mjs" claude "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }

const area = (col, row) => ({ col, row, colSpan: 1, rowSpan: 1 });
const claudeCell = (key, name, extra = {}) => ({ id: ids[key], profileId: 'claude', name, session: { cli: 'claude', id: sessions[key], confirmed: true }, ...extra });
const tabA = 'tab-agents', tabB = 'tab-review';
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p-atlas',
  profiles: [{ id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#d97757' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  projects: [{ id: 'p-atlas', name: 'Atlas', path: project, color: '#3b82f6', archive: [], activeTabId: tabA, tabs: [
    { id: tabA, name: 'Agenci', layout: { cols: 2, rows: 2, areas: [area(0, 0), area(1, 0), area(0, 1), area(1, 1)] },
      cells: [claudeCell('perm', 'Porządki'), claudeCell('ask', 'Testy'), claudeCell('done', 'Katalog'), { id: ids.shell, profileId: 'shell', name: 'Konsola' }] },
    { id: tabB, name: 'Recenzja', layout: { cols: 2, rows: 1, areas: [area(0, 0), area(1, 0)] },
      cells: [claudeCell('fail', 'Recenzent'), claudeCell('quiet', 'Dokumentacja', { muted: true })] },
  ] }],
  settings: { language: 'pl', shell: process.platform === 'win32' ? 'cmd' : 'bash', backgroundLoad: 'all', lastProfileId: 'claude', alerts: { enabled: false }, sidePanels: { waiting: true } },
}));

const env = { ...process.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
scrubAppEnv(env);
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`;
const child = spawn(electron, ['.'], { cwd: checkout, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log = (log + d).slice(-6000); });
child.stderr.on('data', (d) => { log = (log + d).slice(-6000); });

const results = [];
const check = (ok, label, detail = '') => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`); };

/** One CDP connection to a page of the app. */
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
    await sleep(500);
    const { data: png } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(png, 'base64'));
    console.log(`     screenshot ${join(shots, `${name}.png`)}`);
  };
  // The page believes it has the focus (offscreen windows never get it): seen / unseen works as with a person at the screen.
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { ws, cdp, evaluate, until, shot };
}

const store = 'window.__mc.useStore.getState()';
const rows = `[...document.querySelectorAll('.waiting-row')].map((r) => ({ cell: r.dataset.cell, name: r.querySelector('.waiting-name')?.textContent, what: r.querySelector('.waiting-what')?.textContent, place: r.querySelector('.waiting-place')?.textContent, age: r.querySelector('.waiting-age')?.textContent, muted: r.classList.contains('muted') }))`;
const pressStep = (app, dir) => (async () => {
  const k = dir > 0 ? { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 } : { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 };
  const modifiers = process.platform === 'darwin' ? 1 | 4 : 1 | 2; // Alt + Ctrl (Cmd on macOS)
  for (const type of ['rawKeyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, modifiers, ...k });
})();

let main, side;
try {
  main = await connect((url) => url.includes('index.html') && !url.includes('detached='));
  await main.cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
  await main.until(`!!window.__mc && document.querySelectorAll('.cell').length === 4`, 'the Agenci grid');
  await main.until(`(() => { const w = ${store}.ui.waits; return ['${ids.perm}', '${ids.ask}', '${ids.done}', '${ids.fail}', '${ids.quiet}'].every((id) => w[id]); })()`, 'all five cells wait', 40000);

  // The panel from the rail; the badge counts four (the muted cell is not counted).
  await main.evaluate(`document.querySelector('#waiting-view').click()`);
  await main.until(`document.querySelectorAll('.waiting-row').length === 5`, 'five rows');
  const list = await main.evaluate(rows);
  console.log(list);
  const byCell = Object.fromEntries(list.map((r) => [r.cell, r]));
  check(await main.evaluate(`document.querySelector('#waiting-view .rail-badge')?.textContent`) === '4', 'the rail badge counts 4 (muted cell left out)');
  check(byCell[ids.perm]?.what === 'czeka na zgodę: Bash', 'permission with its tool', byCell[ids.perm]?.what);
  check(byCell[ids.ask]?.what === 'pyta Cię o coś', 'AskUserQuestion is a question', byCell[ids.ask]?.what);
  check(byCell[ids.done]?.what === 'skończył, nieprzeczytane', 'a finished turn not seen yet', byCell[ids.done]?.what);
  check(/limit/i.test(byCell[ids.fail]?.what ?? ''), 'a rate limit', byCell[ids.fail]?.what);
  check(byCell[ids.quiet]?.muted === true, 'the muted cell is listed and marked');
  check(byCell[ids.fail]?.place === 'Recenzja · Atlas' && byCell[ids.perm]?.place === 'Agenci · Atlas', 'grid and project of each row', `${byCell[ids.fail]?.place} / ${byCell[ids.perm]?.place}`);
  check(list.every((r) => r.age === 'teraz'), 'fresh waits say "teraz"');
  const sinces = await main.evaluate(`[...document.querySelectorAll('.waiting-row')].map((r) => ${store}.ui.waits[r.dataset.cell].since)`);
  check(sinces.every((t, i) => i === 0 || sinces[i - 1] <= t), 'longest waiting first', JSON.stringify(sinces));
  await main.shot('01-waiting-panel');

  // A click on the finished turn shows the cell and reads it: it leaves the list.
  const cells = async (app = main) => (await app.evaluate(rows)).map((r) => r.cell);
  /** What "next" / "previous" from `from` must reach: the following (preceding) cell of `order` that is listed in `now`. */
  const neighbour = (order, now, from, dir) => {
    const k = order.indexOf(from);
    for (let j = k + dir; j >= 0 && j < order.length; j += dir) if (now.includes(order[j])) return order[j];
    return dir > 0 ? now[0] : now[now.length - 1];
  };
  const beforeClick = await cells();
  await main.evaluate(`document.querySelector('.waiting-row[data-cell="${ids.done}"]').click()`);
  await main.until(`${store}.ui.focusedCellId === '${ids.done}' && !document.querySelector('.waiting-row[data-cell="${ids.done}"]')`, 'the read turn leaves the list');
  check(await main.evaluate(`!!document.querySelector('.cell[data-cell-id="${ids.done}"].wait-flash')`), 'the card flashes');
  await main.shot('02-after-click');

  // Next / previous from the keyboard: the read cell left the list but keeps its place, so "next" goes on from there.
  const first = neighbour(beforeClick, await cells(), ids.done, 1);
  await pressStep(main, 1);
  await main.until(`${store}.ui.focusedCellId === '${first}'`, `next goes on from the read cell's place (${first})`, 5000) && check(true, 'next waiting cell (Ctrl+Alt+PageDown) goes on from the place of the read cell');
  // From a question (it never leaves the list by being seen) to the following cell and back.
  await main.evaluate(`window.__mc.actions.focusCell('${ids.perm}')`);
  await main.until(`${store}.ui.focusedCellId === '${ids.perm}'`, 'focus on the permission cell', 3000);
  const fromPerm = await cells();
  const second = neighbour(fromPerm, fromPerm, ids.perm, 1);
  await pressStep(main, 1);
  await main.until(`${store}.ui.focusedCellId === '${second}'`, `next goes on (${second})`, 5000) && check(true, 'next goes from the focused cell to the following one');
  // The cell just reached may have been read (an error, a finished turn) and left the list: "previous" still goes back.
  await pressStep(main, -1);
  await main.until(`${store}.ui.focusedCellId === '${ids.perm}'`, 'previous goes back', 5000) && check(true, 'previous waiting cell goes back');

  // "Recenzja" moves to its own window: its rows stay and say so.
  await main.evaluate(`window.__mc.detach.detachKey('grid:${tabB}', 'menu')`);
  side = await connect((url) => url.includes('detached='));
  await side.cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 600, deviceScaleFactor: 1, mobile: false });
  await side.until(`document.querySelectorAll('.cell').length === 2`, 'the detached grid');
  // A new permission in the detached window reaches the main window's list.
  await side.until(`!!window.__mc.terminals.has('${ids.quiet}')`, 'detached terminal');
  await side.evaluate(`window.__mc.terminals.paste('${ids.quiet}', 'again', true)`);
  await main.until(`(() => { const r = ${rows}.find((x) => x.cell === '${ids.quiet}'); return r?.what === 'czeka na zgodę: Edit'; })()`, 'the detached permission reaches the main list', 20000)
    && check(true, 'a permission asked in the detached window shows in the main list');
  // The keyboard steps above may have read both cells of this grid (a failed turn and a finished one leave the list once seen);
  // the permission just asked keeps one listed for sure.
  const marked = await main.until(`(() => { const r = ${rows}.filter((x) => x.place?.startsWith('Recenzja')); return r.length > 0 && r.every((x) => x.place.includes('w osobnym oknie')); })()`, 'detached rows marked "w osobnym oknie"');
  if (marked) check(true, 'rows of the detached grid are kept and marked "w osobnym oknie"');
  else console.log(await main.evaluate(rows));
  await main.shot('03-detached-rows');
  await side.shot('04-detached-window');

  // The step goes into the detached window: it focuses the cell there.
  const all = await cells();
  const detachedCells = new Set([ids.fail, ids.quiet]);
  const target = all.find((id) => detachedCells.has(id) && !detachedCells.has(all[(all.indexOf(id) - 1 + all.length) % all.length]));
  const before = all[(all.indexOf(target) - 1 + all.length) % all.length];
  await main.evaluate(`window.__mc.actions.focusCell('${before}')`);
  await main.until(`${store}.ui.focusedCellId === '${before}'`, 'focus before the detached cell', 3000);
  await pressStep(main, 1);
  await side.until(`${store}.ui.focusedCellId === '${target}'`, `next goes into the detached window (${target})`, 8000) && check(true, 'next waiting cell focuses a cell of the detached window');
  // From the detached window the shortcut asks the main window, which goes on from the cell it showed last.
  const expected = neighbour(all, all.filter((id) => id !== target), target, 1);
  await pressStep(side, 1);
  const where = detachedCells.has(expected) ? side : main;
  await where.until(`${store}.ui.focusedCellId === '${expected}'`, `next from the detached window goes to ${expected}`, 8000)
    && check(true, 'the shortcut pressed in the detached window goes on to the next waiting cell');

  // The palette lists the waiting cells first.
  await main.evaluate(`${store}.setUi({ palette: true })`);
  await main.until(`!!document.querySelector('.palette-item')`, 'palette');
  const palette = await main.evaluate(`[...document.querySelectorAll('.palette-item')].slice(0, 6).map((i) => i.querySelector('.kind').textContent + '|' + i.querySelector('.ptitle').textContent)`);
  check(palette[0]?.startsWith('Czeka na Ciebie|'), 'the palette starts with the waiting cells', JSON.stringify(palette));
  await main.shot('05-palette');
  await main.evaluate(`${store}.setUi({ palette: false })`);

  // "Ukryj wyciszone": the muted cell goes from the list.
  await main.evaluate(`document.querySelector('.waiting-filter input').click()`);
  await main.until(`!document.querySelector('.waiting-row[data-cell="${ids.quiet}"]')`, 'muted row hidden') && check(true, '"Ukryj wyciszone" hides the muted cell');
  await main.shot('06-hide-muted');
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
