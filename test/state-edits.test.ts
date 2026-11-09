import { describe, expect, it } from 'vitest';
import { addProject, addTab, defaultState, updateCell, upsertSnippet } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';
import { jsonEqual, mergeStateEdit } from '../src/shared/stateEdits';
import { OptimisticState } from '../src/shared/optimisticState';

function grid(count = 2) {
  let state = addProject(defaultState(), { name: 'Project', path: 'D:/project' });
  state = addTab(state, state.projects[0].id, { layout: layoutForCount(count), cells: [{ profileId: 'codex' }] });
  return state;
}
describe('concurrent renderer and MCP state edits', () => {
  it('keeps later optimistic edits through acknowledgments and ignores stale snapshots', () => {
    const base = grid();
    const cellId = base.projects[0].tabs[0].cells[0].id;
    const optimistic = new OptimisticState({ state: base, revision: 0 });
    const one = updateCell(base, cellId, { name: 'First' });
    const two = updateCell(one, cellId, { name: 'Second' });
    optimistic.stage({ id: 'one', base, next: one });
    optimistic.stage({ id: 'two', base: one, next: two });
    const external = upsertSnippet(base, { id: 'external', name: 'Prompt', text: 'test', autoSend: false });
    expect(optimistic.accept({ state: external, revision: 1 }).projects[0].tabs[0].cells[0].name).toBe('Second');
    const mainOne = mergeStateEdit(external, { base, next: one });
    expect(optimistic.accept({ state: mainOne, revision: 2, editId: 'one' }).projects[0].tabs[0].cells[0].name).toBe('Second');
    const mainTwo = mergeStateEdit(mainOne, { base: one, next: two });
    optimistic.accept({ state: mainTwo, revision: 3, editId: 'two' });
    const stale = optimistic.accept({ state: mainOne, revision: 2, editId: 'one' });
    expect(stale.projects[0].tabs[0].cells[0].name).toBe('Second');
    expect(stale.snippets[0].id).toBe('external');
  });
});

describe('jsonEqual says what comparing the JSON text says', () => {
  const values: unknown[] = [
    null, undefined, 0, 1, NaN, '', 'a', true, false, [], {}, [1, 2], [2, 1], [null], [undefined], [[1]], { a: 1 }, { a: 1, b: 2 }, { b: 2, a: 1 },
    { a: undefined }, { a: undefined, b: 2 }, { b: 2 }, { a: null }, { a: [1, { c: 1 }] }, { a: [1, { c: 2 }] }, { a: {} }, { a: [] },
  ];
  it('for every pair of a set of shapes', () => {
    for (const a of values) for (const b of values) expect([a, b, jsonEqual(a, b)]).toEqual([a, b, JSON.stringify(a) === JSON.stringify(b)]);
  });
});
