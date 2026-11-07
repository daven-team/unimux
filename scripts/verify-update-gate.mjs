// Real-app acceptance of U1 (update coordinator and startup gate, Tauri 1.2.0), Windows. Everything runs in scratch folders:
// a local feed (MC_UPDATE_FEED) signed with a scratch minisign key (MC_UPDATE_PUBKEY, check build only), the 1.2.0 check build
// copied into a scratch install dir, a payload installer 1.2.1-test.1 built from Tauri's NSIS template with its registry writes
// commented out (like U2's harness: nothing lands in Apps & features), and a scratch home (LOCALAPPDATA, so the updater root
// is scratch too). All windows off screen (MC_OFFSCREEN); no dialog is ever shown.
//
//   node scripts/verify-update-gate.mjs --build      builds the payload (target/u1) and the check build, then runs
//   node scripts/verify-update-gate.mjs [--case=gate,running,corrupt,gatefail] [--keep]
//
// Cases:
//   gate      updateMode "ask": the gate window offers 1.2.1-test.1 before the main window, "Install now" downloads, verifies
//             and hands over to the U2 update window; the old app exits without a main window, the installer replaces the
//             install dir, the new app starts and writes update/ready; update-gate.json is written before the install and
//             cleared by the new version.
//   running   updateMode "manual": the main window starts, the background check finds 1.2.1-test.1 and downloads it (status
//             ready); a state edit, then update:install: the install window hands over, the wind-down saves the edit to
//             state.json before the old app exits, the new app comes up.
//   corrupt   the feed's signature does not match: the status shows the verification error, the app keeps running, nothing
//             is handed over.
//   gatefail  "ask" with the corrupt signature: the gate shows the failure, starts the current version (main window), and
//             update-gate.json remembers the failed version.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { freePort, realProfileMarkers, sleep } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const caseArg = process.argv.find((a) => a.startsWith('--case='));
const ALL = ['gate', 'running', 'corrupt', 'gatefail'];
const selected = caseArg ? caseArg.slice('--case='.length).split(',').filter((c) => ALL.includes(c)) : ALL;
const PAYLOAD_VERSION = '1.2.1-test.1';
const OLD_VERSION = JSON.parse(readFileSync(join(root, 'src-tauri', 'crates', 'unimux-app', 'tauri.conf.json'), 'utf8')).version;
const PRODUCT = 'unimux-u1';
const PUBLISHER = JSON.parse(readFileSync(join(root, 'src-tauri', 'crates', 'unimux-app', 'tauri.conf.json'), 'utf8')).bundle.publisher;
const checkExe = join(root, 'src-tauri', 'target', 'check', 'release', 'unimux.exe');
const u1Dir = join(root, 'src-tauri', 'target', 'u1');
const payloadSetup = join(u1Dir, `${PRODUCT}_${PAYLOAD_VERSION}_x64-setup.exe`);

if (process.platform !== 'win32') { console.log('U1 harness: Windows only (the macOS engine is U5)'); process.exit(0); }

// ── build ─────────────────────────────────────────────────────────────────────
function stockTemplate() {
  const cliVersion = JSON.parse(readFileSync(join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json'), 'utf8')).version;
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
  for (const index of existsSync(registry) ? readdirSync(registry) : []) {
    const cliToml = join(registry, index, `tauri-cli-${cliVersion}`, 'Cargo.toml');
    if (!existsSync(cliToml)) continue;
    const bundler = /\[dependencies\.tauri-bundler\]\s*\nversion = "=?([^"]+)"/.exec(readFileSync(cliToml, 'utf8'))?.[1];
    const template = join(registry, index, `tauri-bundler-${bundler}`, 'src', 'bundle', 'windows', 'nsis', 'installer.nsi');
    if (bundler && existsSync(template)) return { template, bundler };
  }
  throw new Error(`the NSIS template of @tauri-apps/cli ${cliVersion} is not in the cargo registry (cargo fetch tauri-cli@${cliVersion})`);
}

