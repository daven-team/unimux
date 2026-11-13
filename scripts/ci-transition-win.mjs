// CI only (Tauri workflow, job "Update 1.1.4 -> 1.2.0"): installs the published Electron 1.1.4 on a throwaway Windows runner
// and runs the CI-built 1.2.0 installer over it exactly as 1.1.4's updater does (`--updated /S --force-run`), in the default
// folder and in a folder of the user's own. Checks: same folder, the Tauri exe in place, the Electron runtime gone, one entry
// in Apps & features, user data kept, the update window's marker written, the app really starts, and the "Open with" /
// Default apps / context menu registration exists for the new exe (per user, never HKLM) and is gone after the uninstall.
//
//   node scripts/ci-transition-win.mjs <unimux-Setup-1.1.4.exe> <1.2.0 setup.exe>
//
// It installs and uninstalls for real, so it refuses to run anywhere but on a GitHub Actions runner.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'win32') {
  console.error('ci-transition-win: only on a GitHub-hosted Windows runner (it runs real installers)');
  process.exit(2);
}

const [oldSetup, newSetup] = process.argv.slice(2).map((p) => resolve(p));
assert.ok(existsSync(oldSetup), 'the 1.1.4 installer');
assert.ok(existsSync(newSetup), 'the 1.2.0 installer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = process.env.LOCALAPPDATA;
const dataDir = join(process.env.APPDATA, 'unimux');
const ps = (command) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();

function install(exe, args) {
  // /D= has to be the last argument and is not quoted (NSIS): no quoting by Node either.
  const r = spawnSync(exe, args, { windowsVerbatimArguments: true, stdio: 'inherit', timeout: 300000 });
  assert.equal(r.status, 0, `${exe} ${args.join(' ')}: exit ${r.status} ${r.error ?? ''}`);
}

const uninstallEntries = () => {
  const text = ps(`@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'unimux*' } | ForEach-Object { $_.DisplayName + ' | ' + $_.DisplayVersion }) -join [char]10`);
  return text ? text.split('\n') : [];
};
// A registry value ('' for the default value); '' when the key or the value is missing. -LiteralPath: `*\shell` is a real key.
const regValue = (hive, key, name = '') =>
  ps(`$k = Get-Item -LiteralPath '${hive}:\\${key}' -ErrorAction SilentlyContinue; if ($k) { [string]$k.GetValue('${name}') } else { '' }`);
const regHasValue = (hive, key, name) =>
  ps(`$k = Get-Item -LiteralPath '${hive}:\\${key}' -ErrorAction SilentlyContinue; if ($k -and ($k.GetValueNames() -contains '${name}')) { '1' } else { '0' }`) === '1';
const regKeyExists = (hive, key) => ps(`if (Test-Path -LiteralPath '${hive}:\\${key}') { '1' } else { '0' }`) === '1';

// What installer-hooks.nsh registers for opening files from Explorer (UNIMUX_REGISTER_OPEN_WITH).
const APP_KEY = 'Software\\Classes\\Applications\\unimux.exe';
const PROGID_KEY = 'Software\\Classes\\unimux.file';
const VERB_KEY = 'Software\\Classes\\*\\shell\\unimux';
const CAP_KEY = 'Software\\ajzak, azozowsky\\unimux\\Capabilities';

function assertOpenWithRegistered(exe) {
  const command = `"${exe}" "%1"`;
  assert.equal(regValue('HKCU', `${APP_KEY}\\shell\\open\\command`).toLowerCase(), command.toLowerCase(), 'Applications\\unimux.exe opens the file');
  assert.equal(regValue('HKCU', APP_KEY, 'FriendlyAppName'), 'unimux', 'the name in "Open with"');
  for (const ext of ['.txt', '.md', '.json', '.ts', '.py']) {
    assert.ok(regHasValue('HKCU', `${APP_KEY}\\SupportedTypes`, ext), `SupportedTypes lists ${ext}`);
    assert.ok(regHasValue('HKCU', `Software\\Classes\\${ext}\\OpenWithProgids`, 'unimux.file'), `${ext} offers unimux in "Open with"`);
    assert.equal(regValue('HKCU', `${CAP_KEY}\\FileAssociations`, ext), 'unimux.file', `Default apps knows ${ext}`);
    assert.notEqual(regValue('HKCU', `Software\\Classes\\${ext}`), 'unimux.file', `${ext} keeps its own default handler`);
  }
  assert.equal(regValue('HKCU', `${PROGID_KEY}\\shell\\open\\command`).toLowerCase(), command.toLowerCase(), 'the ProgID opens the file');
  assert.equal(regValue('HKCU', 'Software\\RegisteredApplications', 'unimux'), CAP_KEY, 'unimux is a registered application');
  assert.equal(regValue('HKCU', `${VERB_KEY}\\command`).toLowerCase(), command.toLowerCase(), 'the context menu entry opens the file');
  assert.ok(regValue('HKCU', VERB_KEY, 'MUIVerb').includes('unimux'), 'the context menu entry has its text');
  // A per-user install never writes the machine's classes.
  for (const key of [APP_KEY, PROGID_KEY, VERB_KEY]) assert.ok(!regKeyExists('HKLM', key), `nothing in HKLM\\${key}`);
}

const openWithGone = () =>
  [APP_KEY, PROGID_KEY, VERB_KEY, CAP_KEY].every((key) => !regKeyExists('HKCU', key))
  && !regHasValue('HKCU', 'Software\\Classes\\.md\\OpenWithProgids', 'unimux.file')
  && !regHasValue('HKCU', 'Software\\RegisteredApplications', 'unimux');

const running = (exe) => ps(`@(Get-CimInstance Win32_Process -Filter "Name='unimux.exe'" | Where-Object { $_.ExecutablePath -eq '${exe}' }).Count`);

async function waitFor(what, test, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await sleep(500);
  }
  throw new Error(`timeout: ${what}`);
}

