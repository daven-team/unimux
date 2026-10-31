import { describe, expect, it, vi } from 'vitest';
import { AutomationService } from '../src/main/automation';
import { StateController } from '../src/main/stateController';
import { addProject, addTab, defaultState, normalizeState, updateCell, upsertPreset, upsertSnippet } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';
import type { AgentTask } from '../src/shared/automation';

export function automationFixture() {
  let state = addProject(defaultState(), { name: 'Own project', path: 'D:/own' });
  state = addTab(state, state.projects[0].id, { name: 'Team', layout: layoutForCount(2), cells: [{ profileId: 'codex', role: 'coordinator' }, { profileId: 'claude', role: 'worker' }] });
  const project = state.projects[0], [coordinator, worker] = project.tabs[0].cells;
  state = addProject(state, { name: 'Other project', path: 'D:/other' });
  state = addTab(state, state.projects[1].id, { layout: layoutForCount(1), cells: [{ profileId: 'codex', role: 'coordinator' }] });
  const outsider = state.projects[1].tabs[0].cells[0];
  const controller = new StateController(state, vi.fn());
  const deps = {
    createWorktree: vi.fn(async (path: string, name: string) => ({ path: `${path}-wt-${name}`, branch: `mc/${name}` })),
    isCellRunning: vi.fn(() => true),
    restartAgent: vi.fn(async (): Promise<{ restarted: boolean; reason?: string }> => ({ restarted: true })),
    removeWorktree: vi.fn(async () => {}), startCells: vi.fn(), deliver: vi.fn(async () => {}),
  };
  return { service: new AutomationService(controller, deps), controller, deps, project, coordinator, worker, outsider };
}
describe('automation service', () => {
  it('keeps roles and MCP optional, preserves plain prompts and revokes access when disabled', async () => {
    const f = automationFixture();
    await f.service.execute('set_paused', { paused: true });
    const created = await f.service.execute('create_grid', { projectId: f.project.id, name: 'Plain', cells: [
      { profileId: 'claude', prompt: 'Just my original prompt' }, { profileId: 'codex' },
    ] }) as { cellIds: string[] };
    const grid = f.controller.get().projects[0].tabs.at(-1)!;
    expect(grid.cells.every((cell) => cell.role === undefined)).toBe(true);
    expect(grid.cells[0].startupPrompt).toBe('Just my original prompt');
    expect(f.controller.get().automation.tasks).toEqual([]);
    await expect(f.service.execute('get_context', {}, created.cellIds[0])).rejects.toThrow('disabled');
    await f.service.execute('set_role', { cellId: created.cellIds[0], role: 'worker' });
    expect(await f.service.execute('get_context', {}, created.cellIds[0])).toMatchObject({ role: 'worker' });
    await f.service.execute('set_role', { cellId: created.cellIds[0], role: null });
    await expect(f.service.execute('get_context', {}, created.cellIds[0])).rejects.toThrow('disabled');
    const saved = normalizeState(JSON.parse(JSON.stringify(f.controller.get())))!;
    expect(saved.projects[0].tabs.at(-1)!.cells[0].role).toBeUndefined();
  });
  it('migrates existing app data without losing snippets, projects or language', () => {
    const old = defaultState();
    const { automation: _, ...legacy } = old;
    const restored = normalizeState({ ...legacy, settings: { ...legacy.settings, language: 'pl' } });
    expect(restored?.automation).toEqual({ paused: false, tasks: [], messages: [], events: [] });
    expect(restored?.settings.language).toBe('pl');
  });
  it('identifies the actor and scopes reads and writes to its project', async () => {
    const f = automationFixture();
    expect(await f.service.execute('get_context', {}, f.worker.id)).toMatchObject({ cellId: f.worker.id, projectId: f.project.id, role: 'worker' });
    await expect(f.service.execute('list_agents', { projectId: f.outsider.id }, f.worker.id)).rejects.toThrow('access denied');
    await expect(f.service.execute('send_message', { toCellId: f.outsider.id, text: 'outside' }, f.worker.id)).rejects.toThrow('access denied');
    await expect(f.service.execute('set_role', { cellId: f.worker.id, role: 'coordinator' }, f.worker.id)).rejects.toThrow('controlled by the user');
    await expect(f.service.execute('create_grid', { name: 'Unrequested', cells: [{ profileId: 'codex' }] }, f.worker.id)).rejects.toThrow('coordinator');
    await expect(f.service.execute('create_task', { cellId: f.coordinator.id, title: 'Other', prompt: 'Do work' }, f.worker.id)).rejects.toThrow('coordinator');
  });
  it('creates a team in the background with tracked startup tasks and no selection changes', async () => {
    const f = automationFixture();
    const oldSelection = f.controller.get().activeProjectId;
    const oldTab = f.project.activeTabId;
    const created = await f.service.execute('create_grid', { name: 'Feature', rows: [2, 1], cells: [
      { profileId: 'codex', role: 'worker', name: 'Backend', prompt: 'Implement backend', worktree: true },
      { profileId: 'claude', role: 'worker', name: 'Frontend', prompt: 'Implement frontend', worktree: true },
      { profileId: 'codex', name: 'Review', role: 'worker' },
    ] }, f.coordinator.id) as { gridId: string; cellIds: string[] };
    expect(f.controller.get().activeProjectId).toBe(oldSelection);
    expect(f.controller.get().projects[0].activeTabId).toBe(oldTab);
    expect(f.deps.startCells).toHaveBeenCalledWith(created.cellIds);
    expect(f.deps.createWorktree).toHaveBeenCalledTimes(2);
    const grid = f.controller.get().projects[0].tabs.find((t) => t.id === created.gridId)!;
    expect(grid.cells).toHaveLength(3);
    expect(grid.cells[0].startupPrompt).toContain('update_task');
    expect(f.controller.get().automation.tasks).toHaveLength(2);
    expect(f.controller.get().automation.tasks[0]).toMatchObject({ status: 'queued', delivery: 'startup' });
  });
  it('rolls back only newly created worktrees when preparation fails', async () => {
    const f = automationFixture();
    f.deps.createWorktree.mockRejectedValueOnce(new Error('git failed'));
    await expect(f.service.execute('create_grid', { name: 'Broken', cells: [{ profileId: 'codex', worktree: true }] }, f.coordinator.id)).rejects.toThrow('git failed');
    expect(f.controller.get().projects[0].tabs).toHaveLength(1);
    expect(f.deps.startCells).not.toHaveBeenCalled();
    f.deps.createWorktree.mockImplementationOnce(async () => ({ path: 'D:/own-wt-new', branch: 'mc/new' }));
    f.deps.createWorktree.mockRejectedValueOnce(new Error('second failed'));
    await expect(f.service.execute('create_grid', { name: 'Broken', cells: [{ profileId: 'codex', worktree: true }, { profileId: 'claude', worktree: true }] }, f.coordinator.id)).rejects.toThrow('second failed');
    expect(f.deps.removeWorktree).toHaveBeenCalledWith(f.project.path, { path: 'D:/own-wt-new', branch: 'mc/new' });
    expect(f.controller.get().projects[0].tabs).toHaveLength(1);
  });
  it('rechecks pause and project permissions after asynchronous worktree creation', async () => {
    const f = automationFixture();
    f.deps.createWorktree.mockImplementationOnce(async () => {
      await f.service.execute('set_paused', { paused: true });
      return { path: 'D:/own-wt-new', branch: 'mc/new' };
    });
    await expect(f.service.execute('create_grid', { name: 'Paused', cells: [{ profileId: 'codex', worktree: true }] }, f.coordinator.id)).rejects.toThrow('paused');
    expect(f.deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(f.deps.startCells).not.toHaveBeenCalled();
  });
  it('retains undelivered work, accepts results from the recipient and protects closed tasks', async () => {
    const f = automationFixture();
    f.deps.deliver.mockRejectedValue(new Error('Native delivery unavailable'));
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'Fix login', prompt: 'Fix the login flow' }, f.coordinator.id) as AgentTask;
    expect(task).toMatchObject({ delivery: 'pending', status: 'queued', deliveryError: 'Native delivery unavailable' });
    expect(await f.service.execute('get_tasks', {}, f.worker.id)).toHaveLength(1);
    await f.service.execute('update_task', { taskId: task.id, status: 'in_progress' }, f.worker.id);
    await expect(f.service.execute('update_task', { taskId: task.id, status: 'completed' }, f.worker.id)).rejects.toThrow('require a result');
    await expect(f.service.execute('update_task', { taskId: task.id, status: 'blocked' }, f.worker.id)).rejects.toThrow('require a reason');
    await f.service.execute('set_paused', { paused: true });
    await expect(f.service.execute('send_message', { toCellId: f.coordinator.id, text: 'new' }, f.worker.id)).rejects.toThrow('paused');
    await f.service.execute('update_task', { taskId: task.id, status: 'completed', result: { summary: 'Fixed', files: ['login.ts'], tests: ['login tests passed'], branch: 'mc/login' } }, f.worker.id);
    expect(f.controller.get().automation.tasks[0].result?.files).toEqual(['login.ts']);
    await expect(f.service.execute('update_task', { taskId: task.id, status: 'in_progress' }, f.worker.id)).rejects.toThrow('already closed');
  });
  it('does not resend items already accepted by a native queue', async () => {
    const f = automationFixture();
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'Task', prompt: 'Work' }, f.coordinator.id) as AgentTask;
    expect(task.delivery).toBe('native');
    await f.service.execute('deliver_task', { taskId: task.id }, f.coordinator.id);
    expect(f.deps.deliver).toHaveBeenCalledTimes(1);
  });
  it('makes messages visible only to their recipient and requires recipient acknowledgment', async () => {
    const f = automationFixture();
    const message = await f.service.execute('send_message', { toCellId: f.worker.id, text: 'The API is ready' }, f.coordinator.id) as { id: string };
    expect(await f.service.execute('get_messages', {}, f.worker.id)).toHaveLength(1);
    expect(await f.service.execute('get_messages', {}, f.coordinator.id)).toEqual([]);
    await expect(f.service.execute('acknowledge_message', { messageId: message.id }, f.coordinator.id)).rejects.toThrow('recipient');
    await f.service.execute('acknowledge_message', { messageId: message.id }, f.worker.id);
    expect(await f.service.execute('get_messages', {}, f.worker.id)).toEqual([]);
    expect(await f.service.execute('get_messages', { unreadOnly: false }, f.worker.id)).toHaveLength(1);
  });
  it('creates snippets, uses them as tracked tasks and protects other scopes', async () => {
    const f = automationFixture();
    f.controller.change((s) => upsertSnippet(s, { id: 'global', name: 'Global', text: 'global prompt', autoSend: true }));
    const snippet = await f.service.execute('save_snippet', { name: 'Review', text: 'Review files' }, f.worker.id) as { id: string; autoSend: boolean };
    expect(snippet.autoSend).toBe(false);
    expect(await f.service.execute('get_snippet', { snippetId: snippet.id }, f.worker.id)).toMatchObject({ text: 'Review files' });
    await expect(f.service.execute('save_snippet', { id: 'global', name: 'Overwrite', text: 'new' }, f.worker.id)).rejects.toThrow('another scope');
    const task = await f.service.execute('apply_snippet', { snippetId: snippet.id, cellId: f.worker.id }, f.coordinator.id) as AgentTask;
    expect(task).toMatchObject({ title: 'Review', prompt: 'Review files' });
    expect((await f.service.execute('list_library', {}, f.worker.id) as { snippets: unknown[] }).snippets).toHaveLength(2);
  });
  it('starts saved team presets and validates custom layouts before worktree side effects', async () => {
    const f = automationFixture();
    f.controller.change((s) => upsertPreset(s, { id: 'team', name: 'Saved', layout: layoutForCount(2), cells: [{ profileId: 'codex', worktree: false, prompt: 'Backend' }, { profileId: 'claude', worktree: false }] }));
    const created = await f.service.execute('create_grid', { name: 'From preset', presetId: 'team' }, f.coordinator.id) as { cellIds: string[] };
    expect(created.cellIds).toHaveLength(2);
    await expect(f.service.execute('create_grid', { name: 'Invalid', cells: [{ profileId: 'codex', worktree: true }, { profileId: 'claude' }], layout: {
      cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 0, row: 0, colSpan: 1, rowSpan: 1 }],
    } }, f.coordinator.id)).rejects.toThrow('overlap');
    expect(f.deps.createWorktree).not.toHaveBeenCalled();
  });
  it('applies role changes immediately and blocks workers from reading other task inboxes', async () => {
    const f = automationFixture();
    await f.service.execute('create_task', { cellId: f.coordinator.id, title: 'Own', prompt: 'Work' }, f.coordinator.id);
    expect(await f.service.execute('get_tasks', { cellId: f.coordinator.id }, f.worker.id)).toEqual([]);
    f.controller.change((s) => updateCell(s, f.coordinator.id, { role: 'worker' }));
    await expect(f.service.execute('create_grid', { name: 'Forbidden', cells: [{ profileId: 'codex' }] }, f.coordinator.id)).rejects.toThrow('coordinator');
  });
});


