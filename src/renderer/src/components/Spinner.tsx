import { useEffect, useRef, useState } from 'react';
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
 * A refresh arrow that turns smoothly while `spinning` (a CSS rotation in styles.css that exists only while it spins, so an
 * idle button costs nothing). Static with reduced motion.
 */
export function RefreshIcon({ spinning }: { spinning: boolean }) {
  return <span className={`refresh-icon ${spinning ? 'spinning' : ''}`} aria-hidden><IRestart /></span>;
}

/** A small busy ring (`className` styles it) that turns smoothly while it is shown (`.busy-ring` in styles.css). */
export function BusyRing({ className }: { className: string }) {
  return <span className={`busy-ring ${className}`} aria-hidden="true" />;
}
