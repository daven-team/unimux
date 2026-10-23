// One SQLite session of the DB Host (1.0.6), the counterpart of PgSession and MysqlSession: its connection lives in a worker
// thread of its own (sqliteWorker.ts), so a long statement never blocks the host. Runs its operations one at a time, streams rows
// to the renderer over the DB port in bounded batches, keeps at most one read-only result open for "load more" (an open
// statement holds a read lock on the file, so it is closed when anything else runs or after DB_LIMITS.cursorIdleMs), refuses
// writes on read-only connections on the client side and with PRAGMA query_only, and applies staged edits in one
// BEGIN IMMEDIATE transaction. Cancel sets the worker's interrupt flag (checked between rows); a statement that does not stop
// within a moment (one step of SQLite running long, or waiting for another program's lock) ends with its worker: the session
// opens the file again, and an open transaction is rolled back.
import type { Worker } from 'node:worker_threads';
import {
  DB_LIMITS, SQLITE_MAIN, type DbCellRequest, type DbColumn, type DbEditRequest, type DbErrorCode, type DbPortMessage, type DbQueryRequest, type DbResult,
  type DbServerError, type DbTablePageRequest, type DbTxStatus, type DbValue,
} from '../shared/db';
import { DbSqlError, firstKeyword, splitSql } from '../shared/dbSql';
import {
  sqliteCellSql, sqliteEditPreview, sqliteEditStatements, sqliteEndsTransaction, sqliteErrorPosition, sqliteIsReadStatement, sqlitePageSql,
  sqliteReadOnlyAllows, sqliteValueKind, type SqliteBuiltStatement, type SqliteParam,
} from '../shared/dbSqlite';
import type { DbHostOp } from '../shared/dbHostIpc';
import type { SqliteColumnOut, SqliteWorkerError, SqliteWorkerReply, SqliteWorkerRequest } from './sqliteWorker';
import { listObjects, objectDdl, tableInfo, type SqRow, type SqliteTableInfo } from './sqliteMeta';

export interface SqliteSessionOut {
  port(m: DbPortMessage): void;
  tx(tx: DbTxStatus): void;
  activity(busy: boolean): void;
  /** Something to tell the user outside of a run (the connection was opened again after a cancel). */
  notice?(message: string): void;
}

export interface SqliteSessionOptions {
  path: string;
  readOnly: boolean;
  /** A new engine thread (the host passes the built worker; tests the TypeScript file). */
  spawn(interrupt: SharedArrayBuffer): Worker;
  /** The session cannot go on (its worker died, the file cannot be opened again): it must end. */
  fatal(error: DbErrorCode, message?: string): void;
  /** How long SQLite waits for another program's lock before it reports the file as locked. */
  busyMs?: number;
  /** How long a cancelled statement may take to stop before its worker is ended. */
  killGraceMs?: number;
  cursorIdleMs?: number;
  now?(): number;
}

/** What the engine answered, or why there is no answer. */
export class SqliteError extends Error {
  constructor(readonly info: SqliteWorkerError) { super(info.message); }
}

const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const fail = (error: DbErrorCode, server?: DbServerError, index?: number): DbResult<never> => ({ ok: false, error, ...(server ? { server } : {}), ...(index !== undefined ? { index } : {}) });

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_INTERRUPT = 9;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

/** The error code the UI shows for an engine error. */
export function sqliteErrorCode(e: SqliteWorkerError): DbErrorCode {
  if (e.interrupted || e.errcode === SQLITE_INTERRUPT) return 'cancelled';
  const primary = e.errcode === null ? null : e.errcode & 0xff;
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return 'dbLocked';
  if (primary === SQLITE_READONLY || /attempt to write a readonly database/i.test(e.message)) return 'readOnly';
  if (primary === SQLITE_NOTADB) return 'dbNotSqlite';
  if (primary === SQLITE_CANTOPEN) return 'dbFileMissing';
  return e.errcode !== null ? 'server' : 'dbFailed';
}

/** The server error of an engine error (its message, SQLITE_<code> and, for a syntax error, the position in `sql`). */
export function sqliteServerError(e: SqliteWorkerError, sql?: string): DbServerError | undefined {
  if (e.errcode === null || e.interrupted) return undefined;
  const position = sql ? sqliteErrorPosition(e.message, sql) : null;
  return { message: e.message.slice(0, DB_LIMITS.serverText), code: `SQLITE_${e.errcode}`, severity: 'ERROR', ...(position ? { position } : {}) };
}

