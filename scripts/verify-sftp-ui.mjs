// node scripts/verify-sftp-ui.mjs - real-app check of the SFTP view (0.9.8) against the local test server only
// (scripts/ssh-test-server.mjs --sftp-root <scratch>). Never a real host, never the user's data dir, home or ~/.ssh.
// Needs `npm run build` first. Screenshots go to D:\Projekty\_shots\098-sftp-*.png.
//
// Drags between the panes are dispatched as DOM drag events (an in-page HTML5 drag cannot be started over CDP without the OS):
// dragstart on the selected source rows (the pane's own handler fills the DataTransfer and remembers the drag), then
// dragenter/dragover/drop on the target with the same DataTransfer, then dragend. A forged payload without a dragstart behind
// it (what another app could put under the custom type) is checked to do nothing.
// The OS drop goes through CDP Input.dispatchDragEvent with real file paths, so the pane reads them with window.mc.pathForFile
// (webUtils.getPathForFile in the preload), exactly like a drop from Explorer.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { launchApp, mainInspector, scratchRoot, sleep, startTestServer, testHost, writeState } from './ssh-ui-lib.mjs';

const shot = (app, name) => app.screenshot(`098-sftp-${name}.png`);
const log = (m) => process.stdout.write(`  ${m}\n`);

const root = scratchRoot('sftp');
const remoteRoot = join(root, 'remote');
const home = join(remoteRoot, 'home', 'alice');
const local = join(root, 'local');
const trash = join(root, 'trash');
for (const dir of [home, join(home, 'site', 'img'), local, join(local, 'site', 'css'), trash]) mkdirSync(dir, { recursive: true });
writeFileSync(join(home, 'readme.txt'), 'remote readme\n');
writeFileSync(join(home, 'site', 'img', 'logo.txt'), 'logo\n');
writeFileSync(join(local, 'a.txt'), 'local a v1\n');
writeFileSync(join(local, 'b.txt'), 'local b\n');
writeFileSync(join(local, 'os-drop.txt'), 'dropped from the OS\n');
writeFileSync(join(local, 'site', 'index.html'), '<h1>site</h1>\n');
writeFileSync(join(local, 'site', 'css', 'a.css'), 'body{}\n');
writeFileSync(join(local, 'big.bin'), Buffer.alloc(24 * 1024 * 1024, 7));

// A user key made here (not the user's ~/.ssh): the server accepts it, the app gets it through the normal import path.
const pair = ssh2.utils.generateKeyPairSync('ed25519');
writeFileSync(join(root, 'user.pub'), pair.public);

const server = await startTestServer(['--sftp-root', remoteRoot, '--sftp-home', '/home/alice', '--public-key-file', join(root, 'user.pub'), '--sftp-delay', '4']);
const keyHost = testHost(server.port, { label: 'vps-key', group: 'lab' });
const pwHost = testHost(server.port, { label: 'vps-password', group: 'lab' });
const projectId = '7a3a5d30-2f45-4d61-9d6b-1b0f6a3c1a01';
const cellId = '7a3a5d30-2f45-4d61-9d6b-1b0f6a3c1a02';
const tabId = '7a3a5d30-2f45-4d61-9d6b-1b0f6a3c1a03';
mkdirSync(join(root, 'project'), { recursive: true });
writeState(root, {
  version: 1, settings: { language: 'pl' }, sshHosts: [keyHost, pwHost], activeProjectId: projectId, sftp: { localPath: local, remotePaths: {} },
  projects: [{ id: projectId, name: 'sftp-check', path: join(root, 'project'), color: '#3b82f6', activeTabId: tabId, archive: [],
    tabs: [{ id: tabId, name: 'SSH', color: '#60a5fa', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }, cells: [{ id: cellId, profileId: 'shell', ssh: { hostId: keyHost.id } }] }] }],
});

