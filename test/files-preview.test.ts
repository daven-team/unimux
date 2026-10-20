// Preview tabs in the renderer file store with a stubbed window (no DOM): a single click opens the preview tab, the next
// file takes its place in the strip, a double click, an edit or a save keeps it, and unsaved edits are never replaced.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentId } from '../src/shared/fileOps';

// The renderer is not part of the node tsconfig: loaded through variables, so tsc does not follow the imports.
interface TestDoc { id: string; relativePath: string; text: string; savedText: string; status: string; preview?: boolean }
let files: any;
let store: any;
const storage = new Map<string, string>();
/** Reads in flight by path: a test lets each one finish when it wants. */
const reads = new Map<string, Array<(text: string) => void>>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      // No answer from main: the state edits stay local (the test looks at the store right away).
      applyStateEdit: () => new Promise(() => undefined),
      loadSnapshot: () => new Promise(() => undefined),
      readProjectFile: (_project: string, path: string) => new Promise((resolve) => {
        reads.set(path, [...(reads.get(path) ?? []), (text: string) => resolve({ kind: 'text', text, size: text.length, truncated: false })]);
      }),
      writeProjectFile: () => Promise.resolve({ ok: true }),
      statProjectFile: () => Promise.resolve(null),
    },
    setTimeout, clearTimeout,
  });
  const paths = ['../src/renderer/src/files', '../src/renderer/src/store'];
  [files, store] = await Promise.all(paths.map((p) => import(/* @vite-ignore */ p)));
});

const id = (path: string) => documentId('p', path);
const docs = (): TestDoc[] => files.useFileStore.getState().documents;
const tabs = () => docs().map((d) => (d.preview ? `${d.relativePath}*` : d.relativePath));
const finishRead = (path: string, text = `disk ${path}`) => { for (const done of reads.get(path) ?? []) done(text); reads.delete(path); };
const setSettings = (patch: Record<string, unknown>) => store.useStore.setState((st: any) => ({ s: { ...st.s, settings: { ...st.s.settings, ...patch } } }));

beforeEach(() => {
  reads.clear();
  files.useFileStore.setState({ documents: [], activeFileId: null });
  store.useStore.setState((st: any) => ({ s: { ...st.s, workspaceOrder: [], settings: { ...st.s.settings, previewTabs: true } } }));
});

describe('opening files with a single click', () => {
  it('replaces the preview tab in place: same slot in the strip, the new file in front, the old read ignored', async () => {
    void files.openFile('p', 'kept.ts', 'keep');
    finishRead('kept.ts');
    void files.openFile('p', 'a.ts', 'preview');
    expect(tabs()).toEqual(['kept.ts', 'a.ts*']);
    store.useStore.setState((st: any) => ({ s: { ...st.s, workspaceOrder: ['grid:g', `file:${id('a.ts')}`, `file:${id('kept.ts')}`] } }));

    const opened = files.openFile('p', 'b.ts', 'preview');
    expect(tabs()).toEqual(['kept.ts', 'b.ts*']);
    expect(files.useFileStore.getState().activeFileId).toBe(id('b.ts'));
    // The new tab takes the old one's place in the strip (before the kept tab), in the same tick.
    expect(store.getS().workspaceOrder).toEqual(['grid:g', `file:${id('b.ts')}`, `file:${id('kept.ts')}`]);

    // The read of the replaced file lands nowhere; the new tab gets its own text.
    finishRead('a.ts', 'stale');
    finishRead('b.ts', 'fresh');
    await opened;
    expect(docs().find((d) => d.id === id('b.ts'))).toMatchObject({ text: 'fresh', status: 'ready', preview: true });
    expect(docs().some((d) => d.text === 'stale')).toBe(false);
  });

  it('a file open in a kept tab is only brought to the front', async () => {
    void files.openFile('p', 'kept.ts', 'keep');
    finishRead('kept.ts');
    void files.openFile('p', 'a.ts', 'preview');
    void files.openFile('p', 'kept.ts', 'preview');
    expect(tabs()).toEqual(['kept.ts', 'a.ts*']);
    expect(files.useFileStore.getState().activeFileId).toBe(id('kept.ts'));
  });

  it('a double click (the second click opens with "keep") keeps the preview tab', () => {
    void files.openFile('p', 'a.ts', 'preview');
    void files.openFile('p', 'a.ts', 'keep');
    expect(tabs()).toEqual(['a.ts']);
    void files.openFile('p', 'b.ts', 'preview');
    expect(tabs()).toEqual(['a.ts', 'b.ts*']);
  });

  it('keepFile (a double click on the tab, a drag, "Keep open") keeps it; nothing changes for a kept tab', () => {
    void files.openFile('p', 'a.ts', 'preview');
    files.keepFile(id('a.ts'));
    expect(tabs()).toEqual(['a.ts']);
    const before = docs();
    files.keepFile(id('a.ts'));
    expect(docs()).toBe(before);
  });
});

