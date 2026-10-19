// The transfer queue of one session (or of the local copies): folders expand into one item per file, at most
// SFTP_LIMITS.concurrentFiles move at once, every file is written as "<name>.unimux-part" and renamed into place, an existing
// target pauses the item in state "conflict" until the renderer answers. Pure module: the two FileSides are injected.
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform, type Writable } from 'stream';
import {
  isFinished, keepBothName, partName, SFTP_LIMITS,
  type ConflictAnswer, type ConflictChoice, type TransferDirection, type TransferItem, type TransferRequest,
} from '../shared/sftp';
import { SftpError, localError, type FileSide, type Meta } from './sides';

export interface QueueEvents {
  /** An item changed; `force`: a state change (sent at once), otherwise progress (throttled by the caller's clock). */
  changed(item: TransferItem, force: boolean): void;
  removed(ids: string[]): void;
  /** True while anything is queued, running or waiting for a conflict answer. */
  activeChanged(active: boolean): void;
}

export interface QueueOptions {
  maxConcurrent?: number;
  now?(): number;
}

interface Batch {
  id: string;
  direction: TransferDirection;
  src: FileSide;
  dst: FileSide;
  policy: ConflictChoice | undefined;
  /** The chosen target folder: no target path may leave it. */
  root: string;
  /** Folders already made sure of (path -> pending check). */
  dirs: Map<string, Promise<void>>;
  cancelled: boolean;
}

interface Job {
  item: TransferItem;
  batch: Batch;
  /** The target before a keep-both rename (a retry starts from it again). */
  plannedTarget: string;
  abort: AbortController | null;
  answer: ((a: ConflictAnswer) => void) | null;
  /** Speed samples: [time, bytesDone]. */
  samples: Array<[number, number]>;
  /** Answered a conflict and waits for a free slot (shown as queued, but pump() must not start it again). */
  resuming: boolean;
}

/** Sides throw SftpError; a raw error can only come from a Node stream (the local disk). */
const errorOf = (error: unknown) => (error instanceof SftpError ? error.code : localError(error));

export class TransferQueue {
  private jobs = new Map<string, Job>();
  private running = 0;
  private slotWaiters: Array<() => void> = [];
  private wasActive = false;
  private readonly max: number;
  private readonly now: () => number;
  private disposed: { error: TransferItem['error'] } | null = null;

  constructor(readonly sessionId: string, private readonly sides: (direction: TransferDirection) => { src: FileSide; dst: FileSide } | null, private readonly events: QueueEvents, opts: QueueOptions = {}) {
    this.max = opts.maxConcurrent ?? SFTP_LIMITS.concurrentFiles;
    this.now = opts.now ?? Date.now;
  }

  items(): TransferItem[] { return [...this.jobs.values()].map((j) => j.item); }
  runningCount(): number { return this.running; }
  active(): boolean { return [...this.jobs.values()].some((j) => !isFinished(j.item.state)); }

