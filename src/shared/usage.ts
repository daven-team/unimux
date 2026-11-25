/** Limits of the user's Claude and Codex accounts: types and pure helpers shared by main process and window. */
import type { AccountNotice } from './accounts';
import type { SwitchOffer } from './autoSwitch';
export type UsageProvider = 'claude' | 'codex';
export type UsageStatus = 'ok' | 'signedOut' | 'expired' | 'dormant' | 'apiKey' | 'error' | 'elsewhere' | 'forbidden' | 'lapsed';
/* `dormant`: the main Claude login's access token is past its expiry but a refresh token exists; Claude Code renews it on next use. Not an error. */
/* `elsewhere`: a saved account whose tokens this app must not renew (R6) and whose access token ran out. */
/* forbidden: the usage endpoint answered 403 (e.g. a paused subscription); the sign-in itself is valid. */
/* lapsed (1.2.6): a 403 and the account's OAuth profile says its subscription lapsed (canceled, free tier): no limits to show. */
export type UsageSource = 'live' | 'log' | 'cache';

export interface UsageWindow {
  id: '5h' | '7d';
  /** 0 to 100 as reported when the data was read. */
  usedPercent: number;
  /** Epoch seconds when the window resets; 0 when the provider reports no active window. */
  resetsAt: number;
}

/** One account whose limits are tracked; `configDir` is set for a saved Claude profile and absent for the live login. */
export interface AccountRef {
  id: string;
  provider: UsageProvider;
  configDir?: string;
  /** Identity key (shared/accounts identityKey): cache, backoff and read spacing follow the account, never the card slot. */
  key?: string;
  /** The account signed in to Claude Code. */
  active?: boolean;
  /** Saved Claude account: whether this app may renew its tokens, and why not (R6). */
  renew?: 'allowed' | 'held-by-live' | 'held-by-cswap' | 'switched-out';
  /** Saved Claude account: SHA-256 of the refresh token known dead (`ManagedAccount.deadTokens`); main process only. */
  deadTokens?: string;
}

export const MAIN_ACCOUNTS: AccountRef[] = [
  { id: 'claude:main', provider: 'claude' },
  { id: 'codex:main', provider: 'codex' },
];

export interface ProviderUsage {
  accountId: string;
  provider: UsageProvider;
  status: UsageStatus;
  plan?: string;
  email?: string;
  org?: string;
  /** The account lives in an isolated profile managed by this app. */
  managed?: boolean;
  windows: UsageWindow[];
  /** Epoch milliseconds of the read this data comes from. */
  fetchedAt: number;
  source: UsageSource;
  /** Short machine-readable reason (for example `http-429`, `refresh-http-429`, `bad-response`); never a token. */
  error?: string;
  /** Epoch milliseconds of the last attempt to read this account (fetchedAt stays the time of the last good data). */
  attemptAt?: number;
  /** Epoch milliseconds before which the service will not try again after a failure. */
  retryAt?: number;
  /** The account signed in to Claude Code (the "main" badge). */
  active?: boolean;
  /** Why this saved account's tokens are not renewed here: the live login, cswap or an outside switch holds the newest copy. */
  heldBy?: 'live' | 'cswap' | 'switched-out';
  /** 1.2.6: epoch ms when the stored Claude login ends (`refreshTokenExpiresAt`); absent when the file does not say. */
  loginExpiresAt?: number;
  /** 1.2.7: the subscription state the OAuth profile reported after a 403 (`past_due`, `canceled`, ...). */
  subscription?: string;
  /** 1.2.7: the claude.ai page that pays the overdue invoice of an unpaid subscription. */
  paymentUrl?: string;
}

/** 1.2.7: the profile says the subscription is not paid (`past_due`, `unpaid`): refused until it is paid. */
export const unpaidSubscription = (usage: Pick<ProviderUsage, 'subscription'>): boolean => usage.subscription === 'past_due' || usage.subscription === 'unpaid';

