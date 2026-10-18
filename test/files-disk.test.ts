// Editor tabs and files changed on disk (renderer file store with a stubbed window): clean tabs reload, dirty ones get a
// notice, a save conflict comes as a code and offers Reload / Show diff / Overwrite.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentId } from '../src/shared/fileOps';
import { DIFF_VIEW_MAX_LINES, diffView, lineDiff, minimalChange } from '../src/shared/textDiff';

interface TestDoc { id: string; text: string; savedText: string; diskText: string; error: string | null; diskConflict?: string; externalText?: string }
let files: any;
let disk = '';
let writes: Array<{ text: string; expected: string }> = [];
let reads = 0;
const storage = new Map<string, string>();
/** A modification time that changes with the content (a real write moves mtime). */
const mtimeOf = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      statProjectFile: async () => ({ size: disk.length, mtimeMs: mtimeOf(disk) }),
      readProjectFile: async () => { reads++; return { kind: 'text', text: disk, size: disk.length, truncated: false }; },
      writeProjectFile: async (_p: string, _path: string, text: string, expected: string) => {
        writes.push({ text, expected });
        if (expected !== disk) return { ok: false, code: 'conflict', error: 'any wording' };
        disk = text;
        return { ok: true };
      },
    },
    setTimeout, clearTimeout,
  });
  const modulePath = '../src/renderer/src/files';
  files = await import(/* @vite-ignore */ modulePath);
});

const ID = documentId('p', 'a.txt');
const get = (): TestDoc => files.useFileStore.getState().documents.find((d: TestDoc) => d.id === ID);
function open(text: string, edited?: string): void {
  disk = text;
  files.useFileStore.setState({ documents: [{ id: ID, projectId: 'p', relativePath: 'a.txt', name: 'a.txt', text: edited ?? text, savedText: text, diskText: text, status: 'ready', saving: false, error: null, wrap: false }], activeFileId: ID });
}
beforeEach(() => { writes = []; });

describe('files changed on disk', () => {
  it('a clean tab takes the new text from disk', async () => {
    open('one\n');
    disk = 'two\n';
    await files.checkFileOnDisk(ID);
    expect(get()).toMatchObject({ text: 'two\n', savedText: 'two\n', diskText: 'two\n' });
    expect(get().diskConflict).toBeUndefined();
  });

  it('a dirty tab keeps the edits and gets a notice; the notice goes when the disk is back', async () => {
    open('one\n', 'mine\n');
    disk = 'theirs\n';
    await files.checkFileOnDisk(ID);
    expect(get()).toMatchObject({ text: 'mine\n', diskText: 'one\n', diskConflict: 'changed', externalText: 'theirs\n' });
    disk = 'one\n';
    await files.checkFileOnDisk(ID);
    expect(get().diskConflict).toBeUndefined();
  });

  it('a save conflict is recognised by its code (not the message text) and keeps the draft', async () => {
    open('one\n', 'mine\n');
    disk = 'theirs\n';
    expect(await files.saveFile(ID)).toBe(false);
    expect(get()).toMatchObject({ text: 'mine\n', diskConflict: 'save', error: null });
    expect(writes).toEqual([{ text: 'mine\n', expected: 'one\n' }]);
  });

  it('Overwrite writes the draft against the text on disk now', async () => {
    open('one\n', 'mine\n');
    disk = 'theirs\n';
    await files.saveFile(ID);
    expect(await files.overwriteFileOnDisk(ID)).toBe(true);
    expect(disk).toBe('mine\n');
    expect(get()).toMatchObject({ text: 'mine\n', savedText: 'mine\n', diskText: 'mine\n' });
    expect(get().diskConflict).toBeUndefined();
  });

  it('Reload drops the draft and shows the disk text; Show diff reads it for the diff', async () => {
    open('one\n', 'mine\n');
    disk = 'theirs\n';
    await files.saveFile(ID);
    expect(await files.loadDiskText(ID)).toBe('theirs\n');
    expect(get().externalText).toBe('theirs\n');
    await files.reloadFileFromDisk(ID);
    expect(get()).toMatchObject({ text: 'theirs\n', savedText: 'theirs\n', diskText: 'theirs\n' });
    expect(get().diskConflict).toBeUndefined();
  });
});

