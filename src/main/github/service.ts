// "Publish to GitHub" put together for main (index.ts passes Electron's pieces in): the token store, the sign-in, publishing
// and the environment that lets later fetch, pull and push to https://github.com use the stored sign-in.
import { execFile } from 'child_process';
import { join } from 'path';
import { GITHUB_OAUTH_CLIENT_ID } from '../../shared/github';
import type { Git } from '../git';
import type { Cipher } from '../ssh/vault';
import type { FetchLike } from './api';
import { GithubAuth, type ExecFile } from './auth';
import { githubGitEnv } from './gitEnv';
import { createGithubHandlers, type GithubHandlerDeps, type GithubHandlers } from './ipc';
import { createPublisher } from './publish';
import { GithubTokenStore } from './tokenStore';

export interface GithubServiceDeps {
  dataDir: string;
  cipher: Cipher;
  fetch: FetchLike;
  /** The environment `gh` runs in. */
  env(): Promise<Record<string, string>>;
}

/** execFile without a shell, small output, hidden window: what `gh auth token` needs. */
const execNoShell: ExecFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, windowsHide: true, shell: false, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error);
    else resolve({ stdout });
  });
});

export function createGithubService(deps: GithubServiceDeps) {
  const store = new GithubTokenStore(join(deps.dataDir, 'github', 'token.json'), deps.cipher);
  const auth = new GithubAuth({ fetch: deps.fetch, store, clientId: GITHUB_OAUTH_CLIENT_ID, exec: execNoShell, env: deps.env, platform: process.platform });
  return {
    /** For Git's fetch, pull and push: the stored sign-in as an https://github.com header, or null. */
    remoteAuth: (): Record<string, string> | null => {
      const token = store.get();
      return token ? githubGitEnv(token) : null;
    },
    handlers: (git: Git, project: Pick<GithubHandlerDeps, 'projectPath' | 'worktreePaths'>): GithubHandlers =>
      createGithubHandlers({ auth, git, publish: createPublisher({ git, auth, fetch: deps.fetch }), ...project }),
  };
}
