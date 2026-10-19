// Main side of SFTP sessions (0.9.8): starts the SFTP Host on first use, logs in through the SSH coordinator (same vault,
// known hosts and prompts as a cell), keeps the session state the renderer sees, brokers operations and disconnects a session
// 2 minutes after the SFTP view closed once its queue is empty. Electron-free so it is unit tested.
import { randomUUID } from 'crypto';
import {
  LOCAL_QUEUE_ID, SFTP_LIMITS, sftpSessionId, sftpStatusOf,
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
  events: { session(s: SftpSessionState): void; prompt(sessionId: string, prompt: SshPrompt | null): void; hostCrashed(): void };
  now?(): number;
  idleMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

interface Entry { state: SftpSessionState; initialPath?: string; queueActive: boolean; idle: unknown; resolving: boolean }

export class SftpService {
  private sessions = new Map<string, Entry>();
  private viewOpen = false;

  constructor(private readonly deps: SftpServiceDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private setTimer(fn: () => void, ms: number): unknown { return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms); }
  private clearTimer(t: unknown): void { if (t === undefined || t === null) return; if (this.deps.clearTimer) this.deps.clearTimer(t); else clearTimeout(t as NodeJS.Timeout); }

  async connect(hostId: string, initialPath?: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: SshErrorCode }> {
    if (!this.deps.hostExists(hostId)) return { ok: false, error: 'hostMissing' };
    if (!this.deps.host.ensure()) return { ok: false, error: 'sftpHostCrashed' };
    const id = sftpSessionId(randomUUID());
    this.sessions.set(id, { state: { id, hostId, state: 'connecting', phase: 'connecting', since: this.now() }, initialPath, queueActive: false, idle: null, resolving: false });
    const r = await this.deps.coordinator.connectSession({ sessionId: id, hostId });
    if (!r.ok) { this.forget(id); return r; }
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
    const next: SftpSessionState = { id: s.cellId, hostId: s.hostId, state: sftpStatusOf(s.phase), phase: s.phase, since: s.since, ...(s.error ? { error: s.error } : {}) };
    if (s.phase === 'connected') {
      // "connected" goes out with the start folder: the asked one when it exists, else the login folder.
      if (entry.resolving || entry.state.path) return;
      entry.resolving = true;
      void this.resolveStart(entry).then((path) => {
        entry.resolving = false;
        if (this.sessions.get(s.cellId) !== entry) return; // ended meanwhile
        entry.state = { ...next, ...(path ? { path } : {}) };
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
    if (m.t === 'sshStatus' || m.t === 'sshHostKey' || m.t === 'sshAuthPrompt') this.deps.coordinator.onHostMessage(m);
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

  viewOpened(): void {
    this.viewOpen = true;
    for (const e of this.sessions.values()) { this.clearTimer(e.idle); e.idle = null; }
  }

  viewClosed(): void {
    this.viewOpen = false;
    for (const e of this.sessions.values()) this.scheduleIdle(e);
  }

  private scheduleIdle(entry: Entry): void {
    this.clearTimer(entry.idle);
    entry.idle = null;
    if (this.viewOpen || entry.queueActive) return;
    const id = entry.state.id;
    entry.idle = this.setTimer(() => {
      const e = this.sessions.get(id);
      if (e === entry && !this.viewOpen && !e.queueActive) void this.disconnect(id);
    }, this.deps.idleMs ?? SFTP_LIMITS.idleDisconnectMs);
  }

  ids(): string[] { return [...this.sessions.keys()]; }
}
