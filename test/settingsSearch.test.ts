import { describe, expect, it } from 'vitest';
import { searchStem, searchText, settingsSearchMatches } from '../src/shared/settingsSearch';

describe('settings search', () => {
  it('ignores case, diacritics and extra spaces', () => {
    expect(searchText('  Powiadomienia   i DŹWIĘKI ')).toBe('powiadomienia i dzwieki');
    expect(searchText('Łącz ponownie')).toBe('lacz ponownie');
    expect(settingsSearchMatches('Godziny ciszy', 'GODZINY')).toBe(true);
    expect(settingsSearchMatches('Głośność', 'glosnosc')).toBe(true);
  });

  it('needs every word of the query, in any order', () => {
    expect(settingsSearchMatches('Historia przewijania terminala', 'terminal historia')).toBe(true);
    expect(settingsSearchMatches('Historia przewijania terminala', 'terminal czcionka')).toBe(false);
  });

  it('matches other forms of a word through its stem, at the start of a word', () => {
    expect(settingsSearchMatches('Otwiera paletę poleceń', 'paleta')).toBe(true);
    expect(settingsSearchMatches('Skróty klawiszowe', 'skrótów')).toBe(true);
    expect(settingsSearchMatches('Powiadomienie systemowe', 'powiadomienia')).toBe(true);
    expect(settingsSearchMatches('Dźwięk powiadomienia', 'dźwięki')).toBe(true);
    expect(searchStem('paleta')).toBe('palet');
    // a short word matches only as typed; a stem inside a word does not count
    expect(searchStem('ssh')).toBe('ssh');
    expect(settingsSearchMatches('Rozpaletowany', 'paleta')).toBe(false);
    expect(settingsSearchMatches('Kolor tła', 'kolory')).toBe(true);
    expect(settingsSearchMatches('Kolor tła', 'kolano')).toBe(false);
  });

  it('matches everything for an empty query', () => {
    expect(settingsSearchMatches('anything', '')).toBe(true);
    expect(settingsSearchMatches('anything', '   ')).toBe(true);
  });
});
