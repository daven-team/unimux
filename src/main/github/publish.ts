// "Publish to GitHub", end to end in main: the repository is checked first (a branch with commits, no remote, trusted), then the
// repository is created on GitHub (POST /user/repos), added as "origin" (its https address) and the branch pushed with upstream.
// The token goes to git in the environment only (gitEnv.ts). No Electron here, so the tests can run it with fakes.
import type { GithubPublishRequest, GithubPublishResult, GithubResult } from '../../shared/github';
import type { Git } from '../git';
import { canonicalPath } from '../gitPaths';
import { createRepo, type FetchLike } from './api';
import type { GithubAuth } from './auth';
import { githubGitEnv, workflowScopeRefused } from './gitEnv';

export const PUBLISH_ERR = {
  signIn: 'Zaloguj się do GitHuba, aby opublikować repozytorium.',
  remoteExists: 'To repozytorium ma już zdalne repozytorium.',
  noCommits: 'Najpierw zatwierdź pierwszy commit, potem opublikuj repozytorium.',
  detached: 'Publikowanie wymaga gałęzi (HEAD jest odłączony).',
  busy: 'Publikowanie już trwa.',
  remoteFailed: 'Repozytorium zostało utworzone na GitHubie, ale nie udało się dodać go jako origin.',
  pushFailed: 'Repozytorium zostało utworzone na GitHubie, ale wysłanie gałęzi nie powiodło się. Użyj Push w panelu Git, aby spróbować ponownie.',
  workflowScope: 'Repozytorium zostało utworzone na GitHubie, ale GitHub nie przyjął gałęzi: zawiera pliki .github/workflows, a to logowanie nie ma uprawnienia „workflow”. Użyj Push w panelu Git (z Twoimi poświadczeniami git) albo git push w terminalu.',
} as const;

export interface PublishDeps {
  git: Pick<Git, 'publishInfo' | 'publishPush'>;
  auth: Pick<GithubAuth, 'token' | 'rejected'>;
  fetch: FetchLike;
}

export type Publish = (dir: string, scope: string, req: GithubPublishRequest) => Promise<GithubResult<GithubPublishResult>>;

export function createPublisher(deps: PublishDeps): Publish {
  const running = new Set<string>();
  return async (dir, scope, req) => {
    const key = canonicalPath(dir);
    if (running.has(key)) return { ok: false, code: 'busy', error: PUBLISH_ERR.busy };
    running.add(key);
    try {
      const info = await deps.git.publishInfo(dir, scope);
      if (!info.ok) return info;
      if (info.data.remotes.length) return { ok: false, code: 'remote-exists', error: PUBLISH_ERR.remoteExists };
      const branch = info.data.branch;
      if (!branch) return { ok: false, code: 'detached', error: PUBLISH_ERR.detached };
      if (info.data.initial) return { ok: false, code: 'no-commits', error: PUBLISH_ERR.noCommits };

      const auth = await deps.auth.token();
      if (!auth) return { ok: false, code: 'auth', error: PUBLISH_ERR.signIn };
      const created = await createRepo(deps.fetch, auth.token, { name: req.name, private: req.private });
      if (!created.ok) {
        if (created.code === 'auth') deps.auth.rejected(auth.source);
        return created;
      }
      const { fullName, htmlUrl, cloneUrl } = created.data;
      const pushed = await deps.git.publishPush(dir, { requestId: req.requestId, url: cloneUrl, branch, env: githubGitEnv(auth.token) }, scope);
      if (!pushed.ok) return { ok: false, code: 'remote-failed', error: PUBLISH_ERR.remoteFailed, detail: pushed.error, url: htmlUrl };
      if (!pushed.data.pushed) {
        // The device-flow sign-in asks for "repo" only: GitHub refuses it a push that brings GitHub Actions workflow files.
        const error = workflowScopeRefused(pushed.data.message) ? PUBLISH_ERR.workflowScope : PUBLISH_ERR.pushFailed;
        return { ok: false, code: 'push-failed', error, detail: pushed.data.message, url: htmlUrl };
      }
      return { ok: true, data: { fullName, htmlUrl, branch } };
    } catch (error) {
      return { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) };
    } finally {
      running.delete(key);
    }
  };
}
