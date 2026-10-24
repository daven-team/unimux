import { describe, expect, it } from 'vitest';
import { cursorOffset, reflowedCursor, type WrapBuffer } from '../src/shared/cursorReflow';

/** A buffer of rows where `wrapped` lists the rows that continue the row above. */
const buffer = (cursorRow: number, cursorX: number, wrapped: number[]): WrapBuffer => ({ cursorRow, cursorX, isWrapped: (row) => wrapped.includes(row) });

describe('cursor of a ConPTY terminal after a resize (1.0.7)', () => {
  // "D:\Projekty\_tmp\run-7GLMno\project>" is 43 characters: at 34 columns the prompt wraps, the cursor is at 9 on row 2.
  it('a wrapped prompt drawn whole on a wider terminal: the cursor goes to its end, not mid-path', () => {
    const offset = cursorOffset(buffer(2, 9, [2]), 34);
    expect(offset).toBe(43);
    // After xterm reflowed it to 70 columns the prompt is one row (row 1) and the cursor was left at column 9.
    expect(reflowedCursor(buffer(1, 9, []), offset, 70)).toEqual({ row: 1, x: 43 });
  });

  it('narrower: the prompt wraps over three rows and the cursor ends on the last one', () => {
    const offset = cursorOffset(buffer(1, 43, []), 70);
    expect(reflowedCursor(buffer(3, 43, [2, 3]), offset, 20)).toEqual({ row: 3, x: 3 });
  });

  it('nothing to do when the cursor is already right or its line is not wrapped', () => {
    expect(reflowedCursor(buffer(5, 12, []), cursorOffset(buffer(5, 12, []), 80), 100)).toBeNull();
    expect(reflowedCursor(buffer(3, 3, [2, 3]), 43, 20)).toBeNull();
  });

  it('a line that exactly fills its rows keeps the cursor at the end of the last row', () => {
    // 40 characters at 20 columns: rows 1 and 2; there is no row 3 of that line.
    expect(reflowedCursor(buffer(2, 0, [2]), 40, 20)).toEqual({ row: 2, x: 19 });
    // A third row continues the line (the cursor wrapped onto it): it stays there.
    expect(reflowedCursor(buffer(2, 5, [2, 3]), 40, 20)).toEqual({ row: 3, x: 0 });
  });
});
