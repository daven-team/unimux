// One prompt to several agent cells at once (1.1.1): the dialog "Wyślij prompt do wielu agentów" (components/AgentPromptDialog.tsx)
// lists every Claude Code and Codex cell of every grid and window. A cell gets the prompt now only while its agent is idle at its
// prompt; a busy cell is skipped with the reason, or (an option) the prompt goes to that cell's prompt queue (shared/promptQueue.ts).
// The window that holds a cell's terminal decides and sends (renderer/agentPrompt.ts); main routes the request there
// (main/agentPrompt.ts). This file is the pure part: the targets, the state of a cell, what happens to it, the request and the summary.
import type { MessageKey } from './i18n';
import { QUEUE_MAX_TEXT } from './promptQueue';
import { getProfile } from './state';
import type { CellStatus, StatusDetail, StatusReason } from './status';
import type { AppState } from './types';

/** At most this many cells in one request (a big workspace has a few dozen agents). */
export const AGENT_PROMPT_MAX_CELLS = 200;
/** A window that did not answer within this time counts as unreachable for its cells. */
export const AGENT_PROMPT_TIMEOUT_MS = 5000;

/** A Claude Code or Codex cell of some grid. */
export interface AgentTarget {
  cellId: string;
  projectId: string;
  tabId: string;
  cli: 'claude' | 'codex';
}

/** Every agent cell (local Claude Code or Codex; shell and SSH cells are no targets), in project, grid and cell order. */
export function agentTargets(s: Pick<AppState, 'projects' | 'profiles'>): AgentTarget[] {
  const out: AgentTarget[] = [];
  for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) {
    if (c.ssh) continue;
    const cli = getProfile(s as AppState, c.profileId)?.cli;
    if (cli === 'claude' || cli === 'codex') out.push({ cellId: c.id, projectId: p.id, tabId: t.id, cli });
  }
  return out;
}

/**
 * Where a cell stands for a prompt sent now.
 * - `ready`: the agent is idle at its prompt (no turn yet, or the turn ended) and its prompt line is empty: it gets the prompt now.
 * - `working`: it runs a turn (or a prompt was just sent and its turn has not started).
 * - `permission` / `question`: it waits for the user's answer.
 * - `queued`: its own prompt queue holds prompts (they go first; sending past them would mix the order).
 * - `typing`: the user typed into its prompt line after the last turn end (the prompt would join their text).
 * - `limit`: the last turn hit the usage limit.
 * - `notStarted`: its terminal has not started; `exited`: the agent ended; `paste`: a multi-line prompt and a terminal without
 *   bracketed paste (every line would go as a prompt of its own); `unreachable`: its window did not answer.
 */
export type TargetState =
  | 'ready' | 'working' | 'permission' | 'question' | 'queued' | 'typing' | 'limit' | 'notStarted' | 'exited' | 'paste' | 'unreachable';

export const TARGET_STATES: readonly TargetState[] = ['ready', 'working', 'permission', 'question', 'queued', 'typing', 'limit', 'notStarted', 'exited', 'paste', 'unreachable'];

/** The states whose prompt may go to the cell's queue instead (it sends once the agent is idle at its prompt again). */
export const QUEUEABLE: ReadonlySet<TargetState> = new Set<TargetState>(['working', 'permission', 'question', 'queued', 'typing']);

/** What the window holding the cell knows about it (gathered from its status tracker, its terminal and the store). */
export interface TargetSignal {
  started: boolean;
  status: CellStatus;
  reason?: StatusReason;
  failure?: string;
  detail?: StatusDetail;
  /** The user typed into the terminal after the last turn end. */
  typed: boolean;
  /** The cell's prompt queue holds prompts. */
  queued: boolean;
  /** A prompt was sent (by the queue or a broadcast) and its turn has not started yet. */
  sent: boolean;
  /** The prompt has a line break and the terminal has no bracketed paste. */
  noPaste: boolean;
}

export function targetState(sig: TargetSignal): TargetState {
  const { status, detail } = sig;
  if (!sig.started) return 'notStarted';
  if (status === 'exited' || detail?.kind === 'cli-exited') return 'exited';
  if (status === 'working' || sig.sent) return 'working';
  if (status === 'waiting') {
    if (sig.failure === 'usage-limit') return 'limit';
    if (detail?.kind === 'permission') return 'permission';
    if (detail?.kind === 'question' || detail?.kind === 'elicitation' || detail?.kind === 'input' || sig.reason === 'attention') return 'question';
    if (detail?.kind === 'exit-code') return 'exited';
  }
  if (sig.queued) return 'queued';
  if (sig.typed) return 'typing';
  if (sig.noPaste) return 'paste';
  return 'ready';
}

export type TargetAction = 'send' | 'queue' | 'skip';

/** What a send does to a cell in `state`; `queueBusy` = "the rest goes to the queue". */
export function targetAction(state: TargetState, queueBusy: boolean): TargetAction {
  if (state === 'ready') return 'send';
  return queueBusy && QUEUEABLE.has(state) ? 'queue' : 'skip';
}

