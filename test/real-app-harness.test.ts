// PLAN X1: the real-app harness. Every contract channel has a package that implements it (so a not-yet call names its
// blocker), every owner is a package of PLAN.md, and the migrated scripts no longer load Electron or its main inspector.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { BRIDGE_OP_OWNERS, blockedBy, formatBlocked, ownerOf } from '../scripts/real-app-owners.mjs';
// @ts-expect-error plain ESM script without type declarations
import { SCRIPTS } from '../scripts/real-app-run.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(root, 'src-tauri', 'gen', 'ipc-contract.json'), 'utf8'));
const plan = readFileSync(join(root, 'docs', 'tauri', 'PLAN.md'), 'utf8');
const packages = new Set([...plan.matchAll(/^\| ([A-Z]+\d+) \|/gm)].map((m) => m[1]));
const read = (file: string) => readFileSync(join(root, 'scripts', file), 'utf8');

describe('real-app owners', () => {
  it('names a PLAN package for every channel of the contract, every port and every harness op', () => {
    const channels = Object.keys(contract.channels);
    expect(channels.length).toBeGreaterThan(200);
    const missing = channels.filter((c) => !ownerOf(c));
    expect(missing).toEqual([]);
    const owners = new Set([...channels.map(ownerOf), ...['port:pty', 'port:sftp', 'port:db', 'update-splash:init'].map(ownerOf), ...Object.values(BRIDGE_OP_OWNERS)]);
    expect([...owners].filter((o) => !packages.has(o as string))).toEqual([]);
  });

  it('groups not-yet commands by package in PLAN order', () => {
    const groups = blockedBy(['notify', 'cell:spawn', 'attention:flash', 'port:pty', 'something:else']);
    expect(groups).toEqual([
      { owner: 'P2', commands: ['port:pty'] },
      { owner: 'P4', commands: ['cell:spawn'] },
      { owner: 'unowned', commands: ['something:else'] },
      { owner: 'W4', commands: ['notify', 'attention:flash'] },
    ]);
    expect(formatBlocked(groups.slice(0, 2))).toBe('P2 (port:pty), P4 (cell:spawn)');
  });

  it('maps the domains the way the packages split them', () => {
    expect(ownerOf('state:edit')).toBe('F9');
    expect(ownerOf('git:status')).toBe('G3');
    expect(ownerOf('git:createWorktree')).toBe('G4');
    expect(ownerOf('ssh:key:generate')).toBe('S2');
    expect(ownerOf('ssh:connect')).toBe('S3');
    expect(ownerOf('sftp:enqueue')).toBe('T3');
    expect(ownerOf('db:connect')).toBe('D1');
    expect(ownerOf('detach:open')).toBe('W5');
  });
});

describe('migrated scripts', () => {
  const scripts = readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.mjs'));

  it('no script imports Electron except the Electron-only SSH smoke (R1 removes it)', () => {
    // A static import loads Electron even on the Tauri target; real-app.mjs resolves it lazily for MC_APP_TARGET=electron.
    const importing = scripts.filter((f) => /^import [^;]* from 'electron';/m.test(read(f)));
    expect(importing).toEqual(['smoke-ssh.mjs']);
  });

  it('no script reaches the Electron main inspector except through the harness (Electron target only)', () => {
    const users = scripts.filter((f) => f !== 'real-app.mjs' && /--inspect=|mainInspector\(/.test(read(f)));
    // The Electron-internal profilers: reference tools that exit on the Tauri target.
    expect(users.sort()).toEqual(['bench-perf.mjs', 'perf-check.mjs', 'perf-renders.mjs']);
    for (const f of users) expect(read(f)).toContain('if (isTauri) {');
  });

  it('runs every verify script (the workspace module through capture-readme --verify) and the X1 list', () => {
    const listed = new Set(SCRIPTS.map((s: { file: string }) => s.file));
    const verify = scripts.filter((f) => f.startsWith('verify-') && f !== 'verify-workspace-ui.mjs');
    expect(verify.filter((f) => !listed.has(f))).toEqual([]);
    for (const f of ['capture-readme.mjs', 'smoke-start.mjs', 'measure-startup.mjs', 'perf-latency.mjs', 'bench-jank.mjs', 'perf-grid.mjs', 'perf-hidden.mjs', 'perf-profile.mjs']) expect(listed.has(f)).toBe(true);
    expect(SCRIPTS.filter((s: { gate?: boolean }) => s.gate).map((s: { file: string }) => s.file)).toEqual(['verify-cli-contract.mjs', 'verify-team-start.mjs']);
  });

  it('release.mjs runs both release gates', () => {
    const release = read('release.mjs');
    expect(release).toContain('verify-cli-contract.mjs');
    expect(release).toContain('verify-team-start.mjs');
  });
});
