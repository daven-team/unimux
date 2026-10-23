// One connected MySQL / MariaDB session of the DB Host (1.0.5), the counterpart of PgSession: runs its operations one at a
// time on its mysql2 connection, streams rows to the renderer over the DB port in bounded batches (the connection is paused
// while the renderer has enough), keeps at most one read-only result open for "load more" (a streaming result holds the
// connection, so it is stopped with KILL QUERY when something else needs it or after DB_LIMITS.cursorIdleMs), refuses writes on
// read-only connections on the client side too (the session's transactions are READ ONLY as well), learns the transaction state
// from the server status of OK packets, cancels with KILL QUERY on a side connection, and applies staged edits in one transaction.
// Every value arrives as the server's text (typeCast off), bytes as "\x..." hex. Independent of Electron (tested against
// mysql2's own server protocol and, when available, real servers).
import type { Connection } from 'mysql2';
import {
  DB_LIMITS, type DbCellRequest, type DbColumn, type DbEditRequest, type DbErrorCode, type DbMysqlFlavor, type DbPortMessage, type DbQueryRequest, type DbResult,
  type DbServerError, type DbTablePageRequest, type DbTxStatus, type DbValue,
} from '../shared/db';
import { DbSqlError, firstKeyword, splitSql } from '../shared/dbSql';
import {
  mysqlBinaryType, mysqlCellSql, mysqlEditPreview, mysqlEditStatements, mysqlEndsTransaction, mysqlErrorText, mysqlFieldBinary, mysqlFieldKind, mysqlIsReadStatement,
  mysqlErrorPosition, mysqlIsUse, mysqlPageSql, mysqlReadOnlyAllows, mysqlTimeoutSql, type MysqlBuiltStatement, type MysqlFieldLike,
} from '../shared/dbMysql';
import type { DbHostOp } from '../shared/dbHostIpc';
import { listDatabases, listObjects, listSchemas, objectDdl, tableInfo, type MyRow, type MysqlTableInfo } from './mysqlMeta';

/** The part of a mysql2 connection the session uses. */
export type MyConn = Pick<Connection, 'query' | 'pause' | 'resume' | 'threadId'>;
interface Field extends MysqlFieldLike { name: string }
interface Header { affectedRows?: number; serverStatus?: number; warningStatus?: number; insertId?: number }
type Raw = Array<Buffer | null>;

export interface MysqlSessionOut {
  port(m: DbPortMessage): void;
  tx(tx: DbTxStatus): void;
  activity(busy: boolean): void;
  /** USE switched the default database. */
  database(name: string): void;
}

export interface MysqlSessionOptions {
  readOnly: boolean;
  /** The connection's statement timeout (ms; 0: the server's). */
  statementTimeoutMs: number;
  flavor: DbMysqlFlavor;
  /** A second connection to the same server (for KILL QUERY); the caller ends it. */
  sideConnection(): Promise<{ query: Connection['query']; end(): void; destroy(): void }>;
  /** The session cannot be trusted any more (a setting could not be restored, a stopped result never ended): it must end. */
  fatal(): void;
  cursorIdleMs?: number;
  now?(): number;
}

const IN_TRANS = 1;
const ER_QUERY_INTERRUPTED = 1317;
const ER_QUERY_TIMEOUT = 3024;
const ER_STATEMENT_TIMEOUT = 1969;
const ER_READ_ONLY_TRANSACTION = 1792;
/** Rows (or bytes) buffered from the server before the connection is paused, and resumed below. */
const HIGH_ROWS = 2000;
const LOW_ROWS = 500;
const HIGH_BYTES = 8 * 1024 * 1024;

const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const fail = (error: DbErrorCode, server?: DbServerError, index?: number): DbResult<never> => ({ ok: false, error, ...(server ? { server } : {}), ...(index !== undefined ? { index } : {}) });

/** The server's error (capped); null for errors that are not the server's (a dropped connection, a protocol error). */
export function mysqlServerError(error: unknown): DbServerError | null {
  const e = error as { errno?: unknown; sqlState?: unknown; sqlMessage?: unknown; message?: unknown; fatal?: unknown } | null;
  if (!e || typeof e !== 'object' || typeof e.errno !== 'number' || e.fatal === true) return null;
  const message = typeof e.sqlMessage === 'string' ? e.sqlMessage : typeof e.message === 'string' ? e.message : '';
  const state = typeof e.sqlState === 'string' && /^[0-9A-Z]{5}$/.test(e.sqlState) ? e.sqlState : undefined;
  return { message: mysqlErrorText(e.errno, state, message).slice(0, DB_LIMITS.serverText), ...(state ? { code: state } : {}), severity: 'ERROR' };
}
const errnoOf = (error: unknown): number | null => {
  const e = error as { errno?: unknown; fatal?: unknown } | null;
  return e && typeof e === 'object' && typeof e.errno === 'number' && e.fatal !== true ? e.errno : null;
};