/** Tauri's template with every write of the uninstall and product keys commented out (U2's patch). */
function patchedTemplate() {
  const { template, bundler } = stockTemplate();
  let count = 0;
  const text = readFileSync(template, 'utf8').split('\n').map((line) => {
    if (/^\s*WriteReg(Str|ExpandStr|DWORD)\s+SHCTX\s+"\$\{(UNINSTKEY|MANUPRODUCTKEY)\}"/.test(line)) { count++; return `  ; U1 harness, nothing registered: ${line.trim()}`; }
    return line;
  }).join('\n');
  if (count < 15) throw new Error(`template of tauri-bundler ${bundler}: only ${count} registry writes found, the harness patch needs updating`);
  const out = join(u1Dir, 'installer-no-registry.nsi');
  mkdirSync(u1Dir, { recursive: true });
  writeFileSync(out, text);
  return out;
}

if (process.argv.includes('--build')) {
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'msvc-run.mjs'), ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env, PATH: `${join(root, 'node_modules', '.bin')};${process.env.PATH}` } });
    if (r.status !== 0) { console.error(`build failed: ${args.join(' ')}`); process.exit(1); }
  };
  // The payload first, in the check target dir (only the workspace crates rebuild for another version), then the check build
  // of the current version over it.
  const conf = join(tmpdir(), `unimux-u1-tauri-${process.pid}.json`);
  writeFileSync(conf, JSON.stringify({ productName: PRODUCT, identifier: 'com.unimux.u1', mainBinaryName: 'unimux', version: PAYLOAD_VERSION, bundle: { windows: { nsis: { template: patchedTemplate() } } } }));
  try { run(['--target-dir=check', 'tauri', 'build', '--features', 'dev-overrides,test-bridge', '--bundles', 'nsis', '--config', conf], { UNIMUX_VERSION_OVERRIDE: PAYLOAD_VERSION }); } finally { rmSync(conf, { force: true }); }
  const bundleDir = join(root, 'src-tauri', 'target', 'check', 'release', 'bundle', 'nsis');
  copyFileSync(join(bundleDir, `${PRODUCT}_${PAYLOAD_VERSION}_x64-setup.exe`), payloadSetup);
  rmSync(join(root, 'src-tauri', 'target', 'check', 'release', 'bundle'), { recursive: true, force: true });
  run(['--target-dir=check', 'tauri', 'build', '--no-bundle', '--features', 'dev-overrides,test-bridge'], { UNIMUX_VERSION_OVERRIDE: '' });
}
if (!existsSync(payloadSetup) || !existsSync(checkExe)) { console.error('missing the payload installer or the check build: run with --build'); process.exit(1); }

// ── bookkeeping ───────────────────────────────────────────────────────────────
const results = [];
let currentCase = '';
const check = (name, ok, detail = '') => { results.push({ name: `[${currentCase}] ${name}`, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} [${currentCase}] ${name}${detail ? `: ${detail}` : ''}`); };
const markersBefore = realProfileMarkers();
const realUpdater = join(process.env.LOCALAPPDATA, 'unimux-updater');
const realUpdaterBefore = existsSync(realUpdater) ? readdirSync(realUpdater).sort().join(',') : '(none)';
const REG_KEYS = [`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT}`, `HKCU\\Software\\${PUBLISHER}\\${PRODUCT}`];
const regExists = (key) => spawnSync('reg', ['query', key], { stdio: 'ignore' }).status === 0;

const scratch = mkdtempSync(join(tmpdir(), 'unimux-u1-'));
console.log(`scratch: ${scratch}`);

/** Every process whose exe or command line is inside `dir` (the apps, the update window, the installer, WebView2 children). */
function processesInside(dir) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const needle = dir.toLowerCase();
  return JSON.parse(out).filter((p) => `${p.ExecutablePath ?? ''} ${p.CommandLine ?? ''}`.toLowerCase().includes(needle));
}
function killInside(dir) {
  for (const p of processesInside(dir)) { try { execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
}

// ── the feed ──────────────────────────────────────────────────────────────────
const keyDir = join(scratch, 'key');
mkdirSync(keyDir);
function tauriCli(args) {
  const env = { ...process.env };
  delete env.TAURI_SIGNING_PRIVATE_KEY; delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD; delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  const r = spawnSync(process.execPath, [join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), ...args], { cwd: scratch, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tauri ${args[0]} ${args[1]}: ${r.stderr}`);
}
tauriCli(['signer', 'generate', '--ci', '-p', '', '-w', join(keyDir, 'scratch.key')]);
const pubkey = readFileSync(join(keyDir, 'scratch.key.pub'), 'utf8').trim();
const served = join(scratch, 'feed');
mkdirSync(served);
const setupName = `unimux-Setup-${PAYLOAD_VERSION}.exe`;
copyFileSync(payloadSetup, join(served, setupName));
tauriCli(['signer', 'sign', '-f', join(keyDir, 'scratch.key'), '-p', '', join(served, setupName)]);
const goodSig = readFileSync(join(served, `${setupName}.sig`), 'utf8').trim();
// A well-formed signature of another file: refused by the check.
writeFileSync(join(keyDir, 'other.bin'), 'not the installer');
tauriCli(['signer', 'sign', '-f', join(keyDir, 'scratch.key'), '-p', '', join(keyDir, 'other.bin')]);
const badSig = readFileSync(join(keyDir, 'other.bin.sig'), 'utf8').trim();

