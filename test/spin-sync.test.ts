// One phase for all spinners of a window (src/shared/spinSync.ts).
import { describe, expect, it } from 'vitest';
import { alignSpinners, SPIN_ANIMATION, watchSpinners, type SpinAnimation } from '../src/shared/spinSync';

describe('alignSpinners', () => {
  it('sets the start time of running spin animations to the timeline origin', () => {
    const list: SpinAnimation[] = [
      { animationName: SPIN_ANIMATION, playState: 'running', startTime: 12345 },
      { animationName: SPIN_ANIMATION, playState: 'running', startTime: null },
      { animationName: 'other', playState: 'running', startTime: 7 },
    ];
    alignSpinners(list);
    expect(list.map((a) => a.startTime)).toEqual([0, 0, 7]);
  });

  it('leaves a paused spinner alone, setting its start time would make it run', () => {
    const paused: SpinAnimation = { animationName: SPIN_ANIMATION, playState: 'paused', startTime: null };
    alignSpinners([paused]);
    expect(paused.startTime).toBeNull();
  });
});

describe('watchSpinners', () => {
  function setup() {
    const listeners = new Map<string, (e: unknown) => void>();
    const animations: SpinAnimation[] = [{ animationName: SPIN_ANIMATION, playState: 'running', startTime: 99 }];
    const doc = {
      addEventListener: (t: string, l: (e: unknown) => void) => listeners.set(t, l),
      getAnimations: () => animations,
    } as unknown as Document;
    const frames: Array<() => void> = [];
    let shown: (v: boolean) => void = () => {};
    watchSpinners(doc, (cb) => frames.push(cb), (cb) => { shown = cb; });
    return { animations, frames, listeners, shown: (v: boolean) => shown(v) };
  }

  it('aligns once per frame however many spinners start in it', () => {
    const { animations, frames, listeners } = setup();
    listeners.get('animationstart')!({ animationName: SPIN_ANIMATION });
    listeners.get('animationstart')!({ animationName: SPIN_ANIMATION });
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(animations[0].startTime).toBe(0);
  });

  it('ignores other animations and aligns again when the window is shown', () => {
    const { frames, listeners, shown } = setup();
    listeners.get('animationstart')!({ animationName: 'pill-in' });
    expect(frames).toHaveLength(0);
    shown(false);
    expect(frames).toHaveLength(0);
    shown(true);
    expect(frames).toHaveLength(1);
  });
});
