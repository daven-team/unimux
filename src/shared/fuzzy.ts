// Small subsequence fuzzy matcher for the command palette.

const isBoundary = (text: string, i: number) => i === 0 || /[\s\-_/\\.:]/.test(text[i - 1]) ||
  (text[i] >= 'A' && text[i] <= 'Z' && text[i - 1] >= 'a' && text[i - 1] <= 'z');

/** Higher is better; null when `query` is not a subsequence of `text`. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += 1;
    if (found === prev + 1) score += 3;
    if (isBoundary(text, found)) score += 4;
    if (found === 0) score += 2;
    score -= Math.min(3, (found - ti) * 0.1);
    prev = found;
    ti = found + 1;
  }
  return score - text.length * 0.01;
}

// ── strict matching (command palette) ───────────────────────────────────────
// The query is matched as runs of contiguous characters; every run has to start at a word start or be 3+ characters
// long, so "ust" finds "Ustawienia" or "kapusta" but not the scattered u…s…t of "Claude · Dodaj komórkę do siatki".
// The best split is searched (not the first characters found): word starts, long runs and few runs score higher.

const MAX_STRICT_TEXT = 240;

/** Higher is better; null when the query only matches as weak scattered characters. */
export function strictFuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const src = text.length > MAX_STRICT_TEXT ? text.slice(0, MAX_STRICT_TEXT) : text;
  const t = src.toLowerCase();
  if (t.length !== src.length) return fuzzyScore(query, text); // a case mapping that changes lengths: no reliable positions
  const memo = new Map<number, number | null>();
  // best(qi, ti): the best score of matching q[qi..] in t[ti..], the next run starting at ti or later.
  const best = (qi: number, ti: number): number | null => {
    if (qi === q.length) return 0;
    const key = qi * (t.length + 1) + ti;
    if (memo.has(key)) return memo.get(key)!;
    let top: number | null = null;
    for (let j = t.indexOf(q[qi], ti); j >= 0; j = t.indexOf(q[qi], j + 1)) {
      let run = 0;
      while (qi + run < q.length && j + run < t.length && t[j + run] === q[qi + run]) run++;
      const boundary = isBoundary(src, j);
      for (let len = run; len >= 1; len--) {
        if (!boundary && len < 3) break;
        const rest = best(qi + len, j + len);
        if (rest === null) continue;
        // 2 per character, 3 per contiguous pair, a word start 6 for the first run and 3 for later ones, 3 more for the
        // very start, -3 per run, earlier is better: "not" in "Notatki" beats the initials of "Nowy otwarty terminal".
        const own = len * 2 + (len - 1) * 3 + (boundary ? (qi === 0 ? 6 : 3) : 0) + (j === 0 ? 3 : 0) - 3 - j * 0.02;
        if (top === null || own + rest > top) top = own + rest;
      }
    }
    memo.set(key, top);
    return top;
  };
  const score = best(0, 0);
  return score === null ? null : score - text.length * 0.01;
}

/**
 * Strict matching over several fields, the first ones weighing more (the palette: title, then kind and description), so
 * "ust" lists "Ustawienia" before an item that only mentions it in its description. A query of several words may also
 * span the fields ("claude agent"); one word never does, so "zak" does not take a "z" from a title and "ak" from "Akcja".
 */
export function strictFieldFilter<T>(items: T[], query: string, getFields: (item: T) => string[], limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const words = /\s/.test(query.trim());
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const fields = getFields(item).filter(Boolean);
    let top: number | null = null;
    for (let i = 0; i < fields.length; i++) {
      const s = strictFuzzyScore(query, fields[i]);
      if (s !== null && (top === null || s - i * 4 > top)) top = s - i * 4;
    }
    if (top === null && words && fields.length > 1) {
      const s = strictFuzzyScore(query, fields.join(' '));
      if (s !== null) top = s - fields.length * 4;
    }
    if (top !== null) scored.push({ item, score: top });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.item);
}

/** `strict` drops weak scattered matches (see strictFuzzyScore); by default every subsequence matches. */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string, limit = 50, strict = false): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const score = strict ? strictFuzzyScore : fuzzyScore;
  return items
    .map((item) => ({ item, score: score(query, getText(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
