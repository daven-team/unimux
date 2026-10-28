// Finds the Claude Code / Codex binaries without relying on the PATH the app was launched with:
// known install directories, then the (Windows: registry-refreshed) PATH, then on POSIX a login-shell probe.
// All I/O is injected, so the whole decision logic is tested with fakes.
import { posix, win32 } from 'path';
import {
  CLI_IDS, executableNames, getEnv, joinPath, knownCliDirs, mergePaths, npmPrefixBinDir, parseShellProbe, parseVersion, parseWindowsCommandProbe,
  posixShellFile, prependDir, quoteForCmd, registryPathEntries, sameStatus, shellProbeScript, sortVersionsDesc, splitPath, versionedCliDirs,
  windowsCommandProbeScript, withPath,
  type CliId, type CliReason, type CliSource, type CliStatus, type CliStatusMap,
} from '../shared/cliStatus';
import { cleanEnv } from '../shared/env';

export interface ExecOptions {
  timeout: number;
  env: Record<string, string>;
  /** Windows: pass the argument string untouched (needed for `cmd.exe /s /c "..."`). */
  verbatim?: boolean;
}
export interface ExecResult { ok: boolean; stdout: string; timedOut: boolean }

export interface CliDetectorDeps {
  platform: NodeJS.Platform;
  home: string;
  env(): Record<string, string | undefined>;
  now(): number;
  isFile(path: string): Promise<boolean>;
  /** Directory entries; an empty list when it cannot be read. */
  readDir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string | null>;
  exec(file: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  /** Raw (unexpanded) Machine and User PATH from the Windows registry; null when unreadable. The only registry access. */
  readWindowsPath?(): Promise<{ machine: string | null; user: string | null } | null>;
  /** The shell kind cells run (settings.shell). POSIX: that shell does the login probe; Windows: PowerShell kinds get the profile probe, cmd does not. */
  shell?(): string | undefined;
  /** Test hook (unpackaged builds): a PowerShell script dot-sourced instead of the user's real profile in the Windows probe. */
  probeProfile?: string;
}

export const FOUND_TTL_MS = 10 * 60_000;
export const MISSING_TTL_MS = 30_000;
export const EXEC_TIMEOUT_MS = 5000;
/**
 * The registry PATH changes only when something is installed: it is re-read after a minute, on a window focus (the user may
 * come back from an installer), on "check again" and after an install; a failed read is retried on the next spawn.
 */
export const REGISTRY_TTL_MS = 60_000;
const NODE_VERSIONS_TRIED = 8;
const WINDOWS_PROBE_TIMEOUT_MS = 8000;

interface ProbeResult { ok: boolean; reason?: CliReason; path: string[]; found: Partial<Record<CliId, string>>; aliased: Partial<Record<CliId, true>> }

export class CliDetector {
  private cache = new Map<CliId, CliStatus>();
  /** Last status handed to listeners; survives invalidation so an unchanged recheck is not announced again. */
  private announced = new Map<CliId, CliStatus>();
  private inflight = new Map<CliId, Promise<CliStatus>>();
  private generation = 0;
  private listeners = new Set<(map: CliStatusMap) => void>();
  private probe?: { at: number; promise: Promise<ProbeResult> };
  private registry?: { at: number; promise: Promise<string[] | null> };
  private winProbe?: { at: number; promise: Promise<ProbeResult> };

  constructor(private readonly deps: CliDetectorDeps) {}

  private get path() { return this.deps.platform === 'win32' ? win32 : posix; }

  /** Cached status, stale or not; undefined = never checked. */
  peek(cli: CliId): CliStatus | undefined { return this.cache.get(cli); }

  snapshot(): CliStatusMap {
    const out: CliStatusMap = {};
    for (const cli of CLI_IDS) { const status = this.cache.get(cli); if (status) out[cli] = status; }
    return out;
  }

