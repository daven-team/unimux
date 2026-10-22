import { expect, it } from 'vitest';
import { activeWorkspaceKey, workspaceOrder, reorderWorkspace } from '../src/shared/workspaceOrder';
import { defaultState } from '../src/shared/state';
import { StateController } from '../src/main/stateController';

it('preserves mixed card order while dropping closed cards and appending new ones', () => {
  expect(workspaceOrder(['file:a', 'settings', 'grid:a', 'closed'], ['grid:a', 'grid:b', 'file:a', 'settings']))
    .toEqual(['file:a', 'settings', 'grid:a', 'grid:b']);
});
it('moves files across grids and settings in either direction', () => {
  const cards = ['grid:a', 'file:a', 'settings', 'grid:b'];
  expect(reorderWorkspace(cards, 'file:a', 'grid:b', true)).toEqual(['grid:a', 'settings', 'grid:b', 'file:a']);
  expect(reorderWorkspace(cards, 'grid:b', 'grid:a', false)).toEqual(['grid:b', 'grid:a', 'file:a', 'settings']);
  expect(reorderWorkspace(cards, 'missing', 'grid:a', false)).toBe(cards);
});
it('picks the visible workspace: settings, then a file, then the grid; with the SSH view in front no strip tab is', () => {
  const base = { settingsActive: false, sshActive: false, fileId: null, gridId: null };
  expect(activeWorkspaceKey({ ...base, settingsActive: true, sshActive: true, fileId: 'f', gridId: 'g' })).toBe('settings');
  expect(activeWorkspaceKey({ ...base, sshActive: true, fileId: 'f', gridId: 'g' })).toBeNull();
  expect(activeWorkspaceKey({ ...base, fileId: 'f', gridId: 'g' })).toBe('file:f');
  expect(activeWorkspaceKey({ ...base, gridId: 'g' })).toBe('grid:g');
  expect(activeWorkspaceKey(base)).toBeNull();
});
it('the main-process state edit path repairs the strip order like at load and keeps a clean order as it is', () => {
  const base = defaultState();
  const grid = base.projects[0]?.tabs[0]?.id;
  const gridKeys = grid ? [`grid:${grid}`] : [];
  const controller = new StateController(base, () => {});
  const dirty = JSON.parse(JSON.stringify(base));
  dirty.workspaceOrder = ['settings', 'settings', 'grid:missing', 'bogus', 42, 'x'.repeat(5000), 'file:{"a":1}', ...gridKeys];
  expect(controller.apply({ id: 'e1', base, next: dirty }).state.workspaceOrder).toEqual(['settings', 'file:{"a":1}', ...gridKeys]);
  const before = controller.get();
  const order = ['file:b', 'settings'];
  const kept = controller.apply({ id: 'e2', base: before, next: { ...before, workspaceOrder: order } }).state.workspaceOrder;
  expect(kept).toBe(order);
  const now = controller.get();
  const many = { ...now, workspaceOrder: Array.from({ length: 1500 }, (_, i) => `file:${i}`) };
  expect(controller.apply({ id: 'e3', base: now, next: many }).state.workspaceOrder).toHaveLength(1000);
});
