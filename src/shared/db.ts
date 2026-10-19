// The database contract (1.0.0): saved connections (no secrets), sessions, results streamed over the DB port, metadata of
// Postgres, staged edits and the API the renderer uses. Shared by main, the DB Host and the renderer: no Node or DOM imports.
// Pure SQL helpers (quoting, splitting, edits, paging, value formatting) live in dbSql.ts.
import type { MessageKey } from './i18n';
import { addressProblem, isUuid, normalizeAddress, sshErrorText, type Localized, type SshErrorCode, type SshPrompt } from './ssh';
import type { DbRedisApi, RedisPortMessage } from './dbRedis';

// ── ids and limits ──────────────────────────────────────────────────────────

/** DB sessions live in their own namespace next to cells and SFTP sessions: "db:<uuid>". */
export const DB_SESSION_PREFIX = 'db:';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID = new RegExp(`^db:${UUID}$`, 'i');
export const dbSessionId = (uuid: string): string => `${DB_SESSION_PREFIX}${uuid}`;
export const isDbSessionId = (id: unknown): id is string => typeof id === 'string' && SESSION_ID.test(id);

export const DB_LIMITS = {
  connections: 500, name: 80, group: 60, host: 253, user: 128, database: 63, password: 4096, caPath: 4096, caBytes: 1024 * 1024,
  /** A statement timeout above a day is a typo. */
  statementTimeoutMaxMs: 24 * 3600_000,
  /** Rows a query result shows before "load more" (the default and the most one request may ask for). */
  rowCap: 1000, rowCapMax: 100_000,
  pageSizes: [100, 500, 1000] as readonly number[],
  /** A cell longer than this (characters of its text form) arrives truncated; cellValue reads it whole up to fullValueChars. */
  cellChars: 64 * 1024, fullValueChars: 16 * 1024 * 1024,
  /** One rows message carries at most this many rows or about this many characters. */
  chunkRows: 500, chunkChars: 2 * 1024 * 1024,
  sql: 8 * 1024 * 1024, filter: 64 * 1024, identifier: 1024, edits: 5000, sortColumns: 16, serverText: 4000,
  /** A session nobody pinned is disconnected after this long without an operation. */
  idleMs: 5 * 60_000,
} as const;

// ── connections ─────────────────────────────────────────────────────────────

export type DbKind = 'postgres' | 'redis';
export const DB_KINDS: readonly DbKind[] = ['postgres', 'redis'];
export const DB_DEFAULT_PORT: Record<DbKind, number> = { postgres: 5432, redis: 6379 };
/** disable: plain; prefer: TLS when the server offers it; require: TLS without certificate checks; verify-full: TLS checked against `caPath` and the host name. */
export type DbTlsMode = 'disable' | 'prefer' | 'require' | 'verify-full';
export const DB_TLS_MODES: readonly DbTlsMode[] = ['disable', 'prefer', 'require', 'verify-full'];

/** Through a saved SSH host: the database address as the server sees it (usually 127.0.0.1 and the default port). */
export interface DbSshTunnel { hostId: string; dbHost: string; dbPort: number }

/** A saved connection in state.json. The password is never here: it lives in <data>/db/vault.json (DbVault, main only). */
export interface DbConnection {
  id: string;
  kind: DbKind;
  name: string;
  color?: string;
  group?: string;
  /** Without a tunnel: where the app connects. With one: unused by the connection (kept for the form). */
  host: string;
  port: number;
  /** Postgres role; Redis ACL user (empty: the default user). */
  user: string;
  /** Postgres: the database the connection opens (default "postgres"). */
  database?: string;
  /** Redis: the DB index (default 0). */
  dbIndex?: number;
  tls: DbTlsMode;
  /** verify-full: the CA certificate file (PEM) on this computer. */
  caPath?: string;
  ssh: DbSshTunnel | null;
  /** No edits and no data-changing statements unless the user overrides it for one run. */
  readOnly: boolean;
  /** Postgres: the session's statement_timeout (absent: the server's). */
  statementTimeoutMs?: number;
  createdAt: number;
  updatedAt: number;
}

/** What the connection editor saves (main assigns the id on create and the timestamps). */
export type DbConnectionInput = Omit<DbConnection, 'id' | 'createdAt' | 'updatedAt'>;
/** The password part of a save: keep what the vault has, store a new one, or forget it. */
export type DbPasswordChange = { keep: true } | { set: string } | { clear: true };

