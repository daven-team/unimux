// The two ends of a transfer behind one interface: the local disk (Node fs) and a remote SFTP session (ssh2). Streams move the
// bytes; the remote ones keep several requests in flight (one request per round trip would crawl over a real link) and are
// abortable like any stream (destroy closes the remote handle).
import { createReadStream, createWriteStream } from 'fs';
import { lstat, mkdir, readdir, realpath, rename, rmdir, stat, unlink, utimes } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { Readable, Writable } from 'stream';
import type { FileEntry, SFTPWrapper, Stats as SftpStats } from 'ssh2';
import { kindFromMode, ownerFromLongname, permissionString, posixBasename, posixNormalize, safeEntryName, posixContains, posixJoin, posixParent, type EntryKind, type SftpEntry, type SftpErrorCode } from '../shared/sftp';
import { TargetRegistry } from './targets';

export interface Meta { kind: EntryKind; size: number; mtime: number; mode?: number }
export interface DirEntry extends Meta { name: string; longname?: string }

/** An error with one of the fixed codes the UI shows (raw messages never leave the SFTP host). */
export class SftpError extends Error {
  /** `keepPart`: the old target is gone and could not be put back, so the complete part file is the only copy: never delete it. */
  constructor(readonly code: SftpErrorCode, readonly keepPart = false) { super(code); }
}

export interface FileSide {
  readonly remote: boolean;
  /** Names that differ only in case are the same file (Windows and default macOS disks). */
  readonly caseInsensitive: boolean;
  /** Targets being written right now on this side (all queues that write here share it). */
  readonly inflight: TargetRegistry;
  /** Resolves symlinks (null when nothing is there). */
  realpath(path: string): Promise<string | null>;
  join(dir: string, name: string): string;
  /** A name read from a folder may be joined onto a path of this side (never "..", no separators: shared safeEntryName). */
  validName(name: string): boolean;
  /** `child` is `parent` or inside it. */
  contains(parent: string, child: string): boolean;
  basename(path: string): string;
  dirname(path: string): string;
  /** Follows symlinks; null when nothing is there. */
  stat(path: string): Promise<Meta | null>;
  /** Does not follow symlinks; null when nothing is there. */
  lstat(path: string): Promise<Meta | null>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  /** A file or symlink. */
  unlink(path: string): Promise<void>;
  /** An empty folder. */
  rmdir(path: string): Promise<void>;
  /** `overwrite`: an existing target is replaced (atomically where the server can). Without it an existing target fails. */
  rename(from: string, to: string, overwrite: boolean): Promise<void>;
  setMtime(path: string, mtime: number): Promise<void>;
  openRead(path: string): Promise<{ stream: Readable; size: number }>;
  openWrite(path: string): Promise<Writable>;
}

// ── errors ──────────────────────────────────────────────────────────────────

const SFTP_STATUS = { NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, OP_UNSUPPORTED: 8 };

export function localError(error: unknown): SftpErrorCode {
  if (error instanceof SftpError) return error.code;
  switch ((error as { code?: unknown } | null)?.code) {
    case 'ENOENT': return 'notFound';
    case 'EEXIST': return 'exists';
    case 'EACCES': case 'EPERM': case 'EBUSY': return 'permission';
    case 'ENOTEMPTY': return 'notEmpty';
    case 'ENOTDIR': return 'notADirectory';
    case 'EISDIR': return 'isADirectory';
    case 'ENOSPC': case 'EDQUOT': return 'noSpace';
    case 'ABORT_ERR': return 'cancelled';
    default: return 'failed';
  }
}

export function remoteError(error: unknown): SftpErrorCode {
  if (error instanceof SftpError) return error.code;
  const e = (error ?? {}) as { code?: unknown; name?: unknown };
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'cancelled';
  switch (e.code) {
    case SFTP_STATUS.NO_SUCH_FILE: return 'notFound';
    case SFTP_STATUS.PERMISSION_DENIED: return 'permission';
    case SFTP_STATUS.OP_UNSUPPORTED: return 'unsupported';
    case SFTP_STATUS.FAILURE: return 'failed';
    default: return typeof e.code === 'number' ? 'failed' : 'connectionLost';
  }
}

