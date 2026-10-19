// Coalesces item updates for the transfer port: a state change goes out at once, progress of one item at most every
// `intervalMs` (about 10 a second), always with the latest values. Updates of one turn travel as one message.
import type { TransferItem } from '../shared/sftp';

export class ItemThrottle {
  private dirty = new Map<string, { item: TransferItem; force: boolean }>();
  private lastSent = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;

  constructor(private readonly send: (items: TransferItem[]) => void, private readonly intervalMs = 100, private readonly now: () => number = Date.now) {}

  push(item: TransferItem, force: boolean): void {
    const prev = this.dirty.get(item.id);
    this.dirty.set(item.id, { item, force: force || !!prev?.force });
    if (force) { this.flushSoon(); return; }
    const since = this.now() - (this.lastSent.get(item.id) ?? -Infinity);
    if (since >= this.intervalMs) this.flushSoon();
    else this.arm(this.intervalMs - since);
  }

  forget(ids: string[]): void {
    for (const id of ids) { this.dirty.delete(id); this.lastSent.delete(id); }
  }

  private flushSoon(): void {
    if (!this.immediate) this.immediate = setImmediate(() => { this.immediate = null; this.flush(); });
  }

  private arm(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(1, ms));
  }

  flush(): void {
    const now = this.now();
    const out: TransferItem[] = [];
    let wait = Infinity;
    for (const [id, { item, force }] of this.dirty) {
      const since = now - (this.lastSent.get(id) ?? -Infinity);
      if (force || since >= this.intervalMs) {
        out.push(item);
        this.dirty.delete(id);
        this.lastSent.set(id, now);
      } else wait = Math.min(wait, this.intervalMs - since);
    }
    if (out.length) this.send(out);
    if (wait !== Infinity) this.arm(wait);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
    this.immediate = null;
    this.dirty.clear();
  }
}
