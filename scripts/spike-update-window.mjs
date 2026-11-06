// SP6 spike (docs/tauri/spikes/SP6.md): the custom update window process end to end on Windows, on scratch folders only.
//
//   node scripts/spike-update-window.mjs [--build] [--keep]
//
// 1. --build: builds a spike installer from the check flavour (dev-overrides + test-bridge, so every unimux.exe it starts
//    honours MC_DATA_DIR) into src-tauri/target/sp6, with productName `unimux-sp6` and identifier `com.unimux.sp6`: its
//    registry keys, shortcuts and app data names can never meet the user's real unimux. mainBinaryName stays `unimux`, so the
//    NSIS running-app check (Restart Manager on $INSTDIR\unimux.exe) is exercised exactly as in production.
// 2. Installs it silently into `<scratch>\Install Dir` (a space on purpose: /D= is unquoted), makes the installed exe
//    different from the payload (appended bytes, so "fully replaced" is provable by hash and the size valley is visible).
// 3. Starts that old app on a scratch data dir and calls the test bridge `update-handover` (copy to
//    `<scratch>\unimux-updater\runtime-1.2.0\unimux-update.exe`, config, detached start, wait for work/shown, app exits).
// 4. Watches the update window over its own DevTools port (MC_UPDATE_DEBUG_PORT), the file signals and every process whose
//    image or command line is inside the scratch folder (plus any conhost.exe they own), until the new app wrote update/ready,
//    the window ended and the cleanup removed the runtime copy.
// 5. Quits the new app, uninstalls the spike product silently, checks that its registry keys are gone, removes the scratch.
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
const targetDir = join(root, 'src-tauri', 'target', 'sp6');
const bundleDir = join(targetDir, 'release', 'bundle', 'nsis');
const shots = join(root, 'artifacts', 'tauri-sp6');
mkdirSync(shots, { recursive: true });