const isNotFound = (code: SftpErrorCode) => code === 'notFound' || code === 'notADirectory';

// ── local ───────────────────────────────────────────────────────────────────

function localMeta(st: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number; mode: number }): Meta {
  const kind: EntryKind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  return { kind, size: kind === 'file' ? st.size : 0, mtime: Math.round(st.mtimeMs), mode: st.mode };
}

/** `a` and `b` name the same file (a case-only rename on a case-insensitive disk); on a case-sensitive one they differ. */
export async function sameLocalFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([lstat(a, { bigint: true }), lstat(b, { bigint: true })]);
    return x.dev === y.dev && x.ino === y.ino && x.ino !== 0n;
  } catch { return false; }
}

const wrapLocal = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (error) { throw new SftpError(localError(error)); }
};

export class LocalSide implements FileSide {
  readonly remote = false;
  readonly inflight: TargetRegistry;
  constructor(readonly caseInsensitive = process.platform === 'win32' || process.platform === 'darwin', private readonly windowsNames = process.platform === 'win32') {
    this.inflight = new TargetRegistry((p) => { const r = resolve(p); return caseInsensitive ? r.toLowerCase() : r; });
  }
  async realpath(path: string): Promise<string | null> { try { return await realpath(path); } catch { return null; } }
  validName(name: string): boolean { return safeEntryName(name, { windows: this.windowsNames }); }
  join(dir: string, name: string): string { return join(dir, name); }
  contains(parent: string, child: string): boolean {
    const fold = (p: string) => { const r = resolve(p); return this.caseInsensitive ? r.toLowerCase() : r; };
    const rel = relative(fold(parent), fold(child));
    // "..cache" inside the folder is fine; only ".." itself or "../..." leaves it.
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  }
  basename(path: string): string { return basename(path); }
  dirname(path: string): string { return dirname(path); }
  async stat(path: string): Promise<Meta | null> {
    try { return localMeta(await stat(path)); } catch (error) { if (isNotFound(localError(error))) return null; throw new SftpError(localError(error)); }
  }
  async lstat(path: string): Promise<Meta | null> {
    try { return localMeta(await lstat(path)); } catch (error) { if (isNotFound(localError(error))) return null; throw new SftpError(localError(error)); }
  }
  readdir(path: string): Promise<DirEntry[]> {
    return wrapLocal(async () => {
      const names = await readdir(path);
      const out: DirEntry[] = [];
      for (const name of names) {
        try { out.push({ name, ...localMeta(await lstat(join(path, name))) }); } catch { /* vanished or unreadable: skipped */ }
      }
      return out;
    });
  }
  mkdir(path: string): Promise<void> { return wrapLocal(() => mkdir(path)); }
  unlink(path: string): Promise<void> { return wrapLocal(() => unlink(path)); }
  rmdir(path: string): Promise<void> { return wrapLocal(() => rmdir(path)); }
  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    return wrapLocal(async () => {
      if (!overwrite && await this.lstat(to) && !(await sameLocalFile(from, to))) throw new SftpError('exists');
      await rename(from, to);
    });
  }
  setMtime(path: string, mtime: number): Promise<void> { return wrapLocal(() => utimes(path, new Date(mtime), new Date(mtime))); }
  async openRead(path: string): Promise<{ stream: Readable; size: number }> {
    const meta = await this.stat(path);
    if (!meta) throw new SftpError('notFound');
    if (meta.kind === 'dir') throw new SftpError('isADirectory');
    const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
    await new Promise<void>((resolve, reject) => { stream.once('open', () => resolve()); stream.once('error', (e) => reject(new SftpError(localError(e)))); });
    return { stream, size: meta.size };
  }
  async openWrite(path: string): Promise<Writable> {
    const stream = createWriteStream(path, { flags: 'w' });
    await new Promise<void>((resolve, reject) => { stream.once('open', () => resolve()); stream.once('error', (e) => reject(new SftpError(localError(e)))); });
    return stream;
  }
}

