// Main side of SFTP sessions (0.9.8): starts the SFTP Host on first use, logs in through the SSH coordinator (same vault,
// known hosts and prompts as a cell), keeps the session state the renderer sees, brokers operations and disconnects a session
// 2 minutes after the SFTP view closed once its queue is empty. Electron-free so it is unit tested.
import { randomUUID } from 'crypto';
import {
  LOCAL_QUEUE_ID, SFTP_LIMITS, isSftpSessionId, sftpSessionId, sftpStatusOf,
  type SftpResult, type SftpSessionState, type SftpSnapshot,
} from '../../shared/sftp';
import type { SftpHostToMain, SftpOp } from '../../shared/sftpHostIpc';
import { isLivePhase, type SshErrorCode, type SshPrompt, type SshPromptAnswer, type SshSessionState } from '../../shared/ssh';
import type { SshCoordinator } from '../ssh/coordinator';
import type { SftpHostLink } from '../sftpHostClient';

export interface SftpServiceDeps {
  coordinator: Pick<SshCoordinator, 'connectSession' | 'endSession' | 'answer' | 'sessionSnapshot' | 'onHostMessage' | 'sessionHostCrashed'>;
  host: SftpHostLink;
  hostExists(hostId: string): boolean;
  /** 0.9.9: the host runs SFTP through sudo (the session then reads `sudo` once connected). */
  hostSudo?(hostId: string): boolean;
  events: { session(s: SftpSessionState): void; prompt(sessionId: string, prompt: SshPrompt | null): void; hostCrashed(): void };
  now?(): number;
  idleMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
  defer?(fn: () => void): void;
}

interface Entry { state: SftpSessionState; initialPath?: string; queueActive: boolean; idle: unknown; resolving: boolean; sudo: boolean; plain: boolean }

export class SftpService {
  private sessions = new Map<string, Entry>();
  private viewOpen = false;
  /** The session the open SFTP view shows (0.9.9): the only one exempt from the idle disconnect while the view is open. */
  private shown: string | null = null;
  /** Hosts with unsaved editor tabs (0.9.9): their sessions are not disconnected for being idle. */
  private pinned = new Set<string>();

  constructor(private readonly deps: SftpServiceDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  /** Runs after the current IPC answer went out (a microtask would still run before it). */
  private defer(fn: () => void): void { if (this.deps.defer) this.deps.defer(fn); else setImmediate(fn); }
  private setTimer(fn: () => void, ms: number): unknown { return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms); }
  private clearTimer(t: unknown): void { if (t === undefined || t === null) return; if (this.deps.clearTimer) this.deps.clearTimer(t); else clearTimeout(t as NodeJS.Timeout); }

  /** `plain`: a session with the SSH user's own rights even when the host runs SFTP through sudo (editor tabs). */
  async connect(hostId: string, initialPath?: string, opts: { plain?: boolean } = {}): Promise<{ ok: true; sessionId: string } | { ok: false; error: SshErrorCode }> {
    if (!this.deps.hostExists(hostId)) return { ok: false, error: 'hostMissing' };
    if (!this.deps.host.ensure()) return { ok: false, error: 'sftpHostCrashed' };
    const id = sftpSessionId(randomUUID());
    // Sudo is decided here, once: the coordinator gets the flag and never reads the host setting again (a toggle in between
    // can never give a root session without `sudo` on it).
    const sudo = !opts.plain && this.deps.hostSudo?.(hostId) === true;
    const plain = opts.plain === true;
    const entry: Entry = { state: { id, hostId, state: 'connecting', phase: 'connecting', since: this.now(), ...(plain ? { plain: true as const } : {}) }, initialPath, queueActive: false, idle: null, resolving: false, sudo, plain };
    this.sessions.set(id, entry);
    // Only the view opens sessions that are not plain: while it is open, the new one is the one it shows (the renderer confirms it).
    if (!plain && this.viewOpen) this.shown = id;
    // The id goes back first; the login (which may wait minutes for a passphrase) runs after this answer was sent, so every
    // 'sftp:session' and 'sftp:prompt' event names an id the view already has.
    this.defer(() => {
      void this.deps.coordinator.connectSession({ sessionId: id, hostId, sudo }).then((r) => {
        if (r.ok || this.sessions.get(id) !== entry) return;
        // The coordinator reports most failures as an 'error' state itself; one it refused up front is reported here.
        if (entry.state.state !== 'error') {
          entry.state = { ...entry.state, state: 'error', phase: 'error', since: this.now(), error: r.error };
          this.deps.events.session(entry.state);
        }
        this.forget(id);
      });
    });
    return { ok: true, sessionId: id };
  }