const CONTROL = /[\u0000-\u001f\u007f]/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const stamp = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
const cleanText = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && t.length <= max && !CONTROL.test(t) ? t : undefined;
};
const validHost = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const address = normalizeAddress(raw);
  return addressProblem(address) ? null : address;
};
const validUser = (v: unknown): v is string => typeof v === 'string' && v.length <= DB_LIMITS.user && !CONTROL.test(v) && v.trim() === v;
const validDatabase = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= DB_LIMITS.database && !CONTROL.test(v);
export const validCaPath = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= DB_LIMITS.caPath && !CONTROL.test(v);

/**
 * A connection read from disk or sent by the renderer, or null when it cannot be used. Unknown fields are dropped; a bad
 * optional field falls back to its default.
 */
export function normalizeDbConnection(raw: unknown): DbConnection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isUuid(r.id) || !DB_KINDS.includes(r.kind as DbKind)) return null;
  const kind = r.kind as DbKind;
  const host = validHost(r.host);
  if (!host) return null;
  const user = typeof r.user === 'string' ? r.user.trim() : '';
  if (!validUser(user) || (kind === 'postgres' && !user)) return null;
  const c: DbConnection = {
    id: r.id, kind, name: cleanText(r.name, DB_LIMITS.name) ?? host, host, port: isPort(r.port) ? r.port : DB_DEFAULT_PORT[kind], user,
    tls: DB_TLS_MODES.includes(r.tls as DbTlsMode) ? r.tls as DbTlsMode : kind === 'postgres' ? 'prefer' : 'disable',
    ssh: null, readOnly: r.readOnly === true, createdAt: stamp(r.createdAt), updatedAt: stamp(r.updatedAt),
  };
  if (typeof r.color === 'string' && HEX_COLOR.test(r.color)) c.color = r.color;
  const group = cleanText(r.group, DB_LIMITS.group);
  if (group) c.group = group;
  if (kind === 'postgres') c.database = validDatabase(r.database) ? r.database : 'postgres';
  if (kind === 'redis') c.dbIndex = typeof r.dbIndex === 'number' && Number.isInteger(r.dbIndex) && r.dbIndex >= 0 && r.dbIndex <= 10_000 ? r.dbIndex : 0;
  if (c.tls === 'verify-full') {
    if (validCaPath(r.caPath)) c.caPath = r.caPath;
    else c.tls = 'require';
  }
  const ssh = r.ssh as Record<string, unknown> | null | undefined;
  if (ssh && typeof ssh === 'object' && isUuid(ssh.hostId)) {
    const dbHost = validHost(ssh.dbHost);
    if (dbHost) c.ssh = { hostId: ssh.hostId, dbHost, dbPort: isPort(ssh.dbPort) ? ssh.dbPort : DB_DEFAULT_PORT[kind] };
  }
  if (kind === 'postgres' && typeof r.statementTimeoutMs === 'number' && Number.isInteger(r.statementTimeoutMs) && r.statementTimeoutMs > 0 && r.statementTimeoutMs <= DB_LIMITS.statementTimeoutMaxMs) {
    c.statementTimeoutMs = r.statementTimeoutMs;
  }
  return c;
}

export function normalizeDbConnections(raw: unknown): DbConnection[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DbConnection[] = [];
  for (const entry of raw) {
    const c = normalizeDbConnection(entry);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= DB_LIMITS.connections) break;
  }
  return out;
}

/** The connection form as typed (strings), turned into an input or field errors. */
export interface DbConnectionDraft {
  kind: DbKind; name: string; color?: string; group: string; host: string; port: string; user: string; database: string; dbIndex: string;
  tls: DbTlsMode; caPath: string; sshHostId: string | null; sshDbHost: string; sshDbPort: string; readOnly: boolean;
  /** Seconds; empty: the server's default. */
  statementTimeout: string;
}
export type DbDraftField = 'host' | 'port' | 'user' | 'database' | 'dbIndex' | 'caPath' | 'sshDbHost' | 'sshDbPort' | 'statementTimeout';
export type DbDraftResult = { ok: true; value: DbConnectionInput } | { ok: false; errors: Partial<Record<DbDraftField, MessageKey>> };

