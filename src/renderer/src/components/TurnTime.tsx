// The running time of a cell's turn in its header status ("pracuje 3:12"). Only this span re-renders on the clock's tick, and
// only while the turn runs: a paused or finished turn shows nothing here and holds no clock (renderer/turnTimer.ts).
import { useEffect } from 'react';
import { formatElapsed, turnRunning } from '../../../shared/turnTimer';
import { holdTurnClock, useTurnClock, useTurns } from '../turnTimer';

export function TurnTime({ cellId }: { cellId: string }) {
  const since = useTurns((st) => (turnRunning(st.marks[cellId]) ? st.marks[cellId].since : undefined));
  return since === undefined ? null : <RunningTime since={since} />;
}

function RunningTime({ since }: { since: number }) {
  useEffect(() => holdTurnClock(), []);
  const now = useTurnClock((st) => st.now);
  // The clock may be a tick behind a turn that just started: never a negative time.
  return <span className="turn-time">{formatElapsed(Math.max(now, since) - since)}</span>;
}
