import { automationSchemas, isClosedTask, projectCount, pruneAutomation, PROJECT_ITEM_LIMIT, taskPrompt, type AgentMessage, type AgentRole, type AgentRuntimeStatus, type AgentTask, type AutomationOperation, type AutomationState } from '../shared/automation';
import { CELL_COLORS, closeTab, addTab, findCell, getProfile, setActiveTab, uid, updateCell, upsertPreset, upsertSnippet } from '../shared/state';
import { layoutForCount, layoutFromRows } from '../shared/layout';
import type { AppState, Cell, Tab, Worktree } from '../shared/types';
import { CLI_NAMES, type CliId } from '../shared/cliStatus';
import type { StateController } from './stateController';
import type { ContextUsage } from '../shared/contextUsage';

export interface AutomationDependencies {
  createWorktree(path: string, name: string): Promise<Worktree>;
  removeWorktree(path: string, worktree: Worktree): Promise<void>;
  startCells(ids: string[]): void;
  /** The CLI a profile needs when it is known not to be installed (cached knowledge only, never blocks). */
  missingCli?(profileId: string): CliId | undefined;
  stopCells?(ids: string[]): Promise<void>;
  isCellRunning?(cellId: string): boolean;
  /** How full the context window of the cell's conversation is, when known. */
  contextOf?(cellId: string): ContextUsage | null;
  /** Runtime must verify a confirmed, compatible session before killing and relaunching; never type a shell command. */
  restartAgent?(cellId: string): Promise<{ restarted: boolean; reason?: string }>;
  deliver(cellId: string, text: string): Promise<void>;
}
/** list_agents: the context window use of an agent's conversation, when known. */
const contextField = (usage: ContextUsage | null | undefined) =>
  usage ? { context: { percent: usage.percent, tokens: usage.tokens, window: usage.window } } : {};
const READS = new Set<AutomationOperation>(['get_context', 'read_inbox', 'list_agents', 'list_library', 'get_snippet', 'get_tasks', 'get_messages', 'wait_for']);
const CLOSED = new Set(['completed', 'cancelled']);
/** wait_for wakes on every state change; this safety tick only covers a change it could have missed. */
const WAIT_POLL_MS = 1000;
const UI_ONLY = new Set<AutomationOperation>(['set_paused', 'set_role', 'mark_pasted', 'remove_items']);
const taskLimit = `Task limit reached (${PROJECT_ITEM_LIMIT} open tasks in this project). Complete or cancel some first.`;
const messageLimit = `Message limit reached (${PROJECT_ITEM_LIMIT} unread messages in this project). Read some first.`;

/** How long an identical create_grid / add_agents / close_grid call of the same agent returns the first call's answer. */
export const IDEMPOTENT_MS = 5 * 60_000;
const CANCELLED = 'The request ended (the MCP client disconnected or timed out) before the grid was created; nothing was kept. Retry if it is still wanted.';
interface IdempotentEntry { at: number; controller: AbortController; callers: number; running: boolean; abandoned: boolean; result: Promise<unknown> }

/** Runtime statuses of the cells; `onChange` hears every real change (the Automation panel is told instead of polling). */
export class StatusMap extends Map<string, AgentRuntimeStatus> {
  onChange?: () => void;
  override set(key: string, value: AgentRuntimeStatus): this {
    const changed = super.get(key) !== value;
    super.set(key, value);
    if (changed) this.onChange?.();
    return this;
  }
  override delete(key: string): boolean {
    const deleted = super.delete(key);
    if (deleted) this.onChange?.();
    return deleted;
  }
}

export class AutomationService {
  readonly statuses = new StatusMap();
  private pendingRestart = new Set<string>();
  /** Call on a confirmed runtime spawn so a user-initiated restart clears deferred launch settings. */
  runtimeStarted(cellId: string): void { this.pendingRestart.delete(cellId); this.seenInbox.delete(cellId); }
  /** The cell left the state for good. */
  forgetCell(cellId: string): void { this.pendingRestart.delete(cellId); this.seenInbox.delete(cellId); this.statuses.delete(cellId); }
  /** Inbox items (unread message ids, startable task ids) an agent has already been shown; wait_for reports only new ones. */
  private seenInbox = new Map<string, Set<string>>();
  private seen(cellId: string): Set<string> {
    let ids = this.seenInbox.get(cellId);
    if (!ids) { ids = new Set(); this.seenInbox.set(cellId, ids); }
    return ids;
  }
  private delivering = new Set<string>();
  private recent = new Map<string, IdempotentEntry>();
  constructor(readonly state: StateController, private readonly deps: AutomationDependencies) {}

