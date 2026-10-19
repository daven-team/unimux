// Pure SQL helpers of the database viewer (1.0.0): quoting, splitting scripts, the statement under the cursor, staged edits and
// their preview, table paging, value kinds, input checks and copy/export formats.
import { describe, expect, it } from 'vitest';
import {
  DbSqlError, buildEditStatements, cellSql, editPreview, endsTransaction, firstKeyword, isReadStatement, readOnlyAllows, formatDbValue, inlineParams, jsonValue, pageSql, parseDbInput, quoteIdent, quoteLiteral,
  returnsRows, rowsToCsv, rowsToJson, rowsToTsv, splitSql, statementAt, valueKind,
} from '../src/shared/dbSql';

const texts = (sql: string) => splitSql(sql).map((s) => s.text);

describe('quoting', () => {
  it('quotes identifiers and literals, refusing names that cannot be identifiers', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('My "odd" Table')).toBe('"My ""odd"" Table"');
    expect(() => quoteIdent('')).toThrow(DbSqlError);
    expect(() => quoteIdent('a\0b')).toThrow(DbSqlError);
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral(null)).toBe('NULL');
    expect(quoteLiteral('back\\slash')).toBe("'back\\slash'");
  });
});

describe('splitSql', () => {
  it('splits at semicolons outside strings, identifiers, comments and dollar quoting', () => {
    expect(texts("SELECT 'a;b'; SELECT \"x;y\" FROM t;SELECT 3")).toEqual(["SELECT 'a;b'", 'SELECT "x;y" FROM t', 'SELECT 3']);
    expect(texts("SELECT 'it''s; fine'; SELECT E'a\\';b'; SELECT 2")).toEqual(["SELECT 'it''s; fine'", "SELECT E'a\\';b'", 'SELECT 2']);
    expect(texts('SELECT 1 -- no; split\n; SELECT /* a; /* nested; */ b; */ 2')).toEqual(['SELECT 1', 'SELECT /* a; /* nested; */ b; */ 2']);
    expect(texts('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f()')).toEqual(['CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql', 'SELECT f()']);
    expect(texts('DO $body$ BEGIN PERFORM 1; END $body$; SELECT $1, a$b FROM t')).toEqual(['DO $body$ BEGIN PERFORM 1; END $body$', 'SELECT $1, a$b FROM t']);
  });

  it('keeps BEGIN ATOMIC bodies (with CASE ... END inside) in one statement', () => {
    const sql = 'CREATE FUNCTION g(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END; SELECT 2; END; SELECT 3';
    expect(texts(sql)).toEqual(['CREATE FUNCTION g(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END; SELECT 2; END', 'SELECT 3']);
    expect(texts('BEGIN; SELECT 1; COMMIT;')).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });

  it('drops empty and comment-only statements, starts at the first token and copes with unterminated quotes', () => {
    expect(texts(';;  -- only a comment\n; /* x */ ;')).toEqual([]);
    const sql = '-- heading\n  SELECT 1;\n\n';
    const [s] = splitSql(sql);
    expect(s).toEqual({ start: 13, end: 21, text: 'SELECT 1' });
    expect(texts("SELECT 'open; SELECT 2")).toEqual(["SELECT 'open; SELECT 2"]);
    expect(texts('SELECT $$open; SELECT 2')).toEqual(['SELECT $$open; SELECT 2']);
  });
});

describe('statementAt', () => {
  const sql = 'SELECT 1;\nSELECT 2;\n\nSELECT 3';
  it('picks the statement under the cursor, the one before when between statements, and the first before all', () => {
    expect(statementAt(sql, 3)?.text).toBe('SELECT 1');
    expect(statementAt(sql, 9)?.text).toBe('SELECT 1'); // right after the semicolon
    expect(statementAt(sql, 12)?.text).toBe('SELECT 2');
    expect(statementAt(sql, 20)?.text).toBe('SELECT 2'); // on the empty line
    expect(statementAt(sql, sql.length)?.text).toBe('SELECT 3');
    expect(statementAt('  \n SELECT 9', 0)?.text).toBe('SELECT 9');
    expect(statementAt('-- nothing', 3)).toBeNull();
  });
});

