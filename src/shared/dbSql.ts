// Pure SQL helpers of the database viewer (1.0.0): identifier quoting, splitting a script into statements, the statement under
// the cursor, building the parameterized statements of staged edits and their preview, table paging SQL, value kinds, and
// formatting / parsing values per type. Shared by the DB Host and the renderer: no Node or DOM imports.
import { DB_LIMITS, isTruncated, type DbColumn, type DbSort, type DbStagedEdit, type DbValue, type DbValueKind } from './db';
import type { MessageKey } from './i18n';

export class DbSqlError extends Error {
  constructor(readonly code: 'invalid' | 'noKey') { super(code); }
}

// ── quoting ─────────────────────────────────────────────────────────────────

/**
 * The SQL a connection speaks: Postgres, MySQL / MariaDB (backtick identifiers, backslash escapes, # comments, DELIMITER) or
 * SQLite (1.0.6: "..." identifiers, also `...` and [...], CREATE TRIGGER bodies).
 */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

/**
 * Any name as a quoted identifier: "My ""odd"" table" (Postgres) or `My ``odd`` table` (MySQL, whatever sql_mode says); a NUL
 * or an empty or overlong name is refused.
 */
export function quoteIdent(name: string, dialect: SqlDialect = 'postgres'): string {
  // SQLite quotes names like Postgres ("..." with "" inside).
  if (typeof name !== 'string' || !name || name.length > DB_LIMITS.identifier || name.includes('\0')) throw new DbSqlError('invalid');
  return dialect === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
}

export const qualifiedName = (schema: string, name: string, dialect: SqlDialect = 'postgres'): string => `${quoteIdent(schema, dialect)}.${quoteIdent(name, dialect)}`;

