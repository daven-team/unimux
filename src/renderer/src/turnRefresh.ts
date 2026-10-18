// Agent turn ends refresh the views that show the project on disk (Files tree, its git marks, the Git panel). Only views that are
// on screen listen, so a hidden project reads nothing; the refreshes are reads only and keep the views' own trust checks.
import { findCell, getProfile } from '../../shared/state';
import { createTurnRefresh, type RefreshTarget } from '../../shared/turnRefresh';
import { getS } from './store';

const listeners = new Set<(target: RefreshTarget) => void>();

const refresher = createTurnRefresh((target) => {
  for (const listener of [...listeners]) {
    try { listener(target); } catch { /* one view failing does not stop the others */ }
  }
}, {
  now: () => Date.now(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (timer) => window.clearTimeout(timer as number),
});

/** A Claude or Codex cell finished a turn: its project (or its worktree) is refreshed after a short wait. */
export function noteAgentTurnEnd(cellId: string): void {
  const s = getS();
  const found = findCell(s, cellId);
  if (!found || found.cell.ssh || getProfile(s, found.cell.profileId).cli === 'shell') return;
  refresher.note({ projectId: found.project.id, worktree: found.cell.worktree?.path });
}

/** Called with every refresh target while registered; returns the unsubscribe. */
export function onTurnRefresh(listener: (target: RefreshTarget) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether two folder paths are the same folder (slashes, a trailing slash and, on Windows and macOS, letter case aside). */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => {
    const out = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return window.mc.platform === 'linux' ? out : out.toLowerCase();
  };
  return norm(a) === norm(b);
}
