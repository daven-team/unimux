// U2 acceptance (docs/tauri/PLAN.md U2, grown from the SP6 spike): the custom update window process end to end on Windows, on
// scratch folders only, with a real NSIS update installer 1.2.0 -> 1.2.0-test.1.
//
//   node scripts/verify-update-window.mjs [--build] [--keep] [--prestage] [--case=main,guard,failed,webview,swap,rollback]
//
// Rules of this machine (PROGRESS.md): no test shows a dialog, message box or window on the user's desktop, and no installer
// registers in Apps & features. So:
//  - every window is off screen (MC_OFFSCREEN=1: position -6000, no taskbar button); `--visible` (window on screen) runs only
//    with UNIMUX_HARNESS_VISIBLE=1, for CI or a machine nobody works on;
//  - the payload installer is built from Tauri's own NSIS template with every registry write of the uninstall and product keys
//    commented out (`/UPDATE` already skips the shortcuts): nothing is registered, nothing needs uninstalling, and the harness
//    polls the registry and the shortcut folders to prove it;
//  - the old app is not installed: the 1.2.0 check build is copied into `<case>\Install Dir` (as if an earlier update had put
//    it there), and the update installer replaces it in place.
//
// --build makes both:
//   old app   src-tauri/target/check/release/unimux.exe   (`npm run build:check`: dev-overrides + test-bridge, version 1.2.0)
//   payload   src-tauri/target/u2/release/bundle/nsis/unimux-u2_1.2.0-test.1_x64-setup.exe   (productName `unimux-u2`,
//             identifier `com.unimux.u2`, mainBinaryName `unimux`, version 1.2.0-test.1 in tauri.conf and in the binary through
//             UNIMUX_VERSION_OVERRIDE, the patched template)
//
// Cases (all by default):
//   main     1.2.0 -> 1.2.0-test.1: the app hands over and winds down for 2.5 s (W6), the window shows preparing, closing,
//            installing, launching and done, the bar only moves forward, versions line = from + drawn chevron + to; Escape while
//            working shows "continues in the background" and hides; the installer replaces the install dir; the window starts
//            the new app, which writes update/ready = 1.2.0-test.1; the window closes and the cleanup removes the copy and the
//            WebView2 folder. --prestage stages and warms the copy first (U1 does it once the download is verified).
//   guard    target 1.2.1 with a 0.5 s timeout: the timeout card, Escape on it hides while supervised, the installer still
//            runs, the new app is still started and (being 1.2.0-test.1, an "old build started mid-install") writes no ready.
//   failed   a missing installer: the "Could not install the update." card, Escape ends the window, install dir untouched.
//   webview  the WebView2 data folders of the window AND of the app are files (WebView2 would show Edge's "cannot create data
//            directory" box): the pre-check takes fresh folders under %TEMP% instead, no dialog appears anywhere, the update
//            completes and the fallback folder of the window is removed.
//   swap     U5 (the macOS bundle swap, run here on a scratch "bundle" `<case>\Applications\unimux.app\Contents\MacOS\unimux.exe`):
//            the hand-over carries a swap plan instead of an installer; once the old app exited the window renames the bundle
//            to `unimux.app.old-<from>`, the staged `unimux.app.new-1.2.0-test.1` into place, starts the new app, which writes
//            update/ready, then removes the backup and the downloaded files; updates/mac/update.log has the steps.
//   rollback U5: the staged bundle's executable cannot be started: the window puts the old bundle back, starts it again,
//            writes updates/mac/rolled-back = 1.2.0-test.1 and shows "Could not install the update."; Escape ends it.
//
// --build also makes the swap payload: src-tauri/target/u5/release/unimux.exe (version 1.2.0-test.1, no bundle).
//
// Never runs the real installer of unimux, never touches %APPDATA%\unimux or %LOCALAPPDATA%\unimux-updater, ends only processes
// it started (by pid, all of them inside the scratch folder).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { connectPage, freePort, realProfileMarkers, sha256, sleep } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const visible = process.argv.includes('--visible') && process.env.UNIMUX_HARNESS_VISIBLE === '1';
if (process.argv.includes('--visible') && !visible) console.log('[u2] --visible ignored: it puts a window on the desktop; set UNIMUX_HARNESS_VISIBLE=1 to allow it');
const prestage = process.argv.includes('--prestage');
const caseArg = process.argv.find((a) => a.startsWith('--case='));
const ALL = ['main', 'guard', 'failed', 'webview', 'swap', 'rollback'];
const SWAP_CASES = ['swap', 'rollback'];
// U5: a non-executable file that `read_dir` lists before `unimux.exe` in Contents/MacOS of both scratch bundles.
const DECOY = 'aaa-sidecar.exe';
const selected = caseArg ? caseArg.slice('--case='.length).split(',').filter((c) => ALL.includes(c)) : ALL;
const PAYLOAD_VERSION = '1.2.0-test.1';
const OLD_VERSION = JSON.parse(readFileSync(join(root, 'src-tauri', 'crates', 'unimux-app', 'tauri.conf.json'), 'utf8')).version;
const PRODUCT = 'unimux-u2';
const PUBLISHER = JSON.parse(readFileSync(join(root, 'src-tauri', 'crates', 'unimux-app', 'tauri.conf.json'), 'utf8')).bundle.publisher;
const oldExeBuilt = join(root, 'src-tauri', 'target', 'check', 'release', 'unimux.exe');
const u2Dir = join(root, 'src-tauri', 'target', 'u2');
const bundleDir = join(u2Dir, 'release', 'bundle', 'nsis');
const payloadExe = join(u2Dir, 'release', 'unimux.exe');
const swapPayloadExe = join(root, 'src-tauri', 'target', 'u5', 'release', 'unimux.exe');
const shots = join(root, 'artifacts', 'tauri-u2');
mkdirSync(shots, { recursive: true });

if (process.platform !== 'win32') { console.log('U2 harness: Windows only (macOS installs through U5)'); process.exit(0); }