  /** Expands the sources (folders recursively) into one item per file and starts the queue. */
  async enqueue(req: TransferRequest): Promise<{ batchId: string }> {
    if (this.disposed) throw new SftpError('noSession');
    const sides = this.sides(req.direction);
    if (!sides) throw new SftpError('notConnected');
    const batch: Batch = { id: randomUUID(), direction: req.direction, src: sides.src, dst: sides.dst, policy: req.policy, root: req.targetDir, dirs: new Map(), cancelled: false };
    const { src, dst } = sides;
    const files: Array<{ source: string; target: string; name: string; size: number; mtime: number; error?: TransferItem['error'] }> = [];
    // A name read from the source side (a server for downloads) is never trusted: one that is not a single safe segment on
    // both sides ("..", "a/b", "c:d", "NUL" on Windows) becomes a failed item and is never joined onto a path.
    const reject = (parent: string, label: string, error: TransferItem['error']) => {
      files.push({ source: parent, target: req.targetDir, name: label, size: 0, mtime: 0, error });
    };
    const emptyDirs: string[] = [];
    const walk = async (source: string, target: string, label: string, depth: number): Promise<void> => {
      if (batch.cancelled || this.disposed) throw new SftpError('cancelled');
      if (depth > 64) return; // a link loop or an absurd tree: deeper levels are left out
      const meta = await src.lstat(source);
      if (!meta) throw new SftpError('notFound');
      let kind = meta.kind;
      let size = meta.size, mtime = meta.mtime;
      if (kind === 'symlink') {
        // A link to a file is copied as that file; a link to a folder is skipped (no loops, nothing outside the tree).
        const real = await src.stat(source).catch(() => null);
        if (!real || real.kind !== 'file') return;
        kind = 'file'; size = real.size; mtime = real.mtime;
      }
      if (!dst.contains(batch.root, target) || target === batch.root) { reject(source, label, 'invalid'); return; }
      if (kind === 'file') {
        files.push({ source, target, name: label, size, mtime });
        if (files.length > SFTP_LIMITS.batchFiles) throw new SftpError('tooMany');
        return;
      }
      if (kind !== 'dir') return;
      const children = await src.readdir(source);
      if (!children.length) emptyDirs.push(target);
      for (const child of children) {
        if (!src.validName(child.name) || !dst.validName(child.name)) { reject(source, `${label}/${child.name}`, 'invalidName'); continue; }
        await walk(src.join(source, child.name), dst.join(target, child.name), `${label}/${child.name}`, depth + 1);
      }
    };
    for (const source of req.sources) {
      const name = src.basename(source);
      if (!name) throw new SftpError('invalid');
      if (!src.validName(name) || !dst.validName(name)) { reject(src.dirname(source), name, 'invalidName'); continue; }
      const target = dst.join(req.targetDir, name);
      // Copying a folder into itself would never end.
      if (req.direction === 'local-copy' && dst.contains(source, req.targetDir)) throw new SftpError('invalid');
      await walk(source, target, name, 0);
    }
    const created = files.map((f): Job => ({
      item: {
        id: randomUUID(), batchId: batch.id, sessionId: this.sessionId, direction: req.direction, source: f.source, target: f.target, name: f.name,
        bytesDone: 0, bytesTotal: f.size, speed: 0, ...(f.error ? { state: 'failed' as const, error: f.error, endedAt: this.now() } : { state: 'queued' as const }),
      },
      batch, plannedTarget: f.target, abort: null, answer: null, samples: [], resuming: false,
    }));
    for (const job of created) { this.jobs.set(job.item.id, job); this.events.changed(job.item, true); }
    // Empty folders are made too (best effort, they have no item of their own).
    for (const dir of emptyDirs) void this.ensureDir(batch, dir).catch(() => undefined);
    this.pump();
    return { batchId: batch.id };
  }

  private update(job: Job, patch: Partial<TransferItem>, force = true): void {
    job.item = { ...job.item, ...patch };
    this.events.changed(job.item, force);
    if (force) this.checkActive();
  }

  private checkActive(): void {
    const active = this.active();
    if (active !== this.wasActive) { this.wasActive = active; this.events.activeChanged(active); }
  }

  private pump(): void {
    if (this.disposed) return;
    // Items that answered a conflict come first: they were started before anything still queued.
    while (this.running < this.max && this.slotWaiters.length) { this.running++; this.slotWaiters.shift()!(); }
    for (const job of this.jobs.values()) {
      if (this.running >= this.max) break;
      if (job.item.state !== 'queued' || job.resuming) continue;
      this.running++;
      this.update(job, { state: 'running', startedAt: this.now(), bytesDone: 0, speed: 0 });
      void this.run(job).finally(() => { this.running--; this.pump(); });
    }
    this.checkActive();
  }

  /** mkdir -p of `dir` on the target side, once per batch. */
  private ensureDir(batch: Batch, dir: string): Promise<void> {
    const known = batch.dirs.get(dir);
    if (known) return known;
    const p = (async () => {
      const meta = await batch.dst.stat(dir);
      if (meta) { if (meta.kind !== 'dir') throw new SftpError('notADirectory'); return; }
      const parent = batch.dst.dirname(dir);
      if (parent && parent !== dir) await this.ensureDir(batch, parent);
      try { await batch.dst.mkdir(dir); } catch (error) {
        const again = await batch.dst.stat(dir).catch(() => null);
        if (again?.kind !== 'dir') throw error;
      }
    })();
    batch.dirs.set(dir, p);
    p.catch(() => batch.dirs.delete(dir));
    return p;
  }

