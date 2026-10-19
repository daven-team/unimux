// The transfer queue with a fake (hostile) source side: names from the source are never joined onto the target unchecked.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSide, SftpError, remoteEntry, sameLocalFile, type DirEntry, type FileSide, type Meta } from '../src/sftphost/sides';
import { TransferQueue } from '../src/sftphost/queue';
import { TargetRegistry } from '../src/sftphost/targets';
import { posixBasename, posixContains, posixJoin, posixParent, safeEntryName, type TransferItem } from '../src/shared/sftp';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-queue-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Node = string | string[] | { link: string } | { other: true };

/** A remote-like source whose folder listing is whatever the "server" says (links resolve inside the fake tree). */
function fakeSource(tree: Record<string, Node>, opts: { slowReaddir?: () => Promise<void> } = {}): FileSide {
  const resolveLink = (path: string, hops = 0): string | null => {
    const node = tree[path];
    if (node === undefined || hops > 8) return null;
    return typeof node === 'object' && !Array.isArray(node) && 'link' in node ? resolveLink(node.link, hops + 1) : path;
  };
  const metaOf = (node: Node | undefined): Meta | null => {
    if (node === undefined) return null;
    if (typeof node === 'string') return { kind: 'file', size: node.length, mtime: 0 };
    if (Array.isArray(node)) return { kind: 'dir', size: 0, mtime: 0 };
    return 'link' in node ? { kind: 'symlink', size: 0, mtime: 0 } : { kind: 'other', size: 0, mtime: 0 };
  };
  const statOf = (p: string) => { const r = resolveLink(p); return r ? metaOf(tree[r]) : null; };
  return {
    remote: true, caseInsensitive: false, inflight: new TargetRegistry((p) => p), realpath: async (p) => resolveLink(p),
    validName: (name) => safeEntryName(name),
    join: (d, n) => posixJoin(d, n), contains: posixContains, basename: posixBasename, dirname: posixParent,
    stat: async (p) => statOf(p), lstat: async (p) => metaOf(tree[p]),
    // The listing names come straight from the "server": they are not checked here.
    readdir: async (p) => {
      await opts.slowReaddir?.();
      const r = resolveLink(p)!;
      return (tree[r] as string[]).map((name): DirEntry => ({ name, ...(metaOf(tree[`${r}/${name}`]) ?? { kind: 'file', size: 4, mtime: 0 }) }));
    },
    mkdir: async () => { throw new SftpError('permission'); }, unlink: async () => undefined, rmdir: async () => undefined,
    rename: async () => undefined, setMtime: async () => undefined,
    openRead: async (p) => { const r = resolveLink(p); const node = r ? tree[r] : undefined; const text = typeof node === 'string' ? node : 'EVIL'; return { stream: Readable.from([Buffer.from(text)]), size: text.length }; },
    openWrite: async () => { throw new SftpError('permission'); },
  };
}

/** An in-memory target side (fast enough for 50,000 files); `writes` counts writers open at the same time per folded key. */
function memSide(opts: { caseInsensitive?: boolean; slowWriteMs?: number } = {}) {
  const fold = (p: string) => (opts.caseInsensitive ? p.toLowerCase() : p);
  const files = new Map<string, { name: string; data: Buffer }>();
  const dirs = new Set<string>(['/', '/t']);
  let open = 0, maxOpen = 0;
  const openByKey = new Map<string, number>();
  let maxSameKey = 0;
  const meta = (p: string): Meta | null => (dirs.has(fold(p)) ? { kind: 'dir', size: 0, mtime: 0 } : files.has(fold(p)) ? { kind: 'file', size: files.get(fold(p))!.data.length, mtime: 0 } : null);
  const side: FileSide = {
    remote: true, caseInsensitive: !!opts.caseInsensitive, inflight: new TargetRegistry((p) => fold(posixJoin(p))), realpath: async (p) => p,
    validName: (name) => safeEntryName(name),
    join: (d, n) => posixJoin(d, n), contains: posixContains, basename: posixBasename, dirname: posixParent,
    stat: async (p) => meta(p), lstat: async (p) => meta(p),
    readdir: async (d) => [...files.values()].filter((f) => posixParent(f.name) === d).map((f) => ({ name: posixBasename(f.name), kind: 'file' as const, size: f.data.length, mtime: 0 })),
    mkdir: async (p) => { dirs.add(fold(p)); }, unlink: async (p) => { files.delete(fold(p)); }, rmdir: async () => undefined,
    rename: async (from, to, overwrite) => {
      if (!overwrite && files.has(fold(to))) throw new SftpError('exists');
      const f = files.get(fold(from));
      if (!f) throw new SftpError('notFound');
      files.delete(fold(from));
      files.set(fold(to), { name: to, data: f.data });
    },
    setMtime: async () => undefined,
    openRead: async () => { throw new SftpError('unsupported'); },
    openWrite: async (p) => {
      const key = fold(p.replace(/\.unimux-part$/, ''));
      open++; maxOpen = Math.max(maxOpen, open);
      openByKey.set(key, (openByKey.get(key) ?? 0) + 1);
      maxSameKey = Math.max(maxSameKey, openByKey.get(key)!);
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk: Buffer, _e, cb) { chunks.push(chunk); if (opts.slowWriteMs) setTimeout(cb, opts.slowWriteMs); else cb(); },
        final(cb) { files.set(fold(p), { name: p, data: Buffer.concat(chunks) }); open--; openByKey.set(key, openByKey.get(key)! - 1); cb(); },
        destroy(err, cb) { cb(err); },
      });
    },
  };
  return { side, files, maxOpen: () => maxOpen, maxSameKey: () => maxSameKey };
}

