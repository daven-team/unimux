// The SFTP Host (0.9.8): one ssh2 Client and SFTP channel per session, the remote operations and the transfer queues.
// Logs in with the shared SshLogin (host key and auth questions go to main's coordinator like a cell's). Independent of
// Electron (the process wrapper is index.ts) so it is tested in Node against the local test server.
import { randomUUID } from 'crypto';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import type { SshConnectRequest } from '../shared/ipc';
import type { SftpOp, MainToSftpHost, SftpHostToMain } from '../shared/sftpHostIpc';
import {
  CHMOD_ERRORS_MAX, LOCAL_QUEUE_ID, SFTP_LIMITS, applyMode, isLocalDirection, posixContains, posixNormalize, validRemoteName, validRemotePath,
  type ChmodCount, type ChmodRequest, type ChmodResult, type DeleteCount, type SftpEntry, type SftpErrorCode, type SftpPortMessage, type SftpResult, type TransferDirection, type TransferItem,
} from '../shared/sftp';
import type { SshErrorCode, SshPhase } from '../shared/ssh';
import { SshLogin } from '../sshcore/login';
import { isRecoverableAuthError, mapSshError } from '../ptyhost/sshErrors';
import { LocalSide, RemoteSide, SftpError, remoteEntry, type FileSide } from './sides';
import { TransferQueue } from './queue';
import { readForEditor, statForEditor, writeFromEditor } from './editFile';
import { ItemThrottle } from './throttle';
import { sftpOverStream } from './execSftp';
import { classifySudo, markerCount, passwordCommand, SUDO_ENV, sudoCommands, sudoError, validSudoPassword, type SudoOutcome } from './sudo';

/** `sudoPromptGraceMs`: how long a `sudo -S` run waits for sudo's password prompt before it assumes sudo will not ask. */
export interface SftpHostTimers { connectMs: number; authStepMs: number; sftpMs: number; killGraceMs: number; keepaliveMs: number; keepaliveCountMax: number; sudoPromptGraceMs: number }
export const SFTP_TIMERS: SftpHostTimers = { connectMs: 20_000, authStepMs: 20_000, sftpMs: 20_000, killGraceMs: 2000, keepaliveMs: 15_000, keepaliveCountMax: 3, sudoPromptGraceMs: 3000 };

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
  /** 0.9.9: the SFTP server runs through sudo on an exec channel (null: the sftp subsystem). */
  sudo: { command?: string } | null;
  /** The open sudo password question. */
  sudoAsk: { promptId: string; resolve(password: string | null): void } | null;
}

