// node scripts/verify-ssh-paths.mjs  (after `npm run build`)
// Real-app check of 1.0.6 SSH path completion and session restore against scripts/ssh-test-server.mjs --shell-root (a fake
// shell over a scratch folder): `cd /sr` Tab, `vim TEST` Tab Tab Tab Shift+Tab, no popup inside vim, then a clean quit and a
// restart with "Przywracaj sesje SSH po ponownym uruchomieniu" on: the cell connects by itself into the same folder.
// Scratch data dir and home only (ssh-ui-lib.mjs); screenshots go to D:\Projekty\_shots\ssh-paths-*.png.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connected, connectWithPassword, killTree, launchApp, scratchRoot, sleep, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

const BUFFER = `(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId);
  const b = window.__mc.terminals.entries.get(t.cells[0].id)?.term.buffer.active; if (!b) return ''; let text = ''; for (let i = 0; i < b.length; i++) text += (b.getLine(i)?.translateToString(true) ?? '') + '\\n'; return text; })()`;
const CURSOR_LINE = `(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId);
  const b = window.__mc.terminals.entries.get(t.cells[0].id)?.term.buffer.active; return b ? (b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '') : ''; })()`;
const CELL = `(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); return p.tabs.find((x) => x.id === p.activeTabId).cells[0]; })()`;
const ITEMS = `[...document.querySelectorAll('.ssh-ac .ssh-ac-item .ssh-ac-text')].map((e) => e.textContent)`;
const SELECTED = `document.querySelector('.ssh-ac .ssh-ac-item.sel .ssh-ac-text')?.textContent ?? null`;

const root = scratchRoot('paths');
const remote = join(root, 'remote');
for (const dir of ['srv/ftp', 'srv/www', 'srv/backup', 'home/alice/docs', 'etc']) mkdirSync(join(remote, dir), { recursive: true });
for (let i = 1; i <= 10; i++) writeFileSync(join(remote, 'srv/ftp', `TEST${i}`), `test ${i}\n`);
writeFileSync(join(remote, 'srv/ftp', 'readme.txt'), 'hi\n');
writeFileSync(join(remote, 'srv/ftp', 'my notes.txt'), 'hi\n');
mkdirSync(join(remote, 'srv/ftp', 'TESTDATA'));