describe('returnsRows', () => {
  it('reads row-returning statements through a cursor', () => {
    expect(firstKeyword('/* c */ -- d\n (SELECT 1)')).toBe('SELECT');
    for (const sql of ['SELECT 1', 'with x as (select 1) select * from x', 'VALUES (1)', 'TABLE t', 'SHOW search_path', 'EXPLAIN SELECT 1', 'INSERT INTO t VALUES (1) RETURNING id', 'update t set a = 1 returning *', 'CALL p()', 'EXECUTE stmt(1)']) expect(returnsRows(sql), sql).toBe(true);
    for (const sql of ['INSERT INTO t VALUES (1)', 'CREATE TABLE t (a int)', 'BEGIN', 'SET x = 1', "INSERT INTO t VALUES ('returning')", 'VACUUM']) expect(returnsRows(sql), sql).toBe(false);
  });

  it('keeps cursors open only for statements that cannot change data', () => {
    for (const sql of ['SELECT * FROM t', 'VALUES (1)', 'TABLE t', 'SHOW x', 'EXPLAIN SELECT 1', 'WITH a AS (SELECT 1) SELECT * FROM a', "SELECT 'insert into x'"]) expect(isReadStatement(sql), sql).toBe(true);
    for (const sql of ['INSERT INTO t VALUES (1) RETURNING *', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'SELECT * INTO t2 FROM t', 'SELECT * FROM t FOR UPDATE', 'EXPLAIN ANALYZE DELETE FROM t', 'CALL p()', 'EXECUTE s']) expect(isReadStatement(sql), sql).toBe(false);
  });
});

describe('read-only connections', () => {
  it('allows reads and transaction control and refuses writes and anything that could switch read-only off', () => {
    for (const sql of ['SELECT 1', 'with x as (select 1) select * from x', 'EXPLAIN SELECT 1', 'SHOW search_path', 'BEGIN', 'BEGIN READ ONLY', 'START TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a', 'DECLARE c CURSOR FOR SELECT 1', 'FETCH 10 FROM c', "SELECT 'set_config'"]) expect(readOnlyAllows(sql), sql).toBe(true);
    for (const sql of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'CREATE TABLE t (a int)', 'DROP TABLE t', 'TRUNCATE t', 'COPY t FROM STDIN', 'CALL p()', 'DO $$ BEGIN END $$',
      'SET default_transaction_read_only = off', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'RESET ALL', 'DISCARD ALL', 'BEGIN READ WRITE', 'START TRANSACTION READ WRITE',
      'SET TRANSACTION READ WRITE', "SELECT set_config('default_transaction_read_only', 'off', false)", 'SELECT * INTO t2 FROM t', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
      'EXPLAIN ANALYZE DELETE FROM t', 'SET statement_timeout = 0', 'PREPARE p AS DELETE FROM t', 'EXECUTE p', "SELECT dblink_exec('x', 'delete from t')"]) expect(readOnlyAllows(sql), sql).toBe(false);
    expect(endsTransaction('commit')).toBe(true);
    expect(endsTransaction('SELECT 1')).toBe(false);
  });
});

