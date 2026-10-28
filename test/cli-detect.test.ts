import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliDetector, FOUND_TTL_MS, MISSING_TTL_MS, type CliDetectorDeps, type ExecOptions, type ExecResult } from '../src/main/cliDetect';
import type { CliStatusMap } from '../src/shared/cliStatus';

interface World {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  files: Set<string>;
  dirs: Record<string, string[]>;
  texts: Record<string, string>;
  registry: { machine: string | null; user: string | null } | null | undefined;
  clock: number;
  calls: Array<{ file: string; args: string[]; options: ExecOptions }>;
  /** Result of any exec; the default answers `--version` and the shell probe sensibly. */
  exec: (file: string, args: string[], options: ExecOptions) => ExecResult | Promise<ExecResult>;
}

const VERSION_OK: ExecResult = { ok: true, stdout: '2.1.211 (Claude Code)\n', timedOut: false };

function world(patch: Partial<World> = {}): World {
  return {
    platform: 'darwin', home: '/Users/a', env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, files: new Set(), dirs: {}, texts: {},
    registry: undefined, clock: 1_000_000, calls: [], exec: () => VERSION_OK, ...patch,
  };
}

function detector(w: World, extra: Partial<CliDetectorDeps> = {}): CliDetector {
  return new CliDetector({
    platform: w.platform, home: w.home, env: () => w.env, now: () => w.clock,
    isFile: async (path) => w.files.has(path),
    readDir: async (path) => w.dirs[path] ?? [],
    readFile: async (path) => w.texts[path] ?? null,
    exec: async (file, args, options) => { w.calls.push({ file, args, options }); return w.exec(file, args, options); },
    ...(w.registry !== undefined ? { readWindowsPath: async () => w.registry! } : {}),
    ...extra,
  });
}

const PROBE_OUT = (path: string, claude = '', codex = ''): ExecResult => ({
  ok: true, timedOut: false, stdout: `banner\n__AJZ_PATH__=${path}\n__AJZ_CLAUDE__=${claude}\n__AJZ_CODEX__=${codex}\n`,
});
const isProbe = (args: string[]) => args[0] === '-ilc';
const WIN_PROBE = (claude = '', codex = ''): ExecResult => ({ ok: true, timedOut: false, stdout: `Loading personal profile...\r\n__AJZ_CMD_CLAUDE__=${claude}\r\n__AJZ_CMD_CODEX__=${codex}\r\n` });
const isWinProbe = (file: string) => file === 'powershell.exe' || file === 'pwsh.exe';

afterEach(() => vi.useRealTimers());

