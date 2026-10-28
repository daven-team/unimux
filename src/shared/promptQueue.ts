// The prompt queue of an agent cell (1.0.9): follow-up prompts the user lines up while Claude Code or Codex works; unimux
// sends the next one when the agent has finished its turn and sits idle at its prompt. This file is the pure part: the
// persisted shape and its normalisation, the edits, and the decision whether a cell may receive the next prompt now.
// The renderer runs it (src/renderer/src/promptQueue.ts) and the cell footer shows it (components/PromptQueueBar.tsx).
import type { MessageKey } from './i18n';
import type { CellStatus, StatusDetail, StatusReason } from './status';

/** At most this many prompts wait in one cell and each is at most this long (a pasted file is fine, a book is not). */
export const QUEUE_MAX_ITEMS = 50;
export const QUEUE_MAX_TEXT = 20_000;
/** The visible countdown before a prompt goes out: the user sees it coming and may cancel it. */
export const QUEUE_SEND_DELAY_MS = 1500;
/** A sent prompt that did not start a turn within this time pauses the queue (the agent never took it). */
export const QUEUE_NO_TURN_MS = 20_000;

/**
 * Why the queue stopped sending; the user resumes it. `user` = paused by hand, `restart` = the app started again (a queue never
 * sends on its own right after a launch), the others = the cell was not idle at its prompt when the next prompt was due.
 */
export type QueuePause =
  | 'user' | 'restart' | 'permission' | 'question' | 'error' | 'limit' | 'interrupted' | 'exited' | 'typing' | 'noTurn' | 'paste';

export const QUEUE_PAUSES: readonly QueuePause[] = ['user', 'restart', 'permission', 'question', 'error', 'limit', 'interrupted', 'exited', 'typing', 'noTurn', 'paste'];

export interface QueuedPrompt {
  id: string;
  text: string;
}

/** Persisted on the cell (`Cell.promptQueue`); absent when the cell has no queued prompt and is not paused. */
export interface PromptQueue {
  items: QueuedPrompt[];
  /** Present = the queue does not send by itself, and why. */
  paused?: QueuePause;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A saved queue as the app may use it: items with an id and a non-blank text (cut to the limits, repeated ids dropped), a
 * known pause reason. `launch` = read at the start of the app: a queue with prompts is paused ('restart') unless the user had
 * paused it already. Returns undefined when nothing is left.
 */
export function normalizePromptQueue(raw: unknown, launch = false): PromptQueue | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  const seen = new Set<string>();
  const items: QueuedPrompt[] = [];
  for (const item of raw.items) {
    if (items.length >= QUEUE_MAX_ITEMS) break;
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || item.id.length > 64 || seen.has(item.id)) continue;
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    seen.add(item.id);
    items.push({ id: item.id, text: item.text.slice(0, QUEUE_MAX_TEXT) });
  }
  if (!items.length) return undefined;
  const saved = QUEUE_PAUSES.includes(raw.paused as QueuePause) ? raw.paused as QueuePause : undefined;
  const paused = saved ?? (launch ? 'restart' : undefined);
  return paused ? { items, paused } : { items };
}

/** The queue after an edit: undefined once it holds no prompt (the cell field goes away). */
const settle = (items: QueuedPrompt[], paused: QueuePause | undefined): PromptQueue | undefined =>
  !items.length ? undefined : paused ? { items, paused } : { items };

/** Appends a prompt (blank text and a full queue change nothing). */
export function enqueuePrompt(queue: PromptQueue | undefined, text: string, id: string): PromptQueue | undefined {
  const items = queue?.items ?? [];
  if (!text.trim() || items.length >= QUEUE_MAX_ITEMS) return queue;
  return settle([...items, { id, text: text.slice(0, QUEUE_MAX_TEXT) }], queue?.paused);
}

/** Replaces the text of one prompt; a blank text removes it. */
export function editQueued(queue: PromptQueue | undefined, id: string, text: string): PromptQueue | undefined {
  if (!queue) return queue;
  if (!text.trim()) return removeQueued(queue, id);
  return settle(queue.items.map((item) => (item.id === id ? { ...item, text: text.slice(0, QUEUE_MAX_TEXT) } : item)), queue.paused);
}

export function removeQueued(queue: PromptQueue | undefined, id: string): PromptQueue | undefined {
  if (!queue) return queue;
  return settle(queue.items.filter((item) => item.id !== id), queue.paused);
}

/** Moves the prompt `id` to position `to` (clamped), as a drag in the list does. */
export function moveQueued(queue: PromptQueue | undefined, id: string, to: number): PromptQueue | undefined {
  if (!queue) return queue;
  const from = queue.items.findIndex((item) => item.id === id);
  if (from < 0) return queue;
  const items = queue.items.filter((item) => item.id !== id);
  const at = Math.max(0, Math.min(items.length, to));
  items.splice(at, 0, queue.items[from]);
  return items.every((item, i) => item === queue.items[i]) ? queue : settle(items, queue.paused);
}

export function pauseQueue(queue: PromptQueue | undefined, reason: QueuePause): PromptQueue | undefined {
  if (!queue || queue.paused === reason) return queue;
  return settle(queue.items, reason);
}

