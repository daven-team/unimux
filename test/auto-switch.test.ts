import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountKey, autoSwitchStatus, autoSwitchText, defaultAutoSwitch, emptyAutoSwitchMemory, enableAutoSwitch, manualCandidates, nextAvailable, normalizeAutoSwitch,
  normalizeAutoSwitchMemory, planAutoSwitch, rankCandidates, rememberSwitch, switchTrigger, type AutoSwitchMemory, type AutoSwitchSettings,
} from '../src/shared/autoSwitch';
import type { ProviderUsage } from '../src/shared/usage';
import { AutoSwitcher } from '../src/main/autoSwitch';
import type { SwapResult } from '../src/shared/accounts';

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
const on = (patch: Partial<AutoSwitchSettings> = {}): AutoSwitchSettings => ({ ...defaultAutoSwitch(), enabled: true, mode: 'switch', ...patch });
const plan = (providers: ProviderUsage[], settings = on(), memory: AutoSwitchMemory = emptyAutoSwitchMemory(), nowMs = NOW) => planAutoSwitch({ providers, provider: 'claude', settings, memory, nowMs });

describe('automatic account switch: settings', () => {
  it('is off by default with 95 % / 98 %, asks, returns home and reads damaged settings as defaults', () => {
    const d = defaultAutoSwitch();
    expect(d).toMatchObject({ enabled: false, codex: false, fiveHour: { enabled: true, percent: 95 }, sevenDay: { enabled: true, percent: 98 }, mode: 'ask', cooldownMinutes: 15, returnHome: true });
    expect(normalizeAutoSwitch({ enabled: 'yes', fiveHour: { percent: 300 }, mode: 'now', cooldownMinutes: 7, target: { claude: 'A@X.COM', codex: 5 } })).toEqual({ ...d, target: { claude: 'a@x.com' } });
    expect(normalizeAutoSwitch(undefined)).toEqual(d);
  });

  it('keeps any whole threshold from 1 to 100 (1.1.2: a slider instead of fixed steps)', () => {
    const d = defaultAutoSwitch();
    for (const percent of [1, 50, 63, 95, 100]) expect(normalizeAutoSwitch({ fiveHour: { enabled: true, percent } }).fiveHour.percent).toBe(percent);
    for (const percent of [0, 101, 72.5, -5, '80', NaN]) expect(normalizeAutoSwitch({ sevenDay: { enabled: true, percent } }).sevenDay.percent).toBe(d.sevenDay.percent);
  });

  it('turning it on makes the current main accounts primary (an existing choice stays)', () => {
    const providers = [card('a@x.com', 10, 10, { active: true }), card('b@x.com', 10, 10)];
    expect(enableAutoSwitch(defaultAutoSwitch(), providers)).toMatchObject({ enabled: true, primary: { claude: 'a@x.com' } });
    expect(enableAutoSwitch({ ...defaultAutoSwitch(), primary: { claude: 'b@x.com' } }, providers).primary).toEqual({ claude: 'b@x.com' });
  });

  it('reads a saved memory and drops damaged marks', () => {
    expect(normalizeAutoSwitchMemory({ last: { claude: 5, codex: 'x' }, left: [{ provider: 'claude', key: 'a', window: '5h', resetsAt: 9 }, { provider: 'x' }], offered: 3, away: { claude: 'A' } }))
      .toEqual({ last: { claude: 5 }, left: [{ provider: 'claude', key: 'a', window: '5h', resetsAt: 9 }], offered: [], away: { claude: 'a' } });
  });
});

