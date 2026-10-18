// Quitting while agents work: the window close or the quit is held once and the renderer asks the user (it knows the cells and
// their labels). The renderer tells beforehand whether there is anything to ask about (the guard), so a quit with no working agent
// never waits for it. A renderer that does not answer within `ackMs` does not keep the app open, and whatever is exempt (the OS
// session ending, an update hand-over, the app already winding down) is never held.

export type QuitAnswer = 'asking' | 'quit' | 'cancel';

export interface QuitConfirmDeps {
  /** True when this quit must not be held (session end, update hand-over, already quitting, no live renderer). */
  exempt(): boolean;
  /** Asks the renderer ('app:confirm-quit'). */
  ask(): void;
  /** Quits for real (app.quit()). */
  quit(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export const QUIT_ACK_MS = 3000;

export const isQuitAnswer = (value: unknown): value is QuitAnswer => value === 'asking' || value === 'quit' || value === 'cancel';

export function createQuitConfirm(deps: QuitConfirmDeps, ackMs = QUIT_ACK_MS) {
  let guard = false;
  let confirmed = false;
  let pending = false;
  let ackTimer: unknown;
  const stopTimer = (): void => { if (ackTimer !== undefined) { deps.clearTimer(ackTimer); ackTimer = undefined; } };
  const go = (): void => { pending = false; stopTimer(); confirmed = true; deps.quit(); };
  return {
    setGuard(ask: boolean): void { guard = ask; },
    /** Called from the window close and before-quit: true means "hold it, the user is asked". */
    hold(): boolean {
      if (confirmed || !guard || deps.exempt()) return false;
      if (!pending) {
        pending = true;
        deps.ask();
        ackTimer = deps.setTimer(() => { ackTimer = undefined; if (pending) go(); }, ackMs);
      }
      return true;
    },
    answer(answer: QuitAnswer): void {
      if (!pending) return;
      if (answer === 'asking') { stopTimer(); return; }
      if (answer === 'quit') { go(); return; }
      pending = false;
      stopTimer();
    },
    /** A quit already decided elsewhere (the user chose to quit in a crash dialog): never asked again. */
    confirm(): void { confirmed = true; },
    /** The renderer reloaded or died: its guard and an open question are gone with it. */
    rendererGone(): void { guard = false; pending = false; stopTimer(); },
  };
}
