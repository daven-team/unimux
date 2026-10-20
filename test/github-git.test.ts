// The git half of "Publish to GitHub" against REAL repositories in temporary folders: the remote is added and the branch pushed
// with upstream, the token reaches git in the environment only (a pass-through stand-in records every command line), and fetch,
// pull and push use the stored sign-in with a second try without it when GitHub refuses it. github.com itself is never contacted:
// a global `insteadOf` turns the https address into a local bare repository.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Git } from '../src/main/git';
import { githubGitEnv } from '../src/main/github/gitEnv';
import type { GitStatus } from '../src/shared/git';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';
const HEADER = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const URL = 'https://github.com/ajzak/demo.git';

let lab: string;
let env: NodeJS.ProcessEnv;
let spy: string;
let counter = 0;
const id = () => `req-${String(++counter).padStart(6, '0')}-ghub`;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(name: string, commits: number): string {
  const dir = join(lab, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main', '.');
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(dir, 'file.txt'), `line ${i}\n`);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', `commit ${i}`);
  }
  return dir;
}

/** A Git engine whose "git" is the recording stand-in (`log` gets one JSON line per run). */
function spiedGit(log: string, extra: NodeJS.ProcessEnv = {}, remoteAuth?: () => Record<string, string> | null): Git {
  return new Git({ bin: process.execPath, prefixArgs: [spy], env: { ...env, SPY_LOG: log, ...extra }, remoteAuth });
}
const runs = (log: string): Array<{ args: string[]; header: string | null }> =>
  readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

const data = <T>(result: { ok: boolean }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return (result as unknown as { data: T }).data;
};

beforeAll(() => {
  lab = realpathSync.native(mkdtempSync(join(tmpdir(), 'mc-ghpub-')));
  const bare = join(lab, 'demo.git').replace(/\\/g, '/');
  const globalConfig = join(lab, 'global.gitconfig');
  writeFileSync(globalConfig, `[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n[url "${bare}"]\n\tinsteadOf = ${URL}\n`);
  env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  spy = join(lab, 'spy.cjs');
  writeFileSync(spy, [
    "const { spawnSync } = require('child_process');",
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.SPY_LOG, JSON.stringify({ args, header: process.env.GIT_CONFIG_VALUE_0 || null }) + '\\n');",
    "if (process.env.SPY_REFUSE === '1' && process.env.GIT_CONFIG_VALUE_0 && args.includes('fetch')) {",
    "  process.stderr.write(\"remote: Invalid username or token.\\nfatal: Authentication failed for 'https://github.com/ajzak/demo.git/'\\n\");",
    '  process.exit(128);',
    '}',
    "const result = spawnSync('git', args, { stdio: 'inherit' });",
    'process.exit(result.status === null ? 1 : result.status);',
  ].join('\n'));
  sh(lab, 'init', '-q', '--bare', '-b', 'main', bare);
});

afterAll(() => {
  if (!lab.includes('mc-ghpub-')) throw new Error('unsafe cleanup target');
  rmSync(lab, { recursive: true, force: true });
});

describe('publishing with git', () => {
  it('adds origin, pushes the branch with upstream and keeps the token off every command line', async () => {
    const work = repo('work', 2);
    const log = join(lab, 'publish.log');
    const git = spiedGit(log);
    expect(data<GitStatus>(await git.status(work)).hasRemote).toBe(false);
    expect(data(await git.publishInfo(work, work))).toEqual({ branch: 'main', initial: false, remotes: [] });

    const pushed = data<{ pushed: boolean }>(await git.publishPush(work, { requestId: id(), url: URL, branch: 'main', env: githubGitEnv(TOKEN) }, work));
    expect(pushed.pushed).toBe(true);
    const status = data<GitStatus>(await git.status(work));
    expect(status.hasRemote).toBe(true);
    expect(status.upstream).toBe('origin/main');
    expect(status.push).toMatchObject({ remote: 'origin', branch: 'main', setUpstream: false });
    expect(sh(join(lab, 'demo.git'), 'rev-parse', 'refs/heads/main').trim()).toBe(sh(work, 'rev-parse', 'HEAD').trim());
    expect(sh(work, 'config', '--get', 'remote.origin.url').trim()).toBe(URL);

    const all = runs(log);
    const text = JSON.stringify(all.map((r) => r.args));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(HEADER);
    const push = all.filter((r) => r.args.includes('push'));
    expect(push).toHaveLength(1);
    expect(push[0].header).toBe(`AUTHORIZATION: basic ${HEADER}`);
    // Only the push carries the credentials.
    expect(all.filter((r) => r.header !== null)).toHaveLength(1);
    // A second publish of the same repository is refused: it has a remote now.
    expect(await git.publishPush(work, { requestId: id(), url: URL, branch: 'main', env: githubGitEnv(TOKEN) }, work)).toMatchObject({ ok: false, code: 'invalid' });
    expect(data(await git.publishInfo(work, work))).toMatchObject({ remotes: ['origin'] });
  });

  it('tells an empty repository and a detached HEAD apart', async () => {
    const git = new Git({ env });
    const empty = repo('empty', 0);
    expect(data(await git.publishInfo(empty, empty))).toEqual({ branch: 'main', initial: true, remotes: [] });
    const detached = repo('detached', 2);
    sh(detached, 'checkout', '-q', '--detach', 'HEAD~1');
    expect(data(await git.publishInfo(detached, detached))).toEqual({ branch: null, initial: false, remotes: [] });
    expect(await git.publishPush(detached, { requestId: id(), url: URL, branch: 'main', env: {} }, detached)).toMatchObject({ ok: false, code: 'invalid' });
    expect(sh(detached, 'remote').trim()).toBe('');
  });

  it('refuses a repository above the project folder', async () => {
    const outer = repo('outer', 1);
    const inner = join(outer, 'sub');
    mkdirSync(inner);
    expect(await new Git({ env }).publishInfo(inner, inner)).toMatchObject({ ok: false, code: 'parent' });
  });
});

describe('fetch, pull and push with the stored GitHub sign-in', () => {
  it('sends it, and tries once more without it when GitHub refuses it', async () => {
    const clone = join(lab, 'clone');
    sh(lab, 'clone', '-q', URL, clone);
    expect(sh(clone, 'config', '--get', 'remote.origin.url').trim()).toBe(URL);

    const plain = join(lab, 'plain.log');
    expect((await spiedGit(plain, {}, () => githubGitEnv(TOKEN)).fetch(clone, id(), clone)).ok).toBe(true);
    const fetches = runs(plain).filter((r) => r.args.includes('fetch'));
    expect(fetches.map((r) => r.header)).toEqual([`AUTHORIZATION: basic ${HEADER}`]);

    const refused = join(lab, 'refused.log');
    expect((await spiedGit(refused, { SPY_REFUSE: '1' }, () => githubGitEnv(TOKEN)).fetch(clone, id(), clone)).ok).toBe(true);
    expect(runs(refused).filter((r) => r.args.includes('fetch')).map((r) => r.header)).toEqual([`AUTHORIZATION: basic ${HEADER}`, null]);

    const none = join(lab, 'none.log');
    expect((await spiedGit(none, {}, () => null).pull(clone, id(), clone)).ok).toBe(true);
    expect(runs(none).every((r) => r.header === null)).toBe(true);
    expect(JSON.stringify(runs(refused).map((r) => r.args))).not.toContain(TOKEN);
  });
});