  private async decide(job: Job, existing: Meta, incoming: Meta): Promise<ConflictChoice | 'cancelled'> {
    const policy = job.batch.policy;
    if (policy) return policy;
    const signal = job.abort!.signal;
    // Paused: it does not hold one of the running slots while the user thinks.
    this.running--;
    const answer = await new Promise<ConflictAnswer | null>((resolve) => {
      job.answer = (a) => resolve(a);
      this.update(job, {
        state: 'conflict', speed: 0,
        conflict: { target: job.item.target, existing: { kind: existing.kind, size: existing.size, mtime: existing.mtime }, incoming: { size: incoming.size, mtime: incoming.mtime } },
      });
      signal.addEventListener('abort', () => resolve(null), { once: true });
      this.pump();
    });
    job.answer = null;
    if (answer?.applyToRest) {
      job.batch.policy = answer.choice;
      // Every other item of the batch that waits gets the same answer.
      for (const other of this.jobs.values()) if (other !== job && other.batch === job.batch && other.item.state === 'conflict') other.answer?.({ choice: answer.choice, applyToRest: false });
    }
    // Back into a running slot (the cap holds: it waits as queued when all slots are busy).
    if (answer && !signal.aborted && this.running >= this.max) {
      job.resuming = true;
      this.update(job, { state: 'queued', conflict: undefined, speed: 0 });
      await new Promise<void>((resolve) => {
        const granted = () => { signal.removeEventListener('abort', onAbort); resolve(); };
        const onAbort = () => { this.slotWaiters = this.slotWaiters.filter((w) => w !== granted); this.running++; resolve(); };
        this.slotWaiters.push(granted);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      job.resuming = false;
    } else this.running++;
    if (!answer || signal.aborted) return 'cancelled';
    return answer.choice;
  }

  private async run(job: Job): Promise<void> {
    const { batch } = job;
    const { src, dst } = batch;
    const abort = new AbortController();
    job.abort = abort;
    let part: string | null = null;
    try {
      const srcMeta = await src.stat(job.item.source);
      if (!srcMeta) throw new SftpError('notFound');
      if (srcMeta.kind === 'dir') throw new SftpError('isADirectory');
      this.update(job, { bytesTotal: srcMeta.size }, false);
      const dir = dst.dirname(job.item.target);
      if (job.item.target === batch.root || !dst.contains(batch.root, job.item.target)) throw new SftpError('invalid');
      await this.ensureDir(batch, dir);
      if (abort.signal.aborted) throw new SftpError('cancelled');
      let target = job.item.target;
      let overwrite = false;
      const existing = await dst.lstat(target);
      if (existing) {
        const sameFile = src === dst && (dst.caseInsensitive ? target.toLowerCase() === job.item.source.toLowerCase() : target === job.item.source);
        const choice = sameFile ? 'keepBoth' : await this.decide(job, existing, srcMeta);
        if (choice === 'cancelled' || abort.signal.aborted) throw new SftpError('cancelled');
        if (choice === 'skip') { this.update(job, { state: 'done', skipped: true, conflict: undefined, speed: 0, endedAt: this.now() }); return; }
        if (choice === 'overwrite') {
          if (existing.kind === 'dir') throw new SftpError('isADirectory');
          overwrite = true;
        } else {
          const names = (await dst.readdir(dir)).map((e) => e.name);
          target = dst.join(dir, keepBothName(dst.basename(target), names, { caseInsensitive: dst.caseInsensitive }));
        }
        this.update(job, { state: 'running', target, conflict: undefined });
      }
      // Defense in depth: whatever the names were, nothing is written outside the chosen folder.
      if (target === batch.root || !dst.contains(batch.root, target)) throw new SftpError('invalid');
      part = dst.join(dir, partName(dst.basename(target)));
      await dst.unlink(part).catch(() => undefined); // a part file left by a crash
      const reader = await src.openRead(job.item.source);
      let writer: Writable;
      try { writer = await dst.openWrite(part); } catch (error) { reader.stream.destroy(); throw error; }
      job.samples = [[this.now(), 0]];
      let done = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, callback) => {
          done += chunk.length;
          this.progress(job, done);
          callback(null, chunk);
        },
      });
      await pipeline(reader.stream, meter, writer, { signal: abort.signal });
      // A local file must be closed before it can be renamed (Windows).
      if (!(writer as { closed?: boolean }).closed) await new Promise<void>((resolve) => { writer.once('close', () => resolve()); setTimeout(resolve, 2000); });
      if (abort.signal.aborted) throw new SftpError('cancelled');
      if (overwrite) await dst.rename(part, target, true);
      else await dst.rename(part, target, false);
      part = null;
      if (srcMeta.mtime) await dst.setMtime(target, srcMeta.mtime).catch(() => undefined);
      this.update(job, { state: 'done', bytesDone: done, bytesTotal: Math.max(done, job.item.bytesTotal), speed: 0, endedAt: this.now() });
    } catch (error) {
      const code = abort.signal.aborted ? 'cancelled' : errorOf(error);
      if (part) { const leftover = part; await dst.unlink(leftover).catch(() => undefined); }
      if (this.jobs.get(job.item.id) !== job) return; // cleared meanwhile
      const disposedError = this.disposed?.error;
      this.update(job, code === 'cancelled' && !disposedError
        ? { state: 'cancelled', speed: 0, conflict: undefined, endedAt: this.now() }
        : { state: 'failed', error: disposedError ?? code, speed: 0, conflict: undefined, endedAt: this.now() });
    } finally {
      job.abort = null;
    }
  }

  private progress(job: Job, done: number): void {
    const now = this.now();
    job.samples.push([now, done]);
    while (job.samples.length > 2 && now - job.samples[0][0] > 3000) job.samples.shift();
    const [t0, b0] = job.samples[0];
    const speed = now > t0 ? Math.round(((done - b0) * 1000) / (now - t0)) : 0;
    this.update(job, { bytesDone: done, speed }, false);
  }

  answerConflict(itemId: string, answer: ConflictAnswer): boolean {
    const job = this.jobs.get(itemId);
    if (!job || job.item.state !== 'conflict' || !job.answer) return false;
    job.answer(answer);
    return true;
  }

  cancel(target: { itemIds?: string[]; batchId?: string }): boolean {
    const ids = new Set(target.itemIds ?? []);
    let any = false;
    for (const job of this.jobs.values()) {
      if (!ids.has(job.item.id) && job.item.batchId !== target.batchId) continue;
      if (target.batchId && job.item.batchId === target.batchId) job.batch.cancelled = true;
      if (isFinished(job.item.state)) continue;
      any = true;
      if (job.item.state === 'queued') { this.update(job, { state: 'cancelled', speed: 0, endedAt: this.now() }); continue; }
      job.abort?.abort();
    }
    this.checkActive();
    return any;
  }

  retry(itemIds: string[]): boolean {
    let any = false;
    for (const id of itemIds) {
      const job = this.jobs.get(id);
      if (!job || (job.item.state !== 'failed' && job.item.state !== 'cancelled')) continue;
      if (job.item.error === 'invalidName' || job.item.error === 'invalid') continue; // a retry cannot make the name safe
      any = true;
      job.batch.cancelled = false;
      this.update(job, { state: 'queued', target: job.plannedTarget, bytesDone: 0, speed: 0, error: undefined, skipped: undefined, conflict: undefined, startedAt: undefined, endedAt: undefined });
    }
    this.pump();
    return any;
  }

  clearFinished(): string[] {
    const gone = [...this.jobs.values()].filter((j) => isFinished(j.item.state)).map((j) => j.item.id);
    for (const id of gone) this.jobs.delete(id);
    if (gone.length) this.events.removed(gone);
    return gone;
  }

  /** Resolves once no file is running (or after `ms`). */
  async whenIdle(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (this.running > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  }

  /** The session ended: whatever is not finished fails with `error` (running files are aborted and their part files removed). */
  dispose(error: TransferItem['error']): void {
    if (this.disposed) return;
    this.disposed = { error };
    for (const job of this.jobs.values()) {
      job.batch.cancelled = true;
      if (isFinished(job.item.state)) continue;
      if (job.abort) { job.abort.abort(); continue; }
      job.answer = null;
      this.update(job, { state: 'failed', error, speed: 0, conflict: undefined, endedAt: this.now() });
    }
    this.checkActive();
  }
}
