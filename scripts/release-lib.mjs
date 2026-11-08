// Shared pieces of the 1.2.0 release pipeline (PLAN U4): asset names, the update manifests (electron-builder's latest.yml /
// latest-mac.yml for 1.1.x clients, tauri-plugin-updater's latest.json for Tauri clients), the minisign check of the updater
// signatures and the three version files (package.json, src-tauri/Cargo.toml, tauri.conf.json). Pure functions, no network,
// no private key: signing happens only in CI (`tauri signer sign` with the TAURI_SIGNING_PRIVATE_KEY secret).
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const rootPath = (...parts) => join(ROOT, ...parts);

export const DEFAULT_REPOSITORY = 'daven-team/unimux';
export const VERSION = /^\d+\.\d+\.\d+$/;
/** Where the version of the Tauri app lives besides package.json (all three must agree on a tag). */
export const CARGO_TOML = 'src-tauri/Cargo.toml';
export const CARGO_LOCK = 'src-tauri/Cargo.lock';
export const TAURI_CONF = 'src-tauri/crates/unimux-app/tauri.conf.json';
/** The Rust constant the app verifies downloads with (U1); the release checks every .sig against the same key. */
export const PUBLIC_KEY_SOURCE = 'src-tauri/crates/unimux-update/src/lib.rs';

/** The CI matrix: artifact folder, Rust target, Node-style architecture (the asset names of 1.1.x) and latest.json keys. */
export const PLATFORMS = [
  { artifact: 'windows-x64', target: 'x86_64-pc-windows-msvc', os: 'windows', arch: 'x64', feedKeys: ['windows-x86_64', 'windows-x86_64-nsis'] },
  { artifact: 'macos-arm64', target: 'aarch64-apple-darwin', os: 'macos', arch: 'arm64', feedKeys: ['darwin-aarch64', 'darwin-aarch64-app'] },
  { artifact: 'macos-x64', target: 'x86_64-apple-darwin', os: 'macos', arch: 'x64', feedKeys: ['darwin-x86_64', 'darwin-x86_64-app'] },
];

export function platformOfTarget(target) {
  const platform = PLATFORMS.find((p) => p.target === target);
  if (!platform) throw new Error(`unknown release target: ${target}`);
  return platform;
}

/** The file names of one platform's CI artifact (what release-build-assets.mjs writes into release/). */
export function platformAssets(platform, version) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  if (platform.os === 'windows') {
    const setup = `unimux-Setup-${version}.exe`;
    return { manifest: 'latest.yml', installers: [setup], updater: setup, files: [setup, `${setup}.sig`, 'latest.yml'] };
  }
  const base = `unimux-${version}-mac-${platform.arch}`;
  const updater = `${base}.app.tar.gz`;
  return {
    manifest: 'latest-mac.yml',
    // electron-builder's order in latest-mac.yml: the zip first (the 1.1.x engine selects it by name anyway), then the dmg.
    installers: [`${base}.zip`, `${base}.dmg`],
    updater,
    files: [`${base}.zip`, `${base}.dmg`, updater, `${updater}.sig`, 'latest-mac.yml'],
  };
}

/** Every asset of a release, sorted: what `gh release create` uploads (plus SHA256SUMS.txt). */
export function expectedReleaseAssets(version) {
  const names = new Set(['latest.yml', 'latest-mac.yml', 'latest.json', 'SHA256SUMS.txt']);
  for (const platform of PLATFORMS) for (const file of platformAssets(platform, version).files) names.add(file);
  return [...names].sort();
}

/** electron-builder's `files` entry: base64 sha512 and the size in bytes. */
export function fileEntry(name, bytes) {
  return { url: name, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length };
}

/**
 * latest.yml / latest-mac.yml in electron-builder's layout (version, files, path, sha512, releaseDate). electron-updater
 * (Windows 1.1.x) reads `files`; the 1.1.4 macOS engine reads `version` and `files` only. No blockmap: electron-updater falls
 * back to the full download when the differential one fails.
 */
