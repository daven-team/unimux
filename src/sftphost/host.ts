// The SFTP Host (0.9.8): one ssh2 Client and SFTP channel per session, the remote operations and the transfer queues.
// Logs in with the shared SshLogin (host key and auth questions go to main's coordinator like a cell's). Independent of
// Electron (the process wrapper is index.ts) so it is tested in Node against the local test server.
import { Client } from 'ssh2';
import type { SshConnectRequest } from '../shared/ipc';
import type { SftpOp, MainToSftpHost, SftpHostToMain } from '../shared/sftpHostIpc';
import {
  LOCAL_QUEUE_ID, SFTP_LIMITS, posixContains, posixNormalize, validRemoteName, validRemotePath,
  type DeleteCount, type SftpEntry, type SftpErrorCode, type SftpPortMessage, type SftpResult, type TransferDirection, type TransferItem,
} from '../shared/sftp';
import type { SshErrorCode, SshPhase } from '../shared/ssh';
import { SshLogin } from '../sshcore/login';
import { isRecoverableAuthError, mapSshError } from '../ptyhost/sshErrors';
import { LocalSide, RemoteSide, SftpError, remoteEntry, type FileSide } from './sides';
import { TransferQueue } from './queue';
import { ItemThrottle } from './throttle';

export interface SftpHostTimers { connectMs: number; authStepMs: number; sftpMs: number; killGraceMs: number; keepaliveMs: number; keepaliveCountMax: number }
export const SFTP_TIMERS: SftpHostTimers = { connectMs: 20_000, authStepMs: 20_000, sftpMs: 20_000, killGraceMs: 2000, keepaliveMs: 15_000, keepaliveCountMax: 3 };

export interface SftpHostOutput {
  toMain(m: SftpHostToMain): void;
  /** The transfer port; false when no renderer is attached (the snapshot on attach catches up). */
  toRenderer(m: SftpPortMessage): void;
}

interface Session {
  id: string;
  client: Client;
  login: SshLogin;
  phase: SshPhase;
  timer: NodeJS.Timeout | null;
  side: RemoteSide | null;
  queue: TransferQueue;
  error: SshErrorCode | undefined;
  /** The user (or main's idle timer) disconnected: the end reads "closed", not an error. */
  disconnected: boolean;
  ended: boolean;
}

function hardClose(client: Client): void {
  try { client.destroy(); } catch { /* gone */ }
  const sock = (client as unknown as { _sock?: { destroyed?: boolean; destroy(): void } })._sock;
  try { if (sock && !sock.destroyed) sock.destroy(); } catch { /* gone */ }
}

const ok = <T>(value: T): SftpResult<T> => ({ ok: true, value });
const fail = (error: SftpErrorCode): SftpResult<never> => ({ ok: false, error });
const codeOf = (error: unknown): SftpErrorCode => (error instanceof SftpError ? error.code : 'failed');

/** Normalized delete paths without duplicates and without paths inside another selected one (counted once, removed once). */
export function deleteRoots(paths: string[]): string[] {
  const unique = [...new Set(paths.map((p) => posixNormalize(p)))].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const p of unique) if (!roots.some((r) => posixContains(r, p))) roots.push(p);
  return roots;
}

