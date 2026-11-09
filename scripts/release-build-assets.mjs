// CI step of a platform build (PLAN U4), after `npx tauri build --target <target>`: turns Tauri's bundle output into the
// release assets of that platform and writes them into one folder (the job's artifact).
//
//   Windows x64:  unimux-Setup-<v>.exe (+ .sig)                        latest.yml      (electron-updater, 1.1.x clients)
//   macOS <arch>: unimux-<v>-mac-<arch>.zip (ditto, scripts/mac-legacy-zip.mjs) and .dmg   latest-mac.yml  (1.1.x clients)
//                 unimux-<v>-mac-<arch>.app.tar.gz (+ .sig)            (Tauri clients, latest.json is written at publish time)
//
// Signing: `tauri signer sign` with the TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD secrets taken from the
// environment (never put on a command line, never printed); every signature is checked against the public key the app
// embeds right away. Without the key the step fails unless --allow-unsigned (pull requests from forks, which get no secrets).
//
//   node scripts/release-build-assets.mjs --target <rust target> [--out release] [--allow-unsigned]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  TAURI_CONF, electronManifest, embeddedPublicKey, fileEntry, platformAssets, platformOfTarget, readVersions, rootPath,
  tauriConfVersion, verifyMinisign,
} from './release-lib.mjs';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const target = option('--target');
if (!target) { console.error('usage: node scripts/release-build-assets.mjs --target <rust target> [--out release] [--allow-unsigned]'); process.exit(2); }
const allowUnsigned = args.includes('--allow-unsigned');
const out = resolve(option('--out') ?? rootPath('release'));
const platform = platformOfTarget(target);
const version = tauriConfVersion(readFileSync(rootPath(TAURI_CONF), 'utf8'));
const assets = platformAssets(platform, version);
const bundle = rootPath('src-tauri', 'target', target, 'release', 'bundle');

const fail = (message) => { console.error(`release-build-assets: ${message}`); process.exit(1); };
const packageVersion = readVersions()['package.json'];
if (packageVersion !== version) console.warn(`release-build-assets: package.json is ${packageVersion}, the app is ${version} (a tag build refuses this in Release metadata)`);

function run(cmd, cmdArgs, options = {}) {
  // stdin closed: a missing key password must fail, never wait for a prompt.
  const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
  if (result.error) throw result.error;
  return result;
}