  async disconnect(id: string): Promise<{ ok: boolean }> {
    const entry = this.sessions.get(id);
    if (!entry) return { ok: false };
    this.deps.host.send({ t: 'sftpDisconnect', id });
    this.deps.coordinator.endSession(id); // emits "closed" through onCoordinatorSession
    this.forget(id);
    return { ok: true };
  }

  private forget(id: string): void {
    const entry = this.sessions.get(id);
    if (entry) this.clearTimer(entry.idle);
    this.sessions.delete(id);
  }

  /** A state of a non-cell session from the coordinator (index.ts routes "sftp:" ids here). */
  onCoordinatorSession(s: SshSessionState): void {
    const entry = this.sessions.get(s.cellId);
    if (!entry) {
      // A closed or failed session main already forgot still tells the renderer.
      if (!isLivePhase(s.phase)) this.deps.events.session({ id: s.cellId, hostId: s.hostId, state: sftpStatusOf(s.phase), phase: s.phase, since: s.since, ...(s.error ? { error: s.error } : {}) });
      return;
    }
    const next: SftpSessionState = { id: s.cellId, hostId: s.hostId, state: sftpStatusOf(s.phase), phase: s.phase, since: s.since, ...(s.error ? { error: s.error } : {}), ...(entry.plain ? { plain: true as const } : {}) };
    if (s.phase === 'connected') {
      // "connected" goes out with the start folder: the asked one when it exists, else the login folder.
      if (entry.resolving || entry.state.path) return;
      entry.resolving = true;
      void this.resolveStart(entry).then((path) => {
        entry.resolving = false;
        if (this.sessions.get(s.cellId) !== entry) return; // ended meanwhile
        // Sudo never falls back to the plain subsystem: a connected session of a sudo host runs through sudo.
        entry.state = { ...next, ...(path ? { path } : {}), ...(entry.sudo ? { sudo: true as const } : {}) };
        this.deps.events.session(entry.state);
        this.scheduleIdle(entry);
      });
      return;
    }
    entry.state = next;
    this.deps.events.session(next);
    if (!isLivePhase(s.phase)) {
      const id = s.cellId;
      this.forget(id);
      // Out of the coordinator's own loop (it may be iterating its sessions right now).
      queueMicrotask(() => this.deps.coordinator.endSession(id));
    }
  }

  private async resolveStart(entry: Entry): Promise<string | undefined> {
    const tryPath = async (path: string): Promise<string | undefined> => {
      const r = await this.deps.host.request(entry.state.id, { op: 'realpath', path });
      if (!r.ok || typeof r.value !== 'string') return undefined;
      const st = await this.deps.host.request(entry.state.id, { op: 'stat', path: r.value });
      const v = st.ok ? (st.value as { kind?: string; target?: string }) : null;
      return v && (v.kind === 'dir' || v.target === 'dir') ? r.value : undefined;
    };
    return (entry.initialPath ? await tryPath(entry.initialPath) : undefined) ?? (await tryPath('.')) ?? '/';
  }

  onPrompt(sessionId: string, prompt: SshPrompt | null): void { this.deps.events.prompt(sessionId, prompt); }

