import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexActivationRefusal, codexIdentityKey, codexStoresInKeyring, compareCodexIdentity, normalizeCodexAccounts, outsideSwitch } from '../src/shared/codexAccounts';
import { CodexAccountsStore } from '../src/main/accounts/codexStore';
import { activateCodexAccount, checkCodexTarget, parseCodexAuth, readLiveCodexIdentity, reconcileCodexLive } from '../src/main/accounts/codexActivate';
import { CodexLoginManager } from '../src/main/auth/codexLogin';
import type { LoginState } from '../src/shared/accounts';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `h.${b64(claims)}.s`;
/** A fake Codex auth.json (fake tokens only) of a ChatGPT login. */
function auth(name: string, refresh = `fake-refresh-${name}`, exp = Math.floor(Date.now() / 1000) + 86_400): string {
  const claim = { 'https://api.openai.com/auth': { chatgpt_user_id: `user-${name}`, chatgpt_account_id: `ws-${name}`, chatgpt_plan_type: 'plus' } };
  return JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: jwt({ email: `${name}@example.com`, ...claim }), access_token: jwt({ exp, ...claim }), refresh_token: refresh, account_id: `ws-${name}` },
    last_refresh: new Date().toISOString(),
  });
}

describe('Codex identities and the family rule (pure)', () => {
  it('compares by user and workspace, else by e-mail', () => {
    expect(compareCodexIdentity({ userId: 'u1', accountId: 'w1', email: 'a@x' }, { userId: 'u1', accountId: 'w1' })).toBe('same');
    expect(compareCodexIdentity({ userId: 'u1', accountId: 'w1' }, { userId: 'u1', accountId: 'w2' })).toBe('different');
    expect(compareCodexIdentity({ email: 'A@x' }, { email: 'a@x' })).toBe('same');
    expect(compareCodexIdentity({}, { email: 'a@x' })).toBe('unknown');
    expect(codexIdentityKey({ userId: 'u1', accountId: 'w1' })).toBe('codex-user:u1:w1');
    expect(codexIdentityKey({ email: 'A@x' })).toBe('codex-email:a@x:-');
  });

  it('reads accounts.json safely (bad ids, duplicates and a dangling live record are dropped)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(normalizeCodexAccounts({ accounts: [{ id, addedAt: 1, email: 'a@x', liveFamily: true }, { id }, { id: '../x' }], live: { email: 'a@x', recordId: '22222222-2222-4222-8222-222222222222' } }))
      .toEqual({ version: 1, accounts: [{ id, addedAt: 1, email: 'a@x', liveFamily: true }], live: { email: 'a@x' } });
  });

  it('marks the twin of an account switched out by something else as outdated, never an independent copy', () => {
    const twin = { id: 'r1', addedAt: 1, userId: 'u1', liveFamily: true as const };
    const own = { id: 'r2', addedAt: 1, userId: 'u2' };
    const file = { version: 1 as const, accounts: [twin, own], live: { userId: 'u1', recordId: 'r1' } };
    expect(outsideSwitch(file, { userId: 'u3' })).toEqual({ changed: true, outdated: ['r1'], live: { userId: 'u3' } });
    expect(outsideSwitch({ ...file, live: { userId: 'u2', recordId: 'r2' } }, { userId: 'u1' })).toEqual({ changed: true, outdated: [], live: { userId: 'u1', recordId: 'r1' } });
    expect(outsideSwitch(file, { userId: 'u1' }).changed).toBe(false);
  });

  it('refuses the live account, an outdated copy and a missing record; detects the keyring store', () => {
    expect(codexActivationRefusal(undefined, null)).toBe('noTarget');
    expect(codexActivationRefusal({ id: 'r', addedAt: 0, userId: 'u1' }, { userId: 'u1' })).toBe('sameAccount');
    expect(codexActivationRefusal({ id: 'r', addedAt: 0, userId: 'u1', outdated: true }, { userId: 'u2' })).toBe('foreign');
    expect(codexActivationRefusal({ id: 'r', addedAt: 0, userId: 'u1' }, { userId: 'u2' })).toBeNull();
    expect(codexStoresInKeyring('model = "o3"\ncli_auth_credentials_store = "keyring"\n')).toBe(true);
    expect(codexStoresInKeyring('cli_auth_credentials_store = "auto"')).toBe(true);
    expect(codexStoresInKeyring('cli_auth_credentials_store = "file"')).toBe(false);
    expect(codexStoresInKeyring('[mcp_servers.x]\ncli_auth_credentials_store = "keyring"')).toBe(false);
    expect(codexStoresInKeyring(null)).toBe(false);
  });

  it('reads who an auth.json belongs to without returning a token', () => {
    const login = parseCodexAuth(auth('alice'));
    expect(login).toMatchObject({ chatgpt: true, identity: { email: 'alice@example.com', userId: 'user-alice', accountId: 'ws-alice' } });
    expect(JSON.stringify(login)).not.toContain('fake-refresh');
    expect(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-fake' }))).toEqual({ identity: {}, chatgpt: false });
    expect(parseCodexAuth('{')).toBeNull();
  });
});