describe('what keeps the preview tab', () => {
  it('the first edit keeps it, so the next file never replaces unsaved changes', async () => {
    const opened = files.openFile('p', 'a.ts', 'preview');
    finishRead('a.ts', 'one');
    await opened;
    files.editFile(id('a.ts'), 'one'); // the editor echoing the same text is no edit
    expect(tabs()).toEqual(['a.ts*']);
    files.editFile(id('a.ts'), 'two');
    expect(tabs()).toEqual(['a.ts']);
    void files.openFile('p', 'b.ts', 'preview');
    expect(tabs()).toEqual(['a.ts', 'b.ts*']);
    expect(docs()[0]).toMatchObject({ text: 'two', savedText: 'one' });
  });

  it('a save keeps it, even when there was nothing to write', async () => {
    const opened = files.openFile('p', 'a.ts', 'preview');
    finishRead('a.ts');
    await opened;
    expect(await files.saveFile(id('a.ts'))).toBe(true);
    expect(tabs()).toEqual(['a.ts']);
  });

  it('a preview tab with unsaved changes (however they came) is kept, never replaced', () => {
    files.useFileStore.setState({ documents: [{ id: id('a.ts'), projectId: 'p', relativePath: 'a.ts', name: 'a.ts', text: 'edited', savedText: 'x', diskText: 'x', status: 'ready', saving: false, error: null, wrap: false, preview: true }], activeFileId: id('a.ts') });
    void files.openFile('p', 'b.ts', 'preview');
    expect(tabs()).toEqual(['a.ts', 'b.ts*']);
    expect(docs()[0].text).toBe('edited');
  });
});

describe('other ways in', () => {
  it('a diff opens in the preview tab by default and replaces a previewed file', () => {
    void files.openFile('p', 'a.ts', 'preview');
    files.openDiffTab('p', { source: 'working', path: 'a.ts' });
    expect(docs()).toHaveLength(1);
    expect(docs()[0]).toMatchObject({ preview: true, diff: { source: 'working', path: 'a.ts' } });
    files.openDiffTab('p', { source: 'staged', path: 'b.ts' }, 'keep');
    expect(docs().map((d) => !!d.preview)).toEqual([true, false]);
  });

  it('with the setting off a single click opens a kept tab, and switching it off keeps the preview tab', () => {
    void files.openFile('p', 'a.ts', 'preview');
    setSettings({ previewTabs: false });
    expect(tabs()).toEqual(['a.ts']);
    void files.openFile('p', 'b.ts', 'preview');
    expect(tabs()).toEqual(['a.ts', 'b.ts']);
    setSettings({ previewTabs: true });
    void files.openFile('p', 'c.ts', 'preview');
    expect(tabs()).toEqual(['a.ts', 'b.ts', 'c.ts*']);
  });

  it('closing the preview tab just closes it; the next single click opens a new one at the end', async () => {
    void files.openFile('p', 'kept.ts', 'keep');
    void files.openFile('p', 'a.ts', 'preview');
    expect(await files.closeFile(id('a.ts'))).toBe(true);
    void files.openFile('p', 'b.ts', 'preview');
    expect(tabs()).toEqual(['kept.ts', 'b.ts*']);
  });

  it('a stored draft never carries the preview mark', () => {
    files.useFileStore.setState({ documents: [{ id: id('a.ts'), projectId: 'p', relativePath: 'a.ts', name: 'a.ts', text: 'draft', savedText: 'x', diskText: 'x', status: 'ready', saving: false, error: null, wrap: false, preview: true }], activeFileId: null });
    files.flushDrafts();
    const stored = JSON.parse(storage.get('mc-file-drafts-v1') ?? '[]');
    expect(stored).toHaveLength(1);
    expect('preview' in stored[0]).toBe(false);
  });
});

describe('the keyboard after a double click or Enter in the tree', () => {
  it('focusFileEditor focuses the editor on screen right away, else the editor of the file when it appears', () => {
    const focus = vi.fn();
    const unregister = files.registerEditorFocus(id('a.ts'), focus);
    files.treeOpen.keyboard = true;
    files.focusFileEditor(id('a.ts'));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(files.treeOpen.keyboard).toBe(false); // nothing left over for the next editor that mounts
    // Still loading (no editor yet): the editor takes focus when it mounts (CodeEditor reads treeOpen.keyboard).
    files.focusFileEditor(id('b.ts'));
    expect(files.treeOpen.keyboard).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
    files.focusFileEditor(id('a.ts'));
    expect(focus).toHaveBeenCalledTimes(1);
    files.treeOpen.keyboard = false;
  });

  it('an editor unmounting after its replacement mounted leaves the replacement registered', () => {
    const first = vi.fn(), second = vi.fn();
    const unregisterFirst = files.registerEditorFocus(id('a.ts'), first);
    const unregisterSecond = files.registerEditorFocus(id('a.ts'), second);
    unregisterFirst();
    files.focusFileEditor(id('a.ts'));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    unregisterSecond();
    files.treeOpen.keyboard = false;
  });
});
