// Types, request validation and output parsers of the Git panel. Everything here is pure (no process, no DOM), so the main process
// (src/main/git.ts), the IPC layer and the renderer share it and the tests can drive it directly.

import { normalizeProjectPath } from './platform';

export type GitErrorCode = 'not-repo' | 'no-git' | 'timeout' | 'busy' | 'invalid' | 'dirty' | 'too-large' | 'gone' | 'untrusted' | 'parent' | 'failed';

export type GitResult<T> = { ok: true; data: T } | { ok: false; code: GitErrorCode; error: string };

/** What the rail asks about a project: a repository, a folder that is none, or a machine without git. */
export type GitProbe = 'repo' | 'no-repo' | 'no-git';

// ---------- limits ----------

export const GIT_LOG_PAGE = 50;
export const GIT_LOG_MAX_PAGE = 200;
export const GIT_LOG_MAX_SKIP = 1_000_000;
export const GIT_MAX_PATHS = 2000;
export const GIT_MAX_FILES = 3000;
export const GIT_COMMIT_FILE_LIMIT = 500;
export const GIT_MESSAGE_LIMIT = 20_000;
export const GIT_DIFF_LINES = 4000;

// ---------- result shapes ----------

export interface GitFileChange {
  /** Relative to the repository root, with forward slashes (a folder ends with "/"). */
  path: string;
  /** The previous path of a renamed or copied file. */
  origPath?: string;
  /** Status letters of the index (X) and the work tree (Y); ' ' = unchanged. */
  x: string;
  y: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
}

/**
 * Where "Push" would go. `url` is the push URL git resolves (pushurl and insteadOf rewriting applied) with credentials removed, for
 * the confirmation dialog; `urlId` identifies the raw URL, and a push is refused when it no longer matches what the user confirmed.
 */
/** `inside-root`: the project is `prefix` below the root ('' = the root itself); `contains-root`: the root is `prefix` below the project. */
export type GitProjectRelation = { kind: 'inside-root' | 'contains-root'; prefix: string };

export interface GitPushTarget { remote: string; branch: string; setUpstream: boolean; url: string; urlId: string }

export interface GitStatus {
  /** Absolute path of the repository root (git's spelling, forward slashes). */
  root: string;
  /** The checked out branch; null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** Short hash of HEAD ('' in a repository without commits). */
  head: string;
  /** A repository without any commit. */
  initial: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  /** More changes than the panel lists. */
  truncated: boolean;
  /** Where "Push" would go (null: detached HEAD, no commits or no remote). */
  push: GitPushTarget | null;
  /** The repository root is above the project folder (the project is a subfolder of a larger repository): no write operations. */
  parent: boolean;
  /** Where the project folder lies relative to the repository root (null: unrelated); main works it out from canonical paths. */
  projectRelation: GitProjectRelation | null;
  /** The repository has at least one remote (false: "Publish to GitHub" is offered). */
  hasRemote?: boolean;
}

export interface GitRef { name: string; kind: 'head' | 'branch' | 'remote' | 'tag'; current?: boolean }

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  /** Seconds since the epoch. */
  at: number;
  refs: GitRef[];
  subject: string;
}

export interface GitLogPage { commits: GitCommit[]; hasMore: boolean }

export interface GitCommitFile { path: string; origPath?: string; status: string; added: number | null; deleted: number | null }

export interface GitCommitDetails {
  commit: GitCommit;
  email: string;
  /** The full message. */
  message: string;
  files: GitCommitFile[];
  filesTruncated: boolean;
  added: number;
  deleted: number;
}

export interface GitBranch {
  /** Short name: "main", or "origin/main" for a remote branch. */
  name: string;
  hash: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  /** "ahead 1, behind 2" as git prints it; '' when in sync or unknown. */
  track: string;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string;
  main: boolean;
  detached: boolean;
  /** Inside the project folder, next to it as an app-created sibling, or used by a cell: only these can be picked. */
  allowed: boolean;
  /** This is the project's own folder (compared by canonical path, so short names, links and letter case do not matter). */
  isProject: boolean;
  /** The worktree the caller asked to prefer (the focused cell's), matched the same way. */
  preferred: boolean;
}

