// PLAN X1: the real-app harness. Every contract channel has a package that implements it (so a not-yet call names its
// blocker), every owner is a package of PLAN.md, and the migrated scripts no longer load Electron or its main inspector.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { BRIDGE_OP_OWNERS, SCRIPT_PACKAGES, blockedBy, classifyRun, formatBlocked, ownerOf } from '../scripts/real-app-owners.mjs';
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

describe('run classification', () => {
  // What a bare launch of the check build calls (real-app-baseline.mjs on the X1 build).
  const baseline = ['port:pty', 'cli:status', 'usage:get', 'accounts:swapPending', 'update:get', 'sessions:list', 'app:quitGuard'];
  const owners = (groups: { owner: string }[]) => groups.map((g) => g.owner);

  it('a failure with only boot-time not-yet calls is a failure, not blocked (they are listed as seen)', () => {
    const run = classifyRun({ code: 1, notYet: ['cli:status', 'usage:get', 'update:get'], baseline });
    expect(run.result).toBe('fail');
    expect(run.blocked).toEqual([]);
    expect(owners(run.seen)).toEqual(['A5', 'H3', 'U1']);
  });

  it('a failure is blocked by the not-yet commands the script exercised beyond the boot', () => {
    const run = classifyRun({ code: 1, notYet: ['cli:status', 'cell:spawn', 'usage:get', 'notify'], baseline });
    expect(run.result).toBe('blocked');
    expect(run.blocked).toEqual([{ owner: 'P4', commands: ['cell:spawn'] }, { owner: 'W4', commands: ['notify'] }]);
  });

  it('a boot-time command of a package the script tests blocks it', () => {
    const run = classifyRun({ code: 1, notYet: ['cli:status', 'usage:get'], baseline, packages: ['A5'] });
    expect(run.result).toBe('blocked');
    expect(run.blocked).toEqual([{ owner: 'A5', commands: ['usage:get'] }]);
  });

  it('a missing test-bridge op always blocks; a timeout (code null) is judged like a failure', () => {
    expect(classifyRun({ code: 1, notYet: [], baseline, bridge: [{ owner: 'W4', commands: ['test-bridge toasts'] }] }).result).toBe('blocked');
    expect(classifyRun({ code: null, notYet: ['cli:status'], baseline }).result).toBe('fail');
    expect(classifyRun({ code: null, notYet: ['cli:status', 'conv:search'], baseline }).result).toBe('blocked');
  });

  it('without a baseline a failure stays a failure; a pass passes unless it is a measurement with not-yet calls', () => {
    expect(classifyRun({ code: 1, notYet: ['cell:spawn'], baseline: null }).result).toBe('fail');
    expect(classifyRun({ code: 0, notYet: ['cli:status'], baseline: null }).result).toBe('pass');
    expect(classifyRun({ code: 0, strict: true, notYet: ['cli:status'], baseline: null }).result).toBe('blocked');
  });

  it('SCRIPT_PACKAGES names scripts of the sweep and packages of PLAN.md', () => {
    const listed = new Set(SCRIPTS.map((s: { file: string }) => s.file));
    for (const [file, list] of Object.entries(SCRIPT_PACKAGES as Record<string, string[]>)) {
      expect(listed.has(file), file).toBe(true);
      expect(list.filter((p) => !packages.has(p)), file).toEqual([]);
    }
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

  it('release.mjs builds the check flavour of this commit, then runs both release gates on it', () => {
    const release = read('release.mjs');
    expect(release).toContain('verify-cli-contract.mjs');
    expect(release).toContain('verify-team-start.mjs');
    const build = release.indexOf("run(NPM, ['run', 'build:check']");
    expect(build).toBeGreaterThan(0);
    expect(build).toBeLessThan(release.indexOf('for (const gate of GATES)'));
    expect(release).toContain("MC_APP_TARGET: 'tauri'");
    expect(release).toContain('delete gateEnv.MC_APP_BINARY');
  });
});
