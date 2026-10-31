// test/usage-restart.test.ts - 1.1.1: an app restart with a usage cache and the refresh button.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchResult } from '../src/main/usage/fetchers';
import { EAGER_GUARD_MS, MIN_IDENTITY_GAP_MS, UsageService } from '../src/main/usage/service';
import { cardState, type AccountRef, type ProviderUsage } from '../src/shared/usage';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const live: AccountRef = { id: 'claude:support', provider: 'claude', key: 'uuid:S:o', active: true };
const switched: AccountRef = { id: 'claude:daniel', provider: 'claude', key: 'uuid:D:o', configDir: '/p/daniel', renew: 'switched-out' };
const dead: AccountRef = { id: 'claude:app', provider: 'claude', key: 'uuid:A:o', configDir: '/p/app', renew: 'allowed' };
const codex: AccountRef = { id: 'codex:main', provider: 'codex' };
const ALL = [live, switched, dead, codex];
const windows = (five: number, seven: number) => [{ id: '5h' as const, usedPercent: five, resetsAt: Math.floor(NOW / 1000) + 3600 }, { id: '7d' as const, usedPercent: seven, resetsAt: Math.floor(NOW / 1000) + 86_400 }];

/** What 1.1.0 wrote for the user's accounts: the expired ones keep their status and their last numbers. */
function seedCache(file: string, readAgoMs: number) {
  const at = NOW - readAgoMs;
  const entry = (ref: AccountRef, usage: Partial<ProviderUsage>) => ({ key: ref.key ?? ref.id, usage: { accountId: ref.id, provider: ref.provider, fetchedAt: at - 3_600_000, source: 'live', windows: windows(40, 60), ...usage } });
  writeFileSync(file, JSON.stringify({
    version: 2,
    entries: [
      entry(live, { status: 'ok', email: 'support@example.com' }),
      entry(switched, { status: 'elsewhere', source: 'cache', heldBy: 'switched-out', email: 'daniel@example.com', windows: windows(77, 88) }),
      entry(dead, { status: 'expired', source: 'cache', error: 'refresh-dead', email: 'app@example.com', windows: windows(55, 66) }),
      entry(codex, { status: 'ok', email: 'codex@example.com' }),
    ],
    backoff: {},
    reads: Object.fromEntries(ALL.map((ref) => [ref.key ?? ref.id, at])),
  }));
}

/** What the accounts answer now: the live one and Codex are fine, the two others still expired. */
const answer = (ref: AccountRef): FetchResult => ({
  usage: ref === dead ? { accountId: ref.id, provider: 'claude', status: 'expired', error: 'refresh-dead', windows: [], fetchedAt: Date.now(), source: 'live' }
    : ref === switched ? { accountId: ref.id, provider: 'claude', status: 'elsewhere', windows: [], fetchedAt: Date.now(), source: 'live' }
      : { accountId: ref.id, provider: ref.provider, status: 'ok', windows: windows(12, 30), fetchedAt: Date.now(), source: 'live' },
});

let dir: string;
let cacheFile: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); dir = mkdtempSync(join(tmpdir(), 'ajza-restart-')); cacheFile = join(dir, 'usage-cache.json'); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

const build = (fetchAccount: (ref: AccountRef) => Promise<FetchResult>, accounts: () => AccountRef[] = () => ALL) =>
  new UsageService({ accounts, fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 300_000 });
const states = (service: UsageService) => Object.fromEntries(service.getState().providers.map((p) => [p.accountId, cardState(p)]));

