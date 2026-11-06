// Runs a command (cargo, the Tauri CLI) with the MSVC build environment on Windows.
//
// rustc looks for link.exe through vswhere; a Visual Studio 2026 (version 18) Build Tools install that vswhere does not report
// (and Git Bash's own /usr/bin/link.exe earlier on PATH) make it fail with "linker `link.exe` not found" or "extra operand".
// When no MSVC link.exe is active, this loads vcvars64.bat once and runs the command with that environment. Elsewhere (macOS,
// a Developer prompt) it just runs the command.
//
//   node scripts/msvc-run.mjs cargo build --workspace
//   node scripts/msvc-run.mjs --target-dir=check tauri build ...   (CARGO_TARGET_DIR = src-tauri/target/check)
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findVcvars() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((p) => join(p, 'Microsoft Visual Studio'));
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const candidates = [];
  if (existsSync(vswhere)) {
    try {
      const out = execFileSync(vswhere, ['-all', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) if (line.trim()) candidates.push(join(line.trim(), 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'));
    } catch { /* fall back to the folder scan */ }
  }
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // <root>\<version>\<edition>\VC\Auxiliary\Build\vcvars64.bat, newest version first.
    for (const version of readdirSync(root).sort().reverse()) {
      let editions = [];
      try { editions = readdirSync(join(root, version)); } catch { continue; }
      for (const edition of editions) candidates.push(join(root, version, edition, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'));
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

function msvcActive() {
  if (process.env.VCINSTALLDIR) return true;
  try {
    const out = execFileSync('where.exe', ['link.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /\\MSVC\\/i.test(out.split(/\r?\n/)[0] ?? '');
  } catch { return false; }
}

export function msvcEnv() {
  if (process.platform !== 'win32' || msvcActive()) return process.env;
  const vcvars = findVcvars();
  if (!vcvars) {
    console.warn('msvc-run: no vcvars64.bat found; install the "Desktop development with C++" workload (MSVC + Windows SDK).');
    return process.env;
  }
  const installer = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer');
  const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"set "PATH=${installer};%PATH%" && call "${vcvars}" >nul 2>nul && set"`], { encoding: 'utf8', windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024 });
  const env = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  // Keep cargo reachable even when vcvars rebuilt PATH from the machine values only.
  const cargoBin = join(process.env.USERPROFILE ?? '', '.cargo', 'bin');
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  if (!env[pathKey].toLowerCase().includes(cargoBin.toLowerCase())) env[pathKey] = `${cargoBin};${env[pathKey]}`;
  addUserSdk(env, pathKey);
  return env;
}

/**
 * Without the Windows SDK (kernel32.lib, rc.exe) the MSVC tools cannot link. When the SDK is not installed, a user-level copy
 * of Microsoft's official NuGet packages Microsoft.Windows.SDK.CPP and Microsoft.Windows.SDK.CPP.x64, extracted to
 * UNIMUX_WINSDK_DIR (default %LOCALAPPDATA%\unimux-build\winsdk-<version>, see docs/tauri/PROGRESS.md), is used instead.
 * The proper fix is the "Windows 11 SDK" component in the Visual Studio installer.
 */
function addUserSdk(env, pathKey) {
  const libKey = Object.keys(env).find((k) => k.toLowerCase() === 'lib') ?? 'LIB';
  const lib = env[libKey] ?? '';
  if (lib.split(';').some((dir) => dir && existsSync(join(dir, 'kernel32.lib')))) return;
  let root = process.env.UNIMUX_WINSDK_DIR;
  if (!root) {
    const parent = join(process.env.LOCALAPPDATA ?? '', 'unimux-build');
    const found = existsSync(parent) ? readdirSync(parent).filter((n) => n.startsWith('winsdk-')).sort().reverse()[0] : undefined;
    if (found) root = join(parent, found);
  }
  if (!root || !existsSync(root)) {
    console.warn('msvc-run: the Windows SDK is missing (no kernel32.lib); install "Windows 11 SDK" in the Visual Studio installer.');
    return;
  }
  const cpp = join(root, 'microsoft.windows.sdk.cpp', 'c');
  const x64 = join(root, 'microsoft.windows.sdk.cpp.x64', 'c');
  const version = readdirSync(join(cpp, 'Include')).filter((n) => /^10\./.test(n)).sort().reverse()[0];
  env[libKey] = [join(x64, 'um', 'x64'), join(x64, 'ucrt', 'x64'), lib].filter(Boolean).join(';');
  const includeKey = Object.keys(env).find((k) => k.toLowerCase() === 'include') ?? 'INCLUDE';
  env[includeKey] = [...['ucrt', 'um', 'shared', 'winrt', 'cppwinrt'].map((d) => join(cpp, 'Include', version, d)), env[includeKey] ?? ''].filter(Boolean).join(';');
  env[pathKey] = `${join(cpp, 'bin', version, 'x64')};${env[pathKey]}`;
  env.WindowsSdkDir = `${cpp}\\`;
  env.WindowsSDKVersion = `${version}\\`;
  env.WindowsSdkBinPath = `${join(cpp, 'bin')}\\`;
  env.WindowsSdkVerBinPath = `${join(cpp, 'bin', version)}\\`;
}

if (process.argv[1] && process.argv[1].endsWith('msvc-run.mjs')) {
  let rest = process.argv.slice(2);
  const env = { ...msvcEnv() };
  // A target dir of its own per flavour, so the check build never overwrites the release build (and the reverse).
  if (rest[0]?.startsWith('--target-dir=')) {
    env.CARGO_TARGET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'target', rest[0].slice('--target-dir='.length));
    rest = rest.slice(1);
  }
  const [command, ...args] = rest;
  if (!command) {
    console.error('usage: node scripts/msvc-run.mjs <command> [args...]');
    process.exit(2);
  }
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  process.exit(result.status ?? 1);
}
