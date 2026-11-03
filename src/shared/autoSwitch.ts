/**
 * 1.1.2: switching the main AI account automatically when it nears a limit, like cswap does. Pure: the settings, the memory
 * that keeps the switches apart (cooldown, no ping-pong, one notice per limit period) and the decision what to do with a new
 * state of the accounts. The main process does the switch itself (the same "make main" as the card's menu) and checks the
 * family rules once more right before it, so a candidate here is only a proposal.
 *
 * Rules: the main account crossing a threshold switches to the best usable saved account (most room, earliest reset as
 * tie-break) or to the one account the user chose; never to an account at or over a threshold, never to an expired, dead or
 * switched-out copy, never twice within the cooldown and never back to an account left because of a limit before that
 * limit reset. With a primary account ("konto podstawowe") and "return after the reset" on, the app goes back to it once it
 * was left automatically and is usable again. When no account has room it stays and says so once per limit period.
 */
import { isThresholdPercent, type LimitWindowAlert } from './alerts';
import type { MessageKey, MessageParams } from './i18n';
import { cardState, effectivePercent, type ProviderUsage, type UsageProvider, type UsageWindow } from './usage';

export type AutoSwitchMode = 'ask' | 'switch';

export interface AutoSwitchSettings {
  /** "Przełączaj konto Claude automatycznie" (off by default). */
  enabled: boolean;
  /** Also the Codex accounts saved in the app (off by default). */
  codex: boolean;
  fiveHour: LimitWindowAlert;
  sevenDay: LimitWindowAlert;
  /** `ask`: a notification with "Switch to X"; `switch`: at once, then a notification what happened. */
  mode: AutoSwitchMode;
  /** At most one automatic switch (or attempt) per provider in this many minutes. */
  cooldownMinutes: number;
  /** Per provider: the account (see `accountKey`) to switch to; absent: the one with the most room. */
  target: Partial<Record<UsageProvider, string>>;
  /** Per provider: the primary account ("konto podstawowe") the app returns to. */
  primary: Partial<Record<UsageProvider, string>>;
  /** Go back to the primary account once its limit reset ("Wracaj na konto podstawowe po resecie"). */
  returnHome: boolean;
}

export const AUTO_SWITCH_COOLDOWNS: readonly number[] = [5, 15, 30, 60];