let feedSig = goodSig;
const feedPort = await freePort();
const base = `http://127.0.0.1:${feedPort}`;
const feedRequests = [];
const server = createServer((req, res) => {
  feedRequests.push(req.url);
  if (req.url === '/latest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: PAYLOAD_VERSION, notes: 'U1 harness', pub_date: new Date().toISOString(), platforms: { 'windows-x86_64': { url: `${base}/${setupName}`, signature: feedSig } } }));
    return;
  }
  if (req.url === `/${setupName}`) {
    const body = readFileSync(join(served, setupName));
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
    res.end(body);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(feedPort, '127.0.0.1', r));

// ── one app run ───────────────────────────────────────────────────────────────
const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };

async function devtoolsTargets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return []; }
}

/** A DevTools client for the page whose URL matches. */
async function attach(port, match, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const target = (await devtoolsTargets(port)).find((t) => t.type === 'page' && match.test(t.url));
    if (target) {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let id = 0; const pending = new Map();
      ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) rej(new Error(msg.error.message)); else res(msg.result); } };
      ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('closed')); pending.clear(); };
      const evaluate = (expression) => new Promise((res, rej) => {
        if (ws.readyState !== WebSocket.OPEN) { rej(new Error('closed')); return; }
        const n = ++id; pending.set(n, { res: (r) => (r.exceptionDetails ? rej(new Error(r.exceptionDetails.text)) : res(r.result.value)), rej });
        ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      return { evaluate, close: () => ws.close() };
    }
    if (Date.now() > deadline) throw new Error(`no page matching ${match} on port ${port}`);
    await sleep(200);
  }
}

async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(200);
  }
}

const GATE_PAGE = /update-splash\/index\.html/;
const MAIN_PAGE = /^https?:\/\/tauri\.localhost\/(index\.html)?(\?|#|$)/;
const stageOf = (page) => page.evaluate(`(() => { const c = document.querySelector('.card'); return c ? { stage: c.dataset.stage, title: document.getElementById('title').textContent, versions: document.getElementById('versions').textContent, status: document.getElementById('status').textContent, percent: document.getElementById('percent').textContent } : null; })()`);

function prepare(name, updateMode) {
  const dir = join(scratch, name);
  const installDir = join(dir, 'install');
  const dataDir = join(dir, 'data');
  for (const d of [installDir, dataDir]) mkdirSync(d, { recursive: true });
  copyFileSync(checkExe, join(installDir, 'unimux.exe'));
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, settings: { language: 'en', updateMode }, projects: [] }));
  return { dir, installDir, dataDir };
}

async function launch({ dir, installDir, dataDir }) {
  const port = await freePort();
  const { env: homeEnv } = scratchHome(dir);
  const env = scrubAppEnv({ ...process.env, ...homeEnv, MC_TEST_TOASTS: '1', MC_DATA_DIR: dataDir, MC_DEBUG_PORT: String(port), MC_OFFSCREEN: '1', MC_UPDATE_FEED: base, MC_UPDATE_PUBKEY: pubkey });
  const child = spawn(join(installDir, 'unimux.exe'), [], { env, stdio: 'ignore', windowsHide: true, cwd: dir });
  return { child, port, updaterRoot: join(homeEnv.LOCALAPPDATA, 'unimux-updater') };
}

