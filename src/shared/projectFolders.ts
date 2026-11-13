// Project folders of the Projects panel (1.2.4): Discord-like named groups of projects, one level deep.
//
// Stored next to `projects` in two optional fields that older versions keep untouched (both normalizers copy unknown keys):
// `projectFolders` (each folder with its members in order) and `sidebarOrder` (the top-level items: project and folder ids).
// The panel is always derived from them with `projectTree`, which tolerates any mismatch (a version that knows no folders may
// have added, removed or reordered projects meanwhile): unknown ids are dropped, a project in two folders stays in the first,
// projects and folders the order does not name come last. Every change writes the tree back and reorders `projects` to the
// flattened panel order, so the other lists that follow `projects` (the grid strip, search) show the same order.
import type { AppState, Project, ProjectFolder } from './types';
const uid = () => globalThis.crypto.randomUUID();

export type TreeItem =
  | { kind: 'project'; project: Project }
  | { kind: 'folder'; folder: ProjectFolder; projects: Project[] };

/** Where a dragged project or folder goes: next to an item (a project inside a folder means inside that folder), into a folder, or at the end. */
export type TreeTarget =
  | { kind: 'before' | 'after'; id: string }
  | { kind: 'into'; folderId: string }
  | { kind: 'end' };

export function projectTree(s: Pick<AppState, 'projects' | 'projectFolders' | 'sidebarOrder'>): TreeItem[] {
  const byId = new Map(s.projects.map((p) => [p.id, p]));
  const placed = new Set<string>();
  const folders = new Map<string, Extract<TreeItem, { kind: 'folder' }>>();
  for (const f of s.projectFolders ?? []) {
    if (!f || typeof f.id !== 'string' || folders.has(f.id)) continue;
    const members: Project[] = [];
    for (const id of Array.isArray(f.projectIds) ? f.projectIds : []) {
      const p = byId.get(id);
      if (p && !placed.has(id)) { placed.add(id); members.push(p); }
    }
    folders.set(f.id, { kind: 'folder', folder: { id: f.id, name: typeof f.name === 'string' ? f.name : '', collapsed: f.collapsed === true, projectIds: members.map((p) => p.id) }, projects: members });
  }
  const out: TreeItem[] = [];
  const used = new Set<string>();
  for (const id of Array.isArray(s.sidebarOrder) ? s.sidebarOrder : []) {
    if (used.has(id)) continue;
    const folder = folders.get(id);
    if (folder) { used.add(id); out.push(folder); continue; }
    const p = byId.get(id);
    if (p && !placed.has(id)) { used.add(id); placed.add(id); out.push({ kind: 'project', project: p }); }
  }
  for (const [id, folder] of folders) if (!used.has(id)) out.push(folder);
  for (const p of s.projects) if (!placed.has(p.id)) out.push({ kind: 'project', project: p });
  return out;
}

/** Project ids in panel order. */
export const flatProjectIds = (tree: TreeItem[]): string[] =>
  tree.flatMap((i) => (i.kind === 'project' ? [i.project.id] : i.projects.map((p) => p.id)));

/** Writes a tree back: the folders, the top-level order and `projects` in panel order. */
export function withTree<S extends AppState>(s: S, tree: TreeItem[]): S {
  const order = flatProjectIds(tree);
  const byId = new Map(s.projects.map((p) => [p.id, p]));
  const projects = order.map((id) => byId.get(id)).filter((p): p is Project => !!p);
  return {
    ...s,
    projects,
    projectFolders: tree.filter((i): i is Extract<TreeItem, { kind: 'folder' }> => i.kind === 'folder').map((i) => ({ ...i.folder, projectIds: i.projects.map((p) => p.id) })),
    sidebarOrder: tree.map((i) => (i.kind === 'project' ? i.project.id : i.folder.id)),
  };
}

const itemId = (i: TreeItem) => (i.kind === 'project' ? i.project.id : i.folder.id);

/** The folder holding a project, if any. */
export function folderOf(tree: TreeItem[], projectId: string): ProjectFolder | null {
  for (const i of tree) if (i.kind === 'folder' && i.projects.some((p) => p.id === projectId)) return i.folder;
  return null;
}

/** Takes a project or a folder out of the tree; returns the rest and what was taken. */
function take(tree: TreeItem[], id: string): { rest: TreeItem[]; item: TreeItem | null } {
  let item: TreeItem | null = null;
  const rest: TreeItem[] = [];
  for (const i of tree) {
    if (itemId(i) === id) { item = i; continue; }
    if (i.kind === 'folder' && i.projects.some((p) => p.id === id)) {
      const project = i.projects.find((p) => p.id === id)!;
      item = { kind: 'project', project };
      const projects = i.projects.filter((p) => p.id !== id);
      rest.push({ ...i, projects, folder: { ...i.folder, projectIds: projects.map((p) => p.id) } });
      continue;
    }
    rest.push(i);
  }
  return { rest, item };
}

