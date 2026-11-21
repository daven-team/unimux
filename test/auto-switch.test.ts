import { describe, expect, it } from 'vitest';
import {
  autoSwitchStatus, autoSwitchText, deadMain, deadOfferMark, defaultAutoSwitch, emptyAutoSwitchMemory, enableAutoSwitch, normalizeAutoSwitch, offerKey,
  planAutoSwitch, rankCandidates, rememberTold, strategyOf, switchOfferText,
  type AutoSwitchSettings, type SwitchOffer,
} from '../src/shared/autoSwitch';
import type { ProviderUsage } from '../src/shared/usage';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const S = Math.floor(NOW / 1000);
const H = 3600;

function card(email: string, five: number, seven: number, patch: Partial<ProviderUsage> = {}, resets: { five?: number; seven?: number } = {}): ProviderUsage {
  return {
    accountId: patch.active ? 'claude:main' : `claude:${email}`, provider: 'claude', status: 'ok', email, windows: [
      { id: '5h', usedPercent: five, resetsAt: S + (resets.five ?? 2 * H) },
      { id: '7d', usedPercent: seven, resetsAt: S + (resets.seven ?? 3 * 24 * H) },
    ], fetchedAt: NOW - 60_000, source: 'live', managed: !patch.active, ...patch,
  };
}

describe('automatic account switch: settings', () => {
  it('turning it on makes the current main accounts primary (an existing choice stays)', () => {
    const providers = [card('a@x.com', 10, 10, { active: true }), card('b@x.com', 10, 10)];
    expect(enableAutoSwitch(defaultAutoSwitch(), providers)).toMatchObject({ enabled: true, primary: { claude: 'a@x.com' } });
    expect(enableAutoSwitch({ ...defaultAutoSwitch(), primary: { claude: 'b@x.com' } }, providers).primary).toEqual({ claude: 'b@x.com' });
  });
});


describe('automatic account switch: 1.2.6 strategy and the at-limit escape', () => {
  const on = (patch: Partial<AutoSwitchSettings> = {}): AutoSwitchSettings => ({ ...defaultAutoSwitch(), enabled: true, mode: 'switch', ...patch });
  const ranked = (providers: ProviderUsage[], settings: AutoSwitchSettings) =>
    rankCandidates(providers, 'claude', settings, emptyAutoSwitchMemory(), NOW).map((u) => u.email);
  const plan = (providers: ProviderUsage[], settings: AutoSwitchSettings) => planAutoSwitch({ providers, provider: 'claude', settings, memory: emptyAutoSwitchMemory(), nowMs: NOW });

  it('keeps the strategy only when it is weekly-first, so older settings stay the same', () => {
    expect(defaultAutoSwitch()).not.toHaveProperty('strategy');
    for (const strategy of [undefined, 'room', 'x', 1]) expect(normalizeAutoSwitch({ enabled: true, strategy })).not.toHaveProperty('strategy');
    expect(normalizeAutoSwitch({ strategy: 'weekly-first' }).strategy).toBe('weekly-first');
    expect(strategyOf(defaultAutoSwitch())).toBe('room');
    expect(Object.keys(normalizeAutoSwitch({ strategy: 'weekly-first' })).at(-1)).toBe('strategy');
  });

  it('weekly-first takes the soonest weekly reset, a roomy landing first, more room on a tie', () => {
    const D = 24 * H;
    const providers = [
      card('a@x.com', 96, 50, { active: true }),
      card('late@x.com', 10, 10, {}, { seven: 6 * D }),
      card('soon@x.com', 40, 80, {}, { seven: D }),
      card('soon2@x.com', 20, 70, {}, { seven: D + 300 }),
      card('tight@x.com', 90, 10, {}, { seven: 12 * H }),
    ];
    expect(ranked(providers, on())).toEqual(['late@x.com', 'soon2@x.com', 'soon@x.com', 'tight@x.com']);
    expect(ranked(providers, on({ strategy: 'weekly-first' }))).toEqual(['soon2@x.com', 'soon@x.com', 'late@x.com', 'tight@x.com']);
    const chosen = plan(providers, on({ strategy: 'weekly-first', target: { claude: 'late@x.com' } }));
    expect(chosen.kind === 'switch' && chosen.candidates.map((u) => u.email)).toEqual(['late@x.com']);
    const tr = (key: string) => key;
    expect(autoSwitchStatus(on({ strategy: 'weekly-first' }), 'claude', undefined, tr as never)).toContain('najbliższy reset tygodniowy');
  });

  it('escapes at the limit to the account with the most room when everyone is over the thresholds', () => {
    const providers = [
      card('a@x.com', 100, 40, { active: true }),
      card('b@x.com', 96, 10),
      card('c@x.com', 95, 10, {}, { five: 3 * H }),
      card('thin@x.com', 98, 10),
      card('spent@x.com', 100, 10),
      card('expired@x.com', 96, 10, { status: 'expired' }),
    ];
    const p = plan(providers, on());
    expect(p.kind === 'switch' && [p.reason, p.trigger?.percent, p.candidates.map((u) => u.email)]).toEqual(['escape', 100, ['c@x.com', 'b@x.com']]);
    expect(plan(providers, on({ mode: 'ask' })).kind).toBe('offer');
    expect(plan([card('a@x.com', 99, 40, { active: true }), providers[1]], on()).kind).toBe('exhausted');
    expect(plan([providers[0], providers[3], providers[4]], on()).kind).toBe('exhausted');
  });

  it('judges an account without a 5-hour window (Ultra) on its weekly window alone', () => {
    const ultra = (email: string, seven: number, patch: Partial<ProviderUsage> = {}) => {
      const u = card(email, 0, seven, patch);
      return { ...u, windows: u.windows.filter((w) => w.id === '7d') };
    };
    expect(plan([ultra('u@x.com', 50, { active: true }), card('b@x.com', 1, 1)], on())).toMatchObject({ kind: 'none', reason: 'below' });
    expect(ranked([card('a@x.com', 96, 10, { active: true }), ultra('ultra@x.com', 20), card('pro@x.com', 85, 10)], on())).toEqual(['ultra@x.com', 'pro@x.com']);
  });
});

