// Starts the packaged Windows app the way the Start menu, a shortcut or the installer does: no console to attach to and no
// standard handles. 0.9.3 and 0.9.4 crashed in exactly this case (the Pty Host launch got a null stdout handle, exit code
// 0x80000003), while every check started from a terminal passed. The app runs in a scratch profile and is stopped afterwards.
// Tauri (default): the check build (npm run build:check) with MC_DATA_DIR and MC_OFFSCREEN, so nothing reaches the real profile
// and no window shows; a release unimux.exe ignores both, so it is only run with --ci (the CI machine of U4). Electron
// (MC_APP_TARGET=electron): release/win-unpacked/unimux.exe as before.
// Usage: node scripts/smoke-start.mjs [exe] [--ci]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appBinary, isTauri } from './real-app.mjs';

if (process.platform !== 'win32') {
  console.log('Start without a console: Windows only, skipped');
  process.exit(0);
}

const args = process.argv.slice(2);
const ci = args.includes('--ci');
const executable = resolve(args.find((a) => !a.startsWith('--')) ?? (isTauri ? appBinary() : 'release/win-unpacked/unimux.exe'));
if (!existsSync(executable)) throw new Error(`Packaged app not found: ${executable}`);
const checkBuild = isTauri && /[\\/]target[\\/]check[\\/]/i.test(executable);
if (isTauri && !checkBuild && !ci) throw new Error(`${executable} is not the check build: a release build ignores MC_DATA_DIR and would start on the real profile (use --ci on a CI machine)`);
const scratch = mkdtempSync(join(tmpdir(), 'unimux-start-'));
const home = join(scratch, 'home');
for (const dir of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(home, dir), { recursive: true });
const profile = join(home, 'AppData', 'Roaming', 'unimux');
mkdirSync(profile, { recursive: true });
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
