// Output of several terminals flushed in the same event-loop turn travels to the renderer as one port message.
import type { HostToRendererPort } from '../shared/ipc';

export class OutputBatcher {
  private items: Array<[string, string]> = [];
  private scheduled = false;

  constructor(
    private readonly post: (m: HostToRendererPort) => void,
    private readonly schedule: (fn: () => void) => void = (fn) => { setImmediate(fn); },
  ) {}

  /**
   * Queues one terminal's output; it is posted at the end of this turn (no added delay, the timers already coalesced it).
   * `now`: a typed echo, posted at once together with whatever is queued (one more message instead of a turn of waiting
   * behind other terminals' output and timers).
   */
  data(id: string, data: string, now = false): void {
    this.items.push([id, data]);
    if (now) { this.flush(); return; }
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  /** Posts what is queued now (also before any other message, so output never falls behind an exit). */
  flush(): void {
    this.scheduled = false;
    if (!this.items.length) return;
    const items = this.items;
    this.items = [];
    this.post(items.length === 1 ? { t: 'data', id: items[0][0], data: items[0][1] } : { t: 'dataBatch', items });
  }

  /** Forgets what is queued (a new renderer gets the replay tail, which already holds it). */
  drop(): void {
    this.items = [];
  }
}
