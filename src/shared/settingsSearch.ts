// The search box of Settings (1.0.7): a row matches when every word of the query appears in its text, ignoring case and
// diacritics ("dzwiek" finds "dźwięk", "ł" counts as "l").

/** Lower case, without diacritics and with single spaces: the form both sides are compared in. */
export function searchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Every word of the query is somewhere in the text; an empty query matches everything. */
export function settingsSearchMatches(text: string, query: string): boolean {
  const words = searchText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const haystack = searchText(text);
  return words.every((word) => haystack.includes(word));
}
