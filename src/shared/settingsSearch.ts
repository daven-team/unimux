// The search box of Settings (1.0.7): a row matches when every word of the query appears in its text, ignoring case and
// diacritics ("dzwiek" finds "dźwięk", "ł" counts as "l"). Polish (and other) word forms meet at their stem: a word of five
// letters or more also matches a word of the text starting with it minus its ending ("paleta" finds "paletę", "skrótów"
// finds "skróty").

/** Lower case, without diacritics and with single spaces: the form both sides are compared in. */
export function searchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Endings of inflected words (in the folded form, longest first): Polish cases and plurals, and the common English ones. */
const ENDINGS = ['ami', 'ach', 'owi', 'iem', 'ow', 'om', 'em', 'ie', 'ia', 'ii', 'es', 'a', 'e', 'i', 'o', 'u', 'y', 's'];
/** The stem keeps at least this many letters, so short words ("ssh", "git", "tab") only match as they are. */
const STEM_MIN = 4;

/** The folded word without its inflection ending; the word itself when it is too short to have one. */
export function searchStem(word: string): string {
  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= STEM_MIN) return word.slice(0, -ending.length);
  }
  return word;
}

const startsWord = (haystack: string, at: number) => at === 0 || !/[\p{L}\p{N}]/u.test(haystack[at - 1]);

/** One folded query word in the folded text: anywhere as typed, or its stem at the start of a word. */
function wordMatches(haystack: string, word: string): boolean {
  if (haystack.includes(word)) return true;
  const stem = searchStem(word);
  if (stem === word) return false;
  for (let at = haystack.indexOf(stem); at >= 0; at = haystack.indexOf(stem, at + 1)) if (startsWord(haystack, at)) return true;
  return false;
}

/** Every word of the query is somewhere in the text; an empty query matches everything. */
export function settingsSearchMatches(text: string, query: string): boolean {
  const words = searchText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const haystack = searchText(text);
  return words.every((word) => wordMatches(haystack, word));
}