export function electronManifest(version, files, releaseDate) {
  if (!files.length) throw new Error('a manifest needs at least one file');
  // Written by hand (the tag check runs without node_modules); every value is a safe plain scalar (versions, plain file
  // names, base64, sizes), the date is quoted like electron-builder writes it.
  const plain = (value) => {
    const text = String(value);
    if (!/^[A-Za-z0-9+/=._-]+$/.test(text)) throw new Error(`not a manifest value: ${text}`);
    return text;
  };
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(releaseDate)) throw new Error(`not an ISO date: ${releaseDate}`);
  const [first] = files;
  const out = [`version: ${plain(version)}`, 'files:'];
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`${file.url}: no size`);
    out.push(`  - url: ${plain(file.url)}`, `    sha512: ${plain(file.sha512)}`, `    size: ${file.size}`);
  }
  out.push(`path: ${plain(first.url)}`, `sha512: ${plain(first.sha512)}`, `releaseDate: '${releaseDate}'`);
  return `${out.join('\n')}\n`;
}

export function assetUrl(repository, version, name) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`not a repository: ${repository}`);
  return `https://github.com/${repository}/releases/download/v${version}/${name}`;
}

/**
 * latest.json in tauri-plugin-updater's format. Windows points at the signed setup exe (the update window runs it), macOS at
 * the signed .app.tar.gz; each platform is listed under its plain key and the bundle-specific one the plugin tries first.
 */
export function tauriManifest({ version, notes, pubDate, repository, signatures }) {
  const platforms = {};
  for (const platform of PLATFORMS) {
    const { updater } = platformAssets(platform, version);
    const signature = signatures[updater];
    if (!signature) throw new Error(`no signature for ${updater}`);
    for (const key of platform.feedKeys) platforms[key] = { signature, url: assetUrl(repository, version, updater) };
  }
  return `${JSON.stringify({ version, notes, pub_date: pubDate, platforms }, null, 2)}\n`;
}

