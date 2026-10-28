// "Czeka na Ciebie" (1.0.9) in the renderer. Every window keeps `ui.waits` for its own cells (what they wait for, since when,
// whether the user has looked at them: shared/waiting.ts) and reports them to main (main/detachedWindows.ts), which passes a
// detached window's reports on to the main window; the main window therefore has the list of every window and decides "next /
// previous waiting cell" (a detached window forwards the shortcut). Showing a cell goes through main, which brings up the
// window that has it. A window that just took a grid (or reloaded) starts from the marks main kept, so the times stay.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { cellOwners, ownsCell } from '../../shared/detached';
import { entriesFromKey, nextMark, normalizeWaitMark, seeMark, stepWaiting, waitingCount, waitingEntries, waitingKey, type WaitingEntry, type WaitMark } from '../../shared/waiting';
import { focusCell } from './actions';
import { tr } from './i18n';
import { getS, getUi, setUi, toast, useStore } from './store';
import { detachedId } from './windowRole';
import { isWindowShown, onWindowShown } from './windowShown';
// The card flash lives with the panel's styles; every window (a detached one too) needs it.
import './components/waitingPanel.css';

const HIDE_MUTED_KEY = 'unimux.waiting.hideMuted';

function storedHideMuted(): boolean {
  try { return localStorage.getItem(HIDE_MUTED_KEY) === '1'; } catch { return false; }
}

/** The panel's own choice: cells with muted alerts are left out of the list (and of the next / previous step). */
export const useWaitingPrefs = create<{ hideMuted: boolean }>(() => ({ hideMuted: storedHideMuted() }));

export function setHideMuted(hideMuted: boolean): void {
  useWaitingPrefs.setState({ hideMuted });
  try { localStorage.setItem(HIDE_MUTED_KEY, hideMuted ? '1' : '0'); } catch { /* not stored */ }
}

// ── tracking ─────────────────────────────────────────────────────────────────

let tracking = false;
/** The cell the last step (or the user) went to, in any window: "next" goes on from it while it is still listed. */
let cursor: string | null = null;
/** How long the cursor's cell had been waiting when it was shown: the place in the list once it is read and gone. */
let cursorSince: number | undefined;
let queued = false;

/** The user is looking at this window: it has the keyboard focus and is not minimized. */
const looking = (): boolean => document.hasFocus() && isWindowShown();

/** Recomputes the marks of this window's cells; called (batched) after every status, detail, focus or layout change. */
function recompute(): void {
  queued = false;
  const { s, ui } = useStore.getState();
  const now = Date.now();
  const owners = cellOwners(s);
  const seenCell = looking() ? ui.focusedCellId : null;
  const known = new Set<string>();
  let next: Record<string, WaitMark> | null = null;
  const put = (cellId: string, mark: WaitMark | undefined) => {
    next ??= { ...ui.waits };
    if (mark) next[cellId] = mark; else delete next[cellId];
  };
  for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) {
    known.add(c.id);
    // Another window's cell: the main window keeps what that window reported.
    if (!ownsCell(owners, detachedId, c.id)) continue;
    const prev = ui.waits[c.id];
    // A cell this window has no status for yet (a grid that just moved here, a reload) keeps the mark it came with.
    const statusKnown = ui.statuses[c.id] !== undefined;
    let mark = statusKnown || !prev ? nextMark(prev, ui.statuses[c.id] ?? 'idle', ui.statusDetails[c.id], ui.failures[c.id], now) : prev;
    if (mark && seenCell === c.id) mark = seeMark(mark, now);
    if (mark !== prev) put(c.id, mark);
    report(c.id, mark, statusKnown);
  }
  for (const id of Object.keys(ui.waits)) if (!known.has(id)) put(id, undefined);
  if (next) setUi({ waits: next });
}

/** What this window last told main about each of its cells (null: that it waits for nothing). */
const sent = new Map<string, WaitMark | null>();

/** Reports a cell's mark to main when it changed; "nothing" is not reported for a cell this window knows nothing about yet. */
function report(cellId: string, mark: WaitMark | undefined, known: boolean): void {
  const value = mark ?? null;
  if (sent.has(cellId) ? sent.get(cellId) === value : !value && !known) return;
  sent.set(cellId, value);
  window.mc.detach.wait(cellId, value);
}

function schedule(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(recompute);
}