export function dbConnectionToDraft(c?: DbConnection, kind: DbKind = c?.kind ?? 'postgres'): DbConnectionDraft {
  return {
    kind, name: c?.name ?? '', color: c?.color, group: c?.group ?? '', host: c?.host ?? (c?.ssh ? '' : 'localhost'), port: String(c?.port ?? DB_DEFAULT_PORT[kind]),
    user: c?.user ?? (kind === 'postgres' ? 'postgres' : ''), database: c?.database ?? 'postgres', dbIndex: String(c?.dbIndex ?? 0),
    tls: c?.tls ?? (kind === 'postgres' ? 'prefer' : 'disable'), caPath: c?.caPath ?? '', sshHostId: c?.ssh?.hostId ?? null,
    sshDbHost: c?.ssh?.dbHost ?? '127.0.0.1', sshDbPort: String(c?.ssh?.dbPort ?? DB_DEFAULT_PORT[kind]), readOnly: c?.readOnly === true,
    statementTimeout: c?.statementTimeoutMs ? String(c.statementTimeoutMs / 1000) : '',
  };
}

const parsePort = (text: string, fallback: number): number | null => {
  const t = text.trim();
  if (t === '') return fallback;
  const n = Number(t);
  return /^\d+$/.test(t) && isPort(n) ? n : null;
};

export function validateDbDraft(d: DbConnectionDraft): DbDraftResult {
  const errors: Partial<Record<DbDraftField, MessageKey>> = {};
  const tunnel = d.sshHostId !== null && isUuid(d.sshHostId);
  // With a tunnel the host field is not used: it keeps what was typed when valid, else a placeholder.
  const host = validHost(d.host) ?? (tunnel ? 'localhost' : null);
  if (!host) errors.host = d.host.trim() ? 'Nieprawidłowy adres hosta' : 'Podaj adres hosta';
  const port = parsePort(d.port, DB_DEFAULT_PORT[d.kind]);
  if (port === null) errors.port = 'Nieprawidłowy port';
  const user = d.user.trim();
  if (!validUser(user) || (d.kind === 'postgres' && !user)) errors.user = 'Podaj nazwę użytkownika';
  const database = d.database.trim() || 'postgres';
  if (d.kind === 'postgres' && !validDatabase(database)) errors.database = 'Nieprawidłowa nazwa bazy danych';
  const dbIndex = d.dbIndex.trim() === '' ? 0 : Number(d.dbIndex.trim());
  if (d.kind === 'redis' && !(/^\d+$/.test(d.dbIndex.trim() || '0') && Number.isInteger(dbIndex) && dbIndex <= 10_000)) errors.dbIndex = 'Nieprawidłowy numer bazy';
  const caPath = d.caPath.trim();
  if (d.tls === 'verify-full' && !validCaPath(caPath)) errors.caPath = 'Wybierz plik certyfikatu CA';
  let ssh: DbSshTunnel | null = null;
  if (tunnel) {
    const dbHost = validHost(d.sshDbHost.trim() || '127.0.0.1');
    if (!dbHost) errors.sshDbHost = 'Nieprawidłowy adres hosta';
    const dbPort = parsePort(d.sshDbPort, DB_DEFAULT_PORT[d.kind]);
    if (dbPort === null) errors.sshDbPort = 'Nieprawidłowy port';
    if (dbHost && dbPort !== null) ssh = { hostId: d.sshHostId!, dbHost, dbPort };
  }
  let statementTimeoutMs: number | undefined;
  const st = d.statementTimeout.trim().replace(',', '.');
  if (d.kind === 'postgres' && st) {
    const seconds = Number(st);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds * 1000 > DB_LIMITS.statementTimeoutMaxMs) errors.statementTimeout = 'Nieprawidłowy limit czasu';
    else if (seconds > 0) statementTimeoutMs = Math.max(1, Math.round(seconds * 1000));
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const value: DbConnectionInput = {
    kind: d.kind, name: clip(d.name.trim(), DB_LIMITS.name) || (ssh ? ssh.dbHost : host!), host: host!, port: port!, user,
    tls: d.tls, ssh, readOnly: d.readOnly,
  };
  if (d.color && HEX_COLOR.test(d.color)) value.color = d.color;
  const group = clip(d.group.trim(), DB_LIMITS.group);
  if (group && !CONTROL.test(group)) value.group = group;
  if (d.kind === 'postgres') value.database = database;
  if (d.kind === 'redis') value.dbIndex = dbIndex;
  if (d.tls === 'verify-full') value.caPath = caPath;
  if (statementTimeoutMs) value.statementTimeoutMs = statementTimeoutMs;
  return { ok: true, value };
}

