// Pure SQL helpers of MySQL / MariaDB connections (1.0.5): literals, value kinds of result fields and columns, what a read-only
// connection may run, table pages, staged edits and whole cells. Shared by the DB Host and tests: no Node or DOM imports.
//
// Values never go through client-side escaping: a string is written as a hex literal with a character set introducer
// (_utf8mb4 X'...'), which reads the same under every sql_mode (NO_BACKSLASH_ESCAPES, ANSI_QUOTES) and cannot end early.
import { DB_LIMITS, type DbMysqlFlavor, type DbSort, type DbStagedEdit, type DbValueKind } from './db';
import { DbSqlError, firstKeyword, quoteIdent, qualifiedName, type PageSqlInput } from './dbSql';

const UTF8 = new TextEncoder();
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A value as the server reads it: NULL, a hex string literal in utf8mb4, or (binary columns) bytes; "\x0aff" means bytes 0a ff there. */
export function mysqlLiteral(value: string | null, binary = false): string {
  if (value === null) return 'NULL';
  if (binary) {
    const m = /^\\x((?:[0-9a-f]{2})*)$/i.exec(value);
    return `X'${m ? m[1].toLowerCase() : hex(UTF8.encode(value))}'`;
  }
  if (value === '') return "''";
  return `_utf8mb4 X'${hex(UTF8.encode(value))}'`;
}

/** A readable literal for previews only (never run): quotes doubled, backslashes doubled (the default sql_mode). */
export function mysqlDisplayLiteral(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replace(/\0/g, '').replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export const myIdent = (name: string): string => quoteIdent(name, 'mysql');
export const myQualified = (db: string, name: string): string => qualifiedName(db, name, 'mysql');

// ── statements ──────────────────────────────────────────────────────────────

/** Text outside quotes and comments, MySQL's way (backslash escapes, backticks, #). */
export function mysqlCodeOnly(sql: string): string {
  return sql.replace(/--\s[^\n]*|#[^\n]*|\/\*(?![!M])[\s\S]*?\*\/|'(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"\\]|\\[\s\S]|"")*"|`(?:[^`]|``)*`/g, ' ');
}

const MY_RO_ALLOWED = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'HELP', 'USE', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'SET']);
const MY_WRITE_WORDS = /\b(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|TRUNCATE|CALL|LOAD)\b/i;

/**
 * What a read-only MySQL connection may run without the explicit override: reads, USE and transaction control. Refused: anything
 * that changes data or the schema, SET (except SET TRANSACTION without READ WRITE), SELECT ... INTO (files and variables), CALL,
 * and anything naming the read-only settings. The session's READ ONLY transactions stay the second line of defense.
 */