  onChange(listener: (map: CliStatusMap) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Status with caching: `found` 10 min (a stale one is returned at once and re-verified in the background),
   * `missing`/`unknown` 30 s, concurrent calls share one detection. With `waitMs` a slow detection yields `unknown`
   * (which never blocks anything) instead of making the caller wait.
   */
  async get(cli: CliId, options: { waitMs?: number; force?: boolean } = {}): Promise<CliStatus> {
    const cached = this.cache.get(cli);
    if (!options.force && cached) {
      const age = this.deps.now() - cached.checkedAt;
      if (cached.state === 'found') {
        if (age > FOUND_TTL_MS) void this.refresh(cli).catch(() => undefined);
        return cached;
      }
      if (age <= MISSING_TTL_MS) return cached;
    }
    const run = this.refresh(cli);
    if (!options.waitMs) return run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<CliStatus>((resolve) => {
      timer = setTimeout(() => resolve({ cli, state: 'unknown', reason: 'timeout', checkedAt: this.deps.now() }), options.waitMs);
    });
    try { return await Promise.race([run, slow]); } finally { clearTimeout(timer); }
  }

  /** Forgets cached results (and the login-shell / registry snapshots); the next `get` detects again. */
  invalidate(cli?: CliId): void {
    this.generation++;
    this.probe = undefined;
    this.winProbe = undefined;
    this.registry = undefined;
    for (const id of cli ? [cli] : CLI_IDS) { this.cache.delete(id); this.inflight.delete(id); }
  }

  /** Explicit "check again": invalidates and detects the given CLI (or both). */
  async recheck(cli?: CliId): Promise<CliStatusMap> {
    this.invalidate(cli);
    await Promise.all((cli ? [cli] : CLI_IDS).map((id) => this.get(id, { force: true })));
    return this.snapshot();
  }

  /** Startup scan: never throws. */
  refreshAll(): Promise<CliStatusMap> {
    return this.recheck().catch(() => this.snapshot());
  }

  /**
   * Environment for a spawned process: on Windows the PATH is refreshed from the registry (an installer may
   * have edited it after the app started), and the directory of the detected CLI goes in front when the PATH lacks it.
   */
  async applyEnv(env: Record<string, string>, cli?: CliId): Promise<Record<string, string>> {
    const { platform } = this.deps;
    let entries = splitPath(getEnv(env, 'PATH', platform), platform);
    if (platform === 'win32') {
      const registry = await this.registryEntries();
      if (registry) entries = mergePaths(entries, registry, platform);
    }
    const status = cli ? this.cache.get(cli) : undefined;
    if (status?.state === 'found' && status.path) entries = prependDir(entries, this.path.dirname(status.path), platform);
    return entries.length ? withPath(env, joinPath(entries, platform), platform) : env;
  }

  /**
   * Version of the binary a cell started with `env` really runs. The detection prefers known install folders, but the cell's
   * shell types the bare name and takes the first PATH entry that has it: an older npm install earlier on the PATH is what the
   * cell gets. Then that binary is asked (`--version`, cached per path, at most `waitMs`; undefined when unknown or slow).
   * A command the user's PowerShell resolves itself (source `shell`: alias, function, profile PATH) keeps the detected version.
   */
  async versionFor(cli: CliId, env: Record<string, string | undefined>, waitMs = 2000): Promise<string | undefined> {
    const { platform } = this.deps;
    const detected = this.cache.get(cli);
    if (detected?.state === 'found' && detected.source === 'shell') return detected.version;
    const names = executableNames(cli, platform, getEnv(env, 'PATHEXT', platform));
    let first: string | null = null;
    for (const dir of splitPath(getEnv(env, 'PATH', platform), platform)) {
      for (const name of names) {
        const full = this.path.join(dir, name);
        if (await this.deps.isFile(full)) { first = full; break; }
      }
      if (first) break;
    }
    const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    // Not on the PATH (an alias or a login-shell PATH) or the detected binary's folder itself: the detection is right.
    if (!first || (detected?.path && same(this.path.dirname(first), this.path.dirname(detected.path)))) return detected?.version;
    const cached = this.pathVersions.get(first);
    if (cached && this.deps.now() - cached.at <= FOUND_TTL_MS) return cached.version;
    const path = first;
    const run = this.verify(cli, path, 'path').then((status) => {
      this.pathVersions.set(path, { version: status.version, at: this.deps.now() });
      return status.version;
    }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); });
    try { return await Promise.race([run, slow]); } finally { clearTimeout(timer); }
  }
  private pathVersions = new Map<string, { version: string | undefined; at: number }>();

