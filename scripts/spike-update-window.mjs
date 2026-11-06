// SP6 spike (docs/tauri/spikes/SP6.md): the custom update window process end to end on Windows, on scratch folders only.
//
//   node scripts/spike-update-window.mjs [--build] [--keep] [--prestage] [--visible] [--case=main,guard,failed,headless]
//
// The headless case hands WebView2 a file as its data folder, which makes Edge show a 'cannot create data directory'
// message box on the desktop. It runs only with UNIMUX_SPIKE_BROKEN_WEBVIEW=1 (CI or a machine nobody works on).
//
// 1. --build: builds a spike installer from the check flavour (dev-overrides + test-bridge, so every unimux.exe it starts
//    honours MC_DATA_DIR) into src-tauri/target/sp6, with productName `unimux-sp6` and identifier `com.unimux.sp6`: its
//    registry keys, shortcuts and app data names can never meet the user's real unimux. mainBinaryName stays `unimux`, so the
//    NSIS running-app check (Restart Manager on $INSTDIR\unimux.exe) is exercised exactly as in production.
// 2. Every case installs it silently into `<scratch>\<case>\Install Dir` (a space on purpose: /D= is unquoted), makes the
//    installed exe different from the payload (appended bytes, so "fully replaced" is provable by hash), starts that old app
//    on a scratch data dir and calls the test bridge `update-handover`, then watches the update window over its own DevTools
//    port (MC_UPDATE_DEBUG_PORT), its top-level window (foreground, WS_EX_TOPMOST, visible) through user32, the file signals
//    and every process whose image or command line is inside the scratch folder (plus any conhost.exe they own). It ends with
//    quitting the new app and `uninstall.exe /S`.
//
// Cases (all by default):
//    main      1.1.9 -> 1.2.0 (display), Escape early (note, hide), stages to done, relaunch, ready, cleanup.
//              --visible: the window on screen (MC_UPDATE_VISIBLE=1), the production show path; it must never become the
//              foreground window nor be topmost. --prestage: stage and warm the copy first.
//    guard     target 1.2.1 with a 0.5 s timeout: the timeout card (shown inactive), Escape on it hides the window while the
//              installer still runs, the installer still runs to the end and the window still starts the new app, which
//              must NOT write update/ready (it is 1.2.0, an "old build started mid-install"); then the window ends.
//    failed    an installer that does not exist: the error card says the install failed (not "taking longer"), Escape ends
//              the window, the install dir is untouched.
//    headless  a WebView2 data folder that cannot be created: no window, no work/shown, and still the install, the relaunch
//              and update/ready; the window process ends on its own.
//
// Never runs the real installer of unimux (productName unimux), never touches %APPDATA%\unimux or %LOCALAPPDATA%\unimux-updater,
// ends only processes it started (by pid, all of them inside the scratch folder).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { connectPage, freePort, realProfileMarkers, sha256, sleep } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const visible = process.argv.includes('--visible');
const prestage = process.argv.includes('--prestage');
const caseArg = process.argv.find((a) => a.startsWith('--case='));
const ALL = ['main', 'guard', 'failed', 'headless'];
const brokenWebviewAllowed = process.env.UNIMUX_SPIKE_BROKEN_WEBVIEW === '1';
const selected = (caseArg ? caseArg.slice('--case='.length).split(',').filter((c) => ALL.includes(c)) : ALL).filter((c) => {
  if (c !== 'headless' || brokenWebviewAllowed) return true;
  console.log('[sp6] skipping the headless case: it shows an Edge dialog on the desktop; set UNIMUX_SPIKE_BROKEN_WEBVIEW=1 to run it');
  return false;
});
const targetDir = join(root, 'src-tauri', 'target', 'sp6');
const bundleDir = join(targetDir, 'release', 'bundle', 'nsis');
const shots = join(root, 'artifacts', 'tauri-sp6');
mkdirSync(shots, { recursive: true });

if (process.platform !== 'win32') { console.log('SP6 Windows half only'); process.exit(0); }