// ── remote ──────────────────────────────────────────────────────────────────

const channelOpen = (sftp: SFTPWrapper) => (sftp as unknown as { outgoing?: { state?: string } }).outgoing?.state === 'open';

type Done<T> = (err: Error | undefined | null, value?: T) => void;

/**
 * Every SFTP request of one session. ssh2 accepts requests on a channel whose socket died and never answers them, so the
 * session fails them itself: kill() rejects whatever is pending and everything after it, and a lost connection never
 * hangs a transfer.
 */
export class RemoteRequests {
  private dead = false;
  private pending = new Set<(e: SftpError) => void>();
  constructor(readonly sftp: SFTPWrapper) {}

  get alive(): boolean { return !this.dead && channelOpen(this.sftp); }

  call<T>(fn: (cb: Done<T>) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.alive) { reject(new SftpError('connectionLost')); return; }
      let settled = false;
      const failNow = (e: SftpError) => { if (settled) return; settled = true; this.pending.delete(failNow); reject(e); };
      this.pending.add(failNow);
      try {
        fn((err, value) => {
          if (settled) return;
          settled = true;
          this.pending.delete(failNow);
          if (err) reject(new SftpError(remoteError(err))); else resolve(value as T);
        });
      } catch (error) { failNow(new SftpError(remoteError(error))); }
    });
  }

  kill(): void {
    this.dead = true;
    for (const f of [...this.pending]) f(new SftpError('connectionLost'));
  }
}

function remoteMeta(attrs: Partial<SftpStats> | undefined): Meta {
  const mode = typeof attrs?.mode === 'number' ? attrs.mode : undefined;
  const kind = kindFromMode(mode);
  return { kind, size: kind === 'file' && typeof attrs?.size === 'number' ? attrs.size : 0, mtime: typeof attrs?.mtime === 'number' ? attrs.mtime * 1000 : 0, mode };
}

/** Requests kept in flight per remote stream (32 KB each). */
const DEPTH = 16;
const CHUNK = 32 * 1024;

/** Reads a remote file with up to DEPTH requests in flight, pushing the chunks in order. */
class RemoteReadStream extends Readable {
  private next = 0;
  private inflight: Array<{ data: Promise<Buffer>; length: number }> = [];
  private pumping = false;
  private eof = false;
  constructor(private readonly rq: RemoteRequests, private readonly handle: Buffer, private readonly size: number) { super({ highWaterMark: DEPTH * CHUNK }); }

  /** One chunk; a short answer is read on until the chunk is full or the file ends. */
  private async readAt(position: number, length: number): Promise<Buffer> {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = await this.rq.call<number>((cb) => this.rq.sftp.read(this.handle, buf, got, length - got, position + got, (err, bytesRead) => cb(err, bytesRead)));
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  }

  private fill(): void {
    while (!this.eof && this.inflight.length < DEPTH && this.next < this.size) {
      const length = Math.min(CHUNK, this.size - this.next);
      const data = this.readAt(this.next, length);
      data.catch(() => undefined); // handled in pump, in order
      this.inflight.push({ data, length });
      this.next += length;
    }
  }

  override _read(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        if (this.destroyed) return;
        this.fill();
        const head = this.inflight.shift();
        if (!head) { this.push(null); return; }
        const buf = await head.data;
        if (this.destroyed) return;
        // The file got shorter while it was read: what was read is the whole file.
        const short = buf.length < head.length;
        if (short) { this.eof = true; this.inflight = []; }
        const more = buf.length ? this.push(buf) : true;
        if (short) { this.push(null); return; }
        if (!more) return;
      }
    } catch (error) {
      this.destroy(error as Error);
    } finally {
      this.pumping = false;
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inflight = [];
    this.rq.call<void>((cb) => this.rq.sftp.close(this.handle, cb)).then(() => callback(error), () => callback(error));
  }
}

