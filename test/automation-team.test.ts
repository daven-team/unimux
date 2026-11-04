// The AI team's reliability fixes of 1.1.4: stalled agents, inbox notices through the prompt queue, restarting an exited
// agent, dependents delivered when their prerequisites complete, the runtime status left alone for a dead worker, orphaned
// tasks cancelled and reassigned, closed ids in wait_for, the per-CLI wait cap and the delegation limit.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_PREFIX, queueNotice, STALL_ATTENTION_MS, STALL_CONNECT_MS, waitingPrompt, type McpConnection } from '../src/main/automation';
import { findCell, removeCell } from '../src/shared/state';
import { normalizePromptQueue, queueVerdict, type QueueSignal } from '../src/shared/promptQueue';
import type { AgentTask } from '../src/shared/automation';
import { automationFixture } from './helpers/automationFixture';

const refusal = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../src/shared/delegation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shared/delegation')>()),
  delegationRefusal: () => refusal.value,
}));

afterEach(() => { vi.useRealTimers(); refusal.value = null; });

const fakeTime = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
/** Lets queued microtasks and the promise chain of a wait run. */
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function team() {
  const f = automationFixture();
  const connection = new Map<string, McpConnection>();
  f.service.mcpProbe = { connection: (cellId) => connection.get(cellId) ?? 'off' };
  return { ...f, connection };
}

describe('stalled agents (wait_for event "stalled", list_agents mcp/since)', () => {
  it('reports an agent of a watched task that never connected to MCP 90 s after its start, once per start', async () => {
    fakeTime();
    const f = team();
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'T', prompt: 'p' }, f.coordinator.id) as AgentTask;
    f.service.runtimeStarted(f.worker.id);
    f.service.statuses.set(f.worker.id, 'starting');
    f.connection.set(f.worker.id, 'waiting');
    let result: unknown;
    void f.service.execute('wait_for', { taskIds: [task.id], timeoutSec: 170 }, f.coordinator.id).then((r) => { result = r; });
    await flush();
    await vi.advanceTimersByTimeAsync(STALL_CONNECT_MS - 1000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(result).toMatchObject({ event: 'stalled', stalled: [{ cellId: f.worker.id, reason: expect.stringContaining('never connected') }], tasks: [{ id: task.id, status: 'queued' }] });
    expect((result as { stalled: Array<{ sinceSec: number }> }).stalled[0].sinceSec).toBeGreaterThanOrEqual(90);
    // Told once: the next wait on the same start times out.
    let again: unknown;
    void f.service.execute('wait_for', { taskIds: [task.id], timeoutSec: 5 }, f.coordinator.id).then((r) => { again = r; });
    await vi.advanceTimersByTimeAsync(6000);
    expect(again).toEqual({ event: 'timeout' });
    // Connected agents are not stalled; list_agents shows the connection and the seconds in the status.
    f.connection.set(f.worker.id, 'connected');
    const rows = await f.service.execute('list_agents', {}, f.coordinator.id) as Array<{ cellId: string; mcp: string; since?: number }>;
    expect(rows.find((r) => r.cellId === f.worker.id)).toMatchObject({ mcp: 'connected', since: expect.any(Number) });
    expect(rows.find((r) => r.cellId === f.worker.id)!.since).toBeGreaterThanOrEqual(96);
  });

  it('reports an agent that waits for the user longer than the threshold, and its exit code in list_agents', async () => {
    fakeTime();
    const f = team();
    f.connection.set(f.worker.id, 'connected');
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'T', prompt: 'p' }, f.coordinator.id) as AgentTask;
    f.service.runtimeStarted(f.worker.id);
    f.service.statuses.set(f.worker.id, 'needs_attention');
    let result: unknown;
    void f.service.execute('wait_for', { taskIds: [task.id], timeoutSec: 170 }, f.coordinator.id).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(STALL_ATTENTION_MS + 1000);
    expect(result).toMatchObject({ event: 'stalled', stalled: [{ cellId: f.worker.id, reason: expect.stringContaining('waits for the user') }] });
    f.service.statuses.set(f.worker.id, 'exited');
    f.service.noteExit(f.worker.id, 3);
    const rows = await f.service.execute('list_agents', {}, f.coordinator.id) as Array<{ cellId: string; lastExitCode?: number; status: string }>;
    expect(rows.find((r) => r.cellId === f.worker.id)).toMatchObject({ status: 'exited', lastExitCode: 3 });
  });
});

