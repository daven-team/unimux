// The SSH tunnel of DB sessions (1.0.0): one ssh2 Client logged in with the shared SshLogin (host key and auth questions go to
// main's coordinator like a cell's). There is no local listener: every database connection (the session's own, the cancel side
// connection, a CancelRequest) is a ForwardSocket, a socket-like Duplex over its own direct-tcpip channel that pg uses through
// its `stream` option, so no other local program can ever reach the database through the tunnel. One tunnel is shared by
// all sessions of a connection (reference counted by the DB Host). Independent of Electron so it is tested in Node.
import { Duplex } from 'stream';
import { Client, type ClientChannel } from 'ssh2';
import type { SshConnectRequest } from '../shared/ipc';
import type { SshErrorCode } from '../shared/ssh';
import { SshLogin, type SshAuthPromptInfo } from '../sshcore/login';
import { isRecoverableAuthError, mapSshError } from '../ptyhost/sshErrors';

export interface TunnelTimers { connectMs: number; authStepMs: number; keepaliveMs: number; keepaliveCountMax: number; killGraceMs: number }
export const TUNNEL_TIMERS: TunnelTimers = { connectMs: 20_000, authStepMs: 20_000, keepaliveMs: 15_000, keepaliveCountMax: 3, killGraceMs: 2000 };

export interface TunnelEvents {
  phase(phase: 'verifying' | 'authenticating'): void;
  hostKey(promptId: string, keyBase64: string): void;
  authPrompt(promptId: string, prompt: SshAuthPromptInfo): void;
  /** The tunnel ended (before or after it was ready); `error` absent: closed on request. */
  ended(error?: SshErrorCode): void;
  debug?(line: string): void;
}

/** The error a ForwardSocket fails with when the SSH server could not open the channel (it cannot reach the database). */
export class TunnelForwardError extends Error {
  readonly code = 'ETUNNEL';
  constructor(reason: string) { super(`SSH forward failed: ${reason}`); }
}

type Opener = (cb: (err: Error | undefined, channel: ClientChannel | undefined) => void) => void;

/**
 * A net.Socket stand-in for pg: connect() opens a direct-tcpip channel and emits 'connect'; data flows through the channel.
 * tls.connect accepts it as `socket`, so TLS to the database works through the tunnel as well.
 */
export class ForwardSocket extends Duplex {
  private channel: ClientChannel | null = null;
  private opening = false;
  constructor(private readonly opener: Opener) { super(); }

  connect(): this {
    if (this.opening || this.destroyed) return this;
    this.opening = true;
    this.opener((err, ch) => {
      if (this.destroyed) { try { ch?.close(); } catch { /* gone */ } return; }
      if (err || !ch) { this.destroy(new TunnelForwardError(err?.message ?? 'no channel')); return; }
      this.channel = ch;
      ch.on('data', (d: Buffer) => { if (!this.push(d)) ch.pause(); });
      ch.on('end', () => this.push(null));
      ch.on('close', () => { if (!this.destroyed) { this.push(null); this.destroy(); } });
      ch.on('error', (e: Error) => this.destroy(e));
      this.emit('connect');
    });
    return this;
  }

  override _read(): void { this.channel?.resume(); }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (!this.channel) { cb(new Error('not connected')); return; }
    this.channel.write(chunk, () => cb());
  }
  override _final(cb: (error?: Error | null) => void): void { try { this.channel?.end(); } catch { /* gone */ } cb(); }
  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void { try { this.channel?.close(); } catch { /* gone */ } cb(err); }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  setTimeout(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

function hardClose(client: Client): void {
  try { client.destroy(); } catch { /* gone */ }
  const sock = (client as unknown as { _sock?: { destroyed?: boolean; destroy(): void } })._sock;
  try { if (sock && !sock.destroyed) sock.destroy(); } catch { /* gone */ }
}

export class SshTunnel {
  private readonly client = new Client();
  private readonly login: SshLogin;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;
  private ready = false;
  private requested = false;
  private error: SshErrorCode | undefined;
  private readonly streams = new Set<ForwardSocket>();
  private waiting: { resolve(): void; reject(error: SshErrorCode): void } | null = null;

  constructor(req: SshConnectRequest, private readonly target: { host: string; port: number }, private readonly events: TunnelEvents, private readonly timers: TunnelTimers = TUNNEL_TIMERS) {
    this.login = new SshLogin({ ...req }, timers, {
      live: () => !this.ended,
      arm: (ms) => this.arm(ms),
      disarm: () => this.disarm(),
      phase: (phase) => events.phase(phase),
      hostKey: (promptId, key) => events.hostKey(promptId, key),
      authPrompt: (promptId, prompt) => events.authPrompt(promptId, prompt),
      debug: (line) => events.debug?.(line),
    });
  }

  private arm(ms: number): void { this.disarm(); this.timer = setTimeout(() => this.fail('timeout'), ms); }
  private disarm(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** Logs in; resolves once the SSH connection is ready, rejects with the SSH error code. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.arm(this.timers.connectMs);
      this.client.on('ready', () => {
        if (this.ended) return;
        this.disarm();
        this.login.dropSecrets();
        this.ready = true;
        const w = this.waiting;
        this.waiting = null;
        w?.resolve();
      });
      this.client.on('error', (err) => { if (!isRecoverableAuthError(err)) this.fail(mapSshError(err, this.login.override)); });
      this.client.on('close', () => this.onClose());
      try { this.client.connect(this.login.connectConfig()); } catch (err) { this.fail(mapSshError(err)); }
    });
  }

  answerHostKey(promptId: string, accept: boolean, error?: SshErrorCode): void { if (!this.ended) this.login.answerHostKey(promptId, accept, error); }
  answerAuth(promptId: string, values: string[] | null): void { if (!this.ended) this.login.answerAuth(promptId, values); }

  live(): boolean { return this.ready && !this.ended; }

  /** A new socket-like stream to the database through its own channel (pg's `stream`); connect() opens the channel. */
  socket(): ForwardSocket {
    const s = new ForwardSocket((cb) => {
      if (!this.live()) { cb(new Error('tunnel closed'), undefined); return; }
      this.client.forwardOut('127.0.0.1', 0, this.target.host, this.target.port, (err, ch) => cb(err ?? undefined, ch));
    });
    this.streams.add(s);
    s.on('close', () => this.streams.delete(s));
    s.on('error', () => undefined);
    return s;
  }

  private fail(error: SshErrorCode): void {
    if (this.ended) return;
    if (!this.error && !this.requested) this.error = error;
    this.disarm();
    this.login.abort();
    try { this.client.end(); } catch { /* gone */ }
    setTimeout(() => { if (!this.ended) { hardClose(this.client); this.onClose(); } }, this.timers.killGraceMs);
  }

  private onClose(): void {
    if (this.ended) return;
    this.ended = true;
    this.disarm();
    this.login.abort();
    this.login.dropSecrets();
    for (const s of this.streams) s.destroy();
    this.streams.clear();
    const error = this.requested ? undefined : this.error ?? this.login.override ?? 'reset';
    const w = this.waiting;
    this.waiting = null;
    w?.reject(error ?? 'cancelled');
    this.events.ended(error);
  }

  /** Closes the tunnel (the database connections through it end with it). */
  close(): void {
    if (this.ended) return;
    this.requested = true;
    this.fail('cancelled');
  }
}
