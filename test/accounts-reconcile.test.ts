// test/accounts-reconcile.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareIdentity, custodyOf, type AccountIdentity } from '../src/shared/accounts';
import type { CswapRoster } from '../src/main/accounts/cswap';
import { gateFamilyRefresh } from '../src/main/accounts/guards';
import { renewRule } from '../src/main/accounts/refs';
import { backupLiveBeforeLogin, LiveBackupFailed, reconcileLive, reconcileWhenIdle, resyncOutgoingWhenIdle, type ReconcileDeps } from '../src/main/accounts/reconcile';
import { heldTokenHash, resyncActiveBackup } from '../src/main/accounts/resync';
import { LiveIdentityUnknown, readLiveClaudeIdentity } from '../src/main/usage/credentials';
import { AccountsStore } from '../src/main/accounts/store';
import { claimSwap, isSwapRunning, nodeSwapFs, releaseSwap, type SwapFs } from '../src/main/accounts/swap';

const G = { email: 'g@x.com', accountUuid: 'ug' };
const A = { email: 'a@x.com', accountUuid: 'ua' };
let root: string;
let home: string;
let store: AccountsStore;
let live: AccountIdentity | null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ajza-reconcile-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  store = new AccountsStore(join(root, 'accounts'));
  live = null;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (resync?: ReconcileDeps['resync']): ReconcileDeps => ({ store, readLiveIdentity: async () => live, now: () => 10, ...(resync ? { resync } : {}) });
const add = (identity: AccountIdentity, custody?: 'app' | 'live') => { const { id } = store.prepare(); store.commit({ id, addedAt: 1, ...identity, ...(custody ? { custody } : {}) }); return id; };
const holders = (identity: AccountIdentity) => store.list().filter((r) => custodyOf(r) !== 'quarantined' && compareIdentity(r, identity) === 'same');