  private actor(cellId: string) {
    const found = findCell(this.state.get(), cellId);
    if (!found || !found.cell.role || !!found.cell.ssh || getProfile(this.state.get(), found.cell.profileId).cli === 'shell') throw new Error('Agent MCP integration is disabled or the cell is no longer available.');
    return found;
  }
  /** The MCP role of a cell, or undefined while MCP is disabled for it (used to decide which tools the agent sees). */
  roleOf(cellId: string): AgentRole | undefined {
    try { return this.actor(cellId).cell.role; } catch { return undefined; }
  }
  private role(cellId: string) {
    return this.actor(cellId).cell.role;
  }
  private project(projectId: string | undefined, actorId?: string) {
    const own = actorId ? this.actor(actorId).project : undefined;
    const id = projectId ?? own?.id;
    if (!id || (own && own.id !== id)) throw new Error('Project access denied.');
    const project = this.state.get().projects.find((p) => p.id === id);
    if (!project) throw new Error('Project not found.');
    return project;
  }
  private target(cellId: string, actorId?: string) {
    const found = findCell(this.state.get(), cellId);
    if (!found || !found.cell.role || !!found.cell.ssh || getProfile(this.state.get(), found.cell.profileId).cli === 'shell') throw new Error('Target must be an active agent cell with MCP enabled.');
    this.project(found.project.id, actorId);
    return found;
  }
  private coordinator(actorId?: string) {
    if (actorId && this.role(actorId) !== 'coordinator') throw new Error('This operation requires the coordinator role.');
  }
  private log(state: AppState, projectId: string, action: string, detail: string, cellId?: string): AppState {
    return { ...state, automation: { ...state.automation, events: [...state.automation.events,
      { id: uid(), projectId, action, detail, cellId, createdAt: Date.now() }].slice(-200) } };
  }

