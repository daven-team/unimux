// Suggestions of the SSH command autocomplete: matching (prefix first, then fuzzy), the fish-style ghost text, the keys
// that insert a suggestion, the popup's key handling and what each piece of terminal input means for the followed line.
// Pure, so every rule is unit tested (test/ssh-autocomplete.test.ts).
import { fuzzyScore } from './fuzzy';

export type SuggestionKind = 'history' | 'snippet';

export interface SuggestSource {
  text: string;
  kind: SuggestionKind;
  /** Rank among equal matches (history: frecency; snippets: a fixed weight). */
  weight: number;
  /** A snippet's name. */
  label?: string;
}

export interface Suggestion {
  text: string;
  kind: SuggestionKind;
  label?: string;
  /** Matched parts of `text` ([start, end) in UTF-16 units), shown highlighted. */
  ranges: Array<[number, number]>;
  /** `text` starts with what was typed (the ghost text and → can complete it). */
  prefix: boolean;
}

/** Items the popup shows at most. */
export const SUGGESTION_LIMIT = 8;

/** The characters of `text` the fuzzy matcher (fuzzy.ts) takes for `query`, merged into ranges; null when it does not match. */
export function fuzzyRanges(query: string, text: string): Array<[number, number]> | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (t.length !== text.length) return null; // a case mapping that changes lengths: no reliable positions
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, from);
    if (found < 0) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + ch.length;
    else ranges.push([found, found + ch.length]);
    from = found + ch.length;
  }
  return ranges;
}

/**
 * Matches the typed command line against history and snippets: prefix matches first (best ranked first), then fuzzy ones
 * (two typed characters at least), without duplicates and without the line itself.
 */
export function suggestCommands(typed: string, sources: readonly SuggestSource[], limit = SUGGESTION_LIMIT): Suggestion[] {
  const query = typed.replace(/^\s+/, '');
  if (!query.trim()) return [];
  const seen = new Set<string>([query.trimEnd()]);
  const prefix: Array<{ s: SuggestSource; rank: number }> = [];
  const fuzzy: Array<{ s: SuggestSource; rank: number; ranges: Array<[number, number]> }> = [];
  for (const s of sources) {
    if (s.text.startsWith(query)) { if (s.text !== query) prefix.push({ s, rank: s.weight }); continue; }
    if (query.trim().length < 2) continue;
    const score = fuzzyScore(query, s.text);
    const ranges = score === null ? null : fuzzyRanges(query, s.text);
    // The weight only orders matches of a similar quality.
    if (ranges) fuzzy.push({ s, rank: score! + Math.min(2, Math.log2(1 + s.weight)), ranges });
  }
  prefix.sort((a, b) => b.rank - a.rank);
  fuzzy.sort((a, b) => b.rank - a.rank);
  const out: Suggestion[] = [];
  const add = (s: SuggestSource, ranges: Array<[number, number]>, isPrefix: boolean) => {
    if (out.length >= limit || seen.has(s.text)) return;
    seen.add(s.text);
    out.push({ text: s.text, kind: s.kind, ...(s.label ? { label: s.label } : {}), ranges, prefix: isPrefix });
  };
  for (const { s } of prefix) add(s, [[0, query.length]], true);
  for (const { s, ranges } of fuzzy) add(s, ranges, false);
  return out;
}

/** What the ghost text shows after the cursor: the rest of a suggestion that starts with the typed line. */
export function ghostText(typed: string, suggestion: Suggestion | undefined): string {
  if (!suggestion) return '';
  const lead = /^\s*/.exec(typed)![0];
  const target = lead + suggestion.text;
  return target.startsWith(typed) && target.length > typed.length ? target.slice(typed.length) : '';
}

/**
 * The input that turns the typed line into `target`: backspaces (DEL) for the characters after the common start, then the
 * rest of `target`. A completion of the typed text sends only the missing part.
 */
export function completionKeys(typed: string, target: string): string {
  const a = Array.from(typed);
  const b = Array.from(target);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return '\x7f'.repeat(a.length - common) + b.slice(common).join('');
}

// ── keys while the popup shows ───────────────────────────────────────────────

export interface KeyLike { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean }

export interface PopupKeyState {
  /** The item chosen with the arrows; -1 = none yet (the keys still belong to the shell). */
  selected: number;
  count: number;
  /** Ghost text is drawn after the cursor. */
  ghost: boolean;
}

export type PopupKeyAction =
  | { kind: 'pass'; hide: boolean }
  | { kind: 'select'; index: number }
  | { kind: 'accept'; index: number }
  | { kind: 'close' };

const PASS: PopupKeyAction = { kind: 'pass', hide: false };
const PASS_HIDE: PopupKeyAction = { kind: 'pass', hide: true };

