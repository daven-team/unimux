// Folder spellings: the Git module compares every root through one canonical form (short 8.3 names, links, letter case, slashes).
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Git } from '../src/main/git';
import { handleGit } from '../src/main/gitHandler';
import { canonicalPath, isInsidePath, normalizeSpelling, relativeInside, samePath, type PathOps } from '../src/main/gitPaths';
import type { GitStatus, GitTrustInfo, GitWorktree } from '../src/shared/git';

// Real git processes: slow under a busy machine or CI runner, so these tests get more time than the 20 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const windows = process.platform === 'win32';

/** A fake file system where the 8.3 spelling of the runner's folders resolves to the long one (what GitHub's Windows runner does). */
const fakeWindows: PathOps = {
  platform: 'win32',
  realpath(path: string): string {
    const slashed = path.replace(/\//g, '\\');
    const known = ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp'];
    const long = slashed.replace(/RUNNER~1/i, 'runneradmin');
    // only folders below the temp folder exist; everything else is "missing"
    if (!long.toLowerCase().startsWith(known[1].toLowerCase()) || long.toLowerCase().includes('missing')) throw new Error('ENOENT');
    return long.replace(/\\temp/i, '\\Temp').replace(/\\appdata/i, '\\AppData').replace(/\\local/i, '\\Local');
  },
};
const fakePosix: PathOps = { platform: 'linux', realpath: (path) => { if (path.includes('missing')) throw new Error('ENOENT'); return path.replace('/link/', '/real/'); } };

describe('canonical folder spelling (fake spellings)', () => {
  it('treats the short and the long spelling, other letter case and slashes as one folder', () => {
    const long = 'c:/users/runneradmin/appdata/local/temp/mc-git-abc/project';
    for (const spelling of [
      'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\mc-git-abc\\project', 'c:\\users\\runner~1\\appdata\\local\\temp\\mc-git-abc\\project',
      'C:/Users/runneradmin/AppData/Local/Temp/MC-GIT-ABC/Project/', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\mc-git-abc\\\\project',
    ]) {
      // the temp folder itself exists in the fake; mc-git-abc/project do not, so they resolve through the nearest existing parent
      expect(canonicalPath(spelling, fakeWindows), spelling).toBe(long);
      expect(samePath(spelling, long, fakeWindows), spelling).toBe(true);
    }
    expect(samePath('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\a', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\b', fakeWindows)).toBe(false);
  });

  it('decides "inside the project" on canonical paths', () => {
    const project = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj';
    expect(isInsidePath(project, 'C:/Users/runneradmin/AppData/Local/Temp/proj', fakeWindows)).toBe(true);
    expect(isInsidePath(project, 'c:/users/runneradmin/appdata/local/temp/PROJ/sub/dir', fakeWindows)).toBe(true);
    expect(isInsidePath(project, 'C:/Users/runneradmin/AppData/Local/Temp/proj2', fakeWindows)).toBe(false);
    expect(isInsidePath(project, 'C:/Users/runneradmin/AppData/Local/Temp', fakeWindows)).toBe(false);
    expect(isInsidePath('C:\\', 'C:\\Users', fakeWindows)).toBe(true);
  });

  it('keeps the real case of the part below the parent', () => {
    expect(relativeInside('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\p', 'C:/Users/runneradmin/AppData/Local/Temp/P/Packages/App', fakeWindows)).toBe('Packages/App');
    expect(relativeInside('C:/Users/runneradmin/AppData/Local/Temp/p', 'C:/Users/runneradmin/AppData/Local/Temp/p', fakeWindows)).toBe('');
    expect(relativeInside('C:/Users/runneradmin/AppData/Local/Temp/p', 'C:/Users/runneradmin/AppData/Local/Temp/q', fakeWindows)).toBeNull();
  });

  it('is case sensitive and link aware off Windows, and falls back to the lexical path', () => {
    expect(canonicalPath('/home/me/link/app', fakePosix)).toBe('/home/me/real/app');
    expect(samePath('/home/me/Repo', '/home/me/repo', fakePosix)).toBe(false);
    expect(canonicalPath('/home/me/missing/dir', fakePosix)).toBe('/home/me/missing/dir');
    expect(isInsidePath('/', '/home', fakePosix)).toBe(true);
    expect(normalizeSpelling('\\\\?\\C:\\A\\B\\', 'win32')).toBe('c:/a/b');
    expect(canonicalPath('Z:\\nowhere\\x', fakeWindows)).toBe('z:/nowhere/x');
  });
});

// ---------- the module against real short and differently cased spellings ----------

let lab = '';
let env: NodeJS.ProcessEnv;
let git: Git;
let counter = 0;
const id = () => `req-${String(++counter).padStart(6, '0')}-path`;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
const data = <T>(result: { ok: boolean }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return (result as unknown as { data: T }).data;
};
const call = (project: string, channel: string, request: unknown = {}, extra: string[] = []) => handleGit(git, project, channel, request, windows, extra);

/** The 8.3 spelling of an existing folder, or null when the volume has no short names. */
function shortSpelling(path: string): string | null {
  if (!windows) return null;
  try {
    const out = (spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', '"for %I in ("%MC_SHORT_SOURCE%") do @echo %~sI"'], {
      encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, MC_SHORT_SOURCE: path },
    }).stdout ?? '').trim();
    return out && out.toLowerCase() !== path.toLowerCase() && existsSync(out) ? out : null;
  } catch { return null; }
}

