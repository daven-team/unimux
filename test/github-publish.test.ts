// "Publish to GitHub" (1.0.x): repository names, request checks, the token in git's environment (never on the command line),
// GitHub's error answers, the device-flow poll, the token store, the sign-in order and publishing, all with fakes (no network).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  folderBaseName, isGithubPage, isValidRepoName, sanitizeRepoName, validatePublishRequest, type GithubPublishRequest,
} from '../src/shared/github';
import { redactSecrets } from '../src/shared/git';
import {
  createRepo, devicePollStep, ERR, fetchLogin, mapCreateRepoError, pollDeviceToken, requestDeviceCode, TOKEN_URL,
  type FetchLike, type FetchResponse,
} from '../src/main/github/api';
import { GithubAuth, type ExecFile } from '../src/main/github/auth';
import { GITHUB_HEADER_KEY, githubAuthRefused, githubGitEnv } from '../src/main/github/gitEnv';
import { createGithubHandlers, GITHUB_CHANNELS, registerGithubIpc } from '../src/main/github/ipc';
import { createPublisher, PUBLISH_ERR } from '../src/main/github/publish';
import { GithubTokenStore } from '../src/main/github/tokenStore';
import { createIpcGuard, type IpcSenderEvent } from '../src/main/ipcGuard';
import type { Cipher } from '../src/main/ssh/vault';

const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';
const RID = 'req-000001-github';

