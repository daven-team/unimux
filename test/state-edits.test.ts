import { describe, expect, it } from 'vitest';
import { addCell, addProject, addTab, defaultState, removeProject, updateCell, updateSettings, upsertSnippet } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';
import { mergeStateEdit } from '../src/shared/stateEdits';
import { OptimisticState } from '../src/shared/optimisticState';
import { StateController } from '../src/main/stateController';

function grid(count = 2) {
  let state = addProject(defaultState(), { name: 'Project', path: 'D:/project' });
  state = addTab(state, state.projects[0].id, { layout: layoutForCount(count), cells: [{ profileId: 'codex' }] });
  return state;
}
describe('concurrent renderer and MCP state edits', () => {
  it('keeps an MCP-created grid and snippet during a stale renderer settings save', () => {
    const base = grid();
    let latest = addTab(base, base.projects[0].id, { name: 'MCP', layout: layoutForCount(1), cells: [{ profileId: 'claude' }] });
    latest = upsertSnippet(latest, { id: 'mcp-snippet', name: 'Review', text: 'Review code', autoSend: false });
    const merged = mergeStateEdit(latest, { base, next: updateSettings(base, { fontSize: 17 }) });
    expect(merged.projects[0].tabs).toHaveLength(2);
    expect(merged.snippets[0].id).toBe('mcp-snippet');
    expect(merged.settings.fontSize).toBe(17);
  });
  it('merges edits to different cells and does not resurrect a deleted project', () => {
    const base = grid();
    const [first, second] = base.projects[0].tabs[0].cells;
    const latest = updateCell(base, first.id, { name: 'MCP name' });
    const next = updateCell(base, second.id, { color: '#abcdef' });
    expect(mergeStateEdit(latest, { base, next }).projects[0].tabs[0].cells).toMatchObject([{ name: 'MCP name' }, { color: '#abcdef' }]);
    expect(mergeStateEdit(removeProject(latest, base.projects[0].id), { base, next }).projects).toEqual([]);
  });
  it('preserves external collection reordering when the UI only edits a field', () => {
    const base = grid();
    const [first, second] = base.projects[0].tabs[0].cells;
    const latest = { ...base, projects: base.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, cells: [...t.cells].reverse() })) })) };
    const next = updateCell(base, first.id, { name: 'User name' });
    const cells = mergeStateEdit(latest, { base, next }).projects[0].tabs[0].cells;
    expect(cells.map((c) => c.id)).toEqual([second.id, first.id]);
    expect(cells[1].name).toBe('User name');
  });
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
  it('repairs the layout when two independent additions are merged', () => {
    const base = grid(1);
    const project = base.projects[0], tab = project.tabs[0];
    const controller = new StateController(base, () => {});
    controller.change((s) => addCell(s, project.id, tab.id, 'claude'));
    controller.apply({ id: 'ui', base, next: addCell(base, project.id, tab.id, 'codex') });
    const merged = controller.get().projects[0].tabs[0];
    expect(merged.cells).toHaveLength(3);
    expect(merged.layout.areas).toHaveLength(3);
  });
  it('rejects concurrent additions beyond 20 without altering the canonical state', () => {
    const base = grid(19);
    const project = base.projects[0], tab = project.tabs[0];
    const controller = new StateController(base, () => {});
    controller.change((s) => addCell(s, project.id, tab.id, 'claude'));
    const before = controller.get();
    expect(() => controller.apply({ id: 'ui', base, next: addCell(base, project.id, tab.id, 'codex') })).toThrow('cell limit');
    expect(controller.get()).toBe(before);
  });
  it('normalizes the SFTP places and the scrollback setting of a renderer edit', () => {
    const base = grid(1);
    const controller = new StateController(base, () => {});
    const remotePaths = JSON.parse('{"__proto__":"/x","h1":"/srv//www/","bad id":"/y","h2":"relative"}') as Record<string, string>;
    const next = { ...base, sftp: { localPath: 'relative/path', remotePaths }, settings: { ...base.settings, scrollbackLines: 123 } };
    controller.apply({ id: 'ui', base, next });
    const state = controller.get();
    expect(state.sftp).toEqual({ remotePaths: { h1: '/srv/www' } });
    expect(Object.getPrototypeOf(state.sftp.remotePaths)).toBe(Object.prototype);
    expect(state.settings.scrollbackLines).toBe(5000);
    const kept = { ...base, sftp: { remotePaths: { h1: '/srv' } }, settings: { ...base.settings, scrollbackLines: 10_000 } };
    controller.apply({ id: 'ui2', base: state, next: kept });
    expect(controller.get().sftp).toEqual({ remotePaths: { h1: '/srv' } });
    expect(controller.get().settings.scrollbackLines).toBe(10_000);
  });
});