/** A modifier pressed on its own (AltGr comes as Ctrl+Alt with key AltGraph on Windows): the popup stays as it is. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Meta', 'Shift', 'CapsLock', 'OS', 'Fn']);

/**
 * A keydown while the popup is open. The shell keeps every key unless the popup is engaged: ↓ enters and walks the list, ↑
 * walks back (and leaves it from the first item) only once the list was entered, Enter inserts the chosen item (without
 * running it), → inserts the ghost text or the chosen item, Esc closes the popup. Tab, ↑ outside the list and keys with
 * modifiers go to the shell and close the popup; typing goes to the shell and keeps it.
 */
export function popupKey(ev: KeyLike, st: PopupKeyState): PopupKeyAction {
  if (ev.isComposing || !st.count || MODIFIER_KEYS.has(ev.key)) return PASS;
  // AltGr (Ctrl+Alt on Windows) types a character, like Polish letters do.
  if (ev.ctrlKey && ev.altKey && !ev.metaKey && [...ev.key].length === 1) return PASS;
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return PASS_HIDE;
  switch (ev.key) {
    case 'ArrowDown':
      if (ev.shiftKey) return PASS_HIDE;
      return { kind: 'select', index: Math.min(st.count - 1, st.selected + 1) };
    case 'ArrowUp':
      if (ev.shiftKey || st.selected < 0) return PASS_HIDE;
      return { kind: 'select', index: st.selected - 1 };
    case 'Enter':
      return st.selected >= 0 && !ev.shiftKey ? { kind: 'accept', index: st.selected } : PASS_HIDE;
    case 'ArrowRight':
      if (ev.shiftKey) return PASS_HIDE;
      return st.selected >= 0 || st.ghost ? { kind: 'accept', index: Math.max(0, st.selected) } : PASS_HIDE;
    case 'Escape':
      return { kind: 'close' };
    case 'Tab': case 'ArrowLeft': case 'Home': case 'End': case 'PageUp': case 'PageDown': case 'Insert':
      return PASS_HIDE;
    default:
      return PASS;
  }
}

// ── terminal input ───────────────────────────────────────────────────────────

/**
 * What a piece of user input (xterm onData) does to the command line: `submit` Enter, `abort` the shell starts a fresh line
 * (Ctrl+C, a paste that ends with a newline), `lose` the line can no longer be followed until the next Enter (the shell's
 * history search with Ctrl+R / Ctrl+S, a paste with a newline inside), `text` typed or pasted characters, `erase` backspace
 * and friends, `complete` Tab, `recall` the shell's history (↑ / ↓), `move` the cursor moves, `other` anything else.
 */
export type InputKind = 'submit' | 'abort' | 'lose' | 'text' | 'erase' | 'complete' | 'recall' | 'move' | 'other';

const ERASE = new Set(['\x7f', '\b', '\x1b[3~', '\x04', '\x17', '\x15', '\x0b', '\x1b\x7f', '\x1b\b', '\x1bd']);
const RECALL = new Set(['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB', '\x10', '\x0e']);
const MOVE = /^(?:\x1b(?:\[(?:1;\d+)?[CDHF]|O[CDHF]|\[[1478]~|[bf])|[\x01\x02\x05\x06])$/;
const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

export function classifyInput(data: string): InputKind {
  // Enter, Ctrl+J and keypad Enter in application keypad mode.
  if (data === '\r' || data === '\n' || data === '\x1bOM') return 'submit';
  if (data === '\x03') return 'abort';
  if (data === '\x12' || data === '\x13') return 'lose';
  if (data === '\t') return 'complete';
  if (ERASE.has(data)) return 'erase';
  if (RECALL.has(data)) return 'recall';
  if (MOVE.test(data)) return 'move';
  const text = PASTE.exec(data)?.[1] ?? data;
  if (/[\r\n]/.test(text)) return /[\r\n]\s*$/.test(text) ? 'abort' : 'lose';
  return text && !/[\u0000-\u001f\u007f]/.test(text) ? 'text' : 'other';
}

/**
 * The typed line (`typed`, the cursor at its end) once the shell echoed `data`: typed or pasted text is added, a backspace
 * takes the last character. Null when that cannot be foreseen (word erase, Tab, the shell's history, cursor keys) or when
 * the line before was not known either.
 */
export function predictLine(typed: string | null, data: string): string | null {
  if (typed === null) return null;
  if (data === '\x7f' || data === '\b') return Array.from(typed).slice(0, -1).join('');
  return classifyInput(data) === 'text' ? typed + (PASTE.exec(data)?.[1] ?? data) : null;
}