const server = await startTestServer(['--shell-root', remote, '--shell-home', '/home/alice']);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const tab = async (app, shift = false) => {
  for (const type of ['keyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
  await sleep(250);
};
const focus = (app) => app.evaluate(`(() => { window.__mc.terminals.focus(${CELL}.id); return true; })()`);
const lineIs = (app, text, label) => app.until(`${CURSOR_LINE}.trimEnd().endsWith(${JSON.stringify(text)})`, label, 8000);
/** A clean quit through the window (before-quit runs, unlike killing the process); the process is gone afterwards. */
async function quit(app) {
  await app.evaluate('window.close(), true').catch(() => undefined);
  for (let i = 0; i < 75; i++) {
    try { process.kill(app.pid, 0); } catch { return; }
    await sleep(200);
  }
  killTree(app.pid);
  throw new Error('the app did not quit');
}

try {
  writeKnownHost(root, server);
  const host = testHost(server.port, { label: 'ftp-server' });
  const state = sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] });
  writeState(root, state);

  // ── first run: turn the restore on in Settings, connect, complete paths ──
  let app = await launchApp(root);
  try {
    await app.click('button[aria-label="Ustawienia"]');
    await app.until(`!!document.querySelector('.settings-nav [role=tab]')`, 'settings page');
    await app.click('.settings-nav [role=tab]', 'SSH');
    await app.until(`!!document.querySelector('#settings-ssh-restore')`, 'restore switch');
    check(await app.evaluate(`!document.querySelector('#settings-ssh-restore').checked`), 'the restore is off by default');
    await app.click('#settings-ssh-restore');
    await app.until(`window.__mc.useStore.getState().s.settings.sshRestoreSessions === true`, 'restore on');
    await app.evaluate(`document.querySelector('#settings-ssh-path-complete').scrollIntoView({ block: 'center' }), true`);
    await app.screenshot('ssh-paths-settings-completion.png');
    await app.evaluate(`document.querySelector('#settings-ssh-restore').scrollIntoView({ block: 'center' }), true`);
    await app.screenshot('ssh-paths-settings-restore.png');
    await app.evaluate(`window.__mc.useStore.getState().setUi({ settingsTabOpen: false, settingsActive: false }), true`);
    await app.until(`!document.querySelector('.settings-tab')`, 'settings tab closed');

    await app.until(`!!document.querySelector('.cell .ssh-card')`, 'idle card');
    await app.click('.ssh-card button', 'Połącz');
    await connectWithPassword(app, server.password, { save: true });
    await connected(app);
    await app.until(`${BUFFER}.includes('alice@test-server:/home/alice$')`, 'prompt in /home/alice');
    await focus(app);
    await sleep(300);

    await app.insertText('cd /sr');
    await app.until(`${ITEMS}.length > 0`, 'popup for /sr', 8000);
    check(JSON.stringify(await app.evaluate(ITEMS)) === JSON.stringify(['srv/']), `cd /sr lists srv/ (${JSON.stringify(await app.evaluate(ITEMS))})`);
    await app.screenshot('ssh-paths-cd-sr.png');
    await tab(app);
    await lineIs(app, 'cd /srv/', 'Tab completes cd /srv/');
    await app.until(`${ITEMS}.join() === 'backup/,ftp/,www/'`, 'the folder lists its entries next', 8000);
    await app.screenshot('ssh-paths-cd-srv.png');
    await app.insertText('f');
    await app.until(`${ITEMS}.join() === 'ftp/'`, 'f narrows to ftp/', 8000);
    await tab(app);
    await lineIs(app, 'cd /srv/ftp/', 'Tab completes cd /srv/ftp/');
    await app.press('Enter');
    await app.until(`${BUFFER}.includes('alice@test-server:/srv/ftp$')`, 'shell in /srv/ftp');

    await sleep(400);
    await app.insertText('vim TEST');
    await app.until(`${ITEMS}.length >= 11`, 'popup for vim TEST', 8000);
    const items = await app.evaluate(ITEMS);
    check(items[0] === 'TESTDATA/' && items.slice(1).join() === Array.from({ length: 10 }, (_, i) => `TEST${i + 1}`).join(), `folders first, natural order (${items.join(' ')})`);
    await app.screenshot('ssh-paths-vim-test.png');
    await tab(app);
    await lineIs(app, 'vim TESTDATA/', 'first Tab: TESTDATA/');
    await tab(app);
    await lineIs(app, 'vim TEST1', 'second Tab: TEST1');
    await tab(app);
    await lineIs(app, 'vim TEST2', 'third Tab: TEST2');
    check(await app.evaluate(SELECTED) === 'TEST2', 'the popup marks TEST2');
    await app.screenshot('ssh-paths-vim-tab3.png');
    await tab(app, true);
    await lineIs(app, 'vim TEST1', 'Shift+Tab goes back to TEST1');
    await tab(app);
    await tab(app);
    await lineIs(app, 'vim TEST3', 'Tab Tab: TEST3');
    await app.press('Enter');
    await app.until(`${BUFFER}.includes('fake vim')`, 'vim opened');
    await sleep(300);
    await app.insertText('ab');
    await tab(app);
    await sleep(500);
    check(await app.evaluate(`!document.querySelector('.ssh-ac')`), 'no popup inside vim');
    await app.screenshot('ssh-paths-in-vim.png');
    await app.insertText(':q');
    await app.press('Enter');
    await app.until(`${CURSOR_LINE}.includes('alice@test-server:/srv/ftp$')`, 'back at the prompt');

    // A name with a space is quoted like a shell does it.
    await sleep(300);
    await app.insertText('cat my');
    await app.until(`${ITEMS}.join() === 'my notes.txt'`, 'popup for cat my', 8000);
    await tab(app);
    await lineIs(app, 'cat my\\ notes.txt', 'a space is escaped');
    await app.screenshot('ssh-paths-quoted.png');
    await app.press('Escape');

    await app.until(`${CELL}.ssh.cwd === '/srv/ftp' && ${CELL}.ssh.resume === true`, 'the cell keeps /srv/ftp and the resume mark', 8000);
    check(true, `cell.ssh = ${JSON.stringify(await app.evaluate(`${CELL}.ssh`))}`);
    await sleep(800);
  } finally {
    await quit(app).catch(async (e) => { failures.push(String(e)); await app.close(); });
  }

  // ── second run: the session comes back by itself into /srv/ftp ──
  app = await launchApp(root);
  try {
    await connected(app, 1, 30000);
    await app.until(`${CURSOR_LINE}.includes('alice@test-server:/srv/ftp$')`, 'restored into /srv/ftp', 15000);
    check((await app.evaluate(BUFFER)).includes("cd '/srv/ftp'"), 'the restore typed the cd');
    await app.screenshot('ssh-paths-restored.png');
    // Disconnecting clears the mark: the next start leaves the cell idle.
    await app.until(`${CELL}.ssh.resume === true`, 'resume mark after the restore');
  } finally {
    await quit(app).catch(async (e) => { failures.push(String(e)); await app.close(); });
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  server.stop();
  await sleep(500);
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.log(`scratch left: ${root}`); }
}
console.log(failures.length ? `\n${failures.length} FAILED:\n${failures.join('\n')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
