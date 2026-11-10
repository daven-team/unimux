// An interval that runs only while there is something for it to do: `set(true)` starts it (if it is not running), `set(false)`
// stops it. The ticks keep their period from the moment it started; an idle window has no timer waking it up for nothing.
// No DOM imports, so it is tested in Node.

export class ActiveInterval {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly tick: () => void, private readonly ms: number) {}

  set(active: boolean): void {
    if (active && !this.timer) this.timer = setInterval(() => this.tick(), this.ms);
    else if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The timer runs (tests). */
  get running(): boolean {
    return this.timer !== null;
  }
}
