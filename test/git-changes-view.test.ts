import { describe, expect, it } from 'vitest';
import { buildChangeTree, commitPlan, groupChanges, hasCommittable, sortChanges } from '../src/shared/gitUi';
import type { GitFileChange } from '../src/shared/git';

const file = (path: string, y = 'M', extra: Partial<GitFileChange> = {}): GitFileChange => ({ path, x: ' ', y, staged: false, unstaged: true, untracked: false, conflict: false, ...extra });

describe('changes view', () => {
  const files = [file('src/b.ts'), file('a/z.ts', 'D'), file('src/a.ts', 'A'), file('readme.md')];
  it('sorts by path, by name and by status', () => {
    expect(sortChanges(files, 'path', (f) => f.y).map((f) => f.path)).toEqual(['a/z.ts', 'readme.md', 'src/a.ts', 'src/b.ts']);
    expect(sortChanges(files, 'name', (f) => f.y).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'readme.md', 'a/z.ts']);
    expect(sortChanges(files, 'status', (f) => f.y).map((f) => f.y)).toEqual(['M', 'M', 'A', 'D']);
  });
  it('builds a tree with folders first and keeps an untracked folder a leaf', () => {
    const tree = buildChangeTree([...files, file('build/', '?', { untracked: true })]);
    expect(tree.map((n) => n.name)).toEqual(['a', 'src', 'build', 'readme.md']);
    expect(tree[1].children.map((n) => n.name)).toEqual(['a.ts', 'b.ts']);
    expect(tree[2].file?.path).toBe('build/');
  });
});

describe('commit button', () => {
  const staged = file('src/a.ts', ' ', { x: 'M', staged: true, unstaged: false });
  const changed = file('src/b.ts');
  const untracked = file('new.ts', '?', { untracked: true, unstaged: false });
  const conflict = file('both.ts', 'U', { x: 'U', conflict: true });
  it('has work only with staged files or changes it can stage', () => {
    expect(hasCommittable(groupChanges([]))).toBe(false);
    expect(hasCommittable(groupChanges([conflict]))).toBe(false);
    expect(hasCommittable(groupChanges([untracked]))).toBe(true);
    expect(hasCommittable(groupChanges([changed]))).toBe(true);
    expect(hasCommittable(groupChanges([staged]))).toBe(true);
  });
  it('asks for a message, offers to stage everything when nothing is staged, else commits', () => {
    expect(commitPlan('fix', groupChanges([]))).toBe('nothing');
    expect(commitPlan('', groupChanges([]))).toBe('nothing');
    expect(commitPlan('fix', groupChanges([conflict]))).toBe('nothing');
    expect(commitPlan('  \n', groupChanges([staged]))).toBe('ask');
    expect(commitPlan('fix', groupChanges([changed, untracked]))).toBe('stage-all');
    expect(commitPlan('fix', groupChanges([staged, changed]))).toBe('commit');
  });
});