function cipher(available = true): Cipher {
  return {
    storage: available ? 'dpapi' : 'unavailable',
    available: () => available,
    encrypt: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('hex')}`),
    decrypt: (data) => {
      const s = data.toString();
      if (!s.startsWith('enc:')) throw new Error('cannot decrypt');
      return Buffer.from(s.slice(4), 'hex').toString('utf8');
    },
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
/** A fetch that answers from a list (or a function) and records every request. */
function fakeFetch(answers: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | 'offline'>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = answers.shift();
    if (!next || next === 'offline') throw new TypeError('fetch failed');
    const headers = new Map(Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const response: FetchResponse = { status: next.status, ok: next.status < 300, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, json: async () => next.body };
    return response;
  };
  return { fetch, calls };
}

describe('repository names', () => {
  it('follows GitHub’s rules', () => {
    for (const ok of ['unimux', 'my-repo', 'a.b_c-d', '.github', 'x'.repeat(100)]) expect(isValidRepoName(ok), ok).toBe(true);
    for (const bad of ['', '.', '..', 'a b', 'ąę', 'repo.git', 'REPO.GIT', 'x'.repeat(101), 'a/b', '-'.repeat(0), 42, null]) expect(isValidRepoName(bad), String(bad)).toBe(false);
  });

  it('suggests a valid name from any folder name', () => {
    expect(sanitizeRepoName('MULTICODING')).toBe('MULTICODING');
    expect(sanitizeRepoName('Mój projekt')).toBe('Moj-projekt');
    expect(sanitizeRepoName('Łódź  -- źródła!!')).toBe('Lodz-zrodla');
    expect(sanitizeRepoName('  spaced out  ')).toBe('spaced-out');
    expect(sanitizeRepoName('site.git')).toBe('site');
    expect(sanitizeRepoName('.dotfiles')).toBe('.dotfiles');
    expect(sanitizeRepoName('trailing.')).toBe('trailing');
    expect(sanitizeRepoName('日本語')).toBe('repository');
    expect(sanitizeRepoName('..')).toBe('repository');
    expect(sanitizeRepoName('a'.repeat(140)).length).toBe(100);
    for (const folder of ['Mój projekt', '日本語', 'a'.repeat(140), '...', '-x-', 'x.git.git']) expect(isValidRepoName(sanitizeRepoName(folder)), folder).toBe(true);
  });

  it('takes the folder name from either kind of path', () => {
    expect(folderBaseName('D:\\Projekty\\MULTICODING\\')).toBe('MULTICODING');
    expect(folderBaseName('/home/a/my app')).toBe('my app');
  });
});

describe('publish request validation', () => {
  it('keeps the known fields and refuses anything odd', () => {
    expect(validatePublishRequest({ requestId: RID, name: 'unimux', private: true, extra: 1 })).toEqual({ ok: true, value: { requestId: RID, name: 'unimux', private: true } });
    expect(validatePublishRequest({ requestId: RID, name: 'unimux', private: false, worktree: 'D:\\wt' })).toEqual({ ok: true, value: { requestId: RID, name: 'unimux', private: false, worktree: 'D:\\wt' } });
    expect(validatePublishRequest({ requestId: RID, name: 'bad name', private: true })).toMatchObject({ ok: false, error: expect.stringContaining('100') });
    expect(validatePublishRequest({ requestId: 'x', name: 'unimux', private: true }).ok).toBe(false);
    expect(validatePublishRequest({ requestId: RID, name: 'unimux', private: 'yes' }).ok).toBe(false);
    expect(validatePublishRequest({ requestId: RID, name: 'unimux', private: true, worktree: 'a\0b' }).ok).toBe(false);
    expect(validatePublishRequest(null).ok).toBe(false);
    expect(validatePublishRequest([]).ok).toBe(false);
  });

  it('opens GitHub’s own pages only', () => {
    expect(isGithubPage('https://github.com/login/device')).toBe(true);
    expect(isGithubPage('https://github.com/a/b')).toBe(true);
    for (const bad of ['http://github.com/login/device', 'https://github.com.evil.io/x', 'https://evil.io/github.com', 'https://user@github.com/x', 'javascript:alert(1)', 5]) expect(isGithubPage(bad), String(bad)).toBe(false);
  });
});

describe('the token in git’s environment', () => {
  it('is one header for https://github.com/ in GIT_CONFIG_*, never an argument', () => {
    const env = githubGitEnv(TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe(GITHUB_HEADER_KEY);
    expect(GITHUB_HEADER_KEY).toBe('http.https://github.com/.extraheader');
    const [, scheme, value] = /^(AUTHORIZATION: basic) (\S+)$/.exec(env.GIT_CONFIG_VALUE_0)!;
    expect(scheme).toBe('AUTHORIZATION: basic');
    expect(Buffer.from(value, 'base64').toString('utf8')).toBe(`x-access-token:${TOKEN}`);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_TRACE_CURL).toBe('0');
    expect(env.GIT_TRACE_REDACT).toBe('1');
    // Nothing else carries the token, in clear or encoded.
    const others = Object.entries(env).filter(([key]) => key !== 'GIT_CONFIG_VALUE_0').map(([, v]) => v).join('\n');
    expect(others).not.toContain(TOKEN);
    expect(others).not.toContain(value);
  });

  it('a header that ever shows up in git’s output is redacted', () => {
    expect(redactSecrets(`> AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`)).toBe('> AUTHORIZATION: basic ***');
    expect(redactSecrets(`token ${TOKEN}`)).toBe('token ***');
  });

  it('recognizes GitHub refusing the credentials (and only for github.com)', () => {
    expect(githubAuthRefused("remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b.git/'")).toBe(true);
    expect(githubAuthRefused("remote: Permission to a/b.git denied to c.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403")).toBe(true);
    expect(githubAuthRefused("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found")).toBe(true);
    expect(githubAuthRefused("fatal: Authentication failed for 'https://gitlab.com/a/b.git/'")).toBe(false);
    expect(githubAuthRefused("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com")).toBe(false);
    expect(githubAuthRefused(' ! [rejected]        main -> main (fetch first)')).toBe(false);
  });
});

describe('GitHub answers to "create repository"', () => {
  it('maps the status codes to what the dialog says', () => {
    expect(mapCreateRepoError(401, { message: 'Bad credentials' })).toEqual({ ok: false, code: 'auth', error: ERR.auth });
    expect(mapCreateRepoError(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }))
      .toEqual({ ok: false, code: 'exists', error: ERR.exists });
    expect(mapCreateRepoError(422, { message: 'Validation Failed', errors: [{ field: 'name', code: 'invalid', message: 'name is too long' }] }))
      .toEqual({ ok: false, code: 'invalid', error: ERR.invalidName, detail: 'name is too long' });
    expect(mapCreateRepoError(403, { message: 'API rate limit exceeded for user.' })).toMatchObject({ code: 'rate-limit' });
    expect(mapCreateRepoError(403, {}, { get: (n) => (n === 'x-ratelimit-remaining' ? '0' : null) })).toMatchObject({ code: 'rate-limit' });
    expect(mapCreateRepoError(429, null)).toMatchObject({ code: 'rate-limit' });
    expect(mapCreateRepoError(403, { message: 'Resource not accessible by integration' })).toEqual({ ok: false, code: 'forbidden', error: ERR.forbidden, detail: 'Resource not accessible by integration' });
    expect(mapCreateRepoError(502, null)).toEqual({ ok: false, code: 'failed', error: ERR.failed, detail: 'HTTP 502' });
  });

  it('creates the repository with the token in the header only and checks the addresses it gets back', async () => {
    const created = { full_name: 'ajzak/unimux', html_url: 'https://github.com/ajzak/unimux', clone_url: 'https://github.com/ajzak/unimux.git' };
    const { fetch, calls } = fakeFetch([{ status: 201, body: created }]);
    expect(await createRepo(fetch, TOKEN, { name: 'unimux', private: true })).toEqual({ ok: true, data: { fullName: 'ajzak/unimux', htmlUrl: created.html_url, cloneUrl: created.clone_url } });
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/user/repos', method: 'POST' });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0].body!)).toEqual({ name: 'unimux', private: true, auto_init: false });
    expect(calls[0].url).not.toContain(TOKEN);

    const odd = fakeFetch([{ status: 201, body: { ...created, clone_url: 'https://evil.example/x.git' } }]);
    expect(await createRepo(odd.fetch, TOKEN, { name: 'unimux', private: true })).toMatchObject({ ok: false, code: 'failed' });
    const offline = fakeFetch(['offline']);
    expect(await createRepo(offline.fetch, TOKEN, { name: 'unimux', private: false })).toEqual({ ok: false, code: 'network', error: ERR.network });
  });

  it('reads the login of a token', async () => {
    expect(await fetchLogin(fakeFetch([{ status: 200, body: { login: 'ajzak' } }]).fetch, TOKEN)).toEqual({ ok: true, data: 'ajzak' });
    expect(await fetchLogin(fakeFetch([{ status: 401, body: {} }]).fetch, TOKEN)).toMatchObject({ ok: false, code: 'auth' });
  });
});

describe('device flow', () => {
  const code = { deviceCode: 'dev-123', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };

  it('steps: pending keeps the interval, slow_down raises it, the end states end it', () => {
    expect(devicePollStep(5, 200, { error: 'authorization_pending' })).toEqual({ kind: 'wait', interval: 5 });
    expect(devicePollStep(5, 200, { error: 'slow_down', interval: 10 })).toEqual({ kind: 'wait', interval: 10 });
    expect(devicePollStep(5, 200, { error: 'slow_down' })).toEqual({ kind: 'wait', interval: 10 });
    expect(devicePollStep(5, 200, { error: 'expired_token' })).toEqual({ kind: 'fail', code: 'expired', error: ERR.expired });
    expect(devicePollStep(5, 200, { error: 'access_denied' })).toEqual({ kind: 'fail', code: 'denied', error: ERR.denied });
    expect(devicePollStep(5, 200, { access_token: TOKEN, token_type: 'bearer', scope: 'repo' })).toEqual({ kind: 'token', token: TOKEN });
    expect(devicePollStep(5, 400, { error: 'device_flow_disabled', error_description: 'Device flow is disabled.' })).toEqual({ kind: 'fail', code: 'failed', error: ERR.deviceFailed, detail: 'Device flow is disabled.' });
    expect(devicePollStep(5, 500, null)).toMatchObject({ kind: 'fail', code: 'failed', detail: 'HTTP 500' });
  });

  it('polls at the interval GitHub asks for until the token arrives', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { error: 'authorization_pending' } },
      { status: 200, body: { error: 'slow_down', interval: 10 } },
      'offline',
      { status: 200, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: TOKEN, scope: 'repo' } },
    ]);
    const waits: number[] = [];
    let clock = 0;
    const result = await pollDeviceToken({ fetch, clientId: 'Iv1.abc', code, signal: new AbortController().signal, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    expect(result).toEqual({ ok: true, data: { token: TOKEN } });
    expect(waits).toEqual([5000, 5000, 10000, 10000, 10000]);
    expect(calls.every((c) => c.url === TOKEN_URL && c.method === 'POST')).toBe(true);
    expect(new URLSearchParams(calls[0].body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(new URLSearchParams(calls[0].body).get('device_code')).toBe('dev-123');
  });

  it('ends when the code expires, the user refuses, the network stays down or the flow is cancelled', async () => {
    let clock = 0;
    const tick = async (ms: number) => { clock += ms; };
    const pending = () => fakeFetch(Array.from({ length: 400 }, () => ({ status: 200, body: { error: 'authorization_pending' } }))).fetch;
    expect(await pollDeviceToken({ fetch: pending(), clientId: 'c', code, signal: new AbortController().signal, now: () => clock, sleep: tick })).toMatchObject({ ok: false, code: 'expired' });
    expect(await pollDeviceToken({ fetch: fakeFetch([{ status: 200, body: { error: 'access_denied' } }]).fetch, clientId: 'c', code, signal: new AbortController().signal, sleep: tick }))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(await pollDeviceToken({ fetch: fakeFetch(['offline', 'offline', 'offline']).fetch, clientId: 'c', code, signal: new AbortController().signal, sleep: tick, maxNetworkFailures: 3 }))
      .toEqual({ ok: false, code: 'network', error: ERR.network });
    const controller = new AbortController();
    const cancelled = pollDeviceToken({ fetch: pending(), clientId: 'c', code, signal: controller.signal, sleep: (_ms, signal) => new Promise((done) => signal.addEventListener('abort', () => done())) });
    controller.abort();
    expect(await cancelled).toEqual({ ok: false, code: 'cancelled', error: ERR.cancelled });
  });

  it('asks for a code only with a client id', async () => {
    expect(await requestDeviceCode(fakeFetch([]).fetch, '', 'repo')).toMatchObject({ ok: false, code: 'no-client' });
    const { fetch, calls } = fakeFetch([{ status: 200, body: { device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5 } }]);
    expect(await requestDeviceCode(fetch, 'Iv1.abc', 'repo workflow')).toEqual({ ok: true, data: { deviceCode: 'd', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 899, interval: 5 } });
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ client_id: 'Iv1.abc', scope: 'repo workflow' });
  });
});

describe('token store', () => {
  let dir: string;
  const file = () => join(dir, 'github', 'token.json');
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-github-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the token sealed on disk, reads it back and forgets it', () => {
    const store = new GithubTokenStore(file(), cipher());
    expect(store.get()).toBeNull();
    expect(store.set(TOKEN, 'ajzak')).toBe(true);
    const raw = readFileSync(file(), 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(Buffer.from(TOKEN).toString('base64'));
    const again = new GithubTokenStore(file(), cipher());
    expect(again.get()).toBe(TOKEN);
    expect(again.login()).toBe('ajzak');
    again.clear();
    expect(again.get()).toBeNull();
    expect(existsSync(file())).toBe(false);
  });

  it('without system encryption it keeps the token in memory only', () => {
    const store = new GithubTokenStore(file(), cipher(false));
    expect(store.set(TOKEN, null)).toBe(true);
    expect(store.get()).toBe(TOKEN);
    expect(existsSync(file())).toBe(false);
    expect(new GithubTokenStore(file(), cipher(false)).get()).toBeNull();
  });

  it('refuses text that cannot be a token', () => {
    const store = new GithubTokenStore(file(), cipher());
    expect(store.set('has space in it', null)).toBe(false);
    expect(store.set('line\nbreak-token', null)).toBe(false);
    expect(store.get()).toBeNull();
  });
});

describe('sign-in order', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-github-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const enoent = () => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  let stores = 0;
  function setup(opts: { gh?: string | 'missing' | 'signed-out'; clientId?: string; answers?: Parameters<typeof fakeFetch>[0] } = {}) {
    const store = new GithubTokenStore(join(dir, `token-${++stores}.json`), cipher());
    const runs: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFile = async (file, args) => {
      runs.push({ file, args });
      if (opts.gh === undefined || opts.gh === 'missing') throw enoent();
      if (opts.gh === 'signed-out') throw Object.assign(new Error('no oauth token'), { code: 1 });
      return { stdout: `${opts.gh}\n` };
    };
    const { fetch, calls } = fakeFetch(opts.answers ?? []);
    const auth = new GithubAuth({ fetch, store, clientId: opts.clientId ?? '', exec, env: async () => ({ PATH: '/bin' }), platform: 'darwin', poll: { sleep: async () => undefined } });
    return { auth, store, runs, calls };
  }

  it('uses the stored token first, then the GitHub CLI’s, else none', async () => {
    const stored = setup({ gh: 'gho_fromGitHubCli0000000000000000000000' });
    stored.store.set(TOKEN, 'ajzak');
    expect(await stored.auth.token()).toEqual({ token: TOKEN, source: 'stored' });
    expect(stored.runs).toEqual([]);
    expect(await stored.auth.status()).toEqual({ signedIn: true, source: 'stored', login: 'ajzak', deviceFlow: false, storage: 'dpapi' });

    const gh = setup({ gh: 'gho_fromGitHubCli0000000000000000000000', answers: [{ status: 200, body: { login: 'cli-user' } }] });
    expect(await gh.auth.token()).toEqual({ token: 'gho_fromGitHubCli0000000000000000000000', source: 'gh' });
    expect(gh.runs[0]).toEqual({ file: 'gh', args: ['auth', 'token', '--hostname', 'github.com'] });
    expect(await gh.auth.status()).toMatchObject({ signedIn: true, source: 'gh', login: 'cli-user' });
    expect(gh.calls[0].headers.Authorization).toBe('Bearer gho_fromGitHubCli0000000000000000000000');

    const none = setup({ gh: 'missing', clientId: 'Iv1.abc' });
    expect(await none.auth.token()).toBeNull();
    // A missing gh is looked for in the usual places too, and is no error.
    expect(none.runs.map((r) => r.file)).toEqual(['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']);
    expect(await none.auth.status()).toEqual({ signedIn: false, source: null, login: null, deviceFlow: true, storage: 'dpapi' });

    const signedOut = setup({ gh: 'signed-out' });
    expect(await signedOut.auth.token()).toBeNull();
    expect(signedOut.runs).toHaveLength(1);

    // The quick status of the panel's menu looks at the stored sign-in only: no gh, no network.
    const quick = setup({ gh: 'gho_fromGitHubCli0000000000000000000000' });
    expect(await quick.auth.status(true)).toMatchObject({ signedIn: false, source: null });
    expect(quick.runs).toEqual([]);
    expect(quick.calls).toEqual([]);
    quick.store.set(TOKEN, 'ajzak');
    expect(await quick.auth.status(true)).toMatchObject({ signedIn: true, source: 'stored', login: 'ajzak' });
  });

  it('forgets a stored token GitHub refused, and signs out', async () => {
    const { auth, store } = setup();
    store.set(TOKEN, 'ajzak');
    auth.rejected('stored');
    expect(store.get()).toBeNull();
    store.set(TOKEN, 'ajzak');
    expect(await auth.signOut()).toMatchObject({ signedIn: false, source: null });
    expect(store.get()).toBeNull();
    expect(existsSync(join(dir, `token-${stores}.json`))).toBe(false);
  });

  it('device flow: hidden without a client id, stores the token it gets', async () => {
    expect(await setup().auth.startDevice()).toMatchObject({ ok: false, code: 'no-client' });
    const { auth, store } = setup({
      clientId: 'Iv1.abc',
      answers: [
        { status: 200, body: { device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://evil.example/device', expires_in: 900, interval: 5 } },
        { status: 200, body: { error: 'authorization_pending' } },
        { status: 200, body: { access_token: TOKEN } },
        { status: 200, body: { login: 'ajzak' } },
      ],
    });
    const started = await auth.startDevice();
    if (!started.ok) throw new Error('expected a code');
    expect(started.data).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900 });
    expect(await auth.waitDevice('00000000-0000-4000-8000-000000000000')).toMatchObject({ ok: false, code: 'cancelled' });
    expect(await auth.waitDevice(started.data.flowId)).toEqual({ ok: true, data: { login: 'ajzak' } });
    expect(store.get()).toBe(TOKEN);
    expect(store.login()).toBe('ajzak');
  });
});

describe('publishing', () => {
  const req: GithubPublishRequest = { requestId: RID, name: 'unimux', private: true };
  const created = { status: 201, body: { full_name: 'ajzak/unimux', html_url: 'https://github.com/ajzak/unimux', clone_url: 'https://github.com/ajzak/unimux.git' } };

  function setup(opts: { info?: { branch: string | null; initial: boolean; remotes: string[] }; token?: { token: string; source: 'stored' | 'gh' } | null; answers?: Parameters<typeof fakeFetch>[0]; push?: { pushed: boolean; message: string } | 'remote-error' } = {}) {
    const pushes: Array<{ dir: string; url: string; branch: string; env: Record<string, string>; scope?: string }> = [];
    const rejected: string[] = [];
    const { fetch, calls } = fakeFetch(opts.answers ?? [created]);
    const publish = createPublisher({
      fetch,
      auth: { token: async () => (opts.token === undefined ? { token: TOKEN, source: 'stored' } : opts.token), rejected: (source) => { rejected.push(source); } },
      git: {
        publishInfo: async () => ({ ok: true, data: opts.info ?? { branch: 'main', initial: false, remotes: [] } }),
        publishPush: async (dir, r, scope) => {
          pushes.push({ dir, url: r.url, branch: r.branch, env: r.env, scope });
          if (opts.push === 'remote-error') return { ok: false, code: 'failed', error: "error: remote origin already exists." };
          return { ok: true, data: opts.push ?? { pushed: true, message: 'OK' } };
        },
      },
    });
    return { publish, pushes, rejected, calls };
  }

  it('creates the repository, adds it as origin and pushes the branch with the token in the environment', async () => {
    const { publish, pushes, calls } = setup();
    expect(await publish('/p', '/p', req)).toEqual({ ok: true, data: { fullName: 'ajzak/unimux', htmlUrl: 'https://github.com/ajzak/unimux', branch: 'main' } });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ name: 'unimux', private: true });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ dir: '/p', url: 'https://github.com/ajzak/unimux.git', branch: 'main', scope: '/p' });
    expect(pushes[0].env).toEqual(githubGitEnv(TOKEN));
    expect(pushes[0].url).not.toContain(TOKEN);
  });

  it('refuses before creating anything when the repository is not ready', async () => {
    for (const [info, code, error] of [
      [{ branch: 'main', initial: false, remotes: ['origin'] }, 'remote-exists', PUBLISH_ERR.remoteExists],
      [{ branch: null, initial: false, remotes: [] }, 'detached', PUBLISH_ERR.detached],
      [{ branch: 'main', initial: true, remotes: [] }, 'no-commits', PUBLISH_ERR.noCommits],
    ] as const) {
      const { publish, calls, pushes } = setup({ info: { ...info, remotes: [...info.remotes] } });
      expect(await publish('/p', '/p', req)).toEqual({ ok: false, code, error });
      expect(calls).toEqual([]);
      expect(pushes).toEqual([]);
    }
    const signedOut = setup({ token: null });
    expect(await signedOut.publish('/p', '/p', req)).toEqual({ ok: false, code: 'auth', error: PUBLISH_ERR.signIn });
  });

  it('says why GitHub refused, and forgets a stored token it no longer accepts', async () => {
    const taken = setup({ answers: [{ status: 422, body: { errors: [{ message: 'name already exists on this account' }] } }] });
    expect(await taken.publish('/p', '/p', req)).toMatchObject({ ok: false, code: 'exists' });
    expect(taken.pushes).toEqual([]);
    const revoked = setup({ answers: [{ status: 401, body: { message: 'Bad credentials' } }] });
    expect(await revoked.publish('/p', '/p', req)).toMatchObject({ ok: false, code: 'auth' });
    expect(revoked.rejected).toEqual(['stored']);
    expect(await setup({ answers: ['offline'] }).publish('/p', '/p', req)).toMatchObject({ ok: false, code: 'network' });
  });

  it('a failed push or remote keeps the address of the repository that now exists', async () => {
    expect(await setup({ push: { pushed: false, message: 'remote: Permission denied' } }).publish('/p', '/p', req))
      .toEqual({ ok: false, code: 'push-failed', error: PUBLISH_ERR.pushFailed, detail: 'remote: Permission denied', url: 'https://github.com/ajzak/unimux' });
    expect(await setup({ push: 'remote-error' }).publish('/p', '/p', req))
      .toMatchObject({ ok: false, code: 'remote-failed', error: PUBLISH_ERR.remoteFailed, url: 'https://github.com/ajzak/unimux' });
  });

  it('runs one publish per repository at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const { fetch } = fakeFetch([created]);
    const publish = createPublisher({
      fetch,
      auth: { token: async () => { await gate; return { token: TOKEN, source: 'gh' }; }, rejected: () => undefined },
      git: { publishInfo: async () => ({ ok: true, data: { branch: 'main', initial: false, remotes: [] } }), publishPush: async () => ({ ok: true, data: { pushed: true, message: 'OK' } }) },
    });
    const first = publish('/p', '/p', req);
    expect(await publish('/p', '/p', req)).toEqual({ ok: false, code: 'busy', error: PUBLISH_ERR.busy });
    release();
    expect((await first).ok).toBe(true);
  });
});

describe('IPC', () => {
  it('registers every channel behind the sender check', async () => {
    const handlers = new Map<string, (event: IpcSenderEvent, ...args: unknown[]) => unknown>();
    const guard = createIpcGuard({ handle: (channel: string, fn: never) => { handlers.set(channel, fn); }, on: () => undefined } as never, (e) => e.sender === 'app');
    let published = 0;
    registerGithubIpc(guard, {
      status: async () => ({ signedIn: true, source: 'stored', login: 'ajzak', deviceFlow: false, storage: 'dpapi' }),
      deviceStart: async () => ({ ok: true, data: {} }),
      deviceWait: async () => ({ ok: true, data: {} }),
      deviceCancel: () => undefined,
      signOut: async () => ({ signedIn: false, source: null, login: null, deviceFlow: false, storage: 'dpapi' }),
      publish: async () => { published++; return { ok: true, data: {} }; },
    });
    expect([...handlers.keys()].sort()).toEqual([...GITHUB_CHANNELS].sort());
    expect(await handlers.get('github:status')!({ sender: 'other' })).toMatchObject({ signedIn: false, login: null });
    expect(await handlers.get('github:status')!({ sender: 'app' })).toMatchObject({ signedIn: true, login: 'ajzak' });
    expect(await handlers.get('github:publish')!({ sender: 'other' }, 'p', {})).toMatchObject({ ok: false, code: 'invalid' });
    expect(published).toBe(0);
    expect(await handlers.get('github:publish')!({ sender: 'app' }, 'p', {})).toEqual({ ok: true, data: {} });
    expect(published).toBe(1);
  });

  it('resolves the project in main and validates the request before publishing', async () => {
    const seen: Array<{ dir: string; scope: string }> = [];
    const locals: boolean[] = [];
    const handlers = createGithubHandlers({
      auth: { status: async (local) => { locals.push(!!local); return { signedIn: false, source: null, login: null, deviceFlow: false, storage: 'dpapi' }; }, startDevice: async () => ({ ok: false, code: 'no-client', error: ERR.noClient }), waitDevice: async () => ({ ok: true, data: { login: null } }), cancelDevice: () => undefined, signOut: async () => ({ signedIn: false, source: null, login: null, deviceFlow: false, storage: 'dpapi' }) },
      publish: async (dir, scope) => { seen.push({ dir, scope }); return { ok: true, data: { fullName: 'a/b', htmlUrl: 'https://github.com/a/b', branch: 'main' } }; },
      git: { resolveDir: async (projectPath, worktree) => (worktree === 'D:/elsewhere' ? { ok: false, code: 'invalid', error: 'To nie jest worktree tego repozytorium.' } : { ok: true, data: worktree ?? projectPath }) },
      projectPath: (id) => (id === 'p1' ? 'D:/proj' : undefined),
    });
    expect(await handlers.publish('gone', { requestId: RID, name: 'x', private: true })).toMatchObject({ ok: false, code: 'gone' });
    expect(await handlers.publish('p1', { requestId: RID, name: 'bad name', private: true })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handlers.publish('p1', { requestId: RID, name: 'x', private: true, worktree: 'D:/elsewhere' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handlers.publish('p1', { requestId: RID, name: 'x', private: true })).toMatchObject({ ok: true });
    expect(await handlers.publish('p1', { requestId: RID, name: 'x', private: true, worktree: 'D:/proj-wt-a' })).toMatchObject({ ok: true });
    expect(seen).toEqual([{ dir: 'D:/proj', scope: 'D:/proj' }, { dir: 'D:/proj-wt-a', scope: 'D:/proj-wt-a' }]);
    expect(await handlers.deviceWait('not-a-flow')).toMatchObject({ ok: false, code: 'cancelled' });
    await handlers.status(undefined);
    await handlers.status({ local: true });
    await handlers.status({ local: 'yes' });
    expect(locals).toEqual([false, true, false]);
  });
});