/**
 * Whether a repository's configuration can make git start programs, and whether the user allowed it.
 *   safe       nothing in the repository can start a program
 *   trusted    it can, and the user trusted exactly this configuration
 *   untrusted  it can and the user has not (or the configuration changed since): only read-only operations that start nothing work
 */
export interface GitTrustInfo { state: 'safe' | 'trusted' | 'untrusted'; keys: string[]; root: string; parent: boolean }

export type GitDiffSource = 'working' | 'staged' | 'commit' | 'untracked';

export interface GitDiffResult {
  text: string;
  /** The output was cut at the size cap. */
  truncated: boolean;
  binary: boolean;
}

export interface GitOpResult { message: string }

// ---------- requests ----------

interface Base { worktree?: string }
export interface GitStatusRequest extends Base {}
export interface GitLogRequest extends Base { skip: number; count: number; search?: string; author?: string; path?: string; all?: boolean }
export interface GitShowRequest extends Base { hash: string }
export interface GitDiffRequest extends Base { source: GitDiffSource; path: string; oldPath?: string; hash?: string }
export interface GitBranchesRequest extends Base {}
export interface GitMutation extends Base { requestId: string }
export interface GitFetchRequest extends GitMutation {}
export interface GitPullRequest extends GitMutation {}
export interface GitPushRequest extends GitMutation { remote: string; branch: string; urlId: string }
/** `cached`: a display-only read (the Files tree marks) may use a scan of the last few seconds; every git run still checks itself. */
export interface GitTrustRequest extends Base { cached?: boolean }
export interface GitTrustGrantRequest extends GitMutation {}
export interface GitPathsRequest extends GitMutation { paths: string[]; all?: boolean }
export interface GitCommitRequest extends GitMutation { message: string }
export interface GitCheckoutRequest extends GitMutation { branch: string; remote?: boolean }

export interface GitApi {
  probe(projectId: string): Promise<GitProbe>;
  /** `git init` in the project folder (only when it is not a repository yet). */
  init(projectId: string): Promise<GitResult<{ message: string }>>;
  /** Installs Git (winget / Xcode tools) or opens its download page. */
  installGit(): Promise<GitResult<{ message: string; restart: boolean }>>;
  worktrees(projectId: string, req?: { prefer?: string }): Promise<GitResult<GitWorktree[]>>;
  status(projectId: string, req: GitStatusRequest): Promise<GitResult<GitStatus>>;
  log(projectId: string, req: GitLogRequest): Promise<GitResult<GitLogPage>>;
  show(projectId: string, req: GitShowRequest): Promise<GitResult<GitCommitDetails>>;
  diff(projectId: string, req: GitDiffRequest): Promise<GitResult<GitDiffResult>>;
  branches(projectId: string, req: GitBranchesRequest): Promise<GitResult<GitBranch[]>>;
  fetch(projectId: string, req: GitFetchRequest): Promise<GitResult<GitOpResult>>;
  pull(projectId: string, req: GitPullRequest): Promise<GitResult<GitOpResult>>;
  push(projectId: string, req: GitPushRequest): Promise<GitResult<GitOpResult>>;
  stage(projectId: string, req: GitPathsRequest): Promise<GitResult<GitOpResult>>;
  unstage(projectId: string, req: GitPathsRequest): Promise<GitResult<GitOpResult>>;
  commit(projectId: string, req: GitCommitRequest): Promise<GitResult<GitOpResult>>;
  checkout(projectId: string, req: GitCheckoutRequest): Promise<GitResult<GitOpResult>>;
  /** What the repository's configuration could start, and whether it is trusted. */
  trust(projectId: string, req: GitTrustRequest): Promise<GitResult<GitTrustInfo>>;
  /** The user's explicit "trust this repository": main scans again and stores the result (nothing the renderer sends can grant trust). */
  trustGrant(projectId: string, req: GitTrustGrantRequest): Promise<GitResult<GitTrustInfo>>;
  trustRevoke(projectId: string, req: GitTrustGrantRequest): Promise<GitResult<GitTrustInfo>>;
}

