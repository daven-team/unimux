import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUIT_SWAP_AFTER_CELLS_MS, QUIT_SWAP_WAIT_MS, waitUntilIdle } from '../src/main/quitWait';
import { claimSwap, isSwapRunning, releaseSwap, swapIdle } from '../src/main/accounts/swap';
import { SHUTDOWN_HARD_LIMIT_MS } from '../src/main/safeWindow';

function work(busy: boolean) {
  let running = busy;
  let done: () => void = () => undefined;
  const idle = new Promise<void>((resolve) => { done = resolve; });
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    deps: {
      busy: () => running,
      idle: () => idle,
      setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimer: (t: unknown) => { (t as { cleared: boolean }).cleared = true; },
    },
    finish: () => { running = false; done(); },
    fire: () => { for (const t of timers) if (!t.cleared) t.fn(); },
    timers,
  };
}

describe('waitUntilIdle (the quit waits for a running swap, 0.9.6)', () => {
  it('never waits (and sets no timer) when nothing runs', async () => {
    const w = work(false);
    expect(await waitUntilIdle(w.deps, 5000)).toBe(true);
    expect(w.timers).toEqual([]);
  });

  it('resolves true as soon as the work ends, and clears its timer', async () => {
    const w = work(true);
    const result = waitUntilIdle(w.deps, 5000);
    expect(w.timers.map((t) => t.ms)).toEqual([5000]);
    w.finish();
    expect(await result).toBe(true);
    expect(w.timers[0].cleared).toBe(true);
  });

  it('resolves false once the bound runs out while the work still runs', async () => {
    const w = work(true);
    const result = waitUntilIdle(w.deps, 5000);
    w.fire();
    expect(await result).toBe(false);
    w.finish(); // a late end changes nothing
    expect(await result).toBe(false);
  });

  it('the bounds (5 s, then 3 s after the cells) stay well inside the hard shutdown limit', () => {
    expect(QUIT_SWAP_WAIT_MS).toBe(5000);
    expect(QUIT_SWAP_AFTER_CELLS_MS).toBe(3000);
    // 0.15 s + both waits + terminals (about 4 s) + the last save (3 s) leave a margin to the hard limit.
    expect(150 + QUIT_SWAP_WAIT_MS + QUIT_SWAP_AFTER_CELLS_MS + 4000 + 3000).toBeLessThan(SHUTDOWN_HARD_LIMIT_MS - 3000);
  });
});

describe('swapIdle', () => {
  afterEach(() => { if (isSwapRunning()) releaseSwap(); vi.useRealTimers(); });

  it('resolves at once while the slot is free', async () => {
    expect(isSwapRunning()).toBe(false);
    await expect(swapIdle()).resolves.toBeUndefined();
  });

  it('resolves when the holder (a swap or "Set as main") releases the slot', async () => {
    expect(claimSwap()).toBe(true);
    let resolved = false;
    const idle = swapIdle().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    releaseSwap();
    await idle;
    expect(resolved).toBe(true);
  });

  it('a release followed at once by a new claim keeps the quit waiting (within the bound)', async () => {
    vi.useFakeTimers();
    const deps = { busy: isSwapRunning, idle: swapIdle, setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>) };
    claimSwap();
    let result: boolean | undefined;
    void waitUntilIdle(deps, 5000).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(1000);
    // The startup recovery between two attempts: the slot is free for a moment only.
    releaseSwap();
    expect(claimSwap()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBeUndefined();
    releaseSwap();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(true);

    // The same with a holder that never lets go: the bound still ends the wait.
    claimSwap();
    result = undefined;
    void waitUntilIdle(deps, 5000).then((r) => { result = r; });
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(1000); releaseSwap(); claimSwap(); }
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBe(false);
    releaseSwap();
  });

  it('with real timers: the quit wait ends with the swap, or after the bound', async () => {
    vi.useFakeTimers();
    const deps = { busy: isSwapRunning, idle: swapIdle, setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>) };
    claimSwap();
    const ended = waitUntilIdle(deps, 5000);
    await vi.advanceTimersByTimeAsync(1000);
    releaseSwap();
    expect(await ended).toBe(true);

    claimSwap();
    const timedOut = waitUntilIdle(deps, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await timedOut).toBe(false);
    releaseSwap();
  });
});
