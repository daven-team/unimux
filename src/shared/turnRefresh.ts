// Refreshing the Files tree and the Git views after agent turns: every turn end of a project (or of one worktree) restarts a short
// trailing wait, so agents finishing together cause one refresh per project. A project whose agents keep finishing is still
// refreshed at least every `maxWaitMs`.

export const TURN_REFRESH_DELAY_MS = 1500;
export const TURN_REFRESH_MAX_WAIT_MS = 6000;

export interface RefreshTarget { projectId: string; worktree?: string }

export interface RefreshTimers { now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(timer: unknown): void }

const keyOf = (target: RefreshTarget): string => `${target.projectId}\n${target.worktree ?? ''}`;

export function createTurnRefresh(
  fire: (target: RefreshTarget) => void, timers: RefreshTimers, delayMs = TURN_REFRESH_DELAY_MS, maxWaitMs = TURN_REFRESH_MAX_WAIT_MS,
): { note(target: RefreshTarget): void; dispose(): void } {
  const pending = new Map<string, { target: RefreshTarget; first: number; timer: unknown }>();
  const run = (key: string): void => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    fire(entry.target);
  };
  return {
    note(target) {
      const key = keyOf(target);
      const now = timers.now();
      const entry = pending.get(key);
      const first = entry?.first ?? now;
      if (entry) timers.clearTimer(entry.timer);
      const wait = Math.max(0, Math.min(delayMs, first + maxWaitMs - now));
      pending.set(key, { target: { projectId: target.projectId, ...(target.worktree ? { worktree: target.worktree } : {}) }, first, timer: timers.setTimer(() => run(key), wait) });
    },
    dispose() {
      for (const entry of pending.values()) timers.clearTimer(entry.timer);
      pending.clear();
    },
  };
}

/** Whether two folder paths are the same folder (slashes and a trailing slash aside; letter case too where the file system ignores it). */
export function sameFolder(a: string, b: string, ignoreCase: boolean): boolean {
  const norm = (p: string) => {
    const out = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return ignoreCase ? out.toLowerCase() : out;
  };
  return norm(a) === norm(b);
}

/**
 * Whether a refresh target concerns a view of `projectId` showing `worktree` (undefined = the project folder itself): a project
 * turn refreshes only the project view, a worktree turn only the view of that worktree.
 */
export function refreshTargetMatches(target: RefreshTarget, projectId: string, worktree: string | undefined, ignoreCase: boolean): boolean {
  if (target.projectId !== projectId) return false;
  if (worktree === undefined) return !target.worktree;
  return target.worktree !== undefined && sameFolder(target.worktree, worktree, ignoreCase);
}