let app;
let main;
const inspectPort = 9300 + Math.floor(Math.random() * 500);
const remoteFiles = (dir = home) => readdirSync(dir);
try {
  app = await launchApp(root, { MC_TRASH_DIR: trash }, [`--inspect=${inspectPort}`]);
  main = await mainInspector(inspectPort);
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const ev = app.evaluate;
  const sftp = `window.__mc.useSftpStore.getState()`;
  const rowsOf = (side) => `[...document.querySelectorAll('.sftp-pane-${side} .sftp-list .sftp-row')].map((r) => r.dataset.name)`;
  const hasRow = (side, name) => `${rowsOf(side)}.includes(${JSON.stringify(name)})`;
  const clickRow = (side, name, mods = {}) => ev(`(() => { const r = [...document.querySelectorAll('.sftp-pane-${side} .sftp-list .sftp-row')].find((x) => x.dataset.name === ${JSON.stringify(name)}); if (!r) throw new Error('no row ${name}'); r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} })); return true; })()`);
  const menu = async (side, label) => {
    await app.click(`.sftp-pane-${side} .sftp-actions`);
    await app.until(`!!document.querySelector('.menu')`, 'actions menu');
    await ev(`(() => { const el = [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (!el) throw new Error('menu item ${label}'); el.click(); return true; })()`);
  };
  const answerText = async (value) => {
    await app.until(`!!document.querySelector('.modal input.input')`, 'name dialog');
    await app.setValue('.modal input.input', value);
    await app.click('.modal .modal-foot .btn.primary');
  };
  const dialogChoose = async (label, check = false) => {
    await app.until(`!!document.querySelector('.modal .modal-foot')`, `dialog for ${label}`);
    if (check) await app.click('.modal .dialog-check input');
    await app.click('.modal .modal-foot .btn', label);
  };
  /** A drag of the rows `names` (selected first, Ctrl click) from one pane, dropped on the other pane or one of its folder rows. */
  const dragDrop = async (fromSide, names, toSide, folderName) => {
    for (const [i, name] of names.entries()) await clickRow(fromSide, name, { ctrl: i > 0 });
    await ev(`(() => {
    const dt = new DataTransfer();
    const source = [...document.querySelectorAll('.sftp-pane-${fromSide} .sftp-list .sftp-row')].find((r) => r.dataset.name === ${JSON.stringify(names[0])});
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const list = document.querySelector('.sftp-pane-${toSide} .sftp-list');
    const target = ${folderName ? `[...list.querySelectorAll('.sftp-row')].find((r) => r.dataset.name === ${JSON.stringify(folderName)})` : 'list'};
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true; })()`);
  };
  /** What a web page could drop: the custom type with paths, no drag from this window behind it. */
  const forgedDrop = (side, paths, toSide) => ev(`(() => {
    const dt = new DataTransfer();
    dt.setData('application/x-unimux-sftp', JSON.stringify({ side: ${JSON.stringify(side)}, paths: ${JSON.stringify(paths)} }));
    const list = document.querySelector('.sftp-pane-${toSide} .sftp-list');
    for (const type of ['dragenter', 'dragover', 'drop']) list.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true; })()`);
  const allDone = `(() => { const t = ${sftp}.transfers; return t.length > 0 && t.every((i) => ['done', 'failed', 'cancelled'].includes(i.state)); })()`;
  const clearDone = async () => { await app.click('.sftp-transfers-head .btn', 'Wyczyść zakończone'); await app.until(`${sftp}.transfers.length === 0`, 'queue cleared'); };

  // 1. The SFTP entry of the SSH mode navigation opens the view with the empty state.
  await app.click('.rail-tiles [aria-label="SSH"]');
  await app.until(`!!document.querySelector('.ssh-nav-item[data-section="sftp"]') && !document.querySelector('.ssh-nav-item[data-section="sftp"]').disabled`, 'SFTP entry enabled');
  await app.click('.ssh-nav-item[data-section="sftp"]');
  await app.until(`!!document.querySelector('.sftp-view .sftp-connect') && document.querySelector('.sftp-connect h3').textContent === 'Połącz z hostem'`, 'empty state');
  await app.until(hasRow('local', 'a.txt') + ` && ${hasRow('local', 'site')}`, 'local pane in the remembered folder');
  const localOrder = await ev(rowsOf('local'));
  if (localOrder[0] !== 'site') throw new Error(`folders first: ${localOrder}`);
  await shot(app, 'empty');
  log('empty state and local pane OK');

  // 2. Select host lists the saved hosts (with the group); the key host asks for the host key in the view.
  const imported = await ev(`window.mc.ssh.draftFromText({ privateKey: ${JSON.stringify(pair.private)} }).then((d) => d.ok ? window.mc.ssh.commitDraft({ draftId: d.draftId, label: 'check-key', savePassphrase: false }) : d)`);
  if (!imported.ok) throw new Error(`key import failed: ${JSON.stringify(imported)}`);
  await ev(`(() => { window.__mc.useStore.getState().update((s) => ({ ...s, sshHosts: s.sshHosts.map((h) => h.id === ${JSON.stringify(keyHost.id)} ? { ...h, keyId: ${JSON.stringify(imported.key.id)} } : h) })); return true; })()`);
  await app.click('.sftp-connect .btn', 'Wybierz host');
  await app.until(`document.querySelectorAll('.sftp-picker .sftp-host-option').length === 2 && document.querySelector('.sftp-picker-group-name')?.textContent === 'lab'`, 'host picker');
  await shot(app, 'picker');
  await app.click('.sftp-host-option', 'vps-key');
  await app.until(`!!document.querySelector('.sftp-prompt .ssh-fingerprint')`, 'host key prompt in the view');
  if (!(await ev(`document.querySelector('.sftp-prompt .ssh-fingerprint').textContent.includes(${JSON.stringify(server.fingerprint)})`))) throw new Error('fingerprint mismatch');
  await shot(app, 'hostkey');
  await app.click('.sftp-prompt .btn', 'Zaufaj i zapisz');
  await app.until(`${sftp}.session?.state === 'connected' && ${hasRow('remote', 'readme.txt')}`, 'connected with a key, login folder listed');
  const crumbs = await ev(`[...document.querySelectorAll('.sftp-pane-remote .sftp-crumb button')].map((b) => b.textContent).join('|')`);
  if (crumbs !== '/|home|alice') throw new Error(`remote crumbs: ${crumbs}`);
  const cols = await ev(`[...document.querySelectorAll('.sftp-pane-remote .sftp-columns .sftp-col')].map((c) => c.textContent).join('|')`);
  if (!cols.includes('Uprawnienia') || !cols.includes('Właściciel')) throw new Error(`remote columns: ${cols}`);
  // At 1440x900 every column is on screen in both panes, and no column is cut off by the pane edge.
  const shown = (side) => ev(`[...document.querySelectorAll('.sftp-pane-${side} .sftp-columns .sftp-col')].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.textContent).join('|')`);
  const remoteShown = await shown('remote'), localShown = await shown('local');
  if (remoteShown !== 'Nazwa|Data modyfikacji|Rozmiar|Rodzaj|Uprawnienia|Właściciel') throw new Error(`remote columns on screen: ${remoteShown}`);
  if (localShown !== 'Nazwa|Data modyfikacji|Rozmiar|Rodzaj') throw new Error(`local columns on screen: ${localShown}`);
  const overflow = await ev(`[...document.querySelectorAll('.sftp-pane .sftp-columns')].some((r) => r.scrollWidth > r.clientWidth + 1)`);
  if (overflow) throw new Error('a column row overflows its pane');
  const heads = await ev(`[...document.querySelectorAll('.sftp-pane-head')].map((h) => h.offsetHeight).join('|')`);
  if (new Set(heads.split('|')).size !== 1) throw new Error(`pane heads differ in height: ${heads}`);
  if (!(await ev(`[...document.querySelectorAll('.sftp-pane-remote .sftp-row')].some((r) => r.textContent.includes('-rw'))`))) throw new Error('no permission string shown');
  await shot(app, 'connected');
  log('key login with host key prompt OK');

  // 3. New folder, rename (F2).
  await menu('remote', 'Nowy folder');
  await answerText('nowy');
  await app.until(hasRow('remote', 'nowy'), 'new remote folder');
  await clickRow('remote', 'nowy');
  await ev(`document.querySelector('.sftp-pane-remote .sftp-list').focus()`);
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
  await answerText('docs');
  await app.until(`${hasRow('remote', 'docs')} && !${hasRow('remote', 'nowy')}`, 'renamed remote folder');
  if (!existsSync(join(home, 'docs'))) throw new Error('docs not on the server disk');
  log('new folder and rename OK');

  // 4. Upload a file and a folder by a drag from the local pane (into the folder "docs" under the pointer, then the pane).
  // A forged drop first: nothing is uploaded.
  await forgedDrop('local', [join(local, 'b.txt')], 'remote');
  await sleep(800);
  if ((await ev(`${sftp}.transfers.length + ${sftp}.preparing.length`)) !== 0) throw new Error('a forged drag payload started a transfer');
  await dragDrop('local', ['b.txt'], 'remote', 'docs');
  await app.until(allDone, 'upload into docs');
  if (!existsSync(join(home, 'docs', 'b.txt'))) throw new Error('drop onto a folder row did not upload into it');
  await clearDone();
  await dragDrop('local', ['a.txt', 'site'], 'remote');
  await app.until(`${allDone} && ${hasRow('remote', 'a.txt')}`, 'upload of a file and a folder');
  if (readFileSync(join(home, 'site', 'css', 'a.css'), 'utf8') !== 'body{}\n') throw new Error('folder upload content');
  if (!existsSync(join(home, 'site', 'img', 'logo.txt'))) throw new Error('the existing remote folder content was lost on merge');
  await shot(app, 'uploaded');
  await clearDone();
  log('upload by drag OK');

  // 5. Download back into a new local folder (local New folder, open it, drag from the remote pane).
  await menu('local', 'Nowy folder');
  await answerText('back');
  await app.until(hasRow('local', 'back'), 'local folder');
  await ev(`(() => { const r = [...document.querySelectorAll('.sftp-pane-local .sftp-row')].find((x) => x.dataset.name === 'back'); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  await app.until(`document.querySelector('.sftp-pane-local .sftp-crumb button.on')?.textContent === 'back'`, 'into back');
  await dragDrop('remote', ['site', 'readme.txt'], 'local');
  await app.until(`${allDone} && ${hasRow('local', 'site')} && ${hasRow('local', 'readme.txt')}`, 'download back');
  if (readFileSync(join(local, 'back', 'site', 'img', 'logo.txt'), 'utf8') !== 'logo\n') throw new Error('folder download content');
  await clearDone();
  // Back to the local root with the back button.
  await app.click('.sftp-pane-local .sftp-pathbar .btn[aria-label="Wstecz"]');
  await app.until(hasRow('local', 'a.txt'), 'back in the local root');
  log('download OK');

  // 6. Conflicts: Overwrite, Skip, Keep both, then "do the same for the rest" with two files.
  writeFileSync(join(local, 'a.txt'), 'local a v2\n');
  const upload = (names) => ev(`(async () => { const s = ${sftp}; const r = await window.mc.sftp.enqueue(s.sessionId, { direction: 'upload', sources: ${JSON.stringify(names.map((n) => join(local, n)))}, targetDir: '/home/alice' }); return r.ok; })()`);
  // The Upload button with a selection (Ctrl click adds the second file).
  await clickRow('local', 'a.txt');
  await app.click('.sftp-pane-local .sftp-send');
  await app.until(`document.querySelector('.modal h3')?.textContent === 'Konflikt nazw'`, 'conflict question');
  await shot(app, 'conflict');
  await dialogChoose('Zastąp');
  await app.until(allDone, 'overwrite done');
  if (readFileSync(join(home, 'a.txt'), 'utf8') !== 'local a v2\n') throw new Error('overwrite did not replace the file');
  await clearDone();
  writeFileSync(join(local, 'a.txt'), 'local a v3\n');
  await upload(['a.txt']);
  await dialogChoose('Pomiń');
  await app.until(`${allDone} && ${sftp}.transfers[0].skipped === true`, 'skip done');
  if (readFileSync(join(home, 'a.txt'), 'utf8') !== 'local a v2\n') throw new Error('skip changed the file');
  await clearDone();
  await upload(['a.txt']);
  await dialogChoose('Zachowaj oba');
  await app.until(`${allDone} && ${hasRow('remote', 'a (1).txt')}`, 'keep both');
  await clearDone();
  writeFileSync(join(home, 'b.txt'), 'remote b\n');
  await upload(['a.txt', 'b.txt']);
  await dialogChoose('Zachowaj oba', true);
  await app.until(`${allDone} && ${hasRow('remote', 'b (1).txt')} && ${hasRow('remote', 'a (2).txt')}`, 'keep both for the rest');
  const questions = await ev(`!!document.querySelector('.modal')`);
  if (questions) throw new Error('a second conflict question came although "do the same for the rest" was ticked');
  await clearDone();
  log('conflicts OK');

  // 7. Progress, then Cancel: no part file stays.
  await upload(['big.bin']);
  await app.until(`(() => { const i = ${sftp}.transfers[0]; return i?.state === 'running' && i.bytesDone > 0; })()`, 'big upload running');
  await app.until(`!!document.querySelector('.sftp-transfer.running') && parseInt(document.querySelector('.sftp-transfers-head .sftp-percent').textContent) >= 0`, 'progress row');
  await sleep(400);
  await shot(app, 'progress');
  await app.click('.sftp-transfer.running .btn', 'Anuluj');
  await app.until(`${sftp}.transfers[0]?.state === 'cancelled'`, 'cancelled');
  await sleep(500);
  const leftovers = remoteFiles().filter((n) => n.endsWith('.unimux-part') || n === 'big.bin');
  if (leftovers.length) throw new Error(`cancel left ${leftovers}`);
  await app.until(`!!document.querySelector('.sftp-transfer.cancelled .btn') && [...document.querySelectorAll('.sftp-transfer.cancelled .btn')].some((b) => b.textContent === 'Ponów')`, 'retry offered');
  await clearDone();
  log('cancel without a part file OK');

  // 8. Delete with a confirmation naming what goes (recursive count from the server).
  await clickRow('remote', 'docs');
  await clickRow('remote', 'site', { ctrl: true });
  await ev(`document.querySelector('.sftp-pane-remote .sftp-list').focus()`);
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await app.until(`document.querySelector('.modal h3')?.textContent.startsWith('Usunąć z serwera (2)')`, 'delete question');
  const body = await ev(`document.querySelector('.modal .modal-body').textContent`);
  if (!body.includes('docs') || !body.includes('site') || !/Plików: 4, folderów: 4/.test(body)) throw new Error(`delete question body: ${body}`);
  await shot(app, 'delete');
  await dialogChoose('Usuń z serwera');
  await app.until(`!${hasRow('remote', 'docs')} && !${hasRow('remote', 'site')}`, 'deleted');
  if (existsSync(join(home, 'site')) || existsSync(join(home, 'docs'))) throw new Error('delete left files on the server');
  log('delete OK');

  // 9. A drop from the OS (real file paths through CDP; the pane reads them with window.mc.pathForFile).
  const box = await ev(`(() => { const r = document.querySelector('.sftp-pane-remote .sftp-list').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 20 }; })()`);
  const data = { items: [], files: [join(local, 'os-drop.txt')], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await app.cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
  await app.until(`${allDone} && ${hasRow('remote', 'os-drop.txt')}`, 'OS drop uploaded');
  if (readFileSync(join(home, 'os-drop.txt'), 'utf8') !== 'dropped from the OS\n') throw new Error('OS drop content');
  await clearDone();
  log('OS drop OK');

  // 10. Switching host while a transfer runs asks first; then the password host signs in with a prompt in the view.
  await upload(['big.bin']);
  await app.until(`${sftp}.transfers[0]?.state === 'running'`, 'running before the switch');
  await app.click('.sftp-pane-remote .sftp-host-chip');
  await app.until(`!!document.querySelector('.sftp-picker')`, 'picker over the session');
  await app.click('.sftp-host-option', 'vps-password');
  await app.until(`document.querySelector('.modal h3')?.textContent === 'Przerwać transfery i zmienić host?'`, 'switch question');
  await shot(app, 'switch-ask');
  await dialogChoose('Zmień host');
  await app.until(`!!document.querySelector('.sftp-prompt input[type=password]')`, 'password prompt in the view');
  await shot(app, 'password');
  await app.setValue('.sftp-prompt input[type=password]', server.password);
  await app.click('.sftp-prompt button[type=submit]');
  await app.until(`${sftp}.session?.state === 'connected' && ${hasRow('remote', 'os-drop.txt')}`, 'connected with a password');
  await app.until(`${sftp}.transfers.every((i) => i.state !== 'running' && i.state !== 'queued')`, 'old transfer ended');
  await sleep(500);
  if (remoteFiles().some((n) => n.endsWith('.unimux-part'))) throw new Error('the switch left a part file');
  await clearDone();
  log('host switch and password login OK');

  // 11. "Otwórz SFTP tutaj" from a connected SSH cell after its shell reported a folder with OSC 7.
  mkdirSync(join(home, 'proj x'), { recursive: true });
  writeFileSync(join(home, 'proj x', 'inside.txt'), 'x\n');
  await ev(`document.querySelector('.workspace-tabs .grid-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
  await app.until(`!!document.querySelector('.ssh-card button')`, 'cell connect card');
  await app.click('.ssh-card button', 'Połącz');
  await app.until(`(() => { const c = document.querySelector('.cell'); return c && !c.querySelector('.ssh-card') && !c.querySelector('.status-text.ssh'); })()`, 'cell connected (key, known host)');
  await ev(`(() => { window.__mc.terminals.post({ t: 'write', id: ${JSON.stringify(cellId)}, data: 'cd /home/alice/proj x\\r' }); return true; })()`);
  await app.until(`window.__mc.terminals.remoteCwd(${JSON.stringify(cellId)}) === '/home/alice/proj x'`, 'OSC 7 folder noted');
  await app.click('.cell-head .ssh-host');
  await app.click('.menu .menu-item', 'Otwórz SFTP tutaj');
  await app.until(`!!document.querySelector('.sftp-view') && getComputedStyle(document.querySelector('.sftp-host')).display !== 'none' && ${hasRow('remote', 'inside.txt')} && document.querySelector('.sftp-pane-remote .sftp-crumb button.on')?.textContent === 'proj x'`, 'SFTP opened in the cell folder');
  await shot(app, 'open-here');
  log('Otwórz SFTP tutaj with OSC 7 OK');

  // 12. Local delete goes to the (scratch) trash; the palette entry opens the picker.
  await clickRow('local', 'back');
  await menu('local', 'Przenieś do kosza');
  await dialogChoose('Przenieś do kosza');
  await app.until(`!${hasRow('local', 'back')}`, 'local trash');
  if (existsSync(join(local, 'back'))) throw new Error('local trash left the folder');
  // Remembered folders: the last local folder and the remote one per host are in the state.
  const places = await ev(`window.__mc.useStore.getState().s.sftp`);
  if (places.localPath !== local || places.remotePaths[keyHost.id] !== '/home/alice/proj x' || places.remotePaths[pwHost.id] !== '/home/alice') throw new Error(`remembered places: ${JSON.stringify(places)}`);
  // A narrow window still shows both panes without overflow.
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await shot(app, 'narrow');
  log('local trash, remembered folders, narrow window OK');

  // 13. Closing the window (the last one, so the app would quit) while a transfer runs asks first; Cancel keeps the app and the
  // transfer goes on.
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await upload(['big.bin']);
  await app.until(`${sftp}.transfers[0]?.state === 'running' && ${sftp}.transfers[0].bytesDone > 0`, 'running before the quit');
  await main.evaluate(`__el.BrowserWindow.getAllWindows()[0].close(), true`);
  await app.until(`document.querySelector('.modal h3')?.textContent === 'Zamknąć aplikację w trakcie transferów?'`, 'quit question about the transfers');
  const quitBody = await ev(`document.querySelector('.modal .modal-body').textContent`);
  if (!quitBody.includes('Transfery w toku: 1.')) throw new Error(`quit question body: ${quitBody}`);
  await shot(app, 'quit-ask');
  const before = await ev(`${sftp}.transfers[0].bytesDone`);
  await dialogChoose('Anuluj');
  await sleep(1500);
  if ((await main.evaluate(`__el.BrowserWindow.getAllWindows().length`)) !== 1) throw new Error('the window closed after Cancel');
  const after = await ev(`${sftp}.transfers[0]`);
  if (!['running', 'done'].includes(after.state) || (after.state === 'running' && after.bytesDone <= before)) throw new Error(`the transfer did not go on after Cancel: ${JSON.stringify({ state: after.state, before, after: after.bytesDone })}`);
  log(`after Cancel the transfer is ${after.state} (${before} -> ${after.bytesDone} bytes)`);
  // "Zakończ mimo to" is not chosen here: the script closes the app itself.
  if (after.state === 'running') await app.click('.sftp-transfer.running .btn', 'Anuluj');
  await app.until(`${sftp}.transfers.every((i) => i.state !== 'running' && i.state !== 'queued')`, 'transfer ended');
  log('quit with a running transfer asks, Cancel keeps it running OK');
  process.stdout.write('verify-sftp-ui: all OK\n');
} catch (error) {
  if (app) await shot(app, 'failure').catch(() => undefined);
  process.stdout.write(`verify-sftp-ui: FAILED ${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  main?.close();
  await app?.close();
  server.stop();
  await sleep(500);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}
