// Targets being written on one side (the local disk across every queue, one remote server per session). Two jobs never
// write the same file (or its part file) at once: a second one waits until the first released it, then meets it as an
// existing file (a conflict). Keys are case-folded on case-insensitive disks, so "A.txt" and "a.txt" are one target.
export class TargetRegistry {
  private held = new Map<string, string>();
  private waiters = new Map<string, Array<() => void>>();

  constructor(readonly key: (path: string) => string) {}

  isHeld(path: string): boolean { return this.held.has(this.key(path)); }

  /** True when `owner` holds it now; false when someone else does. */
  hold(path: string, owner: string): boolean {
    const k = this.key(path);
    const by = this.held.get(k);
    if (by !== undefined && by !== owner) return false;
    this.held.set(k, owner);
    return true;
  }

  release(path: string, owner: string): void {
    const k = this.key(path);
    if (this.held.get(k) !== owner) return;
    this.held.delete(k);
    const waiting = this.waiters.get(k);
    this.waiters.delete(k);
    for (const w of waiting ?? []) w();
  }

  /** Calls `fn` once when `path` is released (at once when it is free). */
  whenFree(path: string, fn: () => void): void {
    const k = this.key(path);
    if (!this.held.has(k)) { fn(); return; }
    const list = this.waiters.get(k) ?? [];
    list.push(fn);
    this.waiters.set(k, list);
  }

  size(): number { return this.held.size; }
}
