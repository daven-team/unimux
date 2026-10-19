// node scripts/verify-sftp-edit.mjs - real-app check of SFTP files in editor tabs (0.9.9) against the local test server only
// (scripts/ssh-test-server.mjs --sftp-root <scratch>). Never a real host, never the user's data dir, home or ~/.ssh.
// Needs `npm run build` first. Screenshots go to D:\Projekty\_shots\099-edit-*.png.
//
// Opens a remote text file in a tab (host badge, "host:/path" tooltip), edits it and saves with Ctrl+S (the server file
// changes, no part file stays, the mode is kept), changes it on the server meanwhile (the conflict choices; Show differences;
// Overwrite), lets a clean tab follow a server change when it gets focus, opens an image (preview), a big file and a binary
// (the download offer), disconnects and saves again (the login prompt inside the tab, then the save), opens a local file
// outside the projects, and checks that an unsaved remote draft survives a window reload.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

const shot = (app, name) => app.screenshot(`099-edit-${name}.png`);
const log = (m) => process.stdout.write(`  ${m}\n`);

const root = scratchRoot('sftp-edit');
const remoteRoot = join(root, 'remote');
const home = join(remoteRoot, 'home', 'alice');
const local = join(root, 'local');
for (const dir of [home, local]) mkdirSync(dir, { recursive: true });
const notes = join(home, 'notes.txt');
writeFileSync(notes, 'line one\nline two\n');
chmodSync(notes, 0o640);
// A 4x4 red PNG.
writeFileSync(join(home, 'logo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC', 'base64'));
writeFileSync(join(home, 'big.log'), Buffer.alloc(9 * 1024 * 1024, 0x61));
writeFileSync(join(home, 'data.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1, 2, 3]));
writeFileSync(join(local, 'local.txt'), 'local text\n');

const server = await startTestServer(['--sftp-root', remoteRoot, '--sftp-home', '/home/alice']);
const host = testHost(server.port, { label: 'vps' });
const projectId = '7a3a5d30-2f45-4d61-9d6b-1b0f6a3c1b01';
mkdirSync(join(root, 'project'), { recursive: true });
writeKnownHost(root, server);
writeState(root, {
  version: 1, settings: { language: 'pl' }, sshHosts: [host], activeProjectId: projectId, sftp: { localPath: local, remotePaths: {} },
  projects: [{ id: projectId, name: 'edit-check', path: join(root, 'project'), color: '#3b82f6', activeTabId: null, archive: [], tabs: [] }],
});

let app;
try {
  app = await launchApp(root);
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const ev = app.evaluate;
  const ctrl = 2;
  const sftp = `window.__mc.useSftpStore.getState()`;
  const docs = `window.__mc.useFileStore.getState().documents`;
  const hasRow = (side, name) => `[...document.querySelectorAll('.sftp-pane-${side} .sftp-list .sftp-row')].some((r) => r.dataset.name === ${JSON.stringify(name)})`;
  const dblRow = (side, name) => ev(`(() => { const r = [...document.querySelectorAll('.sftp-pane-${side} .sftp-list .sftp-row')].find((x) => x.dataset.name === ${JSON.stringify(name)}); if (!r) throw new Error('no row ${name}'); r.dispatchEvent(new MouseEvent('click', { bubbles: true })); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  const editorText = `(document.querySelector('.file-editor .cm-content')?.textContent ?? '')`;
  const setText = async (value) => {
    await ev('document.querySelector(".file-editor .cm-content").focus()');
    for (const type of ['keyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: ctrl });
    await app.cdp('Input.insertText', { text: value });
  };
  const save = async () => {
    await ev('document.querySelector(".file-editor .cm-content").focus()');
    for (const type of ['keyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: ctrl });
  };
  const waitFile = async (path, expected, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) { if (existsSync(path) && readFileSync(path, 'utf8') === expected) return; await sleep(150); }
    throw new Error(`timeout: ${label}: ${existsSync(path) ? JSON.stringify(readFileSync(path, 'utf8').slice(0, 200)) : 'missing'}`);
  };
  const noPartFiles = () => { const left = readdirSync(home).filter((n) => n.includes('.unimux-')); if (left.length) throw new Error(`part files left: ${left}`); };
  const openSftpView = async () => {
    await app.click('.workspace-tabs .ssh-tab');
    await app.until(`!!document.querySelector('.sftp-view') && document.querySelector('.sftp-view').offsetParent !== null`, 'SFTP view shown');
  };

  // 1. Connect the SFTP view (password in the view; the host key is known).
  await app.click('.rail-tiles [aria-label="SSH"]');
  await app.until(`!!document.querySelector('.ssh-nav-item[data-section="sftp"]') && !document.querySelector('.ssh-nav-item[data-section="sftp"]').disabled`, 'SFTP entry');
  await app.click('.ssh-nav-item[data-section="sftp"]');
  await app.until(`!!document.querySelector('.sftp-view .sftp-connect')`, 'SFTP empty state');
  await app.click('.sftp-connect .btn', 'Wybierz host');
  await app.click('.sftp-host-option', 'vps');
  await app.until(`!!document.querySelector('.sftp-prompt input[type=password]')`, 'password prompt in the view');
  await app.setValue('.sftp-prompt input[type=password]', server.password);
  await app.click('.sftp-prompt button[type=submit]');
  await app.until(`${sftp}.session?.state === 'connected' && ${hasRow('remote', 'notes.txt')}`, 'connected');
  log('SFTP view connected');

  // 2. Double click opens the remote text file in a tab at the top: file name, host badge, "host:/path" tooltip.
  const modeBefore = statSync(notes).mode & 0o7777;
  await dblRow('remote', 'notes.txt');
  await app.until(`${editorText}.includes('line one') && !document.querySelector('.sftp-view')?.offsetParent`, 'remote file in the editor');
  const tab = await ev(`(() => { const t = document.querySelector('.workspace-tabs .file-tab.active'); return t && { label: t.querySelector('.label').textContent, host: t.querySelector('.tab-host-tag')?.textContent, title: t.title }; })()`);
  if (!tab || tab.label !== 'notes.txt' || tab.host !== 'vps' || tab.title !== 'vps:/home/alice/notes.txt') throw new Error(`remote tab: ${JSON.stringify(tab)}`);
  await shot(app, 'open');
  log(`remote tab ${JSON.stringify(tab)}`);
  // The same file again focuses the existing tab.
  await openSftpView();
  await dblRow('remote', 'notes.txt');
  await app.until(`${editorText}.includes('line one')`, 'focused again');
  if ((await ev(`${docs}.filter((d) => d.relativePath === '/home/alice/notes.txt').length`)) !== 1) throw new Error('the file opened twice');
  log('opening it again focuses the same tab');

  // 3. Edit + Ctrl+S: the server file changes, no part file stays, the mode is kept.
  await setText('line one\nedited in unimux\n');
  await app.until(`${editorText}.includes('edited in unimux') && !!document.querySelector('.editor-save-status.dirty')`, 'dirty');
  await save();
  await waitFile(notes, 'line one\nedited in unimux\n', 'saved to the server');
  await app.until(`!document.querySelector('.editor-save-status.dirty')`, 'clean after save');
  noPartFiles();
  if ((statSync(notes).mode & 0o7777) !== modeBefore) throw new Error(`mode changed: ${modeBefore.toString(8)} -> ${(statSync(notes).mode & 0o7777).toString(8)}`);
  await shot(app, 'saved');
  log(`Ctrl+S saved through the server, no part file, mode ${modeBefore.toString(8)} kept`);

  // 4. Changed on the server meanwhile: the save is refused with the three choices; Show differences; Overwrite.
  await setText('my version\n');
  await app.until(`${editorText}.includes('my version')`, 'edited again');
  writeFileSync(notes, 'changed on the server by someone else\n');
  await save();
  await app.until(`!!document.querySelector('.file-disk-conflict.error')`, 'save conflict');
  const choices = await ev(`[...document.querySelectorAll('.file-disk-conflict-actions button')].map((b) => b.textContent)`);
  const notice = await ev(`document.querySelector('.file-disk-conflict > span').textContent`);
  if (choices.length !== 3 || !choices[0].includes('serwera') || !notice.includes('serwerze')) throw new Error(`conflict: ${notice} ${JSON.stringify(choices)}`);
  if (readFileSync(notes, 'utf8') !== 'changed on the server by someone else\n') throw new Error('the conflicting save wrote the file');
  noPartFiles();
  await app.click('.file-disk-conflict-actions button', 'Pokaż różnice');
  await app.until(`!!document.querySelector('.file-conflict-diff .git-diff-line.add') && !!document.querySelector('.file-conflict-diff .git-diff-line.del')`, 'diff view');
  await shot(app, 'conflict');
  await app.click('.file-disk-conflict-actions button', 'Nadpisz');
  await waitFile(notes, 'my version\n', 'overwrite');
  await app.until(`!document.querySelector('.file-disk-conflict')`, 'conflict gone');
  noPartFiles();
  log(`conflict "${notice}" with ${JSON.stringify(choices)}; Show differences and Overwrite work`);

  // 5. A clean tab follows a change on the server when it gets focus again (no polling).
  writeFileSync(notes, 'server side update\n');
  await sleep(3200); // at most one check per few seconds
  await app.click('.workspace-tabs .ssh-tab');
  await app.click('.workspace-tabs .file-tab', 'notes.txt');
  await app.until(`${editorText}.includes('server side update')`, 'clean tab reloaded on focus', 15000);
  log('a clean tab reloaded the server change on focus');

  // 6. An image opens as a preview.
  await openSftpView();
  await dblRow('remote', 'logo.png');
  await app.until(`!!document.querySelector('.file-editor .image-view img')`, 'image preview');
  await shot(app, 'image');
  log('image preview OK');

  // 7. A big file offers a download instead of a tab; Pobierz puts it into the local pane's folder.
  await openSftpView();
  await dblRow('remote', 'big.log');
  await app.until(`(document.querySelector('.modal h3')?.textContent ?? '').includes('big.log')`, 'download offer for the big file');
  if (await ev(`${docs}.some((d) => d.relativePath === '/home/alice/big.log')`)) throw new Error('the big file got a tab');
  await shot(app, 'download');
  await app.click('.modal .modal-foot .btn', 'Pobierz');
  const t0 = Date.now();
  while (!(existsSync(join(local, 'big.log')) && statSync(join(local, 'big.log')).size === 9 * 1024 * 1024) && Date.now() - t0 < 30000) await sleep(200);
  if (!existsSync(join(local, 'big.log'))) throw new Error('the download did not arrive');
  log('big file: download offer, Pobierz downloaded it');
  // A binary file closes its new tab and offers the download too.
  await openSftpView();
  await dblRow('remote', 'data.bin');
  await app.until(`(document.querySelector('.modal h3')?.textContent ?? '').includes('data.bin')`, 'download offer for the binary');
  if (await ev(`${docs}.some((d) => d.relativePath === '/home/alice/data.bin')`)) throw new Error('the binary kept a tab');
  await app.click('.modal .modal-foot .btn', 'Anuluj');
  log('binary file: download offer, no tab');

  // 8. After a disconnect, Ctrl+S logs in again (the password question inside the tab) and saves.
  await openSftpView();
  await app.click('.sftp-pane-remote .sftp-actions');
  await app.until(`!!document.querySelector('.menu')`, 'actions menu');
  await ev(`(() => { const el = [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.trim() === 'Rozłącz'); el.click(); return true; })()`);
  await app.until(`!${sftp}.sessionId`, 'disconnected');
  await app.click('.workspace-tabs .file-tab', 'notes.txt');
  await app.until(`${editorText}.includes('server side update')`, 'notes tab');
  // A clean tab without a connection says its content may be outdated (it is not checked any more).
  await app.until(`!!document.querySelector('.remote-stale')`, 'stale notice on a clean tab without a session');
  log(`clean tab without a session: "${await ev(`document.querySelector('.remote-stale span').textContent`)}"`);
  await shot(app, 'stale');
  await setText('saved after a reconnect\n');
  await app.until(`!!document.querySelector('.remote-notice')`, 'no connection notice');
  await save();
  await app.until(`!!document.querySelector('.remote-login input[type=password]')`, 'password prompt inside the tab');
  await shot(app, 'reconnect');
  await app.setValue('.remote-login input[type=password]', server.password);
  await app.click('.remote-login button[type=submit]');
  await waitFile(notes, 'saved after a reconnect\n', 'save after reconnect');
  noPartFiles();
  log('save after a disconnect: login prompt in the tab, then saved');

  // 9. A local file outside the projects opens in a tab and saves to disk.
  await openSftpView();
  await dblRow('local', 'local.txt');
  await app.until(`${editorText}.includes('local text')`, 'local file in the editor');
  await setText('local text edited\n');
  await save();
  await waitFile(join(local, 'local.txt'), 'local text edited\n', 'local save');
  log('local file outside the projects: opened and saved');

  // 10. An unsaved remote draft survives a window reload (keyed by host + path).
  await app.click('.workspace-tabs .file-tab', 'notes.txt');
  await app.until(`${editorText}.includes('saved after a reconnect')`, 'notes tab again');
  await setText('draft across reload\n');
  await app.until(`${editorText}.includes('draft across reload')`, 'draft typed');
  await sleep(1000);
  await ev('location.reload(), true');
  await sleep(1500);
  await app.until(`!!document.querySelector('.app .workspace-tabs') && !!window.__mc?.useFileStore`, 'reloaded', 30000);
  await app.until(`${docs}.some((d) => d.relativePath === '/home/alice/notes.txt' && d.text === 'draft across reload\\n' && d.source?.kind === 'remote')`, 'remote draft restored');
  if (readFileSync(notes, 'utf8') !== 'saved after a reconnect\n') throw new Error('the draft was written');
  log('remote draft restored after a reload');

  process.stdout.write('verify-sftp-edit: all OK\n');
} catch (error) {
  if (app) await shot(app, 'failure').catch(() => undefined);
  if (app) process.stdout.write(`  state: ${await app.evaluate(`JSON.stringify({ editor: document.querySelector('.file-editor .cm-content')?.textContent?.slice(0, 80), sftpShown: !!document.querySelector('.sftp-view')?.offsetParent, modal: document.querySelector('.modal h3')?.textContent, error: document.querySelector('.file-editor [role=alert]')?.textContent })`).catch((e) => String(e))}\n`);
  process.stdout.write(`verify-sftp-edit: FAILED ${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  await app?.close();
  server.stop();
  await sleep(500);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}