const HELD_BY = { 'held-by-live': 'live', 'held-by-cswap': 'cswap', 'switched-out': 'switched-out' } as const;

/** Why a saved account's tokens are not renewed (the card's `heldBy`), from its renewal rule; undefined when renewal is allowed. */
export function heldByOf(renew: AccountRef['renew']): ProviderUsage['heldBy'] {
  return renew && renew !== 'allowed' ? HELD_BY[renew] : undefined;
}

/**
 * "Make main account" is offered on a saved Claude card that is not the main one and not held by the live login or an
 * outside switch. A copy cswap may hold too is offered as well: the main process swaps it in while its access token is
 * fresh and otherwise refuses with a text that says what to do.
 */
export function makeMainOffered(usage: Pick<ProviderUsage, 'provider' | 'managed' | 'active' | 'heldBy'> & { status?: UsageStatus }): boolean {
  // An expired sign-in (also a held copy whose access token ran out) cannot become the main one: its card offers signing in again.
  return usage.provider === 'claude' && !!usage.managed && !usage.active && usage.status !== 'expired' && usage.status !== 'elsewhere' && usage.status !== 'lapsed' && (!usage.heldBy || usage.heldBy === 'cswap');
}

/**
 * "Renew this copy in unimux" is offered only on a saved Claude card that is not the main one and that the app does not
 * renew because cswap lists the account (`held-by-cswap`); an expired sign-in only offers signing in again.
 */
export function adoptCopyOffered(usage: Pick<ProviderUsage, 'provider' | 'managed' | 'active' | 'heldBy' | 'status'>): boolean {
  return usage.provider === 'claude' && !!usage.managed && !usage.active && usage.heldBy === 'cswap' && usage.status !== 'expired';
}

/** A saved Claude card set aside after a failed restore of its previous sign-in (not renewed, not polled, not deleted). */
export interface SetAsideAccount {
  recordId: string;
  email?: string;
  /** The app still holds the card's previous sign-in and retries the restore (until it quits). */
  restoring: boolean;
}

export interface UsageState {
  providers: ProviderUsage[];
  notices?: AccountNotice[];
  /** Path of accounts.json when it cannot be read safely: the app writes nothing to it (no logins saved, no removals). */
  accountsReadOnly?: string;
  setAside?: SetAsideAccount[];
  /** Records set aside as a second copy of an account whose holder still exists: only these offer "Delete copy". */
  duplicateCopies?: string[];
  /** 1.1.2: an automatic switch the user is asked about ("Switch to X"), until taken, hidden or no longer true. */
  switchOffer?: SwitchOffer;
  /** 1.1.2: per provider, the primary account the automatic switch left and returns to (the panel's state line). */
  switchAway?: Partial<Record<UsageProvider, string>>;
}

export const USAGE_INTERVALS_MINUTES = [1, 5, 15] as const;

export type UsageBand = 'low' | 'mid' | 'high';

export const clampPercent = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

/** A window that already reset counts as unused until fresh data arrives. */
export function effectivePercent(window: UsageWindow, nowMs: number): number {
  return window.resetsAt > 0 && window.resetsAt * 1000 <= nowMs ? 0 : clampPercent(window.usedPercent);
}

export const usageBand = (percent: number): UsageBand => (percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low');

export function worstPercent(usage: ProviderUsage, nowMs: number): number {
  return usage.windows.reduce((worst, window) => Math.max(worst, effectivePercent(window, nowMs)), 0);
}

/** "2 h 13 min", "6 d 8 h", "12 min", "<1 min". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  return minutes > 0 ? `${minutes} min` : '<1 min';
}

/** Compact countdown for tight spots: "4h 2m", "5d 13h", "12m", "<1m". */
export function shortDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return minutes > 0 ? `${minutes}m` : '<1m';
}