const results = [];
let currentCase = '';
const check = (name, ok, detail = '') => { const full = `[${currentCase}] ${name}`; results.push({ name: full, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${full}${detail ? `: ${detail}` : ''}`); };
const t0 = Date.now();
const at = () => Date.now() - t0;

// ── the spike installer ─────────────────────────────────────────────────────
if (process.argv.includes('--build')) {
  const conf = join(tmpdir(), `unimux-sp6-tauri-${process.pid}.json`);
  writeFileSync(conf, JSON.stringify({ productName: 'unimux-sp6', identifier: 'com.unimux.sp6', mainBinaryName: 'unimux' }));
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'msvc-run.mjs'), '--target-dir=sp6', 'tauri', 'build', '--features', 'dev-overrides,test-bridge', '--bundles', 'nsis', '--config', conf], { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${join(root, 'node_modules', '.bin')};${process.env.PATH}` } });
  if (r.status !== 0) { console.error('spike installer build failed'); process.exit(1); }
}
const setupName = existsSync(bundleDir) ? readdirSync(bundleDir).find((n) => /^unimux-sp6_.*-setup\.exe$/.test(n)) : undefined;
if (!setupName) { console.error(`no spike installer in ${bundleDir}: run with --build`); process.exit(1); }
const payloadExe = join(targetDir, 'release', 'unimux.exe');

const markersBefore = realProfileMarkers();
const realUpdater = join(process.env.LOCALAPPDATA, 'unimux-updater');
const realUpdaterBefore = existsSync(realUpdater) ? readdirSync(realUpdater).sort().join(',') : '(none)';

const scratch = mkdtempSync(join(tmpdir(), 'unimux-sp6-'));
const setup = join(scratch, 'unimux-sp6-setup.exe');
copyFileSync(join(bundleDir, setupName), setup);
console.log(`scratch: ${scratch}`);

const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\unimux-sp6';
const regExists = (key) => spawnSync('reg', ['query', key], { stdio: 'ignore' }).status === 0;
const inside = (dir) => (p) => `${p.ExecutablePath ?? ''} ${p.CommandLine ?? ''}`.toLowerCase().includes(dir.toLowerCase());

/** PE subsystem of an exe: 2 = Windows GUI (no console), 3 = console. */
function subsystem(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  return b.readUInt16LE(pe + 24 + 68);
}

// ── process watcher: every process inside the scratch folder, and conhost.exe children of those ───────────────
const harnessPids = new Set();
const seen = new Map(); // pid -> {name, path, cmd, parent, first, last}
const conhosts = new Set();
const watcherScript = '$ErrorActionPreference="SilentlyContinue"; while ($true) { $p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine; [Console]::Out.WriteLine(($p | ConvertTo-Json -Compress -Depth 2)); [Console]::Out.Flush(); Start-Sleep -Milliseconds 200 }';
const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', watcherScript], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
let buffer = '';
let snapshots = 0;
let lastSnapshot = [];
watcher.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line.startsWith('[')) continue;
    let list;
    try { list = JSON.parse(line); } catch { continue; }
    snapshots++;
    const now = at();
    // The window poller below carries the scratch path in its command line: it is the harness, not ours.
    const ours = new Set(list.filter((p) => inside(scratch)(p) && !harnessPids.has(p.ProcessId)).map((p) => p.ProcessId));
    lastSnapshot = list.filter((p) => ours.has(p.ProcessId));
    for (const p of list) {
      if (ours.has(p.ProcessId)) {
        const s = seen.get(p.ProcessId) ?? { name: p.Name, parent: p.ParentProcessId, first: now };
        // A process that is just starting may not report its path yet.
        s.path ||= p.ExecutablePath;
        s.cmd ||= p.CommandLine;
        s.last = now;
        seen.set(p.ProcessId, s);
      }
      if (/^conhost\.exe$/i.test(p.Name ?? '') && ours.has(p.ParentProcessId)) conhosts.add(`${p.ProcessId} (parent ${p.ParentProcessId})`);
    }
  }
});
const waitSnapshot = async () => { const n = snapshots; while (snapshots < n + 2) await sleep(100); };

// ── window poller (user32): the foreground window's pid and the update window's top-level windows ───────────────
// The target pid is read from a file each tick (the harness writes it once the hand-over returned).
const targetFile = join(scratch, 'window-pid.txt');
writeFileSync(targetFile, '0');
const pollerScript = `$ErrorActionPreference="SilentlyContinue"
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class SpikeWin {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Snap(uint target) {
    uint fg; GetWindowThreadProcessId(GetForegroundWindow(), out fg);
    var sb = new StringBuilder("{\\"fg\\":" + fg + ",\\"wins\\":[");
    bool first = true;
    if (target != 0) EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        int ex = GetWindowLong(h, -20);
        if (!first) sb.Append(","); first = false;
        sb.Append("{\\"title\\":\\"" + t.ToString().Replace("\\\\", "").Replace("\\"", "") + "\\",\\"visible\\":" + (IsWindowVisible(h) ? "true" : "false") + ",\\"topmost\\":" + ((ex & 8) != 0 ? "true" : "false") + "}");
      }
      return true;
    }, IntPtr.Zero);
    return sb.Append("]}").ToString();
  }
}
"@
while ($true) { $t = 0; try { $t = [uint32]((Get-Content -Raw '${targetFile}').Trim()) } catch {}; [Console]::Out.WriteLine([SpikeWin]::Snap($t)); [Console]::Out.Flush(); Start-Sleep -Milliseconds 40 }`;
const poller = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', pollerScript], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
harnessPids.add(poller.pid);
let pollBuffer = '';
let winSamples = []; // {t, fg, target, wins}
let pollTarget = 0;
poller.stdout.on('data', (chunk) => {
  pollBuffer += chunk.toString('utf8');
  let i;
  while ((i = pollBuffer.indexOf('\n')) >= 0) {
    const line = pollBuffer.slice(0, i).trim();
    pollBuffer = pollBuffer.slice(i + 1);
    if (!line.startsWith('{')) continue;
    try { winSamples.push({ t: at(), target: pollTarget, ...JSON.parse(line) }); } catch { /* partial */ }
  }
});
const setPollTarget = (pid) => { pollTarget = pid; writeFileSync(targetFile, String(pid)); };
const mainWindow = (s) => s.wins.find((w) => w.title === 'unimux');

