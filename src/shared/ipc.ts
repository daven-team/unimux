// Messages between main ⇄ pty host (control) and renderer ⇄ pty host (data, via MessagePort).
import type { RemoteListResult } from './remotePaths';
import type { SshErrorCode, SshPhase } from './ssh';
import type { SshStatsRun } from './sshBar';
import type { ReplaySize } from './replay';
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
  /** SFTP sessions of a host with "Uruchamiaj SFTP przez sudo" (0.9.9): the server command runs on an exec channel. */
  sftpSudo?: { command?: string };
}

export type MainToHost =
  | { t: 'spawn'; req: SpawnRequest }
  | { t: 'kill'; id: string; ack?: boolean }
  | { t: 'killAll' }
  /** 1.0.6: the terminal's output goes to a detached window (null: back to the main window); that window gets its replay. */
  | { t: 'route'; id: string; window: string | null }
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
  | { t: 'sshAuthPrompt'; id: string; promptId: string; kind: 'password' | 'keyboard' | 'sudo'; name?: string; instructions?: string; fields: Array<{ text: string; echo: boolean }>; retry: boolean };

export type RendererToHost =
  /** `reply`: the terminal's own answer (device / focus / mouse report), not typing: it does not shorten the output window. */
  | { t: 'write'; id: string; data: string; reply?: boolean }
  | { t: 'resize'; id: string; cols: number; rows: number }
  /** The renderer finished parsing `chars` characters of output (flow control). */
  | { t: 'ack'; id: string; chars: number }
  /** The terminal with the keyboard focus (null: none); its output is coalesced with the short window. */
  | { t: 'focus'; id: string | null }
  /**
   * SSH path completion (1.0.6): list `dir` (as typed, relative to `cwd` or the shell's own folder) on the cell's own SSH
   * connection; `cwdOnly` asks only for the shell's folder. Answered with `sshListResult` and the same `reqId`.
   */
  | { t: 'sshList'; id: string; reqId: number; dir: string; cwd: string | null; cwdOnly?: boolean }
  /** SSH status bar (1.0.7): runs sshBar.barScript on the cell's own connection (`first`: also the system). Answered with `sshStatsResult`. */
  | { t: 'sshStats'; id: string; reqId: number; first: boolean };

export type HostToRenderer =
  | { t: 'data'; id: string; data: string }
  /** `sizes`: the pty sizes the output was written at, as offsets into `data` (see shared/replay). */
  | { t: 'replay'; id: string; data: string; sizes?: ReplaySize[] }
  | { t: 'exit'; id: string; code: number }
  | { t: 'sshListResult'; id: string; reqId: number; result: RemoteListResult }
  | { t: 'sshStatsResult'; id: string; reqId: number; result: SshStatsRun };

/** What travels on the port: single messages, or the output of several terminals flushed in the same tick ([id, data] pairs, in order). */
export type HostToRendererPort = HostToRenderer | { t: 'dataBatch'; items: Array<[string, string]> };

/** Unpacks a port message into the single messages the renderer handles. */
export function unpackHostMessage(m: HostToRendererPort): HostToRenderer[] {
  return m.t === 'dataBatch' ? m.items.map(([id, data]) => ({ t: 'data' as const, id, data })) : [m];
}
