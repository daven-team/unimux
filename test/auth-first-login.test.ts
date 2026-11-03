// test/auth-first-login.test.ts
// 1.1.2: the first Claude login on a machine that had only Claude Desktop. Desktop (its built-in Claude Code) leaves an
// `oauthAccount` in ~/.claude.json while ~/.claude/.credentials.json holds no Claude login; that identity was taken for the
// live login, adopted as a card nobody sees (signed out) and then blocked the first "Add a Claude account" as "already added".
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { custodyOf, type LoginState } from '../src/shared/accounts';
import { activateAccount } from '../src/main/accounts/activate';
import { reconcileLive } from '../src/main/accounts/reconcile';
import { AccountsStore } from '../src/main/accounts/store';
import { LoginManager, type KnownIdentity, type LoginDeps } from '../src/main/auth/login';
import { claudeLoginPresence, LiveIdentityUnknown, readLiveClaudeIdentity, readSignedInClaudeIdentity } from '../src/main/usage/credentials';

const EMAIL = 'maksy@example.com';
const DESKTOP_JSON = JSON.stringify({ numStartups: 3, oauthAccount: { emailAddress: EMAIL, accountUuid: 'u-maksy', organizationUuid: 'o-1', organizationName: 'Org' } });
const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 9e12 } });

let root: string;
let home: string;
let store: AccountsStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unimux-first-login-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  store = new AccountsStore(join(root, 'accounts'));
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

const source = (platform: NodeJS.Platform = 'win32') => ({ env: {}, home, platform });
const desktopLeftover = () => writeFileSync(join(home, '.claude.json'), DESKTOP_JSON);

describe('who is signed in to Claude Code', () => {
  it('an identity in ~/.claude.json without a Claude login next to it is nobody (Claude Desktop leftover)', async () => {
    desktopLeftover();
    // What 1.1.1 read: the leftover counted as the live login.
    expect(await readLiveClaudeIdentity(source())).toMatchObject({ email: EMAIL });
    expect(await readSignedInClaudeIdentity(source())).toBeNull();
    // MCP sign-ins only: still no Claude login.
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ mcpOAuth: { x: {} } }));
    expect(await readSignedInClaudeIdentity(source())).toBeNull();
  });

  it('a real login, a login Claude Code cleared as dead and macOS (Keychain) keep the identity', async () => {
    desktopLeftover();
    writeFileSync(join(home, '.claude', '.credentials.json'), LOGIN);
    expect(await readSignedInClaudeIdentity(source())).toMatchObject({ email: EMAIL, accountUuid: 'u-maksy' });
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }));
    expect(await readSignedInClaudeIdentity(source())).toMatchObject({ email: EMAIL });
    rmSync(join(home, '.claude', '.credentials.json'));
    expect(await readSignedInClaudeIdentity(source('darwin'))).toMatchObject({ email: EMAIL });
  });

  it('a credentials file that cannot be read right now is unknown, never a sign-out', async () => {
    desktopLeftover();
    const busy = async (path: string) => {
      if (path.endsWith('.credentials.json')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return DESKTOP_JSON;
    };
    expect(await claudeLoginPresence(source(), busy)).toBe('unknown');
    await expect(readSignedInClaudeIdentity(source(), busy)).rejects.toBeInstanceOf(LiveIdentityUnknown);
    expect(await claudeLoginPresence(source(), async () => '{half')).toBe('unknown');
    expect(await claudeLoginPresence(source())).toBe('absent');
    expect(await claudeLoginPresence({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, home })).toBe('present');
  });

  it('the leftover is not adopted as a hidden main card any more', async () => {
    desktopLeftover();
    const deps = { store, now: () => 1, readLiveIdentity: () => readSignedInClaudeIdentity(source()) };
    expect((await reconcileLive(deps)).activeId).toBeNull();
    expect(store.list()).toEqual([]);
    // 1.1.1 adopted it: a record with custody live whose card reads the missing live login (signed out, not shown).
    const old = await reconcileLive({ ...deps, readLiveIdentity: () => readLiveClaudeIdentity(source()) });
    expect(old.activeId).not.toBeNull();
    expect(store.list().map(custodyOf)).toEqual(['live']);
  });
});

describe('making the new account main over the leftover', () => {
  it('is not refused as "already main": the account becomes the live login, the leftover identity is replaced', async () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, theme: 'dark', oauthAccount: { emailAddress: EMAIL, accountUuid: 'u-maksy', organizationUuid: 'o-1' } }));
    const { id, dir } = store.prepare();
    store.commit({ id, addedAt: 1, email: EMAIL, accountUuid: 'u-maksy', organizationUuid: 'o-1', custody: 'app', family: 'own' });
    writeFileSync(join(dir, '.credentials.json'), LOGIN);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: EMAIL, accountUuid: 'u-maksy', organizationUuid: 'o-1', organizationName: 'Org' } }));
    const result = await activateAccount({
      home, env: {}, platform: 'win32', store, backupDir: join(root, 'accounts', 'swap-backup'), now: () => 1_000, refresh: vi.fn(async () => ({ kind: 'ok' as const })),
      delay: async () => undefined, cswap: async () => ({ present: false }), locks: { timeoutMs: 300 },
    }, id);
    // 1.1.1: { ok: false, error: 'sameAccount' } - the leftover identity counted as the main login.
    expect(result).toEqual({ ok: true, email: EMAIL });
    expect(JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fake-refresh');
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toMatchObject({ theme: 'dark', oauthAccount: { emailAddress: EMAIL, organizationName: 'Org' } });
    expect(store.list()).toHaveLength(1);
    expect(store.get(id)?.custody).toBe('live');
    expect(store.live()?.recordId).toBe(id);
  });
});

