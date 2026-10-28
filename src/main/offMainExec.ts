// One program run outside the main process (1.0.9). On Windows CreateProcess runs synchronously in the thread that calls it, and
// for a big binary (codex.exe is over 300 MB) it takes about 0.8 s while the image is mapped and scanned: started from main, that
// froze IPC, hooks and every window for each `codex queue`. A short-lived utility process (src/exechost) starts the program
// instead; forking it costs main about a millisecond. The program gets its arguments as an argv array, never through a shell.
import { execFile } from 'child_process';

/** A program with its argv, environment and time limit (ms). */
export interface ExecCall { file: string; args: string[]; env: Record<string, string>; timeout: number }

export type ExecHostRequest = { t: 'run'; call: ExecCall };
export type ExecHostReply = { t: 'done'; ok: boolean };

/** Output kept per stream; a program that prints more fails, as execFile's maxBuffer does. */
export const EXEC_MAX_BUFFER = 256 * 1024;
/** How long the utility process may take beyond the program's own timeout (its start, the reply) before it is killed. */
export const EXEC_HOST_GRACE_MS = 5000;

/** Runs the call in this process; true when the program exited with 0 in time. Never rejects. */
export function execCall(call: ExecCall): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(call.file, call.args, { env: call.env, windowsHide: true, timeout: call.timeout, maxBuffer: EXEC_MAX_BUFFER }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

/** What execOffMain needs of an Electron UtilityProcess. */
export interface ExecHostChild {
  postMessage(message: ExecHostRequest): void;
  on(event: 'message', listener: (message: ExecHostReply) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

/**
 * Runs the call in a utility process from `fork`; true when the program exited with 0 in time. A host that ends without an
 * answer, cannot be started or overruns the program's timeout by `graceMs` counts as a failure. Never rejects.
 */
export function execOffMain(call: ExecCall, fork: () => ExecHostChild, graceMs = EXEC_HOST_GRACE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ExecHostChild;
    try { child = fork(); } catch { resolve(false); return; }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), call.timeout + graceMs);
    child.on('message', (m) => { if (m && m.t === 'done') finish(m.ok === true); });
    child.on('exit', () => finish(false));
    try { child.postMessage({ t: 'run', call }); } catch { finish(false); }
  });
}
