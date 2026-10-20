// One connected Postgres session of the DB Host (1.0.0): runs its operations one at a time on its pg.Client, streams rows to the
// renderer over the DB port in bounded batches, keeps at most one read-only result cursor open for "load more" (closed after
// DB_LIMITS.cursorIdleMs without a fetch), enforces read-only connections on the client side too, tracks the transaction state from
// ReadyForQuery, cancels through pg_cancel_backend on a side connection, and applies staged edits in one transaction.
// Independent of Electron so it is tested in Node against PGlite and the fake server.
import type { Client, QueryResult } from 'pg';
import Cursor from 'pg-cursor';
import {
  DB_LIMITS, type DbCellRequest, type DbColumn, type DbEditRequest, type DbErrorCode, type DbPortMessage, type DbQueryRequest, type DbResult,
  type DbServerError, type DbTablePageRequest, type DbTxStatus, type DbValue,
} from '../shared/db';
import { DbSqlError, buildEditStatements, cellSql, editPreview, endsTransaction, firstKeyword, isReadStatement, pageSql, readOnlyAllows, returnsRows, splitSql, valueKind } from '../shared/dbSql';
import { listDatabases, listObjects, listSchemas, objectDdl, tableInfo, type Row } from './pgMeta';
import type { DbHostOp } from '../shared/dbHostIpc';

/** Every value stays the server's text form (no JS Date, no float rounding, no bigint loss). */
export const RAW_TYPES = { getTypeParser: () => (value: string) => value };

export interface PgSessionOut {
  port(m: DbPortMessage): void;
  tx(tx: DbTxStatus): void;
  activity(busy: boolean): void;
}

export interface PgSessionOptions {
  readOnly: boolean;
  /** The connection's statement_timeout (ms; 0: none). */
  statementTimeoutMs: number;
  /** A second connection to the same server and database (for pg_cancel_backend); the caller ends it. */
  sideConnection(): Promise<Client>;
  /** The protocol-level CancelRequest (the fallback when no side connection can be opened). */
  cancelRequest(processId: number, secretKey: number): Promise<void>;
  /** A session setting could not be restored: the session must end (it might be read-write or without its timeout). */
  fatal(): void;
  cursorIdleMs?: number;
  now?(): number;
}

interface FieldLike { name: string; dataTypeID: number; tableID?: number; columnID?: number }
interface Run { queryId: string; cancelled: boolean }

const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const fail = (error: DbErrorCode, server?: DbServerError, index?: number): DbResult<never> => ({ ok: false, error, ...(server ? { server } : {}), ...(index !== undefined ? { index } : {}) });
const cap = (s: unknown, max: number = DB_LIMITS.serverText): string | undefined => (typeof s === 'string' && s ? s.slice(0, max) : undefined);