/** "user@host:port/db" or, through SSH, "user@dbHost:dbPort/db via <ssh label>" (the label is added by the caller). */
export function dbEndpoint(c: Pick<DbConnection, 'kind' | 'host' | 'port' | 'ssh' | 'database' | 'dbIndex'>): string {
  const host = c.ssh ? c.ssh.dbHost : c.host;
  const port = c.ssh ? c.ssh.dbPort : c.port;
  const h = host.includes(':') ? `[${host}]` : host;
  return `${h}:${port}/${c.kind === 'postgres' ? c.database ?? 'postgres' : String(c.dbIndex ?? 0)}`;
}

// ── state edits ─────────────────────────────────────────────────────────────

export interface DbStateLike { dbConnections?: DbConnection[] }

export function upsertDbConnection<S extends DbStateLike>(s: S, c: DbConnection): S {
  const list = s.dbConnections ?? [];
  const at = list.findIndex((x) => x.id === c.id);
  return { ...s, dbConnections: at < 0 ? [...list, c] : list.map((x, i) => (i === at ? c : x)) };
}

export const removeDbConnection = <S extends DbStateLike>(s: S, id: string): S => ({ ...s, dbConnections: (s.dbConnections ?? []).filter((c) => c.id !== id) });

/** A copy right after the original, named "<name> (2)" (the first free number). */
export function duplicateDbConnection<S extends DbStateLike>(s: S, id: string, newId: string, now: number): S {
  const list = s.dbConnections ?? [];
  const source = list.find((c) => c.id === id);
  if (!source) return s;
  const names = new Set(list.map((c) => c.name));
  let n = 2;
  while (names.has(`${source.name} (${n})`)) n++;
  const copy: DbConnection = { ...source, ...(source.ssh ? { ssh: { ...source.ssh } } : {}), id: newId, name: clip(`${source.name} (${n})`, DB_LIMITS.name), createdAt: now, updatedAt: now };
  const at = list.indexOf(source) + 1;
  return { ...s, dbConnections: [...list.slice(0, at), copy, ...list.slice(at)] };
}

// ── sessions ────────────────────────────────────────────────────────────────

export type DbSessionStatus = 'connecting' | 'connected' | 'error' | 'closed';
/**
 * The step a session is at: the SSH tunnel's login steps (connecting, verifying, authenticating), then the database's own
 * connect ("database"), then connected; error and closed end it.
 */
export type DbPhase = 'connecting' | 'verifying' | 'authenticating' | 'database' | 'connected' | 'error' | 'closed';
export const isLiveDbPhase = (p: DbPhase): boolean => p !== 'error' && p !== 'closed';
export const dbStatusOf = (p: DbPhase): DbSessionStatus => (p === 'connected' ? 'connected' : p === 'error' ? 'error' : p === 'closed' ? 'closed' : 'connecting');
/** idle: auto-commit; transaction: inside BEGIN; failed: inside a transaction that failed (only ROLLBACK works). */
export type DbTxStatus = 'idle' | 'transaction' | 'failed';

export type DbErrorCode = SshErrorCode
  /** The DB Host restarted; the saved connection or its SSH host is gone; this kind of database is not supported. */
  | 'dbHostCrashed' | 'connectionMissing' | 'unsupported'
  /** Connecting: wrong password or role, refused, unknown host, timeout, TLS failed, TLS needed but off, no such database, the CA file. */
  | 'dbAuth' | 'dbRefused' | 'dbDns' | 'dbTimeout' | 'dbTls' | 'dbTlsUnsupported' | 'dbNoDatabase' | 'caFile' | 'tunnel'
  /** The server closed the connection; anything else. */
  | 'dbClosed' | 'dbFailed'
  /** Operations: the connection is read-only, a transaction is open, no such session, not connected yet, a bad request. */
  | 'readOnly' | 'inTransaction' | 'noSession' | 'notConnected' | 'invalid'
  /** Edits: the table has no primary or unique not-null key; a row changed or vanished meanwhile (rolled back); not found. */
  | 'noKey' | 'conflict' | 'notFound'
  /** The server refused a statement (`server` has its message); the statement timeout hit. */
  | 'server' | 'statementTimeout'
  /**
   * Redis: the new key name exists (rename, create); the key holds another type; the command needs the user's confirmation
   * (dangerous); it blocks the connection or subscribes (use Pub/Sub); it would break the session's connection or is a
   * transaction (not in the console); a pattern delete's count token is unknown or used.
   */
  | 'keyExists' | 'wrongType' | 'needsConfirm' | 'blockingCommand' | 'subscribeCommand' | 'consoleUnsupported' | 'staleToken';

