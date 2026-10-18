// The quit waits (bounded) for a running account swap or "Set as main" activation (0.9.6): quitting in the middle of one can
// leave the live Claude login half swapped and Claude Code's lock directories behind. No Electron imports, so it is tested in Node.

/** Longest time the wind-down waits for a running swap before it goes on anyway (well inside SHUTDOWN_HARD_LIMIT_MS). */
export const QUIT_SWAP_WAIT_MS = 5000;
/**
 * The second wait, after the cells were shut down: an activation that waited for a Claude Code lock a cell held can finish
 * then. Both waits plus the terminal shutdown (about 4 s) and the last save (3 s) stay well inside SHUTDOWN_HARD_LIMIT_MS.
 */
export const QUIT_SWAP_AFTER_CELLS_MS = 3000;

export interface IdleWaitDeps {
  /** True while the work runs. */
  busy(): boolean;
  /** Resolves once the work is done. */
  idle(): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/**
 * Waits until the work is idle, at most `boundMs`. Resolves true when it is idle (at once when it already was, without a timer),
 * false when the bound ran out first. Never rejects.
 */
export function waitUntilIdle(deps: IdleWaitDeps, boundMs: number = QUIT_SWAP_WAIT_MS): Promise<boolean> {
  if (!deps.busy()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (idle: boolean) => {
      if (done) return;
      done = true;
      deps.clearTimer(timer);
      resolve(idle);
    };
    const timer = deps.setTimer(() => finish(!deps.busy()), boundMs);
    // One release is not enough: a retry or a poll may claim the slot again at once, so it is checked again each time.
    const watch = (): void => {
      if (done) return;
      if (!deps.busy()) { finish(true); return; }
      deps.idle().then(watch, () => finish(!deps.busy()));
    };
    watch();
  });
}
