// The working dots blink from one shared timer (shared/blink.ts): it sets `data-blink` on <html> in the "on" phase and CSS
// shows the halo then (styles.css, `.dot.working`). No CSS animation runs while agents work.
import { useEffect } from 'react';
import { SharedBlink } from '../../shared/blink';

export const BLINK_ATTRIBUTE = 'data-blink';

const blink = new SharedBlink(
  (on) => document.documentElement.toggleAttribute(BLINK_ATTRIBUTE, on),
  () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
);

/** Keeps the shared blink running while `active` (a cell that shows a working dot). */
export function useBlink(active: boolean): void {
  useEffect(() => (active ? blink.hold() : undefined), [active]);
}
