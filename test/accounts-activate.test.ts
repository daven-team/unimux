import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareIdentity, custodyOf, type AccountIdentity } from '../src/shared/accounts';
import {
  activateAccount, activationJournalPending, checkActivationTarget, clearPendingActivation, isActivationRecoveryPending, recoverActivationWithRetry,
  recoverInterruptedActivation, startActivationRecoveryRetry, type ActivateDeps,
} from '../src/main/accounts/activate';
import type { CswapRoster } from '../src/main/accounts/cswap';
import { reconcileLive, reconcileWhenIdle } from '../src/main/accounts/reconcile';
import { withProfileLock } from '../src/main/accounts/refresh';
import { resyncActiveBackup } from '../src/main/accounts/resync';
import { claudeRefs } from '../src/main/accounts/refs';
import { AccountsStore } from '../src/main/accounts/store';
import { claimSwap, clearPendingSwap, isSwapUnresolved, nodeSwapFs, releaseSwap, setSwapUnresolved, type SwapFs } from '../src/main/accounts/swap';
import { fetchClaude, type FetcherDeps } from '../src/main/usage/fetchers';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const FUTURE = NOW + 3_600_000;
let root: string;
let home: string;
let store: AccountsStore;
let refresh: ActivateDeps['refresh'];
let roster: CswapRoster;
let fs: SwapFs;
let A: string; // record of the live account a@x.com
let T: string; // target x@x.com

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const put = (path: string, data: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
const liveCreds = () => join(home, '.claude', '.credentials.json');
const liveJson = () => join(home, '.claude.json');
const backupDir = () => join(root, 'accounts', 'swap-backup');
const creds = (n: string, expiresAt = FUTURE) => ({ claudeAiOauth: { accessToken: `fake-acc-${n}`, refreshToken: `fake-ref-${n}`, expiresAt, scopes: ['s'] }, mcpOAuth: { server: n } });
const account = (n: string, email: string) => ({ emailAddress: email, organizationName: `Org ${n}`, accountUuid: `uuid-${n}`, organizationUuid: `org-${n}` });
const deps = (): ActivateDeps => ({ home, env: {}, platform: 'win32', store, backupDir: backupDir(), now: () => NOW, refresh, delay: async () => undefined, cswap: async () => roster, fs, locks: { timeoutMs: 300 } });
const files = () => [liveCreds(), liveJson(), join(store.dirOf(A), '.credentials.json'), join(store.dirOf(A), '.claude.json'), join(store.dirOf(T), '.credentials.json')];
const snapshot = () => files().map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
const lockDirs = () => [join(home, '.claude', '.oauth_refresh.lock'), join(home, '.claude.lock'), join(home, '.claude.json.lock')];

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ajza-activate-'))); // the legacy lock path is realpath-based (native: 8.3 names on CI)
  home = join(root, 'home');
  store = new AccountsStore(join(root, 'accounts'));
  refresh = vi.fn(async () => ({ kind: 'ok' as const }));
  roster = { present: false };
  fs = nodeSwapFs;
  put(liveCreds(), creds('A'));
  put(liveJson(), { oauthAccount: account('A', 'a@x.com'), projects: { p: 1 }, numStartups: 4 });
  A = store.prepare().id;
  store.commit({ id: A, addedAt: 1, email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A', custody: 'live', family: 'live' });
  T = store.prepare().id;
  store.commit({ id: T, addedAt: 2, email: 'x@x.com', accountUuid: 'uuid-X', organizationUuid: 'org-X', custody: 'app', family: 'own' });
  put(join(store.dirOf(T), '.credentials.json'), creds('X'));
  put(join(store.dirOf(T), '.claude.json'), { oauthAccount: account('X', 'x@x.com'), theme: 'dark' });
  store.setLive({ email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A', recordId: A });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('activateAccount', () => {
  it('saves the outgoing live login to its record, writes the target into Claude Code and moves the roles', async () => {
    const result = await activateAccount(deps(), T);
    expect(result).toEqual({ ok: true, email: 'x@x.com' });
    expect(json(liveCreds())).toEqual({ ...creds('X'), mcpOAuth: { server: 'A' } });
    expect(json(liveJson())).toEqual({ oauthAccount: account('X', 'x@x.com'), projects: { p: 1 }, numStartups: 4 });
    expect(json(join(store.dirOf(A), '.credentials.json')).claudeAiOauth).toEqual(creds('A').claudeAiOauth);
    expect(json(join(store.dirOf(A), '.claude.json')).oauthAccount).toEqual(account('A', 'a@x.com'));
    expect(json(join(store.dirOf(T), '.credentials.json'))).toEqual(creds('X')); // the target keeps its copy as a backup
    expect(store.get(A)).toMatchObject({ custody: 'app', family: 'live' });
    expect(store.get(T)).toMatchObject({ custody: 'live' });
    expect(store.live()?.recordId).toBe(T);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
    expect(lockDirs().map(existsSync)).toEqual([false, false, false]);
    expect(JSON.stringify(result)).not.toContain('fake-');
  });

  it('creates a record for an outgoing account the app did not know (a login is never dropped)', async () => {
    store.remove(A);
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    const outgoing = store.list().filter((r) => compareIdentity(r, { accountUuid: 'uuid-A', organizationUuid: 'org-A' }) === 'same');
    expect(outgoing).toHaveLength(1);
    expect(custodyOf(outgoing[0])).toBe('app');
    expect(json(join(store.dirOf(outgoing[0].id), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-A');
  });

  it('is not blocked by an unrelated duplicate (investigation test 10)', async () => {
    const dup = store.prepare().id;
    store.commit({ id: dup, addedAt: 3, email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A', custody: 'quarantined', duplicateOf: A });
    expect((await activateAccount(deps(), T)).ok).toBe(true);
  });

  it('does not renew a target whose token is valid for more than 5 minutes', async () => {
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('renews a target that expires in 2 minutes, and reports dead with the e-mail', async () => {
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 2 * 60_000));
    refresh = vi.fn(async () => ({ kind: 'dead' as const }));
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'dead', email: 'x@x.com' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refuses a switched-out target and a stale copy cswap also holds, but swaps an own family cswap lists', async () => {
    store.setCustody(T, 'foreign');
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    store.setCustody(T, 'app');
    roster = { present: true, accounts: [{ email: 'x@x.com', accountUuid: 'uuid-X' }] };
    store.setFamily(T, 'live');
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 2 * 60_000));
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    store.setFamily(T, 'own');
    expect((await activateAccount(deps(), T)).ok).toBe(true);
  });

  it('swaps in a fresh copy cswap also holds without any token request, and refuses a stale one with foreign (I3)', async () => {
    roster = { present: true, accounts: [{ email: 'x@x.com', accountUuid: 'uuid-X' }] };
    store.setFamily(T, 'live');
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 4 * 60_000)); // would need renewing: refused, no request
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    expect(refresh).not.toHaveBeenCalled();
    expect(json(liveCreds()).claudeAiOauth.refreshToken).toBe('fake-ref-A');
    put(join(store.dirOf(T), '.credentials.json'), creds('X')); // valid for an hour: only files move
    expect(await activateAccount(deps(), T)).toEqual({ ok: true, email: 'x@x.com' });
    expect(refresh).not.toHaveBeenCalled();
    expect(json(liveCreds()).claudeAiOauth.refreshToken).toBe('fake-ref-X');
    expect(store.get(A)).toMatchObject({ custody: 'app', family: 'live' }); // the outgoing copy is the live family
    expect(store.get(T)).toMatchObject({ custody: 'live', family: 'live' });
  });

  it('the target takes the live family: switched out again by an own change while cswap lists it, it is never renewable (I1)', async () => {
    roster = { present: true, accounts: [{ email: 'x@x.com', accountUuid: 'uuid-X' }] };
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(store.get(T)?.family).toBe('live');
    // The app signs in someone else (a main re-login): T leaves the live login as an own change and becomes `app`.
    const G = { email: 'g@x.com', accountUuid: 'uuid-G', organizationUuid: 'org-G' };
    await reconcileLive({ store, readLiveIdentity: async () => G, now: () => NOW }, { ownChange: true });
    expect(store.get(T)?.custody).toBe('app');
    const refs = claudeRefs({ records: store.list(), dirOf: (id) => store.dirOf(id), live: store.live(), cswap: roster, platform: 'win32' });
    expect(refs.find((r) => r.id === `claude:${T}`)?.renew).toBe('held-by-cswap');
    expect(refs.every((r) => r.renew !== 'allowed' || r.id !== `claude:${T}`)).toBe(true);
  });

  it("holds Claude Code's locks for every write into Claude Code's files (investigation test 11)", async () => {
    const seen: boolean[] = [];
    fs = { ...nodeSwapFs, rename: async (from, to) => { if (to === liveCreds() || to === liveJson()) seen.push(lockDirs().every(existsSync)); return nodeSwapFs.rename(from, to); } };
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(seen).toEqual([true, true]);
  });

  it('waits on a held lock and aborts cleanly on timeout without writing', async () => {
    const before = snapshot();
    mkdirSync(join(home, '.claude.lock'));
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'locked' });
    expect(snapshot()).toEqual(before);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
    expect(store.list()).toHaveLength(2);
  });

  it('rolls back exactly when writing the live credentials fails', async () => {
    const before = snapshot();
    let failed = false; // fails once: the rollback's own write must go through
    fs = { ...nodeSwapFs, rename: async (from, to) => { if (to === liveCreds() && !failed) { failed = true; throw Object.assign(new Error('boom'), { code: 'EIO' }); } return nodeSwapFs.rename(from, to); } };
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'write' });
    expect(snapshot()).toEqual(before);
    expect(store.get(A)?.custody).toBe('live');
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('renews the target only through the one family rule, and never while holding Claude Code locks', async () => {
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 2 * 60_000));
    const locksDuringRefresh: boolean[] = [];
    refresh = vi.fn(async () => { locksDuringRefresh.push(lockDirs().some(existsSync)); return { kind: 'ok' as const }; });
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(refresh).toHaveBeenCalledWith(store.dirOf(T));
    expect(locksDuringRefresh).toEqual([false]);
  });

  it('never renews or swaps in an expiring target the rule refuses (held by cswap or by the live identity)', async () => {
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 2 * 60_000));
    store.setFamily(T, 'live');
    roster = { present: true, accounts: null }; // unreadable roster: holds everything
    const before = snapshot();
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    store.setFamily(T, 'own');
    roster = { present: false };
    store.updateIdentity(T, { accountUuid: 'uuid-A', organizationUuid: 'org-A' }); // the live account under another label
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'sameAccount', email: 'x@x.com' });
    expect(refresh).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('refuses the live record itself as the main one, naming it', async () => {
    expect(await activateAccount(deps(), A)).toEqual({ ok: false, error: 'sameAccount', email: 'a@x.com' });
  });

  it('records the outgoing family as live, also on a record it had to create', async () => {
    store.remove(A);
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    const outgoing = store.list().find((r) => r.id !== T)!;
    expect(outgoing).toMatchObject({ custody: 'app', family: 'live', accountUuid: 'uuid-A' });
  });

  it('removes its backups when the first journal write fails (no live file was touched)', async () => {
    const before = snapshot();
    fs = { ...nodeSwapFs, rename: async (from, to) => { if (to.endsWith('swap-journal.json')) throw Object.assign(new Error('boom'), { code: 'EIO' }); return nodeSwapFs.rename(from, to); } };
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'write' });
    expect(snapshot()).toEqual(before);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('is busy while another swap runs and pending while a journal exists', async () => {
    expect(claimSwap()).toBe(true);
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'busy' });
    releaseSwap();
    put(join(backupDir(), 'swap-journal.json'), { version: 1 });
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'pending' });
  });

  const loginCreds = { claudeAiOauth: { accessToken: 'fake-acc-login', refreshToken: 'fake-ref-login', expiresAt: FUTURE } };
  /** A writer that ignores the locks (a /login, a holder that broke them as stale) right after the swap wrote the identity. */
  const foreignWriteAfterSwap = (write: () => void): SwapFs => {
    let done = false;
    return { ...nodeSwapFs, rename: async (from, to) => { await nodeSwapFs.rename(from, to); if (to === liveJson() && !done) { done = true; write(); } } };
  };

  it('never rolls back over a login someone else wrote before the verification (manual, backups kept)', async () => {
    setSwapUnresolved(false);
    fs = foreignWriteAfterSwap(() => put(liveCreds(), loginCreds));
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'manual' });
    expect(json(liveCreds())).toEqual(loginCreds);
    expect(json(join(store.dirOf(A), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-A'); // the outgoing copy stays
    expect(readdirSync(backupDir())).toEqual(expect.arrayContaining(['swap-journal.json', 'live-credentials.json', 'live-claude.json']));
    expect(isSwapUnresolved()).toBe(true);
    setSwapUnresolved(false);
  });

  it('never rolls back over an identity someone else wrote either', async () => {
    fs = foreignWriteAfterSwap(() => put(liveJson(), { oauthAccount: account('Z', 'z@x.com') }));
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'manual' });
    expect(json(liveJson()).oauthAccount).toEqual(account('Z', 'z@x.com'));
    expect(json(join(store.dirOf(A), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-A');
    expect(existsSync(join(backupDir(), 'swap-journal.json'))).toBe(true);
    setSwapUnresolved(false);
  });

  it('waits for a renewal of the outgoing record still in flight before taking the Claude Code locks', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const renewal = withProfileLock(store.dirOf(A), async () => { await gate; put(join(store.dirOf(A), '.credentials.json'), creds('renewed')); });
    const running = activateAccount(deps(), T);
    const state = await Promise.race([running.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 400))]);
    expect(state).toBe('waiting');
    expect(lockDirs().map(existsSync)).toEqual([false, false, false]);
    release();
    await renewal;
    expect((await running).ok).toBe(true);
    expect(json(join(store.dirOf(A), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-A');
  });

  it('commits a record for an unknown outgoing account only once the journal names it', async () => {
    store.remove(A);
    const counts: number[] = [];
    fs = { ...nodeSwapFs, rename: async (from, to) => { if (to.endsWith('swap-journal.json')) counts.push(store.list().length); return nodeSwapFs.rename(from, to); } };
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(counts[0]).toBe(1);
    expect(counts.at(-1)).toBe(2);
  });

  it('leaves neither a record nor a profile dir behind when an unknown outgoing account cannot be saved', async () => {
    store.remove(A);
    fs = { ...nodeSwapFs, rename: async (from, to) => { if (to.endsWith('swap-journal.json')) throw Object.assign(new Error('boom'), { code: 'EIO' }); return nodeSwapFs.rename(from, to); } };
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'write' });
    expect(store.list().map((r) => r.id)).toEqual([T]);
    expect(readdirSync(join(root, 'accounts', 'claude'))).toEqual([T]);
  });
});