/** Rows a single engine request returns at most (the batches the renderer gets are cut from these). */
const BATCH_ROWS = 500;

/** The worker side of a session: requests in order, one answer each; the interrupt flag; ending and opening it again. */
class EngineLink {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve(r: SqliteWorkerReply): void }>();
  private readonly flag = new SharedArrayBuffer(4);
  readonly interrupt = new Int32Array(this.flag);
  private killed = false;
  /** In flight right now (cancel waits for it, then ends the worker). */
  inFlight = 0;

  constructor(private readonly spawn: (flag: SharedArrayBuffer) => Worker, private readonly died: (error: string) => void) {}

  alive(): boolean { return !!this.worker; }
  /** The newest request, and whether it still waits for its answer (a cancel ends the worker only for the request it saw). */
  lastRequest(): number { return this.seq; }
  waiting(id: number): boolean { return this.pending.has(id); }

  start(): void {
    const w = this.spawn(this.flag);
    this.worker = w;
    this.killed = false;
    w.on('message', (m: { id: number; reply: SqliteWorkerReply }) => { const p = this.pending.get(m.id); this.pending.delete(m.id); p?.resolve(m.reply); });
    const gone = (why: string) => {
      if (this.worker !== w) return;
      this.worker = null;
      this.flush(why);
      if (!this.killed) this.died(why);
    };
    w.on('error', (e) => gone(e instanceof Error ? e.message : String(e)));
    w.on('exit', () => gone('the SQLite worker ended'));
  }

  private flush(why: string): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.resolve({ ok: false, inTx: false, error: { message: why, errcode: null, code: null, ...(this.killed ? { interrupted: true as const } : {}) } });
  }

  async request(req: SqliteWorkerRequest): Promise<SqliteWorkerReply> {
    if (!this.worker) return { ok: false, inTx: false, error: { message: 'no worker', errcode: null, code: null } };
    const id = ++this.seq;
    this.inFlight++;
    try {
      return await new Promise<SqliteWorkerReply>((resolve) => { this.pending.set(id, { resolve }); this.worker!.postMessage({ id, req }); });
    } finally { this.inFlight--; }
  }

  /** Ends the worker now: every request waiting for it answers "interrupted". */
  kill(): void {
    const w = this.worker;
    if (!w) return;
    this.killed = true;
    this.worker = null;
    this.flush('interrupted');
    void w.terminate().catch(() => undefined);
  }

  /** Asks the worker to close the file and end. */
  async shutdown(): Promise<void> {
    const w = this.worker;
    if (!w) return;
    this.killed = true;
    const t = setTimeout(() => { void w.terminate().catch(() => undefined); }, 2000);
    await this.request({ t: 'shutdown' }).catch(() => undefined);
    clearTimeout(t);
    this.worker = null;
    void w.terminate().catch(() => undefined);
  }
}

interface Run { queryId: string; cancelled: boolean }
interface OpenResult { queryId: string; index: number; cursor: number; sent: number; timer: NodeJS.Timeout | null }

export class SqliteSession {
  tx: DbTxStatus = 'idle';
  serverVersion = '';
  journalMode = '';
  /** The file could be opened read-only only (a read-only medium or folder): writes fail in SQLite itself. */
  fileReadOnly = false;
  private link: EngineLink;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private runs = 0;
  private metaPending = 0;
  private open: OpenResult | null = null;
  private run: Run | null = null;
  private cursorSeq = 0;
  private ended = false;
  private keys = new Map<string, { at: number; info: SqliteTableInfo | null }>();
  /** query_only is off for a run with writes allowed (read-only connections); switched back once no transaction is open. */
  private overrideActive = false;
  /** The worker was ended (a cancel that did not stop): the next operation opens the file again. */
  private reopen = false;