  private refresh(cli: CliId): Promise<CliStatus> {
    const existing = this.inflight.get(cli);
    if (existing) return existing;
    const generation = this.generation;
    const run: Promise<CliStatus> = this.detect(cli)
      .catch((): CliStatus => ({ cli, state: 'unknown', reason: 'probeFailed', checkedAt: this.deps.now() }))
      .then((status) => {
        // A recheck that started meanwhile owns the cache; this older result is only returned to its own callers.
        if (generation === this.generation) this.store(status);
        return status;
      })
      .finally(() => { if (this.inflight.get(cli) === run) this.inflight.delete(cli); });
    this.inflight.set(cli, run);
    return run;
  }

  private store(status: CliStatus): void {
    const previous = this.announced.get(status.cli);
    this.cache.set(status.cli, status);
    this.announced.set(status.cli, status);
    if (!previous || !sameStatus(previous, status)) for (const listener of this.listeners) listener(this.snapshot());
  }

  private async detect(cli: CliId): Promise<CliStatus> {
    const { platform } = this.deps;
    const env = this.deps.env();
    const names = executableNames(cli, platform, getEnv(env, 'PATHEXT', platform));
    const inDir = async (dir: string): Promise<string | null> => {
      for (const name of names) {
        const full = this.path.join(dir, name);
        if (await this.deps.isFile(full)) return full;
      }
      return null;
    };
    const found = async (path: string, source: CliSource) => this.verify(cli, path, source);

    for (const dir of await this.knownDirs(env)) {
      const hit = await inDir(dir);
      if (hit) return found(hit, 'known');
    }

    const { entries, complete } = await this.pathEntries(env);
    for (const dir of entries) {
      const hit = await inDir(dir);
      if (hit) return found(hit, 'path');
    }

    let probeReason: CliReason | undefined;
    if (platform !== 'win32') {
      const probe = await this.shellProbe(env);
      if (probe.ok) {
        const direct = probe.found[cli];
        if (direct && await this.deps.isFile(direct)) return found(direct, 'shell');
        for (const dir of probe.path) {
          const hit = await inDir(dir);
          if (hit) return found(hit, 'shell');
        }
        // An alias or function is not a file, but a cell (login shell) can run it: never a "missing" verdict.
        if (probe.aliased[cli]) probeReason = 'shellAlias';
      } else probeReason = probe.reason ?? 'probeFailed';
    } else if (this.windowsProbeShell()) {
      // The user's PowerShell (profile loaded, like a cell) may know the command by a PATH the profile builds, or as an alias.
      const probe = await this.windowsShellProbe(env, entries);
      if (probe.ok) {
        const direct = probe.found[cli];
        if (direct && await this.deps.isFile(direct)) return found(direct, 'shell');
        if (direct || probe.aliased[cli]) probeReason = 'shellAlias';
      } else probeReason = probe.reason ?? 'probeFailed';
    }

    const checkedAt = this.deps.now();
    // Not finding it is only a verdict when every place was really searched.
    if (probeReason) return { cli, state: 'unknown', reason: probeReason, checkedAt };
    if (!complete) return { cli, state: 'unknown', reason: 'registryFailed', checkedAt };
    return { cli, state: 'missing', reason: 'notOnPath', checkedAt };
  }

