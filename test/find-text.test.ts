import { describe, expect, it } from 'vitest';
import { findCounter, findKey, findMatches, joinSegments, locateOffset, matchAtOrAfter, stepMatch, type FindOptions } from '../src/shared/findText';
import { translate } from '../src/shared/i18n';

const opts = (query: string, extra: Partial<FindOptions> = {}): FindOptions => ({ query, caseSensitive: false, wholeWord: false, regexp: false, ...extra });

describe('find in one file', () => {
  it('finds a plain query literally, case-insensitive by default', () => {
    expect(findMatches('Foo foo FOO', opts('foo')).matches).toEqual([[0, 3], [4, 7], [8, 11]]);
    expect(findMatches('Foo foo FOO', opts('foo', { caseSensitive: true })).matches).toEqual([[4, 7]]);
    // Regexp characters and "\n" are literal without the regexp toggle.
    expect(findMatches('a.b axb a\\nb', opts('a.b')).matches).toEqual([[0, 3]]);
    expect(findMatches('a\\nb a\nb', opts('a\\nb')).matches).toEqual([[0, 4]]);
    expect(findMatches('anything', opts('')).matches).toEqual([]);
  });

  it('keeps the offsets of the original text when case folding', () => {
    expect(findMatches('ZAŻÓŁĆ gęślą', opts('żółć')).matches).toEqual([[2, 6]]);
    expect(findMatches('Straße', opts('STRASSE')).matches).toEqual([]);
  });

  it('matches whole words in any script and retries after a rejected match', () => {
    expect(findMatches('foofoo foo', opts('foo', { wholeWord: true })).matches).toEqual([[7, 10]]);
    expect(findMatches('zażółć żół', opts('żół', { wholeWord: true })).matches).toEqual([[7, 10]]);
    expect(findMatches('a_b ab', opts('ab', { wholeWord: true })).matches).toEqual([[4, 6]]);
  });

  it('runs regular expressions, skips empty matches and reports invalid ones', () => {
    expect(findMatches('a1 b22 c333', opts('\\d+', { regexp: true })).matches).toEqual([[1, 2], [4, 6], [8, 11]]);
    expect(findMatches('one\ntwo', opts('^\\w', { regexp: true })).matches).toEqual([[0, 1], [4, 5]]);
    expect(findMatches('abc', opts('x*', { regexp: true })).matches).toEqual([]);
    expect(findMatches('abc', opts('(', { regexp: true }))).toEqual({ matches: [], invalid: true, capped: false });
    // A pattern that is valid only without the u flag still works.
    expect(findMatches('a-b', opts('\\-', { regexp: true })).matches).toEqual([[1, 2]]);
  });

  it('stops at the limit and says so', () => {
    const result = findMatches('x'.repeat(20), opts('x'), 5);
    expect(result.matches).toHaveLength(5);
    expect(result.capped).toBe(true);
    expect(findMatches('xxxxx', opts('x'), 5).capped).toBe(false);
  });

  it('steps through matches with wrap-around', () => {
    expect(stepMatch(null, 3, 1)).toBe(0);
    expect(stepMatch(null, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(1, 0, 1)).toBeNull();
    expect(matchAtOrAfter([[2, 3], [5, 6], [9, 10]], 4)).toBe(1);
    expect(matchAtOrAfter([[2, 3], [5, 6]], 5)).toBe(1);
    expect(matchAtOrAfter([[2, 3], [5, 6]], 7)).toBe(0);
    expect(matchAtOrAfter([], 0)).toBeNull();
  });

  it('formats the counter in every language', () => {
    expect(findCounter({ query: '', current: null, total: 0 })).toBeNull();
    const counter = findCounter({ query: 'a', current: 2, total: 12 })!;
    expect(translate('pl', counter.key, counter.params)).toBe('3 z 12');
    expect(translate('en', counter.key, counter.params)).toBe('3 of 12');
    const unknown = findCounter({ query: 'a', current: null, total: 4 })!;
    expect(translate('de', unknown.key, unknown.params)).toBe('? von 4');
    const capped = findCounter({ query: 'a', current: 0, total: 1000, capped: true }, (n) => n.toLocaleString('pl'))!;
    expect(translate('en', capped.key, capped.params)).toBe('1 of 1000+');
    const none = findCounter({ query: 'a', current: null, total: 0 })!;
    expect(none.empty).toBe(true);
    expect(translate('pl', none.key)).toBe('Brak wyników');
    expect(translate('en', findCounter({ query: '(', current: null, total: 0, invalid: true })!.key)).toBe('Invalid expression');
  });

  it('joins rendered text pieces with block separators and maps offsets back', () => {
    const segments = [{ text: 'Title', block: true }, { text: 'Some ', block: true }, { text: 'bold', block: false }, { text: ' text', block: false }];
    const { text, starts } = joinSegments(segments);
    expect(text).toBe('Title\nSome bold text');
    expect(starts).toEqual([0, 6, 11, 15]);
    const lengths = segments.map((s) => s.text.length);
    // "Title" + "Some" never match across the block boundary.
    expect(findMatches(text, opts('TitleSome')).matches).toEqual([]);
    // "me bo" spans two pieces of one paragraph.
    const [[from, to]] = findMatches(text, opts('me bo')).matches;
    expect(locateOffset(starts, lengths, from)).toEqual({ segment: 1, offset: 2 });
    expect(locateOffset(starts, lengths, to, true)).toEqual({ segment: 2, offset: 2 });
    // The end of a piece stays in it; a start on the separator moves to the next piece.
    expect(locateOffset(starts, lengths, 15, true)).toEqual({ segment: 2, offset: 4 });
    expect(locateOffset(starts, lengths, 15)).toEqual({ segment: 3, offset: 0 });
    expect(locateOffset(starts, lengths, 5)).toEqual({ segment: 1, offset: 0 });
    expect(locateOffset([], [], 0)).toBeNull();
  });
});

describe('find keys', () => {
  const key = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  it('opens find and replace with the platform keys only', () => {
    expect(findKey(key('KeyF', { ctrlKey: true }), 'win32')).toBe('find');
    expect(findKey(key('KeyH', { ctrlKey: true }), 'win32')).toBe('replace');
    // AltGr+F, Ctrl+Shift+F and the Windows key are not find.
    expect(findKey(key('KeyF', { ctrlKey: true, altKey: true }), 'win32')).toBeNull();
    expect(findKey(key('KeyF', { ctrlKey: true, shiftKey: true }), 'win32')).toBeNull();
    expect(findKey(key('KeyF', { metaKey: true }), 'win32')).toBeNull();
    expect(findKey(key('KeyF', { metaKey: true }), 'darwin')).toBe('find');
    expect(findKey(key('KeyF', { metaKey: true, altKey: true }), 'darwin')).toBe('replace');
    expect(findKey(key('KeyH', { metaKey: true }), 'darwin')).toBeNull();
    expect(findKey(key('KeyF', { ctrlKey: true }), 'darwin')).toBeNull();
    expect(findKey(key('KeyG', { ctrlKey: true }), 'linux')).toBeNull();
  });
});