describe('automatic account switch: thresholds and candidates', () => {
  it('triggers at the 5-hour or 7-day threshold only with current numbers', () => {
    const main = card('a@x.com', 95, 10, { active: true });
    expect(switchTrigger(main, on(), NOW)).toEqual({ window: '5h', percent: 95, resetsAt: S + 2 * H });
    expect(switchTrigger(card('a@x.com', 94, 97, { active: true }), on(), NOW)).toBeNull();
    expect(switchTrigger(card('a@x.com', 10, 98, { active: true }), on(), NOW)?.window).toBe('7d');
    // Remembered numbers, an expired sign-in and a disabled window never trigger.
    expect(switchTrigger({ ...main, source: 'cache' }, on(), NOW)).toBeNull();
    expect(switchTrigger({ ...main, status: 'expired' }, on(), NOW)).toBeNull();
    expect(switchTrigger(main, on({ fiveHour: { enabled: false, percent: 95 } }), NOW)).toBeNull();
    // A window whose reset already passed counts as unused.
    expect(switchTrigger(card('a@x.com', 99, 10, { active: true }, { five: -60 }), on(), NOW)).toBeNull();
  });

  it('picks the account with the most room, the earlier reset on equal room', () => {
    const providers = [card('a@x.com', 96, 50, { active: true }), card('b@x.com', 40, 60), card('c@x.com', 20, 30), card('d@x.com', 20, 30, {}, { five: H })];
    expect(rankCandidates(providers, 'claude', on(), emptyAutoSwitchMemory(), NOW).map(accountKey)).toEqual(['d@x.com', 'c@x.com', 'b@x.com']);
    const result = plan(providers);
    expect(result.kind).toBe('switch');
    if (result.kind === 'switch') expect(result.candidates[0].email).toBe('d@x.com');
  });

  it('never offers an expired, dead, switched-out, stale, unread or over-threshold account', () => {
    const providers = [
      card('a@x.com', 96, 10, { active: true }),
      card('expired@x.com', 0, 0, { status: 'expired', error: 'login-dead' }),
      card('elsewhere@x.com', 0, 0, { status: 'elsewhere', heldBy: 'switched-out' }),
      card('held@x.com', 0, 0, { heldBy: 'live' }),
      card('cached@x.com', 0, 0, { source: 'cache' }),
      card('old@x.com', 0, 0, { fetchedAt: NOW - 60 * 60_000 }),
      card('full@x.com', 96, 10),
      card('week@x.com', 10, 99),
      card('error@x.com', 0, 0, { status: 'error' }),
    ];
    expect(rankCandidates(providers, 'claude', on(), emptyAutoSwitchMemory(), NOW)).toEqual([]);
    // A copy cswap may also hold stays a candidate: the swap checks the family rules again right before it.
    expect(rankCandidates([...providers, card('cswap@x.com', 5, 5, { heldBy: 'cswap' })], 'claude', on(), emptyAutoSwitchMemory(), NOW).map(accountKey)).toEqual(['cswap@x.com']);
  });

  it('switches only to the chosen account when one is set, and never over its thresholds', () => {
    const providers = [card('a@x.com', 96, 10, { active: true }), card('b@x.com', 10, 10), card('c@x.com', 50, 10)];
    const chosen = plan(providers, on({ target: { claude: 'c@x.com' } }));
    expect(chosen.kind === 'switch' && chosen.candidates.map(accountKey)).toEqual(['c@x.com']);
    const over = plan([...providers.slice(0, 2), card('c@x.com', 97, 10, {}, { five: 3 * H })], on({ target: { claude: 'c@x.com' } }));
    expect(over).toMatchObject({ kind: 'exhausted', target: 'c@x.com', next: { email: 'c@x.com', resetsAt: S + 3 * H } });
  });

  it('offers instead of switching in ask mode, once per limit period', () => {
    const providers = [card('a@x.com', 96, 10, { active: true }), card('b@x.com', 10, 10)];
    const first = plan(providers, on({ mode: 'ask' }));
    expect(first.kind).toBe('offer');
    const told: AutoSwitchMemory = { ...emptyAutoSwitchMemory(), offered: [{ provider: 'claude', key: 'a@x.com', window: '5h', resetsAt: S + 2 * H + 60 }] };
    expect(plan(providers, on({ mode: 'ask' }), told)).toMatchObject({ kind: 'none', reason: 'offered' });
    // A new period of the main account (another reset time) is offered again.
    expect(plan([card('a@x.com', 96, 10, { active: true }, { five: 5 * H }), providers[1]], on({ mode: 'ask' }), told).kind).toBe('offer');
  });
});