function manager(over: Partial<LoginDeps> = {}) {
  const states: LoginState[] = [];
  const fp = { value: null as string | null };
  const deps: LoginDeps = {
    store,
    spawnPty: vi.fn(),
    killPty: vi.fn(),
    fingerprint: vi.fn(async () => fp.value),
    identity: vi.fn(async () => ({ email: EMAIL, accountUuid: 'u-maksy', organizationUuid: 'o-1', org: 'Org' })),
    knownIdentities: vi.fn(async () => [] as KnownIdentity[]),
    snapshotProfile: vi.fn(async () => ({ credentials: null, claudeJson: null })),
    restoreProfile: vi.fn(async () => undefined),
    identityRewritten: vi.fn(async () => true),
    emit: (state) => { states.push(state); },
    onChanged: vi.fn(),
    ...over,
  };
  return { deps, states, fp, login: new LoginManager(deps) };
}

async function signIn(h: ReturnType<typeof manager>) {
  const res = await h.login.start({ provider: 'claude', target: { type: 'new' } });
  await vi.advanceTimersByTimeAsync(1500);
  h.fp.value = 'fp-new';
  await vi.advanceTimersByTimeAsync(1500 + 1500 + 10);
  return res;
}

describe('the first "Add a Claude account"', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('a record of the account without any login (adopted leftover) is no duplicate: the account is added and the empty record replaced', async () => {
    const { id: empty } = store.prepare();
    store.commit({ id: empty, addedAt: 1, email: EMAIL, accountUuid: 'u-maksy', organizationUuid: 'o-1', custody: 'live', family: 'live' });
    store.setLive({ email: EMAIL, accountUuid: 'u-maksy', recordId: empty });
    const h = manager({ knownIdentities: vi.fn(async () => [{ email: EMAIL, accountUuid: 'u-maksy', organizationUuid: 'o-1', recordId: empty, empty: true }]) });
    expect((await signIn(h)).ok).toBe(true);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    const records = store.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ email: EMAIL, custody: 'app', family: 'own' });
    expect(records[0].id).not.toBe(empty);
    expect(h.states[1].recordId).toBe(records[0].id);
    expect(store.live()?.recordId).toBeUndefined();
  });

  it('with no main login it is offered as main; with a main login it is not', async () => {
    const none = manager({ hasMainLogin: vi.fn(async () => false) });
    await signIn(none);
    expect(none.states.at(-1)).toMatchObject({ status: 'success', email: EMAIL, offerMain: true });
    none.login.dispose();
    for (const record of store.list()) store.remove(record.id);
    const some = manager({ hasMainLogin: vi.fn(async () => true) });
    await signIn(some);
    expect(some.states.at(-1)?.status).toBe('success');
    expect(some.states.at(-1)?.offerMain).toBeUndefined();
  });

  it('a duplicate names the record that really holds the account: the main login or a saved card', async () => {
    const main = manager({ knownIdentities: vi.fn(async () => [{ email: 'Maksy@Example.com', accountUuid: 'u-maksy', live: true }]) });
    await signIn(main);
    expect(main.states.at(-1)).toMatchObject({ status: 'duplicate', duplicateOf: 'main', email: 'Maksy@Example.com' });
    expect(store.list()).toEqual([]);
    const saved = manager({ knownIdentities: vi.fn(async () => [{ email: 'maksy@example.com', accountUuid: 'u-maksy', recordId: 'r1' }]) });
    await signIn(saved);
    expect(saved.states.at(-1)).toMatchObject({ status: 'duplicate', duplicateOf: 'saved', email: 'maksy@example.com' });
    expect(store.list()).toEqual([]);
  });

  it('a missing CLI never opens a login terminal: the start answers cliMissing (Claude and Codex)', async () => {
    const h = manager({ cliMissing: vi.fn(async () => true) });
    expect(await h.login.start({ provider: 'claude', target: { type: 'new' } })).toEqual({ ok: false, error: 'cliMissing' });
    expect(await h.login.start({ provider: 'codex', target: { type: 'main' } })).toEqual({ ok: false, error: 'cliMissing' });
    expect(h.deps.spawnPty).not.toHaveBeenCalled();
    expect(h.states).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(h.login.isActive()).toBe(false);
    // A failing detection fails open (as cells do): the login starts.
    const open = manager({ cliMissing: vi.fn(async () => { throw new Error('probe'); }) });
    expect((await open.login.start({ provider: 'claude', target: { type: 'new' } })).ok).toBe(true);
    open.login.dispose();
  });

  it('a login cancelled while its terminal is still starting kills that terminal', async () => {
    let release: () => void = () => undefined;
    const h = manager({ spawnPty: vi.fn(() => new Promise<void>((done) => { release = done; })) });
    const pending = h.login.start({ provider: 'claude', target: { type: 'new' } });
    await vi.advanceTimersByTimeAsync(0);
    h.login.dispose();
    release();
    expect(await pending).toEqual({ ok: false, error: 'cancelled' });
    expect(h.deps.killPty).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
