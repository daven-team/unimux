// Which terminals keep a WebGL renderer. Pure, so the policy is tested without a browser.
import { MAX_CELLS } from './layout';

export interface WebglCandidate {
  id: string;
  /** Currently has a WebGL context. */
  hasWebgl: boolean;
  /** Currently shown in a cell. */
  attached: boolean;
  /** When it was last shown or hidden (performance.now()). */
  shownAt: number;
  /** Has the keyboard focus. */
  focused?: boolean;
  /** Last output (performance.now()). */
  outputAt?: number;
  /** When its context was last created or given back (performance.now()). */
  changedAt?: number;
  /** No new context before this time (a lost context backs off). */
  blockedUntil?: number;
}

/**
 * Time one frame may spend creating WebGL contexts (each compiles its shaders, about 10 ms on a desktop GPU); the rest of a
 * plan follows in the next frames, so a grid coming to the front never freezes the window for all its contexts at once.
 */
export const WEBGL_GRANT_BUDGET_MS = 8;

/** An on-screen terminal keeps a context it just got, and waits after losing one, at least this long (no thrashing). */
export const WEBGL_HOLD_MS = 4000;
/** Output this recent makes a terminal "busy": it may take a context from a quiet one on screen. */
export const WEBGL_BUSY_MS = 3000;

/** 3 = focused, 2 = recent output, 1 = shown and quiet. */
function rank(c: WebglCandidate, now: number): number {
  if (c.focused) return 3;
  return c.outputAt !== undefined && now - c.outputAt < WEBGL_BUSY_MS ? 2 : 1;
}

const settled = (c: WebglCandidate, now: number) => c.changedAt === undefined || now - c.changedAt >= WEBGL_HOLD_MS;

/**
 * Who gets a context and who gives one back so that at most `limit` exist. On-screen terminals without one are served by
 * rank (focused, then busy, then quiet): first from free slots, then from parked terminals (least recently shown first), and
 * only then from an on-screen terminal of a lower rank. Taking one from the screen happens at most once per plan, only from a
 * terminal that held its context for WEBGL_HOLD_MS and for a terminal that did not just lose one, so a plan run every second
 * swaps at most one context per second and never the same cell back and forth. Parked terminals keep theirs while slots are free.
 */
export function planWebgl(candidates: readonly WebglCandidate[], limit: number, now: number): { grant: string[]; release: string[] } {
  const grant: string[] = [];
  const release: string[] = [];
  const holders = candidates.filter((c) => c.hasWebgl);
  const parked = holders.filter((c) => !c.attached).sort((a, b) => a.shownAt - b.shownAt);
  // A lowered limit: parked terminals give back the excess first.
  let used = holders.length;
  while (used > limit && parked.length) { release.push(parked.shift()!.id); used--; }
  const wanting = candidates
    .filter((c) => c.attached && !c.hasWebgl && !(c.blockedUntil !== undefined && c.blockedUntil > now))
    .sort((a, b) => rank(b, now) - rank(a, now) || (b.outputAt ?? 0) - (a.outputAt ?? 0) || b.shownAt - a.shownAt);
  // On-screen holders that could give theirs up, the cheapest loss first.
  const shown = holders.filter((c) => c.attached && !c.focused && settled(c, now))
    .sort((a, b) => rank(a, now) - rank(b, now) || (a.outputAt ?? 0) - (b.outputAt ?? 0));
  let swapped = false;
  for (const c of wanting) {
    if (used < limit) { grant.push(c.id); used++; continue; }
    const victim = parked.shift();
    if (victim) { release.push(victim.id); grant.push(c.id); continue; }
    if (swapped || !settled(c, now)) continue;
    const loser = shown[0];
    if (!loser || rank(loser, now) >= rank(c, now)) break;
    shown.shift();
    release.push(loser.id);
    grant.push(c.id);
    swapped = true;
  }
  return { grant, release };
}

/**
 * Contexts left free when parked terminals get one in idle time (prewarm, see pickPrewarm): room for a full grid (MAX_CELLS)
 * that is shown next, so that prewarming never takes the contexts a shown grid needs and is never undone by the plan.
 */
