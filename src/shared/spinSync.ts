// Every spinner (a working cell's mark, a busy ring) is its own CSS animation, started when its element appeared, and turns in
// 60 steps. Started at different moments, their steps fall in different frames: 20 marks made the compositor draw and present
// on every vsync of a 240 Hz screen instead of 60 times a second, for 12 pixel icons (60 cells, 20 of them shown and working
// at rest: 33 -> 20 percent of a core on a quiet machine, 85 -> 26 on a loaded one; 2 with the animation paused). All spinners of a window are put on one phase here:
// the step of each falls in the same frame, so a window presents 60 times a second however many marks turn. The marks keep turning
// as before. No document or Blink imports, so it is tested in Node.

export const SPIN_ANIMATION = 'mc-spin';

export interface SpinAnimation {
  animationName?: string;
  playState?: string;
  startTime: unknown;
}

/** Aligns the running spin animations; a paused one (the window is minimized) is left alone, setting its start time would make it run. */
export function alignSpinners(animations: Iterable<SpinAnimation>): void {
  for (const a of animations) {
    if (a.animationName === SPIN_ANIMATION && a.playState !== 'paused' && a.startTime !== 0) a.startTime = 0;
  }
}

/** Watches for new spinners (animationstart, coalesced in a frame) and shown windows (`shown`: resumed animations hold their pause point). */
export function watchSpinners(doc: Document, frame: (cb: () => void) => void, shown: (cb: (visible: boolean) => void) => void): void {
  let queued = false;
  const align = () => {
    queued = false;
    alignSpinners(doc.getAnimations() as unknown as Iterable<SpinAnimation>);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    frame(align);
  };
  doc.addEventListener('animationstart', (e) => { if ((e as AnimationEvent).animationName === SPIN_ANIMATION) queue(); }, true);
  shown((visible) => { if (visible) queue(); });
}
