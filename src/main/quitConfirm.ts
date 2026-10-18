// Quitting while agents work: the window close or the quit is held while the renderer asks the user (it knows the cells and
// their labels). The renderer tells beforehand whether there is anything to ask about (the guard), so a quit with no working agent
// never waits for it. The question can never trap the user:
// - a renderer that does not acknowledge within `ackMs` does not keep the app open (every further Close asks again and re-arms it);
// - an acknowledged question has an upper bound (`answerMs`), after which the app quits as requested;
// - whatever is exempt (the OS session ending, an update hand-over, the app already winding down) is never held, and a session end
//   that arrives while the question is open releases the quit at once (release()).

export type QuitAnswer = 'asking' | 'quit' | 'cancel';

export interface QuitConfirmDeps {
  /** True when this quit must not be held (session end, update hand-over, already quitting, no live renderer). */
  exempt(): boolean;
  /** Shows the window and asks the renderer ('app:confirm-quit'). */
  ask(): void;
  /** Quits for real (app.quit()). */
  quit(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export const QUIT_ACK_MS = 3000;
/** The longest an open, acknowledged quit question holds the quit; then the app quits as the user asked. */
export const QUIT_ANSWER_MS = 120_000;

export const isQuitAnswer = (value: unknown): value is QuitAnswer => value === 'asking' || value === 'quit' || value === 'cancel';

export function createQuitConfirm(deps: QuitConfirmDeps, ackMs = QUIT_ACK_MS, answerMs = QUIT_ANSWER_MS) {
  let guard = false;
  let confirmed = false;
  let pending = false;
  let ackTimer: unknown;
  let answerTimer: unknown;
  const stopAck = (): void => { if (ackTimer !== undefined) { deps.clearTimer(ackTimer); ackTimer = undefined; } };
  const stopAll = (): void => {
    stopAck();
    if (answerTimer !== undefined) { deps.clearTimer(answerTimer); answerTimer = undefined; }
  };
  const go = (): void => { pending = false; stopAll(); confirmed = true; deps.quit(); };
  const ask = (): void => {
    stopAck();
    deps.ask();
    ackTimer = deps.setTimer(() => { ackTimer = undefined; if (pending) go(); }, ackMs);
  };
  return {
    setGuard(value: boolean): void { guard = value; },
    /** Called from the window close and before-quit: true means "hold it, the user is asked". A repeated Close asks again. */
    hold(): boolean {
      if (confirmed || !guard || deps.exempt()) return false;
      pending = true;
      ask();
      return true;
    },
    answer(answer: QuitAnswer): void {
      if (!pending) return;
      if (answer === 'asking') {
        stopAck();
        // The bound is set by the first acknowledgement and never extended.
        answerTimer ??= deps.setTimer(() => { answerTimer = undefined; if (pending) go(); }, answerMs);
        return;
      }
      if (answer === 'quit') { go(); return; }
      pending = false;
      stopAll();
    },
    /** A quit already decided elsewhere (the user chose to quit in a crash dialog): never asked again. */
    confirm(): void { confirmed = true; },
    /** The OS session ends while the question may be open: a held quit goes on now; later ones are exempt by the caller. */
    release(): void { if (pending) go(); },
    /** The renderer reloaded or died: its guard and an open question are gone with it. */
    rendererGone(): void { guard = false; pending = false; stopAll(); },
    isPending: (): boolean => pending,
  };
}

/** How long after the OS announced a session end (shutdown, log-off) quits are never held; a cancelled shutdown re-enables the question. */
export const SESSION_END_WINDOW_MS = 60_000;

export const sessionEndingNow = (endingAt: number | undefined, now: number, windowMs = SESSION_END_WINDOW_MS): boolean =>
  endingAt !== undefined && now - endingAt >= 0 && now - endingAt < windowMs;
