// src/main/limitAlerts.ts - 1.1.1: limit warnings as OS notifications, fed by every new state of the AI account limits.
import { mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { inQuietHours, type AlertSettings } from '../shared/alerts';
import { dueResets, evaluateLimits, nextReset, normalizeLimitMemory, type LimitMemory, type LimitNotice } from '../shared/limitAlerts';
import type { ProviderUsage } from '../shared/usage';
import { atomicWriteFileSync } from './atomicWrite';

export interface LimitAlerterOptions {
  /** Where the told windows are remembered (so a restart does not repeat a warning); no credentials. */
  file: string;
  alerts(): AlertSettings;
  show(notice: LimitNotice): void;
  /** The accounts as last known (for the reset timer, which runs without a new state). */
  providers(): ProviderUsage[];
  now?(): number;
}

/**
 * Keeps the memory of told windows, decides what to tell on every state and at the reset times, and asks `show` for each
 * notice the alert rules let through: the alerts master switch and quiet hours silence it (the window still counts as told).
 */
export class LimitAlerter {
  private memory: LimitMemory;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: LimitAlerterOptions) {
    this.now = options.now ?? Date.now;
    this.memory = this.load();
  }

  /** A new state of the accounts (after every poll). */
  onState(providers: ProviderUsage[]): void {
    const result = evaluateLimits(this.memory, providers, this.options.alerts().limits, this.now());
    this.apply(result.memory, result.notices);
  }

  /** Call after the settings changed: the reset timer follows the "available again" switch. */
  settingsChanged(): void { this.arm(); }

  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  /** The memory (tests and diagnostics). */
  snapshot(): LimitMemory { return { ...this.memory }; }

  private apply(memory: LimitMemory, notices: LimitNotice[]): void {
    const changed = JSON.stringify(memory) !== JSON.stringify(this.memory);
    this.memory = memory;
    if (changed) this.save();
    const alerts = this.options.alerts();
    if (notices.length && alerts.enabled && !inQuietHours(alerts.quietHours, new Date(this.now()))) {
      for (const notice of notices) {
        try { this.options.show(notice); } catch { /* one failed notification must not stop the others */ }
      }
    }
    this.arm();
  }

  /** A timer at the next reset of a told window: the "available again" notice comes on time, also without a poll. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const at = nextReset(this.memory);
    if (at === undefined) return;
    // At least a second later (the reset must have passed), at most a day (timers drift over sleep; it simply re-arms).
    const delay = Math.min(24 * 3_600_000, Math.max(1_000, at - this.now() + 1_000));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const result = dueResets(this.memory, this.options.providers(), this.options.alerts().limits, this.now());
      this.apply(result.memory, result.notices);
    }, delay);
    this.timer.unref?.();
  }

  private load(): LimitMemory {
    try {
      const raw = JSON.parse(readFileSync(this.options.file, 'utf8')) as { version?: unknown; marks?: unknown };
      return raw?.version === 1 ? normalizeLimitMemory(raw.marks) : {};
    } catch { return {}; }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      atomicWriteFileSync(this.options.file, JSON.stringify({ version: 1, marks: this.memory }));
    } catch { /* the memory is optional: at worst a warning repeats after a restart */ }
  }
}