describe('CliDetector on macOS', () => {
  it('finds a CLI in a known install directory that is not on the app PATH and verifies its version', async () => {
    const w = world({ files: new Set(['/Users/a/.local/bin/claude']) });
    const status = await detector(w).get('claude');
    expect(status).toMatchObject({ state: 'found', path: '/Users/a/.local/bin/claude', version: '2.1.211', source: 'known' });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].args).toEqual(['--version']);
    expect(w.calls[0].options.timeout).toBe(5000);
    // the binary's directory is on the PATH of the version check (shims start `node` from there)
    expect(w.calls[0].options.env.PATH!.split(':')[0]).toBe('/Users/a/.local/bin');
  });

  it('finds a CLI through the PATH walk', async () => {
    const w = world({ env: { PATH: '/usr/bin:/custom/bin', SHELL: '/bin/zsh' }, files: new Set(['/custom/bin/codex']) });
    expect(await detector(w).get('codex')).toMatchObject({ state: 'found', path: '/custom/bin/codex', source: 'path' });
  });

  it('finds the newest nvm version and an npm prefix from ~/.npmrc', async () => {
    const w = world({
      dirs: { '/Users/a/.nvm/versions/node': ['v18.1.0', 'v20.5.0'] },
      files: new Set(['/Users/a/.nvm/versions/node/v20.5.0/bin/claude', '/Users/a/.npm-g/bin/codex']),
      texts: { '/Users/a/.npmrc': 'prefix=~/.npm-g' },
    });
    const d = detector(w);
    expect((await d.get('claude')).path).toBe('/Users/a/.nvm/versions/node/v20.5.0/bin/claude');
    expect((await d.get('codex')).path).toBe('/Users/a/.npm-g/bin/codex');
  });

  it('finds a CLI only through the login-shell probe (custom install dir) and runs the probe once for both CLIs', async () => {
    const w = world({
      files: new Set(['/opt/tools/claude', '/opt/tools/codex']),
      exec: (_file, args) => (isProbe(args) ? PROBE_OUT('/usr/bin:/opt/tools', '/opt/tools/claude') : VERSION_OK),
    });
    const d = detector(w);
    const [claude, codex] = await Promise.all([d.get('claude'), d.get('codex')]);
    expect(claude).toMatchObject({ state: 'found', path: '/opt/tools/claude', source: 'shell' });
    expect(codex).toMatchObject({ state: 'found', path: '/opt/tools/codex', source: 'shell' });
    const probes = w.calls.filter((c) => isProbe(c.args));
    expect(probes).toHaveLength(1);
    expect(probes[0].file).toBe('/bin/zsh');
    expect(probes[0].options.timeout).toBe(5000);
  });

  it('reports "missing" only when every place was searched', async () => {
    const w = world({ exec: (_f, args) => (isProbe(args) ? PROBE_OUT('/usr/bin:/bin') : VERSION_OK) });
    expect(await detector(w).get('claude')).toMatchObject({ state: 'missing', reason: 'notOnPath' });
  });

  it('never reports "missing" when the login shell resolves the name to an alias or function', async () => {
    const aliased = (value: string) => world({ exec: (_f, args) => (isProbe(args) ? PROBE_OUT('/usr/bin:/bin', value) : VERSION_OK) });
    for (const value of ["alias claude='/opt/x/claude --flag'", 'claude', 'claude is a shell function']) {
      expect(await detector(aliased(value)).get('claude')).toMatchObject({ state: 'unknown', reason: 'shellAlias' });
    }
    // the other CLI of the same probe is still judged on its own
    const w = aliased("alias claude='x'");
    expect(await detector(w).get('codex')).toMatchObject({ state: 'missing' });
  });

  it('probes with the shell the cells run (settings.shell), not $SHELL', async () => {
    const w = world({ env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, files: new Set(['/bin/bash']), exec: (_f, args) => (isProbe(args) ? PROBE_OUT('/usr/bin:/bin') : VERSION_OK) });
    await detector(w, { shell: () => 'bash' }).get('claude');
    expect(w.calls.find((c) => isProbe(c.args))!.file).toBe('/bin/bash');
    const zsh = world({ env: { PATH: '/usr/bin:/bin', SHELL: '/bin/bash' }, files: new Set(['/bin/zsh']), exec: (_f, args) => (isProbe(args) ? PROBE_OUT('/usr/bin:/bin') : VERSION_OK) });
    await detector(zsh, { shell: () => 'zsh' }).get('claude');
    expect(zsh.calls.find((c) => isProbe(c.args))!.file).toBe('/bin/zsh');
    // a configured shell that is not there falls back to $SHELL
    const absent = world({ env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, exec: (_f, args) => (isProbe(args) ? PROBE_OUT('/usr/bin:/bin') : VERSION_OK) });
    await detector(absent, { shell: () => 'bash' }).get('claude');
    expect(absent.calls.find((c) => isProbe(c.args))!.file).toBe('/bin/zsh');
  });

  it('fails open (unknown) when the login shell probe times out or the shell is unsupported', async () => {
    const timedOut = world({ exec: () => ({ ok: false, stdout: '', timedOut: true }) });
    expect(await detector(timedOut).get('claude')).toMatchObject({ state: 'unknown', reason: 'timeout' });
    const unsupported = world({ env: { PATH: '/usr/bin', SHELL: '/opt/homebrew/bin/nu' } });
    expect(await detector(unsupported).get('claude')).toMatchObject({ state: 'unknown', reason: 'probeFailed' });
    expect(unsupported.calls).toHaveLength(0);
  });

  it('treats a binary whose version check fails or times out as found but unverified', async () => {
    const w = world({ files: new Set(['/usr/local/bin/claude']), exec: () => ({ ok: false, stdout: '', timedOut: true }) });
    expect(await detector(w).get('claude')).toMatchObject({ state: 'found', reason: 'timeout' });
    expect((await detector(w).get('claude')).version).toBeUndefined();
    const failed = world({ files: new Set(['/usr/local/bin/claude']), exec: () => ({ ok: false, stdout: 'boom', timedOut: false }) });
    expect(await detector(failed).get('claude')).toMatchObject({ state: 'found', reason: 'versionFailed' });
  });

  it('never exposes anything but the parsed version of the output', async () => {
    const w = world({ files: new Set(['/usr/local/bin/claude']), exec: () => ({ ok: true, stdout: 'token sk-ant-123 1.2.3 more', timedOut: false }) });
    const status = await detector(w).get('claude');
    expect(JSON.stringify(status)).not.toContain('sk-ant');
    expect(status.version).toBe('1.2.3');
  });
});

