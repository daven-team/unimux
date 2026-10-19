// Owns every SSH session: one ssh2 Client per cell id (spec 6.1, 6.2, 6.4). Independent of Electron so it is tested in Node.
// Secrets arrive in SshConnectRequest (memory only), are dropped once ssh2 used them, and are never logged. The login itself
// (connect options, host key and auth callbacks) is the shared SshLogin of src/sshcore, also used by the SFTP Host.
import { StringDecoder } from 'string_decoder';
import { Client, type ClientChannel } from 'ssh2';
import type { SshConnectRequest } from '../shared/ipc';
import { sanitizeServerText, type SshErrorCode, type SshPhase } from '../shared/ssh';
import { SshLogin, type SshAuthPromptInfo } from '../sshcore/login';
import type { PtySink } from './manager';
import { OutputChannel } from './output';
import type { TerminalBackend } from './router';
import { isRecoverableAuthError, mapSshError } from './sshErrors';

export type { SshAuthPromptInfo };

export interface SshEvents {
  spawned(id: string): void;
  status(id: string, phase: SshPhase, extra?: { error?: SshErrorCode; exitCode?: number; banner?: string }): void;
  hostKey(id: string, promptId: string, keyBase64: string): void;
  authPrompt(id: string, promptId: string, prompt: SshAuthPromptInfo): void;
  debug?(id: string, line: string): void;
}

export interface SshTimers { connectMs: number; authStepMs: number; shellMs: number; quietMs: number; startupMaxMs: number; killGraceMs: number; keepaliveMs: number; keepaliveCountMax: number }
export const SSH_TIMERS: SshTimers = { connectMs: 20_000, authStepMs: 20_000, shellMs: 20_000, quietMs: 400, startupMaxMs: 5000, killGraceMs: 2000, keepaliveMs: 15_000, keepaliveCountMax: 3 };
/**
 * ssh2's destroy() is a no-op once end() half-closed the socket, so a peer that never reads or answers the FIN (a server that
 * accepts TCP but never speaks SSH) would keep the socket open for good. The socket itself is destroyed as well.
 */
export function hardClose(client: Client): void {
  try { client.destroy(); } catch { /* gone */ }
  const sock = (client as unknown as { _sock?: { destroyed?: boolean; destroy(): void } })._sock;
  try { if (sock && !sock.destroyed) sock.destroy(); } catch { /* gone */ }
}

interface Session {
  id: string;
  client: Client;
  out: OutputChannel;
  stream: ClientChannel | null;
  phase: SshPhase;
  /** Our copy of the request; privateKey, passphrase and password are deleted after ready and on every end. */
  req: SshConnectRequest;
  size: { cols: number; rows: number };
  login: SshLogin;
  timer: NodeJS.Timeout | null;
  error: SshErrorCode | undefined;
  exited: boolean;
  exitCode: number | undefined;
  startup: { text: string | undefined; quiet: NodeJS.Timeout | null; max: NodeJS.Timeout | null };
  ended: boolean;
  /** The session ended and the last output of a paused channel is being drained (M2): it is still delivered. */
  draining: boolean;
  closed: Promise<void>;
  markClosed: () => void;
}

export class SshManager implements TerminalBackend {
  private sessions = new Map<string, Session>();
  private flowControl = false;
  private readonly timers: SshTimers;

  constructor(private sink: PtySink, private readonly events: SshEvents, timers: Partial<SshTimers> = {}) {
    this.timers = { ...SSH_TIMERS, ...timers };
  }

  has(id: string): boolean { return this.sessions.has(id); }
  phase(id: string): SshPhase | undefined { return this.sessions.get(id)?.phase; }
  private live(s: Session): boolean { return this.sessions.get(s.id) === s && !s.ended; }

