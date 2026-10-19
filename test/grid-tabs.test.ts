// 1.0.0 grid tabs across projects: the global strip order, its migration and the open / close / switch logic.
import { describe, expect, it } from 'vitest';
import {
  gridTabLabels, groupWorkspaceKeys, mergeWorkspaceOrder, migrateWorkspaceOrders, normalizeWorkspaceOrder, parseWorkspaceKey,
  sameOrder, sortTabsByOrder, stepWorkspace, stripKeys,
} from '../src/shared/workspaceOrder';
import { addProject, addTab, closeTab, defaultState, focusGrid, normalizeState, restoreTab } from '../src/shared/state';
import { decideShortcut } from '../src/shared/shortcutDispatch';
import { resolveShortcuts } from '../src/shared/shortcuts';
import type { AppState } from '../src/shared/types';
import { layoutForCount } from '../src/shared/layout';

const cells = [{ profileId: 'shell' }];
const layout = layoutForCount(1);

/** Two projects, A with grids a1 and a2, B with grid b1. */
function twoProjects(): { s: AppState; a: string; b: string; a1: string; a2: string; b1: string } {
  let s = addProject(defaultState(), { name: 'Alpha', path: '/tmp/alpha' });
  const a = s.projects[0].id;
  s = addProject(s, { name: 'Beta', path: '/tmp/beta' });
  const b = s.projects[1].id;
  s = addTab(s, a, { layout, cells, name: 'Grid 1' });
  s = addTab(s, a, { layout, cells, name: 'Grid 2' });
  s = addTab(s, b, { layout, cells, name: 'Grid 1' });
  const [a1, a2] = s.projects[0].tabs.map((t) => t.id);
  const b1 = s.projects[1].tabs[0].id;
  return { s, a, b, a1, a2, b1 };
}

describe('the stored order', () => {
  it('keeps known keys of open grids, drops unknown kinds, closed grids and duplicates', () => {
    const ids = new Set(['g1', 'g2']);
    expect(normalizeWorkspaceOrder(['grid:g2', 'db:x', 'file:p:a.ts', 'grid:gone', 'settings', 'grid:g2', 7, 'ssh', 'file:', 'grid:g1'], ids))
      .toEqual(['grid:g2', 'file:p:a.ts', 'settings', 'ssh', 'grid:g1']);
    expect(normalizeWorkspaceOrder('nonsense', ids)).toEqual([]);
    expect(normalizeWorkspaceOrder(undefined, ids)).toBeUndefined();
  });

  it('is repaired by normalizeState and stays absent until migrated', () => {
    const { s, a1, b1 } = twoProjects();
    const loaded = normalizeState(JSON.parse(JSON.stringify({ ...s, workspaceOrder: [`grid:${b1}`, 'grid:removed', 42, `grid:${a1}`] })));
    expect(loaded!.workspaceOrder).toEqual([`grid:${b1}`, `grid:${a1}`]);
    expect('workspaceOrder' in normalizeState(JSON.parse(JSON.stringify(s)))!).toBe(false);
    // A grid of a removed project disappears with it.
    const without = normalizeState(JSON.parse(JSON.stringify({ ...s, projects: [s.projects[0]], workspaceOrder: [`grid:${b1}`, `grid:${a1}`] })));
    expect(without!.workspaceOrder).toEqual([`grid:${a1}`]);
  });

  it('migrates the per-project localStorage orders of 0.9.x into one list in sidebar order', () => {
    const { s, a, b, a1, a2, b1 } = twoProjects();
    const legacy = { [b]: ['file:x', `grid:${b1}`, 'settings'], [a]: [`grid:${a2}`, 'file:y'], 'no-project': ['ssh'], other: 'bad' };
    expect(migrateWorkspaceOrders(legacy, s.projects)).toEqual([`grid:${a2}`, 'file:y', `grid:${a1}`, 'file:x', `grid:${b1}`, 'settings']);
    expect(migrateWorkspaceOrders(null, s.projects)).toEqual([`grid:${a1}`, `grid:${a2}`, `grid:${b1}`]);
    expect(migrateWorkspaceOrders('broken', [])).toEqual([]);
  });
});

describe('ordering', () => {
  it('drops closed tabs, keeps the saved places and puts a new grid right after the tab in front', () => {
    const saved = ['grid:a1', 'file:f', 'grid:b1', 'settings'];
    expect(mergeWorkspaceOrder(saved, ['grid:a1', 'grid:b1', 'grid:new', 'file:f', 'settings'], 'file:f'))
      .toEqual(['grid:a1', 'file:f', 'grid:new', 'grid:b1', 'settings']);
    // No anchor (first start) or an anchor that is gone: new grids go to the end.
    expect(mergeWorkspaceOrder(saved, ['grid:a1', 'grid:new', 'file:f'], null)).toEqual(['grid:a1', 'file:f', 'grid:new']);
    expect(mergeWorkspaceOrder(saved, ['grid:a1', 'grid:new'], 'grid:closed')).toEqual(['grid:a1', 'grid:new']);
    // New files, Settings and the SSH view are appended at the end as before.
    expect(mergeWorkspaceOrder(['grid:a1', 'grid:b1'], ['grid:a1', 'grid:b1', 'file:new', 'ssh'], 'grid:a1')).toEqual(['grid:a1', 'grid:b1', 'file:new', 'ssh']);
  });

  it('shows the grids of every project and the files of the project on screen and outside projects', () => {
    const keys = stripKeys({
      settingsOpen: false, sshOpen: true, activeProjectId: 'A',
      projects: [{ id: 'A', tabs: [{ id: 'a1' }] }, { id: 'B', tabs: [{ id: 'b1' }] }],
      files: [{ id: 'fa', projectId: 'A' }, { id: 'fb', projectId: 'B' }, { id: 'remote', projectId: '' }],
    });
    expect(keys.all).toEqual(['ssh', 'grid:a1', 'grid:b1', 'file:fa', 'file:fb', 'file:remote']);
    expect(keys.shown).toEqual(['ssh', 'grid:a1', 'grid:b1', 'file:fa', 'file:remote']);
  });

  it('sorts each project grids by the strip so the sidebar follows a drag across projects', () => {
    const tabs = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    expect(sortTabsByOrder(tabs, ['grid:other', 'grid:z', 'grid:x', 'grid:y']).map((t) => t.id)).toEqual(['z', 'x', 'y']);
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], undefined)).toBe(false);
  });
});