describe('checkActivationTarget (the makeMain IPC check)', () => {
  it('accepts an app-held target and refuses a missing, set-aside, live, switched-out or cswap-held one, naming it', async () => {
    expect(await checkActivationTarget(deps(), T)).toBeNull();
    expect(await checkActivationTarget(deps(), '123e4567-e89b-42d3-a456-426614174000')).toEqual({ ok: false, error: 'noTarget' });
    expect(await checkActivationTarget(deps(), A)).toEqual({ ok: false, error: 'sameAccount', email: 'a@x.com' });
    store.setCustody(T, 'quarantined', A);
    expect(await checkActivationTarget(deps(), T)).toEqual({ ok: false, error: 'noTarget', email: 'x@x.com' });
    store.setCustody(T, 'foreign');
    expect(await checkActivationTarget(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    store.setCustody(T, 'app');
    store.setFamily(T, 'live');
    roster = { present: true, accounts: [{ email: 'x@x.com' }] };
    // A copy cswap may hold too: accepted while its access token is fresh, refused once it would need renewing (I3).
    expect(await checkActivationTarget(deps(), T)).toBeNull();
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 60_000));
    expect(await checkActivationTarget(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('recoverInterruptedActivation', () => {
  /** The state a crash right after writing the live identity leaves behind. */
  function crashedAfterLiveWrites() {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), 'live-credentials.json'), readFileSync(liveCreds(), 'utf8'));
    writeFileSync(join(backupDir(), 'live-claude.json'), readFileSync(liveJson(), 'utf8'));
    put(join(backupDir(), 'swap-journal.json'), { version: 2, phase: 'live-json-written', outgoingId: A, targetId: T, created: false, outCredsExisted: false, outJsonExisted: false, startedAt: NOW });
    put(join(store.dirOf(A), '.credentials.json'), creds('A'));
    put(liveCreds(), { ...creds('X'), mcpOAuth: { server: 'A' } });
    put(liveJson(), { oauthAccount: account('X', 'x@x.com'), projects: { p: 1 }, numStartups: 4 });
  }

  it('rolls an interrupted swap back when the live login is still exactly what it wrote', async () => {
    const before = readFileSync(liveCreds(), 'utf8');
    crashedAfterLiveWrites();
    expect(await recoverInterruptedActivation(deps())).toBe('recovered');
    expect(readFileSync(liveCreds(), 'utf8')).toBe(before);
    expect(json(liveJson()).oauthAccount).toEqual(account('A', 'a@x.com'));
    expect(existsSync(join(store.dirOf(A), '.credentials.json'))).toBe(false);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('changes nothing when Claude Code renewed the live login since (manual)', async () => {
    crashedAfterLiveWrites();
    put(liveCreds(), { claudeAiOauth: { accessToken: 'fake-acc-new', refreshToken: 'fake-ref-new', expiresAt: FUTURE } });
    const after = snapshot();
    expect(await recoverInterruptedActivation(deps())).toBe('manual');
    expect(snapshot()).toEqual(after);
    expect(existsSync(join(backupDir(), 'swap-journal.json'))).toBe(true);
  });

  it('leaves a 0.9.0 (version 1) journal to the legacy recovery', async () => {
    put(join(backupDir(), 'swap-journal.json'), { version: 1, accountId: T, phase: 'backed-up' });
    expect(await recoverInterruptedActivation(deps())).toBe('legacy');
  });

  it('deletes backups a crash left before the first journal, then defers to the legacy recovery', async () => {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), 'live-credentials.json'), readFileSync(liveCreds(), 'utf8'));
    writeFileSync(join(backupDir(), 'outgoing-claude.json'), '{}');
    writeFileSync(join(backupDir(), 'live-claude.json.123e4567-e89b-42d3-a456-426614174000.tmp'), '{}');
    writeFileSync(join(backupDir(), 'main-credentials.json'), '{}'); // a 0.9.0 backup is the legacy recovery's business
    expect(await recoverInterruptedActivation(deps())).toBe('legacy');
    expect(readdirSync(backupDir())).toEqual(['main-credentials.json']);
  });

  it('finishes the roles of a verified swap', async () => {
    put(join(backupDir(), 'swap-journal.json'), { version: 2, phase: 'verified', outgoingId: A, targetId: T, created: false, outCredsExisted: false, outJsonExisted: false, startedAt: NOW });
    put(liveJson(), { oauthAccount: account('X', 'x@x.com') });
    expect(await recoverInterruptedActivation(deps())).toBe('none');
    expect(store.get(T)?.custody).toBe('live');
    expect(store.get(A)?.custody).toBe('app');
    expect(store.live()?.recordId).toBe(T);
  });

  it('leaves the roles of a verified swap to reconcile when the target is no longer signed in', async () => {
    put(join(backupDir(), 'swap-journal.json'), { version: 2, phase: 'verified', outgoingId: A, targetId: T, created: false, outCredsExisted: false, outJsonExisted: false, startedAt: NOW });
    expect(await recoverInterruptedActivation(deps())).toBe('none'); // the live identity is still A
    expect(store.get(T)?.custody).toBe('app');
    expect(store.get(A)?.custody).toBe('live');
    expect(store.live()?.recordId).toBe(A);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('removes a record created for the outgoing account when the swap stopped right after the journal', async () => {
    const created = store.prepare().id;
    store.commit({ id: created, addedAt: 5, email: 'b@x.com', accountUuid: 'uuid-B', custody: 'live', family: 'live' });
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), 'live-credentials.json'), readFileSync(liveCreds(), 'utf8'));
    put(join(backupDir(), 'swap-journal.json'), { version: 2, phase: 'backed-up', outgoingId: created, targetId: T, created: true, outCredsExisted: false, outJsonExisted: false, startedAt: NOW });
    expect(await recoverInterruptedActivation(deps())).toBe('none');
    expect(store.get(created)).toBeUndefined();
    expect(existsSync(store.dirOf(created))).toBe(false);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('keeps an identity someone else wrote since (manual)', async () => {
    crashedAfterLiveWrites();
    put(liveJson(), { oauthAccount: account('Z', 'z@x.com') });
    const after = snapshot();
    expect(await recoverInterruptedActivation(deps())).toBe('manual');
    expect(snapshot()).toEqual(after);
    setSwapUnresolved(false);
  });

  it('keeps the journal while Claude Code holds its locks, never marks the swap unresolved, and blocks reconcile until it recovers', async () => {
    setSwapUnresolved(false);
    crashedAfterLiveWrites();
    mkdirSync(join(home, '.claude.lock'));
    expect(await recoverInterruptedActivation(deps())).toBe('locked');
    expect(isSwapUnresolved()).toBe(false);
    expect(isActivationRecoveryPending()).toBe(true);
    expect(existsSync(join(backupDir(), 'swap-journal.json'))).toBe(true);
    const reconcile = vi.fn(async () => undefined);
    const guard = { swapUnresolved: isSwapUnresolved, loginActive: () => false, journalPending: () => activationJournalPending(deps()) };
    expect(await reconcileWhenIdle(guard, reconcile)).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
    rmSync(join(home, '.claude.lock'), { recursive: true });
    expect(await recoverInterruptedActivation(deps())).toBe('recovered');
    expect(isActivationRecoveryPending()).toBe(false);
    expect(isSwapUnresolved()).toBe(false);
    expect(await reconcileWhenIdle(guard, reconcile)).toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('retries at start-up while the locks are busy', async () => {
    crashedAfterLiveWrites();
    const lock = join(home, '.claude.lock');
    mkdirSync(lock);
    const waits: number[] = [];
    const d: ActivateDeps = { ...deps(), delay: async (ms) => { waits.push(ms); rmSync(lock, { recursive: true }); } };
    expect(await recoverActivationWithRetry(d, 3, 1000)).toBe('recovered');
    expect(waits).toEqual([1000]);
    expect(isActivationRecoveryPending()).toBe(false);
  });

  it('starts no further start-up attempt once the app quits (0.9.6)', async () => {
    crashedAfterLiveWrites();
    const lock = join(home, '.claude.lock');
    mkdirSync(lock);
    let quitting = false;
    const waits: number[] = [];
    // The quit begins during the wait between two attempts; the lock is free by then, but no attempt may claim the slot.
    const d: ActivateDeps = { ...deps(), delay: async (ms) => { waits.push(ms); quitting = true; rmSync(lock, { recursive: true }); } };
    expect(await recoverActivationWithRetry(d, 3, 1000, () => quitting)).toBe('locked');
    expect(waits).toEqual([1000]);
    expect(await activationJournalPending(deps())).toBe(true); // the journal stays for the next start
  });

  it('stops a pending retry when the version-2 journal is gone, unparsable or not version 2 (D1)', async () => {
    for (const journal of [null, '{not json', JSON.stringify({ version: 1, accountId: T, phase: 'backed-up' })]) {
      crashedAfterLiveWrites();
      mkdirSync(join(home, '.claude.lock'));
      expect(await recoverInterruptedActivation(deps())).toBe('locked');
      expect(isActivationRecoveryPending()).toBe(true);
      rmSync(join(home, '.claude.lock'), { recursive: true });
      rmSync(backupDir(), { recursive: true, force: true });
      if (journal !== null) { mkdirSync(backupDir(), { recursive: true }); writeFileSync(join(backupDir(), 'swap-journal.json'), journal); }
      expect(await recoverInterruptedActivation(deps())).toBe('legacy');
      expect(isActivationRecoveryPending()).toBe(false);
      rmSync(backupDir(), { recursive: true, force: true });
    }
  });

  it('retries a locked recovery on its own timer, also without the usage polls (M3)', async () => {
    crashedAfterLiveWrites();
    mkdirSync(join(home, '.claude.lock'));
    expect(await recoverInterruptedActivation(deps())).toBe('locked');
    rmSync(join(home, '.claude.lock'), { recursive: true });
    let run: Promise<unknown> | undefined;
    const retry = vi.fn(() => (run = recoverInterruptedActivation(deps())));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stop = startActivationRecoveryRetry(retry, 30_000);
    try {
      vi.advanceTimersByTime(29_000);
      expect(retry).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(await run).toBe('recovered');
      expect(isActivationRecoveryPending()).toBe(false);
      vi.advanceTimersByTime(60_000); // nothing pending any more: no further tries
      expect(retry).toHaveBeenCalledTimes(1);
    } finally { stop(); vi.useRealTimers(); }
  });
});

describe('clearing the warning of an interrupted version-2 swap (M1)', () => {
  /** A crash between the live credentials write and the identity write, left unresolved (manual). */
  function crashedBetweenLiveWrites(phase = 'live-json-written') {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), 'live-credentials.json'), readFileSync(liveCreds(), 'utf8'));
    writeFileSync(join(backupDir(), 'live-claude.json'), readFileSync(liveJson(), 'utf8'));
    put(join(backupDir(), 'swap-journal.json'), { version: 2, phase, outgoingId: A, targetId: T, created: false, outCredsExisted: false, outJsonExisted: false, startedAt: NOW });
    put(join(store.dirOf(A), '.credentials.json'), creds('A'));
    put(join(store.dirOf(A), '.claude.json'), { oauthAccount: account('A', 'a@x.com') });
    put(liveCreds(), { ...creds('X'), mcpOAuth: { server: 'A' } }); // the target's tokens, A's identity still in .claude.json
  }
  const clear = () => clearPendingSwap({ backupDir: backupDir(), fs });
  const resync = (id: string, identity: AccountIdentity) => resyncActiveBackup({ paths: { credentials: liveCreds(), claudeJson: liveJson() }, store, delay: async () => undefined, locks: { timeoutMs: 300 } }, id, identity);

  it('marks the outgoing record switched out and never copies the live tokens into it afterwards', async () => {
    crashedBetweenLiveWrites();
    expect(await clearPendingActivation(deps(), clear)).toBe(true);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
    expect(store.get(A)?.custody).toBe('foreign');
    expect(store.get(A)?.heldTokens).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(store.list())).not.toContain('fake-');
    // The next poll: A is signed in by identity, so it holds the card again, but its saved copy is never overwritten.
    await reconcileLive({ store, readLiveIdentity: async () => ({ email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A' }), resync, now: () => NOW });
    expect(store.get(A)?.custody).toBe('live');
    expect(json(join(store.dirOf(A), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-A');
    // Neither does a swap away from A: its own copy stays, the live tokens are not saved under its name.
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(json(join(store.dirOf(A), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-A');
    expect(json(liveCreds()).claudeAiOauth.refreshToken).toBe('fake-ref-X');
  });

  it('holds nothing when the live tokens are the outgoing record\'s own, and leaves an earlier phase alone', async () => {
    crashedBetweenLiveWrites();
    put(liveCreds(), creds('A'));
    expect(await clearPendingActivation(deps(), clear)).toBe(true);
    expect(store.get(A)?.custody).toBe('foreign');
    expect(store.get(A)?.heldTokens).toBeUndefined();
    store.setCustody(A, 'live');
    crashedBetweenLiveWrites('outgoing-saved');
    expect(await clearPendingActivation(deps(), clear)).toBe(true);
    expect(store.get(A)).toMatchObject({ custody: 'live' });
    expect(store.get(A)?.heldTokens).toBeUndefined();
  });

  it('marks nothing when the clear itself fails', async () => {
    crashedBetweenLiveWrites();
    expect(await clearPendingActivation(deps(), async () => false)).toBe(false);
    expect(store.get(A)?.custody).toBe('live');
    expect(store.get(A)?.heldTokens).toBeUndefined();
  });
});

describe('an external switch after an app swap (investigation test 12)', () => {
  it('cswap writes its own copy of A into Claude Code: one card per account, the target is never POSTed', async () => {
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    // cswap's switch: a different token family of A plus A's identity.
    put(liveCreds(), { claudeAiOauth: { accessToken: 'fake-acc-cswap', refreshToken: 'fake-ref-cswap', expiresAt: FUTURE } });
    put(liveJson(), { oauthAccount: account('A', 'a@x.com') });
    await reconcileLive({ store, readLiveIdentity: async () => ({ email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A' }), now: () => NOW });
    expect(store.get(A)?.custody).toBe('live');
    expect(store.get(T)?.custody).toBe('foreign');
    const refs = claudeRefs({ records: store.list(), dirOf: (id) => store.dirOf(id), live: store.live(), cswap: roster, platform: 'win32' });
    expect(refs.map((r) => r.id)).toEqual([`claude:${A}`, `claude:${T}`]);
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW - 1000));
    const refreshClaude = vi.fn();
    const fetchDeps: FetcherDeps = {
      credentials: { env: {}, home, platform: 'win32', keychain: async () => null, readFile: (p) => Promise.resolve(existsSync(p) ? readFileSync(p, 'utf8') : null) },
      fetch: vi.fn() as never, now: () => NOW, sleep: async () => undefined, codexHome: () => join(home, '.codex'),
      claudeUrl: 'https://claude.test/usage', codexUrl: 'https://codex.test/usage', refreshClaude,
    };
    const { usage } = await fetchClaude(fetchDeps, refs[1]);
    expect(usage.status).toBe('elsewhere');
    expect(refreshClaude).not.toHaveBeenCalled();
  });
});
