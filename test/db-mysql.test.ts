// MySQL / MariaDB (1.0.5): the pure parts. Connections of the new kind, the flavour from the server's version, identifier and
// value quoting, splitting scripts the MySQL way (backslash escapes, #, DELIMITER, routine bodies), what a read-only connection
// may run, table pages, staged edits and the kinds of result fields.
import { describe, expect, it } from 'vitest';
import {
  dbConnectionToDraft, dbDefaultDatabase, dbEndpoint, dbKindLabel, mysqlFlavorOf, mysqlServerLabel, normalizeDbConnection, validateDbDraft,
} from '../src/shared/db';
import { quoteIdent, qualifiedName, splitSql, statementAt } from '../src/shared/dbSql';
import {
  MY_BINARY_CHARSET, MY_TYPE, mysqlCellSql, mysqlColumnKind, mysqlDisplayLiteral, mysqlEditPreview, mysqlEditStatements, mysqlFieldKind, mysqlIsReadStatement,
  mysqlLiteral, mysqlPageSql, mysqlReadOnlyAllows, mysqlTimeoutSql,
} from '../src/shared/dbMysql';
import { validDbTabRef } from '../src/shared/dbTabs';

const ID = '11111111-2222-4333-8444-555555555555';
const texts = (sql: string) => splitSql(sql, 'mysql').map((s) => s.text);

describe('MySQL connections', () => {
  it('normalizes with port 3306, prefer TLS, an optional database and the remembered flavour', () => {
    const c = normalizeDbConnection({ id: ID, kind: 'mysql', host: 'db', user: 'app', createdAt: 1, updatedAt: 2, flavor: 'mariadb', statementTimeoutMs: 5000 });
    expect(c).toMatchObject({ kind: 'mysql', port: 3306, tls: 'prefer', flavor: 'mariadb', statementTimeoutMs: 5000 });
    expect(c?.database).toBeUndefined();
    expect(normalizeDbConnection({ id: ID, kind: 'mysql', host: 'db', user: 'app', database: 'shop', flavor: 'oracle' })).toMatchObject({ database: 'shop' });
    expect(normalizeDbConnection({ id: ID, kind: 'mysql', host: 'db', user: 'app', flavor: 'oracle' })?.flavor).toBeUndefined();
    // A user is required, like Postgres.
    expect(normalizeDbConnection({ id: ID, kind: 'mysql', host: 'db', user: '' })).toBeNull();
  });

  it('the form: root, no database by default; an empty database stays out, a timeout is allowed', () => {
    const d = dbConnectionToDraft(undefined, 'mysql');
    expect(d).toMatchObject({ user: 'root', database: '', port: '3306', tls: 'prefer' });
    const r = validateDbDraft({ ...d, statementTimeout: '2.5' });
    expect(r.ok && r.value).toMatchObject({ kind: 'mysql', user: 'root', statementTimeoutMs: 2500 });
    expect(r.ok && 'database' in r.value).toBe(false);
    const named = validateDbDraft({ ...d, database: 'shop' });
    expect(named.ok && named.value.database).toBe('shop');
    expect(validateDbDraft({ ...d, user: '' }).ok).toBe(false);
  });

  it('endpoint, default database and labels', () => {
    const c = { kind: 'mysql' as const, host: 'db', port: 3306, ssh: null, database: undefined as string | undefined };
    expect(dbEndpoint(c)).toBe('db:3306');
    expect(dbEndpoint({ ...c, database: 'shop' })).toBe('db:3306/shop');
    expect(dbDefaultDatabase(c)).toBe('');
    expect(dbDefaultDatabase({ kind: 'postgres' })).toBe('postgres');
    expect(dbKindLabel({ kind: 'mysql' })).toBe('MySQL / MariaDB');
    expect(dbKindLabel({ kind: 'mysql', flavor: 'mariadb' })).toBe('MariaDB');
    expect(dbKindLabel({ kind: 'mysql', flavor: 'mysql' })).toBe('MySQL');
  });

  it('tells MariaDB from MySQL by the version or its comment', () => {
    expect(mysqlFlavorOf('11.4.2-MariaDB-ubu2404')).toBe('mariadb');
    expect(mysqlFlavorOf('5.5.5-10.6.12-MariaDB')).toBe('mariadb');
    expect(mysqlFlavorOf('10.11.6', 'mariadb.org binary distribution')).toBe('mariadb');
    expect(mysqlFlavorOf('8.0.36', 'MySQL Community Server - GPL')).toBe('mysql');
    expect(mysqlFlavorOf('8.0.35-27', 'Percona Server (GPL)')).toBe('mysql');
    expect(mysqlServerLabel('11.4.2-MariaDB-ubu2404')).toBe('MariaDB 11.4.2');
    expect(mysqlServerLabel('5.5.5-10.6.12-MariaDB-1:10.6.12+maria~ubu2004')).toBe('MariaDB 10.6.12');
    expect(mysqlServerLabel('8.4.3', 'MySQL Community Server - GPL')).toBe('MySQL 8.4.3');
    expect(mysqlServerLabel('8.0.36-log')).toBe('MySQL 8.0.36');
  });

  it('a tab may name no database (MySQL without a default one)', () => {
    expect(validDbTabRef({ kind: 'sql', connectionId: ID, database: '', uid: ID })).toBe(true);
    expect(validDbTabRef({ kind: 'sql', connectionId: ID, database: 'a\0', uid: ID })).toBe(false);
  });
});