/** The server's own error, as Postgres reports it (never translated; capped). */
export interface DbServerError {
  message: string;
  /** SQLSTATE, e.g. 42P01. */
  code?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  /** 1-based character position in the statement. */
  position?: number;
  schema?: string; table?: string; column?: string; constraint?: string;
}

export type DbResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DbErrorCode; server?: DbServerError; /** Edits: the staged edit that failed (0-based). */ index?: number };

export interface DbSessionState {
  id: string;
  connectionId: string;
  kind: DbKind;
  state: DbSessionStatus;
  phase: DbPhase;
  since: number;
  error?: DbErrorCode;
  /** The server's text for a connect error (e.g. "password authentication failed for user ..."). */
  message?: string;
  /** The database the session is on (Postgres), or the DB index as text (Redis: "0", changes with select). */
  database?: string;
  /** Redis: the connection dropped and the host is trying again (attempt 1..REDIS_LIMITS.reconnectAttempts); absent once connected. */
  reconnecting?: number;
  serverVersion?: string;
  readOnly: boolean;
  tx?: DbTxStatus;
  /** A "Test connection" session (ends by itself). */
  test?: true;
}

/** A prompt of a DB session: the SSH tunnel's (host key, passphrase, password, keyboard) or the database password. */
export type DbPrompt = SshPrompt
  | { id: string; kind: 'dbPassword'; connectionName: string; user: string; endpoint: string; canSave: boolean; retry: boolean };

export type DbPromptAnswer =
  | { sessionId: string; promptId: string; cancel: true }
  /** `remember`: save the typed password (SSH password or DB password) once the login worked. */
  | { sessionId: string; promptId: string; values: string[]; remember?: boolean }
  | { sessionId: string; promptId: string; hostKey: 'once' | 'save' | 'replace' };

export interface DbSnapshot { sessions: DbSessionState[]; prompts: Array<{ sessionId: string; prompt: DbPrompt }> }

export interface DbVaultInfo {
  storage: 'dpapi' | 'keychain' | 'unavailable';
  /** Connections with a saved password, and those whose password cannot be decrypted on this computer. */
  saved: string[];
  locked: string[];
  readOnly: boolean;
}

export type DbTestResult = { ok: true; serverVersion?: string; timeMs: number } | { ok: false; error: DbErrorCode; message?: string };

// ── values and results ──────────────────────────────────────────────────────

/** How a column's values are shown and edited (from the type OID and category). */
export type DbValueKind = 'text' | 'int' | 'bigint' | 'float' | 'numeric' | 'bool' | 'json' | 'bytea' | 'uuid'
  | 'date' | 'time' | 'timestamp' | 'timestamptz' | 'interval' | 'array' | 'enum' | 'other';

/** A value too long to send whole: its start and full length in characters (cellValue reads it). */
export interface DbTruncated { t: 'trunc'; head: string; chars: number }
/**
 * One cell: null is SQL NULL; anything else is Postgres's text form exactly as the server sent it (bigint and numeric keep
 * every digit, bytea is "\x" hex, booleans "t"/"f", dates in the server's DateStyle, json as text, arrays as "{...}").
 */
export type DbValue = string | null | DbTruncated;
export const isTruncated = (v: DbValue): v is DbTruncated => typeof v === 'object' && v !== null;

export interface DbColumn {
  name: string;
  typeOid: number;
  /** format_type of the column (e.g. "character varying", "integer[]"). */
  typeName: string;
  kind: DbValueKind;
  /** The table column this result column comes from, when the server says so. */
  tableOid?: number;
  columnNumber?: number;
}

