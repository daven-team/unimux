// Real-app check of 1.1.2 "update while agents work" (npm run build:check first). No real Claude or Codex and no real update: the grids
// hold shell cells whose profile is switched to "claude" in Settings after they started, the agent status is faked with the
// 'cell:hook' event main sends for a real hook (prompt = working, stop = turn finished), and the update is faked from the main
// side (real-app.mjs mainControl): the status bar is told an update is ready, and 'update:install' (the hand-over to the update window) is
// replaced by a recorder. One grid lives in a detached window.
// Checks: a click on the update button while agents work shows the dialog (listing both agents, the detached one too) and does not
// hand over; "Update when they finish" shows the waiting state and hands over only after both turns ended; the X cancels the
// wait; "Update now" hands over at once; with nothing in progress the click hands over without a question.
// Screenshots go to a temporary folder (printed at the end).
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';

const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
const tabs = { main: randomUUID(), away: randomUUID() };
const layout = (n) => ({ cols: n, rows: 1, areas: Array.from({ length: n }, (_, i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) });
const projectId = randomUUID();
const windowId = randomUUID();

function state(project) {
  return {
    version: 1, settings: { language: 'en' }, activeProjectId: projectId,
    profiles: [{ id: 'fake', name: 'Fake agent', cli: 'shell', args: '', color: '#8b5cf6' }],
    projects: [{ id: projectId, name: 'Project X', path: project, color: '#3b82f6', archive: [], activeTabId: tabs.main, tabs: [
      { id: tabs.main, name: 'Main', layout: layout(2), cells: [{ id: ids.a, profileId: 'fake', name: 'Reviewer' }, { id: ids.b, profileId: 'fake', name: 'Tester' }] },
      { id: tabs.away, name: 'Away', layout: layout(1), cells: [{ id: ids.c, profileId: 'fake', name: 'Writer' }] },
    ] }],
    detachedWindows: [{ id: windowId, target: { kind: 'grid', projectId, tabId: tabs.away }, bounds: { x: -5000, y: 0, width: 900, height: 600 } }],
  };
}

const root = scratchRoot('updatewait');
const shots = mkdtempSync(join(tmpdir(), 'unimux-update-wait-'));
let app;
let main;
const results = [];
const ok = (name) => { results.push(name); console.log(`OK ${name}`); };
try {
  mkdirSync(join(root, 'project'), { recursive: true });
  writeState(root, state(join(root, 'project')));
  const path = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';');
  app = await launchApp(root, { PATH: path, Path: null }, [], { main: true });
  main = app.main;
  const shot = async (name) => {
    const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
  };
  // The hook goes to every window: the one that holds the cell's terminal takes it.
  const hook = (cellId, event) => main.hookAll(cellId, event);
  const dialogText = () => app.evaluate(`document.querySelector('.overlay .modal')?.textContent ?? ''`);
  const clickDialog = (text) => app.click('.overlay .modal .modal-foot .btn', text);
  // The hand-overs so far (the recorded update:install calls, counted up).
  let installCount = 0;
  const installs = async () => (installCount += (await main.recorded('update:install')).length);
  const updateButton = `[...document.querySelectorAll('.statusbar .sb-action')].find((b) => b.textContent.includes('9.9.9'))`;

  await app.until(`document.querySelectorAll('.xterm').length >= 2`, 'terminals');
  const windows = (await main.windows()).length;
  if (windows < 2) throw new Error(`the detached window did not open (${windows} windows)`);
  // The profile becomes an agent profile (the running shells are not restarted).
  await app.click('.tb-btn[aria-label="Settings"]');
  await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent === 'Agents')`, 'settings page');
  await app.click('.settings-nav [role=tab]', 'Agents');
  await app.until(`!!document.querySelector('#settings-profile-cli-fake')`, 'profile card');
  await app.click('#settings-profile-cli-fake');
  await app.click('[role=option]', 'claude');
  await sleep(300);
  await app.evaluate(`[...document.querySelectorAll('.tab.grid-tab')].find((t) => t.querySelector('.label')?.textContent === 'Main')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })), true`);
  await sleep(800);

  // The fake update: ready to install, and the hand-over only recorded.
  await main.record(['update:install'], { swallow: true });
  await main.emit('update:state', [{ status: 'ready', version: '9.9.9' }]);
  await app.until(`!!(${updateButton})`, 'update button');

  // 1. Agents working (one here, one in the detached window): the click asks and does not hand over.
  await hook(ids.a, 'prompt');
  await hook(ids.c, 'prompt');
  await sleep(800);
  await app.evaluate(`(${updateButton}).click(), true`);
  await app.until(`!!document.querySelector('.overlay .modal .uw-groups')`, 'update dialog');
  const text = await dialogText();
  for (const part of ['The update would interrupt work in progress', 'Agents in the middle of a turn (2)', 'Reviewer', 'Writer', 'Update when they finish', 'Update now', 'Cancel', 'conversations come back after the restart']) {
    if (!text.includes(part)) throw new Error(`dialog lacks "${part}": ${text}`);
  }
  if (text.includes('Tester')) throw new Error('an idle agent was listed');
  await shot('1-update-dialog.png');
  await sleep(1500);
  if (await installs()) throw new Error('handed over while the dialog was open');
  ok('a click on update while agents work asks (both windows listed) and does not hand over');

  // 2. Cancel: nothing happens.
  await clickDialog('Cancel');
  await sleep(500);
  if (await installs()) throw new Error('Cancel handed over');
  if (await app.evaluate(`!!document.querySelector('.sb-update-wait')`)) throw new Error('Cancel started waiting');
  ok('Cancel neither updates nor waits');

  // 3. "Update when they finish": the waiting state; the hand-over only after both turns ended (and the short quiet time).
  await app.evaluate(`(${updateButton}).click(), true`);
  await app.until(`!!document.querySelector('.overlay .modal .uw-groups')`, 'update dialog 2');
  await clickDialog('Update when they finish');
  await app.until(`document.querySelector('.sb-update-wait')?.textContent.includes('Update after the agents finish (2)')`, 'waiting state (2)');
  await shot('2-waiting-state.png');
  await hook(ids.a, 'stop');
  await app.until(`document.querySelector('.sb-update-wait')?.textContent.includes('Update after the agents finish (1)')`, 'waiting state (1)');
  // A new prompt is allowed while waiting and holds the update again.
  await hook(ids.b, 'prompt');
  await app.until(`document.querySelector('.sb-update-wait')?.textContent.includes('Update after the agents finish (2)')`, 'waiting state with a new prompt');
  await sleep(5000);
  if (await installs()) throw new Error('handed over while agents still worked');
  // The click on the waiting state says what it waits for.
  await app.click('.sb-update-wait [data-update-wait]');
  await app.until(`document.querySelector('.overlay .modal')?.textContent.includes('The update waits for the work to finish')`, 'waiting dialog');
  const waitingText = await dialogText();
  if (!waitingText.includes('Writer') || !waitingText.includes('Tester') || !waitingText.includes('Keep waiting')) throw new Error(`waiting dialog: ${waitingText}`);
  await shot('3-waiting-dialog.png');
  await clickDialog('Keep waiting');
  await sleep(300);
  await hook(ids.c, 'stop');
  await hook(ids.b, 'stop');
  const endedAt = Date.now();
  const t0 = Date.now();
  while (!(await installs()) && Date.now() - t0 < 15000) await sleep(200);
  const waited = Date.now() - endedAt;
  if ((await installs()) !== 1) throw new Error('no hand-over after the turns ended');
  if (waited < 3000) throw new Error(`handed over too soon after the turns ended (${waited} ms)`);
  await sleep(300);
  if (await app.evaluate(`!!document.querySelector('.sb-update-wait')`)) throw new Error('the waiting state stayed after the hand-over');
  ok(`"Update when they finish" hands over only after the turns ended (${waited} ms later), the detached one included`);

  // 4. The X stops waiting: no hand-over when the turn ends later.
  await hook(ids.a, 'prompt');
  await sleep(600);
  await app.evaluate(`(${updateButton}).click(), true`);
  await app.until(`!!document.querySelector('.overlay .modal .uw-groups')`, 'update dialog 3');
  await clickDialog('Update when they finish');
  await app.until(`!!document.querySelector('.sb-update-wait')`, 'waiting state 3');
  await app.click('.sb-update-wait [data-update-wait-cancel]');
  await sleep(300);
  if (await app.evaluate(`!!document.querySelector('.sb-update-wait')`)) throw new Error('the X did not stop waiting');
  await hook(ids.a, 'stop');
  await sleep(6000);
  if ((await installs()) !== 1) throw new Error('handed over after the wait was cancelled');
  ok('the X cancels the waiting update');

  // 5. "Update now" hands over at once.
  await hook(ids.b, 'prompt');
  await sleep(600);
  await app.evaluate(`(${updateButton}).click(), true`);
  await app.until(`!!document.querySelector('.overlay .modal .uw-groups')`, 'update dialog 4');
  await clickDialog('Update now');
  await sleep(500);
  if ((await installs()) !== 2) throw new Error('"Update now" did not hand over');
  ok('"Update now" hands over at once');

  // 6. Nothing in progress: no question.
  await hook(ids.b, 'stop');
  await sleep(800);
  await app.evaluate(`(${updateButton}).click(), true`);
  await sleep(800);
  if (await app.evaluate(`!!document.querySelector('.overlay .modal')`)) throw new Error('asked with nothing in progress');
  if ((await installs()) !== 3) throw new Error('no hand-over with nothing in progress');
  ok('with nothing in progress the click hands over without a question');
  console.log(`ALL OK (${results.length})`);
  console.log(`screenshots: ${shots}`);
} finally {
  main?.close();
  if (app) await app.close();
  removeScratch(root);
}
