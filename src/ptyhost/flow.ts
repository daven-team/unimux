// Pure helpers for the pty output path: a bounded replay tail, renderer back-pressure and the coalescing delay.
import type { ReplaySize } from '../shared/replay';

/** Stored pieces of a tail before they are joined into one string. */
export const MAX_TAIL_CHUNKS = 256;
/** Size changes a tail remembers at most (a window drag resizes many times, mostly with little output in between). */
export const MAX_TAIL_SIZES = 512;

/** Keeps roughly the newest `limit` characters of a stream without re-copying the whole tail on every chunk. */
export class TailBuffer {
  private chunks: string[] = [];
  private length = 0;
  /** Characters ever pushed: the absolute position of the tail's end. */
  private total = 0;
  /** The pty sizes, each from an absolute position on (see `size`). */
  private sizes: Array<{ pos: number; cols: number; rows: number }> = [];

  constructor(private readonly limit: number) {}

  /** The terminal has `cols` x `rows` from now on: what follows was written at that size (see replay()). */
  size(cols: number, rows: number): void {
    const last = this.sizes[this.sizes.length - 1];
    if (last && last.cols === cols && last.rows === rows) return;
    if (last && last.pos === this.total) this.sizes.pop();
    const before = this.sizes[this.sizes.length - 1];
    if (!before || before.cols !== cols || before.rows !== rows) this.sizes.push({ pos: this.total, cols, rows });
    this.pruneSizes();
  }

  private pruneSizes(): void {
    // Only the newest size from before the kept characters still matters: it is the size they start at.
    const start = this.total - Math.min(this.length, this.limit);
    while (this.sizes.length > 1 && this.sizes[1].pos <= start) this.sizes.shift();
    if (this.sizes.length > MAX_TAIL_SIZES) this.sizes.splice(0, this.sizes.length - MAX_TAIL_SIZES);
  }

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.length += data.length;
    this.total += data.length;
    // Drop whole leading chunks that are no longer needed; the exact cut happens in toString().
    while (this.chunks.length > 1 && this.length - this.chunks[0].length >= this.limit) {
      this.length -= this.chunks.shift()!.length;
    }
    // Many tiny chunks (echoes, spinners) cost far more as separate strings than their characters: join them now and then.
    if (this.chunks.length > MAX_TAIL_CHUNKS) this.compact();
    if (this.sizes.length > 1) this.pruneSizes();
  }

  /** Number of stored pieces (tests). */
  get pieces(): number {
    return this.chunks.length;
  }

  private compact(): void {
    const all = this.chunks.join('');
    const kept = all.length > this.limit ? all.slice(-this.limit) : all;
    this.chunks = [kept];
    this.length = kept.length;
  }

  /** The newest `limit` characters (same result as repeatedly doing `(tail + data).slice(-limit)`). */
  toString(): string {
    const all = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
    if (this.chunks.length > 1) this.chunks = [all];
    return all.length > this.limit ? all.slice(-this.limit) : all;
  }

  /** The tail with the sizes it was written at, as offsets into it (the first one at 0 when a size is known). */
  replay(): { data: string; sizes: ReplaySize[] } {
    const data = this.toString();
    const start = this.total - data.length;
    const sizes: ReplaySize[] = [];
    for (const s of this.sizes) {
      const at = Math.max(0, s.pos - start);
      if (sizes.length && sizes[sizes.length - 1].at === at) sizes.pop();
      sizes.push({ at, cols: s.cols, rows: s.rows });
    }
    return { data, sizes };
  }
}

/** Bytes the renderer may be behind before the pty is paused, and the level at which it is resumed. */
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;

/** Counts characters sent to the renderer but not yet parsed there (acknowledged). */
export class FlowGate {
  private pending = 0;
  paused = false;

  /** Characters sent but not acknowledged yet. */
  get inFlight(): number {
    return this.pending;
  }

  /** Returns true when the pty has to be paused now. */
  sent(n: number): boolean {
    this.pending += n;
    if (!this.paused && this.pending >= HIGH_WATER) {
      this.paused = true;
      return true;
    }
    return false;
  }

  /** Returns true when the pty may be resumed now. */
  acked(n: number): boolean {
    this.pending = Math.max(0, this.pending - n);
    if (this.paused && this.pending <= LOW_WATER) {
      this.paused = false;
      return true;
    }
    return false;
  }

  /** Lifts a pause without forgetting what is in flight (the renderer is slow, not gone). */
  release(): void {
    this.paused = false;
  }

  /** Forgets everything in flight (renderer reconnected). Returns true when a pause has to be lifted. */
  reset(): boolean {
    const wasPaused = this.paused;
    this.pending = 0;
    this.paused = false;
    return wasPaused;
  }
}

/**
 * Typing echoes must stay snappy; bulk output of the cell the user works in is coalesced into roughly one frame; output of
 * cells nobody types in (agents streaming in the background) waits about two frames at 60 Hz, which roughly halves the
 * renderer's parse and draw work for a busy grid (measured: 20 busy cells 48 -> 34 % of a core).
 */