export interface DbQueryRequest {
  /** Chosen by the renderer (a UUID); every port message of the run carries it. */
  queryId: string;
  /** One statement or a script: the host splits it (quotes, dollar quoting and comments respected) and runs the statements in order. */
  sql: string;
  /** Rows sent per result before "load more" (default DB_LIMITS.rowCap). */
  rowCap?: number;
  /** For this run only; null: the connection's setting. */
  statementTimeoutMs?: number | null;
  /** A read-only connection runs this one run with writes allowed (the explicit override). */
  readWrite?: boolean;
  /** Go on with the next statement after an error (default: stop). */
  continueOnError?: boolean;
}

export interface DbSort { column: string; desc: boolean }

export interface DbTablePageRequest {
  queryId: string;
  schema: string;
  table: string;
  limit: number;
  /** Offset paging (any sort). */
  offset?: number;
  /** Keyset paging: the edit key values of the last row shown (only when sorted by the key or not sorted). */
  after?: string[];
  sort?: DbSort[];
  /** A WHERE condition typed by the user, run as is inside a READ ONLY transaction. */
  filter?: string;
}

/** Messages of the DB port (DB Host -> renderer). The rows of every query, table page and "load more" arrive here only. */
export type DbPortMessage =
  /** A statement of the run started; start/end: its place in the submitted text. */
  | { t: 'statement'; queryId: string; index: number; start: number; end: number }
  | { t: 'columns'; queryId: string; index: number; columns: DbColumn[] }
  | { t: 'rows'; queryId: string; index: number; rows: DbValue[][] }
  /**
   * The statement finished (or the next page of it arrived). command: "SELECT", "UPDATE" ...; rowCount: the server's count
   * (affected rows, or rows read so far); hasMore: more rows wait on the server (fetchMore).
   */
  | { t: 'statementEnd'; queryId: string; index: number; command: string; rowCount: number | null; rows: number; hasMore: boolean; timeMs: number }
  | { t: 'statementError'; queryId: string; index: number; error: DbErrorCode; server?: DbServerError; timeMs: number }
  /** NOTICE / WARNING lines of the server during the run. */
  | { t: 'notice'; queryId: string; message: string; severity?: string }
  /** The run ended: tx is the session's transaction state after it. */
  | { t: 'queryEnd'; queryId: string; ok: boolean; cancelled: boolean; timeMs: number; tx: DbTxStatus }
  /** A result's open cursor was closed (another operation needed the connection): no more rows for it. */
  | { t: 'resultClosed'; queryId: string; index: number }
  /** Redis Pub/Sub messages and subscriber state (keyed by sessionId, not queryId). */
  | RedisPortMessage;

// ── metadata ────────────────────────────────────────────────────────────────

export interface DbDatabaseInfo { name: string; owner: string; encoding: string; isTemplate: boolean; allowConnections: boolean; sizeBytes: number | null; comment?: string }
export interface DbSchemaInfo { name: string; owner: string; system: boolean; comment?: string }
export type DbObjectKind = 'table' | 'partitioned' | 'view' | 'matview' | 'foreign' | 'sequence' | 'function' | 'procedure';
export interface DbObjectInfo {
  schema: string;
  name: string;
  kind: DbObjectKind;
  oid: number;
  /** Tables and materialized views: pg_class.reltuples (null: never analyzed). */
  rowEstimate?: number | null;
  /** Functions and procedures: the argument list (functions may be overloaded) and the result type. */
  args?: string;
  returns?: string;
  comment?: string;
}
export interface DbColumnInfo {
  name: string;
  position: number;
  typeName: string;
  typeOid: number;
  kind: DbValueKind;
  nullable: boolean;
  default: string | null;
  identity: boolean;
  generated: boolean;
  comment?: string;
}
export interface DbIndexInfo { name: string; definition: string; unique: boolean; primary: boolean; columns: string[] }
/** p primary key, u unique, f foreign key, c check, x exclusion, n not null (Postgres 18). */
export interface DbConstraintInfo { name: string; type: 'p' | 'u' | 'f' | 'c' | 'x' | 'n' | 't'; definition: string; columns: string[] }
export interface DbTableInfo {
  schema: string;
  name: string;
  kind: DbObjectKind;
  oid: number;
  rowEstimate: number | null;
  columns: DbColumnInfo[];
  primaryKey: string[] | null;
  /** Unique constraints and unique indexes whose columns are all NOT NULL (usable to identify a row). */
  uniqueKeys: string[][];
  /** The key edits use: the primary key, else the first unique not-null key; null: the table cannot be edited. */
  editKey: string[] | null;
  indexes: DbIndexInfo[];
  constraints: DbConstraintInfo[];
  comment?: string;
}