export function defaultAutoSwitch(): AutoSwitchSettings {
  return {
    enabled: false, codex: false, fiveHour: { enabled: true, percent: 95 }, sevenDay: { enabled: true, percent: 98 }, mode: 'ask', cooldownMinutes: 15,
    target: {}, primary: {}, returnHome: true,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;

function perProvider(value: unknown): Partial<Record<UsageProvider, string>> {
  const out: Partial<Record<UsageProvider, string>> = {};
  if (isObject(value)) for (const provider of ['claude', 'codex'] as const) if (isKey(value[provider])) out[provider] = (value[provider] as string).toLowerCase();
  return out;
}

/** Reads saved settings; every missing or corrupt field falls back to its default. */
export function normalizeAutoSwitch(value: unknown): AutoSwitchSettings {
  const r = isObject(value) ? value : {};
  const d = defaultAutoSwitch();
  const windowOf = (raw: unknown, fallback: LimitWindowAlert): LimitWindowAlert => {
    const w = isObject(raw) ? raw : {};
    return { enabled: typeof w.enabled === 'boolean' ? w.enabled : fallback.enabled, percent: isThresholdPercent(w.percent) ? w.percent : fallback.percent };
  };
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    codex: typeof r.codex === 'boolean' ? r.codex : d.codex,
    fiveHour: windowOf(r.fiveHour, d.fiveHour),
    sevenDay: windowOf(r.sevenDay, d.sevenDay),
    mode: r.mode === 'switch' || r.mode === 'ask' ? r.mode : d.mode,
    cooldownMinutes: AUTO_SWITCH_COOLDOWNS.includes(r.cooldownMinutes as number) ? r.cooldownMinutes as number : d.cooldownMinutes,
    target: perProvider(r.target),
    primary: perProvider(r.primary),
    returnHome: typeof r.returnHome === 'boolean' ? r.returnHome : d.returnHome,
  };
}

/** Whether the automatic switch looks at this provider at all. */
export function autoSwitchOn(settings: AutoSwitchSettings, provider: UsageProvider): boolean {
  if (!settings.enabled || (!settings.fiveHour.enabled && !settings.sevenDay.enabled)) return false;
  return provider === 'claude' || settings.codex;
}

/**
 * Turning the switch on (panel or settings): a provider without a primary account gets the one that is main now, as the
 * user asked ("the one that was main when auto-switch was turned on").
 */
export function enableAutoSwitch(settings: AutoSwitchSettings, providers: ProviderUsage[]): AutoSwitchSettings {
  const primary = { ...settings.primary };
  for (const provider of ['claude', 'codex'] as const) {
    const main = mainCard(providers, provider);
    if (!primary[provider] && main) primary[provider] = accountKey(main);
  }
  return { ...settings, enabled: true, primary };
}

/** An account the app switched away from because of a limit: not a target again until that limit period ends. */
export interface LeftMark { provider: UsageProvider; key: string; window: UsageWindow['id']; resetsAt: number }
/** A limit period already told about (an offer, "all accounts over the threshold"): not told again in that period. */
export type OfferMark = LeftMark;

export interface AutoSwitchMemory {
  /** Epoch ms of the last switch or attempt per provider (the cooldown). */
  last: Partial<Record<UsageProvider, number>>;
  left: LeftMark[];
  offered: OfferMark[];
  /** Per provider: the primary account the app left (automatically or by "switch now"); it returns there after the reset. */
  away: Partial<Record<UsageProvider, string>>;
}

export const emptyAutoSwitchMemory = (): AutoSwitchMemory => ({ last: {}, left: [], offered: [], away: {} });

/** Two periods whose reset times differ by less than this are the same period (the endpoints jitter). */
const SAME_PERIOD_S = 10 * 60;
/** A candidate's numbers older than this are not trusted for a switch. */
export const CANDIDATE_MAX_AGE_MS = 20 * 60_000;
/** Two candidates with room within this many percent are equal; the earlier reset decides. */
const ROOM_TIE = 1;
const MAX_MARKS = 50;
/** How long a return offer is not repeated (it has no limit period of its own). */
const RETURN_OFFER_S = 5 * 3600;

/** Who an account is for the settings and the memory: its e-mail, else its card id (never a token). */
export const accountKey = (usage: Pick<ProviderUsage, 'email' | 'accountId'>): string => (usage.email || usage.accountId).toLowerCase();

/** The card of the account each tool uses now (Claude Code's live login, Codex's ~/.codex). */
export function mainCard(providers: ProviderUsage[], provider: UsageProvider): ProviderUsage | undefined {
  return providers.find((usage) => usage.provider === provider && usage.active);
}

const thresholdOf = (settings: AutoSwitchSettings, window: UsageWindow['id']): LimitWindowAlert => (window === '5h' ? settings.fiveHour : settings.sevenDay);

/** Unused part of the tightest window (0-100); an account without numbers has none. */
export function roomOf(usage: ProviderUsage, nowMs: number): number {
  if (!usage.windows.length) return 0;
  return Math.min(...usage.windows.map((window) => 100 - effectivePercent(window, nowMs)));
}

/** The earliest reset still ahead (epoch s), Infinity when none. */
function nextResetOf(usage: ProviderUsage, nowMs: number): number {
  const ahead = usage.windows.map((window) => window.resetsAt).filter((at) => at > 0 && at * 1000 > nowMs);
  return ahead.length ? Math.min(...ahead) : Number.POSITIVE_INFINITY;
}

export interface Trigger { window: UsageWindow['id']; percent: number; resetsAt: number }

/** Numbers read now: remembered ones, a failed read or an expired sign-in never count. */
const current = (usage: ProviderUsage) => usage.status === 'ok' && usage.source !== 'cache' && cardState(usage) !== 'expired';

/** The window of the main account at or above its threshold (the fuller one when both are), or null. */
export function switchTrigger(main: ProviderUsage, settings: AutoSwitchSettings, nowMs: number): Trigger | null {
  if (!current(main)) return null;
  let found: Trigger | null = null;
  for (const window of main.windows) {
    const threshold = thresholdOf(settings, window.id);
    if (!threshold.enabled || window.resetsAt <= 0 || window.resetsAt * 1000 <= nowMs) continue;
    const percent = effectivePercent(window, nowMs);
    if (percent < threshold.percent) continue;
    if (!found || percent > found.percent) found = { window: window.id, percent: Math.round(percent), resetsAt: window.resetsAt };
  }
  return found;
}

const blockedByLeft = (memory: AutoSwitchMemory, provider: UsageProvider, key: string, nowMs: number): boolean =>
  memory.left.some((mark) => mark.provider === provider && mark.key === key && mark.resetsAt * 1000 > nowMs);

/** A saved account whose sign-in and numbers can be trusted for a switch (no threshold check). */
function usableCopy(usage: ProviderUsage, provider: UsageProvider, nowMs: number, maxAgeMs: number): boolean {
  if (usage.provider !== provider || usage.active || !usage.managed) return false;
  if (usage.status !== 'ok' || usage.source !== 'live' || cardState(usage) !== 'ok') return false;
  if (nowMs - usage.fetchedAt > maxAgeMs) return false;
  // A copy the live login or an outside switch holds may be outdated; one cswap also holds is checked again by the swap.
  if (usage.heldBy && usage.heldBy !== 'cswap') return false;
  return usage.windows.length > 0 && !usage.windows.some((window) => effectivePercent(window, nowMs) >= 100);
}

/** Every enabled window below its threshold. */
const belowThresholds = (usage: ProviderUsage, settings: AutoSwitchSettings, nowMs: number): boolean =>
  usage.windows.every((window) => { const t = thresholdOf(settings, window.id); return !t.enabled || effectivePercent(window, nowMs) < t.percent; });

/**
 * Saved accounts of `provider` that could take over, best first: a usable copy read recently (`usableCopy`), every enabled
 * window below its threshold (in every mode: a switch never lands on an account over a threshold), and not left because of
 * a limit that has not reset yet (no ping-pong). The most room wins; equal room goes to the earlier reset.
 */
export function rankCandidates(providers: ProviderUsage[], provider: UsageProvider, settings: AutoSwitchSettings, memory: AutoSwitchMemory, nowMs: number, options: { ignoreLeft?: boolean; maxAgeMs?: number } = {}): ProviderUsage[] {
  const main = mainCard(providers, provider);
  const mainKey = main ? accountKey(main) : undefined;
  const maxAge = options.maxAgeMs ?? CANDIDATE_MAX_AGE_MS;
  const usable = providers.filter((usage) => {
    if (!usableCopy(usage, provider, nowMs, maxAge)) return false;
    const key = accountKey(usage);
    if (key === mainKey) return false;
    if (!options.ignoreLeft && blockedByLeft(memory, provider, key, nowMs)) return false;
    return belowThresholds(usage, settings, nowMs);
  });
  return usable.sort((a, b) => {
    const room = roomOf(b, nowMs) - roomOf(a, nowMs);
    if (Math.abs(room) >= ROOM_TIE) return room;
    const resetA = nextResetOf(a, nowMs);
    const resetB = nextResetOf(b, nowMs);
    if (resetA !== resetB) return resetA < resetB ? -1 : 1;
    return room !== 0 ? room : accountKey(a).localeCompare(accountKey(b));
  });
}

/** The chosen account only, when the settings name one for the provider; every candidate otherwise. */
const chosen = (candidates: ProviderUsage[], settings: AutoSwitchSettings, provider: UsageProvider) => {
  const target = settings.target[provider];
  return target ? candidates.filter((usage) => accountKey(usage) === target) : candidates;
};

/**
 * When the first account (main or saved) is back below the thresholds: for each the latest reset of its windows at or over a
 * threshold; the earliest of those. Undefined when nothing is known.
 */
export function nextAvailable(providers: ProviderUsage[], provider: UsageProvider, settings: AutoSwitchSettings, nowMs: number, onlyKey?: string): { email?: string; resetsAt: number } | undefined {
  let best: { email?: string; resetsAt: number } | undefined;
  for (const usage of providers) {
    if (usage.provider !== provider || (onlyKey && accountKey(usage) !== onlyKey) || cardState(usage) === 'expired' || !usage.windows.length) continue;
    const over = usage.windows.filter((window) => { const t = thresholdOf(settings, window.id); return t.enabled && effectivePercent(window, nowMs) >= t.percent && window.resetsAt * 1000 > nowMs; });
    if (!over.length) continue;
    const at = Math.max(...over.map((window) => window.resetsAt));
    if (!best || at < best.resetsAt) best = { ...(usage.email ? { email: usage.email } : {}), resetsAt: at };
  }
  return best;
}

export type AutoSwitchSkip = 'off' | 'noMain' | 'below' | 'cooldown' | 'offered' | 'noCandidate';
export type AutoSwitchPlan =
  | { kind: 'none'; reason: AutoSwitchSkip; from?: ProviderUsage; trigger?: Trigger }
  /** `reason: 'return'`: back to the primary account (no trigger: the main account may be fine). */
  | { kind: 'switch' | 'offer'; reason: 'limit' | 'return'; from: ProviderUsage; trigger?: Trigger; candidates: ProviderUsage[] }
  /** No account has room: told once per limit period of the main account, with the earliest account to become usable. */
  | { kind: 'exhausted'; from: ProviderUsage; trigger: Trigger; next?: { email?: string; resetsAt: number }; target?: string };

const told = (memory: AutoSwitchMemory, provider: UsageProvider, key: string, window: UsageWindow['id'], resetsAt: number) =>
  memory.offered.some((mark) => mark.provider === provider && mark.key === key && mark.window === window && Math.abs(mark.resetsAt - resetsAt) <= SAME_PERIOD_S);

/** Marks of the told notices (`offered`): an offer, a return offer and "all over the threshold" have their own keys. */
export const offerKey = (kind: 'limit' | 'return' | 'exhausted', key: string): string => (kind === 'limit' ? key : `${kind}:${key}`);

/**
 * What to do about `provider` after a new state of the accounts: nothing (and why), switch at once to the first of
 * `candidates` the family rules allow, offer that in a notification, or say that no account has room. Whether a swap or a
 * login runs is the caller's check.
 */
export function planAutoSwitch(input: { providers: ProviderUsage[]; provider: UsageProvider; settings: AutoSwitchSettings; memory: AutoSwitchMemory; nowMs: number }): AutoSwitchPlan {
  const { providers, provider, settings, memory, nowMs } = input;
  if (!autoSwitchOn(settings, provider)) return { kind: 'none', reason: 'off' };
  const from = mainCard(providers, provider);
  if (!from) return { kind: 'none', reason: 'noMain' };
  const last = memory.last[provider];
  const cooling = last !== undefined && nowMs >= last && nowMs - last < settings.cooldownMinutes * 60_000;
  const mode = settings.mode === 'switch' ? 'switch' as const : 'offer' as const;
  const key = accountKey(from);
  const candidates = rankCandidates(providers, provider, settings, memory, nowMs);
  // Back to the primary account once it was left and is usable again (its limit reset: the left mark is gone).
  const primary = settings.primary[provider];
  if (settings.returnHome && primary && memory.away[provider] === primary && key !== primary && !cooling) {
    const home = candidates.find((usage) => accountKey(usage) === primary);
    // A return offer is not repeated while its mark lasts (expired marks are pruned).
    const offeredBack = memory.offered.some((mark) => mark.provider === provider && mark.key === offerKey('return', primary) && mark.resetsAt * 1000 > nowMs);
    if (home && !(mode === 'offer' && offeredBack)) {
      return { kind: mode, reason: 'return', from, candidates: [home] };
    }
  }
  const trigger = switchTrigger(from, settings, nowMs);
  if (!trigger) return { kind: 'none', reason: 'below', from };
  if (cooling) return { kind: 'none', reason: 'cooldown', from, trigger };
  if (mode === 'offer' && told(memory, provider, offerKey('limit', key), trigger.window, trigger.resetsAt)) return { kind: 'none', reason: 'offered', from, trigger };
  const usable = chosen(candidates, settings, provider);
  if (!usable.length) {
    // "All accounts are over the threshold" only when that is known: some other saved account exists and none of them is
    // still waiting for its numbers (a card not read yet, a failed read) - those are looked at again with the next state.
    const others = providers.filter((usage) => usage.provider === provider && usage.managed && !usage.active && cardState(usage) !== 'expired' && (!settings.target[provider] || accountKey(usage) === settings.target[provider]));
    const unknown = others.some((usage) => usage.status !== 'ok' || usage.source !== 'live' || !usage.windows.length || nowMs - usage.fetchedAt > CANDIDATE_MAX_AGE_MS);
    if (!others.length || unknown) return { kind: 'none', reason: 'noCandidate', from, trigger };
    if (told(memory, provider, offerKey('exhausted', key), trigger.window, trigger.resetsAt)) return { kind: 'none', reason: 'noCandidate', from, trigger };
    const target = settings.target[provider];
    const next = nextAvailable(providers, provider, settings, nowMs, target);
    return { kind: 'exhausted', from, trigger, ...(next ? { next } : {}), ...(target ? { target } : {}) };
  }
  return { kind: mode, reason: 'limit', from, trigger, candidates: usable };
}

/**
 * The user's "switch now": the chosen account (`to`, an account key) or else every usable saved account with more room than
 * the main one, best first. Thresholds still apply (never to an account over one); the no-ping-pong marks do not.
 */
export function manualCandidates(providers: ProviderUsage[], provider: UsageProvider, settings: AutoSwitchSettings, nowMs: number, to?: string): ProviderUsage[] {
  const all = rankCandidates(providers, provider, settings, emptyAutoSwitchMemory(), nowMs, { ignoreLeft: true });
  if (to) return all.filter((usage) => accountKey(usage) === to);
  const main = mainCard(providers, provider);
  const mainRoom = main && current(main) && main.windows.length ? roomOf(main, nowMs) : -1;
  return all.filter((usage) => roomOf(usage, nowMs) > mainRoom);
}

/**
 * The memory after a switch (or an attempt) from `from` to `toKey`: the cooldown starts; an account left because of a limit
 * stays out until that limit resets; leaving the primary account remembers it (return home), reaching it forgets that.
 */
export function rememberSwitch(memory: AutoSwitchMemory, provider: UsageProvider, from: ProviderUsage, trigger: Trigger | undefined, nowMs: number, options: { toKey?: string; primary?: string } = {}): AutoSwitchMemory {
  const fromKey = accountKey(from);
  const left = trigger ? [...memory.left.filter((mark) => !(mark.provider === provider && mark.key === fromKey)), { provider, key: fromKey, window: trigger.window, resetsAt: trigger.resetsAt }] : memory.left;
  const away = { ...memory.away };
  if (options.toKey && options.toKey === options.primary) delete away[provider];
  else if (options.toKey && options.primary && fromKey === options.primary) away[provider] = options.primary;
  return prune({ ...memory, last: { ...memory.last, [provider]: nowMs }, left, away }, nowMs);
}

/** The memory after a notice (offer, return offer, "all over the threshold") was shown. */
export function rememberTold(memory: AutoSwitchMemory, provider: UsageProvider, key: string, window: UsageWindow['id'], resetsAt: number, nowMs: number): AutoSwitchMemory {
  return prune({ ...memory, offered: [...memory.offered, { provider, key, window, resetsAt }] }, nowMs);
}

/** The told mark of a return offer (it has no limit period: it is not repeated for a few hours). */
export const returnOfferMark = (nowMs: number): { window: '5h'; resetsAt: number } => ({ window: '5h', resetsAt: Math.floor(nowMs / 1000) + RETURN_OFFER_S });

function prune(memory: AutoSwitchMemory, nowMs: number): AutoSwitchMemory {
  const ahead = <T extends { resetsAt: number }>(marks: T[]) => marks.filter((mark) => mark.resetsAt * 1000 > nowMs).slice(-MAX_MARKS);
  return { last: memory.last, left: ahead(memory.left), offered: ahead(memory.offered), away: memory.away };
}

/** Reads a saved memory; damaged entries are dropped. */
export function normalizeAutoSwitchMemory(value: unknown): AutoSwitchMemory {
  if (!isObject(value)) return emptyAutoSwitchMemory();
  const last: AutoSwitchMemory['last'] = {};
  if (isObject(value.last)) for (const provider of ['claude', 'codex'] as const) {
    const at = value.last[provider];
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) last[provider] = at;
  }
  const marks = (raw: unknown): LeftMark[] => (Array.isArray(raw) ? raw : []).flatMap((m): LeftMark[] => {
    if (!isObject(m)) return [];
    const { provider, key, window, resetsAt } = m;
    if ((provider !== 'claude' && provider !== 'codex') || !isKey(key)) return [];
    if ((window !== '5h' && window !== '7d') || typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return [];
    return [{ provider, key, window, resetsAt }];
  }).slice(-MAX_MARKS);
  return { last, left: marks(value.left), offered: marks(value.offered), away: perProvider(value.away) };
}

/** An offer the limits panel shows until it is taken, dismissed or no longer true (renderer and main share it). */
export interface SwitchOffer {
  provider: UsageProvider;
  /** `return`: back to the primary account after its reset (no window, no percent). */
  reason: 'limit' | 'return';
  /** Card id of the proposed account (`claude:<record>` / `codex:<record>`). */
  to: string;
  toEmail?: string;
  fromEmail?: string;
  window?: UsageWindow['id'];
  percent?: number;
}

export type SwitchNoticeKind = 'switched' | 'returned' | 'offer' | 'returnOffer' | 'exhausted' | 'failed';
export interface SwitchNotice {
  kind: SwitchNoticeKind;
  provider: UsageProvider;
  fromEmail?: string;
  toEmail?: string;
  window?: UsageWindow['id'];
  percent?: number;
  /** `exhausted`: epoch seconds when the first account is usable again; `toEmail` names it. */
  resetsAt?: number;
  /** `exhausted` with a chosen target account (only that account was looked at). */
  targetOnly?: boolean;
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

const nameOf = (email: string | undefined, provider: UsageProvider) => (email || (provider === 'claude' ? 'Claude' : 'Codex')).slice(0, 60);

/** "21:00", or "pt., 7.11 o 21:00"-like for another day. */
export function resetClock(resetsAt: number, language: string, nowMs: number, tr: Translate): string {
  const at = new Date(resetsAt * 1000);
  const time = at.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date(nowMs).toDateString()) return time;
  return tr('{date} o {time}', { date: at.toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'numeric' }), time });
}