describe('a conflict notice', () => {
  it('a dirty tab does not re-read the same conflict; undone back to clean it takes the disk text', async () => {
    open('one\n', 'mine\n');
    disk = 'theirs\n';
    await files.checkFileOnDisk(ID);
    expect(get().diskConflict).toBe('changed');
    reads = 0;
    await files.checkFileOnDisk(ID);
    expect(reads).toBe(0);
    files.editFile(ID, 'one\n'); // undo: clean again
    await files.checkFileOnDisk(ID);
    expect(get()).toMatchObject({ text: 'theirs\n', savedText: 'theirs\n', diskText: 'theirs\n' });
    expect(get().diskConflict).toBeUndefined();
  });

  it('stored drafts carry no disk copy or stamps, and the notice comes back after a restart', async () => {
    open('one\n', 'mine\n');
    disk = 'theirs\n';
    await files.checkFileOnDisk(ID);
    expect(get()).toMatchObject({ diskConflict: 'changed', externalText: 'theirs\n' });
    files.flushDrafts();
    const stored = JSON.parse(storage.get('mc-file-drafts-v1') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('mine\n');
    for (const key of ['externalText', 'diskStamp', 'conflictStamp', 'diskConflict']) expect(stored[0]).not.toHaveProperty(key);
    vi.resetModules();
    const modulePath = '../src/renderer/src/files';
    const restarted = await import(/* @vite-ignore */ modulePath);
    const doc = (): TestDoc => restarted.useFileStore.getState().documents.find((d: TestDoc) => d.id === ID)!;
    expect(doc()).toMatchObject({ text: 'mine\n', diskText: 'one\n' });
    expect(doc().diskConflict).toBeUndefined();
    await restarted.checkFileOnDisk(ID);
    expect(doc()).toMatchObject({ text: 'mine\n', diskConflict: 'changed', externalText: 'theirs\n' });
  });
});

describe('cheap checks', () => {
  it('reads the text only when size or modification time changed since the last read', async () => {
    open('one\n');
    reads = 0;
    await files.checkFileOnDisk(ID); // no stamp yet: one read
    expect(reads).toBe(1);
    await files.checkFileOnDisk(ID);
    await files.checkFileOnDisk(ID);
    expect(reads).toBe(1);
    disk = 'one, then more\n';
    await files.checkFileOnDisk(ID);
    expect(reads).toBe(2);
    expect(get().text).toBe('one, then more\n');
  });
});

describe('minimalChange', () => {
  it('replaces only the changed middle, so the editor keeps the cursor and scroll', () => {
    expect(minimalChange('abc\ndef\nghi\n', 'abc\nDEF\nghi\n')).toEqual({ from: 4, to: 7, insert: 'DEF' });
    expect(minimalChange('abc', 'abcd')).toEqual({ from: 3, to: 3, insert: 'd' });
    expect(minimalChange('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' });
    const before = 'x'.repeat(5);
    const { from, to, insert } = minimalChange(before, 'yy');
    expect(before.slice(0, from) + insert + before.slice(to)).toBe('yy');
  });
});

describe('lineDiff', () => {
  it('marks removed and added lines with numbers and folds long unchanged runs', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 10', 'line ten').replace('line 20', 'line 20\nline 21');
    const lines = lineDiff(before, after, 1);
    expect(lines.filter((l) => l.kind === 'del')).toEqual([{ kind: 'del', text: 'line 10', oldNo: 10 }]);
    expect(lines.filter((l) => l.kind === 'add')).toEqual([{ kind: 'add', text: 'line ten', newNo: 10 }, { kind: 'add', text: 'line 21', newNo: 21 }]);
    expect(lines[0]).toEqual({ kind: 'hunk', text: expect.any(String) });
    expect(lines.filter((l) => l.kind === 'ctx').map((l) => l.oldNo)).toEqual([9, 11, 20]);
  });

  it('identical texts (line endings aside) have no lines', () => {
    expect(lineDiff('a\r\nb', 'a\nb')).toEqual([]);
  });

  it('a full rewrite of a huge file neither overflows the stack nor renders every line', () => {
    const before = Array.from({ length: 150_000 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 150_000 }, (_, i) => `new ${i}`).join('\n');
    const view = diffView(before, after);
    expect(view.total).toBe(300_000);
    expect(view.lines).toHaveLength(DIFF_VIEW_MAX_LINES);
    expect(view.width).toBe(String(DIFF_VIEW_MAX_LINES).length);
    expect(diffView('a\nb', 'a\nc')).toMatchObject({ total: 3, width: 1 });
  });
});