// ── staged edits ────────────────────────────────────────────────────────────

/** A key value or a new value: the text form (as cells arrive), null for SQL NULL. Keys are never null. */
export type DbStagedEdit =
  | { op: 'update'; key: Record<string, string>; set: Record<string, string | null> }
  | { op: 'insert'; values: Record<string, string | null> }
  | { op: 'delete'; key: Record<string, string> };

export interface DbEditRequest { schema: string; table: string; edits: DbStagedEdit[] }
export interface DbEditPreview { sql: string; statements: number }
export interface DbCellRequest { schema: string; table: string; key: Record<string, string>; column: string }

// ── API (window.mc.db) ──────────────────────────────────────────────────────

export interface DbPgApi {
  databases(sessionId: string): Promise<DbResult<DbDatabaseInfo[]>>;
  schemas(sessionId: string): Promise<DbResult<DbSchemaInfo[]>>;
  objects(sessionId: string, schema: string): Promise<DbResult<DbObjectInfo[]>>;
  tableInfo(sessionId: string, schema: string, name: string): Promise<DbResult<DbTableInfo>>;
  /** CREATE statement of a table, view, materialized view, sequence or function (`args` picks an overload). */
  ddl(sessionId: string, schema: string, name: string, kind: DbObjectKind, args?: string): Promise<DbResult<string>>;
  /** Starts a page; rows arrive on the DB port. Answers once the host accepted it. */
  tablePage(sessionId: string, req: DbTablePageRequest): Promise<DbResult<true>>;
  /** Starts a run; results arrive on the DB port. Answers once the host accepted it. */
  query(sessionId: string, req: DbQueryRequest): Promise<DbResult<true>>;
  /** The next rows of a result with hasMore (count up to DB_LIMITS.rowCapMax). */
  fetchMore(sessionId: string, queryId: string, count: number): Promise<DbResult<true>>;
  /** Drops a result's open cursor. */
  closeResult(sessionId: string, queryId: string): Promise<DbResult<true>>;
  /** Cancels the running statement (pg_cancel_backend on a side connection) and the rest of its run. */
  cancel(sessionId: string): Promise<DbResult<boolean>>;
  /** BEGIN / COMMIT / ROLLBACK of the explicit transaction mode. */
  transaction(sessionId: string, action: 'begin' | 'commit' | 'rollback'): Promise<DbResult<DbTxStatus>>;
  previewEdits(sessionId: string, req: DbEditRequest): Promise<DbResult<DbEditPreview>>;
  /** Runs the edits in one transaction; an UPDATE or DELETE that hits no row rolls everything back ('conflict', index). */
  applyEdits(sessionId: string, req: DbEditRequest): Promise<DbResult<{ affected: number }>>;
  /** A whole cell value (up to DB_LIMITS.fullValueChars) by the row's edit key. */
  cellValue(sessionId: string, req: DbCellRequest): Promise<DbResult<string | null>>;
}

export interface DbApi {
  /** Saves a new connection (no id) or changes one; the password goes to the DB vault. */
  saveConnection(input: DbConnectionInput & { id?: string }, password: DbPasswordChange): Promise<{ ok: true; connection: DbConnection } | { ok: false; error: 'invalid' | 'notFound' | 'readOnly' | 'failed' }>;
  deleteConnection(id: string): Promise<{ ok: boolean }>;
  duplicateConnection(id: string): Promise<{ ok: true; connection: DbConnection } | { ok: false }>;
  /** Connects with the form's values (password: typed, the saved one of a connection, or none) and disconnects again. */
  testConnection(input: DbConnectionInput, password: { set: string } | { saved: string } | null): Promise<DbTestResult>;
  vaultInfo(): Promise<DbVaultInfo>;
  /** Answers at once with the session id; 'db:session' and 'db:prompt' events follow. `database`: another database of the server. */
  connect(connectionId: string, opts?: { database?: string }): Promise<{ ok: true; sessionId: string } | { ok: false; error: DbErrorCode }>;
  disconnect(sessionId: string): Promise<{ ok: boolean }>;
  sessions(): Promise<DbSnapshot>;
  answer(answer: DbPromptAnswer): Promise<{ ok: boolean }>;
  /** The sessions open tabs use: they are never disconnected for being idle. Replaces the previous list. */
  pin(sessionIds: string[]): void;
  pg: DbPgApi;
  redis: DbRedisApi;
}

