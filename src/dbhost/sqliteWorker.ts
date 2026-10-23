// The SQLite engine thread of the DB Host (1.0.6): one worker per SQLite session holds its node:sqlite connection, so a long
// statement never stalls the host's other sessions. It knows statements, cursors and rows only (SqliteSession in the host
// thread builds the SQL and keeps the session's rules). Values leave it as the text the grid shows: integers in full (BigInt),
// reals in their shortest exact form, bytes as "\x..." hex, long ones cut to `cellChars` with their full length.
//
// Self-contained on purpose: only built-in modules (process.getBuiltinModule) and type imports, so the built file runs as an
// eval'd worker in the packaged app (read from the asar by the host) and as a TypeScript file in the tests.
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { MessagePort } from 'node:worker_threads';

/** A cell as the DB port carries it (DbValue). */
export type SqliteCell = string | null | { t: 'trunc'; head: string; chars: number };
export interface SqliteColumnOut { name: string; type: string | null; table: string | null; column: string | null }
export type SqliteBind = string | number | bigint | Uint8Array | null;

export type SqliteWorkerRequest =
  | { t: 'open'; path: string; readOnly: boolean; busyMs: number; cellChars: number }
  /** One statement read whole (metadata, settings, edits): its rows untruncated, or what it changed. */
  | { t: 'exec'; sql: string; params?: SqliteBind[] }
  /** One statement of a run: its first rows, its cursor kept open while more follow. */
  | { t: 'start'; cursor: number; sql: string; params?: SqliteBind[]; max: number; maxChars: number }
  | { t: 'next'; cursor: number; max: number; maxChars: number }
  | { t: 'close'; cursor: number }
  | { t: 'shutdown' };

export interface SqliteWorkerError { message: string; errcode: number | null; code: string | null; interrupted?: true }
export type SqliteWorkerReply =
  | { ok: true; inTx: boolean; version?: string; journal?: string; columns?: SqliteColumnOut[] | null; rows?: SqliteCell[][]; more?: boolean; changes?: number; lastInsertRowid?: string }
  | { ok: false; inTx: boolean; error: SqliteWorkerError };

const hex = (bytes: Uint8Array): string => {
  let out = '\\x';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
};

/** A value as its text form; `cut`: longer text arrives truncated with its full length. */
function cell(v: unknown, cut: number): SqliteCell {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : typeof v === 'bigint' ? v.toString() : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : v > 0 ? 'Inf' : v < 0 ? '-Inf' : 'NaN')
    : v instanceof Uint8Array ? hex(v) : String(v);
  return cut > 0 && s.length > cut ? { t: 'trunc', head: s.slice(0, cut), chars: s.length } : s;
}
const cellChars = (c: SqliteCell): number => (c === null ? 4 : typeof c === 'string' ? c.length : c.head.length);

/** `peek`: the row read ahead to know whether more follow (it goes out first next time). */
interface Cursor { stmt: StatementSync; iter: Iterator<unknown[]>; columns: SqliteColumnOut[]; peek: unknown[] | null }

/**
 * The engine: one connection, its open cursors, the interrupt flag (shared memory: the host sets it, a row loop checks it).
 * Exported for the tests; the worker below drives it from messages.
 */
export class SqliteEngine {
  private db: DatabaseSync | null = null;
  private cursors = new Map<number, Cursor>();
  private cut = 64 * 1024;
  private readonly interrupt: Int32Array;

  // No parameter properties: the tests run this file with Node's type stripping, which only erases types.
  constructor(interrupt: Int32Array) { this.interrupt = interrupt; }

  private inTx(): boolean { try { return !!this.db?.isTransaction; } catch { return false; } }
  private checkInterrupt(): void {
    if (Atomics.load(this.interrupt, 0) !== 0) throw Object.assign(new Error('interrupted'), { interrupted: true });
  }

  private fail(e: unknown): SqliteWorkerReply {
    const x = (e ?? {}) as { message?: unknown; errcode?: unknown; code?: unknown; interrupted?: unknown };
    const interrupted = x.interrupted === true || x.errcode === 9;
    return { ok: false, inTx: this.inTx(), error: {
      message: typeof x.message === 'string' ? x.message.slice(0, 4000) : String(e).slice(0, 4000),
      errcode: typeof x.errcode === 'number' ? x.errcode : null, code: typeof x.code === 'string' ? x.code : null, ...(interrupted ? { interrupted: true as const } : {}),
    } };
  }

  handle(m: SqliteWorkerRequest): SqliteWorkerReply {
    try {
      switch (m.t) {
        case 'open': return this.open(m);
        case 'exec': return this.exec(m.sql, m.params ?? []);
        case 'start': return this.start(m);
        case 'next': return this.next(m.cursor, m.max, m.maxChars);
        case 'close': this.closeCursor(m.cursor); return { ok: true, inTx: this.inTx() };
        case 'shutdown': this.shutdown(); return { ok: true, inTx: false };
      }
    } catch (e) { return this.fail(e); }
  }

