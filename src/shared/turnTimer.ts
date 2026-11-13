// The turn timer of a cell: since when the current turn works and how long the last one took. Pure logic only; the renderer's
// turnTimer.ts keeps the marks (UI state, never persisted) and ticks one shared clock while a shown cell works.
//
// The rule of a turn: it starts at the first `working` (the user's prompt) and ends when the cell stops for good, that is a
// finished turn, an error, an interruption or a failed command (waiting with a non-question kind), idle or exited. A question
// in between (a permission prompt, AskUserQuestion, an MCP elicitation, another input request) only pauses the display: the
// start is kept and the next `working` goes on with the same turn, so working -> permission -> working is one turn. The
// duration is wall-clock time from the start to the end, the paused time included. Because the detail of a waiting status can
// arrive just after the status itself, a turn that ended on `waiting` is reopened (paused) when that same wait turns out to be
// a question; once the cell has moved on (works again, goes idle, exits) the end is final and the next `working` starts anew.
import type { MessageKey, MessageParams } from './i18n';
import type { CellStatus, StatusDetail } from './status';
import { ATTENTION_KINDS, waitKindOf } from './waiting';

/** One cell's turn: when it started (ms since the epoch) and, once over, when it ended. */
export interface TurnMark {
  since: number;
  /** The turn waits on a question: the display stops, the start stays. */
  paused?: boolean;
  /** When the turn ended (absent: it is still on). */
  endedAt?: number;
  /** The end came with a waiting status that may still turn out to be a question (see the rule above). */
  reopenable?: boolean;
}

/** Where a cell is in its turn: working, waiting on a question, stopped with a result, or resting (idle / exited). */
export type TurnPhase = 'work' | 'ask' | 'stop' | 'rest';

export function turnPhase(status: CellStatus, detail: StatusDetail | undefined, failure: string | undefined): TurnPhase {
  if (status === 'working') return 'work';
  if (status !== 'waiting') return 'rest';
  const wait = waitKindOf(status, detail, failure);
  return wait && ATTENTION_KINDS.has(wait.kind) ? 'ask' : 'stop';
}

/** The mark after a phase change; returns `prev` itself when nothing changes. */
export function nextTurn(prev: TurnMark | undefined, phase: TurnPhase, now: number): TurnMark | undefined {
  const ended = prev?.endedAt !== undefined;
  switch (phase) {
    case 'work':
      if (!prev || ended) return { since: now };
      return prev.paused ? { since: prev.since } : prev;
    case 'ask':
      // A wait seen before any work (a reload while a question is open) has no known start: no timer.
      if (!prev) return undefined;
      if (ended) return prev.reopenable ? { since: prev.since, paused: true } : prev;
      return prev.paused ? prev : { since: prev.since, paused: true };
    case 'stop':
      if (!prev || ended) return prev;
      return { since: prev.since, endedAt: now, reopenable: true };
    case 'rest':
      if (!prev) return undefined;
      if (ended) return prev.reopenable ? { since: prev.since, endedAt: prev.endedAt } : prev;
      return { since: prev.since, endedAt: now };
  }
}

/** True while the turn's time runs on screen (working, not paused, not over). */
export function turnRunning(mark: TurnMark | undefined): boolean {
  return !!mark && mark.endedAt === undefined && !mark.paused;
}

/** The running time for the header: "3:12", past an hour "1:03:12". */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface TurnText { key: MessageKey; params?: MessageParams }

/** How long a finished turn took, short: "40 s" under a minute, "4 min", past an hour "1 godz. 5 min". */
export function turnDuration(ms: number): TurnText {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return { key: '{n} s', params: { n: seconds } };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { key: '{n} min', params: { n: minutes } };
  return { key: '{h} godz. {m} min', params: { h: Math.floor(minutes / 60), m: minutes % 60 } };
}

/** The duration of a finished turn (undefined while it is on or when no turn is known). */
export function turnTook(mark: TurnMark | undefined): number | undefined {
  return mark?.endedAt !== undefined ? mark.endedAt - mark.since : undefined;
}
