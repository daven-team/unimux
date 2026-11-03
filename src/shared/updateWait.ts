// Updating while work is in progress (1.1.2). Installing an update closes the app and starts the new version: the agents'
// conversations come back (the app resumes their sessions) but a turn in progress is cut off, and transfers, open database
// transactions or a running account login are lost. Before an update starts from the app, the renderer of the main window
// gathers what would be interrupted (its own cells and those of the detached windows, whose statuses and waits it mirrors) and,
// when anything is in progress, asks: update when it is done, update now, or cancel.
// Pure logic only:
//   - collectUpdateWork: what is in progress, from the state and the renderer's runtime facts;
//   - updateWorkGroups: the dialog's grouped list;
//   - updateBlockers / stepUpdateWait: the "update when they finish" wait, one step per tick, until it installs or gives up.
// The wait never waits forever on the user: an agent that waits for an answer holds the update for ASK_GRACE_MS at most, and the
// whole wait ends after WAIT_MAX_MS (the update is then not installed; the button offers it again).
import type { MessageKey, MessageParams } from './i18n';
import { cellLabel, workingAgents } from './agentWork';
import { getProfile } from './state';
import type { CellStatus } from './status';
import type { AppState } from './types';
import { ATTENTION_KINDS, type WaitMark } from './waiting';

export interface NamedCell { cellId: string; label: string }
/** An agent waiting for the user's answer (permission, question, MCP input); `since`: when it started waiting. */
export interface AskingCell extends NamedCell { since: number }
/** A cell with queued prompts; a paused queue does not send by itself (it is kept, and paused after the restart). */
export interface QueuedCell extends NamedCell { count: number; paused: boolean }

export interface UpdateWork {
  working: NamedCell[];
  asking: AskingCell[];
  queued: QueuedCell[];
  /** MCP tasks in progress on an agent that is working or waiting for the user. */
  tasks: Array<{ title: string; label: string }>;
  /** Names of this window's unsaved editor files (local and remote); `unsavedAway`: those of the detached windows. */
  unsaved: string[];
  unsavedAway: number;
  /** Editor files being written right now (every window). */
  saving: number;
  /** SFTP transfers queued, running or waiting for an answer, and folder walks being prepared. */
  transfers: number;
  /** Database work of every window: open transactions, table tabs with staged edits, unsaved Redis values. */
  tx: number;
  staged: number;
  redis: number;
  /** An account swap, or an account login (Claude or Codex), in progress in main. */
  swap: boolean;
  login: boolean;
}

export const NO_UPDATE_WORK: UpdateWork = {
  working: [], asking: [], queued: [], tasks: [], unsaved: [], unsavedAway: 0, saving: 0, transfers: 0, tx: 0, staged: 0, redis: 0, swap: false, login: false,
};

/** How long an agent that waits for the user's answer holds a waiting update (from the wait's start or its question, the later). */
export const ASK_GRACE_MS = 3 * 60_000;
/** Nothing may be in progress for this long before the update starts (a queued prompt goes out 1.5 s after a turn ends). */
export const SETTLE_MS = 4000;
/** The longest "update when they finish" waits; then it gives up without installing. */
export const WAIT_MAX_MS = 8 * 60 * 60_000;
/** How often the waiting update looks again. */
export const WAIT_TICK_MS = 1000;

export interface WorkFacts {
  state: AppState;
  statuses: Readonly<Record<string, CellStatus>>;
  sessionTitles: Readonly<Record<string, string>>;
  /** The waits of every window's cells (the main window keeps those the detached windows report). */
  waits: Readonly<Record<string, WaitMark>>;
  unsaved?: string[];
  saving?: number;
  /** What the detached windows report (unsaved files, saves, database work). */
  away?: { files?: number; saving?: number; tx?: number; staged?: number; redis?: number };
  local?: { tx?: number; staged?: number; redis?: number };
  transfers?: number;
  swap?: boolean;
  login?: boolean;
}