describe('inbox notices', () => {
  it('tells the agent with a short notice, not the task text, and redelivers pending items when it starts', async () => {
    fakeTime();
    const f = team();
    f.deps.deliver.mockRejectedValueOnce(new Error('Agent is not running.'));
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'Fix login', prompt: 'A very long prompt '.repeat(50) }, f.coordinator.id) as AgentTask;
    expect(task.delivery).toBe('pending');
    f.service.runtimeStarted(f.worker.id);
    f.service.statuses.set(f.worker.id, 'starting');
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.deps.deliver).toHaveBeenLastCalledWith(f.worker.id, expect.stringMatching(new RegExp(`^unimux: new task ${task.id} "Fix login" from .+: read_inbox$`)));
    expect(f.controller.get().automation.tasks[0].delivery).toBe('native');
  });

  it('merges notices that were not sent yet into one queue item, marked as a unimux notice', () => {
    let queue = queueNotice(undefined, 'unimux: new task t1 "A" from Lead: read_inbox', 'a');
    queue = queueNotice(queue, 'unimux: new message m1 from Lead: read_inbox', 'b');
    expect(queue?.items).toEqual([{ id: `${NOTICE_PREFIX}a`, auto: true, text: 'unimux: new task t1 "A" from Lead; new message m1 from Lead: read_inbox' }]);
    for (let i = 0; i < 6; i++) queue = queueNotice(queue, `unimux: new message m${i} from Lead: read_inbox`, `x${i}`);
    expect(queue?.items).toHaveLength(1);
    expect(queue?.items[0].text).toBe('unimux: several new tasks and messages: read_inbox');
  });

  it('lets a notice reach an agent idle at its first prompt once its hooks report, and drops stale notices at launch', () => {
    const signal: QueueSignal = { agent: true, started: true, status: 'idle', hooked: true, typed: false, sent: false };
    const notice = { items: [{ id: 'unimux-1', text: 'unimux: x: read_inbox', auto: true as const }] };
    expect(queueVerdict(notice, signal)).toEqual({ kind: 'ready' });
    expect(queueVerdict(notice, { ...signal, hooked: false })).toEqual({ kind: 'wait', why: 'first' });
    expect(queueVerdict({ items: [{ id: 'u', text: 'my prompt' }] }, signal)).toEqual({ kind: 'wait', why: 'first' });
    expect(queueVerdict(notice, { ...signal, status: 'waiting', detail: { kind: 'permission' } } as QueueSignal)).toEqual({ kind: 'pause', reason: 'permission' });
    expect(normalizePromptQueue({ items: [...notice.items, { id: 'u', text: 'mine' }] }, true)).toEqual({ items: [{ id: 'u', text: 'mine' }], paused: 'restart' });
    expect(normalizePromptQueue(notice, false)).toEqual(notice);
  });
});

describe('update_agent restart:true', () => {
  it('starts an exited team agent again and always says whether it restarted', async () => {
    const f = team();
    const startAgent = vi.fn(async () => ({ started: true }));
    const service = new (f.service.constructor as typeof import('../src/main/automation').AutomationService)(f.controller, { ...f.deps, startAgent });
    service.statuses.set(f.worker.id, 'exited');
    expect(await service.execute('update_agent', { cellId: f.worker.id, restart: true }, f.coordinator.id)).toMatchObject({ restarted: true, restartReason: expect.stringContaining('started again') });
    expect(startAgent).toHaveBeenCalledWith(f.worker.id);
    expect(f.deps.restartAgent).not.toHaveBeenCalled();
    startAgent.mockResolvedValueOnce({ started: false, reason: 'Project folder does not exist; ask the user.' } as never);
    expect(await service.execute('update_agent', { cellId: f.worker.id, restart: true }, f.coordinator.id)).toMatchObject({ restarted: false, restartReason: 'Project folder does not exist; ask the user.' });
    // Without the runtime hook the answer says so instead of a silent no-op.
    f.service.statuses.set(f.worker.id, 'exited');
    expect(await f.service.execute('update_agent', { cellId: f.worker.id, restart: true }, f.coordinator.id)).toMatchObject({ restarted: false, restartReason: expect.stringContaining('unavailable') });
  });
});

