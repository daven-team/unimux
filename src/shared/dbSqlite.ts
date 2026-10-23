// Pure SQL helpers of SQLite connections (1.0.6): type affinity and value kinds, what a read-only connection may run, table
// pages, staged edits, whole cells and error positions. Shared by the DB Host and tests: no Node or DOM imports.
//
// Values travel as bound parameters, never written into the text. A cell arrives as text (integers in full, reals in their
// shortest exact form, bytes as "\x..." hex); a parameter is bound in the type the column's affinity reads it as (an integer as
// a BigInt, a real as a number, "\x..." of a BLOB column as bytes), so a key or an unchanged-value check matches exactly.
import { DB_LIMITS, SQLITE_MAIN, type DbSort, type DbStagedEdit, type DbValueKind } from './db';
import { DbSqlError, firstKeyword, quoteIdent, quoteLiteral, type PageSqlInput } from './dbSql';

export type SqliteParam = string | number | bigint | Uint8Array | null;

/** The five column affinities of SQLite, from a declared type (https://sqlite.org/datatype3.html#determination_of_column_affinity). */
export type SqliteAffinity = 'integer' | 'text' | 'blob' | 'real' | 'numeric';
export function sqliteAffinity(declared: string | null | undefined): SqliteAffinity {
  const t = (declared ?? '').toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text';
  if (t.includes('BLOB') || !t.trim()) return 'blob';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real';
  return 'numeric';
}

/** How a column of a declared type is shown and edited (a value without a declared type: 'other'). */
export function sqliteValueKind(declared: string | null | undefined): DbValueKind {
  const t = (declared ?? '').toUpperCase().trim();
  if (!t) return 'other';
  if (/^BOOL/.test(t)) return 'int';
  if (/JSON/.test(t)) return 'json';
  if (/UUID|GUID/.test(t)) return 'text';
  switch (sqliteAffinity(t)) {
    case 'integer': return 'bigint';
    case 'real': return 'float';
    case 'blob': return 'bytea';
    case 'text': return 'text';
    default: return /DEC|NUM/.test(t) ? 'numeric' : 'text';
  }
}

const HEX = /^\\x((?:[0-9a-f]{2})*)$/i;
const INTEGER = /^[+-]?\d{1,19}$/;
const REAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?Infinity$/;

const bytesOf = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const inInt64 = (v: string): boolean => { try { const n = BigInt(v); return n >= -(2n ** 63n) && n < 2n ** 63n; } catch { return false; } };

/**
 * A value (text form) as the parameter its column reads it as: integers of an INTEGER column as BigInt, numbers of a REAL
 * column as a number, "\x..." of a BLOB (or untyped) column as bytes, everything else as text (SQLite's affinity converts it).
 */
export function sqliteParam(value: string | null, affinity: SqliteAffinity): SqliteParam {
  if (value === null) return null;
  if (affinity === 'integer' && INTEGER.test(value) && inInt64(value)) return BigInt(value);
  if (affinity === 'real' && REAL.test(value.trim())) return Number(value);
  if (affinity === 'blob') { const m = HEX.exec(value); if (m) return bytesOf(m[1]); }
  return value;
}

/**
 * The ways a loaded text form may have been stored in a column of this affinity: an untyped (or BLOB) column keeps what it was
 * given, so "42" may be the integer 42, the real 42.0 or the text "42"; "\x00ff" the bytes 00 ff or that text.
 */
function storedForms(value: string, affinity: SqliteAffinity): SqliteParam[] {
  if (affinity !== 'blob') return [sqliteParam(value, affinity)];
  const forms: SqliteParam[] = [value];
  const m = HEX.exec(value);
  if (m) forms.push(bytesOf(m[1]));
  if (INTEGER.test(value) && inInt64(value)) forms.push(BigInt(value));
  else if (REAL.test(value)) forms.push(Number(value));
  return forms;
}

export const sqIdent = (name: string): string => quoteIdent(name, 'sqlite');
/** "main"."orders": SQLite connections show the main database only. */
export const sqQualified = (schema: string, name: string): string => {
  if (schema !== SQLITE_MAIN) throw new DbSqlError('invalid');
  return `${sqIdent(schema)}.${sqIdent(name)}`;
};

