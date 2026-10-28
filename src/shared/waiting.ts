// "Czeka na Ciebie" (1.0.9): every cell that needs the user, across all grids and windows, longest waiting first.
// Pure logic only (the renderer's waiting.ts tracks the marks, the panel shows them; main may reuse waitKindOf / needsYou to
// count the same cells for a taskbar badge):
//   - waitKindOf: what a cell waits for, from its status, the status detail and the failure code of the last turn;
//   - nextMark / seeMark: since when it waits (a new kind starts a new wait) and whether the user has seen it;
//   - waitingEntries / stepWaiting: the ordered list over the grids and the "next / previous waiting cell" step.
// A question (permission, AskUserQuestion, an MCP elicitation, another input request) stays listed until it is answered; a
// finished turn, an error or a failed command only until the user has looked at the cell (focused it in a focused window).
import { errorPhrase } from './alerts';
import type { MessageKey, MessageParams } from './i18n';
import type { CellStatus, StatusDetail } from './status';

export type WaitKind =
  /** A permission dialog (with the tool when known). */
  | 'permission'
  /** AskUserQuestion. */
  | 'question'
  /** An MCP server asks for input. */
  | 'elicitation'
  /** Another question for the user (Codex approval, agent_needs_input). */
  | 'input'
  /** The turn ended on a usage or rate limit. */
  | 'limit'
  /** The turn ended with another error. */
  | 'error'
  /** A command, the agent CLI or the cell's process ended with a non-zero exit code. */
  | 'failed'
  /** The user interrupted the turn (Esc / Ctrl-C) and nothing followed. */
  | 'interrupted'
  /** The turn finished and the user has not looked at it yet. */
  | 'done';

/** The kinds that keep needing the user after they have seen the cell: a question is answered, not read. */
export const ATTENTION_KINDS: ReadonlySet<WaitKind> = new Set(['permission', 'question', 'elicitation', 'input']);
const KINDS: ReadonlySet<string> = new Set(['permission', 'question', 'elicitation', 'input', 'limit', 'error', 'failed', 'interrupted', 'done']);
/** Failure codes shown as a limit (the turn ended because of how much was used, not because something broke). */
const LIMIT_CODES: ReadonlySet<string> = new Set(['usage-limit', 'rate_limit']);

export interface WaitState { kind: WaitKind; tool?: string; error?: string; code?: number }

/** One cell's wait: what for, since when (ms since the epoch) and when the user looked at it (absent: not yet). */
export interface WaitMark extends WaitState { since: number; seenAt?: number }

/**
 * What a cell waits for, or null when it does not need the user. `failure` is the code of a turn that ended with an error
 * (the renderer's ui.failures). Idle cells never wait: a shell at its prompt after a failed command is not a request.
 */
export function waitKindOf(status: CellStatus, detail: StatusDetail | undefined, failure: string | undefined): WaitState | null {
  if (status === 'exited') return (detail?.kind === 'exit-code' || detail?.kind === 'cli-exited') && detail.code ? { kind: 'failed', code: detail.code } : null;
  if (status !== 'waiting') return null;
  if (failure !== undefined) return { kind: LIMIT_CODES.has(failure) ? 'limit' : 'error', error: failure };
  switch (detail?.kind) {
    case 'permission': return detail.tool ? { kind: 'permission', tool: detail.tool } : { kind: 'permission' };
    case 'question': return { kind: 'question' };
    case 'elicitation': return { kind: 'elicitation' };
    case 'input': return { kind: 'input' };
    case 'interrupted': return { kind: 'interrupted' };
    case 'exit-code': return detail.code ? { kind: 'failed', code: detail.code } : { kind: 'done' };
    default: return { kind: 'done' };
  }
}

const sameState = (a: WaitState, b: WaitState): boolean => a.kind === b.kind && a.tool === b.tool && a.error === b.error && a.code === b.code;

export function sameMark(a: WaitMark | undefined, b: WaitMark | undefined): boolean {
  return a === b || (!!a && !!b && sameState(a, b) && a.since === b.since && a.seenAt === b.seenAt);
}

