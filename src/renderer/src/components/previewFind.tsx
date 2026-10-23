// Find in a rendered preview (Markdown): searches the text the reader sees, marks the matches with the CSS Custom Highlight API
// (no DOM changes, so links, selection and the rendered HTML stay as they are) and scrolls the current one into view.
import { useCallback, useEffect, useLayoutEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { findMatches, joinSegments, locateOffset, stepMatch, type TextSegment } from '../../../shared/findText';
import { FindWidget, type FindToggles } from './FindWidget';

const BLOCKS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TD', 'TH', 'TR', 'BLOCKQUOTE', 'DT', 'DD', 'SUMMARY', 'DETAILS', 'TABLE', 'UL', 'OL', 'DIV', 'ARTICLE', 'HR']);
const HIGHLIGHT = 'mc-find';
const CURRENT = 'mc-find-current';

function blockOf(node: Node, root: Element): Element {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) if (BLOCKS.has(el.tagName)) return el;
  return root;
}

/** The rendered text in pieces (one per text node), with the block boundaries between them. */
function textNodes(root: Element): { nodes: Text[]; segments: TextSegment[] } {
  const nodes: Text[] = [];
  const segments: TextSegment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let lastBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data) continue;
    const block = blockOf(text, root);
    segments.push({ text: text.data, block: block !== lastBlock });
    nodes.push(text);
    lastBlock = block;
  }
  return { nodes, segments };
}

const highlights = (): HighlightRegistry | null => (typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null);

function paint(ranges: Range[], current: number | null): void {
  const registry = highlights();
  if (!registry) return;
  registry.set(HIGHLIGHT, new Highlight(...ranges.filter((_, i) => i !== current)));
  if (current === null || !ranges[current]) registry.delete(CURRENT);
  else registry.set(CURRENT, new Highlight(ranges[current]));
}

function clearPaint(): void {
  highlights()?.delete(HIGHLIGHT);
  highlights()?.delete(CURRENT);
}

/** Scrolls the range into the middle third of the scroller when it is not comfortably visible (below the widget). */
function reveal(range: Range, scroller: HTMLElement): void {
  // A match inside a closed <details> is invisible: open it first.
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.top >= box.top + 56 && rect.bottom <= box.bottom - 24) {
    if (rect.left >= box.left && rect.right <= box.right) return;
  }
  scroller.scrollTop += rect.top - box.top - scroller.clientHeight / 3;
  if (rect.left < box.left || rect.right > box.right) scroller.scrollLeft += rect.left - box.left - 40;
}

/** The selected text inside `root` when it is a short single line, else ''. */
export function selectedText(root: Element | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return '';
  if (!root.contains(selection.getRangeAt(0).commonAncestorContainer)) return '';
  const text = selection.toString();
  return text.length <= 200 && !/[\r\n]/.test(text) ? text : '';
}

/**
 * Find for a rendered preview. `content` is the element with the rendered text, `scroller` the scrolling box the widget floats
 * over, `version` changes whenever the rendered HTML does (the matches are collected again).
 */
export function usePreviewFind(content: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, version: unknown): {
  open: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  widget: ReactNode;
} {
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<FindToggles>({ caseSensitive: false, wholeWord: false, regexp: false });
  const [focus, setFocus] = useState(1);
  const [result, setResult] = useState<{ ranges: Range[]; capped: boolean; invalid: boolean }>({ ranges: [], capped: false, invalid: false });
  const [current, setCurrent] = useState<number | null>(null);

  const open = useCallback(() => {
    const seed = selectedText(content.current);
    if (seed) setQuery(seed);
    setShown(true);
    setFocus((n) => n + 1);
  }, [content]);

  const close = useCallback(() => {
    setShown(false);
    clearPaint();
    scroller.current?.focus({ preventScroll: true });
  }, [scroller]);

  // Collect the matches as DOM ranges.
  useLayoutEffect(() => {
    const root = content.current;
    if (!shown || !root) { clearPaint(); return; }
    const { nodes, segments } = textNodes(root);
    const { text, starts } = joinSegments(segments);
    const lengths = segments.map((s) => s.text.length);
    const found = findMatches(text, { query, ...toggles });
    const ranges: Range[] = [];
    for (const [from, to] of found.matches) {
      const start = locateOffset(starts, lengths, from);
      const end = locateOffset(starts, lengths, to, true);
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(nodes[start.segment], start.offset);
      range.setEnd(nodes[end.segment], end.offset);
      ranges.push(range);
    }
    setResult({ ranges, capped: found.capped, invalid: found.invalid });
    // A new search (typing, a toggle, a changed file) starts at the first match at or below the top of the view, like a browser.
    const top = scroller.current?.getBoundingClientRect().top ?? 0;
    let index: number | null = ranges.length ? 0 : null;
    for (let i = 0; i < ranges.length; i++) if (ranges[i].getBoundingClientRect().bottom >= top + 56) { index = i; break; }
    setCurrent(index);
  }, [shown, query, toggles, version, content, scroller]);

  useEffect(() => {
    if (!shown) return;
    paint(result.ranges, current);
    const range = current === null ? null : result.ranges[current];
    if (range && scroller.current) reveal(range, scroller.current);
  }, [result, current, shown, scroller]);

  useEffect(() => clearPaint, []);

  const step = useCallback((dir: 1 | -1) => {
    setCurrent((index) => stepMatch(index, result.ranges.length, dir));
  }, [result]);

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
      total={result.ranges.length}
      capped={result.capped}
      invalid={result.invalid}
      onNext={() => step(1)}
      onPrev={() => step(-1)}
      onClose={close}
      focusFind={focus}
    />
  ) : null;
  return { open, onKeyDown, widget };
}
