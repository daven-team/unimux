// Small pieces of the Git panel that its components share (labels and classes of the status letters, path pieces, refs).
import type { MessageKey } from './i18n';
import type { GitFileChange, GitRef } from './git';

export const newRequestId = (): string => crypto.randomUUID();

export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;
export const dirName = (path: string): string => {
  const parts = path.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
};

export interface Letter { letter: string; cls: string; title: MessageKey }

/** The letter shown for one side (index or work tree) of a change. */
export function letterOf(code: string): Letter {
  switch (code) {
    case 'A': return { letter: 'A', cls: 'add', title: 'Dodany' };
    case 'D': return { letter: 'D', cls: 'del', title: 'Usunięty' };
    case 'R': return { letter: 'R', cls: 'ren', title: 'Przeniesiony lub przemianowany' };
    case 'C': return { letter: 'C', cls: 'ren', title: 'Skopiowany' };
    case 'T': return { letter: 'T', cls: 'mod', title: 'Zmieniony typ pliku' };
    case '?': return { letter: 'U', cls: 'add', title: 'Nieśledzony' };
    default: return { letter: 'M', cls: 'mod', title: 'Zmodyfikowany' };
  }
}

export const CONFLICT_LETTER: Letter = { letter: '!', cls: 'del', title: 'Konflikt scalania' };

export type ChangeGroup = 'conflict' | 'staged' | 'unstaged' | 'untracked';

/** The rows of the Changes section: a file with both staged and unstaged changes shows up in both groups. */
export function groupChanges(files: readonly GitFileChange[]): Record<ChangeGroup, GitFileChange[]> {
  const groups: Record<ChangeGroup, GitFileChange[]> = { conflict: [], staged: [], unstaged: [], untracked: [] };
  for (const file of files) {
    if (file.conflict) groups.conflict.push(file);
    else if (file.untracked) groups.untracked.push(file);
    else {
      if (file.staged) groups.staged.push(file);
      if (file.unstaged) groups.unstaged.push(file);
    }
  }
  return groups;
}

/** Refs worth a chip next to a commit: the checked out branch first, then other branches, tags, remote branches. */
export function chipRefs(refs: readonly GitRef[], max = 3): { shown: GitRef[]; more: number } {
  const rank = (ref: GitRef): number => (ref.kind === 'head' ? 0 : ref.current ? 1 : ref.kind === 'branch' ? 2 : ref.kind === 'tag' ? 3 : 4);
  const sorted = [...refs].sort((a, b) => rank(a) - rank(b));
  return { shown: sorted.slice(0, max), more: Math.max(0, sorted.length - max) };
}

/** Whether the Commit button has anything to work with: staged files, or changes it can stage (conflicts alone cannot be committed). */
export const hasCommittable = (groups: Record<ChangeGroup, readonly GitFileChange[]>): boolean =>
  groups.staged.length + groups.unstaged.length + groups.untracked.length > 0;

/**
 * What the Commit button (and its shortcut) does now: `nothing` to commit, `ask` for a message first, `stage-all` (nothing is
 * staged yet: offer to add every change and commit them together, as Cursor does) or `commit` what is staged.
 */
export type CommitPlan = 'nothing' | 'ask' | 'stage-all' | 'commit';
export function commitPlan(message: string, groups: Record<ChangeGroup, readonly GitFileChange[]>): CommitPlan {
  if (!hasCommittable(groups)) return 'nothing';
  if (!message.trim()) return 'ask';
  return groups.staged.length ? 'commit' : 'stage-all';
}

export type ChangesView = 'list' | 'tree';
export type ChangesSort = 'name' | 'path' | 'status';

const STATUS_ORDER = '!MARDTCU';
const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The files of one group in the chosen order; `letterOf` says which status letter a file shows in that group. */
export function sortChanges(files: readonly GitFileChange[], sort: ChangesSort, letterOf: (file: GitFileChange) => string): GitFileChange[] {
  const rank = (file: GitFileChange): number => { const i = STATUS_ORDER.indexOf(letterOf(file)); return i < 0 ? STATUS_ORDER.length : i; };
  return [...files].sort((a, b) => {
    if (sort === 'name') return byText(baseName(a.path), baseName(b.path)) || byText(a.path, b.path);
    if (sort === 'status') return rank(a) - rank(b) || byText(a.path, b.path);
    return byText(a.path, b.path);
  });
}

export interface ChangeNode { name: string; path: string; file?: GitFileChange; children: ChangeNode[] }

/** The files of one group as folders and files: folders first, everything by name (a folder entry like "build/" stays a leaf). */
export function buildChangeTree(files: readonly GitFileChange[]): ChangeNode[] {
  const root: ChangeNode = { name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.replace(/\/+$/, '').split('/');
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const leaf = index === parts.length - 1;
      let next = leaf ? undefined : node.children.find((child) => !child.file && child.name === part);
      if (!next) { next = { name: part, path, children: [], ...(leaf ? { file } : {}) }; node.children.push(next); }
      node = next;
    });
  }
  const order = (nodes: ChangeNode[]): void => {
    nodes.sort((a, b) => Number(!!a.file) - Number(!!b.file) || byText(a.name, b.name));
    nodes.forEach((node) => order(node.children));
  };
  order(root.children);
  return root.children;
}

export const LANE_COLORS = ['#60a5fa', '#4ade80', '#f59e0b', '#c084fc', '#f472b6', '#22d3ee', '#fb923c', '#a3e635'];
