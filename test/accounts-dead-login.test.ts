// 1.0.10: a main Claude login that Claude Code itself cleared as dead ("Login expired · Please run /login").
// Bug 1: its card said "the access token has expired - Claude Code will renew it" (or vanished) instead of "Sign-in expired".
// Bug 2: "Make main" on another saved account was refused with "There is no main Claude Code sign-in".
// Bug 3: after an outside switch the panel showed a banner and a long "switched out" text even for a dead login.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountIdentity } from '../src/shared/accounts';
import { activateAccount, recoverInterruptedActivation, type ActivateDeps } from '../src/main/accounts/activate';
import type { CswapRoster } from '../src/main/accounts/cswap';
import { isClearedLogin } from '../src/main/accounts/dead';
import { backupLiveBeforeLogin, reconcileLive, type ReconcileDeps } from '../src/main/accounts/reconcile';
import { claudeRefs, panelNotices } from '../src/main/accounts/refs';
import { resyncActiveBackup } from '../src/main/accounts/resync';
import { savedCopyDead } from '../src/main/accounts/dead';
import { AccountsStore } from '../src/main/accounts/store';
import { nodeSwapFs, type SwapFs } from '../src/main/accounts/swap';
import { fetchClaude, type FetcherDeps } from '../src/main/usage/fetchers';
import { cardState, makeMainOffered, summaryAccounts, type ProviderUsage } from '../src/shared/usage';