/** Part of the e-mail before "@", cut to `max` characters; falls back to `fallback` when there is no e-mail. */
export function shortAccountName(email: string | undefined, fallback: string, max = 12): string {
  const local = email?.split('@')[0]?.trim();
  return local ? local.slice(0, max) : fallback;
}

/**
 * The few states a limits card can be in (1.0.10); every underlying reason maps onto one of them, so the same situation
 * always looks the same and offers the same action:
 * - `ok`: current limits;
 * - `stale`: limits from an earlier read (cached, Claude Code renews the token on next use, a temporary failure), with
 *   their age in one short line;
 * - `expired`: sign-in expired - one "Sign in again" button and nothing else. Any card whose limits can only come back
 *   through a new sign-in: a rejected renewal, a main login Claude Code cleared as dead, a dead copy, and a saved copy the
 *   app may not renew (switched out elsewhere, or a copy cswap also holds) whose access token ran out;
 * - `unavailable`: no numbers right now (temporary failure, access denied), one short line;
 * - `apiKey`: Codex with an API key, which has no limits;
 * - `lapsed` (1.2.6): the subscription lapsed - no limits, the card offers removing the account;
 * - `denied` (1.2.7): access denied (403) - laid out like `expired`: no bars (old numbers would look current), one line and
 *   "Sign in again"; when that does not help, the account can only be removed.
 */
export type CardState = 'ok' | 'stale' | 'expired' | 'unavailable' | 'apiKey' | 'lapsed' | 'denied';

/**
 * 1.2.7 (claude-swap 1.2.0's `[org]` tag): the organisation name a card shows beside its e-mail, only when another card has
 * the same e-mail (case-insensitive), e.g. a personal Max and a Team seat on one address; undefined otherwise.
 */
export function orgTag(usage: Pick<ProviderUsage, 'accountId' | 'email' | 'org'>, cards: Pick<ProviderUsage, 'accountId' | 'email'>[]): string | undefined {
  const email = usage.email?.trim().toLowerCase();
  if (!email || !usage.org) return undefined;
  return cards.some((c) => c.accountId !== usage.accountId && c.email?.trim().toLowerCase() === email) ? usage.org : undefined;
}

export function cardState(usage: Pick<ProviderUsage, 'status' | 'windows' | 'source' | 'heldBy'>): CardState {
  if (usage.status === 'apiKey') return 'apiKey';
  if (usage.status === 'expired') return 'expired';
  if (usage.status === 'lapsed') return 'lapsed';
  if (usage.status === 'forbidden') return 'denied';
  // Held only by the live login (its numbers are on the main card) is not a sign-in problem.
  if (usage.status === 'elsewhere' && usage.heldBy !== 'live') return 'expired';
  if (!usage.windows.length) return 'unavailable';
  return usage.status === 'ok' && usage.source === 'live' ? 'ok' : 'stale';
}

/** Accounts that show numbers: not signed out, not an expired sign-in (old numbers never pass as current), with windows or ok. */
export function summaryAccounts(providers: ProviderUsage[]): ProviderUsage[] {
  return providers.filter((u) => u.status !== 'signedOut' && u.status !== 'apiKey' && cardState(u) !== 'expired' && cardState(u) !== 'lapsed' && cardState(u) !== 'denied' && (u.status === 'ok' || u.windows.length > 0));
}

/** "Claude 17% · Claude 40% · Codex 8%"; several Claude accounts are told apart by the e-mail name. Empty when nothing to show. */
export function usageSummary(providers: ProviderUsage[], nowMs: number): string {
  const shown = summaryAccounts(providers);
  const claudeCount = providers.filter((u) => u.provider === 'claude' && u.status !== 'signedOut').length;
  return shown.map((u) => {
    const base = u.provider === 'claude' ? 'Claude' : 'Codex';
    const name = u.provider === 'claude' && claudeCount > 1 ? shortAccountName(u.email, base) : base;
    return `${name} ${Math.round(worstPercent(u, nowMs))}%`;
  }).join(' · ');
}