/** The server's error fields (capped); null for errors that are not the server's (a dropped connection). */
export function serverError(error: unknown): DbServerError | null {
  const e = error as { message?: unknown; code?: unknown; severity?: unknown; detail?: unknown; hint?: unknown; position?: unknown; schema?: unknown; table?: unknown; column?: unknown; constraint?: unknown; name?: unknown } | null;
  if (!e || typeof e !== 'object' || e.name !== 'error' || typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return null;
  const position = typeof e.position === 'string' ? Number(e.position) : NaN;
  return {
    message: cap(e.message) ?? '', code: e.code,
    ...(cap(e.severity) ? { severity: cap(e.severity) } : {}), ...(cap(e.detail) ? { detail: cap(e.detail) } : {}), ...(cap(e.hint) ? { hint: cap(e.hint) } : {}),
    ...(Number.isFinite(position) && position > 0 ? { position } : {}),
    ...(cap(e.schema, 200) ? { schema: cap(e.schema, 200) } : {}), ...(cap(e.table, 200) ? { table: cap(e.table, 200) } : {}),
    ...(cap(e.column, 200) ? { column: cap(e.column, 200) } : {}), ...(cap(e.constraint, 200) ? { constraint: cap(e.constraint, 200) } : {}),
  };
}

/** A cell for the port: the text form, cut to DB_LIMITS.cellChars with its full length. */
export function toValue(v: unknown): DbValue {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : Buffer.isBuffer(v) ? `\\x${v.toString('hex')}` : String(v);
  return s.length > DB_LIMITS.cellChars ? { t: 'trunc', head: s.slice(0, DB_LIMITS.cellChars), chars: s.length } : s;
}

const cursorState = (cursor: Cursor): string | undefined => (cursor as unknown as { state?: string }).state;

interface Reader { cursor: Cursor; fields: FieldLike[] | null; columnsSent: boolean; buffered: unknown[][]; done: boolean; batch: number; result: { command?: string; rowCount?: number | null } }
interface OpenResult { queryId: string; index: number; reader: Reader; sent: number; timer: NodeJS.Timeout | null }

export class PgSession {
  tx: DbTxStatus = 'idle';
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  /** Queries, table pages and fetchMore queued or running: metadata and edits answer 'busy' meanwhile. */
  private runs = 0;
  private metaPending = 0;
  private open: OpenResult | null = null;
  private run: Run | null = null;
  /** A statement is on the server right now (what cancel stops). */
  private inFlight = false;
  private cancelRequested = false;
  private ended = false;
  private types = new Map<number, { name: string; category: string }>();
  private keys = new Map<string, { at: number; key: string[] | null }>();
  /** Settings a run changed (read-only override, statement timeout); restored only once no transaction or cursor is open. */
  private restore: string[] = [];
  /** A read-only connection runs with writes allowed (its override run left a transaction open). */
  private overrideActive = false;
  private noticeTarget: string | null = null;
  /**
   * An error came from the server since the last drain: the ReadyForQuery messages that end its exchange may still be on the way
   * (PGlite sends one more than Postgres), so the next statement waits for drain() first.
   */
  private dirty = false;
  private gone = false;

  constructor(readonly client: Client, private readonly opts: PgSessionOptions, private readonly out: PgSessionOut) {
    const con = (client as unknown as { connection: { on(e: string, f: (m: { status?: string }) => void): void } }).connection;
    con.on('errorMessage', () => { this.dirty = true; });
    con.on('readyForQuery', (m) => {
      const tx: DbTxStatus = m.status === 'T' ? 'transaction' : m.status === 'E' ? 'failed' : 'idle';
      if (tx !== this.tx) { this.tx = tx; this.out.tx(tx); }
    });
    client.on('end', () => { this.gone = true; });
    client.on('error', () => { this.gone = true; });
    client.on('notice', (n: { message?: string; severity?: string }) => {
      if (this.noticeTarget && typeof n.message === 'string') this.out.port({ t: 'notice', queryId: this.noticeTarget, message: n.message.slice(0, DB_LIMITS.serverText), ...(n.severity ? { severity: n.severity } : {}) });
    });
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  /**
   * Waits until the exchange of the last server error is over before anything else goes to the server. Postgres ends an
   * error with one ReadyForQuery (for the Sync); PGlite's socket server sends one more right after the error, and from a server
   * in another process it can come in a read of its own. Taken as the end of the next statement, it ended that statement
   * early and the statement's real answer then broke the connection (or went to the statement after it). So an empty query
   * goes out as a marker and every message up to its answer is kept from the client: the ReadyForQuery after the marker's
   * EmptyQueryResponse (or error) is the only one the client sees, whatever the server sent before it.
   */
  private async drain(): Promise<void> {
    if (!this.dirty || this.gone || this.ended) return;
    this.dirty = false;
    const con = (this.client as unknown as { connection: { emit(event: string | symbol, ...args: unknown[]): boolean; query(text: string): void } }).connection;
    const emit = con.emit;
    await new Promise<void>((resolve) => {
      let answered = false;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        con.emit = emit;
        resolve();
      };
      con.emit = function (this: unknown, event: string | symbol, ...args: unknown[]): boolean {
        if (event === 'readyForQuery') {
          if (!answered) return true;
          finish();
          return emit.call(con, event, ...args);
        }
        if (event === 'emptyQuery' || event === 'errorMessage' || event === 'commandComplete' || event === 'rowDescription' || event === 'dataRow') { answered = true; return true; }
        if (event === 'end' || event === 'error') finish();
        return emit.call(con, event, ...args);
      };
      // No answer at all: the connection cannot be trusted any more.
      const timer = setTimeout(() => { finish(); this.client.end().catch(() => undefined); }, 30_000);
      try { con.query(''); } catch { finish(); }
    });
  }

  /** A statement through the client, after drain(). */
  private async query(config: string | Record<string, unknown>): Promise<QueryResult> {
    await this.drain();
    return this.client.query(config as never) as unknown as Promise<QueryResult>;
  }

  /**
   * Ends a cursor before the connection is used again. A cursor the server refused has sent its Sync already (its portal goes
   * with it): it is not closed again (a lone Close that PGlite answers with one more ReadyForQuery); the rest of its exchange is
   * drained, so the transaction state is known before the run reports its end.
   */
  private async closeCursor(cursor: Cursor): Promise<void> {
    const state = cursorState(cursor);
    if (state === 'done') return;
    if (state === 'error') { await this.drain(); return; }
    try { await cursor.close(); } catch { /* the connection is gone */ }
  }

  /** Loads the names of the built-in types once (user types are looked up when a result names them). */
  async init(): Promise<void> {
    const r = await this.raw(`SELECT oid, format_type(oid, NULL), typcategory FROM pg_type WHERE oid < 16384`);
    for (const row of r) this.types.set(Number(row[0]), { name: row[1] ?? '', category: row[2] ?? '' });
  }

  end(): void {
    this.ended = true;
    if (this.run) this.run.cancelled = true;
    if (this.open?.timer) clearTimeout(this.open.timer);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private raw(text: string, values?: unknown[]): Promise<Row[]> {
    return this.query({ text, values, rowMode: 'array', types: RAW_TYPES }).then((r) => r.rows as unknown as Row[]);
  }

  /** Runs `fn` after everything queued before it; the session reports busy while anything is queued or running. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending++ === 0) this.out.activity(true);
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined).finally(() => { if (--this.pending === 0) this.out.activity(false); });
    return next;
  }

  /** A query, page or fetchMore: counted so metadata refuses with 'busy' instead of piling up behind it. */
  private serialRun(fn: () => Promise<void>): void {
    this.runs++;
    void this.serial(fn).finally(() => { this.runs--; });
  }

  private async onServer<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight = true;
    try { return await fn(); } finally { this.inFlight = false; }
  }

  private codeOf(error: unknown): DbErrorCode {
    const server = serverError(error);
    if (!server) return this.ended ? 'noSession' : 'dbClosed';
    if (server.code === '57014') return this.cancelRequested ? 'cancelled' : /statement timeout/i.test(server.message) ? 'statementTimeout' : 'cancelled';
    if (server.code === '25006') return 'readOnly';
    return 'server';
  }

  /** A setting that must hold could not be set: the session cannot be trusted any more and ends. */
  private fatal(): never {
    this.ended = true;
    this.opts.fatal();
    throw new Error('session settings could not be restored');
  }

  private async must(sql: string): Promise<void> {
    try { await this.query(sql); } catch { this.fatal(); }
  }

  /** Runs the queued restores once nothing holds the connection (no transaction, no cursor); a failed one ends the session. */
  private async settle(): Promise<void> {
    if (this.tx !== 'idle' || this.open || !this.restore.length) return;
    const restore = this.restore;
    this.restore = [];
    for (const sql of restore) await this.must(sql);
    this.overrideActive = false;
  }

  /** Re-asserts the session settings a statement may have changed (set_config in a SELECT or a page filter). */
  private async reassert(): Promise<void> {
    if (this.tx !== 'idle' || this.open || this.overrideActive) return;
    if (this.opts.readOnly) await this.must('SET default_transaction_read_only = on');
  }

  private async columns(fields: readonly FieldLike[], canQuery: boolean): Promise<DbColumn[]> {
    const unknown = [...new Set(fields.map((f) => f.dataTypeID).filter((oid) => !this.types.has(oid)))];
    if (unknown.length && canQuery) {
      try {
        const rows = await this.raw(`SELECT t.oid, format_type(t.oid, NULL), COALESCE(b.typcategory, t.typcategory) FROM pg_type t LEFT JOIN pg_type b ON t.typtype = 'd' AND b.oid = t.typbasetype WHERE t.oid = ANY($1::oid[])`, [unknown]);
        for (const row of rows) this.types.set(Number(row[0]), { name: row[1] ?? '', category: row[2] ?? '' });
      } catch { /* names stay unknown */ }
    }
    return fields.map((f) => {
      const t = this.types.get(f.dataTypeID);
      return {
        name: f.name, typeOid: f.dataTypeID, typeName: t?.name ?? String(f.dataTypeID), kind: valueKind(f.dataTypeID, t?.category),
        ...(f.tableID ? { tableOid: f.tableID } : {}), ...(f.tableID && f.columnID ? { columnNumber: f.columnID } : {}),
      };
    });
  }

  /** Rows to the port in chunks of at most chunkRows rows or about chunkChars characters; returns the characters sent. */
  private sendRows(queryId: string, index: number, rows: readonly unknown[][]): number {
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

  private read(cursor: Cursor, count: number): Promise<{ rows: unknown[][]; result: { fields?: FieldLike[]; command?: string; rowCount?: number | null } }> {
    return this.onServer(() => new Promise((resolve, reject) => {
      cursor.read(count, (err: Error | undefined, rows: unknown[][], result: unknown) => (err ? reject(err) : resolve({ rows, result: result as { fields?: FieldLike[] } })));
    }));
  }

  private async reader(text: string, values?: unknown[]): Promise<Reader> {
    await this.drain();
    const cursor = this.client.query(new Cursor(text, values as never, { rowMode: 'array', types: RAW_TYPES } as never));
    return { cursor, fields: null, columnsSent: false, buffered: [], done: false, batch: 100, result: {} };
  }

  /**
   * Reads and sends up to `max` rows in batches (smaller ones for wide rows) and stops early at DB_LIMITS.pageChars characters,
   * so a result of huge rows never sits in memory whole. Reads one row ahead to know whether more follow.
   */
  private async pump(queryId: string, index: number, r: Reader, max: number): Promise<number> {
    let sent = 0;
    let chars = 0;
    while (sent < max && !(r.done && !r.buffered.length) && chars < DB_LIMITS.pageChars) {
      let rows: unknown[][];
      if (r.buffered.length) { rows = r.buffered; r.buffered = []; }
      else {
        const want = Math.min(r.batch, max - sent);
        const got = await this.read(r.cursor, want);
        if (!r.fields) r.fields = got.result.fields ?? [];
        r.result = got.result;
        if (got.rows.length < want) r.done = true;
        rows = got.rows;
      }
      if (!r.columnsSent && r.fields) {
        r.columnsSent = true;
        if (r.fields.length) this.out.port({ t: 'columns', queryId, index, columns: await this.columns(r.fields, r.done) });
      }
      if (rows.length) {
        chars += this.sendRows(queryId, index, rows);
        sent += rows.length;
        const perRow = Math.max(1, chars / sent);
        r.batch = Math.max(1, Math.min(DB_LIMITS.chunkRows, Math.floor(DB_LIMITS.chunkChars / perRow)));
      }
    }
    if (!r.done && !r.buffered.length && sent >= max) {
      const got = await this.read(r.cursor, 1);
      r.result = got.result;
      if (got.rows.length) r.buffered = got.rows; else r.done = true;
    }
    if (!r.columnsSent && r.fields) {
      r.columnsSent = true;
      if (r.fields.length) this.out.port({ t: 'columns', queryId, index, columns: await this.columns(r.fields, r.done) });
    }
    return sent;
  }

  private armIdle(open: OpenResult): void {
    if (open.timer) clearTimeout(open.timer);
    open.timer = setTimeout(() => {
      void this.serial(async () => { if (this.open === open) { await this.closeOpen(); await this.settle().catch(() => undefined); } });
    }, this.opts.cursorIdleMs ?? DB_LIMITS.cursorIdleMs);
  }

  /** Closes the open result cursor (the connection is needed for something else, or nobody fetched for a while). */
  private async closeOpen(): Promise<void> {
    const open = this.open;
    if (!open) return;
    this.open = null;
    if (open.timer) clearTimeout(open.timer);
    await this.closeCursor(open.reader.cursor);
    this.out.port({ t: 'resultClosed', queryId: open.queryId, index: open.index });
  }

  // ── operations ─────────────────────────────────────────────────────────────

  /**
   * One operation. query, tablePage and fetchMore answer once accepted (their rows and their end go to the port); cancel runs
   * at once; metadata and edits answer 'busy' while a run is queued or running, else wait their turn and answer with the value.
   */
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
      default:
        if (this.runs > 0 || this.metaPending >= 4) return Promise.resolve(fail('busy'));
        this.metaPending++;
        return this.serial(async () => {
          try {
            await this.closeOpen();
            await this.settle();
            return await this.meta(op);
          } catch (error) {
            if (error instanceof DbSqlError) return fail(error.code);
            const server = serverError(error);
            return fail(this.ended ? 'dbFailed' : this.codeOf(error), server ?? undefined);
          } finally { this.metaPending--; }
        });
    }
  }

  private async meta(op: DbHostOp): Promise<DbResult<unknown>> {
    const q = (text: string, params?: unknown[]) => this.raw(text, params);
    switch (op.op) {
      case 'databases': return ok(await listDatabases(q));
      case 'schemas': return ok(await listSchemas(q));
      case 'objects': return ok(await listObjects(q, op.schema));
      case 'tableInfo': { const info = await tableInfo(q, op.schema, op.name); return info ? ok(info) : fail('notFound'); }
      case 'ddl': { const ddl = await objectDdl(q, op.schema, op.name, op.kind, op.args); return ddl === null ? fail('notFound') : ok(ddl); }
      case 'transaction': {
        if (op.action === 'begin') await this.reassert();
        await this.query(op.action === 'begin' ? 'BEGIN' : op.action === 'commit' ? 'COMMIT' : 'ROLLBACK');
        await this.settle();
        return ok(this.tx);
      }
      case 'previewEdits': {
        const built = await this.buildEdits(op.req);
        return 'error' in built ? built.error : ok({ sql: editPreview(built.statements), statements: built.statements.length });
      }
      case 'applyEdits': return this.applyEdits(op.req);
      case 'cellValue': return this.cellValue(op.req);
      default: return fail('invalid');
    }
  }

  // ── cancel ─────────────────────────────────────────────────────────────────

  /** Stops the running statement and the rest of its run; true when a cancel was sent. */
  private async cancel(): Promise<boolean> {
    if (this.run) this.run.cancelled = true;
    if (!this.inFlight) return false;
    this.cancelRequested = true;
    const pid = (this.client as unknown as { processID: number | null }).processID;
    const secret = (this.client as unknown as { secretKey: number | null }).secretKey;
    if (pid === null || pid === undefined) return false;
    try {
      const side = await this.opts.sideConnection();
      try {
        const r = await side.query({ text: 'SELECT pg_cancel_backend($1)', values: [pid], rowMode: 'array', types: RAW_TYPES } as never) as QueryResult;
        if ((r.rows as unknown as Row[])[0]?.[0] === 't') return true;
      } finally { void side.end().catch(() => undefined); }
    } catch { /* no side connection: the protocol cancel below */ }
    if (secret === null || secret === undefined) return false;
    try { await this.opts.cancelRequest(pid, secret); return true; } catch { return false; }
  }

  // ── queries ────────────────────────────────────────────────────────────────

  private async runQuery(req: DbQueryRequest): Promise<void> {
    const started = this.now();
    const run: Run = { queryId: req.queryId, cancelled: false };
    this.run = run;
    this.cancelRequested = false;
    this.noticeTarget = req.queryId;
    let allOk = true;
    const override = req.readWrite === true && this.opts.readOnly;
    const refuse = (code: DbErrorCode, index = 0) => {
      allOk = false;
      this.out.port({ t: 'statementError', queryId: req.queryId, index, error: code, timeMs: this.now() - started });
    };
    try {
      await this.closeOpen();
      await this.settle();
      const spans = splitSql(req.sql);
      const rowCap = Math.max(1, Math.min(DB_LIMITS.rowCapMax, Math.floor(req.rowCap ?? DB_LIMITS.rowCap)));
      if (this.opts.readOnly && !override) {
        // An override's transaction is still open: only ending it may run without the override.
        if (this.overrideActive && !spans.every((s) => endsTransaction(s.text))) { refuse('inTransaction'); return; }
        // Checked before anything runs: a refused statement anywhere stops the whole script.
        const bad = spans.findIndex((s) => !readOnlyAllows(s.text));
        if (bad >= 0) { refuse('readOnly', bad); return; }
      }
      if (override) {
        if (this.tx !== 'idle') { refuse('inTransaction'); return; }
        await this.query('SET default_transaction_read_only = off');
        this.overrideActive = true;
        this.restore.push('SET default_transaction_read_only = on');
      }
      if (req.statementTimeoutMs !== undefined && req.statementTimeoutMs !== null && req.statementTimeoutMs !== this.opts.statementTimeoutMs) {
        const ms = Math.max(0, Math.min(DB_LIMITS.statementTimeoutMaxMs, Math.floor(req.statementTimeoutMs)));
        await this.query(`SET statement_timeout = ${ms}`);
        // Without a connection setting the server's (or the role's) default comes back, not 0.
        this.restore.push(this.opts.statementTimeoutMs ? `SET statement_timeout = ${Math.floor(this.opts.statementTimeoutMs)}` : 'RESET statement_timeout');
      }
      for (let i = 0; i < spans.length; i++) {
        if (run.cancelled || this.ended) break;
        const span = spans[i];
        // A function a statement called may have switched read-only off for the session: set again before the next one.
        if (!override) await this.reassert();
        this.out.port({ t: 'statement', queryId: req.queryId, index: i, start: span.start, end: span.end });
        const t0 = this.now();
        try {
          await this.statement(req.queryId, i, span.text, rowCap, i === spans.length - 1);
        } catch (error) {
          if (this.ended) throw error;
          allOk = false;
          const server = serverError(error);
          this.out.port({ t: 'statementError', queryId: req.queryId, index: i, error: this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - t0 });
          if (!req.continueOnError || !server) break;
        }
      }
    } catch (error) {
      allOk = false;
      const server = serverError(error);
      this.out.port({ t: 'statementError', queryId: req.queryId, index: 0, error: this.ended ? 'dbFailed' : this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - started });
    } finally {
      try { if (!this.ended) { await this.settle(); if (!override) await this.reassert(); } } catch { allOk = false; }
      this.noticeTarget = this.open ? req.queryId : null;
      if (this.run === run) this.run = null;
      this.out.port({ t: 'queryEnd', queryId: req.queryId, ok: allOk && !run.cancelled, cancelled: run.cancelled, timeMs: this.now() - started, tx: this.tx });
    }
  }

  /**
   * One statement. Row-returning ones go through a cursor read in bounded batches; only a read-only statement that is the last
   * of the run keeps its cursor open for "load more". Any other (... RETURNING, CALL, EXECUTE, or an earlier statement) is
   * read up to the cap and closed at once (its changes commit now), reported with truncated when rows were left.
   */
  private async statement(queryId: string, index: number, text: string, rowCap: number, last: boolean): Promise<void> {
    const t0 = this.now();
    if (!returnsRows(text)) {
      const r = await this.onServer(() => this.query({ text, rowMode: 'array', types: RAW_TYPES } as never)) as unknown as QueryResult | QueryResult[];
      const results = Array.isArray(r) ? r : [r];
      const res = results[results.length - 1];
      const fields = (res.fields ?? []) as FieldLike[];
      const rows = (res.rows ?? []) as unknown as unknown[][];
      if (fields.length) {
        this.out.port({ t: 'columns', queryId, index, columns: await this.columns(fields, true) });
        this.sendRows(queryId, index, rows.slice(0, rowCap));
      }
      this.out.port({ t: 'statementEnd', queryId, index, command: res.command ?? '', rowCount: res.rowCount ?? null, rows: Math.min(rows.length, rowCap), hasMore: false, ...(rows.length > rowCap ? { truncated: true } : {}), timeMs: this.now() - t0 });
      return;
    }
    const reader = await this.reader(text);
    let sent: number;
    try { sent = await this.pump(queryId, index, reader, rowCap); } catch (error) { await this.closeCursor(reader.cursor); throw error; }
    const more = !reader.done || reader.buffered.length > 0;
    const keep = more && last && isReadStatement(text);
    if (more && !keep) {
      await this.closeCursor(reader.cursor);
      this.out.port({ t: 'statementEnd', queryId, index, command: firstKeyword(text) || 'SELECT', rowCount: null, rows: sent, hasMore: false, truncated: true, timeMs: this.now() - t0 });
      return;
    }
    const command = reader.result.command ?? '';
    this.out.port({ t: 'statementEnd', queryId, index, command: keep ? 'SELECT' : command, rowCount: keep ? null : (command === 'SELECT' ? sent : reader.result.rowCount ?? sent), rows: sent, hasMore: keep, timeMs: this.now() - t0 });
    if (!keep) return;
    this.open = { queryId, index, reader, sent, timer: null };
    this.armIdle(this.open);
  }

  private async fetchMore(queryId: string, count: number): Promise<void> {
    const open = this.open;
    if (!open || open.queryId !== queryId) return;
    const n = Math.max(1, Math.min(DB_LIMITS.rowCapMax, Math.floor(count)));
    const t0 = this.now();
    this.cancelRequested = false;
    this.noticeTarget = queryId;
    try {
      const sent = await this.pump(queryId, open.index, open.reader, n);
      open.sent += sent;
      const hasMore = !open.reader.done || open.reader.buffered.length > 0;
      // The last Execute's CommandComplete counts only its own rows: a SELECT's total is what was sent.
      this.out.port({ t: 'statementEnd', queryId, index: open.index, command: 'SELECT', rowCount: hasMore ? null : open.sent, rows: open.sent, hasMore, timeMs: this.now() - t0 });
      if (hasMore) { this.armIdle(open); return; }
      this.open = null;
      if (open.timer) clearTimeout(open.timer);
      await this.settle();
      await this.reassert();
    } catch (error) {
      if (this.open === open) this.open = null;
      if (open.timer) clearTimeout(open.timer);
      const server = serverError(error);
      this.out.port({ t: 'statementError', queryId, index: open.index, error: this.ended ? 'dbFailed' : this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - t0 });
      await this.closeCursor(open.reader.cursor);
      if (!this.ended) await this.settle().catch(() => undefined);
    }
  }

  // ── table pages ────────────────────────────────────────────────────────────

  private async editKey(schema: string, table: string): Promise<string[] | null> {
    const id = `${schema}\0${table}`;
    const cached = this.keys.get(id);
    if (cached && this.now() - cached.at < 30_000) return cached.key;
    const info = await tableInfo((text, params) => this.raw(text, params), schema, table);
    const key = info?.editKey ?? null;
    this.keys.set(id, { at: this.now(), key });
    return key;
  }

  /**
   * One page of a table inside a READ ONLY transaction, read in bounded batches. The filter is the user's own SQL: the READ
   * ONLY transaction stops data changes, not every side effect of the functions it calls, so the session settings are set
   * again after the page.
   */
  private async runPage(req: DbTablePageRequest): Promise<void> {
    const started = this.now();
    const run: Run = { queryId: req.queryId, cancelled: false };
    this.run = run;
    this.cancelRequested = false;
    this.noticeTarget = req.queryId;
    let success = false;
    const error = (code: DbErrorCode, server?: DbServerError) => this.out.port({ t: 'statementError', queryId: req.queryId, index: 0, error: code, ...(server ? { server } : {}), timeMs: this.now() - started });
    try {
      await this.closeOpen();
      await this.settle();
      if (this.tx !== 'idle') { error('inTransaction'); return; }
      await this.reassert();
      const key = await this.editKey(req.schema, req.table);
      let built: ReturnType<typeof pageSql>;
      try { built = pageSql(req, key); } catch { error('invalid'); return; }
      this.out.port({ t: 'statement', queryId: req.queryId, index: 0, start: 0, end: 0 });
      await this.query('BEGIN READ ONLY');
      const limit = Math.floor(req.limit);
      let sent = 0;
      let more = false;
      try {
        const reader = await this.reader(built.sql, built.params);
        try { sent = await this.pump(req.queryId, 0, reader, limit); } catch (e) { await this.closeCursor(reader.cursor); throw e; }
        more = !reader.done || reader.buffered.length > 0;
        if (!reader.done) await this.closeCursor(reader.cursor);
        await this.query('COMMIT');
      } catch (e) {
        try { await this.query('ROLLBACK'); } catch { /* gone */ }
        throw e;
      }
      this.out.port({ t: 'statementEnd', queryId: req.queryId, index: 0, command: 'SELECT', rowCount: sent, rows: sent, hasMore: more, timeMs: this.now() - started });
      success = true;
    } catch (e) {
      const server = serverError(e);
      error(this.ended ? 'dbFailed' : this.codeOf(e), server ?? undefined);
    } finally {
      try {
        if (!this.ended) {
          await this.reassert();
          if (this.opts.statementTimeoutMs && this.tx === 'idle') await this.must(`SET statement_timeout = ${Math.floor(this.opts.statementTimeoutMs)}`);
        }
      } catch { success = false; }
      if (this.run === run) this.run = null;
      this.noticeTarget = null;
      this.out.port({ t: 'queryEnd', queryId: req.queryId, ok: success, cancelled: run.cancelled, timeMs: this.now() - started, tx: this.tx });
    }
  }

  // ── edits ──────────────────────────────────────────────────────────────────

  private async buildEdits(req: DbEditRequest): Promise<{ statements: ReturnType<typeof buildEditStatements> } | { error: DbResult<never> }> {
    const info = await tableInfo((text, params) => this.raw(text, params), req.schema, req.table);
    if (!info) return { error: fail('notFound') };
    const needsKey = req.edits.some((e) => e.op !== 'insert');
    if (needsKey && !info.editKey) return { error: fail('noKey') };
    try {
      const statements = buildEditStatements(req.schema, req.table, info.editKey, req.edits, info.columns.map((c) => c.name), info.columns.filter((c) => c.generated).map((c) => c.name),
        Object.fromEntries(info.columns.map((c) => [c.name, c.typeName])));
      return { statements };
    } catch (error) {
      return { error: fail(error instanceof DbSqlError ? error.code : 'invalid') };
    }
  }

  /** All edits in one transaction; an UPDATE or DELETE that does not hit exactly one row rolls everything back. */
  private async applyEdits(req: DbEditRequest): Promise<DbResult<{ affected: number }>> {
    if (this.opts.readOnly) return fail('readOnly');
    if (this.tx !== 'idle') return fail('inTransaction');
    const built = await this.buildEdits(req);
    if ('error' in built) return built.error;
    await this.query('BEGIN');
    let affected = 0;
    for (const s of built.statements) {
      let r: QueryResult;
      try {
        r = await this.onServer(() => this.query({ text: s.sql, values: s.params, rowMode: 'array', types: RAW_TYPES } as never)) as unknown as QueryResult;
      } catch (error) {
        try { await this.query('ROLLBACK'); } catch { /* gone */ }
        const server = serverError(error);
        return fail(this.codeOf(error), server ?? undefined, s.index);
      }
      if (s.op !== 'insert' && r.rowCount !== 1) {
        try { await this.query('ROLLBACK'); } catch { /* gone */ }
        return fail('conflict', undefined, s.index);
      }
      affected += r.rowCount ?? 0;
    }
    try { await this.query('COMMIT'); } catch (error) {
      try { await this.query('ROLLBACK'); } catch { /* gone */ }
      const server = serverError(error);
      return fail(this.codeOf(error), server ?? undefined);
    }
    // COMMIT of a failed transaction answers ROLLBACK without an error.
    if (this.tx !== 'idle') return fail('dbFailed');
    this.keys.clear();
    return ok({ affected });
  }

  private async cellValue(req: DbCellRequest): Promise<DbResult<string | null>> {
    const key = await this.editKey(req.schema, req.table);
    if (!key) return fail('noKey');
    let built: ReturnType<typeof cellSql>;
    try { built = cellSql(req.schema, req.table, req.column, req.key, key); } catch { return fail('invalid'); }
    const rows = await this.raw(built.sql, built.params);
    if (rows.length !== 1) return fail(rows.length ? 'conflict' : 'notFound');
    const v = rows[0][0];
    return ok(v === null ? null : v.slice(0, DB_LIMITS.fullValueChars));
  }
}
