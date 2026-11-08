// Real-app check of W4 (1.2.0): notifications with the 1.0.9 buttons, the taskbar flash, dialogs, alert sound files, the
// beep, the clipboard with the copied secret, and the shell commands, on the `check` build through window.mc exactly as the
// renderer calls them. The run is offscreen (MC_OFFSCREEN): the app then talks to a recorder instead of the desktop, so no
// toast, dialog, browser, Explorer window, beep or flash ever reaches the user's screen; the script reads what was asked,
// answers the dialogs and presses the toast buttons through the test bridge. Scratch data dir and home only.
//
//   npm run build:check && node scripts/verify-tauri-os.mjs [--quick]
//
// --quick skips the two waits on the app's real 60 s clipboard timer (about 2 minutes).
//
// The parts of scripts/verify-notify-actions.mjs that need a running agent terminal (Enter / Esc typed into a fake
// permission dialog, the stale-answer check of the renderer against the screen) wait for P3 / P4 / H1.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
const [{ defaultState }, { layoutForCount }] = await Promise.all([load('src/shared/state.ts'), load('src/shared/layout.ts')]);

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-w4-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
const soundFile = join(scratch, 'ding.wav');
writeFileSync(soundFile, Buffer.from([82, 73, 70, 70, 1, 2, 3, 4, 5]));
const exeFile = join(scratch, 'not-a-sound.exe');
writeFileSync(exeFile, 'x');

const state = defaultState('win32');
state.settings.language = 'en';
const claude = state.profiles.find((p) => p.cli === 'claude') ?? state.profiles[0];
const shell = state.profiles.find((p) => p.cli === 'shell') ?? state.profiles[0];
const cellId = 'cell-agent-1';
state.projects = [{ id: 'proj-w4', name: 'W4 project', path: scratch, color: '#3b82f6', archive: [], activeTabId: 'tab-w4', tabs: [
  { id: 'tab-w4', name: 'Main', layout: layoutForCount(2), cells: [{ id: cellId, profileId: claude.id, name: 'Reviewer' }, { id: 'cell-shell', profileId: shell.id }] },
] }];
state.activeProjectId = 'proj-w4';
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state));

const children = [];
const start = async () => {
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 30000, 'Tauri IPC');
  return { child, page };
};
const bridge = (page, op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);