describe('a restart with a usage cache (1.1.1)', () => {
  it('shows an expired or switched-out sign-in as expired right away, never its old numbers as current', () => {
    seedCache(cacheFile, 60_000);
    const service = build(vi.fn(async (ref: AccountRef) => answer(ref)));
    expect(states(service)).toEqual({ 'claude:support': 'stale', 'claude:daniel': 'expired', 'claude:app': 'expired', 'codex:main': 'stale' });
    expect(service.getState().providers.find((p) => p.accountId === 'claude:app')).toMatchObject({ status: 'expired', error: 'refresh-dead' });
  });

  it('reads every account once right away at start although the last reads were a minute ago, then on the interval', async () => {
    seedCache(cacheFile, 60_000);
    const fetchAccount = vi.fn(async (ref: AccountRef) => answer(ref));
    const service = build(fetchAccount);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchAccount.mock.calls.map(([ref]) => ref.id).sort()).toEqual(['claude:app', 'claude:daniel', 'claude:support', 'codex:main']);
    expect(states(service)).toEqual({ 'claude:support': 'ok', 'claude:daniel': 'expired', 'claude:app': 'expired', 'codex:main': 'ok' });
    // The automatic runs keep the 3-minute spacing: a stamp-triggered run 1 minute later reads nothing.
    await vi.advanceTimersByTimeAsync(60_000);
    await service.refresh(false, true);
    expect(fetchAccount).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(240_000); // the 5-minute interval
    expect(fetchAccount).toHaveBeenCalledTimes(8);
    service.stop();
  });

  it('keeps an expired card across a restart also when it has no numbers', async () => {
    const fetchAccount = vi.fn(async (ref: AccountRef) => (ref === dead ? answer(dead) : answer(live)));
    await build(fetchAccount, () => [live, dead]).refreshNow();
    const stored = JSON.parse(readFileSync(cacheFile, 'utf8')) as { entries: Array<{ key: string; usage: ProviderUsage }> };
    expect(stored.entries.find((e) => e.key === dead.key)?.usage).toMatchObject({ status: 'expired', windows: [] });
    expect(states(build(fetchAccount, () => [live, dead]))['claude:app']).toBe('expired');
  });

  it('skips the start read of an account read in the last 30 seconds (a quick restart loop)', async () => {
    seedCache(cacheFile, EAGER_GUARD_MS - 5_000);
    const fetchAccount = vi.fn(async (ref: AccountRef) => answer(ref));
    const service = build(fetchAccount);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchAccount).not.toHaveBeenCalled();
    expect(states(service)['claude:app']).toBe('expired');
    service.stop();
  });

  it('still respects a rate-limit hold at start and the card says when it retries', async () => {
    seedCache(cacheFile, 60_000);
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8'));
    raw.backoff = { [live.key!]: { until: NOW + 600_000, failures: 1, error: 'http-429', attemptAt: NOW - 60_000 } };
    writeFileSync(cacheFile, JSON.stringify(raw));
    const fetchAccount = vi.fn(async (ref: AccountRef) => answer(ref));
    const service = build(fetchAccount);
    await service.refresh();
    expect(fetchAccount.mock.calls.map(([ref]) => ref.id)).not.toContain('claude:support');
    expect(fetchAccount).toHaveBeenCalledTimes(3);
    expect(service.getState().providers.find((p) => p.accountId === 'claude:support')).toMatchObject({ status: 'error', error: 'http-429', retryAt: NOW + 600_000 });
  });
});

describe('the refresh button (1.1.1)', () => {
  it('reads every account now, not only those past their 3-minute spacing, and resolves when all reads finished', async () => {
    const fetchAccount = vi.fn(async (ref: AccountRef) => answer(ref));
    const service = build(fetchAccount);
    await service.refresh();
    expect(fetchAccount).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(45_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchAccount.mockImplementation(async (ref: AccountRef) => { if (ref === codex) await gate; return answer(ref); });
    let done = false;
    const button = service.refreshNow().then((state) => { done = true; return state; });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchAccount).toHaveBeenCalledTimes(8);
    expect(done).toBe(false); // the spinner stays until the last read is back
    release();
    await button;
    expect(done).toBe(true);
  });

  it('skips only an account read in the last 30 seconds', async () => {
    const fetchAccount = vi.fn(async (ref: AccountRef) => answer(ref));
    const service = build(fetchAccount);
    await service.refresh();
    vi.advanceTimersByTime(10_000);
    await service.refreshNow();
    expect(fetchAccount).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(EAGER_GUARD_MS);
    await service.refreshNow();
    expect(fetchAccount).toHaveBeenCalledTimes(8);
  });

  it('never bypasses a rate-limit hold; the card tells when the account is retried', async () => {
    const fetchAccount = vi.fn(async (ref: AccountRef): Promise<FetchResult> => (ref === dead
      ? { usage: { accountId: ref.id, provider: 'claude', status: 'error', error: 'http-429', windows: [], fetchedAt: Date.now(), source: 'live' }, retryAfterMs: 600_000 }
      : answer(ref)));
    const service = new UsageService({ accounts: () => [live, dead], fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 300_000, retryAfterMarginMs: 0 });
    await service.refresh();
    vi.advanceTimersByTime(MIN_IDENTITY_GAP_MS);
    await service.refreshNow();
    expect(fetchAccount.mock.calls.filter(([ref]) => ref === dead)).toHaveLength(1);
    expect(fetchAccount.mock.calls.filter(([ref]) => ref === live)).toHaveLength(2);
    expect(service.getState().providers.find((p) => p.accountId === 'claude:app')).toMatchObject({ status: 'error', error: 'http-429', retryAt: NOW + 600_000 });
  });

  it('reads every account after an automatic run that was in flight when it was pressed', async () => {
    const fetchAccount = vi.fn(async (ref: AccountRef) => answer(ref));
    let gate: Promise<void> = Promise.resolve();
    const service = new UsageService({ accounts: () => ALL, fetchAccount, cacheFile, enabled: () => true, intervalMs: () => 300_000, beforeRun: () => gate });
    await service.refresh();
    expect(fetchAccount).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(60_000);
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const auto = service.refresh(false, true); // e.g. a changed login file: keeps the 3-minute spacing, reads nothing
    const button = service.refreshNow();
    release();
    await Promise.all([auto, button]);
    expect(fetchAccount).toHaveBeenCalledTimes(8);
  });
});
