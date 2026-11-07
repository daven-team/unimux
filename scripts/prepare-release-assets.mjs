// "Publish release" step (and the CI rehearsal, PLAN U4): checks the three platform artifacts of a CI run and assembles the
// exact asset list of a release in <root>/publish:
//
//   latest.yml + unimux-Setup-X.exe                           Windows clients still on Electron 1.1.x (electron-updater)
//   latest-mac.yml + unimux-X-mac-<arch>.zip / .dmg           macOS clients still on Electron 1.1.x (the 1.1.4 engine)
//   latest.json + unimux-Setup-X.exe.sig + unimux-X-mac-<arch>.app.tar.gz(.sig)   Tauri clients (1.2.0 and later)
//   SHA256SUMS.txt
//
// Every manifest entry must match its file (sha512 + size), every .sig must verify with the public key the app embeds
// (UPDATER_PUBLIC_KEY, key id 817A07BB564AC8D0), and the folder must hold exactly the expected files.
//
//   node scripts/prepare-release-assets.mjs <artifact root> <version> [--repository owner/repo] [--notes file]
//        [--public-key <base64 .pub>]   (tests only: another key than the embedded one)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import {
  DEFAULT_REPOSITORY, PLATFORMS, VERSION, electronManifest, embeddedPublicKey, expectedReleaseAssets, parsePublicKey, platformAssets,
  tauriManifest, verifyMinisign,
} from './release-lib.mjs';

/** The release notes as latest.json `notes`: the notes file without its `# unimux X` heading. */
export function notesText(file) {
  if (!file || !existsSync(file)) return '';
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/^# [^\n]*\n+/, '').trim();
}

function checkManifest(directory, name, version) {
  const manifest = load(readFileSync(join(directory, name), 'utf8'));
  assert.equal(manifest.version, version, `${name} version`);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length, `${name} lists no files`);
  for (const file of manifest.files) {
    assert.equal(file.url, basename(file.url), `${name}: ${file.url} is not a plain file name`);
    assert.ok(file.url.includes(version), `${name}: ${file.url} is not of this release`);
    const data = readFileSync(join(directory, file.url));
    assert.equal(data.length, file.size, `${file.url} size`);
    assert.equal(createHash('sha512').update(data).digest('base64'), file.sha512, `${file.url} hash`);
  }
  return manifest;
}

export function prepareReleaseAssets({ root, version, repository = DEFAULT_REPOSITORY, notes = '', publicKey = embeddedPublicKey(), now = new Date() }) {
  assert.ok(root, 'Provide the CI artifact directory');
  assert.match(version ?? '', VERSION);
  const keyId = parsePublicKey(publicKey).keyId;
  const output = join(root, 'publish');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const macFiles = [];
  let macDate;
  const signatures = {};
  for (const platform of PLATFORMS) {
    const directory = join(root, `unimux-${platform.artifact}`);
    const assets = platformAssets(platform, version);
    const present = existsSync(directory) ? readdirSync(directory).sort() : [];
    assert.deepEqual(present, [...assets.files].sort(), `unimux-${platform.artifact} holds unexpected files`);
    const manifest = checkManifest(directory, assets.manifest, version);
    assert.deepEqual(manifest.files.map((file) => file.url).sort(), [...assets.installers].sort(), `${assets.manifest} of ${platform.artifact}`);
    // The updater artifact of Tauri clients and its minisign signature.
    const signature = readFileSync(join(directory, `${assets.updater}.sig`), 'utf8').trim();
    try { verifyMinisign(readFileSync(join(directory, assets.updater)), signature, publicKey); }
    catch (error) { throw new Error(`${assets.updater}.sig: ${error.message} (key ${keyId})`); }
    signatures[assets.updater] = signature;
    for (const file of assets.files) if (!file.endsWith('.yml')) copyFileSync(join(directory, file), join(output, file));
    if (platform.os === 'windows') copyFileSync(join(directory, assets.manifest), join(output, assets.manifest));
    else {
      macFiles.push(...manifest.files);
      macDate ??= manifest.releaseDate;
    }
  }
  assert.equal(new Set(macFiles.map((file) => file.url)).size, macFiles.length, 'a macOS asset is listed twice');
  writeFileSync(join(output, 'latest-mac.yml'), electronManifest(version, macFiles, macDate ?? now.toISOString()));
  writeFileSync(join(output, 'latest.json'), tauriManifest({ version, notes, pubDate: now.toISOString(), repository, signatures }));
  const expected = expectedReleaseAssets(version).filter((file) => file !== 'SHA256SUMS.txt');
  assert.deepEqual(readdirSync(output).sort(), expected, 'the release asset list');
  const sums = expected.map((file) => `${createHash('sha256').update(readFileSync(join(output, file))).digest('hex')}  ${file}`);
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  assert.deepEqual(readdirSync(output).sort(), expectedReleaseAssets(version));
  return { output, sums, keyId };
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const [root, version] = positional;
  const keyFile = option('--public-key');
  const { output, sums, keyId } = prepareReleaseAssets({
    root: resolve(root ?? ''), version, repository: option('--repository') ?? process.env.RELEASE_REPOSITORY ?? DEFAULT_REPOSITORY,
    notes: notesText(option('--notes') ?? `docs/releases/${version}.md`),
    ...(keyFile ? { publicKey: readFileSync(keyFile, 'utf8').trim() } : {}),
  });
  console.log(`Verified ${sums.length} assets in ${output}: manifests match package hashes and sizes, signatures verify with key ${keyId}.`);
  console.log(sums.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`prepare-release-assets: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
