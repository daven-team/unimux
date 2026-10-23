import { describe, expect, it } from 'vitest';
import { DATA_FIND_LIMIT, findInItems, firstMatchFrom, joinItems, lastMatchUpTo, lineWindow, markParts, matchesOf } from '../src/shared/findItems';
import { findInTerminal, terminalScrollFor, terminalStartMatch, type TerminalRow } from '../src/shared/terminalFind';
import type { FindOptions } from '../src/shared/findText';
import { decideShortcut, type DispatchContext } from '../src/shared/shortcutDispatch';
import { resolveShortcuts } from '../src/shared/shortcuts';
import { parseDelimited, TABLE_VIEW_ROWS } from '../src/shared/csv';

const opts = (query: string, extra: Partial<FindOptions> = {}): FindOptions => ({ query, caseSensitive: false, wholeWord: false, regexp: false, ...extra });

describe('find over lines and cells', () => {
  it('maps every match back to its piece', () => {
    const joined = joinItems(['alpha', '', 'beta alpha', 'ALPHA']);
    expect(findInItems(joined, opts('alpha')).matches).toEqual([
      { item: 0, from: 0, to: 5 }, { item: 2, from: 5, to: 10 }, { item: 3, from: 0, to: 5 },
    ]);
    expect(findInItems(joined, opts('alpha', { caseSensitive: true })).matches).toHaveLength(2);
  });

  it('never lets a match run from one piece into the next', () => {
    const joined = joinItems(['ab', 'cd']);
    expect(findInItems(joined, opts('b\\sc', { regexp: true })).matches).toEqual([]);
    // An expression that would swallow the separator is cut at it: each piece still gets its own match.
    expect(findInItems(joined, opts('[^x]+', { regexp: true })).matches).toEqual([{ item: 0, from: 0, to: 2 }, { item: 1, from: 0, to: 2 }]);
    expect(findInItems(joinItems(['a b', 'c']), opts('b\\s*', { regexp: true })).matches).toEqual([{ item: 0, from: 2, to: 3 }]);
    // ^ and $ are the edges of each piece.
    expect(findInItems(joined, opts('^.', { regexp: true })).matches).toEqual([{ item: 0, from: 0, to: 1 }, { item: 1, from: 0, to: 1 }]);
    expect(findInItems(joined, opts('.$', { regexp: true })).matches).toEqual([{ item: 0, from: 1, to: 2 }, { item: 1, from: 1, to: 2 }]);
  });

  it('treats the piece boundary as the end of a word', () => {
    const joined = joinItems(['foo', 'foobar', 'bar foo']);
    expect(findInItems(joined, opts('foo', { wholeWord: true })).matches).toEqual([{ item: 0, from: 0, to: 3 }, { item: 2, from: 4, to: 7 }]);
  });

  it('reports invalid expressions and caps the count', () => {
    expect(findInItems(joinItems(['a']), opts('(', { regexp: true })).invalid).toBe(true);
    const many = joinItems(Array.from({ length: 50 }, () => 'x x'));
    const capped = findInItems(many, opts('x'), 10);
    expect(capped.matches).toHaveLength(10);
    expect(capped.capped).toBe(true);
    expect(findInItems(joinItems([]), opts('x')).matches).toEqual([]);
  });

  it('finds a value deep in a 50 000-row table quickly', () => {
    const columns = 4;
    const cells: string[] = [];
    for (let r = 0; r < 50_000; r++) for (let c = 0; c < columns; c++) cells.push(r === 39_999 && c === 2 ? 'needle-xyz' : `row ${r} col ${c}`);
    const started = performance.now();
    const found = findInItems(joinItems(cells), opts('needle-xyz'), DATA_FIND_LIMIT);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(found.matches).toEqual([{ item: 39_999 * columns + 2, from: 0, to: 10 }]);
    // Counted over the whole data, far beyond the editor's 1000.
    const all = findInItems(joinItems(cells), opts('row'), DATA_FIND_LIMIT);
    expect(all.matches.length).toBe(DATA_FIND_LIMIT);
    expect(all.capped).toBe(true);
  });

  it('keeps every row of a 50 000-row CSV in the table view, so find reaches row 40 000', () => {
    const lines = ['id,name'];
    for (let i = 1; i <= 50_000; i++) lines.push(`${i},${i === 40_000 ? 'needle' : `name ${i}`}`);
    const table = parseDelimited(lines.join('\n'), ',', TABLE_VIEW_ROWS);
    expect(table.truncated).toBe(false);
    const rows = table.rows.slice(1);
    const found = findInItems(joinItems(rows.flatMap((row) => row)), opts('needle'), DATA_FIND_LIMIT);
    expect(found.matches.map((m) => Math.floor(m.item / 2) + 1)).toEqual([40_000]);
  });

  it('steps to the matches of a piece and around the end', () => {
    const matches = [{ item: 1, from: 0, to: 1 }, { item: 1, from: 3, to: 4 }, { item: 4, from: 0, to: 1 }];
    expect(matchesOf(matches, 1)).toEqual([0, 2]);
    expect(matchesOf(matches, 2)).toEqual([2, 2]);
    expect(firstMatchFrom(matches, 0)).toBe(0);
    expect(firstMatchFrom(matches, 2)).toBe(2);
    expect(firstMatchFrom(matches, 5)).toBe(0);
    expect(lastMatchUpTo(matches, 3)).toBe(1);
    expect(lastMatchUpTo(matches, 0)).toBe(2);
    expect(firstMatchFrom([], 0)).toBeNull();
  });

  it('splits a line into plain and marked parts', () => {
    expect(markParts('one two one', [[0, 3], [8, 11]], 1)).toEqual([
      { text: 'one', mark: true, current: false }, { text: ' two ', mark: false, current: false }, { text: 'one', mark: true, current: true },
    ]);
    // Clipped to the drawn window.
    expect(markParts('abcdef', [[1, 4]], -1, 2, 5)).toEqual([{ text: 'cd', mark: true, current: false }, { text: 'e', mark: false, current: false }]);
    expect(markParts('abc', [])).toEqual([{ text: 'abc', mark: false, current: false }]);
  });

  it('moves the drawn window of a long line to the current match', () => {
    expect(lineWindow(100, 2000)).toEqual({ start: 0, end: 100 });
    expect(lineWindow(5000, 2000)).toEqual({ start: 0, end: 2000 });
    expect(lineWindow(5000, 2000, [100, 110])).toEqual({ start: 0, end: 2000 });
    const far = lineWindow(5000, 2000, [4000, 4010]);
    expect(far.start).toBeLessThanOrEqual(4000);
    expect(far.end).toBeGreaterThanOrEqual(4010);
    expect(far.end - far.start).toBe(2000);
  });
});

