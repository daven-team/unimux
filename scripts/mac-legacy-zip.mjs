// macOS: the ditto zip that Electron 1.1.x installs update into 1.2.0 through (PLAN U3, ARCHITECTURE section 8, SP4).
//
// The 1.1.4 engine (src/main/macUpdate) reads latest-mac.yml, downloads `unimux-<version>-mac-<arch>.zip`, unpacks it with
// `ditto -x -k` and accepts exactly one .app whose Info.plist has CFBundleShortVersionString = <version>, the running app's
// CFBundleIdentifier (com.ajzakomator.app) and a CFBundleExecutable that exists with the exec bit, and that passes
// `codesign --verify --deep --strict` (the ad-hoc signature counts). This script checks the Tauri .app against exactly those
// rules BEFORE zipping (a release whose zip the old engine refuses would strand every 1.1.x Mac), zips it with
// `ditto -c -k --keepParent`, unpacks the zip again to check it holds one .app, and writes the latest-mac.yml entry
// (`url`, base64 `sha512`, `size`) as JSON next to it for the release step (U4) to merge.
//
//   node scripts/mac-legacy-zip.mjs <unimux.app> <version> <arm64|x64> <out dir>
//
// macOS only (ditto, plutil, codesign). The checks themselves are pure functions, tested in test/macLegacyZip.test.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The identifier of every unimux macOS build since 0.1 (keeps TCC grants; the 1.1.4 engine compares it). */
export const MAC_IDENTIFIER = 'com.ajzakomator.app';
export const MAC_EXECUTABLE = 'unimux';
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** feed.ts ASSET_NAME of 1.1.4: only such names are downloaded at all. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*-mac-(arm64|x64)\.zip$/;

/** `unimux-<version>-mac-<arch>.zip`, the name the 1.1.4 feed reader and engine accept (checked against both regexes). */
export function legacyZipName(version, arch) {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`not a macOS architecture: ${arch}`);
  const name = `unimux-${version}-mac-${arch}.zip`;
  const match = ASSET_NAME.exec(name);
  if (!match || match[1] !== arch || !name.includes(`-${version}-`)) throw new Error(`${name} would not be accepted by the 1.1.4 feed reader`);
  if (/-(\d+\.\d+\.\d+[^/]*?)-mac-(?:arm64|x64)\.zip$/.exec(name)?.[1] !== version) throw new Error(`${name}: the 1.1.4 engine reads another version from it`);
  return name;
}

/**
 * The Info.plist rules of the 1.1.4 engine's `verifyBundle` (plus the executable name 1.2.0 ships). `info` is the plist as a
 * plain object (plutil -convert json). Returns the problems; empty when the old engine accepts the bundle.
 */
export function bundleProblems(info, version) {
  const problems = [];
  if (info?.CFBundleShortVersionString !== version) problems.push(`CFBundleShortVersionString is ${info?.CFBundleShortVersionString ?? '(none)'}, not ${version}`);
  if (info?.CFBundleIdentifier !== MAC_IDENTIFIER) problems.push(`CFBundleIdentifier is ${info?.CFBundleIdentifier ?? '(none)'}, not ${MAC_IDENTIFIER}`);
  const exe = info?.CFBundleExecutable;
  if (typeof exe !== 'string' || !exe || exe.includes('/') || exe === '.' || exe === '..') problems.push('no valid CFBundleExecutable');
  else if (exe !== MAC_EXECUTABLE) problems.push(`CFBundleExecutable is ${exe}, not ${MAC_EXECUTABLE}`);
  return problems;
}

/** The latest-mac.yml `files` entry of a zip: electron-builder's format (base64 sha512, size in bytes). */
export function feedEntry(name, bytes) {
  return { url: name, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

function checkApp(app, version) {
  const plist = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]);
  if (plist.status !== 0) throw new Error(`Info.plist unreadable: ${plist.stderr.trim()}`);
  const info = JSON.parse(plist.stdout);
  const problems = bundleProblems(info, version);
  const exe = join(app, 'Contents', 'MacOS', String(info.CFBundleExecutable ?? ''));
  let mode = 0;
  try { mode = statSync(exe).isFile() ? statSync(exe).mode : 0; } catch { /* reported below */ }
  if (!(mode & 0o111)) problems.push(`${exe} is missing or not executable`);
  const signed = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (signed.status !== 0) problems.push(`codesign --verify --deep --strict: ${signed.stderr.trim()}`);
  if (problems.length) throw new Error(`the 1.1.4 engine would refuse ${app}:\n  ${problems.join('\n  ')}`);
}

function main() {
  const [appArg, version, arch, outArg] = process.argv.slice(2);
  if (!appArg || !version || !arch || !outArg) {
    console.error('usage: node scripts/mac-legacy-zip.mjs <unimux.app> <version> <arm64|x64> <out dir>');
    process.exit(2);
  }
  if (process.platform !== 'darwin') { console.error('mac-legacy-zip: macOS only (ditto, plutil, codesign)'); process.exit(2); }
  const app = resolve(appArg);
  if (!app.endsWith('.app')) throw new Error(`${app} is not an .app bundle`);
  const name = legacyZipName(version, arch);
  checkApp(app, version);
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const zip = join(out, name);
  rmSync(zip, { force: true });
  const zipped = run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  if (zipped.status !== 0) throw new Error(`ditto -c failed: ${zipped.stderr.trim()}`);
  // What the old engine sees: exactly one .app at the top of the unpacked zip, still valid.
  const check = mkdtempSync(join(tmpdir(), 'unimux-legacy-zip-'));
  try {
    const unpacked = run('/usr/bin/ditto', ['-x', '-k', zip, check]);
    if (unpacked.status !== 0) throw new Error(`ditto -x failed: ${unpacked.stderr.trim()}`);
    const apps = readdirSync(check).filter((n) => n.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`the zip holds ${apps.length} .app bundles, the 1.1.4 engine wants exactly one`);
    checkApp(join(check, apps[0]), version);
  } finally {
    rmSync(check, { recursive: true, force: true });
  }
  const entry = feedEntry(name, readFileSync(zip));
  writeFileSync(join(out, `${basename(zip, '.zip')}.feed.json`), `${JSON.stringify(entry, null, 2)}\n`);
  console.log(`mac-legacy-zip: ${zip} (${entry.size} bytes) accepted by the 1.1.4 rules`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`mac-legacy-zip: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