export function mysqlReadOnlyAllows(sql: string): boolean {
  const kw = firstKeyword(sql);
  const code = mysqlCodeOnly(sql);
  if (!MY_RO_ALLOWED.has(kw)) return false;
  if (/\b(?:transaction_read_only|tx_read_only|read_only)\b/i.test(code)) return false;
  if (/\bREAD\s+WRITE\b/i.test(code)) return false;
  if (kw === 'SET') return /^[\s(]*SET\s+(?:SESSION\s+)?TRANSACTION\b/i.test(code);
  if (kw === 'SHOW' || kw === 'DESCRIBE' || kw === 'DESC' || kw === 'HELP' || kw === 'USE') return true;
  if (kw === 'SELECT' || kw === 'WITH' || kw === 'EXPLAIN' || kw === 'VALUES' || kw === 'TABLE') return !MY_WRITE_WORDS.test(code) && !/\bINTO\b/i.test(code);
  return true;
}

/** Whether a statement only reads, so its result may stay open for "load more" (and may be stopped with KILL QUERY). */
export function mysqlIsReadStatement(sql: string): boolean {
  const kw = firstKeyword(sql);
  const code = mysqlCodeOnly(sql);
  switch (kw) {
    case 'SELECT': case 'WITH': case 'VALUES': case 'TABLE': return !MY_WRITE_WORDS.test(code) && !/\bINTO\b/i.test(code) && !/\bFOR\s+UPDATE\b/i.test(code);
    case 'SHOW': case 'DESCRIBE': case 'DESC': case 'HELP': return true;
    case 'EXPLAIN': return !/\bANALYZE\b/i.test(code);
    default: return false;
  }
}

export const mysqlEndsTransaction = (sql: string): boolean => {
  const kw = firstKeyword(sql);
  return kw === 'COMMIT' || kw === 'ROLLBACK';
};

/** The session statement of a statement timeout: MySQL's max_execution_time (ms, SELECT only), MariaDB's max_statement_time (s). */
export function mysqlTimeoutSql(flavor: DbMysqlFlavor, ms: number | null): string {
  if (flavor === 'mariadb') return `SET SESSION max_statement_time = ${ms === null ? 'DEFAULT' : (Math.max(0, Math.floor(ms)) / 1000).toFixed(3)}`;
  return `SET SESSION max_execution_time = ${ms === null ? 'DEFAULT' : Math.max(0, Math.floor(ms))}`;
}

/** The first statement word that changes the default database. */
export const mysqlIsUse = (sql: string): boolean => firstKeyword(sql) === 'USE';

// ── value kinds ─────────────────────────────────────────────────────────────

/** Column type codes of the protocol (ColumnDefinition.columnType). */
export const MY_TYPE = {
  DECIMAL: 0x00, TINY: 0x01, SHORT: 0x02, LONG: 0x03, FLOAT: 0x04, DOUBLE: 0x05, NULL: 0x06, TIMESTAMP: 0x07, LONGLONG: 0x08, INT24: 0x09,
  DATE: 0x0a, TIME: 0x0b, DATETIME: 0x0c, YEAR: 0x0d, NEWDATE: 0x0e, VARCHAR: 0x0f, BIT: 0x10, VECTOR: 0xf2, JSON: 0xf5, NEWDECIMAL: 0xf6,
  ENUM: 0xf7, SET: 0xf8, TINY_BLOB: 0xf9, MEDIUM_BLOB: 0xfa, LONG_BLOB: 0xfb, BLOB: 0xfc, VAR_STRING: 0xfd, STRING: 0xfe, GEOMETRY: 0xff,
} as const;
export const MY_BINARY_CHARSET = 63;
const UNSIGNED_FLAG = 32;
const ENUM_FLAG = 256;
const SET_FLAG = 2048;
const STRINGISH = new Set<number>([MY_TYPE.VARCHAR, MY_TYPE.VAR_STRING, MY_TYPE.STRING, MY_TYPE.TINY_BLOB, MY_TYPE.MEDIUM_BLOB, MY_TYPE.LONG_BLOB, MY_TYPE.BLOB, MY_TYPE.ENUM, MY_TYPE.SET]);

export interface MysqlFieldLike { columnType: number; characterSet: number; flags: number; extendedTypeName?: string; extendedFormat?: string }

/** Whether a result field's values are bytes (shown as "\x..." hex): binary strings and blobs, BIT, GEOMETRY. */
export function mysqlFieldBinary(f: MysqlFieldLike): boolean {
  if (f.extendedFormat === 'json') return false;
  if (f.columnType === MY_TYPE.BIT || f.columnType === MY_TYPE.GEOMETRY || f.columnType === MY_TYPE.VECTOR) return true;
  return STRINGISH.has(f.columnType) && f.characterSet === MY_BINARY_CHARSET;
}

/** The kind and type name of a result field. */
export function mysqlFieldKind(f: MysqlFieldLike): { kind: DbValueKind; typeName: string } {
  const unsigned = (f.flags & UNSIGNED_FLAG) !== 0;
  const u = (name: string) => (unsigned ? `${name} unsigned` : name);
  const binary = mysqlFieldBinary(f);
  if (f.extendedFormat === 'json') return { kind: 'json', typeName: 'json' };
  if (f.extendedTypeName === 'uuid') return { kind: 'uuid', typeName: 'uuid' };
  if (f.extendedTypeName) return { kind: binary ? 'bytea' : 'text', typeName: f.extendedTypeName };
  switch (f.columnType) {
    case MY_TYPE.TINY: return { kind: 'int', typeName: u('tinyint') };
    case MY_TYPE.SHORT: return { kind: 'int', typeName: u('smallint') };
    case MY_TYPE.INT24: return { kind: 'int', typeName: u('mediumint') };
    case MY_TYPE.LONG: return { kind: unsigned ? 'bigint' : 'int', typeName: u('int') };
    case MY_TYPE.LONGLONG: return { kind: unsigned ? 'numeric' : 'bigint', typeName: u('bigint') };
    case MY_TYPE.YEAR: return { kind: 'int', typeName: 'year' };
    case MY_TYPE.FLOAT: return { kind: 'float', typeName: 'float' };
    case MY_TYPE.DOUBLE: return { kind: 'float', typeName: 'double' };
    case MY_TYPE.DECIMAL: case MY_TYPE.NEWDECIMAL: return { kind: 'numeric', typeName: 'decimal' };
    case MY_TYPE.DATE: case MY_TYPE.NEWDATE: return { kind: 'date', typeName: 'date' };
    case MY_TYPE.TIME: return { kind: 'time', typeName: 'time' };
    case MY_TYPE.DATETIME: return { kind: 'timestamp', typeName: 'datetime' };
    case MY_TYPE.TIMESTAMP: return { kind: 'timestamp', typeName: 'timestamp' };
    case MY_TYPE.JSON: return { kind: 'json', typeName: 'json' };
    case MY_TYPE.BIT: return { kind: 'bytea', typeName: 'bit' };
    case MY_TYPE.GEOMETRY: return { kind: 'other', typeName: 'geometry' };
    case MY_TYPE.VECTOR: return { kind: 'other', typeName: 'vector' };
    case MY_TYPE.NULL: return { kind: 'text', typeName: 'null' };
    case MY_TYPE.ENUM: return { kind: 'enum', typeName: 'enum' };
    case MY_TYPE.SET: return { kind: 'enum', typeName: 'set' };
    case MY_TYPE.TINY_BLOB: case MY_TYPE.MEDIUM_BLOB: case MY_TYPE.LONG_BLOB: case MY_TYPE.BLOB:
      return { kind: binary ? 'bytea' : 'text', typeName: binary ? 'blob' : 'text' };
    case MY_TYPE.VAR_STRING: case MY_TYPE.VARCHAR: case MY_TYPE.STRING:
      if (f.flags & ENUM_FLAG) return { kind: 'enum', typeName: 'enum' };
      if (f.flags & SET_FLAG) return { kind: 'enum', typeName: 'set' };
      if (binary) return { kind: 'bytea', typeName: f.columnType === MY_TYPE.STRING ? 'binary' : 'varbinary' };
      return { kind: 'text', typeName: f.columnType === MY_TYPE.STRING ? 'char' : 'varchar' };
    default: return { kind: 'other', typeName: String(f.columnType) };
  }
}

const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit']);
const STRING_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);
const GEOMETRY_TYPES = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection', 'vector']);

