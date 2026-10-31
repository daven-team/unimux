// 1.0.9: the taskbar button (Windows: overlay badge with the number of agents waiting for you; 1.1.0 dropped the
// progress bar while agents work) and the Dock icon (macOS: the same number as its badge). Main hears every window's statuses
// (cell:runtime, detached grids included), so the counts cover all grids. Cheap by design: statuses only mark the view dirty,
// one debounced pass computes it, and the OS is called only when what it shows changes. Badge images are drawn once per label.
import { NO_TASKBAR, sameView, taskbarCounts, taskbarView, type CellRuntime, type TaskbarCell, type TaskbarSettings, type TaskbarView } from '../shared/taskbarState';

export interface TaskbarDeps<Image> {
  platform: string;
  cells(): Iterable<TaskbarCell>;
  alive(): ReadonlySet<string>;
  settings(): TaskbarSettings;
  /** Windows: the main window's taskbar button (no-ops when the window is gone). */
  setOverlay(image: Image | null, description: string): void;
  /** macOS: the Dock badge. */
  setDockBadge(text: string): void;
  /** The overlay image of a label (1..9, 9+); cached here, so it is drawn once per label. */
  image(label: string): Image;
  /** The accessible description of the overlay ("3 agentów czeka na Ciebie"). */
  describe(count: number): string;
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
  /** The badge images changed (drawn with the system font): draw the current one again. */
  redraw(): void;
  /** Runs a pending update now (tests, quit). */
  flush(): void;
  view(): TaskbarView;
  dispose(): void;
}

export function createTaskbar<Image>(deps: TaskbarDeps<Image>): Taskbar {
  const runtime = new Map<string, CellRuntime>();
  const reporter = new Map<string, string>();
  const images = new Map<string, Image>();
  let applied: TaskbarView = NO_TASKBAR;
  let timer: unknown;
  let disposed = false;

  const imageOf = (label: string): Image => {
    let image = images.get(label);
    if (!image) images.set(label, (image = deps.image(label)));
    return image;
  };

  const apply = (next: TaskbarView, force = false): void => {
    if (!force && sameView(applied, next)) return;
    const prev = applied;
    applied = next;
    if (force || next.overlay !== prev.overlay) {
      const count = next.overlay === null ? 0 : next.overlay === '9+' ? 10 : Number(next.overlay);
      deps.setOverlay(next.overlay === null ? null : imageOf(next.overlay), next.overlay === null ? '' : deps.describe(count));
    }
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
    redraw() {
      images.clear();
      if (!disposed && applied.overlay !== null) apply(compute(), true);
    },
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
