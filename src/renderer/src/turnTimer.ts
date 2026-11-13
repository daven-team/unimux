// The turn timer in the renderer: every window keeps a mark per cell (since when its turn works, when it ended; the rule is in
// shared/turnTimer.ts) as UI state only, never persisted. One shared clock ticks every second while at least one shown timer
// runs and the window is shown, and stops otherwise; no cell has an interval of its own.
import { create } from 'zustand';
import { nextTurn, turnPhase, turnTook, type TurnMark } from '../../shared/turnTimer';
import { useStore } from './store';
import { isWindowShown, onWindowShown } from './windowShown';

/** The marks by cell id; only the cells whose status this window knows. */
export const useTurns = create<{ marks: Readonly<Record<string, TurnMark>> }>(() => ({ marks: {} }));

/** Recomputes the marks from the statuses; runs inside the status update, so an alert raised right after it sees the end. */
function recompute(): void {
  const { statuses, statusDetails, failures } = useStore.getState().ui;
  const prevMarks = useTurns.getState().marks;
  const now = Date.now();
  let next: Record<string, TurnMark> | null = null;
  for (const [cellId, status] of Object.entries(statuses)) {
    const prev = prevMarks[cellId];
    const mark = nextTurn(prev, turnPhase(status, statusDetails[cellId], failures[cellId]), now);
    if (mark === prev) continue;
    next ??= { ...prevMarks };
    if (mark) next[cellId] = mark; else delete next[cellId];
  }
  // A closed cell takes its mark along.
  for (const cellId of Object.keys(prevMarks)) {
    if (cellId in statuses) continue;
    next ??= { ...prevMarks };
    delete next[cellId];
  }
  if (next) useTurns.setState({ marks: next });
}

let tracking = false;

/** Starts following the statuses of this window's cells (once). */
export function initTurnTracking(): void {
  if (tracking) return;
  tracking = true;
  useStore.subscribe((st, prev) => {
    const a = st.ui, b = prev.ui;
    if (a.statuses !== b.statuses || a.statusDetails !== b.statusDetails || a.failures !== b.failures) recompute();
  });
  recompute();
}

/** How long a cell's last turn took, when it ended within `withinMs` (for the "finished" alert of that very turn). */
export function freshTurnTook(cellId: string, withinMs = 5000): number | undefined {
  const mark = useTurns.getState().marks[cellId];
  if (mark?.endedAt === undefined || Date.now() - mark.endedAt > withinMs) return undefined;
  return turnTook(mark);
}

// ── the shared clock ─────────────────────────────────────────────────────────

/** "Now" for the running timers; refreshed only while the clock ticks. */
export const useTurnClock = create<{ now: number }>(() => ({ now: Date.now() }));

/** The running timers on screen (mounted); the clock ticks while there is one and the window is shown. */
let running = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let shownWired = false;

function sync(): void {
  const want = running > 0 && isWindowShown();
  if (want && !timer) {
    useTurnClock.setState({ now: Date.now() });
    timer = setInterval(() => useTurnClock.setState({ now: Date.now() }), 1000);
  } else if (!want && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** A running timer came on screen; returns its release. */
export function holdTurnClock(): () => void {
  if (!shownWired) { shownWired = true; onWindowShown(sync); }
  running++;
  sync();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    running--;
    sync();
  };
}