/** What the usage panel offers for logging in to Claude on a platform (macOS cannot use isolated profiles: Keychain). */
export function claudeLoginActions(platform: string, hasMainClaude: boolean): {
  /** Entry in the "+" menu: sign in the main login (macOS) or add a managed account (elsewhere), or null. */
  menu: 'main' | 'new' | null;
  /** Login target of the empty-state Claude button. */
  emptyTarget: 'main' | 'new';
  /** Managed-account actions (make main, relogin of saved accounts) are available. */
  managedAccounts: boolean;
} {
  const mac = platform === 'darwin';
  return {
    menu: mac ? (hasMainClaude ? null : 'main') : 'new',
    emptyTarget: mac ? 'main' : 'new',
    managedAccounts: !mac,
  };
}

export type UsageErrorKind = 'rate' | 'server' | 'network' | 'parse' | 'empty' | 'refresh' | 'refreshLimited' | 'blocked' | 'other';

/** Groups the machine-readable reason of a failed read into what the card tells the user. */
export function usageErrorKind(code?: string): UsageErrorKind {
  if (!code) return 'other';
  if (code === 'refresh-http-429') return 'refreshLimited';
  if (code === 'http-429') return 'rate';
  if (/^http-5\d\d$/.test(code)) return 'server';
  if (code === 'network' || code === 'timeout') return 'network';
  if (code === 'bad-response') return 'parse';
  if (code === 'no-windows') return 'empty';
  if (code === 'refresh-blocked') return 'blocked';
  if (code.startsWith('refresh-')) return 'refresh';
  return 'other';
}

/** HTTP status contained in a reason code (`http-429`, `refresh-http-503`), if any. */
export function usageHttpStatus(code?: string): number | undefined {
  const match = code ? /(?:^|-)http-(\d{3})$/.exec(code) : null;
  return match ? Number(match[1]) : undefined;
}

/** How a bug report names an account: its role, never its e-mail ("claude main", "claude saved #2", "codex"). */
export function diagnosticLabel(usage: Pick<ProviderUsage, 'provider' | 'managed'>, savedIndex = 1): string {
  if (usage.provider === 'codex') return 'codex';
  return usage.managed ? `claude saved #${Math.max(1, savedIndex)}` : 'claude main';
}

/** Short text for bug reports: reason, status and ages only. Never contains tokens or e-mails; `label` names the account (see `diagnosticLabel`). */
export function usageDiagnostics(usage: ProviderUsage, nowMs: number, label: string, intervalMinutes?: number): string {
  const age = (at?: number) => (at === undefined ? 'n/a' : `${formatDuration((nowMs - at) / 1000)} ago`);
  return [
    `account: ${label}`,
    `provider: ${usage.provider}${usage.managed ? ' (saved account)' : ''}${usage.plan ? `, plan ${usage.plan}` : ''}`,
    `state: ${usage.status}`,
    `reason: ${usage.error ?? 'none'}`,
    `http status: ${diagnosticHttpStatus(usage)}`,
    `active login: ${usage.active ? 'yes' : 'no'}`,
    `renewal: ${usage.heldBy ? `held (${usage.heldBy})` : 'allowed'}`,
    `data source: ${usage.source}, last good data ${age(usage.fetchedAt)}`,
    `last attempt: ${age(usage.attemptAt)}`,
    `next attempt: ${diagnosticNextAttempt(usage, nowMs, intervalMinutes)}`,
    `windows: ${usage.windows.length ? usage.windows.map((w) => `${w.id} ${Math.round(w.usedPercent)}%`).join(', ') : 'none'}`,
    `subscription: ${usage.subscription ?? 'n/a'}`,
    `login ends: ${usage.loginExpiresAt === undefined ? 'n/a' : usage.loginExpiresAt <= nowMs ? 'passed' : `in ${formatDuration((usage.loginExpiresAt - nowMs) / 1000)}`}`,
  ].join('\n');
}

