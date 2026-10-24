import { describe, expect, it } from 'vitest';
import { CELL_GAP, cellBodyBox, chooseGridSize } from '../src/shared/cellBox';
import { createLayout } from '../src/shared/layout';

describe('where a background terminal is fitted', () => {
  it('uses the grid when it has a real size', () => {
    expect(chooseGridSize([{ width: 900, height: 600 }, { width: 950, height: 640 }], null)).toEqual({ width: 900, height: 600 });
  });

  it('falls back to the workspace when the grid is hidden (0x0 while Settings or an editor shows)', () => {
    expect(chooseGridSize([{ width: 0, height: 0 }, { width: 950, height: 640 }], null)).toEqual({ width: 950, height: 640 });
    expect(chooseGridSize([null, { width: 950, height: 640 }], null)).toEqual({ width: 950, height: 640 });
  });

  it('falls back to the last size seen, and to nothing when there is none', () => {
    const last = { width: 800, height: 500 };
    expect(chooseGridSize([{ width: 0, height: 0 }, null], last)).toEqual(last);
    expect(chooseGridSize([{ width: 0, height: 0 }, { width: 100, height: 50 }], null)).toBeNull();
  });

  it('computes the body of a cell card: its share of the grid without the gaps, minus header and padding', () => {
    // 1.0.7: the areas share the grid minus one gap; a card keeps half a gap on each side; the terminal is padded 10/6 and 6/8.
    const box = cellBodyBox(createLayout(3, 1), 1, { width: 906, height: 606 }, 34)!;
    expect(CELL_GAP).toBe(6);
    expect(box.width).toBeCloseTo(300 - 6 - 16, 5);
    expect(box.height).toBeCloseTo(600 - 6 - 34 - 14, 5);
    expect(cellBodyBox(createLayout(3, 1), 1, { width: 906, height: 606 }, 34, 24)!.height).toBeCloseTo(box.height - 24, 5);
    expect(cellBodyBox(createLayout(3, 1), 7, { width: 900, height: 600 })).toBeNull();
  });
});
