// git worktrees for cells that should work in isolation from the rest of the grid.
import { execFile } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { cleanEnv } from '../shared/env';
import { normalizeProjectPath } from '../shared/platform';
import type { Worktree, WorktreeInspection, WorktreeRemoveResult } from '../shared/types';
import { SCRUBBED_ENV } from './git';

const run = promisify(execFile);
/** Reads (status, rev-list) must answer within this; adding or removing a big worktree may take longer. */
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 120_000;
const TIMEOUT_MESSAGE = 'Git nie odpowiedział w wyznaczonym czasie.';

/** A quiet environment like the Git panel's (src/main/git.ts): no prompts, no foreign repository or config, no optional locks. */
function gitEnv(): Record<string, string> {
  const env = cleanEnv(process.env);
  for (const key of Object.keys(env)) if (SCRUBBED_ENV.test(key)) delete env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}
/** fsmonitor names a program in the repository's config that even `status` would start. */
const gitIn = (timeout: number) => (cwd: string, ...args: string[]) =>
  run('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
const git = gitIn(READ_TIMEOUT_MS);
const gitWrite = gitIn(WRITE_TIMEOUT_MS);

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const { stdout } = await git(path, 'rev-parse', '--is-inside-work-tree');
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function branchTip(repo: string, branch: string): Promise<string> {
  if (!branch) return '';
  try { return (await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).stdout.trim(); }
  catch { return ''; }
}
const branchExists = async (repo: string, branch: string) => !!(await branchTip(repo, branch));

/** Only branches unimux created for a cell are deleted with its worktree; an adopted worktree (a resumed conversation) never owns one. */
export const ownsBranch = (wt: Worktree): boolean => !wt.adopted && wt.branch.startsWith('mc/');

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
    await gitWrite(projectPath, 'worktree', 'add', '-b', branch, path, 'HEAD');
    return { path, branch };
  }
  throw new Error('Nie udało się znaleźć wolnej nazwy dla worktree');
}

/**
 * A path in its long, real spelling, also for a folder that no longer exists (its nearest existing parent is resolved): a
 * project reached through a short 8.3 path (a temp folder under a long Windows user name) has its worktrees listed by git
 * under the long name.
 */
function longPath(path: string): string {
  let dir = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(dir), ...rest.reverse()); } catch { /* not there (yet): one level up */ }
    const parent = dirname(dir);
    if (parent === dir) return path;
    rest.push(basename(dir));
    dir = parent;
  }
}

/** The entry of `git worktree list --porcelain` for this folder (its HEAD and the path as git spells it), or null when git does not know it. */
async function listedWorktree(projectPath: string, path: string): Promise<{ head: string; folder: string } | null> {
  const want = normalizeProjectPath(longPath(path));
  const { stdout } = await git(projectPath, 'worktree', 'list', '--porcelain');
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const folder = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (folder && normalizeProjectPath(longPath(folder)) === want) return { head: lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? '', folder };
  }
  return null;
}

/**
 * What removing a worktree would lose:
 * - `dirty`: files with uncommitted changes (staged, unstaged and untracked; ignored files excluded);
 * - `unmerged`: commits of its branch that the project's current HEAD cannot reach. HEAD is the base on purpose: it is what
 *   `git branch -d` checks for a branch without an upstream (cells' `mc/*` branches have none);
 * - `detached`: commits reachable from the worktree's HEAD but from no branch, remote or tag (made on a detached HEAD, a
 *   rebase in progress): removing the worktree drops its HEAD and they are gone, whatever happens to the branch.
 * `head` and `tip` (the worktree HEAD and the branch tip) let a confirmed removal tell whether anything moved since.
 */