  private async knownDirs(env: Record<string, string | undefined>): Promise<string[]> {
    const { platform, home } = this.deps;
    const dirs = [...knownCliDirs(platform, env, home)];
    const fromEnv = (name: string, sub?: string) => {
      const value = getEnv(env, name, platform);
      if (value) dirs.push(sub ? this.path.join(value, sub) : value);
    };
    fromEnv('NVM_BIN');
    fromEnv('VOLTA_HOME', 'bin');
    fromEnv('BUN_INSTALL', 'bin');
    fromEnv('PNPM_HOME');
    const prefix = getEnv(env, 'npm_config_prefix', platform) ?? getEnv(env, 'NPM_CONFIG_PREFIX', platform);
    if (prefix) dirs.push(platform === 'win32' ? prefix : this.path.join(prefix, 'bin'));
    const npmrc = await this.deps.readFile(this.path.join(home, '.npmrc'));
    const fromNpmrc = npmrc ? npmPrefixBinDir(npmrc, platform, home) : null;
    if (fromNpmrc) dirs.push(fromNpmrc);
    for (const { root, suffix } of versionedCliDirs(platform, home)) {
      const versions = sortVersionsDesc(await this.deps.readDir(root)).slice(0, NODE_VERSIONS_TRIED);
      for (const version of versions) dirs.push(suffix ? this.path.join(root, version, ...suffix.split('/')) : this.path.join(root, version));
    }
    return [...new Set(dirs)];
  }

  private async pathEntries(env: Record<string, string | undefined>): Promise<{ entries: string[]; complete: boolean }> {
    const { platform } = this.deps;
    const base = splitPath(getEnv(env, 'PATH', platform), platform);
    if (platform !== 'win32' || !this.deps.readWindowsPath) return { entries: base, complete: true };
    const registry = await this.registryEntries();
    return { entries: mergePaths(base, registry ?? [], platform), complete: registry !== null };
  }

  private registryEntries(): Promise<string[] | null> {
    const read = this.deps.readWindowsPath;
    if (!read) return Promise.resolve(null);
    const current = this.registry;
    if (current && this.deps.now() - current.at <= REGISTRY_TTL_MS) return current.promise;
    const promise = read().then((raw) => (raw ? registryPathEntries(raw, this.deps.env()) : null)).catch(() => null);
    const entry = { at: this.deps.now(), promise };
    this.registry = entry;
    void promise.then((entries) => { if (entries === null && this.registry === entry) this.registry = undefined; });
    return promise;
  }

  /** The next spawn reads the registry PATH again (window focus: the user may come back from an installer). */
  invalidateRegistry(): void {
    this.registry = undefined;
  }

  private shellProbe(env: Record<string, string | undefined>): Promise<ProbeResult> {
    const current = this.probe;
    if (current && this.deps.now() - current.at <= MISSING_TTL_MS) return current.promise;
    const promise = this.runProbe(env).catch((): ProbeResult => ({ ok: false, reason: 'probeFailed', path: [], found: {}, aliased: {} }));
    this.probe = { at: this.deps.now(), promise };
    return promise;
  }

  /** Cells use PowerShell kinds with their profile; cmd.exe has no profile worth asking. */
  private windowsProbeShell(): 'pwsh' | 'powershell' | null {
    const kind = this.deps.shell?.();
    if (kind === 'cmd') return null;
    return kind === 'pwsh' ? 'pwsh' : 'powershell';
  }

  private windowsShellProbe(env: Record<string, string | undefined>, entries: string[]): Promise<ProbeResult> {
    const current = this.winProbe;
    if (current && this.deps.now() - current.at <= MISSING_TTL_MS) return current.promise;
    const promise = this.runWindowsProbe(env, entries).catch((): ProbeResult => ({ ok: false, reason: 'probeFailed', path: [], found: {}, aliased: {} }));
    this.winProbe = { at: this.deps.now(), promise };
    return promise;
  }