/**
 * The mark after a status change at `now`: the same object while the cell waits for the same thing (so "since" and "seen"
 * stay), a fresh mark when it waits for something else (another tool, a question after a finished turn), undefined when it
 * does not wait any more.
 */
export function nextMark(
  prev: WaitMark | undefined, status: CellStatus, detail: StatusDetail | undefined, failure: string | undefined, now: number,
): WaitMark | undefined {
  const state = waitKindOf(status, detail, failure);
  if (!state) return undefined;
  if (prev && sameState(prev, state)) return prev;
  return { ...state, since: now };
}

/** The user looked at the cell at `now` (it had the focus in a focused window). */
export function seeMark(mark: WaitMark, now: number): WaitMark {
  return mark.seenAt !== undefined ? mark : { ...mark, seenAt: Math.max(now, mark.since) };
}

/** Does the mark still need the user: a question until it is answered, anything else until it was seen. */
export function needsYou(mark: WaitMark | undefined): boolean {
  return !!mark && (ATTENTION_KINDS.has(mark.kind) || mark.seenAt === undefined);
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const SAFE_TEXT = /^[\w.:@/-]{1,80}$/;

/** A mark another window reported (IPC): checked field by field, null for anything malformed. */
export function normalizeWaitMark(raw: unknown): WaitMark | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  if (typeof raw.since !== 'number' || !Number.isFinite(raw.since) || raw.since <= 0) return null;
  const mark: WaitMark = { kind: raw.kind as WaitKind, since: raw.since };
  if (typeof raw.tool === 'string' && SAFE_TEXT.test(raw.tool)) mark.tool = raw.tool;
  if (typeof raw.error === 'string' && SAFE_TEXT.test(raw.error)) mark.error = raw.error;
  if (typeof raw.code === 'number' && Number.isSafeInteger(raw.code)) mark.code = raw.code;
  if (typeof raw.seenAt === 'number' && Number.isFinite(raw.seenAt)) mark.seenAt = raw.seenAt;
  return mark;
}

// ── the list ─────────────────────────────────────────────────────────────────

interface CellLike { id: string; muted?: boolean }
interface TabLike { id: string; cells: ReadonlyArray<CellLike> }
interface ProjectLike { id: string; tabs: ReadonlyArray<TabLike> }

export interface WaitingEntry extends WaitMark {
  cellId: string;
  projectId: string;
  tabId: string;
  /** The cell's alerts are muted: listed (marked) unless the list hides muted cells, never counted in the badge. */
  muted: boolean;
}

/**
 * Every cell that needs the user, longest waiting first; cells that started waiting at the same moment keep the order of the
 * projects, grids and cells. `hideMuted` leaves out the cells whose alerts are muted.
 */
export function waitingEntries(
  projects: ReadonlyArray<ProjectLike>, marks: Readonly<Record<string, WaitMark>>, opts: { hideMuted?: boolean } = {},
): WaitingEntry[] {
  const out: WaitingEntry[] = [];
  for (const p of projects) for (const t of p.tabs) for (const c of t.cells) {
    const mark = marks[c.id];
    if (!needsYou(mark) || (opts.hideMuted && c.muted)) continue;
    out.push({ ...mark!, cellId: c.id, projectId: p.id, tabId: t.id, muted: !!c.muted });
  }
  // Array.prototype.sort is stable: equal times keep the order above.
  return out.sort((a, b) => a.since - b.since);
}

/** The cells the badge counts: the ones that need the user and are not muted. */
export const waitingCount = (entries: ReadonlyArray<Pick<WaitingEntry, 'muted'>>): number => entries.reduce((n, e) => n + (e.muted ? 0 : 1), 0);

/** A comparable key of the list: equal keys mean the same rows in the same order (the "x min" text comes from `since`). */
export function waitingKey(entries: ReadonlyArray<WaitingEntry>): string {
  return JSON.stringify(entries.map((e) => [e.cellId, e.projectId, e.tabId, e.kind, e.since, e.tool ?? '', e.error ?? '', e.code ?? '', e.muted ? 1 : 0, e.seenAt ?? 0]));
}

