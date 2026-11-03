// 1.1.2: a threshold slider (any whole percent) instead of a select with fixed steps. The value is kept as a local draft while
// it is dragged or stepped and saved once: on release, on blur, or after a short pause, so a drag does not write state.json
// on every pointer move.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { THRESHOLD_MAX, THRESHOLD_MIN } from '../../../shared/alerts';

const SAVE_AFTER_MS = 400;
const PAGE_STEP = 10;

export function PercentSlider({ id, value, label, disabled, onCommit, min = THRESHOLD_MIN, max = THRESHOLD_MAX }: {
  id: string;
  value: number;
  label: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const valueRef = useRef(value);
  valueRef.current = value;
  // A value still waiting for its pause is saved when the slider goes away (the settings tab closes, a section changes).
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (pending.current !== null && pending.current !== valueRef.current) commitRef.current(pending.current);
  }, []);

  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  const flush = () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    setDraft(null);
    if (next !== null && next !== valueRef.current) commitRef.current(next);
  };
  const change = (n: number, delay = SAVE_AFTER_MS) => {
    const next = clamp(n);
    pending.current = next;
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, delay);
  };

  const shown = draft ?? value;
  const ratio = (shown - min) / (max - min || 1);
  return <span className={`threshold-slider ${disabled ? 'disabled' : ''}`}>
    <input id={id} type="range" min={min} max={max} step={1} value={shown} disabled={disabled}
      aria-label={label} aria-valuetext={`${shown}%`}
      style={{ '--fill': ratio } as CSSProperties}
      onChange={(e) => change(Number(e.target.value))}
      onPointerUp={flush}
      onPointerCancel={flush}
      onBlur={flush}
      onKeyDown={(e) => {
        // Arrows step by one natively; PageUp/PageDown step by ten (the browser's page step depends on the range).
        if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
        e.preventDefault();
        change(shown + (e.key === 'PageUp' ? PAGE_STEP : -PAGE_STEP));
      }} />
    <span className="threshold-slider-value" aria-hidden="true">{shown}%</span>
  </span>;
}
