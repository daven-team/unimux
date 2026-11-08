import { describe, expect, it } from 'vitest';
import { OptimisticState } from '../src/shared/optimisticState';
import {
  addProject, defaultState, removeProject, updateProject, updateSettings,
} from '../src/shared/state';
import { mergeStateEdit, type StateEdit, type StateSnapshot } from '../src/shared/stateEdits';
import { stateChange, type StateChange } from '../src/shared/statePatch';
import { StateSync } from '../src/shared/stateSync';
import type { AppState } from '../src/shared/types';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/**
 * The app side of the state (1.1.4's StateController, now unimux-state's controller): every change gets the next revision
 * and is pushed; an edit is merged onto the current state. The normalization of an edit is left out (nothing here needs it).
 */
class StateController {
  private revision = 0;
  constructor(private state: AppState, private readonly changed: (snapshot: StateSnapshot) => void) {}
  get(): AppState { return this.state; }
  snapshot(): StateSnapshot { return { state: this.state, revision: this.revision }; }
  change(fn: (state: AppState) => AppState, editId?: string): StateSnapshot {
    this.state = fn(this.state);
    const snapshot = { state: this.state, revision: ++this.revision, editId };
    this.changed(snapshot);
    return snapshot;
  }
  apply(edit: StateEdit): StateSnapshot { return this.change((state) => mergeStateEdit(state, edit), edit.id); }
}

/** A renderer (StateSync) and the app's state (StateController) connected by an unreliable, interleaved network. */

describe('the reviewed scenario: an edit pending across a gap', () => {
  it('after the missed patch and the resync the edit is settled, so the later changes of main show on the screen', async () => {
    let initial = addProject(defaultState(), { name: 'P', path: '/p' });
    initial = addProject(initial, { name: 'Q', path: '/q' });
    const [p, q] = initial.projects;
    const pushes: StateChange[] = [];
    let previous = initial;
    const controller = new StateController(clone(initial), (snapshot) => { pushes.push(clone(stateChange(previous, snapshot))); previous = snapshot.state; });
    let view = clone(initial);
    const sync = new StateSync(clone(controller.snapshot()), {
      transport: {
        applyEdit: async (edit) => { const r = controller.apply(clone(edit)); return { revision: r.revision, editId: r.editId }; },
        loadSnapshot: async () => clone(controller.snapshot()),
      },
      setTimer: () => 0,
      onState: (s) => { view = s; },
    });
    sync.init(clone(controller.snapshot()));
    controller.change((s) => updateSettings(s, { fontSize: 20 })); // revision 1: its patch is lost
    pushes.length = 0;
    const next = updateProject(view, p.id, { color: '#ff0000' });
    const edit: StateEdit = { id: 'E', base: view, next };
    view = next;
    sync.submit(edit); // main applies it as revision 2 and sends a patch that does not follow what the renderer has
    await flush();
    for (const change of pushes.splice(0)) sync.receive(change);
    await flush();
    expect(sync.pendingCount).toBe(0);
    // main removes Q and recolors P: the screen has to follow, with no zombie edit repainting P red
    controller.change((s) => updateProject(removeProject(s, q.id), p.id, { color: '#0000ff' }));
    for (const change of pushes.splice(0)) sync.receive(change);
    await flush();
    expect(view.projects.map((x) => [x.id, x.color])).toEqual([[p.id, '#0000ff']]);
    expect(view).toEqual(clone(controller.get()));
  });
});

describe('OptimisticState acknowledgements', () => {
  const state = () => addProject(defaultState(), { name: 'A', path: '/a' });

  it('drops an edit once the confirmed revision reaches the revision of its ack, also for a duplicated ack', () => {
    const s0 = state();
    const o = new OptimisticState({ state: s0, revision: 1 });
    const next = updateSettings(s0, { fontSize: 21 });
    o.stage({ id: 'x', base: s0, next });
    expect(o.ack('x', 2).behind).toBe(true);
    expect(o.pendingCount).toBe(1);
    o.accept({ state: next, revision: 2 });
    expect(o.pendingCount).toBe(0);
    expect(o.ack('x', 2)).toMatchObject({ dropped: false, behind: false }); // duplicated ack
    expect(o.pendingCount).toBe(0);
  });

  it('an ack whose revision is already confirmed drops the edit at once', () => {
    const s0 = state();
    const o = new OptimisticState({ state: s0, revision: 5 });
    o.stage({ id: 'x', base: s0, next: updateSettings(s0, { fontSize: 22 }) });
    expect(o.ack('x', 4)).toMatchObject({ dropped: true, behind: false });
  });

  it('a snapshot clears the edits sent before it was requested, not the ones sent after', () => {
    const s0 = state();
    const o = new OptimisticState({ state: s0, revision: 1 });
    o.stage({ id: 'early', base: s0, next: updateSettings(s0, { fontSize: 9 }) });
    const covered = o.pendingIds();
    o.stage({ id: 'late', base: s0, next: updateSettings(s0, { fontSize: 10 }) });
    o.acceptSnapshot({ state: updateSettings(s0, { fontSize: 9 }), revision: 2 }, covered);
    expect(o.pendingIds()).toEqual(['late']);
  });

  it('a duplicated or stale patch changes nothing but still settles its edit', () => {
    const s0 = state();
    const s1 = updateSettings(s0, { fontSize: 11 });
    const o = new OptimisticState({ state: s0, revision: 1 });
    const change = stateChange(s0, { state: s1, revision: 2, editId: 'x' });
    o.stage({ id: 'x', base: s0, next: s1 });
    expect(o.acceptChange(change)?.settings.fontSize).toBe(11);
    expect(o.acceptChange(change)?.settings.fontSize).toBe(11); // the duplicate does not ask for a snapshot
    expect(o.revision).toBe(2);
  });
});
