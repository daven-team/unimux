// Main-side brain of SSH sessions (spec 6.1, 7.3, 9, D7): resolves hosts and credentials, talks to the Pty Host,
// asks the renderer (coalescing identical prompts) and keeps a session state per cell. The only place that decrypts secrets.
// Since 0.9.8 a session may also be a non-cell one (an SFTP session, id "sftp:<uuid>"): same vault, saved password,
// passphrase check, known hosts and prompt grouping; its commands go to the SFTP Host (main routes `host()` by id).
import { randomUUID } from 'crypto';
import type { HostToMain, MainToHost } from '../../shared/ipc';
import { isSftpSessionId } from '../../shared/sftp';
import { findCell } from '../../shared/state';
import {
  hostEndpoint, isLivePhase, knownHostId, sanitizeServerText, startupInput,
  type SshConnectCellRequest, type SshErrorCode, type SshHost, type SshPhase, type SshPrompt, type SshPromptAnswer, type SshSessionState, type SshSessionsSnapshot,
} from '../../shared/ssh';
import type { AppState } from '../../shared/types';
import { checkPassphrase } from './keys';
import type { KnownHostsStore } from './knownHosts';
import type { SshVault } from './vault';

export type SshHostCommand = Extract<MainToHost, { t: 'sshConnect' | 'sshHostKeyAnswer' | 'sshAuthAnswer' }>;

export interface CoordinatorDeps {
  state(): AppState;
  vault: SshVault;
  knownHosts: KnownHostsStore;
  /** Sends a command to the Pty Host (cells) or the SFTP Host (sessions, by id); false when it was not delivered (no host runs). */
  host(m: SshHostCommand): boolean | void;
  events: { session(s: SshSessionState): void; prompt(cellId: string, prompt: SshPrompt | null): void; vaultChanged(): void };
  debug?: boolean;
  now?(): number;
  promptTimeoutMs?: number;
}

type Answer = { cancel: true; timeout?: boolean } | { values: string[]; remember: boolean } | { hostKey: 'once' | 'save' | 'replace' };
type PromptBody = SshPrompt extends infer P ? (P extends SshPrompt ? Omit<P, 'id'> : never) : never;

interface Group { id: string; key: string | null; prompt: SshPrompt; cells: Map<string, (a: Answer) => void>; timer: NodeJS.Timeout }
interface Live { kind: 'cell' | 'session'; state: SshSessionState; host: string; port: number; user: string; endpoint: string; pendingSave?: string }

type Answer2 = Answer & { useSaved?: boolean };

const PROMPT_TIMEOUT_MS = 5 * 60_000;
const MAX_PASSPHRASE_TRIES = 3;

export class SshCoordinator {
  private sessionsByCell = new Map<string, Live>();
  private groups = new Map<string, Group>();
  private promptOfCell = new Map<string, string>();
  /** Results computed once per answer of a coalesced prompt (passphrase check, host key trust). Keyed weakly by the answer
   *  object every cell of the group receives, so a typed passphrase is not kept once the cells are done with it (D7). */
  private perAnswer = new WeakMap<Answer, boolean>();

  private onceFor(answer: Answer, compute: () => boolean): boolean {
    const known = this.perAnswer.get(answer);
    if (known !== undefined) return known;
    const result = compute();
    this.perAnswer.set(answer, result);
    return result;
  }