// ---------- validation ----------

const HASH = /^[0-9a-f]{4,64}$/i;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isCommitHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);

/**
 * A branch or tag name that is safe to put into a git command line: it never starts with "-" (no option injection), has no space,
 * control character, backslash, "..", "@{", "//", leading or trailing "/" or "." parts, nor a ".lock" suffix.
 */
export function isSafeRef(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !REF.test(value)) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//') || value.endsWith('/') || value.endsWith('.') || value === '@') return false;
  return value.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

export const isSafeRemote = (value: unknown): value is string => typeof value === 'string' && value.length <= 100 && REMOTE.test(value) && !value.includes('..');

export const isRequestId = (value: unknown): value is string => typeof value === 'string' && REQUEST_ID.test(value);

/**
 * A path inside the repository, as git prints it: relative, forward slashes, no "..", no control characters, no ".git" part
 * (on Windows also no 8.3 alias, trailing dot or space, or stream name).
 * Returns the normalized path or null. (Backslashes are separators on Windows only.)
 */
export function normalizeRepoPath(value: unknown, windows = false): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  const path = windows ? value.replace(/\\/g, '/') : value;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split('/');
  const last = parts.length - 1;
  for (let i = 0; i <= last; i++) {
    const part = parts[i];
    if (part === '' && i === last && i > 0) continue; // trailing "/" of a folder
    if (part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git') return null;
    if (windows) {
      // NTFS: ".git." and ".git " name the .git folder, "GIT~1" is its 8.3 alias, "a:stream" is an alternate data stream.
      if (/[:~]\d|:/.test(part) || /[. ]$/.test(part) || part.replace(/[. ]+$/, '').toLowerCase() === '.git') return null;
    }
  }
  return path;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null | undefined =>
  value === undefined ? undefined : typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : null;

function worktreeOf(req: Record<string, unknown>): Checked<string | undefined> {
  const value = text(req.worktree, 1000);
  if (value === null) return bad('Nieprawidłowe żądanie git.');
  return { ok: true, value: value || undefined };
}

export type GitChannel = 'status' | 'log' | 'show' | 'diff' | 'branches' | 'fetch' | 'pull' | 'push' | 'stage' | 'unstage' | 'commit' | 'checkout' | 'trust' | 'trustGrant' | 'trustRevoke';

export const MUTATING_CHANNELS: ReadonlySet<GitChannel> = new Set(['fetch', 'pull', 'push', 'stage', 'unstage', 'commit', 'checkout', 'trustGrant', 'trustRevoke']);

export interface GitRequestMap {
  status: GitStatusRequest; log: GitLogRequest; show: GitShowRequest; diff: GitDiffRequest; branches: GitBranchesRequest;
  fetch: GitFetchRequest; pull: GitPullRequest; push: GitPushRequest; stage: GitPathsRequest; unstage: GitPathsRequest;
  commit: GitCommitRequest; checkout: GitCheckoutRequest; trust: GitTrustRequest; trustGrant: GitTrustGrantRequest; trustRevoke: GitTrustGrantRequest;
}

/** Checks (and normalizes) what the renderer sent for a channel: unknown fields are dropped, every value is bounds-checked. */
export function validateGitRequest<C extends GitChannel>(channel: C, input: unknown, windows = false): Checked<GitRequestMap[C]> {
  const invalid = bad('Nieprawidłowe żądanie git.');
  if (!isObject(input)) return invalid;
  const worktree = worktreeOf(input);
  if (!worktree.ok) return invalid;
  const base: Base = worktree.value ? { worktree: worktree.value } : {};
  const done = (value: unknown): Checked<GitRequestMap[C]> => ({ ok: true, value: value as GitRequestMap[C] });
  const requestId = (): string | null => (isRequestId(input.requestId) ? input.requestId : null);

  switch (channel) {
    case 'status':
    case 'branches':
      return done(base);
    case 'trust':
      if (input.cached !== undefined && typeof input.cached !== 'boolean') return invalid;
      return done(input.cached ? { ...base, cached: true } : base);
    case 'log': {
      const skip = input.skip ?? 0;
      const count = input.count ?? GIT_LOG_PAGE;
      if (typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0 || skip > GIT_LOG_MAX_SKIP) return invalid;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > GIT_LOG_MAX_PAGE) return invalid;
      const search = text(input.search, 200);
      const author = text(input.author, 100);
      if (search === null || author === null) return invalid;
      let path: string | undefined;
      if (input.path !== undefined && input.path !== '') {
        const normalized = normalizeRepoPath(input.path, windows);
        if (!normalized) return invalid;
        path = normalized;
      }
      if (input.all !== undefined && typeof input.all !== 'boolean') return invalid;
      return done({ ...base, skip, count, ...(search ? { search } : {}), ...(author ? { author } : {}), ...(path ? { path } : {}), ...(input.all ? { all: true } : {}) });
    }
    case 'show':
      return isCommitHash(input.hash) ? done({ ...base, hash: input.hash }) : invalid;
    case 'diff': {
      const source = input.source;
      if (source !== 'working' && source !== 'staged' && source !== 'commit' && source !== 'untracked') return invalid;
      const path = normalizeRepoPath(input.path, windows);
      if (!path) return invalid;
      let oldPath: string | undefined;
      if (input.oldPath !== undefined) {
        const normalized = normalizeRepoPath(input.oldPath, windows);
        if (!normalized) return invalid;
        oldPath = normalized;
      }
      if (source === 'commit' && !isCommitHash(input.hash)) return invalid;
      return done({ ...base, source, path, ...(oldPath ? { oldPath } : {}), ...(source === 'commit' ? { hash: input.hash } : {}) });
    }
    case 'fetch':
    case 'pull':
    case 'trustGrant':
    case 'trustRevoke': {
      const id = requestId();
      return id ? done({ ...base, requestId: id }) : invalid;
    }
    case 'push': {
      const id = requestId();
      if (!id || !isSafeRemote(input.remote) || !isSafeRef(input.branch) || typeof input.urlId !== 'string' || !/^[0-9a-f]{16}$/.test(input.urlId)) return invalid;
      return done({ ...base, requestId: id, remote: input.remote, branch: input.branch, urlId: input.urlId });
    }
    case 'stage':
    case 'unstage': {
      const id = requestId();
      if (!id) return invalid;
      const all = input.all === true;
      if (input.all !== undefined && typeof input.all !== 'boolean') return invalid;
      const list = Array.isArray(input.paths) ? input.paths : input.paths === undefined && all ? [] : null;
      if (!list || list.length > GIT_MAX_PATHS || (!all && list.length === 0)) return invalid;
      const paths: string[] = [];
      for (const entry of list) {
        const normalized = normalizeRepoPath(entry, windows);
        if (!normalized) return invalid;
        paths.push(normalized);
      }
      return done({ ...base, requestId: id, paths, ...(all ? { all: true } : {}) });
    }
    case 'commit': {
      const id = requestId();
      const message = text(input.message, GIT_MESSAGE_LIMIT);
      if (!id || typeof message !== 'string' || !message.trim()) return invalid;
      return done({ ...base, requestId: id, message });
    }
    case 'checkout': {
      const id = requestId();
      if (!id || !isSafeRef(input.branch)) return invalid;
      if (input.remote !== undefined && typeof input.remote !== 'boolean') return invalid;
      return done({ ...base, requestId: id, branch: input.branch, ...(input.remote ? { remote: true } : {}) });
    }
    default:
      return invalid;
  }
}

