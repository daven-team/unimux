// The split view (1.0.4, "Otwórz obok gridu"): the grid of the project on screen stays on the left and a file, diff, database
// or Redis tab shows on the right, with a draggable divider between them. Pure rules of what each side shows.

/** What the rules need of an open tab: tabs with projectId '' (files outside the projects, DB and Redis tabs) show in every project. */
export interface SplitDoc { id: string; projectId: string }

export interface SplitInput {
  /** The split view is on. */
  on: boolean;
  /** The tab in front (files.ts activeFileId); null when a grid tab is in front. */
  activeFileId: string | null;
  /** The project on screen. */
  projectId: string | null;
  /** The tabs last shown beside this project's grid, the most recent first. */
  recent: readonly string[] | undefined;
  documents: readonly SplitDoc[];
}

/** What is on screen: the grid (left, or alone) and the tab beside it or instead of it. */
export interface SplitSides {
  grid: boolean;
  fileId: string | null;
  /** Both sides at once. */
  split: boolean;
}

export const shownInProject = (doc: SplitDoc, projectId: string | null): boolean => !doc.projectId || doc.projectId === projectId;

/**
 * Off: the tab in front covers the grid (as before 1.0.4), or the grid shows alone. On: the grid always shows; beside it the
 * tab in front, else the tab last shown beside this project's grid (a grid tab clicked keeps the split), else nothing (the
 * grid takes the full width).
 */
export function splitSides({ on, activeFileId, projectId, recent, documents }: SplitInput): SplitSides {
  const shown = (id: string | null | undefined): id is string => !!id && documents.some((d) => d.id === id && shownInProject(d, projectId));
  if (!on) return shown(activeFileId) ? { grid: false, fileId: activeFileId, split: false } : { grid: true, fileId: null, split: false };
  const fileId = shown(activeFileId) ? activeFileId : recent?.find(shown) ?? null;
  return { grid: true, fileId, split: fileId !== null };
}

const RECENT_LIMIT = 20;

/** The tab now in front goes first in its project's list (only a tab shown in that project; the list stays short). */
export function rememberSplitFile(recent: Readonly<Record<string, readonly string[]>>, projectId: string | null, activeFileId: string | null, documents: readonly SplitDoc[]): Readonly<Record<string, readonly string[]>> {
  if (!projectId || !activeFileId || !documents.some((d) => d.id === activeFileId && shownInProject(d, projectId))) return recent;
  const list = recent[projectId] ?? [];
  if (list[0] === activeFileId) return recent;
  const known = new Set(documents.map((d) => d.id));
  return { ...recent, [projectId]: [activeFileId, ...list.filter((id) => id !== activeFileId && known.has(id))].slice(0, RECENT_LIMIT) };
}

/** A tab was closed while the split was on and nothing is left to show beside the grid: the split ends. */
export function splitEndsAfterClose(before: readonly SplitDoc[], after: readonly SplitDoc[], sides: SplitSides): boolean {
  const closed = before.some((d) => !after.some((a) => a.id === d.id));
  return closed && sides.fileId === null;
}

/** Narrowest side in pixels; a workspace too narrow for both splits it in half. */
export const SPLIT_MIN_SIDE = 280;
export const SPLIT_DEFAULT_RATIO = 0.5;

/** The grid's share of the workspace width, kept so that both sides are at least SPLIT_MIN_SIDE wide. */
export function clampSplitRatio(ratio: number, width: number, minSide = SPLIT_MIN_SIDE): number {
  const value = Number.isFinite(ratio) ? ratio : SPLIT_DEFAULT_RATIO;
  if (!(width > 0)) return Math.min(0.9, Math.max(0.1, value));
  if (width < minSide * 2) return 0.5;
  const min = minSide / width;
  return Math.min(1 - min, Math.max(min, value));
}

/** The divider moved by the keyboard: arrows by 2% (Shift: 10%), Home / End to the narrowest grid or file, Enter back to half. */
export function splitRatioForKey(ratio: number, key: string, shift: boolean, width: number): number | null {
  const step = shift ? 0.1 : 0.02;
  const next = key === 'ArrowLeft' ? ratio - step
    : key === 'ArrowRight' ? ratio + step
    : key === 'Home' ? 0
    : key === 'End' ? 1
    : key === 'Enter' ? SPLIT_DEFAULT_RATIO
    : null;
  return next === null ? null : clampSplitRatio(next, width);
}
