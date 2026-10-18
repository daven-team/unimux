// The trust model and the hardening of the Git engine, against a hostile repository whose configuration names marker-writing programs
// (fsmonitor, filters, textconv, external diff, pager, uploadpack/receivepack, ssh, credential helper, hooks, alias, include).
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Git } from '../src/main/git';
import { handleGit } from '../src/main/gitHandler';
import { canonicalPath, samePath } from '../src/main/gitPaths';
import type { GitResult, GitStatus, GitTrustInfo } from '../src/shared/git';

// Real git processes: slow under a busy machine or CI runner, so these tests get more time than the 20 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let lab: string;
let env: NodeJS.ProcessEnv;
let git: Git;
let marker: string;
let counter = 0;
const windows = process.platform === 'win32';
const id = () => `req-${String(++counter).padStart(6, '0')}-trst`;
const slash = (value: string) => value.split(String.fromCharCode(92)).join('/');

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
const write = (dir: string, name: string, text: string) => writeFileSync(join(dir, name), text);
const markers = (): string[] => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);
const data = <T>(result: { ok: boolean }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return (result as unknown as { data: T }).data;
};
const call = (project: string, channel: string, request: unknown = {}, instance: Git = git) => handleGit(instance, project, channel, request, windows);

/** The command a configuration key runs: node writes its name into the marker file (and passes stdin through for filters). */
const program = (name: string) => `"${slash(process.execPath)}" "${slash(join(lab, 'mark.js'))}" ${name}`;

/** A repository with a bare remote and a first commit, then every dangerous thing a hostile repository can carry. */
function hostile(name: string): { dir: string; bare: string } {
  const bare = join(lab, `${name}.git`);
  sh(lab, 'init', '-q', '--bare', '-b', 'main', bare);
  const dir = join(lab, name);
  sh(lab, 'clone', '-q', bare, dir);
  write(dir, 'a.txt', 'one\n');
  write(dir, 'data.dat', 'binary-ish\n');
  write(dir, '.gitattributes', '*.txt filter=mark\n*.dat diff=mark\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'first');
  sh(dir, 'push', '-q', 'origin', 'main');
  markersReset();
  for (const [key, value] of [
    ['core.fsmonitor', program('fsmonitor')], ['filter.mark.clean', program('clean')], ['filter.mark.smudge', program('smudge')],
    ['diff.mark.textconv', program('textconv')], ['diff.external', program('extdiff')], ['core.pager', program('pager')],
    ['pager.log', program('pager-log')], ['remote.origin.uploadpack', program('uploadpack')], ['remote.origin.receivepack', program('receivepack')],
    ['core.sshCommand', program('ssh')], ['credential.helper', `!${program('credential')}`], ['alias.boom', `!${program('alias')}`],
    ['include.path', '../nowhere.gitconfig'],
  ] as const) sh(dir, 'config', key, value);
  const hooks = join(dir, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'post-index-change', 'reference-transaction', 'pre-push', 'post-merge']) {
    const file = join(hooks, hook);
    writeFileSync(file, `#!/bin/sh\n${program(`hook-${hook}`)}\nexit 0\n`);
    chmodSync(file, 0o755);
  }
  return { dir, bare };
}
const markersReset = () => { rmSync(marker, { force: true }); };

