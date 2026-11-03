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

export interface TaskbarSettings { taskbarBadge: boolean }

/** 1.1.2: only the macOS Dock badge is left (the Windows taskbar overlay was dropped at the user's request). */
export interface TaskbarView {
  /** macOS Dock badge text ('' = none). */
  dock: string;
}

export const NO_TASKBAR: TaskbarView = Object.freeze({ dock: '' });

/** What the Dock icon should show for the counts on this platform (nothing elsewhere). */
export function taskbarView(counts: TaskbarCounts, settings: TaskbarSettings, platform: string): TaskbarView {
  const count = settings.taskbarBadge ? counts.attention : 0;
  return platform === 'darwin' ? { dock: count > 0 ? String(count) : '' } : NO_TASKBAR;
}

export const sameView = (a: TaskbarView, b: TaskbarView): boolean => a.dock === b.dock;

const STATUSES = new Set<string>(['idle', 'working', 'waiting', 'exited']);
const REASONS = new Set<string>(['done', 'attention', 'error']);
export const isCellStatus = (value: unknown): value is CellStatus => typeof value === 'string' && STATUSES.has(value);
export const isStatusReason = (value: unknown): value is StatusReason => typeof value === 'string' && REASONS.has(value);