describe('open, close and switch', () => {
  it('cycles through the whole strip and wraps around', () => {
    const shown = ['grid:a1', 'file:f', 'grid:b1'];
    expect(stepWorkspace(shown, 'grid:a1', 1)).toBe('file:f');
    expect(stepWorkspace(shown, 'grid:b1', 1)).toBe('grid:a1');
    expect(stepWorkspace(shown, 'grid:a1', -1)).toBe('grid:b1');
    expect(stepWorkspace(shown, null, -1)).toBe('grid:b1');
    expect(stepWorkspace(['grid:a1'], 'grid:a1', 1)).toBeNull();
    expect(stepWorkspace([], null, 1)).toBeNull();
  });

  it('tells what a key closes or opens', () => {
    expect(parseWorkspaceKey('settings')).toEqual({ kind: 'settings' });
    expect(parseWorkspaceKey('ssh')).toEqual({ kind: 'ssh' });
    expect(parseWorkspaceKey('file:p:src/a.ts')).toEqual({ kind: 'file', id: 'p:src/a.ts' });
    expect(parseWorkspaceKey('grid:g1')).toEqual({ kind: 'grid', id: 'g1' });
    expect(parseWorkspaceKey('grid:')).toBeNull();
    expect(parseWorkspaceKey('db:x')).toBeNull();
  });

  it('a click on a grid of another project switches the project and the grid', () => {
    const { s, a, b, b1, a1 } = twoProjects();
    const onA = { ...s, activeProjectId: a };
    const next = focusGrid(onA, b, b1);
    expect(next.activeProjectId).toBe(b);
    expect(next.projects.find((p) => p.id === b)!.activeTabId).toBe(b1);
    // Nothing of project A is closed or changed.
    expect(next.projects.find((p) => p.id === a)).toBe(onA.projects.find((p) => p.id === a));
    // A grid that is not in that project (or no longer open) changes nothing.
    expect(focusGrid(onA, b, a1)).toBe(onA);
  });

  it('closing a grid moves it to the archive and out of the strip; restoring brings it back next to the tab in front', () => {
    const { s, a, a1, a2, b1 } = twoProjects();
    const closed = closeTab(s, a, a1);
    const ids = new Set(closed.projects.flatMap((p) => p.tabs.map((t) => t.id)));
    expect(closed.projects[0].archive[0].id).toBe(a1);
    expect(normalizeWorkspaceOrder([`grid:${a1}`, `grid:${a2}`, `grid:${b1}`], ids)).toEqual([`grid:${a2}`, `grid:${b1}`]);
    const restored = restoreTab(closed, a, a1);
    const available = stripKeys({ settingsOpen: false, sshOpen: false, activeProjectId: a, projects: restored.projects, files: [] }).all;
    expect(mergeWorkspaceOrder([`grid:${a2}`, `grid:${b1}`], available, `grid:${a2}`)).toEqual([`grid:${a2}`, `grid:${a1}`, `grid:${b1}`]);
  });

  it('Mod+Shift+W acts whenever a tab is in front, also a file with no grid behind it', () => {
    const ctx = {
      resolution: resolveShortcuts({}, 'win32'), languageChosen: true, recording: false, overlayOpen: false, paletteOpen: false,
      settingsActive: false, hasProject: false, hasTab: true, target: 'other' as const,
    };
    const ev = { key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(decideShortcut(ev, ctx)).toBe('tab.close');
    expect(decideShortcut(ev, { ...ctx, hasTab: false })).toBeNull();
  });
});

describe('labels and the all-tabs menu', () => {
  it('prefixes the project name only when grids of different projects share a name', () => {
    const { s, a1, a2, b1 } = twoProjects();
    const labels = gridTabLabels(s.projects);
    expect(labels.get(a1)).toBe('Alpha · Grid 1');
    expect(labels.get(b1)).toBe('Beta · Grid 1');
    expect(labels.get(a2)).toBe('Grid 2');
  });

  it('groups entries by project, tabs outside projects first', () => {
    const owner: Record<string, string | null> = { 'grid:a1': 'A', 'grid:b1': 'B', 'file:fa': 'A', settings: null, 'file:remote': null };
    expect(groupWorkspaceKeys(['grid:b1', 'settings', 'grid:a1', 'file:remote', 'file:fa'], (k) => owner[k], ['A', 'B'])).toEqual([
      { projectId: null, keys: ['settings', 'file:remote'] },
      { projectId: 'A', keys: ['grid:a1', 'file:fa'] },
      { projectId: 'B', keys: ['grid:b1'] },
    ]);
  });
});