  private open(m: Extract<SqliteWorkerRequest, { t: 'open' }>): SqliteWorkerReply {
    const { DatabaseSync: Db } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    this.cut = m.cellChars;
    // Double-quoted strings are names, never text (SQLITE_DQS off): a typo in a name is an error, not a string.
    const db = new Db(m.path, { readOnly: m.readOnly, timeout: m.busyMs, enableDoubleQuotedStringLiterals: false, enableForeignKeyConstraints: true });
    this.db = db;
    const read = (sql: string): string => { const st = db.prepare(sql); st.setReturnArrays(true); const row = st.get() as unknown[] | undefined; return row ? String(row[0] ?? '') : ''; };
    // A file that is not a database fails on its first read, not on open.
    const journal = read('PRAGMA journal_mode');
    read('SELECT count(*) FROM sqlite_schema');
    return { ok: true, inTx: false, version: read('SELECT sqlite_version()'), journal };
  }

  private prepare(sql: string): StatementSync {
    if (!this.db) throw new Error('not open');
    const st = this.db.prepare(sql);
    st.setReadBigInts(true);
    st.setReturnArrays(true);
    return st;
  }

  private columnsOf(st: StatementSync): SqliteColumnOut[] {
    return st.columns().map((c) => ({ name: c.name, type: c.type ?? null, table: c.table ?? null, column: c.column ?? null }));
  }

  private exec(sql: string, params: SqliteBind[]): SqliteWorkerReply {
    const st = this.prepare(sql);
    const columns = this.columnsOf(st);
    if (!columns.length) {
      const r = st.run(...(params as SQLInputValue[]));
      return { ok: true, inTx: this.inTx(), columns: null, changes: Number(r.changes), lastInsertRowid: String(r.lastInsertRowid) };
    }
    const rows: SqliteCell[][] = [];
    for (const row of st.iterate(...(params as SQLInputValue[])) as Iterable<unknown[]>) {
      this.checkInterrupt();
      rows.push(row.map((v) => cell(v, 0)));
    }
    return { ok: true, inTx: this.inTx(), columns, rows, more: false };
  }

  private start(m: Extract<SqliteWorkerRequest, { t: 'start' }>): SqliteWorkerReply {
    this.closeCursor(m.cursor);
    const st = this.prepare(m.sql);
    const columns = this.columnsOf(st);
    if (!columns.length) {
      const r = st.run(...((m.params ?? []) as SQLInputValue[]));
      return { ok: true, inTx: this.inTx(), columns: null, changes: Number(r.changes), lastInsertRowid: String(r.lastInsertRowid) };
    }
    const iter = (st.iterate(...((m.params ?? []) as SQLInputValue[])) as unknown as Iterator<unknown[]>);
    this.cursors.set(m.cursor, { stmt: st, iter, columns, peek: null });
    const page = this.next(m.cursor, m.max, m.maxChars);
    return page.ok ? { ...page, columns } : page;
  }

  /** Up to `max` rows (fewer once about `maxChars` characters are read); `more` is exact: one row is read ahead. */
  private next(cursor: number, max: number, maxChars: number): SqliteWorkerReply {
    const c = this.cursors.get(cursor);
    if (!c) return { ok: true, inTx: this.inTx(), rows: [], more: false };
    const rows: SqliteCell[][] = [];
    let chars = 0;
    const read = (): unknown[] | null => {
      if (c.peek) { const p = c.peek; c.peek = null; return p; }
      this.checkInterrupt();
      const r = c.iter.next();
      return r.done ? null : r.value;
    };
    try {
      while (rows.length < Math.max(1, max) && chars < maxChars) {
        const row = read();
        if (!row) { this.closeCursor(cursor); return { ok: true, inTx: this.inTx(), rows, more: false }; }
        const values = row.map((v) => cell(v, this.cut));
        for (const v of values) chars += cellChars(v);
        rows.push(values);
      }
      const ahead = read();
      if (!ahead) { this.closeCursor(cursor); return { ok: true, inTx: this.inTx(), rows, more: false }; }
      c.peek = ahead;
    } catch (e) {
      this.closeCursor(cursor);
      throw e;
    }
    return { ok: true, inTx: this.inTx(), rows, more: true };
  }

  private closeCursor(cursor: number): void {
    const c = this.cursors.get(cursor);
    if (!c) return;
    this.cursors.delete(cursor);
    // Ends the statement (its read lock on the file goes with it).
    try { c.iter.return?.(); } catch { /* already done */ }
  }

  shutdown(): void {
    for (const id of [...this.cursors.keys()]) this.closeCursor(id);
    try { this.db?.close(); } catch { /* closed */ }
    this.db = null;
  }
}

// ── the worker ──────────────────────────────────────────────────────────────

interface WorkerInit { sqliteEngine: true; interrupt: SharedArrayBuffer }
const threads = process.getBuiltinModule('node:worker_threads') as typeof import('node:worker_threads');
const init = threads.workerData as WorkerInit | undefined;
if (!threads.isMainThread && init?.sqliteEngine) {
  const port = threads.parentPort as MessagePort;
  const engine = new SqliteEngine(new Int32Array(init.interrupt));
  port.on('message', (m: { id: number; req: SqliteWorkerRequest }) => {
    const reply = engine.handle(m.req);
    port.postMessage({ id: m.id, reply });
    if (m.req.t === 'shutdown') port.close();
  });
}