// `dir` is where 1.1.4 is installed, `newDir` where 1.2.x has to end up: the same folder for a per-user 1.1.4, the per-user
// default for one installed for all users (this per-user installer removes that one with its own uninstaller).
async function round(name, dir, oldArgs, newDir = dir) {
  console.log(`\n=== ${name}: ${dir}`);
  rmSync(dataDir, { recursive: true, force: true });
  install(oldSetup, ['/S', ...oldArgs]);
  const exe = join(dir, 'unimux.exe');
  await waitFor('1.1.4 installed', () => existsSync(exe));
  assert.ok(existsSync(join(dir, 'resources', 'app.asar')), 'this is the Electron 1.1.4 layout');
  assert.ok(ps(`(Get-Item '${exe}').VersionInfo.ProductVersion`).startsWith('1.1.4'), '1.1.4 is installed');
  console.log('apps & features before:', uninstallEntries());

  mkdirSync(dataDir, { recursive: true });
  const marker = join(dataDir, 'transition-marker.txt');
  const content = `kept across the update (${name})`;
  writeFileSync(marker, content);

  install(newSetup, ['--updated', '/S', '--force-run']);

  if (newDir !== dir) {
    assert.ok(!existsSync(exe), 'the all-users 1.1.4 is uninstalled');
    assert.ok(!existsSync(join(dir, 'Uninstall unimux.exe')), 'its uninstaller is gone too');
    const startMenu = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'unimux.lnk');
    const target = ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${startMenu}').TargetPath`);
    assert.equal(target.toLowerCase(), join(newDir, 'unimux.exe').toLowerCase(), 'the Start menu entry starts the new exe');
  }
  const newExe = join(newDir, 'unimux.exe');
  assert.ok(existsSync(newExe), `unimux.exe is in ${newDir}`);
  const version = ps(`(Get-Item '${newExe}').VersionInfo.ProductVersion`);
  assert.ok(version.startsWith('1.2.0'), `installed version: ${version}`);
  for (const gone of [join('resources', 'app.asar'), 'ffmpeg.dll', 'chrome_100_percent.pak', 'icudtl.dat']) {
    assert.ok(!existsSync(join(dir, gone)) && !existsSync(join(newDir, gone)), `the Electron runtime is gone: ${gone}`);
  }
  const entries = uninstallEntries();
  console.log('apps & features after:', entries);
  assert.equal(entries.length, 1, `one entry in Apps & features: ${entries.join('; ')}`);
  assert.match(entries[0], /1\.2\.0/);
  assert.equal(readFileSync(marker, 'utf8'), content, 'user data kept');
  await waitFor('the marker for the update window', () => existsSync(join(dataDir, 'update', 'installer-done')));
  assertOpenWithRegistered(newExe);
  console.log('"Open with", Default apps and the context menu are registered');

  // --force-run starts the new app: it has to be there, and stay there.
  await waitFor('the app started by --force-run', () => Number(running(newExe)) > 0);
  await sleep(15000);
  assert.ok(Number(running(newExe)) > 0, 'the app still runs 15 s after the start');
  // crash.log is the app's rolling log: info and warn lines are normal on a first start (`<ISO> <level> <text>`).
  const crashLog = join(dataDir, 'crash.log');
  const errors = existsSync(crashLog) ? readFileSync(crashLog, 'utf8').split('\n').filter((l) => /^\S+ (error|fatal) /.test(l)) : [];
  assert.deepEqual(errors, [], 'no error in crash.log');
  console.log('started and still running');

  ps(`Get-CimInstance Win32_Process -Filter "Name='unimux.exe'" | Where-Object { $_.ExecutablePath -eq '${newExe}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  await waitFor('the app stopped', () => Number(running(newExe)) === 0);
  await sleep(2000);
  install(join(newDir, 'uninstall.exe'), ['/S']);
  await waitFor('uninstalled', () => uninstallEntries().length === 0, 120000);
  await waitFor('the "Open with" registration removed', openWithGone, 60000);
  // Tauri's silent uninstaller keeps its install-location key. The next round is a machine that never had 1.2.0.
  ps(`Remove-Item -LiteralPath 'HKCU:\\Software\\ajzak, azozowsky' -Recurse -Force -ErrorAction SilentlyContinue`);
}

await round('default folder', join(local, 'Programs', 'unimux'), []);
await round('own folder', 'C:\\Custom Apps\\unimux', ['/D=C:\\Custom Apps\\unimux']);
// "Anyone who uses this computer" in the 1.1.x installer: HKLM, Program Files or a folder of the user's own.
await round('all users, default folder', join(process.env.ProgramFiles, 'unimux'), ['/allusers'], join(local, 'unimux'));
await round('all users, own folder', 'C:\\Machine Apps\\unimux', ['/allusers', '/D=C:\\Machine Apps\\unimux'], join(local, 'unimux'));
console.log('\nUpdate 1.1.4 -> 1.2.x: all four rounds passed');
