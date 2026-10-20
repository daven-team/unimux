// Where the GitHub token for publishing comes from, in this order: the one unimux stored (device flow), the token of an installed
// and signed-in GitHub CLI (`gh auth token`, run without a shell; a missing gh is no error), else nothing (the dialog offers the
// device flow, or asks for `gh auth login` while unimux has no OAuth App). The token stays in main; the renderer only ever sees
// the source and the user name. No Electron here, so the tests can drive it.
import { randomUUID } from 'crypto';
import { GITHUB_DEVICE_PAGE, GITHUB_DEVICE_SCOPE, isGithubPage, type GithubAuthSource, type GithubAuthStatus, type GithubDeviceStart, type GithubResult } from '../../shared/github';
import { ERR, fetchLogin, pollDeviceToken, requestDeviceCode, type FetchLike, type PollOptions } from './api';
import { isTokenText, type GithubTokenStore } from './tokenStore';

/** Runs a program without a shell: its stdout, or an error (ENOENT when it is not installed). */
export type ExecFile = (file: string, args: string[], options: { timeout: number; env: Record<string, string> }) => Promise<{ stdout: string }>;

export interface GithubAuthDeps {
  fetch: FetchLike;
  store: GithubTokenStore;
  /** The OAuth App client id (GITHUB_OAUTH_CLIENT_ID); empty hides the device flow. */
  clientId: string;
  exec: ExecFile;
  /** The environment gh runs in (PATH refreshed, session variables removed). */
  env(): Promise<Record<string, string>>;
  platform: NodeJS.Platform;
  /** Test hooks of the device-flow poll. */
  poll?: Pick<PollOptions, 'now' | 'sleep' | 'maxNetworkFailures'>;
}

/** Where gh usually lives when the app's PATH does not have it (a Finder-started app on macOS, a PATH not refreshed on Windows). */
const GH_FALLBACKS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
  win32: ['C:\\Program Files\\GitHub CLI\\gh.exe'],
  linux: ['/usr/bin/gh', '/usr/local/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh'],
};
const GH_TIMEOUT_MS = 8000;
const LOGIN_TTL_MS = 10 * 60_000;

interface Flow { id: string; controller: AbortController; result: Promise<GithubResult<{ login: string | null }>> }

export class GithubAuth {
  private flow: Flow | null = null;
  /** The user name of the gh token, per token, for a few minutes (the dialog asks each time it opens). */
  private ghLogin: { token: string; login: string | null; at: number } | null = null;

  constructor(private readonly deps: GithubAuthDeps) {}

  /** The GitHub CLI's token, or null (gh missing, signed out, too old for `auth token`, or slow). */
  async ghToken(): Promise<string | null> {
    const env = { ...(await this.deps.env()), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
    for (const bin of ['gh', ...(GH_FALLBACKS[this.deps.platform] ?? [])]) {
      try {
        const { stdout } = await this.deps.exec(bin, ['auth', 'token', '--hostname', 'github.com'], { timeout: GH_TIMEOUT_MS, env });
        const token = stdout.trim();
        return isTokenText(token) ? token : null;
      } catch (error) {
        // Not installed here: the next place is tried. Installed but signed out (or failing): there is no token.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return null;
      }
    }
    return null;
  }

  /** The token to publish with and where it came from, or null when the user has to sign in. */
  async token(): Promise<{ token: string; source: GithubAuthSource } | null> {
    const stored = this.deps.store.get();
    if (stored) return { token: stored, source: 'stored' };
    const gh = await this.ghToken();
    return gh ? { token: gh, source: 'gh' } : null;
  }

  /** GitHub refused the token (401): a stored one is forgotten (it cannot work again); a gh token belongs to the CLI. */
  rejected(source: GithubAuthSource): void {
    if (source === 'stored') this.deps.store.clear();
    else this.ghLogin = null;
  }

  /** Who is signed in. `local`: the stored sign-in only (no `gh`, no network), for the Git panel's menu. */
  async status(local = false): Promise<GithubAuthStatus> {
    const base = { deviceFlow: !!this.deps.clientId, storage: this.deps.store.storage };
    if (this.deps.store.get()) return { ...base, signedIn: true, source: 'stored', login: this.deps.store.login() };
    if (local) return { ...base, signedIn: false, source: null, login: null };
    const gh = await this.ghToken();
    if (!gh) return { ...base, signedIn: false, source: null, login: null };
    const known = this.ghLogin;
    if (known && known.token === gh && Date.now() - known.at < LOGIN_TTL_MS) return { ...base, signedIn: true, source: 'gh', login: known.login };
    const login = await fetchLogin(this.deps.fetch, gh);
    // GitHub says the CLI's token is no longer valid: the user has to run `gh auth login` again (or sign in here).
    if (!login.ok && login.code === 'auth') return { ...base, signedIn: false, source: null, login: null };
    this.ghLogin = { token: gh, login: login.ok ? login.data : null, at: Date.now() };
    return { ...base, signedIn: true, source: 'gh', login: this.ghLogin.login };
  }

  /** Starts the device flow (one at a time: a new start ends the previous one) and polls GitHub in the background. */
  async startDevice(): Promise<GithubResult<GithubDeviceStart>> {
    this.cancelDevice();
    const code = await requestDeviceCode(this.deps.fetch, this.deps.clientId, GITHUB_DEVICE_SCOPE);
    if (!code.ok) return code;
    const controller = new AbortController();
    const id = randomUUID();
    const result = pollDeviceToken({ fetch: this.deps.fetch, clientId: this.deps.clientId, code: code.data, signal: controller.signal, ...this.deps.poll })
      .then(async (polled): Promise<GithubResult<{ login: string | null }>> => {
        if (!polled.ok) return polled;
        const login = await fetchLogin(this.deps.fetch, polled.data.token);
        this.deps.store.set(polled.data.token, login.ok ? login.data : null);
        return { ok: true, data: { login: login.ok ? login.data : null } };
      });
    // A finished flow stays here (its answer is still asked for) until the next start, a cancel or a sign-out.
    this.flow = { id, controller, result };
    const verificationUri = isGithubPage(code.data.verificationUri) ? code.data.verificationUri : GITHUB_DEVICE_PAGE;
    return { ok: true, data: { flowId: id, userCode: code.data.userCode, verificationUri, expiresIn: code.data.expiresIn } };
  }

  /** The end of the device flow `flowId` (an unknown or replaced id answers "cancelled"). */
  waitDevice(flowId: string): Promise<GithubResult<{ login: string | null }>> {
    if (this.flow?.id !== flowId) return Promise.resolve({ ok: false, code: 'cancelled', error: ERR.cancelled });
    return this.flow.result;
  }

  /** Stops the running device flow (all of them when no id is given). */
  cancelDevice(flowId?: string): void {
    if (!this.flow || (flowId !== undefined && this.flow.id !== flowId)) return;
    this.flow.controller.abort();
    this.flow = null;
  }

  /** "Sign out of GitHub": the stored token is forgotten (the local status follows); a GitHub CLI login is the CLI's own (`gh auth logout`). */
  async signOut(): Promise<GithubAuthStatus> {
    this.cancelDevice();
    this.deps.store.clear();
    this.ghLogin = null;
    return this.status(true);
  }
}
