// Find in a terminal's scrollback: the rows of the xterm buffer, with the rows that continue a wrapped line joined to it, are
// searched like one text; every match comes back as the cells it covers (one span per row, a match may cross a wrap).
import { FIND_LIMIT, type FindOptions } from './findText';
import { findInItems, joinItems } from './findItems';

export interface TerminalRow {
  /** The row's text, as xterm gives it (trailing blanks trimmed unless the next row continues it). */
  text: string;
  /** The row continues the previous one (soft wrap). */
  wrapped: boolean;
  /**
   * The column of each UTF-16 unit of `text` plus one more entry: the column after the last character. Missing when every
   * character takes one cell (plain ASCII), then the offset is the column.
   */
  columns?: number[];
}

export interface TerminalSpan { row: number; col: number; width: number }
export interface TerminalMatch { row: number; col: number; spans: TerminalSpan[] }
export interface TerminalFindResult { matches: TerminalMatch[]; invalid: boolean; capped: boolean }

const columnOf = (row: TerminalRow, offset: number): number => (row.columns ? row.columns[Math.min(offset, row.columns.length - 1)] : offset);

/** Every match in the rows, in buffer order (top to bottom), as the cells to highlight. */
export function findInTerminal(rows: readonly TerminalRow[], options: FindOptions, limit = FIND_LIMIT): TerminalFindResult {
  // Logical lines: a row and the rows that continue it. `first[i]` is the first row of line i, `offsets[r]` where row r begins in its line.
  const lines: string[] = [];
  const first: number[] = [];
  const offsets: number[] = new Array(rows.length);
  rows.forEach((row, index) => {
    if (index === 0 || !row.wrapped) { lines.push(''); first.push(index); }
    offsets[index] = lines[lines.length - 1].length;
    lines[lines.length - 1] += row.text;
  });
  const found = findInItems(joinItems(lines), options, limit);
  const matches: TerminalMatch[] = [];
  for (const { item, from, to } of found.matches) {
    const spans: TerminalSpan[] = [];
    const last = item + 1 < first.length ? first[item + 1] : rows.length;
    for (let r = first[item]; r < last && offsets[r] < to; r++) {
      const a = Math.max(from, offsets[r]) - offsets[r];
      const b = Math.min(to, offsets[r] + rows[r].text.length) - offsets[r];
      if (b <= a) continue;
      const col = columnOf(rows[r], a);
      spans.push({ row: r, col, width: Math.max(1, columnOf(rows[r], b) - col) });
    }
    if (spans.length) matches.push({ row: spans[0].row, col: spans[0].col, spans });
  }
  return { matches, invalid: found.invalid, capped: found.capped };
}

/**
 * Where a new search starts: the last match that begins at or above the bottom row of the view (the newest output the
 * user can see), else the first one below it.
 */
export function terminalStartMatch(matches: readonly TerminalMatch[], viewportBottom: number): number | null {
  if (!matches.length) return null;
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches[mid].row <= viewportBottom) low = mid + 1; else high = mid;
  }
  return low > 0 ? low - 1 : 0;
}

/** The scroll position (top row) that shows `row`, or null when it is already in view with a margin of one row. */
export function terminalScrollFor(row: number, viewportTop: number, rows: number, maxTop: number): number | null {
  if (row >= viewportTop + 1 && row <= viewportTop + rows - 2) return null;
  if (rows <= 2 && row >= viewportTop && row < viewportTop + rows) return null;
  return Math.max(0, Math.min(maxTop, row - Math.floor(rows / 3)));
}