function single(dir, test, what) {
  const found = existsSync(dir) ? readdirSync(dir).filter(test) : [];
  if (found.length !== 1) fail(`expected one ${what} in ${dir}, found ${found.length ? found.join(', ') : 'none'}`);
  return join(dir, found[0]);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let manifestFiles;
if (platform.os === 'windows') {
  // Tauri names it unimux_<version>_x64-setup.exe; 1.1.x clients and the download page know unimux-Setup-<version>.exe.
  const setup = single(join(bundle, 'nsis'), (name) => name === `unimux_${version}_x64-setup.exe`, `NSIS installer of ${version}`);
  copyFileSync(setup, join(out, assets.updater));
  manifestFiles = [fileEntry(assets.updater, readFileSync(join(out, assets.updater)))];
} else {
  if (process.platform !== 'darwin') fail('the macOS assets are made on macOS (ditto, codesign, tar)');
  const macos = join(bundle, 'macos');
  const app = join(macos, 'unimux.app');
  if (!existsSync(app)) fail(`${app} is missing`);
  const [zipName, dmgName] = assets.installers;
  // The ditto zip 1.1.x Macs update through; mac-legacy-zip checks the bundle against the 1.1.4 engine's rules first.
  const zipped = run(process.execPath, [rootPath('scripts', 'mac-legacy-zip.mjs'), app, version, platform.arch, out], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (zipped.status !== 0) fail('mac-legacy-zip failed');
  const feedFile = join(out, `${zipName.replace(/\.zip$/, '')}.feed.json`);
  const zipEntry = JSON.parse(readFileSync(feedFile, 'utf8'));
  rmSync(feedFile);
  const dmg = single(join(bundle, 'dmg'), (name) => name.endsWith('.dmg'), 'dmg');
  copyFileSync(dmg, join(out, dmgName));
  // The Tauri updater archive: unimux.app/ at the top, modes and symlinks kept, no AppleDouble files.
  const tar = run('/usr/bin/tar', ['--no-mac-metadata', '-czf', join(out, assets.updater), '-C', macos, 'unimux.app'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (tar.status !== 0) fail(`tar failed: ${tar.stderr.trim()}`);
  const listed = run('/usr/bin/tar', ['-tzf', join(out, assets.updater)]);
  const stray = listed.stdout.split('\n').filter(Boolean).filter((entry) => entry !== 'unimux.app' && !entry.startsWith('unimux.app/'));
  if (listed.status !== 0 || stray.length) fail(`${assets.updater} does not hold unimux.app only: ${stray.slice(0, 5).join(', ')}`);
  const zipBytes = readFileSync(join(out, zipName));
  const zipCheck = fileEntry(zipName, zipBytes);
  if (zipCheck.sha512 !== zipEntry.sha512 || zipCheck.size !== zipEntry.size) fail(`${zipName} changed after mac-legacy-zip`);
  manifestFiles = [zipCheck, fileEntry(dmgName, readFileSync(join(out, dmgName)))];
}

const releaseDate = new Date().toISOString();
writeFileSync(join(out, assets.manifest), electronManifest(version, manifestFiles, releaseDate));

const signing = !!process.env.TAURI_SIGNING_PRIVATE_KEY;
if (signing) {
  const file = join(out, assets.updater);
  const tauri = rootPath('node_modules', '@tauri-apps', 'cli', 'tauri.js');
  // A secret pasted from a file written on Windows can start with a UTF-8 BOM or end with a line break; neither is part of it.
  const secret = (value) => value?.replace(/^﻿/, '').replace(/[\r\n]+$/, '');
  const env = {
    ...process.env,
    CI: 'true',
    TAURI_SIGNING_PRIVATE_KEY: secret(process.env.TAURI_SIGNING_PRIVATE_KEY),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: secret(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD),
  };
  const signed = run(process.execPath, [tauri, 'signer', 'sign', '--app-version', version, file], { env });
  // The CLI's errors name what went wrong (a wrong password, a key that does not decode), never the key; anything long enough to be one is cut anyway.
  if (signed.status !== 0 || !existsSync(`${file}.sig`)) fail(`tauri signer sign failed (exit ${signed.status}): ${signed.stderr.replace(/[A-Za-z0-9+/=]{24,}/g, '<redacted>').split('\n').map((l) => l.trim()).filter(Boolean).join(' | ').slice(0, 400)}`);
  try {
    const comment = verifyMinisign(readFileSync(file), readFileSync(`${file}.sig`, 'utf8'), embeddedPublicKey());
    console.log(`Signed ${assets.updater} (${comment})`);
  } catch (error) {
    fail(`${assets.updater}.sig does not verify with the app's public key: ${error.message}`);
  }
} else if (!allowUnsigned) {
  fail('TAURI_SIGNING_PRIVATE_KEY is not set: the updater artifacts must be signed (use --allow-unsigned for a pull request build)');
} else {
  console.warn(`release-build-assets: ${assets.updater} left unsigned (--allow-unsigned)`);
}

const expected = assets.files.filter((name) => signing || !name.endsWith('.sig')).sort();
const written = readdirSync(out).sort();
if (JSON.stringify(written) !== JSON.stringify(expected)) fail(`unexpected files in ${out}: ${written.join(', ')} (expected ${expected.join(', ')})`);
console.log(`Release assets of ${platform.artifact} ${version}:\n  ${written.join('\n  ')}`);
