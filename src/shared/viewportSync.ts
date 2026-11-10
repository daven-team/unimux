// xterm 6's Viewport moves its scrollbar synchronously for every line the buffer scrolls (`bufferService.onScroll` calls
// `_sync()`): a cell printing a diff moves the scrollbar, reveals it and re-arms its hide timer (a setTimeout and a clearTimeout)
// dozens of times between two frames, and every move is a style write. Only the last position of a frame is ever drawn, so
// the line-by-line syncs are folded into one per animation frame here. Anything that reads the scrollbar's position (a wheel
// turn, a click on the scrollbar, scrollLines / scrollToLine) gets the pending sync first, so it sees exactly what it saw before.
// 16 cells printing 60 lines a second: 8,200 timers a second become 1,180, renderer script time 28 -> 20 ms a second.
// Uses xterm internals (`_core._viewport`): a version without them is left as it is (the function returns null). No xterm or
// Electron imports, so it is tested in Node.

interface ViewportLike {
  _sync: (...args: unknown[]) => void;
  scrollLines: (...args: unknown[]) => void;
  scrollToLine: (...args: unknown[]) => void;
  /** xterm's own frame-queued sync (every scroll of the terminal, a resize); optional for older shapes. */
  queueSync?: (ydisp?: number) => void;
  _latestYDisp?: number;
}

/** The undo of coalesceViewportSync; `resume()` runs the one sync a hidden terminal skipped (call it when it shows again). */
export type ViewportUnsync = (() => void) & { resume: () => void };

/** Events after which xterm reads the scrollbar's position (capture phase on the terminal's host, before xterm sees them). */
export const VIEWPORT_INPUT_EVENTS = ['wheel', 'mousedown', 'touchstart'] as const;

export interface FrameScheduler {
  request(cb: () => void): number;
  cancel(id: number): void;
}

const animationFrames: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

function viewportOf(term: unknown): ViewportLike | null {
  const vp = (term as { _core?: { _viewport?: Partial<ViewportLike> } } | null)?._core?._viewport;
  if (!vp || typeof vp._sync !== 'function' || typeof vp.scrollLines !== 'function' || typeof vp.scrollToLine !== 'function') return null;
  return vp as ViewportLike;
}

/**
 * Folds the per-line scrollbar syncs of `term` (an opened xterm Terminal) into one per frame. `host` gets capture listeners that
 * flush a pending sync before xterm handles a wheel turn or a click. While `hidden()` (a window nobody sees, R2: WebView2 keeps
 * running animation frames for a minimized window, so every printed line asked for two frames; or a terminal parked off any
 * cell) no sync is scheduled at all; `resume()` of the result runs one when the terminal shows again. Returns the function that undoes it all (call it before
 * the terminal is disposed), or null when this xterm has no such viewport.
 */
export function coalesceViewportSync(term: unknown, host: EventTarget, frames: FrameScheduler = animationFrames, hidden: () => boolean = () => false): ViewportUnsync | null {
  const vp = viewportOf(term);
  if (!vp) return null;
  const sync = vp._sync;
  const scrollLines = vp.scrollLines;
  const scrollToLine = vp.scrollToLine;
  const queueSync = typeof vp.queueSync === 'function' ? vp.queueSync : null;
  let frame = 0;
  let disposed = false;
  /** A line-by-line sync (it reads the buffer's ydisp) and xterm's queued sync (it reads the latest ydisp) skipped while hidden. */
  let skipped = false;
  let skippedQueued = false;
  const flush = () => {
    if (!frame) return;
    frames.cancel(frame);
    frame = 0;
    sync.call(vp);
  };
  vp._sync = function (...args: unknown[]) {
    // `_sync(ydisp)` (xterm's own queued sync of the next frame) and any other call with arguments run as before.
    if (args.length > 0) return sync.apply(vp, args);
    if (frame || disposed) return;
    if (hidden()) { skipped = true; return; }
    frame = frames.request(() => {
      frame = 0;
      if (!disposed) sync.call(vp);
    });
  };
  if (queueSync) {
    vp.queueSync = function (ydisp?: number) {
      if (!disposed && hidden()) {
        if (ydisp !== undefined) vp._latestYDisp = ydisp;
        skippedQueued = true;
        return;
      }
      return queueSync.call(vp, ydisp);
    };
  }
  // A hidden terminal scrolled by code (scrollToBottom of a parked one) gets its scrollbar's size first, or the new position
  // is clamped to a stale height and the sync on resume (same ydisp) does not move it. The resume still runs when it shows.
  const catchUp = () => {
    flush();
    if ((skipped || skippedQueued) && !disposed) sync.call(vp);
  };
  vp.scrollLines = function (...args: unknown[]) { catchUp(); return scrollLines.apply(vp, args); };
  vp.scrollToLine = function (...args: unknown[]) { catchUp(); return scrollToLine.apply(vp, args); };
  for (const type of VIEWPORT_INPUT_EVENTS) host.addEventListener(type, flush, { capture: true, passive: true });
  const undo = () => {
    if (disposed) return;
    disposed = true;
    if (frame) frames.cancel(frame);
    frame = 0;
    for (const type of VIEWPORT_INPUT_EVENTS) host.removeEventListener(type, flush, { capture: true });
    vp._sync = sync;
    vp.scrollLines = scrollLines;
    vp.scrollToLine = scrollToLine;
    if (queueSync) vp.queueSync = queueSync;
  };
  const resume = () => {
    if ((!skipped && !skippedQueued) || disposed) return;
    const queued = skippedQueued && queueSync !== null;
    const lines = skipped || !queued;
    skipped = false;
    skippedQueued = false;
    // xterm's queued sync (a resize, a buffer switch: it reads the latest ydisp), then the folded sync of the next frame
    // for skipped scrolls (it reads the buffer's ydisp, so a parked terminal that printed shows its scrollbar where it is).
    // Both run in the next frame, after the fit of a terminal just attached (a microtask).
    if (queued) queueSync!.call(vp);
    if (lines) vp._sync();
  };
  return Object.assign(undo, { resume });
}