export const ECHO_COALESCE_MS = 4;
export const BULK_COALESCE_MS = 12;
export const BACKGROUND_COALESCE_MS = 33;
/** A buffer this large is sent at once instead of waiting for the timer. */
export const FLUSH_NOW_CHARS = 128 * 1024;
/**
 * Output this soon after a keystroke counts as its echo (see coalesceDelay and OutputChannel.wrote): the window of a local
 * shell. A terminal that answers slower (an SSH server far away) gets a longer one from its EchoClock.
 */
export const ECHO_WINDOW_MS = 150;
/** A cell that got input this recently counts as the one the user works in, even without the focus. */
export const ACTIVE_WINDOW_MS = 1000;
/** The longest echo window; an answer later than this is not taken for an echo (nor measured as one). */
export const ECHO_WINDOW_MAX_MS = ACTIVE_WINDOW_MS;
/**
 * Flushes a keystroke may send without a timer: the echo and the redraws that follow it within a few milliseconds (zsh
 * syntax highlighting and suggestions, fish, prompts that repaint); more output after it is coalesced again.
 */
export const ECHO_FLUSHES = 4;
/** Weight of the newest keystroke -> answer time in the EchoClock's average. */
export const ECHO_EWMA_WEIGHT = 0.25;

/**
 * How long a terminal takes to answer a keystroke: a moving average of keystroke -> first output. Only a key typed after a
 * pause (no key for the current window) into a quiet terminal (no output for the average answer time) is measured: an
 * earlier key's echo cannot be on its way then, and the first output after it is its own answer. Measuring keys typed while
 * earlier echoes were still on their way took (round trip - typing gap) for the round trip when typing faster than the
 * server answers, and output of a busy terminal (a build, a spinner) was taken for answers: both pulled the window down to
 * 150 ms again. Its `window` is the echo window of the terminal: ECHO_WINDOW_MS for anything answering within about 65 ms
 * (local shells, nearby servers), else twice the average plus a margin for jitter, at most ECHO_WINDOW_MAX_MS. Without it
 * an SSH server with a round trip above 150 ms had every echo after a pause in typing wait for the coalescing timer.
 * Times are of a monotonic clock (performance.now()).
 */
export class EchoClock {
  private waitingSince: number | null = null;
  private average: number | null = null;
  private lastKey = -Infinity;
  private lastOutput = -Infinity;

  /** The user typed at `now`. */
  keystroke(now: number): void {
    // A key without an answer in time (a password, a key without output) is not measured any more.
    if (this.waitingSince !== null && now - this.waitingSince > ECHO_WINDOW_MAX_MS) this.waitingSince = null;
    if (this.waitingSince === null && now - this.lastKey >= this.window && now - this.lastOutput >= (this.average ?? 0)) {
      this.waitingSince = now;
    }
    this.lastKey = now;
  }

  /** The terminal printed something at `now`: the answer to the keystroke that waits, if any. */
  output(now: number): void {
    this.lastOutput = now;
    if (this.waitingSince === null) return;
    const sample = now - this.waitingSince;
    this.waitingSince = null;
    // Above the cap: no echo (a password, a key without output), what came now is something else. Negative: a clock that
    // went back.
    if (sample < 0 || sample > ECHO_WINDOW_MAX_MS) return;
    this.average = this.average === null ? sample : this.average + (sample - this.average) * ECHO_EWMA_WEIGHT;
  }

  /**
   * A first estimate before any key was measured (an SSH session: one round trip of its shell request), so the first key
   * typed already gets the window of a slow server. Ignored once a key was measured.
   */
  seed(ms: number): void {
    if (this.average === null && ms >= 0 && ms <= ECHO_WINDOW_MAX_MS) this.average = ms;
  }

  /** Average keystroke -> answer time in ms (null before the first answer). */
  get answerMs(): number | null {
    return this.average;
  }

  get window(): number {
    if (this.average === null) return ECHO_WINDOW_MS;
    return Math.min(ECHO_WINDOW_MAX_MS, Math.max(ECHO_WINDOW_MS, Math.round(2 * this.average + 20)));
  }
}

/**
 * The coalescing window of the next flush: `focused` = the renderer reported this terminal as the focused one, `echoWindow`
 * = how long after a keystroke output still counts as its echo (see EchoClock).
 */
export function coalesceDelay(now: number, lastWrite: number, focused: boolean, echoWindow = ECHO_WINDOW_MS): number {
  const sinceWrite = now - lastWrite;
  if (sinceWrite < echoWindow) return ECHO_COALESCE_MS;
  return focused || sinceWrite < ACTIVE_WINDOW_MS ? BULK_COALESCE_MS : BACKGROUND_COALESCE_MS;
}

/**
 * Bulk and background delays moved onto a shared grid of their own period (between half and one and a half periods, one
 * period on average), so busy terminals flush in the same timer turn and their output leaves the host as one message.
 */
export function alignedDelay(now: number, delay: number): number {
  if (delay !== BULK_COALESCE_MS && delay !== BACKGROUND_COALESCE_MS) return delay;
  const next = delay - (now % delay);
  return next < delay / 2 ? next + delay : next;
}
