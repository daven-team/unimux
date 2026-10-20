// IPC of "Publish to GitHub". Every channel answers the app window only (guardedHandle, R9): signing in, signing out and
// publishing change something, and even the status runs `gh` and asks GitHub. The renderer names a project (never a path) and
// gets the sign-in source and user name, never a token.
import { isFlowId, validatePublishRequest, type GithubAuthStatus, type GithubResult } from '../../shared/github';
import type { Git } from '../git';
import { GONE, INVALID } from '../gitHandler';
import type { IpcGuard } from '../ipcGuard';
import { ERR } from './api';
import type { GithubAuth } from './auth';
import type { Publish } from './publish';

export const GITHUB_CHANNELS = ['github:status', 'github:deviceStart', 'github:deviceWait', 'github:deviceCancel', 'github:signOut', 'github:publish'] as const;

export interface GithubHandlers {
  status(options: unknown): Promise<GithubAuthStatus>;
  deviceStart(): Promise<GithubResult<unknown>>;
  deviceWait(flowId: unknown): Promise<GithubResult<unknown>>;
  deviceCancel(flowId: unknown): void;
  signOut(): Promise<GithubAuthStatus>;
  publish(projectId: unknown, request: unknown): Promise<GithubResult<unknown>>;
}

export interface GithubHandlerDeps {
  auth: Pick<GithubAuth, 'status' | 'startDevice' | 'waitDevice' | 'cancelDevice' | 'signOut'>;
  publish: Publish;
  git: Pick<Git, 'resolveDir'>;
  projectPath(projectId: string): string | undefined;
  /** Worktrees the project's cells use (they may sit anywhere). */
  worktreePaths?(projectId: string): string[];
}

export function createGithubHandlers(deps: GithubHandlerDeps): GithubHandlers {
  return {
    status: (options) => deps.auth.status(typeof options === 'object' && options !== null && (options as { local?: unknown }).local === true),
    deviceStart: () => deps.auth.startDevice(),
    deviceWait: (flowId) => (isFlowId(flowId) ? deps.auth.waitDevice(flowId) : Promise.resolve({ ok: false, code: 'cancelled', error: ERR.cancelled })),
    deviceCancel: (flowId) => { if (isFlowId(flowId)) deps.auth.cancelDevice(flowId); },
    signOut: () => deps.auth.signOut(),
    publish: async (projectId, request) => {
      const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
      if (!path) return { ok: false, code: 'gone', error: GONE };
      const checked = validatePublishRequest(request);
      if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
      // The folder is resolved like every Git panel request: the project folder, or one of its worktrees git itself lists.
      const dir = await deps.git.resolveDir(path, checked.value.worktree, deps.worktreePaths?.(projectId as string) ?? []);
      if (!dir.ok) return dir;
      return deps.publish(dir.data, checked.value.worktree ? dir.data : path, checked.value);
    },
  };
}

const signedOut: GithubAuthStatus = { signedIn: false, source: null, login: null, deviceFlow: false, storage: 'unavailable' };

export function registerGithubIpc(guard: Pick<IpcGuard, 'guardedHandle'>, handlers: GithubHandlers): void {
  // A foreign sender gets what a failed request answers; the dialog already shows those.
  const refused = (): GithubResult<never> => ({ ok: false, code: 'invalid', error: INVALID });
  guard.guardedHandle('github:status', (_e, options: unknown) => handlers.status(options), () => signedOut);
  guard.guardedHandle('github:deviceStart', () => handlers.deviceStart(), refused);
  guard.guardedHandle('github:deviceWait', (_e, flowId: unknown) => handlers.deviceWait(flowId), refused);
  guard.guardedHandle('github:deviceCancel', (_e, flowId: unknown) => handlers.deviceCancel(flowId), () => undefined);
  guard.guardedHandle('github:signOut', () => handlers.signOut(), () => signedOut);
  guard.guardedHandle('github:publish', (_e, projectId: unknown, request: unknown) => handlers.publish(projectId, request), refused);
}