describe('CliDetector on Windows', () => {
  const win = (patch: Partial<World> = {}) => world({
    platform: 'win32', home: 'C:\\Users\\a', env: { Path: 'C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\Users\\a\\AppData\\Roaming', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    ...patch,
  });

  it('finds claude.exe in the documented %USERPROFILE%\\.local\\bin and asks it through cmd.exe', async () => {
    // 1.0.9: spawning a big .exe directly blocked the main process for about 0.8 s (codex.exe, CreateProcess is synchronous).
    const w = win({ files: new Set(['C:\\Users\\a\\.local\\bin\\claude.exe']) });
    const status = await detector(w).get('claude');
    expect(status).toMatchObject({ state: 'found', path: 'C:\\Users\\a\\.local\\bin\\claude.exe', source: 'known' });
    expect(w.calls[0].file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(w.calls[0].args).toEqual(['/d', '/s', '/c', '""C:\\Users\\a\\.local\\bin\\claude.exe" --version"']);
    expect(w.calls[0].options.verbatim).toBe(true);
  });

  it('runs an .exe directly when its path cannot be quoted for cmd.exe', async () => {
    const w = win({ files: new Set(['C:\\100%\\claude.exe']), env: { Path: 'C:\\100%', PATHEXT: '.EXE', ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
    expect(await detector(w).get('claude')).toMatchObject({ state: 'found', version: '2.1.211' });
    expect(w.calls[0].file).toBe('C:\\100%\\claude.exe');
    expect(w.calls[0].args).toEqual(['--version']);
    expect(w.calls[0].options.verbatim).toBe(false);
  });

  it('runs an npm .cmd shim through cmd.exe with a safely quoted command line', async () => {
    const w = win({ files: new Set(['C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd']) });
    expect(await detector(w).get('codex')).toMatchObject({ state: 'found', path: 'C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd' });
    expect(w.calls[0].file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(w.calls[0].args).toEqual(['/d', '/s', '/c', '""C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd" --version"']);
    expect(w.calls[0].options.verbatim).toBe(true);
  });

  it('quotes a shim path so that `&` in a folder name works, and refuses what cannot be quoted', async () => {
    const amp = win({ files: new Set(['C:\\Users\\R&D\\x\\claude.cmd']), env: { Path: 'C:\\Users\\R&D\\x', PATHEXT: '.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
    expect(await detector(amp).get('claude')).toMatchObject({ state: 'found', version: '2.1.211' });
    expect(amp.calls[0].args).toEqual(['/d', '/s', '/c', '""C:\\Users\\R&D\\x\\claude.cmd" --version"']);
    const percent = win({ files: new Set(['C:\\100%\\claude.cmd']), env: { Path: 'C:\\100%', PATHEXT: '.CMD' } });
    expect(await detector(percent).get('claude')).toMatchObject({ state: 'found', reason: 'versionFailed' });
    expect(percent.calls).toHaveLength(0);
  });

  it('picks up a directory only the registry PATH has (installer ran after the app started)', async () => {
    const w = win({
      registry: { machine: 'C:\\Windows', user: '%USERPROFILE%\\tools' },
      files: new Set(['C:\\Users\\a\\tools\\claude.exe']),
    });
    const d = detector(w);
    expect(await d.get('claude')).toMatchObject({ state: 'found', source: 'path', path: 'C:\\Users\\a\\tools\\claude.exe' });
  });

  it('reports "missing" with a readable registry and "unknown" when the registry cannot be read', async () => {
    const readable = win({ registry: { machine: 'C:\\Windows', user: null }, exec: (file) => (isWinProbe(file) ? WIN_PROBE() : VERSION_OK) });
    expect(await detector(readable).get('claude')).toMatchObject({ state: 'missing' });
    const broken = win({ registry: null, exec: (file) => (isWinProbe(file) ? WIN_PROBE() : VERSION_OK) });
    expect(await detector(broken).get('claude')).toMatchObject({ state: 'unknown', reason: 'registryFailed' });
  });

  it('refreshes the cell PATH from the registry without reordering it and keeps the Path key', async () => {
    const w = win({ registry: { machine: 'C:\\Windows;C:\\Machine', user: '%USERPROFILE%\\Other' }, files: new Set(['C:\\Users\\a\\.local\\bin\\claude.exe']) });
    const d = detector(w);
    await d.get('claude');
    const env = await d.applyEnv({ Path: 'C:\\Windows;C:\\Mine', MC_CELL_ID: 'c1' }, 'claude');
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toEqual(['Path']);
    // the detected dir goes in front, the rest keeps its order, registry-only entries come last
    expect(env.Path).toBe('C:\\Users\\a\\.local\\bin;C:\\Windows;C:\\Mine;C:\\Machine;C:\\Users\\a\\Other');
    expect(env.MC_CELL_ID).toBe('c1');
  });

  it('does not touch a PATH that already has everything', async () => {
    const w = win({ registry: { machine: 'C:\\Windows', user: null }, files: new Set(['C:\\Windows\\claude.exe']) });
    const d = detector(w);
    await d.get('claude');
    expect((await d.applyEnv({ Path: 'C:\\Windows' }, 'claude')).Path).toBe('C:\\Windows');
  });

  describe('profile probe (what the user\'s own PowerShell resolves)', () => {
    const probed = (claude: string, extra: Partial<World> = {}) => win({
      files: new Set(['C:\\Tools\\claude.exe']), exec: (file) => (isWinProbe(file) ? WIN_PROBE(claude) : VERSION_OK), ...extra,
    });

    it('finds an Application the profile put on the PATH and verifies it', async () => {
      const w = probed('Application|C:\\Tools\\claude.exe');
      expect(await detector(w, { shell: () => 'powershell' }).get('claude')).toMatchObject({ state: 'found', path: 'C:\\Tools\\claude.exe', source: 'shell', version: '2.1.211' });
      const probe = w.calls.find((c) => isWinProbe(c.file))!;
      expect(probe.file).toBe('powershell.exe');
      expect(probe.args).toContain('-Command');
      expect(probe.args).not.toContain('-NoProfile'); // the profile is the point
      expect(probe.options.timeout).toBe(8000);
    });

    it('treats an alias, function or script as unknown, never as missing (no lock-out)', async () => {
      for (const kind of ['Alias|claude-real', 'Function|', 'ExternalScript|C:\\Tools\\claude.ps1', 'Cmdlet|']) {
        const w = probed(kind);
        expect(await detector(w, { shell: () => 'powershell' }).get('claude')).toMatchObject({ state: 'unknown', reason: 'shellAlias' });
      }
    });

    it('is missing only when the shell itself ran and knows nothing', async () => {
      expect(await detector(probed(''), { shell: () => 'powershell' }).get('claude')).toMatchObject({ state: 'missing' });
      const broken = probed('', { exec: () => ({ ok: false, stdout: '', timedOut: true }) });
      expect(await detector(broken, { shell: () => 'powershell' }).get('claude')).toMatchObject({ state: 'unknown', reason: 'timeout' });
      const noOutput = probed('', { exec: () => ({ ok: true, stdout: 'garbage', timedOut: false }) });
      expect(await detector(noOutput, { shell: () => 'powershell' }).get('claude')).toMatchObject({ state: 'unknown', reason: 'probeFailed' });
    });

    it('runs one probe for both CLIs, and none when the binary is found on the PATH', async () => {
      const w = probed('');
      const d = detector(w, { shell: () => 'powershell' });
      await Promise.all([d.get('claude'), d.get('codex')]);
      expect(w.calls.filter((c) => isWinProbe(c.file))).toHaveLength(1);
      const hit = win({ files: new Set(['C:\\Windows\\claude.exe']) });
      await detector(hit, { shell: () => 'powershell' }).get('claude');
      expect(hit.calls.filter((c) => isWinProbe(c.file))).toHaveLength(0);
    });

    it('uses pwsh for the pwsh shell (falling back to Windows PowerShell) and skips the probe for cmd', async () => {
      const w = probed('Application|C:\\Tools\\claude.exe');
      await detector(w, { shell: () => 'pwsh' }).get('claude');
      expect(w.calls.find((c) => isWinProbe(c.file))!.file).toBe('pwsh.exe');
      const fallback = probed('Application|C:\\Tools\\claude.exe', { exec: (file) => (file === 'pwsh.exe' ? { ok: false, stdout: '', timedOut: false } : file === 'powershell.exe' ? WIN_PROBE('Application|C:\\Tools\\claude.exe') : VERSION_OK) });
      expect(await detector(fallback, { shell: () => 'pwsh' }).get('claude')).toMatchObject({ state: 'found', source: 'shell' });
      const cmd = probed('Application|C:\\Tools\\claude.exe');
      expect(await detector(cmd, { shell: () => 'cmd' }).get('claude')).toMatchObject({ state: 'missing' });
      expect(cmd.calls.filter((c) => isWinProbe(c.file))).toHaveLength(0);
    });

    it('dot-sources the test profile instead of the real one when asked (unpackaged hook)', async () => {
      const w = probed('');
      await detector(w, { shell: () => 'powershell', probeProfile: 'D:\\lab\\profile.ps1' }).get('claude');
      const probe = w.calls.find((c) => isWinProbe(c.file))!;
      expect(probe.args).toContain('-NoProfile');
      expect(probe.args.at(-1)).toContain(". 'D:\\lab\\profile.ps1'; ");
    });
  });
});

describe('CliDetector applyEnv on POSIX', () => {
  it('prepends the detected directory only when the PATH lacks it, and leaves shell cells alone', async () => {
    const w = world({ files: new Set(['/Users/a/.local/bin/claude']) });
    const d = detector(w);
    await d.get('claude');
    expect((await d.applyEnv({ PATH: '/usr/bin:/bin' }, 'claude')).PATH).toBe('/Users/a/.local/bin:/usr/bin:/bin');
    expect((await d.applyEnv({ PATH: '/x:/Users/a/.local/bin' }, 'claude')).PATH).toBe('/x:/Users/a/.local/bin');
    expect((await d.applyEnv({ PATH: '/usr/bin' })).PATH).toBe('/usr/bin');
  });
});

describe('CliDetector cache', () => {
  it('shares one detection between concurrent callers', async () => {
    const w = world({ files: new Set(['/usr/local/bin/claude']) });
    const d = detector(w);
    const results = await Promise.all([d.get('claude'), d.get('claude'), d.get('claude')]);
    expect(results[0]).toBe(results[1]);
    expect(w.calls).toHaveLength(1);
  });

  it('keeps "found" for 10 minutes, then serves the stale value while re-verifying in the background', async () => {
    const w = world({ files: new Set(['/usr/local/bin/claude']) });
    const d = detector(w);
    await d.get('claude');
    w.clock += FOUND_TTL_MS - 1;
    await d.get('claude');
    expect(w.calls).toHaveLength(1);
    w.clock += 2;
    const stale = await d.get('claude');
    expect(stale.state).toBe('found');
    await vi.waitFor(() => expect(w.calls).toHaveLength(2));
  });

  it('keeps "missing" for 30 seconds and then looks again (the user may have installed it)', async () => {
    const w = world({ exec: (_f, args) => (isProbe(args) ? PROBE_OUT('/usr/bin') : VERSION_OK) });
    const d = detector(w);
    expect((await d.get('claude')).state).toBe('missing');
    const probes = () => w.calls.filter((c) => isProbe(c.args)).length;
    expect(probes()).toBe(1);
    w.clock += MISSING_TTL_MS - 1;
    await d.get('claude');
    expect(probes()).toBe(1);
    w.files.add('/Users/a/.local/bin/claude');
    w.clock += 2;
    expect((await d.get('claude')).state).toBe('found');
  });

  it('invalidate / recheck forget the cache and the login-shell snapshot', async () => {
    const w = world({ exec: (_f, args) => (isProbe(args) ? PROBE_OUT('/usr/bin') : VERSION_OK) });
    const d = detector(w);
    await d.get('claude');
    w.files.add('/usr/local/bin/claude');
    expect((await d.get('claude')).state).toBe('missing'); // still cached
    expect((await d.recheck('claude')).claude?.state).toBe('found');
    expect(d.peek('claude')?.path).toBe('/usr/local/bin/claude');
    d.invalidate();
    expect(d.peek('claude')).toBeUndefined();
    expect(d.snapshot()).toEqual({});
  });

  it('does not let an older, slower detection overwrite a newer recheck', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const w = world({ files: new Set(['/usr/local/bin/claude']) });
    let first = true;
    w.exec = async () => { if (first) { first = false; await slow; } return VERSION_OK; };
    const d = detector(w);
    const old = d.get('claude');
    const fresh = d.recheck('claude');
    await fresh;
    release();
    await old;
    expect(d.peek('claude')?.state).toBe('found');
  });

  it('returns unknown instead of blocking when a detection is slower than the caller is willing to wait', async () => {
    vi.useFakeTimers();
    const w = world();
    w.exec = () => new Promise<ExecResult>(() => undefined); // the probe never answers
    const d = detector(w);
    const pending = d.get('claude', { waitMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ state: 'unknown', reason: 'timeout' });
  });

  it('notifies listeners about changes only', async () => {
    const w = world({ files: new Set(['/usr/local/bin/claude']), exec: (_f, args) => (isProbe(args) ? PROBE_OUT('/usr/bin') : VERSION_OK) });
    const d = detector(w);
    const seen: CliStatusMap[] = [];
    d.onChange((map) => seen.push(map));
    await d.get('claude');
    await d.recheck('claude'); // same result again: no second notification
    await d.get('codex'); // codex is new (missing)
    expect(seen.map((map) => [map.claude?.state, map.codex?.state])).toEqual([['found', undefined], ['found', 'missing']]);
  });
});