/** Writes a remote file at increasing offsets with up to DEPTH writes in flight; the handle is closed on finish. */
class RemoteWriteStream extends Writable {
  private position = 0;
  private inflight = 0;
  private failed: Error | null = null;
  private waiting: (() => void) | null = null;
  private handleClosed = false;
  constructor(private readonly rq: RemoteRequests, private readonly handle: Buffer) { super({ highWaterMark: DEPTH * CHUNK }); }

  private settle(): void { const w = this.waiting; this.waiting = null; w?.(); }

  override _write(chunk: Buffer, _enc: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.failed) { callback(this.failed); return; }
    const position = this.position;
    this.position += chunk.length;
    this.inflight++;
    this.rq.call<void>((cb) => this.rq.sftp.write(this.handle, chunk, 0, chunk.length, position, (err) => cb(err))).then(
      () => { this.inflight--; this.settle(); },
      (err: Error) => { this.inflight--; if (!this.failed) this.failed = err; this.settle(); },
    );
    if (this.inflight < DEPTH) { callback(); return; }
    this.waiting = () => callback(this.failed);
  }

  override _final(callback: (error?: Error | null) => void): void {
    const done = () => {
      if (this.failed) { callback(this.failed); return; }
      this.handleClosed = true;
      this.rq.call<void>((cb) => this.rq.sftp.close(this.handle, cb)).then(() => callback(null), (err: Error) => callback(err));
    };
    const wait = () => { if (this.inflight === 0) done(); else this.waiting = wait; };
    wait();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.handleClosed) { callback(error); return; }
    this.handleClosed = true;
    this.rq.call<void>((cb) => this.rq.sftp.close(this.handle, cb)).then(() => callback(error), () => callback(error));
  }
}

export class RemoteSide implements FileSide {
  readonly remote = true;
  readonly caseInsensitive = false;
  readonly rq: RemoteRequests;
  readonly inflight = new TargetRegistry((p) => posixNormalize(p));
  constructor(readonly sftp: SFTPWrapper) { this.rq = new RemoteRequests(sftp); }
  async realpath(path: string): Promise<string | null> {
    try { return await this.rq.call<string>((cb) => this.sftp.realpath(path, cb)); } catch (error) { if (isNotFound(remoteError(error))) return null; throw error; }
  }
  /** The realpath of the remote pane (an error when it does not exist). */
  resolvePath(path: string): Promise<string> { return this.rq.call<string>((cb) => this.sftp.realpath(path, cb)); }

  /** The session ended: pending requests fail with connectionLost, later ones at once. */
  kill(): void { this.rq.kill(); }

  get posixRename(): boolean {
    return (this.sftp as unknown as { _extensions?: Record<string, string> })._extensions?.['posix-rename@openssh.com'] === '1';
  }

  validName(name: string): boolean { return safeEntryName(name); }
  join(dir: string, name: string): string { return posixJoin(dir, name); }
  contains(parent: string, child: string): boolean { return posixContains(parent, child); }
  basename(path: string): string { return posixBasename(path); }
  dirname(path: string): string { return posixParent(path); }