// ── statements ──────────────────────────────────────────────────────────────

/** Text outside quotes and comments, SQLite's way ('...', "...", `...`, [...]): those are blanked, every offset stays. */
export function sqliteCodeOnly(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g, (m) => m.replace(/[^\n]/g, ' '));
}

const WRITE_WORDS = /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE)\b/i;
/** PRAGMAs that only read (with or without an argument); every other one may change the file or the connection. */
const READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check', 'integrity_check',
  'quick_check', 'database_list', 'collation_list', 'function_list', 'module_list', 'pragma_list', 'compile_options', 'page_count', 'page_size',
  'freelist_count', 'encoding', 'user_version', 'application_id', 'schema_version', 'data_version', 'journal_mode', 'foreign_keys', 'auto_vacuum',
  'cache_size', 'busy_timeout', 'synchronous', 'temp_store', 'max_page_count', 'recursive_triggers', 'case_sensitive_like', 'stats',
]);
const ARG_READ_PRAGMAS = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check', 'integrity_check', 'quick_check']);
const RO_ALLOWED = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN', 'PRAGMA', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);

/**
 * What a read-only SQLite connection may run without the explicit override: reads, the PRAGMAs that only read (queried, never
 * set) and transaction control. The connection's PRAGMA query_only stays the second line of defense.
 */