beforeAll(() => {
  lab = realpathSync.native(mkdtempSync(join(tmpdir(), 'mc-trust-')));
  marker = join(lab, 'markers.log');
  writeFileSync(join(lab, 'mark.js'), [
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(slash(join(lab, 'markers.log')))}, process.argv[2] + '\\n');`,
    "if (['clean', 'smudge'].includes(process.argv[2])) process.stdin.pipe(process.stdout);",
    '',
  ].join('\n'));
  const globalConfig = join(lab, 'global.gitconfig');
  writeFileSync(globalConfig, '[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
  env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  git = new Git({ env });
});

afterAll(() => {
  if (!lab.includes('mc-trust-')) throw new Error('unsafe cleanup target');
  rmSync(lab, { recursive: true, force: true });
});

describe('an untrusted repository', () => {
  it('lists what can start a program, without starting any of it', async () => {
    const { dir } = hostile('listing');
    const info = data<GitTrustInfo>(await call(dir, 'trust'));
    expect(info.state).toBe('untrusted');
    for (const key of [
      'core.fsmonitor', 'filter.mark.clean', 'filter.mark.smudge', 'diff.mark.textconv', 'diff.external', 'core.pager', 'pager.log', 'remote.origin.uploadpack',
      'remote.origin.receivepack', 'core.sshCommand', 'credential.helper', 'include.path', 'hooks/pre-commit', 'hooks/post-commit', 'hooks/pre-push', 'hooks/reference-transaction',
    ]) expect(info.keys.map((k) => k.toLowerCase()), key).toContain(key.toLowerCase());
    expect(info.keys).not.toContain('alias.boom'); // git never runs an alias on its own
    expect(JSON.stringify(info)).not.toContain('mark.js'); // values are not shown
    expect(markers()).toEqual([]);
  });

  it('runs nothing on any IPC channel: reads that were measured are allowed, everything else refuses', async () => {
    const { dir } = hostile('zero');
    write(dir, 'untracked.txt', 'new\n');
    write(dir, 'a.txt', 'two\n');
    const hash = sh(dir, 'rev-parse', 'HEAD').trim();
    const request = { requestId: id() };
    const allowed: Array<[string, unknown]> = [
      ['log', { skip: 0, count: 10 }], ['log', { skip: 0, count: 10, search: 'first', all: true }], ['show', { hash }], ['branches', {}],
      ['diff', { source: 'commit', hash, path: 'a.txt' }], ['diff', { source: 'staged', path: 'a.txt' }], ['trust', {}],
    ];
    for (const [channel, req] of allowed) expect((await call(dir, channel, req)).ok, `${channel} ${JSON.stringify(req)}`).toBe(true);
    const refused: Array<[string, unknown]> = [
      ['status', {}], ['status', { trusted: true, trust: true }], ['diff', { source: 'working', path: 'a.txt' }], ['diff', { source: 'untracked', path: 'untracked.txt' }],
      ['stage', { ...request, paths: ['a.txt'] }], ['stage', { requestId: id(), paths: [], all: true }], ['unstage', { requestId: id(), paths: ['a.txt'] }],
      ['commit', { requestId: id(), message: 'nope' }], ['fetch', { requestId: id() }], ['pull', { requestId: id() }],
      ['push', { requestId: id(), remote: 'origin', branch: 'main', urlId: '0123456789abcdef' }], ['checkout', { requestId: id(), branch: 'main' }],
    ];
    for (const [channel, req] of refused) expect(await call(dir, channel, req), `${channel} ${JSON.stringify(req)}`).toMatchObject({ ok: false, code: 'untrusted' });
    expect((await call(dir, 'status', {})).ok).toBe(false);
    expect(await git.probe(dir)).toBe('repo');
    expect(data<unknown[]>(await git.worktrees(dir))).toHaveLength(1);
    expect(markers()).toEqual([]);
    expect(sh(dir, 'log', '--format=%s').trim()).toBe('first'); // nothing was committed either
  });

  it('cannot be trusted by a flag on an ordinary call, only by the dedicated request', async () => {
    const { dir } = hostile('flag');
    expect(await call(dir, 'status', { trusted: true })).toMatchObject({ ok: false, code: 'untrusted' });
    expect(await call(dir, 'commit', { requestId: id(), message: 'x', trusted: true })).toMatchObject({ ok: false, code: 'untrusted' });
    expect(await call(dir, 'trustGrant', {})).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call(dir, 'trustGrant', { requestId: 'short' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(data<GitTrustInfo>(await call(dir, 'trust')).state).toBe('untrusted');
    const rid = id();
    expect(data<GitTrustInfo>(await call(dir, 'trustGrant', { requestId: rid })).state).toBe('trusted');
    expect(await call(dir, 'trustGrant', { requestId: rid })).toMatchObject({ ok: false, code: 'invalid' }); // one use per id
    expect(markers()).toEqual([]); // granting trust starts nothing by itself
  });
});

describe('a trusted repository', () => {
  it('runs what git runs only after the explicit trust, and never the programs we switch off', async () => {
    const { dir, bare } = hostile('trusted');
    write(dir, 'b.txt', 'b\n');
    data(await call(dir, 'trustGrant', { requestId: id() }));
    expect(markers()).toEqual([]);
    expect(data<GitStatus>(await call(dir, 'status', {})).branch).toBe('main');
    data(await call(dir, 'stage', { requestId: id(), paths: ['b.txt'] })); // the clean filter runs
    data(await call(dir, 'commit', { requestId: id(), message: 'add b' })); // the commit hooks run
    expect(await call(dir, 'fetch', { requestId: id() })).toMatchObject({ ok: false }); // uploadpack is our marker, not a real upload-pack
    const seen = markers();
    expect(seen).toContain('clean');
    expect(seen).toContain('hook-pre-commit');
    expect(seen).toContain('hook-post-commit');
    expect(seen).toContain('uploadpack');
    for (const never of ['fsmonitor', 'textconv', 'extdiff', 'pager', 'pager-log', 'alias']) expect(seen, never).not.toContain(never);
    // reading history and diffs still starts none of the disabled ones
    markersReset();
    const hash = sh(dir, 'rev-parse', 'HEAD').trim();
    expect((await call(dir, 'diff', { source: 'commit', hash, path: 'b.txt' })).ok).toBe(true);
    expect((await call(dir, 'diff', { source: 'working', path: 'a.txt' })).ok).toBe(true);
    expect((await call(dir, 'log', { skip: 0, count: 5 })).ok).toBe(true);
    for (const never of ['fsmonitor', 'textconv', 'extdiff', 'pager', 'pager-log', 'alias']) expect(markers(), never).not.toContain(never);
    expect(sh(bare, 'log', '--format=%s', 'main').trim()).toBe('first');
  });

  it('asks again when the configuration or a hook changes, and remembers the answer across restarts', async () => {
    const { dir } = hostile('changes');
    const trustFile = join(lab, 'trust-store', 'git-trust.json');
    const first = new Git({ env, trustFile });
    data(await call(dir, 'trustGrant', { requestId: id() }, first));
    const again = new Git({ env, trustFile });
    expect(data<GitTrustInfo>(await call(dir, 'trust', {}, again)).state).toBe('trusted');
    sh(dir, 'config', 'core.sshCommand', program('ssh-changed'));
    expect(data<GitTrustInfo>(await call(dir, 'trust', {}, again)).state).toBe('untrusted');
    expect(await call(dir, 'status', {}, again)).toMatchObject({ ok: false, code: 'untrusted' });
    data(await call(dir, 'trustGrant', { requestId: id() }, again));
    expect(data<GitTrustInfo>(await call(dir, 'trust', {}, again)).state).toBe('trusted');
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${program('hook-changed')}\nexit 0\n`);
    expect(data<GitTrustInfo>(await call(dir, 'trust', {}, again)).state).toBe('untrusted');
    data(await call(dir, 'trustGrant', { requestId: id() }, again));
    data(await call(dir, 'trustRevoke', { requestId: id() }, again));
    expect(data<GitTrustInfo>(await call(dir, 'trust', {}, again)).state).toBe('untrusted');
    expect(data<GitTrustInfo>(await call(dir, 'trust', {}, new Git({ env, trustFile }))).state).toBe('untrusted');
  });

  it('treats a repository without risky configuration as safe', async () => {
    const dir = join(lab, 'quiet');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'a.txt', 'a\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'one');
    const info = data<GitTrustInfo>(await call(dir, 'trust'));
    expect(info).toMatchObject({ state: 'safe', keys: [], parent: false });
    expect((await call(dir, 'status', {})).ok).toBe(true);
  });

  it('picks up a hostile .gitattributes that names a driver defined outside the repository', async () => {
    const dir = join(lab, 'attributes');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, '.gitattributes', '*.png filter=lfs\n');
    const globalWithDriver = join(lab, 'driver.gitconfig');
    writeFileSync(globalWithDriver, '[user]\n\tname = T\n\temail = t@example.com\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
    const withDriver = new Git({ env: { ...env, GIT_CONFIG_GLOBAL: globalWithDriver } });
    const info = data<GitTrustInfo>(await call(dir, 'trust', {}, withDriver));
    expect(info.state).toBe('untrusted');
    expect(info.keys).toEqual(['.gitattributes: filter=lfs']);
    expect(data<GitTrustInfo>(await call(dir, 'trust', {}, git)).state).toBe('safe'); // no such driver for this user
  });
});

