// The per-frame scrollbar sync of xterm's Viewport (shared/viewportSync.ts, used by renderer/terminals/TerminalManager.ts).
import { describe, expect, it } from 'vitest';
import { coalesceViewportSync, VIEWPORT_INPUT_EVENTS, type FrameScheduler } from '../src/shared/viewportSync';

function setup() {
  const calls: unknown[][] = [];
  const vp = {
    _sync(...args: unknown[]) { calls.push(['sync', ...args]); },
    scrollLines(...args: unknown[]) { calls.push(['scrollLines', ...args]); },
    scrollToLine(...args: unknown[]) { calls.push(['scrollToLine', ...args]); },
  };
  const term = { _core: { _viewport: vp } };
  const queued = new Map<number, () => void>();
  let next = 0;
  const frames: FrameScheduler = { request: (cb) => { queued.set(++next, cb); return next; }, cancel: (id) => { queued.delete(id); } };
  const runFrame = () => { const cbs = [...queued.values()]; queued.clear(); cbs.forEach((cb) => cb()); };
  const host = new EventTarget();
  const undo = coalesceViewportSync(term, host, frames);
  return { vp, calls, queued, runFrame, host, undo };
}

describe('coalesceViewportSync', () => {
  it('folds the line-by-line syncs of the buffer into one per frame', () => {
    const { vp, calls, queued, runFrame } = setup();
    for (let i = 0; i < 50; i++) vp._sync();
    expect(calls).toEqual([]);
    expect(queued.size).toBe(1);
    runFrame();
    expect(calls).toEqual([['sync']]);
    vp._sync();
    runFrame();
    expect(calls).toEqual([['sync'], ['sync']]);
  });

  it('runs a sync with arguments (xterm queued sync) right away', () => {
    const { vp, calls } = setup();
    vp._sync(undefined);
    vp._sync(12);
    expect(calls).toEqual([['sync', undefined], ['sync', 12]]);
  });

  it('syncs first when something reads the scroll position', () => {
    const { vp, calls, queued } = setup();
    vp._sync();
    vp.scrollLines(-3);
    expect(calls).toEqual([['sync'], ['scrollLines', -3]]);
    expect(queued.size).toBe(0);
    vp._sync();
    vp.scrollToLine(5, true);
    expect(calls.slice(2)).toEqual([['sync'], ['scrollToLine', 5, true]]);
    // Nothing pending: no extra sync.
    vp.scrollLines(1);
    expect(calls.slice(4)).toEqual([['scrollLines', 1]]);
  });

  it('syncs before a wheel turn or a click on the terminal reaches xterm', () => {
    for (const type of VIEWPORT_INPUT_EVENTS) {
      const { vp, calls, queued, host } = setup();
      vp._sync();
      host.dispatchEvent(new Event(type));
      expect(calls).toEqual([['sync']]);
      expect(queued.size).toBe(0);
    }
  });

  it('undoes everything and never syncs a disposed terminal', () => {
    const { vp, calls, queued, host, undo } = setup();
    const patched = vp._sync;
    vp._sync();
    undo!();
    expect(queued.size).toBe(0);
    expect(vp._sync).not.toBe(patched);
    host.dispatchEvent(new Event('wheel'));
    vp._sync();
    expect(calls).toEqual([['sync']]);
  });

  it('leaves an xterm without such a viewport alone', () => {
    expect(coalesceViewportSync({}, new EventTarget())).toBeNull();
    expect(coalesceViewportSync({ _core: { _viewport: { _sync() {} } } }, new EventTarget())).toBeNull();
  });
});
