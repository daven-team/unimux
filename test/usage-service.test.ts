// test/usage-service.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchResult } from '../src/main/usage/fetchers';
import { EAGER_GUARD_MS, MIN_GAP_MS, MIN_IDENTITY_GAP_MS, RETRY_AFTER_MARGIN_MS, UsageService } from '../src/main/usage/service';
import { MAIN_ACCOUNTS, type AccountRef, type ProviderUsage, type UsageProvider } from '../src/shared/usage';

/** Spacing and Retry-After margin off: these tests check other rules. */
const LEGACY = { minIdentityGapMs: 0, retryAfterMarginMs: 0 };
const NOW = Date.parse('2026-10-11T12:00:00Z');
const ok = (provider: UsageProvider, percent: number, accountId = `${provider}:main`): FetchResult => ({
  usage: { accountId, provider, status: 'ok', plan: 'Max 5x', fetchedAt: Date.now(), source: 'live', windows: [{ id: '5h', usedPercent: percent, resetsAt: Math.floor(Date.now() / 1000) + 3600 }] },
});
const failing = (provider: UsageProvider, status: 'error' | 'expired', retryAfterMs?: number, accountId = `${provider}:main`): FetchResult => ({
  usage: { accountId, provider, status, fetchedAt: Date.now(), source: 'live', windows: [], ...(status === 'error' ? { error: 'http-500' } : {}) }, retryAfterMs,
});

let dir: string;
let cacheFile: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); dir = mkdtempSync(join(tmpdir(), 'ajza-usage-')); cacheFile = join(dir, 'usage-cache.json'); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function make(overrides: { claude?: () => Promise<FetchResult>; codex?: () => Promise<FetchResult>; enabled?: () => boolean; intervalMs?: () => number; accounts?: () => AccountRef[]; fetchAccount?: (ref: AccountRef) => Promise<FetchResult> } = {}) {
  const claude = vi.fn(overrides.claude ?? (async () => ok('claude', 40)));
  const codex = vi.fn(overrides.codex ?? (async () => ok('codex', 8)));
  const fetchAccount = vi.fn(overrides.fetchAccount ?? ((ref: AccountRef) => (ref.id === 'codex:main' ? codex() : claude())));
  const service = new UsageService({ ...LEGACY, accounts: overrides.accounts ?? (() => MAIN_ACCOUNTS), fetchAccount, cacheFile, enabled: overrides.enabled ?? (() => true), intervalMs: overrides.intervalMs ?? (() => 300_000) });
  return { service, claude, codex, fetchAccount };
}