describe('MySQL quoting', () => {
  it('backticks identifiers, doubling backticks', () => {
    expect(quoteIdent('orders', 'mysql')).toBe('`orders`');
    expect(quoteIdent('we`ird"name', 'mysql')).toBe('`we``ird"name`');
    expect(qualifiedName('shop', 'order items', 'mysql')).toBe('`shop`.`order items`');
    expect(quoteIdent('x')).toBe('"x"');
    expect(() => quoteIdent('a\0b', 'mysql')).toThrow();
  });

  it('values run as hex literals (no escaping to get wrong) and show readable in previews', () => {
    expect(mysqlLiteral(null)).toBe('NULL');
    expect(mysqlLiteral('')).toBe("''");
    expect(mysqlLiteral("O'Brien\\")).toBe("_utf8mb4 X'4f27427269656e5c'");
    expect(mysqlLiteral('zażółć')).toBe(`_utf8mb4 X'${Buffer.from('zażółć').toString('hex')}'`);
    expect(mysqlLiteral('\\x0AFF', true)).toBe("X'0aff'");
    expect(mysqlLiteral('ab', true)).toBe("X'6162'");
    expect(mysqlDisplayLiteral("it's a \\ test")).toBe("'it''s a \\\\ test'");
  });

  it('the statement timeout of each flavour', () => {
    expect(mysqlTimeoutSql('mysql', 1500)).toBe('SET SESSION max_execution_time = 1500');
    expect(mysqlTimeoutSql('mariadb', 1500)).toBe('SET SESSION max_statement_time = 1.500');
    expect(mysqlTimeoutSql('mysql', null)).toBe('SET SESSION max_execution_time = DEFAULT');
  });
});

