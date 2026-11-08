// Real-app check of 1.0.9 "actions in notifications" and "taskbar / Dock state" (npm run build:check first). No real Claude runs: a
// shell cell whose profile is switched to "claude" after it started runs a fake permission dialog (a node script that draws
// Claude Code's dialog and records the keys it receives), and the PermissionRequest hook is faked from the main process
// inspector. The OS notification is not shown: Notification.show is replaced there, so the test can see the buttons and press
// them (emitting the 'action' event Electron emits for a button). setOverlayIcon / setProgressBar are recorded.
// Checks: the permission notification carries Allow / Deny / Show and Allow types Enter into the cell; a second (stale) press
// types nothing and only shows the cell; Deny types Esc; no buttons once the setting is off; no taskbar overlay badge (1.1.2) (was: with all
// scale factors) follows the statuses (no progress since 1.1.0); a muted cell does not count; the attention flash is asked.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';

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
  app = await launchApp(root, {}, [], { main: true });
  main = app.main;
  // OS notifications kept by the app (never shown), taskbar calls recorded, the attention flash recorded (not done),
  // notify:show (a toast button that shows the cell) recorded and run.
  await main.stubToasts();
  await main.stubTaskbar();
  await main.record(['attention:flash'], { swallow: true });
  await main.record(['notify:show']);
  const tabEl = (name) => `[...document.querySelectorAll('.tab.grid-tab')].find((t) => t.querySelector('.label')?.textContent === ${JSON.stringify(name)})`;
  const selectTab = (name) => app.evaluate(`(${tabEl(name)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })), true`);
  const hook = (event, info) => main.hook(cellId, event, info);
  const shown = () => main.toasts();
  const press = (index) => main.toastAction(-1, index);
  const cellDebug = `(() => { const e = window.__mc.terminals.entries.get(${JSON.stringify(cellId)}); const b = e.term.buffer.active; const rows = []; for (let y = 0; y < e.term.rows; y++) rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? ''); const t = e.tracker; return { agent: e.agent, remote: e.remote, codex: e.codex, win32: e.win32, status: t.status, reason: t.lastReason, detail: t.detail, hooked: t.isHooked, rows: rows.filter(Boolean) }; })()`;
  const keys = () => (existsSync(keysFile) ? readFileSync(keysFile, 'utf8').trim().split('\n').filter(Boolean) : []);
  // The taskbar calls so far; checks look at the last call of each kind (what the taskbar button shows now).
  const taskbarLog = () => main.taskbar();
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

  // 1. Working: the taskbar button shows no progress (1.1.0 dropped it).
  await hook('prompt');
  await sleep(700);
  let log = await taskbarLog();
  if (log.some((e) => 'progress' in e)) throw new Error(`taskbar progress set: ${JSON.stringify(log)}`);
  ok('a working agent sets no taskbar progress');

  // 2. PermissionRequest: notification with Allow / Deny / Show, no taskbar overlay, flash asked.
  await hook('notify', { need: 'permission', immediate: true, tool: 'Bash' });
  await sleep(2000);
  let notes = await shown();
  if (notes.length !== 1 || JSON.stringify(notes[0].actions) !== JSON.stringify(['Allow', 'Deny', 'Show']) || notes[0].body !== 'Reviewer needs you') throw new Error(`notification: ${JSON.stringify(notes)} cell: ${JSON.stringify(await app.evaluate(cellDebug))}`);
  ok(`the permission notification offers ${notes[0].actions.join(' / ')}`);
  log = await taskbarLog();
  // 1.1.2: no taskbar overlay on Windows any more.
  if (log.some((e) => 'overlay' in e && e.overlay)) throw new Error(`taskbar overlay set: ${JSON.stringify(log)}`);
  ok('no taskbar overlay badge is set');
  if ((await main.recorded('attention:flash')).length < 1) throw new Error('no attention flash asked');
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
  if (JSON.stringify((await main.recorded('notify:show')).map((c) => c.args[0])) !== JSON.stringify([cellId])) throw new Error('a stale Allow did not show the cell');
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
  await main.hook(otherId, 'notify', { need: 'permission', immediate: true, tool: 'Bash' });
  await hook('busy', { tool: 'AskUserQuestion', toolUseId: 'toolu_3', toolEnd: true });
  await sleep(1200);
  log = await taskbarLog();
  if (log.some((e) => 'overlay' in e && e.overlay)) throw new Error(`taskbar overlay set: ${JSON.stringify(log)}`);
  ok('still no taskbar overlay after more waiting cells');

  // 8. The setting off: no buttons at all.
  await app.click('.tb-btn[aria-label="Settings"]');
  await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent.includes('Notifications'))`, 'settings nav');
  await app.click('.settings-nav [role=tab]', 'Notifications');
  await app.until(`!!document.querySelector('#settings-alert-actions')`, 'actions switch');
  if (!(await app.evaluate(`document.querySelector('#settings-alert-actions').checked && document.querySelector('#settings-alert-flash').checked`))) throw new Error('new switches not on by default');
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
  removeScratch(root);
}
