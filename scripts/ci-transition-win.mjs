// CI only (Tauri workflow, job "Update 1.1.4 -> 1.2.0"): installs the published Electron 1.1.4 on a throwaway Windows runner
// and runs the CI-built 1.2.0 installer over it exactly as 1.1.4's updater does (`--updated /S --force-run`), in the default
// folder and in a folder of the user's own. Checks: same folder, the Tauri exe in place, the Electron runtime gone, one entry
// in Apps & features, user data kept, the update window's marker written, and the app really starts.
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
  const text = ps(`@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'unimux*' } | ForEach-Object { $_.DisplayName + ' | ' + $_.DisplayVersion }) -join [char]10`);
  return text ? text.split('\n') : [];
};
const running = (exe) => ps(`@(Get-CimInstance Win32_Process -Filter "Name='unimux.exe'" | Where-Object { $_.ExecutablePath -eq '${exe}' }).Count`);

async function waitFor(what, test, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await sleep(500);
  }
  throw new Error(`timeout: ${what}`);
}

async function round(name, dir, oldArgs) {
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

  assert.ok(existsSync(exe), 'unimux.exe is in the same folder');
  const version = ps(`(Get-Item '${exe}').VersionInfo.ProductVersion`);
  assert.ok(version.startsWith('1.2.0'), `installed version: ${version}`);
  for (const gone of [join('resources', 'app.asar'), 'ffmpeg.dll', 'chrome_100_percent.pak', 'icudtl.dat']) {
    assert.ok(!existsSync(join(dir, gone)), `the Electron runtime is gone: ${gone}`);
  }
  const entries = uninstallEntries();
  console.log('apps & features after:', entries);
  assert.equal(entries.length, 1, `one entry in Apps & features: ${entries.join('; ')}`);
  assert.match(entries[0], /1\.2\.0/);
  assert.equal(readFileSync(marker, 'utf8'), content, 'user data kept');
  await waitFor('the marker for the update window', () => existsSync(join(dataDir, 'update', 'installer-done')));

  // --force-run starts the new app: it has to be there, and stay there.
  await waitFor('the app started by --force-run', () => Number(running(exe)) > 0);
  await sleep(15000);
  assert.ok(Number(running(exe)) > 0, 'the app still runs 15 s after the start');
  assert.ok(!existsSync(join(dataDir, 'crash.log')), `crash.log: ${existsSync(join(dataDir, 'crash.log')) ? readFileSync(join(dataDir, 'crash.log'), 'utf8').slice(-2000) : ''}`);
  console.log('started and still running');

  ps(`Get-CimInstance Win32_Process -Filter "Name='unimux.exe'" | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  await waitFor('the app stopped', () => Number(running(exe)) === 0);
  await sleep(2000);
  install(join(dir, 'uninstall.exe'), ['/S']);
  await waitFor('uninstalled', () => uninstallEntries().length === 0, 120000);
}

await round('default folder', join(local, 'Programs', 'unimux'), []);
await round('own folder', 'C:\\Custom Apps\\unimux', ['/D=C:\\Custom Apps\\unimux']);
console.log('\nUpdate 1.1.4 -> 1.2.0: both rounds passed');