/** A cell for the port: text, or bytes as "\x..." hex, cut to DB_LIMITS.cellChars with its full length. */
function toValue(v: string | Buffer | null): DbValue {
  if (v === null) return null;
  const s = typeof v === 'string' ? v : `\\x${v.toString('hex')}`;
  return s.length > DB_LIMITS.cellChars ? { t: 'trunc', head: s.slice(0, DB_LIMITS.cellChars), chars: s.length } : s;
}

/** How each column's raw bytes are read: text in utf8 (what the connection's utf8mb4 sends), or kept as bytes. */
const decoders = (fields: readonly Field[]): Array<(b: Buffer) => string | Buffer> =>
  fields.map((f) => (mysqlFieldBinary(f) ? (b: Buffer) => b : (b: Buffer) => b.toString('utf8')));

/**
 * One statement's answer, as it streams in: the fields of its first result set, its rows (buffered up to HIGH_ROWS / HIGH_BYTES,
 * then the connection pauses until they are taken), the OK packet of a statement without rows, and its end or error. Later
 * result sets are dropped (their OK still counts); a CALL is read by MyCall, which keeps them all.
 */
class MyStream {
  fields: Field[] | null = null;
  header: Header | null = null;
  done = false;
  error: unknown = null;
  private rows: Raw[] = [];
  private bytes = 0;
  private sets = -1;
  private rowSet = -1;
  private paused = false;
  private discard = false;
  private wake: (() => void) | null = null;

  constructor(private readonly conn: MyConn, sql: string) {
    const q = (conn.query as unknown as (o: object) => { on(e: string, f: (...a: never[]) => void): unknown })({ sql, rowsAsArray: true, typeCast: false });
    q.on('fields', (fields: Field[] | undefined) => {
      this.sets++;
      if (fields && this.fields === null) { this.fields = fields; this.rowSet = this.sets; }
      this.poke();
    });
    q.on('result', (row: Raw | Header, index: number) => {
      if (!Array.isArray(row)) { this.header = row; this.poke(); return; }
      if (this.discard || (index ?? 0) !== this.rowSet) return;
      this.rows.push(row);
      for (const v of row) this.bytes += v ? v.length : 1;
      if (!this.paused && (this.rows.length >= HIGH_ROWS || this.bytes >= HIGH_BYTES)) { this.paused = true; this.conn.pause(); }
      this.poke();
    });
    q.on('error', (e: unknown) => { this.error = e; this.done = true; this.poke(); });
    q.on('end', () => { this.done = true; this.poke(); });
  }

  private poke(): void { const w = this.wake; this.wake = null; w?.(); }
  private wait(): Promise<void> { return new Promise((r) => { this.wake = r; }); }
  private resumeIfLow(): void {
    if (this.paused && this.rows.length < LOW_ROWS && this.bytes < HIGH_BYTES / 4) { this.paused = false; this.conn.resume(); }
  }

  /** Up to `count` rows (fewer only at the end); throws the statement's error once its rows are taken. */
  async take(count: number): Promise<Raw[]> {
    while (this.rows.length < count && !this.done) { this.resumeIfLow(); await this.wait(); }
    const out = this.rows.splice(0, count);
    for (const row of out) for (const v of row) this.bytes -= v ? v.length : 1;
    this.resumeIfLow();
    if (!out.length && this.error) throw this.error;
    return out;
  }

  /** Waits until a row is buffered or the statement ended: whether more rows follow. */
  async more(): Promise<boolean> {
    while (!this.rows.length && !this.done) { this.resumeIfLow(); await this.wait(); }
    return this.rows.length > 0;
  }

  /** Everything up to the end (rows thrown away): the connection is free once this resolves. */
  async drain(ms: number): Promise<boolean> {
    this.discard = true;
    this.rows = [];
    this.bytes = 0;
    if (this.paused) { this.paused = false; this.conn.resume(); }
    const until = Date.now() + ms;
    while (!this.done && Date.now() < until) await Promise.race([this.wait(), new Promise((r) => setTimeout(r, 200))]);
    return this.done;
  }
}

/** The result sets a CALL shows at most (more are counted in a notice) and the rows kept of each (the rest are counted). */
const CALL_MAX_SETS = 50;

interface CallSet { fields: Field[]; rows: Raw[]; dropped: number }

/**
 * A CALL read to its end (1.0.6): every result set of the procedure with up to `rowCap` rows each (the rest counted, not kept),
 * and the OK packet that ends it. A CALL changes data as it runs, so it is never stopped halfway for "load more".
 */
class MyCall {
  sets: CallSet[] = [];
  extraSets = 0;
  header: Header | null = null;
  error: unknown = null;
  private done = false;
  private wake: (() => void) | null = null;

