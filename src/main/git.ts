// The Git panel's engine: the system `git`, started without a shell, always inside a repository folder the caller resolved, with
// timeouts, output caps and a quiet environment (nothing may wait for a terminal). Every argument that comes from the renderer was
// validated by shared/git.ts before it gets here, and the ones that could still look like an option go behind "--" or travel on
// stdin (paths, commit messages).
//
// Trust: a repository's own configuration (filters, hooks, fsmonitor, ssh command ...) can name programs that git runs during
// status, add, commit, fetch ... Opening a hostile repository must not run them, so every operation that can start such a program is
// refused until the user explicitly trusts the repository (see `scan` and `GitTrustStore`); only reads that were measured to start
// nothing (log, show, branches, commit and staged diffs, worktree list) work without trust.
import { execFile, spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { realpath as fsRealpath } from 'fs';
import { promisify } from 'util';
import { dirname, join, resolve } from 'path';
import { cleanEnv } from '../shared/env';
import {
  BRANCH_FORMAT, DETAILS_FORMAT, GIT_COMMIT_FILE_LIMIT, GIT_MAX_FILES, LOG_FORMAT, isSafeRef, isSafeRemote, parseBranches, parseDetails,
  parseDiffTree, parseLog, parseStatusV2, parseWorktrees, redactSecrets, trimGitText, worktreeAllowed,
  type GitBranch, type GitCheckoutRequest, type GitCommitDetails, type GitCommitRequest, type GitDiffRequest, type GitDiffResult,
  type GitErrorCode, type GitLogPage, type GitLogRequest, type GitOpResult, type GitPathsRequest, type GitProbe, type GitPushRequest,
  type GitPushTarget, type GitResult, type GitStatus, type GitTrustInfo, type GitWorktree,
} from '../shared/git';
import { canonicalPath, isInsidePath, relativeInside, samePath } from './gitPaths';
import { pathExists } from './fsProbe';
import { atomicWriteFileSync } from './atomicWrite';
import { attributeDrivers, configuredAttributeDrivers, dangerousConfigKeys, parseConfigList, type ConfigEntry } from '../shared/gitTrust';
import { githubAuthRefused } from './github/gitEnv';

export interface GitOptions {
  /** The executable (default "git"); tests point it at a stand-in. */
  bin?: string;
  /** Arguments that go before git's own (a stand-in script). */
  prefixArgs?: string[];
  /** Replaces process.env as the base of the child environment. */
  env?: NodeJS.ProcessEnv;
  /** Local reads (status, log, diff ...). */
  readTimeoutMs?: number;
  /** Operations that talk to a remote, and the ones that run hooks. */
  networkTimeoutMs?: number;
  /** Cap of the output kept from one read (the command is stopped when it prints more). */
  maxOutputBytes?: number;
  /** Cap of the output kept from one write (the excess is discarded; the command is never stopped for it). */
  writeOutputBytes?: number;
  /** Where the trusted repositories are remembered (memory only when absent). */
  trustFile?: string;
  /**
   * Environment additions of fetch, pull and push: the GitHub sign-in unimux stored ("Publish to GitHub"), sent by git to
   * https://github.com only. Null when there is none. Never on the command line.
   */
  remoteAuth?: () => Record<string, string> | null;
}

export const READ_TIMEOUT_MS = 10_000;
export const NETWORK_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 4 * 1024 * 1024;
const WRITE_OUTPUT_CAP = 64 * 1024 * 1024;
const DIFF_CAP = 1024 * 1024;
const SCAN_TTL_MS = 3000;
const PUSH_TARGET_TTL_MS = 30_000;
/** Per-folder caches of a long session (many projects and worktrees) keep at most this many entries, the oldest go first. */
const CACHE_LIMIT = 100;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value as K);
}

const INSTALL_HINT = 'Nie znaleziono polecenia git. Zainstaluj Git (git-scm.com) i uruchom aplikację ponownie.';
const UNTRUSTED = 'To repozytorium ma w konfiguracji programy, które git może uruchomić. Zaufaj mu, aby użyć tej operacji.';
const NOT_REPO = 'To nie jest repozytorium git.';

class GitFailure extends Error {
  constructor(readonly code: GitErrorCode, message: string) { super(message); }
}

interface RunOptions {
  timeoutMs: number;
  maxBytes?: number;
  input?: string;
  /** Local read: no optional locks; its output is capped (the command is stopped) and a truncated result is an error unless allowed. */
  read?: boolean;
  /** A read whose caller copes with a cut-off result (it says so to the user). */
  allowTruncate?: boolean;
  /** Exit codes besides 0 that are an answer, not a failure (diff --no-index exits 1 when there is a difference). */
  okCodes?: number[];
  /** Variables added to the quiet environment of this run (the credentials of a network operation). */
  env?: Record<string, string>;
}

interface RunOutput { code: number; stdout: string; stderr: string; truncated: boolean }

const ok = <T>(data: T): GitResult<T> => ({ ok: true, data });
const fail = (code: GitErrorCode, error: string): GitResult<never> => ({ ok: false, code, error });

/** Ends the process and what it started (a credential helper or ssh keeps the pipes open after git itself is gone); resolves once it is done. */
function killTree(child: ChildProcess): Promise<void> {
  try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
  return new Promise((done) => {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => done());
      return;
    }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    done();
  });
}

