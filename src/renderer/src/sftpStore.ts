// Renderer SFTP state (0.9.8): the one session of the SFTP view, its login prompt, the transfer queue from the SFTP Host's
// port and what the remote pane should show next. No imports of actions, files or terminals.
import { create } from 'zustand';
import type { SshPrompt } from '../../shared/ssh';
import type { SftpSessionState, TransferItem } from '../../shared/sftp';

interface SftpStore {
  /** The session the view shows (one at a time); null before the first connect and after a disconnect. */
  sessionId: string | null;
  hostId: string | null;
  session: SftpSessionState | null;
  prompt: SshPrompt | null;
  /** The host each session belongs to (for a retry of an item after an SFTP Host restart). */
  sessionHosts: Record<string, string>;
  /** Every item of every queue (sessions and local copies), in enqueue order. */
  transfers: TransferItem[];
  /** The host picker of the remote pane is open. */
  pickerOpen: boolean;
  /** A folder the remote pane should go to (set by "Otwórz SFTP tutaj" on the connected host); bumped by `seq`. */
  remoteGoto: { path: string; seq: number } | null;
}

export const useSftpStore = create<SftpStore>(() => ({
  sessionId: null, hostId: null, session: null, prompt: null, sessionHosts: {}, transfers: [], pickerOpen: false, remoteGoto: null,
}));