// ---------- output text ----------

/** Removes credentials from text that came from git (a remote URL with a user and password or token). */
export function redactSecrets(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/(authorization:\s*(?:basic|bearer|token)\s+)\S+/gi, '$1***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, '***');
}

/**
 * What the user sees of git's output: no credentials, no ANSI, no "hint:" advice lines (unless they are all there is), collapsed
 * blank lines, the tail when it is long.
 */
export function trimGitText(value: string, max = 600): string {
  // eslint-disable-next-line no-control-regex
  const clean = redactSecrets(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  const withoutHints = clean.split('\n').filter((line) => !/^hint:/i.test(line)).join('\n');
  const text = (withoutHints.trim() ? withoutHints : clean).replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? `…${text.slice(text.length - max).trimStart()}` : text;
}

// ---------- parsers ----------

/** Splits `n` space separated fields off the start of a record; the rest (a path that may hold spaces) is the last element. */
function fields(record: string, n: number): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < n; i++) {
    const space = record.indexOf(' ', from);
    if (space < 0) return [];
    out.push(record.slice(from, space));
    from = space + 1;
  }
  out.push(record.slice(from));
  return out;
}

export interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  head: string;
  initial: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  truncated: boolean;
}

/** `git status --porcelain=v2 --branch -z` */
export function parseStatusV2(stdout: string, limit = GIT_MAX_FILES): ParsedStatus {
  const out: ParsedStatus = { branch: null, detached: false, head: '', initial: false, upstream: null, ahead: 0, behind: 0, files: [], truncated: false };
  const records = stdout.split('\0');
  const add = (file: GitFileChange): void => {
    if (out.files.length >= limit) out.truncated = true;
    else out.files.push(file);
  };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') { out.initial = value === '(initial)'; out.head = out.initial ? '' : value.slice(0, 7); }
      else if (key === 'branch.head') { out.detached = value === '(detached)'; out.branch = out.detached ? null : value; }
      else if (key === 'branch.upstream') out.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
      }
      continue;
    }
    const kind = record[0];
    if (kind === '1') {
      const f = fields(record, 8);
      if (f.length === 9) add(change(f[8], f[1]));
    } else if (kind === '2') {
      const f = fields(record, 9);
      const origPath = records[++i] ?? '';
      if (f.length === 10) add({ ...change(f[9], f[1]), origPath });
    } else if (kind === 'u') {
      const f = fields(record, 10);
      if (f.length === 11) add({ path: f[10], x: f[1][0] ?? 'U', y: f[1][1] ?? 'U', staged: false, unstaged: false, untracked: false, conflict: true });
    } else if (kind === '?') {
      add({ path: record.slice(2), x: '?', y: '?', staged: false, unstaged: false, untracked: true, conflict: false });
    }
    // "!" (ignored) is not requested; anything else is a record of a newer git that this panel does not know
  }
  return out;
}

