import { describe, expect, it } from 'vitest';
import {
  autoSwitchStatus, defaultAutoSwitch, emptyAutoSwitchMemory, enableAutoSwitch, normalizeAutoSwitch, planAutoSwitch, rankCandidates, strategyOf,
  type AutoSwitchSettings,
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
    expect(p.kind === 'switch' && [p.reason, p.trigger?.percent, p.candidates.map((u) => u.email)]).toEqual(['limit', 100, ['c@x.com', 'b@x.com']]);
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
