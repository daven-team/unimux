// Editor tabs and files changed on disk (renderer file store with a stubbed window): clean tabs reload, dirty ones get a
// notice, a save conflict comes as a code and offers Reload / Show diff / Overwrite.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentId } from '../src/shared/fileOps';
import { lineDiff } from '../src/shared/textDiff';

interface TestDoc { id: string; text: string; savedText: string; diskText: string; error: string | null; diskConflict?: string; externalText?: string }
let files: any;
let disk = '';
let writes: Array<{ text: string; expected: string }> = [];

beforeAll(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      readProjectFile: async () => ({ kind: 'text', text: disk, size: disk.length, truncated: false }),
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
});
