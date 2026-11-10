// The interval that runs only while needed (shared/activeInterval.ts, used by renderer/src/promptQueue.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveInterval } from '../src/shared/activeInterval';

describe('ActiveInterval', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ticks with its period only while active', () => {
    const tick = vi.fn();
    const iv = new ActiveInterval(tick, 250);
    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    iv.set(true);
    expect(iv.running).toBe(true);
    vi.advanceTimersByTime(249);
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(3);
    iv.set(false);
    expect(iv.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('keeps one timer and its phase when set active again', () => {
    const tick = vi.fn();
    const iv = new ActiveInterval(tick, 250);
    iv.set(true);
    vi.advanceTimersByTime(200);
    iv.set(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(50);
    expect(tick).toHaveBeenCalledTimes(1);
    iv.set(false);
    iv.set(false);
    expect(iv.running).toBe(false);
  });
});
