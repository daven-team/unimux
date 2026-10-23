// Main process work that must not block or repeat: hook commands, existence checks, the accounts file and
// the registry PATH cache.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { bypassProxyForHooks, claudeHookCommand, claudeHookForm, claudeHookSettings, HookServer } from '../src/main/hooks';
import { codexNotifyArgv } from '../src/shared/codexHooks';
import { pathExists } from '../src/main/fsProbe';
import { AccountsStore } from '../src/main/accounts/store';
import { CliDetector, REGISTRY_TTL_MS } from '../src/main/cliDetect';

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'mc-mainperf-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Claude hook commands', () => {
  const url = (event: string) => `http://127.0.0.1:5000/h/abc/cell/${event}/n0nce`;
  type Hook = { type: string; command: string; async?: boolean };
  const hook = (settings: ReturnType<typeof claudeHookSettings>, name: string): Hook => (settings.hooks[name][0] as { hooks: Hook[] }).hooks[0];

  it('never go through a proxy, like the Codex notify hook', () => {
    expect(claudeHookCommand(url('stop'), true)).toBe("curl -s --noproxy '*' -m 2 -X POST --data-binary @- http://127.0.0.1:5000/h/abc/cell/stop/n0nce");
    expect(codexNotifyArgv('http://127.0.0.1:5000/h/abcdef01/cell/codex/abcdef01').slice(0, 4)).toEqual(['curl', '-s', '--noproxy', '*']);
    const settings = claudeHookSettings(url);
    for (const name of Object.keys(settings.hooks)) expect(hook(settings, name).command, name).toContain("--noproxy '*'");
  });

  it('run the busy hooks in the background and keep the status hooks synchronous with their payloads', () => {
    const settings = claudeHookSettings(url);
    for (const name of ['PreToolUse', 'PostToolUse', 'SubagentStop']) {
      expect(hook(settings, name).async, name).toBe(true);
      expect(hook(settings, name).command, name).not.toContain('--data-binary'); // tool payloads would upload whole files
    }
    for (const name of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart', 'StopFailure']) expect(hook(settings, name).async, name).toBeUndefined();
    for (const name of ['Stop', 'Notification', 'SessionStart', 'StopFailure']) expect(hook(settings, name).command, name).toContain('--data-binary @-');
    expect(hook(settings, 'PreToolUse').command).toContain('/busy/');
    expect(hook(settings, 'SubagentStop').command).toContain('/subagent/');
  });

  it('pick the hook form from the Claude Code version', () => {
    expect(claudeHookForm(undefined)).toBe('shell');
    expect(claudeHookForm('garbage')).toBe('shell');
    expect(claudeHookForm('2.1.62')).toBe('shell');
    expect(claudeHookForm('2.1.63')).toBe('http');
    expect(claudeHookForm('2.1.138')).toBe('http');
    expect(claudeHookForm('2.1.139')).toBe('exec');
    expect(claudeHookForm('2.1.309-beta.1')).toBe('exec');
    expect(claudeHookForm('3.0.0')).toBe('exec');
    expect(claudeHookForm('1.9.999')).toBe('shell');
  });

  it('use http hooks with the token in a header, and a shell-free curl for SessionStart', () => {
    const target = { url, headerUrl: (event: string) => `http://127.0.0.1:5000/k/cell/${event}/n0nce`, token: 'abc' };
    const exec = claudeHookSettings(target, 'exec');
    for (const name of ['UserPromptSubmit', 'Stop', 'Notification', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'StopFailure']) {
      const h = (exec.hooks[name][0] as { hooks: Array<Record<string, unknown>> }).hooks[0];
      expect(h.type, name).toBe('http');
      expect(h.url, name).not.toContain('abc');
      expect(h.headers, name).toEqual({ Authorization: 'Bearer abc' });
      expect(h.timeout, name).toBe(5);
      expect(h.async, name).toBeUndefined(); // async is a command hook field only
    }
    const session = (exec.hooks.SessionStart[0] as { hooks: Array<Record<string, unknown>> }).hooks[0];
    expect(session).toEqual({ type: 'command', command: 'curl', args: ['-s', '--noproxy', '*', '-m', '2', '-X', 'POST', '--data-binary', '@-', url('session')] });
    const http = claudeHookSettings(target, 'http');
    expect((http.hooks.SessionStart[0] as { hooks: Hook[] }).hooks[0].command).toBe(claudeHookCommand(url('session'), true));
    expect((http.hooks.Stop[0] as { hooks: Hook[] }).hooks[0].type).toBe('http');
  });

  it('accept http hook posts with the header token, keep the curl path, and read big tool payloads to the end', async () => {
    const s = new HookServer();
    await s.start();
    const dir = temp();
    try {
      const json = JSON.parse(readFileSync(s.writeClaudeSettings(dir, 'c1', '2.1.309'), 'utf8'));
      const got: string[] = [];
      s.on('hook', (cell, ev) => got.push(`${cell}:${ev}`));
      const pre = json.hooks.PreToolUse[0].hooks[0] as { url: string; headers: Record<string, string> };
      expect(pre.url).not.toContain(s.token);
      const post = (h: { url: string; headers: Record<string, string> }, body: string) =>
        fetch(h.url, { method: 'POST', headers: { ...h.headers, 'Content-Type': 'application/json' }, body });
      // A PostToolUse payload with a whole file in it: answered 204, still a busy.
      expect((await post(json.hooks.PostToolUse[0].hooks[0], JSON.stringify({ tool_response: 'x'.repeat(3_000_000) }))).status).toBe(204);
      expect((await post(json.hooks.Stop[0].hooks[0], JSON.stringify({ background_tasks: [] }))).status).toBe(204);
      expect((await post(json.hooks.Notification[0].hooks[0], JSON.stringify({ notification_type: 'permission_prompt' }))).status).toBe(204);
      // The same URL without the header (or with a wrong one) is refused.
      expect((await fetch(pre.url, { method: 'POST', body: '{}' })).status).toBe(403);
      expect((await fetch(pre.url, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' })).status).toBe(403);
      // SessionStart still posts through curl's path token.
      expect((json.hooks.SessionStart[0].hooks[0].args as string[]).at(-1)).toContain(`/h/${s.token}/c1/session/`);
      expect(got).toEqual(['c1:busy', 'c1:stop', 'c1:notify']);
    } finally {
      s.stop();
    }
  });

  it('keep 127.0.0.1 off the proxy for a cell that has one', () => {
    expect(bypassProxyForHooks({ PATH: 'x' }, 'win32')).toEqual({ PATH: 'x' });
    expect(bypassProxyForHooks({ HTTPS_PROXY: 'http://p:8080' }, 'win32')).toEqual({ HTTPS_PROXY: 'http://p:8080', NO_PROXY: '127.0.0.1' });
    expect(bypassProxyForHooks({ http_proxy: 'http://p' }, 'darwin')).toEqual({ http_proxy: 'http://p', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' });
    expect(bypassProxyForHooks({ HTTP_PROXY: 'http://p', no_proxy: 'corp.local, .internal' }, 'win32')).toEqual({ HTTP_PROXY: 'http://p', no_proxy: 'corp.local,.internal,127.0.0.1' });
    expect(bypassProxyForHooks({ HTTP_PROXY: 'http://p', NO_PROXY: 'localhost,127.0.0.1' }, 'win32').NO_PROXY).toBe('localhost,127.0.0.1');
    expect(bypassProxyForHooks({ ALL_PROXY: 'socks5://p', NO_PROXY: '*' }, 'linux').NO_PROXY).toBe('*');
    expect(bypassProxyForHooks({ HTTP_PROXY: '  ' }, 'win32')).toEqual({ HTTP_PROXY: '  ' });
  });

  it('a failed listen rejects instead of throwing out of the process', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const server = new HookServer();
    // Force the listen onto an address that is taken.
    const original = (await import('http')).Server.prototype.listen;
    const port = (blocker.address() as { port: number }).port;
    (await import('http')).Server.prototype.listen = function (this: unknown, ...args: unknown[]) {
      return (original as (...a: unknown[]) => unknown).call(this, port, '127.0.0.1', ...(args.slice(2)));
    } as typeof original;
    try {
      await expect(server.start()).rejects.toThrow();
    } finally {
      (await import('http')).Server.prototype.listen = original;
      blocker.close();
      server.stop();
    }
  });
});

describe('pathExists', () => {
  it('answers without blocking and treats bad input as missing', async () => {
    const dir = temp();
    expect(await pathExists(dir)).toBe(true);
    expect(await pathExists(join(dir, 'nope'))).toBe(false);
    expect(await pathExists('')).toBe(false);
    expect(await pathExists('a\0b')).toBe(false);
  });
});

describe('accounts store cache', () => {
  it('reads the file again only when it changed, and own writes are seen at once', () => {
    const root = temp();
    const store = new AccountsStore(root);
    expect(store.list()).toEqual([]);
    store.commit({ id: '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091', addedAt: 1, email: 'a@b.c' });
    expect(store.list().map((a) => a.email)).toEqual(['a@b.c']);
    // A copy: editing what a caller got never changes the store.
    store.list()[0].email = 'changed@x.y';
    expect(store.get('3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091')?.email).toBe('a@b.c');
    // A change made outside (another size) is read.
    writeFileSync(join(root, 'accounts.json'), JSON.stringify({ version: 2, claude: [{ id: '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091', addedAt: 1, email: 'other@example.com' }] }));
    expect(store.list()[0].email).toBe('other@example.com');
  });
});

describe('registry PATH cache', () => {
  it('is reused for a minute, re-read after invalidateRegistry and a failed read is not kept', async () => {
    let clock = 1_000_000;
    let reads = 0;
    let answer: { machine: string | null; user: string | null } | null = { machine: 'C:\\Windows', user: null };
    const detector = new CliDetector({
      platform: 'win32', home: 'C:\\Users\\a', env: () => ({ Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a' }), now: () => clock,
      isFile: async () => false, readDir: async () => [], readFile: async () => null,
      exec: async () => ({ ok: true, stdout: '', timedOut: false }),
      readWindowsPath: async () => { reads++; return answer; },
    });
    await detector.applyEnv({ Path: 'C:\\Windows' });
    clock += REGISTRY_TTL_MS - 1;
    await detector.applyEnv({ Path: 'C:\\Windows' });
    expect(reads).toBe(1);
    detector.invalidateRegistry();
    await detector.applyEnv({ Path: 'C:\\Windows' });
    expect(reads).toBe(2);
    clock += REGISTRY_TTL_MS + 1;
    answer = null;
    await detector.applyEnv({ Path: 'C:\\Windows' });
    await Promise.resolve();
    await detector.applyEnv({ Path: 'C:\\Windows' });
    expect(reads).toBe(4); // the failed read was dropped right away
  });
});
