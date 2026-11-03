// The logic of the "Zespół AI" panel (1.1.2, AutomationPanel.tsx): tasks grouped by state, message threads per agent, the
// agent filter, and the texts the quick actions copy. Pure functions over the persisted automation state, tested in Node.
import { isClosedTask, type AgentMessage, type AgentTask, type AutomationEvent, type TaskResult } from './automation';

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

/** "Przydziel ponownie" of a closed task: a new task with the same agent, title and instructions (closed tasks never reopen). */
export function reassignInput(task: AgentTask): { cellId: string; title: string; prompt: string } {
  return { cellId: task.cellId, title: task.title, prompt: task.prompt };
}

/** Counts for the tabs: open tasks (not closed) and unread messages, of one agent when filtered. */
export function teamCounts(tasks: readonly AgentTask[], messages: readonly AgentMessage[], filterCellId?: string | null): { openTasks: number; unread: number } {
  return {
    openTasks: tasks.filter((t) => !isClosedTask(t) && (!filterCellId || taskConcerns(t, filterCellId))).length,
    unread: messages.filter((m) => !m.readAt && (!filterCellId || messageConcerns(m, filterCellId))).length,
  };
}
