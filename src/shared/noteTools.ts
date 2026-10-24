// Notes (1.0.7): tags, checklists, search, sorting, templates, import and export. Pure logic of the Notes panel and of the
// note tabs; nothing here touches the state or the DOM.
import type { Note } from './types';
import { NOTE_LIMITS } from './notes';
import { resolveCodeLanguage, type CodeLanguage } from './codeLanguages';

/** Only the beginning of a long note is scanned for tags and shown in excerpts (the cards must stay cheap). */
const SCAN_LIMIT = 50_000;

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * For each line: true when it belongs to a fenced code block (the fences included). Tags and tasks are never read in code.
 * Fences are found at any indentation (code in list items is common in notes); an unclosed fence runs to the end.
 */
export function codeLineFlags(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fence) {
      out.push(true);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
    } else if (m) {
      out.push(true);
      fence = m[1];
    } else out.push(false);
  }
  return out;
}

const lineSplit = (text: string): string[] => text.split(/\r?\n/);

// ── tags ────────────────────────────────────────────────────────────────────

const TAG = /(^|[\s([{,;])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
export const TAG_MAX = 40;

/**
 * The #tags of a note, lowercased, in the order they first appear. Not inside code (fenced blocks, `inline code`), not a
 * Markdown heading ("# Title" has a space), not a number (#42 is an issue) and at most TAG_MAX characters.
 */
export function noteTags(text: string): string[] {
  const lines = lineSplit(text.slice(0, SCAN_LIMIT));
  const code = codeLineFlags(lines);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (code[i] || !line.includes('#')) return;
    const plain = line.replace(/`[^`]*`/g, ' ');
    for (const m of plain.matchAll(TAG)) {
      const tag = m[2].replace(/[/-]+$/, '').toLowerCase();
      if (!tag || tag.length > TAG_MAX || /^\d+$/.test(tag) || out.includes(tag)) continue;
      out.push(tag);
    }
  });
  return out;
}

/** A line of text cut at its #tags (the note preview shows them as chips); the other pieces stay as they are. */
export function splitTags(text: string): Array<string | { tag: string; raw: string }> {
  const out: Array<string | { tag: string; raw: string }> = [];
  let at = 0;
  for (const m of text.matchAll(TAG)) {
    const raw = `#${m[2].replace(/[/-]+$/, '')}`;
    const tag = raw.slice(1).toLowerCase();
    if (!tag || tag.length > TAG_MAX || /^\d+$/.test(tag)) continue;
    const start = m.index! + m[1].length;
    if (start > at) out.push(text.slice(at, start));
    out.push({ tag, raw });
    at = start + raw.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
/** The tags of a note: those of its name first, then those of its text. */
export const noteTagsOf = (n: Pick<Note, 'name' | 'text'>): string[] => noteTags(`${n.name}\n${n.text}`);

/** Every tag of these notes with the number of notes carrying it: the most used first, then by name. */
export function tagCounts(notes: readonly Pick<Note, 'name' | 'text'>[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of notes) for (const tag of noteTagsOf(n)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ── checklists ──────────────────────────────────────────────────────────────

const LIST_ITEM = /^(\s*(?:>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)/;
const TASK_BOX = /^(\s*(?:>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/;
/**
 * A task the note preview shows as a checkbox: the box is followed by a space and some text (GFM), or by nothing (an empty
 * task the preview turns into a checkbox itself, see MarkdownPreview.tsx).
 */
const TASK = /^(\s*(?:>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\](?=[ \t]+\S|[ \t]*$)/;

export interface NoteTask { line: number; /** Offset in the text of the character between the brackets. */ at: number; checked: boolean; text: string }

/** The Markdown tasks (`- [ ] text`, `1. [x] text`, also quoted and nested) outside code, in the order the preview shows them. */
export function noteTasks(text: string): NoteTask[] {
  const lines = lineSplit(text);
  const code = codeLineFlags(lines);
  const out: NoteTask[] = [];
  let offset = 0;
  lines.forEach((line, i) => {
    if (!code[i]) {
      const m = TASK.exec(line);
      if (m) out.push({ line: i, at: offset + m[1].length + 1, checked: m[2] !== ' ', text: line.slice(m[0].length).trim() });
    }
    // The separator this line ended with (\r\n counts two).
    offset += line.length + (text.slice(offset + line.length, offset + line.length + 2) === '\r\n' ? 2 : 1);
  });
  return out;
}

/** How many tasks are done; total 0 for a note without tasks. Empty tasks (a template's `- [ ] `) do not count. */
export function taskProgress(text: string): { done: number; total: number } {
  const tasks = noteTasks(text).filter((t) => t.text);
  return { done: tasks.filter((t) => t.checked).length, total: tasks.length };
}

/** The text with task `index` (as counted by noteTasks) ticked or unticked; the same text when there is no such task. */
export function toggleTask(text: string, index: number, checked?: boolean): string {
  const task = noteTasks(text)[index];
  if (!task) return text;
  const next = checked ?? !task.checked;
  if (next === task.checked) return text;
  return text.slice(0, task.at) + (next ? 'x' : ' ') + text.slice(task.at + 1);
}

/**
 * One line after Ctrl+Enter in the note editor: a task is ticked or unticked, a list item becomes a task, a blank line
 * starts a task and any other line becomes one (its indentation kept).
 */
export function toggleTaskLine(line: string): string {
  const box = TASK_BOX.exec(line);
  if (box) return line.slice(0, box[1].length + 1) + (box[2] === ' ' ? 'x' : ' ') + line.slice(box[1].length + 2);
  const item = LIST_ITEM.exec(line);
  if (item) return `${item[1]}[ ] ${line.slice(item[1].length)}`;
  const indent = /^\s*/.exec(line)![0];
  return `${indent}- [ ] ${line.slice(indent.length)}`;
}

// ── search ──────────────────────────────────────────────────────────────────

/** Lowercase without accents, one character for one character (offsets in the folded text are offsets in the original). */
export function foldText(text: string): string {
  let out = '';
  for (const ch of text) {
    const folded = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    // Keep the length: a character that folds into several (or into none) stays itself, lowercased when that keeps it single.
    const single = folded.length === ch.length ? folded : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
    out += single === 'ł' ? 'l' : single;
  }
  return out;
}

export interface NoteQuery { terms: string[]; tags: string[] }

/** Words of the search field: `#tag` filters by a tag, any other word must appear in the name or the text (case and accents ignored). */
export function parseNoteQuery(query: string): NoteQuery {
  const terms: string[] = [];
  const tags: string[] = [];
  for (const word of query.trim().split(/\s+/)) {
    if (!word) continue;
    if (word.startsWith('#')) { const tag = word.slice(1).toLowerCase(); if (tag && !tags.includes(tag)) tags.push(tag); continue; }
    const term = foldText(word);
    if (!terms.includes(term)) terms.push(term);
  }
  return { terms, tags };
}

export const emptyQuery = (q: NoteQuery): boolean => !q.terms.length && !q.tags.length;

/** Does the note match every word and carry every tag (#work also matches #work/meetings)? */
export function noteMatches(note: Pick<Note, 'name' | 'text'>, q: NoteQuery): boolean {
  if (q.tags.length) {
    const tags = noteTagsOf(note);
    if (!q.tags.every((wanted) => tags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`)))) return false;
  }
  if (!q.terms.length) return true;
  const hay = foldText(`${note.name}\n${note.text.slice(0, NOTE_LIMITS.text)}`);
  return q.terms.every((term) => hay.includes(term));
}

/** Where the words occur in `text`: sorted ranges [start, end) that never overlap. */
export function hitRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  if (!terms.length || !text) return [];
  const hay = foldText(text);
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) continue;
    for (let at = hay.indexOf(term); at >= 0 && ranges.length < 200; at = hay.indexOf(term, at + term.length)) ranges.push([at, at + term.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

// ── excerpts ────────────────────────────────────────────────────────────────

const HEADING = /^\s*(?:>\s?)*#{1,6}\s/;

/** A line of Markdown as plain text for a card: no heading marks, list markers, task boxes, emphasis, links or images (dropped). */
export function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:>\s?)+/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s*)?/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * What a note's card shows: its first lines as plain text, blank lines and code fences skipped. With search words the line
 * of the first hit is shown when it is further down (shortened in front so the hit is visible).
 */
export function noteExcerpt(text: string, terms: readonly string[] = [], lines = 2): string {
  const all = lineSplit(text.slice(0, SCAN_LIMIT));
  const fences = all.map((line) => FENCE.test(line));
  const plain = all.map((line, i) => (fences[i] ? '' : plainLine(line)));
  // Headings are the note's structure (often its name again): the card shows what is under them, unless there is nothing else.
  const body = plain.filter((line, i) => line && !HEADING.test(all[i]));
  const shown = body.length ? body : plain.filter(Boolean);
  const first = shown.slice(0, lines);
  if (!terms.length) return first.join('\n');
  const hit = shown.findIndex((line) => { const folded = foldText(line); return terms.some((t) => folded.includes(t)); });
  if (hit < lines) return first.join('\n');
  const line = shown[hit];
  const folded = foldText(line);
  const at = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0));
  return at > 40 ? `…${line.slice(at - 24).trimStart()}` : line;
}

// ── sorting ─────────────────────────────────────────────────────────────────

/** The order of the list: the user's own (drag and drop), the last changed first, or by name. Pinned notes always come first. */
export type NoteSort = 'manual' | 'recent' | 'name';
export const NOTE_SORTS: readonly NoteSort[] = ['manual', 'recent', 'name'];
export const normalizeNoteSort = (raw: unknown): NoteSort => (NOTE_SORTS as readonly unknown[]).includes(raw) ? raw as NoteSort : 'manual';
/** localStorage key of the chosen order (a view setting of this computer, not part of the notes). */
export const NOTE_SORT_KEY = 'mc-notes-sort-v1';

export function sortNotes<T extends Pick<Note, 'name' | 'updatedAt' | 'pinned'>>(notes: readonly T[], sort: NoteSort, locale = 'en'): T[] {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const indexed = notes.map((note, i) => ({ note, i }));
  indexed.sort((a, b) => {
    const pin = Number(!!b.note.pinned) - Number(!!a.note.pinned);
    if (pin) return pin;
    if (sort === 'recent') return b.note.updatedAt - a.note.updatedAt || a.i - b.i;
    if (sort === 'name') {
      const an = a.note.name.trim(), bn = b.note.name.trim();
      // Untitled notes go last.
      if (!an !== !bn) return an ? -1 : 1;
      return collator.compare(an, bn) || a.i - b.i;
    }
    return a.i - b.i;
  });
  return indexed.map((x) => x.note);
}

// ── templates ───────────────────────────────────────────────────────────────

export type NoteTemplateId = 'daily' | 'meeting' | 'checklist';
export const NOTE_TEMPLATES: readonly NoteTemplateId[] = ['daily', 'meeting', 'checklist'];

/** The words a template is written with, already in the user's language. */
export interface NoteTemplateWords {
  daily: string; goals: string; notes: string;
  meeting: string; date: string; attendees: string; agenda: string; actions: string;
  checklist: string;
}

/** A local date as 2026-10-24 and the time as 14:05. */
export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const clock = (date: Date): string => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

/** A new note from a template: its name, its Markdown text and where the cursor starts (the first thing to fill in). */
export function noteFromTemplate(id: NoteTemplateId, words: NoteTemplateWords, date: Date, locale = 'en'): { name: string; text: string; cursor: number } {
  const day = isoDate(date);
  let long = day;
  try { long = date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch { /* the ISO date */ }
  if (id === 'daily') {
    const head = `# ${long}\n\n## ${words.goals}\n- [ ] `;
    return { name: `${words.daily} ${day}`, text: `${head}\n\n## ${words.notes}\n\n`, cursor: head.length };
  }
  if (id === 'meeting') {
    const head = `# ${words.meeting}\n\n**${words.date}:** ${day} ${clock(date)}\n**${words.attendees}:** `;
    return { name: `${words.meeting} ${day}`, text: `${head}\n\n## ${words.agenda}\n- \n\n## ${words.notes}\n\n## ${words.actions}\n- [ ] \n`, cursor: head.length };
  }
  const text = `# ${words.checklist}\n\n- [ ] `;
  return { name: words.checklist, text, cursor: text.length };
}

// ── import and export ───────────────────────────────────────────────────────

/** Files the panel takes as notes (dropped on it or picked to import). */
export const IMPORT_EXTENSIONS = ['md', 'markdown', 'txt', 'text'] as const;
export const isImportableNoteFile = (name: string): boolean => (IMPORT_EXTENSIONS as readonly string[]).includes(name.split('.').pop()?.toLowerCase() ?? '');
/** A dropped or picked file larger than this is skipped (a note holds at most NOTE_LIMITS.text characters). */
export const IMPORT_MAX_BYTES = 1024 * 1024;

/** A note from a Markdown or text file: its name without the extension, Unix line ends, capped like any note. */
export function noteFromFile(fileName: string, text: string): { name: string; text: string; language?: CodeLanguage } {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const name = (dot > 0 ? base.slice(0, dot) : base).trim().slice(0, NOTE_LIMITS.name);
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').slice(0, NOTE_LIMITS.text);
  return { name, text: body, ...(ext === 'txt' || ext === 'text' ? { language: 'text' as const } : {}) };
}

const EXTENSIONS: Partial<Record<CodeLanguage, string>> = {
  markdown: 'md', text: 'txt', shell: 'sh', powershell: 'ps1', typescript: 'ts', javascript: 'js', sql: 'sql', python: 'py',
  json: 'json', yaml: 'yaml', html: 'html', css: 'css', go: 'go', rust: 'rs', c: 'c', cpp: 'cpp', java: 'java', csharp: 'cs', toml: 'toml',
};

/** The file name a note is exported under: its name made safe for every file system, with the extension of its language. */
export function exportFileName(name: string, language: string | undefined): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 100) || 'note';
  const ext = EXTENSIONS[resolveCodeLanguage(language) ?? 'markdown'] ?? 'txt';
  return `${/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe) ? `${safe}-note` : safe}.${ext}`;
}

// ── images ──────────────────────────────────────────────────────────────────

/** Images pasted into a note are files in <data>/note-images, named by a random id; the note links them as `note-images/<name>`. */
export const NOTE_IMAGE_DIR = 'note-images';
export const NOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
export const NOTE_IMAGE_TYPES: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const isNoteImageName = (name: unknown): name is string => typeof name === 'string' && IMAGE_NAME.test(name);
/** The image name behind a link of a note (`note-images/<name>`), or null for any other link. */
export function noteImageName(src: string): string | null {
  const name = src.startsWith(`${NOTE_IMAGE_DIR}/`) ? src.slice(NOTE_IMAGE_DIR.length + 1) : '';
  return isNoteImageName(name) ? name : null;
}
export const noteImageMarkdown = (name: string, alt = 'image'): string => `![${alt.replace(/[[\]]/g, '')}](${NOTE_IMAGE_DIR}/${name})`;
/** The names of the images a note links (to keep them when unused ones are removed). */
export function noteImageNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/note-images\/([0-9a-f-]{36}\.(?:png|jpg|gif|webp))/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// ── tabs ────────────────────────────────────────────────────────────────────

/** The id of a note's tab in the strip (`file:<id>`); JSON like the ids of the other tabs, so it never meets a file's. */
export const noteTabId = (noteId: string): string => JSON.stringify(['note', noteId]);
/** The note behind a tab id, or null for a tab of another kind. */
export function noteIdOfTab(tabId: string): string | null {
  if (!tabId.startsWith('["note",')) return null;
  try { const v: unknown = JSON.parse(tabId); return Array.isArray(v) && v.length === 2 && v[0] === 'note' && typeof v[1] === 'string' ? v[1] : null; } catch { return null; }
}
