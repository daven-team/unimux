// The transfer queue of one session (or of the local copies): folders expand into one item per file, at most
// SFTP_LIMITS.concurrentFiles move at once, every file is written as "<name>.unimux-part" and renamed into place, an existing
// target pauses the item in state "conflict" until the renderer answers. Two jobs never write one target at once (the side's
// TargetRegistry). Bookkeeping is O(1) per item (a counter of unfinished items and a FIFO of queued ones), so a 50,000-file
// batch does not stall the host. Pure module: the two FileSides are injected.
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
  /** Waits in the side's registry for another job's target (pump() must not pick it twice). */
  blocked: boolean;
}

/** Sides throw SftpError; a raw error can only come from a Node stream (the local disk). */
const errorOf = (error: unknown) => (error instanceof SftpError ? error.code : localError(error));

type FileSpec = { source: string; target: string; name: string; size: number; mtime: number; error?: TransferItem['error'] };

export class TransferQueue {
  private jobs = new Map<string, Job>();
  /** Queued job ids in order; `head` is the next one (the array is compacted now and then). */
  private fifo: string[] = [];
  private head = 0;
  /** Jobs whose target became free again: they go before the FIFO. */
  private ready: string[] = [];
  private unfinished = 0;
  private running = 0;
  private slotWaiters: Array<() => void> = [];
  private walking = new Map<string, Batch>();
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
  active(): boolean { return this.unfinished > 0; }

  /** Expands the sources (folders recursively) into one item per file and starts the queue. */
  async enqueue(req: TransferRequest): Promise<{ batchId: string }> {
    if (this.disposed) throw new SftpError('noSession');
    const sides = this.sides(req.direction);
    if (!sides) throw new SftpError('notConnected');
    const id = req.batchId && !this.walking.has(req.batchId) && ![...this.jobs.values()].some((j) => j.batch.id === req.batchId) ? req.batchId : randomUUID();
    const batch: Batch = { id, direction: req.direction, src: sides.src, dst: sides.dst, policy: req.policy, root: req.targetDir, dirs: new Map(), cancelled: false };
    this.walking.set(id, batch);
    try {
      const { files, emptyDirs } = await this.expand(batch, req);
      if (batch.cancelled || this.disposed) throw new SftpError('cancelled');
      for (const f of files) {
        const job: Job = {
          item: {
            id: randomUUID(), batchId: batch.id, sessionId: this.sessionId, direction: req.direction, source: f.source, target: f.target, name: f.name,
            bytesDone: 0, bytesTotal: f.size, speed: 0, state: 'queued',
          },
          batch, plannedTarget: f.target, abort: null, answer: null, samples: [], resuming: false, blocked: false,
        };
        this.jobs.set(job.item.id, job);
        if (f.error) {
          job.item = { ...job.item, state: 'failed', error: f.error, endedAt: this.now() };
        } else {
          this.unfinished++;
          this.fifo.push(job.item.id);
        }
        this.events.changed(job.item, true);
      }
      // Empty folders are made too (best effort, they have no item of their own).
      for (const dir of emptyDirs) void this.ensureDir(batch, dir).catch(() => undefined);
      this.pump();
      return { batchId: batch.id };
    } finally {
      this.walking.delete(id);
    }
  }

