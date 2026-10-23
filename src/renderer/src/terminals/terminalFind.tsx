// Find in a terminal cell's scrollback (Ctrl+Shift+F by default, Settings > Shortcuts): the find widget at the top right of
// the cell, the matches painted with xterm decorations, the current one scrolled into view. New output searches again a
// moment later and keeps the current match. Escape gives the keyboard back to the terminal.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import { create } from 'zustand';
import { stepMatch } from '../../../shared/findText';
import { findInTerminal, terminalScrollFor, terminalStartMatch, type TerminalFindResult, type TerminalRow } from '../../../shared/terminalFind';
import { FindWidget, type FindToggles } from '../components/FindWidget';
import { useI18n } from '../i18n';
import { matchesShortcut } from '../shortcuts';
import { terminals } from './TerminalManager';

/** Open widgets: cell id -> a counter bumped by every Ctrl+Shift+F (moves the keyboard back into the field). */
const useFindStore = create<Record<string, number>>(() => ({}));

export function openTerminalFind(cellId: string): void {
  useFindStore.setState((open) => ({ [cellId]: (open[cellId] ?? 0) + 1 }));
}

function closeTerminalFind(cellId: string): void {
  useFindStore.setState((open) => { const next = { ...open }; delete next[cellId]; return next; }, true);
}

/** The terminal cell the keyboard is in (the shortcut fires only there, see shortcuts.ts `terminalOnly`). */
export function focusedTerminalCell(): string | null {
  const active = document.activeElement;
  return active instanceof Element ? active.closest('[data-cell-id]')?.getAttribute('data-cell-id') ?? null : null;
}

const MATCH = '#5c4813';
const CURRENT = '#e2a33c';
const CURRENT_TEXT = '#16130c';
/** Output keeps coming while the widget is open (an agent at work): search again at most this often. */
const RESEARCH_MS = 400;

/** The rows of the active buffer as text, with the cell of each character where a character is not one cell wide. */
function readRows(term: Terminal): TerminalRow[] {
  const buffer = term.buffer.active;
  const rows: TerminalRow[] = new Array(buffer.length);
  const cell = buffer.getNullCell();
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) { rows[y] = { text: '', wrapped: false }; continue; }
    const continued = buffer.getLine(y + 1)?.isWrapped === true;
    const text = line.translateToString(!continued);
    if (!/[^\x20-\x7e]/.test(text)) { rows[y] = { text, wrapped: line.isWrapped }; continue; }
    // Wide (CJK, emoji) or combined characters: map every UTF-16 unit to the column of its cell.
    let chars = '';
    const columns: number[] = [];
    const ends: number[] = [];
    for (let x = 0; x < line.length; x++) {
      if (!line.getCell(x, cell)) break;
      const width = cell.getWidth();
      if (width === 0) continue;
      const value = cell.getChars() || ' ';
      for (let i = 0; i < value.length; i++) { columns.push(x); ends.push(x + width); }
      chars += value;
    }
    if (!continued) {
      let keep = chars.length;
      while (keep > 0 && chars[keep - 1] === ' ') keep--;
      chars = chars.slice(0, keep);
      columns.length = keep;
    }
    columns.push(chars.length ? ends[chars.length - 1] : 0);
    rows[y] = { text: chars, wrapped: line.isWrapped, columns };
  }
  return rows;
}

const EMPTY: TerminalFindResult = { matches: [], invalid: false, capped: false };

export function TerminalFind({ cellId }: { cellId: string }) {
  const focus = useFindStore((open) => open[cellId]);
  return focus ? <TerminalFindBox cellId={cellId} focus={focus} /> : null;
}