describe('reconcileLive', () => {
  it('adopts an unknown live account as a record, once', async () => {
    live = A;
    const first = await reconcileLive(deps());
    expect(first.changed).toBe(true);
    expect(holders(A)).toHaveLength(1);
    expect(store.get(first.activeId!)).toMatchObject({ ...A, custody: 'live', family: 'live' });
    expect(store.notices().map((n) => n.kind)).toEqual(['adopted']);
    expect(await reconcileLive(deps())).toEqual({ activeId: first.activeId, changed: false });
  });

  it('main changes from G to A while a saved P holds A: P becomes live, G foreign, one card for A (investigation test 3)', async () => {
    const g = add(G, 'live');
    const p = add(A);
    store.setLive({ ...G, recordId: g });
    live = A;
    const result = await reconcileLive(deps());
    expect(result.activeId).toBe(p);
    expect(store.get(p)?.custody).toBe('live');
    expect(store.get(g)?.custody).toBe('foreign');
    expect(holders(A)).toHaveLength(1);
    // 1.0.10: an outside switch is no banner any more; G's card says it (custody foreign).
    expect(store.notices()).toEqual([]);
    expect(store.live()).toEqual({ ...A, recordId: p });
  });

  it('main changes from A to G externally: G is adopted, A is kept and nothing is deleted (investigation test 4)', async () => {
    const a = add(A, 'live');
    store.setLive({ ...A, recordId: a });
    live = G;
    await reconcileLive(deps());
    expect(store.get(a)?.custody).toBe('foreign');
    expect(existsSync(store.dirOf(a))).toBe(true);
    expect(holders(G)).toHaveLength(1);
  });

  it('a sign-out outside the app keeps the record and says so', async () => {
    const a = add(A, 'live');
    store.setLive({ ...A, recordId: a });
    await reconcileLive(deps());
    expect(store.get(a)?.custody).toBe('foreign');
    expect(store.notices()[0].kind).toBe('loggedOut');
    expect(store.live()).toBeNull();
  });

  it('an own change (the app signed in someone else) leaves the outgoing record renewable and silent', async () => {
    const a = add(A, 'live');
    live = G;
    await reconcileLive(deps(), { ownChange: true });
    expect(store.get(a)?.custody).toBe('app');
    expect(store.notices().map((n) => n.kind)).toEqual(['adopted']);
  });

  it('sets a second record of the live account aside instead of keeping two cards', async () => {
    const p = add(A, 'live');
    const copy = add(A);
    live = A;
    await reconcileLive(deps());
    expect(store.get(copy)).toMatchObject({ custody: 'quarantined', duplicateOf: p });
  });

  it('fills the uuids from the live login and resyncs the active record; a failing resync changes nothing else', async () => {
    const p = add({ email: 'a@x.com' }, 'live');
    live = A;
    const resync = vi.fn(async () => { throw new Error('disk'); });
    await reconcileLive(deps(resync));
    expect(store.get(p)?.accountUuid).toBe('ua');
    expect(resync).toHaveBeenCalledWith(p, A);
  });

  it('prefers the record the live login already names over an older record of the same account', async () => {
    const older = add(A);
    const named = add(A, 'live');
    store.setLive({ ...A, recordId: named });
    live = A;
    const result = await reconcileLive(deps());
    expect(result.activeId).toBe(named);
    expect(store.get(older)).toMatchObject({ custody: 'quarantined', duplicateOf: named });
    expect(store.notices().map((n) => n.kind)).toEqual(['quarantined']);
  });

  it('writes nothing and throws nothing while accounts.json is read-only', async () => {
    const a = add(A, 'live');
    store.setLive({ ...A, recordId: a });
    const file = join(root, 'accounts', 'accounts.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...parsed, version: 99 }));
    const before = readFileSync(file, 'utf8');
    live = G;
    const resync = vi.fn(async () => 'copied' as const);
    expect(store.readOnly()).toBe(true);
    expect(await reconcileLive(deps(resync))).toEqual({ activeId: a, changed: false });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(resync).not.toHaveBeenCalled();
  });

  it('sets a second live record of the live account aside without a switchedOut notice', async () => {
    const p = add(A, 'live');
    const copy = add(A, 'live');
    store.setLive({ ...A, recordId: p });
    live = A;
    await reconcileLive(deps());
    expect(store.get(copy)).toMatchObject({ custody: 'quarantined', duplicateOf: p });
    expect(store.notices().map((n) => n.kind)).toEqual(['quarantined']);
  });

  it('stops without a throw and leaves the file as it was when accounts.json turns read-only during the run', async () => {
    const a = add(A, 'live');
    store.setLive({ ...A, recordId: a });
    const file = join(root, 'accounts', 'accounts.json');
    let before = '';
    const result = await reconcileLive({ ...deps(), readLiveIdentity: async () => {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: 99 }));
      before = readFileSync(file, 'utf8');
      return G;
    } });
    expect(result).toEqual({ activeId: a, changed: false });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('uses one test for "left the login" and "set aside": a partial-identity live record ends either aside or marked, never live twice', async () => {
    const holder = add({ email: 'a@x.com', accountUuid: 'ua', organizationUuid: 'o1' }, 'live');
    const other = add({ email: 'a@x.com', organizationUuid: 'o2' }, 'live');
    store.setLive({ email: 'a@x.com', accountUuid: 'ua', recordId: holder });
    live = A; // no organisation: `other` matches the live identity but not the holder
    await reconcileLive(deps());
    expect(store.list().filter((r) => custodyOf(r) === 'live').map((r) => r.id)).toEqual([holder]);
    expect(store.get(other)?.custody).toBe('foreign');
    expect(store.notices()).toEqual([]);
  });

  it('changes nothing when the live identity cannot be read', async () => {
    add(A, 'live');
    const result = await reconcileLive({ ...deps(), readLiveIdentity: async () => { throw new Error('io'); } });
    expect(result.changed).toBe(false);
  });
});

