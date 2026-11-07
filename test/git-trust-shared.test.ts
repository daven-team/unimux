import { describe, expect, it } from 'vitest';
import { normalizeRepoPath, validateGitRequest, worktreeAllowed } from '../src/shared/git';
import { attributeDrivers, configuredAttributeDrivers, dangerousConfigKeys, parseConfigList } from '../src/shared/gitTrust';

const entries = (...pairs: Array<[string, string]>) => pairs.map(([key, value]) => ({ key, value }));

describe('config scan (pure part of the trust model)', () => {
  it('parses git config --list -z', () => {
    expect(parseConfigList('core.bare\nfalse\0user.name\nA B\0core.noValue\0')).toEqual([
      { key: 'core.bare', value: 'false' }, { key: 'user.name', value: 'A B' }, { key: 'core.noValue', value: '' },
    ]);
    expect(parseConfigList('')).toEqual([]);
    expect(parseConfigList('a.b\nline1\nline2\0')).toEqual([{ key: 'a.b', value: 'line1\nline2' }]);
  });

  it('flags every key that can start a program', () => {
    const risky = entries(
      ['filter.lfs.clean', 'x'], ['filter.a.smudge', 'x'], ['filter.a.process', 'x'], ['diff.a.textconv', 'x'], ['diff.a.command', 'x'], ['diff.external', 'x'],
      ['merge.a.driver', 'x'], ['core.fsmonitor', '/bin/x'], ['core.fsmonitor', 'true'], ['core.hooksPath', '.hooks'], ['core.sshCommand', 'x'], ['core.pager', 'x'],
      ['core.editor', 'x'], ['core.askPass', 'x'], ['remote.origin.uploadpack', 'x'], ['remote.origin.receivepack', 'x'], ['remote.origin.proxy', 'x'],
      ['remote.origin.vcs', 'x'], ['credential.helper', '!x'], ['credential.https://h.helper', '/usr/bin/x'], ['credential.helper', 'C:\\x\\y.exe'],
      ['url.https://evil/.insteadOf', 'https://good/'], ['url.https://evil/.pushInsteadOf', 'https://good/'], ['protocol.file.allow', 'always'], ['protocol.allow', 'always'],
      ['include.path', '../x'], ['includeIf.gitdir:/x/.path', '../x'], ['gpg.program', 'x'], ['gpg.ssh.program', 'x'], ['core.worktree', '..'],
      ['pager.log', 'x'], ['uploadpack.packObjectsHook', 'x'], ['sequence.editor', 'x'], ['submodule.s.update', '!x'],
    );
    const found = dangerousConfigKeys(risky);
    expect(found).toHaveLength(new Set(risky.map((e) => e.key)).size);
    for (const { key } of risky) expect(found, key).toContain(key);
  });

  it('leaves ordinary configuration alone', () => {
    const quiet = entries(
      ['core.bare', 'false'], ['core.fsmonitor', 'false'], ['core.fsmonitor', ''], ['core.autocrlf', 'true'], ['user.name', 'x'], ['remote.origin.url', 'https://h/r.git'],
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], ['branch.main.remote', 'origin'], ['credential.helper', 'manager'], ['alias.x', '!echo hi'],
      ['submodule.s.update', 'checkout'], ['filter.x.required', 'true'], ['diff.a.binary', 'true'],
    );
    expect(dangerousConfigKeys(quiet)).toEqual([]);
  });

  it('flags a credential helper that is not a known helper name (git runs it through the shell)', () => {
    for (const value of ['x; calc', 'evil', 'manager $(calc)', 'store --file=x;calc', 'cache `calc`', 'manager\ncalc', '../x', 'manager && calc']) {
      expect(dangerousConfigKeys(entries(['credential.helper', value])), value).toEqual(['credential.helper']);
    }
    for (const value of ['', 'manager', 'manager-core', 'wincred', 'osxkeychain', 'libsecret', 'cache --timeout=3600', 'store --file=~/.git-credentials']) {
      expect(dangerousConfigKeys(entries(['credential.helper', value])), value).toEqual([]);
    }
  });

  it('never reports a value, and removes credentials that sit inside a key', () => {
    const found = dangerousConfigKeys(entries(['url.https://user:s3cr3t@evil.example/.insteadOf', 'https://good/'], ['core.sshCommand', 'secret-command']));
    expect(JSON.stringify(found)).not.toContain('s3cr3t');
    expect(JSON.stringify(found)).not.toContain('secret-command');
  });

  it('finds attribute references to configured drivers', () => {
    const drivers = attributeDrivers('# c\n*.png filter=lfs diff=lfs merge=lfs -text\n*.md text\n\n*.dat   diff=hex\n');
    expect(drivers).toEqual([
      { kind: 'filter', name: 'lfs' }, { kind: 'diff', name: 'lfs' }, { kind: 'merge', name: 'lfs' }, { kind: 'diff', name: 'hex' },
    ]);
    const defined = entries(['filter.lfs.clean', 'git-lfs clean'], ['diff.hex.textconv', 'xxd'], ['diff.lfs.binary', 'true']);
    expect(configuredAttributeDrivers(drivers, defined)).toEqual(['.gitattributes: diff=hex', '.gitattributes: filter=lfs']);
    expect(configuredAttributeDrivers(drivers, [])).toEqual([]);
  });
});

