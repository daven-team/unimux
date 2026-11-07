import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-expect-error plain ESM script without type declarations
import { bundleProblems, feedEntry, legacyZipName } from '../scripts/mac-legacy-zip.mjs';
import { selectMacAsset } from '../src/main/macUpdate/feed';

describe('mac-legacy-zip (U3): the zip 1.1.4 Macs update into 1.2.0 through', () => {
  it('names the zip so the 1.1.4 feed reader selects it', () => {
    for (const arch of ['arm64', 'x64'] as const) {
      const name = legacyZipName('1.2.0', arch);
      expect(name).toBe(`unimux-1.2.0-mac-${arch}.zip`);
      const feed = { version: '1.2.0', files: [{ name, sha512: 'x', size: 1 }] };
      expect(selectMacAsset(feed, arch)?.name).toBe(name);
    }
    expect(() => legacyZipName('1.2', 'arm64')).toThrow();
    expect(() => legacyZipName('1.2.0', 'universal')).toThrow();
  });

  it('applies the Info.plist rules of the 1.1.4 verifyBundle', () => {
    const good = { CFBundleShortVersionString: '1.2.0', CFBundleIdentifier: 'com.ajzakomator.app', CFBundleExecutable: 'unimux' };
    expect(bundleProblems(good, '1.2.0')).toEqual([]);
    expect(bundleProblems({ ...good, CFBundleIdentifier: 'com.unimux.app' }, '1.2.0')).toHaveLength(1);
    expect(bundleProblems({ ...good, CFBundleShortVersionString: '1.1.4' }, '1.2.0')).toHaveLength(1);
    expect(bundleProblems({ ...good, CFBundleExecutable: '../unimux' }, '1.2.0')).toEqual(['no valid CFBundleExecutable']);
    expect(bundleProblems({}, '1.2.0')).toHaveLength(3);
  });

  it('writes the latest-mac.yml entry in the electron-builder format', () => {
    const bytes = Buffer.from('zip bytes');
    expect(feedEntry('unimux-1.2.0-mac-arm64.zip', bytes)).toEqual({
      url: 'unimux-1.2.0-mac-arm64.zip',
      sha512: createHash('sha512').update(bytes).digest('base64'),
      size: bytes.length,
    });
  });
});