  constructor(conn: MyConn, sql: string, rowCap: number) {
    const q = (conn.query as unknown as (o: object) => { on(e: string, f: (...a: never[]) => void): unknown })({ sql, rowsAsArray: true, typeCast: false });
    let current: CallSet | null = null;
    q.on('fields', (fields: Field[] | undefined) => {
      if (!fields) return;
      if (this.sets.length >= CALL_MAX_SETS) { this.extraSets++; current = null; return; }
      current = { fields, rows: [], dropped: 0 };
      this.sets.push(current);
    });
    q.on('result', (row: Raw | Header) => {
      if (!Array.isArray(row)) { this.header = row; return; }
      if (!current) return;
      if (current.rows.length < rowCap) current.rows.push(row); else current.dropped++;
    });
    q.on('error', (e: unknown) => { this.error = e; this.finish(); });
    q.on('end', () => this.finish());
  }

  private finish(): void { this.done = true; const w = this.wake; this.wake = null; w?.(); }
  /** Resolves when the CALL ended (its error, if any, is in `error`). */
  ended(): Promise<void> { return this.done ? Promise.resolve() : new Promise((r) => { this.wake = r; }); }
}

/** A CALL that failed after some of its result sets were shown: the error goes to a result of its own (`index`). */
class CallError extends Error { constructor(readonly failure: unknown, readonly index: number) { super('call failed'); } }

interface Run { queryId: string; cancelled: boolean }
interface OpenResult { queryId: string; index: number; stream: MyStream; decode: Array<(b: Buffer) => string | Buffer>; sent: number; timer: NodeJS.Timeout | null }
interface Exec { rows: Array<Array<string | Buffer | null>>; fields: Field[] | null; header: Header | null }

export class MysqlSession {
  tx: DbTxStatus = 'idle';
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private runs = 0;
  private metaPending = 0;
  private open: OpenResult | null = null;
  private run: Run | null = null;
  private inFlight = false;
  private cancelRequested = false;
  private ended = false;
  private keys = new Map<string, { at: number; info: MysqlTableInfo | null }>();
  /** Settings a run changed (read-only override, statement timeout); restored once no transaction or result is open. */
  private restore: string[] = [];
  private overrideActive = false;

  constructor(readonly conn: MyConn, private readonly opts: MysqlSessionOptions, private readonly out: MysqlSessionOut) {}

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  end(): void {
    this.ended = true;
    if (this.run) this.run.cancelled = true;
    if (this.open?.timer) clearTimeout(this.open.timer);
  }

  /** Something is on the connection (a statement, an open result): a plain end() would wait behind it. */
  busy(): boolean { return this.inFlight || !!this.open || this.pending > 0; }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private setTx(header: Header | null): void {
    if (!header || typeof header.serverStatus !== 'number') return;
    const tx: DbTxStatus = header.serverStatus & IN_TRANS ? 'transaction' : 'idle';
    if (tx !== this.tx) { this.tx = tx; this.out.tx(tx); }
  }

  /** One statement read whole (metadata, settings, edits); its OK packet updates the transaction state. */
  private exec(sql: string): Promise<Exec> {
    return new Promise((resolve, reject) => {
      (this.conn.query as unknown as (o: object, cb: (err: unknown, rows: unknown, fields: unknown) => void) => void)({ sql, rowsAsArray: true, typeCast: false }, (err, rows, fields) => {
        if (err) { reject(err); return; }
        if (!Array.isArray(rows)) { this.setTx(rows as Header); resolve({ rows: [], fields: null, header: rows as Header }); return; }
        const decode = (f: Field[], list: unknown) => {
          const dec = decoders(f);
          return Array.isArray(list) ? (list as Raw[]).map((r) => r.map((v, i) => (v === null ? null : dec[i](v)))) : [];
        };
        // A CALL answers with several result sets and an OK: the first rows, the last OK.
        if (Array.isArray(fields) && Array.isArray(fields[0])) {
          const last = rows[rows.length - 1];
          const header = last && !Array.isArray(last) ? last as Header : null;
          this.setTx(header);
          const f = (fields as Field[][])[0];
          resolve({ rows: decode(f, rows[0]), fields: f, header });
          return;
        }
        const f = (fields as Field[] | undefined) ?? [];
        resolve({ rows: decode(f, rows), fields: f, header: null });
      });
    });
  }

  /** Rows of a catalog read, every value as text. */
  private async meta(sql: string): Promise<MyRow[]> {
    const r = await this.exec(sql);
    return r.rows.map((row) => row.map((v) => (v === null ? null : typeof v === 'string' ? v : v.toString('utf8'))));
  }