  constructor(private readonly deps: CoordinatorDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private setPhase(cellId: string, live: Live, phase: SshPhase, extra: { error?: SshErrorCode; exitCode?: number } = {}): void {
    const { serverBanner } = live.state;
    live.state = {
      cellId, hostId: live.state.hostId, phase, since: this.now(),
      ...(extra.error ? { error: extra.error } : {}), ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      ...(serverBanner && isLivePhase(phase) ? { serverBanner } : {}),
    };
    this.deps.events.session(live.state);
  }

  async connect(req: SshConnectCellRequest): Promise<{ ok: true } | { ok: false; error: SshErrorCode }> {
    const state = this.deps.state();
    const found = findCell(state, req.cellId);
    const host = state.sshHosts.find((h) => h.id === req.hostId);
    if (!found || found.cell.ssh?.hostId !== req.hostId || !host) return { ok: false, error: 'hostMissing' };
    const existing = this.sessionsByCell.get(req.cellId);
    if (existing && isLivePhase(existing.state.phase)) return { ok: true }; // R13
    return this.start(req.cellId, 'cell', host, { cols: req.cols, rows: req.rows, startup: startupInput(host.startupCommand) ?? undefined });
  }

  /**
   * A login that is not a grid cell (0.9.8, SFTP): `sessionId` is "sftp:<uuid>". Everything else is the cell path: vault key,
   * passphrase (saved, remembered or asked), saved password, known hosts and the same prompt groups.
   */
  /**
   * `sudo` (0.9.9): run the SFTP server through sudo. SftpService decides it once from the host setting when the session is
   * created; it is never read from the host again here, so editor sessions (sudo false) always run as the SSH user.
   */
  async connectSession(req: { sessionId: string; hostId: string; sudo?: boolean }): Promise<{ ok: true } | { ok: false; error: SshErrorCode }> {
    if (!isSftpSessionId(req.sessionId)) return { ok: false, error: 'unknown' };
    const host = this.deps.state().sshHosts.find((h) => h.id === req.hostId);
    if (!host) return { ok: false, error: 'hostMissing' };
    const existing = this.sessionsByCell.get(req.sessionId);
    if (existing && isLivePhase(existing.state.phase)) return { ok: true };
    return this.start(req.sessionId, 'session', host, { cols: 80, rows: 24, ...(req.sudo === true ? { sftpSudo: { ...(host.sftpCommand ? { command: host.sftpCommand } : {}) } } : {}) });
  }

  private async start(id: string, kind: Live['kind'], host: SshHost, size: { cols: number; rows: number; startup?: string; sftpSudo?: { command?: string } }): Promise<{ ok: true } | { ok: false; error: SshErrorCode }> {
    const live: Live = {
      kind, state: { cellId: id, hostId: host.id, phase: 'connecting', since: this.now() },
      host: host.address, port: host.port, user: host.username, endpoint: hostEndpoint(host.address, host.port),
    };
    this.sessionsByCell.set(id, live);
    this.deps.events.session(live.state);
    const current = () => this.sessionsByCell.get(id) === live && isLivePhase(live.state.phase);
    const fail = (error: SshErrorCode) => { if (current()) this.setPhase(id, live, 'error', { error }); return { ok: false as const, error }; };

    let privateKey: string | undefined;
    let passphrase: string | undefined;
    if (host.keyId) {
      const secret = this.deps.vault.keySecret(host.keyId);
      if (!secret.ok) { this.deps.events.vaultChanged(); return fail(secret.error); }
      privateKey = secret.privateKey;
      const info = this.deps.vault.key(host.keyId);
      if (info?.encrypted) {
        // M2: the bcrypt check blocks the main loop, so a saved passphrase is checked once per run and a remembered one
        // (checked when it was typed) never again. A wrong one still ends in an ssh2 auth failure, no prompt is lost.
        const saved = secret.passphrase;
        if (saved !== undefined && (this.deps.vault.isVerified(host.keyId, saved) || checkPassphrase(privateKey, saved))) {
          this.deps.vault.markVerified(host.keyId, saved);
          passphrase = saved;
        } else passphrase = this.deps.vault.remembered(host.keyId);
      }
      if (info?.encrypted && passphrase === undefined) {
        // The key may be replaced while the prompt is open: a passphrase checked against this material is remembered only for it.
        const generation = this.deps.vault.generation(host.keyId);
        for (let attempt = 0; attempt < MAX_PASSPHRASE_TRIES && passphrase === undefined; attempt++) {
          const answer = await this.ask(id, `pp:${host.keyId}`, { kind: 'passphrase', keyId: host.keyId, keyLabel: info.label, retry: attempt > 0 });
          if (!current()) return { ok: false, error: 'cancelled' };
          if (!('values' in answer)) return fail('cancelled');
          const typed = answer.values[0] ?? '';
          // Cells of one coalesced prompt get the same answer object: only the first one pays for the check. A typed passphrase
          // is never cached by itself; it is kept only when the user asked to remember it (D7).
          const key = privateKey;
          if (this.onceFor(answer, () => checkPassphrase(key, typed))) {
            passphrase = typed;
            if (answer.remember) this.deps.vault.remember(host.keyId, typed, generation);
          }
        }
        if (passphrase === undefined) return fail('passphrase');
      }
    }
    const savedPassword = this.deps.vault.password(host.id);
    if (!current()) return { ok: false, error: 'cancelled' };
    const startup = size.startup;
    const delivered = this.deps.host({ t: 'sshConnect', req: {
      id, host: host.address, port: host.port, username: host.username, cols: size.cols, rows: size.rows,
      ...(privateKey ? { privateKey } : {}), ...(passphrase ? { passphrase } : {}), ...(savedPassword.ok ? { password: savedPassword.password } : {}),
      ...(startup ? { startup } : {}), ...(size.sftpSudo ? { sftpSudo: size.sftpSudo } : {}),
      allowPasswordPrompt: true, ...(this.deps.debug ? { debug: true } : {}),
    } });
    // M1: a connect sent while the Pty Host is restarting or gone would be lost and leave the cell `connecting` forever.
    if (delivered === false) return fail(kind === 'cell' ? 'ptyHostCrashed' : 'sftpHostCrashed');
    return { ok: true };
  }

  private ask(cellId: string, key: string | null, body: PromptBody): Promise<Answer> {
    return new Promise((resolve) => {
      let group = key ? [...this.groups.values()].find((g) => g.key === key) : undefined;
      if (!group) {
        const id = randomUUID();
        const created: Group = { id, key, prompt: { ...body, id } as SshPrompt, cells: new Map(), timer: setTimeout(() => this.finish(created, { cancel: true, timeout: true }), this.deps.promptTimeoutMs ?? PROMPT_TIMEOUT_MS) };
        group = created;
        this.groups.set(id, group);
      }
      group.cells.set(cellId, resolve);
      this.promptOfCell.set(cellId, group.id);
      this.deps.events.prompt(cellId, group.prompt);
    });
  }

  private finish(group: Group, answer: Answer): void {
    clearTimeout(group.timer);
    this.groups.delete(group.id);
    for (const [cellId, resolve] of group.cells) {
      if (this.promptOfCell.get(cellId) === group.id) {
        this.promptOfCell.delete(cellId);
        this.deps.events.prompt(cellId, null);
      }
      resolve(answer);
    }
  }

  /** Takes one cell out of its prompt (the cell was closed or its session ended); the others keep waiting. */
  private withdraw(cellId: string): void {
    const groupId = this.promptOfCell.get(cellId);
    const group = groupId ? this.groups.get(groupId) : undefined;
    this.promptOfCell.delete(cellId);
    if (!group) return;
    const resolve = group.cells.get(cellId);
    group.cells.delete(cellId);
    this.deps.events.prompt(cellId, null);
    resolve?.({ cancel: true });
    if (!group.cells.size) { clearTimeout(group.timer); this.groups.delete(group.id); }
  }

  answer(a: SshPromptAnswer): { ok: boolean } {
    const groupId = this.promptOfCell.get(a.cellId);
    const group = groupId ? this.groups.get(groupId) : undefined;
    if (!group || group.id !== a.promptId) return { ok: false };
    const p = group.prompt;
    if ('cancel' in a) { this.finish(group, { cancel: true }); return { ok: true }; }
    if ('hostKey' in a) {
      if (p.kind !== 'hostKey') return { ok: false };
      const allowed = p.reason === 'changed' ? a.hostKey === 'replace' : a.hostKey !== 'replace';
      if (!allowed) return { ok: false };
      this.finish(group, { hostKey: a.hostKey });
      return { ok: true };
    }
    const count = p.kind === 'keyboard' ? p.fields.length : p.kind === 'hostKey' ? -1 : 1;
    if (a.values.length !== count) return { ok: false };
    // "Użyj zapisanego hasła" (a sudo prompt only): the user's consent to use the host's saved login password for sudo once.
    if (a.useSaved && (p.kind !== 'sudo' || !p.canUseSaved)) return { ok: false };
    const answer: Answer2 = { values: a.values, remember: p.kind === 'sudo' ? false : a.remember === true, ...(a.useSaved ? { useSaved: true } : {}) };
    this.finish(group, answer);
    return { ok: true };
  }

  /** Returns true when the message was an SSH one and is fully handled here. */
  onHostMessage(m: HostToMain): boolean {
    switch (m.t) {
      case 'sshStatus': {
        const live = this.sessionsByCell.get(m.id);
        if (!live) return true;
        if (m.banner !== undefined) {
          live.state = { ...live.state, serverBanner: sanitizeServerText(m.banner) };
          this.deps.events.session(live.state);
          return true;
        }
        if (m.phase === 'connected' && live.pendingSave !== undefined) {
          // A failed write only loses the "remember" wish; the session itself is fine.
          try { if (this.deps.vault.setPassword(live.state.hostId, live.pendingSave).ok) this.deps.events.vaultChanged(); } catch { /* not saved */ }
        }
        if (!isLivePhase(m.phase)) { live.pendingSave = undefined; this.withdraw(m.id); }
        if (m.phase === 'connected') live.pendingSave = undefined;
        this.setPhase(m.id, live, m.phase, { error: m.error, exitCode: m.exitCode });
        return true;
      }
      case 'sshHostKey': void this.onHostKey(m); return true;
      case 'sshAuthPrompt': void this.onAuthPrompt(m); return true;
      case 'exit': {
        const live = this.sessionsByCell.get(m.id);
        if (live && isLivePhase(live.state.phase)) this.setPhase(m.id, live, m.code >= 0 ? 'closed' : 'error', m.code >= 0 ? { exitCode: m.code } : { error: 'reset' });
        return false; // index.ts still updates `alive` and automation
      }
      default: return false;
    }
  }

  private async onHostKey(m: Extract<HostToMain, { t: 'sshHostKey' }>): Promise<void> {
    const live = this.sessionsByCell.get(m.id);
    const reply = (accept: boolean, error?: SshErrorCode) => this.deps.host({ t: 'sshHostKeyAnswer', id: m.id, promptId: m.promptId, accept, ...(error ? { error } : {}) });
    if (!live || !isLivePhase(live.state.phase)) { reply(false, 'cancelled'); return; }
    const blob = Buffer.from(m.key, 'base64');
    const { judgement, keyType, fingerprint } = this.deps.knownHosts.judge(live.host, live.port, blob);
    if (judgement.result === 'match') { reply(true); return; }
    const answer = await this.ask(m.id, `hk:${knownHostId(live.host, live.port)}|${fingerprint}`, {
      kind: 'hostKey', endpoint: live.endpoint, keyType, fingerprint, reason: judgement.result,
      knownFingerprints: judgement.result === 'changed' ? judgement.knownFingerprints : [],
      knownTypes: judgement.result === 'newType' ? judgement.knownTypes : [],
    });
    if (this.sessionsByCell.get(m.id) !== live) return; // the cell was closed: its Pty Host session is gone
    if ('hostKey' in answer) {
      if (answer.hostKey !== 'once') {
        // A read-only store (false) cannot save, the key is accepted for this connection; a failed write must not look like success.
        // Once per group: every cell of the prompt gets the same outcome, even when a write fails only now and then.
        const mode = answer.hostKey === 'replace' ? 'replace' : 'save';
        const saved = this.onceFor(answer, () => { try { this.deps.knownHosts.trust(live.host, live.port, blob, mode); return true; } catch { return false; } });
        if (!saved) { reply(false, 'unknown'); return; }
      }
      reply(true);
      return;
    }
    reply(false, 'timeout' in answer && answer.timeout ? 'cancelled' : judgement.result === 'changed' ? 'hostKeyChanged' : 'hostKeyRejected');
  }

  private async onAuthPrompt(m: Extract<HostToMain, { t: 'sshAuthPrompt' }>): Promise<void> {
    const live = this.sessionsByCell.get(m.id);
    const reply = (values: string[] | null) => this.deps.host({ t: 'sshAuthAnswer', id: m.id, promptId: m.promptId, values });
    if (!live || !isLivePhase(live.state.phase)) { reply(null); return; }
    // A sudo password (0.9.9) is asked only for SFTP sessions and never saved.
    if (m.kind === 'sudo' && live.kind !== 'session') { reply(null); return; }
    const saved = m.kind === 'sudo' ? this.deps.vault.password(live.state.hostId) : null;
    const body: PromptBody = m.kind === 'password'
      ? { kind: 'password', user: live.user, endpoint: live.endpoint, canSave: !this.deps.vault.readOnly(), retry: m.retry }
      : m.kind === 'sudo' ? { kind: 'sudo', user: live.user, endpoint: live.endpoint, canUseSaved: !!saved?.ok, retry: m.retry }
        : { kind: 'keyboard', endpoint: live.endpoint, name: sanitizeServerText(m.name ?? '', 200), instructions: sanitizeServerText(m.instructions ?? ''),
            fields: m.fields.slice(0, 10).map((f) => ({ text: sanitizeServerText(f.text, 200), echo: f.echo === true })) };
    const answer = await this.ask(m.id, null, body) as Answer2;
    if (this.sessionsByCell.get(m.id) !== live) return;
    if (!('values' in answer)) { reply(null); return; }
    if (m.kind === 'sudo') {
      if (!answer.useSaved) { reply(answer.values); return; }
      const now = this.deps.vault.password(live.state.hostId);
      reply(now.ok ? [now.password] : null);
      return;
    }
    // I1: only the latest answer decides; a retry answered without "remember" must not save an earlier (wrong) password.
    live.pendingSave = m.kind === 'password' && answer.remember ? answer.values[0] : undefined;
    reply(answer.values);
  }

  /** The user closed or disconnected the cell (cell:kill, cell:killAndWait, MCP stopCells). */
  killed(cellId: string): void {
    this.withdraw(cellId);
    const live = this.sessionsByCell.get(cellId);
    if (!live) return;
    live.pendingSave = undefined;
    if (!findCell(this.deps.state(), cellId)) { this.sessionsByCell.delete(cellId); return; }
    if (isLivePhase(live.state.phase)) this.setPhase(cellId, live, 'closed');
  }

  /** The Pty Host restarted: every cell session ended (SFTP sessions live in another process). */
  hostCrashed(): void {
    for (const [cellId, live] of this.sessionsByCell) {
      if (live.kind !== 'cell') continue;
      this.withdraw(cellId);
      if (isLivePhase(live.state.phase)) this.setPhase(cellId, live, 'error', { error: 'ptyHostCrashed' });
    }
  }

  /** The SFTP Host restarted: every non-cell session ended. */
  sessionHostCrashed(): void {
    for (const [id, live] of this.sessionsByCell) {
      if (live.kind !== 'session') continue;
      this.withdraw(id);
      if (isLivePhase(live.state.phase)) this.setPhase(id, live, 'error', { error: 'sftpHostCrashed' });
    }
  }

  /** A non-cell session was disconnected by the user (or idled out): its prompt goes, it reads closed and is forgotten. */
  endSession(id: string): void {
    const live = this.sessionsByCell.get(id);
    this.withdraw(id);
    if (!live || live.kind !== 'session') return;
    live.pendingSave = undefined;
    if (isLivePhase(live.state.phase)) this.setPhase(id, live, 'closed');
    this.sessionsByCell.delete(id);
  }

  stateChanged(state: AppState): void {
    try { if (this.deps.vault.prunePasswords(new Set(state.sshHosts.map((h) => h.id)))) this.deps.events.vaultChanged(); } catch { /* retried on the next change */ }
    for (const [cellId, live] of this.sessionsByCell) if (!isLivePhase(live.state.phase) && !findCell(state, cellId)) this.sessionsByCell.delete(cellId);
  }

  /** Cell sessions and their prompts (what the SSH store of the renderer holds). */
  sessions(): SshSessionsSnapshot { return this.snapshot('cell'); }

  /** Non-cell sessions (SFTP) and their prompts; `cellId` is the session id. */
  sessionSnapshot(): SshSessionsSnapshot { return this.snapshot('session'); }

  private snapshot(kind: Live['kind']): SshSessionsSnapshot {
    const ofKind = (id: string) => (isSftpSessionId(id) ? 'session' : 'cell') === kind;
    return {
      sessions: [...this.sessionsByCell.values()].filter((l) => l.kind === kind).map((l) => l.state),
      prompts: [...this.promptOfCell].flatMap(([cellId, groupId]) => { const g = this.groups.get(groupId); return g && ofKind(cellId) ? [{ cellId, prompt: g.prompt }] : []; }),
    };
  }
}
