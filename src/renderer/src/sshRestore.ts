// Settings > SSH > "Przywracaj sesje SSH po ponownym uruchomieniu" (1.0.6), the renderer side: the folder each SSH cell's
// shell is in is kept in the cell (cell.ssh.cwd), so a session restored at the next app start goes back into it. Main keeps
// whether the session was connected (cell.ssh.resume, src/main/index.ts) and types the `cd` after the restored login.
// The folder is looked up a moment after a login and after a command that may change it (cd, pushd, popd): from the
// shell's own OSC 7 report when it sends one, otherwise from the server (the shell process's folder, SshManager.list).
import { changesFolder } from '../../shared/remotePaths';
import { findCell, patchSshCell } from '../../shared/state';
import { getS, update } from './store';
import { terminals } from './terminals/TerminalManager';

/** After a login the shell (and a restored `cd`, typed once the shell went quiet) has settled by then. */
const AFTER_CONNECT_MS = 2500;
/** After Enter on a cd line the shell has run it by then. */
const AFTER_COMMAND_MS = 600;

const enabled = (): boolean => getS().settings.sshRestoreSessions === true;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function schedule(cellId: string, ms: number): void {
  if (!enabled()) return;
  clearTimeout(timers.get(cellId));
  timers.set(cellId, setTimeout(() => { timers.delete(cellId); void lookUp(cellId); }, ms));
}

async function lookUp(cellId: string): Promise<void> {
  if (!enabled() || !findCell(getS(), cellId)?.cell.ssh || terminals.remoteCwdForeign(cellId)) return;
  let cwd = terminals.remoteCwd(cellId) ?? null;
  if (!cwd) {
    const result = await terminals.sshList(cellId, { dir: '', cwd: null, cwdOnly: true });
    cwd = result.ok ? result.cwd : null;
  }
  if (!cwd || !enabled()) return;
  const s = getS();
  if (patchSshCell(s, cellId, { cwd }) !== s) update((st) => patchSshCell(st, cellId, { cwd }));
}

/** The cell's session has just connected. */
export function sessionConnected(cellId: string): void {
  schedule(cellId, AFTER_CONNECT_MS);
}

/** Enter sent `line` in the cell's shell (the autocomplete's follower saw it). */
export function lineSubmitted(cellId: string, line: string): void {
  if (changesFolder(line)) schedule(cellId, AFTER_COMMAND_MS);
}

/** The cell is gone or its session ended: no look-up is left waiting for it. */
export function forgetRestore(cellId: string): void {
  clearTimeout(timers.get(cellId));
  timers.delete(cellId);
}
