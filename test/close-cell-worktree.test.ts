// Closing a cell with a worktree decides from the state as it is after the questions: a cell that became the last one of
// its grid (the grid goes to the history with it) or that another open or closed-grid cell shares keeps its worktree.
import { describe, expect, it } from 'vitest';
import { layoutForCount } from '../src/shared/layout';
import { addProject, addTab, cellWorktreeUse, closeTab, defaultState, removeCell, updateCell } from '../src/shared/state';
import { normalizeProjectPath } from '../src/shared/platform';

const same = (a: string, b: string) => normalizeProjectPath(a) === normalizeProjectPath(b);
function grid(cells: number) {
  let s = addProject(defaultState(), { name: 'bot', path: 'D:\\Projekty\\bot' });
  const p = s.projects[0];
  s = addTab(s, p.id, { layout: layoutForCount(cells), cells: Array(cells).fill({ profileId: 'shell' }) });
  const tab = s.projects[0].tabs[0];
  return { s, projectId: p.id, tabId: tab.id, ids: tab.cells.map((c) => c.id) };
}
const wt = (path: string) => ({ worktree: { path, branch: 'mc/grid-1' } });

describe('cellWorktreeUse', () => {
  it('a worktree of one cell in a grid of several is its own', () => {
    let { s, ids } = grid(2);
    s = updateCell(s, ids[0], wt('D:\\Projekty\\bot-wt-grid-1'));
    expect(cellWorktreeUse(s, ids[0], same)).toBe('own');
    expect(cellWorktreeUse(s, ids[1], same)).toBe('none');
  });

  it('becomes the last cell when the other one was closed meanwhile: the worktree must stay with the archived grid', () => {
    let { s, projectId, tabId, ids } = grid(2);
    s = updateCell(s, ids[0], wt('D:\\Projekty\\bot-wt-grid-1'));
    s = removeCell(s, projectId, tabId, ids[1]);
    expect(cellWorktreeUse(s, ids[0], same)).toBe('last');
  });

  it('a cell that is gone (its grid closed meanwhile) is reported as gone', () => {
    let { s, projectId, tabId, ids } = grid(2);
    s = updateCell(s, ids[0], wt('D:\\Projekty\\bot-wt-grid-1'));
    s = closeTab(s, projectId, tabId);
    expect(cellWorktreeUse(s, ids[0], same)).toBe('gone');
  });

  it('a worktree another open cell or a closed grid uses is shared (paths compared normalized)', () => {
    let { s, ids } = grid(3);
    s = updateCell(s, ids[0], wt('D:\\Projekty\\bot-wt-grid-1'));
    s = updateCell(s, ids[1], wt('d:/projekty/bot-wt-grid-1/'));
    expect(cellWorktreeUse(s, ids[0], same)).toBe('shared');

    let other = grid(2);
    other.s = updateCell(other.s, other.ids[0], wt('D:\\Projekty\\bot-wt-grid-1'));
    other.s = closeTab(other.s, other.projectId, other.tabId);
    other.s = addTab(other.s, other.projectId, { layout: layoutForCount(2), cells: Array(2).fill({ profileId: 'shell' }) });
    const open = other.s.projects[0].tabs[0].cells;
    other.s = updateCell(other.s, open[0].id, wt('D:\\Projekty\\bot-wt-grid-1'));
    expect(cellWorktreeUse(other.s, open[0].id, same)).toBe('shared');
  });
});
