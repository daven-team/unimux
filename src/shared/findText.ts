// Find inside one file: the pure part behind the find widget of the code editor and the rendered previews (Markdown).
// The code editor searches with @codemirror/search itself; the previews search their rendered text with findMatches.
import type { MessageKey, MessageParams } from './i18n';

export interface FindOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export interface FindResult {
  /** [from, to) offsets into the searched text, in order, never empty. */
  matches: Array<[number, number]>;
  /** The regular expression does not compile. */
  invalid: boolean;
  /** More matches exist than `limit`; the list stops there. */
  capped: boolean;
}

/** More matches than this are not collected (the counter says "1000+"). */
export const FIND_LIMIT = 1000;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = /[\p{L}\p{N}_]/u;
const isWordChar = (ch: string | undefined): boolean => !!ch && WORD.test(ch);

/** The pattern for the options, or null when the regular expression is invalid. Always global and Unicode-aware. */
export function findPattern(options: FindOptions): RegExp | null {
  const source = options.regexp ? options.query : escapeRegExp(options.query);
  try {
    return new RegExp(source, `g${options.caseSensitive ? '' : 'i'}${options.regexp ? 'mu' : 'u'}`);
  } catch {
    // A pattern that is fine without the u flag (`\-`, `[\w-]`) still works the way people expect from other editors.
    if (!options.regexp) return null;
    try { return new RegExp(source, `g${options.caseSensitive ? '' : 'i'}m`); } catch { return null; }
  }
}

/**
 * Every match of the query in `text`. A plain query is literal (no `\n` unquoting); case folding goes through the regular
 * expression so the offsets stay those of the original text. Zero-length regexp matches (`^`, `\b`) are skipped.
 * Whole word: the match must not continue a word on either side (letters, digits and `_` of any script).
 */
export function findMatches(text: string, options: FindOptions, limit = FIND_LIMIT): FindResult {
  if (!options.query) return { matches: [], invalid: false, capped: false };
  const pattern = findPattern(options);
  if (!pattern) return { matches: [], invalid: true, capped: false };
  const matches: Array<[number, number]> = [];
  let capped = false;
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    const from = found.index;
    const to = from + found[0].length;
    if (to === from) { pattern.lastIndex = from + 1; continue; }
    if (options.wholeWord && (isWordChar(text[from - 1]) || isWordChar(text[to]))) {
      // Retry one character further: "foo" in "foofoo foo" must still find the last one.
      pattern.lastIndex = from + 1;
      continue;
    }
    if (matches.length >= limit) { capped = true; break; }
    matches.push([from, to]);
  }
  return { matches, invalid: false, capped };
}

/** The next (dir 1) or previous (dir -1) match index, wrapping around; from nothing selected it starts at the first / last. */
export function stepMatch(current: number | null, total: number, dir: 1 | -1): number | null {
  if (total <= 0) return null;
  if (current === null || current < 0 || current >= total) return dir === 1 ? 0 : total - 1;
  return (current + dir + total) % total;
}

/** Index of the first match that starts at or after `offset` (wrapping to the first one), or null without matches. */
export function matchAtOrAfter(matches: ReadonlyArray<readonly [number, number]>, offset: number): number | null {
  if (!matches.length) return null;
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches[mid][0] < offset) low = mid + 1; else high = mid;
  }
  return low < matches.length ? low : 0;
}

/** What the counter of the widget says: "3 z 12", "? z 12" (the cursor is not on a match), "Brak wyników", an invalid regexp. */
export function findCounter(state: { query: string; current: number | null; total: number; capped?: boolean; invalid?: boolean }, format: (n: number) => string = String): { key: MessageKey; params?: MessageParams; empty?: boolean } | null {
  if (!state.query) return null;
  if (state.invalid) return { key: 'Nieprawidłowe wyrażenie', empty: true };
  if (state.total <= 0) return { key: 'Brak wyników', empty: true };
  const total = `${format(state.total)}${state.capped ? '+' : ''}`;
  return { key: '{current} z {total}', params: { current: state.current === null ? '?' : format(state.current + 1), total } };
}

/** A piece of rendered text (one DOM text node); `block` marks the first piece of a new block (paragraph, list item, cell). */
export interface TextSegment { text: string; block: boolean }

/**
 * Joins the pieces into one searchable string. A block boundary becomes a "\n" that belongs to no piece, so a word at the end of
 * a heading and one at the start of the next paragraph never form a match together. `starts[i]` is where piece i begins.
 */
export function joinSegments(segments: readonly TextSegment[]): { text: string; starts: number[] } {
  const starts: number[] = [];
  let text = '';
  segments.forEach((segment, index) => {
    if (segment.block && index > 0 && !text.endsWith('\n')) text += '\n';
    starts.push(text.length);
    text += segment.text;
  });
  return { text, starts };
}

/**
 * The piece and the offset inside it for a position of the joined text. `end` positions (the end of a match) prefer the end of
 * the previous piece over the start of the next one, so a match never reaches into a piece it does not cover.
 */
export function locateOffset(starts: readonly number[], lengths: readonly number[], position: number, end = false): { segment: number; offset: number } | null {
  if (!starts.length) return null;
  // The last piece that starts at (a start) or before (an end) the position.
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (end ? starts[mid] < position : starts[mid] <= position) low = mid; else high = mid - 1;
  }
  const inside = position - starts[low];
  // A start on a block separator (the "\n" between pieces) moves to the beginning of the next piece.
  if (!end && inside >= lengths[low] && low + 1 < starts.length) return { segment: low + 1, offset: 0 };
  return { segment: low, offset: Math.max(0, Math.min(lengths[low], inside)) };
}

/**
 * Is this key press the find (Ctrl+F, Cmd+F) or the find-and-replace (Ctrl+H; Cmd+Alt+F on macOS, where Cmd+H hides the app)
 * of a file? AltGr (Ctrl+Alt on Windows) never counts, so characters typed with it stay text.
 */
export function findKey(event: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, platform: string): 'find' | 'replace' | null {
  const mac = platform === 'darwin';
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.shiftKey) return null;
  if (event.code === 'KeyF') return event.altKey ? (mac ? 'replace' : null) : 'find';
  if (event.code === 'KeyH' && !event.altKey && !mac) return 'replace';
  return null;
}
