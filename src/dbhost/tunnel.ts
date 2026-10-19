// The SSH tunnel of a DB session (1.0.0): one ssh2 Client logged in with the shared SshLogin (host key and auth questions go to
// main's coordinator like a cell's), and a local listener on 127.0.0.1:0 whose connections are forwarded with forwardOut to the
// database address as the server sees it. The listener accepts only the connections the DB Host announced (allow()), so no
// other local program can ride the tunnel. Independent of Electron so it is tested in Node.
import { createServer, type Server, type Socket } from 'net';
import { Client } from 'ssh2';
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

function hardClose(client: Client): void {
  try { client.destroy(); } catch { /* gone */ }
  const sock = (client as unknown as { _sock?: { destroyed?: boolean; destroy(): void } })._sock;
  try { if (sock && !sock.destroyed) sock.destroy(); } catch { /* gone */ }
}

export class SshTunnel {
  private readonly client = new Client();
  private readonly login: SshLogin;
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;
  private requested = false;
  private error: SshErrorCode | undefined;
  private allowed = 0;
  private readonly sockets = new Set<Socket>();
  /** The last failed forward (the server could not reach the database): the DB error then reads "tunnel". */
  lastForwardFailed = false;
  private ready: { resolve(port: number): void; reject(error: SshErrorCode): void } | null = null;

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

  /** Logs in and listens; resolves with the local port, rejects with the SSH error code. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.ready = { resolve, reject };
      this.arm(this.timers.connectMs);
      this.client.on('ready', () => this.onReady());
      this.client.on('error', (err) => { if (!isRecoverableAuthError(err)) this.fail(mapSshError(err, this.login.override)); });
      this.client.on('close', () => this.onClose());
      try { this.client.connect(this.login.connectConfig()); } catch (err) { this.fail(mapSshError(err)); }
    });
  }

  answerHostKey(promptId: string, accept: boolean, error?: SshErrorCode): void { if (!this.ended) this.login.answerHostKey(promptId, accept, error); }
  answerAuth(promptId: string, values: string[] | null): void { if (!this.ended) this.login.answerAuth(promptId, values); }

  /** The next `count` connections to the local port are forwarded (the DB Host's own client and cancel connections). */
  allow(count = 1): void { this.allowed += count; }

  private onReady(): void {
    if (this.ended) return;
    this.disarm();
    this.login.dropSecrets();
    const server = createServer((sock) => this.forward(sock));
    this.server = server;
    server.on('error', () => this.fail('unknown'));
    server.listen(0, '127.0.0.1', () => {
      if (this.ended) { server.close(); return; }
      const port = (server.address() as { port: number }).port;
      const r = this.ready;
      this.ready = null;
      r?.resolve(port);
    });
  }

  private forward(sock: Socket): void {
    if (this.ended || this.allowed <= 0) { sock.destroy(); return; }
    this.allowed--;
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => undefined);
    sock.pause();
    this.client.forwardOut('127.0.0.1', 0, this.target.host, this.target.port, (err, stream) => {
      if (err || this.ended) { this.lastForwardFailed = true; sock.destroy(); try { stream?.close(); } catch { /* gone */ } return; }
      this.lastForwardFailed = false;
      stream.on('error', () => sock.destroy());
      stream.on('close', () => sock.destroy());
      sock.on('close', () => { try { stream.close(); } catch { /* gone */ } });
      sock.pipe(stream).pipe(sock);
      sock.resume();
    });
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
    try { this.server?.close(); } catch { /* closed */ }
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const error = this.requested ? undefined : this.error ?? this.login.override ?? 'reset';
    const r = this.ready;
    this.ready = null;
    if (r) r.reject(error ?? 'cancelled');
    this.events.ended(error);
  }

  /** Closes the tunnel (the database connections through it end with it). */
  close(): void {
    if (this.ended) return;
    this.requested = true;
    this.fail('cancelled');
  }
}
