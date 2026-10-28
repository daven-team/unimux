// The working dot of a cell steps from one shared timer (shared/blink.ts) once its smooth first waves are over: the timer puts
// the phase on <html> as `data-pulse` and CSS draws it (terminalCell.css: the ripple of `.cell-icon .dot.working`). No CSS
// animation runs continuously while agents work. The timer stops while the window is hidden or minimized and while the
// system asks for reduced motion (the dot then shows a still ring).
import { useEffect } from 'react';
import { SharedBlink } from '../../shared/blink';
import { onWindowShown } from './windowShown';

export const PULSE_ATTRIBUTE = 'data-pulse';
/** Phases of one wave of the ripple (1-3 the ring grows and fades, 0 a rest) and the time of one: a 1.3 s wave, about three frames a second. */
export const PULSE_PHASES = 4;
export const PULSE_STEP_MS = 320;

const blink = new SharedBlink((phase) => {
  if (phase === null) document.documentElement.removeAttribute(PULSE_ATTRIBUTE);
  else document.documentElement.setAttribute(PULSE_ATTRIBUTE, String(phase));
}, PULSE_PHASES, PULSE_STEP_MS);
const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let shown = true;
const sync = () => blink.setAllowed(shown && !reducedMotion?.matches);
reducedMotion?.addEventListener('change', sync);
onWindowShown((next) => { shown = next; sync(); });
sync();

/** Keeps the shared pulse running while `active` (a cell that shows a working dot). Spinners turn with CSS (Spinner.tsx). */
export function useBlink(active: boolean): void {
  useEffect(() => (active ? blink.hold() : undefined), [active]);
}
