// "Publish to GitHub" of the Git panel: types, the repository name rules and request validation shared by main and the renderer.
// Pure (no process, no DOM). The token itself never appears here: it lives in main only (src/main/github).
import type { GitErrorCode } from './git';
import { isRequestId } from './git';

/**
 * The client id of unimux's GitHub OAuth App (device flow, scope GITHUB_DEVICE_SCOPE). Empty: the app has no OAuth App registered yet, so
 * "Sign in with GitHub" is hidden and the dialog asks for the GitHub CLI (`gh auth login`) instead. To enable it, register an
 * OAuth App on GitHub (Settings > Developer settings > OAuth Apps, "Enable Device Flow" checked) and put its public client id
 * here; a device-flow client id is not a secret (no client secret is used).
 */
export const GITHUB_OAUTH_CLIENT_ID: string = '';

/**
 * The scope the device flow asks for: "repo" (creating private repositories and pushing to them), nothing broader. GitHub
 * refuses such a token a push that adds or changes .github/workflows files ("workflow" scope): publishing says so
 * (PUBLISH_ERR.workflowScope), and later pushes in the Git panel try again with the user's own git credentials.
 */
export const GITHUB_DEVICE_SCOPE = 'repo';
export const GITHUB_DEVICE_PAGE = 'https://github.com/login/device';
export const GITHUB_REPO_NAME_MAX = 100;

export type GithubErrorCode =
  | GitErrorCode
  | 'auth' | 'exists' | 'network' | 'forbidden' | 'rate-limit' | 'remote-exists' | 'no-commits' | 'detached' | 'push-failed'
  | 'remote-failed' | 'expired' | 'denied' | 'cancelled' | 'no-client';

/**
 * `error` is a message key (Polish source text) or git's own text; `detail`, shown after it, is GitHub's or git's own explanation
 * or the message key of the git step that refused (both go through the renderer's errorText, which leaves unknown text as it is).
 * `url` is the web page of a repository that was created although a later step failed.
 */
export type GithubResult<T> = { ok: true; data: T } | { ok: false; code: GithubErrorCode; error: string; detail?: string; url?: string };

/** Where the token for publishing comes from: one stored by unimux (device flow), or the GitHub CLI's. */
export type GithubAuthSource = 'stored' | 'gh';

export interface GithubAuthStatus {
  signedIn: boolean;
  source: GithubAuthSource | null;
  /** The GitHub user name (null when it could not be read). */
  login: string | null;
  /** The device flow can be offered (an OAuth App client id is built in). */
  deviceFlow: boolean;
  /** Where a token from the device flow is kept: encrypted by the system, or in memory until the app quits. */
  storage: 'dpapi' | 'keychain' | 'unavailable';
}

export interface GithubDeviceStart {
  flowId: string;
  /** The code the user types on GitHub's page (e.g. "WDJB-MJHT"). */
  userCode: string;
  /** GitHub's page for the code (always https://github.com/...). */
  verificationUri: string;
  /** Seconds the code stays valid. */
  expiresIn: number;
}

export interface GithubPublishRequest { requestId: string; name: string; private: boolean; worktree?: string }

export interface GithubPublishResult {
  /** "owner/name" */
  fullName: string;
  /** The repository's page on GitHub. */
  htmlUrl: string;
  /** The branch that was pushed (and now tracks origin). */
  branch: string;
}

export interface GithubApi {
  /** Who is signed in and how (never the token). `local`: only the sign-in unimux stored (no `gh`, no network: quick). */
  status(options?: { local?: boolean }): Promise<GithubAuthStatus>;
  /** Starts the OAuth device flow: the code to show; main polls GitHub meanwhile. */
  deviceStart(): Promise<GithubResult<GithubDeviceStart>>;
  /** Resolves when the device flow of `flowId` ended: signed in (the token is stored in main), or why not. */
  deviceWait(flowId: string): Promise<GithubResult<{ login: string | null }>>;
  deviceCancel(flowId: string): Promise<void>;
  /** Forgets the token unimux stored (a GitHub CLI login stays, it belongs to the CLI). */
  signOut(): Promise<GithubAuthStatus>;
  /** Creates the repository on GitHub, adds it as "origin" and pushes the current branch with upstream. */
  publish(projectId: string, req: GithubPublishRequest): Promise<GithubResult<GithubPublishResult>>;
}

// ---------- repository names ----------

const NAME = /^[A-Za-z0-9._-]+$/;
const LETTER_FOLD: Record<string, string> = { ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE' };

/** GitHub's rules for a repository name: 1-100 of ASCII letters, digits, ".", "-", "_"; not "." or ".."; not ending in ".git". */
export function isValidRepoName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= GITHUB_REPO_NAME_MAX && NAME.test(value)
    && value !== '.' && value !== '..' && !/\.git$/i.test(value);
}

/**
 * The name a folder suggests: accents dropped ("Mój projekt" -> "Moj-projekt"), every run of other characters becomes one "-"
 * (what GitHub itself does with a typed name), no "-" or "." at the ends, at most 100 characters, no ".git" suffix.
 */
export function sanitizeRepoName(folder: string, fallback = 'repository'): string {
  // eslint-disable-next-line no-control-regex
  const plain = folder.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7f]/g, (c) => LETTER_FOLD[c] ?? c);
  let name = plain.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-');
  name = name.replace(/\.git$/i, '').replace(/^-+/, '').replace(/[-.]+$/, '').slice(0, GITHUB_REPO_NAME_MAX).replace(/[-.]+$/, '');
  return isValidRepoName(name) ? name : fallback;
}

/** The last part of a folder path (either separator), for the suggested name. */
export const folderBaseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

// ---------- validation ----------

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export const INVALID_NAME = 'Nazwa repozytorium może mieć do 100 znaków: litery, cyfry, kropki, myślniki i podkreślenia.';

/** Checks what the renderer sent: unknown fields are dropped, the name follows GitHub's rules, visibility is a boolean. */
export function validatePublishRequest(input: unknown): Checked<GithubPublishRequest> {
  const invalid = { ok: false as const, error: 'Nieprawidłowe żądanie git.' };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid;
  const req = input as Record<string, unknown>;
  if (!isRequestId(req.requestId) || typeof req.private !== 'boolean') return invalid;
  if (!isValidRepoName(req.name)) return { ok: false, error: INVALID_NAME };
  let worktree: string | undefined;
  if (req.worktree !== undefined && req.worktree !== '') {
    if (typeof req.worktree !== 'string' || req.worktree.length > 1000 || req.worktree.includes('\0')) return invalid;
    worktree = req.worktree;
  }
  return { ok: true, value: { requestId: req.requestId, name: req.name, private: req.private, ...(worktree ? { worktree } : {}) } };
}

/** A device-flow id main handed out (a UUID). */
export const isFlowId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

/** Only GitHub's own pages are opened from the dialog (an address that came back from the network is checked first). */
export function isGithubPage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port;
  } catch { return false; }
}