  /** Messages of the SFTP Host: login ones go to the coordinator, queue activity drives the idle disconnect. */
  onHostMessage(m: SftpHostToMain): void {
    if (m.t === 'sftpQueue') {
      if (m.id === LOCAL_QUEUE_ID) return;
      const entry = this.sessions.get(m.id);
      if (!entry) return;
      entry.queueActive = m.active;
      this.scheduleIdle(entry);
      return;
    }
    // Only for sessions this service started: the SFTP Host can never move a cell's state.
    if ((m.t === 'sshStatus' || m.t === 'sshHostKey' || m.t === 'sshAuthPrompt') && isSftpSessionId(m.id) && this.sessions.has(m.id)) this.deps.coordinator.onHostMessage(m);
  }

  hostCrashed(): void {
    this.deps.coordinator.sessionHostCrashed();
    for (const id of [...this.sessions.keys()]) this.forget(id);
    this.deps.events.hostCrashed();
  }

  answer(a: SshPromptAnswer): { ok: boolean } {
    if (!this.sessions.has(a.cellId)) return { ok: false };
    return this.deps.coordinator.answer(a);
  }

  snapshot(): SftpSnapshot {
    const prompts = this.deps.coordinator.sessionSnapshot().prompts.map((p) => ({ sessionId: p.cellId, prompt: p.prompt }));
    return { sessions: [...this.sessions.values()].map((e) => e.state), prompts };
  }

  /** An operation of a session or of the local queue (id null). */
  async op(sessionId: string | null, op: SftpOp): Promise<SftpResult<unknown>> {
    const id = sessionId ?? LOCAL_QUEUE_ID;
    if (sessionId !== null && !this.sessions.has(sessionId)) return { ok: false, error: 'noSession' };
    if (sessionId === null && !this.deps.host.ensure()) return { ok: false, error: 'sftpHostCrashed' };
    return this.deps.host.request(id, op);
  }

  /** The view is on screen and shows `shownId` (null: no session): every other session may still go idle. */
  viewOpened(shownId: string | null = null): void {
    this.viewOpen = true;
    this.shown = shownId;
    for (const e of this.sessions.values()) this.scheduleIdle(e);
  }

  viewClosed(): void {
    this.viewOpen = false;
    this.shown = null;
    for (const e of this.sessions.values()) this.scheduleIdle(e);
  }

  /** The renderer reloads or crashed: the new page starts with the view hidden and only reports a change, so main counts it closed. */
  rendererGone(): void {
    if (this.viewOpen) this.viewClosed();
    // The new page reports its unsaved editor tabs again.
    if (this.pinned.size) this.pinHosts([]);
  }

  /** The hosts of editor tabs with unsaved changes: their sessions stay connected while the view is closed. */
  pinHosts(hostIds: string[]): void {
    this.pinned = new Set(hostIds);
    for (const e of this.sessions.values()) this.scheduleIdle(e);
  }

  /**
   * Whether a session stays connected without a timer: the one the open view shows, one with queue activity, and a non-sudo
   * session of a host with unsaved editor tabs (the tabs never use a sudo session, so a pin never keeps one alive unseen).
   */
  private kept(entry: Entry): boolean {
    return (this.viewOpen && this.shown === entry.state.id) || entry.queueActive || (!entry.sudo && this.pinned.has(entry.state.hostId));
  }

  private scheduleIdle(entry: Entry): void {
    this.clearTimer(entry.idle);
    entry.idle = null;
    if (this.kept(entry)) return;
    const id = entry.state.id;
    entry.idle = this.setTimer(() => {
      const e = this.sessions.get(id);
      if (e === entry && !this.kept(e)) void this.disconnect(id);
    }, this.deps.idleMs ?? SFTP_LIMITS.idleDisconnectMs);
  }

  ids(): string[] { return [...this.sessions.keys()]; }
}
