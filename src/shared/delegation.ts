// 1.1.4: how a coordinator delegates (Settings > Agenci). "ask": only when the user asked for it (the behaviour up to 1.1.3).
// "auto" (the default): the coordinator itself starts a team when a task is large and splits into independent parts, with at
// most `maxAgents` agents at once, and always tells the user what it delegated. The rules reach a coordinator through its
// system instructions at launch (Claude --append-system-prompt, Codex developer_instructions) and the MCP server instructions;
// the limit is enforced by create_grid / create_task (teamLimit, delegationRefusal).
import { isClosedTask, type AgentTask } from './automation';

export type DelegationMode = 'ask' | 'auto';
export interface DelegationSettings {
  mode: DelegationMode;
  /** Most agents a coordinator uses at once (1-20). */
  maxAgents: number;
}
export const DELEGATION_MODES: readonly DelegationMode[] = ['auto', 'ask'];
export const MAX_AGENTS_MIN = 1;
export const MAX_AGENTS_MAX = 20;
export const DEFAULT_DELEGATION: DelegationSettings = { mode: 'auto', maxAgents: 4 };

export function normalizeMaxAgents(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_DELEGATION.maxAgents;
  return Math.max(MAX_AGENTS_MIN, Math.min(MAX_AGENTS_MAX, Math.round(n)));
}

/** A saved value, or the default for anything missing or unknown (state.json of 1.1.3 and older has none). */
export function normalizeDelegation(value: unknown): DelegationSettings {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    mode: DELEGATION_MODES.includes(v.mode as DelegationMode) ? (v.mode as DelegationMode) : DEFAULT_DELEGATION.mode,
    maxAgents: v.maxAgents === undefined ? DEFAULT_DELEGATION.maxAgents : normalizeMaxAgents(v.maxAgents),
  };
}

type WithSettings = { settings: { delegation?: Partial<DelegationSettings> } };
export const delegationOf = (state: WithSettings): DelegationSettings => normalizeDelegation(state.settings.delegation);

/** The most agents a coordinator may use at once (Settings > Agenci), for create_grid and create_task. */
export const teamLimit = (state: WithSettings): number => delegationOf(state).maxAgents;

/** Cells (other than the coordinator) that hold an open task the coordinator gave them: the agents it uses right now. */
export function busyAgents(tasks: readonly AgentTask[], coordinatorId: string): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) if (t.fromCellId === coordinatorId && t.cellId !== coordinatorId && !isClosedTask(t)) ids.add(t.cellId);
  return ids;
}

/**
 * Why a coordinator's create_grid / add_agents (`newAgents` new cells) or create_task (to `taskCellId`) would go over the
 * limit, or null when it may go on. Counts the agents with open tasks from this coordinator plus the new ones. Only for
 * calls of an agent: the user's own grids and tasks are never limited.
 */
export function delegationRefusal(state: WithSettings & { automation: { tasks: readonly AgentTask[] } }, coordinatorId: string,
  add: { newAgents?: number; taskCellId?: string }): string | null {
  const limit = teamLimit(state);
  const busy = busyAgents(state.automation.tasks, coordinatorId);
  let total = busy.size + Math.max(0, add.newAgents ?? 0);
  if (add.taskCellId && add.taskCellId !== coordinatorId && !busy.has(add.taskCellId)) total++;
  if (total <= limit) return null;
  return `Team limit: at most ${limit} agents at once (the user's setting in Settings > Agents). ${busy.size} already hold open tasks from you. `
    + 'Wait for them (wait_for) or give the work to agents you already use, or do it yourself.';
}

/** Characters no shell may see inside the quoted rules (cmd expands % and !, the others end or change a quoted argument). */
const UNSAFE = /["'`%^!&|<>\r\n\t$\\]+/g;
export const shellSafeText = (text: string): string => text.replace(UNSAFE, ' ').replace(/ {2,}/g, ' ').trim();

/**
 * The coordinator's delegation rules for its system instructions at launch; null in "ask" mode (the MCP instructions keep
 * the old rule then). One line of plain words: it is passed as one quoted argument in every shell.
 */
export function coordinatorSystemRules(d: DelegationSettings): string | null {
  if (d.mode !== 'auto') return null;
  return shellSafeText(`unimux delegation rules for you as the coordinator of this unimux team: when a task is large and splits into independent parts, `
    + `delegate on your own without waiting to be asked: start a team with the unimux MCP tool create_grid, or give parts to workers that already exist with create_task. `
    + `Use at most ${d.maxAgents} agents at once. Do small tasks yourself. Never create agents only to wait on them. `
    + `Always tell the user what you delegated, to which agents and why, then follow the tasks with wait_for.`);
}

/** roleNote.coordinator of the MCP server instructions, per mode. */
export function coordinatorRoleNote(d: DelegationSettings): string {
  const base = 'You are a coordinator: you may assign tasks (create_task), add agents/grids and edit peers. ';
  if (d.mode === 'ask') return base + 'Create agents only when the user asked to delegate (it spends model usage); never create agents to wait on them.';
  return base + `Delegate on your own when a task is large and splits into independent parts (create_grid, or create_task to existing workers), at most ${d.maxAgents} agents at once; `
    + 'do small tasks yourself; always tell the user what you delegated. Never create agents to wait on them.';
}