/** What the notifications and the panel say about a switch, an offer, no room anywhere or a failed attempt. */
export function autoSwitchText(event: SwitchNotice, tr: Translate, language = 'pl', nowMs = Date.now()): { title: string; body: string } {
  const title = tr('Konta i limity');
  const to = nameOf(event.toEmail, event.provider);
  const from = nameOf(event.fromEmail, event.provider);
  const window = event.window === '7d' ? tr('7 dni') : '5 h';
  const percent = event.percent ?? 0;
  switch (event.kind) {
    case 'switched': return { title, body: tr('Przełączono na {to}: limit {window} konta {from} wykorzystany w {percent}%', { to, from, window, percent }) };
    case 'returned': return { title, body: tr('Wrócono na konto podstawowe {to}: jego limit znowu jest dostępny', { to }) };
    case 'offer': return { title, body: tr('Limit {window} konta {from} wykorzystany w {percent}%. Konto {to} ma zapas.', { to, from, window, percent }) };
    case 'returnOffer': return { title, body: tr('Konto podstawowe {to} znowu ma zapas.', { to }) };
    case 'exhausted': {
      const when = event.resetsAt ? resetClock(event.resetsAt, language, nowMs, tr) : '';
      if (event.targetOnly) return { title, body: when ? tr('Wybrane konto {to} też przekroczyło próg, reset {time}. Konto główne zostaje bez zmian.', { to, time: when }) : tr('Wybrane konto {to} nie może teraz przejąć pracy. Konto główne zostaje bez zmian.', { to }) };
      return { title, body: when ? tr('Wszystkie konta przekroczyły próg, najbliższy reset: {to} o {time}', { to, time: when }) : tr('Wszystkie konta przekroczyły próg. Konto główne zostaje bez zmian.') };
    }
    case 'failed': return { title, body: tr('Nie udało się przełączyć na {to}. Konto główne zostało bez zmian.', { to }) };
  }
}

/** The subtle state line of the limits panel: "Switcher: wł. · wraca na A" / "Switcher: wył.". */
export function autoSwitchStatus(settings: AutoSwitchSettings, provider: UsageProvider, memory: Pick<AutoSwitchMemory, 'away'> | undefined, tr: Translate): string {
  if (!autoSwitchOn(settings, provider)) return tr('Switcher: wył.');
  const parts = [tr('Switcher: wł.')];
  const target = settings.target[provider];
  parts.push(target ? tr('na {account}', { account: target }) : tr('największy zapas'));
  const primary = settings.primary[provider];
  if (primary && settings.returnHome) parts.push(memory?.away[provider] === primary ? tr('wraca na {account}', { account: primary }) : tr('podstawowe: {account}', { account: primary }));
  return parts.join(' · ');
}
