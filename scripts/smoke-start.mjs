// Starts the packaged Windows app the way the Start menu, a shortcut or the installer does: no console to attach to and no
// standard handles. 0.9.3 and 0.9.4 crashed in exactly this case (the Pty Host launch got a null stdout handle, exit code
// 0x80000003), while every check started from a terminal passed. The app runs in a scratch profile and is stopped afterwards.
// Tauri (default): the check build (npm run build:check) with MC_DATA_DIR and MC_OFFSCREEN, so nothing reaches the real profile
// and no window shows; a release unimux.exe ignores both, so it is only run with --ci (the CI machine of U4). Electron
// (MC_APP_TARGET=electron): release/win-unpacked/unimux.exe as before.
//
// --install [setup.exe] (Tauri, CI only, PLAN U4): installs the release installer silently into a scratch folder
// (`/S /D=<dir>`; default release/unimux-Setup-*.exe), checks the installed files and starts the INSTALLED unimux.exe. A release
// exe uses the machine's real roaming profile, so this mode refuses to run outside GitHub Actions.
// Tauri also checks the call the 1.1.x update window ends with (`ELECTRON_RUN_AS_NODE=1 unimux.exe -e <script>`, PLAN U3): it
// exits 0 without a window and removes `<data>/update/runtime` only, never a folder a crafted script names.
// Usage: node scripts/smoke-start.mjs [exe] [--ci] | node scripts/smoke-start.mjs --install [setup.exe] --ci
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appBinary, isTauri } from './real-app.mjs';

if (process.platform !== 'win32') {
  console.log('Start without a console: Windows only, skipped');
  process.exit(0);
}

const args = process.argv.slice(2);
const ci = args.includes('--ci');
const installAt = args.indexOf('--install');
const install = installAt >= 0;
const onCiMachine = process.env.GITHUB_ACTIONS === 'true';
if (install && !(isTauri && ci && onCiMachine)) throw new Error('--install runs a real installer and starts a release build on the real profile: Tauri target, --ci and GitHub Actions only');
const scratch = mkdtempSync(join(tmpdir(), 'unimux-start-'));

/** Installs the release setup silently into the scratch folder and returns the installed exe. */
function installRelease() {
  const given = args[installAt + 1] && !args[installAt + 1].startsWith('--') ? resolve(args[installAt + 1]) : undefined;
  const found = given ? [given] : readdirSync('release').filter((n) => /^unimux-Setup-\d+\.\d+\.\d+\.exe$/.test(n)).map((n) => resolve('release', n));
  if (found.length !== 1 || !existsSync(found[0])) throw new Error(`Expected one release installer, found: ${found.join(', ') || 'none'}`);
  const dir = join(scratch, 'installed');
  // NSIS takes /D= last and unquoted, so the folder must not contain spaces.
  if (/\s/.test(dir)) throw new Error(`The install folder must not contain spaces: ${dir}`);
  const result = spawnSync(found[0], ['/S', `/D=${dir}`], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true, timeout: 300_000 });
  if (result.status !== 0) throw new Error(`The installer failed: exit ${result.status ?? result.error?.message}`);
  // The pty runtime travels as bundle resources (tauri.windows.conf.json): without them no terminal starts.
  for (const file of ['unimux.exe', 'resources/conpty/x64/conpty.dll', 'resources/conpty/x64/OpenConsole.exe']) {
    if (!existsSync(join(dir, file))) throw new Error(`The installer did not write ${file}`);
  }
  console.log(`Installed ${found[0]} into ${dir}`);
  return join(dir, 'unimux.exe');
}

const executable = install ? installRelease() : resolve(args.find((a, i) => !a.startsWith('--') && i !== installAt + 1) ?? (isTauri ? appBinary() : 'release/win-unpacked/unimux.exe'));
if (!existsSync(executable)) throw new Error(`Packaged app not found: ${executable}`);
const checkBuild = isTauri && /[\\/]target[\\/]check[\\/]/i.test(executable);
if (isTauri && !checkBuild && !(ci && onCiMachine)) throw new Error(`${executable} is not the check build: a release build ignores MC_DATA_DIR and would start on the real profile (use --ci on a CI machine)`);
const home = join(scratch, 'home');
for (const dir of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(home, dir), { recursive: true });
// A release Tauri exe takes the roaming folder from the OS (FOLDERID_RoamingAppData), not from APPDATA: on the CI machine
// its profile is the runner's real one. Earlier startup marks there are moved aside so only this start counts.
const releaseProfile = isTauri && !checkBuild;
const profile = releaseProfile ? join(process.env.APPDATA ?? '', 'unimux') : join(home, 'AppData', 'Roaming', 'unimux');
if (releaseProfile && !process.env.APPDATA) throw new Error('APPDATA is not set');
mkdirSync(profile, { recursive: true });
if (releaseProfile && existsSync(join(profile, 'startup.log'))) renameSync(join(profile, 'startup.log'), join(profile, `startup.log.before-smoke-${Date.now()}`));

/**
 * The 1.1.x update window's last call: `<appExe> -e <script>` with ELECTRON_RUN_AS_NODE=1. The app must exit 0 within the
 * one-liner's 3 s delay plus its retries, without a window (no startup.log) and must remove nothing but the runtime folder.
 */
