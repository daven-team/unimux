// One shared, calm blink for indicators that show ongoing work (the "working" dots, long waits in dialogs);
// renderer/src/blink.ts puts it on <html>. An infinite CSS animation makes Chromium composite and present a frame at every
// vsync while it runs (about 40 % of a core on a 240 Hz display for a single dot), so these indicators do not animate: one
// timer flips the phase twice a second (a 1 Hz blink, two frames a second). The timer runs only while something holds the
// blink and it is allowed (the window is shown and the system does not ask for reduced motion); otherwise the phase stays
// off (a static indicator).

/** Half a blink period: the halo is on for this long, then off for this long. */
export const BLINK_HALF_MS = 500;

export class SharedBlink {
  private holders = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private on = false;
  private allowed = true;

  /** `show(on)` applies a phase. */
  constructor(private readonly show: (on: boolean) => void) {}

  /** Starts the blink (if it is not running yet); the returned function lets go of it (once). */
  hold(): () => void {
    this.holders++;
    this.update();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holders--;
      this.update();
    };
  }

  /** False while the window is hidden or reduced motion is asked for: no timer runs, the phase stays off. */
  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
    this.update();
  }

  private update(): void {
    const run = this.holders > 0 && this.allowed;
    if (run && !this.timer) {
      this.flip();
      this.timer = setInterval(() => this.flip(), BLINK_HALF_MS);
    } else if (!run && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.on = false;
      this.show(false);
    }
  }

  private flip(): void {
    this.on = !this.on;
    this.show(this.on);
  }

  /** Number of views holding the blink (tests). */
  get count(): number {
    return this.holders;
  }

  /** The timer runs (tests). */
  get running(): boolean {
    return this.timer !== null;
  }
}
