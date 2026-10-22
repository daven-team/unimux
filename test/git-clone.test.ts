// "Clone a repository": the address check, the folder name it suggests, the request check, and Git.clone with a stand-in git
// (no network) that records what it was started with.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Git } from '../src/main/git';
import { cloneFolderName, isCloneUrl, isSafeFolderName, validateCloneRequest } from '../src/shared/git';

describe('clone address', () => {
  it('accepts https, ssh:// and the scp form', () => {
    for (const ok of [
      'https://github.com/octocat/Hello-World.git', 'https://gitlab.example.com/group/sub/repo', 'https://host:8443/a/b.git',
      'ssh://git@github.com/owner/repo.git', 'ssh://host:2222/srv/repo.git', 'git@github.com:owner/repo.git', 'me@my-host.local:/srv/git/x.git',
    ]) expect(isCloneUrl(ok), ok).toBe(true);
  });

  it('refuses other transports, options, local paths, credentials and odd characters', () => {
    for (const bad of [
      'ext::sh -c touch% /tmp/pwned', 'file:///etc/repo', 'http://example.com/repo.git', '-uhttps://github.com/a/b', '--upload-pack=x',
      'C:\\repos\\a', '/srv/git/a.git', '../a', 'https://user:pass@github.com/a/b.git', 'https://tok@github.com/a/b.git',
      'https://github.com/a b', 'https://github.com/a\nb', 'https://github.com/a\tb', 'https://github.com/a\x00b', 'https://github.com/',
      'git@host:-oProxyCommand=x', 'git@-host:a', 'ssh://-oProxyCommand=x/a', 'ssh://user:pw@host/a', 'fd::17', 'github.com:a/b', '', 42, null,
      `https://github.com/${'a'.repeat(2001)}`,
    ]) expect(isCloneUrl(bad), String(bad)).toBe(false);
  });

  it('suggests the folder name git would use', () => {
    expect(cloneFolderName('https://github.com/octocat/Hello-World.git')).toBe('Hello-World');
    expect(cloneFolderName('https://gitlab.com/group/sub/repo/')).toBe('repo');
    expect(cloneFolderName('git@github.com:owner/tool.GIT')).toBe('tool');
    expect(cloneFolderName('git@host:project.git')).toBe('project');
    expect(cloneFolderName('ssh://host/srv/con.git')).toBe('con-repo');
    expect(cloneFolderName('https://host/a/.git')).toBe('repo');
    expect(cloneFolderName('https://host/a/b.c..')).toBe('b.c');
    for (const url of ['https://github.com/octocat/Hello-World.git', 'git@h:x/y z.git', 'https://h/a/con']) expect(isSafeFolderName(cloneFolderName(url)), url).toBe(true);
  });

  it('checks a single folder name', () => {
    for (const ok of ['repo', 'Hello-World', 'my.repo', 'a b']) expect(isSafeFolderName(ok), ok).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'nul', 'COM1', 'aux.txt', 'x.', 'x ', '-x', 'a*b', 'a'.repeat(101), 1]) expect(isSafeFolderName(bad), String(bad)).toBe(false);
  });

  it('validates a request for a project folder or a new folder', () => {
    const url = 'https://github.com/octocat/Hello-World.git';
    expect(validateCloneRequest({ url, projectId: 'p1', extra: 1 })).toEqual({ ok: true, value: { url, projectId: 'p1' } });
    expect(validateCloneRequest({ url, parent: 'C:\\code', name: 'Hello-World' })).toEqual({ ok: true, value: { url, parent: 'C:\\code', name: 'Hello-World' } });
    expect(validateCloneRequest({ url, parent: '/home/me/code', name: 'x' }).ok).toBe(true);
    expect(validateCloneRequest({ url: 'ext::x', projectId: 'p1' })).toEqual({ ok: false, error: 'Podaj adres repozytorium: https://…, ssh://… albo git@host:ścieżka.' });
    for (const bad of [null, 'x', { url }, { url, parent: 'relative', name: 'x' }, { url, parent: '/a', name: '../x' }, { url, parent: '/a\nb', name: 'x' }, { url, parent: '/a', name: '' }]) {
      expect(validateCloneRequest(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('Git.clone', () => {
  let lab: string;
  let log: string;
  /** A stand-in for git: records its arguments and the GitHub header variable, creates .git, fails for addresses with "fail". */
  let script: string;
  const make = (auth: Record<string, string> | null) => new Git({ bin: process.execPath, prefixArgs: [script], env: { ...process.env, FAKE_LOG: log }, remoteAuth: () => auth });

  beforeAll(() => {
    lab = realpathSync.native(mkdtempSync(join(tmpdir(), 'mc-clone-')));
    log = join(lab, 'log.json');
    script = join(lab, 'fake-git.cjs');
    writeFileSync(script, [
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      "fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), header: process.env.GIT_CONFIG_KEY_0 || null }));",
      "if (args.some((a) => a.includes('fail'))) { process.stderr.write('fatal: repository not found'); process.exit(128); }",
      "fs.mkdirSync('.git'); process.stderr.write(\"Cloning into '.'...\\n\");",
    ].join('\n'));
  });
  afterAll(() => {
    if (!lab.includes('mc-clone-')) throw new Error('unsafe cleanup target');
    rmSync(lab, { recursive: true, force: true });
  });
  const last = () => JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; cwd: string; header: string | null };

  it('clones into a new folder with "--" before the address and ext:: off, the GitHub sign-in for github.com only', async () => {
    const target = join(lab, 'one');
    const result = await make({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'x' }).clone(target, 'https://github.com/octocat/Hello-World.git');
    expect(result.ok).toBe(true);
    const run = last();
    expect(run.args.slice(-4)).toEqual(['clone', '--', 'https://github.com/octocat/Hello-World.git', '.']);
    expect(run.args.join(' ')).toContain('protocol.ext.allow=never');
    expect(realpathSync.native(run.cwd)).toBe(realpathSync.native(target));
    expect(run.header).toBe('http.https://github.com/.extraheader');
    expect(existsSync(join(target, '.git'))).toBe(true);

    const other = join(lab, 'two');
    expect((await make({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'h', GIT_CONFIG_VALUE_0: 'x' }).clone(other, 'https://gitlab.com/a/b.git')).ok).toBe(true);
    expect(last().header).toBeNull();
  });

  it('clones into an existing empty folder and refuses one that has files', async () => {
    const empty = join(lab, 'empty');
    mkdirSync(empty);
    expect((await make(null).clone(empty, 'git@github.com:a/b.git')).ok).toBe(true);
    const full = join(lab, 'full');
    mkdirSync(full);
    writeFileSync(join(full, 'note.txt'), 'x');
    const refused = await make(null).clone(full, 'git@github.com:a/b.git');
    expect(refused).toMatchObject({ ok: false, code: 'invalid', error: 'Folder docelowy nie jest pusty. Klonować można tylko do pustego folderu.' });
  });

  it('removes the folder it made when the clone fails, and refuses a bad address before git runs', async () => {
    const target = join(lab, 'failed');
    const failed = await make(null).clone(target, 'https://example.com/fail.git');
    expect(failed.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
    rmSync(log, { force: true });
    expect(await make(null).clone(join(lab, 'bad'), 'ext::sh -c x')).toMatchObject({ ok: false, code: 'invalid' });
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(lab, 'bad'))).toBe(false);
  });
});