/** Variables that would point git at another repository, index or configuration than the folder we run it in. */
export const SCRUBBED_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_PREFIX|GIT_CONFIG|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS)$/i;

/** Resolves links and 8.3 short names, like the canonical spelling of folders does (the plain fs.promises version leaves short names alone on some systems). */
const realpath = promisify(fsRealpath.native);
const caseFold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);

/** The repositories the user trusted: root -> fingerprint of the configuration that was trusted. */
export class GitTrustStore {
  private readonly map = new Map<string, string>();

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') this.map.set(key, value);
    } catch { /* first start, or a damaged file: nothing is trusted */ }
  }

  private key = (root: string): string => canonicalPath(root);
  get(root: string): string | undefined { return this.map.get(this.key(root)); }
  set(root: string, hash: string): void { this.map.set(this.key(root), hash); this.save(); }
  delete(root: string): void { if (this.map.delete(this.key(root))) this.save(); }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      atomicWriteFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2));
    } catch { /* trust then lasts until the app closes */ }
  }
}

interface RepoScan { keys: string[]; hash: string }
interface GitDirs { gitDir: string; commonDir: string }

export class Git {
  private readonly bin: string;
  private readonly prefix: string[];
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly readTimeout: number;
  private readonly networkTimeout: number;
  private readonly cap: number;
  private readonly writeCap: number;
  private readonly busy = new Set<string>();
  private readonly seen = new Map<string, number>();
  private readonly roots = new Map<string, { root: string; at: number }>();
  private readonly dirs = new Map<string, GitDirs>();
  private readonly scans = new Map<string, { scan: RepoScan; at: number }>();
  /** Where a push of a branch goes, per root and branch, while the local configuration file is unchanged (status only). */
  private readonly pushTargets = new Map<string, { target: GitPushTarget | null; at: number; stamp: string }>();
  /** The remote names per root while the local configuration file is unchanged (status only). */
  private readonly remoteLists = new Map<string, { names: string[]; at: number; stamp: string }>();
  private readonly remoteAuth?: () => Record<string, string> | null;
  /** Identical reads that are still running (a window focus asks the Files tree and the Git panel at once): they share one run. */
  private readonly inflight = new Map<string, Promise<GitResult<unknown>>>();
  /** Bumped by every write and trust change: part of the key of shared reads. */
  private generation = 0;
  readonly trust: GitTrustStore;

  constructor(options: GitOptions = {}) {
    this.bin = options.bin ?? 'git';
    this.prefix = options.prefixArgs ?? [];
    this.baseEnv = options.env ?? process.env;
    this.readTimeout = options.readTimeoutMs ?? READ_TIMEOUT_MS;
    this.networkTimeout = options.networkTimeoutMs ?? NETWORK_TIMEOUT_MS;
    this.cap = options.maxOutputBytes ?? OUTPUT_CAP;
    this.writeCap = options.writeOutputBytes ?? WRITE_OUTPUT_CAP;
    this.trust = new GitTrustStore(options.trustFile);
    this.remoteAuth = options.remoteAuth;
  }

  // ---------- running git ----------

