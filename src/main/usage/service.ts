// src/main/usage/service.ts
import { mkdirSync, readFileSync } from 'fs';
import { atomicWriteFileSync } from '../atomicWrite';
import { dirname } from 'path';
import type { AccountNotice } from '../../shared/accounts';
import { heldByOf, type AccountRef, type ProviderUsage, type UsageState } from '../../shared/usage';
import type { FetchResult } from './fetchers';
import { sanitizeUsage } from './sanitize';

export const MIN_GAP_MS = 20_000;
/** At most one read of an account in this window: the usage endpoint allows about 28-30 reads an hour per account and client. */
export const MIN_IDENTITY_GAP_MS = 180_000;
/**
 * The first run after a start and the refresh button read every account at once, except one read in this short window
 * (a quick restart loop, a double click); rate-limit holds stay in force.
 */
export const EAGER_GUARD_MS = 30_000;
/** Added to the Retry-After of a 429: the limit often re-triggers right after the stated deadline (cswap's measured value). */
export const RETRY_AFTER_MARGIN_MS = 15 * 60_000;
const WATCH_MS = 20_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
/** Any rate limit (the usage endpoint or a token renewal): such a hold is never bypassed by the refresh button. */
const RATE_LIMITED = /(?:^|-)http-429$/;
/** Only the usage endpoint's own 429 gets the Retry-After margin (a token renewal's backoff is its own). */
const USAGE_LIMITED = /^http-429$/;
const CACHE_VERSION = 2;
/** A 403 (access denied, e.g. a paused subscription) does not go away in minutes: the account is asked again after this. */
const FORBIDDEN_HOLD_MS = 30 * 60_000;
/** The card id of the live Claude login in 0.9.0; as a refresh subject it means the live Claude card, whatever its id. */
const LIVE_CARD = 'claude:main';

/** A running backoff; its reason and attempt time let a restarted app show the same calm card instead of a fresh retry. */
interface Backoff { until: number; failures: number; error?: string; attemptAt?: number }

export interface UsageServiceOptions {
  /** The accounts to poll right now; read on every run and every state read, so changes apply without a restart. */
  accounts(): AccountRef[];
  fetchAccount(ref: AccountRef): Promise<FetchResult>;
  /** Where the last good result is remembered (no credentials are stored there). */
  cacheFile: string;
  enabled(): boolean;
  /** Polling interval in milliseconds; 0 or less disables polling. */
  intervalMs(): number;
  now?(): number;
  /** Change marker of an account's credentials file (null when unknown). */
  credentialsStamp?(ref: AccountRef): Promise<string | null>;
  /** Poll period of that marker; defaults to 20 s. */
  watchMs?: number;
  /** Runs before every poll (reconciles the live Claude login with the saved accounts); a failure never stops the poll. */
  beforeRun?(): Promise<void>;
  /** Watch the live Claude login's file also while it is fine: an external switch or `/login` is picked up within watchMs. */
  watchLive?: boolean;
  /** Minimum time between two reads of one account (default MIN_IDENTITY_GAP_MS). */
  minIdentityGapMs?: number;
  /** Added to the Retry-After of a 429 (default RETRY_AFTER_MARGIN_MS). */
  retryAfterMarginMs?: number;
  /** Notices about the saved accounts, sent with every state. */
  notices?(): AccountNotice[];
  /** The saved accounts file's read-only state and the set-aside cards, sent with every state. */
  accountsInfo?(): Pick<UsageState, 'accountsReadOnly' | 'setAside' | 'duplicateCopies'>;
  /** Keep polling on the interval while the window is hidden or minimized (1.1.1: limit warnings are on). */
  pollHidden?(): boolean;
  /** E-mail of the account signed in to Claude Code, when known: lets a 0.9.0 cache entry of the live card be checked. */
  liveEmail?(): string | undefined;
}

/**
 * Owns the provider state: polling, spacing of reads, backoff after failures, on-disk cache. Everything is keyed by the
 * account (`AccountRef.key`, else the card id), never by the card slot: a switched main card never shows the previous
 * account's numbers or inherits its backoff.
 */