/** Whether a table column (information_schema DATA_TYPE) holds bytes. */
export const mysqlBinaryType = (dataType: string): boolean => BINARY_TYPES.has(dataType.toLowerCase()) || GEOMETRY_TYPES.has(dataType.toLowerCase());

/** The kind of a table column from information_schema (DATA_TYPE, COLUMN_TYPE). */
export function mysqlColumnKind(dataType: string, columnType: string): DbValueKind {
  const t = dataType.toLowerCase();
  const unsigned = /\bunsigned\b/i.test(columnType);
  switch (t) {
    case 'tinyint': case 'smallint': case 'mediumint': case 'year': return 'int';
    case 'int': case 'integer': return unsigned ? 'bigint' : 'int';
    case 'bigint': return unsigned ? 'numeric' : 'bigint';
    case 'float': case 'double': case 'real': return 'float';
    case 'decimal': case 'numeric': return 'numeric';
    case 'date': return 'date';
    case 'time': return 'time';
    case 'datetime': case 'timestamp': return 'timestamp';
    case 'json': return 'json';
    case 'uuid': return 'uuid';
    case 'enum': case 'set': return 'enum';
    default:
      if (BINARY_TYPES.has(t)) return 'bytea';
      if (GEOMETRY_TYPES.has(t)) return 'other';
      return 'text';
  }
}

// ── table pages ─────────────────────────────────────────────────────────────

/**
 * The SELECT of one table page (limit + 1 rows: the extra one tells whether more follow), ordered like Postgres pages (the
 * user's sort with the key as a tiebreaker, MySQL's NULL order: first ascending, last descending). Keyset paging when the
 * order is the key alone. `binary`: the key columns that hold bytes (their values are hex).
 */
