// The output path of one terminal (pty or SSH channel): coalescing, replay tail, renderer back-pressure and the exit drain.
// Extracted from PtyManager so both backends share it; the source is paused and resumed through `control`.
import { PTY_REPLAY_CHARS } from '../shared/terminalLimits';
import { alignedDelay, coalesceDelay, FLUSH_NOW_CHARS, FlowGate, TailBuffer } from './flow';
import type { PtySink } from './manager';

/** A paused source is resumed anyway when no acknowledgement arrives for this long (renderer gone or stuck). */
export const PAUSE_WATCHDOG_MS = 3000;
/** How long the last output of a paused source that ended may still arrive. */
export const EXIT_DRAIN_MS = 80;

export interface OutputControl { pause(): void; resume(): void }

/** The terminal the renderer reported as focused (its output keeps the short coalescing window, see coalesceDelay). */
let focusedTerminal: string | null = null;
/** Live channels by terminal id: a focus change re-arms the newly focused one's pending flush. */
const channels = new Map<string, OutputChannel>();

export function setFocusedTerminal(id: string | null): void {
  focusedTerminal = id;
  if (id !== null) channels.get(id)?.rearm();
}

/** The terminal the renderer reported as focused (tests). */
export function focusedTerminalId(): string | null {
  return focusedTerminal;
}

export class OutputChannel {
  private buf = '';
  private timer: NodeJS.Timeout | null = null;
  /** When the pending flush timer fires (Date.now() clock). */
  private due = Infinity;
  private readonly tail = new TailBuffer(PTY_REPLAY_CHARS);
  private readonly gate = new FlowGate();
  private watchdog: NodeJS.Timeout | null = null;
  private lastWrite = -Infinity;
  /** The source ended and its last output is being drained: never pause it again. */
  private exiting = false;
  private disposed = false;

  constructor(
    private readonly id: string,
    private readonly sink: () => PtySink,
    private readonly control: OutputControl,
    private readonly flowControl: () => boolean,
  ) {
    channels.set(id, this);
  }

  push(data: string): void {
    if (this.disposed || !data) return;
    this.tail.push(data);
    this.buf += data;
    if (this.buf.length >= FLUSH_NOW_CHARS) this.flush();
    else if (!this.timer) this.arm();
  }

  private arm(): void {
    const now = Date.now();
    const delay = alignedDelay(now, coalesceDelay(now, this.lastWrite, focusedTerminal === this.id));
    if (this.timer) clearTimeout(this.timer);
    this.due = now + delay;
    this.timer = setTimeout(() => this.flush(), delay);
  }

  /**
   * The window may have become shorter (the user typed, or the terminal got the focus): a pending flush that was armed with
   * the long background window is moved up, so the first echo or redraw does not wait for it.
   */
  rearm(): void {
    if (!this.timer || this.disposed) return;
    const now = Date.now();
    if (now + alignedDelay(now, coalesceDelay(now, this.lastWrite, focusedTerminal === this.id)) < this.due) this.arm();
  }

  /** The user typed into this terminal (echoes are flushed faster). */
  wrote(): void {
    this.lastWrite = Date.now();
    this.rearm();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.due = Infinity;
    if (!this.buf || this.disposed) return;
    const out = this.buf;
    this.buf = '';
    const delivered = this.sink().data(this.id, out) !== false;
    if (delivered && this.flowControl() && !this.exiting && this.gate.sent(out.length)) this.pause();
  }

  private pause(): void {
    try { this.control.pause(); } catch { /* the source is going away */ }
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.resume(true), PAUSE_WATCHDOG_MS);
  }

  private resume(force = false): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (force) this.gate.release();
    try { this.control.resume(); } catch { /* the source is going away */ }
  }

  /** The renderer parsed `chars` characters of this terminal's output. */
  ack(chars: number): void {
    if (this.gate.acked(chars)) this.resume();
    else if (this.watchdog) {
      // Slow but alive: progress renews the watchdog.
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => this.resume(true), PAUSE_WATCHDOG_MS);
    }
  }

  /** A renderer (re)connected or flow control was switched: anything counted before is forgotten. */
  resetFlow(): void {
    if (this.gate.reset() || this.watchdog) this.resume();
  }

  history(): string {
    return this.tail.toString();
  }

  get pausedOrWatched(): boolean {
    return this.gate.paused || this.watchdog !== null;
  }

  /** The source ended: a paused one is resumed and given EXIT_DRAIN_MS for its last output; `then` runs afterwards (or at once). */
  drain(then: () => void): void {
    if (!this.pausedOrWatched) { then(); return; }
    this.exiting = true;
    this.resume();
    setTimeout(then, EXIT_DRAIN_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (channels.get(this.id) === this) channels.delete(this.id);
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.timer = null;
    this.watchdog = null;
  }
}