/** The list back from its key (the renderer selects the key, so the list re-renders only when a row changes). */
export function entriesFromKey(key: string): WaitingEntry[] {
  try {
    const rows = JSON.parse(key) as unknown[];
    return rows.flatMap((row) => {
      if (!Array.isArray(row) || row.length < 10) return [];
      const [cellId, projectId, tabId, kind, since, tool, error, code, muted, seenAt] = row as [string, string, string, WaitKind, number, string, string, number | '', number, number];
      const entry: WaitingEntry = { cellId, projectId, tabId, kind, since, muted: muted === 1 };
      if (tool) entry.tool = tool;
      if (error) entry.error = error;
      if (code !== '') entry.code = code;
      if (seenAt) entry.seenAt = seenAt;
      return [entry];
    });
  } catch { return []; }
}

/**
 * "Next / previous waiting cell": the entry after (`dir` 1) or before (-1) the current one, wrapping around. A current one
 * that is not listed any more (a finished turn or an error that was just read) still marks the place:
 *   - `order`, the list as it was when the current cell was chosen: the step goes to the next (previous) cell of that order
 *     that is still listed. This is exact even when several cells started waiting at the same moment.
 *   - else `currentSince`: the first entry that waited less long (going back: the last that waited longer).
 * Without a place, the oldest entry (going back: the newest).
 */
export function stepWaiting(
  entries: ReadonlyArray<Pick<WaitingEntry, 'cellId' | 'since'>>, current: string | null | undefined, dir: 1 | -1,
  currentSince?: number, order?: readonly string[],
): string | null {
  const n = entries.length;
  if (!n) return null;
  const i = current ? entries.findIndex((e) => e.cellId === current) : -1;
  if (i >= 0) return entries[(i + dir + n) % n].cellId;
  const k = current && order ? order.indexOf(current) : -1;
  if (k >= 0) {
    const listed = new Set(entries.map((e) => e.cellId));
    for (let j = k + dir; j >= 0 && j < order!.length; j += dir) if (listed.has(order![j])) return order![j];
    // Nothing of the old order left on that side: wrap around.
    return entries[dir > 0 ? 0 : n - 1].cellId;
  }
  if (currentSince !== undefined) {
    if (dir > 0) return (entries.find((e) => e.since > currentSince) ?? entries[0]).cellId;
    return ([...entries].reverse().find((e) => e.since < currentSince) ?? entries[n - 1]).cellId;
  }
  return entries[dir > 0 ? 0 : n - 1].cellId;
}

// ── texts ────────────────────────────────────────────────────────────────────

export interface WaitText { key: MessageKey; params?: MessageParams }

/** What the cell waits for, as the list shows it ("czeka na zgodę: Bash", "pyta Cię o coś", "limit osiągnięty"). */
export function waitText(mark: WaitState): WaitText {
  switch (mark.kind) {
    case 'permission': return mark.tool ? { key: 'czeka na zgodę: {tool}', params: { tool: mark.tool } } : { key: 'czeka na zgodę' };
    case 'question': return { key: 'pyta Cię o coś' };
    case 'elicitation': return { key: 'serwer MCP prosi o dane' };
    case 'input': return { key: 'czeka na Twoją odpowiedź' };
    case 'limit': case 'error': return { key: errorPhrase(mark.error) };
    case 'failed': return mark.code !== undefined ? { key: 'kod wyjścia {code}', params: { code: mark.code } } : { key: 'zakończony' };
    case 'interrupted': return { key: 'przerwane' };
    default: return { key: 'skończył, nieprzeczytane' };
  }
}

/** How long it waits, short: "teraz", "3 min", "2 godz.", "4 dni" (in the app language through the keys). */
export function waitAge(since: number, now: number): WaitText {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return { key: 'teraz' };
  if (minutes < 60) return { key: '{n} min', params: { n: minutes } };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: '{n} godz.', params: { n: hours } };
  return { key: '{n} d', params: { n: Math.floor(hours / 24) } };
}

/** The tone of a row: a question (needs an answer), a failure, or a plain finished turn. */
export function waitTone(kind: WaitKind): 'attention' | 'error' | 'done' {
  if (ATTENTION_KINDS.has(kind)) return 'attention';
  return kind === 'limit' || kind === 'error' || kind === 'failed' ? 'error' : 'done';
}
