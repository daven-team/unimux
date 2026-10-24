import { describe, expect, it } from 'vitest';
import { searchText, settingsSearchMatches } from '../src/shared/settingsSearch';

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

  it('matches everything for an empty query', () => {
    expect(settingsSearchMatches('anything', '')).toBe(true);
    expect(settingsSearchMatches('anything', '   ')).toBe(true);
  });
});
