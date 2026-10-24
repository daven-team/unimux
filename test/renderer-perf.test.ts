// 0.9.3 renderer performance: structural sharing of the state, equality helpers of memoized components, badge counts,
// the windowed git history and the delayed (throttled) saving of editor drafts.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { layoutForCount } from '../src/shared/layout';
import { patchChanges, propsEqualWithStyle, shallowEqual } from '../src/shared/renderEquality';
import { addProject, addTab, defaultState, updateCell, updateSettings } from '../src/shared/state';
import { stateChange } from '../src/shared/statePatch';
import { NO_COUNTS, projectCountsKey, statusCountsKey, statusCountsOf } from '../src/shared/statusCounts';
import { shareStructure } from '../src/shared/structuralShare';
import type { AppState } from '../src/shared/types';
import { rowSlots, rowWindow } from '../src/shared/virtualRows';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function twoProjects(): AppState {
  let s = defaultState();
  for (let p = 0; p < 2; p++) {
    s = addProject(s, { name: `P${p}`, path: `/tmp/p${p}` });
    s = addTab(s, s.activeProjectId!, { name: 'Grid', layout: layoutForCount(3), cells: [{ profileId: 'shell' }, { profileId: 'shell' }, { profileId: 'shell' }] });
  }
  return s;
}

describe('shareStructure', () => {
  it('returns the previous value when everything is equal', () => {
    const prev = twoProjects();
    expect(shareStructure(prev, clone(prev))).toBe(prev);
  });

  it('keeps the identity of unchanged sub-trees and replaces the changed path only', () => {
    const prev = twoProjects();
    const cellId = prev.projects[1].tabs[0].cells[1].id;
    const next = shareStructure(prev, clone(updateCell(prev, cellId, { color: '#ff0000' })));
    expect(next).not.toBe(prev);
    expect(next.projects[1].tabs[0].cells[1].color).toBe('#ff0000');
    expect(next.projects[0]).toBe(prev.projects[0]);
    expect(next.projects[1]).not.toBe(prev.projects[1]);
    expect(next.projects[1].tabs[0].cells[0]).toBe(prev.projects[1].tabs[0].cells[0]);
    expect(next.projects[1].tabs[0].cells[2]).toBe(prev.projects[1].tabs[0].cells[2]);
    expect(next.profiles).toBe(prev.profiles);
    expect(next.settings).toBe(prev.settings);
  });

  it('treats arrays by position and length, and a missing key unlike an undefined one', () => {
    const a = [{ x: 1 }, { x: 2 }];
    const grown = shareStructure(a, [{ x: 1 }, { x: 2 }, { x: 3 }]);
    expect(grown).not.toBe(a);
    expect(grown[0]).toBe(a[0]);
    expect(shareStructure(a, [{ x: 1 }])).not.toBe(a);
    const o: Record<string, unknown> = { a: 1 };
    expect(shareStructure(o, { a: 1, b: undefined })).not.toBe(o);
    expect(shareStructure({ a: 1, b: undefined } as Record<string, unknown>, { a: 1 })).toEqual({ a: 1 });
    expect(shareStructure(1, 2)).toBe(2);
    expect(shareStructure('x', 'x')).toBe('x');
  });
});

describe('equality helpers', () => {
  it('compares props by reference and the style by its values', () => {
    const cell = { id: 'c' };
    const onDown = () => undefined;
    const a: Record<string, unknown> = { cell, index: 0, style: { left: '0%', top: '0%' }, maximized: false, onHeadPointerDown: onDown };
    expect(propsEqualWithStyle(a, { ...a, style: { left: '0%', top: '0%' } })).toBe(true);
    expect(propsEqualWithStyle(a, { ...a, style: { left: '1%', top: '0%' } })).toBe(false);
    expect(propsEqualWithStyle(a, { ...a, cell: { id: 'c' } })).toBe(false);
    expect(propsEqualWithStyle(a, { ...a, onHeadPointerDown: undefined })).toBe(false);
    expect(propsEqualWithStyle(a, { ...a, dragSource: false })).toBe(false);
  });

  it('knows when a patch changes nothing', () => {
    const ui = { focusedCellId: 'a', palette: false, titles: { x: 'y' } };
    expect(patchChanges(ui, { focusedCellId: 'a' })).toBe(false);
    expect(patchChanges(ui, { titles: ui.titles })).toBe(false);
    expect(patchChanges(ui, { focusedCellId: 'b' })).toBe(true);
    expect(patchChanges(ui, { titles: { x: 'y' } })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual(undefined, { a: 1 })).toBe(false);
  });
});