describe('automatic account switch: 1.2.6 a dead main account and the escape notices', () => {
  const on = (patch: Partial<AutoSwitchSettings> = {}): AutoSwitchSettings => ({ ...defaultAutoSwitch(), enabled: true, mode: 'switch', ...patch });
  const plan = (providers: ProviderUsage[], settings: AutoSwitchSettings, memory = emptyAutoSwitchMemory(), nowMs = NOW) => planAutoSwitch({ providers, provider: 'claude', settings, memory, nowMs });
  const MIN = 60_000;
  const dead = (status: ProviderUsage['status'], gapMs: number): ProviderUsage => {
    const u = card('a@x.com', 40, 40, { active: true, status, source: 'cache', fetchedAt: NOW - gapMs - MIN, attemptAt: NOW - MIN });
    return status === 'lapsed' ? { ...u, windows: [] } : u;
  };
  const tr = ((key: string, params: Record<string, string | number> = {}) => key.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]))) as never;

  it('takes a lapsed main as dead at once and a forbidden one only when the 403 persists', () => {
    expect(deadMain(dead('lapsed', 0))).toBe('lapsed');
    expect(deadMain(dead('forbidden', 5 * MIN))).toBeUndefined();
    expect(deadMain(dead('forbidden', 30 * MIN))).toBe('forbidden');
    expect(deadMain({ ...dead('forbidden', 30 * MIN), attemptAt: undefined })).toBeUndefined();
    // 1.2.7: an unpaid subscription is dead at once.
    expect(deadMain({ ...dead('forbidden', 0), subscription: 'past_due' })).toBe('forbidden');
    expect(deadMain({ ...dead('forbidden', 0), subscription: 'active' })).toBeUndefined();
    for (const status of ['expired', 'signedOut', 'error', 'elsewhere'] as const) expect(deadMain(dead(status, 60 * MIN))).toBeUndefined();
  });

  it('switches away like at a limit: ranking, a chosen account, then any room; never to a dead copy', () => {
    const providers = [dead('lapsed', 0), card('b@x.com', 50, 10), card('c@x.com', 10, 10), card('gone@x.com', 1, 1, { status: 'lapsed' }), card('refused@x.com', 1, 1, { status: 'forbidden' })];
    const p = plan(providers, on());
    expect(p.kind === 'switch' && [p.reason, p.dead, p.trigger, p.candidates.map((u) => u.email)]).toEqual(['dead', 'lapsed', undefined, ['c@x.com', 'b@x.com']]);
    expect(plan(providers, on({ target: { claude: 'b@x.com' } }))).toMatchObject({ kind: 'switch', candidates: [{ email: 'b@x.com' }] });
    expect(plan([dead('forbidden', 5 * MIN), ...providers.slice(1)], on())).toMatchObject({ kind: 'none', reason: 'below' });
    expect(plan([dead('forbidden', 45 * MIN), ...providers.slice(1)], on())).toMatchObject({ kind: 'switch', reason: 'dead', dead: 'forbidden' });
    const over = plan([dead('lapsed', 0), card('thin@x.com', 99, 10), card('more@x.com', 96, 10), card('spent@x.com', 100, 10)], on());
    expect(over.kind === 'switch' && over.candidates.map((u) => u.email)).toEqual(['more@x.com', 'thin@x.com']);
    expect(plan([dead('lapsed', 0), card('spent@x.com', 100, 10)], on())).toMatchObject({ kind: 'none', reason: 'noCandidate' });
    expect(plan(providers, on(), { ...emptyAutoSwitchMemory(), last: { claude: NOW - MIN } })).toMatchObject({ kind: 'none', reason: 'cooldown' });
    expect(plan(providers, on({ enabled: false }))).toMatchObject({ kind: 'none', reason: 'off' });
  });

  it('offers once in a few hours and never returns home to a dead primary', () => {
    const providers = [dead('lapsed', 0), card('b@x.com', 10, 10)];
    expect(plan(providers, on({ mode: 'ask' })).kind).toBe('offer');
    const mark = deadOfferMark(NOW);
    const told = rememberTold(emptyAutoSwitchMemory(), 'claude', offerKey('dead', 'a@x.com'), mark.window, mark.resetsAt, NOW);
    expect(plan(providers, on({ mode: 'ask' }), told)).toMatchObject({ kind: 'none', reason: 'offered' });
    const settings = on({ primary: { claude: 'a@x.com' } });
    const away = { ...emptyAutoSwitchMemory(), away: { claude: 'a@x.com' } };
    for (const status of ['lapsed', 'forbidden'] as const) {
      expect(plan([card('b@x.com', 10, 10, { active: true }), card('a@x.com', 1, 1, { status })], settings, away)).toMatchObject({ kind: 'none', reason: 'below' });
    }
  });

  it('says what the escape and the dead main account switch did or offer', () => {
    const offer = (patch: Partial<SwitchOffer>): string => switchOfferText({ provider: 'claude', reason: 'limit', to: 'claude:b', toEmail: 'b@x.io', fromEmail: 'a@x.io', ...patch }, tr);
    expect(offer({ reason: 'escape', room: 4, window: '5h', percent: 100 })).toBe('Wszystkie konta są ponad progiem - największy zapas ma b@x.io (4%). Przełączyć na b@x.io?');
    expect(offer({ reason: 'dead', lapsed: true })).toBe('Konto a@x.io nie działa (subskrypcja wygasła). Przełączyć na b@x.io?');
    expect(offer({ reason: 'dead' })).toBe('Konto a@x.io nie działa (odmowa dostępu). Przełączyć na b@x.io?');
    expect(offer({ reason: 'limit', window: '5h', percent: 96 })).toBe('Limit 5 h konta a@x.io wykorzystany w 96%. Konto b@x.io ma zapas.');
    expect(autoSwitchText({ kind: 'escaped', provider: 'claude', toEmail: 'b@x.io', room: 7 }, tr).body).toBe('Wszystkie konta są ponad progiem - przełączono na b@x.io: największy zapas (7%).');
    expect(autoSwitchText({ kind: 'deadSwitched', provider: 'claude', fromEmail: 'a@x.io', toEmail: 'b@x.io', dead: 'forbidden' }, tr).body).toBe('Konto a@x.io nie działa (odmowa dostępu) - przełączono na b@x.io.');
  });
});
