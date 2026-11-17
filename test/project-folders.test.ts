import { describe, expect, it } from 'vitest';
import { defaultState, removeProject } from '../src/shared/state';
import { addFolder, dropOnProject, flatProjectIds, moveTreeItem, newFolderWith, projectTree, removeFolder, setFoldersCollapsed, updateFolder } from '../src/shared/projectFolders';
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

  it('keeps a new empty folder, drops a folder its last project left, removes a folder without its projects, one level deep', () => {
    let s = state('a', 'b');
    const first = addFolder(s, 'Pusty');
    expect(shape(first.state)).toEqual(['a', 'b', 'Pusty[]']);
    // 1.2.5: the last project moved out takes its folder with it.
    s = moveTreeItem(first.state, 'b', { kind: 'into', folderId: first.folderId });
    expect(shape(s)).toEqual(['a', 'Pusty[b]']);
    s = moveTreeItem(s, 'b', { kind: 'before', id: 'a' });
    expect(shape(s)).toEqual(['b', 'a']);
    const made = addFolder(s, 'Prywatne');
    s = moveTreeItem(made.state, 'a', { kind: 'into', folderId: made.folderId });
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

  it('drops a folder emptied by taking its last project out, dropping it onto another project or removing it from the list', () => {
    let s = dropOnProject(state('a', 'b', 'c'), 'b', 'a', 'F').state;
    expect(shape(s)).toEqual(['F[a,b]', 'c']);
    const f = s.projectFolders![0].id;
    s = moveTreeItem(s, 'b', { kind: 'after', id: f });
    expect(shape(s)).toEqual(['F[a]', 'b', 'c']);
    // "Wyjmij z folderu" of the last one: the project takes the folder's place.
    s = moveTreeItem(s, 'a', { kind: 'after', id: f });
    expect(shape(s)).toEqual(['a', 'b', 'c']);
    // Dropped onto another project: a new folder there, the old one goes.
    s = dropOnProject(state('a', 'b', 'c'), 'b', 'a', 'F').state;
    s = moveTreeItem(s, 'a', { kind: 'end' });
    s = dropOnProject(s, 'b', 'c', 'G').state;
    expect(shape(s)).toEqual(['G[c,b]', 'a']);
    // Removed from the list: the folder it was the last project of goes, its other folders stay.
    s = removeProject(removeProject(s, 'c'), 'b');
    expect(shape(s)).toEqual(['a']);
    expect(s.projectFolders).toEqual([]);
  });

  it('makes a new folder with a project at its place, and folds or unfolds every folder at once', () => {
    let s = newFolderWith(state('a', 'b', 'c'), 'b', 'F').state;
    expect(shape(s)).toEqual(['a', 'F[b]', 'c']);
    // From inside a folder: the new one goes right after it, and the emptied one goes.
    s = newFolderWith(s, 'b', 'G').state;
    expect(shape(s)).toEqual(['a', 'G[b]', 'c']);
    s = moveTreeItem(s, 'c', { kind: 'into', folderId: s.projectFolders![0].id });
    s = newFolderWith(s, 'c', 'H').state;
    expect(shape(s)).toEqual(['a', 'G[b]', 'H[c]']);
    s = setFoldersCollapsed(s, true);
    expect(s.projectFolders!.every((f) => f.collapsed)).toBe(true);
    expect(setFoldersCollapsed(s, false).projectFolders!.some((f) => f.collapsed)).toBe(false);
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
