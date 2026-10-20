import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_DRAIN_MS, OutputChannel, PAUSE_WATCHDOG_MS } from '../src/ptyhost/output';
import { BACKGROUND_COALESCE_MS, ECHO_COALESCE_MS, ECHO_FLUSHES, ECHO_WINDOW_MS, HIGH_WATER, LOW_WATER } from '../src/ptyhost/flow';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup(opts: { delivered?: boolean; flow?: boolean } = {}) {
  const sent: string[] = [];
  /** The `echo` flag of every delivery. */
  const echoes: boolean[] = [];
  const control = { pause: vi.fn(), resume: vi.fn() };
  const sink = { data: (_id: string, d: string, echo?: boolean) => { sent.push(d); echoes.push(echo === true); return opts.delivered ?? true; }, exit: vi.fn() };
  const out = new OutputChannel('a', () => sink, control, () => opts.flow ?? true);
  return { out, sent, echoes, control };
}

/** The end of the current callback: echo flushes queued with process.nextTick (not faked) have run. */
const endOfCallback = () => new Promise<void>((r) => process.nextTick(r));

describe('OutputChannel', () => {
  it('coalesces small chunks and keeps a replay tail', () => {
    const { out, sent } = setup();
    out.push('a'); out.push('b');
    // A cell nobody types in waits for the background window (BACKGROUND_COALESCE_MS, on its grid).
    vi.advanceTimersByTime(BACKGROUND_COALESCE_MS * 1.5);
    expect(sent).toEqual(['ab']);
    expect(out.history()).toBe('ab');
  });

  it('pauses the source at the high watermark and resumes after acks', () => {
    const { out, control } = setup();
    out.push('x'.repeat(HIGH_WATER));
    expect(control.pause).toHaveBeenCalledTimes(1);
    out.ack(HIGH_WATER - LOW_WATER);
    expect(control.resume).toHaveBeenCalledTimes(1);
  });

  it('resumes a stuck pause after the watchdog', () => {
    const { out, control } = setup();
    out.push('x'.repeat(HIGH_WATER));
    vi.advanceTimersByTime(PAUSE_WATCHDOG_MS + 1);
    expect(control.resume).toHaveBeenCalled();
  });

  it('never pauses while nobody receives the data or flow control is off', () => {
    const a = setup({ delivered: false });
    a.out.push('x'.repeat(HIGH_WATER));
    expect(a.control.pause).not.toHaveBeenCalled();
    const b = setup({ flow: false });
    b.out.push('x'.repeat(HIGH_WATER));
    expect(b.control.pause).not.toHaveBeenCalled();
  });

  it('drains a paused source before reporting its end', () => {
    const { out, sent, control } = setup();
    out.push('x'.repeat(HIGH_WATER));
    const then = vi.fn();
    out.drain(then);
    expect(control.resume).toHaveBeenCalled();
    out.push('tail');
    vi.advanceTimersByTime(EXIT_DRAIN_MS);
    out.flush();
    expect(then).toHaveBeenCalledTimes(1);
    expect(sent.join('').endsWith('tail')).toBe(true);
  });

  it('reports the end at once when not paused, and ignores data after dispose', () => {
    const { out, sent } = setup();
    const then = vi.fn();
    out.drain(then);
    expect(then).toHaveBeenCalledTimes(1);
    out.dispose();
    out.push('late');
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([]);
  });

  // Task L (0.9.9): on Windows a 4 ms setTimeout fires after one timer tick (about 15.6 ms), which every echo used to wait for.
  // 1.0.1: not even the next event-loop turn any more: the echo leaves once the callback that received it is done.
  it('delivers the first output after a keystroke at the end of the callback, without a timer, marked as an echo', async () => {
    const { out, sent, echoes } = setup();
    out.wrote();
    out.push('e');
    out.push('f'); // the same socket read: the same flush
    expect(sent).toEqual([]);
    await endOfCallback();
    expect(sent).toEqual(['ef']);
    expect(echoes).toEqual([true]);
  });

  it('flushes output that was waiting for the background window together with the echo', async () => {
    const { out, sent } = setup();
    out.push('stream ');
    out.wrote();
    out.push('echo');
    await endOfCallback();
    expect(sent).toEqual(['stream echo']);
    vi.advanceTimersByTime(BACKGROUND_COALESCE_MS * 2);
    expect(sent).toEqual(['stream echo']);
  });

  // 1.0.1: zsh with syntax highlighting or suggestions, fish and repainting prompts answer a key in several writes; only the
  // first one used to skip the timer, the redraw after it waited for the 4 ms window (a Windows timer tick).
  it('sends the redraws right after the echo without a timer too, then coalesces on the echo window again', async () => {
    const { out, sent, echoes } = setup();
    out.wrote();
    for (let i = 0; i < ECHO_FLUSHES; i++) {
      out.push(`r${i}`);
      await endOfCallback();
    }
    expect(sent).toEqual(Array.from({ length: ECHO_FLUSHES }, (_, i) => `r${i}`));
    out.push('1'); out.push('2');
    await endOfCallback();
    expect(sent).toHaveLength(ECHO_FLUSHES);
    vi.advanceTimersByTime(ECHO_COALESCE_MS);
    expect(sent.at(-1)).toBe('12');
    expect(echoes.at(-1)).toBe(false);
  });

  // 1.0.1: typing faster than the server answers (each echo arrives after the next key left) used to send every other echo
  // through the timer, because the first echo used up the keystroke's fast path.
  it('gives every keystroke its own fast echo when the echoes overlap the typing', async () => {
    const { out, sent } = setup();
    out.wrote();
    vi.advanceTimersByTime(60);
    out.wrote();
    vi.advanceTimersByTime(60);
    out.push('a'); // the first key's echo
    await endOfCallback();
    vi.advanceTimersByTime(60);
    out.push('b');
    await endOfCallback();
    expect(sent).toEqual(['a', 'b']);
  });

  it('a keystroke without an answer does not turn output long after it into an echo', async () => {
    const { out, sent } = setup();
    out.wrote();
    vi.advanceTimersByTime(ECHO_WINDOW_MS);
    out.push('late');
    await endOfCallback();
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(BACKGROUND_COALESCE_MS * 1.5);
    expect(sent).toEqual(['late']);
  });

  // 1.0.1: an SSH server about 200 ms away answered every key typed after a pause outside the fixed 150 ms window, so its
  // echo waited for the bulk timer (12 ms on its grid, a Windows timer tick or two).
  it('learns the round trip of a slow server and still sends its echoes at once', async () => {
    const { out, sent } = setup();
    expect(out.echoWindow).toBe(ECHO_WINDOW_MS);
    for (let i = 0; i < 3; i++) {
      out.wrote();
      vi.advanceTimersByTime(200);
      out.push(`k${i}`);
      await endOfCallback();
      vi.advanceTimersByTime(BACKGROUND_COALESCE_MS * 2); // the first one, still on the 150 ms window, waits for the timer
      vi.advanceTimersByTime(500);
    }
    expect(out.echoWindow).toBeGreaterThan(400);
    out.wrote();
    vi.advanceTimersByTime(200);
    out.push('fast');
    await endOfCallback();
    expect(sent.at(-1)).toBe('fast');
  });

  it('dispose cancels a pending echo flush', async () => {
    const { out, sent } = setup();
    out.wrote();
    out.push('e');
    out.dispose();
    await endOfCallback();
    vi.advanceTimersByTime(10);
    expect(sent).toEqual([]);
  });
});