export class UsageService {
  private readonly providers = new Map<string, ProviderUsage>();
  private readonly listeners = new Set<(state: UsageState) => void>();
  private readonly backoff = new Map<string, Backoff>();
  /** When each account was last read (kept across restarts in the cache file). */
  private readonly lastRead = new Map<string, number>();
  /** Whether that read used a saved profile (true) or the live login (false); in memory only. */
  private readonly readAsProfile = new Map<string, boolean>();
  /** Accounts an action was about (added, signed in again, made main): read at the next run whatever the spacing. */
  private readonly subjects = new Set<string>();
  /** A 0.9.0 cache, keyed by card id, until its entries found their accounts (first run). */
  private readonly legacyUsage = new Map<string, ProviderUsage>();
  private readonly legacyHold = new Map<string, Backoff>();
  /** The 0.9.0 live card's numbers: given to the live account only once a read shows the same e-mail. */
  private legacyLive: { key: string; usage: ProviderUsage } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly stamps = new Map<string, string | null>();
  private watcher: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<UsageState> | undefined;
  private followUp: Promise<UsageState> | undefined;
  /** Whether any caller that joined the follow-up run was manual (the refresh button). */
  private followUpManual = false;
  /** The next run reads every account at once (the refresh button), with only the short EAGER_GUARD_MS guard. */
  private eagerRequested = false;
  /** No run yet in this process: the first one is eager (persisted read times of the previous process mostly do not count). */
  private firstRun = true;
  private lastRun = 0;
  private running = false;
  private active = true;
  private readonly now: () => number;

  constructor(private readonly options: UsageServiceOptions) {
    this.now = options.now ?? Date.now;
    this.loadCache();
  }

  private keyOf(ref: AccountRef): string { return ref.key ?? ref.id; }

  /** The listed accounts, with any 0.9.0 cache entries moved to their accounts first. */
  private refs(afterReconcile = false): AccountRef[] {
    const refs = this.options.accounts();
    this.adoptLegacy(refs, afterReconcile);
    return refs;
  }

  getState(): UsageState {
    const providers = this.refs().flatMap((ref) => {
      const usage = this.providers.get(this.keyOf(ref));
      if (!usage) return [];
      // The card's slot and role are the current ones, whatever they were when the numbers were read.
      const { active: _active, heldBy: _heldBy, managed: _managed, ...rest } = usage;
      const heldBy = ref.configDir ? heldByOf(ref.renew) : undefined;
      return [{ ...rest, accountId: ref.id, ...(ref.configDir ? { managed: true } : {}), ...(ref.active ? { active: true } : {}), ...(heldBy ? { heldBy } : {}) }];
    });
    const notices = this.options.notices?.() ?? [];
    const info = this.options.accountsInfo?.() ?? {};
    return {
      providers,
      ...(notices.length ? { notices } : {}),
      ...(info.accountsReadOnly ? { accountsReadOnly: info.accountsReadOnly } : {}),
      ...(info.setAside?.length ? { setAside: info.setAside } : {}),
      ...(info.duplicateCopies?.length ? { duplicateCopies: info.duplicateCopies } : {}),
    };
  }

