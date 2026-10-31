// Grid layouts: a cols×rows grid split into rectangular areas; each area hosts one cell.

export type Area = { col: number; row: number; colSpan: number; rowSpan: number };
export type GridLayout = {
  cols: number;
  rows: number;
  areas: Area[];
  /** Set for row-based layouts (e.g. [3, 2] = three on top, two below); `cols` is then their LCM. */
  rowCounts?: number[];
  /** Relative heights of the `rows` tracks; absent means equal. */
  rowSizes?: number[];
  /** Relative widths of the `cols` tracks for each row; `null` entries (or no field) mean equal. */
  rowColSizes?: Array<number[] | null>;
  /** Relative widths of the `cols` tracks shared by every row without its own (also written by 0.5.5). */
  colSizes?: number[];
  /** `cols`: widths are shared and every column has its own heights (`colRowSizes`); absent: the rows mode above. */
  mode?: 'cols';
  /** Relative heights of the `rows` tracks for each column in cols mode. */
  colRowSizes?: Array<number[] | null>;
};

export const MAX_COLS = 5;
export const MAX_ROWS = 4;
export const MAX_CELLS = MAX_COLS * MAX_ROWS;

// Auto-grow sequence: [cols, capacity] - 1, 2, 2×2, 3×2, 3×3, 4×3, 5×4.
const GROW_STEPS: Array<[number, number]> = [[1, 1], [2, 2], [2, 4], [3, 6], [3, 9], [4, 12], [5, 20]];

const sortAreas = (areas: Area[]) => [...areas].sort((a, b) => a.row - b.row || a.col - b.col);

export function createLayout(cols: number, rows: number): GridLayout {
  const areas: Area[] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) areas.push({ col, row, colSpan: 1, rowSpan: 1 });
  return { cols, rows, areas };
}

const inside = (a: Area, r: Area) =>
  a.col >= r.col && a.row >= r.row && a.col + a.colSpan <= r.col + r.colSpan && a.row + a.rowSpan <= r.row + r.rowSpan;

const overlaps = (a: Area, r: Area) =>
  a.col < r.col + r.colSpan && r.col < a.col + a.colSpan && a.row < r.row + r.rowSpan && r.row < a.row + a.rowSpan;

/** Merges every area inside `rect` into one. Partial overlaps make the merge invalid → unchanged layout. */
export function mergeRect(layout: GridLayout, rect: Area): GridLayout {
  const hit = layout.areas.filter((a) => overlaps(a, rect));
  if (hit.length < 2 || hit.some((a) => !inside(a, rect))) return layout;
  const rest = layout.areas.filter((a) => !overlaps(a, rect));
  // Merged areas span rows, so per-row column widths no longer apply.
  const { rowColSizes: _widths, colSizes: _legacy, colRowSizes: _heights, mode: _mode, ...kept } = layout;
  return { ...kept, areas: sortAreas([...rest, { ...rect }]) };
}