/** Runs `fn` over `items` with at most `limit` at once. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

export class SftpHost {
  private sessions = new Map<string, Session>();
  private readonly local = new LocalSide();
  private readonly localQueue: TransferQueue;
  private readonly throttle: ItemThrottle;
  private readonly timers: SftpHostTimers;

  constructor(private readonly out: SftpHostOutput, timers: Partial<SftpHostTimers> = {}, private readonly opts: { maxConcurrent?: number } = {}) {
    this.timers = { ...SFTP_TIMERS, ...timers };
    this.throttle = new ItemThrottle((items) => this.out.toRenderer({ t: 'items', items }), 1000 / SFTP_LIMITS.progressPerSecond);
    this.localQueue = this.makeQueue(LOCAL_QUEUE_ID, (direction) => (direction === 'local-copy' ? { src: this.local, dst: this.local } : null));
  }

  private makeQueue(id: string, sides: (d: TransferDirection) => { src: FileSide; dst: FileSide } | null): TransferQueue {
    return new TransferQueue(id, sides, {
      changed: (item, force) => this.throttle.push(item, force),
      removed: (ids) => { this.throttle.forget(ids); this.out.toRenderer({ t: 'removed', ids }); },
      activeChanged: (active) => this.out.toMain({ t: 'sftpQueue', id, active }),
    }, { maxConcurrent: this.opts.maxConcurrent });
  }

  /** Every item the host knows (the snapshot a newly attached renderer gets). */
  items(): TransferItem[] {
    this.throttle.flush();
    return [...this.localQueue.items(), ...[...this.sessions.values()].flatMap((s) => s.queue.items())];
  }

  has(id: string): boolean { return this.sessions.has(id); }
  queueOf(id: string): TransferQueue | undefined { return id === LOCAL_QUEUE_ID ? this.localQueue : this.sessions.get(id)?.queue; }

  async handle(m: MainToSftpHost): Promise<void> {
    switch (m.t) {
      case 'sshConnect': this.connect(m.req); break;
      case 'sshHostKeyAnswer': { const s = this.sessions.get(m.id); if (s && !s.ended) s.login.answerHostKey(m.promptId, m.accept, m.error); break; }
      case 'sshAuthAnswer': { const s = this.sessions.get(m.id); if (s && !s.ended) s.login.answerAuth(m.promptId, m.values); break; }
      case 'sftpDisconnect': await this.disconnect(m.id); break;
      case 'sftpOp': {
        let result: SftpResult<unknown>;
        try { result = await this.op(m.id, m.op); } catch (error) { result = fail(codeOf(error)); }
        this.out.toMain({ t: 'sftpResult', reqId: m.reqId, result });
        break;
      }
      case 'shutdown': await this.shutdown(); this.out.toMain({ t: 'shutdownDone' }); break;
    }
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  private live(s: Session): boolean { return this.sessions.get(s.id) === s && !s.ended; }
  private status(s: Session, phase: SshPhase, error?: SshErrorCode): void {
    s.phase = phase;
    this.out.toMain({ t: 'sshStatus', id: s.id, phase, ...(error ? { error } : {}) });
  }
  private arm(s: Session, ms: number): void { this.disarm(s); s.timer = setTimeout(() => this.fail(s, 'timeout'), ms); }
  private disarm(s: Session): void { if (s.timer) clearTimeout(s.timer); s.timer = null; }

  connect(req: SshConnectRequest): void {
    const old = this.sessions.get(req.id);
    if (old) void this.disconnect(req.id);
    const client = new Client();
    const s = { id: req.id, client, phase: 'connecting', timer: null, side: null, error: undefined, disconnected: false, ended: false } as Omit<Session, 'login' | 'queue'> as Session;
    s.queue = this.makeQueue(req.id, (direction) => {
      if (!s.side || s.phase !== 'connected') return null;
      if (direction === 'upload') return { src: this.local, dst: s.side };
      if (direction === 'download') return { src: s.side, dst: this.local };
      return null;
    });
    s.login = new SshLogin({ ...req }, this.timers, {
      live: () => this.live(s),
      arm: (ms) => this.arm(s, ms),
      disarm: () => this.disarm(s),
      phase: (phase) => this.status(s, phase),
      hostKey: (promptId, key) => this.out.toMain({ t: 'sshHostKey', id: s.id, promptId, key }),
      authPrompt: (promptId, prompt) => this.out.toMain({ t: 'sshAuthPrompt', id: s.id, promptId, ...prompt }),
      debug: (line) => console.log(`[sftp ${s.id.slice(5, 13)}] ${line}`),
    });
    this.sessions.set(req.id, s);
    this.status(s, 'connecting');
    this.arm(s, this.timers.connectMs);
    client.on('ready', () => this.onReady(s));
    client.on('error', (err) => { if (!isRecoverableAuthError(err)) this.fail(s, mapSshError(err, s.login.override)); });
    client.on('close', () => this.onClose(s));
    try { client.connect(s.login.connectConfig()); } catch (err) { this.fail(s, mapSshError(err)); }
  }

  private onReady(s: Session): void {
    if (!this.live(s)) return;
    s.login.dropSecrets();
    this.arm(s, this.timers.sftpMs);
    s.client.sftp((err, sftp) => {
      if (!this.live(s)) { try { sftp?.end(); } catch { /* gone */ } return; }
      this.disarm(s);
      if (err || !sftp) { this.fail(s, 'sftpDenied'); return; }
      s.side = new RemoteSide(sftp);
      sftp.on('close', () => { if (this.live(s)) this.fail(s, 'reset'); });
      sftp.on('error', () => { if (this.live(s)) this.fail(s, 'reset'); });
      this.status(s, 'connected');
    });
  }

  private fail(s: Session, error: SshErrorCode): void {
    if (!this.live(s)) return;
    if (!s.error && !s.disconnected) s.error = error;
    this.disarm(s);
    s.side?.kill();
    s.login.abort();
    try { s.client.end(); } catch { /* gone */ }
    setTimeout(() => { if (!s.ended && this.sessions.get(s.id) === s) { hardClose(s.client); this.onClose(s); } }, this.timers.killGraceMs);
  }

  private onClose(s: Session): void {
    if (s.ended) return;
    s.ended = true;
    this.disarm(s);
    s.side?.kill();
    s.login.abort();
    s.login.dropSecrets();
    s.queue.dispose(s.disconnected ? 'cancelled' : 'connectionLost');
    if (this.sessions.get(s.id) !== s) return;
    this.sessions.delete(s.id);
    if (s.disconnected) this.status(s, 'closed');
    else this.status(s, 'error', s.error ?? s.login.override ?? 'reset');
  }

  /** `waits`: how long aborted files may clean up and the connection may close cleanly (shorter at app shutdown). */
  async disconnect(id: string, waits: { idleMs: number; graceMs: number } = { idleMs: 1500, graceMs: this.timers.killGraceMs }): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.ended) return;
    s.disconnected = true;
    s.queue.dispose('cancelled');
    // Aborted files remove their part files over the still open connection first.
    await s.queue.whenIdle(waits.idleMs);
    if (s.ended) return;
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => { hardClose(s.client); this.onClose(s); resolve(); }, waits.graceMs);
      s.client.once('close', () => { clearTimeout(done); resolve(); });
      this.disarm(s);
      s.login.abort();
      try { s.client.end(); } catch { clearTimeout(done); hardClose(s.client); this.onClose(s); resolve(); }
    });
  }

  /** App shutdown: at most about 2 s in all (main waits SFTP_SHUTDOWN_WAIT_MS for it). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id, { idleMs: 1000, graceMs: 800 })));
    this.localQueue.dispose('cancelled');
    this.throttle.flush();
  }

  // ── operations ────────────────────────────────────────────────────────────

  private remote(id: string): RemoteSide {
    const s = this.sessions.get(id);
    if (!s || s.ended) throw new SftpError('noSession');
    if (!s.side || s.phase !== 'connected') throw new SftpError('notConnected');
    return s.side;
  }

  private async op(id: string, op: SftpOp): Promise<SftpResult<unknown>> {
    // The queue operations also work for the local copy queue.
    switch (op.op) {
      case 'enqueue': {
        const queue = this.queueOf(id);
        if (!queue) return fail('noSession');
        if (id === LOCAL_QUEUE_ID ? op.req.direction !== 'local-copy' : op.req.direction === 'local-copy') return fail('invalid');
        return ok(await queue.enqueue(op.req));
      }
      case 'cancel': { const q = this.queueOf(id); return q ? ok(q.cancel({ itemIds: op.itemIds, batchId: op.batchId })) : fail('noSession'); }
      case 'answerConflict': { const q = this.queueOf(id); return q ? ok(q.answerConflict(op.itemId, op.answer)) : fail('noSession'); }
      case 'retry': { const q = this.queueOf(id); return q ? ok(q.retry(op.itemIds)) : fail('noSession'); }
      case 'clearFinished': { const q = this.queueOf(id); return q ? ok(q.clearFinished().length) : fail('noSession'); }
      default: break;
    }
    const side = this.remote(id);
    switch (op.op) {
      case 'list': return ok(await this.list(side, op.path));
      case 'stat': {
        const path = posixNormalize(op.path);
        const meta = await side.lstat(path);
        if (!meta) return fail('notFound');
        return ok(await this.entryAt(side, path, meta.kind));
      }
      case 'realpath': return ok(await side.resolvePath(op.path));
      case 'mkdir': await side.mkdir(posixNormalize(op.path)); return ok(null);
      case 'rename': await side.rename(posixNormalize(op.from), posixNormalize(op.to), false); return ok(null);
      case 'deleteCount': return ok(await this.count(side, deleteRoots(op.paths)));
      case 'delete': {
        const roots = deleteRoots(op.paths);
        const now = await this.count(side, roots);
        if (now.files !== op.confirmed.files || now.dirs !== op.confirmed.dirs) return fail('changed');
        for (const p of roots) await this.remove(side, p);
        return ok(null);
      }
    }
  }

  private async entryAt(side: RemoteSide, path: string, kind: string): Promise<SftpEntry> {
    const parent = path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/';
    const name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    const raw = name === '/' ? undefined : (await side.readdirRaw(parent).catch(() => [])).find((e) => e.filename === name);
    const lst = await side.lstat(path);
    const entry: SftpEntry = raw ? remoteEntry(parent, raw) : { name, path, kind: lst?.kind ?? 'other', size: lst?.size ?? 0, mtime: lst?.mtime ?? 0, permissions: '' };
    if (kind === 'symlink') entry.target = await this.linkTarget(side, path);
    return entry;
  }

  private async linkTarget(side: RemoteSide, path: string): Promise<'file' | 'dir' | 'other'> {
    const real = await side.stat(path).catch(() => null);
    return real?.kind === 'file' || real?.kind === 'dir' ? real.kind : 'other';
  }

  private async list(side: RemoteSide, path: string): Promise<{ path: string; entries: SftpEntry[]; truncated: boolean }> {
    const dir = posixNormalize(path);
    if (!validRemotePath(dir)) throw new SftpError('invalid');
    const raw = await side.readdirRaw(dir);
    const truncated = raw.length > SFTP_LIMITS.listEntries;
    const entries = raw.slice(0, SFTP_LIMITS.listEntries).map((e) => remoteEntry(dir, e));
    const links = entries.filter((e) => e.kind === 'symlink');
    await eachLimited(links, 16, async (e) => { e.target = await this.linkTarget(side, e.path); });
    return { path: dir, entries, truncated };
  }

  /** What deleting `paths` removes: files (symlinks count as files, never followed) and folders, recursively. */
  private async count(side: RemoteSide, paths: string[]): Promise<DeleteCount> {
    const total: DeleteCount = { files: 0, dirs: 0 };
    let seen = 0;
    const walk = async (path: string): Promise<void> => {
      if (++seen > 1_000_000) throw new SftpError('tooMany');
      const meta = await side.lstat(path);
      if (!meta) throw new SftpError('notFound');
      if (meta.kind !== 'dir') { total.files++; return; }
      total.dirs++;
      for (const child of await side.readdir(path)) {
        // A name from the server that is not one POSIX segment ("..", "a/b") would make the walk leave the folder: refused.
        // A "\" is an ordinary character here (it never becomes a local path), so such files stay deletable.
        if (!validRemoteName(child.name)) throw new SftpError('invalidName');
        await walk(side.join(path, child.name));
      }
    };
    for (const path of paths) {
      if (path === '/' || !validRemotePath(path)) throw new SftpError('invalid');
      await walk(path);
    }
    return total;
  }

  private async remove(side: RemoteSide, path: string): Promise<void> {
    const meta = await side.lstat(path);
    if (!meta) return;
    if (meta.kind !== 'dir') { await side.unlink(path); return; }
    const children = await side.readdir(path);
    if (children.some((c) => !validRemoteName(c.name))) throw new SftpError('invalidName');
    const files = children.filter((c) => c.kind !== 'dir');
    await eachLimited(files, 8, (c) => side.unlink(side.join(path, c.name)));
    for (const c of children) if (c.kind === 'dir') await this.remove(side, side.join(path, c.name));
    await side.rmdir(path);
  }
}
