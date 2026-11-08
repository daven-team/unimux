import { describe, expect, it } from 'vitest';
import { layoutForCount } from '../src/shared/layout';
import {
  addProject, addTab, defaultState, updateCell,
} from '../src/shared/state';
import { applyPatch, applyStateChange, diffState, pruneEdit, stateChange } from '../src/shared/statePatch';
import { type StateEdit } from '../src/shared/stateEdits';
import type { AppState } from '../src/shared/types';

/** A realistic state: 4 projects x 3 grids x 3 cells. */
function bigState(): AppState {
  let s = defaultState();
  for (let p = 0; p < 4; p++) {
    s = addProject(s, { name: `P${p}`, path: `/tmp/p${p}` });
    const projectId = s.activeProjectId!;
    for (let t = 0; t < 3; t++) s = addTab(s, projectId, { name: `Grid ${t}`, layout: layoutForCount(3), cells: [{ profileId: 'claude' }, { profileId: 'claude' }, { profileId: 'codex' }] });
  }
  return s;
}

/** One random, realistic user action (using the real state transitions). */

describe('state patches', () => {
  it('keeps the identity of everything the patch does not touch', () => {
    const before = bigState();
    const cell = before.projects[2].tabs[1].cells[0];
    const after = updateCell(before, cell.id, { color: '#123456' });
    const patch = diffState(before, after)!;
    const result = applyPatch(before, patch) as AppState;
    expect(result.projects[0]).toBe(before.projects[0]);
    expect(result.projects[2].tabs[0]).toBe(before.projects[2].tabs[0]);
    expect(result.projects[2].tabs[1].cells[1]).toBe(before.projects[2].tabs[1].cells[1]);
    expect(result.settings).toBe(before.settings);
    expect(result.projects[2].tabs[1].cells[0].color).toBe('#123456');
  });

  it('refuses a patch that does not fit', () => {
    const before = bigState();
    const after = updateCell(before, before.projects[0].tabs[0].cells[0].id, { color: '#000000' });
    const change = stateChange(before, { state: after, revision: 5 });
    expect(applyStateChange({ state: before, revision: 4 }, change)?.revision).toBe(5);
    expect(applyStateChange({ state: before, revision: 3 }, change)).toBeNull(); // a revision was missed
    expect(applyStateChange({ state: defaultState(), revision: 4 }, change)).toBeNull(); // different content
  });

  it('full snapshots stay supported', () => {
    const state = bigState();
    expect(applyStateChange({ state: defaultState(), revision: 1 }, { full: { state, revision: 9 } })?.state).toBe(state);
    expect(applyStateChange({ state, revision: 9 }, { full: { state: defaultState(), revision: 2 } })?.state).toBe(state); // stale
  });
});

describe('pruned edits', () => {
  it('is much smaller than base plus next for a single change', () => {
    const base = bigState();
    const next = updateCell(base, base.projects[3].tabs[2].cells[1].id, { name: 'renamed' });
    const edit: StateEdit = { id: 'e', base, next };
    const full = JSON.stringify(edit).length;
    const pruned = JSON.stringify(pruneEdit(edit)).length;
    expect(pruned).toBeLessThan(full / 8);
  });
});