describe('dependencies', () => {
  it('delivers a dependent task when its last prerequisite completes', async () => {
    const f = team();
    const a = await f.service.execute('create_task', { cellId: f.worker.id, title: 'A', prompt: 'p' }, f.coordinator.id) as AgentTask;
    const b = await f.service.execute('create_task', { cellId: f.worker.id, title: 'B', prompt: 'p', dependsOn: [a.id] }, f.coordinator.id) as AgentTask;
    expect(f.deps.deliver).toHaveBeenCalledTimes(1);
    expect(b.delivery).toBe('pending');
    await expect(f.service.execute('update_task', { taskId: b.id, status: 'in_progress' }, f.worker.id)).rejects.toThrow(`blockedBy [${a.id}]; wait_for them`);
    await f.service.execute('update_task', { taskId: a.id, status: 'completed', result: { summary: 'ok' } }, f.worker.id);
    expect(f.deps.deliver).toHaveBeenCalledTimes(2);
    expect(f.deps.deliver).toHaveBeenLastCalledWith(f.worker.id, expect.stringContaining(`new task ${b.id} "B"`));
    expect(f.controller.get().automation.tasks.find((t) => t.id === b.id)?.delivery).toBe('native');
  });

  it('starts create_grid "after" cells with a wait prompt and gives them their task when the prerequisites complete', async () => {
    const f = team();
    const r = await f.service.execute('create_grid', { name: 'Chain', cells: [
      { profileId: 'codex', role: 'worker', name: 'Dev', prompt: 'Build it' },
      { profileId: 'claude', role: 'worker', name: 'Review', prompt: 'Review it', after: [0] },
    ] }, f.coordinator.id) as { cellIds: string[]; tasks: Record<string, string> };
    const [dev, review] = r.cellIds;
    const tasks = f.controller.get().automation.tasks;
    const reviewTask = tasks.find((t) => t.id === r.tasks[review])!;
    expect(reviewTask.delivery).toBe('pending');
    expect(findCell(f.controller.get(), review)?.cell.startupPrompt).toBe(waitingPrompt(reviewTask));
    expect(findCell(f.controller.get(), review)?.cell.startupPrompt).not.toContain('Review it');
    expect(findCell(f.controller.get(), dev)?.cell.startupPrompt).toContain('Build it');
    await f.service.execute('update_task', { taskId: r.tasks[dev], status: 'completed', result: { summary: 'built' } }, dev);
    expect(f.deps.deliver).toHaveBeenLastCalledWith(review, expect.stringContaining(`new task ${reviewTask.id} "Review"`));
  });
});

describe('runtime status and orphaned tasks', () => {
  it('a coordinator updating a dead worker\'s task leaves "exited"; the worker\'s own report sets its status', async () => {
    const f = team();
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'T', prompt: 'p' }, f.coordinator.id) as AgentTask;
    f.service.statuses.set(f.worker.id, 'exited');
    await f.service.execute('update_task', { taskId: task.id, status: 'blocked', blockedReason: 'worker died' }, f.coordinator.id);
    expect(f.service.statuses.get(f.worker.id)).toBe('exited');
    f.service.statuses.set(f.worker.id, 'ready');
    await f.service.execute('update_task', { taskId: task.id, status: 'in_progress' }, f.coordinator.id);
    expect(f.service.statuses.get(f.worker.id)).toBe('ready');
  });

  it('cancels open tasks of a closed agent, tells the waiting coordinator, and lets it reassign', async () => {
    const f = team();
    const extra = await f.service.execute('create_grid', { projectId: f.project.id, name: 'Extra', cells: [{ profileId: 'claude', role: 'worker', name: 'Second' }] }) as { cellIds: string[] };
    const second = extra.cellIds[0];
    const open = await f.service.execute('create_task', { cellId: f.worker.id, title: 'Open', prompt: 'p' }, f.coordinator.id) as AgentTask;
    const queued = await f.service.execute('create_task', { cellId: second, title: 'Move me', prompt: 'p' }, f.coordinator.id) as AgentTask;
    // A queued task moves to another agent and is delivered there.
    expect(await f.service.execute('update_task', { taskId: queued.id, cellId: f.worker.id }, f.coordinator.id)).toMatchObject({ id: queued.id, cellId: f.worker.id });
    expect(f.deps.deliver).toHaveBeenLastCalledWith(f.worker.id, expect.stringContaining(queued.id));
    await expect(f.service.execute('update_task', { taskId: queued.id, cellId: f.worker.id }, f.worker.id)).rejects.toThrow('coordinator');
    const waiting = f.service.execute('wait_for', { taskIds: [open.id], timeoutSec: 30 }, f.coordinator.id);
    f.controller.change((s) => removeCell(s, f.project.id, f.project.tabs[0].id, f.worker.id));
    expect(f.service.cancelOrphans()).toBe(2);
    expect(await waiting).toMatchObject({ event: 'tasks', tasks: [{ id: open.id, status: 'cancelled', reason: 'agent closed' }] });
    // A cancelled task becomes a new task for another agent (teamPanel.reassignInput).
    const again = await f.service.execute('update_task', { taskId: open.id, cellId: second }, f.coordinator.id) as AgentTask;
    expect(again).toMatchObject({ cellId: second, title: 'Open', prompt: 'p', status: 'queued' });
    expect(again.id).not.toBe(open.id);
    expect(f.service.cancelOrphans()).toBe(0);
  });
});

