// Compile check of src-tauri/resources/installer-hooks.nsh (PLAN U3) without building the app: a small script that includes
// the hooks next to the Tauri NSIS template's own helpers (utils.nsh of the tauri-bundler in the cargo registry) and the
// NSIS toolset Tauri downloads (%LOCALAPPDATA%\tauri\NSIS), compiled with makensis into a temp folder. The result is never
// run (it would install over the real app); only the compiler's verdict counts.
//
//   node scripts/check-installer-hooks.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooks = join(root, 'src-tauri', 'resources', 'installer-hooks.nsh');

function fail(message) {
  console.error(`check-installer-hooks: ${message}`);
  process.exit(1);
}

if (process.platform !== 'win32') fail('Windows only (makensis from the Tauri NSIS toolset)');
const nsis = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'tauri', 'NSIS');
const makensis = join(nsis, 'makensis.exe');
if (!existsSync(makensis)) fail(`${makensis} is missing (run a Tauri NSIS build once)`);

const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
const bundlers = existsSync(registry)
  ? readdirSync(registry).flatMap((index) => readdirSync(join(registry, index)).filter((d) => d.startsWith('tauri-bundler-')).map((d) => join(registry, index, d)))
  : [];
const bundler = bundlers.sort().at(-1);
if (!bundler) fail('tauri-bundler is not in the cargo registry (cargo fetch first)');
const utils = join(bundler, 'src', 'bundle', 'windows', 'nsis', 'utils.nsh');

const work = mkdtempSync(join(tmpdir(), 'unimux-hooks-'));
try {
  const script = [
    'Unicode true',
    `!addplugindir "${join(nsis, 'Plugins', 'x86-unicode', 'additional')}"`,
    '!include FileFunc.nsh',
    '!include x64.nsh',
    '!include WordFunc.nsh',
    '!include LogicLib.nsh',
    '!include "Win\\COM.nsh"',
    '!include "Win\\Propkey.nsh"',
    '!include "Win\\RestartManager.nsh"',
    '!define MANUFACTURER "ajzak, azozowsky"',
    '!define PRODUCTNAME "unimux"',
    '!define VERSION "1.2.0"',
    '!define MAINBINARYNAME "unimux"',
    '!define BUNDLEID "com.unimux.app"',
    '!define INSTALLMODE "currentUser"',
    '!define ARCH "x64"',
    '!define STARTMENUFOLDER ""',
    '!define MANUKEY "Software\\${MANUFACTURER}"',
    '!define MANUPRODUCTKEY "${MANUKEY}\\${PRODUCTNAME}"',
    'Var UpdateMode',
    `!include "${utils}"`,
    `!include "${hooks}"`,
    `OutFile "${join(work, 'hooks-check.exe')}"`,
    'RequestExecutionLevel user',
    'InstallDir "$LOCALAPPDATA\\unimux-hooks-check"',
    'Section Install',
    '  SetOutPath $INSTDIR',
    '  !insertmacro NSIS_HOOK_PREINSTALL',
    '  !insertmacro NSIS_HOOK_POSTINSTALL',
    '  WriteUninstaller "$INSTDIR\\uninstall.exe"',
    'SectionEnd',
    'Section Uninstall',
    '  !insertmacro NSIS_HOOK_POSTUNINSTALL',
    'SectionEnd',
    '',
  ].join('\r\n');
  const nsi = join(work, 'hooks-check.nsi');
  writeFileSync(nsi, script);
  const result = spawnSync(makensis, ['/V2', '/WX', nsi], { encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) fail(`makensis exited with ${result.status}`);
  console.log('check-installer-hooks: the hooks compile (makensis /WX, no warnings)');
} finally {
  rmSync(work, { recursive: true, force: true });
}