function change(path: string, xy: string): GitFileChange {
  const x = xy[0] === '.' ? ' ' : xy[0];
  const y = xy[1] === '.' ? ' ' : xy[1];
  return { path, x, y, staged: x !== ' ', unstaged: y !== ' ', untracked: false, conflict: false };
}

/** The ref list of `%D` printed with `--decorate=full`: "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main". */
export function parseRefs(value: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const raw of value.split(', ')) {
    const item = raw.trim();
    if (!item) continue;
    if (item === 'HEAD') { refs.push({ name: 'HEAD', kind: 'head', current: true }); continue; }
    const current = item.startsWith('HEAD -> ');
    const full = current ? item.slice(8) : item;
    if (full.startsWith('tag: refs/tags/')) refs.push({ name: full.slice(15), kind: 'tag' });
    else if (full.startsWith('refs/heads/')) refs.push({ name: full.slice(11), kind: 'branch', ...(current ? { current: true } : {}) });
    else if (full.startsWith('refs/remotes/')) { const name = full.slice(13); if (!name.endsWith('/HEAD')) refs.push({ name, kind: 'remote' }); }
    // refs/stash, refs/notes ... stay out of the list
  }
  return refs;
}

/** The `--format` the log and the details use; parsed by `parseCommit`. */
export const LOG_FORMAT = '%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s';

export function parseCommit(record: string): GitCommit | null {
  const f = record.split('\x1f');
  if (f.length < 7 || !isCommitHash(f[0])) return null;
  return {
    hash: f[0], short: f[1], parents: f[2] ? f[2].split(' ').filter(Boolean) : [], author: f[3],
    at: Number(f[4]) || 0, refs: parseRefs(f[5]), subject: f.slice(6).join('\x1f'),
  };
}