describe('Codex profiles: make main', () => {
  let root: string;
  let live: string;
  let store: CodexAccountsStore;
  const deps = () => ({ store, liveHome: () => live, now: () => 1000 });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'unimux-codex-'));
    live = join(root, 'home', '.codex');
    mkdirSync(live, { recursive: true });
    store = new CodexAccountsStore(join(root, 'data', 'codex-accounts'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const addSaved = (name: string) => {
    const { id, dir } = store.prepare();
    writeFileSync(join(dir, 'auth.json'), auth(name));
    store.commit({ id, addedAt: 1, email: `${name}@example.com`, userId: `user-${name}`, accountId: `ws-${name}` });
    return id;
  };

  it('copies the outgoing live login into a new record of its own, then puts the target in; sessions and config stay', async () => {
    writeFileSync(join(live, 'auth.json'), auth('alice', 'fake-refresh-alice-rotated'));
    writeFileSync(join(live, 'config.toml'), 'model = "o3"\n');
    mkdirSync(join(live, 'sessions'));
    const bob = addSaved('bob');
    expect(await activateCodexAccount(deps(), bob)).toEqual({ ok: true, email: 'bob@example.com' });
    expect(parseCodexAuth(readFileSync(join(live, 'auth.json'), 'utf8'))?.identity.userId).toBe('user-bob');
    const alice = store.list().find((a) => a.userId === 'user-alice')!;
    // The newest tokens of the outgoing account (what Codex had renewed) are in its record, not an older copy.
    expect(readFileSync(join(store.dirOf(alice.id), 'auth.json'), 'utf8')).toContain('fake-refresh-alice-rotated');
    expect(store.get(bob)).toMatchObject({ liveFamily: true });
    expect(store.live()).toMatchObject({ userId: 'user-bob', recordId: bob });
    expect(readFileSync(join(live, 'config.toml'), 'utf8')).toBe('model = "o3"\n');
    expect(existsSync(join(live, 'sessions'))).toBe(true);
    expect(existsSync(join(store.root, 'swap-backup', 'auth.json'))).toBe(true);

    // And back: the twin of bob is overwritten with the live copy, alice goes in.
    expect(await activateCodexAccount(deps(), alice.id)).toMatchObject({ ok: true });
    expect(store.get(bob)?.liveFamily).toBeUndefined();
    expect(store.list()).toHaveLength(2);
  });

  it('refuses the live account, an outdated copy and a keyring config, and changes nothing', async () => {
    writeFileSync(join(live, 'auth.json'), auth('alice'));
    const bob = addSaved('bob');
    const alice = addSaved('alice');
    expect(checkCodexTarget(deps(), alice)).toMatchObject({ ok: false, error: 'sameAccount' });
    store.patch(bob, { outdated: true });
    expect(await activateCodexAccount(deps(), bob)).toMatchObject({ ok: false, error: 'foreign' });
    store.patch(bob, { outdated: undefined });
    writeFileSync(join(live, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    expect(await activateCodexAccount(deps(), bob)).toMatchObject({ ok: false, error: 'unsupported' });
    expect(parseCodexAuth(readFileSync(join(live, 'auth.json'), 'utf8'))?.identity.userId).toBe('user-alice');
  });

  it('an outside switch marks the twin that left as outdated', async () => {
    writeFileSync(join(live, 'auth.json'), auth('alice'));
    const bob = addSaved('bob');
    await activateCodexAccount(deps(), bob);
    expect(reconcileCodexLive(deps())?.userId).toBe('user-bob');
    // Another tool (or `codex login`) puts carol in.
    writeFileSync(join(live, 'auth.json'), auth('carol'));
    expect(reconcileCodexLive(deps())?.userId).toBe('user-carol');
    expect(store.get(bob)).toMatchObject({ outdated: true });
    expect(readLiveCodexIdentity(deps())?.email).toBe('carol@example.com');
  });
});

describe('Codex profiles: "Dodaj konto Codex"', () => {
  let root: string;
  let store: CodexAccountsStore;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'unimux-codex-login-')); store = new CodexAccountsStore(join(root, 'codex-accounts')); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

  function manager(live: string | null = null) {
    const states: LoginState[] = [];
    const spawned: Array<{ env: Record<string, string>; command: string }> = [];
    const read = (dir: string) => { try { return readFileSync(join(dir, 'auth.json'), 'utf8'); } catch { return null; } };
    const login = new CodexLoginManager({
      store,
      spawnPty: (spec) => spawned.push(spec),
      killPty: () => undefined,
      fingerprint: async (dir) => read(dir),
      identity: async (dir) => parseCodexAuth(read(dir))?.identity ?? null,
      liveIdentity: () => (live ? parseCodexAuth(auth(live))!.identity : null),
      readAuth: async (dir) => read(dir),
      restoreAuth: async (dir, raw) => { if (raw === null) rmSync(join(dir, 'auth.json'), { force: true }); else writeFileSync(join(dir, 'auth.json'), raw); },
      busy: () => false,
      emit: (s) => states.push(s),
      onChanged: () => undefined,
      pollMs: 10, settleMs: 10,
    });
    return { login, states, spawned };
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(20); };

  it('runs `codex login` with CODEX_HOME at a new profile and saves the account', async () => {
    const { login, states, spawned } = manager();
    const started = await login.start({ type: 'new' });
    expect(started.ok).toBe(true);
    expect(spawned[0].command).toBe('codex login -c cli_auth_credentials_store=file');
    const dir = spawned[0].env.CODEX_HOME;
    expect(dir.startsWith(store.root)).toBe(true);
    writeFileSync(join(dir, 'auth.json'), auth('bob'));
    await settle();
    expect(states.at(-1)).toMatchObject({ status: 'success', email: 'bob@example.com' });
    expect(store.list()).toMatchObject([{ email: 'bob@example.com', userId: 'user-bob' }]);
    expect(login.isActive()).toBe(false);
  });

  it('refuses the live account and a second copy of a saved one, and drops the new profile', async () => {
    const { login, states, spawned } = manager('alice');
    await login.start({ type: 'new' });
    writeFileSync(join(spawned[0].env.CODEX_HOME, 'auth.json'), auth('alice'));
    await settle();
    expect(states.at(-1)).toMatchObject({ status: 'duplicate', email: 'alice@example.com' });
    expect(store.list()).toEqual([]);
    expect(existsSync(spawned[0].env.CODEX_HOME)).toBe(false);
  });

  it('signing a card in again as another account puts its previous login back', async () => {
    const { id, dir } = store.prepare();
    writeFileSync(join(dir, 'auth.json'), auth('bob'));
    store.commit({ id, addedAt: 1, email: 'bob@example.com', userId: 'user-bob', accountId: 'ws-bob' });
    const { login, states } = manager();
    await login.start({ type: 'account', id });
    writeFileSync(join(dir, 'auth.json'), auth('carol'));
    await settle();
    expect(states.at(-1)).toMatchObject({ status: 'mismatch', email: 'carol@example.com', expected: 'bob@example.com' });
    expect(parseCodexAuth(readFileSync(join(dir, 'auth.json'), 'utf8'))?.identity.userId).toBe('user-bob');
  });
});
