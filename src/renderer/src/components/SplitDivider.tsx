import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { clampSplitRatio, splitRatioForKey, SPLIT_DEFAULT_RATIO } from '../../../shared/splitView';
import { setSplitRatio, useSplitStore } from '../splitView';
import { terminals } from '../terminals/TerminalManager';

/** The edge between the grid and the tab beside it (split view): drag, arrows, Home / End, Enter or a double click for half. */
export function SplitDivider() {
  const { tr } = useI18n();
  const ratio = useSplitStore((st) => st.ratio);
  // Swapped sides (the tab on the left): the pointer and the arrows move the edge, so they work on the left side's share.
  const swapped = useSplitStore((st) => st.swapped);
  const flip = (share: number) => (swapped ? 1 - share : share);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Terminals are fitted once when the drag ends (TerminalManager.holdFits), not at every pause of the pointer. */
  const fitHold = useRef<(() => void) | null>(null);
  const width = () => handle.current?.parentElement?.getBoundingClientRect().width ?? 0;
  const release = () => { const done = fitHold.current; fitHold.current = null; if (done) setTimeout(done, 0); };
  useEffect(() => () => { fitHold.current?.(); fitHold.current = null; }, []);
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add('panel-resizing');
    return () => document.documentElement.classList.remove('panel-resizing');
  }, [dragging]);
  const finish = (cancel: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    setSplitRatio(cancel ? current.start : useSplitStore.getState().ratio, width());
    release();
  };
  const label = tr('Szerokość gridu i pliku obok');
  const percent = Math.round(ratio * 100);
  return (
    <div
      ref={handle}
      className={`split-divider ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={tr('{percent}% dla gridu', { percent })}
      tabIndex={0}
      title={tr('{label} · przeciągnij lub użyj strzałek · podwójny klik: domyślna szerokość', { label })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, start: ratio };
        fitHold.current?.();
        fitHold.current = terminals.holdFits();
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        const box = handle.current?.parentElement?.getBoundingClientRect();
        if (!current || current.id !== e.pointerId || !box) return;
        useSplitStore.setState({ ratio: clampSplitRatio(flip((e.clientX - box.left) / box.width), box.width) });
      }}
      onPointerUp={(e) => {
        finish(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() => setSplitRatio(SPLIT_DEFAULT_RATIO, width())}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && drag.current) { e.preventDefault(); finish(true); return; }
        const next = splitRatioForKey(flip(ratio), e.key, e.shiftKey, width());
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        setSplitRatio(flip(next), width());
      }}
    />
  );
}