  /** The transaction state after a statement that answered with rows (only OK packets carry it). */
  private async syncTx(): Promise<void> { await this.exec('DO 0'); }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending++ === 0) this.out.activity(true);
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined).finally(() => { if (--this.pending === 0) this.out.activity(false); });
    return next;
  }

  private serialRun(fn: () => Promise<void>): void {
    this.runs++;
    void this.serial(fn).finally(() => { this.runs--; });
  }

  private async onServer<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight = true;
    try { return await fn(); } finally { this.inFlight = false; }
  }

  private codeOf(error: unknown): DbErrorCode {
    const errno = errnoOf(error);
    if (errno === null) return this.ended ? 'noSession' : 'dbClosed';
    if (errno === ER_QUERY_INTERRUPTED) return 'cancelled';
    if (errno === ER_QUERY_TIMEOUT || errno === ER_STATEMENT_TIMEOUT) return this.cancelRequested ? 'cancelled' : 'statementTimeout';
    if (errno === ER_READ_ONLY_TRANSACTION) return 'readOnly';
    return 'server';
  }

  private fatal(): never {
    this.ended = true;
    this.opts.fatal();
    throw new Error('session settings could not be restored');
  }

  private async must(sql: string): Promise<void> {
    try { await this.exec(sql); } catch { this.fatal(); }
  }

  private async settle(): Promise<void> {
    if (this.tx !== 'idle' || this.open || !this.restore.length) return;
    const restore = this.restore;
    this.restore = [];
    for (const sql of restore) await this.must(sql);
    this.overrideActive = false;
  }

  /** KILL QUERY of this connection's thread on a side connection (stops the running statement, keeps the connection). */
  private async kill(): Promise<boolean> {
    const thread = this.conn.threadId;
    if (thread === null || thread === undefined) return false;
    try {
      const side = await this.opts.sideConnection();
      try {
        await new Promise<void>((resolve, reject) => {
          (side.query as unknown as (sql: string, cb: (err: unknown) => void) => void)(`KILL QUERY ${Math.floor(thread)}`, (err) => (err ? reject(err) : resolve()));
        });
        return true;
      } finally { try { side.end(); } catch { side.destroy(); } }
    } catch { return false; }
  }

  /** Ends a stream before the connection is used again: a read is stopped on the server (KILL QUERY), anything else runs to its end. */
  private async stop(stream: MyStream, kill: boolean): Promise<void> {
    if (stream.done) return;
    // The KILL is answered before anything else goes out on this connection: a kill that lands after the statement ended is
    // reset by the server when the next command starts, so it can never hit a later statement.
    if (kill) {
      this.cancelRequested = true;
      await this.kill();
    }
    if (!(await stream.drain(30_000))) this.fatal();
  }

  private columns(fields: readonly Field[]): DbColumn[] {
    return fields.map((f) => { const k = mysqlFieldKind(f); return { name: f.name, typeOid: f.columnType, typeName: k.typeName, kind: k.kind }; });
  }

  private sendRows(queryId: string, index: number, rows: ReadonlyArray<ReadonlyArray<string | Buffer | null>>): number {
    let chunk: DbValue[][] = [];
    let chars = 0;
    let total = 0;
    for (const row of rows) {
      const values = row.map(toValue);
      chunk.push(values);
      for (const v of values) chars += v === null ? 4 : typeof v === 'string' ? v.length : v.head.length;
      if (chunk.length >= DB_LIMITS.chunkRows || chars >= DB_LIMITS.chunkChars) {
        this.out.port({ t: 'rows', queryId, index, rows: chunk });
        total += chars;
        chunk = [];
        chars = 0;
      }
    }
    if (chunk.length) this.out.port({ t: 'rows', queryId, index, rows: chunk });
    return total + chars;
  }

  /** Sends up to `max` rows in batches, stopping early at about DB_LIMITS.pageChars characters; the columns go first. */
  private async pump(queryId: string, index: number, stream: MyStream, max: number, state: { columnsSent: boolean; decode: Array<(b: Buffer) => string | Buffer> | null }): Promise<number> {
    let sent = 0;
    let chars = 0;
    let batch = 100;
    const columns = () => {
      if (state.columnsSent || !stream.fields) return;
      state.columnsSent = true;
      state.decode = decoders(stream.fields);
      if (stream.fields.length) this.out.port({ t: 'columns', queryId, index, columns: this.columns(stream.fields) });
    };
    while (sent < max && chars < DB_LIMITS.pageChars) {
      const want = Math.min(batch, max - sent);
      const raw = await this.onServer(() => stream.take(want));
      columns();
      if (!raw.length) break;
      const dec = state.decode ?? [];
      const rows = raw.map((r) => r.map((v, i) => (v === null ? null : (dec[i] ?? ((b: Buffer) => b.toString('utf8')))(v))));
      chars += this.sendRows(queryId, index, rows);
      sent += rows.length;
      const perRow = Math.max(1, chars / sent);
      batch = Math.max(1, Math.min(DB_LIMITS.chunkRows, Math.floor(DB_LIMITS.chunkChars / perRow)));
      // Fewer than asked for: the statement ended.
      if (raw.length < want) break;
    }
    columns();
    return sent;
  }

  private armIdle(open: OpenResult): void {
    if (open.timer) clearTimeout(open.timer);
    open.timer = setTimeout(() => {
      void this.serial(async () => { if (this.open === open) { await this.closeOpen(); await this.settle().catch(() => undefined); } });
    }, this.opts.cursorIdleMs ?? DB_LIMITS.cursorIdleMs);
  }

  private async closeOpen(): Promise<void> {
    const open = this.open;
    if (!open) return;
    this.open = null;
    if (open.timer) clearTimeout(open.timer);
    await this.stop(open.stream, true);
    this.cancelRequested = false;
    this.out.port({ t: 'resultClosed', queryId: open.queryId, index: open.index });
  }

  // ── operations ─────────────────────────────────────────────────────────────

  handle(op: DbHostOp): Promise<DbResult<unknown>> {
    if (this.ended) return Promise.resolve(fail('noSession'));
    switch (op.op) {
      case 'cancel': return this.cancel().then(ok);
      case 'query': this.serialRun(() => this.runQuery(op.req)); return Promise.resolve(ok(true));
      case 'tablePage': this.serialRun(() => this.runPage(op.req)); return Promise.resolve(ok(true));
      case 'fetchMore':
        if (!this.open || this.open.queryId !== op.queryId) return Promise.resolve(fail('notFound'));
        if (this.open.timer) clearTimeout(this.open.timer);
        this.serialRun(() => this.fetchMore(op.queryId, op.count));
        return Promise.resolve(ok(true));
      case 'closeResult':
        return this.serial(async () => { if (this.open?.queryId === op.queryId) { await this.closeOpen(); await this.settle(); } return ok(true); }).catch(() => fail('dbFailed'));
      case 'redis': return Promise.resolve(fail('invalid'));
      default:
        if (this.runs > 0 || this.metaPending >= 4) return Promise.resolve(fail('busy'));
        this.metaPending++;
        return this.serial(async () => {
          try {
            await this.closeOpen();
            await this.settle();
            return await this.metaOp(op);
          } catch (error) {
            if (error instanceof DbSqlError) return fail(error.code);
            return fail(this.ended ? 'dbFailed' : this.codeOf(error), mysqlServerError(error) ?? undefined);
          } finally { this.metaPending--; }
        });
    }
  }

  private async metaOp(op: DbHostOp): Promise<DbResult<unknown>> {
    const q = (sql: string) => this.meta(sql);
    switch (op.op) {
      case 'databases': return ok(await listDatabases(q));
      case 'schemas': return ok(await listSchemas(q));
      case 'objects': return ok(await listObjects(q, op.schema));
      case 'tableInfo': {
        const info = await tableInfo(q, op.schema, op.name);
        if (!info) return fail('notFound');
        const { dataTypes: _types, ...rest } = info;
        return ok(rest);
      }
      case 'ddl': { const ddl = await objectDdl(q, op.schema, op.name, op.kind); return ddl === null ? fail('notFound') : ok(ddl); }
      case 'transaction': {
        await this.exec(op.action === 'begin' ? 'START TRANSACTION' : op.action === 'commit' ? 'COMMIT' : 'ROLLBACK');
        await this.settle();
        return ok(this.tx);
      }
      case 'previewEdits': {
        const built = await this.buildEdits(op.req);
        return 'error' in built ? built.error : ok({ sql: mysqlEditPreview(built.statements), statements: built.statements.length });
      }
      case 'applyEdits': return this.applyEdits(op.req);
      case 'cellValue': return this.cellValue(op.req);
      default: return fail('invalid');
    }
  }

  // ── cancel ─────────────────────────────────────────────────────────────────

  private async cancel(): Promise<boolean> {
    if (this.run) this.run.cancelled = true;
    if (!this.inFlight) return false;
    this.cancelRequested = true;
    return this.kill();
  }

  // ── queries ────────────────────────────────────────────────────────────────

  private async runQuery(req: DbQueryRequest): Promise<void> {
    const started = this.now();
    const run: Run = { queryId: req.queryId, cancelled: false };
    this.run = run;
    this.cancelRequested = false;
    let allOk = true;
    const override = req.readWrite === true && this.opts.readOnly;
    const refuse = (code: DbErrorCode, index = 0) => {
      allOk = false;
      this.out.port({ t: 'statementError', queryId: req.queryId, index, error: code, timeMs: this.now() - started });
    };
    try {
      await this.closeOpen();
      await this.settle();
      const spans = splitSql(req.sql, 'mysql');
      const rowCap = Math.max(1, Math.min(DB_LIMITS.rowCapMax, Math.floor(req.rowCap ?? DB_LIMITS.rowCap)));
      if (this.opts.readOnly && !override) {
        if (this.overrideActive && !spans.every((s) => mysqlEndsTransaction(s.text))) { refuse('inTransaction'); return; }
        const bad = spans.findIndex((s) => !mysqlReadOnlyAllows(s.text));
        if (bad >= 0) { refuse('readOnly', bad); return; }
      }
      if (override) {
        if (this.tx !== 'idle') { refuse('inTransaction'); return; }
        await this.exec('SET SESSION TRANSACTION READ WRITE');
        this.overrideActive = true;
        this.restore.push('SET SESSION TRANSACTION READ ONLY');
      }
      if (req.statementTimeoutMs !== undefined && req.statementTimeoutMs !== null && req.statementTimeoutMs !== this.opts.statementTimeoutMs) {
        const ms = Math.max(0, Math.min(DB_LIMITS.statementTimeoutMaxMs, Math.floor(req.statementTimeoutMs)));
        await this.exec(mysqlTimeoutSql(this.opts.flavor, ms));
        this.restore.push(mysqlTimeoutSql(this.opts.flavor, this.opts.statementTimeoutMs ? this.opts.statementTimeoutMs : null));
      }
      // Results are numbered in order; a CALL with several result sets takes one number per set (the next statement follows).
      let next = 0;
      for (let i = 0; i < spans.length; i++) {
        if (run.cancelled || this.ended) break;
        const span = spans[i];
        const index = next++;
        this.out.port({ t: 'statement', queryId: req.queryId, index, start: span.start, end: span.end });
        const t0 = this.now();
        try {
          if (firstKeyword(span.text) === 'CALL') next = await this.call(req.queryId, index, span, rowCap, next);
          else await this.statement(req.queryId, index, span.text, rowCap, i === spans.length - 1);
        } catch (thrown) {
          if (this.ended) throw thrown;
          allOk = false;
          const error = thrown instanceof CallError ? thrown.failure : thrown;
          const server = mysqlServerError(error);
          // A syntax error names its place as "near '...' at line N": it is underlined in the editor.
          const position = server ? mysqlErrorPosition(server.message, span.text) : null;
          if (server && position) server.position = position;
          this.out.port({ t: 'statementError', queryId: req.queryId, index: thrown instanceof CallError ? thrown.index : index, error: this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - t0 });
          // An error inside a transaction leaves it open in MySQL: the state is asked for.
          try { await this.syncTx(); } catch { /* gone */ }
          if (!req.continueOnError || !server) break;
        }
      }
    } catch (error) {
      allOk = false;
      const server = mysqlServerError(error);
      this.out.port({ t: 'statementError', queryId: req.queryId, index: 0, error: this.ended ? 'dbFailed' : this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - started });
    } finally {
      try { if (!this.ended) await this.settle(); } catch { allOk = false; }
      if (this.run === run) this.run = null;
      this.cancelRequested = false;
      this.out.port({ t: 'queryEnd', queryId: req.queryId, ok: allOk && !run.cancelled, cancelled: run.cancelled, timeMs: this.now() - started, tx: this.tx });
    }
  }

  /**
   * One statement. Its rows stream in bounded batches; only a read that is the last statement of the run keeps its result open
   * for "load more". An earlier read with more rows is stopped (KILL QUERY); anything else that returns rows (CALL) runs to its
   * end with the rest of its rows dropped, reported with truncated.
   */
  private async statement(queryId: string, index: number, text: string, rowCap: number, last: boolean): Promise<void> {
    const t0 = this.now();
    const stream = new MyStream(this.conn, text);
    const state = { columnsSent: false, decode: null as Array<(b: Buffer) => string | Buffer> | null };
    let sent: number;
    try {
      sent = await this.pump(queryId, index, stream, rowCap, state);
    } catch (error) {
      if (!stream.done) await this.stop(stream, false);
      throw error;
    }
    const read = mysqlIsReadStatement(text);
    const more = stream.fields ? await this.onServer(() => stream.more()) : false;
    const keep = more && last && read;
    if (!stream.fields) {
      const h = stream.header ?? {};
      this.setTx(stream.header);
      this.out.port({ t: 'statementEnd', queryId, index, command: firstKeyword(text) || 'OK', rowCount: typeof h.affectedRows === 'number' ? h.affectedRows : null, rows: 0, hasMore: false, timeMs: this.now() - t0 });
      if (h.warningStatus) await this.warnings(queryId);
      if (mysqlIsUse(text)) await this.reportDatabase();
      return;
    }
    if (more && !keep) {
      await this.stop(stream, read);
      this.cancelRequested = false;
      this.out.port({ t: 'statementEnd', queryId, index, command: firstKeyword(text) || 'SELECT', rowCount: null, rows: sent, hasMore: false, truncated: true, timeMs: this.now() - t0 });
      await this.syncTx();
      return;
    }
    this.out.port({ t: 'statementEnd', queryId, index, command: firstKeyword(text) || 'SELECT', rowCount: keep ? null : sent, rows: sent, hasMore: keep, timeMs: this.now() - t0 });
    if (!keep) { if (stream.header) this.setTx(stream.header); else await this.syncTx(); return; }
    this.open = { queryId, index, stream, decode: state.decode ?? [], sent, timer: null };
    this.armIdle(this.open);
  }

  /**
   * A CALL (1.0.6): runs to its end, then every result set it answered with is a result of its own (the first takes `index`,
   * the others the next free numbers, marked with `set`). Returns the next free number. A failure after some sets keeps them
   * and reports the error as one more result (CallError).
   */
  private async call(queryId: string, index: number, span: { start: number; end: number; text: string }, rowCap: number, next: number): Promise<number> {
    const t0 = this.now();
    const call = new MyCall(this.conn, span.text, rowCap);
    await this.onServer(() => call.ended());
    const timeMs = this.now() - t0;
    call.sets.forEach((set, k) => {
      const at = k === 0 ? index : next++;
      if (k > 0) this.out.port({ t: 'statement', queryId, index: at, start: span.start, end: span.end, set: k + 1 });
      if (set.fields.length) this.out.port({ t: 'columns', queryId, index: at, columns: this.columns(set.fields) });
      const dec = decoders(set.fields);
      this.sendRows(queryId, at, set.rows.map((r) => r.map((v, i) => (v === null ? null : (dec[i] ?? ((b: Buffer) => b.toString('utf8')))(v)))));
      this.out.port({ t: 'statementEnd', queryId, index: at, command: 'CALL', rowCount: set.rows.length + set.dropped, rows: set.rows.length, hasMore: false, ...(set.dropped ? { truncated: true } : {}), timeMs });
    });
    if (call.extraSets) this.out.port({ t: 'notice', queryId, message: `CALL: +${call.extraSets} result sets not shown (max ${CALL_MAX_SETS})`, severity: 'NOTICE' });
    if (call.error) {
      if (!call.sets.length) throw call.error;
      const at = next++;
      this.out.port({ t: 'statement', queryId, index: at, start: span.start, end: span.end, set: call.sets.length + 1 });
      throw new CallError(call.error, at);
    }
    const h = call.header ?? {};
    if (!call.sets.length) this.out.port({ t: 'statementEnd', queryId, index, command: 'CALL', rowCount: typeof h.affectedRows === 'number' ? h.affectedRows : null, rows: 0, hasMore: false, timeMs });
    if (call.header) this.setTx(call.header); else await this.syncTx();
    if (h.warningStatus) await this.warnings(queryId);
    return next;
  }

  /** SHOW WARNINGS after a statement that had some: they arrive as notices. */
  private async warnings(queryId: string): Promise<void> {
    try {
      const r = await this.meta('SHOW WARNINGS');
      for (const row of r.slice(0, 50)) this.out.port({ t: 'notice', queryId, message: `${row[0] ?? 'Warning'} ${row[1] ?? ''}: ${row[2] ?? ''}`.slice(0, DB_LIMITS.serverText), severity: (row[0] ?? 'WARNING').toUpperCase() });
    } catch { /* warnings are a bonus */ }
  }

  private async reportDatabase(): Promise<void> {
    try {
      const r = await this.meta('SELECT DATABASE()');
      this.out.database(r[0]?.[0] ?? '');
    } catch { /* stays as it was */ }
  }

  private async fetchMore(queryId: string, count: number): Promise<void> {
    const open = this.open;
    if (!open || open.queryId !== queryId) return;
    const n = Math.max(1, Math.min(DB_LIMITS.rowCapMax, Math.floor(count)));
    const t0 = this.now();
    this.cancelRequested = false;
    try {
      const sent = await this.pump(queryId, open.index, open.stream, n, { columnsSent: true, decode: open.decode });
      open.sent += sent;
      const hasMore = await this.onServer(() => open.stream.more());
      this.out.port({ t: 'statementEnd', queryId, index: open.index, command: 'SELECT', rowCount: hasMore ? null : open.sent, rows: open.sent, hasMore, timeMs: this.now() - t0 });
      if (hasMore) { this.armIdle(open); return; }
      this.open = null;
      if (open.timer) clearTimeout(open.timer);
      await this.syncTx();
      await this.settle();
    } catch (error) {
      if (this.open === open) this.open = null;
      if (open.timer) clearTimeout(open.timer);
      const server = mysqlServerError(error);
      this.out.port({ t: 'statementError', queryId, index: open.index, error: this.ended ? 'dbFailed' : this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - t0 });
      if (!open.stream.done) await this.stop(open.stream, true).catch(() => undefined);
      if (!this.ended) await this.settle().catch(() => undefined);
    }
  }

  // ── table pages ────────────────────────────────────────────────────────────

  private async info(db: string, table: string, fresh = false): Promise<MysqlTableInfo | null> {
    const id = `${db}\0${table}`;
    const cached = this.keys.get(id);
    if (!fresh && cached && this.now() - cached.at < 30_000) return cached.info;
    const info = await tableInfo((sql) => this.meta(sql), db, table);
    this.keys.set(id, { at: this.now(), info });
    return info;
  }

  private binaryColumns(info: MysqlTableInfo | null): Set<string> {
    return new Set(Object.entries(info?.dataTypes ?? {}).filter(([, t]) => mysqlBinaryType(t)).map(([c]) => c));
  }

  /** One page inside a READ ONLY transaction (the filter is the user's own SQL). */
  private async runPage(req: DbTablePageRequest): Promise<void> {
    const started = this.now();
    const run: Run = { queryId: req.queryId, cancelled: false };
    this.run = run;
    this.cancelRequested = false;
    let success = false;
    const error = (code: DbErrorCode, server?: DbServerError) => this.out.port({ t: 'statementError', queryId: req.queryId, index: 0, error: code, ...(server ? { server } : {}), timeMs: this.now() - started });
    try {
      await this.closeOpen();
      await this.settle();
      if (this.tx !== 'idle') { error('inTransaction'); return; }
      const info = await this.info(req.schema, req.table);
      let built: ReturnType<typeof mysqlPageSql>;
      try { built = mysqlPageSql(req, info?.editKey ?? null, this.binaryColumns(info)); } catch { error('invalid'); return; }
      this.out.port({ t: 'statement', queryId: req.queryId, index: 0, start: 0, end: 0 });
      await this.exec('START TRANSACTION READ ONLY');
      let sent = 0;
      let more = false;
      try {
        const stream = new MyStream(this.conn, built.sql);
        try { sent = await this.pump(req.queryId, 0, stream, Math.floor(req.limit), { columnsSent: false, decode: null }); } catch (e) { if (!stream.done) await this.stop(stream, false); throw e; }
        more = await this.onServer(() => stream.more());
        // The page asked for one row more than it shows: the rest is that row at most.
        if (!stream.done) await this.stop(stream, false);
        await this.exec('COMMIT');
      } catch (e) {
        try { await this.exec('ROLLBACK'); } catch { /* gone */ }
        throw e;
      }
      this.out.port({ t: 'statementEnd', queryId: req.queryId, index: 0, command: 'SELECT', rowCount: sent, rows: sent, hasMore: more, timeMs: this.now() - started });
      success = true;
    } catch (e) {
      error(this.ended ? 'dbFailed' : this.codeOf(e), mysqlServerError(e) ?? undefined);
    } finally {
      if (this.run === run) this.run = null;
      this.cancelRequested = false;
      this.out.port({ t: 'queryEnd', queryId: req.queryId, ok: success, cancelled: run.cancelled, timeMs: this.now() - started, tx: this.tx });
    }
  }

  // ── edits ──────────────────────────────────────────────────────────────────

  private async buildEdits(req: DbEditRequest): Promise<{ statements: MysqlBuiltStatement[] } | { error: DbResult<never> }> {
    const info = await this.info(req.schema, req.table, true);
    if (!info) return { error: fail('notFound') };
    if (req.edits.some((e) => e.op !== 'insert') && !info.editKey) return { error: fail('noKey') };
    try {
      return { statements: mysqlEditStatements(req.schema, req.table, info.editKey, req.edits, info.columns.map((c) => ({ name: c.name, dataType: info.dataTypes[c.name] ?? '', generated: c.generated }))) };
    } catch (error) {
      return { error: fail(error instanceof DbSqlError ? error.code : 'invalid') };
    }
  }

  /** All edits in one transaction; an UPDATE or DELETE that does not match exactly one row rolls everything back. */
  private async applyEdits(req: DbEditRequest): Promise<DbResult<{ affected: number }>> {
    if (this.opts.readOnly) return fail('readOnly');
    if (this.tx !== 'idle') return fail('inTransaction');
    const built = await this.buildEdits(req);
    if ('error' in built) return built.error;
    await this.exec('START TRANSACTION');
    let affected = 0;
    for (const s of built.statements) {
      let r: Exec;
      try {
        r = await this.onServer(() => this.exec(s.sql));
      } catch (error) {
        try { await this.exec('ROLLBACK'); } catch { /* gone */ }
        return fail(this.codeOf(error), mysqlServerError(error) ?? undefined, s.index);
      }
      // The connection reports matched rows (CLIENT_FOUND_ROWS): an UPDATE to the same value still counts its row.
      const n = r.header?.affectedRows ?? 0;
      if (s.op !== 'insert' && n !== 1) {
        try { await this.exec('ROLLBACK'); } catch { /* gone */ }
        return fail('conflict', undefined, s.index);
      }
      affected += n;
    }
    try { await this.exec('COMMIT'); } catch (error) {
      try { await this.exec('ROLLBACK'); } catch { /* gone */ }
      return fail(this.codeOf(error), mysqlServerError(error) ?? undefined);
    }
    if (this.tx !== 'idle') return fail('dbFailed');
    this.keys.clear();
    return ok({ affected });
  }

  private async cellValue(req: DbCellRequest): Promise<DbResult<string | null>> {
    const info = await this.info(req.schema, req.table);
    const key = info?.editKey;
    if (!key) return fail('noKey');
    let sql: string;
    try { sql = mysqlCellSql(req.schema, req.table, req.column, req.key, key, this.binaryColumns(info)); } catch { return fail('invalid'); }
    const r = await this.exec(sql);
    if (r.rows.length !== 1) return fail(r.rows.length ? 'conflict' : 'notFound');
    const v = r.rows[0][0];
    if (v === null) return ok(null);
    const s = typeof v === 'string' ? v : `\\x${v.toString('hex')}`;
    return ok(s.slice(0, DB_LIMITS.fullValueChars));
  }
}