/** Starts tracking this window's cells (once); the main window also takes in what the detached windows report. */
export function initWaitTracking(): void {
  if (tracking) return;
  tracking = true;
  useStore.subscribe((st, prev) => {
    const a = st.ui, b = prev.ui;
    if (a.statuses !== b.statuses || a.statusDetails !== b.statusDetails || a.failures !== b.failures || a.focusedCellId !== b.focusedCellId
      || st.s.projects !== prev.s.projects || st.s.detachedWindows !== prev.s.detachedWindows) schedule();
    // The user moved to another cell: "next" goes on from there.
    if (a.focusedCellId !== b.focusedCellId && a.focusedCellId && a.focusedCellId !== cursor) { cursor = a.focusedCellId; cursorSince = a.waits[cursor]?.since; }
  });
  // Coming back to the window: the focused cell has been seen.
  window.addEventListener('focus', schedule);
  onWindowShown(schedule);
  const take = (cellId: string, raw: unknown, onlyNew = false) => {
    const mark = raw === null ? null : normalizeWaitMark(raw);
    setUi((ui) => {
      if (onlyNew && cellId in ui.waits) return {};
      if (!mark) {
        if (!(cellId in ui.waits)) return {};
        const { [cellId]: _gone, ...waits } = ui.waits;
        return { waits };
      }
      return { waits: { ...ui.waits, [cellId]: mark } };
    });
  };
  // The marks main kept: the main window gets every window's, a detached window its own cells'.
  void window.mc.detach.waits().then((list) => { for (const { cellId, mark } of list) take(cellId, mark, true); }).catch(() => undefined);
  if (detachedId === null) {
    window.mc.on('detach:wait', (cellId, mark) => take(cellId, mark));
    window.mc.on('waiting:step', (dir) => stepToWaiting(dir === -1 ? -1 : 1));
  }
  schedule();
}

// ── the list ─────────────────────────────────────────────────────────────────

/** The list as a key: re-renders only when a row changes (a status flip that leaves the list as it was changes nothing). */
function useWaitingKey(): string {
  const hideMuted = useWaitingPrefs((st) => st.hideMuted);
  return useStore((st) => waitingKey(waitingEntries(st.s.projects, st.ui.waits, { hideMuted })));
}

export function useWaitingEntries(): WaitingEntry[] {
  const key = useWaitingKey();
  return useMemo(() => entriesFromKey(key), [key]);
}

/** The badge: cells that need the user, muted ones left out. */
export function useWaitingCount(): number {
  return useStore((st) => waitingCount(waitingEntries(st.s.projects, st.ui.waits)));
}

export function currentWaiting(): WaitingEntry[] {
  return waitingEntries(getS().projects, getUi().waits, { hideMuted: useWaitingPrefs.getState().hideMuted });
}

/** "Now" for the "3 min" texts: refreshed every 30 s while mounted and the window is shown, never otherwise. */
export function useWaitClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || !isWindowShown()) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 30_000);
    };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    const off = onWindowShown((shown) => (shown ? start() : stop()));
    start();
    return () => { stop(); off(); };
  }, [active]);
  return now;
}

// ── navigation ───────────────────────────────────────────────────────────────


/** Shows a cell wherever it is: its grid comes to the front (its window, if detached) and its terminal gets the focus. */
export function revealWaiting(cellId: string): void {
  cursor = cellId;
  cursorSince = getUi().waits[cellId]?.since;
  if (!ownsCell(cellOwners(getS()), detachedId, cellId)) {
    // Main brings up the window that has the cell and has it focus the cell.
    if (detachedId === null) window.mc.detach.revealCell(cellId);
    return;
  }
  // A cell of this window: shown at once; main also raises the window when another app is in front.
  revealCell(cellId);
  if (detachedId === null && !document.hasFocus()) window.mc.detach.revealCell(cellId);
}

/** Focuses a cell of this window and flashes its card once (a notification click, the list, the next / previous step). */
export function revealCell(cellId: string): void {
  focusCell(cellId);
  requestAnimationFrame(() => requestAnimationFrame(() => flashCard(cellId)));
}

function flashCard(cellId: string): void {
  const card = document.querySelector<HTMLElement>(`.cell[data-cell-id="${CSS.escape(cellId)}"]`);
  if (!card) return;
  card.classList.remove('wait-flash');
  void card.offsetWidth; // restart the animation
  card.classList.add('wait-flash');
  window.setTimeout(() => card.classList.remove('wait-flash'), 1300);
}

/** "Next / previous waiting cell": in a detached window the main window (which has every window's list) decides. */
export function stepToWaiting(dir: 1 | -1): void {
  if (detachedId !== null) { window.mc.detach.waitStep(dir); return; }
  const list = currentWaiting();
  const target = cursor ? stepWaiting(list, cursor, dir, cursorSince) : stepWaiting(list, getUi().focusedCellId, dir);
  if (!target) { toast(tr('Nic na Ciebie nie czeka.')); return; }
  revealWaiting(target);
}
