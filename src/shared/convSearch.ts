// Search across every Claude Code and Codex conversation (1.0.9): the index document of one transcript, the query, and the
// pure matching that turns a query into conversations with highlighted snippets. The index itself is built in a worker
// thread (src/convsearch); this file has no imports so the worker, main and the renderer can all use it.

export type ConvCli = 'claude' | 'codex';
export type ConvRole = 'user' | 'assistant';

/** Separator between the messages of a document (never typed by anyone, so no term matches across two messages). */
export const MESSAGE_SEP = '\u0000';

/** One indexed transcript. `text` holds every message joined with MESSAGE_SEP; `folded` is the same text folded for matching. */
export interface ConvDoc {
  cli: ConvCli;
  id: string;
  cwd: string;
  /** The /rename title, a generated one, or the first prompt (clipped). */
  title: string;
  startedAt: number;
  updatedAt: number;
  model?: string;
  file: string;
  text: string;
  folded: string;
  /** Start of each message in `text`. */
  starts: number[];
  /** 'u' or 'a' per message. */
  roles: string;
  /** Time of each message (0 when the line had none). */
  times: number[];
  /** The text reached the per-conversation cap: later messages are not indexed. */
  capped: boolean;
}

export interface ConvQuery {
  text: string;
  cli?: ConvCli | 'all';
  /** A normalized cwd (see normalizeFolder): only conversations held in this folder. */
  project?: string;
  role?: ConvRole | 'all';
  /** Inclusive range of the conversation's activity, in ms. */
  from?: number;
  to?: number;
  limit?: number;
}

export interface ConvSnippet {
  /** Index of the message in the conversation (the transcript preview scrolls to it). */
  index: number;
  role: ConvRole;
  ts: number;
  text: string;
  /** Highlighted ranges of `text`. */
  marks: Array<[number, number]>;
  /** The snippet starts / ends inside the message. */
  before: boolean;
  after: boolean;
}

export interface ConvHit {
  cli: ConvCli;
  id: string;
  cwd: string;
  title: string;
  titleMarks: Array<[number, number]>;
  startedAt: number;
  updatedAt: number;
  model?: string;
  file: string;
  messages: number;
  /** Messages that contain at least one term. */
  hits: number;
  snippets: ConvSnippet[];
}

export interface ConvProject { cwd: string; key: string; count: number; updatedAt: number }

export interface ConvSearchResult {
  hits: ConvHit[];
  /** Conversations that matched (hits holds at most `limit` of them). */
  total: number;
  /** Conversations in the index. */
  conversations: number;
  /** Folders with conversations, newest first (the project filter). */
  projects: ConvProject[];
  /** A pass over the transcript folders is running: how many changed files it has read of how many. */
  indexing: { done: number; total: number } | null;
  tookMs: number;
  error?: string;
}

export interface ConvTranscriptMessage { role: ConvRole; text: string; ts: number; cut: boolean }
export interface ConvTranscript { ok: boolean; messages: ConvTranscriptMessage[]; capped: boolean; error?: string }

/** Limits of the index (the transcript preview reads the file again with its own, larger ones). */
export const INDEX_LIMITS = { messageChars: 4000, docChars: 600_000 };
export const TRANSCRIPT_LIMITS = { messageChars: 40_000, docChars: 4_000_000 };

// ── folding ─────────────────────────────────────────────────────────────────

const foldCache = new Map<string, string>();
const SPECIAL: Record<string, string> = { 'ł': 'l', 'đ': 'd', 'ø': 'o', 'ß': 's', 'æ': 'a', 'œ': 'o', 'ı': 'i' };

function foldNonAscii(c: string): string {
  let hit = foldCache.get(c);
  if (hit !== undefined) return hit;
  const lower = c.toLowerCase();
  const one = lower.length === 1 ? lower : c;
  // Only Latin, Greek and Cyrillic letters lose their marks (Hangul and others decompose into parts that are not letters).
  hit = SPECIAL[one] ?? (one.charCodeAt(0) < 0x0530 || (one.charCodeAt(0) >= 0x1e00 && one.charCodeAt(0) < 0x1f00) ? one.normalize('NFD')[0] ?? one : one);
  if (hit.length !== 1) hit = one;
  const lowerHit = hit.toLowerCase();
  if (lowerHit.length === 1) hit = lowerHit;
  foldCache.set(c, hit);
  return hit;
}

/**
 * Case and diacritics folded text of the same length as `s` (so a match position is also a position in `s`):
 * "Zażółć" and "zazolc" fold to the same string.
 */
