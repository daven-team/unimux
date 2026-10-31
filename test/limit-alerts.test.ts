// test/limit-alerts.test.ts - 1.1.1: limit warnings as OS notifications.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimitAlerter } from '../src/main/limitAlerts';
import { UsageService } from '../src/main/usage/service';
import { defaultAlerts, defaultLimitAlerts, normalizeAlerts, normalizeLimitAlerts, type AlertSettings, type LimitAlertSettings } from '../src/shared/alerts';
import { translate } from '../src/shared/i18n';
import { evaluateLimits, limitKey, limitNoticeText, normalizeLimitMemory, type LimitMemory, type LimitNotice } from '../src/shared/limitAlerts';
import type { ProviderUsage } from '../src/shared/usage';

const NOW = new Date(2026, 9, 31, 18, 0, 0).getTime(); // local time, so "today" is stable
const S = Math.floor(NOW / 1000);
const card = (five: number, seven: number, patch: Partial<ProviderUsage> = {}, fiveReset = S + 3 * 3600, sevenReset = S + 3 * 86_400): ProviderUsage => ({
  accountId: 'claude:a', provider: 'claude', status: 'ok', email: 'support@example.com', fetchedAt: NOW, source: 'live',
  windows: [{ id: '5h', usedPercent: five, resetsAt: fiveReset }, { id: '7d', usedPercent: seven, resetsAt: sevenReset }], ...patch,
});
const settings = (patch: Partial<LimitAlertSettings> = {}): LimitAlertSettings => ({ ...defaultLimitAlerts(), ...patch });
const kinds = (notices: LimitNotice[]) => notices.map((n) => `${n.kind}:${n.window}${n.percent !== undefined ? `:${n.percent}` : ''}`);

describe('limit warning settings', () => {
  it('defaults: on, 5 h at 80 %, 7 days at 90 %, no reset notices', () => {
    expect(defaultAlerts().limits).toEqual({ enabled: true, fiveHour: { enabled: true, percent: 80 }, sevenDay: { enabled: true, percent: 90 }, resets: false });
    expect(normalizeAlerts({}).limits).toEqual(defaultLimitAlerts());
  });

  it('falls back field by field on damaged values', () => {
    expect(normalizeLimitAlerts({ enabled: 'yes', fiveHour: { enabled: false, percent: 150 }, sevenDay: { percent: 70.5 }, resets: true }))
      .toEqual({ enabled: true, fiveHour: { enabled: false, percent: 80 }, sevenDay: { enabled: true, percent: 90 }, resets: true });
  });
});

describe('evaluateLimits', () => {
  it('tells once per account, window and reset period when the threshold is crossed', () => {
    let memory: LimitMemory = {};
    let result = evaluateLimits(memory, [card(70, 50)], settings(), NOW);
    expect(result.notices).toEqual([]);
    memory = result.memory;
    result = evaluateLimits(memory, [card(82, 50)], settings(), NOW + 60_000);
    expect(kinds(result.notices)).toEqual(['threshold:5h:82']);
    expect(result.notices[0]).toMatchObject({ email: 'support@example.com', resetsAt: S + 3 * 3600 });
    memory = result.memory;
    // Still above, a little higher, the reset time jittered by a few seconds: the same period, nothing new.
    result = evaluateLimits(memory, [card(95, 50, {}, S + 3 * 3600 + 2)], settings(), NOW + 120_000);
    expect(result.notices).toEqual([]);
    // The 7-day window crosses its own threshold.
    result = evaluateLimits(result.memory, [card(95, 91)], settings(), NOW + 180_000);
    expect(kinds(result.notices)).toEqual(['threshold:7d:91']);
  });

  it('re-arms in a new reset period', () => {
    const first = evaluateLimits({}, [card(85, 10)], settings(), NOW);
    expect(first.notices).toHaveLength(1);
    const later = NOW + 4 * 3_600_000; // past the 5-hour reset
    const next = evaluateLimits(first.memory, [card(81, 10, {}, S + 8 * 3600)], settings(), later);
    expect(kinds(next.notices)).toEqual(['threshold:5h:81']);
  });

  it('tells each account on its own', () => {
    const other = card(90, 10, { accountId: 'claude:b', email: 'daniel@example.com' });
    const result = evaluateLimits({}, [card(90, 10), other], settings(), NOW);
    expect(result.notices.map((n) => n.email)).toEqual(['support@example.com', 'daniel@example.com']);
    expect(Object.keys(result.memory).sort()).toEqual([limitKey(other, '5h'), limitKey(card(0, 0), '5h')].sort());
  });

  it('never warns about an expired sign-in, remembered numbers or a window that already reset', () => {
    const cards = [
      card(99, 99, { status: 'expired', source: 'cache' }),
      card(99, 99, { status: 'elsewhere', heldBy: 'switched-out', accountId: 'claude:x', email: 'x@example.com' }),
      card(99, 99, { source: 'cache', accountId: 'claude:y', email: 'y@example.com' }),
      card(99, 10, { accountId: 'claude:z', email: 'z@example.com' }, S - 60),
    ];
    expect(evaluateLimits({}, cards, settings(), NOW).notices).toEqual([]);
  });

  it('looks at nothing for a disabled group or window', () => {
    expect(evaluateLimits({}, [card(99, 99)], settings({ enabled: false }), NOW)).toEqual({ memory: {}, notices: [] });
    expect(kinds(evaluateLimits({}, [card(99, 99)], settings({ fiveHour: { enabled: false, percent: 80 } }), NOW).notices)).toEqual(['threshold:7d:99']);
    expect(kinds(evaluateLimits({}, [card(66, 10)], settings({ fiveHour: { enabled: true, percent: 65 } }), NOW).notices)).toEqual(['threshold:5h:66']);
  });

  it('tells "available again" after the reset of a told window only when asked, and not for a sign-in that expired since', () => {
    const told = evaluateLimits({}, [card(85, 10)], settings({ resets: true }), NOW).memory;
    const after = NOW + 3 * 3_600_000 + 5_000;
    expect(kinds(evaluateLimits(told, [card(85, 10)], settings({ resets: true }), after).notices)).toEqual(['reset:5h']);
    expect(evaluateLimits(told, [card(85, 10)], settings(), after)).toMatchObject({ notices: [], memory: {} });
    expect(evaluateLimits(told, [card(85, 10, { status: 'expired' })], settings({ resets: true }), after).notices).toEqual([]);
    // A reset long past (the app was closed) is not announced any more.
    expect(evaluateLimits(told, [], settings({ resets: true }), after + 2 * 3_600_000).notices).toEqual([]);
  });

  it('reads back only sound memory entries', () => {
    expect(normalizeLimitMemory({ 'claude:a@x.com:5h': { provider: 'claude', resetsAt: 5, notified: true, token: 'x' }, 'bad': { provider: 'claude', resetsAt: 5, notified: true }, 'codex:b:7d': { provider: 'codex', resetsAt: 'x', notified: true } }))
      .toEqual({ 'claude:a@x.com:5h': { provider: 'claude', resetsAt: 5, notified: true } });
  });
});

