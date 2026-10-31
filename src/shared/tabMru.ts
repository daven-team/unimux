// Ctrl+Tab between recently used tabs of the strip (1.1.1), like a browser or an IDE: the pure part. The renderer keeps the
// list of tab keys newest first (renderer/tabSwitcher.ts); a switch walks the tabs the strip shows in that order.

/** Most recently used keys kept (more than any strip shows). */
export const MRU_LIMIT = 200;

/** The list with `key` in front (it moves there when it was in the list already). */
export function touchMru(mru: readonly string[], key: string | null, limit = MRU_LIMIT): string[] {
  if (!key) return mru as string[];
  if (mru[0] === key) return mru as string[];
  return [key, ...mru.filter((k) => k !== key)].slice(0, limit);
}

/**
 * The tabs of a switch: the one in front first, then the others the strip shows, most recently used first; tabs never used
 * since the start follow in their strip order. Keys the strip does not show (closed, another project's with the strip scope
 * 'project', a grid in its own window) are left out.
 */
export function mruOrder(mru: readonly string[], shown: readonly string[], active: string | null): string[] {
  const visible = new Set(shown);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => { if (visible.has(key) && !seen.has(key)) { seen.add(key); out.push(key); } };
  if (active) add(active);
  for (const key of mru) add(key);
  for (const key of shown) add(key);
  return out;
}

/** The index after a step of `dir` (wrapping), from `at`; a first step back from the front goes to the least recent tab. */
export function stepIndex(length: number, at: number, dir: 1 | -1): number {
  if (length <= 0) return 0;
  return ((at + dir) % length + length) % length;
}

/** Modifier keys a combo holds, as KeyboardEvent flags: the switch commits when none of them is held any more. */
export interface HeldModifiers { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

/** Is any of the switch's modifiers (all but Shift, which only reverses the direction) still held? */
export function switchHeld(mods: HeldModifiers, event: { ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return (mods.ctrl && event.ctrlKey) || (mods.alt && event.altKey) || (mods.meta && event.metaKey);
}
