// Notes (1.0.4): small plain-text pages kept like snippets, global or for one project, in the right column of the window.
import type { Note } from './types';
import { normalizeCodeLanguage } from './codeLanguages';

export const NOTE_LIMITS = { count: 500, id: 64, name: 120, text: 200_000 } as const;
const COLOR = /^#[0-9a-f]{6}$/i;

/** Notes loaded from disk: entries without an id or with a repeated one are dropped, text fields are capped. */
export function normalizeNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Note[] = [];
  for (const item of raw) {
    if (out.length >= NOTE_LIMITS.count) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || r.id.length > NOTE_LIMITS.id || seen.has(r.id)) continue;
    if (typeof r.name !== 'string' && typeof r.text !== 'string') continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name.slice(0, NOTE_LIMITS.name) : '',
      text: typeof r.text === 'string' ? r.text.slice(0, NOTE_LIMITS.text) : '',
      ...(typeof r.projectId === 'string' && r.projectId ? { projectId: r.projectId } : {}),
      ...(typeof r.color === 'string' && COLOR.test(r.color) ? { color: r.color } : {}),
      ...(normalizeCodeLanguage(r.language) ? { language: normalizeCodeLanguage(r.language) } : {}),
      ...(r.pinned === true ? { pinned: true } : {}),
      updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt > 0 ? Math.round(r.updatedAt) : 0,
    });
  }
  return out;
}

/** The first lines of a note for its card in the list (blank lines skipped). */
export function notePreview(text: string, lines = 2): string {
  return text.slice(0, 2000).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, lines).join('\n');
}

/**
 * What the preview of a note renders (1.0.6): a Markdown note as it is, a note in another language as one code block of that
 * language (its fence longer than any run of backticks in the text), plain text as a block without colours.
 */
export function notePreviewMarkdown(text: string, language = 'markdown'): string {
  if (language === 'markdown') return text;
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language === 'text' ? '' : language}\n${text}\n${fence}\n`;
}

/** The panels of the right column, which share its width. */
export type RightPanel = 'snippets' | 'notes';
const RIGHT_PANELS: readonly RightPanel[] = ['snippets', 'notes'];

/**
 * The open panels of the right column from top to bottom. A panel that stays open keeps its place, a newly opened one goes
 * below the others and a closed one leaves, so the other fills the column. Returns `previous` itself when nothing changed.
 */
export function rightPanelOrder(previous: readonly RightPanel[], open: Record<RightPanel, boolean>): readonly RightPanel[] {
  const kept = previous.filter((panel, i) => open[panel] && previous.indexOf(panel) === i);
  const next = [...kept, ...RIGHT_PANELS.filter((panel) => open[panel] && !kept.includes(panel))];
  return next.length === previous.length && next.every((panel, i) => panel === previous[i]) ? previous : next;
}

/** localStorage key of the right column's order (App.tsx). */
export const RIGHT_ORDER_KEY = 'mc-right-panels-v1';

/** The right column's order as saved by the renderer (localStorage, see App.tsx): known panels, each once; anything else is empty. */
export function parseRightPanelOrder(raw: string | null): readonly RightPanel[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((panel, i): panel is RightPanel => (RIGHT_PANELS as readonly unknown[]).includes(panel) && value.indexOf(panel) === i) : [];
  } catch {
    return [];
  }
}