/** A string literal for display (standard_conforming_strings on): quotes doubled; a NUL cannot be shown. */
export function quoteLiteral(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`;
}

// ── statements ──────────────────────────────────────────────────────────────

/** A statement of a script: [start, end) in the text, without the semicolon and surrounding blanks or leading comments. */
export interface SqlSpan { start: number; end: number; text: string }

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Splits a script at semicolons outside of quotes ('...', E'...', "..."), dollar quoting ($$...$$, $tag$...$tag$), comments
 * (--, nested slash-star) and BEGIN ATOMIC ... END bodies. Statements that hold only comments are left out.
 */
export function splitSql(text: string, dialect: SqlDialect = 'postgres'): SqlSpan[] {
  if (dialect === 'mysql') return splitMysql(text);
  if (dialect === 'sqlite') return splitSqlite(text);
  const spans: SqlSpan[] = [];
  const n = text.length;
  let i = 0;
  let contentStart = -1;
  let contentEnd = -1;
  let atomic = 0;
  let caseDepth = 0;
  let prevWord = '';
  const mark = (from: number, to: number) => { if (contentStart < 0) contentStart = from; contentEnd = to; };
  const flush = () => {
    if (contentStart >= 0) spans.push({ start: contentStart, end: contentEnd, text: text.slice(contentStart, contentEnd) });
    contentStart = contentEnd = -1;
    atomic = caseDepth = 0;
    prevWord = '';
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') { const nl = text.indexOf('\n', i); i = nl < 0 ? n : nl + 1; continue; }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; } else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      const start = i;
      // E'...' (or e'...'): backslash escapes; the E was read as a word just before.
      const escapes = i > 0 && (text[i - 1] === 'E' || text[i - 1] === 'e') && (i < 2 || !IDENT_CHAR.test(text[i - 2]));
      i++;
      while (i < n) {
        if (escapes && text[i] === '\\') { i += 2; continue; }
        if (text[i] === "'") { if (text[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      mark(start, Math.min(i, n));
      prevWord = '';
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) { if (text[i] === '"') { if (text[i + 1] === '"') { i += 2; continue; } i++; break; } i++; }
      mark(start, Math.min(i, n));
      prevWord = '';
      continue;
    }
    if (c === '$' && (i === 0 || !IDENT_CHAR.test(text[i - 1]))) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 200))?.[0];
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        const end = close < 0 ? n : close + tag.length;
        mark(i, end);
        i = end;
        prevWord = '';
        continue;
      }
    }
    if (c === ';' && atomic === 0) { flush(); i++; continue; }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_CHAR.test(text[i])) i++;
      const word = text.slice(start, i).toUpperCase();
      mark(start, i);
      if (word === 'ATOMIC' && prevWord === 'BEGIN') atomic++;
      else if (atomic > 0 && word === 'CASE') caseDepth++;
      else if (atomic > 0 && word === 'END') { if (caseDepth > 0) caseDepth--; else atomic--; }
      prevWord = word;
      continue;
    }
    mark(i, i + 1);
    prevWord = '';
    i++;
  }
  flush();
  return spans;
}

const MYSQL_WORD = /[A-Za-z0-9_$\u0080-￿]/;
const MYSQL_BLOCK_ENDS = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT']);

/**
 * The MySQL / MariaDB split: semicolons outside of quotes ('...' and "..." with backslash escapes, `...`), comments (-- with a
 * blank after it, #, slash-star; the executable /*! ... *\/ ones are code), the BEGIN ... END bodies of CREATE PROCEDURE /
 * FUNCTION / TRIGGER / EVENT and of MariaDB's BEGIN NOT ATOMIC, and the mysql client's DELIMITER lines (they change the
 * separator and are not statements themselves, so dumps run as they are).
 */
function splitMysql(text: string): SqlSpan[] {
  const spans: SqlSpan[] = [];
  const n = text.length;
  let i = 0;
  let delimiter = ';';
  let contentStart = -1;
  let contentEnd = -1;
  let first = '';
  let routine = false;
  let depth = 0;
  let caseDepth = 0;
  let prevWord = '';
  const mark = (from: number, to: number) => { if (contentStart < 0) contentStart = from; contentEnd = to; };
  const flush = () => {
    if (contentStart >= 0) spans.push({ start: contentStart, end: contentEnd, text: text.slice(contentStart, contentEnd) });
    contentStart = contentEnd = -1;
    first = prevWord = '';
    routine = false;
    depth = caseDepth = 0;
  };
  const nextWord = (from: number): string => /^\s*([A-Za-z_]+)/.exec(text.slice(from, from + 64))?.[1]?.toUpperCase() ?? '';
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-' && (i + 2 >= n || /\s/.test(text[i + 2]))) { const nl = text.indexOf('\n', i); i = nl < 0 ? n : nl + 1; continue; }
    if (c === '#') { const nl = text.indexOf('\n', i); i = nl < 0 ? n : nl + 1; continue; }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      // /*!40101 SET NAMES utf8 *\/ and /*M!100100 ... *\/ run on the server: they are part of the statement.
      if (text[i + 2] === '!' || (text[i + 2] === 'M' && text[i + 3] === '!')) mark(i, end);
      i = end;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (contentStart < 0 && /^delimiter\s/i.test(text.slice(i, i + 10))) {
      const nl = text.indexOf('\n', i);
      const line = text.slice(i + 9, nl < 0 ? n : nl).trim();
      const token = line.split(/\s+/)[0];
      if (token) delimiter = token;
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i++;
      while (i < n) {
        if (c !== '`' && text[i] === '\\') { i += 2; continue; }
        if (text[i] === c) { if (text[i + 1] === c) { i += 2; continue; } i++; break; }
        i++;
      }
      mark(start, Math.min(i, n));
      prevWord = '';
      continue;
    }
    if (depth === 0 && text.startsWith(delimiter, i)) { flush(); i += delimiter.length; continue; }
    if (IDENT_START.test(c)) {
      const start = i;
      // A word ends at the DELIMITER too ("END$$").
      while (i < n && MYSQL_WORD.test(text[i]) && !(delimiter !== ';' && text.startsWith(delimiter, i))) i++;
      const word = text.slice(start, i).toUpperCase();
      mark(start, i);
      if (!first) first = word;
      if (first === 'CREATE' && (word === 'PROCEDURE' || word === 'FUNCTION' || word === 'TRIGGER' || word === 'EVENT')) routine = true;
      // Bodies are only counted with the ; separator: under another DELIMITER the script says where statements end itself.
      if (delimiter === ';') {
        if (word === 'BEGIN' && (routine || depth > 0 || (first === 'BEGIN' && nextWord(i) === 'NOT'))) depth++;
        else if (depth > 0 && word === 'CASE' && prevWord !== 'END') caseDepth++;
        else if (depth > 0 && word === 'END') {
          const after = nextWord(i);
          if (MYSQL_BLOCK_ENDS.has(after)) { /* END IF / LOOP / WHILE / REPEAT: those blocks are not counted */ }
          else if (after === 'CASE' || caseDepth > 0) caseDepth = Math.max(0, caseDepth - 1);
          else depth--;
        }
      }
      prevWord = word;
      continue;
    }
    mark(i, i + 1);
    prevWord = '';
    i++;
  }
  flush();
  return spans;
}

