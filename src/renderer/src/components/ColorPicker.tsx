import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PROJECT_COLORS } from '../../../shared/state';
import { useI18n } from '../i18n';
import './colorPicker.css';

const PALETTE = [...PROJECT_COLORS, '#d97757', '#10a37f', '#8b5cf6', '#64748b', '#eab308', '#f43f5e', '#14b8a6', '#9ca3af'];
const HEX = /^#[0-9a-f]{6}$/i;

/** The right edge the palette must stay inside: its nearest clipping or scrolling ancestor, else the window. */
function rightLimit(el: HTMLElement): number {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX } = getComputedStyle(p);
    if (overflowX !== 'visible') return p.getBoundingClientRect().right;
  }
  return window.innerWidth;
}

/**
 * A round swatch that opens a small palette with a hex field (instead of the system colour dialog). Optional: `swatch` content and
 * `swatchClassName` turn the trigger into something else (the icon tile of an SSH host), `onClear` adds a "Usuń kolor" row.
 */
export function ColorPicker({ value, onChange, label, swatch, swatchClassName, onClear }: {
  value: string; onChange(color: string): void; label?: string; swatch?: ReactNode; swatchClassName?: string; onClear?: () => void;
}) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => setDraft(value), [value]);
  // A swatch near the right edge (the colour of a database connection) opens the palette leftwards: opened rightwards it would
  // stick out of the dialog and scroll it sideways. Then, opened near the bottom of a scrolling pane (the SSH host form), the
  // palette scrolls into view instead of opening out of sight.
  useLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el) return;
    if (el.getBoundingClientRect().right > rightLimit(el)) el.classList.add('end');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key, true); };
  }, [open]);
  const commit = (color: string) => { if (HEX.test(color)) onChange(color.toLowerCase()); };
  return (
    <div className="color-picker" ref={root}>
      <button type="button" className={swatchClassName ? `color-swatch ${swatchClassName}` : 'color-swatch'} style={{ background: value }} aria-label={label ?? tr('Wybierz kolor')} title={swatch ? label : value} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>{swatch}</button>
      {open && (
        <div className="color-pop" ref={pop} id={id} role="dialog" aria-label={tr('Wybierz kolor')}>
          <div className="color-grid">
            {PALETTE.map((color) => (
              <button key={color} type="button" className={`color-dot ${color.toLowerCase() === value.toLowerCase() ? 'on' : ''}`} style={{ background: color }} aria-label={color} title={color} onClick={() => { onChange(color); setOpen(false); }} />
            ))}
          </div>
          <label className="color-custom">
            <span>{tr('Własny kolor')}</span>
            <input className="input" value={draft} spellCheck={false} maxLength={7} onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }} onBlur={() => setDraft(value)} />
          </label>
          {onClear && <button type="button" className="btn small ghost color-clear" onClick={() => { onClear(); setOpen(false); }}>{tr('Usuń kolor')}</button>}
        </div>
      )}
    </div>
  );
}