describe('UsageService', () => {
  it('reads both providers at start, orders them and tells listeners', async () => {
    const { service, claude, codex } = make();
    const heard: ProviderUsage[][] = [];
    service.onChange((state) => heard.push(state.providers));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledOnce();
    expect(codex).toHaveBeenCalledOnce();
    expect(service.getState().providers.map((p) => [p.provider, p.windows[0].usedPercent])).toEqual([['claude', 40], ['codex', 8]]);
    expect(heard).toHaveLength(1);
    service.stop();
  });

  it('polls at the configured interval and stops when asked', async () => {
    const { service, claude } = make({ intervalMs: () => 60_000 });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claude).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claude).toHaveBeenCalledTimes(3);
    service.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(claude).toHaveBeenCalledTimes(3);
  });

  it('does nothing while disabled and resumes when enabled again', async () => {
    let enabled = false;
    const { service, claude } = make({ enabled: () => enabled });
    service.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(claude).not.toHaveBeenCalled();
    enabled = true;
    service.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledOnce();
    service.stop();
  });

  it('refreshes at most once per minimum gap and shares a request in flight', async () => {
    let release!: (value: FetchResult) => void;
    const { service, claude } = make({ claude: () => new Promise<FetchResult>((resolve) => { release = resolve; }) });
    const first = service.refresh();
    const second = service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    release(ok('claude', 10));
    await Promise.all([first, second]);
    await service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    claude.mockImplementation(async () => ok('claude', 11));
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it('chains exactly one forced follow-up run after a run in flight', async () => {
    const releases: Array<(value: FetchResult) => void> = [];
    const { service, claude } = make({ claude: () => new Promise<FetchResult>((resolve) => { releases.push(resolve); }) });
    const first = service.refresh();
    const forcedA = service.refresh(true, true);
    const forcedB = service.refresh(true, true);
    expect(claude).toHaveBeenCalledOnce();
    releases[0](ok('claude', 10));
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledTimes(2);
    releases[1](ok('claude', 20));
    await Promise.all([forcedA, forcedB]);
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it('keeps the last numbers when a read fails and backs off exponentially', async () => {
    let step = 0;
    const { service, claude } = make({ claude: async () => (step++ === 0 ? ok('claude', 55) : failing('claude', 'error')) });
    await service.refresh();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    const kept = service.getState().providers[0];
    expect(kept).toMatchObject({ status: 'error', error: 'http-500', source: 'cache' });
    expect(kept.windows[0].usedPercent).toBe(55);
    expect(claude).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After and clears the backoff after a success', async () => {
    let mode: 'limited' | 'fine' = 'limited';
    const { service, claude } = make({ claude: async () => (mode === 'limited' ? failing('claude', 'error', 300_000) : ok('claude', 20)) });
    await service.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    await service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    mode = 'fine';
    await vi.advanceTimersByTimeAsync(181_000);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(2);
    expect(service.getState().providers[0].status).toBe('ok');
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(3);
  });

  it('keeps the last good numbers on a 429 and tells the card when it tries again', async () => {
    let mode: 'fine' | 'limited' = 'fine';
    const { service } = make({ claude: async () => (mode === 'fine' ? ok('claude', 100) : { ...failing('claude', 'error', 600_000), usage: { ...failing('claude', 'error').usage, error: 'http-429' } }) });
    await service.refresh();
    const good = service.getState().providers[0];
    mode = 'limited';
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh(true);
    const held = service.getState().providers[0];
    expect(held).toMatchObject({ status: 'error', error: 'http-429', source: 'cache', fetchedAt: good.fetchedAt, windows: good.windows });
    expect(held.attemptAt).toBe(Date.now());
    expect(held.retryAt).toBe(Date.now() + 600_000);
  });

  it('does not keep an old failure when the numbers come back from the cache file after a restart', async () => {
    const failed = { ...ok('claude', 100).usage, status: 'error' as const, error: 'http-429', attemptAt: NOW, retryAt: NOW + 1000 };
    writeFileSync(cacheFile, JSON.stringify({ providers: [failed] }));
    const { service } = make();
    const [loaded] = service.getState().providers;
    expect(loaded).toMatchObject({ status: 'ok', source: 'cache' });
    expect(loaded.error).toBeUndefined();
    expect(loaded.retryAt).toBeUndefined();
    expect(loaded.attemptAt).toBeUndefined();
  });

  it('keeps the numbers of an expired login and does not hammer the provider', async () => {
    let step = 0;
    const { service } = make({ codex: async () => (step++ === 0 ? ok('codex', 33) : failing('codex', 'expired')) });
    await service.refresh();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'expired', source: 'cache' });
    expect(service.getState().providers[1].windows[0].usedPercent).toBe(33);
  });

  it('survives a fetcher that throws', async () => {
    const { service } = make({ claude: async () => { throw new Error('unexpected'); } });
    await service.refresh();
    expect(service.getState().providers[0]).toMatchObject({ accountId: 'claude:main', provider: 'claude', status: 'error', error: 'network' });
  });

  it('remembers the last good result on disk and shows it as cached after a restart', async () => {
    const first = make();
    await first.service.refresh();
    expect(existsSync(cacheFile)).toBe(true);
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('SECRET-123');
    const second = make({ claude: () => new Promise<FetchResult>(() => undefined) });
    expect(second.service.getState().providers.map((p) => [p.provider, p.source, p.status])).toEqual([['claude', 'cache', 'ok'], ['codex', 'cache', 'ok']]);
  });

  it('never lets unknown fields from a fetcher reach state, listeners or the cache file', async () => {
    const rogue = async (): Promise<FetchResult> => ({ usage: { ...ok('claude', 40).usage, accessToken: 'SECRET-123' } as ProviderUsage });
    const { service } = make({ claude: rogue });
    const heard: string[] = [];
    service.onChange((state) => heard.push(JSON.stringify(state)));
    await service.refresh();
    expect(JSON.stringify(service.getState())).not.toContain('SECRET-123');
    expect(heard.join('')).not.toContain('SECRET-123');
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('SECRET-123');
    expect(service.getState().providers[0].windows[0].usedPercent).toBe(40);
  });

  it('loads a cache with garbage window entries and keeps only the valid ones', () => {
    writeFileSync(cacheFile, JSON.stringify({ providers: [
      null, 'x', { accountId: 'claude:main', provider: 'claude', status: 'error', source: 'live', fetchedAt: 5, token: 'SECRET-123', windows: [null, 7, { id: '5h', usedPercent: 'a', resetsAt: 1 }, { id: '9h', usedPercent: 1, resetsAt: 1 }, { id: '7d', usedPercent: 250, resetsAt: 10 }] },
      { accountId: 'codex:main', provider: 'codex', status: 'ok', source: 'live', fetchedAt: 5, windows: [null] },
    ] }));
    const providers = make().service.getState().providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ provider: 'claude', status: 'ok', source: 'cache', windows: [{ id: '7d', usedPercent: 100, resetsAt: 10 }] });
    expect(JSON.stringify(providers)).not.toContain('SECRET-123');
  });

  it('backs off after a failed read even when another source answered, and clears it on success', async () => {
    let mode: 'failed' | 'fine' = 'failed';
    const { service, codex } = make({ codex: async () => (mode === 'failed' ? { ...ok('codex', 30), usage: { ...ok('codex', 30).usage, source: 'log' as const }, failed: true as const, retryAfterMs: 300_000 } : ok('codex', 31)) });
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'ok', source: 'log' });
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(codex).toHaveBeenCalledOnce();
    mode = 'fine';
    await vi.advanceTimersByTimeAsync(300_000);
    await service.refresh();
    expect(codex).toHaveBeenCalledTimes(2);
    expect(service.getState().providers[1]).toMatchObject({ status: 'ok', source: 'live' });
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(codex).toHaveBeenCalledTimes(3);
  });

  it('lets a manual refresh bypass a backoff but not the minimum gap', async () => {
    const { service, claude } = make({ claude: async () => failing('claude', 'error', 600_000) });
    await service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    await service.refresh(true);
    expect(claude).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh(true);
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it('replaces the entry when a login disappears and refreshes numbers when an expired login returns', async () => {
    let mode: 'ok' | 'out' | 'expired' | 'back' = 'ok';
    const out = (provider: UsageProvider): FetchResult => ({ usage: { accountId: `${provider}:main`, provider, status: 'signedOut', windows: [], fetchedAt: Date.now(), source: 'live' } });
    const { service } = make({ claude: async () => (mode === 'out' ? out('claude') : ok('claude', 40)), codex: async () => (mode === 'expired' ? failing('codex', 'expired') : mode === 'back' ? ok('codex', 12) : ok('codex', 8)) });
    await service.refresh();
    mode = 'out';
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[0]).toMatchObject({ status: 'signedOut', windows: [] });
    mode = 'expired';
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'expired', source: 'cache' });
    mode = 'back';
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'ok', source: 'live' });
    expect(service.getState().providers[1].windows[0].usedPercent).toBe(12);
  });

  it('stores an expired result that carries its own log windows as given and starts no backoff', async () => {
    let step = 0;
    const logWindows = [{ id: '5h' as const, usedPercent: 21, resetsAt: 1781010642 }];
    const { service, codex } = make({ codex: async () => (step++ === 0 ? ok('codex', 77) : { usage: { accountId: 'codex:main', provider: 'codex', status: 'expired', fetchedAt: 5, source: 'log', windows: logWindows } }) });
    await service.refresh();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'expired', source: 'log', fetchedAt: 5, windows: logWindows });
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(codex).toHaveBeenCalledTimes(3);
  });

  it('ignores a corrupt cache file', () => {
    writeFileSync(cacheFile, '{broken');
    expect(make().service.getState().providers).toEqual([]);
  });

  it('pauses while inactive and catches up when active again with stale data', async () => {
    const { service, claude } = make({ intervalMs: () => 60_000 });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.setActive(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(claude).toHaveBeenCalledOnce();
    service.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledTimes(2);
    service.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('applies a new interval after rescheduling', async () => {
    let interval = 600_000;
    const { service, claude } = make({ intervalMs: () => interval });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    interval = 60_000;
    service.reschedule();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(claude).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('gives up on a read that never settles and keeps polling', async () => {
    let hang = true;
    const { service, claude } = make({ intervalMs: () => 60_000, claude: () => (hang ? new Promise<FetchResult>(() => undefined) : Promise.resolve(ok('claude', 12))) });
    service.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.getState().providers[0]).toMatchObject({ provider: 'claude', status: 'error', error: 'timeout' });
    hang = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(claude).toHaveBeenCalledTimes(2);
    expect(service.getState().providers[0].status).toBe('ok');
    service.stop();
  });

  it('is not disturbed by a listener that throws', async () => {
    const { service } = make();
    const heard: number[] = [];
    service.onChange(() => { throw new Error('bad listener'); });
    service.onChange((state) => heard.push(state.providers.length));
    await expect(service.refresh()).resolves.toBeDefined();
    expect(heard).toEqual([2]);
  });
  describe('accounts', () => {
    const extra: AccountRef = { id: 'claude:abc', provider: 'claude', configDir: '/profiles/abc' };

    it('polls every listed account and returns them in accounts() order', async () => {
      const list = [extra, ...MAIN_ACCOUNTS];
      const { service, fetchAccount } = make({ accounts: () => list, fetchAccount: async (ref) => ok(ref.provider, ref.id === 'claude:abc' ? 71 : 5, ref.id) });
      await service.refresh();
      expect(fetchAccount).toHaveBeenCalledTimes(3);
      expect(service.getState().providers.map((p) => [p.accountId, p.windows[0].usedPercent])).toEqual([['claude:abc', 71], ['claude:main', 5], ['codex:main', 5]]);
    });

    it('drops a removed account from state, the next cache write and a result still in flight', async () => {
      let list: AccountRef[] = [...MAIN_ACCOUNTS, extra];
      let release!: (value: FetchResult) => void;
      const slow = new Promise<FetchResult>((resolve) => { release = resolve; });
      let first = true;
      const { service } = make({ accounts: () => list, fetchAccount: (ref) => (ref.id === 'claude:abc' && !first ? slow : Promise.resolve(ok(ref.provider, 9, ref.id))) });
      await service.refresh();
      expect(service.getState().providers).toHaveLength(3);
      expect(readFileSync(cacheFile, 'utf8')).toContain('claude:abc');
      first = false;
      await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
      const run = service.refresh();
      list = MAIN_ACCOUNTS;
      expect(service.getState().providers.map((p) => p.accountId)).toEqual(['claude:main', 'codex:main']);
      release(ok('claude', 99, 'claude:abc'));
      await run;
      expect(service.getState().providers.map((p) => p.accountId)).toEqual(['claude:main', 'codex:main']);
      expect(readFileSync(cacheFile, 'utf8')).not.toContain('claude:abc');
    });

    it('shows a newly added account after the next refresh', async () => {
      let list: AccountRef[] = MAIN_ACCOUNTS;
      const { service } = make({ accounts: () => list, fetchAccount: async (ref) => ok(ref.provider, 9, ref.id) });
      await service.refresh();
      list = [...MAIN_ACCOUNTS, extra];
      expect(service.getState().providers).toHaveLength(2);
      await service.refresh(false, true);
      expect(service.getState().providers.map((p) => p.accountId)).toEqual(['claude:main', 'codex:main', 'claude:abc']);
    });

    it('ignores the minimum gap only when forced, and shares one follow-up run for forced callers during a run', async () => {
      const { service, claude } = make();
      await service.refresh();
      await service.refresh();
      expect(claude).toHaveBeenCalledOnce();
      await service.refresh(false, true);
      expect(claude).toHaveBeenCalledTimes(2);
      let release!: (value: FetchResult) => void;
      claude.mockImplementation(() => new Promise<FetchResult>((resolve) => { release = resolve; }));
      const a = service.refresh(false, true);
      const b = service.refresh(false, true);
      expect(claude).toHaveBeenCalledTimes(3);
      release(ok('claude', 1));
      await a;
      await vi.advanceTimersByTimeAsync(0);
      expect(claude).toHaveBeenCalledTimes(4);
      release(ok('claude', 2));
      await b;
    });

    it('backs off per account id', async () => {
      const { service, fetchAccount } = make({ accounts: () => [extra, ...MAIN_ACCOUNTS], fetchAccount: async (ref) => (ref.id === 'claude:abc' ? failing('claude', 'error', 600_000, ref.id) : ok(ref.provider, 9, ref.id)) });
      await service.refresh();
      await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
      await service.refresh();
      const calls = (id: string) => fetchAccount.mock.calls.filter(([ref]) => ref.id === id).length;
      expect(calls('claude:abc')).toBe(1);
      expect(calls('claude:main')).toBe(2);
      expect(calls('codex:main')).toBe(2);
    });

    it('ignores cache entries from an older file without an account id', () => {
      writeFileSync(cacheFile, JSON.stringify({ providers: [{ provider: 'claude', status: 'ok', source: 'live', fetchedAt: 5, windows: [{ id: '5h', usedPercent: 3, resetsAt: 10 }] }] }));
      expect(make().service.getState().providers).toEqual([]);
    });
  });

  describe('dormant main login', () => {
    const dormant = (): FetchResult => ({ usage: { accountId: 'claude:main', provider: 'claude', status: 'dormant', plan: 'Max 5x', fetchedAt: Date.now(), source: 'live', windows: [] } });

    it('keeps the last windows with their age and starts no backoff', async () => {
      let step = 0;
      const { service, claude } = make({ claude: async () => (step++ === 0 ? ok('claude', 40) : dormant()) });
      await service.refresh();
      const firstAt = service.getState().providers[0].fetchedAt;
      await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
      await service.refresh();
      expect(service.getState().providers[0]).toMatchObject({ status: 'dormant', source: 'cache', fetchedAt: firstAt, windows: [{ id: '5h', usedPercent: 40 }] });
      await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
      await service.refresh();
      expect(claude).toHaveBeenCalledTimes(3);
    });

    it('refreshes at once when the credentials file changes, polling only while dormant', async () => {
      let stamp: string | null = 'a';
      let renewed = false;
      const credentialsStamp = vi.fn(async () => stamp);
      const claude = vi.fn(async () => (renewed ? ok('claude', 12) : dormant()));
      const service = new UsageService({ ...LEGACY, accounts: () => [MAIN_ACCOUNTS[0]], fetchAccount: claude, cacheFile, enabled: () => true, intervalMs: () => 3_600_000, credentialsStamp, watchMs: 20_000 });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getState().providers[0].status).toBe('dormant');
      const stats = credentialsStamp.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(claude).toHaveBeenCalledTimes(1); // unchanged file: no read
      expect(credentialsStamp.mock.calls.length).toBeGreaterThan(stats);
      stamp = 'b'; renewed = true;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(claude).toHaveBeenCalledTimes(2);
      expect(service.getState().providers[0]).toMatchObject({ status: 'ok', source: 'live' });
      const after = credentialsStamp.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(credentialsStamp.mock.calls.length).toBe(after); // no longer dormant: watching stopped
      service.stop();
    });
  });

  it('runs beforeRun before every poll and survives it throwing', async () => {
    const order: string[] = [];
    const beforeRun = vi.fn(async () => { order.push('before'); if (order.length > 2) throw new Error('x'); });
    const service = new UsageService({ ...LEGACY, accounts: () => [MAIN_ACCOUNTS[0]], fetchAccount: async () => { order.push('fetch'); return ok('claude', 1); }, cacheFile, enabled: () => true, intervalMs: () => 0, beforeRun });
    await service.refresh(true, true);
    await service.refresh(true, true);
    expect(order).toEqual(['before', 'fetch', 'before', 'fetch']);
  });

  it('watchLive: a changed live credentials file triggers a poll even when the login is fine', async () => {
    let stamp = 'a';
    const claude = vi.fn(async () => ok('claude', 10));
    const service = new UsageService({ ...LEGACY, accounts: () => [MAIN_ACCOUNTS[0]], fetchAccount: claude, cacheFile, enabled: () => true, intervalMs: () => 3_600_000, credentialsStamp: async () => stamp, watchMs: 20_000, watchLive: true });
    service.start();
    await vi.advanceTimersByTimeAsync(100);
    const calls = claude.mock.calls.length;
    stamp = 'b';
    await vi.advanceTimersByTimeAsync(25_000);
    expect(claude.mock.calls.length).toBe(calls + 1);
    service.stop();
  });
});

describe('a held account across a restart', () => {
  const SAVED: AccountRef = { id: 'claude:abc', provider: 'claude', configDir: '/tmp/ajza-profile' };
  const limited = (): FetchResult => ({ usage: { accountId: SAVED.id, provider: 'claude', status: 'error', fetchedAt: Date.now(), source: 'live', windows: [], managed: true, error: 'refresh-http-429' }, retryAfterMs: 900_000 });
  const build = (fetchAccount: () => Promise<FetchResult>) => new UsageService({ ...LEGACY, accounts: () => [SAVED], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 60_000 });

  it('does not try again right after a restart and shows the same calm card until the window passes', async () => {
    const first = vi.fn(async () => limited());
    const before = build(first);
    await before.refresh();
    expect(first).toHaveBeenCalledOnce();
    expect(before.getState().providers[0]).toMatchObject({ status: 'error', error: 'refresh-http-429', retryAt: NOW + 900_000 });
    const stored = JSON.parse(readFileSync(cacheFile, 'utf8')) as { backoff: Record<string, unknown> };
    expect(stored.backoff[SAVED.id]).toMatchObject({ until: NOW + 900_000, failures: 1, error: 'refresh-http-429', attemptAt: NOW });

    await vi.advanceTimersByTimeAsync(120_000);
    const second = vi.fn(async () => ok('claude', 10, SAVED.id));
    const after = build(second);
    after.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(second).not.toHaveBeenCalled();
    expect(after.getState().providers[0]).toMatchObject({ accountId: SAVED.id, status: 'error', error: 'refresh-http-429', managed: true, retryAt: NOW + 900_000, attemptAt: NOW });

    await vi.advanceTimersByTimeAsync(900_000);
    expect(second).toHaveBeenCalled();
    expect(after.getState().providers[0]).toMatchObject({ status: 'ok' });
    after.stop();
  });

  it('keeps the last numbers on the restored card and ignores damaged or finished backoff entries', async () => {
    writeFileSync(cacheFile, JSON.stringify({
      providers: [{ accountId: SAVED.id, provider: 'claude', status: 'ok', windows: [{ id: '7d', usedPercent: 100, resetsAt: 1 }], fetchedAt: NOW - 600_000, source: 'live' }],
      backoff: { [SAVED.id]: { until: NOW + 60_000, failures: 2, error: 'refresh-http-429', attemptAt: NOW - 1000 }, old: { until: NOW - 1, failures: 1 }, bad: { until: 'x', failures: 1 }, evil: { until: NOW + 5, failures: 1, error: '<script>' } },
    }));
    const fetchAccount = vi.fn(async () => ok('claude', 1, SAVED.id));
    const service = build(fetchAccount);
    await service.refresh();
    expect(fetchAccount).not.toHaveBeenCalled();
    expect(service.getState().providers[0]).toMatchObject({ status: 'error', error: 'refresh-http-429', source: 'cache', windows: [{ id: '7d', usedPercent: 100 }] });
  });
});

describe('usage keyed by account identity (W1)', () => {
  const refA: AccountRef = { id: 'claude:main', provider: 'claude', key: 'uuid:A:-', active: true };
  const refG: AccountRef = { id: 'claude:main', provider: 'claude', key: 'uuid:G:-', active: true };
  const limited = (accountId: string): FetchResult => ({ usage: { accountId, provider: 'claude', status: 'error', fetchedAt: Date.now(), source: 'live', windows: [], error: 'http-429' }, retryAfterMs: 46 * 60_000 });

  it("never shows the previous account's numbers or backoff on the main card after a switch (investigation test 7)", async () => {
    let listed: AccountRef[] = [refA];
    const fetchAccount = vi.fn(async (ref: AccountRef) => (ref.key === 'uuid:A:-' ? ok('claude', 40, ref.id) : failing('claude', 'error', undefined, ref.id)));
    const service = new UsageService({ accounts: () => listed, fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    expect(service.getState().providers[0].windows[0].usedPercent).toBe(40);
    // cswap switched the live login to G; A is now a saved card of its own.
    listed = [refG, { id: 'claude:a', provider: 'claude', key: 'uuid:A:-', configDir: '/a' }];
    await service.refresh(true, true);
    const [main, saved] = service.getState().providers;
    expect(main).toMatchObject({ accountId: 'claude:main', status: 'error', windows: [] });
    expect(saved).toMatchObject({ accountId: 'claude:a', windows: [{ usedPercent: 40 }] });
    expect(saved.active).toBeUndefined();
    const again = new UsageService({ accounts: () => [refA], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    expect(again.getState().providers[0]).toMatchObject({ source: 'cache', windows: [{ usedPercent: 40 }] });
    const other = new UsageService({ accounts: () => [refG], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    expect(other.getState().providers[0]?.windows ?? []).toEqual([]);
  });

  it('reads one account at most every 3 minutes, also when forced, unless the action was about it (investigation test 8)', async () => {
    const fetchAccount = vi.fn(async () => ok('claude', 10));
    const service = new UsageService({ accounts: () => [refA], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    vi.advanceTimersByTime(60_000);
    await service.refresh(true, true);
    expect(fetchAccount).toHaveBeenCalledTimes(1);
    await service.refresh(true, true, 'claude:main');
    expect(fetchAccount).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(MIN_IDENTITY_GAP_MS);
    await service.refresh(true, true);
    expect(fetchAccount).toHaveBeenCalledTimes(3);
  });

  it('keeps a short read guard across a restart (1.1.1: the start read ignores older reads, see usage-restart.test.ts)', async () => {
    const fetchAccount = vi.fn(async () => ok('claude', 10));
    await new UsageService({ accounts: () => [refA], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 }).refresh(true, true);
    vi.advanceTimersByTime(EAGER_GUARD_MS - 1_000);
    await new UsageService({ accounts: () => [refA], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 }).refresh(true, true);
    expect(fetchAccount).toHaveBeenCalledTimes(1);
  });

  it('never bypasses a 429 hold of an unrelated account and adds a margin to Retry-After', async () => {
    const saved: AccountRef = { id: 'claude:abc', provider: 'claude', key: 'uuid:B:-', configDir: '/p' };
    const fetchAccount = vi.fn(async (ref: AccountRef) => (ref.key === 'uuid:B:-' ? limited('claude:abc') : ok('claude', 10)));
    const service = new UsageService({ accounts: () => [refA, saved], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0, minIdentityGapMs: 0 });
    await service.refresh(true, true);
    expect(service.getState().providers.find((p) => p.accountId === 'claude:abc')?.retryAt).toBe(Date.now() + 46 * 60_000 + RETRY_AFTER_MARGIN_MS);
    await service.refresh(true, true, 'claude:main');
    vi.advanceTimersByTime(21_000);
    await service.refresh(true); // the refresh button
    expect(fetchAccount.mock.calls.filter(([ref]) => (ref as AccountRef).key === 'uuid:B:-')).toHaveLength(1);
  });

  it('sends the account notices along with the state', async () => {
    const notices = [{ id: 'n1', kind: 'switchedOut' as const, at: 1, email: 'g@x.com' }];
    const service = new UsageService({ accounts: () => [refA], fetchAccount: async () => ok('claude', 1), cacheFile, enabled: () => true, intervalMs: () => 0, notices: () => notices });
    expect(service.getState().notices).toEqual(notices);
  });

  it('sends the state of the saved accounts file and the set-aside cards along with the state, only when there is any', () => {
    const base = { accounts: () => [refA], fetchAccount: async () => ok('claude', 1), cacheFile, enabled: () => true, intervalMs: () => 0 };
    const setAside = [{ recordId: 'r1', email: 'g@x.com', restoring: false }];
    const service = new UsageService({ ...base, accountsInfo: () => ({ accountsReadOnly: '/d/accounts.json', setAside }) });
    expect(service.getState()).toMatchObject({ accountsReadOnly: '/d/accounts.json', setAside });
    const quiet = new UsageService({ ...base, accountsInfo: () => ({ setAside: [] }) });
    expect(Object.keys(quiet.getState())).toEqual(['providers']);
  });

  it('adds the margin only to a 429 of the usage endpoint, not to a rate-limited token renewal (F23)', async () => {
    const saved: AccountRef = { id: 'claude:abc', provider: 'claude', key: 'uuid:B:-', configDir: '/p' };
    const renewal = (): FetchResult => ({ usage: { accountId: 'claude:abc', provider: 'claude', status: 'error', fetchedAt: Date.now(), source: 'live', windows: [], error: 'refresh-http-429' }, retryAfterMs: 600_000 });
    const service = new UsageService({ accounts: () => [saved], fetchAccount: async () => renewal(), cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    expect(service.getState().providers[0].retryAt).toBe(Date.now() + 600_000);
  });

  it('re-derives the main, managed and held flags from the current card on every result, also while held or failed', async () => {
    const mirror = (ref: AccountRef, result: FetchResult): FetchResult => ({ ...result, usage: { ...result.usage, accountId: ref.id, ...(ref.active ? { active: true } : {}), ...(ref.configDir ? { managed: true } : {}) } });
    const a: AccountRef = { id: 'claude:a', provider: 'claude', key: 'uuid:A:-', active: true };
    const b: AccountRef = { id: 'claude:b', provider: 'claude', key: 'uuid:B:-', configDir: '/b', renew: 'held-by-cswap' };
    let listed: AccountRef[] = [a, b];
    let round = 0;
    const fetchAccount = vi.fn(async (ref: AccountRef) => mirror(ref, ref.key === 'uuid:B:-' ? limited(ref.id) : round === 0 ? ok('claude', 40, ref.id) : failing('claude', 'error', undefined, ref.id)));
    const service = new UsageService({ accounts: () => listed, fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    expect(service.getState().providers.map((p) => [p.accountId, p.active, p.managed, p.heldBy])).toEqual([['claude:a', true, undefined, undefined], ['claude:b', undefined, true, 'cswap']]);
    // B became main (held by its 429), A a saved card whose read fails: one main badge, on B.
    round = 1;
    listed = [{ id: 'claude:b', provider: 'claude', key: 'uuid:B:-', active: true }, { id: 'claude:a', provider: 'claude', key: 'uuid:A:-', configDir: '/a', renew: 'switched-out' }];
    await service.refresh(true, true);
    const state = service.getState().providers;
    expect(state.map((p) => [p.accountId, p.active, p.managed, p.heldBy])).toEqual([['claude:b', true, undefined, undefined], ['claude:a', undefined, true, 'switched-out']]);
    expect(state.filter((p) => p.active)).toHaveLength(1);
    expect(state[0]).toMatchObject({ status: 'error', error: 'http-429' });
    expect(state[1]).toMatchObject({ status: 'error', source: 'cache', windows: [{ usedPercent: 40 }] });
  });

  it('reads an account again when it moved between the live login and a saved profile (another copy of its sign-in)', async () => {
    let listed: AccountRef[] = [refA];
    const fetchAccount = vi.fn(async (ref: AccountRef) => ok('claude', 10, ref.id));
    const service = new UsageService({ accounts: () => listed, fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    vi.advanceTimersByTime(30_000);
    listed = [refG, { id: 'claude:a', provider: 'claude', key: 'uuid:A:-', configDir: '/a' }];
    await service.refresh(true, true);
    expect(fetchAccount.mock.calls.filter(([ref]) => (ref as AccountRef).key === 'uuid:A:-')).toHaveLength(2);
    vi.advanceTimersByTime(30_000);
    await service.refresh(true, true);
    expect(fetchAccount.mock.calls.filter(([ref]) => (ref as AccountRef).key === 'uuid:A:-')).toHaveLength(2);
  });

  describe('a changed live login file (watchLive, F23)', () => {
    it('does not bypass the 3-minute spacing of the same account', async () => {
      let stamp = 'a';
      const beforeRun = vi.fn(async () => undefined);
      const fetchAccount = vi.fn(async () => ok('claude', 10));
      const service = new UsageService({ accounts: () => [refA], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 3_600_000, credentialsStamp: async () => stamp, watchMs: 20_000, watchLive: true, beforeRun });
      service.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchAccount).toHaveBeenCalledTimes(1);
      stamp = 'b';
      await vi.advanceTimersByTimeAsync(60_000);
      expect(beforeRun).toHaveBeenCalledTimes(2); // the change is looked at (reconcile) once
      expect(fetchAccount).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it('does not bypass a backoff', async () => {
      let stamp = 'a';
      const fetchAccount = vi.fn(async () => failing('claude', 'error', 600_000));
      const service = new UsageService({ accounts: () => [refA], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 3_600_000, credentialsStamp: async () => stamp, watchMs: 20_000, watchLive: true, minIdentityGapMs: 0 });
      service.start();
      await vi.advanceTimersByTimeAsync(100);
      stamp = 'b';
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchAccount).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it('reads a newly signed-in account at once', async () => {
      let stamp = 'a';
      let listed: AccountRef[] = [refA];
      const fetchAccount = vi.fn(async (ref: AccountRef) => ok('claude', ref.key === 'uuid:G:-' ? 70 : 10, ref.id));
      const beforeRun = async () => { if (stamp === 'b') listed = [refG]; };
      const service = new UsageService({ accounts: () => listed, fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 3_600_000, credentialsStamp: async () => stamp, watchMs: 20_000, watchLive: true, beforeRun });
      service.start();
      await vi.advanceTimersByTimeAsync(100);
      stamp = 'b';
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchAccount).toHaveBeenCalledTimes(2);
      expect(service.getState().providers[0].windows[0].usedPercent).toBe(70);
      service.stop();
    });
  });

  describe('a 0.9.0 cache (keyed by card)', () => {
    const SAVED: AccountRef = { id: 'claude:rec1', provider: 'claude', key: 'uuid:B:-', configDir: '/b' };
    const card = (accountId: string, percent: number, email: string) => ({ accountId, provider: 'claude', status: 'ok', source: 'live', fetchedAt: NOW - 60_000, email, windows: [{ id: '5h', usedPercent: percent, resetsAt: 10 }] });
    const write = () => writeFileSync(cacheFile, JSON.stringify({
      providers: [card('claude:main', 40, 'a@x.com'), card('claude:rec1', 33, 'b@x.com')],
      backoff: { 'claude:rec1': { until: NOW + 600_000, failures: 1, error: 'http-429', attemptAt: NOW - 1000 } },
    }));
    const failedAs = (ref: AccountRef, email: string): FetchResult => ({ usage: { accountId: ref.id, provider: 'claude', status: 'error', fetchedAt: Date.now(), source: 'live', windows: [], error: 'http-500', email } });

    it('moves a saved card to its account at once, its backoff too, and saves the account-keyed cache', async () => {
      write();
      const fetchAccount = vi.fn(async (ref: AccountRef) => failedAs(ref, 'a@x.com'));
      const service = new UsageService({ accounts: () => [refA, SAVED], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
      expect(service.getState().providers.map((p) => [p.accountId, p.windows[0]?.usedPercent])).toEqual([['claude:rec1', 33]]);
      await service.refresh(true, true);
      expect(fetchAccount.mock.calls.map(([ref]) => (ref as AccountRef).id)).toEqual(['claude:main']); // rec1 is still held
      const stored = JSON.parse(readFileSync(cacheFile, 'utf8')) as { version: number; entries: Array<{ key: string }>; backoff: Record<string, unknown> };
      expect(stored.version).toBe(2);
      expect(stored.entries.map((e) => e.key).sort()).toEqual(['uuid:A:-', 'uuid:B:-']);
      expect(stored.backoff['uuid:B:-']).toMatchObject({ until: NOW + 600_000, error: 'http-429' });
      expect(Object.keys(stored.backoff)).not.toContain('claude:rec1');
    });

    const legacyHeld = () => writeFileSync(cacheFile, JSON.stringify({
      providers: [card('claude:main', 40, 'a@x.com')],
      backoff: { 'claude:main': { until: NOW + 600_000, failures: 1, error: 'http-429', attemptAt: NOW - 1000 } },
    }));
    const live: AccountRef = { id: 'claude:rec9', provider: 'claude', key: 'uuid:A:-', active: true };

    it("keeps the 0.9.0 live card's backoff and numbers only when the live account has its e-mail, also under its record's id", async () => {
      legacyHeld();
      const fetchAccount = vi.fn(async (ref: AccountRef) => failedAs(ref, 'a@x.com'));
      const service = new UsageService({ accounts: () => [live], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0, liveEmail: () => 'A@x.com' });
      await service.refresh(true, true);
      expect(fetchAccount).not.toHaveBeenCalled();
      expect(service.getState().providers[0]).toMatchObject({ accountId: 'claude:rec9', status: 'error', error: 'http-429', windows: [{ usedPercent: 40 }], active: true });
    });

    it("never gives the 0.9.0 live card's backoff to another account, nor keeps one it cannot check", async () => {
      for (const liveEmail of [() => 'g@x.com', () => undefined]) {
        legacyHeld();
        const fetchAccount = vi.fn(async (ref: AccountRef) => failedAs(ref, 'g@x.com'));
        const service = new UsageService({ accounts: () => [live], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0, liveEmail });
        await service.refresh(true, true);
        expect(fetchAccount).toHaveBeenCalledOnce();
        expect(service.getState().providers[0]).toMatchObject({ error: 'http-500', windows: [] });
        expect(JSON.parse(readFileSync(cacheFile, 'utf8')).backoff['uuid:A:-']).toMatchObject({ error: 'http-500' });
      }
    });

    it('gives the live card the old numbers only once a read proves it is the same account', async () => {
      write();
      let email = 'a@x.com';
      const fetchAccount = vi.fn(async (ref: AccountRef) => failedAs(ref, email));
      const service = new UsageService({ accounts: () => [refA], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
      expect(service.getState().providers).toEqual([]);
      await service.refresh(true, true);
      expect(service.getState().providers[0]).toMatchObject({ status: 'error', source: 'cache', windows: [{ usedPercent: 40 }] });
      write();
      email = 'other@x.com';
      const other = new UsageService({ accounts: () => [refA], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
      await other.refresh(true, true);
      expect(other.getState().providers[0]).toMatchObject({ status: 'error', windows: [] });
    });
  });
});

describe('task 12 fix round 1', () => {
  const live: AccountRef = { id: 'claude:main', provider: 'claude', key: 'uuid:A:-', active: true };

  it('reads an account shared by the live login and a saved record once per run, keeps its spacing and one stable card state', async () => {
    const saved: AccountRef = { id: 'claude:rec1', provider: 'claude', key: 'uuid:A:-', configDir: '/a', renew: 'held-by-live' };
    let n = 0;
    const fetchAccount = vi.fn(async (ref: AccountRef) => ok('claude', ++n, ref.id));
    const service = new UsageService({ accounts: () => [saved, live], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    expect(fetchAccount).toHaveBeenCalledOnce();
    expect((fetchAccount.mock.calls[0][0] as AccountRef).configDir).toBeUndefined(); // through the live login
    const first = service.getState().providers;
    vi.advanceTimersByTime(30_000);
    await service.refresh(true, true);
    await service.refresh(true, true);
    expect(fetchAccount).toHaveBeenCalledOnce();
    expect(service.getState().providers).toEqual(first);
    expect(first.map((p) => [p.accountId, p.windows[0].usedPercent, p.active, p.heldBy])).toEqual([['claude:rec1', 1, undefined, 'live'], ['claude:main', 1, true, undefined]]);
    vi.advanceTimersByTime(MIN_IDENTITY_GAP_MS);
    await service.refresh(true, true);
    expect(fetchAccount).toHaveBeenCalledTimes(2);
    // An action about the saved card is about the account: read (once) at once.
    await service.refresh(true, true, 'claude:rec1');
    expect(fetchAccount).toHaveBeenCalledTimes(3);
  });

  it('makes the follow-up run manual only when a manual caller joined it', async () => {
    const x: AccountRef = { id: 'claude:x', provider: 'claude', key: 'uuid:X:-', configDir: '/x' };
    const releases: Array<() => void> = [];
    let slow = false;
    const fetchAccount = vi.fn((ref: AccountRef): Promise<FetchResult> => {
      if (ref.key === 'uuid:X:-') return Promise.resolve(failing('claude', 'error', 600_000, ref.id));
      if (!slow) return Promise.resolve(ok('claude', 1, ref.id));
      return new Promise((resolve) => { releases.push(() => resolve(ok('claude', 1, ref.id))); });
    });
    const service = new UsageService({ ...LEGACY, accounts: () => [live, x], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    const xCalls = () => fetchAccount.mock.calls.filter(([ref]) => (ref as AccountRef).key === 'uuid:X:-').length;
    expect(xCalls()).toBe(1);
    slow = true;
    const run = service.refresh(false, true);
    const joined = service.refresh(false, true); // a file change
    releases.shift()!();
    await run;
    await vi.advanceTimersByTimeAsync(0);
    releases.shift()!();
    await joined;
    expect(xCalls()).toBe(1); // its error hold stands
    const run2 = service.refresh(false, true);
    const button = service.refresh(true, true);
    releases.shift()!();
    await run2;
    await vi.advanceTimersByTimeAsync(0);
    releases.shift()!();
    await button;
    expect(xCalls()).toBe(2);
  });

  it('keeps the short start guard after a restart also when the last read left no numbers', async () => {
    const results: Array<(ref: AccountRef) => FetchResult> = [
      (ref) => ({ usage: { accountId: ref.id, provider: 'claude', status: 'forbidden', fetchedAt: Date.now(), source: 'live', windows: [], error: 'http-403' } }),
      (ref) => failing('claude', 'expired', undefined, ref.id),
      (ref) => ({ usage: { accountId: ref.id, provider: 'claude', status: 'signedOut', fetchedAt: Date.now(), source: 'live', windows: [] } }),
    ];
    for (const result of results) {
      rmSync(cacheFile, { force: true });
      const fetchAccount = vi.fn(async (ref: AccountRef) => result(ref));
      await new UsageService({ accounts: () => [live], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 }).refresh(true, true);
      vi.advanceTimersByTime(EAGER_GUARD_MS - 1_000);
      // The first run after a restart: it reads at once, except an account read in the last 30 seconds.
      await new UsageService({ accounts: () => [live], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 }).refresh(true, true);
      expect(fetchAccount).toHaveBeenCalledOnce();
    }
  });

  it('holds a forbidden account for 30 minutes and shows it as forbidden, also after a restart', async () => {
    const fetchAccount = vi.fn(async (ref: AccountRef): Promise<FetchResult> => ({ usage: { accountId: ref.id, provider: 'claude', status: 'forbidden', fetchedAt: Date.now(), source: 'live', windows: [], error: 'http-403' } }));
    const service = new UsageService({ accounts: () => [live], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    expect(service.getState().providers[0]).toMatchObject({ status: 'forbidden', retryAt: NOW + 30 * 60_000 });
    vi.advanceTimersByTime(MIN_IDENTITY_GAP_MS + 1);
    await service.refresh(false, true);
    expect(fetchAccount).toHaveBeenCalledOnce();
    const after = new UsageService({ accounts: () => [live], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await after.refresh(false, true);
    expect(after.getState().providers[0]).toMatchObject({ status: 'forbidden', error: 'http-403', retryAt: NOW + 30 * 60_000 });
    expect(fetchAccount).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30 * 60_000);
    await after.refresh(false, true);
    expect(fetchAccount).toHaveBeenCalledTimes(2);
  });

  it('adds the margin to a usage 429 without Retry-After too', async () => {
    const fetchAccount = vi.fn(async (ref: AccountRef): Promise<FetchResult> => ({ usage: { accountId: ref.id, provider: 'claude', status: 'error', fetchedAt: Date.now(), source: 'live', windows: [], error: 'http-429' } }));
    const service = new UsageService({ accounts: () => [live], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 0 });
    await service.refresh(true, true);
    expect(service.getState().providers[0].retryAt).toBe(NOW + 60_000 + RETRY_AFTER_MARGIN_MS);
  });
});
