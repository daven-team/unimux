// The Dock icon (macOS: the number of agents waiting for you as its badge; 1.1.2 dropped the Windows taskbar overlay and
// 1.1.0 the progress bar). Main hears every window's statuses (cell:runtime, detached grids included), so the count covers
// all grids. Cheap by design: statuses only mark the view dirty, one debounced pass computes it, and the OS is called only
// when what it shows changes.
import { NO_TASKBAR, sameView, taskbarCounts, taskbarView, type CellRuntime, type TaskbarCell, type TaskbarSettings, type TaskbarView } from '../shared/taskbarState';

export interface TaskbarDeps {
  platform: string;
  cells(): Iterable<TaskbarCell>;
  alive(): ReadonlySet<string>;
  settings(): TaskbarSettings;
  /** macOS: the Dock badge. */
  setDockBadge(text: string): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/** Statuses flip in bursts (a turn end, a grid start): the taskbar follows them once per this window. */
export const TASKBAR_DEBOUNCE_MS = 200;

export interface Taskbar {
  /** A cell reported its status; `window` is the reporting window ('main' or a detached window's id). */
  status(cellId: string, runtime: CellRuntime, window?: string): void;
  /** A window's page went away (reload, crash, closed): the statuses it reported are forgotten until it reports again. */
  forgetWindow(window: string): void;
  /** A cell is gone (killed, removed): its status no longer counts. */
  forget(cellId: string): void;
  /** Cells, mutes or the settings may have changed. */
  invalidate(): void;
  /** The taskbar button was recreated (window shown again, Explorer restarted): show the current view again. */
  reapply(): void;
  /** Runs a pending update now (tests, quit). */
  flush(): void;
  view(): TaskbarView;
  dispose(): void;
}

export function createTaskbar(deps: TaskbarDeps): Taskbar {
  const runtime = new Map<string, CellRuntime>();
  const reporter = new Map<string, string>();
  let applied: TaskbarView = NO_TASKBAR;
  let timer: unknown;
  let disposed = false;

  const apply = (next: TaskbarView, force = false): void => {
    if (!force && sameView(applied, next)) return;
    const prev = applied;
    applied = next;
    if (force || next.dock !== prev.dock) deps.setDockBadge(next.dock);
  };

  const compute = (): TaskbarView => taskbarView(taskbarCounts(deps.cells(), runtime, deps.alive()), deps.settings(), deps.platform);

  const run = (): void => {
    timer = undefined;
    if (!disposed) apply(compute());
  };

  const schedule = (): void => {
    if (disposed || timer !== undefined) return;
    timer = deps.setTimer(run, TASKBAR_DEBOUNCE_MS);
  };

  return {
    status(cellId, r, window = 'main') {
      reporter.set(cellId, window);
      const prev = runtime.get(cellId);
      if (prev && prev.status === r.status && prev.reason === r.reason) return;
      runtime.set(cellId, { status: r.status, reason: r.reason });
      schedule();
    },
    forget(cellId) {
      reporter.delete(cellId);
      if (runtime.delete(cellId)) schedule();
    },
    forgetWindow(window) {
      let changed = false;
      for (const [cellId, owner] of reporter) {
        if (owner !== window) continue;
        reporter.delete(cellId);
        changed = runtime.delete(cellId) || changed;
      }
      if (changed) schedule();
    },
    invalidate: schedule,
    reapply() {
      if (disposed) return;
      if (timer !== undefined) { deps.clearTimer(timer); timer = undefined; }
      apply(compute(), true);
    },
    flush() {
      if (timer === undefined) return;
      deps.clearTimer(timer);
      run();
    },
    view: () => applied,
    dispose() {
      disposed = true;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
    },
  };
}