/** What an update started now would interrupt, over every grid (the main window's and the detached ones). */
export function collectUpdateWork(f: WorkFacts): UpdateWork {
  const s = f.state;
  const ids: string[] = [];
  for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) ids.push(c.id);
  const working = workingAgents(s, ids, f.statuses, f.sessionTitles);
  const workingIds = new Set(working.map((w) => w.cellId));
  const asking: AskingCell[] = [];
  const queued: QueuedCell[] = [];
  for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) {
    const mark = f.waits[c.id];
    const label = (): string => cellLabel(c, f.sessionTitles, getProfile(s, c.profileId).name);
    if (mark && ATTENTION_KINDS.has(mark.kind) && !workingIds.has(c.id) && f.statuses[c.id] !== 'exited') asking.push({ cellId: c.id, label: label(), since: mark.since });
    const items = c.promptQueue?.items.length ?? 0;
    if (items > 0) queued.push({ cellId: c.id, label: label(), count: items, paused: !!c.promptQueue?.paused });
  }
  const busy = new Map<string, string>([...working.map((w) => [w.cellId, w.label] as const), ...asking.map((a) => [a.cellId, a.label] as const)]);
  const tasks = (s.automation?.tasks ?? []).filter((t) => t.status === 'in_progress' && busy.has(t.cellId)).map((t) => ({ title: t.title, label: busy.get(t.cellId)! }));
  const n = (x: number | undefined): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  return {
    working, asking, queued, tasks,
    unsaved: f.unsaved ?? [], unsavedAway: n(f.away?.files), saving: n(f.saving) + n(f.away?.saving),
    transfers: n(f.transfers),
    tx: n(f.local?.tx) + n(f.away?.tx), staged: n(f.local?.staged) + n(f.away?.staged), redis: n(f.local?.redis) + n(f.away?.redis),
    swap: !!f.swap, login: !!f.login,
  };
}

/** Whether the update should ask first: something would be interrupted or lost, or the user should know it is kept. */
export function hasUpdateWork(w: UpdateWork): boolean {
  return w.working.length > 0 || w.asking.length > 0 || w.queued.some((q) => !q.paused) || w.unsaved.length > 0 || w.unsavedAway > 0
    || w.saving > 0 || w.transfers > 0 || w.tx > 0 || w.staged > 0 || w.redis > 0 || w.swap || w.login;
}

export type BlockerKind = 'working' | 'asking' | 'queued' | 'saving' | 'transfers' | 'tx' | 'redis' | 'swap' | 'login' | 'download';
export interface Blocker { kind: BlockerKind; cellId?: string; label?: string; count?: number }

/**
 * What a waiting update still waits for at `now` (it started at `startedAt`). Agents waiting for the user count only during
 * their grace time; unsaved files, staged table edits and paused queues are kept over the restart and never hold it.
 */
export function updateBlockers(w: UpdateWork, startedAt: number, now: number, downloading = false, graceMs = ASK_GRACE_MS): Blocker[] {
  const out: Blocker[] = [];
  for (const a of w.working) out.push({ kind: 'working', cellId: a.cellId, label: a.label });
  for (const a of w.asking) if (now - Math.max(startedAt, a.since) < graceMs) out.push({ kind: 'asking', cellId: a.cellId, label: a.label });
  for (const q of w.queued) if (!q.paused) out.push({ kind: 'queued', cellId: q.cellId, label: q.label, count: q.count });
  if (w.saving) out.push({ kind: 'saving', count: w.saving });
  if (w.transfers) out.push({ kind: 'transfers', count: w.transfers });
  if (w.tx) out.push({ kind: 'tx', count: w.tx });
  if (w.redis) out.push({ kind: 'redis', count: w.redis });
  if (w.swap) out.push({ kind: 'swap' });
  if (w.login) out.push({ kind: 'login' });
  // A download still running: the update starts once it is ready, so the hand-over does not wait in a window.
  if (downloading) out.push({ kind: 'download' });
  return out;
}

export interface UpdateWaitState { startedAt: number; quietSince?: number }
export type UpdateWaitStep =
  | { action: 'wait'; state: UpdateWaitState; blockers: Blocker[] }
  | { action: 'install'; state: UpdateWaitState }
  | { action: 'expire'; state: UpdateWaitState };

/**
 * One tick of "update when they finish": wait while anything holds it; once nothing has for SETTLE_MS, install. An agent that
 * starts working again (a new prompt, the next queued one) holds it again and restarts the quiet time.
 */
export function stepUpdateWait(
  state: UpdateWaitState, w: UpdateWork, now: number,
  opts: { downloading?: boolean; graceMs?: number; settleMs?: number; maxMs?: number } = {},
): UpdateWaitStep {
  if (now - state.startedAt >= (opts.maxMs ?? WAIT_MAX_MS)) return { action: 'expire', state };
  const blockers = updateBlockers(w, state.startedAt, now, opts.downloading, opts.graceMs);
  if (blockers.length) return { action: 'wait', state: { startedAt: state.startedAt }, blockers };
  const quietSince = state.quietSince ?? now;
  const next = { startedAt: state.startedAt, quietSince };
  return now - quietSince >= (opts.settleMs ?? SETTLE_MS) ? { action: 'install', state: next } : { action: 'wait', state: next, blockers };
}

export interface UpdateText { key: MessageKey; params?: MessageParams }

