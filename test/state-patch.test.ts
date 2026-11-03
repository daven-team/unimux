import { describe, expect, it } from 'vitest';
import { StateController } from '../src/main/stateController';
import { layoutForCount } from '../src/shared/layout';
import { OptimisticState } from '../src/shared/optimisticState';
import {
  addCell, addProject, addTab, closeTab, defaultState, moveProject, moveTab, removeCell, removeProject, restoreTab, setActiveProject, setActiveTab,
  setTabLayout, swapCells, updateCell, updateSettings, upsertSnippet,
} from '../src/shared/state';
import { applyPatch, applyStateChange, diffState, pruneEdit, stateChange, type StateChange } from '../src/shared/statePatch';
import { mergeStateEdit, type StateEdit } from '../src/shared/stateEdits';
import type { AppState } from '../src/shared/types';

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

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

const cellIds = (s: AppState) => s.projects.flatMap((p) => p.tabs.flatMap((t) => t.cells.map((c) => c.id)));

/** One random, realistic user action (using the real state transitions). */
function randomAction(s: AppState, random: () => number): AppState {
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
  const project = pick(s.projects);
  const tabs = project?.tabs ?? [];
  switch (Math.floor(random() * 16)) {
    case 0: return addProject(s, { name: `N${Math.floor(random() * 99)}`, path: '/tmp/x' });
    case 1: return project ? removeProject(s, project.id) : s;
    case 2: return project ? addTab(s, project.id, { layout: layoutForCount(2), cells: [{ profileId: 'shell' }] }) : s;
    case 3: return tabs.length ? closeTab(s, project.id, pick(tabs).id) : s;
    case 4: return project?.archive.length ? restoreTab(s, project.id, pick(project.archive).id) : s;
    case 5: return tabs.length ? addCell(s, project.id, pick(tabs).id, 'claude') : s;
    case 6: { const tab = tabs.length ? pick(tabs) : null; return tab && tab.cells.length > 1 ? removeCell(s, project.id, tab.id, pick(tab.cells).id) : s; }
    case 7: { const tab = tabs.length ? pick(tabs) : null; return tab && tab.cells.length > 1 ? swapCells(s, project.id, tab.id, tab.cells[0].id, tab.cells[tab.cells.length - 1].id) : s; }
    case 8: { const ids = cellIds(s); return ids.length ? updateCell(s, pick(ids), { color: `#${Math.floor(random() * 0xffffff).toString(16)}` }) : s; }
    case 9: { const ids = cellIds(s); return ids.length ? updateCell(s, pick(ids), { session: undefined, name: undefined }) : s; }
    case 10: { const ids = cellIds(s); return ids.length ? updateCell(s, pick(ids), { session: { cli: 'claude', id: `s${Math.floor(random() * 9)}`, confirmed: random() > 0.5 } }) : s; }
    case 11: return tabs.length ? setTabLayout(s, project.id, pick(tabs).id, layoutForCount(tabs.length ? pick(tabs).cells.length : 1)) : s;
    case 12: return project && tabs.length > 1 ? moveTab(s, project.id, tabs[0].id, tabs.length - 1) : s;
    case 13: return s.projects.length > 1 ? moveProject(s, s.projects[0].id, s.projects[s.projects.length - 1].id, 'after') : s;
    case 14: return project ? setActiveTab(setActiveProject(s, project.id), project.id, tabs[0]?.id ?? '') : s;
    default: return random() > 0.5 ? updateSettings(s, { fontSize: 8 + Math.floor(random() * 20) }) : upsertSnippet(s, { id: `sn${Math.floor(random() * 4)}`, name: 'x', text: 'y', autoSend: false });
  }
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe('state patches', () => {
  it('round-trips every real state transition: apply(diff(a, b)) equals b', () => {
    const random = rng(7);
    let state = bigState();
    for (let i = 0; i < 400; i++) {
      const next = randomAction(state, random);
      const patch = diffState(state, next);
      const rebuilt = patch ? applyPatch(clone(state), patch) : state;
      expect(rebuilt, `step ${i}`).toEqual(clone(next));
      state = next;
    }
  });

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

  it('a patch is a small part of the state, and no change yields no patch', () => {
    const before = bigState();
    const after = updateCell(before, before.projects[1].tabs[0].cells[2].id, { color: '#abcdef' });
    expect(diffState(before, before)).toBeNull();
    expect(diffState(before, clone(before))).toBeNull();
    expect(JSON.stringify(diffState(before, after)).length).toBeLessThan(JSON.stringify(after).length / 8);
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

describe('keyed lists that kept their order (1.1.2: the MCP lists)', () => {
  const item = (id: string, n = 0) => ({ id, n, text: `entry ${id}` });
  const list = (count: number) => Array.from({ length: count }, (_, i) => item(`id-${i}`));

  it('names only what changed: an appended entry, a dropped front, an entry changed in place', () => {
    const before = { events: list(200), tasks: list(500) };
    const appended = { ...before, events: [...before.events.slice(1), item('new')] };
    const patch = diffState(before, appended)!;
    expect(patch).toEqual({ o: { events: { s: { drop: 1, add: [item('new')] } } } });
    expect(JSON.stringify(patch).length).toBeLessThan(80);
    const changed = { ...before, tasks: before.tasks.map((t, i) => i === 321 ? { ...t, n: 7 } : t) };
    expect(diffState(before, changed)).toEqual({ o: { tasks: { s: { at: [[321, 'id-321', { o: { n: { v: 7 } } }]] } } } });
    expect(applyPatch(clone(before), diffState(before, changed)!)).toEqual(changed);
    expect(applyPatch(clone(before), patch)).toEqual(appended);
  });

  it('falls back to the full id list for removals in the middle, moves and reappearing ids, and always round-trips', () => {
    const random = rng(3);
    let state = { items: list(30) };
    for (let step = 0; step < 600; step++) {
      let items = [...state.items];
      switch (Math.floor(random() * 6)) {
        case 0: items.push(item(`n-${step}`)); break;
        case 1: items = items.slice(Math.floor(random() * 3)); break;
        case 2: if (items.length) items[Math.floor(random() * items.length)] = { ...items[Math.floor(random() * items.length)], n: step }; break;
        case 3: if (items.length > 2) items.splice(1 + Math.floor(random() * (items.length - 2)), 1); break;
        case 4: if (items.length > 1) items.reverse(); break;
        default: items = items.slice(0, Math.max(0, items.length - 1)); break;
      }
      // Ids stay unique (a keyed list); a duplicate from case 2 is replaced by its own entry.
      const seen = new Set<string>();
      items = items.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
      const next = { items };
      const patch = diffState(state, next);
      expect(patch ? applyPatch(clone(state), patch) : state, `step ${step}`).toEqual(next);
      state = next;
    }
  });

  it('refuses an in-place patch whose entry is not where the patch says (the renderer then asks for a snapshot)', () => {
    const before = { items: list(5) };
    const after = { items: before.items.map((t, i) => i === 2 ? { ...t, n: 1 } : t) };
    const patch = diffState(before, after)!;
    expect(() => applyPatch({ items: [item('x'), ...before.items] }, patch)).toThrow(/missing entry/);
    expect(() => applyPatch({ items: [] }, { o: { items: { s: { drop: 3 } } } })).toThrow(/drops more/);
  });
});

describe('pruned edits', () => {
  it('merge exactly like the full edit, also against a state that moved on meanwhile', () => {
    const random = rng(11);
    for (let run = 0; run < 60; run++) {
      const start = (() => { let s = bigState(); for (let i = 0; i < 5; i++) s = randomAction(s, random); return s; })();
      // The renderer's edit, and another change main applied before the edit arrived (MCP, another edit).
      let next = start;
      for (let i = 0; i < 1 + Math.floor(random() * 3); i++) next = randomAction(next, random);
      let current = start;
      for (let i = 0; i < Math.floor(random() * 4); i++) current = randomAction(current, random);
      const edit: StateEdit = { id: 'e', base: start, next };
      const full = mergeStateEdit(current, edit);
      const pruned = mergeStateEdit(clone(current), clone(pruneEdit(edit)));
      expect(pruned, `run ${run}`).toEqual(clone(full));
    }
  });

  it('is much smaller than base plus next for a single change', () => {
    const base = bigState();
    const next = updateCell(base, base.projects[3].tabs[2].cells[1].id, { name: 'renamed' });
    const edit: StateEdit = { id: 'e', base, next };
    const full = JSON.stringify(edit).length;
    const pruned = JSON.stringify(pruneEdit(edit)).length;
    expect(pruned).toBeLessThan(full / 8);
  });

  it('keeps entries that were added or removed', () => {
    const base = bigState();
    const withTab = addTab(base, base.projects[0].id, { name: 'new', layout: layoutForCount(1), cells: [{ profileId: 'shell' }] });
    const removed = removeProject(withTab, base.projects[1].id);
    const edit: StateEdit = { id: 'e', base, next: removed };
    expect(mergeStateEdit(clone(withTab), clone(pruneEdit(edit)))).toEqual(clone(mergeStateEdit(withTab, edit)));
  });
});

describe('the whole loop: edit, ack, patch', () => {
  it('a renderer that only sees patches ends up with main\'s state, with concurrent MCP changes and lost edits', () => {
    const random = rng(23);
    const initial = bigState();
    let rendererOut: StateChange[] = [];
    let previous = initial;
    const controller = new StateController(initial, (snapshot) => {
      rendererOut.push(clone(stateChange(previous, snapshot)));
      previous = snapshot.state;
    });
    const renderer = new OptimisticState(clone(controller.snapshot()));
    let view = renderer.accept(clone(controller.snapshot()));
    const flush = () => {
      for (const change of rendererOut) {
        const next = renderer.acceptChange(change);
        if (!next) throw new Error('gap');
        view = next;
      }
      rendererOut = [];
    };
    for (let i = 0; i < 150; i++) {
      if (random() < 0.3) {
        controller.change((s) => randomAction(s, random)); // main-side change (MCP)
      } else {
        const next = randomAction(view, random);
        if (next === view) continue;
        const edit: StateEdit = { id: `e${i}`, base: view, next };
        renderer.stage(edit);
        view = next;
        controller.apply(clone(pruneEdit(edit)));
      }
      if (random() < 0.6) flush();
    }
    flush();
    expect(view).toEqual(clone(controller.get()));
  });

  it('a state with a large icon: the edit and the patch stay small', () => {
    const base = bigState();
    base.projects[0] = { ...base.projects[0], icon: { kind: 'image', dataUrl: 'data:image/png;base64,' + 'A'.repeat(80_000) } };
    const next = updateCell(base, base.projects[2].tabs[0].cells[0].id, { color: '#ffffff' });
    const edit: StateEdit = { id: 'e', base, next };
    expect(JSON.stringify(edit).length).toBeGreaterThan(150_000);
    expect(JSON.stringify(pruneEdit(edit)).length).toBeLessThan(3000);
    expect(JSON.stringify(stateChange(base, { state: next, revision: 2 })).length).toBeLessThan(1500);
  });
});
