/**
 * 1.1.1: limit warnings as OS notifications. Pure: which account windows crossed their threshold (once per account, window
 * and reset period), which of those reset since, and the memory that keeps both across restarts.
 */
import type { LimitAlertSettings } from './alerts';
import type { MessageKey, MessageParams } from './i18n';
import { cardState, clampPercent, type ProviderUsage, type UsageProvider, type UsageWindow } from './usage';

/** One account window seen above nothing yet (`notified: false`) or already told about in its current reset period. */
export interface LimitMark {
  provider: UsageProvider;
  /** Shown in the reset notification; never a token. */
  email?: string;
  /** Epoch seconds when the period the mark is about ends. */
  resetsAt: number;
  notified: boolean;
}

/** Keyed by `limitKey()`: provider, account (e-mail, else card id) and window. */
export type LimitMemory = Record<string, LimitMark>;

export interface LimitNotice {
  kind: 'threshold' | 'reset';
  provider: UsageProvider;
  email?: string;
  window: UsageWindow['id'];
  /** Used percent (threshold notices). */
  percent?: number;
  /** Epoch seconds of the reset. */
  resetsAt: number;
}

/** A reset time that moved by more than this is another period (the endpoints report the same period with some jitter). */
const SAME_PERIOD_S = 10 * 60;
/** A reset older than this when it is noticed (the app was closed or asleep) is not announced any more. */
export const RESET_NOTICE_MAX_AGE_MS = 60 * 60_000;
const MAX_MARKS = 200;

export function limitKey(usage: Pick<ProviderUsage, 'provider' | 'email' | 'accountId'>, window: UsageWindow['id']): string {
  return `${usage.provider}:${(usage.email || usage.accountId).toLowerCase()}:${window}`;
}

const thresholdOf = (settings: LimitAlertSettings, window: UsageWindow['id']) => (window === '5h' ? settings.fiveHour : settings.sevenDay);

/** Numbers that are current enough to warn about: a valid sign-in read now (never remembered numbers, never an expired card). */
function warnable(usage: ProviderUsage): boolean {
  return usage.status === 'ok' && usage.source !== 'cache' && cardState(usage) !== 'expired';
}

/**
 * The notices for a new state of the accounts and the memory after it. A window that reaches its threshold is told once in its
 * reset period; a new period re-arms it. A disabled group or window looks at nothing (its marks stay as they were).
 */
export function evaluateLimits(memory: LimitMemory, providers: ProviderUsage[], settings: LimitAlertSettings, nowMs: number): { memory: LimitMemory; notices: LimitNotice[] } {
  // Periods that ended go first (with their "available again" notices), so a new period starts from a clean mark.
  const resets = dueResets(memory, providers, settings, nowMs);
  const next: LimitMemory = resets.memory;
  const notices: LimitNotice[] = [...resets.notices];
  if (settings.enabled) {
    for (const usage of providers) {
      if (!warnable(usage)) continue;
      for (const window of usage.windows) {
        const threshold = thresholdOf(settings, window.id);
        // A window without an active period (0) or one already past its reset has no current numbers.
        if (!threshold.enabled || window.resetsAt <= 0 || window.resetsAt * 1000 <= nowMs) continue;
        const key = limitKey(usage, window.id);
        const mark = next[key];
        const samePeriod = !!mark && mark.resetsAt * 1000 > nowMs && Math.abs(window.resetsAt - mark.resetsAt) <= SAME_PERIOD_S;
        const current: LimitMark = samePeriod
          ? { ...mark, resetsAt: window.resetsAt, ...(usage.email ? { email: usage.email } : {}) }
          : { provider: usage.provider, ...(usage.email ? { email: usage.email } : {}), resetsAt: window.resetsAt, notified: false };
        const percent = clampPercent(window.usedPercent);
        if (!current.notified && percent >= threshold.percent) {
          current.notified = true;
          notices.push({ kind: 'threshold', provider: usage.provider, ...(usage.email ? { email: usage.email } : {}), window: window.id, percent: Math.round(percent), resetsAt: window.resetsAt });
        }
        // Nothing to remember for a window below its threshold whose period was not told about.
        if (current.notified || mark) next[key] = current;
      }
    }
  }
  return { memory: prune(next, nowMs), notices };
}