function project(name: string, withCommit = true): string {
  const dir = join(lab, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main', '.');
  if (withCommit) {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'one');
  }
  return dir;
}

beforeAll(() => {
  lab = realpathSync.native(mkdtempSync(join(tmpdir(), 'mc-spelling-test-')));
  const globalConfig = join(lab, 'global.gitconfig');
  writeFileSync(globalConfig, '[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n');
  env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  git = new Git({ env });
});

afterAll(() => {
  if (!lab.includes('mc-spelling-test-')) throw new Error('unsafe cleanup target');
  rmSync(lab, { recursive: true, force: true });
});

describe.skipIf(!windows)('a project reached through a short (8.3) path', () => {
  it('is the repository itself, not a parent repository, and can be written to', async () => {
    const dir = project('A Long Project Name');
    const short = shortSpelling(dir);
    if (!short) return; // 8.3 names are disabled on this volume
    expect(short.toLowerCase()).not.toBe(dir.toLowerCase());
    const status = data<GitStatus>(await call(short, 'status'));
    expect(status.parent).toBe(false);
    expect(status.projectRelation).toEqual({ kind: 'inside-root', prefix: '' });
    expect(data<GitTrustInfo>(await call(short, 'trust')).parent).toBe(false);
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    data(await call(short, 'stage', { requestId: id(), paths: ['b.txt'] }));
    data(await call(short, 'commit', { requestId: id(), message: 'through the short name' }));
    expect(sh(dir, 'log', '-1', '--format=%s').trim()).toBe('through the short name');
  });

  it('knows the worktrees by canonical path (allowed, the project itself, the preferred one)', async () => {
    const dir = project('Another Long Project');
    const short = shortSpelling(dir);
    if (!short) return;
    const wt = `${dir}-wt-feature one`;
    sh(dir, 'worktree', 'add', '-q', '-b', 'mc/feature', wt);
    const shortWt = shortSpelling(wt);
    const list = data<GitWorktree[]>(await git.worktrees(short, short, [], shortWt ?? wt));
    expect(list).toHaveLength(2);
    expect(list.map((w) => `${w.branch}:${w.allowed}:${w.isProject}:${w.preferred}`).sort()).toEqual(['main:true:true:false', 'mc/feature:true:false:true']);
    // the short spelling of the worktree is accepted for a request, and the status of the worktree is its own
    expect((await git.resolveDir(short, shortWt ?? wt)).ok).toBe(true);
    const status = data<GitStatus>(await call(short, 'status', { worktree: shortWt ?? wt }));
    expect(status.branch).toBe('mc/feature');
    expect(status.parent).toBe(false);
    // a worktree a cell uses may sit anywhere, and is matched in its short spelling too
    const elsewhere = join(lab, 'Some Elsewhere Checkout');
    sh(dir, 'worktree', 'add', '-q', '-b', 'mc/elsewhere', elsewhere);
    const shortElsewhere = shortSpelling(elsewhere) ?? elsewhere;
    expect((await git.resolveDir(short, elsewhere)).ok).toBe(false);
    expect((await git.resolveDir(short, elsewhere, [shortElsewhere])).ok).toBe(true);
  });

  it('is still a parent repository when the project is a subfolder, with the prefix worked out on real paths', async () => {
    const dir = project('Yet Another Long Repository');
    mkdirSync(join(dir, 'Packages', 'Application Name'), { recursive: true });
    const short = shortSpelling(join(dir, 'Packages', 'Application Name'));
    if (!short) return;
    const status = data<GitStatus>(await call(short, 'status'));
    expect(status.parent).toBe(true);
    expect(status.projectRelation).toEqual({ kind: 'inside-root', prefix: 'Packages/Application Name' });
    expect(await call(short, 'stage', { requestId: id(), paths: [], all: true })).toMatchObject({ ok: false, code: 'parent' });
  });

  it('keeps one trust entry and one write lock for every spelling of a folder', async () => {
    const dir = project('Trusted Long Project');
    const short = shortSpelling(dir);
    if (!short) return;
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const trustFile = join(lab, 'trust', 'git-trust.json');
    const first = new Git({ env, trustFile });
    expect(data<GitTrustInfo>(await handleGit(first, short, 'trust', {}, true)).state).toBe('untrusted');
    data(await handleGit(first, short, 'trustGrant', { requestId: id() }, true));
    const second = new Git({ env, trustFile });
    for (const spelling of [dir, short, dir.toUpperCase(), dir.toLowerCase(), dir.replace(/\\/g, '/')]) {
      expect(data<GitTrustInfo>(await handleGit(second, spelling, 'trust', {}, true)).state, spelling).toBe('trusted');
    }
    // Writers named by different spellings of the same repository share one lock. The lock is held here (taken only after a
    // few git reads, two real writers started together may as well run one after the other on a busy machine).
    writeFileSync(join(dir, 'x.txt'), 'x');
    writeFileSync(join(dir, 'y.txt'), 'y');
    const busy = (second as unknown as { busy: Set<string> }).busy;
    const key = canonicalPath(join(dir, '.git'));
    busy.add(key);
    expect(await second.stage(short, { requestId: id(), paths: ['x.txt'] })).toMatchObject({ ok: false, code: 'busy' });
    busy.delete(key);
    expect((await second.stage(short, { requestId: id(), paths: ['x.txt'] })).ok).toBe(true);
    expect((await second.stage(dir, { requestId: id(), paths: ['y.txt'] })).ok).toBe(true);
  });

  it('still refuses 8.3 aliases and links inside a repository path', async () => {
    const dir = project('Confined Long Project');
    const short = shortSpelling(dir);
    if (!short) return;
    for (const path of ['GIT~1/config', 'git~1/config', '.git/config']) {
      expect((await git.diff(short, { source: 'untracked', path })).ok, path).toBe(false);
    }
    const outside = join(lab, 'outside folder with secrets');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET\n');
    symlinkSync(outside, join(dir, 'link'), 'junction');
    const result = await git.diff(short, { source: 'untracked', path: 'link/secret.txt' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('TOP-SECRET');
  });
});

describe.skipIf(!windows)('a project reached with other letter case', () => {
  it('behaves like the same folder', async () => {
    const dir = project('Cased Project Folder');
    const odd = dir.replace(/Cased Project/i, 'CASED project').replace(/^(\w):/, (m) => m.toLowerCase());
    expect(odd).not.toBe(dir);
    const status = data<GitStatus>(await call(odd, 'status'));
    expect(status.parent).toBe(false);
    expect(status.projectRelation).toEqual({ kind: 'inside-root', prefix: '' });
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    data(await call(odd, 'stage', { requestId: id(), paths: ['c.txt'] }));
    const list = data<GitWorktree[]>(await git.worktrees(odd, odd));
    expect(list.map((w) => `${w.allowed}:${w.isProject}`)).toEqual(['true:true']);
  });
});

describe('the canonical path with real folders', () => {
  it('resolves a link and the lexical fallback of a missing folder', () => {
    const real = join(lab, 'real-target');
    mkdirSync(real);
    const link = join(lab, 'a-link');
    try { symlinkSync(real, link, 'junction'); } catch { return; } // links not allowed here
    expect(samePath(link, real)).toBe(true);
    expect(isInsidePath(real, join(link, 'sub', 'missing'))).toBe(true);
    expect(canonicalPath(join(lab, 'nope', 'deeper'))).toBe(normalizeSpelling(join(real, '..', 'nope', 'deeper')));
  });
});