describe('splitting MySQL scripts', () => {
  it('respects backslash escapes, both quotes, backticks and the comment styles', () => {
    expect(texts("SELECT 'a\\'; b'; SELECT \"x;y\"; SELECT `a;b` FROM t")).toEqual(["SELECT 'a\\'; b'", 'SELECT "x;y"', 'SELECT `a;b` FROM t']);
    expect(texts('# note; here\nSELECT 1; -- c; d\nSELECT 2; /* x; */ SELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    // "--" without a blank after it is an operator, not a comment.
    expect(texts('SELECT 5--1; SELECT 2')).toEqual(['SELECT 5--1', 'SELECT 2']);
  });

  it('keeps the executable comments of dumps and runs DELIMITER blocks as the client would', () => {
    expect(texts('/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;')).toEqual(['/*!40101 SET NAMES utf8mb4 */', 'SELECT 1']);
    const script = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();';
    expect(texts(script)).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()']);
  });

  it('keeps a routine body whole without DELIMITER (BEGIN ... END, IF, CASE, loops)', () => {
    const body = `CREATE FUNCTION f(x INT) RETURNS INT DETERMINISTIC
BEGIN
  DECLARE r INT DEFAULT 0;
  IF x > 0 THEN SET r = 1; END IF;
  CASE WHEN x = 2 THEN SET r = 2; ELSE SET r = 3; END CASE;
  SET r = r + (CASE WHEN x > 9 THEN 1 ELSE 0 END);
  w: WHILE r < 10 DO SET r = r + 1; END WHILE w;
  BEGIN SET r = r; END;
  RETURN r;
END`;
    expect(texts(`${body};\nSELECT f(1);`)).toEqual([body, 'SELECT f(1)']);
    expect(texts('BEGIN; INSERT INTO t VALUES (1); COMMIT')).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)', 'COMMIT']);
    expect(texts('BEGIN NOT ATOMIC SELECT 1; SELECT 2; END; SELECT 3')).toEqual(['BEGIN NOT ATOMIC SELECT 1; SELECT 2; END', 'SELECT 3']);
  });

  it('finds the statement under the cursor', () => {
    const text = "SELECT 'a;b';\nSELECT 2";
    expect(statementAt(text, 2, 'mysql')?.text).toBe("SELECT 'a;b'");
    expect(statementAt(text, text.length, 'mysql')?.text).toBe('SELECT 2');
  });
});

describe('MySQL read-only connections', () => {
  it('allow reads and transaction control, refuse writes and setting changes', () => {
    for (const ok of ['SELECT 1', 'show tables', 'DESCRIBE t', 'EXPLAIN SELECT * FROM t', 'USE shop', 'START TRANSACTION', 'COMMIT', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED']) {
      expect(mysqlReadOnlyAllows(ok), ok).toBe(true);
    }
    for (const bad of ['INSERT INTO t VALUES (1)', 'REPLACE INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DROP TABLE t', 'CALL p()', 'SET SESSION TRANSACTION READ WRITE',
      'SET @@session.transaction_read_only = 0', 'SET autocommit = 0', "SELECT * FROM t INTO OUTFILE '/tmp/x'", 'SELECT 1 INTO @a', 'START TRANSACTION READ WRITE', 'LOAD DATA INFILE "x" INTO TABLE t', 'TRUNCATE t']) {
      expect(mysqlReadOnlyAllows(bad), bad).toBe(false);
    }
    expect(mysqlReadOnlyAllows("SELECT 'INSERT INTO t' AS s")).toBe(true);
  });

  it('only real reads keep a result open', () => {
    expect(mysqlIsReadStatement('SELECT * FROM t')).toBe(true);
    expect(mysqlIsReadStatement('SHOW PROCESSLIST')).toBe(true);
    expect(mysqlIsReadStatement('SELECT * FROM t FOR UPDATE')).toBe(false);
    expect(mysqlIsReadStatement('CALL p()')).toBe(false);
    expect(mysqlIsReadStatement('EXPLAIN ANALYZE SELECT 1')).toBe(false);
  });
});

describe('MySQL table pages and cells', () => {
  it('orders by the sort with the key as tiebreaker; keyset by the key alone', () => {
    const page = mysqlPageSql({ schema: 'shop', table: 'orders', limit: 100, offset: 200, sort: [{ column: 'total', desc: true }], filter: "status = 'new' -- x" }, ['id']);
    expect(page.sql).toBe("SELECT * FROM `shop`.`orders`\nWHERE (\nstatus = 'new' -- x\n)\nORDER BY `total` DESC, `id` DESC\nLIMIT 101\nOFFSET 200");
    const keyset = mysqlPageSql({ schema: 'shop', table: 'orders', limit: 50, after: ['42', 'x'] }, ['id', 'code'], new Set(['code']));
    expect(keyset.keyset).toBe(true);
    expect(keyset.sql).toContain("WHERE (`id`, `code`) > (_utf8mb4 X'3432', X'78')");
    expect(() => mysqlPageSql({ schema: 's', table: 't', limit: 0 }, null)).toThrow();
    expect(() => mysqlPageSql({ schema: 's', table: 't', limit: 10, after: ['1'], sort: [{ column: 'x', desc: false }] }, ['id'])).toThrow();
  });

  it('reads a whole cell by its key, cut on the server', () => {
    expect(mysqlCellSql('shop', 'docs', 'body', { id: '7' }, ['id'])).toBe("SELECT SUBSTRING(`body`, 1, 16777217) FROM `shop`.`docs` WHERE `id` = _utf8mb4 X'37' LIMIT 2");
    expect(() => mysqlCellSql('shop', 'docs', 'body', {}, ['id'])).toThrow();
  });
});

describe('MySQL staged edits', () => {
  const columns = [
    { name: 'id', dataType: 'int', generated: false }, { name: 'name', dataType: 'varchar', generated: false }, { name: 'price', dataType: 'decimal', generated: false },
    { name: 'ratio', dataType: 'double', generated: false }, { name: 'raw', dataType: 'varbinary', generated: false }, { name: 'total', dataType: 'decimal', generated: true },
  ];

  it('builds update, delete and insert with exact checks of what was loaded', () => {
    const built = mysqlEditStatements('shop', 'items', ['id'], [
      { op: 'update', key: { id: '1' }, set: { name: 'New', raw: '\\x00ff' }, original: { name: 'Old', price: '9.50', ratio: '0.1', raw: null } },
      { op: 'delete', key: { id: '2' } },
      { op: 'insert', values: { name: "it's", price: null } },
      { op: 'insert', values: {} },
    ], columns);
    expect(built[0].sql).toBe("UPDATE `shop`.`items` SET `name` = _utf8mb4 X'4e6577', `raw` = X'00ff' WHERE `id` = _utf8mb4 X'31' AND CONVERT(`name` USING utf8mb4) COLLATE utf8mb4_bin = _utf8mb4 X'4f6c64' AND `price` = _utf8mb4 X'392e3530' AND `raw` IS NULL");
    expect(built[0].preview).toBe("UPDATE `shop`.`items` SET `name` = 'New', `raw` = X'00ff' WHERE `id` = '1' AND CONVERT(`name` USING utf8mb4) COLLATE utf8mb4_bin = 'Old' AND `price` = '9.50' AND `raw` IS NULL");
    expect(built[1].sql).toBe("DELETE FROM `shop`.`items` WHERE `id` = _utf8mb4 X'32'");
    expect(built[2].preview).toBe("INSERT INTO `shop`.`items` (`name`, `price`) VALUES ('it''s', NULL)");
    expect(built[3].sql).toBe('INSERT INTO `shop`.`items` () VALUES ()');
    expect(mysqlEditPreview(built).split('\n')[0]).toBe('START TRANSACTION;');
  });

  it('refuses unknown and generated columns, and keyless updates', () => {
    expect(() => mysqlEditStatements('s', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { nope: 'x' } }], columns)).toThrow();
    expect(() => mysqlEditStatements('s', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { total: '1' } }], columns)).toThrow();
    expect(() => mysqlEditStatements('s', 't', null, [{ op: 'delete', key: { id: '1' } }], columns)).toThrow();
    expect(() => mysqlEditStatements('s', 't', ['id'], [{ op: 'delete', key: { name: 'x' } }], columns)).toThrow();
  });
});