describe('untracked file diffs stay inside the repository', () => {
  it('only shows files git lists as untracked', async () => {
    const dir = join(lab, 'confine');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    sh(dir, 'remote', 'add', 'origin', 'https://user:tok3n-secret@example.com/r.git');
    write(dir, 'tracked.txt', 't\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'one');
    write(dir, 'new.txt', 'visible https://bob:hunter2@host.example/x.git here\n');
    write(dir, '.gitignore', 'ignored.log\n');
    write(dir, 'ignored.log', 'ignored\n');
    const shown = data<{ text: string }>(await git.diff(dir, { source: 'untracked', path: 'new.txt' }));
    expect(shown.text).toContain('+visible https://***@host.example/x.git here');
    expect(shown.text).not.toContain('hunter2');
    for (const path of ['tracked.txt', 'ignored.log', '.git/config', 'GIT~1/config', 'git~1/config', 'missing.txt', 'new.txt/../tracked.txt', '.']) {
      const result = await git.diff(dir, { source: 'untracked', path });
      expect(result.ok, path).toBe(false);
      expect(JSON.stringify(result), path).not.toContain('tok3n-secret');
    }
    // through the IPC the Windows alias is already refused by validation
    expect(await call(dir, 'diff', { source: 'untracked', path: 'GIT~1/config' })).toMatchObject({ ok: false, code: windows ? 'invalid' : 'invalid' });
  });

  it('does not follow a junction or symlink out of the repository', async () => {
    const dir = join(lab, 'junction');
    const outside = join(lab, 'outside-secrets');
    mkdirSync(dir);
    mkdirSync(outside);
    write(outside, 'secret.txt', 'TOP-SECRET-OUTSIDE\n');
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'a.txt', 'a\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'one');
    symlinkSync(outside, join(dir, 'link'), 'junction');
    for (const path of ['link/secret.txt', 'link']) {
      const result = await git.diff(dir, { source: 'untracked', path });
      expect(result.ok, path).toBe(false);
      expect(JSON.stringify(result), path).not.toContain('TOP-SECRET-OUTSIDE');
    }
  });

  it('redacts credentials in commit messages and commit diffs too', async () => {
    const dir = join(lab, 'redact');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'cfg.txt', 'url = https://bob:hunter2@host.example/x.git\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'push to https://bob:hunter2@host.example/x.git');
    const hash = sh(dir, 'rev-parse', 'HEAD').trim();
    const diff = data<{ text: string }>(await git.diff(dir, { source: 'commit', hash, path: 'cfg.txt' }));
    expect(diff.text).not.toContain('hunter2');
    expect(diff.text).not.toContain('ghp_abc');
    const details = data<{ message: string; commit: { subject: string } }>(await git.show(dir, hash));
    expect(details.message).not.toContain('hunter2');
    expect(details.commit.subject).not.toContain('hunter2');
  });
});

describe('write operations', () => {
  it('survive a tiny output cap: the excess is discarded, git is never stopped, nothing is left locked', async () => {
    const dir = join(lab, 'crlf');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    sh(dir, 'config', 'core.autocrlf', 'true');
    sh(dir, 'config', 'core.safecrlf', 'warn');
    for (let i = 0; i < 300; i++) write(dir, `file-${i}.txt`, `line one\nline two ${i}\n`);
    // Only the output caps are under test: a loaded CI runner may need longer than the 10 s of a normal read for 300 files.
    const tiny = new Git({ env, maxOutputBytes: 200, writeOutputBytes: 300, readTimeoutMs: 60_000 });
    const result = await tiny.stage(dir, { requestId: id(), paths: [], all: true });
    expect(result).toMatchObject({ ok: true });
    expect(sh(dir, 'diff', '--cached', '--name-only').trim().split('\n')).toHaveLength(300);
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false);
    const committed = await tiny.commit(dir, { requestId: id(), message: 'all of them' });
    expect(committed).toMatchObject({ ok: true });
    expect(sh(dir, 'log', '--format=%s').trim()).toBe('all of them');
  });

  it('refuses a read that would be cut instead of acting on partial output', async () => {
    const dir = join(lab, 'cut');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    for (let i = 0; i < 80; i++) write(dir, `tracked-file-${i}.txt`, 'x');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'one');
    sh(dir, 'branch', 'other');
    for (let i = 0; i < 80; i++) write(dir, `tracked-file-${i}.txt`, 'changed');
    // the checkout guard reads status internally: a cut-off status must not be taken for "clean"
    const tiny = new Git({ env, maxOutputBytes: 400 });
    const result = await tiny.checkout(dir, { requestId: id(), branch: 'other' });
    expect(result.ok).toBe(false);
    expect(sh(dir, 'branch', '--show-current').trim()).toBe('main');
  });

  it('removes the index.lock of a write it had to kill', async () => {
    const dir = join(lab, 'lock');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'a.txt', 'a');
    // stand-in git: answers the questions that ask for places, takes the index lock for anything else and then hangs
    const script = join(lab, 'lock-git.js');
    writeFileSync(script, [
      "const path = require('path'); const fs = require('fs'); const a = process.argv;",
      "if (a.includes('--show-toplevel')) console.log(process.cwd());",
      "else if (a.includes('--absolute-git-dir')) { console.log(path.join(process.cwd(), '.git')); console.log('.git'); }",
      "else if (a.includes('config') || a.includes('worktree')) { /* no configuration */ }",
      "else { fs.writeFileSync(path.join(process.cwd(), '.git', 'index.lock'), ''); setTimeout(() => {}, 20000); }",
      '',
    ].join('\n'));
    const hanging = new Git({ bin: process.execPath, prefixArgs: [script], env, readTimeoutMs: 400, networkTimeoutMs: 400 });
    const started = Date.now();
    const result = await hanging.stage(dir, { requestId: id(), paths: ['a.txt'] });
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false);
    // and a real git works in the folder right away
    sh(dir, 'add', 'a.txt');
    expect(sh(dir, 'diff', '--cached', '--name-only').trim()).toBe('a.txt');
  });

  it('leaves a lock that it did not create alone', async () => {
    const dir = join(lab, 'foreign-lock');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'a.txt', 'a');
    const stale = join(dir, '.git', 'index.lock');
    writeFileSync(stale, '');
    const old = new Date(Date.now() - 60_000);
    // an old lock (another program's) is no business of ours: the add fails and the file stays
    utimesSync(stale, old, old);
    const result = await git.stage(dir, { requestId: id(), paths: ['a.txt'] });
    expect(result.ok).toBe(false);
    expect(existsSync(stale)).toBe(true);
  });
});