/**
 * The SQLite split: semicolons outside of quotes ('...', "...", `...`, [...]; a quote is doubled to escape it), comments (--
 * and slash-star, not nested) and the BEGIN ... END body of CREATE TRIGGER (CASE ... END inside it included).
 */
function splitSqlite(text: string): SqlSpan[] {
  const spans: SqlSpan[] = [];
  const n = text.length;
  let i = 0;
  let contentStart = -1;
  let contentEnd = -1;
  let first = '';
  let trigger = false;
  let depth = 0;
  let caseDepth = 0;
  const mark = (from: number, to: number) => { if (contentStart < 0) contentStart = from; contentEnd = to; };
  const flush = () => {
    if (contentStart >= 0) spans.push({ start: contentStart, end: contentEnd, text: text.slice(contentStart, contentEnd) });
    contentStart = contentEnd = -1;
    first = '';
    trigger = false;
    depth = caseDepth = 0;
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') { const nl = text.indexOf('\n', i); i = nl < 0 ? n : nl + 1; continue; }
    if (c === '/' && next === '*') { const close = text.indexOf('*/', i + 2); i = close < 0 ? n : close + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const start = i;
      i++;
      while (i < n) {
        if (text[i] === close) { if (close !== ']' && text[i + 1] === close) { i += 2; continue; } i++; break; }
        i++;
      }
      mark(start, Math.min(i, n));
      continue;
    }
    if (c === ';' && depth === 0) { flush(); i++; continue; }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_CHAR.test(text[i])) i++;
      const word = text.slice(start, i).toUpperCase();
      mark(start, i);
      if (!first) first = word;
      if (first === 'CREATE' && word === 'TRIGGER') trigger = true;
      if (trigger && word === 'BEGIN') depth++;
      else if (depth > 0 && word === 'CASE') caseDepth++;
      else if (depth > 0 && word === 'END') { if (caseDepth > 0) caseDepth--; else depth--; }
      continue;
    }
    mark(i, i + 1);
    i++;
  }
  flush();
  return spans;
}

/**
 * The text an error position underlines: from the 0-based offset `at` to the end of the word (or quoted name) starting there,
 * at least one character; at the very end of the text (a statement that ended too early) its last character.
 */
export function errorSpan(text: string, at: number): { from: number; to: number } {
  let from = Math.max(0, Math.min(at, text.length));
  if (from >= text.length) {
    let end = text.length;
    while (end > 0 && /\s/.test(text[end - 1])) end--;
    return { from: Math.max(0, end - 1), to: Math.max(end, 1) };
  }
  const c = text[from];
  let to = from + 1;
  if (c === '"' || c === '`' || c === "'" || c === '[') {
    const close = text.indexOf(c === '[' ? ']' : c, from + 1);
    to = close < 0 || close - from > 200 ? from + 1 : close + 1;
  } else if (IDENT_CHAR.test(c)) {
    while (to < text.length && to - from < 200 && IDENT_CHAR.test(text[to])) to++;
  }
  if (/\s/.test(c)) { while (from > 0 && /\s/.test(text[from])) from--; to = from + 1; }
  return { from, to };
}

/**
 * The statement the cursor is in: the one whose text (or the semicolon right after it) contains `offset`; between
 * statements, the one before the cursor; before the first, the first. Null when the script has none.
 */
