// test/ssh-packaging.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const EXCLUDED = [
  '!**/node_modules/cpu-features/**',
  '!**/node_modules/nan/**',
  '!**/node_modules/ssh2/lib/protocol/crypto/build/**',
  '!**/node_modules/ssh2/lib/protocol/crypto/src/**',
  '!**/node_modules/ssh2/lib/protocol/crypto/binding.gyp',
  '!**/node_modules/ssh2/install.js',
  '!**/node_modules/ssh2/test/**',
  '!**/node_modules/ssh2/examples/**',
  // util/ only holds the Pageant helper (pagent.exe, unused: agent auth is a non-goal); its presence makes
  // electron-builder unpack the whole ssh2 package out of the asar.
  '!**/node_modules/ssh2/util/**',
];

describe('ssh2 packaging', () => {
  it('ships ssh2 as an exactly pinned production dependency and its types as a dev dependency', () => {
    expect(pkg.dependencies.ssh2).toBe('1.17.0');
    expect(pkg.devDependencies['@types/ssh2']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['@types/ssh2']).toBeUndefined();
  });

  it('ships the Postgres driver exactly pinned as production dependencies and the test servers as dev dependencies (1.0.0)', () => {
    expect(pkg.dependencies.pg).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['pg-cursor']).toMatch(/^\d+\.\d+\.\d+$/);
    for (const dev of ['@electric-sql/pglite', '@electric-sql/pglite-socket', '@types/pg', '@types/pg-cursor']) {
      expect(pkg.devDependencies[dev], dev).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg.dependencies[dev], dev).toBeUndefined();
    }
  });

  it('ships the Redis driver exactly pinned as a production dependency (1.0.0)', () => {
    expect(pkg.dependencies.ioredis).toBe('6.0.0');
    expect(pkg.devDependencies.ioredis).toBeUndefined();
  });

  it('keeps the optional native parts of ssh2 out of every file list', () => {
    for (const list of [pkg.build.files, pkg.build.win.files, pkg.build.mac.files]) for (const rule of EXCLUDED) expect(list, rule).toContain(rule);
  });

  it('the Windows and macOS file lists are the shared list plus their own node-pty prebuild exclusions', () => {
    // electron-builder picks the app files from the platform list alone, so each one repeats the shared list; this keeps them in step.
    for (const list of [pkg.build.win.files, pkg.build.mac.files]) {
      expect(list.slice(0, pkg.build.files.length)).toEqual(pkg.build.files);
      for (const rule of list.slice(pkg.build.files.length)) expect(rule.startsWith('!**/node_modules/node-pty/prebuilds/'), rule).toBe(true);
    }
  });

  it('has the Electron runtime smoke test script', () => {
    expect(pkg.scripts['test:ssh-electron']).toBe('node scripts/smoke-ssh.mjs');
  });
});
