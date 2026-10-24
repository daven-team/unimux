import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore, strictFieldFilter, strictFuzzyScore } from '../src/shared/fuzzy';

describe('fuzzy', () => {
  it('ranks word-start matches higher', () => {
    expect(fuzzyScore('bd', 'bot-discord')!).toBeGreaterThan(fuzzyScore('bd', 'abcd')!);
  });

  it('returns null when not a subsequence', () => {
    expect(fuzzyScore('xyz', 'bot-discord')).toBeNull();
  });

  it('filter keeps order by score and returns all for empty query', () => {
    const items = ['opl-raport', 'bot-discord', 'MULTICODING'];
    expect(fuzzyFilter(items, '', (x) => x)).toEqual(items);
    expect(fuzzyFilter(items, 'mc', (x) => x)[0]).toBe('MULTICODING');
    expect(fuzzyFilter(items, 'bot', (x) => x)).toEqual(['bot-discord']);
  });
});

describe('strict fuzzy (command palette)', () => {
  it('drops scattered single letters that start no word', () => {
    expect(strictFuzzyScore('ust', 'Claude Dodaj komórkę do siatki')).toBeNull();
    expect(strictFuzzyScore('ust', 'Pokaż / ukryj snippety')).toBeNull();
    expect(strictFuzzyScore('ust', 'Skopiuj dziennik statusów')).toBeNull();
    expect(strictFuzzyScore('ust', 'Komórka: przesuń w dół')).toBeNull();
  });

  it('keeps prefixes, word-start initials and 3+ character runs inside words', () => {
    expect(strictFuzzyScore('ust', 'Ustawienia')).not.toBeNull();
    expect(strictFuzzyScore('nt', 'Nowy terminal (zakładka)')).not.toBeNull();
    expect(strictFuzzyScore('bd', 'bot-discord')).not.toBeNull();
    expect(strictFuzzyScore('gitst', 'git status')).not.toBeNull();
    expect(strictFuzzyScore('port', 'export data')).not.toBeNull();
    expect(strictFuzzyScore('MC', 'MultiCoding')).not.toBeNull();
    expect(strictFuzzyScore('xyz', 'bot-discord')).toBeNull();
  });

  it('finds the best split, not the first letters found', () => {
    // greedy would take the "s" of "zakładki" and then fail the word-start rule; the split at "Snippety" works
    expect(strictFuzzyScore('sn', 'Zakładki snippety')).not.toBeNull();
    expect(strictFuzzyScore('hip', 'Historia projektu')).not.toBeNull();
  });

  it('prefers prefixes over word starts over runs inside words', () => {
    const prefix = strictFuzzyScore('ust', 'Ustawienia')!;
    const wordStart = strictFuzzyScore('ust', 'Moje ustawienia')!;
    const inside = strictFuzzyScore('ust', 'Kapusta')!;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inside);
  });

  it('prefers contiguous runs over initials', () => {
    expect(strictFuzzyScore('not', 'Notatki: nowa')!).toBeGreaterThan(strictFuzzyScore('not', 'Nowy otwarty terminal')!);
  });

  it('ranks palette items by title first and drops the noise', () => {
    const items = [
      { title: 'Claude', kind: '+ agent', desc: 'Dodaj komórkę do siatki' },
      { title: 'Pokaż / ukryj snippety', kind: 'Akcja', desc: 'Ctrl+Shift+B' },
      { title: 'Ustawienia', kind: 'Akcja', desc: '' },
      { title: 'Projekt A', kind: 'Projekt', desc: 'C:\\ustawienia\\a' },
      { title: 'Skopiuj dziennik statusów', kind: 'Akcja', desc: '' },
    ];
    const got = strictFieldFilter(items, 'ust', (i) => [i.title, i.kind, i.desc]).map((i) => i.title);
    expect(got).toEqual(['Ustawienia', 'Projekt A']);
    expect(strictFieldFilter(items, '', (i) => [i.title])).toHaveLength(5);
    // a query of several words may span the title and the kind; a single word never does
    expect(strictFieldFilter(items, 'claude agent', (i) => [i.title, i.kind, i.desc]).map((i) => i.title)).toEqual(['Claude']);
    expect(strictFieldFilter([{ title: 'SFTP: połącz z hostem', kind: 'Akcja', desc: '' }], 'zak', (i) => [i.title, i.kind, i.desc])).toEqual([]);
  });
});