function checkLegacyEvalCall() {
  const updateDir = join(profile, 'update');
  const runtime = join(updateDir, 'runtime');
  const decoy = join(updateDir, 'keep-me');
  for (const dir of [runtime, decoy]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'x');
  }
  const script = (dir) => `setTimeout(()=>{try{require('fs').rmSync(${JSON.stringify(dir)},{recursive:true,force:true,maxRetries:10,retryDelay:500})}catch{}},3000)`;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), USERPROFILE: home };
  if (checkBuild) env.MC_DATA_DIR = profile;
  const call = (dir) => {
    const started = Date.now();
    const result = spawnSync(executable, ['-e', script(dir)], { env, cwd: tmpdir(), stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`-e call: exit ${result.status ?? result.error?.message}`);
    return Date.now() - started;
  };
  const crafted = call(decoy);
  if (!existsSync(join(decoy, 'file.txt'))) throw new Error('-e call removed a folder that is not <data>/update/runtime');
  const real = call(runtime);
  if (existsSync(runtime)) throw new Error('-e call did not remove <data>/update/runtime');
  if (!existsSync(join(decoy, 'file.txt'))) throw new Error('-e call removed more than <data>/update/runtime');
  if (existsSync(join(profile, 'startup.log'))) throw new Error('-e call started the app (startup.log written)');
  rmSync(updateDir, { recursive: true, force: true });
  console.log(`-e call OK: exit 0 after ${real} ms (crafted script ${crafted} ms), only update/runtime removed, no app start`);
}
// Startup marks that say the start is done: Electron's Pty Host and page load; Tauri's page load (P3 adds its pty mark).
const readyMarks = isTauri ? ['app-ready', 'page-loaded'] : ['pty-host-started', 'did-finish-load'];
const startupLog = join(profile, 'startup.log');
const pidFile = join(scratch, 'app.pid');

// CreateProcess with STARTF_USESTDHANDLES and null handles; ELECTRON_NO_ATTACH_CONSOLE keeps Electron from borrowing the console
// of this script, which would hand the app valid handles again. The app's profile follows APPDATA, its home USERPROFILE.
const launcher = join(scratch, 'launch.ps1');
writeFileSync(launcher, `
param([string]$Exe, [string]$HomeDir, [string]$StartupLog, [string]$PidFile, [string]$Ready1, [string]$Ready2, [string]$DataDir = '', [int]$TimeoutSeconds = 90, [int]$AliveSeconds = 8)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NoConsoleLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
}
"@
$env:APPDATA = Join-Path $HomeDir 'AppData\\Roaming'
$env:LOCALAPPDATA = Join-Path $HomeDir 'AppData\\Local'
$env:USERPROFILE = $HomeDir
$env:ELECTRON_NO_ATTACH_CONSOLE = '1'
# The Tauri check build: the scratch data dir and an off-screen window (a release build ignores both, see --ci).
if ($DataDir) { $env:MC_DATA_DIR = $DataDir; $env:MC_OFFSCREEN = '1' }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$si = New-Object NoConsoleLaunch+STARTUPINFO
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si); $si.dwFlags = 0x100
$pi = New-Object NoConsoleLaunch+PROCESS_INFORMATION
# DETACHED_PROCESS: no console for the app either.
if (-not [NoConsoleLaunch]::CreateProcess($Exe, '"' + $Exe + '"', [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x00000008, [IntPtr]::Zero, (Split-Path $Exe), [ref]$si, [ref]$pi)) {
  Write-Output ('CreateProcess failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 2
}
$appPid = $pi.dwProcessId
# For the Node side: it stops the app if this script itself is cut off by its timeout.
Set-Content -Path $PidFile -Value $appPid
$exited = { [NoConsoleLaunch]::WaitForSingleObject($pi.hProcess, 0) -eq 0 }
$exitText = { $c = [uint32]0; [NoConsoleLaunch]::GetExitCodeProcess($pi.hProcess, [ref]$c) | Out-Null; '0x{0:X}' -f $c }
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if (& $exited) { Write-Output ('The app exited during start, exit code ' + (& $exitText)); exit 1 }
  if ((Test-Path $StartupLog) -and ((Get-Content $StartupLog -Raw) -match $Ready1 -and (Get-Content $StartupLog -Raw) -match $Ready2)) { $ready = $true; break }
  Start-Sleep -Milliseconds 250
}
if (-not $ready) { Write-Output 'The app did not finish its start in time'; taskkill /PID $appPid /T /F | Out-Null; exit 1 }
# 0.9.4 died about two seconds after the window: the app has to stay up a while after the terminal process started.
Start-Sleep -Seconds $AliveSeconds
if (& $exited) { Write-Output ('The app exited after its start, exit code ' + (& $exitText)); exit 1 }
Write-Output ('Started without a console and still running after ' + $AliveSeconds + ' s: ' + ((Get-Content $StartupLog | Select-Object -Last 1)))
taskkill /PID $appPid /T /F | Out-Null
[NoConsoleLaunch]::WaitForSingleObject($pi.hProcess, 10000) | Out-Null
exit 0
`);

let status = 1;
try {
  if (isTauri) checkLegacyEvalCall();
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher,
    '-Exe', executable, '-HomeDir', home, '-StartupLog', startupLog, '-PidFile', pidFile, '-Ready1', readyMarks[0], '-Ready2', readyMarks[1], ...(checkBuild ? ['-DataDir', profile] : [])], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  status = result.status ?? 1;
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  if (status !== 0) {
    // A fresh profile also checks for updates: on a build older than the latest release the app may update and quit.
    for (const name of ['crash.log', 'updater.log']) {
      const file = join(profile, name);
      if (existsSync(file)) process.stderr.write(`${name}:\n${readFileSync(file, 'utf8').split('\n').slice(-30).join('\n')}\n`);
    }
  }
} finally {
  // The launcher stops the app itself; this covers a launcher cut off by the timeout.
  if (existsSync(pidFile)) spawnSync('taskkill', ['/PID', readFileSync(pidFile, 'utf8').trim(), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
  catch (error) { console.warn(`Scratch profile not removed: ${error.message}`); }
}
if (status !== 0) {
  console.error('Start without a console FAILED');
  process.exit(1);
}
console.log('Start without a console OK');