export function statementAt(text: string, offset: number, dialect: SqlDialect = 'postgres'): SqlSpan | null {
  const spans = splitSql(text, dialect);
  if (!spans.length) return null;
  let before: SqlSpan | null = null;
  for (const s of spans) {
    if (offset >= s.start && offset <= s.end + 1) return s;
    if (s.end <= offset) before = s;
  }
  return before ?? spans[0];
}

/** The first keyword of a statement (upper case), skipping comments and opening parentheses. */
export function firstKeyword(sql: string): string {
  const m = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()*([A-Za-z]+)/.exec(sql);
  return m ? m[1].toUpperCase() : '';
}

const ROW_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'FETCH', 'EXECUTE', 'CALL']);
const WRITE_WORDS = /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i;

/** Text outside quotes and comments (for keyword checks). */
export function codeOnly(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ');
}

/** Whether a statement returns rows (read through a cursor, page by page): SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, FETCH or ... RETURNING. */
export function returnsRows(sql: string): boolean {
  const kw = firstKeyword(sql);
  // A cursor also runs statements without rows (SELECT ... INTO), so a false "yes" costs nothing; EXECUTE and CALL may return
  // rows too, and through a cursor their result is read in bounded batches.
  if (ROW_KEYWORDS.has(kw)) return true;
  return /\bRETURNING\b/i.test(codeOnly(sql));
}

/**
 * Whether a statement only reads (its cursor may stay open for "load more"): SELECT (not INTO, not FOR UPDATE/SHARE), VALUES,
 * TABLE, SHOW, FETCH, EXPLAIN without ANALYZE and WITH without a data-changing part. Everything else that returns rows
 * (... RETURNING, CALL, EXECUTE) is read up to the cap and its cursor closed at once, so its changes commit right away.
 */
export function isReadStatement(sql: string): boolean {
  const kw = firstKeyword(sql);
  const code = codeOnly(sql);
  switch (kw) {
    case 'SELECT': return !/\bINTO\b/i.test(code) && !/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b/i.test(code);
    case 'VALUES': case 'TABLE': case 'SHOW': case 'FETCH': return true;
    case 'EXPLAIN': return !/\bANALY[SZ]E\b/i.test(code);
    case 'WITH': return !WRITE_WORDS.test(code) && !/\bINTO\b/i.test(code);
    default: return false;
  }
}

const RO_ALLOWED = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'FETCH', 'MOVE', 'CLOSE', 'DECLARE', 'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE', 'SET']);
const TX_END = new Set(['COMMIT', 'END', 'ROLLBACK', 'ABORT']);

/**
 * What a read-only connection may run without the explicit override (one statement of a split script): reads and transaction
 * control. Refused: anything that changes data or the schema, SET / RESET / DISCARD (they could switch read-only off) except
 * SET TRANSACTION, BEGIN / START / SET TRANSACTION ... READ WRITE, and calls of set_config, dblink or the read-only settings by
 * name. The server's read-only transaction stays the second line of defense (a function a SELECT calls is refused by it).
 */
