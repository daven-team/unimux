import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLATFORMS, cargoLockVersions, cargoWorkspaceVersion, electronManifest, embeddedPublicKey, expectedReleaseAssets, fileEntry,
  parsePublicKey, platformAssets, readVersions, setCargoLockVersions, setCargoWorkspaceVersion, setTauriConfVersion, tauriConfVersion,
  tauriManifest, verifyMinisign, versionMismatches, workspaceCrateNames,
// @ts-expect-error plain ESM script without type declarations
} from '../scripts/release-lib.mjs';
// @ts-expect-error plain ESM script without type declarations
import { prepareReleaseAssets } from '../scripts/prepare-release-assets.mjs';
import { parseLatestMacYml, selectMacAsset } from '../src/main/macUpdate/feed';

const require = createRequire(import.meta.url);
const FIXTURES = join(__dirname, '..', 'src-tauri', 'crates', 'unimux-update', 'tests', 'fixtures');
const TEST_KEY = readFileSync(join(FIXTURES, 'test.key.pub'), 'utf8').trim();
const PAYLOAD = readFileSync(join(FIXTURES, 'payload.bin'));
const SIG = readFileSync(join(FIXTURES, 'payload.bin.sig'), 'utf8').trim();
const DATE = '2026-11-08T10:00:00.000Z';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('release pipeline (U4): minisign signatures', () => {
  it('verifies a `tauri signer sign` signature and refuses a changed file, a changed comment or another key', () => {
    expect(verifyMinisign(PAYLOAD, SIG, TEST_KEY)).toContain('file:payload.bin');
    const changed = Buffer.from(PAYLOAD);
    changed[0] ^= 1;
    expect(() => verifyMinisign(changed, SIG, TEST_KEY)).toThrow(/does not match/);
    const lines = Buffer.from(SIG, 'base64').toString('utf8').split('\n');
    lines[2] = lines[2].replace('payload.bin', 'other.bin');
    expect(() => verifyMinisign(PAYLOAD, Buffer.from(lines.join('\n')).toString('base64'), TEST_KEY)).toThrow(/trusted comment/);
    expect(() => verifyMinisign(PAYLOAD, SIG, embeddedPublicKey())).toThrow(/not 817A07BB564AC8D0/);
    expect(() => verifyMinisign(PAYLOAD, 'not base64!', TEST_KEY)).toThrow(/base64/);
  });

  it('reads the public key the app embeds (key id 817A07BB564AC8D0)', () => {
    expect(parsePublicKey(embeddedPublicKey()).keyId).toBe('817A07BB564AC8D0');
    expect(parsePublicKey(TEST_KEY).keyId).toBe('2AC77A55B08817B3');
  });
});