describe('automatic account switch: cooldown, ping-pong, return home, nobody has room', () => {
  it('waits for the cooldown after a switch or an attempt', () => {
    const providers = [card('b@x.com', 96, 10, { active: true }), card('c@x.com', 10, 10)];
    const memory = { ...emptyAutoSwitchMemory(), last: { claude: NOW - 5 * 60_000 } };
    expect(plan(providers, on(), memory)).toMatchObject({ kind: 'none', reason: 'cooldown' });
    expect(plan(providers, on(), memory, NOW + 11 * 60_000).kind).toBe('switch');
  });

  it('never goes back to an account left because of a limit before that limit reset (no ping-pong)', () => {
    const a = card('a@x.com', 96, 10, { active: true });
    const memory = rememberSwitch(emptyAutoSwitchMemory(), 'claude', a, switchTrigger(a, on(), NOW)!, NOW, { toKey: 'b@x.com' });
    // Now B is main and also over; A still shows old low numbers (a stale read): it is not chosen until its 5 h reset.
    const later = NOW + 20 * 60_000;
    const providers = [card('b@x.com', 97, 10, { active: true, fetchedAt: later }), card('a@x.com', 10, 10, { accountId: 'claude:a', fetchedAt: later })];
    expect(plan(providers, on(), memory, later)).toMatchObject({ kind: 'exhausted' });
    const afterReset = NOW + 2 * H * 1000 + 60_000;
    const fresh = [card('b@x.com', 97, 10, { active: true, fetchedAt: afterReset }, { five: 3 * H }), card('a@x.com', 0, 10, { accountId: 'claude:a', fetchedAt: afterReset }, { five: 7 * H })];
    const back = plan(fresh, on(), memory, afterReset);
    expect(back.kind === 'switch' && back.candidates.map(accountKey)).toEqual(['a@x.com']);
  });

  it('returns to the primary account once it is usable again after its reset (example of the user: A -> B -> A)', () => {
    const settings = on({ primary: { claude: 'a@x.com' } });
    const a = card('a@x.com', 95, 10, { active: true });
    let memory = rememberSwitch(emptyAutoSwitchMemory(), 'claude', a, switchTrigger(a, settings, NOW)!, NOW, { toKey: 'b@x.com', primary: 'a@x.com' });
    expect(memory.away).toEqual({ claude: 'a@x.com' });
    // Before A's reset: B is main and fine, nothing happens.
    const t1 = NOW + 30 * 60_000;
    expect(plan([card('b@x.com', 40, 10, { active: true, fetchedAt: t1 }), card('a@x.com', 95, 10, { accountId: 'claude:a', fetchedAt: t1 })], settings, memory, t1).kind).toBe('none');
    // After A's reset, below the thresholds again: back to A, also while B is fine.
    const t2 = NOW + 2 * H * 1000 + 5 * 60_000;
    const back = plan([card('b@x.com', 60, 10, { active: true, fetchedAt: t2 }), card('a@x.com', 1, 10, { accountId: 'claude:a', fetchedAt: t2 }, { five: 7 * H })], settings, memory, t2);
    expect(back).toMatchObject({ kind: 'switch', reason: 'return' });
    memory = rememberSwitch(memory, 'claude', card('b@x.com', 60, 10, { active: true }), undefined, t2, { toKey: 'a@x.com', primary: 'a@x.com' });
    expect(memory.away).toEqual({});
    // "Return after the reset" off: it stays on B.
    expect(plan([card('b@x.com', 60, 10, { active: true, fetchedAt: t2 }), card('a@x.com', 1, 10, { accountId: 'claude:a', fetchedAt: t2 }, { five: 7 * H })], { ...settings, returnHome: false }, { ...memory, away: { claude: 'a@x.com' } }, t2).kind).toBe('none');
  });

  it('does not return home within the cooldown', () => {
    const settings = on({ primary: { claude: 'a@x.com' } });
    const memory: AutoSwitchMemory = { ...emptyAutoSwitchMemory(), last: { claude: NOW - 60_000 }, away: { claude: 'a@x.com' } };
    expect(plan([card('b@x.com', 50, 10, { active: true }), card('a@x.com', 1, 10)], settings, memory).kind).toBe('none');
  });

  it('when every account is over a threshold it stays and says so once, with the earliest reset', () => {
    const providers = [card('a@x.com', 97, 10, { active: true }, { five: 4 * H }), card('b@x.com', 99, 10, {}, { five: H }), card('c@x.com', 20, 99, {}, { seven: 2 * 24 * H })];
    const result = plan(providers);
    expect(result).toMatchObject({ kind: 'exhausted', next: { email: 'b@x.com', resetsAt: S + H } });
    expect(nextAvailable(providers, 'claude', on(), NOW)).toEqual({ email: 'b@x.com', resetsAt: S + H });
    const told: AutoSwitchMemory = { ...emptyAutoSwitchMemory(), offered: [{ provider: 'claude', key: 'exhausted:a@x.com', window: '5h', resetsAt: S + 4 * H }] };
    expect(plan(providers, on(), told)).toMatchObject({ kind: 'none', reason: 'noCandidate' });
  });

  it('does not claim that every account is over the threshold while one was not read yet or there is no other account', () => {
    expect(plan([card('a@x.com', 97, 10, { active: true }), card('b@x.com', 0, 0, { windows: [], status: 'error' })])).toMatchObject({ kind: 'none', reason: 'noCandidate' });
    expect(plan([card('a@x.com', 97, 10, { active: true })])).toMatchObject({ kind: 'none', reason: 'noCandidate' });
  });

  it('the user\'s "switch now" ignores the cooldown and the ping-pong marks but never picks an account over a threshold', () => {
    const providers = [card('a@x.com', 50, 10, { active: true }), card('b@x.com', 10, 10), card('c@x.com', 96, 10), card('d@x.com', 70, 10)];
    expect(manualCandidates(providers, 'claude', on(), NOW).map(accountKey)).toEqual(['b@x.com']);
    expect(manualCandidates(providers, 'claude', on(), NOW, 'c@x.com')).toEqual([]);
    expect(manualCandidates(providers, 'claude', on(), NOW, 'd@x.com').map(accountKey)).toEqual(['d@x.com']);
  });

  it('is off for Codex unless chosen', () => {
    const codex = (email: string, five: number, active = false): ProviderUsage => ({ ...card(email, five, 10, active ? { active: true } : {}), provider: 'codex', accountId: active ? 'codex:main' : `codex:${email}` });
    const providers = [codex('a@x.com', 96, true), codex('b@x.com', 10)];
    expect(planAutoSwitch({ providers, provider: 'codex', settings: on(), memory: emptyAutoSwitchMemory(), nowMs: NOW })).toMatchObject({ kind: 'none', reason: 'off' });
    expect(planAutoSwitch({ providers, provider: 'codex', settings: on({ codex: true }), memory: emptyAutoSwitchMemory(), nowMs: NOW }).kind).toBe('switch');
  });
});

