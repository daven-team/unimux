// 1.0.0 grid tabs across projects: the global strip order, its migration and the open / close / switch logic.
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  gridTabLabels, groupWorkspaceKeys, mergeWorkspaceOrder, migrateWorkspaceOrders, normalizeStripScope, normalizeWorkspaceOrder, parseWorkspaceKey,
  neighbourAfterClose, reorderWorkspace, sameOrder, scopeWorkspaceKeys, sortTabsByOrder, stepWorkspace, stripKeyOwner, stripKeys, syncTabsToOrder,
} from '../src/shared/workspaceOrder';
import { addProject, addTab, closeTab, defaultState, focusGrid, normalizeState, restoreTab, updateProject } from '../src/shared/state';
import { stripTabColor } from '../src/shared/tabStrip';
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
    // 'ssh' (the SSH view's tab up to 1.0.3) is dropped: the view has no tab any more.
    expect(normalizeWorkspaceOrder(['grid:g2', 'db:x', 'file:p:a.ts', 'grid:gone', 'settings', 'grid:g2', 7, 'ssh', 'file:', 'grid:g1'], ids))
      .toEqual(['grid:g2', 'file:p:a.ts', 'settings', 'grid:g1']);
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
    // A new file tab also opens right after the tab in front (like VS Code); Settings is appended at the end.
    expect(mergeWorkspaceOrder(['grid:a1', 'grid:b1'], ['grid:a1', 'grid:b1', 'file:new', 'settings'], 'grid:a1')).toEqual(['grid:a1', 'file:new', 'grid:b1', 'settings']);
    expect(mergeWorkspaceOrder(['file:c', 'grid:b1'], ['file:c', 'grid:b1', 'file:d'], 'file:c')).toEqual(['file:c', 'file:d', 'grid:b1']);
    expect(mergeWorkspaceOrder(['grid:a1', 'grid:b1'], ['grid:a1', 'grid:b1', 'file:new'], null)).toEqual(['grid:a1', 'grid:b1', 'file:new']);
  });

  it('shows the grids and the files of every project and the files outside projects', () => {
    const keys = stripKeys({
      settingsOpen: true,
      projects: [{ id: 'A', tabs: [{ id: 'a1' }] }, { id: 'B', tabs: [{ id: 'b1' }] }],
      files: [{ id: 'fa', projectId: 'A' }, { id: 'fb', projectId: 'B' }, { id: 'remote', projectId: '' }],
    });
    expect(keys).toEqual(['settings', 'grid:a1', 'grid:b1', 'file:fa', 'file:fb', 'file:remote']);
  });

  it('sorts each project grids by the strip so the sidebar follows a drag across projects', () => {
    const tabs = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    expect(sortTabsByOrder(tabs, ['grid:other', 'grid:z', 'grid:x', 'grid:y']).map((t) => t.id)).toEqual(['z', 'x', 'y']);
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], undefined)).toBe(false);
  });

  it('keeps every project grids in the strip order (a new grid placed after the front tab moves in the sidebar too)', () => {
    const projects = [{ id: 'A', tabs: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }, { id: 'B', tabs: [{ id: 'b1' }] }];
    const next = syncTabsToOrder(projects, ['grid:a1', 'grid:b1', 'grid:a3', 'grid:a2']);
    expect(next[0].tabs.map((t) => t.id)).toEqual(['a1', 'a3', 'a2']);
    expect(next[1]).toBe(projects[1]);
    // Nothing moves: the same array, so no state edit.
    expect(syncTabsToOrder(projects, ['grid:a1', 'grid:a2', 'grid:a3', 'grid:b1'])).toBe(projects);
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
    expect(parseWorkspaceKey('ssh')).toBeNull(); // no SSH tab since 1.0.4
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
    const available = stripKeys({ settingsOpen: false, projects: restored.projects, files: [] });
    expect(mergeWorkspaceOrder([`grid:${a2}`, `grid:${b1}`], available, `grid:${a2}`)).toEqual([`grid:${a2}`, `grid:${a1}`, `grid:${b1}`]);
  });

  it('closing the tab in front brings its strip neighbour (right, else left) to the front, also of another project', () => {
    const shown = ['grid:a1', 'grid:b1', 'file:f'];
    expect(neighbourAfterClose(shown, 'grid:a1')).toBe('grid:b1');
    expect(neighbourAfterClose(shown, 'file:f')).toBe('grid:b1');
    expect(neighbourAfterClose(['grid:a1'], 'grid:a1')).toBeNull();
    expect(neighbourAfterClose(shown, 'grid:gone')).toBeNull();
  });

  it('Mod+Tab and Mod+Shift+Tab also work with Settings in front (Settings is a tab of the strip)', () => {
    const ctx = {
      resolution: resolveShortcuts({}, 'win32'), languageChosen: true, recording: false, overlayOpen: false, paletteOpen: false,
      settingsActive: true, hasProject: true, hasTab: true, target: 'other' as const,
    };
    expect(decideShortcut({ code: 'Tab', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, ctx)).toBe('tab.next');
    expect(decideShortcut({ code: 'Tab', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, ctx)).toBe('tab.prev');
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

describe('strip scope (1.0.4)', () => {
  const input = {
    projects: [{ id: 'A', tabs: [{ id: 'a1' }, { id: 'a2' }] }, { id: 'B', tabs: [{ id: 'b1' }] }],
    files: [{ id: 'fa', projectId: 'A' }, { id: 'fb', projectId: 'B' }, { id: 'remote', projectId: '' }, { id: 'db', projectId: '' }],
  };
  const order = ['grid:b1', 'settings', 'grid:a1', 'file:remote', 'file:fb', 'grid:a2', 'file:fa', 'file:db'];
  const ownerOf = stripKeyOwner(input);

  it('knows the project of each key; Settings and tabs outside the projects have none', () => {
    expect(['grid:a1', 'grid:b1', 'file:fa', 'file:fb', 'file:remote', 'settings', 'grid:gone'].map(ownerOf)).toEqual(['A', 'B', 'A', 'B', null, null, null]);
  });

  it("'all' shows every tab, 'project' only the active project's and those of no project, in the saved order", () => {
    expect(scopeWorkspaceKeys(order, 'all', 'A', ownerOf)).toEqual(order);
    expect(scopeWorkspaceKeys(order, 'project', 'A', ownerOf)).toEqual(['settings', 'grid:a1', 'file:remote', 'grid:a2', 'file:fa', 'file:db']);
    expect(scopeWorkspaceKeys(order, 'project', 'B', ownerOf)).toEqual(['grid:b1', 'settings', 'file:remote', 'file:fb', 'file:db']);
    expect(scopeWorkspaceKeys(order, 'project', null, ownerOf)).toEqual(['settings', 'file:remote', 'file:db']);
  });

  it('only filters the view: a drag among the shown tabs keeps the hidden ones in the global order', () => {
    const shown = scopeWorkspaceKeys(order, 'project', 'A', ownerOf);
    const next = reorderWorkspace(order, 'grid:a2', 'grid:a1', false);
    expect(next).toEqual(['grid:b1', 'settings', 'grid:a2', 'grid:a1', 'file:remote', 'file:fb', 'file:fa', 'file:db']);
    expect(scopeWorkspaceKeys(next, 'project', 'A', ownerOf)).toEqual(['settings', 'grid:a2', 'grid:a1', 'file:remote', 'file:fa', 'file:db']);
    expect(next.filter((key) => !shown.includes(key))).toEqual(['grid:b1', 'file:fb']);
  });

  it('Mod+Tab cycles through the shown tabs only', () => {
    const shown = scopeWorkspaceKeys(['grid:a1', 'grid:b1', 'grid:a2'], 'project', 'A', ownerOf);
    expect(stepWorkspace(shown, 'grid:a1', 1)).toBe('grid:a2');
    expect(stepWorkspace(shown, 'grid:a2', 1)).toBe('grid:a1');
  });

  it("is saved with the settings: 'all' by default, anything unknown falls back to it", () => {
    expect(defaultState().settings.stripScope).toBe('all');
    expect(normalizeStripScope('project')).toBe('project');
    expect(normalizeStripScope('nonsense')).toBe('all');
    expect(normalizeStripScope(undefined)).toBe('all');
    const { s } = twoProjects();
    const raw = JSON.parse(JSON.stringify(s));
    expect(normalizeState({ ...raw, settings: { ...raw.settings, stripScope: 'project' } })!.settings.stripScope).toBe('project');
    delete raw.settings.stripScope;
    expect(normalizeState(raw)!.settings.stripScope).toBe('all');
  });
});

describe('unique grid ids', () => {
  it('normalizeState gives a grid whose id another project (or the archive) already uses a new id; the active tab follows', () => {
    const { s, a, b, a1, a2 } = twoProjects();
    const raw = JSON.parse(JSON.stringify(s)) as AppState;
    const beta = raw.projects.find((p) => p.id === b)!;
    beta.tabs[0].id = a1; // a duplicate of Alpha's first grid
    beta.activeTabId = a1;
    raw.projects.find((p) => p.id === a)!.archive = [{ ...raw.projects[0].tabs[1], id: a2, closedAt: 1 }]; // archived copy of an open id
    const loaded = normalizeState(raw)!;
    const ids = loaded.projects.flatMap((p) => [...p.tabs, ...p.archive].map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    const alpha = loaded.projects.find((p) => p.id === a)!;
    expect(alpha.tabs.map((t) => t.id)).toEqual([a1, a2]); // the first holder keeps its id
    const betaLoaded = loaded.projects.find((p) => p.id === b)!;
    expect(betaLoaded.tabs[0].id).not.toBe(a1);
    expect(betaLoaded.activeTabId).toBe(betaLoaded.tabs[0].id);
    expect(alpha.archive[0].id).not.toBe(a2);
    // A file without duplicates is left as it is.
    expect(normalizeState(JSON.parse(JSON.stringify(s)))!.projects.map((p) => p.tabs.map((t) => t.id))).toEqual(s.projects.map((p) => p.tabs.map((t) => t.id)));
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

describe('strip colours', () => {
  it("gives every grid tab its project's colour, never the grid's own automatic one", () => {
    const { s } = twoProjects();
    const [alpha, beta] = s.projects;
    // New grids get their own, different colours (addTab), so a strip that drew them would differ from tab to tab.
    expect(new Set(alpha.tabs.map((t) => t.color)).size).toBe(alpha.tabs.length);
    expect(alpha.tabs.map((t) => stripTabColor({ project: alpha, grid: t }))).toEqual([alpha.color, alpha.color]);
    expect(stripTabColor({ project: beta, grid: beta.tabs[0] })).toBe(beta.color);
    expect(stripTabColor({ project: alpha, grid: alpha.tabs[0] })).not.toBe(stripTabColor({ project: beta, grid: beta.tabs[0] }));
    // Nor one set explicitly (MCP update_grid): it stays stored, unshown.
    expect(stripTabColor({ project: { color: '#3b82f6' }, grid: { color: '#ef4444' } })).toBe('#3b82f6');
    expect(stripTabColor({ grid: { color: '#ef4444' } })).toBeNull();
    // The tab menu's swatches recolour the project, so every one of its tabs follows.
    const recoloured = updateProject(s, alpha.id, { color: '#ec4899' }).projects[0];
    expect(recoloured.tabs.map((t) => stripTabColor({ project: recoloured, grid: t }))).toEqual(['#ec4899', '#ec4899']);
  });

  it("uses a connection's colour for database tabs and shows none without an owner colour", () => {
    expect(stripTabColor({ connection: { color: '#22c55e' } })).toBe('#22c55e');
    expect(stripTabColor({ connection: {} })).toBeNull();
    expect(stripTabColor({ connection: undefined })).toBeNull();
    // Settings, SSH and files outside the projects.
    expect(stripTabColor({})).toBeNull();
    expect(stripTabColor({ project: null })).toBeNull();
    // The project decides; a value that is not a colour never reaches the CSS.
    expect(stripTabColor({ project: { color: '#3b82f6' }, connection: { color: '#22c55e' } })).toBe('#3b82f6');
    expect(stripTabColor({ project: { color: 'url(x)' } })).toBeNull();
  });

  it("colours each grid tab of the strip through stripTabColor with its grid (1.0.0 painted the grid's colour next to the project's)", () => {
    const titleBar = readFileSync('src/renderer/src/components/TitleBar.tsx', 'utf8');
    const start = titleBar.indexOf('project.tabs.map((t) =>');
    const end = titleBar.indexOf('}))}', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const gridTab = titleBar.slice(start, end);
    expect(gridTab).toContain('const color = stripTabColor({ project, grid: t });');
    expect(gridTab).toContain('style={stripTabStyle(order.indexOf(`grid:${t.id}`), color)}');
    expect(gridTab).not.toMatch(/\bt\.color\b/);
  });
});