export function mysqlPageSql(input: PageSqlInput, keyColumns: readonly string[] | null, binary: ReadonlySet<string> = new Set()): { sql: string; keyset: boolean } {
  const limit = Math.floor(input.limit);
  if (!Number.isFinite(limit) || limit < 1 || limit > DB_LIMITS.rowCapMax) throw new DbSqlError('invalid');
  const sort: DbSort[] = [...(input.sort ?? [])];
  if (sort.length > DB_LIMITS.sortColumns) throw new DbSqlError('invalid');
  const key = keyColumns?.length ? [...keyColumns] : null;
  const orderCols: DbSort[] = [...sort];
  if (key) {
    const dir = sort.length ? sort[sort.length - 1].desc : false;
    for (const k of key) if (!orderCols.some((s) => s.column === k)) orderCols.push({ column: k, desc: dir });
  }
  const byKeyOnly = !!key && orderCols.length === key.length && orderCols.every((s, i) => s.column === key[i] && s.desc === orderCols[0].desc);
  const conditions: string[] = [];
  const filter = input.filter?.trim();
  if (filter) {
    if (filter.length > DB_LIMITS.filter || filter.includes('\0')) throw new DbSqlError('invalid');
    conditions.push(`(\n${filter}\n)`);
  }
  let keyset = false;
  if (input.after && input.after.length) {
    if (!key || !byKeyOnly || input.after.length !== key.length || input.after.some((v) => typeof v !== 'string')) throw new DbSqlError('invalid');
    const op = orderCols[0].desc ? '<' : '>';
    conditions.push(`(${key.map(myIdent).join(', ')}) ${op} (${key.map((k, i) => mysqlLiteral(input.after![i], binary.has(k))).join(', ')})`);
    keyset = true;
  }
  const parts = [`SELECT * FROM ${myQualified(input.schema, input.table)}`];
  if (conditions.length) parts.push(`WHERE ${conditions.join('\nAND ')}`);
  if (orderCols.length) parts.push(`ORDER BY ${orderCols.map((s) => `${myIdent(s.column)} ${s.desc ? 'DESC' : 'ASC'}`).join(', ')}`);
  parts.push(`LIMIT ${limit + 1}`);
  const offset = Math.floor(input.offset ?? 0);
  if (!keyset && offset > 0) parts.push(`OFFSET ${offset}`);
  return { sql: parts.join('\n'), keyset };
}

/** The SELECT of one whole cell by the row's key (cut on the server, never fetched whole). */
export function mysqlCellSql(db: string, table: string, column: string, key: Record<string, string>, keyColumns: readonly string[], binary: ReadonlySet<string> = new Set()): string {
  const names = Object.keys(key);
  if (!keyColumns.length || names.length !== keyColumns.length || !keyColumns.every((k) => typeof key[k] === 'string')) throw new DbSqlError('invalid');
  const where = keyColumns.map((k) => `${myIdent(k)} = ${mysqlLiteral(key[k], binary.has(k))}`).join(' AND ');
  return `SELECT SUBSTRING(${myIdent(column)}, 1, ${DB_LIMITS.fullValueChars + 1}) FROM ${myQualified(db, table)} WHERE ${where} LIMIT 2`;
}

// ── staged edits ────────────────────────────────────────────────────────────

export interface MysqlColumnMeta { name: string; dataType: string; generated: boolean }
/** One staged edit as it runs (`sql`, hex literals) and as the preview shows it (`preview`, readable literals). */
export interface MysqlBuiltStatement { op: DbStagedEdit['op']; index: number; sql: string; preview: string }

/** Whether an `original` value of a column type can be compared exactly with what was loaded (floats, JSON and bytes cannot). */
const comparable = (dataType: string): boolean => {
  const t = dataType.toLowerCase();
  return !['float', 'double', 'real', 'json'].includes(t) && !BINARY_TYPES.has(t) && !GEOMETRY_TYPES.has(t);
};

/**
 * The statements of staged edits on db.table, identified by `keyColumns`. An edit naming an unknown or a generated column is
 * refused. `original` values are checked where the comparison is exact: strings byte for byte (utf8mb4_bin, so a case-only
 * change by someone else is a conflict), numbers, dates and times by value; floats, JSON and bytes are left out.
 */
