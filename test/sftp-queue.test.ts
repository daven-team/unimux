// The transfer queue with a fake (hostile) source side: names from the source are never joined onto the target unchecked.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSide, SftpError, remoteEntry, type DirEntry, type FileSide, type Meta } from '../src/sftphost/sides';
import { TransferQueue } from '../src/sftphost/queue';
import { posixBasename, posixContains, posixJoin, posixParent, safeEntryName, type TransferItem } from '../src/shared/sftp';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-queue-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A remote-like source whose folder listing is whatever the "server" says. */
function fakeSource(tree: Record<string, string[] | string>): FileSide {
  const meta = (path: string): Meta | null => {
    const node = tree[path];
    if (node === undefined) return null;
    return typeof node === 'string' ? { kind: 'file', size: node.length, mtime: 0 } : { kind: 'dir', size: 0, mtime: 0 };
  };
  return {
    remote: true, caseInsensitive: false,
    validName: (name) => safeEntryName(name),
    join: (d, n) => posixJoin(d, n), contains: posixContains, basename: posixBasename, dirname: posixParent,
    stat: async (p) => meta(p), lstat: async (p) => meta(p),
    // The listing names come straight from the "server": they are not checked here.
    readdir: async (p) => (tree[p] as string[]).map((name): DirEntry => ({ name, ...(meta(`${p}/${name}`) ?? { kind: 'file', size: 4, mtime: 0 }) })),
    mkdir: async () => { throw new SftpError('permission'); }, unlink: async () => undefined, rmdir: async () => undefined,
    rename: async () => undefined, setMtime: async () => undefined,
    openRead: async (p) => { const text = typeof tree[p] === 'string' ? tree[p] as string : 'EVIL'; return { stream: Readable.from([Buffer.from(text)]), size: text.length }; },
    openWrite: async () => { throw new SftpError('permission'); },
  };
}

async function settle(q: TransferQueue, batchId: string): Promise<TransferItem[]> {
  for (let i = 0; i < 500; i++) {
    const items = q.items().filter((x) => x.batchId === batchId);
    if (items.length && items.every((x) => ['done', 'failed', 'cancelled'].includes(x.state))) return items;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
}

describe('TransferQueue with names from the source side', () => {
  it('fails "../evil", "a/b", "c:d" and "NUL" as invalid names and writes nothing outside the target folder', async () => {
    const target = join(dir, 'target');
    mkdirSync(target);
    const src = fakeSource({ '/srv': ['../evil', 'a/b', 'a\\b', 'c:d', 'NUL', '..', 'ok.txt', 'sub'], '/srv/ok.txt': 'fine', '/srv/sub': ['../../evil2', 'deep.txt'], '/srv/sub/deep.txt': 'deep' });
    // The local side with Windows name rules on every platform (":" and device names).
    const dst = new LocalSide(true, true);
    const q = new TransferQueue('sftp:x', () => ({ src, dst }), { changed: () => undefined, removed: () => undefined, activeChanged: () => undefined });
    const { batchId } = await q.enqueue({ direction: 'download', sources: ['/srv'], targetDir: target });
    const items = await settle(q, batchId);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    for (const bad of ['srv/../evil', 'srv/a/b', 'srv/a\\b', 'srv/c:d', 'srv/NUL', 'srv/..', 'srv/sub/../../evil2']) expect(byName[bad], bad).toMatchObject({ state: 'failed', error: 'invalidName' });
    expect(byName['srv/ok.txt']).toMatchObject({ state: 'done' });
    expect(byName['srv/sub/deep.txt']).toMatchObject({ state: 'done' });
    expect(readFileSync(join(target, 'srv', 'ok.txt'), 'utf8')).toBe('fine');
    expect(readdirSync(dir)).toEqual(['target']);
    expect(readdirSync(join(target, 'srv')).sort()).toEqual(['ok.txt', 'sub']);
    // A retry cannot make such a name safe.
    expect(q.retry([byName['srv/../evil'].id])).toBe(false);
  });

  it('a hostile top-level name is refused too', async () => {
    const target = join(dir, 't');
    mkdirSync(target);
    const src = fakeSource({ '/x/CON': 'x' });
    const q = new TransferQueue('sftp:x', () => ({ src, dst: new LocalSide(true, true) }), { changed: () => undefined, removed: () => undefined, activeChanged: () => undefined });
    const { batchId } = await q.enqueue({ direction: 'download', sources: ['/x/CON'], targetDir: target });
    expect((await settle(q, batchId))[0]).toMatchObject({ state: 'failed', error: 'invalidName' });
    expect(readdirSync(target)).toEqual([]);
  });

  it('a listing never shows an unsafe server name as a normal entry', () => {
    const attrs = { mode: 0o100644, size: 3, mtime: 0, atime: 0, uid: 0, gid: 0 };
    expect(remoteEntry('/srv', { filename: 'ok.txt', longname: '', attrs })).toMatchObject({ path: '/srv/ok.txt', kind: 'file' });
    for (const bad of ['../evil', 'a/b', 'a\\b']) expect(remoteEntry('/srv', { filename: bad, longname: '', attrs: { ...attrs, mode: 0o040755 } }), bad).toMatchObject({ unsafeName: true, kind: 'other', path: '' });
  });
});