describe('status badge counts', () => {
  it('produces the same key for a flip that keeps the counts', () => {
    const s = twoProjects();
    const [a, b] = s.projects[0].tabs[0].cells;
    const one = statusCountsKey(s.projects, { [a.id]: 'working', [b.id]: 'idle' });
    expect(statusCountsKey(s.projects, { [a.id]: 'idle', [b.id]: 'working' })).toBe(one);
    expect(statusCountsKey(s.projects, { [a.id]: 'waiting', [b.id]: 'idle' })).not.toBe(one);
  });

  it('counts per tab and per project like the badges did', () => {
    const s = twoProjects();
    const [a, b, c] = s.projects[0].tabs[0].cells;
    const counts = statusCountsOf(s.projects, { [a.id]: 'working', [b.id]: 'waiting', [c.id]: 'exited' });
    expect(counts[s.projects[0].tabs[0].id]).toEqual({ working: 1, waiting: 1, exited: 1 });
    expect(counts[projectCountsKey(s.projects[0].id)]).toEqual({ working: 1, waiting: 1, exited: 1 });
    expect(counts[s.projects[1].tabs[0].id] ?? NO_COUNTS).toEqual({ working: 0, waiting: 0, exited: 0 });
  });

  it('1.0.7: an exit with a non-zero code counts as failed (the red badge), a clean one does not', () => {
    const s = twoProjects();
    const [a, b] = s.projects[0].tabs[0].cells;
    const counts = statusCountsOf(s.projects, { [a.id]: 'exited', [b.id]: 'exited' }, { [a.id]: { kind: 'exit-code', code: 3 } });
    expect(counts[s.projects[0].tabs[0].id]).toEqual({ working: 0, waiting: 0, exited: 2, failed: 1 });
    expect(counts[projectCountsKey(s.projects[0].id)]).toEqual({ working: 0, waiting: 0, exited: 2, failed: 1 });
    // A failed command at the prompt (idle) is not an exited cell.
    expect(statusCountsOf(s.projects, { [a.id]: 'idle', [b.id]: 'exited' }, { [a.id]: { kind: 'exit-code', code: 1 } })[s.projects[0].tabs[0].id])
      .toEqual({ working: 0, waiting: 0, exited: 1 });
  });
});

describe('windowed history rows', () => {
  it('renders the visible rows plus the overscan', () => {
    expect(rowWindow(0, 240, 24, 3000, 12)).toEqual({ start: 0, end: 23 });
    expect(rowWindow(2400, 240, 24, 3000, 12)).toEqual({ start: 88, end: 123 });
    expect(rowWindow(2412, 240, 24, 3000, 0)).toEqual({ start: 100, end: 111 });
    expect(rowWindow(1e9, 240, 24, 50, 5)).toEqual({ start: 45, end: 50 });
    expect(rowWindow(-30, 240, 24, 5, 12)).toEqual({ start: 0, end: 5 });
    expect(rowWindow(0, 240, 24, 0)).toEqual({ start: 0, end: 0 });
  });

  it('fills the skipped rows with gaps and keeps a focused row outside the window', () => {
    const slots = rowSlots({ start: 10, end: 13 }, 100, [50]);
    expect(slots).toEqual([
      { kind: 'gap', rows: 10 }, { kind: 'row', index: 10 }, { kind: 'row', index: 11 }, { kind: 'row', index: 12 },
      { kind: 'gap', rows: 37 }, { kind: 'row', index: 50 }, { kind: 'gap', rows: 49 },
    ]);
    const total = slots.reduce((n, slot) => n + (slot.kind === 'gap' ? slot.rows : 1), 0);
    expect(total).toBe(100);
    expect(rowSlots({ start: 0, end: 3 }, 3, [1, 7])).toEqual([{ kind: 'row', index: 0 }, { kind: 'row', index: 1 }, { kind: 'row', index: 2 }]);
  });
});