export function readOnlyAllows(sql: string): boolean {
  const kw = firstKeyword(sql);
  const code = codeOnly(sql);
  if (!RO_ALLOWED.has(kw)) return false;
  if (kw === 'SHOW') return true;
  if (/\bset_config\b|\b(?:default_)?transaction_read_only\b|\bdblink\w*/i.test(code)) return false;
  if (/\bREAD\s+WRITE\b/i.test(code)) return false;
  if (kw === 'SET') return /^[\s(]*SET\s+TRANSACTION\b/i.test(code);
  if (kw === 'SELECT') return !/\bINTO\b/i.test(code);
  if (kw === 'WITH' || kw === 'EXPLAIN' || kw === 'DECLARE') return !WRITE_WORDS.test(code) && !/\bINTO\b/i.test(code);
  return true;
}

/** COMMIT, END, ROLLBACK or ABORT (ending the open transaction). */
export const endsTransaction = (sql: string): boolean => TX_END.has(firstKeyword(sql));

// ── staged edits ────────────────────────────────────────────────────────────

export interface DbBuiltStatement { op: DbStagedEdit['op']; index: number; sql: string; params: Array<string | null> }

/**
 * The parameterized statement of each staged edit, identified by `keyColumns` (the primary key or a unique not-null key).
 * `columns`: the table's columns (an edit naming another one, or a generated one in `readOnlyColumns`, is refused).
 * `columnTypes`: each column's type as the server's format_type names it (with its typmod), for the conflict check of
 * `original`; never from the renderer.
 */
export function buildEditStatements(schema: string, table: string, keyColumns: readonly string[] | null, edits: readonly DbStagedEdit[], columns?: readonly string[], readOnlyColumns: readonly string[] = [], columnTypes?: Readonly<Record<string, string>>): DbBuiltStatement[] {
  if (!edits.length || edits.length > DB_LIMITS.edits) throw new DbSqlError('invalid');
  const target = qualifiedName(schema, table);
  const known = columns ? new Set(columns) : null;
  const fixed = new Set(readOnlyColumns);
  const checkColumn = (c: string) => { if ((known && !known.has(c)) || !c) throw new DbSqlError('invalid'); };
  const writable = (c: string) => { checkColumn(c); if (fixed.has(c)) throw new DbSqlError('invalid'); };
  const where = (key: Record<string, string>, params: Array<string | null>): string => {
    if (!keyColumns || !keyColumns.length) throw new DbSqlError('noKey');
    const names = Object.keys(key);
    if (names.length !== keyColumns.length || !keyColumns.every((k) => Object.hasOwn(key, k))) throw new DbSqlError('invalid');
    return keyColumns.map((k) => {
      const v = key[k];
      if (typeof v !== 'string') throw new DbSqlError('invalid');
      params.push(v);
      return `${quoteIdent(k)} = $${params.length}`;
    }).join(' AND ');
  };
  // The row must still hold the values it was loaded with. The loaded value is Postgres's output form of the column: the
  // parameter is read in the column's own type (its input function, typmod included) and both sides are compared in the
  // output form again (format('%s', ...) prints through the output function, unlike ::text, which turns a boolean into
  // "true", strips char(n) padding and adds /32 to an inet). So the check is exact for every type, also those without an
  // equality operator, and does not depend on formatting settings (a timestamptz is compared in the current time zone on
  // both sides). json and jsonb compare as jsonb (spacing and key order do not count).
  const unchanged = (original: Record<string, string | null> | undefined, params: Array<string | null>): string => {
    if (!original) return '';
    return Object.keys(original).map((c) => {
      checkColumn(c);
      const v = original[c];
      if (v !== null && typeof v !== 'string') throw new DbSqlError('invalid');
      const col = quoteIdent(c);
      if (v === null) return ` AND ${col} IS NULL`;
      params.push(v);
      const p = `$${params.length}`;
      const type = columnTypes && Object.hasOwn(columnTypes, c) ? columnTypes[c] : null;
      if (type === 'json' || type === 'jsonb') return ` AND ${col}::jsonb = ${p}::jsonb`;
      return ` AND (${col} IS NOT NULL AND format('%s', ${col}) = ${type ? `format('%s', ${p}::${type})` : `${p}::text`})`;
    }).join('');
  };
  return edits.map((e, index) => {
    const params: Array<string | null> = [];
    const value = (v: unknown): string | null => { if (v !== null && typeof v !== 'string') throw new DbSqlError('invalid'); return v as string | null; };
    if (e.op === 'update') {
      const names = Object.keys(e.set);
      if (!names.length) throw new DbSqlError('invalid');
      const sets = names.map((c) => { writable(c); params.push(value(e.set[c])); return `${quoteIdent(c)} = $${params.length}`; });
      for (const k of Object.keys(e.key)) checkColumn(k);
      return { op: e.op, index, sql: `UPDATE ${target} SET ${sets.join(', ')} WHERE ${where(e.key, params)}${unchanged(e.original, params)}`, params };
    }
    if (e.op === 'delete') {
      for (const k of Object.keys(e.key)) checkColumn(k);
      return { op: e.op, index, sql: `DELETE FROM ${target} WHERE ${where(e.key, params)}${unchanged(e.original, params)}`, params };
    }
    if (e.op === 'insert') {
      const names = Object.keys(e.values);
      if (!names.length) return { op: e.op, index, sql: `INSERT INTO ${target} DEFAULT VALUES`, params };
      const cols = names.map((c) => { writable(c); params.push(value(e.values[c])); return quoteIdent(c); });
      return { op: e.op, index, sql: `INSERT INTO ${target} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, params };
    }
    throw new DbSqlError('invalid');
  });
}

/** One statement with its parameters written in as literals (display only: the app always runs the parameterized form). */
export function inlineParams(sql: string, params: ReadonlyArray<string | null>): string {
  return sql.replace(/\$(\d+)/g, (m, d: string) => { const i = Number(d) - 1; return i >= 0 && i < params.length ? quoteLiteral(params[i]) : m; });
}

/** "BEGIN; ...; COMMIT;" as the save will run it. */
export function editPreview(statements: readonly DbBuiltStatement[]): string {
  return ['BEGIN;', ...statements.map((s) => `${inlineParams(s.sql, s.params)};`), 'COMMIT;'].join('\n');
}

// ── table paging ────────────────────────────────────────────────────────────

export interface PageSqlInput {
  schema: string;
  table: string;
  limit: number;
  offset?: number;
  after?: readonly string[];
  sort?: readonly DbSort[];
  filter?: string;
}

/**
 * The SELECT of one table page. It asks for limit + 1 rows (the extra one only tells whether more follow). Ordered by the
 * user's sort with the key as a tiebreaker, else by the key. Keyset paging (`after`) is used when the order is the key alone.
 */
export function pageSql(input: PageSqlInput, keyColumns: readonly string[] | null): { sql: string; params: string[]; keyset: boolean } {
  const limit = Math.floor(input.limit);
  if (!Number.isFinite(limit) || limit < 1 || limit > DB_LIMITS.rowCapMax) throw new DbSqlError('invalid');
  const sort = [...(input.sort ?? [])];
  if (sort.length > DB_LIMITS.sortColumns) throw new DbSqlError('invalid');
  const key = keyColumns?.length ? [...keyColumns] : null;
  const orderCols: DbSort[] = [...sort];
  if (key) {
    const dir = sort.length ? sort[sort.length - 1].desc : false;
    for (const k of key) if (!orderCols.some((s) => s.column === k)) orderCols.push({ column: k, desc: dir });
  }
  const byKeyOnly = !!key && orderCols.length === key.length && orderCols.every((s, i) => s.column === key[i] && s.desc === orderCols[0].desc);
  const params: string[] = [];
  const conditions: string[] = [];
  const filter = input.filter?.trim();
  if (filter) {
    if (filter.length > DB_LIMITS.filter || filter.includes('\0')) throw new DbSqlError('invalid');
    // On lines of its own: a trailing "-- comment" in the filter cannot swallow the ORDER BY or the LIMIT.
    conditions.push(`(\n${filter}\n)`);
  }
  let keyset = false;
  if (input.after && input.after.length) {
    if (!key || !byKeyOnly || input.after.length !== key.length || input.after.some((v) => typeof v !== 'string')) throw new DbSqlError('invalid');
    params.push(...input.after);
    const op = orderCols[0].desc ? '<' : '>';
    conditions.push(`(${key.map((k) => quoteIdent(k)).join(', ')}) ${op} (${key.map((_, i) => `$${i + 1}`).join(', ')})`);
    keyset = true;
  }
  const parts = [`SELECT * FROM ${qualifiedName(input.schema, input.table)}`];
  if (conditions.length) parts.push(`WHERE ${conditions.join('\nAND ')}`);
  if (orderCols.length) parts.push(`ORDER BY ${orderCols.map((s) => `${quoteIdent(s.column)} ${s.desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`).join(', ')}`);
  parts.push(`LIMIT ${limit + 1}`);
  const offset = Math.floor(input.offset ?? 0);
  if (!keyset && offset > 0) parts.push(`OFFSET ${offset}`);
  return { sql: parts.join('\n'), params, keyset };
}

/** The SELECT of one whole cell by the row's key. */
export function cellSql(schema: string, table: string, column: string, key: Record<string, string>, keyColumns: readonly string[]): { sql: string; params: string[] } {
  const names = Object.keys(key);
  if (!keyColumns.length || names.length !== keyColumns.length || !keyColumns.every((k) => typeof key[k] === 'string')) throw new DbSqlError('invalid');
  const params = keyColumns.map((k) => key[k]);
  return {
    // left(): a huge value is cut on the server, never fetched whole.
    sql: `SELECT left(${quoteIdent(column)}::text, ${DB_LIMITS.fullValueChars + 1}) FROM ${qualifiedName(schema, table)} WHERE ${keyColumns.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(' AND ')} LIMIT 2`,
    params,
  };
}

// ── value kinds ─────────────────────────────────────────────────────────────

const KIND_BY_OID: Record<number, DbValueKind> = {
  16: 'bool', 17: 'bytea', 18: 'text', 19: 'text', 20: 'bigint', 21: 'int', 23: 'int', 25: 'text', 26: 'int', 114: 'json', 142: 'text',
  700: 'float', 701: 'float', 790: 'numeric', 1042: 'text', 1043: 'text', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz',
  1186: 'interval', 1266: 'time', 1700: 'numeric', 2950: 'uuid', 3802: 'json', 4072: 'text',
};

/** The kind of a type from its OID and, for others, pg_type.typcategory (A array, E enum, B bool, N numeric, D date/time, S string). */
export function valueKind(oid: number, category?: string): DbValueKind {
  const known = KIND_BY_OID[oid];
  if (known) return known;
  switch (category) {
    case 'A': return 'array';
    case 'E': return 'enum';
    case 'B': return 'bool';
    case 'S': return 'text';
    case 'N': return 'numeric';
    default: return 'other';
  }
}

const ALIGN_RIGHT: ReadonlySet<DbValueKind> = new Set(['int', 'bigint', 'float', 'numeric']);
export const isNumericKind = (kind: DbValueKind): boolean => ALIGN_RIGHT.has(kind);

// ── formatting and parsing ──────────────────────────────────────────────────

/** The full text of a value (a truncated one: its head), null for NULL. */
export const dbValueText = (v: DbValue): string | null => (v === null ? null : isTruncated(v) ? v.head : v);

/** How a cell reads in the grid: booleans as true/false, JSON compact or pretty, the rest as the server sent it. */
export function formatDbValue(v: DbValue, kind: DbValueKind, opts: { pretty?: boolean } = {}): string | null {
  const text = dbValueText(v);
  if (text === null) return null;
  if (kind === 'bool') return text === 't' ? 'true' : text === 'f' ? 'false' : text;
  if (kind === 'json' && opts.pretty && !isTruncated(v)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }
  return text;
}

const INT = /^[+-]?\d+$/;
const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const UUID_RE = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;
const INT_RANGE: Record<string, [bigint, bigint]> = { int: [-(2n ** 31n), 2n ** 31n - 1n], bigint: [-(2n ** 63n), 2n ** 63n - 1n] };

export type DbParsed = { ok: true; value: string | null } | { ok: false; error: MessageKey };

/**
 * What the user typed into a cell, checked for the column's kind and turned into the text the server reads. `asNull`: the
 * user chose NULL. Dates, times and intervals are left to the server (it knows the DateStyle); arrays must be "{...}".
 */
export function parseDbInput(kind: DbValueKind, text: string, opts: { asNull?: boolean; typeName?: string } = {}): DbParsed {
  if (opts.asNull) return { ok: true, value: null };
  if (text.includes('\0')) return { ok: false, error: 'Wartość nie może zawierać znaku NUL' };
  const t = text.trim();
  switch (kind) {
    case 'int': case 'bigint': {
      if (!INT.test(t)) return { ok: false, error: 'Wpisz liczbę całkowitą' };
      const range = INT_RANGE[kind];
      // smallint and oid differ from integer: the server checks those exactly.
      const n = BigInt(t);
      if (n < range[0] || n > range[1]) return { ok: false, error: 'Liczba jest poza zakresem tego typu' };
      return { ok: true, value: t.replace(/^\+/, '') };
    }
    case 'float':
      if (NUMERIC.test(t) || /^[+-]?(?:Infinity|inf)$/i.test(t) || /^NaN$/i.test(t)) return { ok: true, value: t };
      return { ok: false, error: 'Wpisz liczbę' };
    case 'numeric':
      if (NUMERIC.test(t) || /^NaN$/i.test(t) || (opts.typeName !== 'money' && /^[+-]?Infinity$/i.test(t))) return { ok: true, value: t };
      if (opts.typeName === 'money' && t) return { ok: true, value: t };
      return { ok: false, error: 'Wpisz liczbę' };
    case 'bool': {
      const b = t.toLowerCase();
      if (['t', 'true', 'y', 'yes', 'on', '1'].includes(b)) return { ok: true, value: 't' };
      if (['f', 'false', 'n', 'no', 'off', '0'].includes(b)) return { ok: true, value: 'f' };
      return { ok: false, error: 'Wpisz true albo false' };
    }
    case 'json':
      try { JSON.parse(text); return { ok: true, value: text }; } catch { return { ok: false, error: 'To nie jest poprawny JSON' }; }
    case 'uuid':
      return UUID_RE.test(t) ? { ok: true, value: t } : { ok: false, error: 'To nie jest poprawny UUID' };
    case 'bytea':
      if (/^\\x(?:[0-9a-f]{2})*$/i.test(t)) return { ok: true, value: t };
      return { ok: false, error: 'Wpisz bajty szesnastkowo, np. \\x0aff' };
    case 'array':
      return /^\{[\s\S]*\}$/.test(t) || /^\[[^\]]*\]=\{[\s\S]*\}$/.test(t) ? { ok: true, value: t } : { ok: false, error: 'Tablicę wpisz w nawiasach klamrowych, np. {1,2,3}' };
    case 'date': case 'time': case 'timestamp': case 'timestamptz': case 'interval':
      return t ? { ok: true, value: t } : { ok: false, error: 'Wpisz wartość albo wybierz NULL' };
    default:
      // Text keeps what was typed, spaces included.
      return { ok: true, value: text };
  }
}

// ── copy and export ─────────────────────────────────────────────────────────

const csvField = (s: string, sep: string) => (s.includes(sep) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** CSV with a header line (RFC 4180 quoting); NULL is an empty field. */
export function rowsToCsv(columns: readonly Pick<DbColumn, 'name'>[], rows: readonly DbValue[][], sep = ','): string {
  const lines = [columns.map((c) => csvField(c.name, sep)).join(sep)];
  for (const row of rows) lines.push(row.map((v) => { const t = dbValueText(v); return t === null ? '' : csvField(t, sep); }).join(sep));
  return `${lines.join('\r\n')}\r\n`;
}

/** Tab-separated text (copying cells into a spreadsheet); NULL is empty, tabs and newlines in values become spaces. */
export function rowsToTsv(rows: readonly DbValue[][]): string {
  return rows.map((row) => row.map((v) => (dbValueText(v) ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

/**
 * A JSON value of a cell: numbers that fit a double exactly, booleans and JSON documents as such; bigint, numeric and
 * everything else as strings (no digit is lost).
 */
export function jsonValue(v: DbValue, kind: DbValueKind): unknown {
  const text = dbValueText(v);
  if (text === null) return null;
  if (isTruncated(v)) return text;
  switch (kind) {
    case 'int': return Number(text);
    case 'float': { const n = Number(text); return Number.isFinite(n) ? n : text; }
    case 'bigint': { const n = Number(text); return Number.isSafeInteger(n) ? n : text; }
    case 'bool': return text === 't' ? true : text === 'f' ? false : text;
    case 'json': try { return JSON.parse(text); } catch { return text; }
    default: return text;
  }
}

export function rowsToJson(columns: readonly Pick<DbColumn, 'name' | 'kind'>[], rows: readonly DbValue[][]): string {
  return JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((c, i) => [c.name, jsonValue(row[i] ?? null, c.kind)]))), null, 2);
}