try {
  const { child, page } = await start();
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  await sleep(800);
  const os = (args) => bridge(page, 'os', args);
  const mc = (expr) => page.evaluate(expr);
  const log = () => os({ action: 'log', take: true });
  // The events the windows receive (the renderer's own handlers run too, as in the app).
  await mc(`(() => { window.__w4 = []; for (const ch of ['notify:answer', 'focus-cell']) window.mc.on(ch, (...a) => window.__w4.push([ch, ...a])); return true; })()`);
  const events = async () => mc(`window.__w4.splice(0)`);
  const settle = () => sleep(400);
  const toasts = (entries) => entries.filter((e) => e.op === 'toast');
  const setState = async (fn) => {
    await mc(`window.__mc.useStore.getState().update(${fn})`);
    await sleep(700);
  };
  await log();

  // ── notifications ──────────────────────────────────────────────────────
  await mc(`window.mc.notify({ title: 'unimux', body: 'Reviewer needs you', cellId: ${JSON.stringify(cellId)}, actions: 'answer', token: 'tok.1' })`);
  await settle();
  let shown = toasts(await log());
  check('a permission notification offers Allow / Deny / Show, silent', shown.length === 1 && JSON.stringify(shown[0].buttons) === '["Allow","Deny","Show"]' && shown[0].silent === true && shown[0].body === 'Reviewer needs you', JSON.stringify(shown));
  await events();
  await os({ action: 'toast', index: shown[0].index, event: 'button', button: 0 });
  await settle();
  let ev = await events();
  check('Allow sends notify:answer (cell, token, allow) to the cell\'s window', JSON.stringify(ev[0]) === JSON.stringify(['notify:answer', cellId, 'tok.1', 'allow']), JSON.stringify(ev));
  check('the renderer, finding no permission dialog in the cell, asks to show the cell instead (stale answer)', ev.some((e) => e[0] === 'focus-cell' && e[1] === cellId), JSON.stringify(ev));
  await os({ action: 'toast', index: shown[0].index, event: 'button', button: 0 });
  await settle();
  ev = await events();
  // 1.1.4 forgot the toast on its first press but kept its handlers (verify-notify-actions: "a stale Allow types nothing
  // and only shows the cell"): the second press still reaches the renderer, whose token check finds the dialog gone.
  check('a second press of the same toast is a stale answer: the renderer only shows the cell', JSON.stringify(ev[0]) === JSON.stringify(['notify:answer', cellId, 'tok.1', 'allow']) && ev.some((e) => e[0] === 'focus-cell' && e[1] === cellId), JSON.stringify(ev));

  await mc(`window.mc.notify({ title: 'unimux', body: 'again', cellId: ${JSON.stringify(cellId)}, actions: 'answer', token: 'tok.2' })`);
  await settle();
  shown = toasts(await log());
  // The user was away: the banner timed out into the Action Center first, the button is pressed there.
  await os({ action: 'toast', index: shown[0].index, event: 'timedOut' });
  await os({ action: 'toast', index: shown[0].index, event: 'button', button: 1 });
  await settle();
  ev = await events();
  check('Deny in the Action Center after the banner timed out sends notify:answer deny', JSON.stringify(ev[0]) === JSON.stringify(['notify:answer', cellId, 'tok.2', 'deny']), JSON.stringify(ev));

  await mc(`window.mc.notify({ title: 'unimux', body: 'a question', cellId: ${JSON.stringify(cellId)}, actions: 'show' })`);
  await settle();
  shown = toasts(await log());
  check('a question gets only Show', JSON.stringify(shown[0]?.buttons) === '["Show"]', JSON.stringify(shown));
  await os({ action: 'toast', index: shown[0].index, event: 'button', button: 0 });
  await settle();
  ev = await events();
  check('Show shows the cell (focus-cell), no answer', ev.length >= 1 && ev.every((e) => e[0] === 'focus-cell' && e[1] === cellId), JSON.stringify(ev));

  await mc(`window.mc.notify({ title: 'unimux', body: 'bad token', cellId: ${JSON.stringify(cellId)}, actions: 'answer', token: 'a b' })`);
  await mc(`window.mc.notify({ title: 'unimux', body: 'no cell', cellId: '', actions: 'answer', token: 'tok.3' })`);
  await mc(`window.mc.notify({ title: ${JSON.stringify('t'.repeat(300))}, body: 'done', cellId: ${JSON.stringify(cellId)} })`);
  await mc(`window.mc.notify({ title: 5, body: 'refused' })`);
  await settle();
  shown = toasts(await log());
  check('no buttons with a bad token or without a cell; title cut at 200; a malformed notification is dropped', shown.length === 3 && shown.every((s) => s.buttons.length === 0) && shown[2].title.length === 200, JSON.stringify(shown.map((s) => [s.body, s.buttons, s.title.length])));
  await os({ action: 'toast', index: shown[2].index, event: 'click' });
  await settle();
  ev = await events();
  check('a click on the body shows the cell', JSON.stringify(ev) === JSON.stringify([['focus-cell', cellId]]), JSON.stringify(ev));
  await os({ action: 'toast', index: shown[1].index, event: 'click' });
  await settle();
  check('a click on a notification without a cell only shows the window', (await events()).length === 0);

  await setState(`(s) => ({ ...s, settings: { ...s.settings, alerts: { ...s.settings.alerts, notificationActions: false } } })`);
  await mc(`window.mc.notify({ title: 'unimux', body: 'off', cellId: ${JSON.stringify(cellId)}, actions: 'answer', token: 'tok.4' })`);
  await settle();
  shown = toasts(await log());
  check('no buttons once the setting is off', shown.length === 1 && shown[0].buttons.length === 0, JSON.stringify(shown));
  await setState(`(s) => ({ ...s, settings: { ...s.settings, alerts: { ...s.settings.alerts, notificationActions: true } } })`);

  const firstOfMany = (await os({ action: 'live' })).length;
  for (let i = 0; i < 55; i++) await mc(`window.mc.notify({ title: 'n${i}', body: 'x', cellId: ${JSON.stringify(cellId)} })`);
  await sleep(1200);
  const many = toasts(await log());
  const live = await os({ action: 'live' });
  check('only the newest 50 notifications keep their handlers', many.length === 55 && live.length === 50, `${firstOfMany} before, ${live.length} live`);
  await events();
  await os({ action: 'toast', index: many[0].index, event: 'click' });
  await os({ action: 'toast', index: many[54].index, event: 'closed' });
  await os({ action: 'toast', index: many[53].index, event: 'click' });
  await settle();
  ev = await events();
  check('a trimmed notification does nothing; a closed one is forgotten; the newest still works', ev.length === 1 && (await os({ action: 'live' })).length === 48, JSON.stringify(ev));
  // Windows: a banner that times out is parked in the Action Center (Dismissed, reason TimedOut). It stays clickable, as
  // in 1.1.4: the click and the buttons still act afterwards.
  await os({ action: 'toast', index: many[52].index, event: 'timedOut' });
  const liveAfterTimeout = (await os({ action: 'live' })).length;
  await os({ action: 'toast', index: many[52].index, event: 'click' });
  await settle();
  ev = await events();
  check('a timed-out notification stays in the Action Center and its click still shows the cell', liveAfterTimeout === 48 && JSON.stringify(ev) === JSON.stringify([['focus-cell', cellId]]) && (await os({ action: 'live' })).length === 47, `${liveAfterTimeout} live, ${JSON.stringify(ev)}`);

  await mc(`window.mc.showCell('no-such-cell')`);
  await mc(`window.mc.showCell(${JSON.stringify(cellId)})`);
  await settle();
  ev = await events();
  check('notify:show shows a cell that exists and ignores others', JSON.stringify(ev) === JSON.stringify([['focus-cell', cellId]]), JSON.stringify(ev));

  // ── taskbar flash ──────────────────────────────────────────────────────
  await mc(`window.mc.flashAttention()`);
  await settle();
  let entries = await log();
  check('attention:flash flashes the sender\'s window when it is not focused', entries.some((e) => e.op === 'flash' && e.window === 'main' && e.on === true), JSON.stringify(entries));
  await setState(`(s) => ({ ...s, settings: { ...s.settings, alerts: { ...s.settings.alerts, flashWindow: false } } })`);
  await mc(`window.mc.flashAttention()`);
  await settle();
  entries = await log();
  check('no flash when the setting is off', !entries.some((e) => e.op === 'flash'), JSON.stringify(entries));
  const badge = await os({ action: 'taskbar', cell: cellId, status: 'waiting', reason: 'attention' });
  check('Windows shows no taskbar badge (1.1.2)', badge === '');

  // ── dialogs ────────────────────────────────────────────────────────────
  await os({ action: 'answer', path: scratch });
  const folder = await mc(`window.mc.pickFolder()`);
  await os({ action: 'answer', path: null });
  const cancelled = await mc(`window.mc.pickFolder()`);
  entries = (await log()).filter((e) => e.op === 'pick');
  check('pickFolder: the chosen folder, null when cancelled, a translated title over the caller window', folder === scratch && cancelled === null && entries[0]?.folder === true && entries[0]?.title === 'Choose project folder' && entries[0]?.parent === 'main', JSON.stringify(entries));
  await os({ action: 'answer', path: soundFile });
  const pickedSound = await mc(`window.mc.pickSoundFile()`);
  await os({ action: 'answer', path: exeFile });
  const pickedExe = await mc(`window.mc.pickSoundFile()`);
  entries = (await log()).filter((e) => e.op === 'pick');
  check('pickSoundFile: a sound file, null for another extension, the sound filter', pickedSound === soundFile && pickedExe === null && entries[0]?.title === 'Choose sound file' && entries[0]?.filter?.name === 'Sound files' && entries[0]?.filter?.extensions.join(',') === 'wav,mp3,ogg,m4a,aac,flac', JSON.stringify(entries));

  // ── alert sound files ──────────────────────────────────────────────────
  await setState(`(s) => ({ ...s, settings: { ...s.settings, alerts: { ...s.settings.alerts, events: { ...s.settings.alerts.events, done: { ...s.settings.alerts.events.done, sound: { kind: 'file', path: ${JSON.stringify(soundFile)} } } } } } })`);
  const loaded = await mc(`window.mc.loadAlertSound('done').then((r) => ({ ok: r.ok, key: r.key, bytes: r.data ? [...r.data] : null, isU8: r.data instanceof Uint8Array }))`);
  check('sound:load answers the bytes of the saved file as a Uint8Array', loaded.ok === true && loaded.isU8 && JSON.stringify(loaded.bytes) === JSON.stringify([82, 73, 70, 70, 1, 2, 3, 4, 5]) && loaded.key.startsWith(`${soundFile}|9|`), JSON.stringify(loaded));
  const again = await mc(`window.mc.loadAlertSound('done', ${JSON.stringify(loaded.key)})`);
  check('no bytes again while the key is current', again.ok === true && again.data === null && again.key === loaded.key, JSON.stringify(again));
  const other = await mc(`Promise.all([window.mc.loadAlertSound('attention'), window.mc.loadAlertSound('__proto__'), window.mc.loadAlertSound(${JSON.stringify(soundFile)})])`);
  check('other events and paths from the renderer are refused', other.every((r) => r.ok === false && Object.keys(r).length === 1), JSON.stringify(other));
  await mc(`window.mc.systemBeep()`);
  await settle();
  check('sound:beep beeps', (await log()).some((e) => e.op === 'beep'));

  // ── clipboard ──────────────────────────────────────────────────────────
  const clipFile = join(dataDir, 'test-clipboard.json');
  const clip = () => JSON.parse(readFileSync(clipFile, 'utf8'));
  await mc(`window.mc.clipboardWrite('hello')`);
  await settle();
  check('clipboard write and read', (await mc(`window.mc.clipboardRead()`)) === 'hello' && clip().secret === false);
  const refusedSecret = await mc(`window.mc.clipboardWriteSecret('')`);
  const copied = await mc(`window.mc.clipboardWriteSecret('-----BEGIN KEY-----')`);
  check('writeSecret: false for nothing, true for a key, written as a secret', refusedSecret === false && copied === true && clip().secret === true && clip().text === '-----BEGIN KEY-----');
  check('the secret waits to be cleared', (await os({ action: 'secretPending' })) === true);
  await os({ action: 'clipboardFire' });
  check('the clear empties the clipboard while it still holds the key', (await mc(`window.mc.clipboardRead()`)) === '' && (await os({ action: 'secretPending' })) === false);
  await mc(`window.mc.clipboardWriteSecret('key-two')`);
  await mc(`window.mc.clipboardWrite('copied by the user later')`);
  await settle();
  await os({ action: 'clipboardFire' });
  check('the clear leaves what the user copied meanwhile', (await mc(`window.mc.clipboardRead()`)) === 'copied by the user later');
  if (!process.argv.includes('--quick')) {
    // The real 60 s timer of the app (not the clipboardFire shortcut): cleared after a minute, not before, and only while
    // the clipboard still holds the key.
    await mc(`window.mc.clipboardWriteSecret('key-timer')`);
    await sleep(57000);
    const early = clip().text;
    await sleep(5000);
    check('the real timer clears the key after 60 s, not before', early === 'key-timer' && clip().text === '' && (await os({ action: 'secretPending' })) === false, `${early} -> ${clip().text}`);
    await mc(`window.mc.clipboardWriteSecret('key-timer-2')`);
    await sleep(1000);
    await mc(`window.mc.clipboardWrite('the user copied this')`);
    await sleep(61000);
    check('the real timer leaves what the user copied meanwhile', clip().text === 'the user copied this' && (await os({ action: 'secretPending' })) === false, clip().text);
  }

  // ── shell ──────────────────────────────────────────────────────────────
  await mc(`window.mc.openExternal('https://example.com/a b')`);
  await mc(`window.mc.openExternal('file:///C:/Windows/win.ini')`);
  await mc(`window.mc.openExternal('javascript:alert(1)')`);
  await mc(`window.mc.openExternal('not a url')`);
  await mc(`window.mc.openPath(${JSON.stringify(soundFile)})`);
  await mc(`window.mc.openPath('')`);
  await mc(`window.mc.revealPath(${JSON.stringify(soundFile)})`);
  await mc(`window.mc.revealPath('a\\u0000b')`);
  await settle();
  entries = await log();
  const shellOps = entries.filter((e) => ['openExternal', 'openPath', 'revealPath'].includes(e.op));
  check('openExternal only for http(s) (the href), openPath / revealPath only for real path strings', JSON.stringify(shellOps) === JSON.stringify([
    { op: 'openExternal', url: 'https://example.com/a%20b' }, { op: 'openPath', path: soundFile }, { op: 'revealPath', path: soundFile },
  ]), JSON.stringify(shellOps));
  // PLAN.md "W4 (open path, security review 2026-11-06)": programs, scripts and shortcuts are revealed, never run.
  const programs = ['run.bat', 'RUN.CMD', 'link.lnk', 'site.url', 'p.ps1', 'v.vbs', 'setup.msi', 'run.bat.'].map((n) => join(scratch, n));
  for (const p of programs) writeFileSync(p.replace(/\.+$/, ''), 'x');
  for (const p of [exeFile, ...programs]) await mc(`window.mc.openPath(${JSON.stringify(p)})`);
  await mc(`window.mc.openPath(${JSON.stringify(scratch)})`);
  await settle();
  const revealed = (await log()).filter((e) => ['openPath', 'revealPath'].includes(e.op));
  check('openPath reveals programs, scripts, installers and shortcuts instead of running them; a folder still opens', JSON.stringify(revealed) === JSON.stringify([
    ...[exeFile, ...programs].map((path) => ({ op: 'revealPath', path })), { op: 'openPath', path: scratch },
  ]), JSON.stringify(revealed));
  await mc(`window.mc.openInEditor(${JSON.stringify(scratch)})`);
  await waitFor({ evaluate: async () => (await os({ action: 'log' })).some((e) => e.op === 'spawnDetached' || e.op === 'openPath') }, 'true', 15000, 'editor launch');
  entries = await log();
  const editor = entries.find((e) => e.op === 'spawnDetached' || e.op === 'openPath');
  check('openInEditor: Cursor / VS Code through cmd (detached), else the default program', editor?.op === 'openPath' ? editor.path === scratch : /cmd\.exe$/i.test(editor?.program ?? '') && editor.args === `/d /v:off /s /c "${editor.args.match(/^\/d \/v:off \/s \/c "(\S+)/)?.[1]} "${scratch}""`, JSON.stringify(editor));
  // A path that would end the quotes of the cmd line never reaches cmd; the no-editor fallback reveals a script.
  await mc(`window.mc.openInEditor('x" & calc & "')`);
  await mc(`window.mc.openInEditor(${JSON.stringify(programs[0])})`);
  await sleep(1500);
  entries = (await log()).filter((e) => ['spawnDetached', 'openPath', 'revealPath'].includes(e.op));
  const hostileOk = editor?.op === 'openPath'
    ? JSON.stringify(entries) === JSON.stringify([{ op: 'openPath', path: 'x" & calc & "' }, { op: 'revealPath', path: programs[0] }])
    : entries.length === 1 && entries[0].op === 'spawnDetached' && !String(entries[0].args).includes('calc');
  check('openInEditor refuses a path with a quote; the fallback reveals a script', hostileOk, JSON.stringify(entries));

  // ── quit clears a waiting secret ───────────────────────────────────────
  await mc(`window.mc.clipboardWriteSecret('key-at-quit')`);
  check('a key waits before the quit', clip().text === 'key-at-quit');
  await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
  const code = await waitExit(child, 15000);
  check('the app quit', code !== null, `exit ${code}`);
  check('the quit cleared the waiting key', existsSync(clipFile) && clip().text === '', JSON.stringify(existsSync(clipFile) ? clip() : null));
  page.close?.();
} catch (error) {
  failed = true;
  console.log(`FAIL ${error?.stack ?? error}`);
} finally {
  for (const child of children) killTree(child);
  check('real profile untouched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
  await sleep(500);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a webview may still hold a file */ }
}
console.log(failed ? 'verify-tauri-os: FAILED' : 'verify-tauri-os: all checks passed');
process.exit(failed ? 1 : 0);
