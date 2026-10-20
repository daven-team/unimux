// Shared pieces of the Redis views (1.0.0): a windowed list of fixed-height rows, a dialog inside the tab, type badges and
// small formatting components.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { rowWindow } from '../../../../shared/virtualRows';
import { isBinaryData, redisDataDisplay, type RedisData } from '../../../../shared/dbRedis';
import { useI18n } from '../../i18n';
import { IX } from '../icons';

/** True while the tab's session is reconnecting (or moving to another DB): views stay visible, writes are disabled. */
export const OfflineContext = createContext(false);
export const useOffline = (): boolean => useContext(OfflineContext);

/** The index an arrow, Home, End or Page key moves to in a list of `count` rows (null: not a moving key). */
export function stepIndex(key: string, index: number, count: number, page = 10): number | null {
  if (!count) return null;
  const at = index < 0 ? -1 : index;
  switch (key) {
    case 'ArrowDown': return Math.min(count - 1, at + 1);
    case 'ArrowUp': return Math.max(0, at < 0 ? 0 : at - 1);
    case 'Home': return 0;
    case 'End': return count - 1;
    case 'PageDown': return Math.min(count - 1, Math.max(0, at) + page);
    case 'PageUp': return Math.max(0, at - page);
    default: return null;
  }
}

/**
 * A scrolling listbox that renders only the rows in view (plus overscan). `end` renders after the rows (a "load more" button).
 * Keyboard: the list takes the focus and marks `active` (aria-activedescendant, scrolled into view); `onMove` gets the index an
 * arrow / Home / End / Page key moves to; `onKey` gets every other key with the active index.
 */
export function VirtualList({ count, rowHeight, row, className = '', end, active = null, label, onMove, onKey }: {
  count: number; rowHeight: number; row: (index: number) => ReactNode; className?: string; end?: ReactNode; active?: number | null; label?: string;
  onMove?: (index: number) => void; onKey?: (e: KeyboardEvent<HTMLDivElement>, index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [view, setView] = useState({ top: 0, height: 400 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || active === null || active < 0) return;
    const top = active * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  }, [active, rowHeight]);
  const w = rowWindow(view.top, view.height, rowHeight, count, 12);
  const rows: ReactNode[] = [];
  for (let i = w.start; i < w.end; i++) {
    rows.push(<div key={i} id={`${id}-${i}`} role="option" aria-selected={i === active} className={`redis-vrow ${i === active ? 'active' : ''}`} style={{ top: i * rowHeight, height: rowHeight }}>{row(i)}</div>);
  }
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const next = stepIndex(e.key, active ?? -1, count, Math.max(1, Math.floor(view.height / rowHeight) - 1));
    if (next !== null && onMove) { e.preventDefault(); onMove(next); return; }
    if (active !== null && active >= 0) onKey?.(e, active);
  };
  return (
    <div ref={ref} className={`redis-vlist ${className}`} role="listbox" tabIndex={0} aria-label={label} aria-activedescendant={active !== null && active >= 0 && active < count ? `${id}-${active}` : undefined}
      onKeyDown={keyDown} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
      <div className="redis-vspace" style={{ height: count * rowHeight }}>{rows}</div>
      {end}
    </div>
  );
}

/** A dialog over the tab's content (Escape closes it). */
export function RedisDialog({ title, children, actions, onClose, wide }: { title: string; children: ReactNode; actions: ReactNode; onClose: () => void; wide?: boolean }) {
  const { tr } = useI18n();
  return (
    <div className="redis-dialog-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`redis-dialog ${wide ? 'wide' : ''}`} role="dialog" aria-label={title} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
        <div className="redis-dialog-head"><strong>{title}</strong><button className="btn ghost icon small" aria-label={tr('Zamknij')} onClick={onClose}><IX /></button></div>
        <div className="redis-dialog-body">{children}</div>
        <div className="redis-dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

const TYPE_SHORT: Record<string, string> = { string: 'STR', hash: 'HASH', list: 'LIST', set: 'SET', zset: 'ZSET', stream: 'STREAM' };

/** The coloured badge of a key type (module types show their own name). */
export function TypeBadge({ type }: { type?: string }) {
  const t = type ?? '?';
  return <span className={`redis-type t-${TYPE_SHORT[t] ? t : 'other'}`} title={t}>{TYPE_SHORT[t] ?? t.slice(0, 6).toUpperCase()}</span>;
}

/** A key, field or member as text; binary data gets a marker and its escaped form. */
export function DataText({ data, className = '' }: { data: RedisData; className?: string }) {
  const { tr } = useI18n();
  return (
    <span className={`redis-data ${className}`}>
      {isBinaryData(data) && <span className="redis-bin" title={tr('Dane binarne')}>bin</span>}
      {redisDataDisplay(data)}
    </span>
  );
}

/** A one-line preview of a long value. */
export const preview = (d: RedisData, max = 300): string => { const t = redisDataDisplay(d); return t.length > max ? `${t.slice(0, max)}…` : t; };
