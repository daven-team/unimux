// 1.0.7: the cursor of a ConPTY terminal after a resize. ConPTY reflows its own buffer (the line with the cursor too) and does
// not redraw it, so xterm reflows that line as well (reflowCursorLine, 1.0.6). xterm moves the line but leaves the cursor's
// column where it was: a wrapped cmd.exe prompt drawn whole on a wider terminal showed the cursor in the middle of the path
// until the next keystroke made ConPTY place it. The cursor's place in its logical line (the rows joined by wrapping) is
// what both sides keep, so the terminal puts its cursor back there. Pure: the renderer only reads the buffer.

/** The rows of a buffer that matter here (xterm's IBufferLine.isWrapped: the row continues the one above). */
export interface WrapBuffer {
  /** Absolute row of the cursor (baseY + cursorY). */
  cursorRow: number;
  cursorX: number;
  isWrapped(row: number): boolean;
}

/** The cursor's offset in its logical line: the wrapped rows above it, each `cols` wide, plus its column. */
export function cursorOffset(buffer: WrapBuffer, cols: number): number {
  let start = buffer.cursorRow;
  while (start > 0 && buffer.isWrapped(start)) start--;
  return (buffer.cursorRow - start) * cols + buffer.cursorX;
}

/**
 * Where the cursor belongs after the reflow: the same offset in the logical line that now holds the cursor row, laid out at
 * `cols`. Null when it is where it should be already. A position exactly at a row's end stays on that row (xterm's pending
 * wrap), not at the start of a row that does not exist.
 */
export function reflowedCursor(buffer: WrapBuffer, offset: number, cols: number): { row: number; x: number } | null {
  if (cols <= 0 || offset < 0) return null;
  let start = buffer.cursorRow;
  while (start > 0 && buffer.isWrapped(start)) start--;
  let line = Math.floor(offset / cols);
  let x = offset % cols;
  if (x === 0 && line > 0 && !buffer.isWrapped(start + line)) { line--; x = cols - 1; }
  const row = start + line;
  return row === buffer.cursorRow && x === buffer.cursorX ? null : { row, x };
}