const exited = (child) => child.exitCode !== null;

async function runGate() {
  currentCase = 'gate';
  const p = prepare('gate', 'ask');
  const { child, port, updaterRoot } = await launch(p);
  try {
    const gate = await attach(port, GATE_PAGE, 30000);
    const ask = await until(async () => { const s = await stageOf(gate); return s?.stage === 'ask' ? s : null; }, 30000, 'the ask prompt');
    check('the gate offers the update before the main window', ask.versions.includes(PAYLOAD_VERSION) && ask.title.includes(PAYLOAD_VERSION), `${ask.title} / ${ask.versions}`);
    check('no main window while the gate asks', !(await devtoolsTargets(port)).some((t) => MAIN_PAGE.test(t.url)));
    check('the feed was read', feedRequests.includes('/latest.json'));
    await gate.evaluate(`document.getElementById('open').click()`);
    const pidFile = () => json(join(p.dataDir, 'update', 'work', 'config.json'));
    const config = await until(() => pidFile(), 60000, 'the hand-over (work/config.json)');
    check('hand-over config names the target and the downloaded installer', config.version === PAYLOAD_VERSION && config.fromVersion === OLD_VERSION && /unimux-Setup-1\.2\.1-test\.1\.exe$/i.test(config.installer ?? ''), `${config.version} ${config.installer}`);
    check('the installer is the verified download in the updater root', (config.installer ?? '').toLowerCase().startsWith(join(updaterRoot, 'pending').toLowerCase()));
    const record = json(join(p.dataDir, 'update-gate.json'));
    check('update-gate.json marks the attempt before the install', record?.version === PAYLOAD_VERSION, JSON.stringify(record));
    const code = await until(() => (exited(child) ? { code: child.exitCode } : null), 30000, 'the old app to exit');
    check('the old app exits for the installer', code.code === 0, `exit ${code.code}`);
    const ready = await until(() => existsSync(join(p.dataDir, 'update', 'ready')) && readFileSync(join(p.dataDir, 'update', 'ready'), 'utf8'), 180000, 'update/ready from the new app');
    check('the new version starts and writes update/ready', ready.trim() === PAYLOAD_VERSION, ready);
    const main = await attach(port, MAIN_PAGE, 60000);
    const running = await until(() => main.evaluate('window.mc.getUpdate()'), 30000, 'update:get of the new app');
    check('the running app is the new version', running.currentVersion === PAYLOAD_VERSION, running.currentVersion);
    await until(() => !existsSync(join(p.dataDir, 'update-gate.json')), 15000, 'update-gate.json cleared').catch(() => {});
    check('update-gate.json is cleared by the new version', !existsSync(join(p.dataDir, 'update-gate.json')));
    check('nothing registered in Apps & features', !REG_KEYS.some(regExists));
    main.close();
  } catch (error) {
    check('gate flow', false, error.message);
  } finally {
    killInside(p.dir);
  }
}

async function runRunning() {
  currentCase = 'running';
  const p = prepare('running', 'manual');
  const { child, port } = await launch(p);
  try {
    const main = await attach(port, MAIN_PAGE, 60000);
    check('manual mode: the main window starts without a gate', !(await devtoolsTargets(port)).some((t) => GATE_PAGE.test(t.url)));
    await main.evaluate('window.mc.checkUpdates()');
    const ready = await until(async () => { const s = await main.evaluate('window.mc.getUpdate()'); return s.status === 'ready' ? s : (s.status === 'error' ? Promise.reject(new Error(s.message)) : null); }, 90000, 'status ready');
    check('the running app finds and downloads the update', ready.version === PAYLOAD_VERSION && ready.currentVersion === OLD_VERSION, JSON.stringify(ready));
    // A state change right before the install: the wind-down must save it.
    const snap = await main.evaluate('window.mc.loadSnapshot()');
    const next = JSON.parse(JSON.stringify(snap.state));
    next.settings.scrollbackLines = 4321;
    await main.evaluate(`window.mc.applyStateEdit(${JSON.stringify({ id: 'u1-edit', base: snap.state, next })})`);
    await main.evaluate('window.mc.installUpdate()');
    const gate = await attach(port, GATE_PAGE, 30000);
    const shown = await until(() => stageOf(gate), 15000, 'the install window');
    check('the status bar install opens the update window', !!shown.stage, JSON.stringify(shown));
    await until(() => exited(child), 60000, 'the old app to exit');
    const saved = json(join(p.dataDir, 'state.json'));
    check('state saved before install', saved?.settings?.scrollbackLines === 4321, String(saved?.settings?.scrollbackLines));
    const ready2 = await until(() => existsSync(join(p.dataDir, 'update', 'ready')) && readFileSync(join(p.dataDir, 'update', 'ready'), 'utf8'), 180000, 'update/ready');
    check('the new version starts after the install', ready2.trim() === PAYLOAD_VERSION, ready2);
    const after = json(join(p.dataDir, 'state.json'));
    check('the new version keeps the saved state', after?.settings?.scrollbackLines === 4321);
    main.close();
  } catch (error) {
    check('running flow', false, error.message);
  } finally {
    killInside(p.dir);
  }
}

