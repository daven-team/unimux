// Find in a view made of many pieces of text (the lines of a diff or a large file, the cells of a table): the same widget as the
// code editor, the search runs over the data itself (not the DOM: the lists draw only the rows on screen), the view draws the
// matches of its visible pieces with <ItemText> and moves to the current one in `reveal`.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { findInItems, firstMatchFrom, joinItems, markParts, matchesOf, type ItemMatch } from '../../../shared/findItems';
import { stepMatch } from '../../../shared/findText';
import { FindWidget, type FindToggles } from './FindWidget';
import { selectedText } from './previewFind';

export interface ItemFind {
  open: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  widget: ReactNode;
  shown: boolean;
  matches: readonly ItemMatch[];
  /** Index into `matches` of the current match, or null. */
  current: number | null;
}

export interface ItemFindOptions {
  /** The box the widget floats over (the keyboard goes back to it on Escape) and where the selection may seed the query. */
  scroller: RefObject<HTMLElement | null>;
  /** Moves the view to the match (scrolls the list to its row; the view finishes horizontally once the row is drawn). */
  reveal(match: ItemMatch): void;
  /** The first piece on screen: a new search starts at the first match from there. */
  firstVisible(): number;
  limit?: number;
}

export function useItemFind(items: readonly string[], options: ItemFindOptions): ItemFind {
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<FindToggles>({ caseSensitive: false, wholeWord: false, regexp: false });
  const [focus, setFocus] = useState(1);
  const [current, setCurrent] = useState<number | null>(null);
  const opts = useRef(options);
  opts.current = options;
  // Large data (50 000 rows) is searched in one pass, but typing stays responsive: the search follows the field a moment later.
  const deferred = useDeferredValue(query);
  const joined = useMemo(() => (shown ? joinItems(items) : null), [shown, items]);
  const result = useMemo(() => (joined ? findInItems(joined, { query: deferred, ...toggles }, options.limit) : null), [joined, deferred, toggles, options.limit]);
  const matches = result?.matches ?? [];

  // A new search (typing, a toggle, changed data) starts at the first match at or below the top of the view.
  useEffect(() => {
    if (!result) return;
    setCurrent(firstMatchFrom(result.matches, opts.current.firstVisible()));
  }, [result]);

  useEffect(() => {
    if (!result || current === null || !result.matches[current]) return;
    opts.current.reveal(result.matches[current]);
  }, [result, current]);

  const open = useCallback(() => {
    const seed = selectedText(opts.current.scroller.current);
    if (seed) setQuery(seed);
    setShown(true);
    setFocus((n) => n + 1);
  }, []);

  const close = useCallback(() => {
    setShown(false);
    setCurrent(null);
    opts.current.scroller.current?.focus({ preventScroll: true });
  }, []);

  const total = matches.length;
  const step = useCallback((dir: 1 | -1) => setCurrent((index) => stepMatch(index, total, dir)), [total]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!shown) return;
    if (e.key === 'F3') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  const widget = shown ? (
    <FindWidget
      query={query}
      onQuery={setQuery}
      toggles={toggles}
      onToggle={(name) => setToggles((t) => ({ ...t, [name]: !t[name] }))}
      current={current}
      total={total}
      capped={result?.capped}
      invalid={result?.invalid}
      onNext={() => step(1)}
      onPrev={() => step(-1)}
      onClose={close}
      focusFind={focus}
    />
  ) : null;
  return { open, onKeyDown, widget, shown, matches: shown ? matches : [], current: shown ? current : null };
}

/**
 * The text of one piece with its matches marked. `start` / `end` cut a window out of a long line (the large file view draws
 * 2000 characters); `prefix` and `suffix` are drawn around it (an ellipsis).
 */
export function ItemText({ text, item, find, start = 0, end = text.length, prefix = '', suffix = '' }: {
  text: string; item: number; find: Pick<ItemFind, 'matches' | 'current'>; start?: number; end?: number; prefix?: string; suffix?: string;
}): ReactNode {
  const [first, last] = find.matches.length ? matchesOf(find.matches, item) : [0, 0];
  if (first === last) return `${prefix}${text.slice(start, end)}${suffix}`;
  const ranges = find.matches.slice(first, last).map((m) => [m.from, m.to] as const);
  const current = find.current !== null && find.current >= first && find.current < last ? find.current - first : -1;
  return <>{prefix}{markParts(text, ranges, current, start, end).map((part, i) => (part.mark
    ? <mark key={i} className={`find-mark ${part.current ? 'current' : ''}`}>{part.text}</mark>
    : part.text))}{suffix}</>;
}

/** Lets Ctrl+F outside the view's text (the tab's toolbar, see FileEditor.tsx) open this view's widget while it is mounted. */
export function useFileFinder(finder: RefObject<((replace: boolean) => void) | null> | undefined, open: () => void): void {
  useEffect(() => {
    if (!finder) return;
    const mine = () => open();
    finder.current = mine;
    return () => { if (finder.current === mine) finder.current = null; };
  }, [finder, open]);
}

/**
 * Scrolls the current match (the element `selector` finds: the mark drawn by <ItemText>, or the table cell holding it) into the
 * horizontal view of the scroller, leaving `left` pixels free for a sticky column. False while it is not drawn yet.
 */
export function revealMarkHorizontally(scroller: HTMLElement, left = 0, selector = '.find-mark.current'): boolean {
  const mark = scroller.querySelector<HTMLElement>(selector);
  if (!mark) return false;
  const rect = mark.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.left < box.left + left) scroller.scrollLeft -= box.left + left - rect.left + 40;
  else if (rect.right > box.right - 16) scroller.scrollLeft += rect.right - box.right + Math.min(box.width / 3, 120);
  return true;
}

/** Vertical scroll for a row of fixed height so it shows below the widget, or null when it is already comfortably in view. */
export function rowScrollTop(index: number, rowHeight: number, scroller: HTMLElement, header = 0): number | null {
  const y = header + index * rowHeight;
  const top = scroller.scrollTop;
  const height = scroller.clientHeight;
  if (y >= top + header + 40 && y + rowHeight <= top + height - 8) return null;
  return Math.max(0, y - Math.round(height / 3));
}
