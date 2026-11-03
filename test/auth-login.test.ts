// test/auth-login.test.ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginState } from '../src/shared/accounts';
import { LiveBackupFailed } from '../src/main/accounts/reconcile';
import { AccountsStore } from '../src/main/accounts/store';
import { LoginManager, type KnownIdentity, type LoginDeps } from '../src/main/auth/login';

const SECRET = 'fp-secret-123';
let base: string;
let store: AccountsStore;

beforeEach(() => {
  vi.useFakeTimers();
  base = mkdtempSync(join(tmpdir(), 'ajza-login-'));
  store = new AccountsStore(join(base, 'accounts'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(base, { recursive: true, force: true });
});

function setup(over: Partial<LoginDeps> = {}) {
  const states: LoginState[] = [];
  const fp: { value: string | null; calls: number } = { value: null, calls: 0 };
  const deps = {
    store,
    spawnPty: vi.fn(),
    killPty: vi.fn(),
    fingerprint: vi.fn(async () => { fp.calls++; return fp.value; }),
    identity: vi.fn(async () => ({ email: 'New@Example.com', org: 'Org' })),
    knownIdentities: vi.fn(async () => [] as KnownIdentity[]),
    snapshotProfile: vi.fn(async () => ({ credentials: 'fake-old-creds', claudeJson: null })),
    restoreProfile: vi.fn(async () => undefined),
    identityRewritten: vi.fn(async () => true),
    emit: vi.fn((state: LoginState) => { states.push(state); }),
    onChanged: vi.fn(),
  } satisfies LoginDeps;
  const merged = { ...deps, ...over } as LoginDeps;
  return { deps: merged, mock: deps, states, fp, manager: new LoginManager(merged) };
}

async function advance(ms: number) { await vi.advanceTimersByTimeAsync(ms); }

/** Starts a login, flips the fingerprint after the third poll and lets everything settle. */
async function runSuccess(h: ReturnType<typeof setup>, request: Parameters<LoginManager['start']>[0]) {
  const res = await h.manager.start(request);
  await advance(1500 * 2);
  h.fp.value = SECRET;
  await advance(1500 + 1500 + 10);
  return res;
}

const noSecret = (value: unknown) => expect(JSON.stringify(value)).not.toContain(SECRET);

describe('LoginManager', () => {
  it('rejects profile logins when profiles are unsupported but allows main logins', async () => {
    const h = setup({ profilesSupported: false });
    expect(await h.manager.start({ provider: 'claude', target: { type: 'new' } })).toEqual({ ok: false, error: 'unsupported' });
    expect(await h.manager.start({ provider: 'claude', target: { type: 'account', id: '123e4567-e89b-42d3-a456-426614174000' } })).toEqual({ ok: false, error: 'unsupported' });
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect((await h.manager.start({ provider: 'codex', target: { type: 'main' } })).ok).toBe(true);
  });

  it('failActive ends the session as failed, kills the pty and drops the pending profile', async () => {
    const h = setup();
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    if (!res.ok) throw new Error('unreachable');
    h.manager.failActive('spawn');
    expect(h.mock.killPty).toHaveBeenCalledWith(res.ptyId);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1].error).toBe('spawn');
    expect(store.list()).toEqual([]);
    h.manager.failActive('spawn');
    expect(h.states).toHaveLength(2);
  });

  it('registers a new Claude account after the fingerprint changes', async () => {
    const h = setup();
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.ptyId).toBe(`auth:${res.sessionId}`);
    await advance(1500 * 2);
    expect(h.mock.killPty).not.toHaveBeenCalled();
    h.fp.value = SECRET;
    await advance(1500);
    expect(h.mock.killPty).not.toHaveBeenCalled();
    await advance(1500 + 10);
    expect(h.mock.killPty).toHaveBeenCalledWith(res.ptyId);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(h.states[1].email).toBe('New@Example.com');
    const accounts = store.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe('New@Example.com');
    expect(accounts[0].org).toBe('Org');
    expect(accounts[0]).toMatchObject({ custody: 'app', family: 'own' });
    expect(h.mock.onChanged).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    noSecret(h.states); noSecret(res);
  });

  it('reports a duplicate e-mail and removes the profile', async () => {
    const h = setup({ knownIdentities: vi.fn(async () => [{ email: 'new@example.com', recordId: 'x' }]) });
    const res = await runSuccess(h, { provider: 'claude', target: { type: 'new' } });
    expect(res.ok).toBe(true);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'duplicate']);
    // The saved card that holds the account is named (1.1.2), with its own spelling.
    expect(h.states[1]).toMatchObject({ email: 'new@example.com', duplicateOf: 'saved' });
    expect(store.list()).toEqual([]);
    expect(existsSync(join(base, 'accounts', 'claude'))).toBe(true);
    const spec = h.mock.spawnPty.mock.calls[0][0];
    expect(existsSync(spec.env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(h.mock.onChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with identity when no e-mail shows up after retries', async () => {
    const h = setup({ identity: vi.fn(async () => ({})) });
    await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    h.fp.value = SECRET;
    await advance(1500 + 1500 + 10 + 5000);
    expect(h.deps.identity).toHaveBeenCalledTimes(5);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1].error).toBe('identity');
    expect(store.list()).toEqual([]);
    expect(existsSync(h.mock.spawnPty.mock.calls[0][0].env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries identity until an e-mail appears', async () => {
    let n = 0;
    const h = setup({ identity: vi.fn(async () => (++n < 3 ? {} : { email: 'late@example.com' })) });
    await runSuccess(h, { provider: 'claude', target: { type: 'new' } });
    await advance(3000);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.list()[0].email).toBe('late@example.com');
  });

  it('handles a Codex login', async () => {
    const h = setup();
    await runSuccess(h, { provider: 'codex', target: { type: 'main' } });
    expect(h.mock.spawnPty).toHaveBeenCalledWith({ id: expect.stringMatching(/^auth:/), env: {}, command: 'codex login' });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.list()).toEqual([]);
    expect(h.mock.onChanged).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-logs the main Claude login without touching the store', async () => {
    const h = setup();
    await runSuccess(h, { provider: 'claude', target: { type: 'main' } });
    expect(h.mock.spawnPty).toHaveBeenCalledWith({ id: expect.stringMatching(/^auth:/), env: {}, command: 'claude auth login --claudeai' });
    expect(h.deps.fingerprint).toHaveBeenCalledWith('claude', undefined);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.list()).toEqual([]);
    expect(h.mock.onChanged).toHaveBeenCalledTimes(1);
  });

  it('re-logs a managed account of the same identity and keeps it renewable (own family)', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'new@example.com', addedAt: 1, custody: 'foreign' });
    const h = setup();
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.mock.spawnPty).toHaveBeenCalledWith({
      id: expect.stringMatching(/^auth:/),
      env: { CLAUDE_CONFIG_DIR: prepared.dir, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' },
      command: 'claude auth login --claudeai',
    });
    expect(h.mock.snapshotProfile).toHaveBeenCalledWith(prepared.dir);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.list()).toEqual([{ id: prepared.id, email: 'New@Example.com', org: 'Org', addedAt: 1, custody: 'app', family: 'own' }]);
    expect(h.mock.restoreProfile).not.toHaveBeenCalled();
    expect(h.mock.onChanged).toHaveBeenCalledWith({ provider: 'claude', recordId: prepared.id });
  });

  it('re-login with a different account restores the old login and reports mismatch (investigation test 1)', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'support@guybot.xyz', accountUuid: 'u-guybot', addedAt: 1 });
    const h = setup({ identity: vi.fn(async () => ({ email: 'app@x.com', accountUuid: 'u-app' })) });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'mismatch']);
    expect(h.states[1]).toMatchObject({ email: 'app@x.com', expected: 'support@guybot.xyz' });
    expect(h.mock.restoreProfile).toHaveBeenCalledWith(prepared.dir, { credentials: 'fake-old-creds', claudeJson: null });
    expect(store.get(prepared.id)).toMatchObject({ email: 'support@guybot.xyz', accountUuid: 'u-guybot' });
    expect(h.mock.onChanged).not.toHaveBeenCalled();
    expect(JSON.stringify(h.states)).not.toContain('fake-old');
  });

  it('a mismatch leaves a foreign record foreign with its family unchanged', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'support@guybot.xyz', addedAt: 1, custody: 'foreign', family: 'live' });
    const h = setup({ identity: vi.fn(async () => ({ email: 'app@x.com' })) });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'mismatch']);
    expect(store.get(prepared.id)).toMatchObject({ custody: 'foreign', family: 'live' });
  });

  it('re-login that signs in the live account or another saved one reports duplicate and restores', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'new@example.com', addedAt: 1 });
    const h = setup({ knownIdentities: vi.fn(async () => [{ email: 'new@example.com', recordId: 'live-record', live: true }, { email: 'new@example.com', recordId: prepared.id }]) });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'duplicate']);
    expect(h.mock.restoreProfile).toHaveBeenCalledTimes(1);
  });

  it('a main re-login backs up the outgoing live login first and reports an own change (investigation test 2)', async () => {
    const order: string[] = [];
    const h = setup({
      beforeMainLogin: vi.fn(async () => { order.push('backup'); }),
      spawnPty: vi.fn(() => { order.push('spawn'); }),
    });
    await runSuccess(h, { provider: 'claude', target: { type: 'main' } });
    expect(order).toEqual(['backup', 'spawn']);
    expect(h.mock.onChanged).toHaveBeenCalledWith({ provider: 'claude', ownChange: true });
  });

  it('refuses a main re-login (busy) when the outgoing live login could not be backed up', async () => {
    const h = setup({ beforeMainLogin: vi.fn(async () => { throw new Error('locked'); }) });
    expect(await h.manager.start({ provider: 'claude', target: { type: 'main' } })).toEqual({ ok: false, error: 'busy' });
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect(h.mock.fingerprint).not.toHaveBeenCalled();
    expect(h.states).toEqual([]);
    expect(h.manager.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a Codex login never runs the Claude backup', async () => {
    const beforeMainLogin = vi.fn(async () => undefined);
    const h = setup({ beforeMainLogin });
    await runSuccess(h, { provider: 'codex', target: { type: 'main' } });
    expect(beforeMainLogin).not.toHaveBeenCalled();
    expect(h.mock.onChanged).toHaveBeenCalledWith({ provider: 'codex' });
  });

  it('cancelling a re-login after it wrote new files puts the card back; cancelling before leaves it alone', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'new@example.com', addedAt: 1 });
    const h = setup({ identity: vi.fn(async () => ({})) });
    const early = await h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    if (!early.ok) throw new Error('unreachable');
    await advance(1500);
    h.manager.cancel(early.sessionId);
    expect(h.mock.restoreProfile).not.toHaveBeenCalled();
    const late = await h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    if (!late.ok) throw new Error('unreachable');
    h.fp.value = SECRET;
    await advance(1500 + 1500 + 10 + 1500);
    h.manager.cancel(late.sessionId);
    await advance(0);
    expect(h.mock.restoreProfile).toHaveBeenCalledTimes(1);
    expect(h.mock.restoreProfile).toHaveBeenCalledWith(prepared.dir, { credentials: 'fake-old-creds', claudeJson: null });
    await advance(10000);
    expect(h.mock.restoreProfile).toHaveBeenCalledTimes(1);
    expect(h.states.filter((s) => s.sessionId === late.sessionId).map((s) => s.status)).toEqual(['waiting']);
  });

  it('a re-login cancelled or timed out between two polls looks once more and puts the card back when its files changed (D2)', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'new@example.com', addedAt: 1 });
    const h = setup({ identity: vi.fn(async () => ({})) });
    const res = await h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    if (!res.ok) throw new Error('unreachable');
    await advance(1500); // the last poll still saw the old login
    h.fp.value = SECRET; // the browser login writes right after it
    h.manager.cancel(res.sessionId);
    expect(h.manager.holdsProfile(prepared.dir)).toBe(true); // no renewal between the look and the restore
    await advance(0);
    expect(h.mock.restoreProfile).toHaveBeenCalledTimes(1);
    expect(h.mock.restoreProfile).toHaveBeenCalledWith(prepared.dir, { credentials: 'fake-old-creds', claudeJson: null });
    expect(h.manager.holdsProfile(prepared.dir)).toBe(false);

    const t = setup({ identity: vi.fn(async () => ({})), pollMs: 10_000_000, timeoutMs: 5_000 });
    t.fp.value = SECRET;
    await t.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    t.fp.value = 'fp-other-login';
    await advance(5_000 + 10);
    expect(t.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(t.mock.restoreProfile).toHaveBeenCalledTimes(1);
    // An unchanged fingerprint leaves the card alone.
    const u = setup({ identity: vi.fn(async () => ({})), pollMs: 10_000_000, timeoutMs: 5_000 });
    u.fp.value = SECRET;
    await u.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(5_000 + 10);
    expect(u.mock.restoreProfile).not.toHaveBeenCalled();
  });

  it('removing the account during its re-login never writes into its profile', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'new@example.com', addedAt: 1 });
    const h = setup({ identity: vi.fn(async () => ({})) });
    await h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    h.fp.value = SECRET;
    await advance(1500 + 1500 + 10 + 1500);
    h.manager.cancelFor(prepared.id);
    await advance(10000);
    expect(h.mock.restoreProfile).not.toHaveBeenCalled();
  });

  it('returns spawn and never starts when the saved profile cannot be snapshotted', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'new@example.com', addedAt: 1 });
    const h = setup({ snapshotProfile: vi.fn(async () => { throw new Error('EACCES'); }) });
    expect(await h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } })).toEqual({ ok: false, error: 'spawn' });
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect(h.manager.isActive()).toBe(false);
  });

  it('times out, kills the pty and discards the pending profile', async () => {
    const h = setup();
    await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    const spec = h.mock.spawnPty.mock.calls[0][0];
    await advance(600000 + 10);
    expect(h.mock.killPty).toHaveBeenCalledWith(spec.id);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1].error).toBe('timeout');
    expect(existsSync(spec.env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels mid-login without emitting anything more', async () => {
    const h = setup();
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    if (!res.ok) throw new Error('unreachable');
    const spec = h.mock.spawnPty.mock.calls[0][0];
    await advance(1500);
    h.manager.cancel(res.sessionId);
    expect(h.mock.killPty).toHaveBeenCalledWith(res.ptyId);
    expect(existsSync(spec.env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    h.fp.value = SECRET;
    await advance(700000);
    expect(h.states.map((s) => s.status)).toEqual(['waiting']);
    expect(store.list()).toEqual([]);
  });

  it('ignores cancel for an unknown session id', async () => {
    const h = setup();
    await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    h.manager.cancel('nope');
    expect(h.mock.killPty).not.toHaveBeenCalled();
    h.manager.dispose();
    expect(h.mock.killPty).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelling during the identity retries leaves no timers and no state', async () => {
    const h = setup({ identity: vi.fn(async () => ({})) });
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    if (!res.ok) throw new Error('unreachable');
    h.fp.value = SECRET;
    await advance(1500 + 1500 + 10 + 1500);
    h.manager.cancel(res.sessionId);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10000);
    expect(h.states.map((s) => s.status)).toEqual(['waiting']);
    expect(store.list()).toEqual([]);
  });

  it('a second start cancels the first session', async () => {
    const h = setup();
    const first = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    const second = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(h.mock.killPty).toHaveBeenCalledWith(first.ptyId);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(existsSync(h.mock.spawnPty.mock.calls[0][0].env.CLAUDE_CONFIG_DIR)).toBe(false);
    h.manager.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid requests without spawning', async () => {
    const h = setup();
    const unknownId = '123e4567-e89b-42d3-a456-426614174000';
    const bad = [
      { provider: 'codex', target: { type: 'new' } },
      { provider: 'codex', target: { type: 'account', id: unknownId } },
      { provider: 'claude', target: { type: 'account', id: unknownId } },
      { provider: 'claude', target: { type: 'account', id: '../x' } },
      { provider: 'claude', target: { type: 'bogus' } },
      { provider: 'claude', target: 'main' },
      { provider: 'claude', target: null },
      { provider: 'gemini', target: { type: 'main' } },
      null,
    ];
    for (const request of bad) {
      expect(await h.manager.start(request as never)).toEqual({ ok: false, error: 'invalid request' });
    }
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports spawn failures and discards the pending profile', async () => {
    const spawnPty = vi.fn(() => { throw new Error('boom'); });
    const h = setup({ spawnPty });
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    expect(res).toEqual({ ok: false, error: 'spawn' });
    expect(existsSync((spawnPty.mock.calls[0] as unknown as [{ env: Record<string, string> }])[0].env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(h.states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never leaks a fingerprint into states or return values', async () => {
    const h = setup();
    const res = await runSuccess(h, { provider: 'claude', target: { type: 'main' } });
    noSecret(res); noSecret(h.states);
    expect(h.deps.fingerprint).toHaveBeenCalled();
  });

  it('fails and cleans up when the store cannot commit, and a later start works', async () => {
    const failing = Object.create(store) as AccountsStore;
    failing.commit = () => { throw new Error('disk full'); };
    const h = setup({ store: failing });
    await runSuccess(h, { provider: 'claude', target: { type: 'new' } });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1].error).toBe('identity');
    expect(existsSync(h.mock.spawnPty.mock.calls[0][0].env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(h.mock.onChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const again = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    expect(again.ok).toBe(true);
    h.manager.dispose();
  });

  it('fails the session when the store cannot update an account', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'new@example.com', addedAt: 1 });
    const failing = Object.create(store) as AccountsStore;
    failing.updateIdentity = () => { throw new Error('disk full'); };
    const h = setup({ store: failing });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(existsSync(prepared.dir)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns spawn when the profile cannot be prepared', async () => {
    const failing = Object.create(store) as AccountsStore;
    failing.prepare = () => { throw new Error('nope'); };
    const h = setup({ store: failing });
    expect(await h.manager.start({ provider: 'claude', target: { type: 'new' } })).toEqual({ ok: false, error: 'spawn' });
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the command and CLAUDE_CONFIG_DIR for a new account', async () => {
    const h = setup();
    await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    const spec = h.mock.spawnPty.mock.calls[0][0];
    expect(spec.command).toBe('claude auth login --claudeai');
    expect(Object.keys(spec.env)).toEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(spec.env.ANTHROPIC_API_KEY).toBe('');
    expect(existsSync(spec.env.CLAUDE_CONFIG_DIR)).toBe(true);
    h.manager.dispose();
  });

  it('cancelling during the initial fingerprint read never spawns', async () => {
    let release: (value: string | null) => void = () => {};
    const h = setup({ fingerprint: vi.fn(() => new Promise<string | null>((resolve) => { release = resolve; })) });
    const pending = h.manager.start({ provider: 'claude', target: { type: 'new' } });
    h.manager.dispose();
    release(null);
    expect((await pending).ok).toBe(false);
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect(h.states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second start emits nothing for the first session', async () => {
    const h = setup();
    const first = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    const second = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    h.fp.value = SECRET;
    await advance(1500 * 2 + 1500);
    expect(h.states.filter((s) => s.sessionId === first.sessionId).map((s) => s.status)).toEqual(['waiting']);
    expect(h.states.filter((s) => s.sessionId === second.sessionId).map((s) => s.status)).toEqual(['waiting', 'success']);
  });
});

describe('LoginManager on macOS (main login through the Keychain)', () => {
  it('starts a main Claude login without a config dir, resets the credential cache on start and every poll, and succeeds', async () => {
    let cached: string | null = null; // stands in for the 30 minute failure cache
    let keychain: string | null = null;
    const reset = vi.fn(() => { cached = null; });
    const h = setup({
      profilesSupported: false,
      resetCredentialCache: reset,
      fingerprint: vi.fn(async () => { cached = cached ?? keychain; return cached; }),
      identity: vi.fn(async () => ({ email: 'mac@example.com' })),
    });
    const res = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    expect(res.ok).toBe(true);
    expect(h.mock.spawnPty).toHaveBeenCalledWith({ id: expect.stringMatching(/^auth:/), env: {}, command: 'claude auth login --claudeai' });
    expect(reset).toHaveBeenCalledTimes(1);
    await advance(1500 * 2);
    keychain = SECRET;
    await advance(1500 + 1500 + 10);
    expect(reset.mock.calls.length).toBeGreaterThan(2);
    expect(h.states.at(-1)).toEqual({ sessionId: expect.any(String), status: 'success', email: 'mac@example.com' });
    expect(h.mock.onChanged).toHaveBeenCalledOnce();
  });
});

describe('LoginManager re-login safety (fix round 1)', () => {
  const card = (over: Record<string, unknown> = {}) => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'support@guybot.xyz', accountUuid: 'u-guybot', addedAt: 1, custody: 'app', family: 'own', ...over });
    return prepared;
  };
  const other = vi.fn(async () => ({ email: 'app@x.com', accountUuid: 'u-app' }));

  it('a new start of the card waits for the queued restore of a cancelled login before it takes its snapshot', async () => {
    const prepared = card();
    let release: () => void = () => {};
    const restoreProfile = vi.fn(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
    const h = setup({ identity: vi.fn(async () => ({})), restoreProfile });
    const first = await h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    if (!first.ok) throw new Error('unreachable');
    h.fp.value = SECRET;
    await advance(1500 + 1500 + 10);
    h.manager.cancel(first.sessionId);
    expect(restoreProfile).toHaveBeenCalledTimes(1);
    expect(h.manager.isActive()).toBe(false);
    expect(h.manager.holdsProfile(prepared.dir)).toBe(true); // the restore still runs
    const second = h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(100);
    expect(h.deps.snapshotProfile).toHaveBeenCalledTimes(1);
    release();
    expect((await second).ok).toBe(true);
    expect(h.deps.snapshotProfile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.deps.snapshotProfile).mock.invocationCallOrder[1]).toBeGreaterThan(restoreProfile.mock.invocationCallOrder[0]);
    h.manager.dispose();
  });

  it('holds the card from renewal while its re-login runs and while its restore runs or failed', async () => {
    const prepared = card();
    const restoreProfile = vi.fn(async (): Promise<undefined> => { throw new Error('locked'); });
    const h = setup({ identity: other, restoreProfile });
    expect(h.manager.holdsProfile(prepared.dir)).toBe(false);
    await h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.manager.holdsProfile(prepared.dir)).toBe(true);
    expect(h.manager.holdsProfile(store.dirOf('123e4567-e89b-42d3-a456-426614174000'))).toBe(false);
    h.fp.value = SECRET;
    await advance(1500 + 1500 + 10);
    expect(h.manager.isActive()).toBe(true);
    expect(h.manager.holdsProfile(prepared.dir)).toBe(true);
    await advance(2000 * 2 + 10);
    expect(h.manager.isActive()).toBe(false);
    expect(h.manager.holdsProfile(prepared.dir)).toBe(true); // parked: the files are another account's
  });

  it('a failed restore is tried 3 times, reported as restore naming the card, and the card is set aside, never renewed', async () => {
    const prepared = card({ custody: 'foreign', family: 'live' });
    const restoreProfile = vi.fn(async (): Promise<undefined> => { throw new Error('locked'); });
    const h = setup({ identity: other, restoreProfile });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(2000 * 2 + 10);
    expect(restoreProfile).toHaveBeenCalledTimes(3);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1]).toMatchObject({ error: 'restore', email: 'app@x.com', expected: 'support@guybot.xyz' });
    expect(store.get(prepared.id)?.custody).toBe('quarantined');
    expect(h.manager.parkedIds()).toEqual([prepared.id]);
    expect(h.mock.onChanged).not.toHaveBeenCalled();
    expect(JSON.stringify(h.states)).not.toContain('fake-old');
    // A later retry (before a poll) puts the card back with its previous roles.
    restoreProfile.mockImplementation(async () => undefined);
    await h.manager.retryParkedRestores();
    expect(restoreProfile).toHaveBeenLastCalledWith(prepared.dir, { credentials: 'fake-old-creds', claudeJson: null });
    expect(store.get(prepared.id)).toMatchObject({ custody: 'foreign', family: 'live' });
    expect(h.manager.holdsProfile(prepared.dir)).toBe(false);
    expect(h.manager.parkedIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new start of a parked card retries its restore first and is refused with restore while it still fails', async () => {
    const prepared = card();
    const restoreProfile = vi.fn(async (): Promise<undefined> => { throw new Error('locked'); });
    const h = setup({ identity: other, restoreProfile });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(2000 * 2 + 10);
    const again = h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(2000 * 2 + 10);
    expect(await again).toEqual({ ok: false, error: 'restore' });
    expect(restoreProfile).toHaveBeenCalledTimes(6);
    expect(h.deps.snapshotProfile).toHaveBeenCalledTimes(1);
    expect(h.manager.isActive()).toBe(false);
    restoreProfile.mockImplementation(async () => undefined);
    const third = await h.manager.start({ provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(third.ok).toBe(true);
    expect(store.get(prepared.id)?.custody).toBe('app');
    h.manager.dispose();
  });

  it('signing in again a card set aside before a restart (quarantined, no holder) makes it the app\'s own again', async () => {
    const prepared = card({ email: 'new@example.com', accountUuid: undefined, custody: 'quarantined', family: 'live' });
    const h = setup();
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.get(prepared.id)).toMatchObject({ custody: 'app', family: 'own' });
    expect(store.get(prepared.id)?.duplicateOf).toBeUndefined();
  });

  it('removing a parked card forgets its snapshot', async () => {
    const prepared = card();
    const restoreProfile = vi.fn(async (): Promise<undefined> => { throw new Error('locked'); });
    const h = setup({ identity: other, restoreProfile });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(2000 * 2 + 10);
    h.manager.cancelFor(prepared.id);
    expect(h.manager.holdsProfile(prepared.dir)).toBe(false);
    await h.manager.retryParkedRestores();
    expect(restoreProfile).toHaveBeenCalledTimes(3);
  });

  it('bounds the wait for the parked restores before a poll and never starts a second retry while one runs', async () => {
    const prepared = card();
    const restoreProfile = vi.fn(async (): Promise<undefined> => { throw new Error('locked'); });
    const h = setup({ identity: other, restoreProfile });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(2000 * 2 + 10);
    expect(restoreProfile).toHaveBeenCalledTimes(3);
    // Claude Code holds the locks: each try waits long (about 10 s per lock).
    restoreProfile.mockImplementation(() => new Promise<undefined>((_resolve, reject) => { setTimeout(() => reject(new Error('locked')), 10_000); }));
    let done = false;
    const first = h.manager.retryParkedRestores(1_000).then(() => { done = true; });
    await advance(1_000);
    expect(done).toBe(true);
    await first;
    const second = h.manager.retryParkedRestores(1_000);
    await advance(1_000);
    await second;
    expect(restoreProfile).toHaveBeenCalledTimes(4); // the second call shares the retry still running
    await advance(40_000);
    expect(restoreProfile).toHaveBeenCalledTimes(6);
    expect(h.manager.holdsProfile(prepared.dir)).toBe(true);
    // The next retry starts again (no run left behind).
    restoreProfile.mockImplementation(async () => undefined);
    await h.manager.retryParkedRestores(1_000);
    expect(h.manager.holdsProfile(prepared.dir)).toBe(false);
  });

  it('waits until the profile identity is rewritten before it compares, and never takes the old one for the card', async () => {
    const prepared = card({ email: 'new@example.com', accountUuid: undefined });
    let n = 0;
    const identityRewritten = vi.fn(async () => ++n >= 3);
    const h = setup({ identityRewritten });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(3000);
    expect(identityRewritten).toHaveBeenCalledWith(prepared.dir, { credentials: 'fake-old-creds', claudeJson: null });
    expect(identityRewritten).toHaveBeenCalledTimes(3);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(h.mock.restoreProfile).not.toHaveBeenCalled();
  });

  it('an identity that is never confirmed as rewritten restores the card and fails with identity, never counts as same', async () => {
    const prepared = card({ email: 'new@example.com', accountUuid: undefined });
    const h = setup({ identityRewritten: vi.fn(async () => false) });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    await advance(5000);
    expect(h.deps.identity).toHaveBeenCalledTimes(5);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1]).toMatchObject({ error: 'identity', expected: 'new@example.com' });
    expect(h.mock.restoreProfile).toHaveBeenCalledTimes(1);
    expect(store.get(prepared.id)).toMatchObject({ custody: 'app', family: 'own' });
    expect(h.mock.onChanged).not.toHaveBeenCalled();
  });

  it('a failed main backup is refused with its own code naming the outgoing account; slot/journal refusals stay busy', async () => {
    const prepared = card({ custody: 'live' });
    store.setLive({ email: 'support@guybot.xyz', accountUuid: 'u-guybot', recordId: prepared.id });
    const locked = setup({ beforeMainLogin: vi.fn(async () => { throw new LiveBackupFailed('locked'); }) });
    expect(await locked.manager.start({ provider: 'claude', target: { type: 'main' } })).toEqual({ ok: false, error: 'backup', email: 'support@guybot.xyz' });
    const busy = setup({ beforeMainLogin: vi.fn(async () => { throw new LiveBackupFailed('busy'); }) });
    expect(await busy.manager.start({ provider: 'claude', target: { type: 'main' } })).toEqual({ ok: false, error: 'busy' });
    expect(locked.mock.spawnPty).not.toHaveBeenCalled();
    expect(busy.mock.spawnPty).not.toHaveBeenCalled();
  });

  it('isMainActive is true only during a main Claude login', async () => {
    const h = setup();
    expect(h.manager.isMainActive()).toBe(false);
    await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    expect(h.manager.isMainActive()).toBe(true);
    h.manager.dispose();
    await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    expect(h.manager.isMainActive()).toBe(false);
    h.manager.dispose();
  });
});
