import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dump, load } from 'js-yaml';

const [root, version] = process.argv.slice(2);
assert.ok(root, 'Provide the CI artifact directory');
assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
const output = join(root, 'publish');
mkdirSync(output, { recursive: true });
const macFiles = [];
let preferredMac;
for (const platform of ['windows-x64', 'macos-x64', 'macos-arm64']) {
  const directory = join(root, `unimux-${platform}`);
  const manifestName = platform.startsWith('macos') ? 'latest-mac.yml' : 'latest.yml';
  const manifest = load(readFileSync(join(directory, manifestName), 'utf8'));
  assert.equal(manifest.version, version);
  for (const file of manifest.files) {
    assert.equal(file.url, basename(file.url));
    assert.ok(file.url.includes(version), 'Manifest must reference this release');
    const data = readFileSync(join(directory, file.url));
    assert.equal(data.length, file.size, `${file.url} size`);
    assert.equal(createHash('sha512').update(data).digest('base64'), file.sha512, `${file.url} hash`);
  }
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.yml')) copyFileSync(join(directory, file), join(output, file));
  }
  if (platform === 'windows-x64') copyFileSync(join(directory, manifestName), join(output, manifestName));
  else {
    macFiles.push(...manifest.files);
    preferredMac ??= manifest;
  }
}
assert.equal(new Set(macFiles.map(file => file.url)).size, macFiles.length);
writeFileSync(join(output, 'latest-mac.yml'), dump({ ...preferredMac, files: macFiles }));
const expected = [
  `unimux-Setup-${version}.exe`,
  `unimux-Setup-${version}.exe.blockmap`,
  `unimux-${version}-mac-arm64.dmg`,
  `unimux-${version}-mac-arm64.zip`,
  `unimux-${version}-mac-x64.dmg`,
  `unimux-${version}-mac-x64.zip`,
  'latest.yml',
  'latest-mac.yml',
].sort();
assert.deepEqual(readdirSync(output).filter(file => file !== 'SHA256SUMS.txt').sort(), expected);
const sums = expected.map(file => `${createHash('sha256').update(readFileSync(join(output, file))).digest('hex')}  ${file}`);
writeFileSync(join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`Verified ${expected.length} assets; update manifests match package hashes and sizes.`);
console.log(sums.join('\n'));
