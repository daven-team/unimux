import { describe, expect, it } from 'vitest';
import {
  addDetached, boundsAtPoint, boundsBeside, cellOwners, clampRect, DETACHED_LIMIT, detachedGridIds, displayAt, normalizeDetachedWindows,
  openGrids, ownsCell, removeDetached, restoreBounds, routeChanges, routeMessage, setDetachedPlace, viewOverlay, type DetachedWindow, type DisplayArea,
} from '../src/shared/detached';
import { addProject, addTab, defaultState, normalizeState } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';
import { mergeStateEdit } from '../src/shared/stateEdits';
import { StateController } from '../src/main/stateController';
import { MAIN_WINDOW, WindowRoutes } from '../src/ptyhost/routes';
import type { AppState } from '../src/shared/types';

function twoGrids(): { s: AppState; projectId: string; a: string; b: string } {
  let s = addProject(defaultState(), { name: 'P', path: 'C:\\p' });
  const projectId = s.projects[0].id;
  s = addTab(s, projectId, { name: 'Grid 1', layout: layoutForCount(2), cells: [{ profileId: 'shell' }, { profileId: 'shell' }] });
  s = addTab(s, projectId, { name: 'Grid 5', layout: layoutForCount(1), cells: [{ profileId: 'shell' }] });
  return { s, projectId, a: s.projects[0].tabs[0].id, b: s.projects[0].tabs[1].id };
}
const gridWindow = (id: string, projectId: string, tabId: string, extra: Partial<DetachedWindow> = {}): DetachedWindow => ({ id, target: { kind: 'grid', projectId, tabId }, ...extra });

