// The title bar's drag area on macOS (PLAN W2). 1.1.4 (Electron) moves the window through `-webkit-app-region: drag` on
// `.titlebar` (styles.css) with `no-drag` holes for its controls; WKWebView ignores that property, so the bridge does it: a
// primary-button press in the area starts a native window drag, a double click does what the user's "Double-click a window's
// title bar to" setting says (Rust, mac_chrome.rs). Like Electron's drag area the page sees neither press. Windows keeps the
// CSS property (WebView2 non-client regions, W1). Kept free of `window` so tests drive it with fakes.

/** Where 1.1.4 has `-webkit-app-region: drag`. */
export const DRAG_SELECTOR = '.titlebar';

/**
 * Where 1.1.4 has `-webkit-app-region: no-drag` inside the title bar (styles.css, updater.css), plus the controls that always
 * take their own clicks.
 */
export const NO_DRAG_SELECTOR = [
  '.no-drag', 'button', '.tab', '.tb-btn', '.tb-add', '.update-pill', '.brand-trigger', '.updater-badge',
  'input', 'textarea', 'select', 'a[href]', '[role="button"]', '[contenteditable="true"]', '[contenteditable=""]',
].join(', ');

export interface ElementLike {
  closest(selector: string): ElementLike | null;
  contains(other: ElementLike | null): boolean;
}

/** True when a press on `target` moves the window: inside a drag area and not inside a no-drag hole of that area. */
export function isDragTarget(target: ElementLike | null): boolean {
  const drag = target?.closest(DRAG_SELECTOR);
  if (!target || !drag) return false;
  const hole = target.closest(NO_DRAG_SELECTOR);
  return !(hole && drag.contains(hole));
}

interface PressLike { button: number; detail: number; target: unknown; preventDefault(): void; stopImmediatePropagation(): void }

export interface DragGlobal {
  addEventListener(type: 'mousedown', listener: (event: PressLike) => void, options?: boolean | AddEventListenerOptions): void;
}

export interface DragActions {
  startDragging(): Promise<unknown> | void;
  doubleClick(): Promise<unknown> | void;
}

/** Installs the drag area handler (capture phase, ahead of React's listeners). */
export function installMacDrag(g: DragGlobal, actions: DragActions): void {
  g.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !isDragTarget(e.target as ElementLike | null)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const run = e.detail === 2 ? actions.doubleClick() : e.detail === 1 ? actions.startDragging() : undefined;
    void Promise.resolve(run).catch(() => {});
  }, true);
}