export function resumeQueue(queue: PromptQueue | undefined): PromptQueue | undefined {
  if (!queue?.paused) return queue;
  return settle(queue.items, undefined);
}

/** What a cell shows of itself to the queue, gathered by the renderer from its status tracker and the store. */
export interface QueueSignal {
  /** The cell runs Claude Code or Codex (a shell or SSH cell never has a queue that sends). */
  agent: boolean;
  /** The cell's terminal was started in this window. */
  started: boolean;
  status: CellStatus;
  /** Why the cell waits (undefined while it works); `error` comes with the failure code. */
  reason?: StatusReason;
  failure?: string;
  detail?: StatusDetail;
  /** Precise signals (Claude hooks, the Codex notify hook) drive the cell: its "waiting / done" is a real turn end. */
  hooked: boolean;
  /** The user typed into the terminal after the last turn end (or after the last resume): the prompt line may hold their text. */
  typed: boolean;
  /** A prompt from the queue was sent and the turn it should start has not begun yet. */
  sent: boolean;
}

/**
 * The decision for a cell's queue right now.
 * - `ready`: the agent finished its turn and is idle at its prompt; the next prompt may go (after the countdown).
 * - `wait`: not yet, and nothing is wrong (the agent works, the first turn has not happened, a sent prompt is starting...).
 * - `pause`: the cell is in a state where sending would be wrong (it asks something, failed, ended, the user typed): the
 *   queue is paused with this reason until the user resumes it.
 * - `paused` / `empty`: nothing to decide.
 */
export type QueueVerdict =
  | { kind: 'empty' }
  | { kind: 'paused'; reason: QueuePause }
  | { kind: 'wait'; why: QueueWait }
  | { kind: 'pause'; reason: QueuePause }
  | { kind: 'ready' };

/** working = the agent runs a turn; start = the terminal has not started; first = no turn ended yet in this run; sent = a sent
 * prompt has not started its turn; unsure = the turn end is only a guess from the output (no hook), so it is not sent by itself. */
export type QueueWait = 'working' | 'start' | 'first' | 'sent' | 'unsure';

export function queueVerdict(queue: PromptQueue | undefined, signal: QueueSignal): QueueVerdict {
  if (!queue?.items.length) return { kind: 'empty' };
  if (queue.paused) return { kind: 'paused', reason: queue.paused };
  if (!signal.agent || !signal.started) return { kind: 'wait', why: 'start' };
  if (signal.sent) return signal.status === 'exited' ? { kind: 'pause', reason: 'exited' } : { kind: 'wait', why: 'sent' };
  const { status, reason, detail } = signal;
  if (status === 'exited' || detail?.kind === 'cli-exited') return { kind: 'pause', reason: 'exited' };
  if (status === 'working') return { kind: 'wait', why: 'working' };
  if (status === 'idle') return { kind: 'wait', why: 'first' };
  // waiting: the turn ended, or the agent needs the user.
  if (reason === 'error' || signal.failure !== undefined) return { kind: 'pause', reason: signal.failure === 'usage-limit' ? 'limit' : 'error' };
  if (detail?.kind === 'permission') return { kind: 'pause', reason: 'permission' };
  if (detail?.kind === 'question' || detail?.kind === 'elicitation' || detail?.kind === 'input' || reason === 'attention') return { kind: 'pause', reason: 'question' };
  if (detail?.kind === 'interrupted') return { kind: 'pause', reason: 'interrupted' };
  if (detail?.kind === 'exit-code') return { kind: 'pause', reason: 'exited' };
  if (signal.typed) return { kind: 'pause', reason: 'typing' };
  if (!signal.hooked) return { kind: 'wait', why: 'unsure' };
  return { kind: 'ready' };
}

/** The label of a pause reason (Polish key). */
export const PAUSE_LABEL: Record<QueuePause, MessageKey> = {
  user: 'wstrzymana przez Ciebie',
  restart: 'wstrzymana po ponownym uruchomieniu',
  permission: 'wstrzymana: agent czeka na zgodę',
  question: 'wstrzymana: agent zadał pytanie',
  error: 'wstrzymana: tura zakończyła się błędem',
  limit: 'wstrzymana: osiągnięto limit',
  interrupted: 'wstrzymana: tura przerwana',
  exited: 'wstrzymana: agent zakończył działanie',
  typing: 'wstrzymana: wpisujesz coś w terminalu',
  noTurn: 'wstrzymana: agent nie podjął promptu',
  paste: 'wstrzymana: terminal nie przyjmie wielu linii naraz',
};

/** The label of a wait (Polish key). */
export const WAIT_LABEL: Record<QueueWait, MessageKey> = {
  working: 'następny po zakończeniu tury',
  start: 'czeka na start agenta',
  first: 'czeka na koniec tury albo na „Wyślij teraz”',
  sent: 'wysłano, czeka na start tury',
  unsure: 'brak pewnego sygnału końca tury - wyślij ręcznie',
};

/** The first line of a prompt, shortened for the footer. */
export function promptPreview(text: string, max = 80): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