  connect(req: SshConnectRequest): void {
    if (this.sessions.has(req.id)) void this.kill(req.id);
    const client = new Client();
    let markClosed!: () => void;
    const closed = new Promise<void>((r) => (markClosed = r));
    const s = {
      id: req.id, client, stream: null, phase: 'connecting', req: { ...req },
      size: { cols: Math.max(2, req.cols), rows: Math.max(1, req.rows) },
      timer: null, error: undefined,
      exited: false, exitCode: undefined, startup: { text: req.startup, quiet: null, max: null }, ended: false, draining: false, closed, markClosed,
    } as Omit<Session, 'out' | 'login'> as Session;
    s.login = new SshLogin(s.req, this.timers, {
      live: () => this.live(s),
      arm: (ms) => this.arm(s, ms),
      disarm: () => this.disarm(s),
      phase: (phase) => { s.phase = phase; this.events.status(s.id, phase); },
      hostKey: (promptId, key) => this.events.hostKey(s.id, promptId, key),
      authPrompt: (promptId, prompt) => this.events.authPrompt(s.id, promptId, prompt),
      debug: (line) => this.events.debug?.(s.id, line),
    });
    s.out = new OutputChannel(req.id, () => this.sink, { pause: () => this.pauseStreams(s), resume: () => this.resumeStreams(s) }, () => this.flowControl);
    this.sessions.set(req.id, s);
    this.events.spawned(req.id);
    this.events.status(req.id, 'connecting');
    this.arm(s, this.timers.connectMs);
    client.on('banner', (message: string) => { if (this.live(s)) this.events.status(s.id, s.phase, { banner: sanitizeServerText(message) }); });
    client.on('ready', () => this.onReady(s));
    client.on('error', (err) => {
      // A key that cannot sign is skipped by ssh2 itself (saved password, prompt or keyboard-interactive come next).
      if (isRecoverableAuthError(err)) return;
      this.fail(s, mapSshError(err, s.login.override));
    });
    client.on('close', () => this.onClose(s));
    try {
      client.connect(s.login.connectConfig());
      // An interactive session (like OpenSSH's client): every keystroke leaves at once instead of waiting, under Nagle's
      // algorithm, for the acknowledgement of the previous one (one round trip per key when typing fast).
      client.setNoDelay(true);
    } catch (err) { this.fail(s, mapSshError(err)); }
  }

  private arm(s: Session, ms: number): void {
    this.disarm(s);
    s.timer = setTimeout(() => this.fail(s, 'timeout'), ms);
  }

  private disarm(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
  }

  answerHostKey(id: string, promptId: string, accept: boolean, error?: SshErrorCode): void {
    const s = this.sessions.get(id);
    if (!s || s.ended) return;
    s.login.answerHostKey(promptId, accept, error);
  }

  answerAuth(id: string, promptId: string, values: string[] | null): void {
    const s = this.sessions.get(id);
    if (!s || s.ended) return;
    s.login.answerAuth(promptId, values);
  }

  private dropSecrets(s: Session): void { s.login.dropSecrets(); }

  private onReady(s: Session): void {
    if (!this.live(s)) return;
    this.dropSecrets(s);
    this.arm(s, this.timers.shellMs);
    s.client.shell({ term: 'xterm-256color', cols: s.size.cols, rows: s.size.rows, width: 0, height: 0 }, (err, stream) => {
      if (!this.live(s)) { try { stream?.close(); } catch { /* gone */ } return; }
      this.disarm(s);
      if (err || !stream) { this.fail(s, 'shellDenied'); return; }
      s.stream = stream;
      s.phase = 'connected';
      this.events.status(s.id, 'connected');
      const stdout = new StringDecoder('utf8');
      const stderr = new StringDecoder('utf8');
      stream.on('data', (chunk: Buffer) => this.output(s, stdout.write(chunk)));
      stream.stderr.on('data', (chunk: Buffer) => this.output(s, stderr.write(chunk)));
      stream.on('exit', (code: number | null) => { s.exited = true; if (typeof code === 'number') s.exitCode = code; });
      stream.on('close', () => { this.output(s, stdout.end() + stderr.end()); try { s.client.end(); } catch { /* gone */ } });
      // A reset mid-write surfaces as a stream error: it ends this session, never the Pty Host (and every other terminal).
      stream.on('error', (error: unknown) => this.fail(s, mapSshError(error, s.login.override)));
      stream.stderr.on('error', (error: unknown) => this.fail(s, mapSshError(error, s.login.override)));
      if (s.startup.text) s.startup.max = setTimeout(() => this.typeStartup(s), this.timers.startupMaxMs);
    });
  }

