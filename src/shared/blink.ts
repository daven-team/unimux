// One shared, calm timer for indicators that show ongoing work for a long time (the "working" dots of agent cells);
// renderer/src/blink.ts puts its phase on <html>. An infinite CSS animation makes Chromium composite and present a frame at
// every vsync while it runs (about 40 % of a core on a 240 Hz display for a single dot), so these indicators do not animate
// continuously: one timer steps through a few phases (each step is one frame). The timer runs only while something holds it
// and it is allowed (the window is shown and the system does not ask for reduced motion); otherwise no phase is shown (a
// static indicator).

/** Half a blink period of the two-phase blink: the halo is on for this long, then off for this long. */
export const BLINK_HALF_MS = 500;

export class SharedBlink {
  private holders = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private phase = 0;
  private allowed = true;

  /**
   * `show(phase)` applies a phase: while running they go 1, 2, ..., `phases - 1`, 0 and around again (two phases: on, off);
   * `null` once the timer stops. One step every `stepMs`.
   */
  constructor(private readonly show: (phase: number | null) => void, private readonly phases = 2, private readonly stepMs = BLINK_HALF_MS) {}

  /** Starts the timer (if it is not running yet); the returned function lets go of it (once). */
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

  /** False while the window is hidden or reduced motion is asked for: no timer runs, no phase is shown. */
  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
    this.update();
  }

  private update(): void {
    const run = this.holders > 0 && this.allowed;
    if (run && !this.timer) {
      this.phase = 0;
      this.step();
      this.timer = setInterval(() => this.step(), this.stepMs);
    } else if (!run && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.phase = 0;
      this.show(null);
    }
  }

  private step(): void {
    this.phase = (this.phase + 1) % this.phases;
    this.show(this.phase);
  }

  /** Number of views holding the timer (tests). */
  get count(): number {
    return this.holders;
  }

  /** The timer runs (tests). */
  get running(): boolean {
    return this.timer !== null;
  }
}