  onChange(listener: (state: UsageState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    this.running = true;
    void this.kick();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.syncWatch();
  }

  /** The window was hidden or shown: no polling while hidden (unless `pollHidden`), a catch-up read on return when data is stale. */
  setActive(active: boolean): void {
    this.active = active;
    this.syncWatch();
    if (!active) { if (!this.options.pollHidden?.()) this.clearTimer(); return; }
    const interval = this.options.intervalMs();
    if (this.running && this.options.enabled() && interval > 0 && this.now() - this.lastRun >= interval) void this.kick();
    this.schedule();
  }

  /** Call after the enabled flag or the interval changed. */
  reschedule(): void {
    if (this.running && this.options.enabled()) void this.kick();
    this.schedule();
  }

  /**
   * `manual` (the refresh button) also reads accounts in an error backoff - never one held by a rate limit; `force` skips the
   * 20 s gap between runs. `subject` (a card id or key; `claude:main` = the live Claude card) is the account an action was
   * about: it is read now whatever its spacing or hold. Every other account keeps its 3-minute spacing.
   */
  refresh(manual = false, force = false, subject?: string): Promise<UsageState> {
    if (!this.options.enabled()) return Promise.resolve(this.getState());
    if (subject) this.subjects.add(subject);
    if (this.pending) {
      if (!force) return this.pending;
      // The follow-up is manual only when a caller was (a file-change run must not bypass error holds by joining).
      this.followUpManual ||= manual;
      if (!this.followUp) {
        this.followUp = this.pending.catch(() => undefined).then(() => {
          const asManual = this.followUpManual;
          this.followUp = undefined;
          this.followUpManual = false;
          return this.refresh(asManual, true);
        });
      }
      return this.followUp;
    }
    if (!force && this.lastRun && this.now() - this.lastRun < MIN_GAP_MS) return Promise.resolve(this.getState());
    this.pending = this.run(manual).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /**
   * The refresh button: reads every account now - only one read in the last EAGER_GUARD_MS and a rate-limit hold (whose card
   * tells when it is retried) are skipped - and resolves once all reads finished. A run already in flight is followed by one.
   */
  refreshNow(): Promise<UsageState> {
    if (!this.options.enabled()) return Promise.resolve(this.getState());
    this.eagerRequested = true;
    return this.refresh(true, true);
  }

  /** Fire-and-forget refresh that can never reject. */
  private kick(): Promise<void> {
    return this.refresh().then(() => undefined, () => undefined);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.clearTimer();
    const interval = this.options.intervalMs();
    if (!this.running || (!this.active && !this.options.pollHidden?.()) || !this.options.enabled() || interval <= 0) return;
    this.timer = setTimeout(() => { void this.kick().then(() => this.schedule()); }, interval);
    this.timer.unref?.();
  }

  private async run(manual: boolean): Promise<UsageState> {
    const started = this.now();
    this.lastRun = started;
    const subjects = new Set(this.subjects);
    this.subjects.clear();
    // The first run of this process and the refresh button read every account now (anti-429 spacing: only the short guard).
    // Holds after a failure are a separate rule: the first run keeps every persisted hold, the button only rate-limit holds.
    const eager = this.eagerRequested || this.firstRun;
    this.eagerRequested = false;
    this.firstRun = false;
    const spacing = this.options.minIdentityGapMs ?? MIN_IDENTITY_GAP_MS;
    const gap = eager ? Math.min(EAGER_GUARD_MS, spacing) : spacing;
    if (this.options.beforeRun) { try { await this.options.beforeRun(); } catch { /* the poll still runs */ } }
    const accounts = this.refs(true);
    this.prune(accounts);
    // An action about any card of an account (also the saved card sharing the live login's account) makes it a subject.
    const subjectKeys = new Set(accounts.filter((ref) => this.isSubject(ref, this.keyOf(ref), subjects)).map((ref) => this.keyOf(ref)));
    await Promise.all(this.onePerAccount(accounts).map((ref) => this.update(ref, started, manual, subjectKeys.has(this.keyOf(ref)), gap)));
    this.prune(this.options.accounts());
    // Whatever of a 0.9.0 cache found no account by now is history.
    this.legacyUsage.clear();
    this.legacyHold.clear();
    this.legacyLive = undefined;
    this.saveCache();
    this.syncWatch();
    const state = this.getState();
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* a bad listener must not affect the others or the run */ }
    }
    return state;
  }