export const WEBGL_PREWARM_RESERVE = MAX_CELLS;
/** Idle time an idle callback must still have to create a context (its shaders take about 10 ms). */
export const WEBGL_PREWARM_IDLE_MS = 12;
/**
 * Frames that keep coming (a terminal printing, a high refresh rate) leave idle periods shorter than that: a context is then
 * created anyway once there was no input for this long, in a task of its own (nothing the person waits for is on screen).
 */
export const WEBGL_PREWARM_QUIET_MS = 2000;
/** Time between two prewarmed contexts when the idle periods are short. */
export const WEBGL_PREWARM_GAP_MS = 250;

/**
 * The parked terminal that gets a context next in idle time, or null: one that has none and is not backing off, the most
 * recently shown first (never shown ones in the order given, the order the cells were created), while fewer than
 * `limit - WEBGL_PREWARM_RESERVE` contexts exist. Showing its grid later then finds the context ready instead of drawing
 * through the DOM renderer while contexts are created a few per frame.
 */
export function pickPrewarm(candidates: readonly WebglCandidate[], limit: number, now: number): string | null {
  let held = 0;
  for (const c of candidates) if (c.hasWebgl) held++;
  if (held >= limit - WEBGL_PREWARM_RESERVE) return null;
  let best: WebglCandidate | null = null;
  for (const c of candidates) {
    if (c.attached || c.hasWebgl || (c.blockedUntil !== undefined && c.blockedUntil > now)) continue;
    if (!best || c.shownAt > best.shownAt) best = c;
  }
  return best?.id ?? null;
}

/** Back-off after a lost context: 2 s, doubling with each loss in a row, at most a minute. */
export function webglBackoff(losses: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, losses - 1));
}

/** A context that lived this long before it was lost was healthy: the loss count (and so the back-off) starts over. */
export const WEBGL_HEALTHY_MS = 5 * 60_000;

/** Losses in a row after one more: counted from when the lost context was created, so the back-off settles at its maximum. */
export function nextLossCount(losses: number, grantedAt: number, now: number): number {
  return now - grantedAt > WEBGL_HEALTHY_MS ? 1 : losses + 1;
}

/** Chromium loses its oldest context synchronously with the creation of one too many: losses this soon after a grant are evictions. */
export const WEBGL_EVICT_MS = 500;
/** Never fewer contexts than this, whatever a burst of losses suggests. */
export const WEBGL_MIN_LIMIT = 4;
/** Without an eviction for this long the limit grows by one again (up to the pool size). */
export const WEBGL_RECOVER_MS = 5 * 60_000;

/**
 * How many contexts Chromium really allows, learned from evictions. Every eviction of a burst (losses within WEBGL_EVICT_MS of
 * each other) lowers the limit to the contexts held minus the evictions of the burst (the lost ones are still counted as held
 * until xterm gives them up, 3 s later). After a quiet WEBGL_RECOVER_MS the limit grows by one per period, up to `max`.
 */
export class WebglLimit {
  limit: number;
  private burstAt = -Infinity;
  private burstLosses = 0;
  private lastLossAt = -Infinity;
  private raisedAt = -Infinity;

  constructor(readonly max: number) { this.limit = max; }

  /** A context of a terminal that holds one was lost. Returns whether the limit went down. */
  lost(now: number, held: number, lastGrantAt: number): boolean {
    if (now - lastGrantAt > WEBGL_EVICT_MS) return false; // a GPU reset or a driver hiccup, not the limit
    if (now - this.burstAt > WEBGL_EVICT_MS) this.burstLosses = 0;
    this.burstAt = now;
    this.burstLosses++;
    this.lastLossAt = now;
    const next = Math.max(WEBGL_MIN_LIMIT, held - this.burstLosses);
    if (next >= this.limit) return false;
    this.limit = next;
    return true;
  }

  /** Called now and then: returns whether the limit went up. */
  recover(now: number): boolean {
    if (this.limit >= this.max || now - this.lastLossAt < WEBGL_RECOVER_MS || now - this.raisedAt < WEBGL_RECOVER_MS) return false;
    this.limit++;
    this.raisedAt = now;
    return true;
  }
}