/**
 * 1.2.7: the HTTP answer of the latest read: the code a failure names, 200 for a good live read, "no answer (reason)" for a
 * failure without one (network, timeout, a renewal), n/a when no read happened (numbers from the cache or a session log).
 */
function diagnosticHttpStatus(usage: ProviderUsage): string {
  const code = usageHttpStatus(usage.error);
  if (code !== undefined) return String(code);
  if (usage.error) return `no answer (${usage.error})`;
  if (usage.status === 'ok' && usage.source === 'live') return '200';
  return 'n/a';
}

/**
 * 1.2.7: when the account is read next: a hold's end (after a failure or a refusal), else the next regular read (the last
 * attempt plus the read interval), "due" once that time passed, n/a without either.
 */
function diagnosticNextAttempt(usage: ProviderUsage, nowMs: number, intervalMinutes?: number): string {
  const at = (ms: number, what: string) => (ms <= nowMs ? `due (${what})` : `in ${formatDuration((ms - nowMs) / 1000)} (${what})`);
  if (usage.retryAt !== undefined) return at(usage.retryAt, 'after the hold');
  if (intervalMinutes !== undefined && intervalMinutes > 0) {
    const last = usage.attemptAt ?? usage.fetchedAt;
    return at(last + intervalMinutes * 60_000, `regular read every ${intervalMinutes} min`);
  }
  return 'n/a';
}

/** 1.2.6: how long before the stored login ends the card warns ("Sign in again in 5 d 12 h"). */
export const LOGIN_END_WARN_MS = 7 * 86_400_000;

/**
 * 1.2.6: the heads-up about a stored Claude login that ends soon (`soon`, with the time left) or already ended (`ended`);
 * undefined when the file does not say, the end is more than a week away, or the card already says the sign-in expired.
 */
export function loginEndNotice(usage: Pick<ProviderUsage, 'provider' | 'status' | 'windows' | 'source' | 'loginExpiresAt' | 'heldBy'>, nowMs: number): { kind: 'soon'; leftMs: number } | { kind: 'ended' } | undefined {
  const end = usage.loginExpiresAt;
  if (usage.provider !== 'claude' || end === undefined || !Number.isFinite(end) || end <= 0) return undefined;
  // An expired sign-in already offers signing in again; a copy held by the live login is told on the main card.
  if (cardState(usage) === 'expired' || cardState(usage) === 'denied' || usage.heldBy === 'live') return undefined;
  const left = end - nowMs;
  if (left <= 0) return { kind: 'ended' };
  return left <= LOGIN_END_WARN_MS ? { kind: 'soon', leftMs: left } : undefined;
}

/** The card states whose card can be removed from the panel: an expired sign-in, (1.2.6) a lapsed subscription and (1.2.7) access denied. */
export const removableCardState = (state: CardState): boolean => state === 'expired' || state === 'lapsed' || state === 'denied';

/**
 * 1.2.5: "Usuń konto" on the card of an expired main login (Claude Code's or Codex CLI's own sign-in, which the app does not
 * own and never deletes) takes the card off the panel. The key names the account and its e-mail, so the card comes back as
 * soon as that login works again or another account signs in there.
 */
export const removedCardKey = (u: Pick<ProviderUsage, 'accountId' | 'email'>): string => `${u.accountId}|${u.email ?? ''}`;

/** The cards to show, and the removed keys still worth keeping (a key whose login works again, or holds another account, goes). */
export function withoutRemovedCards(list: ProviderUsage[], removed: readonly string[]): { cards: ProviderUsage[]; removed: string[] } {
  const keys = new Set(removed);
  const cards = list.filter((u) => !(keys.has(removedCardKey(u)) && removableCardState(cardState(u))));
  const kept = removed.filter((key) => {
    const card = list.find((u) => key.startsWith(`${u.accountId}|`));
    return !card || (removedCardKey(card) === key && removableCardState(cardState(card)));
  });
  return { cards, removed: kept };
}
