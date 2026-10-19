// Messages between main and the DB Host utility process (1.0.0). The SSH tunnel's login messages are the Pty Host's SSH ones,
// so the SSH coordinator in main drives a tunnel login exactly like a cell's or an SFTP session's. Result rows do not pass
// through main: they go from the DB Host to the renderer over a transferred MessagePort (DbPortMessage in shared/db.ts).
import type { HostToMain, MainToHost } from './ipc';
import type {
  DbCellRequest, DbEditRequest, DbErrorCode, DbKind, DbObjectKind, DbPhase, DbQueryRequest, DbResult, DbTablePageRequest, DbTlsMode, DbTxStatus,
} from './db';

/** Everything the DB Host needs to open one session. Secrets (password) in memory only, never logged. */
export interface DbOpenConfig {
  kind: DbKind;
  /** Direct: the server. Through SSH: unused (the tunnel's local end is used). */
  host: string;
  port: number;
  user: string;
  database: string;
  tls: DbTlsMode;
  /** verify-full: the CA certificate text (main read the file). */
  ca?: string;
  /** The saved password; absent: asked for when the server wants one. */
  password?: string;
  readOnly: boolean;
  statementTimeoutMs?: number;
  /**
   * The database address as the SSH server sees it. Sessions of one connection share one tunnel (`tunnelKey`): the `owner`
   * opens it and its sshConnect follows; the others wait for it (and fail with 'tunnel' when there is none).
   */
  ssh: { dbHost: string; dbPort: number; tunnelKey: string; owner: boolean } | null;
}

export type DbHostOp =
  | { op: 'databases' }
  | { op: 'schemas' }
  | { op: 'objects'; schema: string }
  | { op: 'tableInfo'; schema: string; name: string }
  | { op: 'ddl'; schema: string; name: string; kind: DbObjectKind; args?: string }
  | { op: 'tablePage'; req: DbTablePageRequest }
  | { op: 'query'; req: DbQueryRequest }
  | { op: 'fetchMore'; queryId: string; count: number }
  | { op: 'closeResult'; queryId: string }
  | { op: 'cancel' }
  | { op: 'transaction'; action: 'begin' | 'commit' | 'rollback' }
  | { op: 'previewEdits'; req: DbEditRequest }
  | { op: 'applyEdits'; req: DbEditRequest }
  | { op: 'cellValue'; req: DbCellRequest };

export type MainToDbHost =
  /** Login of a session's SSH tunnel (secrets in memory only, never logged). */
  | Extract<MainToHost, { t: 'sshConnect' | 'sshHostKeyAnswer' | 'sshAuthAnswer' }>
  | { t: 'dbOpen'; id: string; config: DbOpenConfig }
  /** The database password the user typed (null: cancelled). */
  | { t: 'dbPasswordAnswer'; id: string; promptId: string; value: string | null }
  | { t: 'dbOp'; reqId: number; id: string; op: DbHostOp }
  | { t: 'dbClose'; id: string }
  | { t: 'shutdown' };

export type DbHostToMain =
  | Extract<HostToMain, { t: 'sshStatus' | 'sshHostKey' | 'sshAuthPrompt' | 'log' }>
  /** The session moved on (tunnel steps, database connect, connected, error, closed). `message`: the server's own text of an error. */
  | { t: 'dbStatus'; id: string; phase: DbPhase; error?: DbErrorCode; message?: string; serverVersion?: string; database?: string; tls?: boolean }
  /** The server asks for a password and none is saved (or the saved one was refused: retry). */
  | { t: 'dbPasswordPrompt'; id: string; promptId: string; retry: boolean }
  | { t: 'dbTx'; id: string; tx: DbTxStatus }
  /** The session runs something (busy) or is idle again: main's idle disconnect waits while it is busy. */
  | { t: 'dbActivity'; id: string; busy: boolean }
  | { t: 'dbResult'; reqId: number; result: DbResult<unknown> }
  | { t: 'shutdownDone' };