  async execute<K extends AutomationOperation>(operation: K, input: unknown, actorId?: string, signal?: AbortSignal): Promise<unknown> {
    const args = automationSchemas[operation].parse(input);
    if (actorId) {
      this.actor(actorId);
      if (UI_ONLY.has(operation)) throw new Error('This operation is controlled by the user.');
    }
    if (this.state.get().automation.paused && !READS.has(operation) && !['set_paused', 'set_role', 'update_task', 'acknowledge_message', 'remove_items'].includes(operation) && !(operation === 'create_grid' && !actorId)) {
      throw new Error('Automation is paused by the user.');
    }
    switch (operation) {
      case 'get_context': {
        if (!actorId) return { paused: this.state.get().automation.paused };
        const { project, cell, tab } = this.actor(actorId);
        return { cellId: cell.id, role: this.role(actorId), projectId: project.id, projectName: project.name,
          cwd: cell.worktree?.path ?? project.path, gridId: tab.id, profileId: cell.profileId, model: cell.model, paused: this.state.get().automation.paused,
          profiles: this.state.get().profiles.map(({ id, name, cli }) => ({ id, name, cli })) };
      }
      case 'read_inbox': {
        if (!actorId) throw new Error('Inbox requires an authenticated agent.');
        const a = automationSchemas.read_inbox.parse(input);
        const { project } = this.actor(actorId);
        const snapshot = this.state.get();
        const own = snapshot.automation.tasks.filter((t) => t.projectId === project.id && t.cellId === actorId && (!a.openOnly || !CLOSED.has(t.status)));
        const tasks = own.slice(a.offset, a.offset + a.limit).map((t) => this.listed(t));
        const unread = snapshot.automation.messages.filter((m) => m.projectId === project.id && m.toCellId === actorId && !m.readAt);
        const messages = unread.slice(a.offset, a.offset + a.limit);
        // A message longer than ackMaxChars was only shown clipped by the caller: it stays unread until fetched in full.
        const acknowledgedMessageIds = a.acknowledge ? messages.filter((m) => a.ackMaxChars === undefined || m.text.length <= a.ackMaxChars).map((m) => m.id) : [];
        const readAt = Date.now();
        if (acknowledgedMessageIds.length) {
          const ids = new Set(acknowledgedMessageIds);
          this.state.change((s) => ({ ...s, automation: { ...s.automation, messages: s.automation.messages.map((m) => ids.has(m.id) && m.toCellId === actorId ? { ...m, readAt } : m) } }));
        }
        const seen = this.seen(actorId);
        for (const m of messages) seen.add(m.id);
        for (const t of tasks) if (t.ready) seen.add(t.id);
        return { tasks, messages: messages.map((m) => acknowledgedMessageIds.includes(m.id) ? { ...m, readAt } : m), acknowledgedMessageIds,
          hasMoreTasks: own.length > a.offset + a.limit,
          hasMoreMessages: unread.length > a.offset + a.limit };
      }
      case 'list_agents': {
        const a = args as { projectId?: string };
        const project = this.project(a.projectId, actorId);
        return project.tabs.flatMap((tab) => tab.cells.filter((cell) => !cell.ssh && getProfile(this.state.get(), cell.profileId).cli !== 'shell').map((cell) => ({
          cellId: cell.id, name: cell.name ?? getProfile(this.state.get(), cell.profileId).name,
          gridId: tab.id, gridName: tab.name, gridColor: tab.color, profileId: cell.profileId, model: cell.model, color: cell.color,
          role: cell.role ?? null,
          status: this.statuses.get(cell.id) ?? 'unknown', cwd: cell.worktree?.path ?? project.path,
          ...contextField(this.deps.contextOf?.(cell.id)),
          tasks: this.state.get().automation.tasks.filter((t) => t.cellId === cell.id && !CLOSED.has(t.status)).map(({ id, title, status }) => ({ id, title, status })),
        })));
      }
      case 'list_library': {
        const project = this.project((args as { projectId?: string }).projectId, actorId);
        return { snippets: this.state.get().snippets.filter((s) => !s.projectId || s.projectId === project.id).map(({ id, name, autoSend, projectId }) => ({ id, name, autoSend, projectId })),
          // SSH hosts never reach MCP (R4, spec 11): preset cells lose their host reference.
          presets: this.state.get().presets.filter((p) => !p.projectId || p.projectId === project.id).map((p) => ({ ...p, cells: p.cells.map(({ sshHostId: _ssh, ...cell }) => cell) })) };
      }
      case 'get_snippet': {
        const { snippetId } = automationSchemas.get_snippet.parse(input);
        const snippet = this.state.get().snippets.find((s) => s.id === snippetId);
        if (!snippet) throw new Error('Snippet not found.');
        if (actorId && snippet.projectId) this.project(snippet.projectId, actorId);
        return snippet;
      }
      case 'apply_snippet': {
        const { snippetId, cellId } = automationSchemas.apply_snippet.parse(input);
        const found = this.target(cellId, actorId);
        const snippet = this.state.get().snippets.find((s) => s.id === snippetId);
        if (!snippet || (snippet.projectId && snippet.projectId !== found.project.id)) throw new Error('Snippet not found in this project.');
        return this.execute('create_task', { cellId, title: snippet.name, prompt: snippet.text }, actorId);
      }
      case 'close_grid': {
        const a = automationSchemas.close_grid.parse(input);
        // Not cancelled by a disconnect: stopped agents are archived either way; a retry gets the first answer.
        return this.idempotent(operation, a, actorId, undefined, () => this.closeGrid(a, actorId));
      }
      case 'add_agents': {
        const a = automationSchemas.add_agents.parse(input);
        return this.idempotent(operation, a, actorId, signal, (combined) => this.createGrid({ ...a, name: '' }, actorId, combined));
      }
      case 'update_grid': {
        this.coordinator(actorId);
        const a = automationSchemas.update_grid.parse(input);
        const { project, tab } = this.grid(a.gridId, actorId);
        const patch = { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.color !== undefined ? { color: a.color ?? undefined } : {}) };
        this.state.change((s) => this.log({ ...s, projects: s.projects.map((p) => p.id === project.id ? { ...p, tabs: p.tabs.map((t) => t.id === tab.id ? { ...t, ...patch } : t) } : p) }, project.id, 'grid_updated', a.name ?? tab.name, actorId));
        return { gridId: tab.id, ...patch };
      }
      case 'update_agent': return this.updateAgent(automationSchemas.update_agent.parse(input), actorId);
      case 'create_grid': {
        const a = automationSchemas.create_grid.parse(input);
        return this.idempotent(operation, a, actorId, signal, (combined) => this.createGrid(a, actorId, combined));
      }
      case 'save_snippet': {
        const a = automationSchemas.save_snippet.parse(input);
        const project = this.project(a.projectId, actorId);
        const existing = this.state.get().snippets.find((s) => s.id === a.id);
        if (existing && existing.projectId !== project.id) throw new Error('Snippet belongs to another scope.');
        const snippet = { ...a, id: a.id ?? uid(), projectId: project.id };
        this.state.change((s) => this.log(upsertSnippet(s, snippet), project.id, 'snippet', snippet.name, actorId));
        return snippet;
      }
      case 'save_preset': {
        this.coordinator(actorId);
        const a = automationSchemas.save_preset.parse(input);
        const project = this.project(a.projectId, actorId);
        const existing = this.state.get().presets.find((p) => p.id === a.id);
        if (existing && existing.projectId !== project.id) throw new Error('Preset belongs to another scope.');
        this.validateCells(a.cells);
        const layout = this.layout(a.cells.length, a.rows);
        const preset = { id: a.id ?? uid(), name: a.name, projectId: project.id, layout, cells: a.cells };
        this.state.change((s) => this.log(upsertPreset(s, preset), project.id, 'preset', preset.name, actorId));
        return preset;
      }
      case 'create_task': {
        const a = automationSchemas.create_task.parse(input);
        const found = this.target(a.cellId, actorId);
        if (actorId && actorId !== a.cellId) this.coordinator(actorId);
        for (const dependencyId of a.dependsOn ?? []) {
          const dependency = this.state.get().automation.tasks.find((t) => t.id === dependencyId);
          if (!dependency || dependency.projectId !== found.project.id) throw new Error('Task dependencies must exist in this project.');
        }
        const task: AgentTask = { ...a, ...(a.dependsOn ? { dependsOn: [...new Set(a.dependsOn)] } : {}), id: uid(), projectId: found.project.id, fromCellId: actorId,
          status: 'queued', delivery: 'pending', createdAt: Date.now(), updatedAt: Date.now() };
        this.state.change((s) => {
          const automation = this.makeRoom(s, { tasks: { [found.project.id]: 1 } });
          if (projectCount(automation.tasks, found.project.id) >= PROJECT_ITEM_LIMIT) throw new Error(taskLimit);
          return this.log({ ...s, automation: { ...automation, tasks: [...automation.tasks, task] } }, found.project.id, 'task_created', task.title, actorId);
        });
        await this.deliver('task', task.id, actorId);
        return this.state.get().automation.tasks.find((t) => t.id === task.id);
      }
      case 'get_tasks': {
        const a = automationSchemas.get_tasks.parse(input);
        const project = this.project(a.projectId, actorId);
        return this.state.get().automation.tasks.filter((t) => t.projectId === project.id && (!a.cellId || t.cellId === a.cellId) &&
          (!a.ids || a.ids.includes(t.id)) && (!a.status || t.status === a.status) && (!actorId || this.role(actorId) === 'coordinator' || t.cellId === actorId))
          .map((t) => this.listed(t))
          .filter((t) => !a.readyOnly || t.ready).slice(a.offset, a.offset + a.limit);
      }
      case 'update_task': {
        const a = automationSchemas.update_task.parse(input);
        const task = this.state.get().automation.tasks.find((t) => t.id === a.taskId);
        if (!task) throw new Error('Task not found.');
        this.project(task.projectId, actorId);
        if (actorId && task.cellId !== actorId) this.coordinator(actorId);
        if (['completed', 'cancelled'].includes(task.status)) throw new Error('Task is already closed.');
        if (a.status === 'in_progress' && this.blockedBy(task).length) throw new Error('Task dependencies have not completed.');
        if (a.status === 'completed' && !a.result) throw new Error('Completed tasks require a result.');
        if (a.status === 'blocked' && !a.blockedReason) throw new Error('Blocked tasks require a reason.');
        const next: AgentTask = { ...task, status: a.status, result: a.result, blockedReason: a.blockedReason, updatedAt: Date.now() };
        this.state.change((s) => this.log({ ...s, automation: { ...s.automation, tasks: s.automation.tasks.map((t) => t.id === task.id ? next : t) } }, task.projectId, `task_${a.status}`, task.title, actorId));
        if (a.status !== 'cancelled') this.statuses.set(task.cellId, a.status === 'in_progress' ? 'working' : a.status === 'blocked' ? 'needs_attention' : 'ready');
        return next;
      }
      case 'send_message': {
        const a = automationSchemas.send_message.parse(input);
        const found = this.target(a.toCellId, actorId);
        const message: AgentMessage = { ...a, id: uid(), projectId: found.project.id, fromCellId: actorId, delivery: 'pending', createdAt: Date.now() };
        this.state.change((s) => {
          const automation = this.makeRoom(s, { messages: { [found.project.id]: 1 } });
          if (projectCount(automation.messages, found.project.id) >= PROJECT_ITEM_LIMIT) throw new Error(messageLimit);
          return this.log({ ...s, automation: { ...automation, messages: [...automation.messages, message] } }, found.project.id, 'message', message.text.slice(0, 140), actorId);
        });
        await this.deliver('message', message.id, actorId);
        return this.state.get().automation.messages.find((m) => m.id === message.id);
      }
      case 'get_messages': {
        const a = automationSchemas.get_messages.parse(input);
        const project = this.project(a.projectId, actorId);
        return this.state.get().automation.messages.filter((m) => m.projectId === project.id && (!actorId || m.toCellId === actorId) && (!a.unreadOnly || !m.readAt)).slice(a.offset, a.offset + a.limit);
      }
      case 'wait_for': return this.waitFor(automationSchemas.wait_for.parse(input), actorId, signal);
      case 'acknowledge_message': {
        const { messageId } = automationSchemas.acknowledge_message.parse(input);
        const message = this.state.get().automation.messages.find((m) => m.id === messageId);
        if (!message) throw new Error('Message not found.');
        this.project(message.projectId, actorId);
        if (actorId && message.toCellId !== actorId) throw new Error('Only the recipient can acknowledge a message.');
        this.state.change((s) => ({ ...s, automation: { ...s.automation, messages: s.automation.messages.map((m) => m.id === messageId ? { ...m, readAt: Date.now() } : m) } }));
        return { acknowledged: true };
      }
      case 'set_paused': {
        const { paused } = automationSchemas.set_paused.parse(input);
        this.state.change((s) => ({ ...s, automation: { ...s.automation, paused } }));
        return { paused };
      }
      case 'set_role': {
        const { cellId, role } = automationSchemas.set_role.parse(input);
        const found = findCell(this.state.get(), cellId);
        if (!found || !!found.cell.ssh || getProfile(this.state.get(), found.cell.profileId).cli === 'shell') throw new Error('Agent cell not found.');
        const { project } = found;
        this.state.change((s) => this.log(updateCell(s, cellId, { role: role ?? undefined }), project.id, 'role', role ?? 'disabled', cellId));
        return { cellId, role };
      }
      case 'deliver_task': return this.deliver('task', automationSchemas.deliver_task.parse(input).taskId, actorId);
      case 'deliver_message': return this.deliver('message', automationSchemas.deliver_message.parse(input).messageId, actorId);
      case 'remove_items': {
        const a = automationSchemas.remove_items.parse(input);
        const project = this.project(a.projectId, actorId);
        const ids = a.ids ? new Set(a.ids) : undefined;
        let removed = 0;
        this.state.change((s) => {
          // A closed task an open task still depends on stays (its result is what unblocks the other one).
          const needed = new Set(s.automation.tasks.filter((t) => !isClosedTask(t)).flatMap((t) => t.dependsOn ?? []));
          const gone = (item: { id: string; projectId: string }, finished: boolean) => item.projectId === project.id && finished && (!ids || ids.has(item.id)) && !needed.has(item.id);
          const tasks = a.kind === 'task' ? s.automation.tasks.filter((t) => !gone(t, isClosedTask(t))) : s.automation.tasks;
          const messages = a.kind === 'message' ? s.automation.messages.filter((m) => !gone(m, m.readAt !== undefined)) : s.automation.messages;
          removed = s.automation.tasks.length - tasks.length + s.automation.messages.length - messages.length;
          return removed ? { ...s, automation: { ...s.automation, tasks, messages } } : s;
        });
        return { removed };
      }
      case 'mark_pasted': {
        const a = automationSchemas.mark_pasted.parse(input);
        this.state.change((s) => ({ ...s, automation: { ...s.automation,
          tasks: a.kind === 'task' ? s.automation.tasks.map((t) => t.id === a.id ? { ...t, delivery: 'pasted', deliveryError: undefined } : t) : s.automation.tasks,
          messages: a.kind === 'message' ? s.automation.messages.map((m) => m.id === a.id ? { ...m, delivery: 'pasted', deliveryError: undefined } : m) : s.automation.messages,
        } }));
        return { pasted: true };
      }
    }
  }

  /** Retention runs on every insert: finished items make room, and items of removed projects go (see pruneAutomation). */
  private makeRoom(s: AppState, room: Parameters<typeof pruneAutomation>[3]): AutomationState {
    return pruneAutomation(s.automation, new Set(s.projects.map((p) => p.id)), Date.now(), room);
  }

  /**
   * A retried team call (same agent, operation and arguments) must not start a second team: while the first one runs, the retry
   * shares it (it is cancelled only when every caller left), and when a caller left before the answer, the finished result is
   * returned to an identical call within IDEMPOTENT_MS. A call whose answer was received is never replayed.
   */
  private idempotent<T>(operation: string, args: unknown, actorId: string | undefined, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [key, entry] of this.recent) if (now - entry.at > IDEMPOTENT_MS) this.recent.delete(key);
    const key = actorId ? `${actorId}\0${operation}\0${JSON.stringify(args)}` : undefined;
    let entry = key ? this.recent.get(key) : undefined;
    if (!entry || (entry.running && entry.controller.signal.aborted)) {
      const controller = new AbortController();
      const created: IdempotentEntry = { at: now, controller, callers: 0, running: true, abandoned: false, result: Promise.resolve() };
      // A finished call is remembered only when a caller left before its answer (a client that timed out and retries);
      // otherwise the next identical call is a deliberate new one (add_agents again, create_grid after close_grid).
      created.result = work(controller.signal).finally(() => {
        created.running = false;
        if (key && !created.abandoned && this.recent.get(key) === created) this.recent.delete(key);
      });
      if (key) {
        this.recent.set(key, created);
        created.result.catch(() => { if (this.recent.get(key) === created) this.recent.delete(key); });
      }
      entry = created;
    }
    const current = entry;
    if (current.running) {
      current.callers++;
      const leave = () => {
        if (!current.running) return;
        current.abandoned = true;
        if (--current.callers === 0) current.controller.abort();
      };
      if (!signal) current.callers++; // a caller without a signal never leaves
      else if (signal.aborted) leave();
      else {
        signal.addEventListener('abort', leave, { once: true });
        void current.result.finally(() => signal.removeEventListener('abort', leave)).catch(() => undefined);
      }
    }
    return current.result as Promise<T>;
  }

  private grid(gridId: string, actorId?: string) {
    const project = this.state.get().projects.find((p) => p.tabs.some((t) => t.id === gridId));
    if (!project) throw new Error('Grid not found.');
    this.project(project.id, actorId);
    return { project, tab: project.tabs.find((t) => t.id === gridId)! };
  }
  private async closeGrid(a: ReturnType<typeof automationSchemas.close_grid.parse>, actorId?: string) {
    this.coordinator(actorId);
    const { project, tab } = this.grid(a.gridId, actorId);
    if (actorId && tab.cells.some((c) => c.id === actorId)) throw new Error('A coordinator cannot close its own grid.');
    const ids = tab.cells.map((c) => c.id);
    const unfinished = () => this.state.get().automation.tasks.filter((t) => ids.includes(t.cellId) && !['completed', 'cancelled'].includes(t.status));
    if (!a.cancelTasks && unfinished().length) throw new Error('Grid has unfinished tasks. Complete them or explicitly set cancelTasks:true.');
    if (!this.deps.stopCells) throw new Error('Runtime grid shutdown is unavailable.');
    await this.deps.stopCells(ids);
    this.coordinator(actorId);
    const latest = this.grid(a.gridId, actorId);
    if (latest.tab.cells.map((c) => c.id).join() !== ids.join()) throw new Error('Grid changed during shutdown; retry after reviewing its agents.');
    if (!a.cancelTasks && unfinished().length) throw new Error('Grid received new unfinished tasks during shutdown.');
    this.state.change((s) => {
      const next = closeTab(s, project.id, tab.id);
      const tasks = next.automation.tasks.map((t) => a.cancelTasks && ids.includes(t.cellId) && !['completed', 'cancelled'].includes(t.status) ? { ...t, status: 'cancelled' as const, updatedAt: Date.now() } : t);
      return this.log({ ...next, automation: { ...next.automation, tasks } }, project.id, 'grid_closed', tab.name, actorId);
    });
    for (const id of ids) { this.statuses.set(id, 'exited'); this.pendingRestart.delete(id); }
    // SSH cells are closed too, but never named to MCP (spec 11).
    const sshIds = new Set(tab.cells.filter((c) => c.ssh).map((c) => c.id));
    return { archivedGridId: tab.id, stoppedCellIds: ids.filter((id) => !sshIds.has(id)) };
  }
  private async updateAgent(a: ReturnType<typeof automationSchemas.update_agent.parse>, actorId?: string) {
    if (actorId && actorId !== a.cellId) this.coordinator(actorId);
    // Launch settings decide what an agent may run: a worker must not change its own profile or model, or restart itself.
    if (actorId && (a.profileId !== undefined || a.model !== undefined || a.restart)) this.coordinator(actorId);
    const found = findCell(this.state.get(), a.cellId);
    if (!found || !!found.cell.ssh || getProfile(this.state.get(), found.cell.profileId).cli === 'shell') throw new Error('Agent cell not found.');
    this.project(found.project.id, actorId);
    if (a.profileId !== undefined) {
      const profile = this.state.get().profiles.find((p) => p.id === a.profileId);
      if (!profile || profile.cli === 'shell') throw new Error('Choose an AI agent profile.');
    }
    const patch: Partial<Cell> = {};
    if (a.name !== undefined) patch.name = a.name;
    if (a.color !== undefined) patch.color = a.color ?? undefined;
    if (a.profileId !== undefined) patch.profileId = a.profileId;
    if (a.model !== undefined) patch.model = a.model ?? undefined;
    const launchChanged = (a.profileId !== undefined && a.profileId !== found.cell.profileId) || (a.model !== undefined && (a.model ?? undefined) !== found.cell.model);
    const running = this.deps.isCellRunning?.(a.cellId) ?? this.statuses.get(a.cellId) !== 'exited';
    this.state.change((s) => this.log(updateCell(s, a.cellId, patch), found.project.id, 'agent_updated', a.name ?? found.cell.name ?? a.cellId, actorId));
    if (launchChanged && running) this.pendingRestart.add(a.cellId);
    if (!running) this.pendingRestart.delete(a.cellId);
    let restarted = false, restartReason: string | undefined;
    if (a.restart && running) {
      if (!this.deps.restartAgent) restartReason = 'Safe runtime restart is unavailable.';
      else {
        try { const result = await this.deps.restartAgent(a.cellId); restarted = result.restarted; restartReason = result.reason; }
        catch (error) { restartReason = error instanceof Error ? error.message : String(error); }
      }
    }
    if (restarted) this.pendingRestart.delete(a.cellId);
    return { cellId: a.cellId, ...patch, restarted, needsRestart: running && !restarted && (this.pendingRestart.has(a.cellId) || a.restart), restartReason };
  }
  private validateCells(cells: Array<{ profileId: string; prompt?: string }>) {
    for (const cell of cells) {
      const profile = this.state.get().profiles.find((p) => p.id === cell.profileId);
      if (!profile) throw new Error(`Unknown profile: ${cell.profileId}`);
      if (profile.cli === 'shell' && cell.prompt) throw new Error('Startup tasks require an AI agent profile.');
    }
  }
  private layout(count: number, rows?: number[]) {
    if (rows && rows.reduce((a, b) => a + b, 0) !== count) throw new Error('Row sizes must match the number of cells.');
    return rows ? layoutFromRows(rows) : layoutForCount(count);
  }
  private async createGrid(a: ReturnType<typeof automationSchemas.create_grid.parse> & { gridId?: string }, actorId?: string, signal?: AbortSignal) {
    this.coordinator(actorId);
    const existing = a.gridId ? this.grid(a.gridId, actorId) : undefined;
    const project = existing?.project ?? this.project(a.projectId, actorId);
    const preset = a.presetId ? this.state.get().presets.find((p) => p.id === a.presetId && (!p.projectId || p.projectId === project.id)) : undefined;
    if (a.presetId && !preset) throw new Error('Preset not found in this project.');
    if (a.presetId && a.cells) throw new Error('Specify either cells or presetId.');
    const cells = a.cells ?? preset?.cells;
    if (!cells?.length || cells.length > 20) throw new Error('Specify 1 to 20 cells or a presetId.');
    this.validateCells(cells);
    const afterOf = (i: number) => (cells[i] as { after?: number[] }).after;
    const tracked = (i: number) => !!(cells[i].prompt && cells[i].role);
    for (let i = 0; i < cells.length; i++) {
      for (const j of afterOf(i) ?? []) {
        if (j >= i) throw new Error(`Cell ${i}: after must reference earlier cells (got ${j}).`);
        if (!tracked(i) || !tracked(j)) throw new Error(`Cell ${i}: after needs a role and prompt on both cells (${i} and ${j}).`);
      }
    }
    if (a.rows && a.layout) throw new Error('Specify rows or layout, not both.');
    const count = (existing?.tab.cells.length ?? 0) + cells.length;
    if (count > 20) throw new Error('Grid cell limit reached (20).');
    const layout = a.layout ?? (!a.rows && preset ? preset.layout : this.layout(count, a.rows));
    if (layout.areas.length !== count) throw new Error('Preset layout must match its cells.');
    const covered = new Set<string>();
    for (const area of layout.areas) {
      if (area.col + area.colSpan > layout.cols || area.row + area.rowSpan > layout.rows) throw new Error('Grid area is outside its bounds.');
      for (let r = area.row; r < area.row + area.rowSpan; r++) for (let c = area.col; c < area.col + area.colSpan; c++) {
        const key = `${c}:${r}`;
        if (covered.has(key)) throw new Error('Grid areas overlap.');
        covered.add(key);
      }
    }
    if (covered.size !== layout.cols * layout.rows) throw new Error('Grid areas must cover the full layout.');
    if (actorId && project.tabs.reduce((n, t) => n + t.cells.length, 0) + cells.length > 100) throw new Error('Agent-created grids are limited to 100 project cells.');
    const newTasks = cells.filter((c) => c.prompt && c.role).length;
    if (newTasks && projectCount(this.makeRoom(this.state.get(), { tasks: { [project.id]: newTasks } }).tasks, project.id) + newTasks > PROJECT_ITEM_LIMIT) throw new Error(taskLimit);
    const created: Worktree[] = [];
    try {
      const specs: Parameters<typeof addTab>[2]['cells'] = [];
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const worktree = cell.worktree ? await this.deps.createWorktree(project.path, `${a.name || existing?.tab.name}-${uid().slice(0, 8)}-${i + 1}`) : undefined;
        if (worktree) created.push(worktree);
        if (signal?.aborted) throw new Error(CANCELLED);
        specs.push({ profileId: cell.profileId, role: cell.role, name: cell.name, color: cell.color ?? (actorId ? CELL_COLORS[((existing?.tab.cells.length ?? 0) + i) % CELL_COLORS.length] : undefined), model: cell.model, worktree });
      }
      let gridId = '';
      const cellIds: string[] = [];
      const taskIds = new Map<number, string>();
      const taskByCell: Record<string, string> = {};
      if (signal?.aborted) throw new Error(CANCELLED);
      this.state.change((s) => {
        // Recheck permissions and project after asynchronous git operations.
        this.coordinator(actorId);
        const latest = this.project(project.id, actorId);
        this.validateCells(cells);
        if (s.automation.paused && actorId) throw new Error('Automation is paused by the user.');
        if (latest.path !== project.path) throw new Error('Project folder changed while creating worktrees.');
        if (actorId && latest.tabs.reduce((n, t) => n + t.cells.length, 0) + cells.length > 100) throw new Error('Project cell limit reached.');
        if (newTasks) {
          s = { ...s, automation: this.makeRoom(s, { tasks: { [project.id]: newTasks } }) };
          if (projectCount(s.automation.tasks, project.id) + newTasks > PROJECT_ITEM_LIMIT) throw new Error(taskLimit);
        }
        let next: AppState;
        let grid: Tab;
        if (existing) {
          const current = latest.tabs.find((t) => t.id === existing.tab.id);
          if (!current || current.cells.length !== existing.tab.cells.length || current.cells.some((c, i) => c.id !== existing.tab.cells[i].id)) throw new Error('Grid changed while preparing agents; retry with the latest grid.');
          grid = { ...current, layout, cells: [...current.cells, ...specs.map((spec) => ({ ...spec, id: uid() }))] };
          next = { ...s, projects: s.projects.map((p) => p.id === project.id ? { ...p, tabs: p.tabs.map((t) => t.id === grid.id ? grid : t) } : p) };
        } else {
          next = addTab(s, project.id, { name: a.name, color: a.color ?? (actorId ? CELL_COLORS[latest.tabs.length % CELL_COLORS.length] : undefined), layout, cells: specs });
          grid = next.projects.find((p) => p.id === project.id)!.tabs.at(-1)!;
        }
        gridId = grid.id;
        const tasks: AgentTask[] = [];
        for (let i = 0; i < cells.length; i++) {
          const cell = grid.cells[(existing?.tab.cells.length ?? 0) + i];
          cellIds.push(cell.id);
          if (!cells[i].prompt) continue;
          if (!cell.role) {
            next = updateCell(next, cell.id, { startupPrompt: cells[i].prompt });
            continue;
          }
          const dependsOn = [...new Set(afterOf(i) ?? [])].map((j) => taskIds.get(j)!);
          const task: AgentTask = { id: uid(), projectId: project.id, cellId: cell.id, fromCellId: actorId,
            title: cells[i].name ?? `${a.name || grid.name} ${i + 1}`, prompt: cells[i].prompt!, status: 'queued', delivery: 'startup', createdAt: Date.now(), updatedAt: Date.now(),
            ...(dependsOn.length ? { dependsOn } : {}) };
          taskIds.set(i, task.id);
          taskByCell[cell.id] = task.id;
          tasks.push(task);
          next = updateCell(next, cell.id, { startupPrompt: taskPrompt(task) });
        }
        next = { ...next, automation: { ...next.automation, tasks: [...next.automation.tasks, ...tasks] } };
        // Automation must preserve the user's active project/tab and keyboard focus.
        next = latest.activeTabId ? setActiveTab(next, project.id, latest.activeTabId) : { ...next,
          projects: next.projects.map((p) => p.id === project.id ? { ...p, activeTabId: null } : p) };
        return this.log(next, project.id, existing ? 'agents_added' : 'grid_created', a.name || grid.name, actorId);
      });
      this.deps.startCells(cellIds);
      // Cells whose CLI is not installed show an install prompt instead of starting; say so per cell instead of leaving the caller to wait.
      const unavailable = cellIds.flatMap((cellId, i) => {
        const cli = this.deps.missingCli?.(cells[i].profileId);
        if (!cli) return [];
        this.statuses.set(cellId, 'exited');
        return [{ cellId, cli, error: `${CLI_NAMES[cli]} is not installed on this computer, so this cell did not start an agent. It shows an install prompt; ask the user to install ${CLI_NAMES[cli]} or switch the profile.` }];
      });
      return { gridId, cellIds, ...(Object.keys(taskByCell).length ? { tasks: taskByCell } : {}), ...(unavailable.length ? { unavailable } : {}) };
    } catch (error) {
      for (const worktree of created.reverse()) await this.deps.removeWorktree(project.path, worktree).catch(() => undefined);
      throw error;
    }
  }
  /**
   * Bounded wait that replaces polling loops: resolves as soon as the agent has something new, or after timeoutSec.
   * Without taskIds it waits for an unread message or a startable queued task in the caller's own inbox;
   * with taskIds it waits for any (or, with all, every) listed task to be completed, blocked or cancelled.
   */
  private async waitFor(a: ReturnType<typeof automationSchemas.wait_for.parse>, actorId?: string, signal?: AbortSignal) {
    if (!actorId) throw new Error('Waiting requires an authenticated agent.');
    const own = this.actor(actorId).project;
    const ids = a.taskIds ? [...new Set(a.taskIds)] : undefined;
    for (const taskId of ids ?? []) {
      const task = this.state.get().automation.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      this.project(task.projectId, actorId);
      // Same visibility as get_tasks: workers only see their own tasks, coordinators the project's.
      if (task.cellId !== actorId && this.role(actorId) !== 'coordinator') throw new Error('Task not found.');
    }
    const deadline = Date.now() + a.timeoutSec * 1000;
    let seen: AppState | undefined;
    for (;;) {
      const snapshot = this.state.get();
      if (snapshot !== seen) {
        seen = snapshot;
        this.actor(actorId);
        const tasks = snapshot.automation.tasks;
        if (ids) {
          const listed = ids.map((taskId) => tasks.find((t) => t.id === taskId)).filter((t): t is AgentTask => !!t);
          const finished = listed.filter((t) => t.status !== 'queued' && t.status !== 'in_progress');
          if (a.all ? listed.length > 0 && finished.length === listed.length : finished.length > 0) {
            return { event: 'tasks', tasks: listed.map((t) => ({ id: t.id, status: t.status, summary: t.result?.summary, blockedReason: t.blockedReason })) };
          }
        } else {
          const seen = this.seen(actorId);
          const unread = snapshot.automation.messages.filter((m) => m.projectId === own.id && m.toCellId === actorId && !m.readAt && !seen.has(m.id));
          const startable = tasks.filter((t) => t.projectId === own.id && t.cellId === actorId && t.status === 'queued' && !seen.has(t.id) && this.blockedBy(t).length === 0);
          if (unread.length || startable.length) {
            for (const item of [...unread, ...startable]) seen.add(item.id);
            return { event: 'inbox', unreadMessages: unread.length, queuedTasks: startable.length };
          }
        }
      }
      const left = deadline - Date.now();
      if (signal?.aborted || left <= 0) return { event: 'timeout' };
      // Woken by the next state change (every task and message change goes through the controller), the abort or the deadline.
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); off(); signal?.removeEventListener('abort', done); resolve(); };
        const off = this.state.subscribe(done);
        const timer = setTimeout(done, Math.min(WAIT_POLL_MS, left));
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  /** Tasks by id, built once per tasks array (a listing asked a linear search per dependency of every task). */
  private taskIndex: { tasks: AgentTask[]; byId: Map<string, AgentTask> } | null = null;
  private blockedBy(task: AgentTask): string[] {
    if (!task.dependsOn?.length) return [];
    const tasks = this.state.get().automation.tasks;
    if (this.taskIndex?.tasks !== tasks) this.taskIndex = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
    const byId = this.taskIndex.byId;
    return task.dependsOn.filter((id) => {
      const prerequisite = byId.get(id);
      return !prerequisite || prerequisite.projectId !== task.projectId || prerequisite.status !== 'completed';
    });
  }
  /** A task as listed: with what still blocks it and whether it can be claimed. */
  private listed(task: AgentTask) {
    const blockedBy = this.blockedBy(task);
    return { ...task, blockedBy, ready: task.status === 'queued' && blockedBy.length === 0 };
  }
  private async deliver(kind: 'task' | 'message', id: string, actorId?: string) {
    const item = kind === 'task' ? this.state.get().automation.tasks.find((t) => t.id === id) : this.state.get().automation.messages.find((m) => m.id === id);
    if (!item) throw new Error('Inbox item not found.');
    this.project(item.projectId, actorId);
    const cellId = 'cellId' in item ? item.cellId : item.toCellId;
    if (actorId && kind === 'task' && actorId !== cellId) this.coordinator(actorId);
    if (actorId && kind === 'message' && item.fromCellId !== actorId) throw new Error('Only the sender can retry delivery.');
    if (kind === 'task' && ['completed', 'cancelled'].includes((item as AgentTask).status)) throw new Error('Task is already closed.');
    if (kind === 'task' && this.blockedBy(item as AgentTask).length) return { delivery: item.delivery, blockedBy: this.blockedBy(item as AgentTask) };
    if (item.delivery !== 'pending' || this.delivering.has(id)) return { delivery: item.delivery };
    this.delivering.add(id);
    let deliveryError: string | undefined;
    try {
      if (this.state.get().automation.paused) throw new Error('Automation is paused by the user.');
      this.target(cellId, actorId);
      const prompt = kind === 'task' ? taskPrompt(item as AgentTask) : `[Unimux message ${id} from ${item.fromCellId ?? 'user'}]\n${(item as AgentMessage).text}\nRead it with read_inbox (acknowledge:true).`;
      await this.deps.deliver(cellId, prompt);
    } catch (error) { deliveryError = error instanceof Error ? error.message : String(error); }
    finally { this.delivering.delete(id); }
    this.state.change((s) => ({ ...s, automation: { ...s.automation,
      tasks: kind === 'task' ? s.automation.tasks.map((t) => t.id === id ? { ...t, delivery: deliveryError ? 'pending' : 'native', deliveryError } : t) : s.automation.tasks,
      messages: kind === 'message' ? s.automation.messages.map((m) => m.id === id ? { ...m, delivery: deliveryError ? 'pending' : 'native', deliveryError } : m) : s.automation.messages,
    } }));
    return { delivery: deliveryError ? 'pending' : 'native', deliveryError };
  }
}
