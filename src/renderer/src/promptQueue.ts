// The prompt queue of agent cells (1.0.9), renderer side: watches the status of every cell with queued prompts and sends the
// next one when the agent finished its turn and is idle at its prompt (shared/promptQueue.ts decides). A prompt goes out after
// a short visible countdown, as one bracketed paste followed by Enter (the way snippets are sent). Each window runs this for the
// cells whose terminal it holds, so a cell in a detached window is served there and nowhere else.
import { create } from 'zustand';
import { findCell, getProfile, uid, updateCell } from '../../shared/state';
import {
  editQueued, enqueuePrompt, moveQueued, pauseQueue, queueVerdict, QUEUE_NO_TURN_MS, QUEUE_SEND_DELAY_MS, removeQueued, resumeQueue,
  type PromptQueue, type QueuePause, type QueueVerdict,
} from '../../shared/promptQueue';
import type { AppState, Cell } from '../../shared/types';
import { isStarted } from './actions';
import { tr } from './i18n';
import { getS, getUi, toast, update, useStore } from './store';
import { terminals } from './terminals/TerminalManager';

interface QueueRuntime {
  /** Cells whose next prompt goes out at this time (Date.now()); shown as a countdown with a cancel button. */
  countdown: Record<string, number>;
  /** Cells that were just sent a prompt and wait for its turn to start. */
  sent: Record<string, true>;
  /** The cell whose queue panel is open; `compose` = the add field takes the focus (the shortcut, the palette). */
  open: { cellId: string; compose: boolean; seq: number } | null;
}

export const useQueueRuntime = create<QueueRuntime>(() => ({ countdown: {}, sent: {}, open: null }));
const setRuntime = (fn: (r: QueueRuntime) => Partial<QueueRuntime>) => useQueueRuntime.setState(fn);

