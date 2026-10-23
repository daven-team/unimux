// SQLite connections and the MySQL extras in the shared code (1.0.6): the saved connection and its form, splitting SQLite
// scripts, affinities and bound values, what a read-only connection may run, error positions (SQLite and MySQL), the error
// underline, table pages, staged edits and their preview, and the tree of a SQLite file and of MySQL triggers and events.
import { describe, expect, it } from 'vitest';
import { dbConnectionToDraft, dbEndpoint, dbKindLabel, normalizeDbConnection, validDbFilePath, validateDbDraft, type DbConnection } from '../src/shared/db';
import { errorSpan, splitSql } from '../src/shared/dbSql';
import { mysqlErrorPosition } from '../src/shared/dbMysql';
import {
  sqliteAffinity, sqliteEditPreview, sqliteEditStatements, sqliteErrorPosition, sqliteIsReadStatement, sqlitePageSql, sqliteParam, sqliteReadOnlyAllows, sqliteValueKind,
} from '../src/shared/dbSqlite';
import { buildDbTree, loadKey, nodeKey, type DbLoad } from '../src/shared/dbTree';
import { validDbTabRef } from '../src/shared/dbTabs';

const ID = '00000000-0000-4000-8000-00000000000a';
const WIN = 'C:\\Users\\me\\data\\shop.sqlite';

describe('SQLite connections', () => {
  it('keeps the file path, name, folder and read-only mode only', () => {
    const c = normalizeDbConnection({ id: ID, kind: 'sqlite', name: '', path: WIN, host: 'ignored', port: 99, user: 'x', tls: 'require', readOnly: true, group: 'Local', createdAt: 1, updatedAt: 2 });
    expect(c).toEqual({ id: ID, kind: 'sqlite', name: 'shop.sqlite', host: '', port: 0, user: '', tls: 'disable', ssh: null, readOnly: true, path: WIN, group: 'Local', createdAt: 1, updatedAt: 2 });
    expect(normalizeDbConnection({ id: ID, kind: 'sqlite', path: 'relative/shop.db' })).toBeNull();
    expect(normalizeDbConnection({ id: ID, kind: 'sqlite' })).toBeNull();
    expect(dbEndpoint(c!)).toBe(WIN);
    expect(dbKindLabel(c!)).toBe('SQLite');
    // Port 0 stays SQLite's: any other kind with it falls back to its default.
    expect(normalizeDbConnection({ id: ID, kind: 'postgres', host: 'h', port: 0, user: 'u', tls: 'disable' })?.port).toBe(5432);
  });

  it('accepts absolute paths of Windows (drive, UNC) and POSIX only', () => {
    for (const p of [WIN, 'D:/x/y.db', '\\\\server\\share\\a.db', '/home/me/a.sqlite']) expect(validDbFilePath(p)).toBe(true);
    for (const p of ['a.db', 'C:', 'C:\\dir\\', ' /a.db', '/a\u0001.db', '']) expect(validDbFilePath(p)).toBe(false);
  });

  it('the form needs a full path; the name defaults to the file name', () => {
    const draft = dbConnectionToDraft(undefined, 'sqlite');
    expect(validateDbDraft(draft)).toEqual({ ok: false, errors: { path: 'Wybierz plik bazy SQLite' } });
    expect(validateDbDraft({ ...draft, path: 'shop.db' })).toEqual({ ok: false, errors: { path: 'Podaj pełną ścieżkę pliku bazy' } });
    expect(validateDbDraft({ ...draft, path: ` ${WIN} `, readOnly: true })).toEqual({ ok: true, value: { kind: 'sqlite', name: 'shop.sqlite', host: '', port: 0, user: '', tls: 'disable', ssh: null, readOnly: true, path: WIN } });
    const back = dbConnectionToDraft({ id: ID, kind: 'sqlite', name: 'Shop', host: '', port: 0, user: '', tls: 'disable', ssh: null, readOnly: false, path: WIN, createdAt: 0, updatedAt: 0 });
    expect(back.path).toBe(WIN);
  });
});

