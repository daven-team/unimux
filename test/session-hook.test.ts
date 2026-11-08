import { describe, expect, it } from 'vitest';
import { sessionSearchPaths } from '../src/shared/sessionTrack';

describe('sessionSearchPaths', () => {
  it('returns the project path plus distinct worktree paths of its cells', () => {
    const cell = (id: string, wt?: string) => ({ id, worktree: wt ? { path: wt } : undefined });
    const state = { projects: [{ path: 'P', archive: [{ cells: [cell('d', 'W2')] }], tabs: [{ cells: [cell('a'), cell('b', 'W1'), cell('c', 'W1')] }] }] };
    expect(sessionSearchPaths('P', state as never)).toEqual(['P', 'W1', 'W2']);
    expect(sessionSearchPaths('other', state as never)).toEqual(['other']);
  });
});