describe('detached windows registry', () => {
  it('keeps valid entries, one per tab, of open grids only, and repairs a grid that moved project', () => {
    const { s, projectId, a, b } = twoGrids();
    const grids = openGrids(s.projects);
    const raw = [
      gridWindow('w1', projectId, a, { bounds: { x: 10.4, y: 20, width: 800, height: 600 }, displayId: 2, maximized: true }),
      gridWindow('w1', projectId, b), // same window id twice
      gridWindow('w2', projectId, a), // same tab twice
      gridWindow('w3', 'other-project', b), // wrong project: follows the grid
      gridWindow('w4', projectId, 'closed-grid'),
      { id: 'w5', target: { kind: 'file', fileId: 'f', projectId, name: 'a.ts', reopen: { kind: 'project', projectId, relativePath: 'src/a.ts' } } },
      { id: 'w6', target: { kind: 'file', fileId: 'g', projectId: '', name: 'x', reopen: { kind: 'nope' } } },
      { id: 'w7', target: { kind: 'grid' } }, 'junk', null,
    ];
    const out = normalizeDetachedWindows(raw, grids)!;
    expect(out.map((w) => w.id)).toEqual(['w1', 'w3', 'w5']);
    expect(out[0]).toEqual({ id: 'w1', target: { kind: 'grid', projectId, tabId: a }, bounds: { x: 10, y: 20, width: 800, height: 600 }, displayId: 2, maximized: true });
    expect(out[1].target).toEqual({ kind: 'grid', projectId, tabId: b });
    expect(normalizeDetachedWindows([], grids)).toBeUndefined();
    expect(normalizeDetachedWindows('x', grids)).toBeUndefined();
  });

  it('survives a save and load, and drops the window of a grid that is gone', () => {
    const { s, projectId, a } = twoGrids();
    const saved = JSON.parse(JSON.stringify({ ...s, detachedWindows: [gridWindow('w1', projectId, a, { bounds: { x: 0, y: 0, width: 900, height: 700 } })] }));
    expect(normalizeState(saved)!.detachedWindows).toEqual(saved.detachedWindows);
    const closed = { ...saved, projects: saved.projects.map((p: AppState['projects'][number]) => ({ ...p, tabs: p.tabs.filter((t) => t.id !== a) })) };
    expect(normalizeState(closed)!.detachedWindows).toBeUndefined();
  });

  it('adds (one window per tab, a limit), moves and removes entries', () => {
    const { s, projectId, a, b } = twoGrids();
    const one = addDetached(s, gridWindow('w1', projectId, a))!;
    expect(one.window.id).toBe('w1');
    expect(addDetached(one.state, gridWindow('w2', projectId, a))!.window.id).toBe('w1');
    let full = one.state;
    for (let i = 1; i < DETACHED_LIMIT; i++) full = { ...full, detachedWindows: [...full.detachedWindows!, gridWindow(`x${i}`, projectId, `t${i}`)] };
    expect(addDetached(full, gridWindow('w9', projectId, b))).toBeNull();
    const placed = setDetachedPlace(one.state, 'w1', { bounds: { x: 5, y: 6, width: 700, height: 500 }, displayId: 3, maximized: false });
    expect(placed.detachedWindows![0]).toMatchObject({ bounds: { x: 5, y: 6, width: 700, height: 500 }, displayId: 3 });
    expect(setDetachedPlace(placed, 'w1', { bounds: { x: 5, y: 6, width: 700, height: 500 }, displayId: 3, maximized: false })).toBe(placed);
    expect(removeDetached(placed, 'w1').detachedWindows).toBeUndefined();
    expect(removeDetached(placed, 'nope')).toBe(placed);
  });

  it('knows which window owns each cell and what moves between two states', () => {
    const { s, projectId, a, b } = twoGrids();
    const detached = { ...s, detachedWindows: [gridWindow('w1', projectId, b)] };
    const owners = cellOwners(detached);
    const [c1, c2] = s.projects[0].tabs[0].cells.map((c) => c.id);
    const c3 = s.projects[0].tabs[1].cells[0].id;
    expect([...owners]).toEqual([[c3, 'w1']]);
    expect(ownsCell(owners, null, c1)).toBe(true);
    expect(ownsCell(owners, 'w1', c1)).toBe(false);
    expect(ownsCell(owners, 'w1', c3)).toBe(true);
    expect(ownsCell(owners, null, c3)).toBe(false);
    expect(ownsCell(owners, null, 'install:x')).toBe(true);
    expect(detachedGridIds(detached)).toEqual(new Set([b]));
    // Detach the other grid, attach this one back.
    const swapped = cellOwners({ ...s, detachedWindows: [gridWindow('w2', projectId, a)] });
    expect(routeChanges(owners, swapped).sort()).toEqual([[c1, 'w2'], [c2, 'w2'], [c3, null]].sort());
    expect(routeChanges(owners, owners)).toEqual([]);
  });

  it('shows the detached tab as active in its window, and the overlay never travels with an edit', () => {
    const { s, projectId, a, b } = twoGrids();
    const real = { ...s, activeProjectId: null, projects: s.projects.map((p) => ({ ...p, activeTabId: a })) };
    const view = viewOverlay(real, { kind: 'grid', projectId, tabId: b });
    expect(view.activeProjectId).toBe(projectId);
    expect(view.projects[0].activeTabId).toBe(b);
    expect(viewOverlay(view, { kind: 'grid', projectId, tabId: b })).toBe(view);
    expect(viewOverlay(real, null)).toBe(real);
    // An edit made in the detached window (a cell renamed) changes only that cell in main's state.
    const next = { ...view, projects: view.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === b ? { ...t, name: 'Renamed' } : t)) })) };
    const merged = mergeStateEdit(real, { base: view, next });
    expect(merged.activeProjectId).toBeNull();
    expect(merged.projects[0].activeTabId).toBe(a);
    expect(merged.projects[0].tabs[1].name).toBe('Renamed');
  });

  it('a renderer edit can neither add nor remove a detached window (main owns the registry)', () => {
    const { s, projectId, a, b } = twoGrids();
    const withWindow = { ...s, detachedWindows: [gridWindow('w1', projectId, a)] };
    const controller = new StateController(withWindow, () => {});
    controller.apply({ id: 'e1', base: withWindow, next: { ...withWindow, detachedWindows: [gridWindow('w1', projectId, a), gridWindow('w2', projectId, b)] } });
    expect(controller.get().detachedWindows!.map((w) => w.id)).toEqual(['w1']);
    controller.apply({ id: 'e2', base: controller.get(), next: { ...controller.get(), detachedWindows: undefined } });
    expect(controller.get().detachedWindows!.map((w) => w.id)).toEqual(['w1']);
    // Closing the grid in the renderer drops its window.
    const closed = { ...controller.get(), projects: controller.get().projects.map((p) => ({ ...p, tabs: p.tabs.filter((t) => t.id !== a) })) };
    controller.apply({ id: 'e3', base: controller.get(), next: closed });
    expect(controller.get().detachedWindows).toBeUndefined();
  });
});

