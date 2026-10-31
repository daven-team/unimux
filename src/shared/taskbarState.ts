// 1.0.9: the taskbar button (Windows) and the Dock icon (macOS) show how many agents wait for the user and whether any works.
// Pure: main feeds it the statuses every window reports (detached grids too) and applies the result only when it changes.
import type { CellStatus, StatusReason } from './status';

export interface CellRuntime { status: CellStatus; reason?: StatusReason }

export interface TaskbarCell { id: string; muted?: boolean; agent: boolean }

export interface TaskbarCounts {
  /** Agent cells that need the user (a permission, a question, an input request), muted cells left out. */
  attention: number;
  /** Agent cells working right now. */
  working: number;
}

/**
 * Counts over the cells of every grid. Only running agent cells count: a shell cell running a dev server is not an agent at
 * work, and a cell whose process is gone keeps no status. A muted cell still counts as working, it only never asks for you.
 */
export function taskbarCounts(cells: Iterable<TaskbarCell>, runtime: ReadonlyMap<string, CellRuntime>, alive: ReadonlySet<string>): TaskbarCounts {
  const counts: TaskbarCounts = { attention: 0, working: 0 };
  for (const cell of cells) {
    if (!cell.agent || !alive.has(cell.id)) continue;
    const r = runtime.get(cell.id);
    if (!r) continue;
    if (r.status === 'working') counts.working++;
    else if (r.status === 'waiting' && r.reason === 'attention' && !cell.muted) counts.attention++;
  }
  return counts;
}

/** The text of the badge: 1..9, then "9+" (a taskbar overlay has room for two characters). */
export function badgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return count > 9 ? '9+' : String(Math.floor(count));
}

export interface TaskbarSettings { taskbarBadge: boolean }

export interface TaskbarView {
  /** Windows overlay icon label (null = none). */
  overlay: string | null;
  /** macOS Dock badge text ('' = none). */
  dock: string;
}

export const NO_TASKBAR: TaskbarView = Object.freeze({ overlay: null, dock: '' });

/** What the taskbar button / the Dock icon should show for the counts on this platform. */
export function taskbarView(counts: TaskbarCounts, settings: TaskbarSettings, platform: string): TaskbarView {
  const count = settings.taskbarBadge ? counts.attention : 0;
  if (platform === 'win32') {
    return { overlay: badgeLabel(count), dock: '' };
  }
  if (platform === 'darwin') return { overlay: null, dock: count > 0 ? String(count) : '' };
  return NO_TASKBAR;
}

export const sameView = (a: TaskbarView, b: TaskbarView): boolean => a.overlay === b.overlay && a.dock === b.dock;

const STATUSES = new Set<string>(['idle', 'working', 'waiting', 'exited']);
const REASONS = new Set<string>(['done', 'attention', 'error']);
export const isCellStatus = (value: unknown): value is CellStatus => typeof value === 'string' && STATUSES.has(value);
export const isStatusReason = (value: unknown): value is StatusReason => typeof value === 'string' && REASONS.has(value);