export function sqliteReadOnlyAllows(sql: string): boolean {
  const kw = firstKeyword(sql);
  const code = sqliteCodeOnly(sql);
  if (!RO_ALLOWED.has(kw)) return false;
  if (kw === 'PRAGMA') {
    // The code form blanks quoted names: PRAGMA table_info('t') reads "PRAGMA table_info( )".
    const m = /^\s*PRAGMA\s+(?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*)\s*(=|\()?/i.exec(code);
    if (!m || m[2] === '=') return false;
    const name = m[1].toLowerCase();
    // With an argument in parentheses most PRAGMAs set something (journal_mode(WAL)); these read about the argument.
    return m[2] === '(' ? ARG_READ_PRAGMAS.has(name) : READ_PRAGMAS.has(name);
  }
  if (kw === 'SELECT' || kw === 'WITH' || kw === 'VALUES' || kw === 'EXPLAIN') return !WRITE_WORDS.test(code);
  return true;
}

/** Whether a statement only reads, so its cursor may stay open for "load more". */
export function sqliteIsReadStatement(sql: string): boolean {
  const kw = firstKeyword(sql);
  if (kw !== 'SELECT' && kw !== 'WITH' && kw !== 'VALUES' && kw !== 'EXPLAIN') return false;
  return !WRITE_WORDS.test(sqliteCodeOnly(sql)) && !/\bRETURNING\b/i.test(sqliteCodeOnly(sql));
}

export const sqliteEndsTransaction = (sql: string): boolean => { const kw = firstKeyword(sql); return kw === 'COMMIT' || kw === 'END' || kw === 'ROLLBACK'; };

/**
 * The 1-based position an error message names in a statement: SQLite's 'near "FRM": syntax error' points at that token (its
 * first place in the code); null when the message names none.
 */
export function sqliteErrorPosition(message: string, sql: string): number | null {
  const m = /near "((?:[^"]|"")*)": syntax error/.exec(message);
  if (!m) return /incomplete input/.test(message) ? sql.length + 1 : null;
  const token = m[1].replace(/""/g, '"');
  if (!token) return null;
  const code = sqliteCodeOnly(sql);
  const quoted = /^['"`[]/.test(token);
  const re = new RegExp(`(^|[^A-Za-z0-9_$])(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'g');
  for (let mm = re.exec(sql); mm; mm = re.exec(sql)) {
    const pos = mm.index + mm[1].length;
    // A word of the code, not one inside a string or a comment (a quoted token: its first place).
    if (quoted || code.slice(pos, pos + token.length) === token) return pos + 1;
  }
  return null;
}

// ── table pages ─────────────────────────────────────────────────────────────

/**
 * The SELECT of one table page (limit + 1 rows: the extra one tells whether more follow). `rowid`: the name the rowid is read as
 * (a table without a primary key is keyed by it), first in the row. Ordered by the user's sort with the key as a tiebreaker
 * (NULLs first ascending, last descending, as Postgres pages are), offset paging.
 */
export function sqlitePageSql(input: PageSqlInput, keyColumns: readonly string[] | null, rowid: string | null): string {
  const limit = Math.floor(input.limit);
  if (!Number.isFinite(limit) || limit < 1 || limit > DB_LIMITS.rowCapMax) throw new DbSqlError('invalid');
  const sort: DbSort[] = [...(input.sort ?? [])];
  if (sort.length > DB_LIMITS.sortColumns) throw new DbSqlError('invalid');
  if (input.after?.length) throw new DbSqlError('invalid');
  const orderCols: DbSort[] = [...sort];
  if (keyColumns?.length) {
    const dir = sort.length ? sort[sort.length - 1].desc : false;
    for (const k of keyColumns) if (!orderCols.some((s) => s.column === k)) orderCols.push({ column: k, desc: dir });
  }
  const parts = [`SELECT ${rowid ? `${rowid}, ` : ''}* FROM ${sqQualified(input.schema, input.table)}`];
  const filter = input.filter?.trim();
  if (filter) {
    if (filter.length > DB_LIMITS.filter || filter.includes('\0')) throw new DbSqlError('invalid');
    parts.push(`WHERE (\n${filter}\n)`);
  }
  const col = (c: string) => (rowid && c === rowid ? rowid : sqIdent(c));
  if (orderCols.length) parts.push(`ORDER BY ${orderCols.map((s) => `${col(s.column)} ${s.desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`).join(', ')}`);
  parts.push(`LIMIT ${limit + 1}`);
  const offset = Math.floor(input.offset ?? 0);
  if (offset > 0) parts.push(`OFFSET ${offset}`);
  return parts.join('\n');
}

export interface SqliteColumnMeta { name: string; affinity: SqliteAffinity; generated: boolean }
export interface SqliteBuilt { sql: string; params: SqliteParam[] }

/** The SELECT of one whole cell by the row's key (cut by SQLite, never read whole). */
export function sqliteCellSql(schema: string, table: string, column: string, key: Record<string, string>, keyColumns: readonly string[], columns: readonly SqliteColumnMeta[], rowid: string | null): SqliteBuilt {
  const names = Object.keys(key);
  if (!keyColumns.length || names.length !== keyColumns.length || !keyColumns.every((k) => typeof key[k] === 'string')) throw new DbSqlError('invalid');
  const aff = (c: string): SqliteAffinity => (rowid && c === rowid ? 'integer' : columns.find((x) => x.name === c)?.affinity ?? 'text');
  return {
    sql: `SELECT substr(${sqIdent(column)}, 1, ${DB_LIMITS.fullValueChars + 1}) FROM ${sqQualified(schema, table)} WHERE ${keyColumns.map((k) => `${rowid && k === rowid ? rowid : sqIdent(k)} = ?`).join(' AND ')} LIMIT 2`,
    params: keyColumns.map((k) => sqliteParam(key[k], aff(k))),
  };
}

// ── staged edits ────────────────────────────────────────────────────────────

export interface SqliteBuiltStatement extends SqliteBuilt { op: DbStagedEdit['op']; index: number; preview: string }

const previewLiteral = (p: SqliteParam): string => {
  if (p === null) return 'NULL';
  if (typeof p === 'bigint' || typeof p === 'number') return String(p);
  if (p instanceof Uint8Array) return `X'${Array.from(p, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
  return quoteLiteral(p);
};
/** One statement with its parameters written in (display only: the save binds them). */
export const sqliteInline = (sql: string, params: readonly SqliteParam[]): string => {
  let i = 0;
  return sql.replace(/\?/g, () => (i < params.length ? previewLiteral(params[i++]) : '?'));
};

/**
 * The statements of staged edits on a table, identified by `keyColumns` (its primary key, or `rowid` for a table without one).
 * An edit naming an unknown or a generated column (or the rowid) is refused. `original` values are checked exactly: the row
 * must still hold each value as it was loaded (in any of the forms an untyped column may have stored it).
 */
export function sqliteEditStatements(schema: string, table: string, keyColumns: readonly string[] | null, edits: readonly DbStagedEdit[], columns: readonly SqliteColumnMeta[], rowid: string | null): SqliteBuiltStatement[] {
  if (!edits.length || edits.length > DB_LIMITS.edits) throw new DbSqlError('invalid');
  const target = sqQualified(schema, table);
  const byName = new Map(columns.map((c) => [c.name, c]));
  const rowidMeta: SqliteColumnMeta | null = rowid ? { name: rowid, affinity: 'integer', generated: true } : null;
  const col = (c: string): SqliteColumnMeta => { const m = rowid && c === rowid ? rowidMeta : byName.get(c); if (!m || !c) throw new DbSqlError('invalid'); return m; };
  const writable = (c: string): SqliteColumnMeta => { const m = col(c); if (m.generated) throw new DbSqlError('invalid'); return m; };
  const value = (v: unknown): string | null => { if (v !== null && typeof v !== 'string') throw new DbSqlError('invalid'); return v as string | null; };
  const ident = (c: string) => (rowid && c === rowid ? rowid : sqIdent(c));
  const where = (key: Record<string, string>, params: SqliteParam[]): string => {
    if (!keyColumns || !keyColumns.length) throw new DbSqlError('noKey');
    const names = Object.keys(key);
    if (names.length !== keyColumns.length || !keyColumns.every((k) => Object.hasOwn(key, k))) throw new DbSqlError('invalid');
    return keyColumns.map((k) => {
      const v = key[k];
      if (typeof v !== 'string') throw new DbSqlError('invalid');
      params.push(sqliteParam(v, col(k).affinity));
      return `${ident(k)} = ?`;
    }).join(' AND ');
  };
  const unchanged = (original: Record<string, string | null> | undefined, params: SqliteParam[]): string => {
    if (!original) return '';
    return Object.keys(original).map((c) => {
      const m = col(c);
      const v = original[c];
      if (v !== null && typeof v !== 'string') throw new DbSqlError('invalid');
      if (v === null) return ` AND ${ident(c)} IS NULL`;
      const forms = storedForms(v, m.affinity);
      params.push(...forms);
      return ` AND (${forms.map(() => `${ident(c)} IS ?`).join(' OR ')})`;
    }).join('');
  };
  const built = (op: DbStagedEdit['op'], index: number, sql: string, params: SqliteParam[]): SqliteBuiltStatement => ({ op, index, sql, params, preview: sqliteInline(sql, params) });
  return edits.map((e, index): SqliteBuiltStatement => {
    const params: SqliteParam[] = [];
    if (e.op === 'update') {
      const names = Object.keys(e.set);
      if (!names.length) throw new DbSqlError('invalid');
      const sets = names.map((c) => { const m = writable(c); params.push(sqliteParam(value(e.set[c]), m.affinity)); return `${sqIdent(c)} = ?`; });
      for (const k of Object.keys(e.key)) col(k);
      const w = where(e.key, params);
      return built(e.op, index, `UPDATE ${target} SET ${sets.join(', ')} WHERE ${w}${unchanged(e.original, params)}`, params);
    }
    if (e.op === 'delete') {
      for (const k of Object.keys(e.key)) col(k);
      const w = where(e.key, params);
      return built(e.op, index, `DELETE FROM ${target} WHERE ${w}${unchanged(e.original, params)}`, params);
    }
    if (e.op === 'insert') {
      const names = Object.keys(e.values);
      if (!names.length) return built(e.op, index, `INSERT INTO ${target} DEFAULT VALUES`, params);
      const cols = names.map((c) => { const m = writable(c); params.push(sqliteParam(value(e.values[c]), m.affinity)); return sqIdent(c); });
      return built(e.op, index, `INSERT INTO ${target} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params);
    }
    throw new DbSqlError('invalid');
  });
}

/** "BEGIN; ...; COMMIT;" as the save runs it (parameters written in). */
export const sqliteEditPreview = (statements: readonly SqliteBuiltStatement[]): string =>
  ['BEGIN;', ...statements.map((s) => `${s.preview};`), 'COMMIT;'].join('\n');
