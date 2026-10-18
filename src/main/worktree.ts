// git worktrees for cells that should work in isolation from the rest of the grid.
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { promisify } from 'util';
import type { Worktree, WorktreeInspection, WorktreeRemoveResult } from '../shared/types';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run('git', args, { cwd, windowsHide: true });

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const { stdout } = await git(path, 'rev-parse', '--is-inside-work-tree');
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cell';

/** Creates `<parent>\<repo>-wt-<name>` on new branch `mc/<name>` from HEAD (suffixing on collisions). */
export async function createWorktree(projectPath: string, name: string): Promise<Worktree> {
  const base = basename(projectPath);
  const root = slug(name);
  for (let i = 1; i < 100; i++) {
    const n = i === 1 ? root : `${root}-${i}`;
    const path = join(dirname(projectPath), `${base}-wt-${n}`);
    const branch = `mc/${n}`;
    if (existsSync(path) || (await branchExists(projectPath, branch))) continue;
    await git(projectPath, 'worktree', 'add', '-b', branch, path, 'HEAD');
    return { path, branch };
  }
  throw new Error('Nie udało się znaleźć wolnej nazwy dla worktree');
}

/**
 * What removing a worktree would lose: files with uncommitted changes (staged, unstaged and untracked, ignored files
 * excluded) and commits of its branch that the project's current HEAD cannot reach. HEAD is the base on purpose: it is what
 * `git branch -d` checks for a branch without an upstream (cells' `mc/*` branches have none), so "0 commits" means the
 * branch can be deleted with -d and no commit is lost.
 */
export async function inspectWorktree(projectPath: string, wt: Worktree): Promise<WorktreeInspection> {
  const exists = existsSync(wt.path);
  let dirty = 0;
  if (exists) {
    const { stdout } = await git(wt.path, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
    const fields = stdout.split('\0');
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].length < 4) continue;
      dirty++;
      if (fields[i][0] === 'R' || fields[i][0] === 'C') i++; // a rename or copy carries its old path in the next field
    }
  }
  let base = 'HEAD';
  try { base = (await git(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim() || 'HEAD'; } catch { /* HEAD without commits */ }
  let unmerged = 0;
  if (await branchExists(projectPath, wt.branch)) {
    const ref = `refs/heads/${wt.branch}`;
    const count = await git(projectPath, 'rev-list', '--count', ref, '--not', 'HEAD')
      .catch(() => git(projectPath, 'rev-list', '--count', ref)); // HEAD without commits: every commit counts
    unmerged = Number(count.stdout.trim()) || 0;
  }
  return { exists, dirty, unmerged, base };
}

/**
 * Removes a worktree (and its branch). Without `force` it checks again first and refuses (code 'unsafe') when files or
 * commits would be lost, then removes without --force and deletes the branch with -d, so git itself refuses as well.
 * `force` (the user confirmed the loss) uses --force and -D. The worktree goes first: git cannot delete a branch that is
 * checked out in a worktree.
 */
export async function removeWorktree(projectPath: string, wt: Worktree, deleteBranch: boolean, force = false): Promise<WorktreeRemoveResult> {
  let inspection: WorktreeInspection;
  try { inspection = await inspectWorktree(projectPath, wt); }
  catch (error) { return { ok: false, code: 'failed', error: gitError(error) }; }
  if (!force && (inspection.dirty > 0 || (deleteBranch && inspection.unmerged > 0))) return { ok: false, code: 'unsafe', error: 'unsafe', inspection };
  try {
    if (inspection.exists) await git(projectPath, 'worktree', 'remove', ...(force ? ['--force'] : []), wt.path);
    else await git(projectPath, 'worktree', 'prune');
  } catch (error) { return { ok: false, code: 'failed', error: gitError(error) }; }
  if (deleteBranch && (await branchExists(projectPath, wt.branch))) {
    try { await git(projectPath, 'branch', force ? '-D' : '-d', wt.branch); }
    catch (error) { return { ok: false, code: 'branch', error: gitError(error) }; }
  }
  return { ok: true };
}

/** The branch checked out in a folder (undefined when detached or not a repository). */
export async function currentBranch(path: string): Promise<string | undefined> {
  try {
    const branch = (await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch { return undefined; }
}

function gitError(error: unknown): string {
  const e = error as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(error)).split(/\r?\n/).filter(Boolean).slice(0, 3).join('\n');
}