describe('limitNoticeText', () => {
  const tr = (language: 'pl' | 'en') => (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(language, key, params);
  it('names the account, the window, the percent and the reset time', () => {
    const notice: LimitNotice = { kind: 'threshold', provider: 'claude', email: 'support@example.com', window: '5h', percent: 82, resetsAt: Math.floor(new Date(2026, 9, 31, 21, 0).getTime() / 1000) };
    expect(limitNoticeText(notice, tr('pl'), 'pl', NOW)).toEqual({ title: 'Limity kont AI', body: 'Konto support@example.com: limit 5 h wykorzystany w 82%, reset o 21:00' });
    expect(limitNoticeText(notice, tr('en'), 'en', NOW).body).toMatch(/^Account support@example\.com: 5 h limit 82% used, resets at /);
  });

  it('names the day of a reset on another day, and the window that is available again', () => {
    const later: LimitNotice = { kind: 'threshold', provider: 'codex', window: '7d', percent: 90, resetsAt: Math.floor(new Date(2026, 10, 3, 9, 30).getTime() / 1000) };
    expect(limitNoticeText(later, tr('pl'), 'pl', NOW).body).toMatch(/^Konto Codex: limit 7 dni wykorzystany w 90%, reset .*3\.11.* o 09:30$/);
    expect(limitNoticeText({ kind: 'reset', provider: 'claude', email: 'a@example.com', window: '5h', resetsAt: S }, tr('pl'), 'pl', NOW).body).toBe('Konto a@example.com: limit 5 h znowu dostępny');
  });
});

describe('LimitAlerter', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); dir = mkdtempSync(join(tmpdir(), 'ajza-limits-')); file = join(dir, 'limit-alerts.json'); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
  const make = (alerts: () => AlertSettings, providers: () => ProviderUsage[] = () => []) => {
    const show = vi.fn();
    return { show, alerter: new LimitAlerter({ file, alerts, providers, show }) };
  };

  it('shows a crossing exactly once, also across a restart', () => {
    const { show, alerter } = make(() => defaultAlerts());
    alerter.onState([card(82, 10)]);
    alerter.onState([card(84, 10)]);
    expect(show).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
    alerter.dispose();
    const again = make(() => defaultAlerts());
    again.alerter.onState([card(86, 10)]);
    expect(again.show).not.toHaveBeenCalled();
    again.alerter.dispose();
  });

  it('stays silent with the alerts master switch off or in quiet hours (the window still counts as told)', () => {
    const off = make(() => ({ ...defaultAlerts(), enabled: false }));
    off.alerter.onState([card(90, 10)]);
    expect(off.show).not.toHaveBeenCalled();
    off.alerter.dispose();
    rmSync(file, { force: true });
    const quiet = make(() => ({ ...defaultAlerts(), quietHours: { enabled: true, start: '17:00', end: '19:00' } }));
    quiet.alerter.onState([card(90, 10)]);
    expect(quiet.show).not.toHaveBeenCalled();
    expect(Object.values(quiet.alerter.snapshot())[0]).toMatchObject({ notified: true });
    quiet.alerter.dispose();
  });

  it('tells "available again" at the reset time without waiting for a poll', async () => {
    const alerts = { ...defaultAlerts(), limits: { ...defaultLimitAlerts(), resets: true } };
    const { show, alerter } = make(() => alerts, () => [card(85, 10)]);
    alerter.onState([card(85, 10)]);
    expect(show).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 2_000);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1][0]).toMatchObject({ kind: 'reset', window: '5h' });
    alerter.dispose();
  });
});

describe('polling while the window is hidden (limit warnings on)', () => {
  let dir: string;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); dir = mkdtempSync(join(tmpdir(), 'ajza-hidden-')); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
  for (const pollHidden of [true, false]) {
    it(`${pollHidden ? 'goes on' : 'stops'} when pollHidden is ${pollHidden}`, async () => {
      const fetchAccount = vi.fn(async () => ({ usage: card(10, 10, { accountId: 'claude:main' }) }));
      const service = new UsageService({ accounts: () => [{ id: 'claude:main', provider: 'claude' }], fetchAccount, cacheFile: join(dir, 'c.json'), enabled: () => true, intervalMs: () => 300_000, pollHidden: () => pollHidden });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      service.setActive(false);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetchAccount).toHaveBeenCalledTimes(pollHidden ? 3 : 1);
      service.stop();
    });
  }
});
