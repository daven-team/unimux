// Preview tabs (shared/previewTabs.ts): a single click opens the one preview tab, the next file takes its place; a double
// click, an edit, a save or a drag keeps it; a tab with unsaved edits is never replaced.
import { describe, expect, it } from 'vitest';
import { keepTab, keepTabs, openTab, previewTabId, swapOrderKey } from '../src/shared/previewTabs';
import { defaultState, normalizeState, updateSettings } from '../src/shared/state';

interface Doc { id: string; preview?: boolean; dirty?: boolean }
const make = (id: string) => (): Doc => ({ id });
const dirty = (d: Doc) => d.dirty === true;
const ids = (docs: Doc[]) => docs.map((d) => (d.preview ? `${d.id}*` : d.id));

describe('openTab', () => {
  it('opens the first preview tab at the end of the strip', () => {
    const r = openTab<Doc>([{ id: 'a' }], 'b', make('b'), 'preview');
    expect(r).toMatchObject({ created: true, replaced: null });
    expect(ids(r.documents)).toEqual(['a', 'b*']);
  });

  it('replaces the preview tab in place with the next single-clicked file', () => {
    const r = openTab<Doc>([{ id: 'a' }, { id: 'b', preview: true }, { id: 'c' }], 'd', make('d'), 'preview');
    expect(r).toMatchObject({ created: true, replaced: 'b' });
    expect(ids(r.documents)).toEqual(['a', 'd*', 'c']);
  });

  it('adds a kept tab at the end and leaves the preview tab alone', () => {
    const r = openTab<Doc>([{ id: 'a', preview: true }], 'b', make('b'), 'keep');
    expect(r).toMatchObject({ created: true, replaced: null });
    expect(ids(r.documents)).toEqual(['a*', 'b']);
  });

  it('only focuses a file that is open in a kept tab (no preview tab is made for it)', () => {
    const docs: Doc[] = [{ id: 'a' }, { id: 'b', preview: true }];
    const r = openTab(docs, 'a', make('a'), 'preview');
    expect(r).toEqual({ documents: docs, created: false, replaced: null });
  });

  it('a single click on the preview tab\'s own file changes nothing; a double click keeps it', () => {
    const docs: Doc[] = [{ id: 'a', preview: true }];
    expect(openTab(docs, 'a', make('a'), 'preview').documents).toBe(docs);
    const kept = openTab(docs, 'a', make('a'), 'keep');
    expect(kept).toMatchObject({ created: false, replaced: null });
    expect(ids(kept.documents)).toEqual(['a']);
    expect('preview' in kept.documents[0]).toBe(false);
  });

  it('never replaces a preview tab with unsaved edits: it is kept and the new file becomes the preview tab', () => {
    const r = openTab<Doc>([{ id: 'a', preview: true, dirty: true }, { id: 'b' }], 'c', make('c'), 'preview', dirty);
    expect(r).toMatchObject({ created: true, replaced: null });
    expect(ids(r.documents)).toEqual(['a', 'b', 'c*']);
    expect(r.documents[0].dirty).toBe(true);
  });

  it('leaves at most one preview tab even when the list had two', () => {
    const r = openTab<Doc>([{ id: 'a', preview: true }, { id: 'b', preview: true }], 'c', make('c'), 'preview');
    expect(r.replaced).toBe('a');
    expect(ids(r.documents)).toEqual(['c*', 'b']);
  });

  it('a new tab never inherits a preview mark from what create() returns', () => {
    const r = openTab<Doc>([], 'a', () => ({ id: 'a', preview: true }), 'keep');
    expect(ids(r.documents)).toEqual(['a']);
  });

  it('does not mutate the input', () => {
    const docs: Doc[] = [{ id: 'a', preview: true }];
    const copy = JSON.parse(JSON.stringify(docs));
    openTab(docs, 'b', make('b'), 'preview');
    openTab(docs, 'a', make('a'), 'keep');
    expect(docs).toEqual(copy);
  });
});

describe('keeping tabs', () => {
  it('keepTab removes the mark of that tab only and returns the same list for a kept tab', () => {
    const docs: Doc[] = [{ id: 'a' }, { id: 'b', preview: true }];
    expect(keepTab(docs, 'a')).toBe(docs);
    expect(keepTab(docs, 'missing')).toBe(docs);
    const next = keepTab(docs, 'b');
    expect(ids(next)).toEqual(['a', 'b']);
    expect(next[0]).toBe(docs[0]);
  });

  it('keepTabs keeps every preview tab, or the ones a filter picks', () => {
    const docs: Doc[] = [{ id: 'a', preview: true, dirty: true }, { id: 'b', preview: true }, { id: 'c' }];
    expect(ids(keepTabs(docs))).toEqual(['a', 'b', 'c']);
    expect(ids(keepTabs(docs, dirty))).toEqual(['a', 'b*', 'c']);
    const none: Doc[] = [{ id: 'c' }];
    expect(keepTabs(none)).toBe(none);
  });

  it('previewTabId finds the preview tab', () => {
    expect(previewTabId([{ id: 'a' }, { id: 'b', preview: true }])).toBe('b');
    expect(previewTabId([{ id: 'a' }])).toBeNull();
  });
});

describe('swapOrderKey', () => {
  it('puts the new key where the replaced one was', () => {
    expect(swapOrderKey(['grid:1', 'file:a', 'file:b'], 'file:a', 'file:c')).toEqual(['grid:1', 'file:c', 'file:b']);
  });

  it('drops an older copy of the new key (no duplicates)', () => {
    expect(swapOrderKey(['file:c', 'grid:1', 'file:a'], 'file:a', 'file:c')).toEqual(['grid:1', 'file:c']);
  });

  it('returns the same order when the old key is not in it', () => {
    const order = ['grid:1'];
    expect(swapOrderKey(order, 'file:a', 'file:b')).toBe(order);
    expect(swapOrderKey(order, 'grid:1', 'grid:1')).toBe(order);
  });
});

describe('the "Open files in preview mode" setting', () => {
  it('is on by default, stays off through a save and falls back to on for a bad or missing value', () => {
    const fresh = defaultState();
    expect(fresh.settings.previewTabs).toBe(true);
    const off = updateSettings(fresh, { previewTabs: false });
    expect(normalizeState(JSON.parse(JSON.stringify(off)))!.settings.previewTabs).toBe(false);
    const raw = JSON.parse(JSON.stringify(fresh));
    raw.settings.previewTabs = 'no';
    expect(normalizeState(raw)!.settings.previewTabs).toBe(true);
    delete raw.settings.previewTabs; // a state.json from before the setting
    expect(normalizeState(raw)!.settings.previewTabs).toBe(true);
  });
});
