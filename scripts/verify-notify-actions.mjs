// Real-app check of 1.0.9 "actions in notifications" and "taskbar / Dock state" (npm run build first). No real Claude runs: a
// shell cell whose profile is switched to "claude" after it started runs a fake permission dialog (a node script that draws
// Claude Code's dialog and records the keys it receives), and the PermissionRequest hook is faked from the main process
// inspector. The OS notification is not shown: Notification.show is replaced there, so the test can see the buttons and press
// them (emitting the 'action' event Electron emits for a button). setOverlayIcon / setProgressBar are recorded.
// Checks: the permission notification carries Allow / Deny / Show and Allow types Enter into the cell; a second (stale) press
// types nothing and only shows the cell; Deny types Esc; no buttons once the setting is off; the overlay badge (with all
// scale factors) and the indeterminate progress follow the statuses; a muted cell does not count; the attention flash is asked.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, mainInspector, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';

const cellId = randomUUID();
const otherId = randomUUID();
const tabs = { main: randomUUID(), other: randomUUID() };
const layout = (n) => ({ cols: n, rows: 1, areas: Array.from({ length: n }, (_, i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) });

function state(project) {
  const projectId = randomUUID();
  return {
    version: 1, settings: { language: 'en' }, activeProjectId: projectId,
    profiles: [{ id: 'fake', name: 'Fake agent', cli: 'shell', args: '', color: '#8b5cf6' }, { id: 'plain', name: 'Plain shell', cli: 'shell', args: '', color: '#888888' }],
    projects: [{ id: projectId, name: 'Project X', path: project, color: '#3b82f6', archive: [], activeTabId: tabs.main, tabs: [
      { id: tabs.main, name: 'Main', layout: layout(2), cells: [{ id: cellId, profileId: 'fake', name: 'Reviewer' }, { id: otherId, profileId: 'fake', name: 'Muted one', muted: true }] },
      { id: tabs.other, name: 'Other', layout: layout(1), cells: [{ id: randomUUID(), profileId: 'plain' }] },
    ] }],
  };
}

const FAKE = `const fs = require('fs');
const out = process.argv[2];
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H Bash command\\r\\n   rm -rf build\\r\\n Do you want to proceed?\\r\\n \\u276f 1. Yes\\r\\n   2. Yes, and don\\'t ask again for rm commands\\r\\n   3. No, and tell Claude what to do differently (esc)\\r\\n');
draw();
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => { fs.appendFileSync(out, d.toString('hex') + '\\n'); if (d.toString('hex') === '71') process.exit(0); draw(); });
`;

const root = scratchRoot('notifyactions');
const inspectPort = 9300 + Math.floor(Math.random() * 500);
let app;
let main;
const results = [];
const ok = (name) => { results.push(name); console.log(`OK ${name}`); };
try {
  const project = join(root, 'project');
  writeState(root, state(project));
  const keysFile = join(root, 'keys.txt');
  writeFileSync(join(root, 'fake.js'), FAKE);
  writeFileSync(join(root, 'run.cmd'), `@"${process.execPath}" "${join(root, 'fake.js')}" "${keysFile}"\r\n`);
  app = await launchApp(root, {}, [`--inspect=${inspectPort}`]);
  main = await mainInspector(inspectPort);
  await main.evaluate(`(() => {
    globalThis.__shown = []; globalThis.__taskbar = []; globalThis.__flash = 0; globalThis.__focus = [];
    __el.Notification.prototype.show = function () { __shown.push(this); };
    const proto = __el.BrowserWindow.prototype;
    const overlay = proto.setOverlayIcon;
    proto.setOverlayIcon = function (image, description) {
      __taskbar.push({ overlay: image ? { size: image.getSize(), scales: image.getScaleFactors(), empty: image.isEmpty() } : null, description });
      return overlay.call(this, image, description);
    };
    const progress = proto.setProgressBar;
    proto.setProgressBar = function (value, options) { __taskbar.push({ progress: value, mode: options?.mode }); return progress.call(this, value, options); };
    __el.ipcMain.on('attention:flash', () => { __flash++; });
    __el.ipcMain.on('notify:show', (_e, id) => { __focus.push(id); });
    return true;
  })()`);
  const tabEl = (name) => `[...document.querySelectorAll('.tab.grid-tab')].find((t) => t.querySelector('.label')?.textContent === ${JSON.stringify(name)})`;
  const selectTab = (name) => app.evaluate(`(${tabEl(name)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })), true`);
  const hook = (event, info) => main.evaluate(`__el.BrowserWindow.getAllWindows()[0].webContents.send('cell:hook', ${JSON.stringify(cellId)}, ${JSON.stringify(event)}${info ? `, ${JSON.stringify(info)}` : ''}), true`);
  const shown = () => main.evaluate(`__shown.map((n) => ({ title: n.title, body: n.body, actions: n.actions.map((a) => a.text) }))`);
  const press = (index) => main.evaluate(`(() => { const n = __shown[__shown.length - 1]; n.emit('action', { actionIndex: ${index} }, ${index}); return true; })()`);
  const cellDebug = `(() => { const e = window.__mc.terminals.entries.get(${JSON.stringify(cellId)}); const b = e.term.buffer.active; const rows = []; for (let y = 0; y < e.term.rows; y++) rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? ''); const t = e.tracker; return { agent: e.agent, remote: e.remote, codex: e.codex, win32: e.win32, status: t.status, reason: t.lastReason, detail: t.detail, hooked: t.isHooked, rows: rows.filter(Boolean) }; })()`;
  const keys = () => (existsSync(keysFile) ? readFileSync(keysFile, 'utf8').trim().split('\n').filter(Boolean) : []);
  // The taskbar calls so far; checks look at the last call of each kind (what the taskbar button shows now).
  const taskbarLog = () => main.evaluate('__taskbar.slice()');
  const last = (log, key) => [...log].reverse().find((e) => key in e);

  await app.until(`document.querySelectorAll('.xterm').length >= 2`, 'terminals');
  await sleep(2500); // the shells start
  // The profile becomes an agent profile (the running shells stay shells), then the grid is shown again (the cells re-read it).
  await app.click('.tb-btn[aria-label="Settings"]');
  await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent === 'Agents')`, 'settings page');
  await app.click('.settings-nav [role=tab]', 'Agents');
  await app.until(`!!document.querySelector('#settings-profile-cli-fake')`, 'profile card');
  await app.click('#settings-profile-cli-fake');
  await app.click('[role=option]', 'claude');
  await sleep(300);
  await selectTab('Other');
  await sleep(400);
  await selectTab('Main');
  await sleep(800);
  // The fake dialog runs in the cell.
  await app.evaluate(`window.__mc.terminals.paste(${JSON.stringify(cellId)}, ${JSON.stringify(join(root, 'run.cmd'))}, true, { focus: false }), true`);
  const screenHas = (text) => `(() => { const e = window.__mc.terminals.entries.get(${JSON.stringify(cellId)}); const b = e.term.buffer.active; for (let y = 0; y < e.term.rows; y++) if ((b.getLine(b.baseY + y)?.translateToString(true) ?? '').includes(${JSON.stringify(text)})) return true; return false; })()`;
  await app.until(screenHas('1. Yes'), 'fake dialog on screen', 15000);
  await sleep(500);

  // 1. Working: the taskbar button shows an indeterminate progress.
  await hook('prompt');
  await sleep(700);
  let log = await taskbarLog();
  if (last(log, 'progress')?.progress !== 2 || last(log, 'progress')?.mode !== 'indeterminate') throw new Error(`no indeterminate progress: ${JSON.stringify(log)}`);
  ok('a working agent sets an indeterminate taskbar progress');

  // 2. PermissionRequest: notification with Allow / Deny / Show, overlay badge "1" with every scale, progress off, flash asked.
  await hook('notify', { need: 'permission', immediate: true, tool: 'Bash' });
  await sleep(2000);
  let notes = await shown();
  if (notes.length !== 1 || JSON.stringify(notes[0].actions) !== JSON.stringify(['Allow', 'Deny', 'Show']) || notes[0].body !== 'Reviewer needs you') throw new Error(`notification: ${JSON.stringify(notes)} cell: ${JSON.stringify(await app.evaluate(cellDebug))}`);
  ok(`the permission notification offers ${notes[0].actions.join(' / ')}`);
  log = await taskbarLog();
  const overlay = last(log, 'overlay');
  if (!overlay?.overlay || overlay.overlay.empty || JSON.stringify(overlay.overlay.size) !== JSON.stringify({ width: 16, height: 16 }) || overlay.overlay.scales.length !== 4 || overlay.description !== 'Agents waiting for you: 1') throw new Error(`overlay: ${JSON.stringify(log)}`);
  if (last(log, 'progress')?.progress !== -1) throw new Error(`progress not cleared: ${JSON.stringify(log)}`);
  ok(`overlay badge: 16x16 with scales ${overlay.overlay.scales.join(', ')}, "${overlay.description}"; progress cleared`);
  if ((await main.evaluate('__flash')) < 1) throw new Error('no attention flash asked');
  ok('the attention flash is asked for an unfocused window');

  // 3. Allow types Enter into the dialog.
  await press(0);
  await sleep(1200);
  let got = keys();
  if (JSON.stringify(got) !== JSON.stringify(['0d'])) throw new Error(`keys after Allow: ${JSON.stringify(got)}`);
  ok('Allow typed Enter into the cell');

  // 4. The same button again is stale (the answer was a keystroke): nothing typed, the cell is shown.
  await press(0);
  await sleep(1200);
  got = keys();
  if (got.length !== 1) throw new Error(`a stale Allow typed: ${JSON.stringify(got)}`);
  if (JSON.stringify(await main.evaluate('__focus.splice(0)')) !== JSON.stringify([cellId])) throw new Error('a stale Allow did not show the cell');
  ok('a stale Allow types nothing and only shows the cell');

  // 5. A new permission request (after the tool ran), Deny types Esc.
  await hook('busy', { tool: 'Bash', toolUseId: 'toolu_1', toolEnd: true });
  await sleep(300);
  await hook('notify', { need: 'permission', immediate: true, tool: 'Bash' });
  await sleep(2000);
  notes = await shown();
  if (notes.length !== 2 || notes[1].actions.length !== 3) throw new Error(`second notification: ${JSON.stringify(notes)}`);
  await press(1);
  await sleep(1200);
  got = keys();
  if (JSON.stringify(got) !== JSON.stringify(['0d', '1b'])) throw new Error(`keys after Deny: ${JSON.stringify(got)}`);
  ok('Deny typed Esc into the cell');

  // 6. A question that is not a permission dialog gets only Show; Show types nothing.
  await hook('busy', { tool: 'Bash', toolUseId: 'toolu_2', toolEnd: true });
  await sleep(300);
  await hook('notify', { need: 'question', immediate: true, tool: 'AskUserQuestion', toolUseId: 'toolu_3' });
  await sleep(2000);
  notes = await shown();
  if (notes.length !== 3 || JSON.stringify(notes[2].actions) !== JSON.stringify(['Show'])) throw new Error(`question notification: ${JSON.stringify(notes)}`);
  await press(0);
  await sleep(800);
  if (keys().length !== 2) throw new Error('Show typed something');
  ok('a question gets only Show, which types nothing');

  // 7. The muted cell never counts; with the cell answered the badge goes.
  await main.evaluate(`__el.BrowserWindow.getAllWindows()[0].webContents.send('cell:hook', ${JSON.stringify(otherId)}, 'notify', { need: 'permission', immediate: true, tool: 'Bash' }), true`);
  await hook('busy', { tool: 'AskUserQuestion', toolUseId: 'toolu_3', toolEnd: true });
  await sleep(1200);
  log = await taskbarLog();
  if (last(log, 'overlay')?.overlay !== null) throw new Error(`badge not cleared (muted cell counted?): ${JSON.stringify(log)}`);
  ok('the badge clears when only a muted cell waits');

  // 8. The setting off: no buttons at all.
  await app.click('.tb-btn[aria-label="Settings"]');
  await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent.includes('Notifications'))`, 'settings nav');
  await app.click('.settings-nav [role=tab]', 'Notifications');
  await app.until(`!!document.querySelector('#settings-alert-actions')`, 'actions switch');
  if (!(await app.evaluate(`document.querySelector('#settings-alert-actions').checked && document.querySelector('#settings-taskbar-badge').checked && document.querySelector('#settings-taskbar-progress').checked && document.querySelector('#settings-alert-flash').checked`))) throw new Error('new switches not on by default');
  await app.click('#settings-alert-actions');
  await sleep(300);
  await selectTab('Main');
  await sleep(300);
  await hook('notify', { need: 'permission', immediate: true, tool: 'Bash' });
  await sleep(2000);
  notes = await shown();
  if (notes.length !== 4 || notes[3].actions.length !== 0) throw new Error(`notification with the setting off: ${JSON.stringify(notes)}`);
  ok('with the setting off the notification has no buttons');
  console.log(`ALL OK (${results.length})`);
} finally {
  main?.close();
  if (app) await app.close();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
