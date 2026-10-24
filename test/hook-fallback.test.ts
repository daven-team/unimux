import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliDetector, type CliDetectorDeps, type ExecResult } from '../src/main/cliDetect';
import { HTTP_HOOK_GRACE_MS, HttpHookWatch, claudeSettingsFiles, hookFallbackFile, httpHookUrlAllowed } from '../src/main/hookFallback';
import { HookServer, claudeHookForm } from '../src/main/hooks';

afterEach(() => vi.useRealTimers());

function watch(saved: string | null = null) {
  const notices: string[] = [];
  const saves: string[] = [];
  const w = new HttpHookWatch({ load: () => saved, save: (v) => saves.push(v), onFallback: () => notices.push('hint') });
  return { w, notices, saves };
}

describe('http hook fallback', () => {
  it('falls back to command hooks when a cell works 20 s after SessionStart without one http hook, and hints once', () => {
    vi.useFakeTimers();
    const { w, notices, saves } = watch();
    expect(w.formFor('exec', '2.1.310')).toBe('exec');
    w.spawned('a', 'exec', '2.1.310');
    w.spawned('b', 'exec', '2.1.310');
    w.hook('a', 'session');
    w.hook('b', 'session');
    w.status('a', 'working', false);
    w.status('b', 'working', false);
    vi.advanceTimersByTime(HTTP_HOOK_GRACE_MS - 1);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notices).toEqual(['hint']);
    expect(saves).toEqual(['2.1.310', '2.1.310']);
    expect(w.formFor('exec', '2.1.310')).toBe('shell');
    expect(w.formFor('http', '2.1.400')).toBe('shell'); // for the rest of this run, whatever the version
    expect(w.formFor('shell', undefined)).toBe('shell');
  });

  it('does not fall back when http hooks arrive, when the cell stops working in time, or before SessionStart', () => {
    vi.useFakeTimers();
    const { w, notices } = watch();
    // An http hook (UserPromptSubmit) proves http hooks work for that process.
    w.spawned('a', 'http', '2.1.100');
    w.hook('a', 'session');
    w.status('a', 'working', false);
    w.hook('a', 'prompt');
    // A menu redraw after Enter is "working" only briefly.
    w.spawned('b', 'http', '2.1.100');
    w.hook('b', 'session');
    w.status('b', 'working', false);
    vi.advanceTimersByTime(3000);
    w.status('b', 'idle', false);
    // The trust dialog before SessionStart (Claude runs no hooks there).
    w.spawned('c', 'http', '2.1.100');
    w.status('c', 'working', false);
    // A hooked status never counts.
    w.spawned('d', 'http', '2.1.100');
    w.hook('d', 'session');
    w.status('d', 'working', true);
    // A cell on command hooks is not watched, and an exited one is forgotten.
    w.spawned('e', 'shell', '2.1.10');
    w.hook('e', 'session');
    w.status('e', 'working', false);
    w.spawned('f', 'http', '2.1.100');
    w.hook('f', 'session');
    w.status('f', 'working', false);
    w.forget('f');
    vi.advanceTimersByTime(HTTP_HOOK_GRACE_MS * 3);
    expect(notices).toEqual([]);
    expect(w.formFor('http', '2.1.100')).toBe('http');
  });

  it('remembers the fallback per claude version across app runs (a new version tries http hooks again)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unimux-hookfb-'));
    try {
      const file = join(dir, 'claude-hook-fallback.json');
      const store = hookFallbackFile(file);
      expect(store.load()).toBeNull();
      store.save('2.1.200');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ claudeVersion: '2.1.200' });
      const next = new HttpHookWatch({ ...store, onFallback: () => undefined });
      expect(next.formFor('exec', '2.1.200')).toBe('shell');
      expect(next.formFor('exec', '2.1.201')).toBe('exec');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes command hooks into the settings file when the form is overridden', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unimux-hookfb-'));
    try {
      const server = new HookServer();
      const settings = JSON.parse(readFileSync(server.writeClaudeSettings(dir, 'cell-1', '2.1.310', 'shell'), 'utf8'));
      expect(settings.hooks.Stop[0].hooks[0].type).toBe('command');
      const http = JSON.parse(readFileSync(server.writeClaudeSettings(dir, 'cell-1', '2.1.310'), 'utf8'));
      expect(http.hooks.Stop[0].hooks[0].type).toBe('http');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('allowedHttpHookUrls in the Claude settings', () => {
  const url = 'http://127.0.0.1:51234/k/cell-1/stop/0';
  const list = (patterns: unknown) => JSON.stringify({ allowedHttpHookUrls: patterns });
  it('matches like Claude Code 2.1.310 does (checked with the real CLI): * spans everything, also the port and the path', () => {
    expect(httpHookUrlAllowed([null, '{}', 'not json'], url)).toBe(true);
    expect(httpHookUrlAllowed([list(['http://127.0.0.1:*'])], url)).toBe(true);
    expect(httpHookUrlAllowed([list(['http://127.0.0.1:*/*'])], url)).toBe(true);
    expect(httpHookUrlAllowed([list(['http://127.0.0.1/*'])], url)).toBe(false);
    expect(httpHookUrlAllowed([list(['http://localhost:*'])], url)).toBe(false);
    expect(httpHookUrlAllowed([list(['https://example.com/*'])], url)).toBe(false);
    expect(httpHookUrlAllowed([list([])], url)).toBe(false);
    // Several lists: any of their patterns may allow it; a dot is literal.
    expect(httpHookUrlAllowed([list(['https://example.com/*']), list(['http://127.0.0.1:*'])], url)).toBe(true);
    expect(httpHookUrlAllowed([list(['http://127x0x0x1:*'])], url)).toBe(false);
  });
  it('looks at the managed policy, the user settings (CLAUDE_CONFIG_DIR) and the project settings', () => {
    expect(claudeSettingsFiles('win32', 'C:\\Users\\a', { ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' }, 'D:\\p')).toEqual([
      'C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json',
      'C:\\Users\\a\\.claude\\settings.json', 'D:\\p\\.claude\\settings.json', 'D:\\p\\.claude\\settings.local.json']);
    expect(claudeSettingsFiles('darwin', '/Users/a', { CLAUDE_CONFIG_DIR: '/cfg' }, '/p')).toEqual([
      '/Library/Application Support/ClaudeCode/managed-settings.json', '/cfg/settings.json', '/p/.claude/settings.json', '/p/.claude/settings.local.json']);
    expect(claudeSettingsFiles('linux', '/home/a', {}, '/p')[0]).toBe('/etc/claude-code/managed-settings.json');
  });
});

describe('the claude version a cell really runs', () => {
  const version = (v: string): ExecResult => ({ ok: true, stdout: `${v} (Claude Code)\n`, timedOut: false });
  function detector(files: string[], versions: Record<string, string>, extra: Partial<CliDetectorDeps> = {}) {
    const calls: string[] = [];
    const d = new CliDetector({
      platform: 'darwin', home: '/Users/a', env: () => ({ PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }), now: () => 1_000_000,
      isFile: async (path) => files.includes(path), readDir: async () => [], readFile: async () => null,
      exec: async (file) => { calls.push(file); return versions[file] ? version(versions[file]) : { ok: false, stdout: '', timedOut: false }; },
      ...extra,
    });
    return { d, calls };
  }

  it('takes the first PATH entry the cell shell would run, not the newer install the detection prefers', async () => {
    const { d, calls } = detector(['/Users/a/.local/bin/claude', '/opt/old/bin/claude'], { '/Users/a/.local/bin/claude': '2.1.310', '/opt/old/bin/claude': '2.1.50' });
    expect((await d.get('claude')).version).toBe('2.1.310');
    const env = { PATH: '/opt/old/bin:/Users/a/.local/bin:/usr/bin' };
    expect(await d.versionFor('claude', env)).toBe('2.1.50');
    expect(claudeHookForm(await d.versionFor('claude', env))).toBe('shell');
    expect(calls.filter((c) => c === '/opt/old/bin/claude')).toHaveLength(1); // cached per path
    // The detected binary first on the PATH: no extra process.
    expect(await d.versionFor('claude', { PATH: '/Users/a/.local/bin:/opt/old/bin' })).toBe('2.1.310');
    // Not on the PATH at all (an alias, a login-shell PATH): the detection stands.
    expect(await d.versionFor('claude', { PATH: '/usr/bin' })).toBe('2.1.310');
    expect(calls.filter((c) => c === '/opt/old/bin/claude')).toHaveLength(1);
  });

  it('gives up after waitMs: an unknown version means command hooks', async () => {
    const { d } = detector(['/Users/a/.local/bin/claude', '/opt/old/bin/claude'], { '/Users/a/.local/bin/claude': '2.1.310' }, {
      exec: async (file) => file === '/opt/old/bin/claude' ? new Promise<ExecResult>(() => undefined) : version('2.1.310'),
    });
    await d.get('claude');
    const found = await d.versionFor('claude', { PATH: '/opt/old/bin:/Users/a/.local/bin' }, 20);
    expect(found).toBeUndefined();
    expect(claudeHookForm(found)).toBe('shell');
  });
});
