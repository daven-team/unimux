import { z } from 'zod';

export type AgentRole = 'coordinator' | 'worker';
export type TaskStatus = 'queued' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export interface TaskResult {
  summary: string;
  files: string[];
  tests: string[];
  branch?: string;
  commit?: string;
}
export interface AgentTask {
  id: string;
  projectId: string;
  cellId: string;
  fromCellId?: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  dependsOn?: string[];
  delivery: 'pending' | 'startup' | 'native' | 'pasted';
  deliveryError?: string;
  blockedReason?: string;
  result?: TaskResult;
  createdAt: number;
  updatedAt: number;
}
export interface AgentMessage {
  id: string;
  projectId: string;
  toCellId: string;
  fromCellId?: string;
  text: string;
  readAt?: number;
  delivery: 'pending' | 'native' | 'pasted';
  deliveryError?: string;
  createdAt: number;
}
export interface AutomationEvent {
  id: string;
  projectId: string;
  cellId?: string;
  action: string;
  detail: string;
  createdAt: number;
}
export interface AutomationState {
  paused: boolean;
  tasks: AgentTask[];
  messages: AgentMessage[];
  events: AutomationEvent[];
}
/** `starting`: the first start of this run has not finished yet (not shown as unavailable). */
export interface McpInfo { running: boolean; starting?: boolean; url?: string; error?: string; configuredCellIds?: string[]; connectedCellIds?: string[] }
export type AgentRuntimeStatus = 'starting' | 'working' | 'ready' | 'needs_attention' | 'unknown' | 'exited';