describe('release pipeline (U4): update manifests', () => {
  it('writes a latest.yml that electron-updater (Windows 1.1.x) reads, without a blockmap', () => {
    const entry = fileEntry('unimux-Setup-1.2.0.exe', PAYLOAD);
    const yml = electronManifest('1.2.0', [entry], DATE);
    const { parseUpdateInfo, resolveFiles, findFile } = require('electron-updater/out/providers/Provider.js');
    const info = parseUpdateInfo(yml, 'latest.yml', new URL('https://github.com/daven-team/unimux/releases/download/v1.2.0/latest.yml'));
    expect(info.version).toBe('1.2.0');
    expect(info.releaseDate).toBe(DATE);
    const files = resolveFiles(info, new URL('https://github.com/daven-team/unimux/releases/download/v1.2.0/'));
    const file = findFile(files, 'exe');
    expect(file.url.href).toBe('https://github.com/daven-team/unimux/releases/download/v1.2.0/unimux-Setup-1.2.0.exe');
    expect(file.info).toEqual({ url: entry.url, sha512: entry.sha512, size: PAYLOAD.length });
    expect(info.path).toBe(entry.url);
    expect(() => electronManifest('1.2.0', [{ ...entry, url: 'a b.exe' }], DATE)).toThrow();
  });

  it('writes a latest-mac.yml the 1.1.4 macOS engine selects the zip of each architecture from', () => {
    const files = ['arm64', 'x64'].flatMap((arch) => [fileEntry(`unimux-1.2.0-mac-${arch}.zip`, PAYLOAD), fileEntry(`unimux-1.2.0-mac-${arch}.dmg`, PAYLOAD)]);
    const feed = parseLatestMacYml(electronManifest('1.2.0', files, DATE));
    expect(feed.version).toBe('1.2.0');
    expect(feed.files).toHaveLength(4);
    for (const arch of ['arm64', 'x64']) {
      const asset = selectMacAsset(feed, arch);
      expect(asset).toEqual({ name: `unimux-1.2.0-mac-${arch}.zip`, sha512: files.find((f: { url: string }) => f.url === asset?.name).sha512, size: PAYLOAD.length });
    }
  });

  it('writes latest.json in the tauri-plugin-updater format the Rust coordinator and the macOS engine accept', () => {
    const signatures = Object.fromEntries(PLATFORMS.map((p: unknown) => [platformAssets(p, '1.2.0').updater, SIG]));
    const json = JSON.parse(tauriManifest({ version: '1.2.0', notes: 'n', pubDate: DATE, repository: 'daven-team/unimux', signatures }));
    expect(Object.keys(json.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-aarch64-app', 'darwin-x86_64', 'darwin-x86_64-app', 'windows-x86_64', 'windows-x86_64-nsis']);
    const base = 'https://github.com/daven-team/unimux/releases/download/v1.2.0/';
    expect(json.platforms['windows-x86_64']).toEqual({ signature: SIG, url: `${base}unimux-Setup-1.2.0.exe` });
    expect(json.platforms['darwin-aarch64'].url).toBe(`${base}unimux-1.2.0-mac-arm64.app.tar.gz`);
    expect(json.platforms['darwin-x86_64-app'].url).toBe(`${base}unimux-1.2.0-mac-x64.app.tar.gz`);
    // unimux-update mac engine archive_name_ok
    for (const [arch, key] of [['arm64', 'darwin-aarch64'], ['x64', 'darwin-x86_64']]) {
      const name = json.platforms[key].url.split('/').pop();
      expect(/^[A-Za-z0-9][A-Za-z0-9._-]*-mac-(arm64|x64)\.(?:app\.tar\.gz|zip)$/.exec(name)?.[1]).toBe(arch);
      expect(name).toContain('-1.2.0-');
    }
    expect(json.version).toBe('1.2.0');
    expect(json.pub_date).toBe(DATE);
    expect(() => tauriManifest({ version: '1.2.0', notes: '', pubDate: DATE, repository: 'daven-team/unimux', signatures: {} })).toThrow(/no signature/);
  });
});

describe('release pipeline (U4): asset list', () => {
  function artifacts(version: string) {
    const root = mkdtempSync(join(tmpdir(), 'unimux-release-'));
    scratch.push(root);
    for (const platform of PLATFORMS) {
      const dir = join(root, `unimux-${platform.artifact}`);
      mkdirSync(dir);
      const assets = platformAssets(platform, version);
      for (const file of assets.files) if (!file.endsWith('.yml') && !file.endsWith('.sig')) writeFileSync(join(dir, file), PAYLOAD);
      writeFileSync(join(dir, `${assets.updater}.sig`), SIG);
      writeFileSync(join(dir, assets.manifest), electronManifest(version, assets.installers.map((f: string) => fileEntry(f, PAYLOAD)), DATE));
    }
    return root;
  }

  it('assembles exactly the release assets, with verified signatures and checksums', () => {
    const root = artifacts('1.2.0');
    const { output, sums } = prepareReleaseAssets({ root, version: '1.2.0', publicKey: TEST_KEY, notes: 'Notes', now: new Date(DATE) });
    expect(readdirSync(output).sort()).toEqual(expectedReleaseAssets('1.2.0'));
    expect(expectedReleaseAssets('1.2.0')).toEqual([
      'SHA256SUMS.txt', 'latest-mac.yml', 'latest.json', 'latest.yml',
      'unimux-1.2.0-mac-arm64.app.tar.gz', 'unimux-1.2.0-mac-arm64.app.tar.gz.sig', 'unimux-1.2.0-mac-arm64.dmg', 'unimux-1.2.0-mac-arm64.zip',
      'unimux-1.2.0-mac-x64.app.tar.gz', 'unimux-1.2.0-mac-x64.app.tar.gz.sig', 'unimux-1.2.0-mac-x64.dmg', 'unimux-1.2.0-mac-x64.zip',
      'unimux-Setup-1.2.0.exe', 'unimux-Setup-1.2.0.exe.sig',
    ]);
    expect(sums).toHaveLength(13);
    const mac = parseLatestMacYml(readFileSync(join(output, 'latest-mac.yml'), 'utf8'));
    expect(mac.files.map((f) => f.name).sort()).toEqual(['unimux-1.2.0-mac-arm64.dmg', 'unimux-1.2.0-mac-arm64.zip', 'unimux-1.2.0-mac-x64.dmg', 'unimux-1.2.0-mac-x64.zip']);
    const json = JSON.parse(readFileSync(join(output, 'latest.json'), 'utf8'));
    expect(json.notes).toBe('Notes');
    expect(json.platforms['windows-x86_64'].signature).toBe(SIG);
  });

  it('refuses a bad signature, a missing or extra file and a manifest that does not match its file', () => {
    let root = artifacts('1.2.0');
    expect(() => prepareReleaseAssets({ root, version: '1.2.0', publicKey: embeddedPublicKey() })).toThrow(/sig/);
    root = artifacts('1.2.0');
    writeFileSync(join(root, 'unimux-macos-x64', 'unimux-1.2.0-mac-x64.app.tar.gz'), 'tampered');
    expect(() => prepareReleaseAssets({ root, version: '1.2.0', publicKey: TEST_KEY })).toThrow(/does not match/);
    root = artifacts('1.2.0');
    writeFileSync(join(root, 'unimux-windows-x64', 'unimux-Setup-1.2.0.exe.blockmap'), 'x');
    expect(() => prepareReleaseAssets({ root, version: '1.2.0', publicKey: TEST_KEY })).toThrow(/unexpected files/);
    root = artifacts('1.2.0');
    rmSync(join(root, 'unimux-macos-arm64', 'unimux-1.2.0-mac-arm64.app.tar.gz.sig'));
    expect(() => prepareReleaseAssets({ root, version: '1.2.0', publicKey: TEST_KEY })).toThrow(/unexpected files/);
    root = artifacts('1.2.0');
    copyFileSync(join(FIXTURES, 'test.key.pub'), join(root, 'unimux-windows-x64', 'unimux-Setup-1.2.0.exe'));
    expect(() => prepareReleaseAssets({ root, version: '1.2.0', publicKey: TEST_KEY })).toThrow(/size|hash/);
    expect(() => prepareReleaseAssets({ root: artifacts('1.2.0'), version: '1.2.1', publicKey: TEST_KEY })).toThrow();
  });
});

describe('release pipeline (U4): version files', () => {
  it('reads every version file of this checkout; the Tauri ones agree with each other', () => {
    const versions = readVersions();
    const cargo = versions['src-tauri/Cargo.toml'];
    expect(versions['src-tauri/crates/unimux-app/tauri.conf.json']).toBe(cargo);
    expect(workspaceCrateNames()).toContain('unimux-app');
    expect(Object.keys(versions).filter((k) => k.startsWith('src-tauri/Cargo.lock '))).toHaveLength(workspaceCrateNames().length);
    expect(versionMismatches({ a: '1.2.0', b: '1.1.4' }, '1.2.0')).toEqual(['b is 1.1.4']);
  });

  it('bumps Cargo.toml, tauri.conf.json and the workspace crates in Cargo.lock only', () => {
    const toml = readFileSync('src-tauri/Cargo.toml', 'utf8');
    const bumped = setCargoWorkspaceVersion(toml, '9.8.7');
    expect(cargoWorkspaceVersion(bumped)).toBe('9.8.7');
    expect((bumped as string).split('\n').filter((l: string, i: number) => l !== toml.split('\n')[i])).toEqual(['version = "9.8.7"']);
    const conf = readFileSync('src-tauri/crates/unimux-app/tauri.conf.json', 'utf8');
    const confBumped = setTauriConfVersion(conf, '9.8.7');
    expect(tauriConfVersion(confBumped)).toBe('9.8.7');
    expect(JSON.parse(confBumped).bundle).toEqual(JSON.parse(conf).bundle);
    const lock = readFileSync('src-tauri/Cargo.lock', 'utf8');
    const names = workspaceCrateNames();
    const lockBumped = setCargoLockVersions(lock, names, '9.8.7');
    expect(Object.values(cargoLockVersions(lockBumped, names))).toEqual(names.map(() => '9.8.7'));
    // Only the workspace crates' lines changed.
    const before = lock.split(/\r?\n/);
    const changed = (lockBumped as string).split(/\r?\n/).filter((l: string, i: number) => l !== before[i]);
    expect(changed).toHaveLength(names.length);
    expect(new Set(changed)).toEqual(new Set(['version = "9.8.7"']));
  });
});
