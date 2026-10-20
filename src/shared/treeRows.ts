// The project tree as a flat list of fixed-height rows (only the rows in view are rendered), the folder rows pinned at
// the top while scrolling (sticky scroll) and the indentation of deep levels. Pure functions, no DOM.
import type { ProjectDirectory, ProjectFileEntry } from './types';
import { IGNORED_FOLDERS } from './search';

export type TreeMessage = 'loading' | 'empty' | 'error' | 'truncated';

export type TreeRow =
  | {
    type: 'entry'; key: string; entry: ProjectFileEntry; depth: number;
    /** Index of the row of the containing folder, -1 at the top level. */
    parent: number;
    /** Folders: expanded or not. */
    open: boolean;
    /** Index after the last row of this entry's subtree (the next row for files and closed folders). */
    end: number;
    /** 1-based position among its siblings and their count (aria-posinset / aria-setsize). */
    pos: number; size: number;
  }
  | { type: 'message'; key: string; message: TreeMessage; dir: string; depth: number; parent: number; error?: string };

/**
 * Flattens the listed folders into rows in display order. `listing(path)` is the loaded listing of a folder (undefined
 * while it loads); a folder's children follow it when it is in `expanded`.
 */
export function flattenTree(listing: (path: string) => ProjectDirectory | undefined, expanded: ReadonlySet<string>, root = ''): TreeRow[] {
  const rows: TreeRow[] = [];
  const message = (msg: TreeMessage, dir: string, depth: number, parent: number, error?: string) =>
    rows.push({ type: 'message', key: `${msg}:${dir}`, message: msg, dir, depth, parent, error });
  const visit = (dir: string, depth: number, parent: number): void => {
    const list = listing(dir);
    if (!list) { message('loading', dir, depth, parent); return; }
    if (!list.ok) { message('error', dir, depth, parent, list.error); return; }
    if (!list.entries.length) { message('empty', dir, depth, parent); return; }
    const size = list.entries.length;
    list.entries.forEach((entry, i) => {
      const index = rows.length;
      const open = entry.kind === 'directory' && expanded.has(entry.path);
      const row: TreeRow = { type: 'entry', key: entry.path, entry, depth, parent, open, end: index + 1, pos: i + 1, size };
      rows.push(row);
      if (open) { visit(entry.path, depth + 1, index); row.end = rows.length; }
    });
    if (list.truncated) message('truncated', dir, depth, parent);
  };
  visit(root, 0, -1);
  return rows;
}

function sameRow(a: TreeRow, b: TreeRow): boolean {
  if (a.type === 'entry' && b.type === 'entry') {
    return a.entry.path === b.entry.path && a.entry.name === b.entry.name && a.entry.kind === b.entry.kind && a.depth === b.depth
      && a.parent === b.parent && a.open === b.open && a.end === b.end && a.pos === b.pos && a.size === b.size;
  }
  if (a.type === 'message' && b.type === 'message') {
    return a.key === b.key && a.depth === b.depth && a.parent === b.parent && a.error === b.error;
  }
  return false;
}

/**
 * Reuses the row objects of the previous flattening whose content did not change (also when a reload produced new
 * listing objects), so a new listing or a toggled folder does not make every visible row look new.
 */
export function stabilizeRows(previous: readonly TreeRow[] | null, next: TreeRow[]): TreeRow[] {
  if (!previous?.length) return next;
  const old = new Map<string, TreeRow>();
  for (const row of previous) old.set(row.key, row);
  let reused = 0;
  const rows = next.map((row) => {
    const before = old.get(row.key);
    if (before && sameRow(before, row)) { reused++; return before; }
    return row;
  });
  return reused === previous.length && rows.length === previous.length ? previous as TreeRow[] : rows;
}

/** Left padding of a pinned row: a small fixed step per pinned level, so a narrow panel still shows the names. */
export function stickyIndent(position: number): number {
  return INDENT.base + Math.max(0, position) * 6;
}

/** Expanded folders whose listing is shown: every ancestor is expanded too (plus the root ''). */
export function shownFolders(expanded: Iterable<string>): string[] {
  const set = new Set(expanded);
  const shown = [''];
  for (const path of set) {
    let visible = true;
    for (let i = path.lastIndexOf('/'); i > 0 && visible; i = path.lastIndexOf('/', i - 1)) visible = set.has(path.slice(0, i));
    if (visible) shown.push(path);
  }
  return shown;
}

/**
 * Whether the row at `index` is a dependency or build output folder (node_modules, out, release: IGNORED_FOLDERS) or lies
 * inside one; the tree dims those. Folder names only, the project's .gitignore is not read.
 */
export function inIgnoredFolder(rows: readonly TreeRow[], index: number, names: ReadonlySet<string> = IGNORED_FOLDERS): boolean {
  for (let i = index; i >= 0 && i < rows.length; i = rows[i].parent) {
    const row = rows[i];
    if (row.type === 'entry' && row.entry.kind === 'directory' && names.has(row.entry.name)) return true;
  }
  return false;
}