  constructor(private readonly opts: SqliteSessionOptions, private readonly out: SqliteSessionOut) {
    this.link = new EngineLink((flag) => opts.spawn(flag), (why) => { if (!this.ended) { this.ended = true; opts.fatal('dbFailed', why); } });
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  /** Starts the engine and opens the file; throws a SqliteError when it cannot be opened. */
  async connect(): Promise<void> {
    this.link.start();
    let r = await this.link.request({ t: 'open', path: this.opts.path, readOnly: false, busyMs: this.opts.busyMs ?? 5000, cellChars: DB_LIMITS.cellChars });
    // A file this computer may only read (or a folder where no journal can be written) still opens, read-only.
    if (!r.ok && this.opts.readOnly && r.error.errcode !== null && [SQLITE_READONLY, SQLITE_CANTOPEN].includes(r.error.errcode & 0xff)) {
      await this.link.shutdown();
      this.link.start();
      r = await this.link.request({ t: 'open', path: this.opts.path, readOnly: true, busyMs: this.opts.busyMs ?? 5000, cellChars: DB_LIMITS.cellChars });
      this.fileReadOnly = r.ok;
    }
    if (!r.ok) { await this.link.shutdown(); throw new SqliteError(r.error); }
    this.serverVersion = r.version ?? '';
    this.journalMode = r.journal ?? '';
    if (this.opts.readOnly && !this.fileReadOnly) await this.mustExec('PRAGMA query_only = 1');
  }

  end(): void {
    this.ended = true;
    if (this.run) this.run.cancelled = true;
    if (this.open?.timer) clearTimeout(this.open.timer);
    void this.link.shutdown();
  }

  busy(): boolean { return this.link.inFlight > 0 || !!this.open || this.pending > 0; }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private setTx(inTx: boolean): void {
    const tx: DbTxStatus = inTx ? 'transaction' : 'idle';
    if (tx !== this.tx) { this.tx = tx; this.out.tx(tx); }
  }

  /** One engine request; its transaction state is taken; an error throws (SqliteError). */
  private async req(req: SqliteWorkerRequest): Promise<Extract<SqliteWorkerReply, { ok: true }>> {
    if (this.reopen) await this.reconnect();
    const r = await this.link.request(req);
    this.setTx(r.inTx);
    if (!r.ok) throw new SqliteError(r.error);
    return r;
  }

  private async exec(sql: string, params?: SqliteParam[]): Promise<Extract<SqliteWorkerReply, { ok: true }>> {
    return this.req({ t: 'exec', sql, ...(params?.length ? { params } : {}) });
  }

  private async mustExec(sql: string): Promise<void> {
    if (this.reopen) { await this.reconnect(); return; }
    const r = await this.link.request({ t: 'exec', sql });
    if (!r.ok) { this.ended = true; this.opts.fatal('dbFailed', r.error.message); throw new SqliteError(r.error); }
  }

  private async meta(sql: string, params?: SqliteParam[]): Promise<SqRow[]> {
    const r = await this.exec(sql, params);
    return (r.rows ?? []).map((row) => row.map((v) => (v === null ? null : typeof v === 'string' ? v : v.head)));
  }

  /** After a cancel ended the worker: the file is opened again (its transaction is gone, the read-only guard is set again). */
  private async reconnect(): Promise<void> {
    this.reopen = false;
    this.overrideActive = false;
    this.link.start();
    const r = await this.link.request({ t: 'open', path: this.opts.path, readOnly: this.fileReadOnly, busyMs: this.opts.busyMs ?? 5000, cellChars: DB_LIMITS.cellChars });
    if (!r.ok) { this.ended = true; this.opts.fatal(sqliteErrorCode(r.error), r.error.message); throw new SqliteError(r.error); }
    if (this.opts.readOnly && !this.fileReadOnly) await this.mustExec('PRAGMA query_only = 1');
    this.setTx(false);
  }

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

  private codeOf(error: unknown): DbErrorCode {
    if (error instanceof DbSqlError) return error.code;
    if (error instanceof SqliteError) return this.ended ? 'noSession' : sqliteErrorCode(error.info);
    return this.ended ? 'noSession' : 'dbFailed';
  }

  /** Writes are back off (read-only connections) once the run that allowed them left no transaction open. */
  private async settle(): Promise<void> {
    if (!this.overrideActive || this.tx !== 'idle' || this.open) return;
    this.overrideActive = false;
    await this.mustExec('PRAGMA query_only = 1');
  }

  private columns(cols: readonly SqliteColumnOut[]): DbColumn[] {
    return cols.map((c) => ({ name: c.name, typeOid: 0, typeName: c.type ?? '', kind: sqliteValueKind(c.type) }));
  }

  private sendRows(queryId: string, index: number, rows: ReadonlyArray<ReadonlyArray<DbValue>>): void {
    let chunk: DbValue[][] = [];
    let chars = 0;
    for (const row of rows) {
      chunk.push(row as DbValue[]);
      for (const v of row) chars += v === null ? 4 : typeof v === 'string' ? v.length : v.head.length;
      if (chunk.length >= DB_LIMITS.chunkRows || chars >= DB_LIMITS.chunkChars) { this.out.port({ t: 'rows', queryId, index, rows: chunk }); chunk = []; chars = 0; }
    }
    if (chunk.length) this.out.port({ t: 'rows', queryId, index, rows: chunk });
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
    await this.link.request({ t: 'close', cursor: open.cursor });
    this.out.port({ t: 'resultClosed', queryId: open.queryId, index: open.index });
  }

  // ── operations ─────────────────────────────────────────────────────────────

  handle(op: DbHostOp): Promise<DbResult<unknown>> {
    if (this.ended) return Promise.resolve(fail('noSession'));
    switch (op.op) {
      case 'cancel': return Promise.resolve(ok(this.cancel()));
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
            return fail(this.codeOf(error), error instanceof SqliteError ? sqliteServerError(error.info) : undefined);
          } finally { this.metaPending--; }
        });
    }
  }

  private async metaOp(op: DbHostOp): Promise<DbResult<unknown>> {
    const q = (sql: string, params?: SqliteParam[]) => this.meta(sql, params);
    switch (op.op) {
      case 'databases': return ok([{ name: SQLITE_MAIN, owner: '', encoding: '', isTemplate: false, allowConnections: true, sizeBytes: null }]);
      case 'schemas': return ok([{ name: SQLITE_MAIN, owner: '', system: false }]);
      case 'objects': return ok(await listObjects(q, op.schema));
      case 'tableInfo': {
        const info = await this.info(op.schema, op.name, true);
        if (!info) return fail('notFound');
        const { rowid: _rowid, affinities: _aff, ...rest } = info;
        return ok(rest);
      }
      case 'ddl': { const ddl = await objectDdl(q, op.schema, op.name, op.kind); return ddl === null ? fail('notFound') : ok(ddl); }
      case 'transaction': {
        if (op.action === 'begin' && this.tx !== 'idle') return ok(this.tx);
        if (op.action !== 'begin' && this.tx === 'idle') return ok(this.tx);
        await this.exec(op.action === 'begin' ? 'BEGIN' : op.action === 'commit' ? 'COMMIT' : 'ROLLBACK');
        await this.settle();
        return ok(this.tx);
      }
      case 'previewEdits': {
        const built = await this.buildEdits(op.req);
        return 'error' in built ? built.error : ok({ sql: sqliteEditPreview(built.statements), statements: built.statements.length });
      }
      case 'applyEdits': return this.applyEdits(op.req);
      case 'cellValue': return this.cellValue(op.req);
      default: return fail('invalid');
    }
  }

  // ── cancel ─────────────────────────────────────────────────────────────────

  /**
   * Stops the running statement: the interrupt flag first (a row loop stops at once); a statement still running after
   * killGraceMs (inside one long step of SQLite, or waiting for a lock) ends with its worker.
   */
  private cancel(): boolean {
    if (this.run) this.run.cancelled = true;
    if (this.link.inFlight === 0) return false;
    Atomics.store(this.link.interrupt, 0, 1);
    const link = this.link;
    const target = link.lastRequest();
    setTimeout(() => {
      if (link !== this.link || !link.waiting(target) || this.ended) return;
      link.kill();
      this.reopen = true;
      this.open = null;
      this.setTx(false);
      this.out.notice?.('SQLite: the statement did not stop, so its connection was closed and the file opened again (an open transaction was rolled back).');
    }, this.opts.killGraceMs ?? 1500).unref?.();
    return true;
  }

  private clearInterrupt(): void { Atomics.store(this.link.interrupt, 0, 0); }

  // ── queries ────────────────────────────────────────────────────────────────

  private async runQuery(req: DbQueryRequest): Promise<void> {
    const started = this.now();
    const run: Run = { queryId: req.queryId, cancelled: false };
    this.run = run;
    this.clearInterrupt();
    let allOk = true;
    const override = req.readWrite === true && this.opts.readOnly;
    const refuse = (code: DbErrorCode, index = 0) => {
      allOk = false;
      this.out.port({ t: 'statementError', queryId: req.queryId, index, error: code, timeMs: this.now() - started });
    };
    try {
      await this.closeOpen();
      await this.settle();
      const spans = splitSql(req.sql, 'sqlite');
      const rowCap = Math.max(1, Math.min(DB_LIMITS.rowCapMax, Math.floor(req.rowCap ?? DB_LIMITS.rowCap)));
      if (this.opts.readOnly && !override) {
        if (this.overrideActive && !spans.every((s) => sqliteEndsTransaction(s.text))) { refuse('inTransaction'); return; }
        const bad = spans.findIndex((s) => !sqliteReadOnlyAllows(s.text));
        if (bad >= 0) { refuse('readOnly', bad); return; }
      }
      if (override) {
        if (this.tx !== 'idle') { refuse('inTransaction'); return; }
        await this.exec('PRAGMA query_only = 0');
        this.overrideActive = true;
      }
      for (let i = 0; i < spans.length; i++) {
        if (run.cancelled || this.ended) break;
        const span = spans[i];
        this.out.port({ t: 'statement', queryId: req.queryId, index: i, start: span.start, end: span.end });
        const t0 = this.now();
        try {
          await this.statement(req.queryId, i, span.text, rowCap, i === spans.length - 1);
        } catch (error) {
          if (this.ended) throw error;
          allOk = false;
          const server = error instanceof SqliteError ? sqliteServerError(error.info, span.text) : undefined;
          this.out.port({ t: 'statementError', queryId: req.queryId, index: i, error: this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - t0 });
          if (!req.continueOnError || !server) break;
        }
      }
    } catch (error) {
      allOk = false;
      const server = error instanceof SqliteError ? sqliteServerError(error.info) : undefined;
      this.out.port({ t: 'statementError', queryId: req.queryId, index: 0, error: this.ended ? 'dbFailed' : this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - started });
    } finally {
      try { if (!this.ended) await this.settle(); } catch { allOk = false; }
      if (this.run === run) this.run = null;
      this.clearInterrupt();
      this.out.port({ t: 'queryEnd', queryId: req.queryId, ok: allOk && !run.cancelled, cancelled: run.cancelled, timeMs: this.now() - started, tx: this.tx });
    }
  }

  /** Reads up to `max` rows of an open cursor in engine batches, sending them on; whether more follow. */
  private async pump(queryId: string, index: number, cursor: number, first: Extract<SqliteWorkerReply, { ok: true }> | null, max: number): Promise<{ sent: number; more: boolean }> {
    let sent = 0;
    let reply = first;
    let chars = 0;
    for (;;) {
      if (reply) {
        const rows = reply.rows ?? [];
        this.sendRows(queryId, index, rows);
        sent += rows.length;
        for (const row of rows) for (const v of row) chars += v === null ? 4 : typeof v === 'string' ? v.length : v.head.length;
        if (!reply.more) return { sent, more: false };
        if (sent >= max || chars >= DB_LIMITS.pageChars) return { sent, more: true };
      }
      reply = await this.req({ t: 'next', cursor, max: Math.min(BATCH_ROWS, max - sent), maxChars: DB_LIMITS.chunkChars });
    }
  }

  /**
   * One statement. Its rows stream in batches; only a read that is the last statement of the run keeps its cursor open for
   * "load more". Anything else with more rows than the cap is closed early (reported as truncated).
   */
  private async statement(queryId: string, index: number, text: string, rowCap: number, last: boolean): Promise<void> {
    const t0 = this.now();
    const cursor = ++this.cursorSeq;
    const first = await this.req({ t: 'start', cursor, sql: text, max: Math.min(BATCH_ROWS, rowCap), maxChars: DB_LIMITS.chunkChars });
    const command = firstKeyword(text) || (first.columns ? 'SELECT' : 'OK');
    if (!first.columns) {
      const changes = /^(?:INSERT|UPDATE|DELETE|REPLACE)$/.test(command) ? first.changes ?? null : null;
      this.out.port({ t: 'statementEnd', queryId, index, command, rowCount: changes, rows: 0, hasMore: false, timeMs: this.now() - t0 });
      return;
    }
    if (first.columns.length) this.out.port({ t: 'columns', queryId, index, columns: this.columns(first.columns) });
    let result: { sent: number; more: boolean };
    try { result = await this.pump(queryId, index, cursor, first, rowCap); } catch (e) { await this.link.request({ t: 'close', cursor }); throw e; }
    const keep = result.more && last && sqliteIsReadStatement(text);
    if (result.more && !keep) {
      await this.link.request({ t: 'close', cursor });
      this.out.port({ t: 'statementEnd', queryId, index, command, rowCount: null, rows: result.sent, hasMore: false, truncated: true, timeMs: this.now() - t0 });
      return;
    }
    this.out.port({ t: 'statementEnd', queryId, index, command, rowCount: keep ? null : result.sent, rows: result.sent, hasMore: keep, timeMs: this.now() - t0 });
    if (!keep) return;
    this.open = { queryId, index, cursor, sent: result.sent, timer: null };
    this.armIdle(this.open);
  }

  private async fetchMore(queryId: string, count: number): Promise<void> {
    const open = this.open;
    if (!open || open.queryId !== queryId) return;
    const n = Math.max(1, Math.min(DB_LIMITS.rowCapMax, Math.floor(count)));
    const t0 = this.now();
    this.clearInterrupt();
    try {
      const r = await this.pump(queryId, open.index, open.cursor, null, n);
      open.sent += r.sent;
      this.out.port({ t: 'statementEnd', queryId, index: open.index, command: 'SELECT', rowCount: r.more ? null : open.sent, rows: open.sent, hasMore: r.more, timeMs: this.now() - t0 });
      if (r.more) { this.armIdle(open); return; }
      this.open = null;
      if (open.timer) clearTimeout(open.timer);
      await this.link.request({ t: 'close', cursor: open.cursor });
      await this.settle();
    } catch (error) {
      if (this.open === open) this.open = null;
      if (open.timer) clearTimeout(open.timer);
      const server = error instanceof SqliteError ? sqliteServerError(error.info) : undefined;
      this.out.port({ t: 'statementError', queryId, index: open.index, error: this.ended ? 'dbFailed' : this.codeOf(error), ...(server ? { server } : {}), timeMs: this.now() - t0 });
      await this.link.request({ t: 'close', cursor: open.cursor }).catch(() => undefined);
      if (!this.ended) await this.settle().catch(() => undefined);
    } finally { this.clearInterrupt(); }
  }

  // ── table pages ────────────────────────────────────────────────────────────

  private async info(schema: string, table: string, fresh = false): Promise<SqliteTableInfo | null> {
    const id = `${schema}\0${table}`;
    const cached = this.keys.get(id);
    if (!fresh && cached && this.now() - cached.at < 30_000) return cached.info;
    const info = await tableInfo((sql, params) => this.meta(sql, params), schema, table);
    this.keys.set(id, { at: this.now(), info });
    return info;
  }

  /** One page with PRAGMA query_only on (the filter is the user's own SQL). */
  private async runPage(req: DbTablePageRequest): Promise<void> {
    const started = this.now();
    const run: Run = { queryId: req.queryId, cancelled: false };
    this.run = run;
    this.clearInterrupt();
    let success = false;
    const error = (code: DbErrorCode, server?: DbServerError) => this.out.port({ t: 'statementError', queryId: req.queryId, index: 0, error: code, ...(server ? { server } : {}), timeMs: this.now() - started });
    try {
      await this.closeOpen();
      await this.settle();
      if (this.tx !== 'idle') { error('inTransaction'); return; }
      const info = await this.info(req.schema, req.table);
      let sql: string;
      try { sql = sqlitePageSql(req, info?.editKey ?? null, info?.rowid ?? null); } catch { error('invalid'); return; }
      this.out.port({ t: 'statement', queryId: req.queryId, index: 0, start: 0, end: 0 });
      const guard = !this.opts.readOnly && !this.fileReadOnly;
      if (guard) await this.exec('PRAGMA query_only = 1');
      const cursor = ++this.cursorSeq;
      let result: { sent: number; more: boolean };
      try {
        const limit = Math.floor(req.limit);
        const first = await this.req({ t: 'start', cursor, sql, max: Math.min(BATCH_ROWS, limit), maxChars: DB_LIMITS.chunkChars });
        if (first.columns?.length) this.out.port({ t: 'columns', queryId: req.queryId, index: 0, columns: this.columns(first.columns) });
        result = await this.pump(req.queryId, 0, cursor, first, limit);
      } finally {
        await this.link.request({ t: 'close', cursor }).catch(() => undefined);
        if (guard) await this.mustExec('PRAGMA query_only = 0');
      }
      this.out.port({ t: 'statementEnd', queryId: req.queryId, index: 0, command: 'SELECT', rowCount: result.sent, rows: result.sent, hasMore: result.more, timeMs: this.now() - started });
      success = true;
    } catch (e) {
      error(this.ended ? 'dbFailed' : this.codeOf(e), e instanceof SqliteError ? sqliteServerError(e.info) : undefined);
    } finally {
      if (this.run === run) this.run = null;
      this.clearInterrupt();
      this.out.port({ t: 'queryEnd', queryId: req.queryId, ok: success, cancelled: run.cancelled, timeMs: this.now() - started, tx: this.tx });
    }
  }

  // ── edits ──────────────────────────────────────────────────────────────────

  private async buildEdits(req: DbEditRequest): Promise<{ statements: SqliteBuiltStatement[]; info: SqliteTableInfo } | { error: DbResult<never> }> {
    const info = await this.info(req.schema, req.table, true);
    if (!info) return { error: fail('notFound') };
    if (info.kind !== 'table') return { error: fail('noKey') };
    if (req.edits.some((e) => e.op !== 'insert') && !info.editKey) return { error: fail('noKey') };
    try {
      const columns = info.columns.filter((c) => c.name !== info.rowid).map((c) => ({ name: c.name, affinity: info.affinities[c.name] ?? 'blob', generated: c.generated }));
      return { statements: sqliteEditStatements(req.schema, req.table, info.editKey, req.edits, columns, info.rowid), info };
    } catch (error) {
      return { error: fail(error instanceof DbSqlError ? error.code : 'invalid') };
    }
  }

  /** All edits in one transaction (BEGIN IMMEDIATE: the write lock first); an UPDATE or DELETE that does not hit exactly one row rolls everything back. */
  private async applyEdits(req: DbEditRequest): Promise<DbResult<{ affected: number }>> {
    if (this.opts.readOnly) return fail('readOnly');
    if (this.tx !== 'idle') return fail('inTransaction');
    const built = await this.buildEdits(req);
    if ('error' in built) return built.error;
    try { await this.exec('BEGIN IMMEDIATE'); } catch (error) { return fail(this.codeOf(error), error instanceof SqliteError ? sqliteServerError(error.info) : undefined); }
    let affected = 0;
    const rollback = async () => { try { await this.exec('ROLLBACK'); } catch { /* gone */ } };
    for (const s of built.statements) {
      let r: Extract<SqliteWorkerReply, { ok: true }>;
      try {
        r = await this.exec(s.sql, s.params);
      } catch (error) {
        await rollback();
        return fail(this.codeOf(error), error instanceof SqliteError ? sqliteServerError(error.info) : undefined, s.index);
      }
      const n = r.changes ?? 0;
      if (s.op !== 'insert' && n !== 1) { await rollback(); return fail('conflict', undefined, s.index); }
      affected += n;
    }
    try { await this.exec('COMMIT'); } catch (error) {
      await rollback();
      return fail(this.codeOf(error), error instanceof SqliteError ? sqliteServerError(error.info) : undefined);
    }
    if (this.tx !== 'idle') return fail('dbFailed');
    this.keys.clear();
    return ok({ affected });
  }

  private async cellValue(req: DbCellRequest): Promise<DbResult<string | null>> {
    const info = await this.info(req.schema, req.table);
    const key = info?.editKey;
    if (!info || !key) return fail('noKey');
    let built: { sql: string; params: SqliteParam[] };
    try { built = sqliteCellSql(req.schema, req.table, req.column, req.key, key, info.columns.map((c) => ({ name: c.name, affinity: info.affinities[c.name] ?? 'blob', generated: c.generated })), info.rowid); } catch { return fail('invalid'); }
    const rows = await this.meta(built.sql, built.params);
    if (rows.length !== 1) return fail(rows.length ? 'conflict' : 'notFound');
    const v = rows[0][0];
    return ok(v === null ? null : v.slice(0, DB_LIMITS.fullValueChars));
  }
}