const results = [];
let currentCase = '';
const check = (name, ok, detail = '') => { const full = `[${currentCase}] ${name}`; results.push({ name: full, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${full}${detail ? `: ${detail}` : ''}`); };
const t0 = Date.now();
const at = () => Date.now() - t0;
/** An epoch time (file mtime, page Date.now(), updater.log ISO stamp) on the harness clock. */
const onClock = (epochMs) => (Number.isFinite(epochMs) ? Math.round(epochMs - t0) : undefined);
/** The installed exe is the payload with the bundle type Tauri's bundler writes into it while packing (`__TAURI_BUNDLE_TYPE_VAR_NSS`; the build output keeps `_UNK`). */
const payloadHashOf = (buffer) => sha256(Buffer.from(buffer.toString('latin1').replaceAll('__TAURI_BUNDLE_TYPE_VAR_NSS', '__TAURI_BUNDLE_TYPE_VAR_UNK'), 'latin1'));
// Records every render of the splash page in the page itself (the harness polls far slower than the window renders).
const RECORDER = `(() => { if (window.__u2) return true; const log = window.__u2 = []; const $ = (id) => document.getElementById(id); const snap = () => { const card = document.querySelector('.card'); if (!card || !card.dataset.stage) return; const s = { t: Date.now(), stage: card.dataset.stage, percent: $('percent').textContent, status: $('status').textContent, title: $('title').textContent, hint: $('hint').textContent, actions: !$('actions').hidden }; const l = log[log.length - 1]; if (!l || ['stage', 'percent', 'status', 'title', 'hint', 'actions'].some((k) => l[k] !== s[k])) log.push(s); }; snap(); new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); return true; })()`;

// ── the template without registry writes ─────────────────────────────────────
/** Tauri's NSIS template of the bundler the CLI embeds, from the cargo registry (the same version the CLI crate pins). */
function stockTemplate() {
  const cliVersion = JSON.parse(readFileSync(join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json'), 'utf8')).version;
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
  for (const index of existsSync(registry) ? readdirSync(registry) : []) {
    const cliToml = join(registry, index, `tauri-cli-${cliVersion}`, 'Cargo.toml');
    if (!existsSync(cliToml)) continue;
    const bundler = /\[dependencies\.tauri-bundler\]\s*\nversion = "=?([^"]+)"/.exec(readFileSync(cliToml, 'utf8'))?.[1];
    const template = join(registry, index, `tauri-bundler-${bundler}`, 'src', 'bundle', 'windows', 'nsis', 'installer.nsi');
    if (bundler && existsSync(template)) return { template, bundler, cliVersion };
  }
  throw new Error(`the NSIS template of @tauri-apps/cli ${cliVersion} is not in the cargo registry (cargo fetch tauri-cli@${cliVersion})`);
}

function patchedTemplate() {
  const { template, bundler } = stockTemplate();
  let count = 0;
  const text = readFileSync(template, 'utf8').split('\n').map((line) => {
    if (/^\s*WriteReg(Str|ExpandStr|DWORD)\s+SHCTX\s+"\$\{(UNINSTKEY|MANUPRODUCTKEY)\}"/.test(line)) { count++; return `  ; U2 harness, nothing registered: ${line.trim()}`; }
    return line;
  }).join('\n');
  if (count < 15) throw new Error(`template of tauri-bundler ${bundler}: only ${count} registry writes found, the harness patch needs updating`);
  const out = join(u2Dir, 'installer-no-registry.nsi');
  mkdirSync(u2Dir, { recursive: true });
  writeFileSync(out, text);
  console.log(`[u2] NSIS template of tauri-bundler ${bundler} with ${count} registry writes commented out: ${out}`);
  return out;
}

if (process.argv.includes('--build')) {
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'msvc-run.mjs'), ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env, PATH: `${join(root, 'node_modules', '.bin')};${process.env.PATH}` } });
    if (r.status !== 0) { console.error(`build failed: ${args.join(' ')}`); process.exit(1); }
  };
  run(['--target-dir=check', 'tauri', 'build', '--no-bundle', '--features', 'dev-overrides,test-bridge'], { UNIMUX_VERSION_OVERRIDE: '' });
  const conf = join(tmpdir(), `unimux-u2-tauri-${process.pid}.json`);
  writeFileSync(conf, JSON.stringify({ productName: PRODUCT, identifier: 'com.unimux.u2', mainBinaryName: 'unimux', version: PAYLOAD_VERSION, bundle: { windows: { nsis: { template: patchedTemplate(), installerHooks: null } } } }));
  try { run(['--target-dir=u2', 'tauri', 'build', '--features', 'dev-overrides,test-bridge', '--bundles', 'nsis', '--config', conf], { UNIMUX_VERSION_OVERRIDE: PAYLOAD_VERSION }); } finally { rmSync(conf, { force: true }); }
  // A config file, not inline JSON: msvc-run passes the arguments through a shell, which drops the quotes.
  const swapConf = join(tmpdir(), `unimux-u5-tauri-${process.pid}.json`);
  writeFileSync(swapConf, JSON.stringify({ version: PAYLOAD_VERSION }));
  try { run(['--target-dir=u5', 'tauri', 'build', '--no-bundle', '--features', 'dev-overrides,test-bridge', '--config', swapConf], { UNIMUX_VERSION_OVERRIDE: PAYLOAD_VERSION }); } finally { rmSync(swapConf, { force: true }); }
}
const setupName = existsSync(bundleDir) ? readdirSync(bundleDir).find((n) => n === `${PRODUCT}_${PAYLOAD_VERSION}_x64-setup.exe`) : undefined;
// The swap cases need no installer, only the payload exe.
const needSetup = selected.some((c) => !SWAP_CASES.includes(c));
const needSwap = selected.some((c) => SWAP_CASES.includes(c));
const missing = [needSetup && !setupName && `the payload installer in ${bundleDir}`, !existsSync(oldExeBuilt) && oldExeBuilt, needSwap && !existsSync(swapPayloadExe) && swapPayloadExe].filter(Boolean);
if (missing.length) { console.error(`missing ${missing.join(', ')}: run with --build`); process.exit(1); }
const payloadHash = needSetup ? payloadHashOf(readFileSync(payloadExe)) : undefined;
const swapPayloadHash = needSwap ? payloadHashOf(readFileSync(swapPayloadExe)) : undefined;

const markersBefore = realProfileMarkers();
const realUpdater = join(process.env.LOCALAPPDATA, 'unimux-updater');
const realUpdaterBefore = existsSync(realUpdater) ? readdirSync(realUpdater).sort().join(',') : '(none)';

const scratch = mkdtempSync(join(tmpdir(), 'unimux-u2-'));
const setup = join(scratch, 'unimux-u2-setup.exe');
if (setupName) copyFileSync(join(bundleDir, setupName), setup);
console.log(`scratch: ${scratch}`);

// ── nothing registered, no shortcut ─────────────────────────────────────────
const REG_KEYS = [`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT}`, `HKCU\\Software\\${PUBLISHER}\\${PRODUCT}`, `HKCU\\Software\\u2\\${PRODUCT}`];
const regExists = (key) => spawnSync('reg', ['query', key], { stdio: 'ignore' }).status === 0;
const SHORTCUTS = [join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT}.lnk`), join(homedir(), 'Desktop', `${PRODUCT}.lnk`), join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop', `${PRODUCT}.lnk`)];
const registered = () => [...REG_KEYS.filter(regExists), ...SHORTCUTS.filter((s) => existsSync(s))];
const registeredBefore = registered();
let registeredSeen = new Set();
const regPoll = setInterval(() => { for (const r of registered()) registeredSeen.add(r); }, 1000);

