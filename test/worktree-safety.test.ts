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
    expect(await inspectWorktree(repo, wt)).toMatchObject({ exists: true, dirty: 0, unmerged: 0, detached: 0, base: 'main' });
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
    expect(info).toMatchObject({ exists: true, dirty: 4, unmerged: 1, detached: 0, base: 'main' });

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
    const confirmed = await inspectWorktree(repo, wt);
    expect(confirmed).toMatchObject({ dirty: 1, unmerged: 1 });
    expect(await removeWorktree(repo, wt, true, confirmed)).toEqual({ ok: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(branchExists('mc/lost')).toBe(false);
  });

  it('work that grew after the confirmation (a new file, a new commit) refuses the forced removal with the new numbers', async () => {
    const wt = await createWorktree(repo, 'grow');
    writeFileSync(join(wt.path, 'one.txt'), '1\n');
    const confirmed = await inspectWorktree(repo, wt);
    expect(confirmed).toMatchObject({ dirty: 1, unmerged: 0 });
    writeFileSync(join(wt.path, 'two.txt'), '2\n'); // the agent kept writing while the dialog was open
    const more = await removeWorktree(repo, wt, true, confirmed);
    expect(more).toMatchObject({ ok: false, code: 'unsafe', inspection: { dirty: 2, unmerged: 0 } });
    expect(existsSync(join(wt.path, 'two.txt'))).toBe(true);

    // Same counts but a new commit: the branch tip moved, so it asks again too.
    const second = (more as { inspection: Awaited<ReturnType<typeof inspectWorktree>> }).inspection;
    sh(wt.path, 'add', 'one.txt');
    sh(wt.path, 'commit', '-q', '-m', 'agent commit');
    writeFileSync(join(wt.path, 'three.txt'), '3\n');
    const moved = await removeWorktree(repo, wt, true, second);
    expect(moved).toMatchObject({ ok: false, code: 'unsafe', inspection: { dirty: 2, unmerged: 1 } });
    expect(branchExists('mc/grow')).toBe(true);

    // Accepting exactly what is there now removes it.
    const accepted = (moved as { inspection: Awaited<ReturnType<typeof inspectWorktree>> }).inspection;
    expect(await removeWorktree(repo, wt, true, accepted)).toEqual({ ok: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(branchExists('mc/grow')).toBe(false);
  });

  it('commits on a detached HEAD (on no branch) count as lost work; the unforced removal refuses', async () => {
    const wt = await createWorktree(repo, 'detached');
    sh(wt.path, 'checkout', '-q', '--detach');
    writeFileSync(join(wt.path, 'det.txt'), 'detached\n');
    sh(wt.path, 'add', 'det.txt');
    sh(wt.path, 'commit', '-q', '-m', 'on no branch');
    const lostHead = sh(wt.path, 'rev-parse', 'HEAD').trim();
    const info = await inspectWorktree(repo, wt);
    expect(info).toMatchObject({ dirty: 0, unmerged: 0, detached: 1, head: lostHead });
    expect(await removeWorktree(repo, wt, true)).toMatchObject({ ok: false, code: 'unsafe', inspection: { detached: 1 } });
    expect(existsSync(wt.path)).toBe(true);
    expect(await removeWorktree(repo, wt, true, info)).toEqual({ ok: true });
    expect(existsSync(wt.path)).toBe(false);
  });

  it('never deletes a branch unimux did not create: an adopted worktree or a branch outside mc/', async () => {
    const adopted = join(lab, 'proj-wt-feature');
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature-x', adopted, 'HEAD');
    sh(adopted, 'commit', '-q', '--allow-empty', '-m', 'user work');
    // Its commit is on feature-x, which stays: nothing is lost, so no confirmation is needed.
    expect(await removeWorktree(repo, { path: adopted, branch: 'feature-x', adopted: true }, true)).toEqual({ ok: true });
    expect(existsSync(adopted)).toBe(false);
    expect(branchExists('feature-x')).toBe(true);

    const cell = await createWorktree(repo, 'joined');
    expect(await removeWorktree(repo, { ...cell, adopted: true }, true)).toEqual({ ok: true });
    expect(branchExists('mc/joined')).toBe(true);
    const plain = join(lab, 'proj-wt-plain');
    sh(repo, 'worktree', 'add', '-q', '-b', 'plain', plain, 'HEAD');
    expect(await removeWorktree(repo, { path: plain, branch: 'plain' }, true)).toEqual({ ok: true });
    expect(branchExists('plain')).toBe(true);
  });

  it('keeping the branch only refuses for uncommitted files; a folder deleted by hand drops only its own registration', async () => {
    const wt = await createWorktree(repo, 'keep');
    sh(wt.path, 'commit', '-q', '--allow-empty', '-m', 'kept commit');
    expect(await removeWorktree(repo, wt, false)).toEqual({ ok: true });
    expect(branchExists('mc/keep')).toBe(true);

    const gone = await createWorktree(repo, 'gone');
    const other = await createWorktree(repo, 'unplugged'); // a folder only temporarily away (a network drive)
    rmSync(gone.path, { recursive: true, force: true });
    rmSync(other.path, { recursive: true, force: true });
    expect(await inspectWorktree(repo, gone)).toMatchObject({ exists: false, dirty: 0, unmerged: 0, detached: 0 });
    expect(await removeWorktree(repo, gone, true)).toEqual({ ok: true });
    expect(branchExists('mc/gone')).toBe(false);
    const list = sh(repo, 'worktree', 'list');
    expect(list).not.toContain('proj-wt-gone');
    expect(list).toContain('proj-wt-unplugged');
  });
});
