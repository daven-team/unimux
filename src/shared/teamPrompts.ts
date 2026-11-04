// 1.1.4: the first prompt of an AI team agent, built by main from the inbox at every start instead of a one-shot copy kept
// on the cell (cell.startupPrompt is cleared after the first start, so a CLI that died before it worked restarted empty and
// its task stayed queued forever). New conversations get the tasks they have not claimed; a conversation the user resumes
// by hand gets a short "continue" note. The automatic resume at app start gets nothing (it must not spend usage by itself).
import { isClosedTask, taskPrompt, type AgentRole, type AgentTask } from './automation';

const line = (t: AgentTask) => `- ${t.id}: ${t.title}`;
const own = (tasks: readonly AgentTask[], cellId: string, status: AgentTask['status']) => tasks.filter((t) => t.cellId === cellId && t.status === status);

/**
 * The prompt a role cell's NEW conversation starts with: its queued tasks (one: that task's own prompt, as create_grid wrote
 * it; several: a list and read_inbox), tasks it had claimed before (in_progress) only as "continue". `fallback` is the cell's
 * stored startupPrompt: a plain text (a grid template's prompt) goes first; a copy of a task prompt is replaced by the inbox.
 * Undefined when there is nothing to say.
 */
/** Queued tasks of the cell whose prerequisites (dependsOn) all completed: the ones a new start may hand over. */
export function readyStartupTasks(tasks: readonly AgentTask[], cellId: string): AgentTask[] {
  const done = new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id));
  return own(tasks, cellId, 'queued').filter((t) => (t.dependsOn ?? []).every((id) => done.has(id)));
}

export function startupTaskPrompt(tasks: readonly AgentTask[], cellId: string, role: AgentRole, fallback?: string): string | undefined {
  // A task still waiting for its prerequisites is not handed over at the start (it is delivered once they complete; the
  // stored prompt of such a cell tells it to wait).
  const queued = readyStartupTasks(tasks, cellId);
  const claimed = own(tasks, cellId, 'in_progress');
  const plain = fallback?.trim() && !fallback.trimStart().startsWith('[Unimux task ') ? fallback.trim() : undefined;
  if (!queued.length && !claimed.length) return fallback?.trim() ? fallback : undefined;
  let body: string;
  if (queued.length === 1 && !claimed.length) body = taskPrompt(queued[0]);
  else {
    const parts = [`[Unimux tasks] You have ${queued.length + claimed.length} open tasks in unimux.`];
    if (queued.length) parts.push(`New tasks:\n${queued.map(line).join('\n')}`);
    if (claimed.length) parts.push(`Tasks you had already started (in_progress) before this agent started again; continue them:\n${claimed.map(line).join('\n')}`);
    parts.push('Unimux MCP: call read_inbox to read each task prompt, then work through them: update_task in_progress before working on a new one; '
      + 'finish each with completed (result: summary, files, tests, branch/commit) or blocked (blockedReason). Claim a task only after its dependsOn tasks completed. '
      + (role === 'coordinator' ? 'Follow your delegation rules.' : 'Do not create agents unless explicitly asked.'));
    body = parts.join('\n\n');
  }
  return plain ? `${plain}\n\n${body}` : body;
}

/**
 * The note a RESUMED conversation gets when the user restarted the agent (restartAgentWithTasks): its open tasks, and for a
 * coordinator the open tasks it gave others (it was waiting for them). Undefined when nothing is open.
 */
export function resumeTaskPrompt(tasks: readonly AgentTask[], cellId: string, role: AgentRole): string | undefined {
  const mine = tasks.filter((t) => t.cellId === cellId && (t.status === 'queued' || t.status === 'in_progress'));
  const waiting = role === 'coordinator' ? tasks.filter((t) => t.fromCellId === cellId && t.cellId !== cellId && !isClosedTask(t)) : [];
  if (!mine.length && !waiting.length) return undefined;
  const parts = ['unimux: this agent was restarted and the conversation resumed.'];
  if (mine.length) parts.push(`Your open tasks: ${mine.map((t) => `${t.id} ${t.title} (${t.status})`).join('; ')}. Continue them (read_inbox shows them).`);
  if (waiting.length) parts.push(`You were waiting for tasks ${waiting.map((t) => t.id).join(', ')}: call wait_for with these taskIds.`);
  return parts.join(' ');
}
