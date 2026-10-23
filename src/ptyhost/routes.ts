// Which renderer window gets a terminal's output (1.0.6, detached windows): every terminal belongs to the main window unless
// main routed it to a detached window. Messages from a window are accepted only for the terminals it owns.
import type { RendererToHost } from '../shared/ipc';

export const MAIN_WINDOW = 'main';

export class WindowRoutes {
  private owners = new Map<string, string>();
  /** The window whose report set the focused terminal (another window's "nothing focused" must not clear it). */
  private focusWindow: string | null = null;

  ownerOf(id: string): string {
    return this.owners.get(id) ?? MAIN_WINDOW;
  }

  /** Routes a terminal to a window (null or 'main': the main window). Returns the previous owner when it changed, else null. */
  set(id: string, window: string | null): string | null {
    const before = this.ownerOf(id);
    const after = window ?? MAIN_WINDOW;
    if (after === MAIN_WINDOW) this.owners.delete(id); else this.owners.set(id, after);
    return before === after ? null : before;
  }

  /** May this message from `window` reach the terminal it names? (A window still holding an old terminal is ignored.) */
  accepts(window: string, m: RendererToHost): boolean {
    if (m.t === 'focus') return true;
    return this.ownerOf(m.id) === window;
  }

  /**
   * A focus report: the id to pass on (null = none focused), or undefined when the report is to be ignored (a window that
   * lost the focus says "none" after another window already reported its terminal).
   */
  focus(window: string, id: string | null): string | null | undefined {
    if (id !== null) { this.focusWindow = window; return id; }
    if (this.focusWindow !== null && this.focusWindow !== window) return undefined;
    this.focusWindow = null;
    return null;
  }
}