  private output(s: Session, text: string): void {
    if (!text || this.sessions.get(s.id) !== s || (s.ended && !s.draining)) return;
    s.out.push(text);
    if (s.startup.text && !s.ended) {
      if (s.startup.quiet) clearTimeout(s.startup.quiet);
      s.startup.quiet = setTimeout(() => this.typeStartup(s), this.timers.quietMs);
    }
  }

  private clearStartup(s: Session): void {
    if (s.startup.quiet) clearTimeout(s.startup.quiet);
    if (s.startup.max) clearTimeout(s.startup.max);
    s.startup.quiet = null;
    s.startup.max = null;
  }

  private typeStartup(s: Session): void {
    const text = s.startup.text;
    this.clearStartup(s);
    s.startup.text = undefined;
    if (!text || !this.live(s) || !s.stream) return;
    s.out.wrote();
    s.stream.write(Buffer.from(text, 'utf8'));
  }

  private fail(s: Session, error: SshErrorCode): void {
    if (!this.live(s)) return;
    // I3: after the remote exit a hard-closing server may answer the disconnect with a reset; that is still a clean close.
    if (!s.error && !s.exited) s.error = error;
    this.disarm(s);
    s.login.abort();
    try { s.client.end(); } catch { /* gone */ }
    // ssh2 emits 'close' after an error; if it does not, the session is ended here.
    setTimeout(() => { if (!s.ended && this.sessions.get(s.id) === s) { hardClose(s.client); this.onClose(s); } }, this.timers.killGraceMs);
  }

  private onClose(s: Session): void {
    if (this.sessions.get(s.id) !== s) { s.markClosed(); return; } // killed: kill() already forgot it
    if (s.ended) return;
    s.ended = true;
    this.disarm(s);
    this.clearStartup(s);
    this.dropSecrets(s);
    s.draining = true;
    s.out.drain(() => {
      s.draining = false;
      if (this.sessions.get(s.id) === s) {
        s.out.flush();
        s.out.dispose();
        this.sessions.delete(s.id);
        if (s.error) this.events.status(s.id, 'error', { error: s.error });
        else if (s.phase === 'connected' && s.exited) this.events.status(s.id, 'closed', s.exitCode !== undefined ? { exitCode: s.exitCode } : undefined);
        else this.events.status(s.id, 'error', { error: s.login.override ?? 'reset' });
        this.sink.exit(s.id, s.exitCode ?? -1);
      }
      s.markClosed();
    });
  }

  private pauseStreams(s: Session): void { s.stream?.pause(); s.stream?.stderr.pause(); }
  private resumeStreams(s: Session): void { s.stream?.resume(); s.stream?.stderr.resume(); }

  write(id: string, data: string, reply = false): void {
    const s = this.sessions.get(id);
    if (!s?.stream || s.ended) return;
    if (!reply) s.out.wrote();
    s.stream.write(Buffer.from(data, 'utf8'));
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.size = { cols: Math.max(2, cols), rows: Math.max(1, rows) };
    try { s.stream?.setWindow(s.size.rows, s.size.cols, 0, 0); } catch { /* closing */ }
  }

  ack(id: string, chars: number): void { this.sessions.get(id)?.out.ack(chars); }

  setFlowControl(on: boolean): void {
    this.flowControl = on;
    for (const s of this.sessions.values()) s.out.resetFlow();
  }

  histories(): Array<{ id: string; data: string }> {
    return [...this.sessions].map(([id, s]) => ({ id, data: s.out.history() }));
  }

  kill(id: string, timeoutMs = this.timers.killGraceMs): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve();
    this.sessions.delete(id);
    s.ended = true;
    this.disarm(s);
    this.clearStartup(s);
    this.dropSecrets(s);
    s.out.dispose();
    s.login.abort();
    try { s.stream?.end(); } catch { /* gone */ }
    try { s.client.end(); } catch { /* gone */ }
    const destroy = setTimeout(() => { hardClose(s.client); s.markClosed(); }, timeoutMs);
    return s.closed.finally(() => clearTimeout(destroy));
  }

  async killAll(timeoutMs = this.timers.killGraceMs): Promise<void> {
    const kills = [...this.sessions.keys()].map((id) => this.kill(id, timeoutMs));
    await Promise.race([Promise.all(kills), new Promise((r) => setTimeout(r, timeoutMs + 500))]);
  }
}