// ── texts ───────────────────────────────────────────────────────────────────

/** The text of an error; SSH codes of a tunnel read like an SSH cell's (`ssh`: the SSH host's name and endpoint). */
export function dbErrorText(code: DbErrorCode, ssh: { host: string; endpoint: string } = { host: '', endpoint: '' }): Localized {
  switch (code) {
    case 'dbHostCrashed': return { key: 'Proces baz danych został uruchomiony ponownie' };
    case 'connectionMissing': return { key: 'To połączenie zostało usunięte' };
    case 'unsupported': return { key: 'Ten rodzaj bazy nie jest jeszcze obsługiwany' };
    case 'dbAuth': return { key: 'Logowanie do bazy nie powiodło się - sprawdź użytkownika i hasło' };
    case 'dbRefused': return { key: 'Serwer bazy odrzucił połączenie' };
    case 'dbDns': return { key: 'Nie znaleziono serwera bazy' };
    case 'dbTimeout': return { key: 'Serwer bazy nie odpowiada' };
    case 'dbTls': return { key: 'Nie udało się nawiązać połączenia TLS z bazą' };
    case 'dbTlsUnsupported': return { key: 'Serwer bazy nie obsługuje TLS' };
    case 'dbNoDatabase': return { key: 'Ta baza danych nie istnieje' };
    case 'caFile': return { key: 'Nie można odczytać pliku certyfikatu CA' };
    case 'tunnel': return { key: 'Tunel SSH nie mógł połączyć się z bazą' };
    case 'dbClosed': return { key: 'Serwer bazy zamknął połączenie' };
    case 'dbFailed': return { key: 'Operacja na bazie nie powiodła się' };
    case 'readOnly': return { key: 'To połączenie jest tylko do odczytu' };
    case 'inTransaction': return { key: 'Najpierw zakończ otwartą transakcję' };
    case 'noSession': case 'notConnected': return { key: 'Brak połączenia z bazą' };
    case 'invalid': return { key: 'Nieprawidłowe żądanie' };
    case 'noKey': return { key: 'Tabela nie ma klucza głównego ani unikalnego - edycja jest wyłączona' };
    case 'conflict': return { key: 'Wiersz zmienił się w międzyczasie - zmiany wycofano' };
    case 'notFound': return { key: 'Nie znaleziono obiektu' };
    case 'server': return { key: 'Serwer bazy zgłosił błąd' };
    case 'statementTimeout': return { key: 'Przekroczono limit czasu zapytania' };
    case 'keyExists': return { key: 'Klucz o tej nazwie już istnieje' };
    case 'wrongType': return { key: 'Klucz ma inny typ niż oczekiwany' };
    case 'needsConfirm': return { key: 'To polecenie wymaga potwierdzenia' };
    case 'blockingCommand': return { key: 'Polecenia blokujące połączenie nie działają w konsoli' };
    case 'subscribeCommand': return { key: 'Subskrypcje działają w zakładce Pub/Sub, nie w konsoli' };
    case 'consoleUnsupported': return { key: 'Tego polecenia nie można użyć w konsoli' };
    case 'staleToken': return { key: 'Policz klucze ponownie przed usunięciem' };
    default: return sshErrorText(code, ssh);
  }
}

/** The phase text of a connecting session. */
export function dbPhaseLabel(phase: DbPhase): Localized | null {
  switch (phase) {
    case 'connecting': return { key: 'łączenie…' };
    case 'verifying': return { key: 'weryfikacja klucza hosta' };
    case 'authenticating': return { key: 'logowanie SSH…' };
    case 'database': return { key: 'łączenie z bazą…' };
    default: return null;
  }
}

