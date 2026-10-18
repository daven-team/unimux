// Where a terminal that is not on screen yet will be fitted: the box its cell body will get. Pure, so it is unit tested.
import { areaRects, type GridLayout } from './layout';

export interface Size { width: number; height: number }

export const MIN_GRID = { width: 200, height: 120 };

/** The first measured box that has a real size (a hidden element measures 0x0), else the last size seen, else nothing. */
export function chooseGridSize(measured: ReadonlyArray<Size | null>, lastKnown: Size | null): Size | null {
  return measured.find((m): m is Size => !!m && m.width >= MIN_GRID.width && m.height >= MIN_GRID.height) ?? lastKnown;
}

/** Height of a cell header: keep it equal to the --cell-head CSS variable (styles.css), which the renderer reads first. */
export const CELL_HEAD_HEIGHT = 30;

/** Cell body (below the header, inside the padding and the 1 px grid line) of the cell at `index` for a grid of `grid` pixels. */
export function cellBodyBox(layout: GridLayout, index: number, grid: Size, headHeight = CELL_HEAD_HEIGHT): Size | null {
  const rect = areaRects(layout)[index];
  if (!rect) return null;
  return {
    width: (rect.x1 - rect.x0) * grid.width - 1 - 8,
    height: (rect.y1 - rect.y0) * grid.height - 1 - headHeight - 4,
  };
}
