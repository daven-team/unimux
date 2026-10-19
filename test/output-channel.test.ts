import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_DRAIN_MS, OutputChannel, PAUSE_WATCHDOG_MS } from '../src/ptyhost/output';
import { BACKGROUND_COALESCE_MS, HIGH_WATER, LOW_WATER } from '../src/ptyhost/flow';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup(opts: { delivered?: boolean; flow?: boolean } = {}) {
  const sent: string[] = [];
  const control = { pause: vi.fn(), resume: vi.fn() };
  const sink = { data: (_id: string, d: string) => { sent.push(d); return opts.delivered ?? true; }, exit: vi.fn() };
  const out = new OutputChannel('a', () => sink, control, () => opts.flow ?? true);
  return { out, sent, control };
}

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
});
