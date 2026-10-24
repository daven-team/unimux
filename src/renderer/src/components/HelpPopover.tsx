// The "?" next to a panel title: a small help card that says what the panel is for and what clicks and keys do.
// It opens on hover, on a click (then it stays until a click elsewhere, Esc or another click) and on keyboard focus.
// The card lives in a portal with a fixed position, placed like the app's tooltips: under the "?", shifted left or right
// to stay inside the window, so a panel at the window's edge never cuts it off.
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placeTooltip } from '../../../shared/tooltipPosition';
import './helpPopover.css';

/** One line of the card: what to do (a key, a click) and what it does. */
export type HelpRow = readonly [key: ReactNode, text: ReactNode];

/** Leaving the "?" this long before reaching the card still keeps it open. */
const CLOSE_DELAY = 160;
/** The card keeps this distance from the window edges. */
const MARGIN = 8;

export function HelpPopover({ label, intro, rows, footer }: { label: string; intro?: ReactNode; rows?: readonly HelpRow[]; footer?: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  const closeTimer = useRef(0);

  const close = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    setOpen(false);
    setPinned(false);
    setPos(null);
  }, []);
  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const leave = () => {
    window.clearTimeout(closeTimer.current);
    // Pinned by a click, or opened from the keyboard: the pointer passing by does not close it.
    if (pinned || pop.current?.contains(document.activeElement) || (document.activeElement === button.current && button.current?.matches(':focus-visible'))) return;
    closeTimer.current = window.setTimeout(close, CLOSE_DELAY);
  };

  const place = useCallback(() => {
    const anchor = button.current;
    const card = pop.current;
    if (!anchor || !card) return;
    const size = card.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const at = placeTooltip(rect, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight }, 6, MARGIN);
    // Flipped above the "?" it would cover the panel's own header: stay below and scroll inside when the window is short,
    // unless even a short card would not fit there.
    const below = rect.bottom + 6;
    const room = window.innerHeight - MARGIN - below;
    if (at.top < rect.top && room >= 160) setPos({ left: at.left, top: below, maxHeight: room });
    else setPos({ left: at.left, top: at.top });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place, intro, rows, footer]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (button.current?.contains(target) || pop.current?.contains(target))) return;
      close();
    };
    // A scrolled panel moves the "?": the card goes rather than float away from it (its own scrolling is fine).
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && pop.current?.contains(e.target))) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('blur', close);
    };
  }, [open, close, place]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`help ${open ? 'on' : ''}`}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={show}
        onPointerLeave={leave}
        onFocus={show}
        onBlur={(e) => { if (!pinned && !pop.current?.contains(e.relatedTarget as Node | null)) close(); }}
        onClick={() => {
          if (pinned) return close();
          show();
          setPinned(true);
        }}
      >?</button>
      {open && createPortal(
        <div
          ref={pop}
          id={id}
          role="tooltip"
          className={`help-pop ${pos ? 'on' : ''}`}
          style={pos ? { left: pos.left, top: pos.top, ...(pos.maxHeight ? { maxHeight: pos.maxHeight, overflowY: 'auto' } : {}) } : undefined}
          onPointerEnter={show}
          onPointerLeave={leave}
          // React events bubble through the portal to the panel: its own background menu is not for the card.
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {intro && <p className="help-intro">{intro}</p>}
          {rows && rows.length > 0 && (
            <div className="help-rows">
              {rows.map(([key, text], i) => <Fragment key={i}><span className="kbd">{key}</span><span>{text}</span></Fragment>)}
            </div>
          )}
          {footer && <div className="help-foot">{footer}</div>}
        </div>,
        document.body,
      )}
    </>
  );
}