describe('MCP grid and agent customization', () => {
  it('appends to an existing grid, preserves identities and selection, starts only additions', async () => {
    const f = automationFixture();
    const selection = f.controller.get().activeProjectId;
    const existing = f.project.tabs[0];
    const result = await f.service.execute('add_agents', { gridId: existing.id, rows: [2, 1], cells: [
      { profileId: 'codex', name: 'Reviewer', role: 'worker', model: 'gpt-5.4', prompt: 'Review' },
    ] }, f.coordinator.id) as { gridId: string; cellIds: string[] };
    const grid = f.controller.get().projects[0].tabs[0];
    expect(result.gridId).toBe(existing.id);
    expect(grid.cells.slice(0, 2)).toEqual(existing.cells);
    expect(grid.cells[2]).toMatchObject({ name: 'Reviewer', model: 'gpt-5.4', color: '#34d399' });
    expect(grid.layout.areas).toHaveLength(3);
    expect(f.controller.get().activeProjectId).toBe(selection);
    expect(f.controller.get().projects[0].activeTabId).toBe(existing.id);
    expect(f.deps.startCells).toHaveBeenCalledWith(result.cellIds);
    expect(result.cellIds).toEqual([grid.cells[2].id]);
    expect(f.controller.get().automation.tasks[0].cellId).toBe(grid.cells[2].id);
  });
  it('validates full grid layouts and project permissions before creating worktrees', async () => {
    const f = automationFixture();
    await expect(f.service.execute('add_agents', { gridId: f.project.tabs[0].id, rows: [1], cells: [{ profileId: 'codex', worktree: true }] }, f.coordinator.id)).rejects.toThrow('Row sizes');
    await expect(f.service.execute('add_agents', { gridId: f.project.tabs[0].id, cells: [{ profileId: 'codex' }] }, f.worker.id)).rejects.toThrow('coordinator');
    const foreignGrid = f.controller.get().projects[1].tabs[0].id;
    await expect(f.service.execute('add_agents', { gridId: foreignGrid, cells: [{ profileId: 'codex' }] }, f.coordinator.id)).rejects.toThrow('access denied');
    expect(f.deps.createWorktree).not.toHaveBeenCalled();
  });
  it('rolls back worktrees if existing grid changes while additions are prepared', async () => {
    const f = automationFixture();
    f.deps.createWorktree.mockImplementationOnce(async () => {
      f.controller.change((s) => ({ ...s, projects: s.projects.map((p) => p.id === f.project.id ? { ...p, tabs: [] } : p) }));
      return { path: 'D:/new-wt', branch: 'mc/new' };
    });
    await expect(f.service.execute('add_agents', { gridId: f.project.tabs[0].id, cells: [{ profileId: 'codex', worktree: true }] }, f.coordinator.id)).rejects.toThrow();
    expect(f.deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(f.deps.startCells).not.toHaveBeenCalled();
  });
  it('defaults team accents distinctly and honors explicit colors/models', async () => {
    const f = automationFixture();
    await f.service.execute('create_grid', { name: 'Team', color: '#123456', cells: [
      { profileId: 'codex', color: '#abcdef', model: 'gpt-5.4' }, { profileId: 'claude' },
    ] }, f.coordinator.id);
    const grid = f.controller.get().projects[0].tabs.at(-1)!;
    expect(grid.color).toBe('#123456');
    expect(grid.cells[0]).toMatchObject({ color: '#abcdef', model: 'gpt-5.4' });
    expect(grid.cells[1].color).toBe('#a78bfa');
  });
  it('restricts peer identities and grid updates to coordinators, honors pause', async () => {
    const f = automationFixture();
    await expect(f.service.execute('update_agent', { cellId: f.coordinator.id, name: 'Hijack' }, f.worker.id)).rejects.toThrow('coordinator');
    await expect(f.service.execute('update_grid', { gridId: f.project.tabs[0].id, name: 'Hijack' }, f.worker.id)).rejects.toThrow('coordinator');
    await f.service.execute('update_agent', { cellId: f.worker.id, name: 'Own', color: '#123456' }, f.worker.id);
    await f.service.execute('update_grid', { gridId: f.project.tabs[0].id, name: 'Renamed', color: '#abcdef' }, f.coordinator.id);
    expect(f.controller.get().projects[0].tabs[0]).toMatchObject({ name: 'Renamed', color: '#abcdef' });
    await f.service.execute('set_paused', { paused: true });
    await expect(f.service.execute('update_agent', { cellId: f.worker.id, model: 'new' }, f.worker.id)).rejects.toThrow('paused');
    expect(f.deps.restartAgent).not.toHaveBeenCalled();
  });
  it('saves launch settings, explicitly restarts safely, and reports deferred or refused restart', async () => {
    const f = automationFixture();
    expect(await f.service.execute('update_agent', { cellId: f.worker.id, model: 'new' }, f.coordinator.id)).toMatchObject({ needsRestart: true, restarted: false });
    expect(f.deps.restartAgent).not.toHaveBeenCalled();
    expect(await f.service.execute('update_agent', { cellId: f.worker.id, name: 'Worker' }, f.worker.id)).toMatchObject({ needsRestart: true });
    f.deps.restartAgent.mockResolvedValueOnce({ restarted: false, reason: 'Session is unconfirmed' });
    expect(await f.service.execute('update_agent', { cellId: f.worker.id, restart: true }, f.coordinator.id)).toMatchObject({ needsRestart: true, restartReason: 'Session is unconfirmed' });
    expect(await f.service.execute('update_agent', { cellId: f.worker.id, restart: true }, f.coordinator.id)).toMatchObject({ needsRestart: false, restarted: true });
    f.deps.isCellRunning.mockReturnValue(false);
    expect(await f.service.execute('update_agent', { cellId: f.worker.id, model: null }, f.coordinator.id)).toMatchObject({ needsRestart: false, restarted: false });
    expect(f.controller.get().projects[0].tabs[0].cells[1].model).toBeUndefined();
    expect(f.deps.deliver).not.toHaveBeenCalled();
  });
  it('rejects unsafe models and invalid profiles before mutating cells', async () => {
    const f = automationFixture();
    await expect(f.service.execute('update_agent', { cellId: f.worker.id, model: 'x; echo bad' }, f.coordinator.id)).rejects.toThrow();
    await expect(f.service.execute('update_agent', { cellId: f.worker.id, profileId: 'shell' }, f.coordinator.id)).rejects.toThrow('AI agent');
    await expect(f.service.execute('update_agent', { cellId: f.outsider.id, model: 'new' }, f.coordinator.id)).rejects.toThrow('access denied');
    expect(f.controller.get().projects[0].tabs[0].cells[1]).toEqual(f.worker);
  });
});


describe('task dependencies', () => {
  it('defers dependent delivery and claims until prerequisites complete and exposes readiness', async () => {
    const f = automationFixture();
    const prerequisite = await f.service.execute('create_task', { cellId: f.coordinator.id, title: 'API', prompt: 'Build API' }, f.coordinator.id) as AgentTask;
    f.deps.deliver.mockClear();
    const dependent = await f.service.execute('create_task', { cellId: f.worker.id, title: 'UI', prompt: 'Use API', dependsOn: [prerequisite.id, prerequisite.id] }, f.coordinator.id) as AgentTask;
    expect(dependent).toMatchObject({ dependsOn: [prerequisite.id], delivery: 'pending' });
    expect(f.deps.deliver).not.toHaveBeenCalled();
    expect(await f.service.execute('get_tasks', { readyOnly: true }, f.worker.id)).toEqual([]);
    expect(await f.service.execute('get_tasks', {}, f.worker.id)).toMatchObject([{ blockedBy: [prerequisite.id], ready: false }]);
    await expect(f.service.execute('update_task', { taskId: dependent.id, status: 'in_progress' }, f.worker.id)).rejects.toThrow('dependencies');
    await f.service.execute('update_task', { taskId: prerequisite.id, status: 'completed', result: { summary: 'API available' } }, f.coordinator.id);
    expect(await f.service.execute('get_tasks', { readyOnly: true }, f.worker.id)).toMatchObject([{ id: dependent.id, blockedBy: [], ready: true }]);
    await f.service.execute('deliver_task', { taskId: dependent.id }, f.worker.id);
    expect(f.deps.deliver).toHaveBeenCalledTimes(1);
    await f.service.execute('update_task', { taskId: dependent.id, status: 'in_progress' }, f.worker.id);
  });
  it('rejects missing or foreign prerequisites and does not consider cancelled work completed', async () => {
    const f = automationFixture();
    const foreign = await f.service.execute('create_task', { cellId: f.outsider.id, title: 'Other', prompt: 'Other' }, f.outsider.id) as AgentTask;
    await expect(f.service.execute('create_task', { cellId: f.worker.id, title: 'Bad', prompt: 'Bad', dependsOn: ['missing'] }, f.coordinator.id)).rejects.toThrow('this project');
    await expect(f.service.execute('create_task', { cellId: f.worker.id, title: 'Bad', prompt: 'Bad', dependsOn: [foreign.id] }, f.coordinator.id)).rejects.toThrow('this project');
    const prerequisite = await f.service.execute('create_task', { cellId: f.worker.id, title: 'First', prompt: 'First' }, f.coordinator.id) as AgentTask;
    const dependent = await f.service.execute('create_task', { cellId: f.worker.id, title: 'Second', prompt: 'Second', dependsOn: [prerequisite.id] }, f.coordinator.id) as AgentTask;
    await f.service.execute('update_task', { taskId: prerequisite.id, status: 'cancelled' }, f.worker.id);
    await expect(f.service.execute('update_task', { taskId: dependent.id, status: 'in_progress' }, f.worker.id)).rejects.toThrow('dependencies');
  });
});


it('reports unavailable or failing runtime restart without typing into the agent shell', async () => {
  const f = automationFixture();
  const withoutRestart = new AutomationService(f.controller, {
    createWorktree: f.deps.createWorktree, removeWorktree: f.deps.removeWorktree,
    startCells: f.deps.startCells, deliver: f.deps.deliver, isCellRunning: f.deps.isCellRunning,
  });
  expect(await withoutRestart.execute('update_agent', { cellId: f.worker.id, model: 'new', restart: true }, f.coordinator.id))
    .toMatchObject({ needsRestart: true, restarted: false, restartReason: 'Safe runtime restart is unavailable.' });
  f.deps.restartAgent.mockRejectedValueOnce(new Error('Runtime rejected restart'));
  expect(await f.service.execute('update_agent', { cellId: f.worker.id, restart: true }, f.coordinator.id))
    .toMatchObject({ needsRestart: true, restarted: false, restartReason: 'Runtime rejected restart' });
  expect(f.deps.deliver).not.toHaveBeenCalled();
});


describe('combined agent inbox', () => {
  it('batches own tasks/messages and optionally acknowledges only the returned page, including paused', async () => {
    const f = automationFixture();
    await f.service.execute('create_task', { cellId: f.worker.id, title: 'Work', prompt: 'Work' }, f.coordinator.id);
    await f.service.execute('create_task', { cellId: f.coordinator.id, title: 'Private', prompt: 'Private' }, f.coordinator.id);
    const first = await f.service.execute('send_message', { toCellId: f.worker.id, text: 'First' }, f.coordinator.id) as { id: string };
    await f.service.execute('send_message', { toCellId: f.worker.id, text: 'Second' }, f.coordinator.id);
    await f.service.execute('send_message', { toCellId: f.coordinator.id, text: 'Private' }, f.worker.id);
    const inbox = await f.service.execute('read_inbox', { limit: 1 }, f.worker.id) as { tasks: AgentTask[]; messages: { id: string }[]; acknowledgedMessageIds: string[]; hasMoreMessages: boolean };
    expect(inbox.tasks).toHaveLength(1);
    expect(inbox.tasks[0].cellId).toBe(f.worker.id);
    expect(inbox.messages.map((m) => m.id)).toEqual([first.id]);
    expect(inbox.acknowledgedMessageIds).toEqual([]);
    expect(inbox.hasMoreMessages).toBe(true);
    await f.service.execute('set_paused', { paused: true });
    expect(await f.service.execute('read_inbox', { limit: 1, acknowledge: true }, f.worker.id)).toMatchObject({ acknowledgedMessageIds: [first.id] });
    expect(await f.service.execute('get_messages', {}, f.worker.id)).toMatchObject([{ text: 'Second' }]);
    expect(await f.service.execute('get_messages', {}, f.coordinator.id)).toMatchObject([{ text: 'Private' }]);
    await expect(f.service.execute('read_inbox', { limit: 101 }, f.worker.id)).rejects.toThrow();
  });
});

describe('closing grids through MCP', () => {
  it('archives finished grids, preserves worktrees and stops only their cells', async () => {
    const f = automationFixture();
    const stopCells = vi.fn(async (_ids: string[]) => {});
    const service = new AutomationService(f.controller, { ...f.deps, stopCells });
    const created = await service.execute('create_grid', { name: 'Review', cells: [{ profileId: 'claude', role: 'worker', worktree: true }] }, f.coordinator.id) as { gridId: string; cellIds: string[] };
    const result = await service.execute('close_grid', { gridId: created.gridId }, f.coordinator.id);
    expect(result).toMatchObject({ archivedGridId: created.gridId, stoppedCellIds: created.cellIds });
    const project = f.controller.get().projects[0];
    expect(project.tabs.some((t) => t.id === created.gridId)).toBe(false);
    expect(project.archive.find((t) => t.id === created.gridId)?.cells[0].worktree).toBeDefined();
    expect(stopCells).toHaveBeenCalledWith(created.cellIds);
    expect(f.deps.removeWorktree).not.toHaveBeenCalled();
  });
  it('stops SSH cells of a closed grid without naming them to MCP (spec 11)', async () => {
    const f = automationFixture();
    const stopCells = vi.fn(async (_ids: string[]) => {});
    const service = new AutomationService(f.controller, { ...f.deps, stopCells });
    const created = await service.execute('create_grid', { name: 'Mixed', cells: [{ profileId: 'claude', role: 'worker' }, { profileId: 'shell' }] }, f.coordinator.id) as { gridId: string; cellIds: string[] };
    const sshHostId = '00000000-0000-4000-8000-000000000001';
    f.controller.change((s) => updateCell(s, created.cellIds[1], { ssh: { hostId: sshHostId } }));
    const result = await service.execute('close_grid', { gridId: created.gridId }, f.coordinator.id);
    expect(result).toEqual({ archivedGridId: created.gridId, stoppedCellIds: [created.cellIds[0]] });
    expect(JSON.stringify(result)).not.toContain(created.cellIds[1]);
    expect(stopCells).toHaveBeenCalledWith(created.cellIds);
  });
  it('guards role, project, own grid, paused operation and unfinished tasks', async () => {
    const f = automationFixture();
    const stopCells = vi.fn(async (_ids: string[]) => {});
    const service = new AutomationService(f.controller, { ...f.deps, stopCells });
    const created = await service.execute('create_grid', { name: 'Worker', cells: [{ profileId: 'claude', role: 'worker', prompt: 'Review' }] }, f.coordinator.id) as { gridId: string; cellIds: string[] };
    await expect(service.execute('close_grid', { gridId: created.gridId }, f.worker.id)).rejects.toThrow('coordinator');
    await expect(service.execute('close_grid', { gridId: f.project.tabs[0].id }, f.coordinator.id)).rejects.toThrow('own grid');
    await expect(service.execute('close_grid', { gridId: created.gridId }, f.outsider.id)).rejects.toThrow();
    await expect(service.execute('close_grid', { gridId: created.gridId }, f.coordinator.id)).rejects.toThrow('unfinished');
    expect(stopCells).not.toHaveBeenCalled();
    await service.execute('set_paused', { paused: true });
    await expect(service.execute('close_grid', { gridId: created.gridId, cancelTasks: true }, f.coordinator.id)).rejects.toThrow('paused');
    await service.execute('set_paused', { paused: false });
    await service.execute('close_grid', { gridId: created.gridId, cancelTasks: true }, f.coordinator.id);
    expect(f.controller.get().automation.tasks.find((t) => t.cellId === created.cellIds[0])?.status).toBe('cancelled');
  });
});

describe('review fixes: ownership, launch settings, inbox acknowledgement', () => {
  it('lets only coordinators change launch settings and wait on other cells\' tasks', async () => {
    const f = automationFixture();
    for (const patch of [{ model: 'gpt-5.4' }, { profileId: 'codex' }, { restart: true }]) {
      await expect(f.service.execute('update_agent', { cellId: f.worker.id, ...patch }, f.worker.id)).rejects.toThrow('coordinator');
    }
    await f.service.execute('update_agent', { cellId: f.worker.id, name: 'Own name' }, f.worker.id);
    const task = await f.service.execute('create_task', { cellId: f.coordinator.id, title: 'Lead only', prompt: 'p' }, f.coordinator.id) as AgentTask;
    await expect(f.service.execute('wait_for', { taskIds: [task.id], timeoutSec: 1 }, f.worker.id)).rejects.toThrow('Task not found.');
    await f.service.execute('update_task', { taskId: task.id, status: 'blocked', blockedReason: 'private' }, f.coordinator.id);
    expect(await f.service.execute('wait_for', { taskIds: [task.id], timeoutSec: 1 }, f.coordinator.id)).toMatchObject({ event: 'tasks' });
  });
  it('acknowledges only messages up to ackMaxChars', async () => {
    const f = automationFixture();
    const long = await f.service.execute('send_message', { toCellId: f.worker.id, text: 'x'.repeat(50) }, f.coordinator.id) as { id: string };
    const short = await f.service.execute('send_message', { toCellId: f.worker.id, text: 'ok' }, f.coordinator.id) as { id: string };
    const inbox = await f.service.execute('read_inbox', { acknowledge: true, ackMaxChars: 10 }, f.worker.id) as { messages: Array<{ id: string; readAt?: number }>; acknowledgedMessageIds: string[] };
    expect(inbox.acknowledgedMessageIds).toEqual([short.id]);
    expect(inbox.messages.find((m) => m.id === long.id)!.readAt).toBeUndefined();
    expect(f.controller.get().automation.messages.find((m) => m.id === long.id)!.readAt).toBeUndefined();
  });
  it('never shows SSH cells or SSH hosts to MCP (R4, spec 11)', async () => {
    const f = automationFixture();
    const sshHost = { id: '00000000-0000-4000-8000-000000000001', label: 'secret-host-label', address: 'internal.example', port: 22, username: 'root', createdAt: 0, updatedAt: 0 };
    f.controller.change((s) => {
      const withHost = { ...s, sshHosts: [sshHost] };
      const withCell = addTab(withHost, f.project.id, { layout: layoutForCount(1), cells: [{ profileId: 'claude', role: 'worker', ssh: { hostId: sshHost.id } }] });
      return upsertPreset(withCell, { id: 'ssh-preset', name: 'ssh', layout: layoutForCount(1), cells: [{ profileId: 'shell', worktree: false, sshHostId: sshHost.id }] });
    });
    const sshCell = f.controller.get().projects[0].tabs.at(-1)!.cells[0];
    const agents = await f.service.execute('list_agents', {}, f.coordinator.id);
    const library = await f.service.execute('list_library', {}, f.coordinator.id);
    expect(JSON.stringify(agents)).not.toContain(sshCell.id);
    for (const text of [JSON.stringify(agents), JSON.stringify(library)]) {
      expect(text).not.toContain('secret-host-label');
      expect(text).not.toContain('internal.example');
      expect(text).not.toContain(sshHost.id);
    }
    await expect(f.service.execute('get_context', {}, sshCell.id)).rejects.toThrow();
  });
});

// 1.1.1 grid templates (test/grid-templates.test.ts covers capture, apply and normalisation).
describe('opening a template through create_grid', () => {
  it('keeps folders, muted flags and sizes for the user and refuses folders from agents', async () => {
    const f = automationFixture();
    const layout = { ...layoutForCount(2), colSizes: [3, 1] };
    const created = await f.service.execute('create_grid', { projectId: f.project.id, name: 'From template', layout, cells: [
      { profileId: 'claude', dir: 'D:/own/web', muted: true }, { profileId: 'codex', dir: 'relative' },
    ] }) as { gridId: string };
    const tab = f.controller.get().projects[0].tabs.find((t) => t.id === created.gridId)!;
    expect(tab.layout.colSizes).toEqual([3, 1]);
    expect(tab.cells[0]).toMatchObject({ dir: 'D:/own/web', muted: true });
    expect(tab.cells[1].dir).toBeUndefined();
    await expect(f.service.execute('create_grid', { name: 'Agent', cells: [{ profileId: 'codex', dir: 'D:/elsewhere' }] }, f.coordinator.id)).rejects.toThrow('not available to agents');
    await expect(f.service.execute('save_preset', { name: 'Agent', cells: [{ profileId: 'codex', dir: 'D:/elsewhere' }] }, f.coordinator.id)).rejects.toThrow('not available to agents');
  });
  it('ignores a template folder when an agent starts it by presetId', async () => {
    const f = automationFixture();
    f.controller.change((s) => upsertPreset(s, { id: 'tp', name: 'T', layout: layoutForCount(1), cells: [{ profileId: 'codex', worktree: false, dir: 'web', muted: true }] }));
    const created = await f.service.execute('create_grid', { name: 'P', presetId: 'tp' }, f.coordinator.id) as { gridId: string };
    const tab = f.controller.get().projects[0].tabs.find((t) => t.id === created.gridId)!;
    expect(tab.cells[0].dir).toBeUndefined();
    expect(tab.cells[0].muted).toBe(true);
  });
});
