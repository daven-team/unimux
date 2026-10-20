// Preview tabs (VS Code's preview mode): a file opened with a single click shows in the one preview tab (its title in italics),
// and the next file opened that way takes the preview tab's place instead of adding a tab. A double click (on the file or on
// the tab), an edit, a save or a drag of the tab keeps the tab. A file already open in a kept tab is only brought to the front.
// At most one tab is the preview tab: the editor area is one strip for all projects (1.0.0).

export interface PreviewTabLike { id: string; preview?: boolean }

/** 'preview': into the preview tab (a single click); 'keep': a tab that stays (a double click, an explicit Open). */
export type OpenMode = 'preview' | 'keep';

export interface OpenTabResult<T> {
  documents: T[];
  /** A new tab was made for the file (its content still has to be read); false: the file was open already. */
  created: boolean;
  /** The preview tab the new tab replaced (its place in the strip goes to the new tab), or null. */
  replaced: string | null;
}

/** The tab without the preview mark (absent = a kept tab). */
function kept<T extends PreviewTabLike>(doc: T): T {
  const { preview: _preview, ...rest } = doc;
  return rest as T;
}

/** The preview tab, if any. */
export const previewTabId = (documents: readonly PreviewTabLike[]): string | null => documents.find((d) => d.preview)?.id ?? null;

/** Keeps a preview tab; the same array when `id` is not a preview tab. */
export function keepTab<T extends PreviewTabLike>(documents: readonly T[], id: string): T[] {
  if (!documents.some((d) => d.id === id && d.preview)) return documents as T[];
  return documents.map((d) => (d.id === id ? kept(d) : d));
}

/** Keeps every preview tab that `which` accepts (all by default); the same array when there is none. */
export function keepTabs<T extends PreviewTabLike>(documents: readonly T[], which: (doc: T) => boolean = () => true): T[] {
  if (!documents.some((d) => d.preview && which(d))) return documents as T[];
  return documents.map((d) => (d.preview && which(d) ? kept(d) : d));
}

/**
 * Opens the tab `id`. An open tab stays where it is ('keep' keeps it when it was the preview tab). A new tab opened with
 * 'keep' goes to the end; with 'preview' it takes the place of the preview tab (or goes to the end as the new preview tab).
 * A preview tab that must not be dropped (`mustKeep`: unsaved edits, a save running) is kept instead of replaced, so a
 * replacement never loses work.
 */
export function openTab<T extends PreviewTabLike>(
  documents: readonly T[], id: string, create: () => T, mode: OpenMode, mustKeep: (doc: T) => boolean = () => false,
): OpenTabResult<T> {
  const existing = documents.find((d) => d.id === id);
  if (existing) return { documents: mode === 'keep' ? keepTab(documents, id) : documents as T[], created: false, replaced: null };
  const fresh = kept(create());
  if (mode === 'keep') return { documents: [...documents, fresh], created: true, replaced: null };
  const next = { ...fresh, preview: true };
  const current = documents.find((d) => d.preview && !mustKeep(d));
  // Any other preview tab (one with unsaved edits, or a second one that should not exist) becomes a kept tab.
  const rest = keepTabs(documents, (d) => d !== current);
  if (!current) return { documents: [...rest, next], created: true, replaced: null };
  return { documents: rest.map((d) => (d === current ? next : d)), created: true, replaced: current.id };
}

/** The strip order after the preview tab's key `from` became `to`: the new key takes the old one's place (no duplicates). */
export function swapOrderKey(order: readonly string[], from: string, to: string): string[] {
  if (from === to || !order.includes(from)) return order as string[];
  return order.filter((key) => key !== to).map((key) => (key === from ? to : key));
}
