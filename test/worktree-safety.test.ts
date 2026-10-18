// Safe worktree removal against a real temporary repository: what would be lost is counted, an unforced removal refuses
// (and removes nothing), a forced one removes the worktree and the unmerged branch.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorktree, currentBranch, inspectWorktree, removeWorktree } from '../src/main/worktree';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let lab: string;
let repo: string;
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const branchExists = (name: string) => { try { sh(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`); return true; } catch { return false; } };

beforeAll(() => {
  lab = realpathSync(mkdtempSync(join(tmpdir(), 'mc-wt-safety-')));
  repo = join(lab, 'proj');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'first');
});
afterAll(() => { rmSync(lab, { recursive: true, force: true }); });

describe('worktree inspection and safe removal', () => {
  it('a fresh worktree is clean: removed without force, its branch deleted with -d', async () => {
    const wt = await createWorktree(repo, 'clean');
    expect(wt.path).toBe(join(lab, 'proj-wt-clean'));
    expect(await currentBranch(wt.path)).toBe('mc/clean');
    expect(await inspectWorktree(repo, wt)).toEqual({ exists: true, dirty: 0, unmerged: 0, base: 'main' });
    expect(await removeWorktree(repo, wt, true)).toEqual({ ok: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(branchExists('mc/clean')).toBe(false);
  });

  it('counts uncommitted (staged, unstaged, untracked) files and commits the project branch lacks; unforced removal refuses and keeps everything', async () => {
    const wt = await createWorktree(repo, 'busy');
    writeFileSync(join(wt.path, 'b.txt'), 'two\n');
    sh(wt.path, 'add', 'b.txt');
    sh(wt.path, 'commit', '-q', '-m', 'unmerged work');
    writeFileSync(join(wt.path, 'a.txt'), 'changed\n'); // unstaged
    writeFileSync(join(wt.path, 'c.txt'), 'staged\n');
    sh(wt.path, 'add', 'c.txt'); // staged
    writeFileSync(join(wt.path, 'd.txt'), 'untracked\n'); // untracked
    writeFileSync(join(wt.path, 'e.txt'), 'untracked\n'); // untracked
    const info = await inspectWorktree(repo, wt);
    expect(info).toEqual({ exists: true, dirty: 4, unmerged: 1, base: 'main' });

    const refused = await removeWorktree(repo, wt, true);
    expect(refused).toMatchObject({ ok: false, code: 'unsafe', inspection: info });
    expect(existsSync(join(wt.path, 'd.txt'))).toBe(true);
    expect(branchExists('mc/busy')).toBe(true);

    // Committed and merged into main: nothing is lost any more.
    sh(wt.path, 'add', '-A');
    sh(wt.path, 'commit', '-q', '-m', 'rest');
    expect(await inspectWorktree(repo, wt)).toMatchObject({ dirty: 0, unmerged: 2 });
    sh(repo, 'merge', '-q', '--ff-only', 'mc/busy');
    expect(await inspectWorktree(repo, wt)).toMatchObject({ dirty: 0, unmerged: 0 });
    expect(await removeWorktree(repo, wt, true)).toEqual({ ok: true });
    expect(branchExists('mc/busy')).toBe(false);
  });

  it('a forced removal (the user confirmed) drops the dirty worktree and the unmerged branch', async () => {
    const wt = await createWorktree(repo, 'lost');
    writeFileSync(join(wt.path, 'x.txt'), 'x\n');
    sh(wt.path, 'add', 'x.txt');
    sh(wt.path, 'commit', '-q', '-m', 'only here');
    writeFileSync(join(wt.path, 'y.txt'), 'y\n');
    expect(await inspectWorktree(repo, wt)).toMatchObject({ dirty: 1, unmerged: 1 });
    expect(await removeWorktree(repo, wt, true, true)).toEqual({ ok: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(branchExists('mc/lost')).toBe(false);
  });

  it('keeping the branch only refuses for uncommitted files; a folder deleted by hand is pruned', async () => {
    const wt = await createWorktree(repo, 'keep');
    sh(wt.path, 'commit', '-q', '--allow-empty', '-m', 'kept commit');
    expect(await removeWorktree(repo, wt, false)).toEqual({ ok: true });
    expect(branchExists('mc/keep')).toBe(true);

    const gone = await createWorktree(repo, 'gone');
    rmSync(gone.path, { recursive: true, force: true });
    expect(await inspectWorktree(repo, gone)).toMatchObject({ exists: false, dirty: 0, unmerged: 0 });
    expect(await removeWorktree(repo, gone, true)).toEqual({ ok: true });
    expect(branchExists('mc/gone')).toBe(false);
    expect(sh(repo, 'worktree', 'list')).not.toContain('proj-wt-gone');
  });
});