describe('Windows path hardening', () => {
  it('rejects 8.3 aliases, trailing dots and spaces and streams only on Windows', () => {
    for (const bad of ['GIT~1/config', 'a/GIT~1', 'progra~1/x', '.git./config', '.git /config', 'a/.GIT.', 'file.txt:stream', 'a./b', 'a /b', 'dir/name ']) {
      expect(normalizeRepoPath(bad, true), bad).toBeNull();
    }
    expect(normalizeRepoPath('GIT~1/config', false)).toBe('GIT~1/config');
    expect(normalizeRepoPath('docs/readme.md', true)).toBe('docs/readme.md');
    expect(normalizeRepoPath('zażółć gęślą/plik ✓.txt', true)).toBe('zażółć gęślą/plik ✓.txt');
  });
});

describe('worktrees the project may use', () => {
  it('allows the project folder, folders inside it, app-made siblings and cell worktrees only', () => {
    const project = 'D:\\Projekty\\app';
    expect(worktreeAllowed(project, 'D:/Projekty/app')).toBe(true);
    expect(worktreeAllowed(project, 'D:/Projekty/app/sub/wt')).toBe(true);
    expect(worktreeAllowed(project, 'D:/Projekty/app-wt-fix-login')).toBe(true);
    expect(worktreeAllowed(project, 'D:/Projekty/app-wt-fix-login/nested')).toBe(false);
    expect(worktreeAllowed(project, 'D:/Projekty/other')).toBe(false);
    expect(worktreeAllowed(project, 'D:/Projekty/app2')).toBe(false);
    expect(worktreeAllowed(project, 'C:/Users/me')).toBe(false);
    expect(worktreeAllowed(project, 'D:/Elsewhere/wt', ['D:\\Elsewhere\\wt'])).toBe(true);
  });
});

describe('trust requests', () => {
  it('needs a request id for grant and revoke and ignores anything else the renderer adds', () => {
    expect(validateGitRequest('trustGrant', { requestId: 'req-12345678', trusted: true, state: 'trusted' })).toEqual({ ok: true, value: { requestId: 'req-12345678' } });
    expect(validateGitRequest('trustRevoke', { requestId: 'req-12345678' }).ok).toBe(true);
    expect(validateGitRequest('trustGrant', {}).ok).toBe(false);
    expect(validateGitRequest('trust', { trusted: true })).toEqual({ ok: true, value: {} });
    // a "trusted" flag on an ordinary call is dropped
    expect(validateGitRequest('commit', { requestId: 'req-12345678', message: 'x', trusted: true })).toEqual({ ok: true, value: { requestId: 'req-12345678', message: 'x' } });
    expect(validateGitRequest('status', { trusted: true, trust: true })).toEqual({ ok: true, value: {} });
  });
});
