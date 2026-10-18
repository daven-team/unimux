/**
 * Guards for windows that outlive their native object: after a window is closed (and while the process
 * winds down for an update) async callbacks still fire, and touching a destroyed window or its
 * webContents throws "Object has been destroyed". Structural types keep this free of Electron imports.
 */

export interface WindowLike {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void };
}

/** True while both the window and its webContents can still be used. */
export function isLive<T extends { isDestroyed(): boolean; webContents: { isDestroyed(): boolean } }>(win: T | null | undefined): win is T {
  if (!win) return false;
  try { return !win.isDestroyed() && !win.webContents.isDestroyed(); } catch { return false; }
}

/**
 * The IPC sender check (R9) of ssh:*, accounts:*, auth:*, usage:refresh and the secret clipboard: only the app window's own
 * webContents (a top-level frame), and only while it is alive. Since 0.9.6 it guards every channel that changes something. Another window (a login or update window, a foreign frame) is refused.
 */
export function isFromWindow(win: { isDestroyed(): boolean; webContents: { isDestroyed(): boolean; mainFrame?: unknown } } | null | undefined, event: { sender: unknown; senderFrame?: unknown }): boolean {
  if (!isLive(win) || event.sender !== win.webContents) return false;
  const main = win.webContents.mainFrame;
  if (main === undefined || !('senderFrame' in event)) return true;
  const frame = event.senderFrame as { parent?: unknown } | null | undefined;
  // Any top-level frame of the app window counts (0.9.6): on a reload Chromium may swap the main frame, and the old document's
  // last `state:edit` (its beforeunload flush) can arrive after the new one committed. Electron reports a frame that is already
  // gone as null; the webContents is still the app window's, so it is that old document. A subframe (it has a parent) is refused.
  if (frame === main || frame === null || frame === undefined) return true;
  return frame.parent === null;
}

/** Sends to a window only if it is still alive; true when the message was handed over. Never throws. */
export function safeSend(win: WindowLike | null | undefined, channel: string, ...args: unknown[]): boolean {
  if (!isLive(win)) return false;
  try { win.webContents.send(channel, ...args); return true; } catch { return false; }
}

/** Runs `action` with the window only while it is alive; the result is undefined otherwise. Never throws. */
export function withLiveWindow<W extends { isDestroyed(): boolean }, R>(win: W | null | undefined, action: (win: W) => R): R | undefined {
  try { return win && !win.isDestroyed() ? action(win) : undefined; } catch { return undefined; }
}

/** 'quiet' covers shutdown, the update hand-over and the startup check: nothing may open a dialog there. */
export type UncaughtPhase = 'running' | 'quiet';
export type UncaughtDecision = 'ignore' | 'log' | 'show';

/**
 * What the main process does with an exception nobody caught. "Object has been destroyed" is a race
 * with a closed window and never actionable, so it is only logged. While shutting down (or installing an
 * update) nothing may open a dialog: the blocking native dialog keeps the process alive and the installer
 * waits for it. Real errors during normal operation are still shown, without blocking the event loop.
 */
export function decideUncaught(error: unknown, phase: UncaughtPhase): UncaughtDecision {
  const message = error instanceof Error ? error.message : String(error);
  if (/Object has been destroyed/i.test(message)) return 'log';
  return phase === 'quiet' ? 'log' : 'show';
}

/** Longest time the process may spend winding down before it exits anyway, so an installer is never kept waiting. */
export const SHUTDOWN_HARD_LIMIT_MS = 20 * 1000;

/** Allows at most `max` error dialogs, no closer together than `minGapMs`, so a recurring error cannot bury the screen. */
export function createDialogLimiter(minGapMs = 10_000, max = 3): (now: number) => boolean {
  let shown = 0;
  let last = -Infinity;
  return (now) => {
    if (shown >= max || now - last < minGapMs) return false;
    shown++; last = now;
    return true;
  };
}

/** How long the app keeps waiting for the installer to quit it, while the update window still supervises, before starting anyway. */
export const HANDOFF_QUIT_WAIT_MAX_MS = 75 * 1000;

/**
 * After the hand-over the installer is expected to quit the app. If it has not, starting the full app next to a
 * waiting installer (late administrator prompt) is wrong while the update window is still supervising; give up
 * waiting only once it is not, or the wait has run out.
 */
export function handoffWatchdogAction(installing: boolean, waitedMs: number): 'wait' | 'start' {
  return installing && waitedMs < HANDOFF_QUIT_WAIT_MAX_MS ? 'wait' : 'start';
}

/** A launch that arrived while the app was winding down is repeated afterwards, unless an update took over. */
export const shouldRelaunchAfterQuit = (launchRequested: boolean, updateStarted: boolean): boolean => launchRequested && !updateStarted;