/**
 * Windows told about whose reset time passed: their marks go (the next period starts fresh) and, with `resets` on, each gets an
 * "available again" notice - not for an account whose sign-in expired since, and not for a reset long past.
 */
export function dueResets(memory: LimitMemory, providers: ProviderUsage[], settings: LimitAlertSettings, nowMs: number): { memory: LimitMemory; notices: LimitNotice[] } {
  const next: LimitMemory = { ...memory };
  const notices: LimitNotice[] = [];
  for (const [key, mark] of Object.entries(memory)) {
    if (mark.resetsAt * 1000 > nowMs) continue;
    delete next[key];
    if (!mark.notified || !settings.enabled || !settings.resets || nowMs - mark.resetsAt * 1000 > RESET_NOTICE_MAX_AGE_MS) continue;
    const window = key.endsWith(':5h') ? '5h' : '7d';
    if (!thresholdOf(settings, window).enabled) continue;
    const account = providers.find((usage) => limitKey(usage, window) === key);
    if (account && cardState(account) === 'expired') continue;
    notices.push({ kind: 'reset', provider: mark.provider, ...(mark.email ? { email: mark.email } : {}), window, resetsAt: mark.resetsAt });
  }
  return { memory: next, notices };
}

/** When the next notified window resets (epoch ms), for the reset timer; undefined when none. */
export function nextReset(memory: LimitMemory): number | undefined {
  const times = Object.values(memory).filter((mark) => mark.notified).map((mark) => mark.resetsAt * 1000);
  return times.length ? Math.min(...times) : undefined;
}

/** Keeps the memory small: the marks of the latest periods only. */
function prune(memory: LimitMemory, nowMs: number): LimitMemory {
  const entries = Object.entries(memory).filter(([, mark]) => mark.resetsAt * 1000 > nowMs - RESET_NOTICE_MAX_AGE_MS);
  return Object.fromEntries(entries.sort(([, a], [, b]) => b.resetsAt - a.resetsAt).slice(0, MAX_MARKS));
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Reads a saved memory; damaged entries are dropped. */
export function normalizeLimitMemory(value: unknown): LimitMemory {
  if (!isRecord(value)) return {};
  const out: LimitMemory = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^(claude|codex):.{1,160}:(5h|7d)$/.test(key) || !isRecord(raw)) continue;
    const { provider, email, resetsAt, notified } = raw;
    if ((provider !== 'claude' && provider !== 'codex') || typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0 || typeof notified !== 'boolean') continue;
    out[key] = { provider, ...(typeof email === 'string' && email && email.length <= 120 ? { email } : {}), resetsAt, notified };
  }
  return out;
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * Title and body of a notice: "Konto support@example.com: limit 5 h wykorzystany w 82%, reset o 21:00" (a reset on another day
 * names the day too), or "Konto support@example.com: limit 5 h znowu dostępny".
 */
export function limitNoticeText(notice: LimitNotice, tr: Translate, language: string, nowMs: number): { title: string; body: string } {
  const account = (notice.email || (notice.provider === 'claude' ? 'Claude' : 'Codex')).slice(0, 60);
  const window = notice.window === '5h' ? '5 h' : tr('7 dni');
  const title = tr('Limity kont AI');
  if (notice.kind === 'reset') return { title, body: tr('Konto {account}: limit {window} znowu dostępny', { account, window }) };
  const at = new Date(notice.resetsAt * 1000);
  const time = at.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  const params = { account, window, percent: notice.percent ?? 0, time };
  if (at.toDateString() === new Date(nowMs).toDateString()) return { title, body: tr('Konto {account}: limit {window} wykorzystany w {percent}%, reset o {time}', params) };
  const date = at.toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'numeric' });
  return { title, body: tr('Konto {account}: limit {window} wykorzystany w {percent}%, reset {date} o {time}', { ...params, date }) };
}
