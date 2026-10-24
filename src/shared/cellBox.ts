// Where a terminal that is not on screen yet will be fitted: the box its cell body will get. Pure, so it is unit tested.
import { areaRects, type GridLayout } from './layout';

export interface Size { width: number; height: number }

export const MIN_GRID = { width: 200, height: 120 };

/** The first measured box that has a real size (a hidden element measures 0x0), else the last size seen, else nothing. */
export function chooseGridSize(measured: ReadonlyArray<Size | null>, lastKnown: Size | null): Size | null {
  return measured.find((m): m is Size => !!m && m.width >= MIN_GRID.width && m.height >= MIN_GRID.height) ?? lastKnown;
}

/** Height of a cell header: keep it equal to the --cell-head CSS variable (styles.css), which the renderer reads first. */
export const CELL_HEAD_HEIGHT = 34;

/**
 * 1.0.7 cell cards: the space between two cards and between a card and the grid's edge (CSS px, even). The grid's areas
 * share the grid minus one gap (half a gap on each outer edge), and each card keeps half a gap inside its area
 * (GridDividers.areaStyle).
 */
export const CELL_GAP = 6;

/** Padding of the terminal inside the card body (.terminal-cell > .cell-main > .cell-body in terminalCell.css). */
export const CELL_BODY_PADDING = { top: 6, right: 6, bottom: 8, left: 10 } as const;

/**
 * Cell body (inside its card: below the header, inside the padding) of the cell at `index` for a grid of `grid` pixels.
 * `footHeight`: a bar in the card's footer slot (CellFoot.tsx) under the terminal.
 */
export function cellBodyBox(layout: GridLayout, index: number, grid: Size, headHeight = CELL_HEAD_HEIGHT, footHeight = 0): Size | null {
  const rect = areaRects(layout)[index];
  if (!rect) return null;
  const pad = CELL_BODY_PADDING;
  return {
    width: (rect.x1 - rect.x0) * (grid.width - CELL_GAP) - CELL_GAP - pad.left - pad.right,
    height: (rect.y1 - rect.y0) * (grid.height - CELL_GAP) - CELL_GAP - headHeight - footHeight - pad.top - pad.bottom,
  };
}
