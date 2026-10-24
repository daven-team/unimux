import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { dividerBox, dividers, MIN_CELL_HEIGHT, MIN_CELL_WIDTH, minShareFor, resetDivider, resizeDivider, type Divider, type GridLayout, type MinShare, type Rect } from '../../../shared/layout';
import { CELL_GAP } from '../../../shared/cellBox';
import { useI18n } from '../i18n';
import { terminals } from '../terminals/TerminalManager';

const HALF_GAP = CELL_GAP / 2;

/** Where a share of the grid lies (1.0.7): the areas share the grid minus one gap, half a gap stays on each outer edge. */
const gridPos = (share: number) => `calc(${HALF_GAP}px + ${share} * (100% - ${CELL_GAP}px))`;

/** The card of an area: half a gap inside each of its edges (a gap between two cards, a gap at the grid's edge). Edges snap
 * to CSS pixels: fractional origins blur the card's thin frame, especially on the bottom/right after a resize. */
export function areaStyle(rect: Rect): CSSProperties {
  const edge = (share: number) => `round(nearest, ${gridPos(share)}, 1px)`;
  return {
    left: `calc(${edge(rect.x0)} + ${HALF_GAP}px)`, top: `calc(${edge(rect.y0)} + ${HALF_GAP}px)`,
    width: `calc(${edge(rect.x1)} - ${edge(rect.x0)} - ${CELL_GAP}px)`,
    height: `calc(${edge(rect.y1)} - ${edge(rect.y0)} - ${CELL_GAP}px)`,
  };
}

/** A maximized cell: the whole grid as one card. */
export const FULL_AREA: CSSProperties = areaStyle({ x0: 0, y0: 0, x1: 1, y1: 1 });

const KEY_STEP = 0.02;

/** 1.0.7: the shares of the grid that keep a card at least MIN_CELL_WIDTH x MIN_CELL_HEIGHT pixels (the grid element's box). */
function minShares(grid: HTMLElement | null): MinShare | undefined {
  if (!grid) return undefined;
  const rect = grid.getBoundingClientRect();
  return { col: minShareFor(rect.width - CELL_GAP, MIN_CELL_WIDTH, CELL_GAP), row: minShareFor(rect.height - CELL_GAP, MIN_CELL_HEIGHT, CELL_GAP) };
}

/**
 * Draggable dividers between the grid's areas. Each vertical divider moves one row on its own, horizontal
 * dividers move the whole line; double click restores the equal split.
 */
export function GridDividers({ layout, onPreview, onCommit }: {
  layout: GridLayout;
  onPreview: (layout: GridLayout | null) => void;
  onCommit: (layout: GridLayout) => void;
}) {
  const { tr } = useI18n();
  const drag = useRef<{ base: GridLayout; divider: Divider; start: number; extent: number; current: GridLayout; limits?: MinShare } | null>(null);
  /** The cells are fitted once when the drag ends (see TerminalManager.holdFits). */
  const fitHold = useRef<(() => void) | null>(null);
  useEffect(() => () => { fitHold.current?.(); fitHold.current = null; }, []);

  const begin = (e: PointerEvent<HTMLDivElement>, d: Divider) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = {
      base: layout, divider: d, current: layout,
      start: d.axis === 'col' ? e.clientX : e.clientY,
      extent: (d.axis === 'col' ? rect.width : rect.height) - CELL_GAP, // the areas share the grid minus one gap
      limits: minShares(e.currentTarget.parentElement),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    fitHold.current?.();
    fitHold.current = terminals.holdFits();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.extent <= 0) return;
    const delta = ((g.divider.axis === 'col' ? e.clientX : e.clientY) - g.start) / g.extent;
    g.current = resizeDivider(g.base, g.divider, delta, g.limits);
    onPreview(g.current);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const release = fitHold.current;
    fitHold.current = null;
    if (release) setTimeout(release, 0); // after the committed layout is rendered
    if (!g) return;
    onPreview(null);
    if (g.current !== g.base) onCommit(g.current);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>, d: Divider) => {
    const forward = d.axis === 'col' ? 'ArrowRight' : 'ArrowDown';
    const backward = d.axis === 'col' ? 'ArrowLeft' : 'ArrowUp';
    if (e.key !== forward && e.key !== backward) return;
    e.preventDefault();
    onCommit(resizeDivider(layout, d, (e.key === forward ? 1 : -1) * KEY_STEP, minShares(e.currentTarget.parentElement)));
  };

  return <>
    {dividers(layout).map((d) => {
      const box = dividerBox(layout, d);
      const style: CSSProperties = d.axis === 'col'
        ? { left: gridPos(box.pos), top: gridPos(box.start), height: `calc(${box.end - box.start} * (100% - ${CELL_GAP}px))` }
        : { top: gridPos(box.pos), left: gridPos(box.start), width: `calc(${box.end - box.start} * (100% - ${CELL_GAP}px))` };
      return <div
        key={`${d.axis}:${d.line}:${d.from}`}
        className={`grid-divider ${d.axis}`}
        style={style}
        role="separator"
        aria-orientation={d.axis === 'col' ? 'vertical' : 'horizontal'}
        aria-label={tr('Zmień rozmiar komórek (dwuklik: równy podział)')}
        title={tr('Przeciągnij, aby zmienić rozmiar · dwuklik: równy podział')}
        tabIndex={0}
        onPointerDown={(e) => begin(e, d)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={(e) => key(e, d)}
        onDoubleClick={() => onCommit(resetDivider(layout, d))}
      />;
    })}
  </>;
}