/** Moves a project or a folder. Folders stay at the top level (one level deep); a target that does not exist is the end. */
export function moveTreeItem<S extends AppState>(s: S, id: string, target: TreeTarget): S {
  const tree = projectTree(s);
  if (target.kind !== 'end' && 'id' in target && target.id === id) return s;
  const { rest, item } = take(tree, id);
  if (!item) return s;
  const put = (): TreeItem[] => {
    if (target.kind === 'end') return [...rest, item];
    if (target.kind === 'into') {
      if (item.kind !== 'project') return tree;
      const at = rest.findIndex((i) => i.kind === 'folder' && i.folder.id === target.folderId);
      if (at < 0) return [...rest, item];
      const f = rest[at] as Extract<TreeItem, { kind: 'folder' }>;
      const projects = [...f.projects, item.project];
      return rest.map((x, k) => (k === at ? { ...f, projects, folder: { ...f.folder, projectIds: projects.map((p) => p.id) } } : x));
    }
    const top = rest.findIndex((i) => itemId(i) === target.id);
    if (top >= 0) return [...rest.slice(0, top + (target.kind === 'after' ? 1 : 0)), item, ...rest.slice(top + (target.kind === 'after' ? 1 : 0))];
    // Next to a project inside a folder: a project joins that folder there, a folder goes next to that folder.
    const at = rest.findIndex((i) => i.kind === 'folder' && i.projects.some((p) => p.id === target.id));
    if (at < 0) return [...rest, item];
    const f = rest[at] as Extract<TreeItem, { kind: 'folder' }>;
    if (item.kind === 'folder') return [...rest.slice(0, at + (target.kind === 'after' ? 1 : 0)), item, ...rest.slice(at + (target.kind === 'after' ? 1 : 0))];
    const k = f.projects.findIndex((p) => p.id === target.id) + (target.kind === 'after' ? 1 : 0);
    const projects = [...f.projects.slice(0, k), item.project, ...f.projects.slice(k)];
    return rest.map((x, j) => (j === at ? { ...f, projects, folder: { ...f.folder, projectIds: projects.map((p) => p.id) } } : x));
  };
  const next = put();
  return next === tree ? s : withTree(s, next);
}

/**
 * A project dropped onto another one: a project inside a folder takes it into that folder; a top-level one makes a new folder
 * at its place holding both (the target first). Returns the new folder's id when one was made.
 */
export function dropOnProject<S extends AppState>(s: S, dragId: string, targetId: string, name: string): { state: S; folderId: string | null } {
  if (dragId === targetId) return { state: s, folderId: null };
  const tree = projectTree(s);
  const holder = folderOf(tree, targetId);
  if (holder) return { state: moveTreeItem(s, dragId, { kind: 'after', id: targetId }), folderId: null };
  const { rest, item } = take(tree, dragId);
  if (!item || item.kind !== 'project') return { state: s, folderId: null };
  const at = rest.findIndex((i) => i.kind === 'project' && i.project.id === targetId);
  if (at < 0) return { state: s, folderId: null };
  const target = (rest[at] as Extract<TreeItem, { kind: 'project' }>).project;
  const folder: ProjectFolder = { id: uid(), name, collapsed: false, projectIds: [target.id, item.project.id] };
  const next = rest.map((x, k) => (k === at ? { kind: 'folder' as const, folder, projects: [target, item.project] } : x));
  return { state: withTree(s, next), folderId: folder.id };
}

/** A new empty folder at the end of the list. */
export function addFolder<S extends AppState>(s: S, name: string): { state: S; folderId: string } {
  const folder: ProjectFolder = { id: uid(), name, collapsed: false, projectIds: [] };
  return { state: withTree(s, [...projectTree(s), { kind: 'folder', folder, projects: [] }]), folderId: folder.id };
}

export function updateFolder<S extends AppState>(s: S, folderId: string, patch: Partial<Pick<ProjectFolder, 'name' | 'collapsed'>>): S {
  return withTree(s, projectTree(s).map((i) => (i.kind === 'folder' && i.folder.id === folderId ? { ...i, folder: { ...i.folder, ...patch } } : i)));
}

/** Removes a folder; its projects go back to the top level at its place (no project is removed). */
export function removeFolder<S extends AppState>(s: S, folderId: string): S {
  return withTree(s, projectTree(s).flatMap((i): TreeItem[] =>
    i.kind === 'folder' && i.folder.id === folderId ? i.projects.map((project) => ({ kind: 'project', project })) : [i]));
}

/** The item a project or folder sits next to among its siblings (for "move up / down"), or null at the edge. */
export function treeNeighbour(tree: TreeItem[], id: string, dir: -1 | 1): string | null {
  const holder = tree.find((i): i is Extract<TreeItem, { kind: 'folder' }> => i.kind === 'folder' && i.projects.some((p) => p.id === id));
  const ids = holder ? holder.projects.map((p) => p.id) : tree.map(itemId);
  const k = ids.indexOf(id);
  return k < 0 ? null : (ids[k + dir] ?? null);
}