describe('staged edits', () => {
  it('builds parameterized UPDATE, INSERT and DELETE statements by the key and previews them with literals', () => {
    const built = buildEditStatements('public', 'users', ['id'], [
      { op: 'update', key: { id: '7' }, set: { name: "O'Brien", note: null } },
      { op: 'insert', values: { id: '8', name: 'new' } },
      { op: 'insert', values: {} },
      { op: 'delete', key: { id: '9' } },
    ], ['id', 'name', 'note']);
    expect(built).toEqual([
      { op: 'update', index: 0, sql: 'UPDATE "public"."users" SET "name" = $1, "note" = $2 WHERE "id" = $3', params: ["O'Brien", null, '7'] },
      { op: 'insert', index: 1, sql: 'INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2)', params: ['8', 'new'] },
      { op: 'insert', index: 2, sql: 'INSERT INTO "public"."users" DEFAULT VALUES', params: [] },
      { op: 'delete', index: 3, sql: 'DELETE FROM "public"."users" WHERE "id" = $1', params: ['9'] },
    ]);
    expect(inlineParams(built[0].sql, built[0].params)).toBe(`UPDATE "public"."users" SET "name" = 'O''Brien', "note" = NULL WHERE "id" = '7'`);
    expect(editPreview(built.slice(3))).toBe('BEGIN;\nDELETE FROM "public"."users" WHERE "id" = \'9\';\nCOMMIT;');
  });

  it('requires the loaded values of edited columns to be unchanged (conflict check)', () => {
    const [u, d] = buildEditStatements('s', 't', ['id'], [
      { op: 'update', key: { id: '1' }, set: { v: 'new' }, original: { v: 'old', n: null } },
      { op: 'delete', key: { id: '2' }, original: { v: 'x' } },
    ], ['id', 'v', 'n']);
    expect(u).toMatchObject({ sql: 'UPDATE "s"."t" SET "v" = $1 WHERE "id" = $2 AND "v"::text IS NOT DISTINCT FROM $3 AND "n"::text IS NOT DISTINCT FROM $4', params: ['new', '1', 'old', null] });
    expect(d).toMatchObject({ sql: 'DELETE FROM "s"."t" WHERE "id" = $1 AND "v"::text IS NOT DISTINCT FROM $2', params: ['2', 'x'] });
    expect(() => buildEditStatements('s', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { v: 'a' }, original: { zz: 'a' } }], ['id', 'v'])).toThrow(DbSqlError);
  });

  it('uses composite keys in order and refuses what would not identify one row', () => {
    const [u] = buildEditStatements('s', 't', ['a', 'b'], [{ op: 'update', key: { b: '2', a: '1' }, set: { v: 'x' } }]);
    expect(u).toMatchObject({ sql: 'UPDATE "s"."t" SET "v" = $1 WHERE "a" = $2 AND "b" = $3', params: ['x', '1', '2'] });
    const bad = (fn: () => unknown, code: 'invalid' | 'noKey') => { try { fn(); throw new Error('no throw'); } catch (e) { expect((e as DbSqlError).code).toBe(code); } };
    bad(() => buildEditStatements('s', 't', null, [{ op: 'delete', key: { a: '1' } }]), 'noKey');
    bad(() => buildEditStatements('s', 't', ['a', 'b'], [{ op: 'delete', key: { a: '1' } }]), 'invalid');
    bad(() => buildEditStatements('s', 't', ['a'], [{ op: 'delete', key: { a: null as unknown as string } }]), 'invalid');
    bad(() => buildEditStatements('s', 't', ['a'], [{ op: 'update', key: { a: '1' }, set: {} }]), 'invalid');
    bad(() => buildEditStatements('s', 't', ['a'], [{ op: 'update', key: { a: '1' }, set: { zz: '1' } }], ['a', 'v']), 'invalid');
    bad(() => buildEditStatements('s', 't', ['a'], [{ op: 'insert', values: { g: '1' } }], ['a', 'g'], ['g']), 'invalid');
    bad(() => buildEditStatements('s', 't', ['a'], []), 'invalid');
  });
});

describe('pageSql', () => {
  it('orders by the key, asks for one extra row and pages by offset', () => {
    expect(pageSql({ schema: 's', table: 't', limit: 100, offset: 200 }, ['id'])).toEqual({ sql: 'SELECT * FROM "s"."t"\nORDER BY "id" ASC NULLS FIRST\nLIMIT 101\nOFFSET 200', params: [], keyset: false });
    expect(pageSql({ schema: 's', table: 't', limit: 10 }, null).sql).toBe('SELECT * FROM "s"."t"\nLIMIT 11');
  });

  it('adds the key as a tiebreaker to a sort and pages by key when the order is the key alone', () => {
    expect(pageSql({ schema: 's', table: 't', limit: 5, sort: [{ column: 'name', desc: true }] }, ['id']).sql).toBe('SELECT * FROM "s"."t"\nORDER BY "name" DESC NULLS LAST, "id" DESC NULLS LAST\nLIMIT 6');
    expect(pageSql({ schema: 's', table: 't', limit: 5, after: ['1', 'x'], sort: [{ column: 'a', desc: true }, { column: 'b', desc: true }] }, ['a', 'b'])).toEqual({
      sql: 'SELECT * FROM "s"."t"\nWHERE ("a", "b") < ($1, $2)\nORDER BY "a" DESC NULLS LAST, "b" DESC NULLS LAST\nLIMIT 6', params: ['1', 'x'], keyset: true,
    });
    expect(() => pageSql({ schema: 's', table: 't', limit: 5, after: ['1'], sort: [{ column: 'name', desc: false }] }, ['id'])).toThrow(DbSqlError);
    expect(() => pageSql({ schema: 's', table: 't', limit: 5, after: ['1'] }, null)).toThrow(DbSqlError);
  });

  it('puts the filter on lines of its own and refuses bad limits', () => {
    expect(pageSql({ schema: 's', table: 't', limit: 5, filter: ' a > 1 -- comment ', after: ['3'] }, ['id']).sql).toBe('SELECT * FROM "s"."t"\nWHERE (\na > 1 -- comment\n)\nAND ("id") > ($1)\nORDER BY "id" ASC NULLS FIRST\nLIMIT 6');
    expect(() => pageSql({ schema: 's', table: 't', limit: 0 }, null)).toThrow(DbSqlError);
    expect(() => pageSql({ schema: 's', table: 't', limit: 5, filter: 'a\0' }, null)).toThrow(DbSqlError);
  });

  it('reads one cell by its key', () => {
    expect(cellSql('s', 't', 'body', { id: '4' }, ['id'])).toEqual({ sql: 'SELECT left("body"::text, 16777217) FROM "s"."t" WHERE "id" = $1 LIMIT 2', params: ['4'] });
    expect(() => cellSql('s', 't', 'body', { other: '4' }, ['id'])).toThrow(DbSqlError);
  });
});