/** `git log -z --format=LOG_FORMAT`: commits are terminated by NUL. */
export function parseLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of stdout.split('\0')) {
    const commit = record.trim() ? parseCommit(record.replace(/^\n+/, '')) : null;
    if (commit) commits.push(commit);
  }
  return commits;
}

/** `git show -s --format=DETAILS_FORMAT`: the commit line fields, the e-mail and the full message. */
export const DETAILS_FORMAT = `${LOG_FORMAT}%x1f%ae%x1f%B`;

export function parseDetails(stdout: string): { commit: GitCommit; email: string; message: string } | null {
  const f = stdout.split('\x1f');
  if (f.length < 9) return null;
  const commit = parseCommit(f.slice(0, 7).join('\x1f'));
  if (!commit) return null;
  return { commit, email: f[7], message: f.slice(8).join('\x1f').replace(/\s+$/, '').replace(/\r\n/g, '\n') };
}

/** `git diff-tree -r -z --raw --numstat`: the raw records first (":modes... S" NUL path [NUL newpath]), then the numstat records. */
export function parseDiffTree(stdout: string, limit = GIT_COMMIT_FILE_LIMIT): { files: GitCommitFile[]; truncated: boolean } {
  const tokens = stdout.split('\0');
  const raw: Array<{ status: string; path: string; origPath?: string }> = [];
  const stats: Array<{ added: number | null; deleted: number | null }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith(':')) {
      const status = token.slice(token.lastIndexOf(' ') + 1);
      const letter = status[0] ?? 'M';
      if (letter === 'R' || letter === 'C') { const origPath = tokens[++i] ?? ''; raw.push({ status: letter, origPath, path: tokens[++i] ?? '' }); }
      else raw.push({ status: letter, path: tokens[++i] ?? '' });
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
    if (!m) continue;
    stats.push({ added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
    if (m[3] === '') i += 2; // a rename: the old and the new path follow as separate records
  }
  const files = raw.map((entry, index) => ({ ...entry, added: stats[index]?.added ?? null, deleted: stats[index]?.deleted ?? null }));
  return { files: files.slice(0, limit), truncated: files.length > limit };
}

/** `git for-each-ref` with the format of `BRANCH_FORMAT`. */
export const BRANCH_FORMAT = '%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)';

export function parseBranches(stdout: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of stdout.split('\n')) {
    const f = line.replace(/\r$/, '').split('\x1f');
    if (f.length < 6) continue;
    const remote = f[0].startsWith('refs/remotes/');
    if (!remote && !f[0].startsWith('refs/heads/')) continue;
    if (remote && (f[1].endsWith('/HEAD') || !f[1].includes('/'))) continue; // origin/HEAD, or the bare remote name git prints for it
    branches.push({ name: f[1], hash: f[2], current: f[5] === '*', remote, upstream: f[3] || null, track: f[4] });
  }
  return branches;
}

/** `git worktree list --porcelain` */
export function parseWorktrees(stdout: string): GitWorktree[] {
  const list: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const line of stdout.split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), branch: null, head: '', main: list.length === 0, detached: false, allowed: true, isProject: false, preferred: false };
      list.push(current);
    } else if (current) {
      if (line.startsWith('HEAD ')) current.head = line.slice(5, 12);
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'detached') current.detached = true;
    }
  }
  return list.filter((w) => w.path);
}

// ---------- unified diff ----------

export interface DiffLine { kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx' | 'note'; text: string; oldNo?: number; newNo?: number }

/** Lines of a unified diff with their kind and line numbers; the header lines (diff --git, index, ---, +++) are folded into `header`. */
export function parseUnifiedDiff(value: string, maxLines = GIT_DIFF_LINES): { lines: DiffLine[]; header: string[]; binary: boolean; cut: boolean } {
  const lines: DiffLine[] = [];
  const header: string[] = [];
  let binary = false;
  let cut = false;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const all = value.split('\n');
  if (all[all.length - 1] === '') all.pop();
  for (const rawLine of all) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (lines.length >= maxLines) { cut = true; break; }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); inHunk = true; }
      lines.push({ kind: 'hunk', text: line });
    } else if (!inHunk && /^(diff --git|index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |copy |dissimilarity)/.test(line)) {
      header.push(line);
    } else if (/^Binary files .* differ$|^GIT binary patch/.test(line)) {
      binary = true;
      lines.push({ kind: 'note', text: line });
    } else if (!inHunk) {
      lines.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith('\\')) {
      lines.push({ kind: 'note', text: line.slice(2) });
    } else if (line.startsWith('diff --git')) {
      inHunk = false;
      header.push(line);
    } else {
      lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return { lines, header, binary, cut };
}

