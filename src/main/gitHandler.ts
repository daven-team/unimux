// One Git request, end to end: allow-list, validation, folder resolution, the call. No Electron here, so the tests can run it.
import {
  validateGitRequest, type GitChannel, type GitRequestMap, type GitResult,
} from '../shared/git';
import type { Git } from './git';

export const GONE = 'Projekt już nie istnieje.';
export const INVALID = 'Nieprawidłowe żądanie git.';

export const GIT_CHANNELS: readonly GitChannel[] = [
  'status', 'log', 'show', 'diff', 'branches', 'fetch', 'pull', 'push', 'stage', 'unstage', 'commit', 'checkout', 'trust', 'trustGrant', 'trustRevoke',
];

/** Channels that only read (status, history, diffs, branch list, trust info): open to any sender. */
export const GIT_READ_CHANNELS: readonly GitChannel[] = ['status', 'log', 'show', 'diff', 'branches', 'trust'];
/** Channels that change the repository, its remotes or the trust list: only the app window may call them (R9). */
export const GIT_MUTATING_CHANNELS: readonly GitChannel[] = GIT_CHANNELS.filter((c) => !GIT_READ_CHANNELS.includes(c));

type Run = (git: Git, dir: string, req: never, scope: string) => Promise<GitResult<unknown>>;

// `scope` is the folder the repository must not reach above: the project folder, or the chosen worktree. It comes from main, never from the renderer.
const RUNNERS: { [C in GitChannel]: (git: Git, dir: string, req: GitRequestMap[C], scope: string) => Promise<GitResult<unknown>> } = {
  status: (git, dir, _req, scope) => git.status(dir, scope),
  log: (git, dir, req) => git.log(dir, req),
  show: (git, dir, req) => git.show(dir, req.hash),
  diff: (git, dir, req) => git.diff(dir, req),
  branches: (git, dir) => git.branches(dir),
  fetch: (git, dir, req, scope) => git.fetch(dir, req.requestId, scope),
  pull: (git, dir, req, scope) => git.pull(dir, req.requestId, scope),
  push: (git, dir, req, scope) => git.push(dir, req, scope),
  stage: (git, dir, req, scope) => git.stage(dir, req, scope),
  unstage: (git, dir, req, scope) => git.unstage(dir, req, scope),
  commit: (git, dir, req, scope) => git.commit(dir, req, scope),
  checkout: (git, dir, req, scope) => git.checkout(dir, req, scope),
  trust: (git, dir, req, scope) => git.trustInfo(dir, scope, req.cached === true),
  trustGrant: (git, dir, req, scope) => git.grantTrust(dir, req.requestId, scope),
  trustRevoke: (git, dir, req, scope) => git.revokeTrust(dir, req.requestId, scope),
};

/**
 * One request, end to end (also what the tests call): validates, resolves the folder, runs. `extraWorktrees` are worktrees the project's
 * cells use (besides the ones inside or next to the project folder).
 */
export async function handleGit(
  git: Git, projectPath: string | undefined, channel: string, input: unknown, windows: boolean, extraWorktrees: readonly string[] = [],
): Promise<GitResult<unknown>> {
  if (!(GIT_CHANNELS as readonly string[]).includes(channel)) return { ok: false, code: 'invalid', error: INVALID };
  const name = channel as GitChannel;
  if (!projectPath) return { ok: false, code: 'gone', error: GONE };
  const checked = validateGitRequest(name, input, windows);
  if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
  const request = checked.value as { worktree?: string };
  const dir = await git.resolveDir(projectPath, request.worktree, extraWorktrees);
  if (!dir.ok) return dir;
  const scope = request.worktree ? dir.data : projectPath;
  try {
    return await (RUNNERS[name] as unknown as Run)(git, dir.data, request as never, scope);
  } catch (error) {
    return { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
