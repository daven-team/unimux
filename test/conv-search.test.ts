import { describe, expect, it } from 'vitest';
import {
  folderOwner,
} from '../src/shared/convSearch';

describe('query sanitizing and resume target', () => {
  it('finds the project or worktree of a conversation folder', () => {
    const projects = [
      { id: 'p1', path: 'D:\\work\\alpha', worktrees: [{ path: 'D:\\trees\\feature', branch: 'feature/x' }] },
      { id: 'p2', path: '/Users/me/beta', worktrees: [] },
    ];
    expect(folderOwner(projects, 'd:/work/alpha/')).toEqual({ projectId: 'p1' });
    expect(folderOwner(projects, 'D:\\trees\\feature')).toEqual({ projectId: 'p1', worktree: { path: 'D:\\trees\\feature', label: 'feature/x', branch: 'feature/x' } });
    expect(folderOwner(projects, 'D:\\work\\alpha-wt-fix')).toEqual({ projectId: 'p1', worktree: { path: 'D:\\work\\alpha-wt-fix', label: 'alpha-wt-fix' } });
    expect(folderOwner(projects, '/Users/me/beta')).toEqual({ projectId: 'p2' });
    expect(folderOwner(projects, '/Users/me/gamma')).toBeNull();
    expect(folderOwner(projects, '')).toBeNull();
  });
});
