// One shared, calm blink for the "working" dots (renderer/src/blink.ts puts it on <html>). An infinite CSS animation makes
// Chromium composite and present a frame at every vsync while it runs (about 40 % of a core on a 240 Hz display for a single
// dot), so the dots do not animate: one timer flips the phase twice a second (a 1 Hz blink, two frames a second). The timer
// runs only while something holds the blink, and the phase stays off with prefers-reduced-motion (a static dot).

/** Half a blink period: the halo is on for this long, then off for this long. */
export const BLINK_HALF_MS = 500;

export class SharedBlink {
  private holders = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private on = false;

  /** `show(on)` applies a phase; `reducedMotion()` is asked at every flip (the system setting can change any time). */
  constructor(private readonly show: (on: boolean) => void, private readonly reducedMotion: () => boolean) {}

  private flip(): void {
    this.on = this.reducedMotion() ? false : !this.on;
    this.show(this.on);
  }

  /** Starts the blink (if it is not running yet); the returned function lets go of it (once). */
  hold(): () => void {
    this.holders++;
    if (!this.timer) {
      this.flip();
      this.timer = setInterval(() => this.flip(), BLINK_HALF_MS);
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holders--;
      if (this.holders > 0 || !this.timer) return;
      clearInterval(this.timer);
      this.timer = null;
      this.on = false;
      this.show(false);
    };
  }

  /** Number of views holding the blink (tests). */
  get count(): number {
    return this.holders;
  }
}
