import { existsSync } from 'fs';
import { cleanEnv } from '../shared/env';
import { execCall, type ExecCall } from './offMainExec';

export interface CodexLaunch {
  /** The detected Codex binary or shim. */
  command?: string;
  env?: Record<string, string>;
  /** Replaceable in tests. */
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

/** How `codex queue` is started: the program, its arguments, extra environment and the time it may take. */
export type CodexQueueCall = ExecCall;

const QUEUE_SCRIPT = (target: string) =>
  `$ErrorActionPreference = 'Stop'; try { & ${target} queue --thread $env:UNIMUX_TARGET_SESSION --message $env:UNIMUX_TASK_MESSAGE; exit $LASTEXITCODE } catch { exit 1 }`;

/**
 * All user text travels in argv (no shell is involved) or in the environment (PowerShell), never in shell source.
 * Windows: the native installer's codex.exe is started directly (no PowerShell cold start); an npm install is reached through its
 * PowerShell shim (codex.ps1, also when the .cmd was detected: cmd.exe would parse the message), with this process's execution
 * policy bypassed so a Restricted machine policy does not refuse the shim.
 */
export function codexQueueCall(sessionId: string, message: string, launch: CodexLaunch = {}): CodexQueueCall {
  const platform = launch.platform ?? process.platform;
  const exists = launch.exists ?? existsSync;
  // `launch.env` carries a PATH that contains the detected binary (a GUI-launched app may not have codex on its own PATH).
  const base = launch.env ?? cleanEnv(process.env);
  const command = launch.command;
  if (platform !== 'win32') return { file: command ?? 'codex', args: ['queue', '--thread', sessionId, '--message', message], env: base, timeout: 15000 };
  if (command && /\.exe$/i.test(command)) return { file: command, args: ['queue', '--thread', sessionId, '--message', message], env: base, timeout: 10000 };
  const script = command ? command.replace(/\.(cmd|bat)$/i, '.ps1') : undefined;
  const shim = script && /\.ps1$/i.test(script) && exists(script) ? script : undefined;
  const env = { ...base, UNIMUX_TARGET_SESSION: sessionId, UNIMUX_TASK_MESSAGE: message, ...(shim ? { UNIMUX_CODEX_PATH: shim } : {}) };
  return {
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', QUEUE_SCRIPT(shim ? '$env:UNIMUX_CODEX_PATH' : 'codex')],
    env,
    timeout: 15000,
  };
}

/**
 * `run` starts the call and tells whether it succeeded; main passes execOffMain (a utility process starts codex.exe, see
 * offMainExec.ts), the default runs it in this process.
 */
export async function queueCodexMessage(sessionId: string, message: string, launch: CodexLaunch = {}, run: (call: ExecCall) => Promise<boolean> = execCall): Promise<void> {
  const ok = await run(codexQueueCall(sessionId, message, launch));
  if (!ok) throw new Error('Native Codex delivery failed. Check that this Codex version supports queue and the session is running. The item remains in the inbox.');
}