const quiet = { changed: () => undefined, removed: () => undefined, activeChanged: () => undefined };

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

describe('TransferQueue: links, special entries, cancel of the walk', () => {
  it('follows a link inside a folder only when it stays inside the picked folder; folders links and fifos are failed items', async () => {
    const src = fakeSource({
      '/srv': ['in.txt', 'out', 'linkdir', 'fifo', 'real.txt'], '/srv/real.txt': 'real',
      '/srv/in.txt': { link: '/srv/real.txt' }, '/srv/out': { link: '/home/alice/.ssh/id_ed25519' }, '/home/alice/.ssh/id_ed25519': 'SECRET',
      '/srv/linkdir': { link: '/srv' }, '/srv/fifo': { other: true },
    });
    const m = memSide();
    const q = new TransferQueue('sftp:x', () => ({ src, dst: m.side }), quiet);
    const { batchId } = await q.enqueue({ direction: 'download', sources: ['/srv'], targetDir: '/t' });
    const byName = Object.fromEntries((await settle(q, batchId)).map((i) => [i.name, i]));
    expect(byName['srv/in.txt']).toMatchObject({ state: 'done' });
    expect(byName['srv/out']).toMatchObject({ state: 'failed', error: 'linkOutside' });
    expect(byName['srv/linkdir']).toMatchObject({ state: 'failed', error: 'linkFolder' });
    expect(byName['srv/fifo']).toMatchObject({ state: 'failed', error: 'unsupported' });
    expect([...m.files.values()].some((f) => f.data.toString() === 'SECRET')).toBe(false);
    expect(m.files.get('/t/srv/in.txt')?.data.toString()).toBe('real');
    // A link the user picked as the source itself is followed.
    const top = await q.enqueue({ direction: 'download', sources: ['/srv/out'], targetDir: '/t' });
    expect((await settle(q, top.batchId))[0]).toMatchObject({ state: 'done' });
  });

  it('a level deeper than 64 is a failed item, not silently left out', async () => {
    const tree: Record<string, Node> = {};
    let p = '/d';
    for (let i = 0; i < 70; i++) { tree[p] = ['x']; p = `${p}/x`; }
    tree[p] = 'leaf';
    const m = memSide();
    const q = new TransferQueue('sftp:x', () => ({ src: fakeSource(tree), dst: m.side }), quiet);
    const { batchId } = await q.enqueue({ direction: 'download', sources: ['/d'], targetDir: '/t' });
    const items = await settle(q, batchId);
    expect(items.map((i) => [i.state, i.error])).toEqual([['failed', 'tooMany']]);
  });

  it('cancel({ batchId }) stops the walk of an enqueue that has not answered yet', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const src = fakeSource({ '/big': ['a'], '/big/a': 'A' }, { slowReaddir: () => gate });
    const q = new TransferQueue('sftp:x', () => ({ src, dst: memSide().side }), quiet);
    const batchId = '00000000-0000-4000-8000-0000000000b1';
    const pending = q.enqueue({ direction: 'download', sources: ['/big'], targetDir: '/t', batchId });
    await new Promise((r) => setTimeout(r, 10));
    expect(q.cancel({ batchId })).toBe(true);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(q.items()).toEqual([]);
  });
});

