// The SSH status bar's runs (1.0.7): one poller per cell asks the Pty Host for sshBar.barScript every SSH_BAR_INTERVAL_MS
// while the bar is on screen (SshStatusBar switches it on and off: visible cell, connected session, shown window), and keeps
// the result per cell. Runs that bring nothing usable count; after SSH_BAR_MAX_FAILURES in a row the bar gives up for the
// session (a Windows server, a router menu). A session that ends or connects again starts over.
import { create } from 'zustand';
import { advanceBar, parseBar, SSH_BAR_INTERVAL_MS, SSH_BAR_MAX_FAILURES, type BarTrack } from '../../shared/sshBar';
import { terminals } from './terminals/TerminalManager';

export interface BarEntry {
  track: BarTrack | null;
  failures: number;
  /** Given up for this session. */
  stopped: boolean;
  /** Round trip and bytes of the last run. */
  run?: { ms: number; bytes: number };
}

export const useSshBarStore = create<{ bars: Record<string, BarEntry> }>(() => ({ bars: {} }));

const EMPTY: BarEntry = { track: null, failures: 0, stopped: false };
const entryOf = (cellId: string): BarEntry => useSshBarStore.getState().bars[cellId] ?? EMPTY;
const setEntry = (cellId: string, entry: BarEntry) => useSshBarStore.setState((st) => ({ bars: { ...st.bars, [cellId]: entry } }));

interface Poller { active: boolean; running: boolean; timer: number | null; last: number; epoch: number }
const pollers = new Map<string, Poller>();

function schedule(cellId: string, p: Poller, delay: number): void {
  if (p.timer !== null) window.clearTimeout(p.timer);
  p.timer = window.setTimeout(() => { p.timer = null; void tick(cellId, p); }, Math.max(0, delay));
}

async function tick(cellId: string, p: Poller): Promise<void> {
  if (!p.active || p.running || pollers.get(cellId) !== p || entryOf(cellId).stopped) return;
  p.running = true;
  const epoch = p.epoch;
  const started = performance.now();
  p.last = started;
  const before = entryOf(cellId);
  const result = await terminals.sshStats(cellId, !before.track?.os);
  p.running = false;
  // Dropped meanwhile (the session ended): the answer belongs to the old session.
  if (pollers.get(cellId) !== p || p.epoch !== epoch) return;
  const entry = entryOf(cellId);
  if (result.ok) {
    const sample = parseBar(result.text);
    if (sample) setEntry(cellId, { track: advanceBar(entry.track, sample, performance.now()), failures: 0, stopped: false, run: { ms: result.ms, bytes: result.bytes } });
    else setEntry(cellId, { ...entry, failures: entry.failures + 1, stopped: entry.failures + 1 >= SSH_BAR_MAX_FAILURES });
  } else if (result.reason === 'unsupported' || result.reason === 'failed') {
    setEntry(cellId, { ...entry, failures: entry.failures + 1, stopped: entry.failures + 1 >= SSH_BAR_MAX_FAILURES });
  }
  if (p.active && !entryOf(cellId).stopped) schedule(cellId, p, SSH_BAR_INTERVAL_MS - (performance.now() - started));
}

/** The bar of `cellId` is on screen (or not): runs start at once (or after the rest of the interval) and stop when it is not. */
export function setBarActive(cellId: string, active: boolean): void {
  let p = pollers.get(cellId);
  if (!p) {
    if (!active) return;
    p = { active: false, running: false, timer: null, last: -Infinity, epoch: 0 };
    pollers.set(cellId, p);
  }
  if (p.active === active) return;
  p.active = active;
  if (!active) {
    if (p.timer !== null) window.clearTimeout(p.timer);
    p.timer = null;
    return;
  }
  if (!p.running) schedule(cellId, p, SSH_BAR_INTERVAL_MS - (performance.now() - p.last));
}

/** The session ended or connected again: the poller and what it collected go. */
export function dropBar(cellId: string): void {
  const p = pollers.get(cellId);
  if (p) {
    if (p.timer !== null) window.clearTimeout(p.timer);
    p.active = false;
    p.epoch++;
    pollers.delete(cellId);
  }
  if (useSshBarStore.getState().bars[cellId]) {
    useSshBarStore.setState((st) => {
      const { [cellId]: _gone, ...bars } = st.bars;
      return { bars };
    });
  }
}