describe('automatic account switch: texts', () => {
  const tr = (key: string, params?: Record<string, string | number>) => key.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));
  it('tells what happened, naming both accounts', () => {
    expect(autoSwitchText({ kind: 'switched', provider: 'claude', toEmail: 'support@x.com', fromEmail: 'daniel@x.com', window: '5h', percent: 96 }, tr as never).body)
      .toBe('Przełączono na support@x.com: limit 5 h konta daniel@x.com wykorzystany w 96%');
    expect(autoSwitchText({ kind: 'exhausted', provider: 'claude', toEmail: 'b@x.com', resetsAt: S + H }, tr as never, 'pl', NOW).body).toMatch(/^Wszystkie konta przekroczyły próg, najbliższy reset: b@x.com o \d\d:\d\d$/);
    expect(autoSwitchStatus(on({ primary: { claude: 'a@x.com' } }), 'claude', { away: { claude: 'a@x.com' } }, tr as never)).toBe('Switcher: wł. · największy zapas · wraca na a@x.com');
    expect(autoSwitchStatus(defaultAutoSwitch(), 'claude', undefined, tr as never)).toBe('Switcher: wył.');
  });
});

describe('AutoSwitcher (main process)', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  function setup(settings: AutoSwitchSettings, providers: ProviderUsage[], options: { busy?: boolean; refuse?: string[] } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'unimux-autoswitch-'));
    const swaps: string[] = [];
    const notices: string[] = [];
    let now = NOW;
    let busy = options.busy ?? false;
    const switcher = new AutoSwitcher({
      file: join(dir, 'auto-switch.json'),
      settings: () => settings,
      providers: () => providers,
      supported: () => true,
      busy: () => busy,
      validate: async (_p, id) => (options.refuse?.includes(id) ? { ok: false, error: 'foreign' } : null),
      swap: async (_p, id): Promise<SwapResult> => { swaps.push(id); return { ok: true, email: id.replace('claude:', '') }; },
      notify: (event) => notices.push(`${event.kind}:${event.toEmail ?? ''}`),
      changed: () => undefined,
      now: () => now,
    });
    return { switcher, swaps, notices, setNow: (t: number) => { now = t; }, setBusy: (b: boolean) => { busy = b; }, file: join(dir, 'auto-switch.json') };
  }

  it('switches at once, skipping a candidate the family rules refuse, then waits for the cooldown', async () => {
    const providers = [card('a@x.com', 96, 10, { active: true }), card('b@x.com', 5, 5), card('c@x.com', 20, 20)];
    const t = setup(on(), providers, { refuse: ['claude:b@x.com'] });
    await t.switcher.onState(providers);
    expect(t.swaps).toEqual(['claude:c@x.com']);
    expect(t.notices).toEqual(['switched:c@x.com']);
    await t.switcher.onState(providers);
    expect(t.swaps).toHaveLength(1);
  });

  it('never switches while a swap or a login runs', async () => {
    const providers = [card('a@x.com', 96, 10, { active: true }), card('b@x.com', 5, 5)];
    const t = setup(on(), providers, { busy: true });
    await t.switcher.onState(providers);
    expect(t.swaps).toEqual([]);
    t.setBusy(false);
    await t.switcher.onState(providers);
    expect(t.swaps).toEqual(['claude:b@x.com']);
  });

  it('offers in ask mode and switches only when the offer is accepted; the cooldown survives a restart', async () => {
    const providers = [card('a@x.com', 96, 10, { active: true }), card('b@x.com', 5, 5)];
    const t = setup(on({ mode: 'ask' }), providers);
    await t.switcher.onState(providers);
    expect(t.swaps).toEqual([]);
    expect(t.notices).toEqual(['offer:b@x.com']);
    expect(t.switcher.currentOffer()).toMatchObject({ provider: 'claude', reason: 'limit', to: 'claude:b@x.com', percent: 96 });
    await t.switcher.onState(providers);
    expect(t.notices).toHaveLength(1);
    expect(await t.switcher.acceptOffer()).toEqual({ ok: true, email: 'b@x.com' });
    expect(t.swaps).toEqual(['claude:b@x.com']);
    expect(t.switcher.currentOffer()).toBeNull();
    const again = new AutoSwitcher({ file: t.file, settings: () => on(), providers: () => providers, supported: () => true, busy: () => false, validate: async () => null, swap: async () => ({ ok: true }), notify: () => undefined, changed: () => undefined, now: () => NOW + 60_000 });
    expect(again.snapshot().last.claude).toBe(NOW);
  });

  it('tells "all accounts over the threshold" once', async () => {
    const providers = [card('a@x.com', 96, 10, { active: true }), card('b@x.com', 97, 5, {}, { five: H })];
    const t = setup(on(), providers);
    await t.switcher.onState(providers);
    await t.switcher.onState(providers);
    expect(t.swaps).toEqual([]);
    expect(t.notices).toEqual(['exhausted:b@x.com']);
  });

  it('"switch now" picks the best account or the chosen one and refuses one over a threshold', async () => {
    const providers = [card('a@x.com', 50, 10, { active: true }), card('b@x.com', 5, 5), card('c@x.com', 99, 5)];
    const t = setup(on({ enabled: false }), providers);
    expect(await t.switcher.switchNow('claude', 'c@x.com')).toEqual({ ok: false, error: 'noTarget' });
    expect(await t.switcher.switchNow('claude')).toEqual({ ok: true, email: 'b@x.com' });
  });
});