export async function inspectWorktree(projectPath: string, wt: Worktree): Promise<WorktreeInspection> {
  try {
    const exists = existsSync(wt.path);
    let dirty = 0;
    let head = '';
    if (exists) {
      const { stdout } = await git(wt.path, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
      const fields = stdout.split('\0');
      for (let i = 0; i < fields.length; i++) {
        if (fields[i].length < 4) continue;
        dirty++;
        if (fields[i][0] === 'R' || fields[i][0] === 'C') i++; // a rename or copy carries its old path in the next field
      }
      try { head = (await git(wt.path, 'rev-parse', '--verify', '--quiet', 'HEAD')).stdout.trim(); } catch { /* no commit yet */ }
    } else head = (await listedWorktree(projectPath, wt.path))?.head ?? '';
    let base = 'HEAD';
    try { base = (await git(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim() || 'HEAD'; } catch { /* HEAD without commits */ }
    const tip = await branchTip(projectPath, wt.branch);
    let unmerged = 0;
    if (tip) {
      const ref = `refs/heads/${wt.branch}`;
      const count = await git(projectPath, 'rev-list', '--count', ref, '--not', 'HEAD')
        .catch(() => git(projectPath, 'rev-list', '--count', ref)); // HEAD without commits: every commit counts
      unmerged = Number(count.stdout.trim()) || 0;
    }
    let detached = 0;
    if (head) detached = Number((await git(projectPath, 'rev-list', '--count', head, '--not', '--branches', '--remotes', '--tags')).stdout.trim()) || 0;
    return { exists, dirty, unmerged, detached, base, head, tip };
  } catch (error) { throw new Error(gitError(error)); }
}

/** Work removing it would lose (the branch's own commits only count when the branch goes too). */
export const losesWork = (i: WorktreeInspection, deleteBranch: boolean): boolean => i.dirty > 0 || i.detached > 0 || (deleteBranch && i.unmerged > 0);
/** Something was added since the user confirmed `c`: more files or commits, or a moved HEAD or branch tip. */
const grewSince = (i: WorktreeInspection, c: WorktreeInspection): boolean =>
  i.dirty > c.dirty || i.unmerged > c.unmerged || i.detached > c.detached || i.head !== c.head || i.tip !== c.tip;

/**
 * Removes a worktree (and its branch, only when unimux created it: `ownsBranch`). It inspects first, after the cell's
 * terminal is gone:
 * - nothing to lose: removed without --force, the branch deleted with -d (git itself refuses when it would lose a commit);
 * - work would be lost and `confirmed` (what the user saw and accepted) is missing, or more appeared since: refused with
 *   code 'unsafe' and the new inspection, nothing removed;
 * - otherwise (the user accepted exactly this loss): --force and -D.
 * The worktree goes first: git cannot delete a branch that is checked out in a worktree.
 */
export async function removeWorktree(projectPath: string, wt: Worktree, deleteBranch: boolean, confirmed?: WorktreeInspection): Promise<WorktreeRemoveResult> {
  const dropBranch = deleteBranch && ownsBranch(wt);
  let inspection: WorktreeInspection;
  try { inspection = await inspectWorktree(projectPath, wt); }
  catch (error) { return { ok: false, code: 'failed', error: (error as Error).message }; }
  const force = losesWork(inspection, dropBranch);
  if (force && (!confirmed || grewSince(inspection, confirmed))) return { ok: false, code: 'unsafe', error: 'unsafe', inspection };
  try {
    if (inspection.exists) await gitWrite(projectPath, 'worktree', 'remove', ...(force ? ['--force'] : []), wt.path);
    // A folder already gone: only its own registration is dropped (`worktree prune` would also drop others on an unplugged drive).
    else {
      const listed = await listedWorktree(projectPath, wt.path);
      if (listed) await gitWrite(projectPath, 'worktree', 'remove', listed.folder);
    }
  } catch (error) { return { ok: false, code: 'failed', error: gitError(error) }; }
  if (dropBranch && inspection.tip) {
    try { await gitWrite(projectPath, 'branch', force ? '-D' : '-d', wt.branch); }
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
  const e = error as { stderr?: string; message?: string; killed?: boolean; signal?: string; code?: string };
  if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') return TIMEOUT_MESSAGE;
  return (e.stderr?.trim() || e.message || String(error)).split(/\r?\n/).filter(Boolean).slice(0, 3).join('\n');
}
