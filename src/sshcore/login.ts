// The SSH login of one ssh2 Client, shared by the Pty Host (SSH cells) and the SFTP Host (0.9.8): the connect options, the
// host key callback (answered by main after its known-hosts check) and the auth handler (publickey, saved password, password
// and keyboard-interactive prompts answered by main). Independent of Electron so it is tested in Node.
// Secrets live in the request object only until dropSecrets(); they are never logged.
import { randomUUID } from 'crypto';
import type { ConnectConfig } from 'ssh2';
import type { SshConnectRequest } from '../shared/ipc';
import { sanitizeServerText, type SshErrorCode } from '../shared/ssh';
import { sshDebugFilter } from '../ptyhost/sshErrors';

export type SshAuthPromptInfo = { kind: 'password' | 'keyboard'; name?: string; instructions?: string; fields: Array<{ text: string; echo: boolean }>; retry: boolean };

export interface LoginTimers { authStepMs: number; keepaliveMs: number; keepaliveCountMax: number }

/** What the owner of the connection does for the login (its own timer, phase and the messages to main). */
export interface LoginHooks {
  /** False once the session ended or was replaced: every callback then refuses. */
  live(): boolean;
  arm(ms: number): void;
  disarm(): void;
  /** The phase moved on (the owner keeps it and reports it). */
  phase(phase: 'verifying' | 'authenticating'): void;
  hostKey(promptId: string, keyBase64: string): void;
  authPrompt(promptId: string, prompt: SshAuthPromptInfo): void;
  debug?(line: string): void;
}

type Step = 'publickey' | 'savedPassword';
type NextAuth = (method: unknown) => void;
const MAX_PROMPT_TRIES = 3;

export class SshLogin {
  /** Set when the user refused or cancelled: the error the session ends with, whatever ssh2 reports. */
  override: SshErrorCode | undefined;
  private steps: Step[];
  private passwordTries = 0;
  private keyboardTries = 0;
  private pendingHostKey: { promptId: string; verify: (ok: boolean) => void } | null = null;
  private pendingAuth: { promptId: string; answer: (values: string[] | null) => void } | null = null;

  /** `req` is the owner's own copy: dropSecrets() deletes the secrets from it. */
  constructor(private readonly req: SshConnectRequest, private readonly timers: LoginTimers, private readonly hooks: LoginHooks) {
    this.steps = [...(req.privateKey ? ['publickey' as const] : []), ...(req.password ? ['savedPassword' as const] : [])];
  }

  /** ssh2 connect options: no ready timeout (the owner's timers decide), keepalive, host verifier and auth handler. */
  connectConfig(): ConnectConfig {
    const keep = sshDebugFilter();
    return {
      host: this.req.host, port: this.req.port, username: this.req.username,
      readyTimeout: 0, keepaliveInterval: this.timers.keepaliveMs, keepaliveCountMax: this.timers.keepaliveCountMax, tryKeyboard: true,
      hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => { this.onHostKey(key, verify); }) as unknown as ConnectConfig['hostVerifier'],
      authHandler: ((methods: string[] | null, _partial: boolean, next: NextAuth) => { this.nextAuth(methods, next); }) as unknown as ConnectConfig['authHandler'],
      ...(this.req.debug ? { debug: (line: string) => { if (keep(line)) this.hooks.debug?.(line); } } : {}),
    };
  }

  private onHostKey(key: Buffer, verify: (ok: boolean) => void): void {
    if (!this.hooks.live()) { verify(false); return; }
    this.hooks.disarm();
    this.hooks.phase('verifying');
    const promptId = randomUUID();
    this.pendingHostKey = { promptId, verify };
    this.hooks.hostKey(promptId, key.toString('base64'));
  }

  answerHostKey(promptId: string, accept: boolean, error?: SshErrorCode): void {
    if (!this.pendingHostKey || this.pendingHostKey.promptId !== promptId || !this.hooks.live()) return;
    const { verify } = this.pendingHostKey;
    this.pendingHostKey = null;
    if (accept) {
      this.hooks.phase('authenticating');
      this.hooks.arm(this.timers.authStepMs);
    } else this.override = error ?? 'hostKeyRejected';
    verify(accept);
  }

  private nextAuth(methods: string[] | null, next: NextAuth): void {
    if (!this.hooks.live() || this.override) { next(false); return; }
    const req = this.req;
    const username = req.username;
    const allows = (method: string) => methods === null || methods.includes(method);
    while (this.steps.length) {
      const step = this.steps.shift()!;
      if (step === 'publickey' && req.privateKey && allows('publickey')) {
        this.hooks.arm(this.timers.authStepMs);
        next({ type: 'publickey', username, key: req.privateKey, ...(req.passphrase ? { passphrase: req.passphrase } : {}) });
        return;
      }
      if (step === 'savedPassword' && req.password && allows('password')) {
        this.hooks.arm(this.timers.authStepMs);
        next({ type: 'password', username, password: req.password });
        return;
      }
    }
    if (methods === null) { this.hooks.arm(this.timers.authStepMs); next({ type: 'none', username }); return; }
    if (methods.includes('password') && req.allowPasswordPrompt && this.passwordTries < MAX_PROMPT_TRIES) {
      this.passwordTries++;
      this.hooks.disarm();
      this.ask({ kind: 'password', fields: [], retry: this.passwordTries > 1 }, (values) => {
        if (!values) { this.override = 'cancelled'; next(false); return; }
        this.hooks.arm(this.timers.authStepMs);
        next({ type: 'password', username, password: values[0] ?? '' });
      });
      return;
    }
    if (methods.includes('keyboard-interactive') && this.keyboardTries < MAX_PROMPT_TRIES) {
      this.keyboardTries++;
      this.hooks.arm(this.timers.authStepMs);
      next({
        type: 'keyboard-interactive', username,
        prompt: (name: string, instructions: string, _lang: string, prompts: Array<{ prompt: string; echo?: boolean }>, finish: (answers: string[]) => void) => {
          if (!this.hooks.live() || !prompts.length) { finish([]); return; }
          this.hooks.disarm();
          this.ask({
            kind: 'keyboard', name: sanitizeServerText(name, 200), instructions: sanitizeServerText(instructions),
            fields: prompts.slice(0, 10).map((p) => ({ text: sanitizeServerText(p.prompt, 200), echo: p.echo === true })), retry: this.keyboardTries > 1,
          }, (values) => {
            if (!values) { this.override = 'cancelled'; finish([]); return; }
            this.hooks.arm(this.timers.authStepMs);
            finish(values);
          });
        },
      });
      return;
    }
    next(false);
  }

  private ask(prompt: SshAuthPromptInfo, answer: (values: string[] | null) => void): void {
    const promptId = randomUUID();
    this.pendingAuth = { promptId, answer };
    this.hooks.authPrompt(promptId, prompt);
  }

  answerAuth(promptId: string, values: string[] | null): void {
    if (!this.pendingAuth || this.pendingAuth.promptId !== promptId || !this.hooks.live()) return;
    const { answer } = this.pendingAuth;
    this.pendingAuth = null;
    answer(values === null ? null : values.map((v) => String(v)));
  }

  /** The session ends: an open host key question is refused (ssh2 may have given up already) and an auth question dropped. */
  abort(): void {
    if (this.pendingHostKey) { const { verify } = this.pendingHostKey; this.pendingHostKey = null; try { verify(false); } catch { /* ssh2 already gave up */ } }
    this.pendingAuth = null;
  }

  dropSecrets(): void {
    delete this.req.privateKey;
    delete this.req.passphrase;
    delete this.req.password;
  }
}