// The renderer store and the file store with a stubbed window (no DOM).
let store: any;
let files: any;
const edits: Array<{ id: string }> = [];
const storage = new Map<string, string>();
const writes: string[] = [];
let ackRevision = 0;

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(k); storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      applyStateEdit: (edit: { id: string }) => { edits.push(edit); return Promise.resolve({ revision: ackRevision, editId: edit.id }); },
      loadSnapshot: () => new Promise(() => undefined),
    },
    setTimeout, clearTimeout,
  });
  // The renderer is not part of the node tsconfig: loaded through variables, so tsc does not follow the imports.
  const storePath = '../src/renderer/src/store';
  const filesPath = '../src/renderer/src/files';
  store = await import(/* @vite-ignore */ storePath);
  files = await import(/* @vite-ignore */ filesPath);
});
afterEach(() => { vi.useRealTimers(); });

describe('store: echoed patches and acks keep what the screen shows', () => {
  it('an echo equal to the optimistic edit and its ack notify nobody', async () => {
    const start = twoProjects();
    store.useStore.getState().init({ state: clone(start), revision: 1 });
    const cellId = start.projects[1].tabs[0].cells[0].id;
    store.update((s: AppState) => updateCell(s, cellId, { color: '#00ff00' }));
    const shown = store.getS();
    const untouched = shown.projects[0];
    let notified = 0;
    const off = store.useStore.subscribe(() => { notified++; });
    // Main's echo: the same change as a patch on the confirmed revision 1.
    const confirmed = clone(updateCell(clone(start), cellId, { color: '#00ff00' }));
    ackRevision = 2;
    store.useStore.getState().applyChange(stateChange(clone(start), { state: confirmed, revision: 2, editId: edits.at(-1)!.id }));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(store.getS()).toBe(shown);
    expect(store.getS().projects[0]).toBe(untouched);
    expect(notified).toBe(0);
    off();
  });

  it('a change from main replaces only the changed path', () => {
    const before = store.getS();
    const next = clone(updateSettings(clone(before), { fontSize: 17 }));
    store.useStore.getState().applyChange(stateChange(clone(before), { state: next, revision: 3 }));
    const after = store.getS();
    expect(after.settings.fontSize).toBe(17);
    expect(after.projects).toBe(before.projects);
    expect(after.profiles).toBe(before.profiles);
  });

  it('setUi skips a patch that changes nothing', () => {
    store.setUi({ focusedCellId: 'x' });
    let notified = 0;
    const off = store.useStore.subscribe(() => { notified++; });
    store.setUi({ focusedCellId: 'x' });
    store.setUi((ui: { sessionTitles: object }) => ({ sessionTitles: ui.sessionTitles }));
    expect(notified).toBe(0);
    store.setUi({ focusedCellId: 'y' });
    expect(notified).toBe(1);
    off();
  });
});

describe('memoized components follow rebound shortcuts', () => {
  // A memoized component that shows a combo must subscribe to the shortcut settings (shortcutText reads them at render).
  const source = (path: string) => readFileSync(path, 'utf8');
  it('title bar, tab strip, grid hints and Git changes subscribe with useShortcutText', () => {
    const titleBar = source('src/renderer/src/components/TitleBar.tsx');
    for (const name of ['TitleBar', 'WorkspaceTabs']) {
      const body = titleBar.slice(titleBar.indexOf(`memo(function ${name}(`));
      expect(body.slice(0, 400)).toContain('useShortcutText()');
    }
    expect(source('src/renderer/src/components/GridView.tsx')).toMatch(/function Kbd[\s\S]{0,120}useShortcutText\(\)\(id\)/);
    expect(source('src/renderer/src/components/GitChanges.tsx')).toContain('useShortcutText()');
    expect(source('src/renderer/src/components/CellView.tsx')).toContain('useShortcutText()');
  });
});

