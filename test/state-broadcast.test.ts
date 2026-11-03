// The batched state:changed broadcast (1.1.2): agents' MCP changes go out as one patch per burst, the user's edits at once.
import { describe, expect, it, vi } from 'vitest';
import { AutomationService } from '../src/main/automation';
import { createStateBroadcaster } from '../src/main/stateBroadcast';
import { StateController } from '../src/main/stateController';
import { layoutForCount } from '../src/shared/layout';
import { OptimisticState } from '../src/shared/optimisticState';
import { addProject, addTab, defaultState, updateSettings } from '../src/shared/state';
import type { StateChange } from '../src/shared/statePatch';

function setup() {
  let state = addProject(defaultState(), { name: 'P', path: 'D:/p' });
  state = addTab(state, state.projects[0].id, { layout: layoutForCount(3), cells: [{ profileId: 'claude', role: 'coordinator' }, { profileId: 'codex', role: 'worker' }, { profileId: 'claude', role: 'worker' }] });
  const sent: StateChange[] = [];
  const timers: Array<() => void> = [];
  let broadcaster!: ReturnType<typeof createStateBroadcaster>;
  const controller = new StateController(state, (snapshot, batch) => broadcaster.changed(snapshot, batch));
  broadcaster = createStateBroadcaster({ initial: controller.snapshot(), send: (c) => sent.push(c), setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
  const service = new AutomationService(controller, { createWorktree: async () => { throw new Error('no'); }, removeWorktree: async () => undefined, startCells: vi.fn(), deliver: async () => undefined });
  const [lead, a, b] = controller.get().projects[0].tabs[0].cells;
  // A window: starts from the initial snapshot and applies what it is sent.
  const window = new OptimisticState(controller.snapshot());
  const deliver = () => { for (const change of sent.splice(0)) expect(window.acceptChange(change), 'the change follows the window state').not.toBeNull(); };
  const tick = () => { for (const fn of timers.splice(0)) fn(); };
  return { controller, service, broadcaster, sent, window, deliver, tick, lead, a, b };
}

describe('state broadcast', () => {
  it('sends a burst of agent changes as one patch after the delay, and the window ends with main state', async () => {
    const f = setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => f.service.execute('send_message', { toCellId: i % 2 ? f.a.id : f.b.id, text: `m${i}` }, f.lead.id)));
    expect(f.controller.snapshot().revision).toBe(20); // each message: the insert and its delivery result
    expect(f.sent).toHaveLength(0);
    expect(f.broadcaster.waiting).toBe(20);
    f.tick();
    expect(f.sent).toHaveLength(1);
    expect(JSON.stringify(f.sent[0]).length).toBeLessThan(6000);
    f.deliver();
    expect(f.window.revision).toBe(20);
    expect(f.window.accept({ state: f.controller.get(), revision: 20 })).toEqual(f.controller.get());
  });

  it('a user edit goes out at once and takes the waiting batch with it, in order', async () => {
    const f = setup();
    await f.service.execute('create_task', { cellId: f.a.id, title: 'T', prompt: 'Do it' }, f.lead.id);
    expect(f.sent).toHaveLength(0);
    const edited = updateSettings(f.controller.get(), { fontSize: 15 });
    const snapshot = f.controller.apply({ id: 'edit-1', base: f.controller.get(), next: edited });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ revision: snapshot.revision, base: 0, editId: 'edit-1' });
    f.deliver();
    expect(f.window.revision).toBe(snapshot.revision);
    f.tick(); // the timer of the batch that already went out sends nothing
    expect(f.sent).toHaveLength(0);
  });

  it('user operations through the service (no agent) are not batched; flush sends a waiting batch at once', async () => {
    const f = setup();
    await f.service.execute('create_task', { cellId: f.a.id, title: 'From the panel', prompt: 'Do it' });
    expect(f.sent.length).toBeGreaterThan(0);
    f.deliver();
    await f.service.execute('send_message', { toCellId: f.a.id, text: 'agent' }, f.lead.id);
    expect(f.sent).toHaveLength(0);
    f.broadcaster.flush();
    expect(f.sent).toHaveLength(1);
    f.deliver();
    expect(f.window.revision).toBe(f.controller.snapshot().revision);
    f.broadcaster.flush();
    expect(f.sent).toHaveLength(0);
  });
});