describe('SQLite scripts', () => {
  it('splits at semicolons outside quotes, comments and CREATE TRIGGER bodies', () => {
    const text = `SELECT 'a;b', "c;d", [e;f], \`g;h\`; -- x;y
/* p;q */ INSERT INTO t VALUES (1);
CREATE TRIGGER tr AFTER INSERT ON t BEGIN
  UPDATE u SET n = CASE WHEN NEW.x > 0 THEN 1 ELSE 0 END;
  DELETE FROM v;
END;
SELECT 2`;
    const spans = splitSql(text, 'sqlite');
    expect(spans.map((s) => s.text.split('\n')[0])).toEqual([`SELECT 'a;b', "c;d", [e;f], \`g;h\``, 'INSERT INTO t VALUES (1)', 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN', 'SELECT 2']);
    expect(spans[2].text.endsWith('END')).toBe(true);
    // A transaction's BEGIN is not a trigger body.
    expect(splitSql('BEGIN; SELECT 1; COMMIT', 'sqlite').map((s) => s.text)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });

  it('reads affinities and value kinds from declared types, and binds values in their column type', () => {
    expect(['INTEGER', 'BIGINT', 'varchar(20)', 'BLOB', '', 'REAL', 'DOUBLE', 'NUMERIC', 'DECIMAL(10,2)', 'DATETIME'].map(sqliteAffinity))
      .toEqual(['integer', 'integer', 'text', 'blob', 'blob', 'real', 'real', 'numeric', 'numeric', 'numeric']);
    expect(['INTEGER', 'TEXT', 'BLOB', 'REAL', 'DECIMAL(10,2)', 'JSON', 'BOOLEAN', null].map(sqliteValueKind)).toEqual(['bigint', 'text', 'bytea', 'float', 'numeric', 'json', 'int', 'other']);
    expect(sqliteParam('9007199254740993', 'integer')).toBe(9007199254740993n);
    expect(sqliteParam('99999999999999999999', 'integer')).toBe('99999999999999999999');
    expect(sqliteParam('1.5', 'real')).toBe(1.5);
    expect(sqliteParam('\\x00ff', 'blob')).toEqual(new Uint8Array([0, 255]));
    expect(sqliteParam('\\x00ff', 'text')).toBe('\\x00ff');
    expect(sqliteParam(null, 'integer')).toBeNull();
  });

  it('a read-only connection runs reads, read PRAGMAs and transaction control only', () => {
    for (const sql of ['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', 'EXPLAIN QUERY PLAN SELECT 1', "PRAGMA table_info('t')", 'PRAGMA journal_mode', 'PRAGMA main.index_list(t)', 'BEGIN', 'ROLLBACK', 'VALUES (1)']) {
      expect(sqliteReadOnlyAllows(sql)).toBe(true);
    }
    for (const sql of ['INSERT INTO t VALUES (1)', 'WITH x AS (SELECT 1) DELETE FROM t', 'PRAGMA query_only = 0', 'PRAGMA journal_mode = WAL', 'PRAGMA journal_mode(WAL)', 'PRAGMA optimize', 'ATTACH DATABASE \'x\' AS y', 'VACUUM', 'CREATE TABLE t (a)', 'SELECT 1; DROP TABLE t'.split(';')[1]]) {
      expect(sqliteReadOnlyAllows(sql)).toBe(false);
    }
    expect(sqliteIsReadStatement('SELECT * FROM t')).toBe(true);
    expect(sqliteIsReadStatement('INSERT INTO t VALUES (1) RETURNING *')).toBe(false);
    expect(sqliteIsReadStatement("SELECT 'delete'")).toBe(true);
  });
});

describe('error positions', () => {
  it('SQLite names the token near the error; its first place in the code (not in a string) counts', () => {
    expect(sqliteErrorPosition('near "FRM": syntax error', "SELECT 'FRM' AS a\nFRM t")).toBe(19);
    expect(sqliteErrorPosition('incomplete input', 'SELECT (')).toBe(9);
    expect(sqliteErrorPosition('no such table: t', 'SELECT * FROM t')).toBeNull();
  });

  it('MySQL names the text from the error on and its line', () => {
    const msg = (near: string, line: number) => `ERROR 1064 (42000): You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '${near}' at line ${line}`;
    expect(mysqlErrorPosition(msg('FRM t', 2), 'SELECT *\nFRM t')).toBe(10);
    // The same text on an earlier line does not count.
    expect(mysqlErrorPosition(msg('x', 2), 'SELECT x\nFROM x')).toBe(15);
    expect(mysqlErrorPosition(msg('', 1), 'SELECT (')).toBe(9);
    expect(mysqlErrorPosition("ERROR 1146: Table 'a.b' doesn't exist", 'SELECT 1')).toBeNull();
    // Quotes inside the near text.
    expect(mysqlErrorPosition(msg("'abc' FRM t", 1), "SELECT 'abc' FRM t")).toBe(8);
  });

  it('underlines the word at the position, a quoted name whole, or the last character at the end', () => {
    expect(errorSpan('SELECT * FRM t', 9)).toEqual({ from: 9, to: 12 });
    expect(errorSpan('SELECT "my col" x', 7)).toEqual({ from: 7, to: 15 });
    expect(errorSpan('SELECT (', 8)).toEqual({ from: 7, to: 8 });
    expect(errorSpan('SELECT 1 +', 9)).toEqual({ from: 9, to: 10 });
  });
});

describe('SQLite pages and edits', () => {
  it('pages by offset with the key as a tiebreaker, the rowid read first when it is the key', () => {
    expect(sqlitePageSql({ schema: 'main', table: 'notes', limit: 100, offset: 200, sort: [{ column: 'body', desc: true }], filter: 'n > 1' }, ['rowid'], 'rowid'))
      .toBe('SELECT rowid, * FROM "main"."notes"\nWHERE (\nn > 1\n)\nORDER BY "body" DESC NULLS LAST, rowid DESC NULLS LAST\nLIMIT 101\nOFFSET 200');
    expect(sqlitePageSql({ schema: 'main', table: 't', limit: 10 }, ['a', 'b'], null)).toBe('SELECT * FROM "main"."t"\nORDER BY "a" ASC NULLS FIRST, "b" ASC NULLS FIRST\nLIMIT 11');
    expect(() => sqlitePageSql({ schema: 'other', table: 't', limit: 10 }, null, null)).toThrow();
    expect(() => sqlitePageSql({ schema: 'main', table: 't', limit: 10, after: ['1'] }, ['a'], null)).toThrow();
  });

  it('binds keys and values in their types and checks loaded values in every form an untyped column may hold', () => {
    const cols = [{ name: 'id', affinity: 'integer' as const, generated: false }, { name: 'name', affinity: 'text' as const, generated: false }, { name: 'n', affinity: 'blob' as const, generated: false }, { name: 'g', affinity: 'integer' as const, generated: true }];
    const built = sqliteEditStatements('main', 't', ['id'], [
      { op: 'update', key: { id: '7' }, set: { name: "O'Hara" }, original: { n: '42', name: null } },
      { op: 'insert', values: { name: 'x', n: '\\x0a' } },
      { op: 'delete', key: { id: '8' } },
    ], cols, null);
    expect(built[0].sql).toBe('UPDATE "main"."t" SET "name" = ? WHERE "id" = ? AND ("n" IS ? OR "n" IS ?) AND "name" IS NULL');
    expect(built[0].params).toEqual(["O'Hara", 7n, '42', 42n]);
    expect(built[1].params).toEqual(['x', new Uint8Array([10])]);
    expect(sqliteEditPreview(built)).toBe(`BEGIN;\nUPDATE "main"."t" SET "name" = 'O''Hara' WHERE "id" = 7 AND ("n" IS '42' OR "n" IS 42) AND "name" IS NULL;\nINSERT INTO "main"."t" ("name", "n") VALUES ('x', X'0a');\nDELETE FROM "main"."t" WHERE "id" = 8;\nCOMMIT;`);
    expect(() => sqliteEditStatements('main', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { g: '1' } }], cols, null)).toThrow();
    expect(() => sqliteEditStatements('main', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { nope: '1' } }], cols, null)).toThrow();
    expect(() => sqliteEditStatements('main', 't', null, [{ op: 'delete', key: { id: '1' } }], cols, null)).toThrow();
    // Keyed by the rowid: it is read-only, and named as rowid (never quoted, so a column cannot hide it).
    const byRowid = sqliteEditStatements('main', 't', ['rowid'], [{ op: 'delete', key: { rowid: '3' } }], cols, 'rowid');
    expect(byRowid[0]).toMatchObject({ sql: 'DELETE FROM "main"."t" WHERE rowid = ?', params: [3n] });
    expect(() => sqliteEditStatements('main', 't', ['rowid'], [{ op: 'update', key: { rowid: '3' }, set: { rowid: '4' } }], cols, 'rowid')).toThrow();
  });
});

