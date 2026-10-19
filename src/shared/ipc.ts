// Messages between main ⇄ pty host (control) and renderer ⇄ pty host (data, via MessagePort).
import type { SshErrorCode, SshPhase } from './ssh';
import type { ShellKind } from './types';

export interface SpawnRequest {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  shell: ShellKind;
  /** Typed into the shell once it printed its first output (agent launch command). */
  command?: string;
  /** Also forward the output to the main process (only the install window, which parses an end marker). */
  tap?: boolean;
}

/** Main to Pty Host: everything ssh2 needs for one cell. Secrets are in memory only and dropped by the Pty Host once used. */
export interface SshConnectRequest {
  id: string;
  host: string;
  port: number;
  username: string;
  cols: number;
  rows: number;
  /** Private key text exactly as stored (OpenSSH, PEM or PPK v2). */
  privateKey?: string;
  passphrase?: string;
  /** Saved password, tried once before prompting. */
  password?: string;
  /** Already passed through startupInput(): typed once after the shell went quiet. */
  startup?: string;
  allowPasswordPrompt: boolean;
  /** Unpackaged runs with MC_SSH_DEBUG=1 only (main decides): ssh2 debug lines up to USERAUTH go to the console. */
  debug?: boolean;
}

export type MainToHost =
  | { t: 'spawn'; req: SpawnRequest }
  | { t: 'kill'; id: string; ack?: boolean }
  | { t: 'killAll' }
  | { t: 'sshConnect'; req: SshConnectRequest }
  | { t: 'sshHostKeyAnswer'; id: string; promptId: string; accept: boolean; error?: SshErrorCode }
  | { t: 'sshAuthAnswer'; id: string; promptId: string; values: string[] | null };

export type HostToMain =
  | { t: 'spawned'; id: string; pid: number }
  | { t: 'spawnError'; id: string; message: string }
  | { t: 'exit'; id: string; code: number }
  /** Output of a terminal spawned with `tap`. */
  | { t: 'tap'; id: string; data: string }
  /** The user typed Ctrl+C into a terminal spawned with `tap`. */
  | { t: 'interrupt'; id: string }
  | { t: 'killed'; id: string }
  | { t: 'killedAll' }
  /** An error inside the Pty Host for main's crash log: message and stack only, never a message payload (SSH secrets). */
  | { t: 'log'; level: 'error' | 'warn'; message: string }
  | { t: 'sshStatus'; id: string; phase: SshPhase; error?: SshErrorCode; exitCode?: number; banner?: string }
  /** `key` is the base64 raw public key blob the server presented. */
  | { t: 'sshHostKey'; id: string; promptId: string; key: string }
  | { t: 'sshAuthPrompt'; id: string; promptId: string; kind: 'password' | 'keyboard'; name?: string; instructions?: string; fields: Array<{ text: string; echo: boolean }>; retry: boolean };

export type RendererToHost =
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  /** The renderer finished parsing `chars` characters of output (flow control). */
  | { t: 'ack'; id: string; chars: number }
  /** The terminal with the keyboard focus (null: none); its output is coalesced with the short window. */
  | { t: 'focus'; id: string | null };

export type HostToRenderer =
  | { t: 'data'; id: string; data: string }
  | { t: 'replay'; id: string; data: string }
  | { t: 'exit'; id: string; code: number };

/** What travels on the port: single messages, or the output of several terminals flushed in the same tick ([id, data] pairs, in order). */
export type HostToRendererPort = HostToRenderer | { t: 'dataBatch'; items: Array<[string, string]> };

/** Unpacks a port message into the single messages the renderer handles. */
export function unpackHostMessage(m: HostToRendererPort): HostToRenderer[] {
  return m.t === 'dataBatch' ? m.items.map(([id, data]) => ({ t: 'data' as const, id, data })) : [m];
}