/** Longest bounded wait; below the default 60 s tool timeout of Codex and the HTTP stack. */
export const WAIT_MAX_SECONDS = 45;
const id = z.string().min(1).max(128);
const PROJECT_ITEM_LIMIT_SCHEMA = 500;
const name = z.string().trim().min(1).max(140);
const text = z.string().trim().min(1).max(32000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const model = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const role = z.enum(['coordinator', 'worker']);
export const taskResultSchema = z.object({
  summary: text,
  files: z.array(z.string().max(1000)).max(200).default([]),
  tests: z.array(z.string().max(2000)).max(100).default([]),
  branch: z.string().max(200).optional(),
  commit: z.string().max(128).optional(),
}).strict();
const gridCell = z.object({
  profileId: id, name: name.optional(), role: role.optional(), color: color.optional(), model: model.optional(),
  prompt: text.optional(), worktree: z.boolean().default(false),
  // 1.1.1, grid templates opened by the user: an absolute start folder (refused for agents) and muted alerts.
  dir: z.string().min(1).max(1000).optional(), muted: z.literal(true).optional(),
}).strict();
/** A cell launched by an agent: `after` lists positions (0-based, earlier cells only) whose startup tasks must finish first. */
const launchCell = gridCell.extend({ after: z.array(z.number().int().min(0).max(19)).max(19).optional() }).strict();
const sizes = z.array(z.number().positive().finite().max(1e6)).max(60);
const gridLayout = z.object({
  cols: z.number().int().min(1).max(60), rows: z.number().int().min(1).max(4),
  areas: z.array(z.object({ col: z.number().int().min(0).max(59), row: z.number().int().min(0).max(3),
    colSpan: z.number().int().min(1).max(60), rowSpan: z.number().int().min(1).max(4) }).strict()).min(1).max(20),
  rowCounts: z.array(z.number().int().min(1).max(5)).min(1).max(4).optional(),
  // 1.1.1: the dragged track sizes a grid template keeps.
  rowSizes: sizes.optional(), colSizes: sizes.optional(), rowColSizes: z.array(sizes.nullable()).max(60).optional(),
  colRowSizes: z.array(sizes.nullable()).max(60).optional(), mode: z.literal('cols').optional(),
}).strict();
export const automationSchemas = {
  get_context: z.object({}).strict(),
  read_inbox: z.object({ acknowledge: z.boolean().default(false), openOnly: z.boolean().default(false), ackMaxChars: z.number().int().min(1).max(32000).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict(),
  list_agents: z.object({ projectId: id.optional() }).strict(),
  list_library: z.object({ projectId: id.optional() }).strict(),
  get_snippet: z.object({ snippetId: id }).strict(),
  apply_snippet: z.object({ snippetId: id, cellId: id }).strict(),
  create_grid: z.object({
    projectId: id.optional(), name, color: color.optional(), cells: z.array(launchCell).min(1).max(20).optional(), presetId: id.optional(),
    rows: z.array(z.number().int().min(1).max(5)).min(1).max(4).optional(),
    layout: gridLayout.optional(),
  }).strict(),
  close_grid: z.object({ gridId: id, cancelTasks: z.boolean().default(false) }).strict(),
  add_agents: z.object({ gridId: id, cells: z.array(launchCell).min(1).max(20),
    rows: z.array(z.number().int().min(1).max(5)).min(1).max(4).optional(), layout: gridLayout.optional(), }).strict(),
  update_grid: z.object({ gridId: id, name: name.optional(), color: color.nullable().optional() }).strict(),
  update_agent: z.object({ cellId: id, name: name.optional(), color: color.nullable().optional(),
    profileId: id.optional(), model: model.nullable().optional(), restart: z.boolean().default(false) }).strict(),
  save_snippet: z.object({
    projectId: id.optional(), id: id.optional(), name, text,
    autoSend: z.boolean().default(false), icon: z.string().max(32).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).strict(),
  save_preset: z.object({
    projectId: id.optional(), id: id.optional(), name, cells: z.array(gridCell).min(1).max(20),
    rows: z.array(z.number().int().min(1).max(5)).min(1).max(4).optional(),
  }).strict(),
  create_task: z.object({ cellId: id, title: name, prompt: text, dependsOn: z.array(id).max(50).optional() }).strict(),
  get_tasks: z.object({ readyOnly: z.boolean().default(false), projectId: id.optional(), cellId: id.optional(), ids: z.array(id).min(1).max(50).optional(), status: z.enum(['queued', 'in_progress', 'blocked', 'completed', 'cancelled']).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict(),
  update_task: z.object({ taskId: id, status: z.enum(['in_progress', 'blocked', 'completed', 'cancelled']), blockedReason: text.optional(), result: taskResultSchema.optional() }).strict(),
  send_message: z.object({ toCellId: id, text }).strict(),
  get_messages: z.object({ projectId: id.optional(), unreadOnly: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict(),
  acknowledge_message: z.object({ messageId: id }).strict(),
  set_paused: z.object({ paused: z.boolean() }).strict(),
  set_role: z.object({ cellId: id, role: role.nullable() }).strict(),
  deliver_task: z.object({ taskId: id }).strict(),
  deliver_message: z.object({ messageId: id }).strict(),
  wait_for: z.object({ taskIds: z.array(id).min(1).max(50).optional(), all: z.boolean().default(false), timeoutSec: z.number().int().min(1).max(WAIT_MAX_SECONDS).default(30) }).strict(),
  mark_pasted: z.object({ kind: z.enum(['task', 'message']), id }).strict(),
  /** The user removes finished items (closed tasks, read messages) of a project: the listed ones, or all of them. */
  remove_items: z.object({ projectId: id, kind: z.enum(['task', 'message']), ids: z.array(id).min(1).max(PROJECT_ITEM_LIMIT_SCHEMA).optional() }).strict(),
} as const;
export type AutomationOperation = keyof typeof automationSchemas;
export type AutomationInput<K extends AutomationOperation> = z.input<(typeof automationSchemas)[K]>;

export const defaultAutomation = (): AutomationState => ({ paused: false, tasks: [], messages: [], events: [] });

/** Tasks and messages kept per project; finished ones make room for new ones (see pruneAutomation). */
export const PROJECT_ITEM_LIMIT = PROJECT_ITEM_LIMIT_SCHEMA;
/** Finished tasks and read messages older than this are dropped. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLOSED_STATUSES = new Set<TaskStatus>(['completed', 'cancelled']);
export const isClosedTask = (task: AgentTask): boolean => CLOSED_STATUSES.has(task.status);

/**
 * Retention of the inboxes. Items of projects that no longer exist go; per project, closed tasks (completed / cancelled) and
 * read messages older than RETENTION_MS go, and beyond PROJECT_ITEM_LIMIT the oldest finished ones go first (`room` keeps that
 * many places free for items about to be added). Open tasks, unread messages and closed tasks that an open task still depends on
 * always stay. Returns the same object when nothing was dropped.
 */
export function pruneAutomation(automation: AutomationState, projectIds: ReadonlySet<string>, now: number, room: { tasks?: Record<string, number>; messages?: Record<string, number> } = {}): AutomationState {
  const needed = new Set<string>();
  for (const task of automation.tasks) if (!isClosedTask(task)) for (const id of task.dependsOn ?? []) needed.add(id);
  const keep = <T extends { id: string; projectId: string }>(items: T[], finished: (item: T) => boolean, finishedAt: (item: T) => number, free: Record<string, number> = {}): T[] => {
    const byProject = new Map<string, T[]>();
    for (const item of items) {
      if (!projectIds.has(item.projectId)) continue;
      const list = byProject.get(item.projectId) ?? [];
      list.push(item);
      byProject.set(item.projectId, list);
    }
    const dropped = new Set<T>();
    for (const [projectId, list] of byProject) {
      const removable = list.filter((item) => finished(item) && !needed.has(item.id));
      for (const item of removable) if (now - finishedAt(item) > RETENTION_MS) dropped.add(item);
      let over = list.length - dropped.size - (PROJECT_ITEM_LIMIT - (free[projectId] ?? 0));
      if (over > 0) {
        for (const item of [...removable].sort((a, b) => finishedAt(a) - finishedAt(b))) {
          if (over <= 0) break;
          if (dropped.has(item)) continue;
          dropped.add(item);
          over--;
        }
      }
    }
    const kept = items.filter((item) => projectIds.has(item.projectId) && !dropped.has(item));
    return kept.length === items.length ? items : kept;
  };
  const tasks = keep(automation.tasks, isClosedTask, (t) => t.updatedAt, room.tasks);
  const messages = keep(automation.messages, (m) => m.readAt !== undefined, (m) => m.readAt ?? m.createdAt, room.messages);
  const events = automation.events.some((e) => !projectIds.has(e.projectId)) ? automation.events.filter((e) => projectIds.has(e.projectId)) : automation.events;
  return tasks === automation.tasks && messages === automation.messages && events === automation.events ? automation : { ...automation, tasks, messages, events };
}

/** How many tasks or messages a project holds. */
export const projectCount = (items: ReadonlyArray<{ projectId: string }>, projectId: string): number => items.reduce((n, item) => n + (item.projectId === projectId ? 1 : 0), 0);
export const taskPrompt = (task: AgentTask): string =>
  `[Unimux task ${task.id}] ${task.title}\n\n${task.prompt}\n\n` +
  'Unimux MCP: update_task in_progress before working; finish with completed (result: summary, files, tests, branch/commit) or blocked (blockedReason). ' +
  'read_inbox for new tasks and messages; wait_for instead of polling. Claim a task only after its dependsOn tasks completed. Do not create agents unless explicitly asked.';