describe('environment and scope', () => {
  it('ignores variables that point git somewhere else', async () => {
    const dir = join(lab, 'envscrub');
    const other = join(lab, 'envscrub-other');
    for (const folder of [dir, other]) { mkdirSync(folder); sh(folder, 'init', '-q', '-b', 'main', '.'); }
    write(dir, 'a.txt', 'a\n');
    const evil = join(dir, 'evil.gitconfig');
    writeFileSync(evil, '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /does/not/exist\n');
    const hostileEnv: NodeJS.ProcessEnv = {
      ...env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'evil-index'), GIT_COMMON_DIR: join(other, '.git'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: program('pager'), GIT_CONFIG_PARAMETERS: "'core.pager'='x'",
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const scrubbed = new Git({ env: hostileEnv });
    const status = data<GitStatus>(await scrubbed.status(dir));
    expect(samePath(status.root, dir)).toBe(true);
    expect(status.files.map((f) => f.path)).toContain('a.txt');
    // a global configuration that lives inside the repository is repository content: it must not apply (here it would require signing)
    const insideGlobal = new Git({ env: { ...hostileEnv, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_CONFIG_GLOBAL: evil } });
    data(await insideGlobal.stage(dir, { requestId: id(), paths: ['a.txt'] }));
    data(await insideGlobal.commit(dir, { requestId: id(), message: 'unsigned because the inner config was dropped' }));
    expect(sh(dir, 'log', '-1', '--format=%s').trim()).toBe('unsigned because the inner config was dropped');
    expect(markers()).not.toContain('pager');
  });

  it('refuses writes in a repository that is larger than the project and says so', async () => {
    const dir = join(lab, 'parentrepo');
    mkdirSync(join(dir, 'packages', 'app'), { recursive: true });
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'top.txt', 't\n');
    write(join(dir, 'packages', 'app'), 'inner.txt', 'i\n');
    const project = join(dir, 'packages', 'app');
    const status = data<GitStatus>(await call(project, 'status', {}));
    expect(status.parent).toBe(true);
    expect(data<GitTrustInfo>(await call(project, 'trust')).parent).toBe(true);
    for (const [channel, req] of [
      ['stage', { requestId: id(), paths: [], all: true }], ['stage', { requestId: id(), paths: ['packages/app/inner.txt'] }], ['unstage', { requestId: id(), paths: ['top.txt'] }],
      ['commit', { requestId: id(), message: 'x' }], ['fetch', { requestId: id() }], ['pull', { requestId: id() }], ['checkout', { requestId: id(), branch: 'main' }],
    ] as const) expect(await call(project, channel, req), channel).toMatchObject({ ok: false, code: 'parent' });
    expect(sh(dir, 'diff', '--cached', '--name-only').trim()).toBe('');
    // the same repository opened at its root is fine
    expect(data<GitStatus>(await call(dir, 'status', {})).parent).toBe(false);
    data(await call(dir, 'stage', { requestId: id(), paths: ['top.txt'] }));
  });

  it('serializes writers of two worktrees of one repository', async () => {
    const dir = join(lab, 'lockwt');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'a.txt', 'a\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'one');
    const wt = join(lab, 'lockwt-wt-b');
    sh(dir, 'worktree', 'add', '-q', '-b', 'b', wt);
    write(dir, 'x.txt', 'x');
    write(wt, 'y.txt', 'y');
    // A writer in the main worktree holds the repository lock (taken only after a few git reads, so two real writers started
    // together may just as well run one after the other): the other worktree's writer has to wait its turn.
    const busy = (git as unknown as { busy: Set<string> }).busy;
    const key = canonicalPath(join(dir, '.git'));
    busy.add(key);
    expect(await git.stage(wt, { requestId: id(), paths: ['y.txt'] })).toMatchObject({ ok: false, code: 'busy' });
    busy.delete(key);
    expect((await git.stage(wt, { requestId: id(), paths: ['y.txt'] })).ok).toBe(true);
    expect((await git.stage(dir, { requestId: id(), paths: ['x.txt'] })).ok).toBe(true);
  });

  it('refuses a push when the URL it would use is not the one the user confirmed', async () => {
    const bare = join(lab, 'urlcheck.git');
    const other = join(lab, 'urlcheck-other.git');
    sh(lab, 'init', '-q', '--bare', '-b', 'main', bare);
    sh(lab, 'init', '-q', '--bare', '-b', 'main', other);
    const dir = join(lab, 'urlcheck');
    sh(lab, 'clone', '-q', bare, dir);
    write(dir, 'a.txt', 'a\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'to push');
    const confirmed = data<GitStatus>(await call(dir, 'status', {})).push!;
    expect(confirmed.url).toBeTruthy();
    // the push URL changes after the user confirmed (a pushurl pointing somewhere else)
    sh(dir, 'config', 'remote.origin.pushurl', other);
    const refused = await call(dir, 'push', { requestId: id(), remote: confirmed.remote, branch: confirmed.branch, urlId: confirmed.urlId });
    expect(refused).toMatchObject({ ok: false, code: 'invalid' });
    expect(sh(other, 'rev-list', '--all', '--count').trim()).toBe('0');
    const now = data<GitStatus>(await call(dir, 'status', {})).push!;
    expect(now.urlId).not.toBe(confirmed.urlId);
    expect(slash(now.url)).toBe(slash(other));
    data(await call(dir, 'push', { requestId: id(), remote: now.remote, branch: now.branch, urlId: now.urlId }));
    expect(sh(other, 'rev-list', '--all', '--count').trim()).toBe('1');
  });

  it('shows the pushing URL without credentials', async () => {
    const dir = join(lab, 'urlsecret');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'a.txt', 'a\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'one');
    sh(dir, 'remote', 'add', 'origin', 'https://user:p4ssw0rd@example.com/r.git');
    const status = data<GitStatus>(await call(dir, 'status', {}));
    expect(status.push!.url).toBe('https://***@example.com/r.git');
    expect(JSON.stringify(status)).not.toContain('p4ssw0rd');
  });
});

describe('results of the trust requests', () => {
  it('shape of an error for an untrusted repository carries a message the panel can translate', async () => {
    const { dir } = hostile('message');
    const result = (await call(dir, 'status', {})) as GitResult<unknown>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Zaufaj mu');
  });
});