/** A cell that may have a queue: a local Claude Code or Codex cell. */
export function queueCapable(s: AppState, cell: Cell): boolean {
  return !cell.ssh && getProfile(s, cell.profileId).cli !== 'shell';
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const noTurnTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** When each cell last ended a turn, was resumed or was sent a prompt (performance.now()): typing before that is not "typing now". */
const settledAt = new Map<string, number>();

const editQueue = (cellId: string, fn: (q: PromptQueue | undefined) => PromptQueue | undefined): void =>
  update((s) => {
    const cell = findCell(s, cellId)?.cell;
    if (!cell) return s;
    const next = fn(cell.promptQueue);
    return next === cell.promptQueue ? s : updateCell(s, cellId, { promptQueue: next });
  });

function cancelCountdown(cellId: string): void {
  const timer = timers.get(cellId);
  if (timer) { clearTimeout(timer); timers.delete(cellId); }
  if (cellId in useQueueRuntime.getState().countdown) setRuntime((r) => { const { [cellId]: _c, ...countdown } = r.countdown; return { countdown }; });
}

function clearSent(cellId: string): void {
  const timer = noTurnTimers.get(cellId);
  if (timer) { clearTimeout(timer); noTurnTimers.delete(cellId); }
  if (useQueueRuntime.getState().sent[cellId]) setRuntime((r) => { const { [cellId]: _s, ...sent } = r.sent; return { sent }; });
}

/** The decision for one cell as things stand now. */
export function verdictFor(cellId: string): QueueVerdict {
  const s = getS();
  const cell = findCell(s, cellId)?.cell;
  if (!cell) return { kind: 'empty' };
  const ui = getUi();
  const status = ui.statuses[cellId] ?? 'idle';
  const failure = ui.failures[cellId];
  return queueVerdict(cell.promptQueue, {
    agent: queueCapable(s, cell),
    started: terminals.has(cellId) && isStarted(cellId),
    status,
    reason: status === 'waiting' ? (failure !== undefined ? 'error' : undefined) : undefined,
    failure,
    detail: ui.statusDetails[cellId],
    hooked: terminals.hooked(cellId),
    typed: terminals.typedAt(cellId) > (settledAt.get(cellId) ?? -Infinity),
    sent: useQueueRuntime.getState().sent[cellId] === true,
  });
}

function evaluate(cellId: string): void {
  // Another window holds this cell's terminal (a detached grid): it serves the queue there.
  if (!terminals.has(cellId)) { cancelCountdown(cellId); return; }
  const verdict = verdictFor(cellId);
  if (verdict.kind === 'pause') {
    cancelCountdown(cellId);
    editQueue(cellId, (q) => pauseQueue(q, verdict.reason));
    return;
  }
  if (verdict.kind !== 'ready') { cancelCountdown(cellId); return; }
  if (timers.has(cellId)) return;
  const due = Date.now() + QUEUE_SEND_DELAY_MS;
  setRuntime((r) => ({ countdown: { ...r.countdown, [cellId]: due } }));
  timers.set(cellId, setTimeout(() => {
    timers.delete(cellId);
    setRuntime((r) => { const { [cellId]: _c, ...countdown } = r.countdown; return { countdown }; });
    if (verdictFor(cellId).kind === 'ready') send(cellId);
    else evaluate(cellId);
  }, QUEUE_SEND_DELAY_MS));
}

/** Sends one prompt of the queue (the first, or `itemId`) into the cell and takes it off the queue. */
function send(cellId: string, itemId?: string): boolean {
  const cell = findCell(getS(), cellId)?.cell;
  const item = itemId ? cell?.promptQueue?.items.find((i) => i.id === itemId) : cell?.promptQueue?.items[0];
  if (!cell || !item) return false;
  // Without bracketed paste every line break would submit a line of its own: such a prompt is not sent.
  if (/[\r\n]/.test(item.text) && !terminals.bracketedPaste(cellId)) {
    editQueue(cellId, (q) => pauseQueue(q, 'paste'));
    return false;
  }
  cancelCountdown(cellId);
  editQueue(cellId, (q) => removeQueued(q, item.id));
  // Sent while the agent works ("send now"): it lands in the agent's own input queue, the running turn is not "its" turn.
  if (getUi().statuses[cellId] !== 'working') {
    setRuntime((r) => ({ sent: { ...r.sent, [cellId]: true } }));
    const prev = noTurnTimers.get(cellId);
    if (prev) clearTimeout(prev);
    noTurnTimers.set(cellId, setTimeout(() => {
      noTurnTimers.delete(cellId);
      if (!useQueueRuntime.getState().sent[cellId]) return;
      clearSent(cellId);
      editQueue(cellId, (q) => pauseQueue(q, 'noTurn'));
    }, QUEUE_NO_TURN_MS));
  }
  terminals.paste(cellId, item.text, true, { focus: false });
  // The paste and its Enter are our own keys, not the user typing.
  settledAt.set(cellId, performance.now() + 1000);
  return true;
}

// ── actions of the UI ───────────────────────────────────────────────────────

export function addToQueue(cellId: string, text: string): void {
  if (!text.trim()) return;
  editQueue(cellId, (q) => enqueuePrompt(q, text, uid()));
}
export const editQueuedPrompt = (cellId: string, id: string, text: string) => editQueue(cellId, (q) => editQueued(q, id, text));
export const removeQueuedPrompt = (cellId: string, id: string) => editQueue(cellId, (q) => removeQueued(q, id));
export const moveQueuedPrompt = (cellId: string, id: string, to: number) => editQueue(cellId, (q) => moveQueued(q, id, to));
export function clearQueue(cellId: string): void {
  cancelCountdown(cellId);
  editQueue(cellId, () => undefined);
}
export function pauseCellQueue(cellId: string, reason: QueuePause = 'user'): void {
  cancelCountdown(cellId);
  editQueue(cellId, (q) => pauseQueue(q, reason));
}
/** Resumes: what the user typed before now no longer counts, a pending "sent" is forgotten. */
export function resumeCellQueue(cellId: string): void {
  settledAt.set(cellId, performance.now());
  clearSent(cellId);
  editQueue(cellId, resumeQueue);
}
/** "Send now": the user's explicit choice, whatever the status says (the agent may take it into its own input queue). */
export function sendQueuedNow(cellId: string, itemId?: string): void {
  if (!terminals.has(cellId) || !isStarted(cellId)) return void toast(tr('Komórka nie jest uruchomiona'), 'error');
  if (!send(cellId, itemId)) toast(tr('Terminal nie przyjmuje wklejania wielu linii naraz, więc prompt nie został wysłany.'), 'error');
}

/** Opens the queue panel of a cell (the focused one by default) with the add field focused. */
export function openQueue(cellId?: string | null, compose = true): void {
  const id = cellId ?? getUi().focusedCellId;
  const found = id ? findCell(getS(), id) : null;
  if (!found || !queueCapable(getS(), found.cell)) return void toast(tr('Kolejka promptów działa w komórkach Claude i Codex.'));
  setRuntime((r) => ({ open: { cellId: found.cell.id, compose, seq: (r.open?.seq ?? 0) + 1 } }));
}
export const closeQueue = () => setRuntime(() => ({ open: null }));

// ── the watcher ─────────────────────────────────────────────────────────────

let started = false;

export function initPromptQueue(): void {
  if (started) return;
  started = true;
  terminals.onStatus((cellId, status, prev) => {
    if (status === 'working') clearSent(cellId);
    if (status === 'waiting' && prev !== 'waiting') settledAt.set(cellId, performance.now());
    if (status === 'exited') clearSent(cellId);
    // After the store took the new status (App's listener may run after this one).
    queueMicrotask(() => evaluate(cellId));
  });
  let queued: string[] = [];
  const collect = (s: AppState) => s.projects.flatMap((p) => p.tabs.flatMap((t) => t.cells.filter((c) => c.promptQueue).map((c) => c.id)));
  const run = () => { for (const id of queued) evaluate(id); };
  useStore.subscribe((st, prev) => {
    if (st.s.projects !== prev.s.projects) {
      const next = collect(st.s);
      for (const id of queued) if (!next.includes(id)) { cancelCountdown(id); clearSent(id); }
      queued = next;
      run();
    } else if (st.ui.statuses !== prev.ui.statuses || st.ui.statusDetails !== prev.ui.statusDetails || st.ui.failures !== prev.ui.failures) run();
  });
  queued = collect(getS());
  // Typing into the terminal after a turn end pauses a queue that is counting down (the prompt line holds the user's text).
  setInterval(() => { for (const id of Object.keys(useQueueRuntime.getState().countdown)) evaluate(id); }, 250);
}
