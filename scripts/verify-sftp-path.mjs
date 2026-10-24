// node scripts/verify-sftp-path.mjs - real-app check of the typed path in the SFTP path bar (1.0.8) against the local test
// server only (scripts/ssh-test-server.mjs --sftp-root <scratch>). Never a real host, the user's data dir, home or ~/.ssh.
// Needs `npm run build` first. Screenshots go to D:\Projekty\_shots\108-sftp-path-*.png.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { launchApp, scratchRoot, sleep, startTestServer, testHost, writeState } from './ssh-ui-lib.mjs';

const shot = (app, name) => app.screenshot(`108-sftp-path-${name}.png`);
const log = (m) => process.stdout.write(`  ${m}\n`);

const root = scratchRoot('sftppath');
const remoteRoot = join(root, 'remote');
const home = join(remoteRoot, 'home', 'alice');
const local = join(root, 'local');
for (const dir of [join(home, 'site', 'img'), join(home, 'site', 'include'), join(home, 'logs'), join(remoteRoot, 'etc', 'nginx'), join(local, 'Projekty', 'app'), join(local, 'Projekty', 'api'), join(local, 'Pobrane')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(home, 'readme.txt'), 'remote readme\n');
writeFileSync(join(remoteRoot, 'etc', 'nginx', 'nginx.conf'), 'events {}\n');
writeFileSync(join(local, 'Projekty', 'api', 'notes.md'), '# notes\n');
const pair = ssh2.utils.generateKeyPairSync('ed25519');
writeFileSync(join(root, 'user.pub'), pair.public);
const server = await startTestServer(['--sftp-root', remoteRoot, '--sftp-home', '/home/alice', '--public-key-file', join(root, 'user.pub')]);
const host = testHost(server.port, { label: 'vps-key' });
const projectId = '7a3a5d30-2f45-4d61-9d6b-1b0f6a3c1b01';
mkdirSync(join(root, 'project'), { recursive: true });
writeState(root, {
  version: 1, settings: { language: 'pl' }, sshHosts: [host], activeProjectId: projectId, sftp: { localPath: local, remotePaths: {} },
  projects: [{ id: projectId, name: 'sftp-path', path: join(root, 'project'), color: '#3b82f6', activeTabId: null, archive: [], tabs: [] }],
});

let app;
try {
  app = await launchApp(root);
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const ev = app.evaluate;
  const sftp = `window.__mc.useSftpStore.getState()`;
  const rowsOf = (side) => `[...document.querySelectorAll('.sftp-pane-${side} .sftp-list .sftp-row')].map((r) => r.dataset.name)`;
  const hasRow = (side, name) => `${rowsOf(side)}.includes(${JSON.stringify(name)})`;
  const crumbsOf = (side) => ev(`[...document.querySelectorAll('.sftp-pane-${side} .sftp-crumb button')].map((b) => b.textContent).join('|')`);
  const field = (side) => `.sftp-pane-${side} .sftp-path-input`;
  const fieldState = (side) => ev(`(() => { const i = document.querySelector('${field(side)}'); return i ? { value: i.value, start: i.selectionStart, end: i.selectionEnd, focused: document.activeElement === i } : null; })()`);
  const keyIn = async (key, code, vk, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
  };
  /** Opens the field by a click on the empty end of the bar. */
  const clickBar = async (side) => {
    await ev(`(() => { const r = document.querySelector('.sftp-pane-${side} .sftp-crumbs-rest'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: b.left + 4, clientY: b.top + 4 })); return true; })()`);
    await app.until(`document.activeElement === document.querySelector('${field(side)}')`, `${side} field focused`);
  };
  /** Replaces the field's text by typing (real key events, so the suggestions follow). */
  const typeIn = async (side, text) => {
    await ev(`(() => { const i = document.querySelector('${field(side)}'); i.focus(); i.select(); return true; })()`);
    await app.insertText(text);
  };
  const selectedRows = (side) => ev(`[...document.querySelectorAll('.sftp-pane-${side} .sftp-list .sftp-row.on')].map((r) => r.dataset.name).join('|')`);

  // Open the view; the local pane starts in the remembered folder.
  await app.click('.rail-tiles [aria-label="SSH"]');
  await app.until(`!!document.querySelector('.ssh-nav-item[data-section="sftp"]') && !document.querySelector('.ssh-nav-item[data-section="sftp"]').disabled`, 'SFTP entry enabled');
  await app.click('.ssh-nav-item[data-section="sftp"]');
  await app.until(hasRow('local', 'Projekty'), 'local pane listed');

  // ── local pane ──
  await clickBar('local');
  let st = await fieldState('local');
  if (st.value !== local || st.start !== 0 || st.end !== local.length) throw new Error(`local field does not start with the whole path selected: ${JSON.stringify(st)}`);
  await shot(app, 'local-edit');
  // Ctrl+C in the field copies the selected path (the native field copy).
  await ev(`window.mc.clipboardWrite('')`);
  await keyIn('c', 'KeyC', 67, 2);
  await sleep(200);
  const copied = await ev(`window.mc.clipboardRead()`);
  if (copied !== local) throw new Error(`Ctrl+C copied ${JSON.stringify(copied)}`);
  // Escape gives the crumbs back without moving.
  await keyIn('Escape', 'Escape', 27);
  await app.until(`!document.querySelector('${field('local')}') && document.activeElement === document.querySelector('.sftp-pane-local .sftp-list')`, 'Escape closes the local field');
  log('local field: click, whole path selected, Ctrl+C, Escape OK');

  // A relative path typed with "/" separators, completion with Tab.
  await ev(`document.querySelector('.sftp-pane-local .sftp-list').focus()`);
  await keyIn('l', 'KeyL', 76, 2); // Ctrl+L from the list
  await app.until(`document.activeElement === document.querySelector('${field('local')}')`, 'Ctrl+L opens the field');
  await typeIn('local', 'Proj');
  await app.until(`document.querySelectorAll('.sftp-pane-local .sftp-path-suggestions li').length === 1`, 'suggestion for Proj');
  await keyIn('Tab', 'Tab', 9);
  st = await fieldState('local');
  if (st.value !== 'Projekty\\' || !st.focused) throw new Error(`Tab completion: ${JSON.stringify(st)}`);
  await app.until(`[...document.querySelectorAll('.sftp-pane-local .sftp-path-suggestions li')].map((l) => l.textContent).join('|') === 'api|app'`, 'suggestions in Projekty');
  await shot(app, 'local-suggestions');
  await app.insertText('ap');
  await app.until(`document.querySelectorAll('.sftp-pane-local .sftp-path-suggestions li').length === 2`, 'two suggestions for ap');
  await keyIn('ArrowDown', 'ArrowDown', 40);
  await keyIn('ArrowDown', 'ArrowDown', 40);
  await keyIn('Enter', 'Enter', 13);
  await app.until(`document.querySelector('.sftp-pane-local .sftp-crumb button.on')?.textContent === 'app'`, 'Enter on the second suggestion goes to app');
  if (await ev(`!!document.querySelector('${field('local')}')`)) throw new Error('field still open after Enter');
  log('local: Ctrl+L, Tab completion, arrows, Enter OK');

  // .. and a file path: its folder opens with the file selected.
  await ev(`document.querySelector('.sftp-pane-local .sftp-list').focus()`);
  await keyIn('F4', 'F4', 115);
  await app.until(`document.activeElement === document.querySelector('${field('local')}')`, 'F4 opens the field');
  await typeIn('local', '..\\api\\notes.md');
  await keyIn('Enter', 'Enter', 13);
  await app.until(`document.querySelector('.sftp-pane-local .sftp-crumb button.on')?.textContent === 'api'`, 'file path opens its folder');
  await app.until(`[...document.querySelectorAll('.sftp-pane-local .sftp-list .sftp-row.on')].map((r) => r.dataset.name).join('|') === 'notes.md'`, 'the file is selected');
  await shot(app, 'local-file-selected');
  log('local: file path opens its folder with the file selected OK');

  // An absolute path with forward slashes, in another case, with a trailing slash.
  await clickBar('local');
  await typeIn('local', `${local.replace(/\\/g, '/').toLowerCase()}/pobrane/`);
  await keyIn('Enter', 'Enter', 13);
  await app.until(`document.querySelector('.sftp-pane-local .sftp-crumb button.on')?.textContent.toLowerCase() === 'pobrane'`, 'absolute path with slashes');
  // A path that does not exist: an inline error, the field stays with the text, the pane stays.
  await clickBar('local');
  await typeIn('local', 'nie-ma-takiego');
  await keyIn('Enter', 'Enter', 13);
  await app.until(`!!document.querySelector('.sftp-pane-local .sftp-path-error')`, 'inline error');
  st = await fieldState('local');
  if (st.value !== 'nie-ma-takiego' || !st.focused) throw new Error(`the field after an error: ${JSON.stringify(st)}`);
  const err = await ev(`document.querySelector('.sftp-pane-local .sftp-path-error').textContent`);
  if (err !== 'Plik lub folder nie istnieje') throw new Error(`error text: ${err}`);
  if (await ev(`!!document.querySelector('.sftp-pane-local .sftp-status .sftp-error')`)) throw new Error('the error also went to the status line');
  await shot(app, 'local-error');
  await typeIn('local', 'C:\\a|b');
  await keyIn('Enter', 'Enter', 13);
  await app.until(`document.querySelector('.sftp-pane-local .sftp-path-error')?.textContent === 'Nieprawidłowa ścieżka lub nazwa'`, 'invalid path error');
  await keyIn('Escape', 'Escape', 27);
  await app.until(`!document.querySelector('${field('local')}')`, 'Escape after the error');
  log('local: absolute path, missing path and invalid path errors OK');

  // ── remote pane ──
  const imported = await ev(`window.mc.ssh.draftFromText({ privateKey: ${JSON.stringify(pair.private)} }).then((d) => d.ok ? window.mc.ssh.commitDraft({ draftId: d.draftId, label: 'check-key', savePassphrase: false }) : d)`);
  if (!imported.ok) throw new Error(`key import failed: ${JSON.stringify(imported)}`);
  await ev(`(() => { window.__mc.useStore.getState().update((s) => ({ ...s, sshHosts: s.sshHosts.map((h) => h.id === ${JSON.stringify(host.id)} ? { ...h, keyId: ${JSON.stringify(imported.key.id)} } : h) })); return true; })()`);
  await app.click('.sftp-connect .btn', 'Wybierz host');
  await app.until(`document.querySelectorAll('.sftp-picker .sftp-host-option').length === 1`, 'host picker');
  await app.click('.sftp-host-option', 'vps-key');
  await app.until(`!!document.querySelector('.sftp-prompt .ssh-fingerprint')`, 'host key prompt');
  await app.click('.sftp-prompt .btn', 'Zaufaj i zapisz');
  await app.until(`${sftp}.session?.state === 'connected' && ${hasRow('remote', 'readme.txt')}`, 'connected');
  if (await crumbsOf('remote') !== '/|home|alice') throw new Error(`remote crumbs: ${await crumbsOf('remote')}`);

  // Breadcrumbs: a click on a segment goes there.
  await app.click('.sftp-pane-remote .sftp-crumb button', 'home');
  await app.until(`document.querySelector('.sftp-pane-remote .sftp-crumb button.on')?.textContent === 'home' && ${hasRow('remote', 'alice')}`, 'crumb click');
  // The copy button and the bar's menu.
  await ev(`window.mc.clipboardWrite('')`);
  await app.click('.sftp-pane-remote .sftp-copy-path');
  await sleep(200);
  if (await ev(`window.mc.clipboardRead()`) !== '/home') throw new Error('copy button');
  await ev(`(() => { const n = document.querySelector('.sftp-pane-remote .sftp-crumbs'); const b = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.right - 20, clientY: b.top + 8 })); return true; })()`);
  await app.until(`!!document.querySelector('.menu')`, 'bar menu');
  const barMenu = await ev(`[...document.querySelectorAll('.menu .menu-item')].map((e) => e.textContent).join('|')`);
  if (!barMenu.includes('Edytuj ścieżkę') || !barMenu.includes('Kopiuj ścieżkę')) throw new Error(`bar menu: ${barMenu}`);
  await shot(app, 'bar-menu');
  await ev(`(() => { [...document.querySelectorAll('.menu .menu-item')].find((e) => e.textContent.includes('Edytuj ścieżkę')).click(); return true; })()`);
  await app.until(`document.activeElement === document.querySelector('${field('remote')}')`, 'menu opens the field');
  st = await fieldState('remote');
  if (st.value !== '/home' || st.start !== 0 || st.end !== 5) throw new Error(`remote field: ${JSON.stringify(st)}`);
  log('remote: crumbs, copy button, bar menu OK');

  // ~ and completion of an absolute path.
  await typeIn('remote', '~/si');
  await app.until(`[...document.querySelectorAll('.sftp-pane-remote .sftp-path-suggestions li')].map((l) => l.textContent).join('|') === 'site'`, '~ suggestion');
  await keyIn('Tab', 'Tab', 9);
  if ((await fieldState('remote')).value !== '~/site/') throw new Error('remote Tab');
  await app.until(`[...document.querySelectorAll('.sftp-pane-remote .sftp-path-suggestions li')].map((l) => l.textContent).join('|') === 'img|include'`, 'site suggestions');
  await app.insertText('i');
  await keyIn('Tab', 'Tab', 9);
  if ((await fieldState('remote')).value !== '~/site/i') throw new Error('Tab with two matches and no longer common start must keep the text');
  await shot(app, 'remote-suggestions');
  await app.insertText('mg/../include//');
  await keyIn('Enter', 'Enter', 13);
  await app.until(`${JSON.stringify('/|home|alice|site|include')} === [...document.querySelectorAll('.sftp-pane-remote .sftp-crumb button')].map((b) => b.textContent).join('|')`, '~ with .. and //');
  log('remote: ~, Tab, suggestions, .. and // OK');

  // A file path on the server, a relative path, an error, Alt+D.
  await ev(`document.querySelector('.sftp-pane-remote .sftp-list').focus()`);
  await keyIn('d', 'KeyD', 68, 1); // Alt+D
  await app.until(`document.activeElement === document.querySelector('${field('remote')}')`, 'Alt+D opens the field');
  await typeIn('remote', '/etc/nginx/nginx.conf');
  await keyIn('Enter', 'Enter', 13);
  await app.until(`document.querySelector('.sftp-pane-remote .sftp-crumb button.on')?.textContent === 'nginx'`, 'remote file path opens its folder');
  await app.until(`${JSON.stringify('nginx.conf')} === [...document.querySelectorAll('.sftp-pane-remote .sftp-list .sftp-row.on')].map((r) => r.dataset.name).join('|')`, 'remote file selected');
  await shot(app, 'remote-file-selected');
  await clickBar('remote');
  await typeIn('remote', '../../nope');
  await keyIn('Enter', 'Enter', 13);
  await app.until(`!!document.querySelector('.sftp-pane-remote .sftp-path-error')`, 'remote error');
  if ((await fieldState('remote')).value !== '../../nope') throw new Error('remote field lost the text');
  await shot(app, 'remote-error');
  await typeIn('remote', '..');
  await keyIn('Enter', 'Enter', 13);
  await app.until(`document.querySelector('.sftp-pane-remote .sftp-crumb button.on')?.textContent === 'etc'`, 'relative ..');
  // The back button returns to the folder before the typed one.
  await app.click('.sftp-pane-remote .sftp-pathbar .btn[aria-label="Wstecz"]');
  await app.until(`document.querySelector('.sftp-pane-remote .sftp-crumb button.on')?.textContent === 'nginx'`, 'back after a typed path');
  log('remote: file path, error, relative path, Alt+D, history OK');

  // Long path: the bar keeps the end in view.
  await shot(app, 'final');
  log('ALL OK');
} finally {
  await app?.close();
  server.stop();
  await sleep(500);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}
