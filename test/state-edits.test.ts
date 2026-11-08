import { describe, expect, it } from 'vitest';
import { addProject, addTab, defaultState, updateCell, upsertSnippet } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';
import { mergeStateEdit } from '../src/shared/stateEdits';
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
