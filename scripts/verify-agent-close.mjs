// Real-app check of 0.9.7 "everyday work with many agents" (npm run build first). No real Claude or Codex runs: the grids hold shell
// cells whose profile is switched to "claude" in Settings after they started (the running shells stay shells), and the agent
// status is faked by sending the 'cell:hook' event main sends for a real hook (prompt = working, stop = turn finished) from the
// main process inspector. PATH is cut to the Windows folders, so even a restarted cell could not find a real CLI.
// Checks: closing a tab with a working agent asks and Cancel keeps it; "do not ask again" skips the question afterwards; the
// notification text names the cell and a burst becomes one notification; the Files tree shows a file made during the turn
// once the turn ends (no manual refresh); closing the window asks and Cancel keeps the app.
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';

const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID() };
const tabs = { main: randomUUID(), other: randomUUID(), third: randomUUID() };
const layout = (n) => ({ cols: n, rows: 1, areas: Array.from({ length: n }, (_, i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) });

function state(project) {
  const projectId = randomUUID();
  return {
    version: 1, settings: { language: 'en' }, activeProjectId: projectId,
    profiles: [{ id: 'fake', name: 'Fake agent', cli: 'shell', args: '', color: '#8b5cf6' }],
    projects: [{ id: projectId, name: 'Project X', path: project, color: '#3b82f6', archive: [], activeTabId: tabs.other, tabs: [
      { id: tabs.main, name: 'Main', layout: layout(2), cells: [{ id: ids.a, profileId: 'fake', name: 'Reviewer' }, { id: ids.b, profileId: 'fake' }] },
      { id: tabs.other, name: 'Other', layout: layout(1), cells: [{ id: ids.c, profileId: 'fake', name: 'Writer' }] },
      { id: tabs.third, name: 'Third', layout: layout(1), cells: [{ id: ids.d, profileId: 'fake', name: 'Tester' }] },
    ] }],
  };
}

/** CDP of the main process (Node inspector): evaluates with the app's own electron module. */
async function mainInspector(port) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0]; } catch { await sleep(200); }
  }
  if (!target) throw new Error('main inspector not reachable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (m) => (m.error || m.result.exceptionDetails ? reject(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails))) : resolve(m.result.result.value)));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  await evaluate(`globalThis.__el = process.mainModule.require('electron'); globalThis.__notes = [];
    __el.ipcMain.on('notify', (_e, n) => __notes.push(n)); true`);
  return {
    evaluate,
    hook: (cellId, event) => evaluate(`__el.BrowserWindow.getAllWindows()[0].webContents.send('cell:hook', ${JSON.stringify(cellId)}, ${JSON.stringify(event)}), true`),
    notes: () => evaluate('__notes.splice(0)'),
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
}

const root = scratchRoot('agentclose');
const inspectPort = 9300 + Math.floor(Math.random() * 500);
let app;
let main;
const results = [];
const ok = (name) => { results.push(name); console.log(`OK ${name}`); };
try {
  writeState(root, state(join(root, 'project')));
  const path = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';');
  app = await launchApp(root, { PATH: path, Path: null }, [`--inspect=${inspectPort}`]);
  main = await mainInspector(inspectPort);
  const tabEl = (name) => `[...document.querySelectorAll('.tab.grid-tab')].find((t) => t.querySelector('.label')?.textContent === ${JSON.stringify(name)})`;
  const selectTab = (name) => app.evaluate(`(${tabEl(name)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })), true`);
  const dialogText = () => app.evaluate(`document.querySelector('.overlay .modal')?.textContent ?? ''`);
  const clickDialog = (text) => app.click('.overlay .modal .modal-foot .btn', text);
  // Every grid once, so each cell's shell starts (only shown cells start).
  for (const name of ['Third', 'Main', 'Other']) { await selectTab(name); await sleep(1500); }
  await app.until(`document.querySelectorAll('.xterm').length >= 1`, 'terminals');
  // The profile becomes an agent profile (the running shells are not restarted).
  await app.click('.tb-btn[aria-label="Settings"]');
  await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent === 'Agent profiles')`, 'settings page');
  await app.click('.settings-nav [role=tab]', 'Agent profiles');
  await app.until(`!!document.querySelector('#settings-profile-cli-fake')`, 'profile card');
  await app.click('#settings-profile-cli-fake');
  await app.click('[role=option]', 'claude');
  await sleep(300);
  await selectTab('Main');
  await sleep(500);

  // 1. A working agent: closing its tab asks, names it, and Cancel keeps the tab.
  await main.hook(ids.a, 'prompt');
  await sleep(500);
  await app.evaluate(`(${tabEl('Main')}).querySelector('.x').click(), true`);
  await app.until(`!!document.querySelector('.overlay .modal')`, 'close dialog');
  const text = await dialogText();
  if (!text.includes('Close a tab where agents are working?') || !text.includes('Reviewer') || !text.includes('Do not ask again')) throw new Error(`dialog text: ${text}`);
  await clickDialog('Cancel');
  await sleep(300);
  if (!(await app.evaluate(`!!(${tabEl('Main')})`))) throw new Error('Cancel closed the tab');
  ok('closing a tab with a working agent asks; Cancel keeps it');

  // 2. The notification names the cell (project and tab in the title), and a burst becomes one notification. A file the agent made
  // during the turn shows in the Files tree after the turn ends (debounced, about 1.5 s).
  await app.click('#files-view');
  await app.until(`!!document.querySelector('.explorer-tree')`, 'files tree');
  await sleep(800);
  writeFileSync(join(root, 'project', 'agent-made.txt'), 'x');
  const fileShown = `[...document.querySelectorAll('.explorer-tree .file-entry')].some((e) => e.textContent.includes('agent-made.txt'))`;
  await sleep(1000);
  if (await app.evaluate(fileShown)) throw new Error('the tree showed the file before the turn ended (no check possible)');
  await main.notes();
  await main.hook(ids.a, 'stop');
  await app.until(fileShown, 'file in the tree after the turn', 5000);
  ok('the Files tree shows a file made during the turn after the turn ends');
  await sleep(1000);
  const single = await main.notes();
  if (single.length !== 1 || single[0].body !== 'Reviewer has finished' || single[0].title !== 'Project X · Main' || single[0].cellId !== ids.a) throw new Error(`single notification: ${JSON.stringify(single)}`);
  ok(`notification names the cell: "${single[0].title}" / "${single[0].body}"`);
  await main.hook(ids.a, 'prompt');
  await main.hook(ids.b, 'prompt');
  await sleep(600);
  await main.hook(ids.a, 'stop');
  await main.hook(ids.b, 'stop');
  await sleep(2000);
  const combined = await main.notes();
  if (combined.length !== 1 || combined[0].body !== '2 agents finished in Project X: Reviewer, Fake agent' || combined[0].cellId !== ids.a) throw new Error(`combined notification: ${JSON.stringify(combined)}`);
  ok(`a burst is one notification: "${combined[0].body}"`);

  // 4. "Do not ask again" + Close anyway closes the tab and turns the question off.
  await main.hook(ids.a, 'prompt');
  await sleep(500);
  await app.evaluate(`(${tabEl('Main')}).querySelector('.x').click(), true`);
  await app.until(`!!document.querySelector('.overlay .modal')`, 'close dialog 2');
  await app.click('.overlay .modal .dialog-check input');
  await clickDialog('Close anyway');
  await app.until(`!(${tabEl('Main')})`, 'tab closed');
  await selectTab('Other');
  await sleep(500);
  await main.hook(ids.c, 'prompt');
  await sleep(500);
  await app.evaluate(`(${tabEl('Other')}).querySelector('.x').click(), true`);
  await sleep(800);
  if (await app.evaluate(`!!document.querySelector('.overlay .modal')`)) throw new Error('asked although "do not ask again" was ticked');
  if (await app.evaluate(`!!(${tabEl('Other')})`)) throw new Error('the tab did not close');
  ok('"do not ask again" skips the question');

  // 5. The setting shows off in Settings and turns back on there.
  await app.click('.tb-btn[aria-label="Settings"]');
  await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent === 'App settings')`, 'settings page 2');
  await app.click('.settings-nav [role=tab]', 'App settings');
  await app.until(`!!document.querySelector('#settings-confirm-close')`, 'setting switch');
  if (await app.evaluate(`document.querySelector('#settings-confirm-close').checked`)) throw new Error('the setting is still on');
  await app.click('#settings-confirm-close');
  await sleep(300);
  if (!(await app.evaluate(`document.querySelector('#settings-confirm-close').checked`))) throw new Error('the setting did not turn on');
  ok('the setting is off in Settings and turns back on');

  // 6. Closing the window while an agent works asks in the window; Cancel keeps the app.
  await selectTab('Third');
  await sleep(500);
  await main.hook(ids.d, 'prompt');
  await sleep(800);
  await main.evaluate(`__el.BrowserWindow.getAllWindows()[0].close(), true`);
  await app.until(`!!document.querySelector('.overlay .modal')`, 'quit dialog');
  const quitText = await dialogText();
  if (!quitText.includes('Quit while agents are working?') || !quitText.includes('Tester')) throw new Error(`quit dialog: ${quitText}`);
  await clickDialog('Cancel');
  await sleep(1000);
  if ((await main.evaluate(`__el.BrowserWindow.getAllWindows().length`)) !== 1) throw new Error('the window closed after Cancel');
  ok('closing the window with a working agent asks; Cancel keeps the app');

  // 6b. A quit while the window is minimized brings the window up with the question; a second Close while it is open does not get
  // stuck (the question stays, the app neither quits nor ignores the answer); Cancel keeps the app.
  await main.evaluate(`__el.BrowserWindow.getAllWindows()[0].minimize(), true`);
  await sleep(800);
  if (!(await main.evaluate(`__el.BrowserWindow.getAllWindows()[0].isMinimized()`))) throw new Error('the window did not minimize');
  await main.evaluate(`__el.BrowserWindow.getAllWindows()[0].close(), true`);
  await app.until(`!!document.querySelector('.overlay .modal')`, 'quit dialog (minimized)');
  await sleep(500);
  const shown = await main.evaluate(`(() => { const w = __el.BrowserWindow.getAllWindows()[0]; return { minimized: w.isMinimized(), visible: w.isVisible() }; })()`);
  if (shown.minimized || !shown.visible) throw new Error(`the question is not visible: ${JSON.stringify(shown)}`);
  ok('a quit while minimized brings the window up with the question');
  const firstDialog = await dialogText();
  await main.evaluate(`__el.BrowserWindow.getAllWindows()[0].close(), true`);
  await sleep(4000); // past the 3 s acknowledgement fallback
  if ((await main.evaluate(`__el.BrowserWindow.getAllWindows().length`)) !== 1) throw new Error('the second Close quit while the question was open');
  if ((await app.evaluate(`document.querySelectorAll('.overlay .modal').length`)) !== 1 || (await dialogText()) !== firstDialog) throw new Error('the second Close changed the question');
  await clickDialog('Cancel');
  await sleep(1000);
  if ((await main.evaluate(`__el.BrowserWindow.getAllWindows().length`)) !== 1) throw new Error('the window closed after Cancel (second Close)');
  if (await app.evaluate(`!!document.querySelector('.overlay .modal')`)) throw new Error('the question stayed open after Cancel');
  // Not stuck: the next Close asks again at once.
  await main.evaluate(`__el.BrowserWindow.getAllWindows()[0].close(), true`);
  await app.until(`!!document.querySelector('.overlay .modal')`, 'quit dialog after Cancel');
  await clickDialog('Cancel');
  await sleep(800);
  ok('a second Close while the question is open does not get stuck; Cancel keeps the app');

  // 7. A waiting agent does not count: the window close goes through without a question.
  await main.hook(ids.d, 'stop');
  await sleep(800);
  const exited = new Promise((resolve) => { const t = setInterval(async () => { try { await fetch(`http://127.0.0.1:${inspectPort}/json/list`); } catch { clearInterval(t); resolve(true); } }, 200); setTimeout(() => { clearInterval(t); resolve(false); }, 15000); });
  await main.evaluate(`setTimeout(() => __el.BrowserWindow.getAllWindows()[0].close(), 50), true`).catch(() => undefined);
  if (!(await exited)) throw new Error('the app did not quit with only waiting agents');
  ok('with only waiting agents the app quits without asking');
  console.log(`ALL OK (${results.length})`);
} finally {
  main?.close();
  if (app) await app.close();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