  async stat(path: string): Promise<Meta | null> {
    try { return remoteMeta(await this.rq.call<SftpStats>((cb) => this.sftp.stat(path, cb))); } catch (error) { if (isNotFound(remoteError(error))) return null; throw error; }
  }
  async lstat(path: string): Promise<Meta | null> {
    try { return remoteMeta(await this.rq.call<SftpStats>((cb) => this.sftp.lstat(path, cb))); } catch (error) { if (isNotFound(remoteError(error))) return null; throw error; }
  }
  async readdir(path: string): Promise<DirEntry[]> {
    return (await this.readdirRaw(path)).map((e) => ({ name: e.filename, longname: e.longname, ...remoteMeta(e.attrs) }));
  }
  /** Raw entries with owner and permissions (the listing of the remote pane). */
  async readdirRaw(path: string): Promise<FileEntry[]> {
    return (await this.rq.call<FileEntry[]>((cb) => this.sftp.readdir(path, cb))).filter((e) => e.filename !== '.' && e.filename !== '..');
  }
  async mkdir(path: string): Promise<void> {
    try { await this.rq.call<void>((cb) => this.sftp.mkdir(path, cb)); } catch (error) {
      // SFTP v3 answers a generic failure for an existing name: tell it apart.
      if (await this.lstat(path).catch(() => null)) throw new SftpError('exists');
      throw error;
    }
  }
  unlink(path: string): Promise<void> { return this.rq.call<void>((cb) => this.sftp.unlink(path, cb)); }
  async rmdir(path: string): Promise<void> {
    try { await this.rq.call<void>((cb) => this.sftp.rmdir(path, cb)); } catch (error) {
      if (remoteError(error) === 'failed' && (await this.readdir(path).catch(() => [])).length) throw new SftpError('notEmpty');
      throw error;
    }
  }
  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    if (overwrite && this.posixRename) { await this.rq.call<void>((cb) => this.sftp.ext_openssh_rename(from, to, cb)); return; }
    const there = await this.lstat(to);
    if (there && !overwrite) throw new SftpError('exists');
    if (!there) { await this.rq.call<void>((cb) => this.sftp.rename(from, to, cb)); return; }
    if (there.kind === 'dir') throw new SftpError('isADirectory');
    // Without posix-rename (plain SFTP v3 rename never overwrites): the old file moves aside first, the new one comes in, and
    // only then the aside copy goes. A failure puts the old file back; nothing is deleted while it is the only copy.
    let aside = `${to}.unimux-old`;
    for (let n = 1; await this.lstat(aside); n++) aside = `${to}.unimux-old${n}`;
    await this.rq.call<void>((cb) => this.sftp.rename(to, aside, cb));
    try {
      await this.rq.call<void>((cb) => this.sftp.rename(from, to, cb));
    } catch (error) {
      const code = remoteError(error);
      try { await this.rq.call<void>((cb) => this.sftp.rename(aside, to, cb)); } catch { throw new SftpError(code, true); }
      throw new SftpError(code);
    }
    await this.unlink(aside).catch(() => undefined);
  }
  async setMtime(path: string, mtime: number): Promise<void> {
    const seconds = Math.floor(mtime / 1000);
    await this.rq.call<void>((cb) => this.sftp.setstat(path, { atime: seconds, mtime: seconds }, cb));
  }
  async openRead(path: string): Promise<{ stream: Readable; size: number }> {
    const handle = await this.rq.call<Buffer>((cb) => this.sftp.open(path, 'r', cb));
    let size: number;
    try { size = remoteMeta(await this.rq.call<SftpStats>((cb) => this.sftp.fstat(handle, cb))).size; } catch {
      try { size = (await this.stat(path))?.size ?? 0; } catch (error) { void this.rq.call<void>((cb) => this.sftp.close(handle, cb)).catch(() => undefined); throw error; }
    }
    return { stream: new RemoteReadStream(this.rq, handle, size), size };
  }
  async openWrite(path: string): Promise<Writable> {
    const handle = await this.rq.call<Buffer>((cb) => this.sftp.open(path, 'w', cb));
    return new RemoteWriteStream(this.rq, handle);
  }
}

/** One remote listing entry for the view. */
export function remoteEntry(dir: string, e: FileEntry): SftpEntry {
  const meta = remoteMeta(e.attrs);
  const entry: SftpEntry = { name: e.filename, path: posixJoin(dir, e.filename), kind: meta.kind, size: meta.size, mtime: meta.mtime, permissions: permissionString(meta.mode), ...ownerFromLongname(e.longname) };
  // A name that is not one safe path segment never reads as a normal entry (its joined path would point elsewhere).
  if (!safeEntryName(e.filename)) { entry.unsafeName = true; entry.kind = 'other'; entry.path = ''; }
  return entry;
}