// ---------- commit graph ----------

export interface GraphRow {
  /** Column of the commit's dot. */
  col: number;
  /** Lanes (commit hash each one waits for) above and below the row's centre. */
  top: Array<string | null>;
  bottom: Array<string | null>;
  /** Lanes below that start at the dot (the first parent continues the dot's lane, the others branch off to a lane). */
  fromDot: number[];
  /** Lanes above that end at the dot. */
  toDot: number[];
}

/**
 * A thin commit graph from parents: one row per commit, lanes carried from row to row. Cheap (linear in rows x lanes) and
 * tolerant of the loaded part of the history being cut off (a parent that never shows up just ends its lane at the bottom).
 */
export function layoutGraph(commits: ReadonlyArray<Pick<GitCommit, 'hash' | 'parents'>>): GraphRow[] {
  const rows: GraphRow[] = [];
  let lanes: Array<string | null> = [];
  for (const commit of commits) {
    const top = lanes.slice();
    const waiting = lanes.flatMap((hash, i) => (hash === commit.hash ? [i] : []));
    let col = waiting[0] ?? lanes.indexOf(null);
    if (col < 0) col = lanes.length;
    const next = lanes.slice();
    while (next.length <= col) next.push(null);
    for (const i of waiting) next[i] = null;
    const fromDot: number[] = [];
    const [first, ...others] = commit.parents;
    if (first !== undefined) {
      const existing = next.indexOf(first);
      if (existing >= 0 && existing !== col) fromDot.push(existing);
      else { next[col] = first; fromDot.push(col); }
    }
    for (const parent of others) {
      let lane = next.indexOf(parent);
      if (lane < 0) { lane = next.indexOf(null); if (lane < 0) lane = next.length; next[lane] = parent; }
      if (!fromDot.includes(lane)) fromDot.push(lane);
    }
    while (next.length && next[next.length - 1] === null) next.pop();
    rows.push({ col, top, bottom: next.slice(), fromDot, toDot: waiting });
    lanes = next;
  }
  return rows;
}

// ---------- paths shown in the panel ----------

/**
 * The path of a repository file relative to the project folder (forward slashes), or null when the file is outside the project.
 * `relation` comes from main (canonical paths), so a project reached through a short name, a link or another letter case works.
 */
export function projectRelativePath(relation: GitProjectRelation | null, file: string, windows = false): string | null {
  if (!relation) return null;
  const clean = file.replace(/\/+$/, '');
  if (relation.kind === 'contains-root') return relation.prefix ? `${relation.prefix}/${clean}` : clean;
  if (!relation.prefix) return clean;
  const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const prefix = `${relation.prefix}/`;
  return clean.length > prefix.length && same(clean.slice(0, prefix.length), prefix) ? clean.slice(prefix.length) : null;
}

/**
 * May the project use this worktree? Inside the project folder, next to it as one the app made (`<project>-wt-<name>`), or one of the
 * worktrees its cells already use. Any other worktree of the repository (a checkout elsewhere on the disk) is listed but not selectable.
 */
export function worktreeAllowed(projectPath: string, worktreePath: string, extra: readonly string[] = []): boolean {
  const base = normalizeProjectPath(projectPath);
  const wt = normalizeProjectPath(worktreePath);
  if (wt === base || wt.startsWith(`${base}/`)) return true;
  if (extra.some((path) => normalizeProjectPath(path) === wt)) return true;
  const slash = base.lastIndexOf('/');
  const parent = base.slice(0, slash);
  const name = base.slice(slash + 1);
  return wt.startsWith(`${parent}/${name}-wt-`) && !wt.slice(parent.length + 1).includes('/');
}