export interface StickyRows {
  /** Row indices of the pinned folders, the outermost first. */
  rows: number[];
  /** Pixels the last pinned row is pushed up when its folder ends right below it (0 or negative). */
  offset: number;
}

/**
 * The folder rows pinned at the top for a scroll position, like VS Code's sticky scroll. Slot k of the stack shows the
 * k-th outermost folder containing the row behind that slot (a folder whose own row is partly scrolled away counts as
 * containing it). At most `max` slots: with more levels the deepest ones are kept (the closest parents matter most).
 * The last pinned folder slides up when its subtree ends under it.
 */
export function stickyRows(rows: readonly TreeRow[], scrollTop: number, rowHeight: number, max = 5): StickyRows {
  if (!rows.length || max <= 0 || scrollTop <= 0) return { rows: [], offset: 0 };
  const top = scrollTop;
  const ancestors = (index: number): number[] => {
    const chain: number[] = [];
    for (let i = rows[index]?.parent ?? -1; i >= 0; i = rows[i].parent) chain.unshift(i);
    return chain;
  };
  /** The folders containing the row behind screen position y (plus that row itself when it is a partly hidden open folder). */
  const behind = (y: number): number[] | null => {
    const index = Math.floor((top + y) / rowHeight);
    if (index >= rows.length) return null;
    const chain = ancestors(index);
    const row = rows[index];
    if (row.type === 'entry' && row.open && row.end > index + 1 && index * rowHeight < top + y) chain.push(index);
    return chain;
  };
  let pinned: number[] = [];
  for (let k = 0; ; k++) {
    const chain = behind(k * rowHeight);
    if (!chain || chain.length <= k || pinned.some((row, i) => chain[i] !== row)) break;
    pinned.push(chain[k]);
  }
  if (pinned.length > max) {
    // The deepest `max` folders around the bottom slot; when its row is fully hidden, the row under the stack decides.
    const y = (max - 1) * rowHeight;
    const index = Math.floor((top + y) / rowHeight);
    const chain = index * rowHeight < top + y ? behind(y) ?? [] : ancestors(Math.min(index + 1, rows.length - 1));
    pinned = chain.slice(-max);
  }
  if (!pinned.length) return { rows: [], offset: 0 };
  const lastIndex = pinned[pinned.length - 1];
  const last = rows[lastIndex];
  const end = last.type === 'entry' ? last.end : lastIndex + 1;
  const offset = Math.min(0, end * rowHeight - top - pinned.length * rowHeight);
  if (offset <= -rowHeight) return { rows: pinned.slice(0, -1), offset: 0 };
  return { rows: pinned, offset };
}

/** Scroll position for a click on a pinned folder: the folder becomes a normal row right under its own pinned parents. */
export function scrollTopForPinned(index: number, depth: number, rowHeight: number, max = 5): number {
  return Math.max(0, (index - Math.min(depth, max)) * rowHeight);
}

/** Indentation: a full step per level up to `cap`, then a small step, and no growth at all after `cap + compressed`. */
export const INDENT = { base: 6, step: 10, cap: 7, small: 2, compressed: 8 } as const;
/** Width of the twistie slot (the chevron, or the empty space of a file row) that starts every row; guides run through its middle. */
export const TWISTIE = 16;

export function indentFor(depth: number, o: { base: number; step: number; cap: number; small: number; compressed: number } = INDENT): number {
  const d = Math.max(0, depth);
  return o.base + Math.min(d, o.cap) * o.step + Math.min(Math.max(0, d - o.cap), o.compressed) * o.small;
}

/**
 * X positions of the indent guide lines of a row at `depth`: one per ancestor level, under that level's chevron
 * (packed closer on the compressed levels, always left of the row's own indent; equal positions are drawn once).
 */
export function indentGuides(depth: number, chevronCenter = TWISTIE / 2): number[] {
  const guides: number[] = [];
  for (let level = 0; level < depth; level++) {
    const x = indentFor(level + 1) - (INDENT.step - chevronCenter);
    if (guides[guides.length - 1] !== x) guides.push(x);
  }
  return guides;
}

/** First and last (exclusive) row index to render for a viewport, with `overscan` rows on both sides. */
export function visibleRange(count: number, scrollTop: number, height: number, rowHeight: number, overscan = 10): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  return [first, Math.max(first, last)];
}

/**
 * Scroll position that shows row `index` (unchanged when it is fully visible below `reserved` pinned pixels).
 * `center` puts it in the middle, on a whole row so no half-hidden row peeks out under the pinned folders.
 */
export function scrollToShow(index: number, scrollTop: number, height: number, rowHeight: number, reserved = 0, center = false): number {
  const top = index * rowHeight;
  if (center) return Math.max(0, Math.round((top - Math.max(0, (height - rowHeight) / 2)) / rowHeight) * rowHeight);
  if (top < scrollTop + reserved) return Math.max(0, top - reserved);
  if (top + rowHeight > scrollTop + height) return top + rowHeight - height;
  return scrollTop;
}