  private async expand(batch: Batch, req: TransferRequest): Promise<{ files: FileSpec[]; emptyDirs: string[] }> {
    const { src, dst } = batch;
    const files: FileSpec[] = [];
    // A name read from the source side (a server for downloads) is never trusted: one that is not a single safe segment on
    // both sides ("..", "a/b", "c:d", "NUL" on Windows) becomes a failed item and is never joined onto a path. Whatever is
    // left out (too deep, a fifo or device, a link out of the folder) shows up as a failed item too, never silently.
    const reject = (source: string, label: string, error: TransferItem['error']) => {
      files.push({ source, target: req.targetDir, name: label, size: 0, mtime: 0, error });
    };
    const emptyDirs: string[] = [];
    const walk = async (source: string, target: string, label: string, depth: number, rootReal: string | null): Promise<void> => {
      if (batch.cancelled || this.disposed) throw new SftpError('cancelled');
      if (depth > 64) { reject(source, label, 'tooMany'); return; }
      const meta = await src.lstat(source);
      if (!meta) { if (depth === 0) throw new SftpError('notFound'); reject(source, label, 'notFound'); return; }
      let kind = meta.kind;
      let size = meta.size, mtime = meta.mtime;
      if (kind === 'symlink') {
        const real = await src.stat(source).catch(() => null);
        if (!real) { reject(source, label, 'notFound'); return; }
        if (depth > 0) {
          // Inside a folder a link is followed only when it stays inside the folder the user picked (never ~/.ssh/...).
          const resolved = await src.realpath(source).catch(() => null);
          if (!resolved || !rootReal || !src.contains(rootReal, resolved)) { reject(source, label, 'linkOutside'); return; }
          if (real.kind !== 'file') { reject(source, label, 'linkFolder'); return; }
        }
        kind = real.kind; size = real.size; mtime = real.mtime;
      }
      if (!dst.contains(batch.root, target) || target === batch.root) { reject(source, label, 'invalid'); return; }
      if (kind === 'file') {
        files.push({ source, target, name: label, size, mtime });
        if (files.length > SFTP_LIMITS.batchFiles) throw new SftpError('tooMany');
        return;
      }
      if (kind !== 'dir') { reject(source, label, 'unsupported'); return; }
      const children = await src.readdir(source);
      if (!children.length) emptyDirs.push(target);
      for (const child of children) {
        const childLabel = `${label}/${child.name}`;
        if (!src.validName(child.name) || !dst.validName(child.name)) { reject(source, childLabel, 'invalidName'); continue; }
        await walk(src.join(source, child.name), dst.join(target, child.name), childLabel, depth + 1, rootReal);
      }
    };
    for (const source of req.sources) {
      const name = src.basename(source);
      if (!name) throw new SftpError('invalid');
      if (!src.validName(name) || !dst.validName(name)) { reject(src.dirname(source), name, 'invalidName'); continue; }
      const target = dst.join(req.targetDir, name);
      // Copying a folder into itself would never end.
      if (req.direction === 'local-copy' && dst.contains(source, req.targetDir)) throw new SftpError('invalid');
      // The user picked this source: a link here is followed, and the folder it resolves to bounds every link inside it.
      const rootReal = await src.realpath(source).catch(() => null);
      await walk(source, target, name, 0, rootReal);
    }
    return { files, emptyDirs };
  }

  private update(job: Job, patch: Partial<TransferItem>, force = true): void {
    const before = job.item.state;
    job.item = { ...job.item, ...patch };
    const after = job.item.state;
    if (isFinished(before) !== isFinished(after)) this.unfinished += isFinished(after) ? -1 : 1;
    if (after === 'queued' && before !== 'queued' && !job.resuming) this.fifo.push(job.item.id);
    this.events.changed(job.item, force);
    if (force) this.checkActive();
  }

  private checkActive(): void {
    const active = this.active();
    if (active !== this.wasActive) { this.wasActive = active; this.events.activeChanged(active); }
  }

  private nextQueued(): Job | null {
    while (this.ready.length) {
      const job = this.jobs.get(this.ready.shift()!);
      if (job && job.item.state === 'queued' && !job.resuming) return job;
    }
    while (this.head < this.fifo.length) {
      const job = this.jobs.get(this.fifo[this.head++]);
      if (this.head > 1024 && this.head * 2 > this.fifo.length) { this.fifo = this.fifo.slice(this.head); this.head = 0; }
      if (job && job.item.state === 'queued' && !job.resuming && !job.blocked) return job;
    }
    return null;
  }

