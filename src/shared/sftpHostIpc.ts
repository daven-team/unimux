// Messages between main and the SFTP Host utility process (0.9.8). The login messages are the Pty Host's SSH ones, so the
// SSH coordinator in main drives an SFTP login exactly like a cell's. Transfer progress does not pass through main: it goes
// from the SFTP Host to the renderer over a transferred MessagePort (SftpPortMessage in shared/sftp.ts).
import type { HostToMain, MainToHost } from './ipc';
import type { ChmodRequest, ConflictAnswer, DeleteCount, SftpResult, TransferRequest } from './sftp';
import type { EditorSave } from './editorSource';

export type SftpOp =
  | { op: 'list'; path: string }
  | { op: 'stat'; path: string }
  | { op: 'realpath'; path: string }
  | { op: 'mkdir'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'deleteCount'; paths: string[] }
  | { op: 'delete'; paths: string[]; confirmed: DeleteCount }
  | { op: 'enqueue'; req: TransferRequest }
  | { op: 'cancel'; itemIds?: string[]; batchId?: string }
  | { op: 'answerConflict'; itemId: string; answer: ConflictAnswer }
  | { op: 'retry'; itemIds: string[] }
  | { op: 'clearFinished' }
  /** 0.9.9: permission changes and stopping a long operation by its op id. */
  | { op: 'chmodCount'; paths: string[]; recursive: boolean }
  | { op: 'chmod'; req: ChmodRequest }
  | { op: 'cancelOp'; opId: string }
  /** An editor tab (0.9.9): the file read into memory, and its text saved back through a part file. */
  | { op: 'readFile'; path: string }
  | { op: 'statFile'; path: string }
  | { op: 'writeFile'; path: string; save: EditorSave };

export type MainToSftpHost =
  /** Login of an SFTP session (secrets in memory only, never logged). */
  | Extract<MainToHost, { t: 'sshConnect' | 'sshHostKeyAnswer' | 'sshAuthAnswer' }>
  /** `id`: an "sftp:<uuid>" session, or LOCAL_QUEUE_ID for the local copy queue. */
  | { t: 'sftpOp'; reqId: number; id: string; op: SftpOp }
  | { t: 'sftpDisconnect'; id: string }
  | { t: 'shutdown' };

export type SftpHostToMain =
  | Extract<HostToMain, { t: 'sshStatus' | 'sshHostKey' | 'sshAuthPrompt' | 'log' }>
  | { t: 'sftpResult'; reqId: number; result: SftpResult<unknown> }
  /** The queue of `id` has (or no longer has) anything queued, running or waiting for a conflict answer. */
  | { t: 'sftpQueue'; id: string; active: boolean }
  | { t: 'shutdownDone' };