const inside = (dir) => (p) => `${p.ExecutablePath ?? ''} ${p.CommandLine ?? ''}`.toLowerCase().includes(dir.toLowerCase());

/** PE subsystem of an exe: 2 = Windows GUI (no console), 3 = console. */
function subsystem(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  return b.readUInt16LE(pe + 24 + 68);
}

// ── process watcher: every process inside the scratch folder, conhost.exe children of those, and every pid's name ──────
const harnessPids = new Set();
const seen = new Map(); // pid -> {name, path, cmd, parent, first, last}
const names = new Map(); // pid -> image name (all processes), for the dialog check
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
    const ours = new Set(list.filter((p) => inside(scratch)(p) && !harnessPids.has(p.ProcessId)).map((p) => p.ProcessId));
    lastSnapshot = list.filter((p) => ours.has(p.ProcessId));
    for (const p of list) {
      names.set(p.ProcessId, p.Name);
      if (ours.has(p.ProcessId)) {
        const s = seen.get(p.ProcessId) ?? { name: p.Name, parent: p.ParentProcessId, first: now };
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

// ── window poller (user32): the foreground window's pid, the update window's top-level windows, and every visible dialog ──
const targetFile = join(scratch, 'window-pid.txt');
writeFileSync(targetFile, '0');
const pollerScript = `$ErrorActionPreference="SilentlyContinue"
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class U2Win {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  static string Clean(string s) { return s.Replace("\\\\", "/").Replace("\\"", "'"); }
  public static string Snap(uint target) {
    uint fg; GetWindowThreadProcessId(GetForegroundWindow(), out fg);
    var sb = new StringBuilder("{\\"fg\\":" + fg + ",\\"wins\\":[");
    var dialogs = new StringBuilder();
    bool first = true;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      var cls = new StringBuilder(64); GetClassName(h, cls, 64);
      if (IsWindowVisible(h) && cls.ToString() == "#32770") {
        var dt = new StringBuilder(256); GetWindowText(h, dt, 256);
        if (dialogs.Length > 0) dialogs.Append(",");
        dialogs.Append("{\\"pid\\":" + p + ",\\"title\\":\\"" + Clean(dt.ToString()) + "\\"}");
      }
      if (target != 0 && p == target) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        int ex = GetWindowLong(h, -20);
        if (!first) sb.Append(","); first = false;
        sb.Append("{\\"title\\":\\"" + Clean(t.ToString()) + "\\",\\"visible\\":" + (IsWindowVisible(h) ? "true" : "false") + ",\\"topmost\\":" + ((ex & 8) != 0 ? "true" : "false") + "}");
      }
      return true;
    }, IntPtr.Zero);
    return sb.Append("],\\"dialogs\\":[").Append(dialogs.ToString()).Append("]}").ToString();
  }
}
"@
while ($true) { $t = 0; try { $t = [uint32]((Get-Content -Raw '${targetFile}').Trim()) } catch {}; [Console]::Out.WriteLine([U2Win]::Snap($t)); [Console]::Out.Flush(); Start-Sleep -Milliseconds 40 }`;
const poller = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', pollerScript], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
harnessPids.add(poller.pid);
let pollBuffer = '';
let winSamples = []; // {t, fg, target, wins, dialogs}
let pollTarget = 0;
const dialogsBefore = new Set();
let pollerReady = false;
const newDialogs = new Map(); // `${pid} ${title}` -> {pid, name, title, t}
poller.stdout.on('data', (chunk) => {
  pollBuffer += chunk.toString('utf8');
  let i;
  while ((i = pollBuffer.indexOf('\n')) >= 0) {
    const line = pollBuffer.slice(0, i).trim();
    pollBuffer = pollBuffer.slice(i + 1);
    if (!line.startsWith('{')) continue;
    let s;
    try { s = JSON.parse(line); } catch { continue; }
    winSamples.push({ t: at(), target: pollTarget, ...s });
    for (const d of s.dialogs ?? []) {
      const key = `${d.pid} ${d.title}`;
      if (!pollerReady) dialogsBefore.add(key);
      else if (!dialogsBefore.has(key) && !newDialogs.has(key)) newDialogs.set(key, { ...d, name: names.get(d.pid), t: at() });
    }
    pollerReady = true;
  }
});
const setPollTarget = (pid) => { pollTarget = pid; writeFileSync(targetFile, String(pid)); };
const mainWindow = (s) => s.wins.find((w) => w.title === 'unimux');
/** A dialog that is ours or WebView2's (Edge's "cannot create data directory" box belongs to msedgewebview2.exe). */
const ourDialogs = () => [...newDialogs.values()].filter((d) => seen.has(d.pid) || /^msedgewebview2\.exe$/i.test(d.name ?? ''));

const timingsAll = {};
let failed = false;

async function runCase(name) {
  currentCase = name;
  const c = {
    main: { escape: 'early', visible, prestage, windDownMs: 2500 },
    guard: { version: '1.2.1', timeoutMs: 500, escape: 'error' },
    failed: { missingInstaller: true, escape: 'error' },
    webview: { brokenWebview: true },
    swap: { swap: true, windDownMs: 1500 },
    rollback: { swap: true, brokenNew: true, escape: 'error' },
  }[name];
  const version = c.version ?? PAYLOAD_VERSION;
  const caseDir = join(scratch, name);
  // U5: the "bundle" of the swap cases (the macOS layout; the executable keeps its .exe name here).
  const bundle = c.swap ? join(caseDir, 'Applications', 'unimux.app') : undefined;
  const newBundle = c.swap ? `${bundle}.new-${PAYLOAD_VERSION}` : undefined;
  const backup = c.swap ? `${bundle}.old-${OLD_VERSION}` : undefined;
  const installDir = c.swap ? join(bundle, 'Contents', 'MacOS') : join(caseDir, 'Install Dir');
  const dataDir = join(caseDir, 'data');
  const updaterRoot = join(caseDir, 'unimux-updater');
  const tempDir = join(caseDir, 'temp');
  for (const d of [dataDir, installDir, tempDir]) mkdirSync(d, { recursive: true });
  const ofCase = inside(caseDir);
  const children = [];
  const timings = { case: name };
  timingsAll[name] = timings;
  const caseStart = at();
  winSamples = [];
  try {
    // ── the old app: the 1.2.0 build in the install dir (never installed, nothing registered) ─────────────────────
    const installedExe = join(installDir, 'unimux.exe');
    copyFileSync(oldExeBuilt, installedExe);
    const oldHash = payloadHashOf(readFileSync(installedExe));
    const oldSize = statSync(installedExe).size;
    let download;
    if (c.swap) {
      // The verified new bundle staged next to the installed one, and what the engine downloaded (removed after the swap).
      mkdirSync(join(newBundle, 'Contents', 'MacOS'), { recursive: true });
      const newExe = join(newBundle, 'Contents', 'MacOS', 'unimux.exe');
      if (c.brokenNew) writeFileSync(newExe, 'not an executable');
      else copyFileSync(swapPayloadExe, newExe);
      // A file listed before the executable in both bundles (a sidecar, a log): only the plan's `executable` may be started.
      for (const dir of [installDir, join(newBundle, 'Contents', 'MacOS')]) writeFileSync(join(dir, DECOY), 'not the app');
      writeFileSync(join(newBundle, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleShortVersionString</key><string>${PAYLOAD_VERSION}</string></dict></plist>`);
      download = join(dataDir, 'updates', 'mac', `unimux-${PAYLOAD_VERSION}-mac-x64.app.tar.gz.extract`);
      mkdirSync(download, { recursive: true });
      writeFileSync(join(download, 'archive'), 'downloaded');
    }
    if (name === 'main') {
      check('payload installer and both exes are GUI-subsystem (no console)', subsystem(setup) === 2 && subsystem(payloadExe) === 2 && subsystem(installedExe) === 2, `setup ${subsystem(setup)}, payload ${subsystem(payloadExe)}, old ${subsystem(installedExe)}`);
      check('old app and payload differ', oldHash !== payloadHash, `${oldSize} vs ${statSync(payloadExe).size} bytes`);
    }
    let appWebviewFile;
    if (c.brokenWebview) {
      // The app's own WebView2 folder is a file too: the main app's pre-check must not hand it to WebView2.
      appWebviewFile = join(dataDir, 'webview2');
      writeFileSync(appWebviewFile, 'not a folder');
    }

    // ── the old app and the hand-over ────────────────────────────────────
    const appPort = await freePort();
    const windowPort = await freePort();
    const { env: homeEnv } = scratchHome(caseDir);
    const env = scrubAppEnv({ ...process.env, ...homeEnv, TEMP: tempDir, TMP: tempDir, MC_DATA_DIR: dataDir, MC_DEBUG_PORT: String(appPort), MC_OFFSCREEN: '1', MC_UPDATE_DEBUG_PORT: String(windowPort) });
    // A swap renames the bundle: the old app (and its WebView2 processes) must not have it as the working directory (macOS
    // renames open folders, Windows does not).
    const old = spawn(installedExe, [], { env, stdio: 'ignore', windowsHide: true, cwd: c.swap ? caseDir : installDir });
    children.push(old);
    const oldExit = new Promise((res) => old.once('exit', (code) => res({ code, at: at() })));
    const page = await connectPage(appPort, { timeoutMs: 45000 });
    await sleep(1000);
    if (c.brokenWebview) {
      const crash = existsSync(join(dataDir, 'crash.log')) ? readFileSync(join(dataDir, 'crash.log'), 'utf8') : '';
      check('main app: a file in place of <data>/webview2 is refused and a %TEMP% folder used (logged), the app runs', /WebView2 data folder not usable: .*webview2: not a directory/.test(crash) && /WebView2 data folder: using .*unimux-webview2/.test(crash) && readFileSync(appWebviewFile, 'utf8') === 'not a folder', (crash.match(/WebView2 data folder[^\n]*/g) ?? ['nothing logged']).join(' | '));
    }
    if (c.prestage) {
      timings.prestage = await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op: 'update-stage', args: { updaterRoot, version } })})`);
      check('prestage: copy staged and warmed (one --update-cleanup start that exits at once)', typeof timings.prestage?.warmMs === 'number' && timings.prestage.warmMs < 10000 && existsSync(join(updaterRoot, `runtime-${version}`, 'unimux-update.exe')), JSON.stringify(timings.prestage));
    }
    const installer = c.missingInstaller ? join(caseDir, 'missing-setup.exe') : setup;
    // The app exits this long after the hand-over answered (W6's wind-down); a second, so the answer reaches the harness on a
    // loaded machine.
    const args = { installer, updaterRoot, version, windDownMs: c.windDownMs ?? 1000 };
    const macDir = join(dataDir, 'updates', 'mac');
    const plan = c.swap ? { bundle, newBundle, backup, executable: 'unimux.exe', log: join(macDir, 'update.log'), readyFlag: join(macDir, 'ready'), failedFlag: join(macDir, 'rolled-back'), cleanup: [download], fromVersion: OLD_VERSION, toVersion: PAYLOAD_VERSION } : undefined;
    if (c.swap) { delete args.installer; args.swap = plan; }
    if (c.timeoutMs) args.timeoutMs = c.timeoutMs;
    if (c.visible) args.env = { MC_UPDATE_VISIBLE: '1' };
    let brokenWebview;
    if (c.brokenWebview) {
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
    // 1.1.4's SHOWN_WAIT (4 s) is how long the app waits for the window, not a promise: on a loaded machine WebView2 takes
    // longer and the app winds down anyway (the update does not depend on it). The case fails only when the window never
    // shows; a late show is reported (PROGRESS.md U2 open issues).
    const shownLate = !(typeof hand.shownMs === 'number' && hand.shownMs < 4000);
    timings.shownLate = shownLate;
    if (c.swap) check('config: a swap plan instead of the installer, installDir = the bundle', config.oldPid === old.pid && config.installer === undefined && config.installerArgs === undefined && config.installDir === bundle && JSON.stringify(config.swap) === JSON.stringify(plan), `${config.fromVersion} -> ${config.version}; swap ${config.swap?.bundle} <- ${config.swap?.newBundle}`);
    else check('config: 1.1.x keys plus installer, installerArgs and a webview2 folder of its own', config.oldPid === old.pid && config.fromVersion === OLD_VERSION && config.installerArgs === `/S /UPDATE --updated /D=${installDir}` && (c.brokenWebview ? webviewDir === brokenWebview : /[\\/]webview2-\d+$/.test(webviewDir) && dirname(webviewDir).toLowerCase() === updaterRoot.toLowerCase()), `${config.fromVersion} -> ${config.version}; ${config.installerArgs}; ${webviewDir}`);

    // ── watch ────────────────────────────────────────────────────────────
    let win;
    for (let i = 0; i < 300 && !win; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${windowPort}/json/list`)).json();
        const target = list.find((t) => t.type === 'page' && t.url.includes('/update-splash/'));
        if (target) win = await connectPage(windowPort, { match: target.id, timeoutMs: 5000 });
      } catch { /* not up yet */ }
      if (!win) await sleep(100);
    }
    check('update window page reachable over its own DevTools port', !!win, win?.target.url);
    const pageLog = [];
    if (win) await win.evaluate(RECORDER).catch(() => null);
    const pullPageLog = async () => {
      const more = await win.evaluate(`(window.__u2 || []).slice(${pageLog.length})`);
      for (const e of more ?? []) pageLog.push({ ...e, t: onClock(e.t) });
    };
    if (win && name === 'main') {
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
    let usedWebview;
    while (Date.now() < deadline) {
      for (const [k, f] of Object.entries(flags)) if (flagAt[k] === undefined && existsSync(f)) { try { flagAt[k] = onClock(statSync(f).mtimeMs); } catch { /* removed meanwhile */ } }
      try { const beat = readFileSync(flags.heartbeat, 'utf8'); if (beat !== lastBeat) { lastBeat = beat; heartbeats++; } } catch { /* removed */ }
      // The folder the window really used when it refused the configured one (updater.log names it).
      if (c.brokenWebview && usedWebview === undefined) {
        try { usedWebview = /WebView2 data folder: using (.+)$/m.exec(readFileSync(join(dataDir, 'update', 'updater.log'), 'utf8'))?.[1]?.trim(); } catch { /* not yet */ }
      }
      if (win && windowGoneAt === undefined) {
        try {
          const s = await win.evaluate(`({ stage: document.querySelector('.card').dataset.stage, percent: document.getElementById('percent').textContent, status: document.getElementById('status').textContent, hint: document.getElementById('hint').textContent, from: document.querySelector('#versions .versions-from')?.textContent, to: document.querySelector('#versions .versions-to')?.textContent, toBrighter: (() => { const f = document.querySelector('#versions .versions-from'), t = document.querySelector('#versions .versions-to'); if (!f || !t) return null; const l = (el) => getComputedStyle(el).color.match(/\\d+/g).slice(0, 3).reduce((a, b) => a + Number(b), 0); return l(t) > l(f); })(), chevron: !!document.querySelector('#versions svg.versions-arrow path'), versionsText: document.getElementById('versions').textContent, title: document.getElementById('title').textContent, actions: !document.getElementById('actions').hidden })`);
          await pullPageLog();
          samples.push({ t: at(), ...s });
          if (stages[stages.length - 1]?.stage !== s.stage) stages.push({ stage: s.stage, t: at(), percent: s.percent, status: s.status });
          if (!shot.has(s.stage)) {
            shot.add(s.stage);
            try { const { data } = await win.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, `${name}-${String(shot.size).padStart(2, '0')}-${s.stage}.png`), Buffer.from(data, 'base64')); } catch { /* window ending */ }
          }
          // Escape once the bar is past "closing" (the user closes the window while the installer works).
          if (escapeAt === undefined && c.escape === 'early' && s.stage === 'installing') await pressEscape();
          if (escapeAt === undefined && c.escape === 'error' && s.stage === 'error') { await sleep(300); await pressEscape(); }
        } catch (e) {
          if (/closed/i.test(e.message)) windowGoneAt ??= at();
        }
      }
      const windowAlive = lastSnapshot.some((p) => p.ProcessId === windowPid);
      if (windowGoneAt === undefined && !windowAlive && seen.has(windowPid) && at() - caseStart > 2000) windowGoneAt = at();
      const leftovers = existsSync(runtimeDir) || (!c.brokenWebview && existsSync(webviewDir)) || (usedWebview && existsSync(usedWebview));
      const doneWhen = {
        main: flagAt.ready !== undefined,
        webview: flagAt.ready !== undefined,
        guard: !!newAppOf(),
        failed: escapeAt !== undefined,
        swap: flagAt.ready !== undefined,
        rollback: escapeAt !== undefined,
      }[name];
      if (doneWhen && windowGoneAt !== undefined && !windowAlive && !leftovers) { timings.cleanedAt = at(); break; }
      await sleep(100);
    }
    const oldEnd = await Promise.race([oldExit, sleep(1).then(() => null)]);
    Object.assign(timings, { oldExitAt: oldEnd?.at, handOverAt, flags: flagAt, windowGoneAt, escapeAt, escapeHow });
    if (win) await pullPageLog().catch(() => null);
    // What the page rendered, from its own recorder (every render, page clock = harness clock).
    const pageStages = [];
    for (const e of pageLog) if (pageStages.at(-1)?.stage !== e.stage) pageStages.push(e);
    console.log('page stages:', pageStages.map((s) => `${s.stage}@${s.t} ${s.percent} "${s.status}"`).join(' | '), `(${pageLog.length} renders; harness samples ${stages.length} stages)`);
    const log = existsSync(join(dataDir, 'update', 'updater.log')) ? readFileSync(join(dataDir, 'update', 'updater.log'), 'utf8') : '';
    const logTime = (re) => { const m = new RegExp(String.raw`^(\S+) \w+ ` + re.source, 'm').exec(log); return m ? onClock(Date.parse(m[1])) : undefined; };
    // The window process's own exit time (its log), not the harness's slower notice of it.
    const windowExitAt = logTime(/update window exits/) ?? windowGoneAt;
    timings.windowExitAt = windowExitAt;
    console.log(`updater.log:\n${log}`);
    const logAt = (re) => { const m = re.exec(log); return m ? log.slice(0, m.index).split('\n').length : -1; };
    timings.windowCreatedMs = Number((/window created \+(\d+) ms/.exec(log) ?? [])[1]);
    timings.windowShownMs = Number((/window shown \+(\d+) ms/.exec(log) ?? [])[1]);
    timings.installerMs = Number((/installer exited with Some\(0\) after (\d+) ms/.exec(log) ?? [])[1]) - Number((/old app exited after (\d+) ms/.exec(log) ?? [])[1]);
    const winInfo = seen.get(windowPid);
    const newApp = newAppOf();
    const newHash = payloadHashOf(readFileSync(installedExe));
    const cleanup = [...seen.values()].find((s) => /--update-cleanup/.test(s.cmd ?? '') && /--wait=/.test(s.cmd ?? '') && (s.cmd ?? '').toLowerCase().includes(caseDir.toLowerCase())) ?? (/cleanup started \(pid \d+\)/.test(log) ? { first: 'log', last: 'log' } : undefined);

    check('the window showed (updater.log "window shown", work/shown)', /window shown \+\d+ ms/.test(log), `work/shown ${hand.shownMs ?? 'later than the 4 s'} ms after the spawn${shownLate ? ' (late: the app wound down before it, as on a loaded machine)' : ''}; window shown +${timings.windowShownMs} ms after the process start`);
    // Window behaviour from user32: never the foreground window, never topmost, visible only when meant to be.
    const ofWindow = winSamples.filter((s) => s.target === windowPid);
    const fgHits = winSamples.filter((s) => s.fg === windowPid).length;
    const shownSamples = ofWindow.filter((s) => mainWindow(s)?.visible);
    check('the update window never became the foreground window', fgHits === 0 && winSamples.length > 0, `${winSamples.length} samples, foreground pids ${[...new Set(winSamples.map((s) => s.fg))].join(',')}`);
    check('the update window is never always-on-top (no WS_EX_TOPMOST)', ofWindow.length > 0 && ofWindow.every((s) => s.wins.every((w) => !w.topmost)), `${ofWindow.length} samples with the window pid`);
    check('the window was visible (shown inactive)', shownSamples.length > 0, `${shownSamples.length} visible samples${c.visible ? ' (on screen)' : ' (off screen)'}`);

    if (name === 'main' || name === 'webview') {
      const order = ['preparing', 'closing', 'installing', 'launching', 'done'];
      const logStages = [...log.matchAll(/stage (\w+) after (\d+) ms/g)].map((m) => m[1]);
      if (name === 'main') {
        // The page renders the state it is pushed; it starts at the current stage once WebView2 is up (preparing lasts about
        // 1.5 s, WebView2 takes 1-5 s), and after Escape (installing) the window is hidden, where WebView2 may batch the
        // launching and done renders. So: a forward-only run up to installing here, every later stage in the webview case
        // (never hidden), all five in the log.
        const idx = pageStages.map((s) => order.indexOf(s.stage));
        check('the page showed the stages forward only, up to installing before Escape', idx.length > 0 && idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])) && pageStages.some((x) => x.stage === 'installing'), pageStages.map((s) => `${s.stage}@${s.t}`).join(' > '));
        check('updater.log lists the same stages', logStages.join(',') === order.join(','), logStages.join(' > '));
        const percents = pageLog.map((s) => parseInt(s.percent, 10)).filter((n) => !Number.isNaN(n));
        check('the bar never moves back', percents.length > 2 && percents.every((p, i) => i === 0 || p >= percents[i - 1]), `${percents[0]}% .. ${percents.at(-1)}% over ${pageLog.length} renders`);
        const v = samples.find((s) => s.from);
        check(`texts from config.strings (en); versions line = "${OLD_VERSION}" + drawn chevron + "${PAYLOAD_VERSION}" (brighter), no text arrow`, pageLog.some((s) => s.title === `Updating to version ${version}`) && v?.from === OLD_VERSION && v?.to === version && v?.chevron && v?.toBrighter === true && !/→/.test(v?.versionsText ?? '→'), v ? `"${v.from}" > "${v.to}", chevron ${v.chevron}, target brighter ${v.toBrighter}` : 'no sample');
        const noted = pageLog.some((s) => s.status === 'The update continues in the background' && s.t >= (escapeAt ?? Infinity) - 50);
        const hidden = winSamples.some((s) => s.t > (escapeAt ?? Infinity) && s.target === windowPid && mainWindow(s) && !mainWindow(s).visible);
        const hiddenLog = /window hidden; the update goes on/.test(log);
        const finishedFirst = !hiddenLog && flagAt.ready !== undefined && flagAt.ready - (escapeAt ?? 0) < 3000;
        check('Escape while installing: the "continues in the background" note, then the window hides (it keeps working)', escapeAt !== undefined && noted && ((hidden && hiddenLog) || finishedFirst) && flagAt.ready !== undefined, `${escapeHow} at ${escapeAt} ms; note ${noted}; hidden ${hidden}, log ${hiddenLog}${finishedFirst ? ' (done within the note time)' : ''}`);
      } else {
        check('window: the broken configured folder is refused and a fresh %TEMP%\\unimux-updater\\webview2-<ms> used', /WebView2 data folder not usable: .*webview2-broken: not a directory/.test(log) && /WebView2 data folder: using .*[\\/]temp[\\/]unimux-updater[\\/]webview2-\d+/i.test(log) && readFileSync(brokenWebview, 'utf8') === 'not a folder', (log.match(/WebView2 data folder[^\n]*/g) ?? ['nothing logged']).join(' | '));
        check('stages reached done (updater.log), forward only', logStages.at(-1) === 'done' && logStages.every((v, i) => i === 0 || order.indexOf(v) > order.indexOf(logStages[i - 1])), logStages.join(' > '));
        const idx = pageStages.map((s) => order.indexOf(s.stage));
        check('the page (never hidden) showed installing, launching and done, forward only', idx.length > 0 && idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])) && ['installing', 'launching', 'done'].every((s) => pageStages.some((x) => x.stage === s)), pageStages.map((s) => `${s.stage}@${s.t}`).join(' > '));
      }
      check('old app exited after the hand-over (exit code 0)', oldEnd?.code === 0, `at ${oldEnd?.at} ms`);
      check('update window survived the old app exiting', winInfo && oldEnd && winInfo.last > oldEnd.at + 1000, `window seen ${winInfo?.first}..${winInfo?.last} ms, old exit ${oldEnd?.at} ms`);
      check('update window ran from the runtime copy', winInfo?.path?.toLowerCase() === runtimeExe.toLowerCase(), winInfo?.path);
      check('installer ran /S /UPDATE --updated /D=... through ShellExecuteExW, owned by the window, and exited 0', /installer exited with Some\(0\)/.test(log) && /installer \S.* \/S \/UPDATE --updated \/D=.* started \(pid \d+, as this user, owner window yes\)/.test(log), (log.match(/installer [^\n]*started[^\n]*/) ?? [''])[0]);
      check(`install dir fully replaced: unimux.exe is the ${PAYLOAD_VERSION} payload`, newHash === payloadHash && newHash !== oldHash, `${oldSize} -> ${statSync(installedExe).size} bytes`);
      // `resources` once the Windows config bundles files (P1: ConPTY's conpty.dll and OpenConsole.exe).
      const bundled = Object.keys(JSON.parse(readFileSync(join(root, 'src-tauri', 'crates', 'unimux-app', 'tauri.windows.conf.json'), 'utf8')).bundle?.resources ?? {}).length > 0;
      const expectedFiles = [...(bundled ? ['resources'] : []), 'unimux.exe', 'uninstall.exe'].join(',');
      check('install dir holds exactly the payload files', readdirSync(installDir).sort().join(',') === expectedFiles, readdirSync(installDir).join(', '));
      check('window stayed until the new app wrote update/ready', flagAt.ready !== undefined && windowExitAt !== undefined && windowExitAt >= flagAt.ready, `ready at ${flagAt.ready} ms, window exit ${windowExitAt} ms`);
      check(`ready written by the new version (${PAYLOAD_VERSION})`, existsSync(flags.ready) && readFileSync(flags.ready, 'utf8') === PAYLOAD_VERSION, existsSync(flags.ready) ? readFileSync(flags.ready, 'utf8') : 'none');
      check('window closed on ready (within 5 s)', windowExitAt !== undefined && flagAt.ready !== undefined && windowExitAt - flagAt.ready >= 0 && windowExitAt - flagAt.ready < 5000, `${windowExitAt - flagAt.ready} ms after ready`);
      check('heartbeat beat about once a second while supervising, removed at the end', heartbeats >= 3 && !existsSync(flags.heartbeat), `${heartbeats} beats`);
      check('new app started from the install dir', !!newApp && lastSnapshot.some((p) => p.ProcessId === newApp[0]), newApp ? `pid ${newApp[0]}` : 'none');
      const fallbackGone = !c.brokenWebview || (!!usedWebview && !existsSync(usedWebview));
      check(`cleanup ran from the installed exe and removed the copy and the WebView2 folder${c.brokenWebview ? ' (the %TEMP% fallback)' : ''}`, !!cleanup && !existsSync(runtimeDir) && (c.brokenWebview ? fallbackGone : !existsSync(webviewDir)), cleanup ? `${cleanup.first}..${cleanup.last} ms${c.brokenWebview ? `, fallback ${usedWebview ?? 'not seen'}` : ''}` : 'no cleanup process');
    }
    const macLog = existsSync(plan?.log ?? '') ? readFileSync(plan.log, 'utf8') : '';
    if (c.swap) console.log(`updates/mac/update.log:\n${macLog}`);
    const macLines = () => (macLog.match(/^\S+ (.*)$/gm) ?? []).map((l) => l.replace(/^\S+ /, '')).join(' | ');
    const siblings = () => (c.swap ? readdirSync(dirname(bundle)).sort().join(',') : '');
    if (name === 'swap') {
      const order = ['preparing', 'closing', 'installing', 'launching', 'done'];
      const logStages = [...log.matchAll(/stage (\w+) after (\d+) ms/g)].map((m) => m[1]);
      check('stages reached done (updater.log), forward only', logStages.at(-1) === 'done' && logStages.every((v, i) => i === 0 || order.indexOf(v) > order.indexOf(logStages[i - 1])), logStages.join(' > '));
      check('old app exited after the hand-over (exit code 0)', oldEnd?.code === 0, `at ${oldEnd?.at} ms`);
      check('update window ran from the runtime copy (outside the bundle)', winInfo?.path?.toLowerCase() === runtimeExe.toLowerCase(), winInfo?.path);
      check('no installer ran', !/installer /.test(log));
      check(`bundle swapped: the executable in unimux.app is the ${PAYLOAD_VERSION} payload`, newHash === swapPayloadHash && newHash !== oldHash, `${oldSize} -> ${statSync(installedExe).size} bytes`);
      check(`the plan's executable was started, not ${DECOY} listed before it (it stays in the bundle)`, existsSync(join(installDir, DECOY)) && !/could not be opened/.test(log) && !/did not report ready/.test(macLog), readdirSync(installDir).join(','));
      check('swap steps in updater.log and updates/mac/update.log (the 1.1.4 lines)', [/the app has exited, replacing /, /the new app is in place/, /started .*unimux\.app/, /update \S+ -> 1\.2\.0-test\.1 complete/].every((re) => re.test(log) && re.test(macLog)), macLines());
      check('the new app started from the bundle', !!newApp && lastSnapshot.some((p) => p.ProcessId === newApp[0]), newApp ? `pid ${newApp[0]}` : 'none');
      check(`ready written by the new version (${PAYLOAD_VERSION}); window closed on it (within 5 s)`, existsSync(flags.ready) && readFileSync(flags.ready, 'utf8') === PAYLOAD_VERSION && windowExitAt - flagAt.ready >= 0 && windowExitAt - flagAt.ready < 5000, `${windowExitAt - flagAt.ready} ms after ready`);
      check('backup, staged sibling and downloaded files removed: only unimux.app is left', siblings() === 'unimux.app' && !existsSync(download), siblings());
      check('no rolled-back flag', !existsSync(plan.failedFlag));
      check('cleanup removed the copy and the WebView2 folder', !!cleanup && !existsSync(runtimeDir) && !existsSync(webviewDir));
    }
    if (name === 'rollback') {
      const card = pageLog.find((s) => s.stage === 'error' && s.actions);
      check('failed card: "Could not install the update." with the hint', card?.status === 'Could not install the update.' && card?.hint === 'You can start unimux manually.' && card?.actions, card ? `"${card.status}" / "${card.hint}"` : stages.map((s) => s.stage).join(' > '));
      check('the log names the step: the new app could not be opened, the previous version restored', /the new app could not be opened, restoring the previous version/.test(log) && /the previous version was restored/.test(macLog), macLines());
      check('the old bundle is back in place, unchanged', newHash === oldHash && existsSync(installedExe));
      check(`updates/mac/rolled-back names ${PAYLOAD_VERSION} (the next start reports the failed update)`, existsSync(plan.failedFlag) && readFileSync(plan.failedFlag, 'utf8').trim() === PAYLOAD_VERSION);
      check('the old app was started again from the bundle', !!newApp && newApp[1].first > (oldEnd?.at ?? 0), newApp ? `pid ${newApp[0]} at ${newApp[1].first} ms` : 'none');
      check('no backup left (it went back into place); the downloaded files stay for the next start', !siblings().includes('.old-') && existsSync(download), siblings());
      check('no ready flag (the old version never reports one for the target)', !existsSync(flags.ready));
      check('Escape on the failed card ends the window, cleanup removed the copy', escapeAt !== undefined && windowExitAt !== undefined && windowExitAt - escapeAt < 8000 && !!cleanup && !existsSync(runtimeDir), `${escapeHow} at ${escapeAt} ms, exit at ${windowExitAt} ms`);
    }
    if (name === 'guard') {
      const card = pageLog.find((s) => s.stage === 'error' && s.actions);
      check('timeout card: "taking longer than usual" with the hint and the buttons', card?.status === 'The update is taking longer than usual' && card?.hint === 'You can start unimux manually.' && card?.actions, card ? `"${card.status}" / "${card.hint}"` : stages.map((s) => s.stage).join(' > '));
      const hiddenAfter = winSamples.some((s) => s.t > (escapeAt ?? Infinity) && s.target === windowPid && mainWindow(s) && !mainWindow(s).visible);
      check('Escape on the timeout card hides the window while the update is still supervised', escapeAt !== undefined && hiddenAfter && /error card closed: the update is still supervised/.test(log), `${escapeHow} at ${escapeAt} ms, hidden ${hiddenAfter}`);
      check('the installer still ran to the end after the timeout (exit 0)', logAt(/timed out after/) > 0 && logAt(/installer exited with Some\(0\)/) > logAt(/timed out after/), (log.match(/installer exited[^\n]*/) ?? ['no installer exit'])[0]);
      check('install dir fully replaced', newHash === payloadHash && newHash !== oldHash);
      check('the window still started the new app after the timeout (1.1.4 --force-run outcome)', !!newApp && logAt(/started .*unimux\.exe \(pid/) > logAt(/timed out after/), newApp ? `pid ${newApp[0]}` : 'none');
      await sleep(3000);
      check(`version guard: a ${PAYLOAD_VERSION} app started for a 1.2.1 update does not write update/ready`, !existsSync(flags.ready) && config.version === '1.2.1');
      check('the hidden window ended once the new app was started, and cleaned up', windowGoneAt !== undefined && !existsSync(runtimeDir) && !existsSync(webviewDir) && !!cleanup, `gone at ${windowGoneAt} ms`);
    }
    if (name === 'failed') {
      const card = pageLog.find((s) => s.stage === 'error' && s.actions);
      check('failed install card: "Could not install the update." (not the timeout text) with the hint', card?.status === 'Could not install the update.' && card?.hint === 'You can start unimux manually.' && card?.actions, card ? `"${card.status}" / "${card.hint}"` : stages.map((s) => s.stage).join(' > '));
      check('the log names the reason', /installer .*missing-setup\.exe did not start/.test(log), (log.match(/installer [^\n]*did not start[^\n]*/) ?? ['none'])[0]);
      check('Escape on the failed card ends the window', escapeAt !== undefined && windowExitAt !== undefined && windowExitAt - escapeAt < 8000, `${escapeHow} at ${escapeAt} ms, exit at ${windowExitAt} ms`);
      check('install dir untouched, no app started by the window', newHash === oldHash && !newApp && !existsSync(flags.installed));
      check('cleanup removed the copy and the WebView2 folder', !!cleanup && !existsSync(runtimeDir) && !existsSync(webviewDir));
    }
    check('no console window: no conhost.exe owned by any of our processes', conhosts.size === 0, [...conhosts].join(', '));
    check('no dialog of ours or of WebView2 appeared (Edge "cannot create data directory" box included)', ourDialogs().length === 0, ourDialogs().map((d) => `${d.name} ${d.pid} "${d.title}"`).join(', ') || `${newDialogs.size} new dialogs of other apps`);

    // ── new app quits, nothing is left ─────────────────────────────────
    if (newApp) {
      try {
        const p = await connectPage(appPort, { timeoutMs: 20000 });
        await p.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null }).catch(() => null)`).catch(() => null);
        p.close();
      } catch (e) { console.log(`new app not reachable: ${e.message}`); }
    }
    const dataDirOf = (p) => (/--user-data-dir="?([^"]+?)"?(\s--|$)/.exec(p.CommandLine ?? '') ?? [])[1] ?? '';
    const isUpdater = (p) => ofCase(p) && (/^(unimux-update|unimux-u2-setup)\.exe$/i.test(p.Name ?? '') || /--update-cleanup/.test(p.CommandLine ?? '') || /unimux-updater/i.test(dataDirOf(p)));
    let updaterLeft = lastSnapshot.filter(isUpdater);
    for (let i = 0; i < 60 && updaterLeft.length; i++) { await sleep(250); updaterLeft = lastSnapshot.filter(isUpdater); }
    check('no orphan of the update window (window, its WebView2, installer, cleanup)', updaterLeft.length === 0, updaterLeft.map((p) => `${p.Name} ${p.ProcessId} ${(p.CommandLine ?? '').replace(scratch, '<scratch>').slice(0, 160)}`).join(' | '));
    const quitAt = at();
    const caseLeft = () => lastSnapshot.filter(ofCase);
    for (let i = 0; i < 240 && caseLeft().length; i++) await sleep(250);
    await waitSnapshot();
    timings.allGoneAfterQuitMs = caseLeft().length ? null : at() - quitAt;
    check('no process left inside the case folder 60 s after the new app quit', caseLeft().length === 0, caseLeft().map((p) => `${p.Name} ${p.ProcessId} ${dataDirOf(p).replace(scratch, '<scratch>')}`).join(', ') || `all gone ${timings.allGoneAfterQuitMs} ms after quit`);
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    for (const p of lastSnapshot.filter(ofCase)) { try { execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    setPollTarget(0);
    appendFileSync(join(shots, 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), case: name, visible: !!c.visible, prestage: !!timings.prestage, spawnMs: timings.handOver?.spawnMs, shownMs: timings.handOver?.shownMs ?? null, windowCreatedMs: timings.windowCreatedMs, windowShownMs: timings.windowShownMs, installerMs: timings.installerMs, readyAfterOldExitMs: timings.flags?.ready - timings.oldExitAt, windowExitAfterReadyMs: timings.windowGoneAt - timings.flags?.ready, passed: results.filter((r) => r.ok && r.name.startsWith(`[${name}]`)).length, total: results.filter((r) => r.name.startsWith(`[${name}]`)).length })}\n`);
  }
}

try {
  await waitSnapshot();
  while (!pollerReady) await sleep(100);
  for (const name of selected) await runCase(name);
} finally {
  currentCase = 'all';
  clearInterval(regPoll);
  for (const p of lastSnapshot) { try { execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  try { watcher.kill(); } catch { /* gone */ }
  try { poller.kill(); } catch { /* gone */ }
  for (const r of registered()) registeredSeen.add(r);
  const leaked = [...registeredSeen].filter((r) => !registeredBefore.includes(r));
  check('nothing registered and no shortcut created (Apps & features, product key, Start menu, desktop)', leaked.length === 0, leaked.join(', ') || `checked ${REG_KEYS.length} keys and ${SHORTCUTS.length} shortcuts every second`);
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