/** One cell's prompt (the text may differ per cell: snippet variables are filled for each). */
export interface AgentPromptItem { cellId: string; text: string }

/** `probe` only reports each cell's state; `send` acts on it. */
export interface AgentPromptRequest {
  mode: 'probe' | 'send';
  queueBusy: boolean;
  items: AgentPromptItem[];
}

/** What happened to a cell (a probe has no `result`). */
export interface AgentPromptOutcome {
  state: TargetState;
  result?: 'sent' | 'queued' | 'skipped';
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A request as it came over IPC, repaired: known mode, valid ids each once, texts cut to the queue's limit; null when unusable. */
export function cleanAgentPromptRequest(raw: unknown): AgentPromptRequest | null {
  if (!isRecord(raw) || (raw.mode !== 'probe' && raw.mode !== 'send') || !Array.isArray(raw.items)) return null;
  const seen = new Set<string>();
  const items: AgentPromptItem[] = [];
  for (const item of raw.items) {
    if (items.length >= AGENT_PROMPT_MAX_CELLS) break;
    if (!isRecord(item) || typeof item.cellId !== 'string' || !item.cellId || item.cellId.length > 128 || seen.has(item.cellId)) continue;
    if (typeof item.text !== 'string') continue;
    if (raw.mode === 'send' && !item.text.trim()) continue;
    seen.add(item.cellId);
    items.push({ cellId: item.cellId, text: item.text.slice(0, QUEUE_MAX_TEXT) });
  }
  return { mode: raw.mode, queueBusy: raw.queueBusy === true, items };
}

/** A window's answer, repaired: only the cells it was asked about, known states and results. */
export function cleanAgentPromptAnswer(raw: unknown, asked: readonly string[]): Record<string, AgentPromptOutcome> {
  const out: Record<string, AgentPromptOutcome> = {};
  if (!isRecord(raw)) return out;
  for (const id of asked) {
    const o = raw[id];
    if (!isRecord(o) || !TARGET_STATES.includes(o.state as TargetState)) continue;
    const result = o.result === 'sent' || o.result === 'queued' || o.result === 'skipped' ? o.result : undefined;
    out[id] = result ? { state: o.state as TargetState, result } : { state: o.state as TargetState };
  }
  return out;
}

/** The counts of the toast after a send. */
export function summarizeOutcomes(outcomes: Readonly<Record<string, AgentPromptOutcome>>): { sent: number; queued: number; skipped: number } {
  const sum = { sent: 0, queued: 0, skipped: 0 };
  for (const o of Object.values(outcomes)) {
    if (o.result === 'sent') sum.sent++;
    else if (o.result === 'queued') sum.queued++;
    else sum.skipped++;
  }
  return sum;
}

/** The counts the dialog shows before a send: what each checked cell would get as things stand. */
export function planCounts(checked: readonly string[], states: Readonly<Record<string, TargetState>>, queueBusy: boolean): { send: number; queue: number; skip: number } {
  const sum = { send: 0, queue: 0, skip: 0 };
  for (const id of checked) {
    const action = targetAction(states[id] ?? 'notStarted', queueBusy);
    sum[action]++;
  }
  return sum;
}

export type QuickSelection = 'grid' | 'all' | 'idle' | 'none';

/**
 * The checked cells after a quick selection: `grid` = the agents of grid `tabId`, `all` = every agent, `idle` = of the checked
 * ones only those idle at their prompt now, `none` = nothing.
 */
export function quickSelect(
  kind: QuickSelection, targets: readonly AgentTarget[], current: ReadonlySet<string>, states: Readonly<Record<string, TargetState>>, tabId?: string,
): Set<string> {
  if (kind === 'none') return new Set();
  if (kind === 'all') return new Set(targets.map((t) => t.cellId));
  if (kind === 'grid') return new Set(targets.filter((t) => t.tabId === tabId).map((t) => t.cellId));
  return new Set(targets.filter((t) => current.has(t.cellId) && states[t.cellId] === 'ready').map((t) => t.cellId));
}

/** The cells checked when the dialog opens: the agents of the given grid when it has any, else every agent. */
export function initialSelection(targets: readonly AgentTarget[], tabId?: string): Set<string> {
  const grid = tabId ? targets.filter((t) => t.tabId === tabId) : [];
  return new Set((grid.length ? grid : targets).map((t) => t.cellId));
}

/** The label of a state (Polish key). */
export const TARGET_STATE_LABEL: Record<TargetState, MessageKey> = {
  ready: 'wolny',
  working: 'pracuje',
  permission: 'czeka na zgodę',
  question: 'czeka na Twoją odpowiedź',
  queued: 'ma prompty w kolejce',
  typing: 'w terminalu jest wpisany tekst',
  limit: 'limit osiągnięty',
  notStarted: 'nie uruchomiony',
  exited: 'zakończony',
  paste: 'terminal nie przyjmie wielu linii',
  unreachable: 'okno nie odpowiada',
};