describe('where a detached window opens', () => {
  const primary: DisplayArea = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const second: DisplayArea = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

  it('clamps into an area and finds the display of a point', () => {
    expect(clampRect({ x: 1800, y: -50, width: 400, height: 300 }, primary.workArea)).toEqual({ x: 1520, y: 0, width: 400, height: 300 });
    expect(clampRect({ x: 0, y: 0, width: 4000, height: 3000 }, primary.workArea)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
    expect(displayAt([primary, second], { x: 2000, y: 10 }, 1)!.id).toBe(2);
    expect(displayAt([primary, second], { x: 9000, y: 10 }, 1)!.id).toBe(2);
    expect(displayAt([primary, second], { x: -50, y: 10 }, 1)!.id).toBe(1);
  });

  it('reopens where it was while its title bar is on a display, else centered on the primary display', () => {
    const saved = { x: 2100, y: 100, width: 1200, height: 800 };
    expect(restoreBounds(saved, [primary, second], 1)).toEqual({ bounds: saved, displayId: 2 });
    // The second monitor is gone.
    const back = restoreBounds(saved, [primary], 1);
    expect(back.displayId).toBe(1);
    expect(back.bounds).toEqual({ x: 360, y: 120, width: 1200, height: 800 });
    // Only a sliver of the title bar is visible: reopened on the primary display.
    expect(restoreBounds({ x: 1900, y: 100, width: 600, height: 400 }, [primary], 1).bounds.x).toBe(660);
    // No saved bounds: the default size, centered; a tiny saved size grows to the minimum.
    expect(restoreBounds(undefined, [primary], 1).bounds).toEqual({ x: 460, y: 170, width: 1000, height: 700 });
    expect(restoreBounds({ x: 10, y: 10, width: 100, height: 50 }, [primary], 1).bounds).toMatchObject({ width: 480, height: 320 });
  });

  it('a drop puts the title bar under the pointer, clamped to that display', () => {
    const size = { width: 1000, height: 700 };
    expect(boundsAtPoint({ x: 2500, y: 300 }, size, [primary, second], 1)).toEqual({ bounds: { x: 2340, y: 282, width: 1000, height: 700 }, displayId: 2 });
    expect(boundsAtPoint({ x: 1910, y: 1030 }, size, [primary, second], 1).bounds).toEqual({ x: 920, y: 340, width: 1000, height: 700 });
  });

  it('the menu opens it on the other display, or beside the main window when there is one display', () => {
    const size = { width: 1000, height: 700 };
    const main = { x: 100, y: 50, width: 1600, height: 950 };
    expect(boundsBeside(main, size, [primary, second], 1)).toEqual({ bounds: { x: 2700, y: 350, width: 1000, height: 700 }, displayId: 2 });
    // The main window on the second display: the new one goes to the primary.
    expect(boundsBeside({ ...main, x: 2000 }, size, [primary, second], 1).displayId).toBe(1);
    expect(boundsBeside(main, size, [primary], 1)).toEqual({ bounds: { x: 148, y: 98, width: 1000, height: 700 }, displayId: 1 });
  });
});

describe('which window hears a message', () => {
  const owners = new Map([['c1', 'w1']]);
  it('broadcasts the state, sends a cell\'s messages to its window and the rest to the main window', () => {
    expect(routeMessage('state:changed', [{ x: 1 }], owners)).toEqual([{ window: '*', args: [{ x: 1 }] }]);
    expect(routeMessage('cell:hook', ['c1', 'stop'], owners)).toEqual([{ window: 'w1', args: ['c1', 'stop'] }]);
    expect(routeMessage('cell:hook', ['c2', 'stop'], owners)).toEqual([{ window: null, args: ['c2', 'stop'] }]);
    expect(routeMessage('ssh:session', [{ cellId: 'c1', phase: 'ready' }], owners)[0].window).toBe('w1');
    expect(routeMessage('focus-cell', ['c1'], owners)[0].window).toBe('w1');
    expect(routeMessage('app:confirm-quit', [], owners)).toEqual([{ window: null, args: [] }]);
    expect(routeMessage('automation:start-cells', [['c1', 'c2', 'c3']], owners)).toEqual([
      { window: 'w1', args: [['c1']] }, { window: null, args: [['c2', 'c3']] },
    ]);
  });
});

describe('Pty Host window routes', () => {
  it('routes terminals, accepts a window only for its own terminals and keeps the focus of the window that reported it', () => {
    const routes = new WindowRoutes();
    expect(routes.ownerOf('c1')).toBe(MAIN_WINDOW);
    expect(routes.set('c1', 'w1')).toBe(MAIN_WINDOW);
    expect(routes.set('c1', 'w1')).toBeNull();
    expect(routes.accepts('w1', { t: 'write', id: 'c1', data: 'x' })).toBe(true);
    expect(routes.accepts(MAIN_WINDOW, { t: 'resize', id: 'c1', cols: 80, rows: 24 })).toBe(false);
    expect(routes.accepts(MAIN_WINDOW, { t: 'ack', id: 'c2', chars: 3 })).toBe(true);
    expect(routes.accepts(MAIN_WINDOW, { t: 'focus', id: null })).toBe(true);
    expect(routes.focus('w1', 'c1')).toBe('c1');
    expect(routes.focus(MAIN_WINDOW, null)).toBeUndefined();
    expect(routes.focus('w1', null)).toBeNull();
    expect(routes.set('c1', null)).toBe('w1');
    expect(routes.ownerOf('c1')).toBe(MAIN_WINDOW);
  });
});