async function runCorrupt() {
  currentCase = 'corrupt';
  feedSig = badSig;
  const p = prepare('corrupt', 'manual');
  const { child, port, updaterRoot } = await launch(p);
  try {
    const main = await attach(port, MAIN_PAGE, 60000);
    await main.evaluate('window.mc.checkUpdates()');
    const state = await until(async () => { const s = await main.evaluate('window.mc.getUpdate()'); return s.status === 'error' || s.status === 'ready' ? s : null; }, 90000, 'the download to end');
    check('a corrupt .sig shows the error state', state.status === 'error' && /weryfikacji/.test(state.message ?? '') && state.version === PAYLOAD_VERSION, JSON.stringify(state));
    await main.evaluate('window.mc.installUpdate()');
    await sleep(2000);
    check('the app keeps running', !exited(child) && (await main.evaluate('1 + 1')) === 2);
    check('nothing handed over', !existsSync(join(p.dataDir, 'update', 'work', 'config.json')));
    const pending = join(updaterRoot, 'pending');
    check('the refused download is removed', !existsSync(pending) || readdirSync(pending).length === 0, existsSync(pending) ? readdirSync(pending).join(',') : '');
    main.close();
  } catch (error) {
    check('corrupt flow', false, error.message);
  } finally {
    killInside(p.dir);
    feedSig = goodSig;
  }
}

async function runGateFail() {
  currentCase = 'gatefail';
  feedSig = badSig;
  const p = prepare('gatefail', 'ask');
  const { child, port } = await launch(p);
  try {
    const gate = await attach(port, GATE_PAGE, 30000);
    await until(async () => (await stageOf(gate))?.stage === 'ask', 30000, 'the ask prompt');
    await gate.evaluate(`document.getElementById('open').click()`);
    const failed = await until(async () => { const s = await stageOf(gate); return s?.stage === 'failed' ? s : null; }, 60000, 'the failure notice').catch(() => null);
    check('the gate shows the failure', !!failed, JSON.stringify(failed));
    const main = await attach(port, MAIN_PAGE, 30000);
    check('the current version starts after the failure', (await main.evaluate('window.mc.getUpdate()')).currentVersion === OLD_VERSION && !exited(child));
    const record = json(join(p.dataDir, 'update-gate.json'));
    check('update-gate.json remembers the failed version', record?.version === PAYLOAD_VERSION, JSON.stringify(record));
    main.close();
  } catch (error) {
    check('gate failure flow', false, error.message);
  } finally {
    killInside(p.dir);
    feedSig = goodSig;
  }
}

const runners = { gate: runGate, running: runRunning, corrupt: runCorrupt, gatefail: runGateFail };
for (const name of selected) await runners[name]();

server.close();
currentCase = 'all';
check('the real profile is untouched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
const realUpdaterAfter = existsSync(realUpdater) ? readdirSync(realUpdater).sort().join(',') : '(none)';
check('the real %LOCALAPPDATA%\\unimux-updater is untouched', realUpdaterAfter === realUpdaterBefore, `${realUpdaterBefore} -> ${realUpdaterAfter}`);
check('no process left in the scratch folder', processesInside(scratch).length === 0);
if (!keep) removeScratch(scratch);
const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} passed${keep ? `; scratch kept: ${scratch}` : ''}`);
process.exit(failedCount ? 1 : 0);