export function fold(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return /[^\x00-\x7f]/.test(lower) ? lower.replace(/[^\x00-\x7f]/g, foldNonAscii) : lower;
  // A character whose lower case is longer (U+0130): one unit at a time.
  let out = '';
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i) < 128 ? s[i].toLowerCase() : foldNonAscii(s[i]);
  return out;
}

/** A folder as the filter compares it: forward slashes, no trailing slash, case-insensitive on Windows and macOS. */
export function normalizeFolder(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ── query ───────────────────────────────────────────────────────────────────

export const MAX_TERMS = 8;

/** Words and "quoted phrases" of a query, folded; duplicates and terms inside a longer one dropped. */
export function parseTerms(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const term = fold((m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim());
    if (term) out.push(term);
  }
  const unique = [...new Set(out)];
  return unique.filter((t) => !unique.some((o) => o !== t && o.includes(t))).slice(0, MAX_TERMS);
}

/** Index of the message holding text offset `pos` (binary search over the starts). */
export function messageAt(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const messageEnd = (doc: ConvDoc, i: number) => (i + 1 < doc.starts.length ? doc.starts[i + 1] - 1 : doc.text.length);

/** Occurrences counted per term at most (a term found in every line of a huge log must not slow the search down). */
const MAX_OCCURRENCES = 400;
const SNIPPETS = 3;
const SNIPPET_BEFORE = 70;
const SNIPPET_AFTER = 170;

function rangesIn(folded: string, terms: string[], from: number, to: number): Array<[number, number]> {
  const marks: Array<[number, number]> = [];
  for (const t of terms) {
    let p = folded.indexOf(t, from);
    while (p >= 0 && p + t.length <= to) {
      marks.push([p - from, p - from + t.length]);
      p = folded.indexOf(t, p + t.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // Overlapping marks merged.
  const out: Array<[number, number]> = [];
  for (const r of marks) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Highlighted ranges of every term in `text` (the transcript preview), at most `max`. */
export function markText(text: string, terms: string[], max = 1000): Array<[number, number]> {
  if (!terms.length || !text) return [];
  return rangesIn(fold(text), terms, 0, text.length).slice(0, max);
}

/** The part of a message around offset `at` (absolute in doc.text), cut at whitespace, with every term marked. */
export function snippetOf(doc: ConvDoc, index: number, at: number, terms: string[]): ConvSnippet {
  const start = doc.starts[index];
  const end = messageEnd(doc, index);
  let from = Math.max(start, at - SNIPPET_BEFORE);
  let to = Math.min(end, at + SNIPPET_AFTER);
  if (from > start) { const ws = doc.text.indexOf(' ', from); if (ws >= 0 && ws < at) from = ws + 1; }
  if (to < end) { const ws = doc.text.lastIndexOf(' ', to); if (ws > at) to = ws; }
  const raw = doc.text.slice(from, to);
  // Whitespace runs collapse to one space: marks are mapped through the same walk.
  const marks = rangesIn(doc.folded, terms, from, to);
  let text = '';
  const map: number[] = new Array(raw.length + 1);
  let space = false;
  for (let i = 0; i < raw.length; i++) {
    map[i] = text.length;
    const c = raw[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      if (!space) text += ' ';
      space = true;
    } else { text += c; space = false; }
  }
  map[raw.length] = text.length;
  return {
    index,
    role: doc.roles[index] === 'a' ? 'assistant' : 'user',
    ts: doc.times[index] ?? 0,
    text,
    marks: marks.map(([a, b]) => [map[a], map[b]] as [number, number]).filter(([a, b]) => b > a),
    before: from > start,
    after: to < end,
  };
}

interface DocMatch { hits: number; snippets: ConvSnippet[]; titleMarks: Array<[number, number]> }

/** Does the conversation hold every term (in its title or messages of the wanted role), and where. */
export function matchDoc(doc: ConvDoc, terms: string[], role: ConvRole | 'all' = 'all'): DocMatch | null {
  const titleFolded = fold(doc.title);
  const titleMarks = rangesIn(titleFolded, terms, 0, titleFolded.length);
  const wanted = role === 'all' ? null : role === 'user' ? 'u' : 'a';
  // Per message: which terms it holds and the first offset of one.
  const found = new Map<number, { mask: number; first: number }>();
  for (let ti = 0; ti < terms.length; ti++) {
    const t = terms[ti];
    let p = doc.folded.indexOf(t);
    let seen = 0;
    let any = false;
    while (p >= 0 && seen < MAX_OCCURRENCES) {
      const i = messageAt(doc.starts, p);
      if (!wanted || doc.roles[i] === wanted) {
        any = true;
        const f = found.get(i);
        if (f) f.mask |= 1 << ti; else found.set(i, { mask: 1 << ti, first: p });
      }
      seen++;
      // The rest of this message holds nothing new for this term.
      p = doc.folded.indexOf(t, Math.max(p + t.length, messageEnd(doc, i)));
    }
    if (!any && !titleFolded.includes(t)) return null;
  }
  const bits = (n: number) => { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };
  const best = [...found.entries()].sort((a, b) => bits(b[1].mask) - bits(a[1].mask) || a[0] - b[0]).slice(0, SNIPPETS);
  best.sort((a, b) => a[0] - b[0]);
  return { hits: found.size, titleMarks, snippets: best.map(([i, f]) => snippetOf(doc, i, f.first, terms)) };
}

export const DEFAULT_LIMIT = 120;

/** Runs a query over the documents: matching conversations newest first, the project list, and how many matched. */
export function searchDocs(docs: Iterable<ConvDoc>, query: ConvQuery): Omit<ConvSearchResult, 'indexing' | 'tookMs'> {
  const terms = parseTerms(query.text);
  const limit = query.limit ?? DEFAULT_LIMIT;
  const projects = new Map<string, ConvProject>();
  const matched: Array<{ doc: ConvDoc; m: DocMatch | null }> = [];
  let conversations = 0;
  for (const doc of docs) {
    conversations++;
    const key = normalizeFolder(doc.cwd);
    const p = projects.get(key);
    if (p) { p.count++; if (doc.updatedAt > p.updatedAt) { p.updatedAt = doc.updatedAt; p.cwd = doc.cwd; } }
    else projects.set(key, { cwd: doc.cwd, key, count: 1, updatedAt: doc.updatedAt });
    if (query.cli && query.cli !== 'all' && doc.cli !== query.cli) continue;
    if (query.project && key !== query.project) continue;
    if (query.from !== undefined && doc.updatedAt < query.from) continue;
    if (query.to !== undefined && doc.startedAt > query.to) continue;
    if (!terms.length) { matched.push({ doc, m: null }); continue; }
    const m = matchDoc(doc, terms, query.role ?? 'all');
    if (m) matched.push({ doc, m });
  }
  matched.sort((a, b) => b.doc.updatedAt - a.doc.updatedAt || (a.doc.id < b.doc.id ? -1 : 1));
  const hits: ConvHit[] = matched.slice(0, limit).map(({ doc, m }) => ({
    cli: doc.cli, id: doc.id, cwd: doc.cwd, title: doc.title, titleMarks: m?.titleMarks ?? [], startedAt: doc.startedAt,
    updatedAt: doc.updatedAt, ...(doc.model ? { model: doc.model } : {}), file: doc.file, messages: doc.starts.length,
    hits: m?.hits ?? 0, snippets: m?.snippets ?? [],
  }));
  return { hits, total: matched.length, conversations, projects: [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
}

// ── resume target ───────────────────────────────────────────────────────────

export interface FolderProject { id: string; path: string; worktrees: Array<{ path: string; branch: string }> }

const parentAndName = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return { parent: cut < 0 ? '' : trimmed.slice(0, cut), name: trimmed.slice(cut + 1) };
};

/**
 * The project a conversation folder belongs to: the project folder itself, or one of its worktrees (a known one, or a
 * `<project>-wt-<name>` sibling the way unimux names them). Null when no project holds it.
 */
export function folderOwner(projects: FolderProject[], cwd: string): { projectId: string; worktree?: { path: string; label: string; branch?: string } } | null {
  const key = normalizeFolder(cwd);
  if (!key) return null;
  const own = projects.find((p) => normalizeFolder(p.path) === key);
  if (own) return { projectId: own.id };
  for (const p of projects) {
    const wt = p.worktrees.find((w) => normalizeFolder(w.path) === key);
    if (wt) return { projectId: p.id, worktree: { path: cwd, label: wt.branch || parentAndName(cwd).name, ...(wt.branch ? { branch: wt.branch } : {}) } };
  }
  for (const p of projects) {
    const { parent, name } = parentAndName(p.path);
    const prefix = normalizeFolder(`${parent}/${name}-wt-`);
    if (key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes('/')) {
      return { projectId: p.id, worktree: { path: cwd, label: parentAndName(cwd).name } };
    }
  }
  return null;
}
