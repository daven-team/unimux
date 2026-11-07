// Real-app checks of the Tauri lifecycle (PLAN W6), on the `check` build with a scratch data dir and home, offscreen:
//   A. quitting with a (faked) busy agent asks in the renderer, Cancel keeps the app, Quit winds down, saves and exits 0;
//   B. a simulated WM_QUERYENDSESSION saves state.json within 1 s (and before the 500 ms save debounce), tells the renderer
//      (app:before-quit) and lets a held quit go on; WM_ENDSESSION returns within its 3 s bound; a cancelled shutdown
//      (WM_ENDSESSION FALSE) keeps the app running and the next minute's quits unheld;
//   C. killing the page's msedgewebview2 renderer reloads it 3 times, the 4th time asks Reload / Quit (translated), Reload
//      reloads, Quit winds down and exits 0 with the state saved;
//   E. a second start while the app winds down is forwarded, and the app starts again after its exit (relaunch): the new
//      process waited for the old pid to end and took the data dir only after the old one's last state.json write;
//   D. (--hang) a page stuck in a loop is asked about after the heartbeat + grace (about 25 s), Reload ends the hung renderer
//      and the page comes back.
// No dialog ever reaches the desktop: in an offscreen run the app records its native dialogs and the test bridge answers them.
// The session-end messages go to our own window handle only (SendMessageTimeout from a PowerShell helper).
//
//   npm run build:check && node scripts/verify-tauri-lifecycle.mjs [--hang] [--keep]
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, readText, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const keep = process.argv.includes('--keep');
const withHang = process.argv.includes('--hang');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-w6-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
const stateFile = join(dataDir, 'state.json');
const crashLog = join(dataDir, 'crash.log');
console.log(`scratch: ${scratch}`);

/** A minimal 1.1.4-shaped state: one project, one tab with a Claude cell (the "busy agent") and a shell cell. */
function writeFixture() {
  const state = {
    version: 1,
    projects: [{ id: 'proj-w6', name: 'w6', path: scratch, color: '#7c5cff', tabs: [{ id: 'tab-w6', name: 'Agenci', cells: [{ id: 'cell-1', profileId: 'claude' }, { id: 'cell-2', profileId: 'shell' }] }], archive: [], activeTabId: 'tab-w6' }],
    activeProjectId: 'proj-w6',
    settings: { language: 'pl', confirmCloseWorking: true },
  };
  writeFileSync(stateFile, JSON.stringify(state));
}
writeFixture();