export function mysqlEditStatements(db: string, table: string, keyColumns: readonly string[] | null, edits: readonly DbStagedEdit[], columns: readonly MysqlColumnMeta[]): MysqlBuiltStatement[] {
  if (!edits.length || edits.length > DB_LIMITS.edits) throw new DbSqlError('invalid');
  const target = myQualified(db, table);
  const byName = new Map(columns.map((c) => [c.name, c]));
  const col = (c: string): MysqlColumnMeta => { const m = byName.get(c); if (!m || !c) throw new DbSqlError('invalid'); return m; };
  const writable = (c: string): MysqlColumnMeta => { const m = col(c); if (m.generated) throw new DbSqlError('invalid'); return m; };
  const value = (v: unknown): string | null => { if (v !== null && typeof v !== 'string') throw new DbSqlError('invalid'); return v as string | null; };
  // Both forms at once: [run, preview].
  const lit = (m: MysqlColumnMeta, v: string | null): [string, string] => [mysqlLiteral(v, mysqlBinaryType(m.dataType)), mysqlBinaryType(m.dataType) && v !== null && /^\\x(?:[0-9a-f]{2})*$/i.test(v) ? `X'${v.slice(2).toLowerCase()}'` : mysqlDisplayLiteral(v)];
  const join = (parts: Array<[string, string]>, sep: string): [string, string] => [parts.map((p) => p[0]).join(sep), parts.map((p) => p[1]).join(sep)];
  const where = (key: Record<string, string>): [string, string] => {
    if (!keyColumns || !keyColumns.length) throw new DbSqlError('noKey');
    const names = Object.keys(key);
    if (names.length !== keyColumns.length || !keyColumns.every((k) => Object.hasOwn(key, k))) throw new DbSqlError('invalid');
    return join(keyColumns.map((k) => {
      const v = key[k];
      if (typeof v !== 'string') throw new DbSqlError('invalid');
      const [run, shown] = lit(col(k), v);
      return [`${myIdent(k)} = ${run}`, `${myIdent(k)} = ${shown}`];
    }), ' AND ');
  };
  const unchanged = (original: Record<string, string | null> | undefined): [string, string] => {
    if (!original) return ['', ''];
    const parts: Array<[string, string]> = [];
    for (const c of Object.keys(original)) {
      const m = col(c);
      const v = original[c];
      if (v !== null && typeof v !== 'string') throw new DbSqlError('invalid');
      const id = myIdent(c);
      if (v === null) { parts.push([` AND ${id} IS NULL`, ` AND ${id} IS NULL`]); continue; }
      if (!comparable(m.dataType)) continue;
      const [run, shown] = lit(m, v);
      if (STRING_TYPES.has(m.dataType.toLowerCase())) {
        const left = `CONVERT(${id} USING utf8mb4) COLLATE utf8mb4_bin`;
        parts.push([` AND ${left} = ${run}`, ` AND ${left} = ${shown}`]);
      } else parts.push([` AND ${id} = ${run}`, ` AND ${id} = ${shown}`]);
    }
    return join(parts, '');
  };
  return edits.map((e, index): MysqlBuiltStatement => {
    if (e.op === 'update') {
      const names = Object.keys(e.set);
      if (!names.length) throw new DbSqlError('invalid');
      const sets = join(names.map((c) => { const [run, shown] = lit(writable(c), value(e.set[c])); return [`${myIdent(c)} = ${run}`, `${myIdent(c)} = ${shown}`]; }), ', ');
      for (const k of Object.keys(e.key)) col(k);
      const w = where(e.key);
      const u = unchanged(e.original);
      return { op: e.op, index, sql: `UPDATE ${target} SET ${sets[0]} WHERE ${w[0]}${u[0]}`, preview: `UPDATE ${target} SET ${sets[1]} WHERE ${w[1]}${u[1]}` };
    }
    if (e.op === 'delete') {
      for (const k of Object.keys(e.key)) col(k);
      const w = where(e.key);
      const u = unchanged(e.original);
      return { op: e.op, index, sql: `DELETE FROM ${target} WHERE ${w[0]}${u[0]}`, preview: `DELETE FROM ${target} WHERE ${w[1]}${u[1]}` };
    }
    if (e.op === 'insert') {
      const names = Object.keys(e.values);
      if (!names.length) return { op: e.op, index, sql: `INSERT INTO ${target} () VALUES ()`, preview: `INSERT INTO ${target} () VALUES ()` };
      const cols = names.map((c) => { writable(c); return myIdent(c); }).join(', ');
      const vals = join(names.map((c) => lit(col(c), value(e.values[c]))), ', ');
      return { op: e.op, index, sql: `INSERT INTO ${target} (${cols}) VALUES (${vals[0]})`, preview: `INSERT INTO ${target} (${cols}) VALUES (${vals[1]})` };
    }
    throw new DbSqlError('invalid');
  });
}

/** "START TRANSACTION; ...; COMMIT;" as the save will run it (readable literals). */
export const mysqlEditPreview = (statements: readonly MysqlBuiltStatement[]): string =>
  ['START TRANSACTION;', ...statements.map((s) => `${s.preview};`), 'COMMIT;'].join('\n');

/** Splits the text of the server's error into what the UI shows: "ERROR 1146 (42S02): Table 'x.y' doesn't exist". */
export function mysqlErrorText(errno: number | undefined, sqlState: string | undefined, message: string): string {
  return errno ? `ERROR ${errno}${sqlState ? ` (${sqlState})` : ''}: ${message}` : message;
}