// ── minisign (the format `tauri signer sign` writes) ────────────────────────────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeBase64Text(text, what) {
  const value = String(text).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${what}: not base64`);
  return Buffer.from(value, 'base64').toString('utf8');
}

function lines(text) {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** A public key as Tauri stores it: base64 of the two-line minisign `.pub` file. Returns the key id (hex, as minisign prints it). */
export function parsePublicKey(base64) {
  const [, keyLine] = lines(decodeBase64Text(base64, 'public key'));
  const raw = Buffer.from((keyLine ?? '').trim(), 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('public key: not a minisign Ed25519 key');
  const keyId = raw.subarray(2, 10);
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]), format: 'der', type: 'spki' });
  return { keyId: Buffer.from(keyId).reverse().toString('hex').toUpperCase(), keyIdBytes: keyId, key };
}

/** A `.sig` file of `tauri signer sign`: base64 of the four-line minisign signature file. */
export function parseSignature(base64) {
  const text = lines(decodeBase64Text(base64, 'signature'));
  const raw = Buffer.from((text[1] ?? '').trim(), 'base64');
  if (raw.length !== 74) throw new Error('signature: not a minisign signature');
  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (algorithm !== 'Ed' && algorithm !== 'ED') throw new Error(`signature: unknown algorithm ${algorithm}`);
  const prefix = 'trusted comment: ';
  if (!text[2]?.startsWith(prefix)) throw new Error('signature: no trusted comment');
  const globalSignature = Buffer.from((text[3] ?? '').trim(), 'base64');
  if (globalSignature.length !== 64) throw new Error('signature: no global signature');
  return { algorithm, keyIdBytes: raw.subarray(2, 10), signature: raw.subarray(10), trustedComment: text[2].slice(prefix.length), globalSignature };
}

/**
 * minisign's verification: the key ids match, the Ed25519 signature covers the data (BLAKE2b-512 of it for the prehashed `ED`
 * form `tauri signer` writes, the data itself for the legacy `Ed`), and the global signature covers signature + trusted
 * comment. Throws with the reason; returns the trusted comment.
 */
export function verifyMinisign(data, signatureBase64, publicKeyBase64) {
  const key = parsePublicKey(publicKeyBase64);
  const sig = parseSignature(signatureBase64);
  if (!key.keyIdBytes.equals(sig.keyIdBytes)) throw new Error(`signature: made with key ${Buffer.from(sig.keyIdBytes).reverse().toString('hex').toUpperCase()}, not ${key.keyId}`);
  const message = sig.algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verifySignature(null, message, key.key, sig.signature)) throw new Error('signature: does not match the file');
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  if (!verifySignature(null, global, key.key, sig.globalSignature)) throw new Error('signature: the trusted comment was altered');
  return sig.trustedComment;
}

/** The updater public key the app embeds (UPDATER_PUBLIC_KEY in unimux-update). */
export function embeddedPublicKey(source = readFileSync(rootPath(PUBLIC_KEY_SOURCE), 'utf8')) {
  const match = /pub const UPDATER_PUBLIC_KEY: &str = "([A-Za-z0-9+/=]+)";/.exec(source);
  if (!match) throw new Error(`UPDATER_PUBLIC_KEY not found in ${PUBLIC_KEY_SOURCE}`);
  return match[1];
}

// ── version files ───────────────────────────────────────────────────────────────────────────────────────────────────

/** `version` of `[workspace.package]` in src-tauri/Cargo.toml (every crate inherits it). */
export function cargoWorkspaceVersion(text) {
  const section = /^\[workspace\.package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
  const version = section && /^version\s*=\s*"([^"]+)"/m.exec(section[1]);
  if (!version) throw new Error(`${CARGO_TOML}: no [workspace.package] version`);
  return version[1];
}

export function setCargoWorkspaceVersion(text, version) {
  cargoWorkspaceVersion(text);
  return text.replace(/^(\[workspace\.package\]\s*$[\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
}

export function tauriConfVersion(text) {
  const version = JSON.parse(text).version;
  if (typeof version !== 'string') throw new Error(`${TAURI_CONF}: no version`);
  return version;
}

/** Only the top-level "version" line changes (the file keeps its layout). */
export function setTauriConfVersion(text, version) {
  tauriConfVersion(text);
  const next = text.replace(/^(\s{2}"version":\s*")[^"]+(")/m, `$1${version}$2`);
  if (tauriConfVersion(next) !== version) throw new Error(`${TAURI_CONF}: the version line was not found`);
  return next;
}

/** The names of the workspace crates (their Cargo.lock entries carry the workspace version). */
export function workspaceCrateNames(cratesDir = rootPath('src-tauri', 'crates')) {
  return readdirSync(cratesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(cratesDir, entry.name, 'Cargo.toml')))
    .map((entry) => {
      const toml = readFileSync(join(cratesDir, entry.name, 'Cargo.toml'), 'utf8');
      const name = /^\[package\]\s*$[\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(toml);
      if (!name) throw new Error(`no package name in crates/${entry.name}/Cargo.toml`);
      return name[1];
    })
    .sort();
}

/** The version of each workspace crate in Cargo.lock (path packages have no `source` line). */
export function cargoLockVersions(text, names) {
  const versions = {};
  for (const block of text.replace(/\r\n/g, '\n').split('\n[[package]]\n').slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    if (!names.includes(name) || /^source = /m.test(block)) continue;
    versions[name] = /^version = "([^"]+)"$/m.exec(block)?.[1];
  }
  return versions;
}

export function setCargoLockVersions(text, names, version) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parts = text.replace(/\r\n/g, '\n').split('\n[[package]]\n');
  const next = parts.map((block, i) => {
    if (i === 0) return block;
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    if (!names.includes(name) || /^source = /m.test(block)) return block;
    return block.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  });
  return next.join('\n[[package]]\n').replace(/\n/g, eol);
}

/** All version sources of the checkout (or of `read(file)`, for example `git show <tag>:<file>`). */
export function readVersions(read = (file) => readFileSync(rootPath(file), 'utf8'), names = workspaceCrateNames()) {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  return {
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json (root package)': lock.packages?.['']?.version,
    [CARGO_TOML]: cargoWorkspaceVersion(read(CARGO_TOML)),
    [TAURI_CONF]: tauriConfVersion(read(TAURI_CONF)),
    ...Object.fromEntries(Object.entries(cargoLockVersions(read(CARGO_LOCK), names)).map(([name, v]) => [`${CARGO_LOCK} ${name}`, v])),
  };
}

/** The version files that disagree with `version` (empty when all agree). */
export function versionMismatches(versions, version) {
  return Object.entries(versions).filter(([, v]) => v !== version).map(([file, v]) => `${file} is ${v ?? '(none)'}`);
}