if (process.platform !== 'win32') { console.log('SP6 Windows half only'); process.exit(0); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const t0 = Date.now();
const at = () => Date.now() - t0;

// ── 1. the spike installer ──────────────────────────────────────────────────
if (process.argv.includes('--build')) {
  const conf = join(tmpdir(), `unimux-sp6-tauri-${process.pid}.json`);
  writeFileSync(conf, JSON.stringify({ productName: 'unimux-sp6', identifier: 'com.unimux.sp6', mainBinaryName: 'unimux' }));
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'msvc-run.mjs'), '--target-dir=sp6', 'tauri', 'build', '--features', 'dev-overrides,test-bridge', '--bundles', 'nsis', '--config', conf], { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${join(root, 'node_modules', '.bin')};${process.env.PATH}` } });
  if (r.status !== 0) { console.error('spike installer build failed'); process.exit(1); }
}
const setupName = existsSync(bundleDir) ? readdirSync(bundleDir).find((n) => /^unimux-sp6_.*-setup\.exe$/.test(n)) : undefined;
if (!setupName) { console.error(`no spike installer in ${bundleDir}: run with --build`); process.exit(1); }
const payloadExe = join(targetDir, 'release', 'unimux.exe');
const payloadHash = sha256(readFileSync(payloadExe));

const markersBefore = realProfileMarkers();
const realUpdater = join(process.env.LOCALAPPDATA, 'unimux-updater');
const realUpdaterBefore = existsSync(realUpdater) ? readdirSync(realUpdater).sort().join(',') : '(none)';

const scratch = mkdtempSync(join(tmpdir(), 'unimux-sp6-'));
const installDir = join(scratch, 'Install Dir');
const dataDir = join(scratch, 'data');
const updaterRoot = join(scratch, 'unimux-updater');
mkdirSync(dataDir, { recursive: true });
const setup = join(scratch, 'unimux-sp6-setup.exe');
copyFileSync(join(bundleDir, setupName), setup);
console.log(`scratch: ${scratch}`);

const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\unimux-sp6';
const regExists = (key) => spawnSync('reg', ['query', key], { stdio: 'ignore' }).status === 0;
const lower = scratch.toLowerCase();

/** PE subsystem of an exe: 2 = Windows GUI (no console), 3 = console. */
function subsystem(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  return b.readUInt16LE(pe + 24 + 68);
}

// ── process watcher: every process inside the scratch folder, and conhost.exe children of those ───────────────
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
    const ours = new Set();
    for (const p of list) {
      const text = `${p.ExecutablePath ?? ''} ${p.CommandLine ?? ''}`.toLowerCase();
      if (text.includes(lower)) ours.add(p.ProcessId);
    }
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
const ourProcesses = () => lastSnapshot.map((p) => `${p.Name} ${p.ProcessId}`);
const waitSnapshot = async () => { const n = snapshots; while (snapshots < n + 2) await sleep(100); };

const children = [];
let failed = false;
const timings = {};
try {
  await waitSnapshot();
  check('spike installer and payload are GUI-subsystem (no console)', subsystem(setup) === 2 && subsystem(payloadExe) === 2, `setup ${subsystem(setup)}, unimux.exe ${subsystem(payloadExe)}`);

  // ── 2. first install ──────────────────────────────────────────────────────
  let started = Date.now();
  const first = spawnSync(setup, ['/S', '/NS', `/D=${installDir}`], { windowsVerbatimArguments: true, stdio: 'ignore', timeout: 120000 });
  timings.firstInstallMs = Date.now() - started;
  const installedExe = join(installDir, 'unimux.exe');
  check('first silent install into a scratch dir with a space', first.status === 0 && existsSync(installedExe), `exit ${first.status}, ${readdirSync(installDir).join(', ')} in ${timings.firstInstallMs} ms`);
  check('spike product registered (and only that)', regExists(UNINSTALL_KEY));
  // The bundler patches the exe in target/ before packing it; the installed file is the reference payload.
  const firstHash = sha256(readFileSync(installedExe));
  console.log(`payload: installed ${firstHash.slice(0, 12)}, target ${payloadHash.slice(0, 12)}`);
  appendFileSync(installedExe, Buffer.concat([Buffer.alloc(4 * 1024 * 1024), Buffer.from('UNIMUX-SP6-OLD-BUILD')]));
  const oldHash = sha256(readFileSync(installedExe));
  const oldSize = statSync(installedExe).size;

  // ── 3. the old app and the hand-over ──────────────────────────────────────
  const appPort = await freePort();
  const windowPort = await freePort();
  const { env: homeEnv } = scratchHome(scratch);
  const env = scrubAppEnv({ ...process.env, ...homeEnv, MC_DATA_DIR: dataDir, MC_DEBUG_PORT: String(appPort), MC_OFFSCREEN: '1', MC_UPDATE_DEBUG_PORT: String(windowPort) });
  const old = spawn(installedExe, [], { env, stdio: 'ignore', windowsHide: true, cwd: installDir });
  children.push(old);
  const oldExit = new Promise((res) => old.once('exit', (code) => res({ code, at: at() })));
  const page = await connectPage(appPort, { timeoutMs: 45000 });
  await sleep(1000);
  // --prestage: copy the runtime when the update is found (as 1.1.4 did), long before the hand-over, so an antivirus scan of
  // the new exe happens then and not while the user waits.
  if (process.argv.includes('--prestage')) {
    timings.prestage = await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op: 'update-stage', args: { updaterRoot } })})`);
    // A first start of the copy outside the hand-over (what a warm-up would do): measured separately.
    const warm = spawnSync(join(updaterRoot, 'runtime-1.2.0', 'unimux-update.exe'), ['--update-cleanup'], { stdio: 'ignore', timeout: 30000 });
    timings.prestage.warmExit = warm.status;
    await sleep(3000);
  }
  const handOverAt = at();
  const hand = await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op: 'update-handover', args: { installer: setup, updaterRoot } })})`);
  page.close();
  timings.handOver = hand;
  if (timings.prestage) hand.prestage = timings.prestage;
  const runtimeExe = join(updaterRoot, 'runtime-1.2.0', 'unimux-update.exe');
  check('hand-over: runtime copy staged as unimux-update.exe', existsSync(runtimeExe) && hand.runtimeExe?.toLowerCase() === runtimeExe.toLowerCase(), `copy ${hand.copyMs} ms, spawn ${hand.spawnMs} ms`);
  check('hand-over: update window shown before the app exits (work/shown)', typeof hand.shownMs === 'number' && hand.shownMs < 4000, `${hand.shownMs} ms after spawn`);
  const config = JSON.parse(readFileSync(join(dataDir, 'update', 'work', 'config.json'), 'utf8'));
  check('config: 1.1.x keys plus installer, installerArgs, webviewDir', config.oldPid === old.pid && config.installerArgs === `/S /UPDATE --updated /D=${installDir}` && config.webviewDir.toLowerCase() === join(updaterRoot, 'webview2').toLowerCase(), config.installerArgs);

  // ── 4. watch ─────────────────────────────────────────────────────────────
  let win;
  for (let i = 0; i < 50 && !win; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${windowPort}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && t.url.includes('/update-splash/'));
      if (target) win = await connectPage(windowPort, { match: target.id, timeoutMs: 5000 });
    } catch { /* not up yet */ }
    if (!win) await sleep(100);
  }
  check('update window page reachable over its own DevTools port', !!win, win?.target.url);
  if (win) {
    // Which IPC transport the splash page uses under its own meta CSP (default-src 'none'): Tauri's ipc: custom protocol
    // (fetch to http://ipc.localhost, visible in resource timing) or the postMessage fallback.
    const ipc = await win.evaluate(`(async () => {
      const used = performance.getEntriesByType('resource').filter((e) => e.name.startsWith('http://ipc.localhost/')).map((e) => e.name.replace('http://ipc.localhost/', ''));
      const probe = await fetch('http://ipc.localhost/update_splash_init', { method: 'POST', body: '{}' }).then((r) => 'allowed ' + r.status, (e) => 'refused (' + e.message + ')');
      const t = performance.now(); await window.updateSplash.init(); const initMs = performance.now() - t;
      return { used, probe, initMs: Math.round(initMs * 10) / 10, meta: document.querySelector('meta[http-equiv]')?.content };
    })()`);
    timings.ipc = ipc;
    console.log(`splash IPC: ${JSON.stringify(ipc)}`);
    // Resource timing does not list every IPC fetch reliably, so the CSP itself is probed: a refused fetch means postMessage.
    check('splash page keeps its own meta CSP and window.updateSplash uses the ipc: custom protocol under it', /default-src 'none'/.test(ipc.meta ?? '') && ipc.probe.startsWith('allowed') && ipc.initMs < 5000, `ipc: ${ipc.used.length ? `custom protocol (${ipc.used.join(', ')})` : 'postMessage fallback'}, fetch probe ${ipc.probe}, init ${ipc.initMs} ms`);
  }
  const stages = [];
  const samples = [];
  let shot = new Set();
  const flags = { installed: join(dataDir, 'update', 'installer-done'), ready: join(dataDir, 'update', 'ready'), heartbeat: join(dataDir, 'update', 'work', 'heartbeat') };
  const flagAt = {};
  let windowGoneAt;
  const deadline = Date.now() + 180000;
  let windowPid = hand.pid;
  let heartbeats = 0;
  let lastBeat = '';
  while (Date.now() < deadline) {
    for (const [k, f] of Object.entries(flags)) if (flagAt[k] === undefined && existsSync(f)) flagAt[k] = at();
    try { const beat = readFileSync(flags.heartbeat, 'utf8'); if (beat !== lastBeat) { lastBeat = beat; heartbeats++; } } catch { /* removed */ }
    if (win && windowGoneAt === undefined) {
      try {
        const s = await win.evaluate(`({ stage: document.querySelector('.card').dataset.stage, percent: document.getElementById('percent').textContent, status: document.getElementById('status').textContent, versions: document.getElementById('versions').textContent, title: document.getElementById('title').textContent, visible: document.visibilityState })`);
        samples.push({ t: at(), ...s });
        if (stages[stages.length - 1]?.stage !== s.stage) stages.push({ stage: s.stage, t: at(), percent: s.percent, status: s.status });
        if (!shot.has(s.stage)) {
          shot.add(s.stage);
          try { const { data } = await win.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, `stage-${String(shot.size).padStart(2, '0')}-${s.stage}.png`), Buffer.from(data, 'base64')); } catch { /* window ending */ }
        }
      } catch { windowGoneAt ??= at(); }
    }
    const windowAlive = lastSnapshot.some((p) => p.ProcessId === windowPid);
    if (flagAt.ready !== undefined && !windowAlive && windowGoneAt === undefined) windowGoneAt = at();
    const leftovers = existsSync(join(updaterRoot, 'runtime-1.2.0')) || existsSync(join(updaterRoot, 'webview2'));
    if (flagAt.ready !== undefined && windowGoneAt !== undefined && !windowAlive && !leftovers) { timings.cleanedAt = at(); break; }
    await sleep(100);
  }
  const oldEnd = await Promise.race([oldExit, sleep(1).then(() => null)]);
  timings.oldExitAt = oldEnd?.at; timings.handOverAt = handOverAt; timings.flags = flagAt; timings.windowGoneAt = windowGoneAt;
  console.log('stages:', stages.map((s) => `${s.stage}@${s.t} ${s.percent} "${s.status}"`).join(' | '));
  const order = ['preparing', 'closing', 'installing', 'launching', 'done'];
  const idx = stages.map((s) => order.indexOf(s.stage));
  check('stages move forward only and end in done', idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])) && stages.at(-1)?.stage === 'done', stages.map((s) => s.stage).join(' > '));
  check('installing and launching were shown', stages.some((s) => s.stage === 'installing') && stages.some((s) => s.stage === 'launching'));
  const percents = samples.map((s) => parseInt(s.percent, 10)).filter((n) => !Number.isNaN(n));
  check('the bar never moves back', percents.every((p, i) => i === 0 || p >= percents[i - 1]), `${percents[0]}% .. ${percents.at(-1)}% over ${samples.length} samples`);
  check('texts from config.strings (en) and versions line', samples.some((s) => s.title === 'Updating to version 1.2.0') && samples.some((s) => s.versions === '1.2.0 → 1.2.0'));
  check('old app exited after the hand-over (exit code 0)', oldEnd?.code === 0, `at ${oldEnd?.at} ms`);
  const winInfo = seen.get(windowPid);
  check('update window survived the old app exiting', winInfo && oldEnd && winInfo.last > oldEnd.at + 1000, `window seen ${winInfo?.first}..${winInfo?.last} ms, old exit ${oldEnd?.at} ms`);
  check('update window ran from the runtime copy', winInfo?.path?.toLowerCase() === runtimeExe.toLowerCase(), winInfo?.path);
  const log = existsSync(join(dataDir, 'update', 'updater.log')) ? readFileSync(join(dataDir, 'update', 'updater.log'), 'utf8') : '';
  console.log(`updater.log:\n${log}`);
  timings.windowCreatedMs = Number((/window created \+(\d+) ms/.exec(log) ?? [])[1]);
  timings.windowShownMs = Number((/window shown \+(\d+) ms/.exec(log) ?? [])[1]);
  timings.installerMs = Number((/installer exited with Some\(0\) after (\d+) ms/.exec(log) ?? [])[1]) - Number((/old app exited after (\d+) ms/.exec(log) ?? [])[1]);
  check('installer ran /S /UPDATE --updated /D=... and exited 0', /installer exited with Some\(0\)/.test(log) && log.includes('/S /UPDATE --updated /D='), (log.match(/installer exited[^\n]*/) ?? [''])[0]);
  const newHash = sha256(readFileSync(installedExe));
  check('install dir fully replaced: unimux.exe is the payload', newHash === firstHash && newHash !== oldHash && statSync(installedExe).size !== oldSize, `${oldSize} -> ${statSync(installedExe).size} bytes`);
  check('install dir holds exactly the payload files', readdirSync(installDir).sort().join(',') === 'unimux.exe,uninstall.exe', readdirSync(installDir).join(', '));
  check('window stayed until the new app wrote update/ready', flagAt.ready !== undefined && winInfo && winInfo.last >= flagAt.ready, `ready at ${flagAt.ready} ms, window last seen ${winInfo?.last} ms`);
  check('ready written by the new version', existsSync(flags.ready) && readFileSync(flags.ready, 'utf8') === '1.2.0');
  check('heartbeat beat about once a second while supervising, removed at the end', heartbeats >= 3 && !existsSync(flags.heartbeat), `${heartbeats} beats`);
  const newApp = [...seen.entries()].find(([pid, s]) => s.path?.toLowerCase() === installedExe.toLowerCase() && pid !== old.pid && !/--update-cleanup/.test(s.cmd ?? ''));
  check('new app started from the install dir', !!newApp && lastSnapshot.some((p) => p.ProcessId === newApp[0]), newApp ? `pid ${newApp[0]}` : 'none');
  const cleanup = [...seen.values()].find((s) => /--update-cleanup/.test(s.cmd ?? ''));
  check('cleanup ran from the installed exe and removed the copy and the WebView2 folder', !!cleanup && !existsSync(join(updaterRoot, 'runtime-1.2.0')) && !existsSync(join(updaterRoot, 'webview2')), cleanup ? `${cleanup.first}..${cleanup.last} ms` : 'no cleanup process');
  timings.cleanupEndAt = cleanup?.last;
  check('no console window: no conhost.exe owned by any of our processes', conhosts.size === 0, [...conhosts].join(', '));
  timings.processes = [...seen.entries()].map(([pid, s]) => `${s.name} ${pid} ${s.first}..${s.last}`);

  // ── 5. new app quits, nothing is left ─────────────────────────────────────
  if (newApp) {
    try {
      const p = await connectPage(appPort, { timeoutMs: 20000 });
      await p.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
      p.close();
    } catch (e) { console.log(`new app not reachable: ${e.message}`); }
  }
  const dataDirOf = (p) => (/--user-data-dir="?([^"]+?)"?(\s--|$)/.exec(p.CommandLine ?? '') ?? [])[1] ?? '';
  // Everything the update machinery started (window, its WebView2, installer, cleanup) must be gone right after it ended.
  const isUpdater = (p) => /^(unimux-update|unimux-sp6-setup)\.exe$/i.test(p.Name ?? '') || /--update-cleanup/.test(p.CommandLine ?? '') || dataDirOf(p).toLowerCase().startsWith(updaterRoot.toLowerCase());
  let updaterLeft = lastSnapshot.filter(isUpdater);
  for (let i = 0; i < 60 && updaterLeft.length; i++) { await sleep(250); updaterLeft = lastSnapshot.filter(isUpdater); }
  check('no orphan of the update window (window, its WebView2, installer, cleanup)', updaterLeft.length === 0, updaterLeft.map((p) => `${p.Name} ${p.ProcessId} ${(p.CommandLine ?? '').replace(scratch, '<scratch>').slice(0, 160)}`).join(' | '));
  const quitAt = at();
  for (let i = 0; i < 240 && lastSnapshot.length; i++) await sleep(250);
  await waitSnapshot();
  timings.allGoneAfterQuitMs = lastSnapshot.length ? null : at() - quitAt;
  check('no process at all left inside the scratch folder 60 s after the new app quit', lastSnapshot.length === 0, lastSnapshot.map((p) => `${p.Name} ${p.ProcessId} ${dataDirOf(p).replace(scratch, '<scratch>')}`).join(', ') || `all gone ${timings.allGoneAfterQuitMs} ms after quit`);
  // Which WebView2 belonged to whom, and when each set ended.
  const byFolder = {};
  for (const s of seen.values()) {
    if (!/msedgewebview2/i.test(s.name ?? '')) continue;
    const dir = dataDirOf({ CommandLine: s.cmd }).replace(scratch, '<scratch>') || '?';
    byFolder[dir] = { count: (byFolder[dir]?.count ?? 0) + 1, last: Math.max(byFolder[dir]?.last ?? 0, s.last) };
  }
  timings.webview2 = byFolder;
  console.log(`webview2 processes: ${JSON.stringify(byFolder)} (window gone ${windowGoneAt}, quit ${quitAt})`);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  // Only what we started, all inside the scratch folder.
  for (const p of lastSnapshot) { try { execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  try { watcher.kill(); } catch { /* gone */ }
  const uninstaller = join(installDir, 'uninstall.exe');
  if (existsSync(uninstaller)) {
    const r = spawnSync(uninstaller, ['/S'], { stdio: 'ignore', timeout: 120000 });
    for (let i = 0; i < 40 && regExists(UNINSTALL_KEY); i++) await sleep(250);
    check('spike product uninstalled (registry key gone)', r.status === 0 && !regExists(UNINSTALL_KEY), `exit ${r.status}`);
  }
  const markersAfter = realProfileMarkers();
  check('real profile untouched', JSON.stringify(markersBefore) === JSON.stringify(markersAfter), markersAfter.join('; '));
  const realUpdaterAfter = existsSync(realUpdater) ? readdirSync(realUpdater).sort().join(',') : '(none)';
  check('real %LOCALAPPDATA%\\unimux-updater untouched', realUpdaterBefore === realUpdaterAfter, realUpdaterAfter);
  writeFileSync(join(shots, 'timings.json'), JSON.stringify(timings, null, 2));
  appendFileSync(join(shots, 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), prestage: !!timings.prestage, spawnMs: timings.handOver?.spawnMs, shownMs: timings.handOver?.shownMs ?? null, windowCreatedMs: timings.windowCreatedMs, windowShownMs: timings.windowShownMs, installerMs: timings.installerMs, readyAfterOldExitMs: timings.flags?.ready - timings.oldExitAt, windowExitAfterReadyMs: timings.windowGoneAt - timings.flags?.ready, cleanupEndAfterWindowMs: timings.cleanupEndAt - timings.windowGoneAt, passed: results.filter((r) => r.ok).length, total: results.length })}\n`);
  console.log(`timings: ${JSON.stringify({ ...timings, processes: undefined })}`);
  if (!keep) { await sleep(1000); removeScratch(scratch); } else console.log(`kept: ${scratch}`);
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(failed || bad.length ? 1 : 0);
