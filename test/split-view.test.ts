import { describe, expect, it } from 'vitest';
import { clampSplitRatio, rememberSplitFile, splitEndsAfterClose, splitRatioForKey, splitSides, SPLIT_MIN_SIDE } from '../src/shared/splitView';

const docs = [
  { id: 'a1', projectId: 'A' },
  { id: 'a2', projectId: 'A' },
  { id: 'b1', projectId: 'B' },
  { id: 'db', projectId: '' },
];

describe('splitSides', () => {
  it('off: the tab in front covers the grid, else the grid shows alone', () => {
    expect(splitSides({ on: false, activeFileId: 'a1', projectId: 'A', recent: undefined, documents: docs })).toEqual({ grid: false, fileId: 'a1', split: false });
    expect(splitSides({ on: false, activeFileId: null, projectId: 'A', recent: ['a1'], documents: docs })).toEqual({ grid: true, fileId: null, split: false });
    // a tab of another project is not on screen
    expect(splitSides({ on: false, activeFileId: 'b1', projectId: 'A', recent: undefined, documents: docs })).toEqual({ grid: true, fileId: null, split: false });
  });

  it('on: the grid stays and the tab in front shows beside it (tabs outside the projects too)', () => {
    expect(splitSides({ on: true, activeFileId: 'a2', projectId: 'A', recent: ['a1'], documents: docs })).toEqual({ grid: true, fileId: 'a2', split: true });
    expect(splitSides({ on: true, activeFileId: 'db', projectId: 'B', recent: undefined, documents: docs })).toEqual({ grid: true, fileId: 'db', split: true });
  });

  it('on with a grid tab in front: the tab last shown beside this project grid, else the grid alone', () => {
    expect(splitSides({ on: true, activeFileId: null, projectId: 'A', recent: ['gone', 'a2', 'a1'], documents: docs })).toEqual({ grid: true, fileId: 'a2', split: true });
    expect(splitSides({ on: true, activeFileId: null, projectId: 'B', recent: ['a1'], documents: docs })).toEqual({ grid: true, fileId: null, split: false });
    expect(splitSides({ on: true, activeFileId: null, projectId: 'B', recent: undefined, documents: docs })).toEqual({ grid: true, fileId: null, split: false });
  });
});

describe('rememberSplitFile', () => {
  it('puts the tab in front first in its project list and drops closed tabs', () => {
    const one = rememberSplitFile({}, 'A', 'a1', docs);
    expect(one).toEqual({ A: ['a1'] });
    const two = rememberSplitFile({ A: ['a1', 'gone'] }, 'A', 'a2', docs);
    expect(two).toEqual({ A: ['a2', 'a1'] });
    expect(rememberSplitFile(two, 'A', 'db', docs)).toEqual({ A: ['db', 'a2', 'a1'] });
  });

  it('changes nothing for a grid in front, the same tab again or a tab of another project', () => {
    const recent = { A: ['a1'] };
    expect(rememberSplitFile(recent, 'A', null, docs)).toBe(recent);
    expect(rememberSplitFile(recent, 'A', 'a1', docs)).toBe(recent);
    expect(rememberSplitFile(recent, 'A', 'b1', docs)).toBe(recent);
    expect(rememberSplitFile(recent, null, 'a1', docs)).toBe(recent);
  });
});

describe('splitEndsAfterClose', () => {
  it('ends the split only when a closed tab leaves nothing beside the grid', () => {
    const after = docs.filter((d) => d.id !== 'a1');
    expect(splitEndsAfterClose(docs, after, { grid: true, fileId: null, split: false })).toBe(true);
    expect(splitEndsAfterClose(docs, after, { grid: true, fileId: 'a2', split: true })).toBe(false);
    // a tab opened (nothing closed) never ends it
    expect(splitEndsAfterClose(after, docs, { grid: true, fileId: null, split: false })).toBe(false);
  });
});

describe('the divider', () => {
  it('keeps both sides at least the minimum width', () => {
    expect(clampSplitRatio(0.5, 1000)).toBe(0.5);
    expect(clampSplitRatio(0.05, 1000)).toBe(SPLIT_MIN_SIDE / 1000);
    expect(clampSplitRatio(0.99, 1000)).toBe(1 - SPLIT_MIN_SIDE / 1000);
    expect(clampSplitRatio(0.8, SPLIT_MIN_SIDE)).toBe(0.5);
    expect(clampSplitRatio(Number.NaN, 1000)).toBe(0.5);
    expect(clampSplitRatio(0.95, 0)).toBe(0.9);
  });

  it('moves with the keyboard', () => {
    expect(splitRatioForKey(0.5, 'ArrowLeft', false, 1000)).toBeCloseTo(0.48);
    expect(splitRatioForKey(0.5, 'ArrowRight', true, 1000)).toBeCloseTo(0.6);
    expect(splitRatioForKey(0.5, 'Home', false, 1000)).toBe(SPLIT_MIN_SIDE / 1000);
    expect(splitRatioForKey(0.5, 'End', false, 1000)).toBe(1 - SPLIT_MIN_SIDE / 1000);
    expect(splitRatioForKey(0.3, 'Enter', false, 1000)).toBe(0.5);
    expect(splitRatioForKey(0.5, 'a', false, 1000)).toBeNull();
  });
});
