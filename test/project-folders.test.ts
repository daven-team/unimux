import { describe, expect, it } from 'vitest';
import { defaultState } from '../src/shared/state';
import { addFolder, dropOnProject, flatProjectIds, moveTreeItem, projectTree, removeFolder, updateFolder } from '../src/shared/projectFolders';
import type { AppState, Project } from '../src/shared/types';

const proj = (id: string): Project => ({ id, name: id, path: `C:\\${id}`, color: '#3b82f6', tabs: [], archive: [], activeTabId: null });
const state = (...ids: string[]): AppState => ({ ...defaultState('win32'), projects: ids.map(proj) });
const shape = (s: AppState) => projectTree(s).map((i) => (i.kind === 'project' ? i.project.id : `${i.folder.name}[${i.projects.map((p) => p.id).join(',')}]`));

describe('project folders', () => {
  it('drops a project onto another into a new folder at the target, moves in and out, and keeps projects in panel order', () => {
    let s = dropOnProject(state('a', 'b', 'c', 'd'), 'd', 'b', 'F').state;
    expect(shape(s)).toEqual(['a', 'F[b,d]', 'c']);
    expect(s.projects.map((p) => p.id)).toEqual(['a', 'b', 'd', 'c']);
    // Onto a project inside a folder: joins that folder after it; into the header: at the end.
    s = dropOnProject(s, 'a', 'b', 'G').state;
    expect(shape(s)).toEqual(['F[b,a,d]', 'c']);
    const f = s.projectFolders![0].id;
    s = moveTreeItem(s, 'c', { kind: 'into', folderId: f });
    expect(shape(s)).toEqual(['F[b,a,d,c]']);
    // Next to a top-level item: out of the folder.
    s = moveTreeItem(s, 'a', { kind: 'after', id: f });
    expect(shape(s)).toEqual(['F[b,d,c]', 'a']);
    expect(s.projects.map((p) => p.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('keeps an emptied folder, removes a folder without removing its projects, and keeps folders one level deep', () => {
    let s = state('a', 'b');
    const made = addFolder(s, 'Prywatne');
    s = moveTreeItem(made.state, 'b', { kind: 'into', folderId: made.folderId });
    s = moveTreeItem(s, 'b', { kind: 'before', id: 'a' });
    expect(shape(s)).toEqual(['b', 'a', 'Prywatne[]']);
    s = moveTreeItem(s, 'a', { kind: 'into', folderId: made.folderId });
    // A folder dropped next to a project inside a folder goes next to that folder, never inside.
    const other = addFolder(s, 'X');
    s = moveTreeItem(other.state, other.folderId, { kind: 'before', id: 'a' });
    expect(shape(s)).toEqual(['b', 'X[]', 'Prywatne[a]']);
    s = updateFolder(s, made.folderId, { collapsed: true, name: 'Służbowe' });
    expect(s.projectFolders!.find((f) => f.id === made.folderId)).toMatchObject({ collapsed: true, name: 'Służbowe' });
    s = removeFolder(s, made.folderId);
    expect(shape(s)).toEqual(['b', 'X[]', 'a']);
    expect(s.projects).toHaveLength(2);
  });

  it('repairs folder data a version without folders left stale: unknown ids dropped, duplicates in the first folder, new projects last', () => {
    const s: AppState = {
      ...state('a', 'b', 'c', 'new'),
      projectFolders: [
        { id: 'f1', name: 'F1', collapsed: false, projectIds: ['gone', 'b', 'a'] },
        { id: 'f2', name: 'F2', collapsed: true, projectIds: ['a', 'c'] },
      ],
      sidebarOrder: ['f2', 'gone', 'f1', 'b'],
    };
    expect(shape(s)).toEqual(['F2[c]', 'F1[b,a]', 'new']);
    expect(flatProjectIds(projectTree(s))).toEqual(['c', 'b', 'a', 'new']);
    // No folders at all: the flat list as before.
    expect(shape(state('a', 'b'))).toEqual(['a', 'b']);
  });
});