  /** `powershell -Command Get-Command ...` with the profile loaded; stdin is closed, the time and output are capped. */
  private async runWindowsProbe(env: Record<string, string | undefined>, entries: string[]): Promise<ProbeResult> {
    const platform = this.deps.platform;
    const script = windowsCommandProbeScript();
    const profile = this.deps.probeProfile;
    const args = profile
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `. '${profile.replace(/'/g, "''")}'; ${script}`]
      : ['-NoLogo', '-NonInteractive', '-Command', script];
    const runEnv = withPath(cleanEnv(env), joinPath(entries, platform), platform);
    const files = this.windowsProbeShell() === 'pwsh' ? ['pwsh.exe', 'powershell.exe'] : ['powershell.exe'];
    let timedOut = false;
    for (const file of files) {
      const result = await this.deps.exec(file, args, { timeout: WINDOWS_PROBE_TIMEOUT_MS, env: runEnv });
      const parsed = parseWindowsCommandProbe(result.stdout);
      if (parsed.ran) return { ok: true, path: [], found: parsed.found, aliased: parsed.aliased };
      timedOut = timedOut || result.timedOut;
    }
    return { ok: false, reason: timedOut ? 'timeout' : 'probeFailed', path: [], found: {}, aliased: {} };
  }

  /** The shell cells run (settings.shell) does the login probe; `$SHELL` only when that is not a known POSIX shell file. */
  private async probeShellFile(env: Record<string, string | undefined>): Promise<string> {
    const { platform } = this.deps;
    const configured = this.deps.shell?.();
    if (configured) {
      const file = posixShellFile(configured, platform);
      if (await this.deps.isFile(file)) return file;
    }
    return getEnv(env, 'SHELL', platform) || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  }

  /** The login shell prints marker lines (rc files may print anything else); this also harvests the user's real PATH. */
  private async runProbe(env: Record<string, string | undefined>): Promise<ProbeResult> {
    const shell = await this.probeShellFile(env);
    const script = shell.startsWith('/') ? shellProbeScript(shell) : null;
    if (!script) return { ok: false, reason: 'probeFailed', path: [], found: {}, aliased: {} };
    const result = await this.deps.exec(shell, ['-ilc', script], { timeout: EXEC_TIMEOUT_MS, env: { ...cleanEnv(env), Unimux_PROBE: '1' } });
    const parsed = parseShellProbe(result.stdout);
    if (!parsed.path.length) return { ok: false, reason: result.timedOut ? 'timeout' : 'probeFailed', path: [], found: {}, aliased: {} };
    return { ok: true, ...parsed };
  }

  /** `<bin> --version`; the file existing is what makes it `found`, the version is a bonus (fail open). */
  private async verify(cli: CliId, path: string, source: CliSource): Promise<CliStatus> {
    const { platform } = this.deps;
    const base = { cli, state: 'found' as const, path, source, checkedAt: this.deps.now() };
    const env = cleanEnv(this.deps.env());
    // Shims (npm, nvm) start `node` from the PATH, which usually sits next to them.
    const entries = prependDir(splitPath(getEnv(env, 'PATH', platform), platform), this.path.dirname(path), platform);
    const execEnv = withPath(env, joinPath(entries, platform), platform);
    let file = path;
    let args = ['--version'];
    let verbatim = false;
    // Windows: through cmd.exe, also for an .exe. Starting a big binary (codex.exe is over 300 MB) blocks the thread that calls
    // CreateProcess for about 0.8 s while it is mapped and scanned; started by cmd.exe that wait is cmd's, and the main process
    // (IPC, the first spawns, every window) goes on after about 10 ms. An .exe whose path cannot be quoted is run directly.
    const shim = /\.(cmd|bat)$/i.test(path);
    if (platform === 'win32' && (shim || quoteForCmd(path))) {
      // Inside quotes `& | < > ^` are literal (`C:\Users\R&D` works); only `"`, `%` and line breaks cannot be quoted.
      const quoted = quoteForCmd(path);
      if (!quoted) return { ...base, reason: 'versionFailed' };
      file = getEnv(env, 'ComSpec', platform) || 'cmd.exe';
      args = ['/d', '/s', '/c', `"${quoted} --version"`];
      verbatim = true;
    }
    const result = await this.deps.exec(file, args, { timeout: EXEC_TIMEOUT_MS, env: execEnv, verbatim }).catch((): ExecResult => ({ ok: false, stdout: '', timedOut: false }));
    const version = parseVersion(result.stdout);
    if (version) return { ...base, version };
    return { ...base, reason: result.timedOut ? 'timeout' : 'versionFailed' };
  }
}