describe('find in a terminal', () => {
  const row = (text: string, wrapped = false, columns?: number[]): TerminalRow => ({ text, wrapped, ...(columns ? { columns } : {}) });

  it('finds matches per row with their cells', () => {
    const result = findInTerminal([row('$ npm test'), row('error: one'), row('ok'), row('Error two')], opts('error'));
    expect(result.matches.map((m) => m.spans)).toEqual([[{ row: 1, col: 0, width: 5 }], [{ row: 3, col: 0, width: 5 }]]);
  });

  it('joins soft-wrapped rows, so a match may cross the wrap', () => {
    const result = findInTerminal([row('hello wor'), row('ld again', true), row('world')], opts('world'));
    expect(result.matches).toEqual([
      { row: 0, col: 6, spans: [{ row: 0, col: 6, width: 3 }, { row: 1, col: 0, width: 2 }] },
      { row: 2, col: 0, spans: [{ row: 2, col: 0, width: 5 }] },
    ]);
    // Without the wrap the two rows are separate lines.
    expect(findInTerminal([row('hello wor'), row('ld again')], opts('world')).matches).toEqual([]);
  });

  it('maps wide characters to their cells', () => {
    // "日本 ok": each CJK character takes two cells.
    const result = findInTerminal([row('日本 ok', false, [0, 2, 4, 5, 6, 7])], opts('ok'));
    expect(result.matches[0].spans).toEqual([{ row: 0, col: 5, width: 2 }]);
    expect(findInTerminal([row('日本 ok', false, [0, 2, 4, 5, 6, 7])], opts('本')).matches[0].spans).toEqual([{ row: 0, col: 2, width: 2 }]);
  });

  it('over the cap keeps the matches nearest the bottom of the view, so the current one is the nearest', () => {
    // 3000 rows, "NEEDLE" on every 250th, an "N" on every row: "N" is capped, "NEE" is not.
    const rows = Array.from({ length: 3000 }, (_, i) => row(i % 250 === 249 ? `row ${i} NEEDLE` : `row ${i} N`));
    const capped = findInTerminal(rows, opts('N'), 1000);
    expect(capped.capped).toBe(true);
    expect(capped.matches).toHaveLength(1000);
    expect(capped.matches[999].row).toBe(2999);
    expect(capped.matches[0].row).toBe(2000);
    expect(terminalStartMatch(capped.matches, 2999)).toBe(999);
    const needle = findInTerminal(rows, opts('NEE'), 1000);
    expect(needle.matches).toHaveLength(12);
    expect(terminalStartMatch(needle.matches, 2999)).toBe(11);
    // A view higher up: the window holds the matches around it, newest at or above it first.
    const middle = findInTerminal(rows, opts('N'), 1000, 1500);
    expect(middle.matches).toHaveLength(1000);
    expect(middle.matches[0].row).toBe(1001);
    expect(middle.matches[999].row).toBe(2000);
    expect(middle.matches[terminalStartMatch(middle.matches, 1500)!].row).toBe(1500);
    // Near the end the window is shifted to keep 1000 matches.
    const late = findInTerminal(rows, opts('N'), 1000, 2900);
    expect(late.matches[0].row).toBe(2000);
    expect(late.matches[999].row).toBe(2999);
    // Near the top: the matches before the view plus the first ones after it.
    const early = findInTerminal(rows, opts('N'), 1000, 10);
    expect(early.matches[0].row).toBe(0);
    expect(early.matches[999].row).toBe(999);
  });

  it('starts at the newest match on screen and scrolls only when needed', () => {
    const matches = [10, 50, 90].map((r) => ({ row: r, col: 0, spans: [{ row: r, col: 0, width: 1 }] }));
    expect(terminalStartMatch(matches, 60)).toBe(1);
    expect(terminalStartMatch(matches, 5)).toBe(0);
    expect(terminalStartMatch(matches, 200)).toBe(2);
    expect(terminalStartMatch([], 10)).toBeNull();
    expect(terminalScrollFor(50, 40, 30, 1000)).toBeNull();
    expect(terminalScrollFor(500, 40, 30, 1000)).toBe(490);
    expect(terminalScrollFor(2, 40, 30, 1000)).toBe(0);
    expect(terminalScrollFor(1990, 0, 30, 1970)).toBe(1970);
  });
});

