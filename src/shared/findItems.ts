// Find over many separate pieces of text: the lines of a diff or of a large file, the cells of a table, the rows of a terminal.
// The pieces are joined into one string (one regexp pass, fast even for 50 000 rows) and every match is mapped back to its
// piece; a match never spans two pieces. The views render only what is on screen and ask for the matches of one piece.
import { findMatches, findPattern, FIND_LIMIT, type FindOptions } from './findText';

const WORD = /[\p{L}\p{N}_]/u;
const isWordChar = (ch: string | undefined): boolean => !!ch && WORD.test(ch);

export interface ItemMatch {
  /** Index of the piece (line, cell). */
  item: number;
  /** [from, to) inside the piece. */
  from: number;
  to: number;
}

export interface ItemFindResult { matches: ItemMatch[]; invalid: boolean; capped: boolean }

/** The data views (tables, large files) count this many matches before the counter says "+". */
export const DATA_FIND_LIMIT = 100_000;

export interface JoinedItems {
  text: string;
  /** Where piece i begins in `text`; the pieces are separated by one "\n" that belongs to none of them. */
  starts: number[];
  lengths: number[];
}

/** One searchable string: "\n" between the pieces, so `^` and `$` (regexp) mean the start and the end of a piece. */
export function joinItems(items: readonly string[]): JoinedItems {
  const starts: number[] = new Array(items.length);
  const lengths: number[] = new Array(items.length);
  let at = 0;
  for (let i = 0; i < items.length; i++) {
    starts[i] = at;
    lengths[i] = items[i].length;
    at += items[i].length + 1;
  }
  return { text: items.join('\n'), starts, lengths };
}

/** The last piece that starts at or before `position` (binary search). */
function pieceAt(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= position) low = mid; else high = mid - 1;
  }
  return low;
}

/**
 * Every match in the pieces, in order. A match never runs from one piece into the next: when the expression would cross the
 * "\n" (`\s`, `[^x]+`), that piece is searched on its own and the search goes on at the next piece.
 */
export function findInItems(joined: JoinedItems, options: FindOptions, limit = FIND_LIMIT): ItemFindResult {
  if (!joined.starts.length || !options.query) return { matches: [], invalid: false, capped: false };
  const pattern = findPattern(options);
  if (!pattern) return { matches: [], invalid: true, capped: false };
  const { text, starts, lengths } = joined;
  const matches: ItemMatch[] = [];
  let capped = false;
  let piece = 0;
  const push = (item: number, from: number, to: number): boolean => {
    if (matches.length >= limit) { capped = true; return false; }
    matches.push({ item, from, to });
    return true;
  };
  for (let at = 0; at <= text.length;) {
    pattern.lastIndex = at;
    const found = pattern.exec(text);
    if (!found) break;
    const from = found.index;
    const to = from + found[0].length;
    if (to === from) { at = from + 1; continue; }
    // The matches come in order: move forward from the last piece instead of searching from the start each time.
    if (piece + 1 < starts.length && starts[piece + 1] <= from) piece = pieceAt(starts, from);
    const start = starts[piece];
    const end = start + lengths[piece];
    if (from >= end) { at = end + 1; continue; }
    if (to > end) {
      for (const [a, b] of findMatches(text.slice(start, end), options, limit).matches) if (a >= from - start && !push(piece, a, b)) break;
      if (capped) break;
      at = end + 1;
      continue;
    }
    if (options.wholeWord && (isWordChar(text[from - 1]) || isWordChar(text[to]))) { at = from + 1; continue; }
    if (!push(piece, from - start, to - start)) break;
    at = to;
  }
  return { matches, invalid: false, capped };
}

/** The first match index whose piece is at or after `item` (wrapping to the first match), or null without matches. */
export function firstMatchFrom(matches: readonly ItemMatch[], item: number): number | null {
  if (!matches.length) return null;
  const index = lowerBound(matches, item);
  return index < matches.length ? index : 0;
}

/** The last match index whose piece is at or before `item` (wrapping to the last match), or null without matches. */
export function lastMatchUpTo(matches: readonly ItemMatch[], item: number): number | null {
  if (!matches.length) return null;
  const index = lowerBound(matches, item + 1) - 1;
  return index >= 0 ? index : matches.length - 1;
}

/** [first, end) of the matches inside one piece. */
export function matchesOf(matches: readonly ItemMatch[], item: number): [number, number] {
  return [lowerBound(matches, item), lowerBound(matches, item + 1)];
}

function lowerBound(matches: readonly ItemMatch[], item: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches[mid].item < item) low = mid + 1; else high = mid;
  }
  return low;
}

/** A piece of a line split for drawing: plain text or a match (`current` for the one the counter points at). */
export interface MarkedPart { text: string; mark: boolean; current: boolean }

/**
 * Splits `text[start, end)` into plain and marked parts. `ranges` are [from, to) in the whole text; `current` is the index in
 * `ranges` of the current match (or -1). Ranges outside the window are clipped.
 */
export function markParts(text: string, ranges: ReadonlyArray<readonly [number, number]>, current = -1, start = 0, end = text.length): MarkedPart[] {
  const parts: MarkedPart[] = [];
  let at = start;
  ranges.forEach(([from, to], index) => {
    const a = Math.max(from, at);
    const b = Math.min(to, end);
    if (b <= a) return;
    if (a > at) parts.push({ text: text.slice(at, a), mark: false, current: false });
    parts.push({ text: text.slice(a, b), mark: true, current: index === current });
    at = b;
  });
  if (at < end) parts.push({ text: text.slice(at, end), mark: false, current: false });
  return parts;
}

/**
 * The window of a long line that is drawn (the views cut lines at `max` characters): the start, or a stretch around the
 * current match when it lies beyond the cut, so the match the counter points at is always on screen.
 */
export function lineWindow(length: number, max: number, focus?: readonly [number, number]): { start: number; end: number } {
  if (length <= max) return { start: 0, end: length };
  if (!focus || focus[1] <= max) return { start: 0, end: max };
  const start = Math.max(0, Math.min(length - max, focus[0] - Math.floor(max / 4)));
  return { start, end: Math.min(length, start + max) };
}