  private env(read: boolean, cwd: string): Record<string, string> {
    const env = cleanEnv(this.baseEnv);
    for (const key of Object.keys(env)) if (SCRUBBED_ENV.test(key)) delete env[key];
    // The user's own global configuration stays; one that lives inside the repository folder would be repository content.
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_GLOBAL$/i.test(key) && isInsidePath(cwd, env[key])) delete env[key];
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'never';
    env.GIT_EDITOR = 'true';
    env.GIT_SEQUENCE_EDITOR = 'true';
    env.GIT_MERGE_AUTOEDIT = 'no';
    env.GIT_PAGER = 'cat';
    if (read) env.GIT_OPTIONAL_LOCKS = '0';
    return env;
  }

  private args(args: string[]): string[] {
    // fsmonitor names a program in the repository's config that even `status` would start; showSignature would call gpg for log.
    const global = [
      '--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'protocol.ext.allow=never',
      '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false',
    ];
    return [...this.prefix, ...global, ...args];
  }

  private run(cwd: string, args: string[], options: RunOptions): Promise<RunOutput> {
    const read = options.read ?? false;
    const cap = read ? options.maxBytes ?? this.cap : this.writeCap;
    const started = Date.now();
    return new Promise<RunOutput>((resolveRun, reject) => {
      let settled = false;
      let timedOut = false;
      let stoppedForSize = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (action: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); action(); } };
      const spawnFailure = (error: unknown): GitFailure => {
        const e = error as NodeJS.ErrnoException;
        return e.code === 'ENOENT' ? new GitFailure('no-git', INSTALL_HINT) : new GitFailure('failed', trimGitText(e.message ?? String(error)));
      };
      let child: ChildProcess;
      try {
        child = spawn(this.bin, this.args(args), { cwd, env: { ...this.env(read, cwd), ...options.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { reject(spawnFailure(error)); return; }

      const chunks: Buffer[][] = [[], []];
      const sizes = [0, 0];
      let truncated = false;
      const collect = (index: 0 | 1) => (chunk: Buffer): void => {
        const room = Math.max(0, cap - sizes[index]);
        if (room > 0) { const part = chunk.length > room ? chunk.subarray(0, room) : chunk; chunks[index].push(part); sizes[index] += part.length; }
        if (chunk.length > room) {
          truncated = true;
          // A read is stopped when it prints more than it may; a write is never stopped for its output (that could leave a lock behind).
          if (read && !stoppedForSize) { stoppedForSize = true; void killTree(child); }
        }
      };
      child.stdout?.on('data', collect(0));
      child.stderr?.on('data', collect(1));
      child.on('error', (error) => finish(() => reject(spawnFailure(error))));
      child.on('close', (code) => {
        if (timedOut) return;
        finish(() => {
          const stdout = Buffer.concat(chunks[0]).toString('utf8');
          const stderr = Buffer.concat(chunks[1]).toString('utf8');
          const exit = code ?? -1;
          if (stoppedForSize) {
            if (options.allowTruncate) resolveRun({ code: 0, stdout, stderr, truncated: true });
            else reject(new GitFailure('too-large', 'Wynik polecenia git jest zbyt duży.'));
          } else if (exit === 0 || options.okCodes?.includes(exit)) resolveRun({ code: exit, stdout, stderr, truncated });
          else reject(new GitFailure('failed', trimGitText(stderr || stdout || `git: ${exit}`)));
        });
      });
      timer = setTimeout(() => {
        timedOut = true;
        void (async () => {
          await killTree(child);
          if (!read) this.releaseStaleLock(cwd, started);
          finish(() => reject(new GitFailure('timeout', 'Git nie odpowiedział w wyznaczonym czasie.')));
        })();
      }, options.timeoutMs);
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input ?? '');
    });
  }

  /**
   * A write we had to kill may leave `index.lock` behind, which blocks every later git command of the user. We hold the repository's
   * write lock, so no other process of ours can own it: a lock created since this operation started is ours and goes away.
   */
  private releaseStaleLock(cwd: string, startedAt: number): void {
    try {
      const dirs = this.dirs.get(cwd);
      if (!dirs) return;
      const lock = join(dirs.gitDir, 'index.lock');
      if (statSync(lock).mtimeMs >= startedAt - 2000) unlinkSync(lock);
    } catch { /* no lock, or it is not ours to remove */ }
  }

  /** Runs `work` once for every caller that asks for the same `key` while it is still running. */
  private shared<T>(key: string, work: () => Promise<GitResult<T>>): Promise<GitResult<T>> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<GitResult<T>>;
    const promise = work().finally(() => { if (this.inflight.get(key) === promise) this.inflight.delete(key); });
    this.inflight.set(key, promise);
    return promise;
  }

  private async attempt<T>(work: () => Promise<GitResult<T>>): Promise<GitResult<T>> {
    try { return await work(); }
    catch (error) {
      if (error instanceof GitFailure) return fail(error.code, error.message);
      return fail('failed', trimGitText(error instanceof Error ? error.message : String(error)));
    }
  }

  /** The repository root of a folder (git's spelling); cached for a few seconds. Throws not-repo / no-git. */
  private async root(dir: string): Promise<string> {
    const cached = this.roots.get(dir);
    if (cached && Date.now() - cached.at < 5000) return cached.root;
    if (!(await pathExists(dir))) throw new GitFailure('gone', 'Folder już nie istnieje.');
    let out: RunOutput;
    try { out = await this.run(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: this.readTimeout, read: true }); }
    catch (error) {
      if (error instanceof GitFailure && error.code === 'failed' && !/dubious ownership/i.test(error.message)) throw new GitFailure('not-repo', NOT_REPO);
      throw error;
    }
    const root = out.stdout.trim();
    if (!root) throw new GitFailure('not-repo', NOT_REPO);
    remember(this.roots, dir, { root, at: Date.now() });
    return root;
  }

  /** The git directory of this checkout and the one it shares with its other worktrees (config, hooks and the write lock live there). */
  private async gitDirs(root: string): Promise<GitDirs> {
    const known = this.dirs.get(root);
    if (known) return known;
    const out = await this.run(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir'], { timeoutMs: this.readTimeout, read: true });
    const [gitDir = '', common = ''] = out.stdout.split('\n').map((line) => line.trim());
    if (!gitDir) throw new GitFailure('not-repo', NOT_REPO);
    const dirs = { gitDir, commonDir: resolve(root, common || gitDir) };
    remember(this.dirs, root, dirs);
    return dirs;
  }

  // ---------- trust ----------

  /** Reads (and starts) nothing from the repository: its local configuration, attributes files and hooks, as a list of risky keys. */
  private async scan(root: string, fresh: boolean): Promise<RepoScan> {
    const cached = this.scans.get(root);
    if (!fresh && cached && Date.now() - cached.at < SCAN_TTL_MS) return cached.scan;
    const dirs = await this.gitDirs(root);
    const fingerprint: string[] = [];
    const keys = new Set<string>();

    const local: ConfigEntry[] = parseConfigList((await this.run(root, ['config', '--local', '--list', '-z'], { timeoutMs: this.readTimeout, read: true, allowTruncate: true })).stdout);
    try { local.push(...parseConfigList((await this.run(root, ['config', '--worktree', '--list', '-z'], { timeoutMs: this.readTimeout, read: true, allowTruncate: true })).stdout)); }
    catch { /* no per-worktree configuration */ }
    const risky = new Set(dangerousConfigKeys(local));
    for (const key of risky) keys.add(key);
    for (const entry of local) if (risky.has(redactSecrets(entry.key))) fingerprint.push(`config:${entry.key}=${entry.value}`);

    // Attributes naming a driver that some configuration defines with a program (a hostile .gitattributes can use a global driver).
    const attributes: Array<{ kind: 'filter' | 'diff' | 'merge'; name: string }> = [];
    for (const file of [join(root, '.gitattributes'), join(dirs.commonDir, 'info', 'attributes')]) {
      try { if (statSync(file).size <= 256 * 1024) attributes.push(...attributeDrivers(readFileSync(file, 'utf8'))); } catch { /* none */ }
    }
    if (attributes.length) {
      const everything = parseConfigList((await this.run(root, ['config', '--list', '-z'], { timeoutMs: this.readTimeout, read: true, allowTruncate: true })).stdout);
      for (const key of configuredAttributeDrivers(attributes, everything)) { keys.add(key); fingerprint.push(`attr:${key}`); }
    }

    // Hooks git would run: any file that is not a ".sample" (on Windows git runs a hook by its shebang, so the executable bit says nothing).
    // Read without blocking the main process (a hooks folder can sit on a slow or scanned drive).
    try {
      for (const name of await readdir(join(dirs.commonDir, 'hooks'))) {
        if (name.endsWith('.sample')) continue;
        const file = join(dirs.commonDir, 'hooks', name);
        const info = await stat(file);
        if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o111) === 0)) continue;
        keys.add(`hooks/${name}`);
        fingerprint.push(`hook:${name}:${createHash('sha256').update(info.size <= 1024 * 1024 ? await readFile(file) : String(info.size)).digest('hex')}`);
      }
    } catch { /* no hooks folder */ }

    const scan = { keys: [...keys].sort(), hash: createHash('sha256').update(JSON.stringify(fingerprint.sort())).digest('hex') };
    remember(this.scans, root, { scan, at: Date.now() });
    return scan;
  }

  private async stateOf(root: string, fresh: boolean): Promise<{ state: GitTrustInfo['state']; scan: RepoScan }> {
    const scan = await this.scan(root, fresh);
    if (!scan.keys.length) return { state: 'safe', scan };
    return { state: this.trust.get(root) === scan.hash ? 'trusted' : 'untrusted', scan };
  }

  /** Throws unless git may start the repository's programs (nothing to start, or the user trusted exactly this configuration). */
  private async requireTrust(root: string, fresh: boolean): Promise<void> {
    if ((await this.stateOf(root, fresh)).state === 'untrusted') throw new GitFailure('untrusted', UNTRUSTED);
  }

  /** Is the repository's root the project folder or inside it? A larger repository around the project must never be written to. */
  private withinScope(scope: string, root: string): boolean {
    return isInsidePath(scope, root);
  }

  /**
   * The trust state for the panel and the Files tree. `cached` (display only) accepts a scan of the last SCAN_TTL_MS; the trust
   * dialog and every git run that can start a repository program scan for themselves.
   */
  trustInfo(dir: string, scope?: string, cached = false): Promise<GitResult<GitTrustInfo>> {
    return this.shared(`trust\0${this.generation}\0${dir}\0${scope ?? ''}\0${cached}`, () => this.readTrust(dir, scope, !cached));
  }

  private readTrust(dir: string, scope: string | undefined, fresh: boolean): Promise<GitResult<GitTrustInfo>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const { state, scan } = await this.stateOf(root, fresh);
      return ok({ state, keys: scan.keys, root, parent: scope ? !this.withinScope(scope, root) : false });
    });
  }

  /** "Trust this repository": scans again right now and remembers that exact configuration. Only the dedicated IPC calls this. */
  grantTrust(dir: string, requestId: string, scope?: string): Promise<GitResult<GitTrustInfo>> {
    return this.attempt(async () => {
      this.consume(requestId);
      const root = await this.root(dir);
      const { scan } = await this.stateOf(root, true);
      if (scan.keys.length) this.trust.set(root, scan.hash);
      this.generation++;
      return this.readTrust(dir, scope, true);
    });
  }

  revokeTrust(dir: string, requestId: string, scope?: string): Promise<GitResult<GitTrustInfo>> {
    return this.attempt(async () => {
      this.consume(requestId);
      this.trust.delete(await this.root(dir));
      this.generation++;
      return this.readTrust(dir, scope, true);
    });
  }

  private consume(requestId: string): void {
    const now = Date.now();
    for (const [id, at] of this.seen) if (now - at > 10 * 60_000) this.seen.delete(id);
    if (this.seen.has(requestId)) throw new GitFailure('invalid', 'To żądanie zostało już wykonane.');
    this.seen.set(requestId, now);
  }

  // ---------- reads that start nothing ----------

  async probe(dir: string): Promise<GitProbe> {
    try { await this.root(dir); return 'repo'; }
    catch (error) { return error instanceof GitFailure && error.code === 'no-git' ? 'no-git' : 'no-repo'; }
  }

  /**
   * The repository's worktrees; those the project may use are marked `allowed`, the project's own folder `isProject`, and the one equal
   * to `prefer` (the focused cell's worktree) `preferred`. All comparisons use the canonical spelling of the folders.
   */
  worktrees(dir: string, projectPath?: string, extra: readonly string[] = [], prefer?: string): Promise<GitResult<GitWorktree[]>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const out = await this.run(root, ['worktree', 'list', '--porcelain'], { timeoutMs: this.readTimeout, read: true, allowTruncate: true });
      const project = projectPath ? canonicalPath(projectPath) : undefined;
      const extras = extra.map((path) => canonicalPath(path));
      const wanted = prefer ? canonicalPath(prefer) : undefined;
      return ok(parseWorktrees(out.stdout).map((w) => {
        const real = canonicalPath(w.path);
        return { ...w, allowed: project ? worktreeAllowed(project, real, extras) : true, isProject: real === project, preferred: real === wanted };
      }));
    });
  }

  /** How the project folder and the repository root lie to each other (see GitStatus.projectRelation), by their canonical paths. */
  private relation(scope: string | undefined, root: string): GitStatus['projectRelation'] {
    if (!scope) return { kind: 'inside-root', prefix: '' };
    const inRoot = relativeInside(root, scope);
    if (inRoot !== null) return { kind: 'inside-root', prefix: inRoot };
    const rootIn = relativeInside(scope, root);
    return rootIn !== null ? { kind: 'contains-root', prefix: rootIn } : null;
  }

  /**
   * The folder to run in: the project folder, or one of the repository's worktrees named by the renderer (matched against what
   * git itself lists and limited to the ones the project may use, so no other folder can be reached this way).
   */
  async resolveDir(projectPath: string, worktree?: string, extra: readonly string[] = []): Promise<GitResult<string>> {
    if (!worktree) return ok(projectPath);
    const list = await this.worktrees(projectPath, projectPath, extra);
    if (!list.ok) return list;
    const found = list.data.find((w) => samePath(w.path, worktree));
    return found && found.allowed ? ok(found.path) : fail('invalid', 'To nie jest worktree tego repozytorium.');
  }

  log(dir: string, req: GitLogRequest): Promise<GitResult<GitLogPage>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const args = ['log', '--decorate=full', '-z', `--format=${LOG_FORMAT}`, `--max-count=${req.count + 1}`, `--skip=${req.skip}`];
      if (req.all) args.push('--all');
      if (req.search) args.push('--fixed-strings', '--regexp-ignore-case', `--grep=${req.search}`);
      if (req.author) args.push('--fixed-strings', '--regexp-ignore-case', `--author=${req.author}`);
      if (req.path) args.push('--', req.path);
      let out: RunOutput;
      try { out = await this.run(root, args, { timeoutMs: this.readTimeout, read: true, allowTruncate: true }); }
      catch (error) {
        // A repository without commits has no HEAD to walk: that is an empty history, not an error.
        if (error instanceof GitFailure && /does not have any commits|unknown revision|bad default revision/i.test(error.message)) return ok({ commits: [], hasMore: false });
        throw error;
      }
      const commits = parseLog(out.stdout);
      return ok({ commits: commits.slice(0, req.count), hasMore: commits.length > req.count });
    });
  }

  private async parentOf(root: string, hash: string): Promise<string | null> {
    try {
      const out = await this.run(root, ['rev-parse', '--verify', '--quiet', `${hash}^1^{commit}`], { timeoutMs: this.readTimeout, read: true });
      return out.stdout.trim() || null;
    } catch { return null; }
  }

  show(dir: string, hash: string): Promise<GitResult<GitCommitDetails>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      let info: RunOutput;
      try { info = await this.run(root, ['show', '-s', '--decorate=full', `--format=${DETAILS_FORMAT}`, hash, '--'], { timeoutMs: this.readTimeout, read: true, allowTruncate: true }); }
      catch (error) { if (error instanceof GitFailure && error.code === 'failed') throw new GitFailure('invalid', 'Nie ma takiego commita.'); throw error; }
      const parsed = parseDetails(info.stdout);
      if (!parsed) throw new GitFailure('failed', 'Nie udało się odczytać commita.');
      const details = { ...parsed, commit: { ...parsed.commit, subject: redactSecrets(parsed.commit.subject) }, message: redactSecrets(parsed.message) };
      // A merge is shown against its first parent (diff-tree -m would list the changes against every parent).
      const parent = details.commit.parents.length ? await this.parentOf(root, hash) : null;
      const range = parent ? [parent, hash] : ['--root', hash];
      const tree = await this.run(root, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--raw', '--numstat', '--no-ext-diff', ...range], { timeoutMs: this.readTimeout, read: true, allowTruncate: true });
      const { files, truncated } = parseDiffTree(tree.stdout, GIT_COMMIT_FILE_LIMIT);
      let added = 0;
      let deleted = 0;
      for (const file of files) { added += file.added ?? 0; deleted += file.deleted ?? 0; }
      return ok({ ...details, files, filesTruncated: truncated || tree.truncated, added, deleted });
    });
  }

  branches(dir: string): Promise<GitResult<GitBranch[]>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const out = await this.run(root, ['for-each-ref', '--count=400', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], { timeoutMs: this.readTimeout, read: true, allowTruncate: true });
      const all = parseBranches(out.stdout);
      // A remote branch that already has a local twin is not offered a second time.
      const local = new Set(all.filter((b) => !b.remote).map((b) => b.name));
      return ok(all.filter((b) => !b.remote || !local.has(b.name.slice(b.name.indexOf('/') + 1))));
    });
  }

  // ---------- reads that need trust ----------

  status(dir: string, scope?: string): Promise<GitResult<GitStatus>> {
    return this.shared(`status\0${this.generation}\0${dir}\0${scope ?? ''}`, () => this.attempt(async () => {
      const root = await this.root(dir);
      await this.requireTrust(root, false);
      const out = await this.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { timeoutMs: this.readTimeout, read: true, allowTruncate: true });
      const parsed = parseStatusV2(out.stdout, GIT_MAX_FILES);
      const push = parsed.branch && !parsed.initial ? await this.cachedPushTarget(root, parsed.branch) : null;
      const parent = scope ? !this.withinScope(scope, root) : false;
      const hasRemote = push !== null || (await this.cachedRemotes(root)).length > 0;
      return ok({ ...parsed, truncated: parsed.truncated || out.truncated, root, push, parent, projectRelation: this.relation(scope, root), hasRemote });
    }));
  }

  /**
   * The push target the status shows, remembered for PUSH_TARGET_TTL_MS while the repository's local configuration file is
   * unchanged (a changed pushurl is seen at once). A push always asks git again and compares with what the user confirmed.
   */
  private async cachedPushTarget(root: string, branch: string): Promise<GitPushTarget | null> {
    const startedAt = this.generation;
    const stamp = await this.configStamp(root);
    const key = `${root}\0${branch}`;
    const hit = this.pushTargets.get(key);
    if (hit && hit.stamp === stamp && Date.now() - hit.at < PUSH_TARGET_TTL_MS) return hit.target;
    const target = await this.pushTarget(root, branch);
    // A write (push, fetch, checkout...) that ran meanwhile dropped the cache: this older answer must not come back into it.
    if (this.generation === startedAt) remember(this.pushTargets, key, { target, at: Date.now(), stamp });
    return target;
  }

  /** Changes whenever the repository's local configuration file does (a remote added or removed, a pushurl set). */
  private async configStamp(root: string): Promise<string> {
    try {
      const { commonDir } = await this.gitDirs(root);
      const info = await stat(join(commonDir, 'config'));
      return `${info.mtimeMs}:${info.size}`;
    } catch { return 'none'; }
  }

  private async remoteNames(root: string): Promise<string[]> {
    const out = await this.run(root, ['remote'], { timeoutMs: this.readTimeout, read: true });
    return out.stdout.split('\n').map((r) => r.trim()).filter(Boolean);
  }

  /** The remotes the status reports (does the repository have any: "Publish to GitHub"), remembered like the push target. */
  private async cachedRemotes(root: string): Promise<string[]> {
    const startedAt = this.generation;
    const stamp = await this.configStamp(root);
    const hit = this.remoteLists.get(root);
    if (hit && hit.stamp === stamp && Date.now() - hit.at < PUSH_TARGET_TTL_MS) return hit.names;
    let names: string[];
    try { names = await this.remoteNames(root); } catch { return []; }
    if (this.generation === startedAt) remember(this.remoteLists, root, { names, at: Date.now(), stamp });
    return names;
  }

  /**
   * Where a push of the branch goes: its upstream, or (without one) the only remote / "origin" with the same name and --set-upstream.
   * Includes the URL git would really push to (pushurl and insteadOf rewriting applied), for the confirmation and the check at push time.
   */
  private async pushTarget(root: string, branch: string): Promise<GitPushTarget | null> {
    if (!isSafeRef(branch)) return null;
    try {
      const read = { timeoutMs: this.readTimeout, read: true };
      const out = await this.run(root, ['for-each-ref', '--format=%(upstream:remotename)%1f%(upstream:remoteref)', `refs/heads/${branch}`], read);
      const [remote = '', ref = ''] = out.stdout.trim().split('\x1f');
      let target: { remote: string; branch: string; setUpstream: boolean } | null = null;
      if (isSafeRemote(remote) && ref.startsWith('refs/heads/') && isSafeRef(ref.slice(11))) target = { remote, branch: ref.slice(11), setUpstream: false };
      else {
        const remotes = (await this.run(root, ['remote'], read)).stdout.split('\n').map((r) => r.trim()).filter(isSafeRemote);
        const chosen = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
        if (chosen) target = { remote: chosen, branch, setUpstream: true };
      }
      if (!target) return null;
      const raw = (await this.run(root, ['remote', 'get-url', '--push', target.remote], read)).stdout.trim();
      if (!raw) return null;
      return { ...target, url: redactSecrets(raw), urlId: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
    } catch { return null; }
  }

  /**
   * An untracked file may only be shown when git itself lists it as untracked, and when no part of its path is a link or an alias
   * (a junction, a symlink, an 8.3 short name such as GIT~1) that leads somewhere else than where the path says.
   */
  private async confineUntracked(root: string, path: string): Promise<void> {
    const refuse = new GitFailure('invalid', 'To nie jest nieśledzony plik tego repozytorium.');
    const listing = await this.run(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', path], { timeoutMs: this.readTimeout, read: true });
    if (!listing.stdout.split('\0').includes(path)) throw refuse;
    let current = await realpath(root);
    for (const part of path.split('/')) {
      const literal = join(current, part);
      let real: string;
      try { real = await realpath(literal); } catch { throw refuse; }
      if (caseFold(real) !== caseFold(literal)) throw refuse;
      current = real;
    }
  }

  diff(dir: string, req: GitDiffRequest): Promise<GitResult<GitDiffResult>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '-U3'];
      let args: string[];
      let okCodes: number[] | undefined;
      if (req.source === 'untracked') {
        await this.requireTrust(root, false);
        await this.confineUntracked(root, req.path);
        args = ['diff', '--no-index', ...flags, '--', '/dev/null', req.path];
        okCodes = [1];
      } else if (req.source === 'commit') {
        const parent = await this.parentOf(root, req.hash!);
        args = ['diff-tree', '-p', '-r', '-M', ...flags, ...(parent ? [parent, req.hash!] : ['--root', req.hash!]), '--', req.path];
        if (req.oldPath) args.push(req.oldPath);
      } else {
        // Comparing the work tree to the index runs the repository's clean filters; the index to HEAD does not.
        if (req.source === 'working') await this.requireTrust(root, false);
        args = ['diff', ...(req.source === 'staged' ? ['--cached'] : []), '-M', ...flags, '--', ...(req.oldPath ? [req.oldPath] : []), req.path];
      }
      const out = await this.run(root, args, { timeoutMs: this.readTimeout, read: true, maxBytes: DIFF_CAP, okCodes, allowTruncate: true });
      const text = redactSecrets(out.stdout);
      return ok({ text, truncated: out.truncated, binary: /^Binary files .* differ$|^GIT binary patch$/m.test(text) });
    });
  }

  // ---------- changes ----------

  /**
   * One mutating operation per repository (all its worktrees share the lock) at a time, one use per request id, never in a repository
   * that is larger than the project, and only in a trusted one (the configuration is scanned again for every write).
   */
  private mutate<T>(dir: string, requestId: string, scope: string | undefined, work: (root: string) => Promise<GitResult<T>>): Promise<GitResult<T>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      if (scope && !this.withinScope(scope, root)) return fail('parent', 'To repozytorium nadrzędne wobec projektu: zapisy są wyłączone.');
      await this.requireTrust(root, true);
      const key = canonicalPath((await this.gitDirs(root)).commonDir);
      this.consume(requestId);
      if (this.busy.has(key)) return fail('busy', 'Inna operacja git w tym repozytorium jeszcze trwa.');
      this.busy.add(key);
      // Reads that started before (or during) a write never answer a request made after it.
      this.generation++;
      try { return await work(root); }
      finally {
        this.busy.delete(key); this.roots.delete(dir); this.scans.delete(root); this.remoteLists.delete(root); this.generation++;
        for (const target of this.pushTargets.keys()) if (target.startsWith(`${root}\0`)) this.pushTargets.delete(target);
      }
    });
  }

  private opMessage(out: RunOutput, fallback: string): GitOpResult {
    const lines = trimGitText(`${out.stdout}\n${out.stderr}`, 400).split('\n').map((l) => l.trim()).filter((l) => l && !/^(hint|warning):/i.test(l));
    return { message: lines.slice(-2).join(' ') || fallback };
  }

  /**
   * A run that talks to a remote: with the GitHub sign-in of unimux when there is one (git sends it to https://github.com only).
   * When GitHub refuses it, the same command runs once more without it, so the user's own credential manager still answers
   * (nothing was transferred: git stops at the refused authentication).
   */
  private async network(root: string, args: string[]): Promise<RunOutput> {
    const auth = this.remoteAuth?.() ?? null;
    if (!auth) return this.run(root, args, { timeoutMs: this.networkTimeout });
    try { return await this.run(root, args, { timeoutMs: this.networkTimeout, env: auth }); }
    catch (error) {
      if (error instanceof GitFailure && error.code === 'failed' && githubAuthRefused(error.message)) return this.run(root, args, { timeoutMs: this.networkTimeout });
      throw error;
    }
  }

  fetch(dir: string, requestId: string, scope?: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, requestId, scope, async (root) => ok(this.opMessage(await this.network(root, ['fetch']), 'OK')));
  }

  /** Fast-forward only: it never creates a merge commit, never rebases and stops when the branches diverged. */
  pull(dir: string, requestId: string, scope?: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, requestId, scope, async (root) => ok(this.opMessage(await this.network(root, ['pull', '--ff-only', '--no-rebase', '--no-edit']), 'OK')));
  }

  /**
   * Pushes the current branch to the target the status showed. The renderer sends the remote, branch and URL id it confirmed with
   * the user; they must be exactly what this repository would push to now. Never forced, hooks are not skipped.
   */
  push(dir: string, req: GitPushRequest, scope?: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, scope, async (root) => {
      const status = await this.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], { timeoutMs: this.readTimeout, read: true });
      const parsed = parseStatusV2(status.stdout);
      if (!parsed.branch || parsed.initial) return fail('invalid', 'Push wymaga gałęzi z co najmniej jednym commitem.');
      const target = await this.pushTarget(root, parsed.branch);
      if (!target) return fail('invalid', 'Brak zdalnego repozytorium, do którego można wypchnąć tę gałąź.');
      if (target.remote !== req.remote || target.branch !== req.branch || target.urlId !== req.urlId) {
        return fail('invalid', 'Cel push zmienił się od ostatniego odświeżenia. Odśwież panel i spróbuj ponownie.');
      }
      const args = ['push', ...(target.setUpstream ? ['--set-upstream'] : []), target.remote, `refs/heads/${parsed.branch}:refs/heads/${target.branch}`];
      return ok(this.opMessage(await this.network(root, args), 'OK'));
    });
  }

  // ---------- publishing (src/main/github/publish.ts) ----------

  /** The checked out branch (null: detached HEAD); reads HEAD only, starts nothing. */
  private async currentBranch(root: string): Promise<string | null> {
    try { return (await this.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: this.readTimeout, read: true })).stdout.trim() || null; }
    catch { return null; }
  }

  /**
   * What publishing needs to know before anything is created on GitHub: the branch, whether it has a commit, the remotes.
   * Refused like a write in a repository above the project or in one that is not trusted (the push would run its hooks).
   */
  publishInfo(dir: string, scope?: string): Promise<GitResult<{ branch: string | null; initial: boolean; remotes: string[] }>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      if (scope && !this.withinScope(scope, root)) return fail('parent', 'To repozytorium nadrzędne wobec projektu: zapisy są wyłączone.');
      await this.requireTrust(root, true);
      let initial = false;
      try { await this.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: this.readTimeout, read: true }); } catch { initial = true; }
      return ok({ branch: await this.currentBranch(root), initial, remotes: await this.remoteNames(root) });
    });
  }

  /**
   * The git half of publishing, inside the repository's write lock: checks again that there is no remote and that `branch` is
   * still checked out, adds `url` as "origin" and pushes the branch with upstream. `env` carries the credentials (never the
   * command line). A failed push keeps the remote (the repository exists now): `pushed` is false and `message` is git's.
   */
  publishPush(dir: string, req: { requestId: string; url: string; branch: string; env: Record<string, string> }, scope?: string): Promise<GitResult<{ pushed: boolean; message: string }>> {
    return this.mutate<{ pushed: boolean; message: string }>(dir, req.requestId, scope, async (root) => {
      if (!isSafeRef(req.branch) || !/^https:\/\/\S+$/.test(req.url)) return fail('invalid', 'Nieprawidłowe żądanie git.');
      if ((await this.remoteNames(root)).length) return fail('invalid', 'To repozytorium ma już zdalne repozytorium.');
      if (await this.currentBranch(root) !== req.branch) return fail('invalid', 'Cel push zmienił się od ostatniego odświeżenia. Odśwież panel i spróbuj ponownie.');
      await this.run(root, ['remote', 'add', '--', 'origin', req.url], { timeoutMs: this.readTimeout });
      try {
        const out = await this.run(root, ['push', '--set-upstream', 'origin', `refs/heads/${req.branch}:refs/heads/${req.branch}`], { timeoutMs: this.networkTimeout, env: req.env });
        return ok({ pushed: true, message: this.opMessage(out, 'OK').message });
      } catch (error) {
        if (error instanceof GitFailure) return ok({ pushed: false, message: error.message });
        throw error;
      }
    });
  }

  stage(dir: string, req: GitPathsRequest, scope?: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, scope, async (root) => {
      const out = req.all
        ? await this.run(root, ['add', '-A'], { timeoutMs: this.readTimeout })
        : await this.run(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { timeoutMs: this.readTimeout, input: req.paths.join('\0') });
      return ok(this.opMessage(out, 'OK'));
    });
  }

  unstage(dir: string, req: GitPathsRequest, scope?: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, scope, async (root) => {
      let hasHead = true;
      try { await this.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: this.readTimeout, read: true }); } catch { hasHead = false; }
      // Without a first commit there is no HEAD to restore from: the files only leave the index.
      const base = hasHead ? ['restore', '--staged'] : ['rm', '--cached', '-r', '-q'];
      const out = req.all
        ? await this.run(root, [...base, '--', '.'], { timeoutMs: this.readTimeout })
        : await this.run(root, [...base, '--pathspec-from-file=-', '--pathspec-file-nul'], { timeoutMs: this.readTimeout, input: req.paths.join('\0') });
      return ok(this.opMessage(out, 'OK'));
    });
  }

  /** Commits what is staged. The message goes in on stdin; there is no amend and no way to skip the hooks. */
  commit(dir: string, req: GitCommitRequest, scope?: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, scope, async (root) => {
      const staged = await this.run(root, ['diff', '--cached', '--quiet', '--no-ext-diff'], { timeoutMs: this.readTimeout, read: true, okCodes: [1] });
      if (staged.code === 0) return fail('invalid', 'Nic nie jest dodane do commita. Dodaj najpierw pliki.');
      const out = await this.run(root, ['commit', '-F', '-'], { timeoutMs: this.networkTimeout, input: req.message.replace(/\r\n/g, '\n') });
      return ok(this.opMessage(out, 'OK'));
    });
  }

  /** Switches branch, only when nothing tracked is modified; a remote branch gets a local branch that tracks it. */
  checkout(dir: string, req: GitCheckoutRequest, scope?: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, scope, async (root) => {
      const status = await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=no'], { timeoutMs: this.readTimeout, read: true });
      if (parseStatusV2(status.stdout).files.length) return fail('dirty', 'Masz niezatwierdzone zmiany. Zatwierdź je lub odłóż, zanim zmienisz gałąź.');
      const full = `refs/${req.remote ? 'remotes' : 'heads'}/${req.branch}`;
      try { await this.run(root, ['rev-parse', '--verify', '--quiet', `${full}^{commit}`], { timeoutMs: this.readTimeout, read: true }); }
      catch { return fail('invalid', 'Nie ma takiej gałęzi.'); }
      const args = req.remote ? ['switch', '--track', req.branch] : ['switch', req.branch];
      return ok(this.opMessage(await this.run(root, args, { timeoutMs: this.networkTimeout }), 'OK'));
    });
  }
}