describe('editor drafts are saved with a delay, and at once on flush', () => {
  const key = 'mc-file-drafts-v1';
  const doc = (id: string, text: string) => ({ id, projectId: 'p', relativePath: `${id}.ts`, name: `${id}.ts`, text, savedText: 'saved', diskText: 'saved', status: 'ready', saving: false, error: null, wrap: false });
  const draftWrites = () => writes.filter((k) => k === key).length;

  it('many keystrokes make one write after DRAFT_SAVE_MS', () => {
    vi.useFakeTimers();
    files.flushDrafts();
    files.useFileStore.setState({ documents: [doc('a', 'saved')], activeFileId: 'a' });
    vi.advanceTimersByTime(files.DRAFT_SAVE_MS);
    const base = draftWrites();
    for (let i = 0; i < 30; i++) files.editFile('a', `typed ${i}`);
    expect(draftWrites()).toBe(base);
    vi.advanceTimersByTime(files.DRAFT_SAVE_MS - 1);
    expect(draftWrites()).toBe(base);
    vi.advanceTimersByTime(1);
    expect(draftWrites()).toBe(base + 1);
    expect(JSON.parse(storage.get(key)!)[0].text).toBe('typed 29');
  });

  it('flushDrafts writes the pending draft now and the timer adds nothing', () => {
    vi.useFakeTimers();
    files.editFile('a', 'last key');
    const base = draftWrites();
    files.flushDrafts();
    expect(draftWrites()).toBe(base + 1);
    expect(JSON.parse(storage.get(key)!)[0].text).toBe('last key');
    vi.advanceTimersByTime(files.DRAFT_SAVE_MS * 2);
    expect(draftWrites()).toBe(base + 1);
    files.flushDrafts();
    expect(draftWrites()).toBe(base + 1);
  });

  it('switching the active file writes nothing; discarding a draft is written', () => {
    vi.useFakeTimers();
    const base = draftWrites();
    files.useFileStore.setState({ activeFileId: null });
    vi.advanceTimersByTime(files.DRAFT_SAVE_MS);
    expect(draftWrites()).toBe(base);
    files.useFileStore.setState({ documents: [] });
    vi.advanceTimersByTime(files.DRAFT_SAVE_MS);
    expect(JSON.parse(storage.get(key)!)).toEqual([]);
  });

  it('a stored draft whose document became clean is removed at once', () => {
    vi.useFakeTimers();
    files.useFileStore.setState({ documents: [doc('b', 'draft')], activeFileId: 'b' });
    files.flushDrafts();
    expect(JSON.parse(storage.get(key)!).map((d: { id: string }) => d.id)).toEqual(['b']);
    files.editFile('b', 'saved'); // back to the saved text: no longer dirty
    expect(JSON.parse(storage.get(key)!)).toEqual([]);
    files.editFile('b', 'again');
    expect(JSON.parse(storage.get(key)!)).toEqual([]);
    vi.advanceTimersByTime(files.DRAFT_SAVE_MS);
    expect(JSON.parse(storage.get(key)!)[0].text).toBe('again');
  });

  it('the flush runs before a reload, when the window is hidden and when the app quits', () => {
    const actions = readFileSync('src/renderer/src/actions.ts', 'utf8');
    expect(actions).toMatch(/export function flushPendingSaves\(\): void \{[^}]*flushDrafts\(\)/);
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8');
    expect(app).toContain("window.addEventListener('beforeunload', flushPendingSaves)");
    expect(app).toContain("window.mc.on('app:before-quit', flushPendingSaves)");
    expect(app).toMatch(/visibilitychange[^\n]*flushPendingSaves/);
  });
});