describe('MySQL value kinds', () => {
  const field = (columnType: number, flags = 0, characterSet = 224) => mysqlFieldKind({ columnType, flags, characterSet });
  it('of result fields', () => {
    expect(field(MY_TYPE.LONG)).toEqual({ kind: 'int', typeName: 'int' });
    expect(field(MY_TYPE.LONG, 32)).toEqual({ kind: 'bigint', typeName: 'int unsigned' });
    expect(field(MY_TYPE.LONGLONG, 32)).toEqual({ kind: 'numeric', typeName: 'bigint unsigned' });
    expect(field(MY_TYPE.NEWDECIMAL).kind).toBe('numeric');
    expect(field(MY_TYPE.DATETIME).kind).toBe('timestamp');
    expect(field(MY_TYPE.JSON, 0, MY_BINARY_CHARSET).kind).toBe('json');
    expect(field(MY_TYPE.VAR_STRING)).toEqual({ kind: 'text', typeName: 'varchar' });
    expect(field(MY_TYPE.VAR_STRING, 0, MY_BINARY_CHARSET)).toEqual({ kind: 'bytea', typeName: 'varbinary' });
    expect(field(MY_TYPE.BLOB, 0, MY_BINARY_CHARSET).kind).toBe('bytea');
    expect(field(MY_TYPE.BLOB).kind).toBe('text');
    expect(field(MY_TYPE.STRING, 256).kind).toBe('enum');
    expect(field(MY_TYPE.BIT, 0, MY_BINARY_CHARSET).kind).toBe('bytea');
    expect(mysqlFieldKind({ columnType: MY_TYPE.LONG_BLOB, flags: 0, characterSet: 224, extendedFormat: 'json' }).kind).toBe('json');
  });

  it('of table columns', () => {
    expect(mysqlColumnKind('int', 'int(10) unsigned')).toBe('bigint');
    expect(mysqlColumnKind('tinyint', 'tinyint(1)')).toBe('int');
    expect(mysqlColumnKind('varbinary', 'varbinary(16)')).toBe('bytea');
    expect(mysqlColumnKind('longtext', 'longtext')).toBe('text');
    expect(mysqlColumnKind('point', 'point')).toBe('other');
    expect(mysqlColumnKind('uuid', 'uuid')).toBe('uuid');
  });
});