  /** Forgets everything about accounts that are no longer listed. */
  private prune(accounts: AccountRef[]): void {
    const keys = new Set(accounts.map((ref) => this.keyOf(ref)));
    for (const map of [this.providers, this.backoff, this.stamps, this.lastRead, this.readAsProfile] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) if (!keys.has(key)) map.delete(key);
    }
  }

  /** The live Claude login (no profile dir) is watched when `watchLive` is on. */
  private watchedLive(ref: AccountRef): boolean {
    return this.options.watchLive === true && ref.provider === 'claude' && !ref.configDir;
  }

  private watched(ref: AccountRef): boolean {
    const key = this.keyOf(ref);
    return this.stamps.has(key) && (this.providers.get(key)?.status === 'dormant' || this.watchedLive(ref));
  }

  /** Polls the credentials file of dormant (and, with watchLive, live) accounts only - a cheap stat - and refreshes when it changed. */
  private syncWatch(): void {
    const wanted = this.running && this.active && this.options.enabled() && !!this.options.credentialsStamp && this.options.accounts().some((ref) => this.watched(ref));
    if (!wanted) {
      if (this.watcher) clearInterval(this.watcher);
      this.watcher = undefined;
      return;
    }
    if (this.watcher) return;
    this.watcher = setInterval(() => { void this.checkStamps(); }, this.options.watchMs ?? WATCH_MS);
    this.watcher.unref?.();
  }

  private async checkStamps(): Promise<void> {
    const stampOf = this.options.credentialsStamp;
    if (!stampOf || this.pending) return;
    try {
      for (const ref of this.options.accounts()) {
        if (!this.watched(ref)) continue;
        const key = this.keyOf(ref);
        const current = await stampOf(ref);
        if (current === this.stamps.get(key)) continue;
        // The file changed (Claude Code renewed it, or another tool switched it): one run now, which reconciles the live
        // login first. It is no action about the account: a new account is read at once (it has no read yet), the same one
        // keeps its spacing and backoff. The change is noted, so it triggers one run, not one every watch period.
        this.stamps.set(key, current);
        await this.refresh(false, true);
        return;
      }
    } catch { /* the regular poll still runs */ }
  }

  /**
   * One card per account and run: the live login and a saved record of the same account (held by the live login) share a
   * key, so the account is read once - through the live login - and its spacing applies; both cards show that one result.
   */
  private onePerAccount(refs: AccountRef[]): AccountRef[] {
    const live = (ref: AccountRef) => ref.provider === 'claude' && !ref.configDir;
    const chosen = new Map<string, AccountRef>();
    for (const ref of [...refs.filter(live), ...refs.filter((ref) => !live(ref))]) if (!chosen.has(this.keyOf(ref))) chosen.set(this.keyOf(ref), ref);
    return [...chosen.values()];
  }

  private isSubject(ref: AccountRef, key: string, subjects: ReadonlySet<string>): boolean {
    return subjects.has(ref.id) || subjects.has(key) || (subjects.has(LIVE_CARD) && ref.provider === 'claude' && !ref.configDir);
  }

  private async update(ref: AccountRef, now: number, manual: boolean, subject: boolean, gap: number): Promise<void> {
    const key = this.keyOf(ref);
    const { id, provider } = ref;
    const hold = this.backoff.get(key);
    // A rate limit is never bypassed (not even by the refresh button): hitting the limiter again keeps it engaged.
    if (hold && hold.until > now && !subject && (!manual || RATE_LIMITED.test(hold.error ?? ''))) { this.restoreHeld(ref, key, hold); return; }
    const last = this.lastRead.get(key);
    const asProfile = !!ref.configDir;
    // Spacing applies to the same copy of the sign-in; an account that moved between the live login and a profile is read once.
    const sameRole = (this.readAsProfile.get(key) ?? asProfile) === asProfile;
    if (!subject && sameRole && last !== undefined && now - last < gap) return;
    this.lastRead.set(key, now);
    this.readAsProfile.set(key, asProfile);
    let result: FetchResult;
    let stamp: string | null = null;
    try { if (this.options.credentialsStamp) stamp = await this.options.credentialsStamp(ref); } catch { /* no marker, no watching */ }
    const failure = (error: string): FetchResult => ({ usage: { accountId: id, provider, status: 'error', windows: [], fetchedAt: now, source: 'live', error } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<FetchResult>((resolve) => { timeout = setTimeout(() => resolve(failure('timeout')), FETCH_TIMEOUT_MS); });
      result = await Promise.race([this.options.fetchAccount(ref), timedOut]);
    } catch { result = failure('network'); }
    finally { clearTimeout(timeout); }
    // A result for an account removed (or switched to another identity) while it was in flight is dropped.
    if (!this.options.accounts().some((listed) => this.keyOf(listed) === key)) return;
    const parsed = sanitizeUsage(result.usage);
    const read = parsed && parsed.accountId === id ? parsed : failure('bad-response').usage;
    this.verifyLegacyLive(key, read);
    const { retryAfterMs } = result;
    const failed = read.status === 'error' || result.failed === true;
    const forbidden = read.status === 'forbidden';
    const retryAt = failed ? this.startBackoff(key, now, hold?.failures, retryAfterMs, read.error)
      : forbidden ? this.startBackoff(key, now, hold?.failures, FORBIDDEN_HOLD_MS, read.error ?? 'http-403') : undefined;
    if (!failed && !forbidden) this.backoff.delete(key);
    const usage: ProviderUsage = { ...read, attemptAt: now, ...(retryAt !== undefined ? { retryAt } : {}) };
    if (usage.status === 'dormant' || this.watchedLive(ref)) this.stamps.set(key, stamp); else this.stamps.delete(key);
    if (usage.status === 'ok' || usage.status === 'signedOut' || usage.status === 'apiKey') {
      this.providers.set(key, usage);
      return;
    }
    // Expired or failed: keep the last numbers of THIS account, marked as remembered, so the panel is never blank after a hiccup.
    const previous = this.providers.get(key);
    const own = usage.windows.length > 0;
    this.providers.set(key, !own && previous?.windows.length ? { ...usage, windows: previous.windows, fetchedAt: previous.fetchedAt, source: 'cache' } : usage);
  }

  /** Returns when the next automatic attempt may happen. */
  private startBackoff(key: string, now: number, previousFailures = 0, retryAfterMs?: number, error?: string): number {
    const failures = previousFailures + 1;
    // A usage-endpoint 429 waits the margin longer, with or without a Retry-After.
    const margin = error && USAGE_LIMITED.test(error) ? this.options.retryAfterMarginMs ?? RETRY_AFTER_MARGIN_MS : 0;
    const wait = (retryAfterMs !== undefined ? retryAfterMs : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))) + margin;
    this.backoff.set(key, { until: now + wait, failures, ...(error ? { error } : {}), attemptAt: now });
    return now + wait;
  }

  /** While held the card shows why and when it is tried next (the attempt itself is skipped). */
  private restoreHeld(ref: AccountRef, key: string, hold: Backoff): void {
    if (!hold.error) return;
    const current = this.providers.get(key);
    if (current?.error === hold.error) return;
    const base: ProviderUsage = current ?? { accountId: ref.id, provider: ref.provider, status: 'error', windows: [], fetchedAt: hold.attemptAt ?? this.now(), source: 'cache' };
    this.providers.set(key, { ...base, status: hold.error === 'http-403' ? 'forbidden' : 'error', error: hold.error, ...(hold.attemptAt !== undefined ? { attemptAt: hold.attemptAt } : {}), retryAt: hold.until });
  }

  /**
   * Moves 0.9.0 cache entries (keyed by card id) to the accounts now listed. A saved card kept its id and its profile, so its
   * numbers and backoff go to its account at once. The 0.9.0 live card may have been another account (cswap may have switched
   * since): its numbers and backoff are taken only when its e-mail is the live account's (known now, or proven by the first
   * read for the numbers); a backoff that cannot be checked now is dropped, never given to another account.
   */
  private adoptLegacy(refs: AccountRef[], afterReconcile: boolean): void {
    if (!this.legacyUsage.size && !this.legacyHold.size) return;
    const adopt = (key: string, from: string): void => {
      const usage = this.legacyUsage.get(from);
      const hold = this.legacyHold.get(from);
      if (usage && !this.providers.has(key)) this.providers.set(key, usage);
      if (hold && !this.backoff.has(key)) this.backoff.set(key, hold);
      this.legacyUsage.delete(from);
      this.legacyHold.delete(from);
    };
    // Same card id, same account (a card without identity is keyed by its id, as in 0.9.0).
    for (const ref of refs) if (ref.id !== LIVE_CARD || this.keyOf(ref) === ref.id) adopt(this.keyOf(ref), ref.id);
    // The live card of an identified account (its id is `claude:main` or its record's): only once a run has looked at
    // who is signed in now (beforeRun), never from a live identity remembered before the upgrade.
    if (!afterReconcile) return;
    const live = refs.find((ref) => ref.provider === 'claude' && !ref.configDir);
    if (!live) return;
    const key = this.keyOf(live);
    const hold = this.legacyHold.get(LIVE_CARD);
    const usage = this.legacyUsage.get(LIVE_CARD);
    const liveEmail = this.options.liveEmail?.()?.toLowerCase();
    const same = !!liveEmail && !!usage?.email && usage.email.toLowerCase() === liveEmail;
    if (same) {
      if (!this.providers.has(key)) this.providers.set(key, usage);
      if (hold && !this.backoff.has(key)) this.backoff.set(key, hold);
    } else if (usage && !liveEmail) {
      this.legacyLive = { key, usage };
    }
    this.legacyHold.delete(LIVE_CARD);
    this.legacyUsage.delete(LIVE_CARD);
  }

  private verifyLegacyLive(key: string, read: ProviderUsage): void {
    const pending = this.legacyLive;
    if (!pending || pending.key !== key) return;
    this.legacyLive = undefined;
    const same = !!read.email && !!pending.usage.email && read.email.toLowerCase() === pending.usage.email.toLowerCase();
    if (same && !this.providers.has(key)) this.providers.set(key, pending.usage);
  }

  private loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(this.options.cacheFile, 'utf8')) as { version?: unknown; entries?: unknown; providers?: unknown; backoff?: unknown; reads?: unknown };
      // Version 2 is keyed by account; a 0.9.0 cache (version-less) is keyed by card id and moved to the accounts on first use.
      const legacy = raw?.version !== CACHE_VERSION;
      const entries: Array<[string, unknown]> = !legacy
        ? (Array.isArray(raw.entries) ? raw.entries : []).flatMap((e): Array<[string, unknown]> => (e && typeof e === 'object' && typeof (e as { key?: unknown }).key === 'string' ? [[(e as { key: string }).key, (e as { usage?: unknown }).usage]] : []))
        : (Array.isArray(raw?.providers) ? raw.providers : []).map((u): [string, unknown] => [typeof (u as { accountId?: unknown } | null)?.accountId === 'string' ? (u as { accountId: string }).accountId : '', u]);
      for (const [key, entry] of entries) {
        const usage = sanitizeUsage(entry);
        // An expired sign-in (or a copy the app may not renew whose token ran out) survives a restart as such: its card says
        // "Sign-in expired" at once instead of showing its old numbers as if they were valid (1.1.1).
        const signIn = !legacy && (usage?.status === 'expired' || usage?.status === 'elsewhere');
        if (!key || !usage || (!usage.windows.length && !signIn)) continue;
        // Otherwise only the numbers survive a restart; the failure that may have been stored with them is history.
        const { error, retryAt: _retryAt, attemptAt: _attemptAt, ...numbers } = usage;
        (legacy ? this.legacyUsage : this.providers).set(key, signIn
          ? { ...numbers, ...(error ? { error } : {}), source: 'cache' }
          : { ...numbers, status: 'ok', source: 'cache' });
      }
      const held = typeof raw?.backoff === 'object' && raw.backoff !== null && !Array.isArray(raw.backoff) ? Object.entries(raw.backoff) : [];
      for (const [key, value] of held) {
        const entry = value as Partial<Backoff> | null;
        if (!entry || !Number.isFinite(entry.until) || !Number.isInteger(entry.failures) || (entry.failures as number) < 1 || (entry.until as number) <= this.now()) continue;
        (legacy ? this.legacyHold : this.backoff).set(key, {
          until: entry.until as number, failures: entry.failures as number,
          ...(typeof entry.error === 'string' && /^[a-z0-9-]{1,40}$/.test(entry.error) ? { error: entry.error } : {}),
          ...(Number.isFinite(entry.attemptAt) ? { attemptAt: entry.attemptAt as number } : {}),
        });
      }
      const reads = !legacy && typeof raw.reads === 'object' && raw.reads !== null && !Array.isArray(raw.reads) ? Object.entries(raw.reads) : [];
      for (const [key, at] of reads) if (typeof at === 'number' && Number.isFinite(at) && at <= this.now()) this.lastRead.set(key, at);
    } catch { /* no usable cache yet */ }
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.options.cacheFile), { recursive: true });
      const keys = [...new Set(this.options.accounts().map((ref) => this.keyOf(ref)))];
      const kept = (usage: ProviderUsage | undefined): usage is ProviderUsage => !!usage && (usage.windows.length > 0 || usage.status === 'expired' || usage.status === 'elsewhere');
      const entries = keys.flatMap((key) => { const usage = this.providers.get(key); return kept(usage) ? [{ key, usage }] : []; });
      const backoff = Object.fromEntries(keys.flatMap((key) => { const hold = this.backoff.get(key); return hold && hold.until > this.now() ? [[key, hold]] : []; }));
      const reads = Object.fromEntries(keys.flatMap((key) => { const at = this.lastRead.get(key); return at !== undefined ? [[key, at]] : []; }));
      atomicWriteFileSync(this.options.cacheFile, JSON.stringify({ version: CACHE_VERSION, entries, backoff, reads }));
    } catch { /* the cache is optional */ }
  }
}