describe('values', () => {
  it('knows the kinds of the common types, arrays, enums and domains by category', () => {
    expect([16, 17, 20, 23, 25, 114, 3802, 1700, 701, 1082, 1114, 1184, 2950].map((o) => valueKind(o))).toEqual(['bool', 'bytea', 'bigint', 'int', 'text', 'json', 'json', 'numeric', 'float', 'date', 'timestamp', 'timestamptz', 'uuid']);
    expect(valueKind(1007, 'A')).toBe('array');
    expect(valueKind(99999, 'E')).toBe('enum');
    expect(valueKind(99999, 'U')).toBe('other');
  });

  it('formats booleans and pretty JSON, keeps everything else as the server sent it', () => {
    expect(formatDbValue('t', 'bool')).toBe('true');
    expect(formatDbValue(null, 'text')).toBeNull();
    expect(formatDbValue('{"a":1}', 'json', { pretty: true })).toBe('{\n  "a": 1\n}');
    expect(formatDbValue({ t: 'trunc', head: 'abc', chars: 10 }, 'text')).toBe('abc');
    expect(formatDbValue('12345678901234567890', 'bigint')).toBe('12345678901234567890');
  });

  it('checks typed input per kind', () => {
    expect(parseDbInput('int', ' +42 ')).toEqual({ ok: true, value: '42' });
    expect(parseDbInput('int', '2147483648').ok).toBe(false);
    expect(parseDbInput('bigint', '9223372036854775807')).toEqual({ ok: true, value: '9223372036854775807' });
    expect(parseDbInput('bigint', '1.5').ok).toBe(false);
    expect(parseDbInput('numeric', '-1.5e3')).toEqual({ ok: true, value: '-1.5e3' });
    expect(parseDbInput('numeric', 'abc').ok).toBe(false);
    expect(parseDbInput('float', 'Infinity').ok).toBe(true);
    expect(parseDbInput('bool', 'Yes')).toEqual({ ok: true, value: 't' });
    expect(parseDbInput('bool', 'maybe').ok).toBe(false);
    expect(parseDbInput('json', '{"a": 1}')).toEqual({ ok: true, value: '{"a": 1}' });
    expect(parseDbInput('json', '{a: 1}').ok).toBe(false);
    expect(parseDbInput('uuid', '6f1d9a2e-4c1b-4c5e-9b7a-2a3b4c5d6e7f').ok).toBe(true);
    expect(parseDbInput('bytea', '\\x0aff')).toEqual({ ok: true, value: '\\x0aff' });
    expect(parseDbInput('bytea', '\\x0af').ok).toBe(false);
    expect(parseDbInput('array', '{1,2}').ok).toBe(true);
    expect(parseDbInput('array', '1,2').ok).toBe(false);
    expect(parseDbInput('timestamptz', '').ok).toBe(false);
    expect(parseDbInput('text', '')).toEqual({ ok: true, value: '' });
    expect(parseDbInput('text', '  spaced ')).toEqual({ ok: true, value: '  spaced ' });
    expect(parseDbInput('text', 'x', { asNull: true })).toEqual({ ok: true, value: null });
    expect(parseDbInput('text', 'a\0b').ok).toBe(false);
  });

  it('copies and exports as CSV, TSV and JSON without losing digits', () => {
    const cols = [{ name: 'id', kind: 'bigint' as const }, { name: 'note', kind: 'text' as const }, { name: 'ok', kind: 'bool' as const }, { name: 'doc', kind: 'json' as const }];
    const rows = [['9007199254740993', 'a,"b"', 't', '{"x":1}'], ['1', null, 'f', null]];
    expect(rowsToCsv(cols, rows)).toBe('id,note,ok,doc\r\n9007199254740993,"a,""b""",t,"{""x"":1}"\r\n1,,f,\r\n');
    expect(rowsToTsv([['a\tb', null, 'c\nd']])).toBe('a b\t\tc d');
    expect(JSON.parse(rowsToJson(cols, rows))).toEqual([
      { id: '9007199254740993', note: 'a,"b"', ok: true, doc: { x: 1 } },
      { id: 1, note: null, ok: false, doc: null },
    ]);
    expect(jsonValue({ t: 'trunc', head: '{"a"', chars: 9 }, 'json')).toBe('{"a"');
  });
});
