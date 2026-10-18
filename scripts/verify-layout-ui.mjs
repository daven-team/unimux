// Real-app check of small layout fixes (npm run build first), in English on a scratch data dir with a 2x2 grid of shell cells:
// - the snippet drop overlay is a translated element ("Drop to paste") that starts right below the cell header, like the path
//   drop overlay;
// - the AI team panel has a splitter: keys and a mouse drag resize it, the height is saved, it is clamped so the grid keeps
//   200px, and a saved height taller than a short window shrinks instead of pushing the grid away;
// - a long cell error keeps its "Try again" button inside the cell (the error box is injected into a real cell with the markup
//   of CellView, because a spawn error with a long message cannot be produced without a broken CLI);
// - the sign-in terminal of the auth dialog fits a short window without scrolling the dialog (the dialog markup of AuthModal is
//   injected, because a real sign-in would start a CLI).
// VERIFY_TAG=before only takes screenshots and prints the measurements (for a build of the old code).
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { launchApp, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';

const TAG = process.env.VERIFY_TAG ?? 'after';
const STRICT = TAG !== 'before';
const problems = [];
const expect = (ok, message, data) => { if (!ok) problems.push(`${message} ${data === undefined ? '' : JSON.stringify(data)}`); };

function state(projectPath) {
  const projectId = randomUUID();
  const areas = [0, 1, 2, 3].map((i) => ({ col: i % 2, row: Math.floor(i / 2), colSpan: 1, rowSpan: 1 }));
  const tab = { id: randomUUID(), name: 'Grid', color: '#60a5fa', layout: { cols: 2, rows: 2, areas }, cells: areas.map(() => ({ id: randomUUID(), profileId: 'shell' })) };
  return { version: 1, settings: { language: 'en' }, sshHosts: [], activeProjectId: projectId,
    projects: [{ id: projectId, name: 'layout-check', path: projectPath, color: '#3b82f6', tabs: [tab], archive: [], activeTabId: tab.id }] };
}

const box = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) }; })()`;

const root = scratchRoot('layout');
let app;
try {
  writeState(root, state(`${root}\\project`));
  app = await launchApp(root);
  const size = async (width, height) => {
    await app.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  };
  await app.until(`document.querySelectorAll('.cell .cell-head').length === 4`, 'grid');

  // V1 + V2: the snippet overlay (a synthetic dragover with the snippet type) and the path overlay.
  await size(900, 560);
  const dragOver = (mime) => app.evaluate(`(() => {
    const cell = document.querySelector('.cell');
    const dt = new DataTransfer(); dt.setData(${JSON.stringify(mime)}, 'x');
    cell.querySelector('.cell-body').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true; })()`);
  const dragLeave = () => app.evaluate(`(() => { document.querySelector('.cell').dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body })); return true; })()`);
  await dragOver('application/x-mc-snippet');
  await sleep(300);
  const snippet = await app.evaluate(`(() => {
    const cell = document.querySelector('.cell');
    const head = cell.querySelector('.cell-head').getBoundingClientRect();
    const el = cell.querySelector('.cell-snippet-drop');
    const after = getComputedStyle(cell, '::after').content;
    return { head: Math.round(head.bottom), top: el ? Math.round(el.getBoundingClientRect().top) : null, text: el?.textContent ?? null, cssContent: after };
  })()`);
  await app.screenshot(`097-snippet-drop-${TAG}.png`);
  console.log('snippet overlay', JSON.stringify(snippet));
  expect(snippet.text === 'Drop to paste', 'the snippet overlay is not in English', snippet);
  expect(snippet.top === snippet.head, 'the snippet overlay does not start at the header bottom', snippet);
  expect(snippet.cssContent === 'none' || snippet.cssContent === 'normal', 'a CSS content string is still drawn', snippet);
  await dragLeave();
  await dragOver('application/x-ajz-path');
  await sleep(300);
  const path = await app.evaluate(`(() => {
    const cell = document.querySelector('.cell');
    const el = cell.querySelector('.cell-path-drop');
    return { head: Math.round(cell.querySelector('.cell-head').getBoundingClientRect().bottom), top: el ? Math.round(el.getBoundingClientRect().top) : null };
  })()`);
  console.log('path overlay', JSON.stringify(path));
  expect(path.top === path.head, 'the path overlay does not start at the header bottom', path);
  await dragLeave();

  // V3: a saved height taller than a short window shrinks; the grid keeps 200px.
  await app.evaluate(`localStorage.setItem('mc-automation-height-v1', '1000'), true`);
  await app.evaluate('location.reload(), true');
  await sleep(1500);
  await app.until(`document.querySelectorAll('.cell .cell-head').length === 4`, 'grid after reload');
  await app.click('.team-toggle');
  await app.until(`!!document.querySelector('.automation-panel')`, 'AI team panel');
  await sleep(500);
  const short = await app.evaluate(`({ grid: ${box('.main > .workspace-content')}, panel: ${box('.automation-panel')}, main: ${box('.main')} })`);
  await app.screenshot(`097-team-short-${TAG}.png`);
  console.log('short window, saved 1000', JSON.stringify(short));
  expect(short.grid.h >= 199, 'the grid has less than 200px in a short window', short);
  expect(short.panel.h >= 139, 'the AI team panel is below 140px', short);
  expect(short.panel.bottom <= short.main.bottom + 1, 'the AI team panel runs out of the window', short);

  // Tall window: the saved height applies; keys, drag and clamping.
  await app.evaluate(`localStorage.setItem('mc-automation-height-v1', '400'), true`);
  await app.evaluate('location.reload(), true');
  await sleep(1500);
  await size(900, 1000);
  await app.until(`document.querySelectorAll('.cell .cell-head').length === 4`, 'grid after reload');
  await app.click('.team-toggle');
  await app.until(`!!document.querySelector('.automation-panel')`, 'AI team panel');
  await sleep(500);
  const tall = await app.evaluate(box('.automation-panel'));
  console.log('tall window, saved 400', JSON.stringify(tall));
  expect(tall.h === 400, 'the saved height is not used in a tall window', tall);
  const hasSplitter = await app.evaluate(`!!document.querySelector('.automation-splitter[role=separator]')`);
  expect(hasSplitter, 'no splitter');
  if (hasSplitter) {
    await app.evaluate(`document.querySelector('.automation-splitter').focus(), true`);
    await app.press('ArrowUp');
    await sleep(300);
    const afterKey = await app.evaluate(`({ h: Math.round(document.querySelector('.automation-panel').getBoundingClientRect().height), saved: localStorage.getItem('mc-automation-height-v1') })`);
    console.log('after ArrowUp', JSON.stringify(afterKey));
    expect(afterKey.h === 424 && afterKey.saved === '424', 'ArrowUp did not grow and save the panel by 24px', afterKey);
    const s = await app.evaluate(box('.automation-splitter'));
    const x = Math.round((s.left + s.right) / 2), y = Math.round((s.top + s.bottom) / 2);
    const mouse = (type, yy) => app.cdp('Input.dispatchMouseEvent', { type, x, y: yy, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await mouse('mousePressed', y);
    for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', y - i * 20); await sleep(30); }
    await mouse('mouseReleased', y - 100);
    await sleep(400);
    const afterDrag = await app.evaluate(`({ h: Math.round(document.querySelector('.automation-panel').getBoundingClientRect().height), saved: localStorage.getItem('mc-automation-height-v1') })`);
    console.log('after a 100px drag up', JSON.stringify(afterDrag));
    expect(Math.abs(afterDrag.h - 524) <= 1 && afterDrag.saved === String(afterDrag.h), 'the drag did not resize and save the panel', afterDrag);
    await mouse('mousePressed', y - 100);
    for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', y - 100 - i * 100); await sleep(30); }
    await mouse('mouseReleased', 5);
    await sleep(400);
    const clamped = await app.evaluate(`({ grid: ${box('.main > .workspace-content')}, panel: ${box('.automation-panel')}, saved: localStorage.getItem('mc-automation-height-v1') })`);
    console.log('after a drag to the top', JSON.stringify(clamped));
    expect(Math.abs(clamped.grid.h - 200) <= 1, 'the drag is not clamped at a 200px grid', clamped);
    await app.screenshot(`097-team-clamped-${TAG}.png`);
    await app.press('ArrowUp');
    await sleep(200);
    await app.evaluate(`document.querySelector('.automation-splitter').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })), true`);
    await sleep(300);
    const min = await app.evaluate(box('.automation-panel'));
    expect(min.h === 140, 'Home does not shrink the panel to 140px', min);
  }
  await app.click('.team-toggle');
  await sleep(300);

  // V7: a long error in a small cell (injected with the markup of CellView) keeps its button inside the cell.
  await size(900, 560);
  const error = await app.evaluate(`(() => {
    const cell = document.querySelectorAll('.cell')[3];
    const div = document.createElement('div');
    div.className = 'cell-error';
    div.innerHTML = '<span class="grow"></span><button class="btn small">Try again</button>';
    div.firstChild.textContent = Array.from({ length: 30 }, (_, i) => 'spawn failed: the command could not be started in C:\\\\some\\\\very\\\\long\\\\path\\\\number-' + i).join(' ');
    cell.appendChild(div);
    const c = cell.getBoundingClientRect(), h = cell.querySelector('.cell-head').getBoundingClientRect(), b = div.querySelector('button').getBoundingClientRect(), e = div.getBoundingClientRect(), g = div.firstChild;
    return { cell: [Math.round(c.top), Math.round(c.bottom)], head: Math.round(h.bottom), box: [Math.round(e.top), Math.round(e.bottom)], button: [Math.round(b.top), Math.round(b.bottom)], textScrolls: g.scrollHeight > g.clientHeight };
  })()`);
  await app.screenshot(`097-cell-error-${TAG}.png`);
  console.log('long cell error', JSON.stringify(error));
  expect(error.box[0] >= error.head && error.box[1] <= error.cell[1], 'the error box leaves the cell body', error);
  expect(error.button[0] >= error.box[0] && error.button[1] <= error.box[1], 'the Try again button is not visible', error);
  expect(error.textScrolls, 'the long text does not scroll inside the box', error);
  await app.evaluate(`document.querySelectorAll('.cell-error').forEach((e) => e.remove()), true`);

  // V8: the auth dialog (injected with the markup of AuthModal) in a 500px-high window.
  await size(900, 500);
  const auth = await app.evaluate(`(() => {
    const host = document.createElement('div');
    host.className = 'overlay';
    host.innerHTML = '<div class="modal auth"><div class="modal-head"><h3>Sign in</h3></div><div class="auth-note muted">Finish signing in in the browser. The window closes by itself once you are signed in.</div><div class="auth-terminal"></div><div class="auth-status wait"><span>Waiting for sign-in...</span></div><div class="modal-foot"><button class="btn">Cancel</button></div></div>';
    document.body.appendChild(host);
    const m = host.querySelector('.modal'), t = host.querySelector('.auth-terminal').getBoundingClientRect(), f = host.querySelector('.modal-foot').getBoundingClientRect(), mb = m.getBoundingClientRect();
    return { modal: [Math.round(mb.top), Math.round(mb.bottom)], terminal: Math.round(t.height), terminalBottom: Math.round(t.bottom), foot: [Math.round(f.top), Math.round(f.bottom)], overflow: m.scrollHeight - m.clientHeight };
  })()`);
  await app.screenshot(`097-auth-short-${TAG}.png`);
  console.log('auth dialog at 500px', JSON.stringify(auth));
  expect(auth.overflow <= 0 && auth.foot[1] <= auth.modal[1] + 1, 'the auth dialog overflows in a 500px window', auth);
  expect(auth.terminal >= 96, 'the sign-in terminal is too small', auth);
  await app.evaluate(`document.querySelectorAll('.overlay').forEach((e) => { if (e.querySelector('.modal.auth h3')?.textContent === 'Sign in') e.remove(); }), true`);
  await size(900, 1000);
  const authTall = await app.evaluate(`(() => {
    const host = document.createElement('div'); host.className = 'overlay';
    host.innerHTML = '<div class="modal auth"><div class="modal-head"><h3>Sign in</h3></div><div class="auth-terminal"></div><div class="modal-foot"><button class="btn">Cancel</button></div></div>';
    document.body.appendChild(host);
    const h = Math.round(host.querySelector('.auth-terminal').getBoundingClientRect().height); host.remove(); return h; })()`);
  console.log('auth terminal at 1000px', authTall);
  expect(authTall === 300, 'the sign-in terminal is not 300px in a tall window', authTall);
} finally {
  if (app) await app.close();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
if (problems.length) {
  console.log(`${STRICT ? 'FAIL' : 'differences (before)'}:\n- ${problems.join('\n- ')}`);
  if (STRICT) process.exit(1);
} else console.log('OK');