const timingsAll = {};
let failed = false;

async function runCase(name) {
  currentCase = name;
  const c = {
    main: { fromVersion: '1.1.9', escape: 'early', visible, prestage },
    guard: { version: '1.2.1', timeoutMs: 500, escape: 'error' },
    failed: { missingInstaller: true, escape: 'error' },
    headless: { brokenWebview: true },
  }[name];
  const version = c.version ?? '1.2.0';
  const caseDir = join(scratch, name);
  const installDir = join(caseDir, 'Install Dir');
  const dataDir = join(caseDir, 'data');
  const updaterRoot = join(caseDir, 'unimux-updater');
  mkdirSync(dataDir, { recursive: true });
  const ofCase = inside(caseDir);
  const children = [];
  const timings = { case: name };
  timingsAll[name] = timings;
  const caseStart = at();
  winSamples = [];
  try {
    // ── install ────────────────────────────────────────────────────────────
    let started = Date.now();
    const first = spawnSync(setup, ['/S', '/NS', `/D=${installDir}`], { windowsVerbatimArguments: true, stdio: 'ignore', timeout: 120000 });
    timings.firstInstallMs = Date.now() - started;
    const installedExe = join(installDir, 'unimux.exe');
    check('first silent install into a scratch dir with a space', first.status === 0 && existsSync(installedExe), `exit ${first.status}, ${existsSync(installDir) ? readdirSync(installDir).join(', ') : '-'} in ${timings.firstInstallMs} ms`);
    if (name === 'main') {
      check('spike installer and payload are GUI-subsystem (no console)', subsystem(setup) === 2 && subsystem(payloadExe) === 2, `setup ${subsystem(setup)}, unimux.exe ${subsystem(payloadExe)}`);
      check('spike product registered (and only that)', regExists(UNINSTALL_KEY));
    }
    // The bundler patches the exe in target/ before packing it; the installed file is the reference payload.
    const firstHash = sha256(readFileSync(installedExe));
    appendFileSync(installedExe, Buffer.concat([Buffer.alloc(4 * 1024 * 1024), Buffer.from('UNIMUX-SP6-OLD-BUILD')]));
    const oldHash = sha256(readFileSync(installedExe));
    const oldSize = statSync(installedExe).size;

    // ── the old app and the hand-over ────────────────────────────────────
    const appPort = await freePort();
    const windowPort = await freePort();
    const { env: homeEnv } = scratchHome(caseDir);
    const env = scrubAppEnv({ ...process.env, ...homeEnv, MC_DATA_DIR: dataDir, MC_DEBUG_PORT: String(appPort), MC_OFFSCREEN: '1', MC_UPDATE_DEBUG_PORT: String(windowPort) });
    const old = spawn(installedExe, [], { env, stdio: 'ignore', windowsHide: true, cwd: installDir });
    children.push(old);
    const oldExit = new Promise((res) => old.once('exit', (code) => res({ code, at: at() })));
    const page = await connectPage(appPort, { timeoutMs: 45000 });
    await sleep(1000);
    // --prestage: copy the runtime when the update is found (as 1.1.4 did), long before the hand-over, so an antivirus scan of
    // the new exe happens then and not while the user waits.
    if (c.prestage) {
      timings.prestage = await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op: 'update-stage', args: { updaterRoot, version } })})`);
      const warm = spawnSync(join(updaterRoot, `runtime-${version}`, 'unimux-update.exe'), ['--update-cleanup'], { stdio: 'ignore', timeout: 30000 });
      timings.prestage.warmExit = warm.status;
      await sleep(3000);
    }
    const installer = c.missingInstaller ? join(caseDir, 'missing-setup.exe') : setup;
    const args = { installer, updaterRoot, version };
    if (c.fromVersion) args.fromVersion = c.fromVersion;
    if (c.timeoutMs) args.timeoutMs = c.timeoutMs;
    if (c.visible) args.env = { MC_UPDATE_VISIBLE: '1' };
    let brokenWebview;
    if (c.brokenWebview) {
      // A file where WebView2 wants its user data folder: the environment cannot be created.
      brokenWebview = join(updaterRoot, 'webview2-broken');
      mkdirSync(updaterRoot, { recursive: true });
      writeFileSync(brokenWebview, 'not a folder');
      args.webviewDir = brokenWebview;
    }
    const handOverAt = at();
    const hand = await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op: 'update-handover', args })})`);
    page.close();
    timings.handOver = hand;
    const windowPid = hand.pid;
    setPollTarget(windowPid);
    const runtimeDir = join(updaterRoot, `runtime-${version}`);
    const runtimeExe = join(runtimeDir, 'unimux-update.exe');
    const config = JSON.parse(readFileSync(join(dataDir, 'update', 'work', 'config.json'), 'utf8'));
    const webviewDir = config.webviewDir;
    check('hand-over: runtime copy staged as unimux-update.exe', existsSync(runtimeExe) && hand.runtimeExe?.toLowerCase() === runtimeExe.toLowerCase(), `copy ${hand.copyMs} ms, spawn ${hand.spawnMs} ms`);
    if (c.brokenWebview) check('hand-over: no work/shown when WebView2 cannot start (the app exits anyway)', hand.shownMs === null || hand.shownMs === undefined, `${hand.shownMs}`);
    else check('hand-over: update window shown before the app exits (work/shown)', typeof hand.shownMs === 'number' && hand.shownMs < 4000, `${hand.shownMs} ms after spawn`);
    check('config: 1.1.x keys plus installer, installerArgs and a webview2-<id> folder of its own', config.oldPid === old.pid && config.installerArgs === `/S /UPDATE --updated /D=${installDir}` && (c.brokenWebview ? webviewDir === brokenWebview : /[\\/]webview2-\d+$/.test(webviewDir) && dirname(webviewDir).toLowerCase() === updaterRoot.toLowerCase()), `${config.installerArgs}; ${webviewDir}`);

    // ── watch ────────────────────────────────────────────────────────────
    let win;
    if (!c.brokenWebview) {
      for (let i = 0; i < 80 && !win; i++) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${windowPort}/json/list`)).json();
          const target = list.find((t) => t.type === 'page' && t.url.includes('/update-splash/'));
          if (target) win = await connectPage(windowPort, { match: target.id, timeoutMs: 5000 });
        } catch { /* not up yet */ }
        if (!win) await sleep(100);
      }
      check('update window page reachable over its own DevTools port', !!win, win?.target.url);
    }
    if (win && name === 'main') {
      // Which IPC transport the splash page uses under its own meta CSP (default-src 'none').
      const ipc = await win.evaluate(`(async () => {
        for (let i = 0; i < 100 && !window.updateSplash; i++) await new Promise((r) => setTimeout(r, 100));
        const probe = await fetch('http://ipc.localhost/update_splash_init', { method: 'POST', body: '{}' }).then((r) => 'allowed ' + r.status, (e) => 'refused (' + e.message + ')');
        const t = performance.now(); await window.updateSplash.init(); const initMs = performance.now() - t;
        return { probe, initMs: Math.round(initMs * 10) / 10, meta: document.querySelector('meta[http-equiv]')?.content };
      })()`);
      timings.ipc = ipc;
      check('splash page keeps its own meta CSP and window.updateSplash uses the ipc: custom protocol under it', /default-src 'none'/.test(ipc.meta ?? '') && ipc.probe.startsWith('allowed') && ipc.initMs < 5000, `fetch probe ${ipc.probe}, init ${ipc.initMs} ms`);
    }
    const stages = [];
    const samples = [];
    const shot = new Set();
    const flags = { installed: join(dataDir, 'update', 'installer-done'), ready: join(dataDir, 'update', 'ready'), heartbeat: join(dataDir, 'update', 'work', 'heartbeat') };
    const flagAt = {};
    let windowGoneAt;
    const deadline = Date.now() + 180000;
    let heartbeats = 0;
    let lastBeat = '';
    let escapeAt;
    let escapeHow;
    const pressEscape = async () => {
      escapeAt = at();
      try {
        await win.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => null);
        await win.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await win.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        escapeHow = 'CDP key';
      } catch (e) { escapeHow = `failed: ${e.message}`; }
    };
    const newAppOf = () => [...seen.entries()].find(([pid, s]) => s.path?.toLowerCase() === installedExe.toLowerCase() && pid !== old.pid && !/--update-cleanup/.test(s.cmd ?? ''));
    while (Date.now() < deadline) {
      for (const [k, f] of Object.entries(flags)) if (flagAt[k] === undefined && existsSync(f)) flagAt[k] = at();
      try { const beat = readFileSync(flags.heartbeat, 'utf8'); if (beat !== lastBeat) { lastBeat = beat; heartbeats++; } } catch { /* removed */ }
      if (win && windowGoneAt === undefined) {
        try {
          const s = await win.evaluate(`({ stage: document.querySelector('.card').dataset.stage, percent: document.getElementById('percent').textContent, status: document.getElementById('status').textContent, hint: document.getElementById('hint').textContent, from: document.querySelector('#versions .versions-from')?.textContent, to: document.querySelector('#versions .versions-to')?.textContent, chevron: !!document.querySelector('#versions svg.versions-arrow path'), versionsText: document.getElementById('versions').textContent, title: document.getElementById('title').textContent, actions: !document.getElementById('actions').hidden })`);
          samples.push({ t: at(), ...s });
          if (stages[stages.length - 1]?.stage !== s.stage) stages.push({ stage: s.stage, t: at(), percent: s.percent, status: s.status });
          if (!shot.has(s.stage)) {
            shot.add(s.stage);
            try { const { data } = await win.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, `${name}-${String(shot.size).padStart(2, '0')}-${s.stage}.png`), Buffer.from(data, 'base64')); } catch { /* window ending */ }
          }
          if (escapeAt === undefined && c.escape === 'early' && ['preparing', 'closing', 'installing'].includes(s.stage)) await pressEscape();
          if (escapeAt === undefined && c.escape === 'error' && s.stage === 'error') { await sleep(300); await pressEscape(); }
        } catch (e) {
          // A page that is still loading throws on the DOM; only a closed DevTools connection means the window ended.
          if (/closed/i.test(e.message)) windowGoneAt ??= at();
        }
      }
      const windowAlive = lastSnapshot.some((p) => p.ProcessId === windowPid);
      if (windowGoneAt === undefined && !windowAlive && seen.has(windowPid) && at() - caseStart > 2000) windowGoneAt = at();
      const leftovers = existsSync(runtimeDir) || (!c.brokenWebview && existsSync(webviewDir));
      const doneWhen = {
        main: flagAt.ready !== undefined,
        headless: flagAt.ready !== undefined,
        guard: !!newAppOf(),
        failed: escapeAt !== undefined,
      }[name];
      if (doneWhen && windowGoneAt !== undefined && !windowAlive && !leftovers) { timings.cleanedAt = at(); break; }
      await sleep(100);
    }
    const oldEnd = await Promise.race([oldExit, sleep(1).then(() => null)]);
    Object.assign(timings, { oldExitAt: oldEnd?.at, handOverAt, flags: flagAt, windowGoneAt, escapeAt, escapeHow });
    console.log('stages:', stages.map((s) => `${s.stage}@${s.t} ${s.percent} "${s.status}"`).join(' | '));
    const log = existsSync(join(dataDir, 'update', 'updater.log')) ? readFileSync(join(dataDir, 'update', 'updater.log'), 'utf8') : '';
    console.log(`updater.log:\n${log}`);
    const logAt = (re) => { const m = re.exec(log); return m ? log.slice(0, m.index).split('\n').length : -1; };
    timings.windowCreatedMs = Number((/window created \+(\d+) ms/.exec(log) ?? [])[1]);
    timings.windowShownMs = Number((/window shown \+(\d+) ms/.exec(log) ?? [])[1]);
    timings.installerMs = Number((/installer exited with Some\(0\) after (\d+) ms/.exec(log) ?? [])[1]) - Number((/old app exited after (\d+) ms/.exec(log) ?? [])[1]);
    const winInfo = seen.get(windowPid);
    const newApp = newAppOf();
    const newHash = sha256(readFileSync(installedExe));
    // The cleanup process may live shorter than one process snapshot: its start in updater.log counts too.
    const cleanup = [...seen.values()].find((s) => /--update-cleanup/.test(s.cmd ?? '') && (s.cmd ?? '').toLowerCase().includes(caseDir.toLowerCase())) ?? (/cleanup started \(pid \d+\)/.test(log) ? { first: 'log', last: 'log' } : undefined);

    // Window behaviour from user32: never the foreground window, never topmost, visible only when meant to be.
    const ofWindow = winSamples.filter((s) => s.target === windowPid);
    const fgHits = winSamples.filter((s) => s.fg === windowPid).length;
    const shownSamples = ofWindow.filter((s) => mainWindow(s)?.visible);
    if (!c.brokenWebview) {
      check('the update window never became the foreground window', fgHits === 0 && winSamples.length > 0, `${winSamples.length} samples, foreground pids ${[...new Set(winSamples.map((s) => s.fg))].join(',')}`);
      check('the update window is never always-on-top (no WS_EX_TOPMOST)', ofWindow.length > 0 && ofWindow.every((s) => s.wins.every((w) => !w.topmost)), `${ofWindow.length} samples with the window pid`);
      check('the window was visible (shown inactive)', shownSamples.length > 0, `${shownSamples.length} visible samples${c.visible ? ' (on screen)' : ' (off screen)'}`);
    }

    if (name === 'main' || name === 'headless') {
      const order = ['preparing', 'closing', 'installing', 'launching', 'done'];
      if (name === 'main') {
        const idx = stages.map((s) => order.indexOf(s.stage));
        check('stages move forward only and end in done', idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])) && stages.at(-1)?.stage === 'done', stages.map((s) => s.stage).join(' > '));
        const percents = samples.map((s) => parseInt(s.percent, 10)).filter((n) => !Number.isNaN(n));
        check('the bar never moves back', percents.every((p, i) => i === 0 || p >= percents[i - 1]), `${percents[0]}% .. ${percents.at(-1)}% over ${samples.length} samples`);
        const v = samples.find((s) => s.from);
        check('texts from config.strings (en); versions line = from + drawn chevron + to (no text arrow)', samples.some((s) => s.title === `Updating to version ${version}`) && v?.from === '1.1.9' && v?.to === version && v?.chevron && !/→/.test(v?.versionsText ?? '→'), v ? `"${v.from}" > "${v.to}", chevron ${v.chevron}` : 'no sample');
        const noted = samples.some((s) => s.status === 'The update continues in the background');
        const hidden = winSamples.some((s) => s.t > (escapeAt ?? Infinity) && s.target === windowPid && mainWindow(s) && !mainWindow(s).visible);
        const hiddenLog = /window hidden; the update goes on/.test(log);
        const finishedFirst = !hiddenLog && flagAt.ready !== undefined && flagAt.ready - (escapeAt ?? 0) < 3000;
        check('Escape while installing: the "continues in the background" note, then the window hides (it keeps working)', escapeAt !== undefined && noted && ((hidden && hiddenLog) || finishedFirst) && flagAt.ready !== undefined, `${escapeHow} at ${escapeAt} ms; note ${noted}; hidden ${hidden}, log ${hiddenLog}${finishedFirst ? ' (done within the note time)' : ''}`);
      } else {
        // The WebView2 start may fail only after the update is done (up to a minute here); the process does not wait for it.
        check('no window and no work/shown, and the update went on without them', !existsSync(join(dataDir, 'update', 'work', 'shown')) && !/window created|window shown/.test(log), (log.match(/update window (could not be created|runtime could not start)[^\n]*/) ?? ['window never created'])[0]);
      }
      check('old app exited after the hand-over (exit code 0)', oldEnd?.code === 0, `at ${oldEnd?.at} ms`);
      check('update window survived the old app exiting', winInfo && oldEnd && winInfo.last > oldEnd.at + 1000, `window seen ${winInfo?.first}..${winInfo?.last} ms, old exit ${oldEnd?.at} ms`);
      check('update window ran from the runtime copy', winInfo?.path?.toLowerCase() === runtimeExe.toLowerCase(), winInfo?.path);
      check('installer ran /S /UPDATE --updated /D=... through ShellExecuteExW and exited 0', /installer exited with Some\(0\)/.test(log) && /installer \S.* \/S \/UPDATE --updated \/D=.* started \(pid \d+, as this user/.test(log), (log.match(/installer [^\n]*started[^\n]*/) ?? [''])[0]);
      check('install dir fully replaced: unimux.exe is the payload', newHash === firstHash && newHash !== oldHash && statSync(installedExe).size !== oldSize, `${oldSize} -> ${statSync(installedExe).size} bytes`);
      check('install dir holds exactly the payload files', readdirSync(installDir).sort().join(',') === 'unimux.exe,uninstall.exe', readdirSync(installDir).join(', '));
      check('window stayed until the new app wrote update/ready', flagAt.ready !== undefined && winInfo && winInfo.last >= flagAt.ready, `ready at ${flagAt.ready} ms, window last seen ${winInfo?.last} ms`);
      check('ready written by the new version', existsSync(flags.ready) && readFileSync(flags.ready, 'utf8') === '1.2.0');
      check('heartbeat beat about once a second while supervising, removed at the end', heartbeats >= 3 && !existsSync(flags.heartbeat), `${heartbeats} beats`);
      check('new app started from the install dir', !!newApp && lastSnapshot.some((p) => p.ProcessId === newApp[0]), newApp ? `pid ${newApp[0]}` : 'none');
      check(`cleanup ran from the installed exe and removed the copy${c.brokenWebview ? '' : ' and the WebView2 folder'}`, !!cleanup && !existsSync(runtimeDir) && (c.brokenWebview || !existsSync(webviewDir)), cleanup ? `${cleanup.first}..${cleanup.last} ms` : 'no cleanup process');
    }
    if (name === 'guard') {
      const card = samples.find((s) => s.stage === 'error');
      check('timeout card: "taking longer than usual" with the hint and the buttons', card?.status === 'The update is taking longer than usual' && card?.hint === 'You can start unimux manually.' && card?.actions, card ? `"${card.status}" / "${card.hint}"` : stages.map((s) => s.stage).join(' > '));
      const hiddenAfter = winSamples.some((s) => s.t > (escapeAt ?? Infinity) && s.target === windowPid && mainWindow(s) && !mainWindow(s).visible);
      check('Escape on the timeout card hides the window while the update is still supervised', escapeAt !== undefined && hiddenAfter && /error card closed: the update is still supervised/.test(log), `${escapeHow} at ${escapeAt} ms, hidden ${hiddenAfter}; after: ${JSON.stringify(winSamples.filter((s) => s.t > (escapeAt ?? Infinity)).slice(0, 6).map((s) => [s.t - escapeAt, s.target, s.wins.map((w) => `${w.title}:${w.visible}`).join("/")]))}`);
      check('the installer still ran to the end after the timeout (exit 0)', logAt(/timed out after/) > 0 && logAt(/installer exited with Some\(0\)/) > logAt(/timed out after/), (log.match(/installer exited[^\n]*/) ?? ['no installer exit'])[0]);
      check('install dir fully replaced', newHash === firstHash && newHash !== oldHash);
      check('the window still started the new app after the timeout (1.1.4 --force-run outcome)', !!newApp && logAt(/started .*unimux\.exe \(pid/) > logAt(/timed out after/), newApp ? `pid ${newApp[0]}` : 'none');
      await sleep(3000);
      check('version guard: a 1.2.0 app started for a 1.2.1 update does not write update/ready', !existsSync(flags.ready) && config.version === '1.2.1');
      check('the hidden window ended once the new app was started, and cleaned up', windowGoneAt !== undefined && !existsSync(runtimeDir) && !existsSync(webviewDir) && !!cleanup, `gone at ${windowGoneAt} ms`);
    }
    if (name === 'failed') {
      const card = samples.find((s) => s.stage === 'error');
      check('failed install card: "Could not install the update." (not the timeout text) with the hint', card?.status === 'Could not install the update.' && card?.hint === 'You can start unimux manually.' && card?.actions, card ? `"${card.status}" / "${card.hint}"` : stages.map((s) => s.stage).join(' > '));
      check('the log names the reason', /installer .*missing-setup\.exe did not start/.test(log), (log.match(/installer [^\n]*did not start[^\n]*/) ?? ['none'])[0]);
      check('Escape on the failed card ends the window', escapeAt !== undefined && windowGoneAt !== undefined && windowGoneAt - escapeAt < 8000, `${escapeHow} at ${escapeAt} ms, gone at ${windowGoneAt} ms`);
      check('install dir untouched, no app started by the window', newHash === oldHash && !newApp && !existsSync(flags.installed));
      check('cleanup removed the copy and the WebView2 folder', !!cleanup && !existsSync(runtimeDir) && !existsSync(webviewDir));
    }
    check('no console window: no conhost.exe owned by any of our processes', conhosts.size === 0, [...conhosts].join(', '));

    // ── new app quits, nothing is left ─────────────────────────────────
    if (newApp) {
      try {
        const p = await connectPage(appPort, { timeoutMs: 20000 });
        await p.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
        p.close();
      } catch (e) { console.log(`new app not reachable: ${e.message}`); }
    }
    const dataDirOf = (p) => (/--user-data-dir="?([^"]+?)"?(\s--|$)/.exec(p.CommandLine ?? '') ?? [])[1] ?? '';
    // Everything the update machinery started (window, its WebView2, installer, cleanup) must be gone right after it ended.
    // headless: the WebView2 that failed to start belongs to WebView2, not to the window; it ends on its own (60 s check below).
    const isUpdater = (p) => ofCase(p) && !(c.brokenWebview && /^msedgewebview2\.exe$/i.test(p.Name ?? '')) && (/^(unimux-update|unimux-sp6-setup)\.exe$/i.test(p.Name ?? '') || /--update-cleanup/.test(p.CommandLine ?? '') || dataDirOf(p).toLowerCase().startsWith(updaterRoot.toLowerCase()));
    let updaterLeft = lastSnapshot.filter(isUpdater);
    for (let i = 0; i < 60 && updaterLeft.length; i++) { await sleep(250); updaterLeft = lastSnapshot.filter(isUpdater); }
    check('no orphan of the update window (window, its WebView2, installer, cleanup)', updaterLeft.length === 0, updaterLeft.map((p) => `${p.Name} ${p.ProcessId} ${(p.CommandLine ?? '').replace(scratch, '<scratch>').slice(0, 160)}`).join(' | '));
    const quitAt = at();
    // headless: WebView2 keeps the processes of an environment that failed to start for minutes on its own (they hold no file
    // of the update); listed, not counted. The harness ends them at the end of the case.
    const failedWebview = (p) => c.brokenWebview && /^msedgewebview2\.exe$/i.test(p.Name ?? '') && dataDirOf(p).toLowerCase().includes('webview2-broken');
    const caseLeft = () => lastSnapshot.filter((p) => ofCase(p) && !failedWebview(p));
    if (c.brokenWebview) console.log(`WebView2 of the failed environment still running: ${lastSnapshot.filter((p) => ofCase(p) && failedWebview(p)).map((p) => `${p.ProcessId} ${dataDirOf(p).replace(scratch, '<scratch>')}`).join(', ') || 'none'}`);
    for (let i = 0; i < 240 && caseLeft().length; i++) await sleep(250);
    await waitSnapshot();
    timings.allGoneAfterQuitMs = caseLeft().length ? null : at() - quitAt;
    check('no process left inside the case folder 60 s after the new app quit', caseLeft().length === 0, caseLeft().map((p) => `${p.Name} ${p.ProcessId} ${dataDirOf(p).replace(scratch, '<scratch>')}`).join(', ') || `all gone ${timings.allGoneAfterQuitMs} ms after quit`);
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    // Only what we started, all inside the case folder.
    for (const p of lastSnapshot.filter(ofCase)) { try { execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    setPollTarget(0);
    const uninstaller = join(installDir, 'uninstall.exe');
    if (existsSync(uninstaller)) {
      const r = spawnSync(uninstaller, ['/S'], { stdio: 'ignore', timeout: 120000 });
      for (let i = 0; i < 40 && regExists(UNINSTALL_KEY); i++) await sleep(250);
      check('spike product uninstalled (registry key gone)', r.status === 0 && !regExists(UNINSTALL_KEY), `exit ${r.status}`);
    }
    appendFileSync(join(shots, 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), case: name, visible: !!c.visible, prestage: !!timings.prestage, spawnMs: timings.handOver?.spawnMs, shownMs: timings.handOver?.shownMs ?? null, windowCreatedMs: timings.windowCreatedMs, windowShownMs: timings.windowShownMs, installerMs: timings.installerMs, readyAfterOldExitMs: timings.flags?.ready - timings.oldExitAt, windowExitAfterReadyMs: timings.windowGoneAt - timings.flags?.ready, passed: results.filter((r) => r.ok && r.name.startsWith(`[${name}]`)).length, total: results.filter((r) => r.name.startsWith(`[${name}]`)).length })}\n`);
  }
}

try {
  await waitSnapshot();
  for (const name of selected) await runCase(name);
} finally {
  currentCase = 'all';
  for (const p of lastSnapshot) { try { execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  try { watcher.kill(); } catch { /* gone */ }
  try { poller.kill(); } catch { /* gone */ }
  const markersAfter = realProfileMarkers();
  check('real profile untouched', JSON.stringify(markersBefore) === JSON.stringify(markersAfter), markersAfter.join('; '));
  const realUpdaterAfter = existsSync(realUpdater) ? readdirSync(realUpdater).sort().join(',') : '(none)';
  check('real %LOCALAPPDATA%\\unimux-updater untouched', realUpdaterBefore === realUpdaterAfter, realUpdaterAfter);
  writeFileSync(join(shots, 'timings.json'), JSON.stringify(timingsAll, null, 2));
  if (!keep) { await sleep(1000); removeScratch(scratch); } else console.log(`kept: ${scratch}`);
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(failed || bad.length ? 1 : 0);