export function unmergeAll(layout: GridLayout): GridLayout {
  return layout.rowCounts ? layoutFromRows(layout.rowCounts) : createLayout(layout.cols, layout.rows);
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => (a * b) / gcd(a, b);

/** Each row gets its own number of equally wide cells, e.g. [3, 2]. */
export function layoutFromRows(counts: number[]): GridLayout {
  const rows = counts.map((n) => Math.max(1, Math.min(MAX_COLS, Math.floor(n)))).slice(0, MAX_ROWS);
  if (!rows.length) return createLayout(1, 1);
  if (rows.every((n) => n === rows[0])) return createLayout(rows[0], rows.length);
  const cols = rows.reduce(lcm, 1);
  const areas = rows.flatMap((n, row) =>
    Array.from({ length: n }, (_, i) => ({ col: i * (cols / n), row, colSpan: cols / n, rowSpan: 1 })),
  );
  return { cols, rows: rows.length, areas, rowCounts: rows };
}

/** Cells per row for the row editor (merged layouts report their base rows). */
export function rowCountsOf(layout: GridLayout): number[] {
  return layout.rowCounts ?? Array.from({ length: layout.rows }, () => layout.cols);
}

/** Layout with exactly `n` areas (clamped to 1..MAX_CELLS); the last area stretches over empty fields. */
export function layoutForCount(n: number): GridLayout {
  const count = Math.max(1, Math.min(MAX_CELLS, Math.floor(n)));
  const [cols] = GROW_STEPS.find(([, cap]) => cap >= count)!;
  const rows = Math.ceil(count / cols);
  const layout = createLayout(cols, rows);
  const areas = layout.areas.slice(0, count);
  const last = areas[areas.length - 1];
  last.colSpan = cols - last.col;
  return { cols, rows, areas };
}

export function growLayout(layout: GridLayout): GridLayout | null {
  if (layout.areas.length >= MAX_CELLS) return null;
  return layoutForCount(layout.areas.length + 1);
}

export function removeArea(layout: GridLayout): GridLayout {
  return layoutForCount(layout.areas.length - 1);
}

export function describeLayout(layout: GridLayout): string {
  const n = layout.areas.length;
  if (layout.rowCounts && n === layout.rowCounts.reduce((a, b) => a + b, 0)) return layout.rowCounts.join('+');
  if (n === 1) return '1';
  if (n === layout.cols * layout.rows) return `${layout.cols}×${layout.rows}`;
  return `${n}`;
}

// ── resizable splits ────────────────────────────────────────────────────────
//
// Dividers can be dragged one segment at a time. A tiling stays gap-free as long as, at every "+" junction, at
// most one of the two crossing lines is split into independently moving halves. So a grid keeps one *shared*
// axis and one *independent* axis:
//   rows mode (default): heights are shared (`rowSizes`), every row has its own widths (`rowColSizes`)
//   cols mode:           widths are shared (`colSizes`), every column has its own heights (`colRowSizes`)
// Until a divider has been dragged, both axes are free; the first drag of a half decides which axis becomes
// independent. Double-clicking the dragged divider returns the grid to the free state.

export type Axis = 'col' | 'row';
/** No area may shrink below this share of the grid while a divider is dragged. */
export const MIN_AREA_SHARE = 0.1;
/** 1.0.7: no cell gets narrower than this many pixels by a divider (its header still shows the icon, the name and the menu). */
export const MIN_CELL_WIDTH = 160;
/** No cell gets shorter than this many pixels by a divider. */
export const MIN_CELL_HEIGHT = 90;

/**
 * The smallest share an area may get on an axis of `extent` pixels: MIN_AREA_SHARE, or more when that many pixels
 * (plus the gap of the card) would be narrower than `minPx`.
 */
export function minShareFor(extent: number, minPx: number, gap = 0): number {
  if (!(extent > 0)) return MIN_AREA_SHARE;
  return Math.max(MIN_AREA_SHARE, Math.min(0.5, (minPx + gap) / extent));
}

const validSizes = (sizes: readonly number[] | null | undefined, n: number): sizes is number[] =>
  !!sizes && sizes.length === n && sizes.every((v) => Number.isFinite(v) && v > 0);
const equalSizes = (n: number) => Array.from({ length: n }, () => 1);
const sum = (values: readonly number[], from = 0, to = values.length) => values.slice(from, to).reduce((a, b) => a + b, 0);
const isEqual = (sizes: number[]) => sizes.every((v) => Math.abs(v - sizes[0]) < 1e-6 * sizes[0]);

/** Position and size of every area as fractions of the grid (same order as `layout.areas`). */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** A divider between areas: grid line `line` (1..n-1) over the other axis' tracks `from`..`to` (inclusive). */
export interface Divider { axis: Axis; line: number; from: number; to: number }

const swapAxis = (d: Divider): Divider => ({ ...d, axis: d.axis === 'col' ? 'row' : 'col' });
const along = (a: Area, axis: Axis) => (axis === 'col' ? { start: a.col, size: a.colSpan } : { start: a.row, size: a.rowSpan });
const across = (a: Area, axis: Axis) => along(a, axis === 'col' ? 'row' : 'col');

// ── canonical (rows mode) form ──────────────────────────────────────────────
// Cols mode is the same algorithm on the transposed grid, so everything below works on the rows-mode form.

const SIZE_FIELDS = ['rowSizes', 'rowColSizes', 'colSizes', 'colRowSizes', 'mode'] as const;

function canon(layout: GridLayout): GridLayout {
  if (layout.mode !== 'cols') return layout;
  return {
    cols: layout.rows, rows: layout.cols,
    areas: layout.areas.map((a) => ({ col: a.row, row: a.col, colSpan: a.rowSpan, rowSpan: a.colSpan })),
    ...(layout.colSizes ? { rowSizes: layout.colSizes } : {}),
    ...(layout.colRowSizes ? { rowColSizes: layout.colRowSizes } : {}),
    ...(layout.rowSizes ? { colSizes: layout.rowSizes } : {}),
  };
}

/** Writes the size fields of a canonical layout back onto the layout it was derived from. */
function fromCanon(original: GridLayout, r: GridLayout): GridLayout {
  const base: Record<string, unknown> = { ...original };
  for (const field of SIZE_FIELDS) delete base[field];
  if (original.mode !== 'cols') {
    return { ...base, ...(r.rowSizes ? { rowSizes: r.rowSizes } : {}), ...(r.rowColSizes ? { rowColSizes: r.rowColSizes } : {}), ...(r.colSizes ? { colSizes: r.colSizes } : {}) } as GridLayout;
  }
  return {
    ...base,
    ...(r.colSizes ? { rowSizes: r.colSizes } : {}),
    ...(r.rowSizes ? { colSizes: r.rowSizes } : {}),
    ...(r.rowColSizes ? { colRowSizes: r.rowColSizes, mode: 'cols' as const } : {}),
  } as GridLayout;
}

/** Whether some row (rows mode) already has widths of its own. */
const hasJog = (r: GridLayout) => !!r.rowColSizes?.some((row) => validSizes(row, r.cols));

/** Row heights (relative) of a canonical layout. */
function rowWeightsR(r: GridLayout): number[] {
  return validSizes(r.rowSizes, r.rows) ? r.rowSizes : equalSizes(r.rows);
}

/** Column widths (relative) of one row of a canonical layout; `colSizes` is the default for rows without their own. */
function colWeightsR(r: GridLayout, row: number): number[] {
  const own = r.rowColSizes?.[row];
  if (validSizes(own, r.cols)) return own;
  return validSizes(r.colSizes, r.cols) ? r.colSizes : equalSizes(r.cols);
}

function areaRectsR(r: GridLayout): Rect[] {
  const rows = rowWeightsR(r);
  const height = sum(rows);
  return r.areas.map((a) => {
    const cols = colWeightsR(r, a.row);
    const width = sum(cols);
    return {
      x0: sum(cols, 0, a.col) / width, x1: sum(cols, 0, a.col + a.colSpan) / width,
      y0: sum(rows, 0, a.row) / height, y1: sum(rows, 0, a.row + a.rowSpan) / height,
    };
  });
}

export function areaRects(layout: GridLayout): Rect[] {
  const rects = areaRectsR(canon(layout));
  return layout.mode === 'cols' ? rects.map((q) => ({ x0: q.y0, y0: q.x0, x1: q.y1, y1: q.x1 })) : rects;
}

function dividersR(r: GridLayout): Divider[] {
  const out: Divider[] = [];
  const free = !hasJog(r);
  for (const axis of ['col', 'row'] as const) {
    const n = axis === 'col' ? r.cols : r.rows;
    const other = axis === 'col' ? r.rows : r.cols;
    for (let line = 1; line < n; line++) {
      const touches = (t: number, side: 'end' | 'start') => r.areas.some((a) => {
        const m = along(a, axis); const o = across(a, axis);
        return (side === 'end' ? m.start + m.size === line : m.start === line) && o.start <= t && t < o.start + o.size;
      });
      // An area on this side finishes right after track t: a perpendicular divider meets the line here.
      const corner = (t: number, side: 'end' | 'start') => r.areas.some((a) => {
        const m = along(a, axis); const o = across(a, axis);
        return (side === 'end' ? m.start + m.size === line : m.start === line) && o.start + o.size === t + 1;
      });
      let from = -1;
      for (let t = 0; t < other; t++) {
        const real = touches(t, 'end') && touches(t, 'start');
        if (real && from < 0) from = t;
        // Vertical lines are always cut at crossings; horizontal ones only while no row has its own widths.
        const cut = t === other - 1 || ((axis === 'col' || free) && corner(t, 'end') && corner(t, 'start'));
        if (real && cut) { out.push({ axis, line, from, to: t }); from = -1; }
        else if (!real) from = -1;
      }
    }
  }
  return out;
}

/**
 * Divider segments. Lines are cut at "+" crossings so each piece moves on its own; they stay whole where an
 * area spans across (T junctions) and, once one axis was made independent, along the shared axis.
 */
export function dividers(layout: GridLayout): Divider[] {
  const list = dividersR(canon(layout));
  return layout.mode === 'cols' ? list.map(swapAxis) : list;
}

/** Where to draw a divider, as fractions of the grid: its line coordinate and its extent along the line. */
export function dividerBox(layout: GridLayout, d: Divider): { pos: number; start: number; end: number } {
  const r = canon(layout);
  const dr = layout.mode === 'cols' ? swapAxis(d) : d;
  const rows = rowWeightsR(r);
  if (dr.axis === 'col') {
    const cols = colWeightsR(r, dr.from);
    return { pos: sum(cols, 0, dr.line) / sum(cols), start: sum(rows, 0, dr.from) / sum(rows), end: sum(rows, 0, dr.to + 1) / sum(rows) };
  }
  const rects = areaRectsR(r).filter((_, i) => { const a = r.areas[i]; return a.row + a.rowSpan === dr.line && a.col <= dr.to && dr.from < a.col + a.colSpan; });
  return { pos: sum(rows, 0, dr.line) / sum(rows), start: Math.min(...rects.map((q) => q.x0)), end: Math.max(...rects.map((q) => q.x1)) };
}

/** The smallest share of an area per screen axis (see minShareFor); MIN_AREA_SHARE where absent. */
export interface MinShare { col?: number; row?: number }

/** Clamp range for moving grid line `line` of a weight list by a fraction of its total. */
function moveLimits(weights: number[], spans: Array<{ start: number; size: number }>, line: number, minShare = MIN_AREA_SHARE): [number, number] {
  const total = sum(weights);
  let lo = -(weights[line - 1] / total) + 1e-6;
  let hi = weights[line] / total - 1e-6;
  for (const { start, size } of spans) {
    const width = sum(weights, start, start + size) / total;
    if (start + size === line) lo = Math.max(lo, Math.min(0, minShare - width));
    else if (start === line) hi = Math.min(hi, Math.max(0, width - minShare));
  }
  return [lo, hi];
}

const shift = (weights: number[], line: number, delta: number) => {
  const total = sum(weights);
  const next = [...weights];
  next[line - 1] += delta * total; next[line] -= delta * total;
  return next;
};

/** Stores row heights, dropping them when they equal the default split. */
function withRowSizes(r: GridLayout, sizes: number[] | undefined): GridLayout {
  const { rowSizes: _old, ...rest } = r;
  return !sizes || isEqual(sizes) ? rest : { ...rest, rowSizes: sizes };
}

/** Stores per-row column widths (`null` = default), dropping the field when nothing is customised. */
function withRowColSizes(r: GridLayout, sizes: Array<number[] | null>): GridLayout {
  const { rowColSizes: _old, ...rest } = r;
  const custom = sizes.map((row) => (row && !isEqual(row) ? row : null));
  if (!custom.some(Boolean)) return rest;
  // Rows without their own widths (null) keep using the grid-wide default.
  return { ...rest, rowColSizes: custom };
}

function resizeR(r: GridLayout, d: Divider, delta: number, minShare?: MinShare): GridLayout {
  if (d.axis === 'row') {
    const weights = rowWeightsR(r);
    if (d.line < 1 || d.line >= weights.length) return r;
    const [lo, hi] = moveLimits(weights, r.areas.map((a) => along(a, 'row')), d.line, minShare?.row);
    return withRowSizes(r, shift(weights, d.line, Math.min(hi, Math.max(lo, delta))));
  }
  if (d.line < 1 || d.line >= r.cols) return r;
  let lo = -Infinity;
  let hi = Infinity;
  for (let t = d.from; t <= d.to; t++) {
    const touching = r.areas.filter((a) => a.row <= t && t < a.row + a.rowSpan && (a.col + a.colSpan === d.line || a.col === d.line));
    const [l, h] = moveLimits(colWeightsR(r, t), touching.map((a) => along(a, 'col')), d.line, minShare?.col);
    lo = Math.max(lo, l); hi = Math.min(hi, h);
  }
  const clamped = Math.min(hi, Math.max(lo, delta));
  const sizes = Array.from({ length: r.rows }, (_, t) => (r.rowColSizes?.[t] && validSizes(r.rowColSizes[t], r.cols) ? r.rowColSizes[t] : null));
  for (let t = d.from; t <= d.to; t++) sizes[t] = shift(colWeightsR(r, t), d.line, clamped);
  return withRowColSizes(r, sizes);
}

/**
 * Moves a divider by `delta` (fraction of the grid, positive = right/down), clamped so no area gets too small.
 * Dragging half of a line while no axis is independent yet makes that axis the independent one.
 */
export function resizeDivider(layout: GridLayout, d: Divider, delta: number, minShare?: MinShare): GridLayout {
  const r = canon(layout);
  const dr = layout.mode === 'cols' ? swapAxis(d) : d;
  if (dr.axis === 'row' && !hasJog(r) && !(dr.from === 0 && dr.to === r.cols - 1)) {
    return resizeDivider(flipMode(layout), d, delta, minShare);
  }
  // The canonical form of a cols-mode grid is transposed: its "col" limit is the screen's row limit.
  const limits = minShare && layout.mode === 'cols' ? { col: minShare.row, row: minShare.col } : minShare;
  return fromCanon(layout, resizeR(r, dr, delta, limits));
}

/** Swaps the independent axis of a grid whose axes are still free. */
function flipMode(layout: GridLayout): GridLayout {
  const { mode: _mode, ...rest } = layout;
  return layout.mode === 'cols' ? rest : { ...rest, mode: 'cols' };
}

/**
 * Centres a divider between its neighbouring lines (double click). Only this line moves, so every other divider
 * and every T junction stays consistent; once everything is centred again the grid is free.
 */
export function resetDivider(layout: GridLayout, d: Divider): GridLayout {
  const r = canon(layout);
  const dr = layout.mode === 'cols' ? swapAxis(d) : d;
  const rows = dr.axis === 'row' ? [rowWeightsR(r)] : Array.from({ length: dr.to - dr.from + 1 }, (_, i) => colWeightsR(r, dr.from + i));
  const at = (weights: number[], line: number) => sum(weights, 0, line) / sum(weights);
  const here = rows.reduce((a, w) => a + at(w, dr.line), 0) / rows.length;
  const middle = rows.reduce((a, w) => a + (at(w, dr.line - 1) + at(w, dr.line + 1)) / 2, 0) / rows.length;
  return fromCanon(layout, resizeR(r, dr, middle - here));
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNumbers = (v: unknown): boolean => Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isNumberRows = (v: unknown): boolean => Array.isArray(v) && v.every((row) => row === null || isNumbers(row));

/** A saved layout the grid can draw for `count` cells: one area per cell inside the grid, size fields of the right type. */
export function isUsableLayout(layout: unknown, count: number): layout is GridLayout {
  if (!isRecord(layout)) return false;
  const { cols, rows, areas } = layout;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (rows as number) < 1) return false;
  // Row-based layouts use the LCM of their row counts as tracks (60 for 5, 4, 3); either axis in cols mode.
  if ((cols as number) > 60 || (rows as number) > 60) return false;
  if (!Array.isArray(areas) || areas.length !== count) return false;
  const inside = areas.every((a) => isRecord(a)
    && [a.col, a.row, a.colSpan, a.rowSpan].every((n) => Number.isInteger(n))
    && (a.col as number) >= 0 && (a.row as number) >= 0 && (a.colSpan as number) >= 1 && (a.rowSpan as number) >= 1
    && (a.col as number) + (a.colSpan as number) <= (cols as number) && (a.row as number) + (a.rowSpan as number) <= (rows as number));
  if (!inside) return false;
  if (layout.mode !== undefined && layout.mode !== 'cols') return false;
  for (const field of ['rowCounts', 'rowSizes', 'colSizes'] as const) if (layout[field] !== undefined && !isNumbers(layout[field])) return false;
  for (const field of ['rowColSizes', 'colRowSizes'] as const) if (layout[field] !== undefined && !isNumberRows(layout[field])) return false;
  return true;
}