describe('the tree of SQLite files and MySQL triggers and events', () => {
  const sqlite = { id: ID, kind: 'sqlite', name: 'shop', host: '', port: 0, user: '', tls: 'disable', ssh: null, readOnly: false, path: WIN, createdAt: 0, updatedAt: 0 } as DbConnection;
  it('a SQLite file shows its objects right under the connection, with folders for indexes and triggers', () => {
    const loads: Record<string, DbLoad> = { [loadKey.objects(ID, 'main', 'main')]: { status: 'ready', value: [
      { schema: 'main', name: 'orders', kind: 'table', oid: 0 }, { schema: 'main', name: 'big', kind: 'view', oid: 0 },
      { schema: 'main', name: 'orders_by_customer', kind: 'index', oid: 0, detail: 'ON orders' }, { schema: 'main', name: 'touch', kind: 'trigger', oid: 0 },
    ] } };
    const { rows, needed } = buildDbTree({ connections: [sqlite], open: new Set([nodeKey.connection(ID), nodeKey.folder(ID, 'main', 'main', 'indexes'), nodeKey.folder(ID, 'main', 'main', 'triggers')]), loads, filter: '', live: () => true });
    expect(needed).toEqual([]);
    expect(rows.map((r) => `${r.depth}:${r.type}:${r.type === 'folder' ? r.folder : r.type === 'object' ? r.object.name : ''}`)).toEqual([
      '0:connection:', '1:folder:tables', '2:object:orders', '1:folder:views', '1:folder:indexes', '2:object:orders_by_customer', '1:folder:triggers', '2:object:touch',
    ]);
    const first = buildDbTree({ connections: [sqlite], open: new Set([nodeKey.connection(ID)]), loads: {}, filter: '', live: () => true });
    expect(first.needed).toEqual([{ kind: 'objects', key: loadKey.objects(ID, 'main', 'main'), connectionId: ID, database: 'main', schema: 'main' }]);
  });

  it('DDL tabs of triggers, events and indexes are valid; data tabs only for objects with rows', () => {
    expect(validDbTabRef({ kind: 'ddl', connectionId: ID, database: 'main', schema: 'main', name: 'touch', objectKind: 'trigger' })).toBe(true);
    expect(validDbTabRef({ kind: 'ddl', connectionId: ID, database: '', schema: 'shop', name: 'nightly', objectKind: 'event' })).toBe(true);
    expect(validDbTabRef({ kind: 'table', connectionId: ID, database: 'main', schema: 'main', table: 'touch', objectKind: 'trigger' })).toBe(false);
  });
});