/** The status bar text of a waiting update: the agents it waits for, else the other work, else "in a moment". */
export function pendingText(blockers: readonly Blocker[]): UpdateText {
  const agents = new Set(blockers.filter((b) => b.cellId).map((b) => b.cellId)).size;
  if (agents) return { key: 'Aktualizacja po zakończeniu pracy agentów ({count})', params: { count: agents } };
  if (blockers.some((b) => b.kind === 'download')) return { key: 'Aktualizacja po pobraniu' };
  if (blockers.length) return { key: 'Aktualizacja po zakończeniu zadań w toku ({count})', params: { count: blockers.length } };
  return { key: 'Aktualizacja za chwilę…' };
}

export type GroupTone = 'wait' | 'kept';
export interface UpdateWorkGroup { key: string; title: UpdateText; names: string[]; note: UpdateText; tone: GroupTone }

/** The dialog's list, grouped (agents first, then files, transfers, databases and accounts). */
export function updateWorkGroups(w: UpdateWork, graceMs = ASK_GRACE_MS): UpdateWorkGroup[] {
  const out: UpdateWorkGroup[] = [];
  const add = (key: string, title: MessageKey, count: number, names: string[], note: MessageKey, tone: GroupTone, params: MessageParams = {}) => {
    out.push({ key, title: { key: title, params: { count } }, names, note: { key: note, params }, tone });
  };
  if (w.working.length) add('working', 'Agenci w trakcie tury ({count})', w.working.length, w.working.map((a) => a.label), 'Poczekam, aż skończą. „Zaktualizuj teraz” przerwie ich bieżącą turę.', 'wait');
  if (w.asking.length) {
    add('asking', 'Agenci czekający na Twoją odpowiedź ({count})', w.asking.length, w.asking.map((a) => a.label),
      'Poczekam na Twoją odpowiedź najwyżej {minutes} min, potem aktualizacja przerwie ich pytanie.', 'wait', { minutes: Math.max(1, Math.round(graceMs / 60_000)) });
  }
  const active = w.queued.filter((q) => !q.paused);
  const paused = w.queued.filter((q) => q.paused);
  const queueNames = (list: QueuedCell[]) => list.map((q) => `${q.label} (${q.count})`);
  if (active.length) add('queued', 'Komórki z promptami w kolejce ({count})', active.length, queueNames(active), 'Poczekam, aż kolejka zostanie wysłana i obsłużona. Po restarcie niewysłane prompty zostaną, wstrzymane.', 'wait');
  if (w.tasks.length) add('tasks', 'Zadania MCP w toku ({count})', w.tasks.length, w.tasks.map((t) => `${t.title} - ${t.label}`), 'Zostaną na liście zadań; agent wróci do nich po wznowieniu rozmowy.', 'kept');
  if (paused.length) add('paused', 'Wstrzymane kolejki promptów ({count})', paused.length, queueNames(paused), 'Zostaną zachowane i nadal wstrzymane.', 'kept');
  if (w.saving) add('saving', 'Zapisywane pliki ({count})', w.saving, [], 'Poczekam na koniec zapisu.', 'wait');
  const files = w.unsaved.length + w.unsavedAway;
  if (files) {
    const names = w.unsavedAway ? [...w.unsaved, `+${w.unsavedAway}`] : [...w.unsaved];
    add('unsaved', 'Niezapisane pliki ({count})', files, names, 'Zostaną zachowane jako szkice i wrócą po restarcie.', 'kept');
  }
  if (w.transfers) add('transfers', 'Transfery SFTP w toku ({count})', w.transfers, [], 'Poczekam, aż się zakończą. „Zaktualizuj teraz” je przerwie.', 'wait');
  if (w.tx) add('tx', 'Otwarte transakcje w bazach danych ({count})', w.tx, [], 'Poczekam, aż je zatwierdzisz lub wycofasz. „Zaktualizuj teraz” je wycofa (ROLLBACK).', 'wait');
  if (w.staged) add('staged', 'Tabele z niezapisanymi zmianami ({count})', w.staged, [], 'Zmiany zostaną zachowane jako szkic.', 'kept');
  if (w.redis) add('redis', 'Niezapisane wartości Redis ({count})', w.redis, [], 'Poczekam, aż je zapiszesz. „Zaktualizuj teraz” je odrzuci.', 'wait');
  if (w.swap) add('swap', 'Przełączanie konta w toku', 1, [], 'Poczekam, aż się zakończy.', 'wait');
  if (w.login) add('login', 'Logowanie do konta w toku', 1, [], 'Poczekam, aż się zakończy lub je anulujesz.', 'wait');
  return out;
}

/** Whether anything would make "update when they finish" wait (else the dialog only informs and offers "Update"). */
export const anythingToWaitFor = (w: UpdateWork, now = Date.now()): boolean => updateBlockers(w, now, now).length > 0;