describe('orphans of an older state.json', () => {
  it('cancels open tasks of archived or removed cells when the service starts, and keeps the others', async () => {
    const { AutomationService } = await import('../src/main/automation');
    const { StateController } = await import('../src/main/stateController');
    const { closeTab, normalizeState } = await import('../src/shared/state');
    const f = team();
    const extra = await f.service.execute('create_grid', { projectId: f.project.id, name: 'Old', cells: [{ profileId: 'claude', role: 'worker', name: 'Gone' }] }) as { gridId: string; cellIds: string[] };
    const now = Date.now();
    const task = (id: string, cellId: string, status: AgentTask['status'] = 'queued'): AgentTask => ({ id, projectId: f.project.id, cellId, title: id, prompt: 'p', status, delivery: 'pending', createdAt: now, updatedAt: now });
    let saved = closeTab(f.controller.get(), f.project.id, extra.gridId); // the grid went to the archive
    saved = { ...saved, automation: { ...saved.automation, tasks: [task('archived', extra.cellIds[0]), task('removed', 'no-such-cell', 'in_progress'), task('alive', f.worker.id), task('done', 'no-such-cell', 'completed')] } };
    const controller = new StateController(normalizeState(JSON.parse(JSON.stringify(saved)))!,() => undefined);
    new AutomationService(controller, f.deps);
    const byId = Object.fromEntries(controller.get().automation.tasks.map((t) => [t.id, t]));
    expect(byId.archived).toMatchObject({ status: 'cancelled', cancelReason: 'agent closed' });
    expect(byId.removed).toMatchObject({ status: 'cancelled', cancelReason: 'agent closed' });
    expect(byId.alive.status).toBe('queued');
    expect(byId.done.status).toBe('completed');
    // The title bar badge counts open tasks: only the live one is left.
    expect(controller.get().automation.tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled')).toHaveLength(1);
  });
});

describe('the MCP server', () => {
  it('reports the app version and whether a cell\'s agent connected; list_agents shows it', async () => {
    const { startMcpHarness } = await import('./helpers/mcpHarness');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const h = await startMcpHarness(undefined, { version: '9.8.7' });
    try {
      const token = h.server.issueToken(h.coordinator.id);
      expect(h.server.connection(h.coordinator.id)).toBe('waiting');
      expect(h.server.connection(h.worker.id)).toBe('off');
      const client = new Client({ name: 't', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      expect(client.getServerVersion()).toMatchObject({ name: 'unimux', version: '9.8.7' });
      await client.listTools();
      const listed = await client.callTool({ name: 'list_agents', arguments: {} });
      const agents = JSON.parse((listed.content as Array<{ text: string }>)[0].text).agents as Array<{ id: string; mcp?: string }>;
      expect(agents.find((a) => a.id === h.coordinator.id)?.mcp).toBe('connected');
      expect(agents.find((a) => a.id === h.worker.id)?.mcp).toBe('off');
      await client.close();
    } finally { await h.server.stop(); }
  });
});

describe('wait_for ergonomics and limits', () => {
  it('answers closed ids once with a hint instead of returning at once in a loop, and caps the wait per CLI', async () => {
    const f = team();
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'T', prompt: 'p' }, f.coordinator.id) as AgentTask;
    await f.service.execute('update_task', { taskId: task.id, status: 'cancelled' }, f.coordinator.id);
    expect(await f.service.execute('wait_for', { taskIds: [task.id] }, f.coordinator.id)).toMatchObject({ event: 'alreadyClosed', hint: expect.stringContaining('only open task IDs') });
    // The coordinator of the fixture is a Codex cell (170 s), the worker a Claude cell (600 s).
    await expect(f.service.execute('wait_for', { timeoutSec: 171 }, f.coordinator.id)).rejects.toThrow('at most 170');
    const abort = new AbortController();
    const long = f.service.execute('wait_for', { timeoutSec: 600 }, f.worker.id, abort.signal);
    abort.abort();
    expect(await long).toEqual({ event: 'cancelled' });
  });

  it('refuses agents beyond the delegation limit with the next step', async () => {
    const f = team();
    refusal.value = 'limit 4 agents at once: wait_for some to finish or close_grid';
    await expect(f.service.execute('create_grid', { name: 'Big', cells: [{ profileId: 'claude', role: 'worker', prompt: 'x' }] }, f.coordinator.id)).rejects.toThrow('limit 4 agents at once');
    await expect(f.service.execute('create_task', { cellId: f.worker.id, title: 'T', prompt: 'p' }, f.coordinator.id)).rejects.toThrow('wait_for some to finish');
    // The user's own calls are never limited.
    await expect(f.service.execute('create_grid', { projectId: f.project.id, name: 'Mine', cells: [{ profileId: 'claude' }] })).resolves.toBeTruthy();
  });
});
