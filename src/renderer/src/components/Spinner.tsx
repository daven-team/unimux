import { useEffect, useRef, useState } from 'react';
import { useBlink } from '../blink';
import { IRestart } from './icons';

/** Stays true for at least `minMs` after `busy` turns on, so quick actions still show visible feedback. */
export function useHoldBusy(busy: boolean, minMs = 700): boolean {
  const [held, setHeld] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (busy) { since.current = Date.now(); setHeld(true); return; }
    const left = since.current + minMs - Date.now();
    if (left <= 0) { setHeld(false); return; }
    const timer = setTimeout(() => setHeld(false), left);
    return () => clearTimeout(timer);
  }, [busy, minMs]);
  return busy || held;
}

/**
 * A refresh arrow that flips half a turn twice a second while `spinning` (the shared blink, not a CSS animation: a spinner
 * that waits for a login or an install would otherwise present a frame at every vsync). Static with reduced motion.
 */
export function RefreshIcon({ spinning }: { spinning: boolean }) {
  useBlink(spinning);
  return <span className={`refresh-icon ${spinning ? 'spinning' : ''}`} aria-hidden><IRestart /></span>;
}

/** A small busy ring (`className` styles it) that turns with the shared blink while it is shown. */
export function BusyRing({ className }: { className: string }) {
  useBlink(true);
  return <span className={className} aria-hidden="true" />;
}