function TerminalFindBox({ cellId, focus }: { cellId: string; focus: number }) {
  const { tr } = useI18n();
  const [query, setQuery] = useState(() => {
    const selected = terminals.xterm(cellId)?.getSelection() ?? '';
    return selected.length <= 200 && !/[\r\n]/.test(selected) ? selected : '';
  });
  const [toggles, setToggles] = useState<FindToggles>({ caseSensitive: false, wholeWord: false, regexp: false });
  const [output, setOutput] = useState(0);
  const [result, setResult] = useState<TerminalFindResult>(EMPTY);
  const [current, setCurrent] = useState<number | null>(null);
  const searched = useRef<string>('');
  /** Follows the current match through new output and trimmed scrollback (xterm moves its markers with the lines). */
  const anchor = useRef<{ marker: IMarker; col: number } | null>(null);
  const decorations = useRef<Array<IDecoration | IMarker>>([]);
  /** The next paint scrolls to the current match: after typing, a toggle or a step, not after new output (the user may be reading elsewhere). */
  const reveal = useRef(true);

  const clearPaint = useCallback(() => {
    for (const item of decorations.current) item.dispose();
    decorations.current = [];
  }, []);

  // New output (or the switch to and from a full-screen program) searches again, a little later.
  useEffect(() => {
    const term = terminals.xterm(cellId);
    if (!term) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => { timer ??= setTimeout(() => { timer = null; setOutput((n) => n + 1); }, RESEARCH_MS); };
    const parsed = term.onWriteParsed(later);
    const switched = term.buffer.onBufferChange(later);
    return () => { parsed.dispose(); switched.dispose(); if (timer) clearTimeout(timer); };
  }, [cellId]);

  useEffect(() => {
    const term = terminals.xterm(cellId);
    if (!term) { setResult(EMPTY); setCurrent(null); return; }
    const options = { query, ...toggles };
    const found = findInTerminal(readRows(term), options);
    const spec = JSON.stringify(options);
    const buffer = term.buffer.active;
    let index: number | null;
    const kept = anchor.current;
    if (spec === searched.current && kept && !kept.marker.isDisposed && kept.marker.line >= 0) {
      // Only the output changed: stay on the same match, or the nearest one at or above it.
      const exact = found.matches.findIndex((m) => m.row === kept.marker.line && m.col === kept.col);
      index = exact >= 0 ? exact : terminalStartMatch(found.matches, kept.marker.line);
      reveal.current = false;
    } else {
      reveal.current = true;
      index = terminalStartMatch(found.matches, buffer.viewportY + term.rows - 1);
    }
    searched.current = spec;
    setResult(found);
    setCurrent(index);
  }, [cellId, query, toggles, output]);

  // Paint the matches and scroll to the current one.
  useEffect(() => {
    const term = terminals.xterm(cellId);
    clearPaint();
    if (!term) return;
    const buffer = term.buffer.active;
    const cursor = buffer.baseY + buffer.cursorY;
    const at = current === null ? null : result.matches[current];
    result.matches.forEach((match, index) => {
      const own = index === current;
      for (const span of match.spans) {
        const marker = term.registerMarker(span.row - cursor);
        if (!marker) continue;
        decorations.current.push(marker);
        const decoration = term.registerDecoration({
          marker, x: span.col, width: span.width, layer: own ? 'top' : 'bottom',
          backgroundColor: own ? CURRENT : MATCH, ...(own ? { foregroundColor: CURRENT_TEXT } : {}),
        });
        if (decoration) decorations.current.push(decoration);
      }
    });
    anchor.current?.marker.dispose();
    anchor.current = null;
    if (at) {
      const marker = term.registerMarker(at.row - cursor);
      if (marker) anchor.current = { marker, col: at.col };
      const top = terminalScrollFor(at.row, buffer.viewportY, term.rows, buffer.baseY);
      if (top !== null && reveal.current) term.scrollToLine(top);
    }
  }, [cellId, result, current, clearPaint]);

  useEffect(() => () => { clearPaint(); anchor.current?.marker.dispose(); anchor.current = null; }, [clearPaint]);

  const close = () => {
    closeTerminalFind(cellId);
    terminals.focus(cellId);
  };
  const step = (dir: 1 | -1) => { reveal.current = true; setCurrent((index) => stepMatch(index, result.matches.length, dir)); };

  return (
    <div className="terminal-find">
      <FindWidget
        label={tr('Znajdź w terminalu')}
        query={query}
        onQuery={setQuery}
        toggles={toggles}
        onToggle={(name) => setToggles((t) => ({ ...t, [name]: !t[name] }))}
        current={current}
        total={result.matches.length}
        capped={result.capped}
        invalid={result.invalid}
        onNext={() => step(1)}
        onPrev={() => step(-1)}
        onClose={close}
        focusFind={focus}
        isFindKey={(e) => matchesShortcut('terminal.find', e)}
      />
    </div>
  );
}
