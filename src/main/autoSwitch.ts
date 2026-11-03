// src/main/autoSwitch.ts - 1.1.2: the automatic switch of the main AI account at a limit, fed by every new state of the limits.
import { mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import type { SwapResult } from '../shared/accounts';
import {
  accountKey, emptyAutoSwitchMemory, mainCard, manualCandidates, normalizeAutoSwitchMemory, offerKey, planAutoSwitch, rememberSwitch, rememberTold, returnOfferMark, switchTrigger,
  type AutoSwitchMemory, type AutoSwitchSettings, type SwitchNotice, type SwitchOffer,
} from '../shared/autoSwitch';
import type { ProviderUsage, UsageProvider } from '../shared/usage';
import { atomicWriteFileSync } from './atomicWrite';

export interface AutoSwitcherOptions {
  /** The memory of switches and notices (cooldown, no ping-pong, return home across restarts); never a credential. */
  file: string;
  settings(): AutoSwitchSettings;
  providers(): ProviderUsage[];
  /** Whether switching this provider is possible on this system at all (Claude profiles need Windows or Linux). */
  supported(provider: UsageProvider): boolean;
  /** True while a swap, a login or a recovery runs or is unresolved: nothing is switched (tried again on the next state). */
  busy(): boolean;
  /** The family rules for the target, checked right before the switch; a refusal skips that candidate. */
  validate(provider: UsageProvider, cardId: string): Promise<SwapResult | null>;
  /** "Make main" of the card's account (the same path as the card's menu). */
  swap(provider: UsageProvider, cardId: string): Promise<SwapResult>;
  /** The notification of a switch, an offer (with its button), no room anywhere or a failed attempt. */
  notify(event: SwitchNotice): void;
  /** The offer or the memory shown in the limits panel changed. */
  changed(): void;
  now?(): number;
}

const PROVIDERS: readonly UsageProvider[] = ['claude', 'codex'];
const RETRY_BUSY_MS = 5_000;

export class AutoSwitcher {
  private memory: AutoSwitchMemory;
  private offer: SwitchOffer | null = null;
  private running = false;
  /** A state that came while an evaluation ran, looked at right after it. */
  private pending: ProviderUsage[] | null = null;
  /** A look again shortly after an evaluation that found a swap or a login running (no new state may come for a while). */
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: AutoSwitcherOptions) {
    this.now = options.now ?? Date.now;
    this.memory = this.load();
  }

  currentOffer(): SwitchOffer | null { return this.offer; }
  away(): AutoSwitchMemory['away'] { return { ...this.memory.away }; }
  snapshot(): AutoSwitchMemory { return structuredClone(this.memory); }

  /** A new state of the accounts (after every poll). One evaluation runs at a time; a state meanwhile is looked at next time. */
  async onState(providers: ProviderUsage[]): Promise<void> {
    if (this.running) { this.pending = providers; return; }
    this.running = true;
    let next: ProviderUsage[] | null = providers;
    try {
      while (next) {
        this.pending = null;
        this.dropStaleOffer(next);
        for (const provider of PROVIDERS) await this.evaluate(provider, next);
        next = this.pending;
      }
    } finally { this.running = false; }
  }

  dispose(): void { if (this.retry) clearTimeout(this.retry); this.retry = undefined; }

  /** Busy now: the same evaluation runs again in a few seconds with the latest state. */
  private later(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.onState(this.options.providers()).catch(() => undefined); }, RETRY_BUSY_MS);
    this.retry.unref?.();
  }

  private async evaluate(provider: UsageProvider, providers: ProviderUsage[]): Promise<void> {
    if (!this.options.supported(provider)) return;
    const settings = this.options.settings();
    const now = this.now();
    const plan = planAutoSwitch({ providers, provider, settings, memory: this.memory, nowMs: now });
    if (plan.kind === 'none') return;
    const fromKey = accountKey(plan.from);
    if (plan.kind === 'exhausted') {
      // Nobody has room: stay, and say so once in this limit period (with the account that is usable first).
      this.remember(rememberTold(this.memory, provider, offerKey('exhausted', fromKey), plan.trigger.window, plan.trigger.resetsAt, now));
      this.tell({ kind: 'exhausted', provider, fromEmail: plan.from.email, toEmail: plan.next?.email ?? plan.target, ...(plan.next ? { resetsAt: plan.next.resetsAt } : {}), ...(plan.target ? { targetOnly: true } : {}) });
      return;
    }
    if (this.options.busy()) { this.later(); return; }
    const returning = plan.reason === 'return';
    if (plan.kind === 'offer') {
      // The first candidate the family rules allow is offered; the offer is told once per limit period.
      const to = await this.firstAllowed(provider, plan.candidates);
      const mark = returning ? returnOfferMark(now) : plan.trigger!;
      this.remember(rememberTold(this.memory, provider, offerKey(returning ? 'return' : 'limit', returning ? settings.primary[provider]! : fromKey), mark.window, mark.resetsAt, now));
      if (!to) return;
      const offer: SwitchOffer = { provider, reason: plan.reason, to: to.accountId, ...(to.email ? { toEmail: to.email } : {}), ...(plan.from.email ? { fromEmail: plan.from.email } : {}), ...(plan.trigger ? { window: plan.trigger.window, percent: plan.trigger.percent } : {}) };
      this.setOffer(offer);
      this.tell({ kind: returning ? 'returnOffer' : 'offer', provider, fromEmail: plan.from.email, toEmail: to.email, window: plan.trigger?.window, percent: plan.trigger?.percent });
      return;
    }
    // Switch at once: the cooldown starts with the attempt, also when every candidate is refused (no retry on every poll).
    this.remember(rememberSwitch(this.memory, provider, plan.from, plan.trigger, now));
    for (const candidate of plan.candidates) {
      if (this.options.busy()) { this.later(); return; }
      if (await this.validate(provider, candidate)) continue;
      const result = await this.swap(provider, candidate);
      if (result.ok) {
        this.remember(rememberSwitch(this.memory, provider, plan.from, plan.trigger, this.now(), { toKey: accountKey(candidate), primary: settings.primary[provider] }));
        if (this.offer?.provider === provider) this.setOffer(null);
        this.tell(returning
          ? { kind: 'returned', provider, fromEmail: plan.from.email, toEmail: result.email ?? candidate.email }
          : { kind: 'switched', provider, fromEmail: plan.from.email, toEmail: result.email ?? candidate.email, window: plan.trigger?.window, percent: plan.trigger?.percent });
      } else {
        this.tell({ kind: 'failed', provider, fromEmail: plan.from.email, toEmail: candidate.email });
      }
      return;
    }
  }

  /**
   * "Switch to X" of an offer (notification button or the panel): only while the offer is still current and X is still a
   * usable account; the switch counts like an automatic one (cooldown, the account left is not chosen again before its reset).
   */
  async acceptOffer(): Promise<SwapResult> {
    const offer = this.offer;
    if (!offer) return { ok: false, error: 'invalid' };
    if (this.options.busy() || this.running) return { ok: false, error: 'busy' };
    const providers = this.options.providers();
    const target = providers.find((usage) => usage.accountId === offer.to);
    if (!target) { this.setOffer(null); return { ok: false, error: 'noTarget' }; }
    // Thresholds hold in every mode: an offer whose account went over one meanwhile is withdrawn.
    if (!manualCandidates(providers, offer.provider, this.options.settings(), this.now(), accountKey(target)).length) { this.setOffer(null); return { ok: false, error: 'noTarget', ...(target.email ? { email: target.email } : {}) }; }
    return this.run(offer.provider, [target]);
  }

  dismissOffer(): void { this.setOffer(null); }

  /**
   * The user's "switch now": to the chosen account (`to`, an account key) or to the best usable saved account with more room
   * than the main one; never to one over a threshold. `noTarget` when there is none. Counts for the cooldown like any switch.
   */
  async switchNow(provider: UsageProvider, to?: string): Promise<SwapResult> {
    if (!this.options.supported(provider)) return { ok: false, error: 'unsupported' };
    if (this.options.busy() || this.running) return { ok: false, error: 'busy' };
    return this.run(provider, manualCandidates(this.options.providers(), provider, this.options.settings(), this.now(), to));
  }

  private async run(provider: UsageProvider, candidates: ProviderUsage[]): Promise<SwapResult> {
    this.running = true;
    try {
      const from = mainCard(this.options.providers(), provider);
      let refusal: SwapResult | null = null;
      for (const candidate of candidates) {
        refusal = await this.validate(provider, candidate);
        if (refusal) continue;
        const result = await this.swap(provider, candidate);
        if (result.ok) {
          const settings = this.options.settings();
          if (from) this.remember(rememberSwitch(this.memory, provider, from, switchTrigger(from, settings, this.now()) ?? undefined, this.now(), { toKey: accountKey(candidate), primary: settings.primary[provider] }));
          if (this.offer?.provider === provider) this.setOffer(null);
        }
        return result;
      }
      return refusal ?? { ok: false, error: 'noTarget' };
    } finally { this.running = false; }
  }

  private async firstAllowed(provider: UsageProvider, candidates: ProviderUsage[]): Promise<ProviderUsage | undefined> {
    for (const candidate of candidates) if (!(await this.validate(provider, candidate))) return candidate;
    return undefined;
  }

  private async validate(provider: UsageProvider, candidate: ProviderUsage): Promise<SwapResult | null> {
    try { return await this.options.validate(provider, candidate.accountId); } catch { return { ok: false, error: 'write' }; }
  }

  private async swap(provider: UsageProvider, candidate: ProviderUsage): Promise<SwapResult> {
    try { return await this.options.swap(provider, candidate.accountId); } catch { return { ok: false, error: 'write' }; }
  }

  /** An offer whose main account changed, whose reason is gone or whose account disappeared is withdrawn. */
  private dropStaleOffer(providers: ProviderUsage[]): void {
    const offer = this.offer;
    if (!offer) return;
    const main = mainCard(providers, offer.provider);
    const settings = this.options.settings();
    const sameMain = !!main && (!offer.fromEmail || accountKey(main) === offer.fromEmail.toLowerCase());
    const reason = offer.reason === 'return' || (!!main && !!switchTrigger(main, settings, this.now()));
    const target = providers.some((usage) => usage.accountId === offer.to);
    if (!settings.enabled || !sameMain || !reason || !target) this.setOffer(null);
  }

  private setOffer(offer: SwitchOffer | null): void {
    if (JSON.stringify(offer) === JSON.stringify(this.offer)) return;
    this.offer = offer;
    this.changed();
  }

  private changed(): void {
    try { this.options.changed(); } catch { /* the panel catches up with the next state */ }
  }

  private tell(event: SwitchNotice): void {
    try { this.options.notify(event); } catch { /* a failed notification must not stop the switch logic */ }
  }

  private remember(memory: AutoSwitchMemory): void {
    const awayChanged = JSON.stringify(memory.away) !== JSON.stringify(this.memory.away);
    this.memory = memory;
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      atomicWriteFileSync(this.options.file, JSON.stringify({ version: 1, memory }));
    } catch { /* optional: at worst a cooldown restarts after a restart */ }
    if (awayChanged) this.changed();
  }

  private load(): AutoSwitchMemory {
    try {
      const raw = JSON.parse(readFileSync(this.options.file, 'utf8')) as { version?: unknown; memory?: unknown };
      return raw?.version === 1 ? normalizeAutoSwitchMemory(raw.memory) : emptyAutoSwitchMemory();
    } catch { return emptyAutoSwitchMemory(); }
  }
}
