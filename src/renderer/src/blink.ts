// Indicators of ongoing work blink from one shared timer (shared/blink.ts): it sets `data-blink` on <html> in the "on"
// phase and CSS shows the phase (styles.css: `.dot.working` halo, `.wait-dot`). No CSS animation runs while agents work.
// The timer stops while the window is hidden or minimized and while the system asks for reduced motion.
import { useEffect } from 'react';
import { SharedBlink } from '../../shared/blink';
import { onWindowShown } from './windowShown';

export const BLINK_ATTRIBUTE = 'data-blink';

const blink = new SharedBlink((on) => document.documentElement.toggleAttribute(BLINK_ATTRIBUTE, on));
const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let shown = true;
const sync = () => blink.setAllowed(shown && !reducedMotion?.matches);
reducedMotion?.addEventListener('change', sync);
onWindowShown((next) => { shown = next; sync(); });
sync();

/** Keeps the shared blink running while `active` (a cell that shows a working dot, a dialog that waits). */
export function useBlink(active: boolean): void {
  useEffect(() => (active ? blink.hold() : undefined), [active]);
}