const children = [];
/** Started by the app itself (relaunch), not by us: ended by pid in the finally block if they are still there. */
const relaunchedPids = [];
const start = async () => {
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  return { child, page, port };
};
const bridge = (page, op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
const crashLines = () => (existsSync(crashLog) ? readText(crashLog).split('\n').filter(Boolean) : []);
const savedSetting = (key) => { try { return JSON.parse(readText(stateFile)).settings?.[key]; } catch { return undefined; } };
const edit = (page, key, value) => page.evaluate(`window.__mc.useStore.getState().update((s) => ({ ...s, settings: { ...s.settings, ${JSON.stringify(key)}: ${JSON.stringify(value)} } }))`);
const setBusy = (page, busy) => page.evaluate(`(() => { const st = window.__mc.useStore.getState(); window.__mc.useStore.setState({ ui: { ...st.ui, statuses: { ...st.ui.statuses, 'cell-1': ${busy ? "'working'" : "'idle'"} } } }); })()`);
/** Waits until state.json is quiet (the renderer's own boot-time saves are done). */
async function settle() {
  let before = readText(stateFile);
  for (let quiet = 0, i = 0; quiet < 6 && i < 60; i++) {
    await sleep(250);
    const now = readText(stateFile);
    quiet = now === before ? quiet + 1 : 0;
    before = now;
  }
}

/** PowerShell helper that sends window messages on request (compiled once, then triggered by a line on stdin). */
function messenger() {
  const script = join(scratch, 'send-message.ps1');
  writeFileSync(script, [
    "$sig = 'using System; using System.Runtime.InteropServices; public static class W6Msg { [DllImport(\"user32.dll\")] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r); }'",
    'Add-Type -TypeDefinition $sig',
    '[Console]::Out.WriteLine("ready"); [Console]::Out.Flush()',
    'while ($null -ne ($line = [Console]::In.ReadLine())) {',
    '  $p = $line.Split(" "); $r = [IntPtr]::Zero; $sw = [Diagnostics.Stopwatch]::StartNew()',
    '  $ok = [W6Msg]::SendMessageTimeoutW([IntPtr][Int64]$p[0], [uint32]$p[1], [IntPtr][Int64]$p[2], [IntPtr][Int64]$p[3], 2, 10000, [ref]$r).ToInt64() -ne 0',
    '  [Console]::Out.WriteLine("done $ok $r $($sw.ElapsedMilliseconds)"); [Console]::Out.Flush()',
    '}',
  ].join('\r\n'));
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  const waiters = [];
  ps.stdout.on('data', (d) => {
    buffer += d.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      waiters.shift()?.(line);
    }
  });
  const next = () => new Promise((res) => waiters.push(res));
  const ready = next();
  return {
    ready,
    /** Sends and resolves with `{ ok, result, ms }` once SendMessageTimeout returned. */
    send: async (hwnd, msg, wparam, lparam) => {
      const answer = next();
      ps.stdin.write(`${hwnd} ${msg} ${wparam} ${lparam}\n`);
      const [, ok, result, ms] = (await answer).split(' ');
      return { ok: ok === 'True', result: Number(result), ms: Number(ms) };
    },
    close: () => { try { ps.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { ps.kill(); } catch { /* gone */ } }, 2000).unref(); },
  };
}
const WM_QUERYENDSESSION = 0x11;
const WM_ENDSESSION = 0x16;
const ENDSESSION_LOGOFF = 0x80000000;