/** Long operations of the view that can be stopped (a recursive permission change). */
interface RunningOp { cancelled: boolean }

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
  private ops = new Map<string, RunningOp>();
  private readonly local = new LocalSide();
  private readonly localQueue: TransferQueue;
  private readonly throttle: ItemThrottle;
  private readonly timers: SftpHostTimers;

  constructor(private readonly out: SftpHostOutput, timers: Partial<SftpHostTimers> = {}, private readonly opts: { maxConcurrent?: number } = {}) {
    this.timers = { ...SFTP_TIMERS, ...timers };
    this.throttle = new ItemThrottle((items) => this.out.toRenderer({ t: 'items', items }), 1000 / SFTP_LIMITS.progressPerSecond);
    this.localQueue = this.makeQueue(LOCAL_QUEUE_ID, (direction) => (isLocalDirection(direction) ? { src: this.local, dst: this.local } : null));
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
      case 'sshAuthAnswer': {
        const s = this.sessions.get(m.id);
        if (!s || s.ended) break;
        if (s.sudoAsk && s.sudoAsk.promptId === m.promptId) { const ask = s.sudoAsk; s.sudoAsk = null; ask.resolve(m.values?.[0] ?? null); break; }
        s.login.answerAuth(m.promptId, m.values);
        break;
      }
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
    const s = {
      id: req.id, client, phase: 'connecting', timer: null, side: null, error: undefined, disconnected: false, ended: false,
      sudo: req.sftpSudo ? { ...(req.sftpSudo.command ? { command: req.sftpSudo.command } : {}) } : null, sudoAsk: null,
    } as Omit<Session, 'login' | 'queue'> as Session;
    s.queue = this.makeQueue(req.id, (direction) => {
      if (!s.side || s.phase !== 'connected') return null;
      if (direction === 'upload') return { src: this.local, dst: s.side };
      if (direction === 'download') return { src: s.side, dst: this.local };
      if (direction === 'move') return { src: s.side, dst: s.side };
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
    if (s.sudo) { void this.startSudo(s); return; }
    this.arm(s, this.timers.sftpMs);
    s.client.sftp((err, sftp) => {
      if (!this.live(s)) { try { sftp?.end(); } catch { /* gone */ } return; }
      this.disarm(s);
      if (err || !sftp) { this.fail(s, 'sftpDenied'); return; }
      this.attach(s, sftp);
    });
  }

  private attach(s: Session, sftp: SFTPWrapper): void {
    s.side = new RemoteSide(sftp);
    sftp.on('close', () => { if (this.live(s)) this.fail(s, 'reset'); });
    sftp.on('error', () => { if (this.live(s)) this.fail(s, 'reset'); });
    this.status(s, 'connected');
  }

  // ── SFTP through sudo (0.9.9) ─────────────────────────────────────────────

  /**
   * Tries the server commands in order (the next one only when sudo says the program is not there). sudo asking for a password
   * turns `sudo -n` into `sudo -S -p ''` with the password asked in the view (up to 3 times); requiretty, a refusal or no
   * answer within the SFTP timeout end the session with a clear error instead of hanging.
   */
  private async startSudo(s: Session): Promise<void> {
    const commands = sudoCommands(s.sudo?.command);
    for (let i = 0; i < commands.length; i++) {
      const r = await this.execSftp(s, commands[i], null);
      if (!this.live(s)) { if (r.ok) try { r.sftp.end(); } catch { /* gone */ } return; }
      if (r.ok) { this.attach(s, r.sftp); return; }
      if (r.outcome === 'notFound' && i < commands.length - 1) continue;
      if (r.outcome !== 'password') { this.fail(s, sudoError(r.outcome)); return; }
      const withPassword = passwordCommand(commands[i]);
      if (!withPassword) { this.fail(s, 'sudoFailed'); return; }
      for (let attempt = 0; attempt < 3; attempt++) {
        const password = await this.askSudo(s, attempt > 0);
        if (!this.live(s)) return;
        if (password === null) { this.fail(s, 'cancelled'); return; }
        if (!validSudoPassword(password)) { this.fail(s, 'sudoPassword'); return; }
        const again = await this.execSftp(s, withPassword, password);
        if (!this.live(s)) { if (again.ok) try { again.sftp.end(); } catch { /* gone */ } return; }
        if (again.ok) { this.attach(s, again.sftp); return; }
        if (again.outcome !== 'wrongPassword') { this.fail(s, sudoError(again.outcome)); return; }
      }
      this.fail(s, 'sudoPassword');
      return;
    }
    this.fail(s, 'sudoNoServer');
  }

  /** The sudo password question (main asks the view; a cancel or the prompt timeout answers null). No timer runs meanwhile. */
  private askSudo(s: Session, retry: boolean): Promise<string | null> {
    this.disarm(s);
    return new Promise((resolve) => {
      const promptId = randomUUID();
      s.sudoAsk = { promptId, resolve };
      this.out.toMain({ t: 'sshAuthPrompt', id: s.id, promptId, kind: 'sudo', fields: [], retry });
    });
  }

  /**
   * One server command on an exec channel (LC_ALL=C where the server accepts it) with ssh2's SFTP client on it. Without a
   * password the SFTP INIT goes out at once. With one (a `sudo -S -p '<marker>'` run) the password is written only after
   * sudo printed the marker, and the INIT right behind it; a second marker is a wrong password. When no marker comes within
   * the grace time sudo is taken not to ask: the INIT goes out and the password is never written.
   */
  private execSftp(s: Session, command: string, password: string | null): Promise<{ ok: true; sftp: SFTPWrapper } | { ok: false; outcome: SudoOutcome | 'timeout' }> {
    return new Promise((resolve) => {
      let settled = false;
      let channel: ClientChannel | null = null;
      let stderr = '';
      let exitCode: number | null = null;
      let grace: NodeJS.Timeout | null = null;
      const nonInteractive = password === null;
      const timer = setTimeout(() => finish({ ok: false, outcome: classifySudo(stderr, exitCode, nonInteractive) ?? 'timeout' }), this.timers.sftpMs);
      const finish = (r: { ok: true; sftp: SFTPWrapper } | { ok: false; outcome: SudoOutcome | 'timeout' }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (!r.ok) { try { channel?.close(); } catch { /* gone */ } }
        resolve(r);
      };
      try {
        s.client.exec(command, { env: { ...SUDO_ENV } }, (err, ch) => {
          if (err || !ch) { finish({ ok: false, outcome: 'other' }); return; }
          channel = ch;
          if (settled || !this.live(s)) { try { ch.close(); } catch { /* gone */ } finish({ ok: false, outcome: 'other' }); return; }
          const remoteIdent = (s.client as unknown as { _protocol?: { _remoteIdentRaw?: string } })._protocol?._remoteIdentRaw;
          const { sftp, start } = sftpOverStream(ch, { remoteIdent });
          let started = false;
          let wrote = false;
          const startSftp = () => { if (started || settled) return; started = true; if (grace) clearTimeout(grace); start(); };
          ch.stderr.on('data', (d: Buffer) => {
            if (settled) return;
            stderr = (stderr + d.toString('utf8')).slice(-4096);
            const markers = markerCount(stderr);
            if (markers >= 1 && password === null) { finish({ ok: false, outcome: 'password' }); return; }
            if (markers >= 2) { finish({ ok: false, outcome: 'wrongPassword' }); return; }
            if (markers === 1 && password !== null && !wrote) {
              // A prompt after the INIT went out: sudo has read the INIT as (part of) the password. Never write it then.
              if (started) { finish({ ok: false, outcome: 'other' }); return; }
              wrote = true;
              ch.write(`${password}\n`);
              startSftp();
              return;
            }
            const o = classifySudo(stderr);
            // A wrong password makes sudo wait for the next line (the SFTP INIT has none): it would hang until the timeout.
            if (o === 'wrongPassword' || o === 'tty' || o === 'denied' || o === 'noSudo') finish({ ok: false, outcome: o });
          });
          ch.on('exit', (code: number | null) => { exitCode = typeof code === 'number' ? code : -1; });
          const ended = () => setTimeout(() => finish({ ok: false, outcome: classifySudo(stderr, exitCode ?? -1, nonInteractive) ?? 'other' }), 20);
          sftp.once('ready', () => finish({ ok: true, sftp }));
          sftp.once('close', ended);
          sftp.on('error', ended);
          if (password === null) startSftp();
          else grace = setTimeout(startSftp, this.timers.sudoPromptGraceMs);
        });
      } catch { finish({ ok: false, outcome: 'other' }); }
    });
  }

  private fail(s: Session, error: SshErrorCode): void {
    if (!this.live(s)) return;
    if (!s.error && !s.disconnected) s.error = error;
    this.disarm(s);
    if (s.sudoAsk) { const ask = s.sudoAsk; s.sudoAsk = null; ask.resolve(null); }
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
    // Aborted local copies remove their <name>.unimux-part files asynchronously: waited for (bounded) next to the sessions, since
    // main kills this process as soon as the shutdown is reported done.
    this.localQueue.dispose('cancelled');
    await Promise.all([
      ...[...this.sessions.keys()].map((id) => this.disconnect(id, { idleMs: 1000, graceMs: 800 })),
      this.localQueue.whenIdle(1000),
    ]);
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
        if (id === LOCAL_QUEUE_ID ? !isLocalDirection(op.req.direction) : isLocalDirection(op.req.direction)) return fail('invalid');
        return ok(await queue.enqueue(op.req));
      }
      case 'cancel': { const q = this.queueOf(id); return q ? ok(q.cancel({ itemIds: op.itemIds, batchId: op.batchId })) : fail('noSession'); }
      case 'answerConflict': { const q = this.queueOf(id); return q ? ok(q.answerConflict(op.itemId, op.answer)) : fail('noSession'); }
      case 'retry': { const q = this.queueOf(id); return q ? ok(q.retry(op.itemIds)) : fail('noSession'); }
      case 'clearFinished': { const q = this.queueOf(id); return q ? ok(q.clearFinished().length) : fail('noSession'); }
      case 'cancelOp': { const r = this.ops.get(op.opId); if (r) r.cancelled = true; return ok(!!r); }
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
      case 'chmodCount': return ok(await this.chmodCount(side, deleteRoots(op.paths), op.recursive));
      case 'chmod': return ok(await this.chmod(side, op.req, !!this.sessions.get(id)?.sudo));
      case 'readFile': return ok(await readForEditor(side, posixNormalize(op.path)));
      case 'statFile': return ok(await statForEditor(side, posixNormalize(op.path)));
      case 'writeFile': return ok(await writeFromEditor(side, posixNormalize(op.path), op.save, `editor:${id}`));
    }
  }

  // ── permissions (0.9.9) ───────────────────────────────────────────────────

  /**
   * Walks the selection (folders recursively with `recursive`), with the delete walk's rules: a name from the server that is not
   * one safe segment is never joined (an error entry), nothing outside the selected folder is visited, symlinks are never
   * followed or changed (chmod on a link changes its target, which may be anywhere). After a folder was read it is looked at
   * again: one that turned into something else meanwhile (a link swapped in) is not walked into. `postOrder`: a folder is
   * visited after its contents (a folder value that takes away the owner's r or x would lock the walk out otherwise).
   */
  private async walkModes(side: RemoteSide, roots: string[], opts: { recursive: boolean; postOrder?: boolean; cancelled?: () => boolean },
    visit: (path: string, kind: 'file' | 'dir' | 'link' | 'bad', mode: number, error?: SftpErrorCode) => Promise<boolean>): Promise<boolean> {
    let seen = 0;
    const walk = async (path: string, root: string, depth: number): Promise<boolean> => {
      if (opts.cancelled?.()) return false;
      if (++seen > 1_000_000 || depth > 64) throw new SftpError('tooMany');
      if (!posixContains(root, path)) return visit(path, 'bad', 0, 'invalid');
      const meta = await side.lstat(path);
      if (!meta) return visit(path, 'bad', 0, 'notFound');
      if (meta.kind === 'symlink') return visit(path, 'link', meta.mode ?? 0, 'linkSkipped');
      if (meta.kind !== 'dir' && meta.kind !== 'file') return visit(path, 'bad', 0, 'unsupported');
      const descend = meta.kind === 'dir' && opts.recursive;
      if (!(descend && opts.postOrder) && !(await visit(path, meta.kind, meta.mode ?? 0))) return false;
      if (!descend) return true;
      let children;
      try { children = await side.readdir(path); } catch (error) { return visit(path, 'bad', 0, error instanceof SftpError ? error.code : 'failed'); }
      // The listing came from whatever is at this path now: still the folder, or the walk stops here.
      const again = await side.lstat(path).catch(() => null);
      if (again?.kind !== 'dir') return visit(path, 'bad', 0, 'changed');
      for (const child of children) {
        if (!validRemoteName(child.name)) { if (!(await visit(`${path}/${child.name}`, 'bad', 0, 'invalidName'))) return false; continue; }
        if (!(await walk(side.join(path, child.name), root, depth + 1))) return false;
      }
      if (opts.postOrder) return visit(path, 'dir', again.mode ?? meta.mode ?? 0);
      return true;
    };
    for (const root of roots) {
      if (root === '/' && opts.recursive) throw new SftpError('invalid');
      if (!validRemotePath(root)) throw new SftpError('invalid');
      if (!(await walk(root, root, 0))) return false;
    }
    return true;
  }

  private async chmodCount(side: RemoteSide, roots: string[], recursive: boolean, cancelled?: () => boolean): Promise<ChmodCount> {
    const count: ChmodCount = { files: 0, dirs: 0, links: 0, noFollow: side.lsetstat };
    await this.walkModes(side, roots, { recursive, cancelled }, async (_p, kind) => {
      if (kind === 'file') count.files++; else if (kind === 'dir') count.dirs++; else if (kind === 'link') count.links++;
      return true;
    });
    return count;
  }

  /**
   * SETSTAT follows a symlink, so every change goes through lsetstat@openssh.com when the server offers it. Under sudo (root)
   * without it a recursive change is refused: a link swapped into the tree between the look and the change could point the
   * change at any file of the system. The folder value without the owner's r+x changes the contents first (not needed as
   * root, which reads any folder).
   */
  private async chmod(side: RemoteSide, req: ChmodRequest, sudo: boolean): Promise<ChmodResult> {
    const roots = deleteRoots(req.paths);
    const recursive = req.recursive;
    const set = req.set;
    if (!recursive && !set) throw new SftpError('invalid');
    if (recursive && sudo && !side.lsetstat) throw new SftpError('unsafeChmod');
    const run: RunningOp = { cancelled: false };
    if (req.opId) this.ops.set(req.opId, run);
    const result: ChmodResult = { changed: 0, errors: [] };
    const addError = (path: string, error: SftpErrorCode) => { if (result.errors.length < CHMOD_ERRORS_MAX) result.errors.push({ path, error }); };
    try {
      // The total for the progress: the dialog's count (it counted before asking), else counted here (cancellable).
      let total = roots.length;
      if (recursive && req.total !== undefined) total = req.total;
      else if (recursive) { const c = await this.chmodCount(side, roots, true, () => run.cancelled); total = c.files + c.dirs; }
      let done = 0;
      let lastSent = 0;
      const progress = (force = false) => {
        const now = Date.now();
        if (!req.opId || (!force && now - lastSent < 1000 / SFTP_LIMITS.progressPerSecond)) return;
        lastSent = now;
        this.out.toRenderer({ t: 'opProgress', opId: req.opId, done, total: Math.max(total, done) });
      };
      const postOrder = !!recursive && !sudo && (recursive.dirMode & 0o500) !== 0o500;
      const finished = await this.walkModes(side, roots, { recursive: !!recursive, postOrder, cancelled: () => run.cancelled }, async (path, kind, mode, error) => {
        if (run.cancelled) return false;
        if (error) { if (kind !== 'link' || !recursive) addError(path, error); return true; }
        const next = recursive ? (kind === 'dir' ? recursive.dirMode : recursive.fileMode) : applyMode(mode, set!.bits, set!.mask);
        try { await side.chmodNoFollow(path, next); result.changed++; } catch (e) { addError(path, e instanceof SftpError ? e.code : 'failed'); }
        done++;
        progress();
        return true;
      });
      if (!finished || run.cancelled) result.cancelled = true;
      progress(true);
      return result;
    } finally {
      if (req.opId) this.ops.delete(req.opId);
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