  private pump(): void {
    if (this.disposed) return;
    // Items that answered a conflict come first: they were started before anything still queued.
    while (this.running < this.max && this.slotWaiters.length) { this.running++; this.slotWaiters.shift()!(); }
    while (this.running < this.max) {
      const job = this.nextQueued();
      if (!job) break;
      const registry = job.batch.dst.inflight;
      if (!registry.hold(job.item.target, job.item.id)) {
        // Another job writes this target right now: this one waits and then meets it as an existing file.
        job.blocked = true;
        registry.whenFree(job.item.target, () => {
          job.blocked = false;
          if (this.jobs.get(job.item.id) !== job || job.item.state !== 'queued') return;
          this.ready.push(job.item.id);
          this.pump();
        });
        continue;
      }
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
    const owner = job.item.id;
    const abort = new AbortController();
    job.abort = abort;
    let part: string | null = null;
    let target = job.item.target;
    try {
      const srcMeta = await src.stat(job.item.source);
      if (!srcMeta) throw new SftpError('notFound');
      if (srcMeta.kind === 'dir') throw new SftpError('isADirectory');
      this.update(job, { bytesTotal: srcMeta.size }, false);
      const dir = dst.dirname(target);
      if (target === batch.root || !dst.contains(batch.root, target)) throw new SftpError('invalid');
      await this.ensureDir(batch, dir);
      if (abort.signal.aborted) throw new SftpError('cancelled');
      let overwrite = false;
      const existing = await dst.lstat(target);
      if (existing) {
        const sameFile = src === dst && dst.inflight.key(target) === dst.inflight.key(job.item.source);
        const choice = sameFile ? 'keepBoth' : await this.decide(job, existing, srcMeta);
        if (choice === 'cancelled' || abort.signal.aborted) throw new SftpError('cancelled');
        if (choice === 'skip') { this.update(job, { state: 'done', skipped: true, conflict: undefined, speed: 0, endedAt: this.now() }); return; }
        if (choice === 'overwrite') {
          if (existing.kind === 'dir') throw new SftpError('isADirectory');
          overwrite = true;
        } else {
          // A name no file and no running job uses; it is held before anything else can take it (no await in between).
          const names = (await dst.readdir(dir)).map((e) => e.name);
          let name = keepBothName(dst.basename(target), names, { caseInsensitive: dst.caseInsensitive });
          while (dst.inflight.isHeld(dst.join(dir, name))) { names.push(name); name = keepBothName(dst.basename(target), names, { caseInsensitive: dst.caseInsensitive }); }
          const next = dst.join(dir, name);
          dst.inflight.hold(next, owner);
          dst.inflight.release(target, owner);
          target = next;
        }
        this.update(job, { state: 'running', target, conflict: undefined });
      }
      // Defense in depth: whatever the names were, nothing is written outside the chosen folder.
      if (target === batch.root || !dst.contains(batch.root, target)) throw new SftpError('invalid');
      part = dst.join(dir, partName(dst.basename(target)));
      // The target is held by this job, so a part file under its name is a leftover of a crash, never another job's.
      await dst.unlink(part).catch(() => undefined);
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
      await dst.rename(part, target, overwrite);
      part = null;
      if (srcMeta.mtime) await dst.setMtime(target, srcMeta.mtime).catch(() => undefined);
      this.update(job, { state: 'done', bytesDone: done, bytesTotal: Math.max(done, job.item.bytesTotal), speed: 0, endedAt: this.now() });
    } catch (error) {
      const code = abort.signal.aborted ? 'cancelled' : errorOf(error);
      // A complete part file whose old target could not be put back is the only copy: it stays.
      const keepPart = error instanceof SftpError && error.keepPart;
      if (part && !keepPart) { const leftover = part; await dst.unlink(leftover).catch(() => undefined); }
      if (this.jobs.get(job.item.id) !== job) return; // cleared meanwhile
      const disposedError = this.disposed?.error;
      const finalError = disposedError ?? code;
      this.update(job, finalError === 'cancelled'
        ? { state: 'cancelled', speed: 0, conflict: undefined, endedAt: this.now() }
        : { state: 'failed', error: finalError, speed: 0, conflict: undefined, endedAt: this.now() });
    } finally {
      job.abort = null;
      dst.inflight.release(target, owner);
      dst.inflight.release(job.plannedTarget, owner);
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
    let any = false;
    if (target.batchId) {
      const walking = this.walking.get(target.batchId);
      if (walking) { walking.cancelled = true; any = true; }
    }
    const ids = new Set(target.itemIds ?? []);
    for (const job of this.jobs.values()) {
      if (!ids.has(job.item.id) && job.item.batchId !== target.batchId) continue;
      if (target.batchId && job.item.batchId === target.batchId) job.batch.cancelled = true;
      if (isFinished(job.item.state)) continue;
      any = true;
      if (job.item.state === 'queued' && !job.abort) { this.update(job, { state: 'cancelled', speed: 0, endedAt: this.now() }); continue; }
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
      // A retry cannot make a name safe, bring a link inside the folder or a fifo transferable.
      if (job.item.error && ['invalidName', 'invalid', 'linkOutside', 'linkFolder', 'unsupported'].includes(job.item.error)) continue;
      if (job.item.bytesTotal === 0 && job.item.target === job.batch.root) continue; // a rejected entry, not a file
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

  /**
   * The session ended: whatever is not finished ends with `error` (running files are aborted and their part files removed).
   * 'cancelled' (the user disconnected) makes them cancelled, anything else failed.
   */
  dispose(error: TransferItem['error']): void {
    if (this.disposed) return;
    this.disposed = { error };
    for (const b of this.walking.values()) b.cancelled = true;
    for (const job of this.jobs.values()) {
      job.batch.cancelled = true;
      if (isFinished(job.item.state)) continue;
      if (job.abort) { job.abort.abort(); continue; }
      job.answer = null;
      this.update(job, error === 'cancelled'
        ? { state: 'cancelled', speed: 0, conflict: undefined, endedAt: this.now() }
        : { state: 'failed', error, speed: 0, conflict: undefined, endedAt: this.now() });
    }
    this.checkActive();
  }
}