let failed = false;
try {
  // ── A. quit question ────────────────────────────────────────────────────
  {
    const { child, page } = await start();
    await settle();
    const plan = (await bridge(page, 'lifecycle')).windDown.map((s) => s.name);
    // W6's steps plus W5's detached windows and the M1 / H1 server stops (wave 1), in 1.1.4's before-quit order.
    check('wind-down plan has the wave 1 and S1 steps in 1.1.4 order', JSON.stringify(plan) === JSON.stringify(['detached: quitting', 'app:before-quit', 'ssh history flush', 'renderer grace', 'close detached windows', 'state save', 'last state save', 'mcp stop', 'hooks stop']), plan.join(' > '));
    await setBusy(page, true);
    const guard = await waitFor(page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'lifecycle', args: null }).then((l) => l.guard)`, 10000, 'quit guard').catch(() => false);
    check('a working agent sets the quit guard (app:quitGuard)', guard === true);
    await bridge(page, 'close');
    const asked = await waitFor(page, `(() => { const d = window.__mc.useStore.getState().ui.dialog; return d && d.kind === 'confirm' ? d.title : null; })()`, 10000, 'quit question').catch(() => null);
    check('closing the window asks in the renderer (app:confirm-quit)', !!asked, asked ?? '');
    await sleep(4000);
    let lc = await bridge(page, 'lifecycle');
    check('the acknowledged question holds the quit past the 3 s ack', child.exitCode === null && lc.pending === true && lc.quitting === false);
    await page.evaluate(`window.__mc.useStore.getState().ui.dialog.onChoose(null, false)`);
    await sleep(3500);
    lc = await bridge(page, 'lifecycle');
    check('Cancel keeps the app running', child.exitCode === null && lc.pending === false && lc.quitting === false);

    await edit(page, 'fontSize', 17);
    await bridge(page, 'close');
    await waitFor(page, `window.__mc.useStore.getState().ui.dialog?.kind === 'confirm'`, 10000, 'second question');
    const t0 = Date.now();
    await page.evaluate(`window.__mc.useStore.getState().ui.dialog.onChoose('close', false)`).catch(() => undefined);
    const code = await waitExit(child, 25000);
    check('Quit winds down and exits 0', code === 0, `exit ${code} after ${Date.now() - t0} ms`);
    check('quit saves the last edit', savedSetting('fontSize') === 17);
    check('no save error in crash.log', !crashLines().some((l) => /could not be saved/.test(l)));
  }

  // ── B. session end ──────────────────────────────────────────────────────
  const msg = messenger();
  await msg.ready;
  {
    // A cancelled shutdown: the app stays, quits within the minute are not held.
    const { child, page } = await start();
    await settle();
    const hwnd = (await bridge(page, 'lifecycle')).hwnd;
    const q = await msg.send(hwnd, WM_QUERYENDSESSION, 0, ENDSESSION_LOGOFF);
    const e = await msg.send(hwnd, WM_ENDSESSION, 0, ENDSESSION_LOGOFF);
    await sleep(1000);
    const lc = await bridge(page, 'lifecycle');
    check('WM_QUERYENDSESSION is answered "yes"', q.ok && q.result === 1, JSON.stringify(q));
    check('a cancelled session end keeps the app running', child.exitCode === null && e.ok && lc.sessionEnding === true);
    await setBusy(page, true);
    await sleep(500);
    await bridge(page, 'close');
    const code = await waitExit(child, 25000);
    check('within the minute after a session end a busy quit is not held', code === 0, `exit ${code}`);
  }
  {
    // A real-looking log-off while the question is open: the save starts at the query, the held quit goes on.
    const { child, page } = await start();
    await settle();
    await page.evaluate(`window.__w6BeforeQuit = 0; window.mc.on('app:before-quit', () => { window.__w6BeforeQuit++; })`);
    await setBusy(page, true);
    await sleep(500);
    await bridge(page, 'close');
    await waitFor(page, `window.__mc.useStore.getState().ui.dialog?.kind === 'confirm'`, 10000, 'question before the log-off');
    const hwnd = (await bridge(page, 'lifecycle')).hwnd;
    await edit(page, 'fontSize', 19);
    const sent = Date.now();
    const q = await msg.send(hwnd, WM_QUERYENDSESSION, 0, ENDSESSION_LOGOFF);
    let savedAt = null;
    while (Date.now() - sent < 3000 && savedAt === null) {
      if (savedSetting('fontSize') === 19) savedAt = Date.now() - sent;
      else await sleep(10);
    }
    const before = await page.evaluate('window.__w6BeforeQuit').catch(() => 'page gone');
    const e = await msg.send(hwnd, WM_ENDSESSION, 1, ENDSESSION_LOGOFF).catch(() => ({ ok: false, ms: -1 }));
    check('WM_QUERYENDSESSION saves state.json within 1 s', savedAt !== null && savedAt < 1000, `${savedAt} ms (query answered in ${q.ms} ms)`);
    check('the save did not wait for the 500 ms debounce', savedAt !== null && savedAt < 450, `${savedAt} ms`);
    check('the renderer was told to push its edits (app:before-quit)', before === 'page gone' || before >= 1, String(before));
    check('WM_ENDSESSION returns within its 3 s bound', e.ms >= 0 && e.ms <= 3200, `${e.ms} ms`);
    const code = await waitExit(child, 25000);
    check('the session end lets the held quit go on (exit 0)', code === 0, `exit ${code}`);
  }
  msg.close();

  // ── E. a start while the app winds down ─────────────────────────────────
  {
    // A slow service keeps the wind-down busy for 3 s; a second unimux.exe started meanwhile is forwarded (and exits), and
    // the quitting app starts itself again once it is gone (1.1.4: app.relaunch() in exitNow).
    const { child, page, port } = await start();
    await settle();
    const firstPid = (await bridge(page, 'windDownDelay', { ms: 3000 })).pid;
    await bridge(page, 'quit').catch(() => undefined);
    await sleep(500);
    const second = launchApp({ dataDir, scratch, port: await freePort() });
    children.push(second);
    const secondCode = await waitExit(second, 15000);
    check('a start during the wind-down is forwarded to the quitting app', secondCode === 0, `exit ${secondCode}`);
    const firstCode = await waitExit(child, 25000);
    check('the quitting app still exits 0', firstCode === 0, `exit ${firstCode}`);
    // The old process's last write (its RunEvent::Exit save); the relaunched one has not saved yet when this is read.
    const lastOldWrite = statSync(stateFile).mtimeMs;
    let relaunched = null;
    let waited = null;
    try {
      const again = await connectPage(port, { timeoutMs: 30000 });
      await waitFor(again, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'relaunched renderer ready');
      relaunched = (await bridge(again, 'windDownDelay', { ms: 0 })).pid;
      relaunchedPids.push(relaunched);
      waited = (await bridge(again, 'lifecycle')).relaunchedAfter;
      await bridge(again, 'quit').catch(() => undefined);
    } catch (error) {
      console.error(error);
    }
    check('the app started again after the exit (relaunch while quitting)', Number.isInteger(relaunched) && relaunched !== firstPid, `first ${firstPid}, relaunched ${relaunched}`);
    check('the relaunched process waited for the old pid to end', waited?.pid === firstPid && waited?.gone === true, JSON.stringify(waited));
    check('the old process wrote state.json only before the relaunched one went on', waited && lastOldWrite <= waited.at, `last old write ${Math.round(lastOldWrite)}, relaunch went on at ${waited?.at}`);
    // The relaunched app ends by itself (quit); its debug port goes away.
    let closed = false;
    for (let i = 0; i < 100 && !closed; i++) {
      await sleep(250);
      closed = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => false, () => true);
    }
    check('the relaunched app quits normally', closed);
  }

  // ── C. renderer crash ───────────────────────────────────────────────────
  {
    writeFixture();
    const started = await start();
    const { child, port } = started;
    let page = started.page;
    await settle();
    // A second window whose page drives the test bridge while the main page is dead.
    await bridge(page, 'openWindow', { label: 'detached-w6probe', url: 'w6probe.html', visible: false });
    const probeTarget = await (async () => {
      for (let i = 0; i < 100; i++) {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const t = list.find((x) => x.type === 'page' && x.url.includes('w6probe'));
        if (t) return t;
        await sleep(200);
      }
      return null;
    })();
    const probe = probeTarget ? await connectPage(port, { match: probeTarget.id }) : null;
    if (probe) await waitFor(probe, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 20000, 'probe bridge');
    const mainPid = (await bridge(page, 'rendererPid')).pid;
    const probePid = probe ? (await bridge(probe, 'rendererPid', { label: 'detached-w6probe' })).pid : null;
    check('the main page renderer pid is known (WebView2 GetProcessExtendedInfos)', Number.isInteger(mainPid) && mainPid > 0, String(mainPid));
    const separate = !!probe && probePid !== mainPid;
    check('the probe window runs in its own renderer', separate, `main ${mainPid}, probe ${probePid}`);

    const kill = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); return true; } catch { return false; } };
    const goneLines = () => crashLines().filter((l) => /renderer gone \(/.test(l)).length;
    let reloads = 0;
    for (let i = 1; i <= 3; i++) {
      const pid = (await bridge(page, 'rendererPid')).pid;
      await page.evaluate('window.__w6Marker = 1');
      kill(pid);
      page.close();
      await sleep(500);
      page = await connectPage(port);
      const back = await waitFor(page, `window.__w6Marker === undefined && window.__mc?.useStore?.getState?.().ready === true`, 30000, `reload ${i}`).catch(() => false);
      if (back) reloads++;
    }
    check('a killed renderer is reloaded 3 times in a row', reloads === 3, `${reloads} reloads, ${goneLines()} crash.log lines`);
    let lc = separate ? await bridge(probe, 'lifecycle') : null;
    check('no question during the first 3 crashes', lc?.dialogs.length === 0);

    const pid4 = (await bridge(page, 'rendererPid')).pid;
    await page.evaluate('window.__w6Marker = 4');
    kill(pid4);
    page.close();
    let dialog = null;
    if (separate) {
      for (let i = 0; i < 50 && !dialog; i++) { await sleep(200); dialog = (await bridge(probe, 'lifecycle')).dialogs.find((d) => d.answer === null) ?? null; }
    }
    check('the 4th crash within a minute asks instead of reloading', !!dialog, dialog ? `${dialog.message} [${dialog.buttons.join(' / ')}]` : 'no dialog recorded');
    check('the question is translated (pl) with Reload / Quit', dialog?.kind === 'error' && dialog?.message === 'Okno aplikacji kilka razy przestało działać.' && JSON.stringify(dialog?.buttons) === JSON.stringify(['Wczytaj ponownie', 'Zamknij aplikację']) && dialog?.defaultId === 0);
    lc = separate ? await bridge(probe, 'lifecycle') : null;
    check('the page stays down while the question is open', lc?.rendererDead === true);
    if (dialog) await bridge(probe, 'dialogAnswer', { id: dialog.id, response: 0 });
    page = await connectPage(port);
    const reloaded = await waitFor(page, `window.__w6Marker === undefined && window.__mc?.useStore?.getState?.().ready === true`, 30000, 'reload after the answer').catch(() => false);
    check('Reload in the question reloads the page', !!reloaded);
    check('crash.log has one line per crash', goneLines() === 4, `${goneLines()} lines`);

    if (withHang) {
      // ── D. hung renderer ──
      await page.evaluate(`setTimeout(() => { const t = Date.now(); while (Date.now() - t < 90000) {} }, 50)`);
      let hung = null;
      const t0 = Date.now();
      while (!hung && Date.now() - t0 < 45000) { await sleep(500); hung = (await bridge(probe, 'lifecycle')).dialogs.find((d) => d.answer === null) ?? null; }
      check('a page stuck in a loop is asked about (Wait / Reload)', hung?.kind === 'warning' && JSON.stringify(hung?.buttons) === JSON.stringify(['Czekaj', 'Wczytaj ponownie']), hung ? `after ${Date.now() - t0} ms` : 'no dialog');
      if (hung) await bridge(probe, 'dialogAnswer', { id: hung.id, response: 1 });
      page.close();
      page = await connectPage(port);
      const back = await waitFor(page, `window.__mc?.useStore?.getState?.().ready === true`, 30000, 'reload after hang').catch(() => false);
      check('Reload ends the hung renderer and the page comes back', !!back && crashLines().some((l) => /hung renderer reloaded by the user/.test(l)));
    }

    // Quit from the question of the next crash: the state is saved, the app exits 0.
    await settle();
    await edit(page, 'fontSize', 21);
    const pid5 = (await bridge(page, 'rendererPid')).pid;
    kill(pid5);
    page.close();
    dialog = null;
    if (separate) {
      for (let i = 0; i < 50 && !dialog; i++) { await sleep(200); dialog = (await bridge(probe, 'lifecycle')).dialogs.find((d) => d.answer === null) ?? null; }
    }
    if (dialog) await bridge(probe, 'dialogAnswer', { id: dialog.id, response: 1 }).catch(() => undefined);
    const code = await waitExit(child, 25000);
    check('Quit in the crash question exits 0 with the state saved', code === 0 && savedSetting('fontSize') === 21, `exit ${code}, fontSize ${savedSetting('fontSize')}`);
  }

  check('isolation: nothing appeared in the real profile', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const child of children) killTree(child);
  for (const pid of relaunchedPids) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } }
  if (!keep) { await sleep(1500); removeScratch(scratch); }
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(failed || bad.length ? 1 : 0);