describe('TransferQueue: one writer per target', () => {
  it('the same file enqueued twice never shares a part file: the second waits and meets the first as a conflict', async () => {
    const src = fakeSource({ '/s': ['f.bin'], '/s/f.bin': 'x'.repeat(2000) });
    const m = memSide({ slowWriteMs: 2 });
    const q = new TransferQueue('sftp:x', () => ({ src, dst: m.side }), quiet);
    const a = await q.enqueue({ direction: 'download', sources: ['/s/f.bin'], targetDir: '/t' });
    const b = await q.enqueue({ direction: 'download', sources: ['/s/f.bin'], targetDir: '/t', policy: 'keepBoth' });
    await settle(q, a.batchId);
    await settle(q, b.batchId);
    expect(m.maxSameKey()).toBe(1);
    expect([...m.files.keys()].sort()).toEqual(['/t/f (1).bin', '/t/f.bin']);
    for (const f of m.files.values()) expect(f.data.length).toBe(2000);
  });

  it('"A.txt" and "a.txt" downloaded together to a case-insensitive disk are one target (serialized, then keep both)', async () => {
    const src = fakeSource({ '/s': ['A.txt', 'a.txt'], '/s/A.txt': 'upper', '/s/a.txt': 'lower' });
    const m = memSide({ caseInsensitive: true, slowWriteMs: 2 });
    const q = new TransferQueue('sftp:x', () => ({ src, dst: m.side }), quiet);
    const { batchId } = await q.enqueue({ direction: 'download', sources: ['/s/A.txt', '/s/a.txt'], targetDir: '/t', policy: 'keepBoth' });
    const items = await settle(q, batchId);
    expect(items.map((i) => i.state)).toEqual(['done', 'done']);
    expect(m.maxSameKey()).toBe(1);
    expect([...m.files.values()].map((f) => [posixBasename(f.name), f.data.toString()]).sort()).toEqual([['A.txt', 'upper'], ['a (1).txt', 'lower']]);
  });

  it('a 50,000-file batch completes with O(1) bookkeeping per item', async () => {
    const tree: Record<string, Node> = { '/many': [] };
    const names = Array.from({ length: 50_000 }, (_, i) => `f${i}`);
    tree['/many'] = names;
    for (const n of names) tree[`/many/${n}`] = 'x';
    const m = memSide();
    let activeChanges = 0;
    const q = new TransferQueue('sftp:x', () => ({ src: fakeSource(tree), dst: m.side }), { ...quiet, activeChanged: () => { activeChanges++; } });
    const t0 = Date.now();
    const { batchId } = await q.enqueue({ direction: 'download', sources: ['/many'], targetDir: '/t' });
    for (let i = 0; i < 24000 && q.active(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(q.active()).toBe(false);
    expect(q.items().filter((i) => i.batchId === batchId && i.state === 'done')).toHaveLength(50_000);
    expect(m.maxOpen()).toBeLessThanOrEqual(3);
    expect(activeChanges).toBe(2);
    // Linear work takes seconds here; the old quadratic scans took minutes.
    expect(Date.now() - t0).toBeLessThan(90_000);
  }, 120_000);
});

describe('LocalSide paths', () => {
  it('"..cache" inside the folder is inside; ".." and "../x" are not', () => {
    const side = new LocalSide(false, false);
    expect(side.contains(dir, join(dir, '..cache'))).toBe(true);
    expect(side.contains(dir, join(dir, '..cache', 'x'))).toBe(true);
    expect(side.contains(dir, join(dir, '..'))).toBe(false);
    expect(side.contains(dir, join(dir, '..', 'x'))).toBe(false);
    expect(new LocalSide(true, false).contains(dir.toUpperCase(), join(dir, 'a'))).toBe(true);
  });

  it('the in-flight registry folds case on a case-insensitive side only', () => {
    expect(new LocalSide(true, false).inflight.key(join(dir, 'A.txt'))).toBe(new LocalSide(true, false).inflight.key(join(dir, 'a.txt')));
    expect(new LocalSide(false, false).inflight.key(join(dir, 'A.txt'))).not.toBe(new LocalSide(false, false).inflight.key(join(dir, 'a.txt')));
  });

  it('a rename never replaces a different file; a case-only rename of the same file works', async () => {
    const side = new LocalSide();
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    await expect(side.rename(join(dir, 'a.txt'), join(dir, 'b.txt'), false)).rejects.toMatchObject({ code: 'exists' });
    expect(await sameLocalFile(join(dir, 'a.txt'), join(dir, 'b.txt'))).toBe(false);
    await side.rename(join(dir, 'a.txt'), join(dir, 'A.txt'), false);
    expect(readdirSync(dir).sort()).toEqual(['A.txt', 'b.txt']);
  });
});