const NOW = Date.parse('2026-10-31T00:07:00Z');
const FUTURE = NOW + 3_600_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let root: string;
let home: string;
let store: AccountsStore;
let roster: CswapRoster;
let refresh: ActivateDeps['refresh'];
let fs: SwapFs;
let D: string; // Daniel: the main account whose login died
let S: string; // support: an app-held account the user wants to make main

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const put = (path: string, data: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); };
const liveCreds = () => join(home, '.claude', '.credentials.json');
const liveJson = () => join(home, '.claude.json');
const backupDir = () => join(root, 'accounts', 'swap-backup');
const creds = (n: string, expiresAt = FUTURE) => ({ claudeAiOauth: { accessToken: `fake-acc-${n}`, refreshToken: `fake-ref-${n}`, expiresAt, scopes: ['s'], subscriptionType: 'team', rateLimitTier: 'default_claude_max_5x' } });
/** Exactly what Claude Code writes after the token endpoint answers invalid_grant ("OAuth dead-token disk clear"). */
const cleared = () => ({ claudeAiOauth: { ...creds('D').claudeAiOauth, accessToken: '', refreshToken: '', expiresAt: 0 }, mcpOAuth: { server: 'm' } });
const account = (n: string, email: string) => ({ emailAddress: email, organizationName: `Org ${n}`, accountUuid: `uuid-${n}`, organizationUuid: `org-${n}` });
const deps = (): ActivateDeps => ({ home, env: {}, platform: 'win32', store, backupDir: backupDir(), now: () => NOW, refresh, delay: async () => undefined, cswap: async () => roster, fs, locks: { timeoutMs: 300 } });
const fetchDeps = (fetchSpy = vi.fn()): FetcherDeps => ({
  credentials: { env: {}, home, platform: 'win32', keychain: async () => null, readFile: (p) => Promise.resolve(existsSync(p) ? readFileSync(p, 'utf8') : null) },
  fetch: fetchSpy as never, now: () => NOW, sleep: async () => undefined, codexHome: () => join(home, '.codex'),
  claudeUrl: 'https://claude.test/usage', codexUrl: 'https://codex.test/usage', refreshClaude: vi.fn(async () => ({ kind: 'ok' as const })),
});
const refs = () => claudeRefs({ records: store.list(), dirOf: (id) => store.dirOf(id), live: store.live(), cswap: roster, platform: 'win32' });
const resync = (recordId: string, identity: AccountIdentity = { email: 'd@x.com', accountUuid: 'uuid-D', organizationUuid: 'org-D' }) =>
  resyncActiveBackup({ paths: { credentials: liveCreds(), claudeJson: liveJson() }, store, delay: async () => undefined, locks: { timeoutMs: 300 } }, recordId, identity);

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ajza-dead-')));
  home = join(root, 'home');
  store = new AccountsStore(join(root, 'accounts'));
  roster = { present: false };
  refresh = vi.fn(async () => ({ kind: 'ok' as const }));
  fs = nodeSwapFs;
  put(liveJson(), { oauthAccount: account('D', 'd@x.com'), projects: { p: 1 } });
  mkdirSync(join(home, '.claude'), { recursive: true }); // Claude Code's config dir stays when it drops the credentials file
  D = store.prepare().id;
  store.commit({ id: D, addedAt: 1, email: 'd@x.com', accountUuid: 'uuid-D', organizationUuid: 'org-D', custody: 'live', family: 'live' });
  // The app's backup of the live login, from before the login died (the same token family).
  put(join(store.dirOf(D), '.credentials.json'), creds('D', NOW - 24 * 3_600_000));
  put(join(store.dirOf(D), '.claude.json'), { oauthAccount: account('D', 'd@x.com') });
  S = store.prepare().id;
  store.commit({ id: S, addedAt: 2, email: 's@x.com', accountUuid: 'uuid-S', organizationUuid: 'org-S', custody: 'app', family: 'own' });
  put(join(store.dirOf(S), '.credentials.json'), creds('S'));
  put(join(store.dirOf(S), '.claude.json'), { oauthAccount: account('S', 's@x.com') });
  store.setLive({ email: 'd@x.com', accountUuid: 'uuid-D', organizationUuid: 'org-D', recordId: D });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('bug 1: the card of a main login Claude Code cleared as dead', () => {
  it('recognises Claude Code\'s dead-token clear and nothing else', () => {
    expect(isClearedLogin(cleared())).toBe(true);
    expect(isClearedLogin(creds('D'))).toBe(false);
    expect(isClearedLogin({ claudeAiOauth: { accessToken: 'a', refreshToken: '' } })).toBe(false);
    expect(isClearedLogin({})).toBe(false);
    expect(isClearedLogin(null)).toBe(false);
  });

  it('shows the live card as an expired sign-in (not signed out, not dormant) without any request', async () => {
    put(liveCreds(), cleared());
    const fetchSpy = vi.fn();
    const { usage } = await fetchClaude(fetchDeps(fetchSpy), refs()[0]);
    expect(usage).toMatchObject({ status: 'expired', error: 'login-dead', email: 'd@x.com', plan: 'Team 5x', active: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps calling an expired access token with a refresh token dormant (Claude Code has not given up on it)', async () => {
    put(liveCreds(), creds('D', NOW - 24 * 3_600_000));
    const { usage } = await fetchClaude(fetchDeps(), refs()[0]);
    expect(usage.status).toBe('dormant');
  });

  it('the backup of the live login is marked dead (by hash) once Claude Code cleared it, and a new sign-in ends the mark', async () => {
    put(liveCreds(), cleared());
    expect(await resync(D)).toBe('dead');
    expect(store.get(D)?.deadTokens).toBe(sha('fake-ref-D'));
    expect(JSON.stringify(store.list())).not.toContain('fake-');
    expect(await savedCopyDead(fs, store.dirOf(D), store.get(D))).toBe(true);
    // The copy itself is untouched (it is never deleted).
    expect(json(join(store.dirOf(D), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-D');
    // Signed in again: the live login holds new tokens, they are backed up and the mark is gone.
    put(liveCreds(), creds('D2'));
    expect(await resync(D)).toBe('copied');
    expect(store.get(D)?.deadTokens).toBeUndefined();
  });

  it('marks nothing for a cleared login of another identity, nor while tokens are held as not the record\'s own', async () => {
    put(liveCreds(), cleared());
    expect(await resync(D, { email: 'g@x.com', accountUuid: 'uuid-G', organizationUuid: 'org-G' })).toBe('mismatch');
    expect(store.get(D)?.deadTokens).toBeUndefined();
    store.setHeldTokens(D, sha('other'));
    expect(await resync(D)).toBe('dead');
    expect(store.get(D)?.deadTokens).toBeUndefined();
  });

  it('a main re-login is not blocked by the dead login (nothing left to back up)', async () => {
    put(liveCreds(), cleared());
    const rdeps: ReconcileDeps = { store, readLiveIdentity: async () => ({ email: 'd@x.com', accountUuid: 'uuid-D', organizationUuid: 'org-D' }), resync: (id, identity) => resync(id, identity), now: () => NOW };
    await expect(backupLiveBeforeLogin({ swapUnresolved: () => false }, rdeps, { delay: async () => undefined, tries: 1 })).resolves.toBeUndefined();
  });

  it('a saved card whose copy is marked dead shows an expired sign-in, never renewed nor sent anywhere', async () => {
    store.setCustody(D, 'foreign');
    store.setLive({ email: 's@x.com', accountUuid: 'uuid-S', organizationUuid: 'org-S', recordId: S });
    store.setCustody(S, 'live');
    store.setDeadTokens(D, sha('fake-ref-D'));
    const ref = refs().find((r) => r.id === `claude:${D}`)!;
    expect(ref.deadTokens).toBe(sha('fake-ref-D'));
    const fetchSpy = vi.fn();
    const f = fetchDeps(fetchSpy);
    const { usage } = await fetchClaude(f, ref);
    expect(usage).toMatchObject({ status: 'expired', error: 'login-dead', managed: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(f.refreshClaude).not.toHaveBeenCalled();
    expect(makeMainOffered(usage)).toBe(false);
  });
});

describe('bug 2: making another account main while the main login is dead or missing', () => {
  it('works when Claude Code cleared the main login: the target becomes main, the dead account keeps its copy marked dead', async () => {
    put(liveCreds(), cleared());
    const before = readFileSync(join(store.dirOf(D), '.credentials.json'), 'utf8');
    expect(await activateAccount(deps(), S)).toEqual({ ok: true, email: 's@x.com' });
    expect(json(liveCreds())).toEqual({ ...creds('S'), mcpOAuth: { server: 'm' } }); // other keys of the file stay
    expect(json(liveJson())).toEqual({ oauthAccount: account('S', 's@x.com'), projects: { p: 1 } });
    expect(readFileSync(join(store.dirOf(D), '.credentials.json'), 'utf8')).toBe(before); // nothing dead is copied over it
    expect(store.get(D)).toMatchObject({ custody: 'app', family: 'live', deadTokens: sha('fake-ref-D') });
    expect(store.get(S)).toMatchObject({ custody: 'live', family: 'live' });
    expect(store.live()?.recordId).toBe(S);
    expect(store.list()).toHaveLength(2);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('works when the credentials file is gone entirely; the account keeps its copy unmarked (no proof it is dead)', async () => {
    expect(existsSync(liveCreds())).toBe(false);
    expect(await activateAccount(deps(), S)).toEqual({ ok: true, email: 's@x.com' });
    expect(json(liveCreds())).toEqual(creds('S'));
    expect(json(liveJson()).oauthAccount).toEqual(account('S', 's@x.com'));
    expect(json(join(store.dirOf(D), '.credentials.json'))).toEqual(creds('D', NOW - 24 * 3_600_000));
    expect(store.get(D)).toMatchObject({ custody: 'app' });
    expect(store.get(D)?.deadTokens).toBeUndefined();
  });

  it('works with no account in the config either (signed out), creating no record', async () => {
    put(liveJson(), { projects: { p: 1 } });
    put(liveCreds(), cleared());
    expect((await activateAccount(deps(), S)).ok).toBe(true);
    expect(json(liveJson())).toEqual({ projects: { p: 1 }, oauthAccount: account('S', 's@x.com') });
    expect(store.list()).toHaveLength(2);
  });

  it('still saves an expired but renewable main login into its record (a valid token family is never lost)', async () => {
    put(liveCreds(), creds('D3', NOW - 24 * 3_600_000));
    expect((await activateAccount(deps(), S)).ok).toBe(true);
    expect(json(join(store.dirOf(D), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-D3');
    expect(store.get(D)?.deadTokens).toBeUndefined();
  });

  it('never overwrites a credentials file it cannot parse, and never creates Claude Code\'s config', async () => {
    put(liveCreds(), '{"claudeAiOauth": {"accessToken": "fake-half');
    expect(await activateAccount(deps(), S)).toEqual({ ok: false, error: 'noMain' });
    expect(readFileSync(liveCreds(), 'utf8')).toBe('{"claudeAiOauth": {"accessToken": "fake-half');
    rmSync(liveCreds());
    rmSync(liveJson());
    expect(await activateAccount(deps(), S)).toEqual({ ok: false, error: 'noMain' });
    expect(existsSync(liveCreds())).toBe(false);
  });

  it('refuses to make the dead account itself main (it is the main one) and a dead-marked copy, without a request', async () => {
    put(liveCreds(), cleared());
    expect(await activateAccount(deps(), D)).toMatchObject({ ok: false, error: 'sameAccount' });
    store.setDeadTokens(S, sha('fake-ref-S'));
    expect(await activateAccount(deps(), S)).toEqual({ ok: false, error: 'dead', email: 's@x.com' });
    expect(refresh).not.toHaveBeenCalled();
    expect(json(liveCreds())).toEqual(cleared());
  });

  it('rolls back cleanly when writing the config fails: the credentials file it created goes again', async () => {
    const renames: string[] = [];
    const failing: SwapFs = { ...nodeSwapFs, rename: async (from, to) => { renames.push(to); if (to === liveJson()) throw Object.assign(new Error('nope'), { code: 'EIO' }); return nodeSwapFs.rename(from, to); } };
    fs = failing;
    const jsonBefore = readFileSync(liveJson(), 'utf8');
    expect(await activateAccount(deps(), S)).toEqual({ ok: false, error: 'write' });
    expect(renames.some((to) => to === liveCreds())).toBe(true); // it got as far as writing the credentials
    expect(existsSync(liveCreds())).toBe(false);
    expect(readFileSync(liveJson(), 'utf8')).toBe(jsonBefore);
    expect(store.live()?.recordId).toBe(D);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('recovers a swap interrupted after it wrote the target into a machine that had no credentials file', async () => {
    const jsonBefore = readFileSync(liveJson(), 'utf8');
    put(join(backupDir(), 'live-claude.json'), jsonBefore);
    put(join(backupDir(), 'swap-journal.json'), { version: 2, phase: 'live-json-written', outgoingId: null, targetId: S, created: false, outCredsExisted: false, outJsonExisted: false, liveCredsExisted: false, startedAt: NOW });
    put(liveCreds(), creds('S'));
    put(liveJson(), { oauthAccount: account('S', 's@x.com'), projects: { p: 1 } });
    expect(await recoverInterruptedActivation(deps())).toBe('recovered');
    expect(existsSync(liveCreds())).toBe(false);
    expect(json(liveJson())).toEqual(JSON.parse(jsonBefore));
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });
});

describe('bug 3: an outside switch away from the account', () => {
  const G = { email: 'g@x.com', accountUuid: 'uuid-G', organizationUuid: 'org-G' };
  const rdeps = (live: typeof G | null): ReconcileDeps => ({
    store, readLiveIdentity: async () => live, now: () => NOW,
    savedCopyDead: (record) => savedCopyDead(fs, store.dirOf(record.id), record),
  });

  it('a dead login that was switched out: no banner, its card says "Sign-in expired"', async () => {
    store.setDeadTokens(D, sha('fake-ref-D'));
    await reconcileLive(rdeps(G));
    expect(store.notices().filter((n) => n.recordId === D)).toEqual([]);
    const ref = refs().find((r) => r.id === `claude:${D}`)!;
    const { usage } = await fetchClaude(fetchDeps(), ref);
    expect(usage).toMatchObject({ status: 'expired', error: 'login-dead' });
  });

  it('a dead login signed out: no banner either', async () => {
    store.setDeadTokens(D, sha('fake-ref-D'));
    await reconcileLive(rdeps(null));
    expect(store.notices()).toEqual([]);
  });

  it('a valid login switched out: no banner, the card keeps a short note (switched-out), its copy is kept', async () => {
    put(join(store.dirOf(D), '.credentials.json'), creds('D'));
    await reconcileLive(rdeps(G));
    expect(store.notices().filter((n) => n.recordId === D)).toEqual([]);
    expect(store.get(D)?.custody).toBe('foreign');
    const ref = refs().find((r) => r.id === `claude:${D}`)!;
    expect(ref.renew).toBe('switched-out');
  });

  it('hides switch-out banners stored by older versions', () => {
    const notices = [
      { id: '1', kind: 'switchedOut' as const, at: 1, email: 'd@x.com' },
      { id: '2', kind: 'adopted' as const, at: 2, email: 'g@x.com' },
    ];
    expect(panelNotices(notices).map((n) => n.id)).toEqual(['2']);
  });
});

describe('one card state per situation (the user: "the same case must look the same")', () => {
  const windows = [{ id: '7d' as const, usedPercent: 96, resetsAt: Math.floor(NOW / 1000) + 3600 }];
  /** The card a real read produces for a saved record in the given situation. */
  const read = async (setup: () => void, refreshOutcome: 'ok' | 'dead' = 'ok'): Promise<ProviderUsage> => {
    setup();
    const f = fetchDeps(vi.fn(async () => new Response('{}', { status: 401 })));
    f.refreshClaude = vi.fn(async () => ({ kind: refreshOutcome }));
    const ref = refs().find((r) => r.id === `claude:${D}`) ?? refs()[0];
    // The service keeps the last numbers of an account whose read failed: they must not make an expired card look current.
    return { ...(await fetchClaude(f, ref)).usage, windows, source: 'cache' };
  };
  const switchedAway = () => {
    store.setLive({ email: 's@x.com', accountUuid: 'uuid-S', organizationUuid: 'org-S', recordId: S });
    store.setCustody(S, 'live');
  };

  it('maps every "only a new sign-in helps" reason onto the same expired state, with the same action', async () => {
    const cases: Record<string, ProviderUsage> = {
      // APP_ChatGPT: the app's own copy, the token endpoint rejected its renewal.
      renewalRejected: await read(() => { switchedAway(); store.setCustody(D, 'app'); store.setFamily(D, 'own'); }, 'dead'),
      // Daniel while main: Claude Code cleared the live login ("Login expired").
      deadMainLogin: await read(() => { put(liveCreds(), cleared()); }),
      // Daniel after the switch: the copy is marked dead.
      deadCopy: await read(() => { switchedAway(); store.setCustody(D, 'foreign'); store.setDeadTokens(D, sha('fake-ref-D')); }),
      // Daniel after a cswap switch the app did not see die: the copy may be outdated and its access token ran out.
      switchedOutOutdated: await read(() => { switchedAway(); store.setCustody(D, 'foreign'); }),
      // A copy cswap also holds whose access token ran out.
      cswapCopyOutdated: await read(() => { switchedAway(); store.setCustody(D, 'app'); roster = { present: true, accounts: [{ email: 'd@x.com', accountUuid: 'uuid-D' }] }; }),
    };
    for (const [why, usage] of Object.entries(cases)) {
      expect({ why, state: cardState(usage) }).toEqual({ why, state: 'expired' });
      expect({ why, offered: makeMainOffered(usage) }).toEqual({ why, offered: false });
    }
    // Old numbers of an expired card never count as current limits (summary, rail, collapsed panel).
    expect(summaryAccounts(Object.values(cases))).toEqual([]);
  });

  it('keeps the other states apart: current, stale, unavailable', () => {
    const base: ProviderUsage = { accountId: 'claude:x', provider: 'claude', status: 'ok', windows, fetchedAt: NOW, source: 'live' };
    const state = (usage: ProviderUsage) => cardState(usage);
    expect(state(base)).toBe('ok');
    expect(state({ ...base, source: 'cache' })).toBe('stale');
    expect(state({ ...base, status: 'dormant', source: 'cache' })).toBe('stale');
    expect(state({ ...base, status: 'error', error: 'http-429' })).toBe('stale');
    expect(state({ ...base, status: 'elsewhere', heldBy: 'live', source: 'cache' })).toBe('stale');
    expect(state({ ...base, status: 'error', windows: [] })).toBe('unavailable');
    expect(state({ ...base, status: 'forbidden', windows: [] })).toBe('unavailable');
    expect(state({ ...base, provider: 'codex', status: 'apiKey', windows: [] })).toBe('apiKey');
  });
});