describe('the terminal find shortcut', () => {
  const ctx = (target: DispatchContext['target'], platform: 'win32' | 'darwin' = 'win32'): DispatchContext => ({
    resolution: resolveShortcuts({}, platform), languageChosen: true, recording: false, overlayOpen: false, paletteOpen: false,
    settingsActive: false, hasProject: true, hasTab: true, target,
  });
  const press = (extra: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>) => ({ code: 'KeyF', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra });

  it('is Ctrl+Shift+F (Cmd+Shift+F) and fires only in a terminal', () => {
    expect(decideShortcut(press({ ctrlKey: true, shiftKey: true }), ctx('terminal'))).toBe('terminal.find');
    expect(decideShortcut(press({ metaKey: true, shiftKey: true }), ctx('terminal', 'darwin'))).toBe('terminal.find');
    // Elsewhere the key stays with the editor or the field; plain Ctrl+F stays with the program in the terminal.
    expect(decideShortcut(press({ ctrlKey: true, shiftKey: true }), ctx('input'))).toBeNull();
    expect(decideShortcut(press({ ctrlKey: true, shiftKey: true }), ctx('other'))).toBeNull();
    expect(decideShortcut(press({ ctrlKey: true }), ctx('terminal'))).toBeNull();
  });

  it('can be moved to another key in the settings, but not to Ctrl+F', () => {
    const moved = resolveShortcuts({ 'terminal.find': 'Ctrl+Shift+J' }, 'win32');
    expect(moved.source['terminal.find']).toBe('custom');
    expect(decideShortcut(press({ code: 'KeyJ', ctrlKey: true, shiftKey: true }), { ...ctx('terminal'), resolution: moved })).toBe('terminal.find');
    expect(decideShortcut(press({ ctrlKey: true, shiftKey: true }), { ...ctx('terminal'), resolution: moved })).toBeNull();
    expect(resolveShortcuts({ 'terminal.find': 'Ctrl+F' }, 'win32').problems['terminal.find']?.kind).toBe('reserved');
  });
});
