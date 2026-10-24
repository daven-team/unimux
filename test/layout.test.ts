import { describe, expect, it } from 'vitest';
import {
  areaRects, createLayout, describeLayout, dividerBox, dividers, growLayout, layoutForCount, layoutFromRows, mergeRect, MIN_AREA_SHARE, minShareFor,
  removeArea, resetDivider, resizeDivider, rowCountsOf, unmergeAll, type GridLayout,
} from '../src/shared/layout';

describe('layout', () => {
  it('createLayout makes one area per field, row-major', () => {
    const l = createLayout(2, 2);
    expect(l.areas).toHaveLength(4);
    expect(l.areas[1]).toEqual({ col: 1, row: 0, colSpan: 1, rowSpan: 1 });
    expect(l.areas[2]).toEqual({ col: 0, row: 1, colSpan: 1, rowSpan: 1 });
  });

  it('mergeRect replaces fully covered areas with one spanning area', () => {
    const l = mergeRect(createLayout(2, 2), { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    expect(l.areas).toHaveLength(3);
    expect(l.areas[0]).toEqual({ col: 0, row: 0, colSpan: 2, rowSpan: 1 });
  });

  it('mergeRect leaves layout unchanged on partial overlap', () => {
    const merged = mergeRect(createLayout(3, 1), { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    const again = mergeRect(merged, { col: 1, row: 0, colSpan: 2, rowSpan: 1 });
    expect(again).toEqual(merged);
  });

  it('unmergeAll restores single fields', () => {
    const l = unmergeAll(mergeRect(createLayout(2, 2), { col: 0, row: 0, colSpan: 2, rowSpan: 2 }));
    expect(l.areas).toHaveLength(4);
  });

  it('layoutForCount follows the auto-grow sequence with exactly n areas', () => {
    expect(layoutForCount(1)).toMatchObject({ cols: 1, rows: 1 });
    expect(layoutForCount(2)).toMatchObject({ cols: 2, rows: 1 });
    expect(layoutForCount(4)).toMatchObject({ cols: 2, rows: 2 });
    const five = layoutForCount(5);
    expect(five).toMatchObject({ cols: 3, rows: 2 });
    expect(five.areas).toHaveLength(5);
    expect(five.areas[4]).toEqual({ col: 1, row: 1, colSpan: 2, rowSpan: 1 });
    expect(layoutForCount(12)).toMatchObject({ cols: 4, rows: 3 });
    expect(layoutForCount(13)).toMatchObject({ cols: 5, rows: 3 });
    expect(layoutForCount(99).areas).toHaveLength(20);
  });

  it('growLayout adds one area, null at max', () => {
    expect(growLayout(layoutForCount(4))!.areas).toHaveLength(5);
    expect(growLayout(layoutForCount(20))).toBeNull();
  });

  it('layoutFromRows builds 3 on top and 2 below', () => {
    const l = layoutFromRows([3, 2]);
    expect(l).toMatchObject({ cols: 6, rows: 2, rowCounts: [3, 2] });
    expect(l.areas).toHaveLength(5);
    expect(l.areas[0]).toEqual({ col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    expect(l.areas[4]).toEqual({ col: 3, row: 1, colSpan: 3, rowSpan: 1 });
    expect(describeLayout(l)).toBe('3+2');
  });

  it('layoutFromRows with equal rows is a plain grid', () => {
    expect(layoutFromRows([2, 2])).toEqual(createLayout(2, 2));
    expect(rowCountsOf(createLayout(4, 3))).toEqual([4, 4, 4]);
  });

  it('unmergeAll on a row layout restores its rows', () => {
    const l = layoutFromRows([3, 2]);
    const merged = mergeRect(l, { col: 0, row: 0, colSpan: 4, rowSpan: 1 });
    expect(merged.areas).toHaveLength(4);
    expect(unmergeAll(merged)).toEqual(l);
  });

  it('removeArea shrinks to n-1 but never below 1', () => {
    expect(removeArea(layoutForCount(4)).areas).toHaveLength(3);
    expect(removeArea(layoutForCount(1)).areas).toHaveLength(1);
  });
});

describe('resizable splits', () => {
  const grid = (cols: number, rows: number) => createLayout(cols, rows);
  const find = (layout: GridLayout, axis: 'col' | 'row', line: number, from?: number) =>
    dividers(layout).find((d) => d.axis === axis && d.line === line && (from === undefined || d.from === from))!;

  /** Areas must tile the grid: total area 1 and no two areas overlapping. */
  const expectTiling = (layout: GridLayout) => {
    const rects = areaRects(layout);
    const area = (r: { x0: number; y0: number; x1: number; y1: number }) => (r.x1 - r.x0) * (r.y1 - r.y0);
    expect(rects.reduce((a, r) => a + area(r), 0)).toBeCloseTo(1, 9);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const w = Math.min(rects[i].x1, rects[j].x1) - Math.max(rects[i].x0, rects[j].x0);
      const h = Math.min(rects[i].y1, rects[j].y1) - Math.max(rects[i].y0, rects[j].y0);
      expect(Math.max(0, w) * Math.max(0, h)).toBeLessThan(1e-9);
    }
  };

  it('defaults to equal geometry and ignores malformed sizes', () => {
    expect(areaRects(grid(1, 3)).map((r) => r.y1)).toEqual([1 / 3, 2 / 3, 1]);
    expect(areaRects({ ...grid(2, 1), rowColSizes: [[1, 2, 3]] }).map((r) => r.x1)).toEqual([0.5, 1]);
    expect(areaRects({ ...grid(1, 2), rowSizes: [1, -1] }).map((r) => r.y1)).toEqual([0.5, 1]);
    expect(areaRects(grid(2, 2))[3]).toEqual({ x0: 0.5, y0: 0.5, x1: 1, y1: 1 });
  });

  it('cuts every line at its crossings while the grid is free', () => {
    expect(dividers(grid(2, 2))).toEqual([
      { axis: 'col', line: 1, from: 0, to: 0 },
      { axis: 'col', line: 1, from: 1, to: 1 },
      { axis: 'row', line: 1, from: 0, to: 0 },
      { axis: 'row', line: 1, from: 1, to: 1 },
    ]);
    expect(dividers(grid(1, 1))).toEqual([]);
    expect(dividers(grid(3, 1))).toEqual([{ axis: 'col', line: 1, from: 0, to: 0 }, { axis: 'col', line: 2, from: 0, to: 0 }]);
    expect(dividers(grid(1, 2))).toEqual([{ axis: 'row', line: 1, from: 0, to: 0 }]);
  });

  it('keeps a divider in one piece at a T junction and splits it where an area spans across', () => {
    const tall = mergeRect(grid(2, 2), { col: 0, row: 0, colSpan: 1, rowSpan: 2 });
    expect(dividers(tall)).toEqual([{ axis: 'col', line: 1, from: 0, to: 1 }, { axis: 'row', line: 1, from: 1, to: 1 }]);
    const wide = mergeRect(grid(2, 2), { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    expect(dividers(wide)).toEqual([{ axis: 'col', line: 1, from: 1, to: 1 }, { axis: 'row', line: 1, from: 0, to: 1 }]);
  });

  it('offers per-row dividers for uneven rows', () => {
    const verticals = dividers(layoutFromRows([3, 2])).filter((d) => d.axis === 'col').map((d) => [d.line, d.from, d.to]);
    expect(verticals).toEqual([[2, 0, 0], [3, 1, 1], [4, 0, 0]]);
  });

  it('moves one row of a vertical line without touching the others', () => {
    const l = grid(2, 2);
    const moved = resizeDivider(l, find(l, 'col', 1, 0), 0.2);
    const rects = areaRects(moved);
    expect(rects[0].x1).toBeCloseTo(0.7);
    expect(rects[1].x0).toBeCloseTo(0.7);
    expect(rects[2].x1).toBeCloseTo(0.5);
    expect(rects[3].x0).toBeCloseTo(0.5);
    expect(moved.mode).toBeUndefined();
    expectTiling(moved);
  });

  it('then moves horizontal lines as a whole', () => {
    const l = grid(2, 2);
    const jogged = resizeDivider(l, find(l, 'col', 1, 0), 0.2);
    expect(dividers(jogged).filter((d) => d.axis === 'row')).toEqual([{ axis: 'row', line: 1, from: 0, to: 1 }]);
    const moved = resizeDivider(jogged, find(jogged, 'row', 1), 0.25);
    const rects = areaRects(moved);
    expect(rects.map((r) => r.y1).slice(0, 2)).toEqual([0.75, 0.75]);
    expect(rects.map((r) => r.y0).slice(2)).toEqual([0.75, 0.75]);
    expect(rects[0].x1).toBeCloseTo(0.7);
    expect(rects[2].x1).toBeCloseTo(0.5);
    expectTiling(moved);
  });

  it('lets half of a horizontal line move on its own and makes the heights independent', () => {
    const l = grid(2, 2);
    const moved = resizeDivider(l, find(l, 'row', 1, 0), 0.2);
    expect(moved.mode).toBe('cols');
    const rects = areaRects(moved);
    expect(rects[0].y1).toBeCloseTo(0.7);
    expect(rects[2].y0).toBeCloseTo(0.7);
    expect(rects[1].y1).toBeCloseTo(0.5);
    expect(rects[3].y0).toBeCloseTo(0.5);
    expect(rects.map((r) => Math.round(r.x1 * 100) / 100)).toEqual([0.5, 1, 0.5, 1]);
    expectTiling(moved);
    // Vertical lines are one piece now, so the gap-free tiling cannot break.
    expect(dividers(moved).filter((d) => d.axis === 'col')).toEqual([{ axis: 'col', line: 1, from: 0, to: 1 }]);
    const widened = areaRects(resizeDivider(moved, find(moved, 'col', 1), 0.1));
    expect(widened.map((r) => Math.round(r.x1 * 100) / 100)).toEqual([0.6, 1, 0.6, 1]);
    expect(widened[0].y1).toBeCloseTo(0.7);
    expect(widened[1].y1).toBeCloseTo(0.5);
  });

  it('does not switch modes for a line that already spans the whole grid', () => {
    const l = grid(1, 2);
    const moved = resizeDivider(l, find(l, 'row', 1), 0.2);
    expect(moved.mode).toBeUndefined();
    expect(areaRects(moved)[0].y1).toBeCloseTo(0.7);
  });

  it('moves both sides of a T junction together', () => {
    const tall = mergeRect(grid(2, 2), { col: 0, row: 0, colSpan: 1, rowSpan: 2 });
    const moved = resizeDivider(tall, find(tall, 'col', 1), 0.2);
    const rects = areaRects(moved);
    expect(rects.map((r) => Math.round(r.x1 * 100) / 100)).toEqual([0.7, 1, 1]);
    expect(rects[1].x0).toBeCloseTo(0.7);
    expect(rects[2].x0).toBeCloseTo(0.7);
    expectTiling(moved);
  });

  it('never lets an area shrink below the minimum share', () => {
    const l = grid(2, 1);
    const far = areaRects(resizeDivider(l, find(l, 'col', 1), 5));
    expect(far[1].x1 - far[1].x0).toBeCloseTo(MIN_AREA_SHARE);
    const back = areaRects(resizeDivider(l, find(l, 'col', 1), -5));
    expect(back[0].x1 - back[0].x0).toBeCloseTo(MIN_AREA_SHARE);
    const rows = grid(1, 2);
    const down = areaRects(resizeDivider(rows, find(rows, 'row', 1), 5));
    expect(down[1].y1 - down[1].y0).toBeCloseTo(MIN_AREA_SHARE);
    const half = grid(2, 2);
    const flipped = areaRects(resizeDivider(half, find(half, 'row', 1, 1), -5));
    expect(flipped[1].y1 - flipped[1].y0).toBeCloseTo(MIN_AREA_SHARE);
  });

  it('keeps the grid gap-free and overlap-free under random drags of every divider', () => {
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const layouts = () => [
      grid(2, 2), grid(3, 3), grid(4, 2), layoutFromRows([3, 2]), layoutFromRows([1, 2, 3]), layoutForCount(5), layoutForCount(7),
      mergeRect(grid(3, 3), { col: 0, row: 0, colSpan: 2, rowSpan: 2 }),
      mergeRect(grid(2, 2), { col: 0, row: 0, colSpan: 1, rowSpan: 2 }),
      mergeRect(grid(3, 2), { col: 1, row: 0, colSpan: 2, rowSpan: 1 }),
    ];
    for (const run of [7, 11, 23, 101, 977]) for (let start of (seed = run, layouts())) {
      for (let step = 0; step < 80; step++) {
        const all = dividers(start);
        if (!all.length) break;
        const pick = all[Math.floor(random() * all.length)];
        // Mix drags with occasional resets so both modes and the free state are all exercised.
        start = random() < 0.12 ? resetDivider(start, pick) : resizeDivider(start, pick, random() - 0.5);
        expectTiling(start);
        for (const r of areaRects(start)) expect(Math.min(r.x1 - r.x0, r.y1 - r.y0)).toBeGreaterThanOrEqual(MIN_AREA_SHARE - 1e-9);
      }
    }
  });

  it('resets only the pieces of one divider, or a whole shared axis', () => {
    let l = grid(2, 2);
    l = resizeDivider(l, find(l, 'col', 1, 0), 0.2);
    l = resizeDivider(l, find(l, 'col', 1, 1), -0.2);
    l = resizeDivider(l, find(l, 'row', 1), 0.1);
    const reset = resetDivider(l, find(l, 'col', 1, 0));
    expect(areaRects(reset)[0].x1).toBeCloseTo(0.5);
    expect(areaRects(reset)[2].x1).toBeCloseTo(0.3);
    expect(areaRects(reset)[0].y1).toBeCloseTo(0.6);
    expect(areaRects(resetDivider(l, find(l, 'row', 1)))[0].y1).toBeCloseTo(0.5);
    const clean = resetDivider(resetDivider(reset, find(reset, 'col', 1, 1)), find(reset, 'row', 1));
    expect(clean).toEqual(grid(2, 2));
  });

  it('returns to a free grid when the dragged horizontal piece is reset', () => {
    const l = grid(2, 2);
    const moved = resizeDivider(l, find(l, 'row', 1, 0), 0.2);
    const reset = resetDivider(moved, find(moved, 'row', 1, 0));
    expect(reset).toEqual(grid(2, 2));
    expect(dividers(reset)).toEqual(dividers(l));
  });

  it('reads grid-wide widths from 0.5.5 as the default of every row', () => {
    const legacy: GridLayout = { ...grid(2, 2), colSizes: [1.5, 0.5] };
    expect(areaRects(legacy).map((r) => r.x1)).toEqual([0.75, 1, 0.75, 1]);
    const moved = resizeDivider(legacy, find(legacy, 'col', 1, 0), -0.1);
    const rects = areaRects(moved);
    expect(rects[0].x1).toBeCloseTo(0.65);
    expect(rects[2].x1).toBeCloseTo(0.75);
    expectTiling(moved);
  });

  it('merging areas drops independent sizes because merged areas span rows or columns', () => {
    const l = grid(2, 2);
    const jogged = mergeRect(resizeDivider(l, find(l, 'col', 1, 0), 0.2), { col: 0, row: 0, colSpan: 1, rowSpan: 2 });
    expect(jogged.rowColSizes).toBeUndefined();
    expectTiling(jogged);
    const flipped = mergeRect(resizeDivider(l, find(l, 'row', 1, 0), 0.2), { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    expect(flipped.colRowSizes).toBeUndefined();
    expect(flipped.mode).toBeUndefined();
    expectTiling(flipped);
  });

  it('places dividers from the geometry', () => {
    const l = grid(2, 2);
    expect(dividerBox(l, find(l, 'col', 1, 0))).toEqual({ pos: 0.5, start: 0, end: 0.5 });
    expect(dividerBox(l, find(l, 'row', 1, 0))).toEqual({ pos: 0.5, start: 0, end: 0.5 });
    expect(dividerBox(l, find(l, 'row', 1, 1))).toEqual({ pos: 0.5, start: 0.5, end: 1 });
    const moved = resizeDivider(l, find(l, 'col', 1, 1), 0.2);
    expect(dividerBox(moved, find(moved, 'col', 1, 1)).pos).toBeCloseTo(0.7);
    expect(dividerBox(moved, find(moved, 'col', 1, 0)).pos).toBeCloseTo(0.5);
    const flipped = resizeDivider(l, find(l, 'row', 1, 1), 0.2);
    const right = dividerBox(flipped, find(flipped, 'row', 1, 1));
    expect(right.pos).toBeCloseTo(0.7);
    expect(right.start).toBeCloseTo(0.5);
    expect(right.end).toBeCloseTo(1);
    expect(dividerBox(flipped, find(flipped, 'row', 1, 0)).pos).toBeCloseTo(0.5);
  });

  it('ignores lines outside the grid', () => {
    const l = grid(2, 1);
    expect(resizeDivider(l, { axis: 'col', line: 0, from: 0, to: 0 }, 1)).toEqual(l);
    expect(resizeDivider(l, { axis: 'col', line: 2, from: 0, to: 0 }, 1)).toEqual(l);
  });
});

describe('1.0.7 minimum cell size of a divider drag', () => {
  it('minShareFor turns pixels into a share, at least MIN_AREA_SHARE and at most half', () => {
    expect(minShareFor(2000, 160, 8)).toBe(MIN_AREA_SHARE);
    expect(minShareFor(800, 160, 8)).toBeCloseTo(0.21);
    expect(minShareFor(200, 160, 8)).toBe(0.5);
    expect(minShareFor(0, 160)).toBe(MIN_AREA_SHARE);
  });

  it('a column divider stops where the narrower cell would go below the pixel minimum', () => {
    const layout = layoutForCount(4); // 2x2
    const col = dividers(layout).find((d) => d.axis === 'col')!;
    const min = minShareFor(800, 160, 8);
    const firstRow = (l: GridLayout) => Math.min(...areaRects(l).filter((r) => r.y0 === 0).map((r) => r.x1 - r.x0));
    expect(firstRow(resizeDivider(layout, col, -0.45, { col: min }))).toBeCloseTo(min, 5);
    expect(firstRow(resizeDivider(layout, col, 0.45, { col: min }))).toBeCloseTo(min, 5);
    // Without limits the old 10 % floor applies.
    expect(firstRow(resizeDivider(layout, col, -0.45))).toBeCloseTo(MIN_AREA_SHARE, 5);
  });

  it('in a grid whose columns are independent (cols mode) the row limit still applies to heights', () => {
    const layout = layoutForCount(4);
    const row = dividers(layout).find((d) => d.axis === 'row' && d.from === 0 && d.to === 0);
    if (!row) return; // a 2x2 grid offers whole row lines only
    const moved = resizeDivider(layout, row, -0.45, { col: 0.1, row: 0.3 });
    const heights = areaRects(moved).map((r) => r.y1 - r.y0);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0.3 - 1e-6);
  });
});
