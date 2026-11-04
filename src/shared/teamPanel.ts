// The logic of the "Zespół AI" panel (1.1.2, AutomationPanel.tsx): tasks grouped by state, message threads per agent, the
// agent filter, and the texts the quick actions copy. Pure functions over the persisted automation state, tested in Node.
import { isClosedTask, type AgentMessage, type AgentRuntimeStatus, type AgentTask, type AutomationEvent, type TaskResult } from './automation';

export type TaskGroupId = 'progress' | 'open' | 'done';
export interface TaskGroup { id: TaskGroupId; tasks: AgentTask[] }

/** A task concerns an agent when the agent works on it or assigned it. */
export const taskConcerns = (task: AgentTask, cellId: string): boolean => task.cellId === cellId || task.fromCellId === cellId;
/** A message concerns an agent when the agent sent or received it. */
export const messageConcerns = (message: AgentMessage, cellId: string): boolean => message.toCellId === cellId || message.fromCellId === cellId;

const byNewest = (a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt;

/**
 * In progress (newest change first), open (blocked ones first, they need someone; then queued, the oldest first, the order
 * they will be worked on), done (completed and cancelled, newest first). Empty groups are kept so the counts read 0.
 */
export function groupTasks(tasks: readonly AgentTask[], filterCellId?: string | null): TaskGroup[] {
  const shown = filterCellId ? tasks.filter((t) => taskConcerns(t, filterCellId)) : [...tasks];
  const progress = shown.filter((t) => t.status === 'in_progress').sort(byNewest);
  const blocked = shown.filter((t) => t.status === 'blocked').sort(byNewest);
  const queued = shown.filter((t) => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  const done = shown.filter(isClosedTask).sort(byNewest);
  return [{ id: 'progress', tasks: progress }, { id: 'open', tasks: [...blocked, ...queued] }, { id: 'done', tasks: done }];
}

/** Prerequisites of a task that have not completed yet (a missing one counts as open, like main's blockedBy). */
export function openPrerequisites(task: AgentTask, tasks: readonly AgentTask[]): Array<{ id: string; task?: AgentTask }> {
  if (!task.dependsOn?.length) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependsOn.filter((id) => byId.get(id)?.status !== 'completed').map((id) => ({ id, task: byId.get(id) }));
}

export interface Thread {
  /** The agent the thread is with. */
  cellId: string;
  count: number;
  /** Messages to this agent it has not read yet. */
  unread: number;
  last: AgentMessage;
}

/**
 * One thread per agent that sent or received messages: a message between two agents is in both threads, a message from the
 * user is in its recipient's. Most recent activity first.
 */
export function messageThreads(messages: readonly AgentMessage[]): Thread[] {
  const threads = new Map<string, Thread>();
  const add = (cellId: string, message: AgentMessage) => {
    const thread = threads.get(cellId);
    const unread = message.toCellId === cellId && !message.readAt ? 1 : 0;
    if (!thread) { threads.set(cellId, { cellId, count: 1, unread, last: message }); return; }
    thread.count++;
    thread.unread += unread;
    if (message.createdAt >= thread.last.createdAt) thread.last = message;
  };
  for (const message of messages) {
    add(message.toCellId, message);
    if (message.fromCellId && message.fromCellId !== message.toCellId) add(message.fromCellId, message);
  }
  return [...threads.values()].sort((a, b) => b.last.createdAt - a.last.createdAt);
}

/** The messages of a thread (or all of them for null), oldest first, the way a conversation reads. */
export function threadMessages(messages: readonly AgentMessage[], cellId: string | null): AgentMessage[] {
  return (cellId ? messages.filter((m) => messageConcerns(m, cellId)) : [...messages]).sort((a, b) => a.createdAt - b.createdAt);
}

/** Activity of the project, newest first, of one agent when filtered. */
export function activityOf(events: readonly AutomationEvent[], projectId: string, filterCellId?: string | null, limit = 100): AutomationEvent[] {
  const out: AutomationEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    if (e.projectId === projectId && (!filterCellId || e.cellId === filterCellId)) out.push(e);
  }
  return out;
}

/** What "Kopiuj wynik" copies: the summary, then branch and commit, files and tests as plain lines. */
export function resultText(result: TaskResult): string {
  const lines = [result.summary.trim()];
  const ref = [result.branch, result.commit].filter(Boolean).join(' @ ');
  if (ref) lines.push('', ref);
  if (result.files.length) lines.push('', ...result.files.map((f) => `- ${f}`));
  if (result.tests.length) lines.push('', ...result.tests.map((t) => `- ${t}`));
  return lines.join('\n');
}

/**
 * "Przydziel ponownie": a new task with the same title and instructions, for the same agent (a closed task, which never
 * reopens) or for another one (an open task whose agent was closed; the old task is then cancelled).
 */
export function reassignInput(task: AgentTask, cellId = task.cellId): { cellId: string; title: string; prompt: string } {
  return { cellId, title: task.title, prompt: task.prompt };
}

/** Counts for the tabs: open tasks (not closed) and unread messages, of one agent when filtered. */
export function teamCounts(tasks: readonly AgentTask[], messages: readonly AgentMessage[], filterCellId?: string | null): { openTasks: number; unread: number } {
  return {
    openTasks: tasks.filter((t) => !isClosedTask(t) && (!filterCellId || taskConcerns(t, filterCellId))).length,
    unread: messages.filter((m) => !m.readAt && (!filterCellId || messageConcerns(m, filterCellId))).length,
  };
}

// ── stuck tasks (1.1.4) ──────────────────────────────────────────────────────

/** How long a queued task's agent may stay off MCP (since the task was created or the agent started) before it counts as stuck. */
export const NEVER_STARTED_MS = 90_000;

/**
 * Why an open task does not move: its agent never connected to MCP, its CLI ended, its cell was closed (or its grid sent to
 * the history), or it waits for the user's answer.
 */
export type StuckKind = 'never-started' | 'ended' | 'closed' | 'waiting';
export interface Stuck {
  kind: StuckKind;
  /** The CLI's exit code (ended), when known and not 0. */
  code?: number;
  /** The cell is in a closed grid (closed). */
  archived?: boolean;
}

/** What the renderer knows about an agent: its cell, the MCP connection, main's runtime status and the terminal's detail. */
export interface AgentHealth {
  /** The cell is in an open grid of the project. */
  open: boolean;
  /** The cell is in a closed grid (the project's history). */
  archived?: boolean;
  /** Connected to unimux's MCP server now. */
  connected: boolean;
  runtime?: AgentRuntimeStatus;
  /** The agent CLI ended and its shell is back (status detail cli-exited), with its exit code when known. */
  cliExited?: boolean;
  exitCode?: number;
  /** When the agent last started, when the renderer saw it. */
  startedAt?: number;
}

/**
 * Why an open task is stuck, or null. `baseline` is the earliest moment the agent could have connected (the window's start:
 * after a restart of the app its agents start again, and an old task must not count as stuck before they had the chance).
 */
export function taskStuck(task: AgentTask, health: AgentHealth | undefined, now: number, baseline = 0): Stuck | null {
  if (isClosedTask(task)) return null;
  if (!health?.open) return health?.archived ? { kind: 'closed', archived: true } : { kind: 'closed' };
  if (health.cliExited || health.runtime === 'exited') return health.exitCode ? { kind: 'ended', code: health.exitCode } : { kind: 'ended' };
  if (health.runtime === 'needs_attention') return { kind: 'waiting' };
  if (task.status === 'queued' && !health.connected && now - Math.max(task.createdAt, health.startedAt ?? 0, baseline) > NEVER_STARTED_MS) return { kind: 'never-started' };
  return null;
}

const STUCK_ORDER: Record<StuckKind, number> = { ended: 0, closed: 1, 'never-started': 2, waiting: 3 };

/** The state of an agent's row: the most serious reason among its open tasks (an ended CLI first). */
export function agentStuck(cellId: string, tasks: readonly AgentTask[], stuck: ReadonlyMap<string, Stuck>): Stuck | null {
  let worst: Stuck | null = null;
  for (const task of tasks) {
    const s = task.cellId === cellId ? stuck.get(task.id) : undefined;
    if (s && (!worst || STUCK_ORDER[s.kind] < STUCK_ORDER[worst.kind])) worst = s;
  }
  return worst;
}

/** An agent whose open tasks cannot move until the user acts (a row of the banner). */
export interface StuckAgent { cellId: string; kind: Exclude<StuckKind, 'waiting'>; code?: number; archived?: boolean; taskIds: string[] }

/**
 * The banner at the top of the tasks: one row per agent that does not run (never started, ended, closed) with its stuck
 * tasks, the oldest first; the agents in the order of their oldest stuck task. A task waiting for the user's answer is not
 * in it (its agent runs; the badge says it).
 */
export function stuckAgents(tasks: readonly AgentTask[], stuck: ReadonlyMap<string, Stuck>): StuckAgent[] {
  const agents = new Map<string, StuckAgent>();
  for (const task of [...tasks].sort((a, b) => a.createdAt - b.createdAt)) {
    const s = stuck.get(task.id);
    if (!s || s.kind === 'waiting') continue;
    const agent = agents.get(task.cellId);
    if (agent) agent.taskIds.push(task.id);
    else agents.set(task.cellId, { cellId: task.cellId, kind: s.kind, ...(s.code ? { code: s.code } : {}), ...(s.archived ? { archived: true } : {}), taskIds: [task.id] });
  }
  return [...agents.values()];
}

/** When the task entered its current state: a queued task when it was created, others at their last change (main bumps updatedAt on every status change). */
export const stateSince = (task: AgentTask): number => (task.status === 'queued' ? task.createdAt : task.updatedAt);

/** The Polish plural form of a count (1 zadanie, 2-4 zadania, 5 zadań, 12 zadań, 22 zadania); it picks the message key. */
export function polishPlural(n: number): 'one' | 'few' | 'many' {
  if (n === 1) return 'one';
  const tens = n % 100, ones = n % 10;
  return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? 'few' : 'many';
}