describe('reconcileWhenIdle', () => {
  const idle = { swapUnresolved: () => false, loginActive: () => false };
  it('holds the swap slot while it runs and releases it, also after a throw', async () => {
    let during = false;
    expect(await reconcileWhenIdle(idle, async () => { during = isSwapRunning(); })).toBe(true);
    expect(during).toBe(true);
    expect(isSwapRunning()).toBe(false);
    await expect(reconcileWhenIdle(idle, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(isSwapRunning()).toBe(false);
  });

  it('skips while a swap holds the slot, a swap is unresolved or a login runs', async () => {
    const run = vi.fn(async () => undefined);
    expect(claimSwap()).toBe(true);
    try { expect(await reconcileWhenIdle(idle, run)).toBe(false); } finally { releaseSwap(); }
    expect(await reconcileWhenIdle({ ...idle, swapUnresolved: () => true }, run)).toBe(false);
    expect(await reconcileWhenIdle({ ...idle, loginActive: () => true }, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(isSwapRunning()).toBe(false);
  });
});

describe('gateFamilyRefresh (one renewal rule: renewRule)', () => {
  it('renews a profile exactly when renewRule allows it, never a quarantined record or a dir no record names', async () => {
    const own = add(A);
    store.setFamily(own, 'own');
    const legacy = add({ email: 'b@x.com' }); // 0.9.0 record: family defaults to live
    const copy = add({ email: 'c@x.com' }, 'live');
    store.setFamily(copy, 'own');
    const foreign = add({ email: 'd@x.com' });
    store.setFamily(foreign, 'own');
    store.setCustody(foreign, 'foreign');
    const parked = add({ email: 'e@x.com' });
    store.setFamily(parked, 'own');
    store.setCustody(parked, 'quarantined', own);
    // Same identity as the live login, but a family of its own (P and main, investigation test 5).
    const twin = add(G);
    store.setFamily(twin, 'own');
    store.setLive({ ...G, recordId: copy });
    let roster: CswapRoster = { present: false };
    const refresh = vi.fn(async () => 'renewed');
    const gated = gateFamilyRefresh(store, () => roster, refresh, 'blocked');
    const renewed = async () => {
      const out: string[] = [];
      for (const id of [own, legacy, copy, foreign, parked, twin]) {
        const result = await gated(store.dirOf(id));
        const record = store.get(id)!;
        // The gate and the card (claudeRefs) never disagree: both come from renewRule.
        if (custodyOf(record) !== 'quarantined') expect(result === 'renewed').toBe(renewRule(record, store.live(), roster) === 'allowed');
        if (result === 'renewed') out.push(id);
      }
      return out;
    };
    // Without cswap a legacy record is the app's only copy and may be renewed.
    expect(await renewed()).toEqual([own, legacy]);
    // cswap lists it: its copy of that family must not be rotated away. An own family is never cswap's.
    roster = { present: true, accounts: [{ email: 'b@x.com' }, { email: 'a@x.com', accountUuid: 'ua' }] };
    expect(await renewed()).toEqual([own]);
    // An unreadable roster holds every live-family record.
    roster = { present: true, accounts: null };
    expect(await renewed()).toEqual([own]);
    expect(await gated(join(root, 'elsewhere'))).toBe('blocked');
  });
});

describe('resyncActiveBackup', () => {
  const paths = () => ({ credentials: join(home, '.claude', '.credentials.json'), claudeJson: join(home, '.claude.json') });
  const putLive = (identity: { emailAddress: string; accountUuid: string }, n: string) => {
    writeFileSync(paths().credentials, JSON.stringify({ claudeAiOauth: { accessToken: `fake-acc-${n}`, refreshToken: `fake-ref-${n}`, expiresAt: 5 }, mcpOAuth: { s: 1 } }));
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: identity, projects: {} }));
  };
  const rdeps = () => ({ paths: paths(), store, delay: async () => undefined, locks: { timeoutMs: 300 } });

  it('copies the live tokens into the record, keeps other keys, marks the family live; unchanged the second time', async () => {
    const p = add(A, 'live');
    mkdirSync(store.dirOf(p), { recursive: true });
    writeFileSync(join(store.dirOf(p), '.credentials.json'), JSON.stringify({ other: 1, claudeAiOauth: { accessToken: 'old', refreshToken: 'old' } }));
    putLive({ emailAddress: 'a@x.com', accountUuid: 'ua' }, '1');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('copied');
    const copied = JSON.parse(readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8'));
    expect(copied).toEqual({ other: 1, claudeAiOauth: { accessToken: 'fake-acc-1', refreshToken: 'fake-ref-1', expiresAt: 5 } });
    expect(JSON.parse(readFileSync(join(store.dirOf(p), '.claude.json'), 'utf8')).oauthAccount.accountUuid).toBe('ua');
    expect(store.get(p)?.family).toBe('live');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('unchanged');
  });

  it("never copies a login whose identity is not the record's", async () => {
    const p = add(A, 'live');
    putLive({ emailAddress: 'g@x.com', accountUuid: 'ug' }, '2');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('mismatch');
    expect(existsSync(join(store.dirOf(p), '.credentials.json'))).toBe(false);
  });

  it("waits for Claude Code's credential lock and gives up without writing", async () => {
    const p = add(A, 'live');
    putLive({ emailAddress: 'a@x.com', accountUuid: 'ua' }, '3');
    mkdirSync(join(home, '.claude', '.oauth_refresh.lock'));
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('locked');
    expect(existsSync(join(store.dirOf(p), '.credentials.json'))).toBe(false);
  });

  it('with a memory of the last look, copies new tokens only once the live files read the same twice', async () => {
    const p = add(A, 'live');
    const seen = new Map<string, string>();
    putLive({ emailAddress: 'a@x.com', accountUuid: 'ua' }, '4');
    expect(await resyncActiveBackup({ ...rdeps(), seen }, p, A)).toBe('settling');
    expect(existsSync(join(store.dirOf(p), '.credentials.json'))).toBe(false);
    expect(await resyncActiveBackup({ ...rdeps(), seen }, p, A)).toBe('copied');
    expect(JSON.parse(readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fake-ref-4');
    // A /login caught between its two writes: new tokens, the old identity. Never copied on that look.
    writeFileSync(paths().credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-acc-5', refreshToken: 'fake-ref-5', expiresAt: 6 } }));
    expect(await resyncActiveBackup({ ...rdeps(), seen }, p, A)).toBe('settling');
    expect(JSON.parse(readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fake-ref-4');
  });

  it('copies an identity-only change (organisation renamed) at once and leaves the tokens alone', async () => {
    const p = add(A, 'live');
    putLive({ emailAddress: 'a@x.com', accountUuid: 'ua' }, '6');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('copied');
    const credsBefore = readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8');
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', accountUuid: 'ua', organizationName: 'New Org' } }));
    expect(await resyncActiveBackup({ ...rdeps(), seen: new Map() }, p, A)).toBe('copied');
    expect(JSON.parse(readFileSync(join(store.dirOf(p), '.claude.json'), 'utf8')).oauthAccount.organizationName).toBe('New Org');
    expect(readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8')).toBe(credsBefore);
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('unchanged');
  });

  it('ignores .claude.json churn outside oauthAccount when deciding that the live files are stable', async () => {
    const p = add(A, 'live');
    const seen = new Map<string, string>();
    putLive({ emailAddress: 'a@x.com', accountUuid: 'ua' }, '7');
    expect(await resyncActiveBackup({ ...rdeps(), seen }, p, A)).toBe('settling');
    writeFileSync(paths().claudeJson, JSON.stringify({ numStartups: 42, projects: { x: {} }, oauthAccount: { emailAddress: 'a@x.com', accountUuid: 'ua' } }));
    expect(await resyncActiveBackup({ ...rdeps(), seen }, p, A)).toBe('copied');
    expect(JSON.parse(readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fake-ref-7');
  });

  it('retries a failed copy on the next look with the same files, and remembers only the record looked at last', async () => {
    const p = add(A, 'live');
    const q = add(G, 'live');
    const seen = new Map<string, string>([[q, 'old']]);
    let failOnce = true;
    const fs: SwapFs = { ...nodeSwapFs, writeFile: async (path, data, mode) => { if (failOnce) { failOnce = false; throw new Error('disk'); } return nodeSwapFs.writeFile(path, data, mode); } };
    putLive({ emailAddress: 'a@x.com', accountUuid: 'ua' }, '8');
    expect(await resyncActiveBackup({ ...rdeps(), seen, fs }, p, A)).toBe('settling');
    expect([...seen.keys()]).toEqual([p]);
    await expect(resyncActiveBackup({ ...rdeps(), seen, fs }, p, A)).rejects.toThrow('disk');
    expect(await resyncActiveBackup({ ...rdeps(), seen, fs }, p, A)).toBe('copied');
    expect(JSON.parse(readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fake-ref-8');
  });

  it('reports a missing live login', async () => {
    const p = add(A, 'live');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('missing');
  });
});

describe('backupLiveBeforeLogin (main re-login, preflight F10)', () => {
  const paths = () => ({ credentials: join(home, '.claude', '.credentials.json'), claudeJson: join(home, '.claude.json') });
  const putLive = (n: string) => {
    writeFileSync(paths().credentials, JSON.stringify({ claudeAiOauth: { accessToken: `fake-acc-${n}`, refreshToken: `fake-ref-${n}`, expiresAt: 5 } }));
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', accountUuid: 'ua' } }));
  };
  const guard = { swapUnresolved: () => false };
  const opts = { delay: async () => undefined };
  const withResync = (resync: ReconcileDeps['resync']) => deps(resync);

  it('backs the live login up into its record before resolving, retrying while the live files settle (real resync)', async () => {
    const p = add(A, 'live');
    store.setLive({ ...A, recordId: p });
    live = A;
    putLive('1');
    const seen = new Map<string, string>();
    const results: string[] = [];
    const resync = async (id: string, identity: AccountIdentity) => {
      const r = await resyncActiveBackup({ paths: paths(), store, seen, delay: async () => undefined, locks: { timeoutMs: 300 } }, id, identity);
      results.push(r);
      return r;
    };
    await backupLiveBeforeLogin(guard, withResync(resync), opts);
    expect(results).toEqual(['settling', 'copied']);
    expect(JSON.parse(readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fake-ref-1');
    expect(isSwapRunning()).toBe(false);
  });

  it('applies a pending own change of an earlier app login: the record that left becomes app, without a notice', async () => {
    const g = add(G, 'live');
    store.setLive({ ...G, recordId: g });
    add(A);
    live = A;
    await backupLiveBeforeLogin(guard, withResync(async () => 'copied' as const), { ...opts, ownChange: true });
    expect(store.get(g)?.custody).toBe('app');
    expect(store.notices().filter((n) => n.kind === 'switchedOut')).toEqual([]);
  });

  it('resolves at once when the backup is already current', async () => {
    add(A, 'live');
    live = A;
    const resync = vi.fn(async () => 'unchanged' as const);
    await backupLiveBeforeLogin(guard, withResync(resync), opts);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it.each(['settling', 'locked', 'mismatch'] as const)('refuses when every try ends %s (never proceeds as if backed up)', async (result) => {
    add(A, 'live');
    live = A;
    const resync = vi.fn(async () => result);
    await expect(backupLiveBeforeLogin(guard, withResync(resync), { ...opts, tries: 3 })).rejects.toThrow(LiveBackupFailed);
    expect(resync).toHaveBeenCalledTimes(3);
    expect(isSwapRunning()).toBe(false);
  });

  it('refuses when the copy throws', async () => {
    add(A, 'live');
    live = A;
    await expect(backupLiveBeforeLogin(guard, withResync(async () => { throw new Error('disk'); }), opts)).rejects.toThrow(LiveBackupFailed);
  });

  it('refuses while a swap holds the slot, a swap is unresolved or an activation journal is pending', async () => {
    add(A, 'live');
    live = A;
    const resync = vi.fn(async () => 'copied' as const);
    expect(claimSwap()).toBe(true);
    try { await expect(backupLiveBeforeLogin(guard, withResync(resync), opts)).rejects.toThrow(LiveBackupFailed); } finally { releaseSwap(); }
    await expect(backupLiveBeforeLogin({ swapUnresolved: () => true }, withResync(resync), opts)).rejects.toThrow(LiveBackupFailed);
    await expect(backupLiveBeforeLogin({ ...guard, journalPending: async () => true }, withResync(resync), opts)).rejects.toThrow(LiveBackupFailed);
    expect(resync).not.toHaveBeenCalled();
  });

  it('refuses when the live identity cannot be read or accounts.json is read-only', async () => {
    add(A, 'live');
    const resync = vi.fn(async () => 'copied' as const);
    await expect(backupLiveBeforeLogin(guard, { ...withResync(resync), readLiveIdentity: async () => { throw new Error('io'); } }, opts)).rejects.toThrow(LiveBackupFailed);
    live = A;
    const file = join(root, 'accounts', 'accounts.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: 99 }));
    expect(store.readOnly()).toBe(true);
    await expect(backupLiveBeforeLogin(guard, withResync(resync), opts)).rejects.toThrow(LiveBackupFailed);
    expect(resync).not.toHaveBeenCalled();
  });

  it('proceeds when nobody is signed in, when the live login holds no refresh token, or where there is no file login (macOS)', async () => {
    live = null;
    const resync = vi.fn(async () => 'copied' as const);
    await backupLiveBeforeLogin(guard, withResync(resync), opts);
    expect(resync).not.toHaveBeenCalled();
    live = A;
    await backupLiveBeforeLogin(guard, withResync(async () => 'missing' as const), opts);
    await backupLiveBeforeLogin(guard, deps(), opts);
  });
});

describe('own change and the outgoing backup during a main login (fix round 1)', () => {
  const guard = { swapUnresolved: () => false };
  const opts = { delay: async () => undefined };

  it('passes ownChange to the first reconcile that runs only and reports it applied, also when the backup then fails', async () => {
    const g = add(G, 'live');
    store.setLive({ ...G, recordId: g });
    add(A);
    live = A;
    const applied = vi.fn();
    const resync = vi.fn(async () => 'locked' as const);
    await expect(backupLiveBeforeLogin(guard, deps(resync), { ...opts, ownChange: true, ownChangeApplied: applied, tries: 3 })).rejects.toThrow(LiveBackupFailed);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledTimes(3);
    expect(store.get(g)?.custody).toBe('app');
    expect(store.notices().filter((n) => n.kind === 'switchedOut')).toEqual([]);
  });

  it('does not report the own change applied when no reconcile could run', async () => {
    const applied = vi.fn();
    expect(claimSwap()).toBe(true);
    try {
      await expect(backupLiveBeforeLogin(guard, deps(async () => 'copied' as const), { ...opts, ownChange: true, ownChangeApplied: applied })).rejects.toThrow(LiveBackupFailed);
    } finally { releaseSwap(); }
    expect(applied).not.toHaveBeenCalled();
  });

  it('resyncs only the outgoing live record (no role changes), under the swap slot', async () => {
    const g = add(G, 'live');
    store.setLive({ ...G, recordId: g });
    live = A; // the new login is already visible: roles must not change mid-login
    let during = false;
    const resync = vi.fn(async () => { during = isSwapRunning(); return 'mismatch' as const; });
    expect(await resyncOutgoingWhenIdle(guard, deps(resync))).toBe('mismatch');
    expect(resync).toHaveBeenCalledWith(g, G);
    expect(during).toBe(true);
    expect(store.get(g)?.custody).toBe('live');
    expect(store.live()).toEqual({ ...G, recordId: g });
    expect(store.list()).toHaveLength(1);
    expect(isSwapRunning()).toBe(false);
  });

  it('skips the outgoing resync while a swap holds the slot, a journal is pending, or nothing is live', async () => {
    const g = add(G, 'live');
    const resync = vi.fn(async () => 'copied' as const);
    expect(await resyncOutgoingWhenIdle(guard, deps(resync))).toBe(null);
    store.setLive({ ...G, recordId: g });
    expect(await resyncOutgoingWhenIdle({ ...guard, journalPending: async () => true }, deps(resync))).toBe(null);
    expect(claimSwap()).toBe(true);
    try { expect(await resyncOutgoingWhenIdle(guard, deps(resync))).toBe(null); } finally { releaseSwap(); }
    expect(resync).not.toHaveBeenCalled();
    expect(await resyncOutgoingWhenIdle(guard, deps())).toBe(null);
    expect(await resyncOutgoingWhenIdle(guard, deps(resync))).toBe('copied');
  });
});

describe('final fix wave: live family, unreadable live config, held tokens', () => {
  const paths = () => ({ credentials: join(home, '.claude', '.credentials.json'), claudeJson: join(home, '.claude.json') });
  const putCreds = (n: string) => writeFileSync(paths().credentials, JSON.stringify({ claudeAiOauth: { accessToken: `fake-acc-${n}`, refreshToken: `fake-ref-${n}`, expiresAt: 5 } }));
  const realDeps = (resync?: ReconcileDeps['resync']): ReconcileDeps => ({
    store, readLiveIdentity: () => readLiveClaudeIdentity({ env: {}, home }), now: () => 10, ...(resync ? { resync } : {}),
  });
  const guard = { swapUnresolved: () => false };
  const opts = { delay: async () => undefined };

  it('a holder promoted to live takes the live family, so an own change later never makes it renewable while cswap lists it (I1)', async () => {
    const p = add(A);
    store.setFamily(p, 'own');
    live = A;
    await reconcileLive(deps());
    expect(store.get(p)).toMatchObject({ custody: 'live', family: 'live' });
    live = G;
    await reconcileLive(deps(), { ownChange: true });
    expect(store.get(p)?.custody).toBe('app');
    expect(renewRule(store.get(p)!, store.live(), { present: true, accounts: [A] })).toBe('held-by-cswap');
  });

  it('readLiveClaudeIdentity: missing file or no account is signed out, a corrupt or unreadable file is unknown (I2)', async () => {
    expect(await readLiveClaudeIdentity({ env: {}, home })).toBeNull();
    writeFileSync(paths().claudeJson, JSON.stringify({ projects: {} }));
    expect(await readLiveClaudeIdentity({ env: {}, home })).toBeNull();
    writeFileSync(paths().claudeJson, '{"oauthAccount": {"emailAddress": "a@x.com", "accou');
    await expect(readLiveClaudeIdentity({ env: {}, home })).rejects.toBeInstanceOf(LiveIdentityUnknown);
    writeFileSync(paths().claudeJson, '');
    await expect(readLiveClaudeIdentity({ env: {}, home })).rejects.toBeInstanceOf(LiveIdentityUnknown);
    await expect(readLiveClaudeIdentity({ env: {}, home }, async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); })).rejects.toBeInstanceOf(LiveIdentityUnknown);
    rmSync(paths().claudeJson);
    mkdirSync(paths().claudeJson); // EISDIR: it exists but cannot be read
    await expect(readLiveClaudeIdentity({ env: {}, home })).rejects.toBeInstanceOf(LiveIdentityUnknown);
    rmSync(paths().claudeJson, { recursive: true });
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', accountUuid: 'ua' } }));
    expect(await readLiveClaudeIdentity({ env: {}, home })).toEqual(A);
  });

  for (const kind of ['corrupt', 'unreadable'] as const) {
    const spoil = () => {
      if (kind === 'corrupt') writeFileSync(paths().claudeJson, '{"oauthAccount": {"emailAd');
      else { rmSync(paths().claudeJson, { force: true }); mkdirSync(paths().claudeJson); }
    };

    it(`a ${kind} live config changes no role, adds no notice and keeps the live record (I2)`, async () => {
      const a = add(A, 'live');
      store.setLive({ ...A, recordId: a });
      spoil();
      const resync = vi.fn(async () => 'copied' as const);
      expect(await reconcileLive(realDeps(resync))).toEqual({ activeId: a, changed: false });
      expect(store.get(a)?.custody).toBe('live');
      expect(store.notices()).toEqual([]);
      expect(store.live()).toEqual({ ...A, recordId: a });
      expect(store.list()).toHaveLength(1);
      expect(resync).not.toHaveBeenCalled();
    });

    it(`a ${kind} live config refuses the main re-login with unread instead of starting it without a backup (I2)`, async () => {
      const a = add(A, 'live');
      store.setLive({ ...A, recordId: a });
      spoil();
      const resync = vi.fn(async () => 'copied' as const);
      const error = await backupLiveBeforeLogin(guard, realDeps(resync), opts).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LiveBackupFailed);
      expect((error as LiveBackupFailed).reason).toBe('unread');
      expect(store.live()).toEqual({ ...A, recordId: a });
      // The outgoing backup during a main login keeps running (the live record was not dropped).
      expect(await resyncOutgoingWhenIdle(guard, realDeps(resync))).toBe('copied');
    });
  }

  it('held tokens are never copied into the record; the hold ends when the live login is rewritten (M1)', async () => {
    const a = add(A, 'live');
    mkdirSync(store.dirOf(a), { recursive: true });
    writeFileSync(join(store.dirOf(a), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-acc-A', refreshToken: 'fake-ref-A' } }));
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', accountUuid: 'ua' } }));
    putCreds('X'); // the target's tokens under A's identity
    store.setHeldTokens(a, heldTokenHash('fake-ref-X'));
    const rdeps = { paths: paths(), store, delay: async () => undefined, locks: { timeoutMs: 300 } };
    expect(await resyncActiveBackup(rdeps, a, A)).toBe('held');
    expect(JSON.parse(readFileSync(join(store.dirOf(a), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fake-ref-A');
    // A main re-login is not blocked by it: nothing of A's would be dropped.
    await backupLiveBeforeLogin(guard, { ...deps(() => resyncActiveBackup(rdeps, a, A)), readLiveIdentity: async () => A }, opts);
    expect(store.get(a)?.heldTokens).toBeDefined();
    putCreds('A2'); // signed in again outside the app: a different login, the hold ends
    expect(await resyncActiveBackup(rdeps, a, A)).toBe('copied');
    expect(store.get(a)?.heldTokens).toBeUndefined();
    expect(JSON.parse(readFileSync(join(store.dirOf(a), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fake-ref-A2');
  });

  it("the hold also ends when the live login is exactly the record's own saved copy (M1)", async () => {
    const a = add(A, 'live');
    mkdirSync(store.dirOf(a), { recursive: true });
    writeFileSync(join(store.dirOf(a), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-acc-A', refreshToken: 'fake-ref-A', expiresAt: 5 } }));
    writeFileSync(join(store.dirOf(a), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', accountUuid: 'ua' } }, null, 2));
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', accountUuid: 'ua' } }));
    putCreds('A');
    store.setHeldTokens(a, heldTokenHash('fake-ref-A'));
    expect(await resyncActiveBackup({ paths: paths(), store, delay: async () => undefined, locks: { timeoutMs: 300 } }, a, A)).toBe('unchanged');
    expect(store.get(a)?.heldTokens).toBeUndefined();
  });
});
