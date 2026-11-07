// The DB helper part of the golden corpus (1.2.0, PLAN D3), used by scripts/dump-goldens.mjs and test/db-sql-vectors.test.ts:
//
//   test/golden/db-sql.jsonl    {fn, args} -> what src/shared/dbSql.ts, dbSqlite.ts, dbMysql.ts (+ mysqlFlavorOf /
//                               mysqlServerLabel of db.ts and redactSql of dbTabs.ts) answer
//   test/golden/db-redis.jsonl  {fn, args} -> what src/shared/dbRedis.ts answers
//
// The Rust ports (crates/unimux-db/tests/sql_golden.rs) answer the same rows, and vitest runs every row through the TS code
// again (callDb below), so the vectors cannot drift from the reference. Inputs: the cases of the TS test suite
// (db-sql, db-sqlite-shared, db-mysql, db-redis-shared) plus seeded random scripts, names, edits, pages and command lines.
//
// Values that JSON cannot carry are tagged both ways: {$num: 'NaN' | 'Infinity' | '-Infinity' | '-0'}, {$bigint: '42'},
// {$bytes: 'hex'}, {$set: [...]}, {$undef: true}; a throw is {$throws: code} (DbSqlError's code, else 'error'). Rows whose
// input or answer holds an unpaired surrogate (a JS string a Rust string cannot hold) are left out.

// ── a small seeded PRNG (mulberry32), the same as dump-goldens.mjs ───────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytesOfHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** A JS value as JSON (tags for what JSON lacks). */
export function enc(v) {
  if (v === undefined) return { $undef: true };
  if (typeof v === 'bigint') return { $bigint: String(v) };
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return { $num: '-0' };
    return Number.isFinite(v) ? v : { $num: String(v) };
  }
  if (v instanceof Uint8Array) return { $bytes: hexOf(v) };
  if (v instanceof Set) return { $set: [...v].map(enc) };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') {
    // fromEntries: a "__proto__" key stays an own property (JSON.parse makes it one too).
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)]));
  }
  return v;
}

/** JSON (tags included) as the JS value. */
export function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1) {
      if (keys[0] === '$num') return v.$num === '-0' ? -0 : Number(v.$num);
      if (keys[0] === '$bigint') return BigInt(v.$bigint);
      if (keys[0] === '$bytes') return bytesOfHex(v.$bytes);
      if (keys[0] === '$set') return new Set(v.$set.map(dec));
      if (keys[0] === '$undef') return undefined;
    }
    return Object.fromEntries(keys.map((k) => [k, dec(v[k])]));
  }
  return v;
}

/** The functions the vectors cover: name -> (modules) => function. */
const FNS = {
  // dbSql.ts
  quoteIdent: (m) => m.sql.quoteIdent, qualifiedName: (m) => m.sql.qualifiedName, quoteLiteral: (m) => m.sql.quoteLiteral,
  splitSql: (m) => m.sql.splitSql, errorSpan: (m) => m.sql.errorSpan, statementAt: (m) => m.sql.statementAt, firstKeyword: (m) => m.sql.firstKeyword,
  codeOnly: (m) => m.sql.codeOnly, returnsRows: (m) => m.sql.returnsRows, isReadStatement: (m) => m.sql.isReadStatement,
  readOnlyAllows: (m) => m.sql.readOnlyAllows, endsTransaction: (m) => m.sql.endsTransaction, buildEditStatements: (m) => m.sql.buildEditStatements,
  inlineParams: (m) => m.sql.inlineParams, editPreview: (m) => m.sql.editPreview, pageSql: (m) => m.sql.pageSql, cellSql: (m) => m.sql.cellSql,
  valueKind: (m) => m.sql.valueKind, isNumericKind: (m) => m.sql.isNumericKind, dbValueText: (m) => m.sql.dbValueText, formatDbValue: (m) => m.sql.formatDbValue,
  parseDbInput: (m) => m.sql.parseDbInput, rowsToCsv: (m) => m.sql.rowsToCsv, rowsToTsv: (m) => m.sql.rowsToTsv, jsonValue: (m) => m.sql.jsonValue,
  rowsToJson: (m) => m.sql.rowsToJson,
  // dbSqlite.ts
  sqliteAffinity: (m) => m.sqlite.sqliteAffinity, sqliteValueKind: (m) => m.sqlite.sqliteValueKind, sqliteParam: (m) => m.sqlite.sqliteParam,
  sqIdent: (m) => m.sqlite.sqIdent, sqQualified: (m) => m.sqlite.sqQualified, sqliteCodeOnly: (m) => m.sqlite.sqliteCodeOnly,
  sqliteReadOnlyAllows: (m) => m.sqlite.sqliteReadOnlyAllows, sqliteIsReadStatement: (m) => m.sqlite.sqliteIsReadStatement,
  sqliteEndsTransaction: (m) => m.sqlite.sqliteEndsTransaction, sqliteErrorPosition: (m) => m.sqlite.sqliteErrorPosition,
  sqlitePageSql: (m) => m.sqlite.sqlitePageSql, sqliteCellSql: (m) => m.sqlite.sqliteCellSql, sqliteInline: (m) => m.sqlite.sqliteInline,
  sqliteEditStatements: (m) => m.sqlite.sqliteEditStatements, sqliteEditPreview: (m) => m.sqlite.sqliteEditPreview,
  // dbMysql.ts
  mysqlLiteral: (m) => m.mysql.mysqlLiteral, mysqlDisplayLiteral: (m) => m.mysql.mysqlDisplayLiteral, myIdent: (m) => m.mysql.myIdent,
  myQualified: (m) => m.mysql.myQualified, mysqlCodeOnly: (m) => m.mysql.mysqlCodeOnly, mysqlReadOnlyAllows: (m) => m.mysql.mysqlReadOnlyAllows,
  mysqlIsReadStatement: (m) => m.mysql.mysqlIsReadStatement, mysqlEndsTransaction: (m) => m.mysql.mysqlEndsTransaction,
  mysqlTimeoutSql: (m) => m.mysql.mysqlTimeoutSql, mysqlIsUse: (m) => m.mysql.mysqlIsUse, mysqlFieldBinary: (m) => m.mysql.mysqlFieldBinary,
  mysqlFieldKind: (m) => m.mysql.mysqlFieldKind, mysqlBinaryType: (m) => m.mysql.mysqlBinaryType, mysqlColumnKind: (m) => m.mysql.mysqlColumnKind,
  mysqlPageSql: (m) => m.mysql.mysqlPageSql, mysqlCellSql: (m) => m.mysql.mysqlCellSql, mysqlEditStatements: (m) => m.mysql.mysqlEditStatements,
  mysqlEditPreview: (m) => m.mysql.mysqlEditPreview, mysqlErrorText: (m) => m.mysql.mysqlErrorText, mysqlErrorPosition: (m) => m.mysql.mysqlErrorPosition,
  // db.ts, dbTabs.ts
  mysqlFlavorOf: (m) => m.db.mysqlFlavorOf, mysqlServerLabel: (m) => m.db.mysqlServerLabel, redactSql: (m) => m.tabs.redactSql,
  // dbRedis.ts
  bytesToBase64: (m) => m.redis.bytesToBase64, base64ToBytes: (m) => m.redis.base64ToBytes, redisDataFromBytes: (m) => m.redis.redisDataFromBytes,
  redisDataBytes: (m) => m.redis.redisDataBytes, redisDataLength: (m) => m.redis.redisDataLength, redisDataHex: (m) => m.redis.redisDataHex,
  redisDataFromHex: (m) => m.redis.redisDataFromHex, redisDataDisplay: (m) => m.redis.redisDataDisplay, redisDataKey: (m) => m.redis.redisDataKey,
  redisDataEquals: (m) => m.redis.redisDataEquals, parseRedisCommandLine: (m) => m.redis.parseRedisCommandLine, quoteRedisArg: (m) => m.redis.quoteRedisArg,
  redisCommandName: (m) => m.redis.redisCommandName, classifyRedisCommand: (m) => m.redis.classifyRedisCommand, parseRedisInfo: (m) => m.redis.parseRedisInfo,
  parseRedisKeyspace: (m) => m.redis.parseRedisKeyspace, parseRedisClientList: (m) => m.redis.parseRedisClientList, isStreamId: (m) => m.redis.isStreamId,
  streamIdStep: (m) => m.redis.streamIdStep,
};

/** What `fn(...args)` answers in the TS code, as JSON (args as stored in a row, tags included). */
export function callDb(m, fn, args) {
  const f = FNS[fn]?.(m);
  if (typeof f !== 'function') throw new Error(`no function ${fn}`);
  try {
    return enc(f(...dec(args)));
  } catch (e) {
    // Each module may carry its own copy of dbSql.ts (one module graph per import), so the class is told by name.
    return { $throws: e?.constructor?.name === 'DbSqlError' ? e.code : 'error' };
  }
}

const LONE = /\\ud[89a-f][0-9a-f]{2}/i;

function collect(m) {
  const rows = [];
  const seen = new Set();
  let skipped = 0;
  const add = (fn, ...args) => {
    const stored = JSON.parse(JSON.stringify(enc(args)));
    const id = `${fn}${JSON.stringify(stored)}`;
    if (seen.has(id)) return;
    seen.add(id);
    const row = { fn, args: stored, out: callDb(m, fn, stored) };
    const line = JSON.stringify(row);
    if (LONE.test(line)) { skipped++; return; }
    rows.push(row);
  };
  return { rows, add, skipped: () => skipped };
}

// ── SQL scripts ─────────────────────────────────────────────────────────────

const SQL_TOKENS = [
  'SELECT', 'select', 'INSERT', 'INTO', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'WITH', 'AS', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'ANALYZE', 'ANALYSE',
  'FETCH', 'EXECUTE', 'CALL', 'RETURNING', 'returning', 'FOR', 'NO', 'KEY', 'SHARE', 'BEGIN', 'begin', 'ATOMIC', 'NOT', 'END', 'end', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'IF', 'LOOP', 'WHILE', 'REPEAT', 'UNTIL', 'DO', 'COMMIT', 'ROLLBACK', 'ABORT', 'START', 'TRANSACTION', 'READ', 'WRITE', 'ONLY', 'SET', 'RESET', 'DISCARD',
  'SESSION', 'CREATE', 'TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT', 'PRAGMA', 'pragma', 'table_info', 'journal_mode', 'query_only', 'index_list', 'optimize', 'main',
  'DECLARE', 'CURSOR', 'MOVE', 'CLOSE', 'SAVEPOINT', 'RELEASE', 'USE', 'DESCRIBE', 'DESC', 'HELP', 'REPLACE', 'UPSERT', 'MERGE', 'TRUNCATE', 'LOAD', 'DATA',
  'ATTACH', 'DETACH', 'VACUUM', 'REINDEX', 'DROP', 'ALTER', 'set_config', 'dblink_exec', 'dblink', 'transaction_read_only', 'default_transaction_read_only',
  'tx_read_only', 'read_only', 'PASSWORD', 'password', 'IDENTIFIED', 'BY', 'password=', '=', 'DELIMITER', 'delimiter', '$$', '//', ';', ';', ';', ';', '(', ')',
  ',', '.', '*', '+', '-', '--', '-- c;', '--x\n', '-- x\n', '#c;\n', '#', '/*', '*/', '/* a; */', '/* /* n */ */', '/*!40101 SET x */', '/*M! y */', "'", "''",
  "'a;b'", "E'\\';x'", "e'", 'E', 'e', '"', '""', '"q;"', '`', '`b;`', '[', ']', '[x;y]', '$', '$1', '$2', '$a$', '$a$;x$a$', '$$ ; $$', '\\', "\\'", '\\\\',
  '\n', '\n', '\r\n', '\t', ' ', ' ', ' ', '﻿', 'ż', 'Ż', '🙂', 'a$b', '1', '42', '1e5', 'x', 't', 'w:', 'lbl:', 'GET', 'NULL', 'OFF',
  '0', 'IS', 'FRM', 'secret', "'s3cr''et'", 'pg_sleep', 'ż;ź', 'ñ', 'ǅ', 'ß',
];
const SEPS = [' ', ' ', ' ', ' ', '', '', '\n', '\t', '  '];

function randomSql(r, maxTokens = 30) {
  const n = 1 + Math.floor(r() * maxTokens);
  let s = '';
  for (let i = 0; i < n; i++) s += SQL_TOKENS[Math.floor(r() * SQL_TOKENS.length)] + SEPS[Math.floor(r() * SEPS.length)];
  return r() < 0.3 ? s.trim() : s;
}

/** Scripts and statements of the TS test suite, and more hand-picked ones. */
const SQL_CASES = [
  "SELECT 'a;b'; SELECT \"x;y\" FROM t;SELECT 3", "SELECT 'it''s; fine'; SELECT E'a\\';b'; SELECT 2", 'SELECT 1 -- no; split\n; SELECT /* a; /* nested; */ b; */ 2',
  'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f()', 'DO $body$ BEGIN PERFORM 1; END $body$; SELECT $1, a$b FROM t',
  'CREATE FUNCTION g(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END; SELECT 2; END; SELECT 3', 'BEGIN; SELECT 1; COMMIT;',
  ';;  -- only a comment\n; /* x */ ;', '-- heading\n  SELECT 1;\n\n', "SELECT 'open; SELECT 2", 'SELECT $$open; SELECT 2', 'SELECT 1;\nSELECT 2;\n\nSELECT 3', '  \n SELECT 9',
  '-- nothing', '/* c */ -- d\n (SELECT 1)', 'with x as (select 1) select * from x', 'VALUES (1)', 'TABLE t', 'SHOW search_path', 'EXPLAIN SELECT 1',
  'INSERT INTO t VALUES (1) RETURNING id', 'update t set a = 1 returning *', 'CALL p()', 'EXECUTE stmt(1)', 'INSERT INTO t VALUES (1)', 'CREATE TABLE t (a int)', 'BEGIN',
  'SET x = 1', "INSERT INTO t VALUES ('returning')", 'VACUUM', 'SELECT * FROM t', 'WITH a AS (SELECT 1) SELECT * FROM a', "SELECT 'insert into x'",
  'INSERT INTO t VALUES (1) RETURNING *', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'SELECT * INTO t2 FROM t', 'SELECT * FROM t FOR UPDATE',
  'SELECT * FROM t FOR NO KEY UPDATE', 'SELECT * FROM t FOR KEY SHARE', 'EXPLAIN ANALYZE DELETE FROM t', 'EXECUTE s', 'BEGIN READ ONLY', 'START TRANSACTION ISOLATION LEVEL SERIALIZABLE',
  'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a', 'DECLARE c CURSOR FOR SELECT 1', 'FETCH 10 FROM c', "SELECT 'set_config'",
  'UPDATE t SET a = 1', 'DELETE FROM t', 'DROP TABLE t', 'TRUNCATE t', 'COPY t FROM STDIN', 'DO $$ BEGIN END $$', 'SET default_transaction_read_only = off',
  'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'RESET ALL', 'DISCARD ALL', 'BEGIN READ WRITE', 'START TRANSACTION READ WRITE', 'SET TRANSACTION READ WRITE',
  "SELECT set_config('default_transaction_read_only', 'off', false)", 'SET statement_timeout = 0', 'PREPARE p AS DELETE FROM t', 'EXECUTE p',
  "SELECT dblink_exec('x', 'delete from t')", 'commit', 'end', 'abort', '(((SELECT 1)))', '/* unterminated', '-- c\n-- d\nSELECT 1', 'SELECT/**/1',
  `SELECT 'a;b', "c;d", [e;f], \`g;h\`; -- x;y\n/* p;q */ INSERT INTO t VALUES (1);\nCREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE u SET n = CASE WHEN NEW.x > 0 THEN 1 ELSE 0 END;\n  DELETE FROM v;\nEND;\nSELECT 2`,
  'BEGIN; SELECT 1; COMMIT', 'EXPLAIN QUERY PLAN SELECT 1', "PRAGMA table_info('t')", 'PRAGMA journal_mode', 'PRAGMA main.index_list(t)', 'PRAGMA query_only = 0',
  'PRAGMA journal_mode = WAL', 'PRAGMA journal_mode(WAL)', 'PRAGMA optimize', "ATTACH DATABASE 'x' AS y", 'WITH x AS (SELECT 1) DELETE FROM t', ' DROP TABLE t',
  "SELECT 'delete'", 'CREATE TEMP TRIGGER IF NOT EXISTS t2 BEFORE DELETE ON x FOR EACH ROW WHEN OLD.a > 1 BEGIN SELECT RAISE(ABORT, \'no;\'); END; SELECT 1',
  "SELECT 'a\\'; b'; SELECT \"x;y\"; SELECT `a;b` FROM t", '# note; here\nSELECT 1; -- c; d\nSELECT 2; /* x; */ SELECT 3', 'SELECT 5--1; SELECT 2',
  '/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;', 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();',
  'CREATE FUNCTION f(x INT) RETURNS INT DETERMINISTIC\nBEGIN\n  DECLARE r INT DEFAULT 0;\n  IF x > 0 THEN SET r = 1; END IF;\n  CASE WHEN x = 2 THEN SET r = 2; ELSE SET r = 3; END CASE;\n  SET r = r + (CASE WHEN x > 9 THEN 1 ELSE 0 END);\n  w: WHILE r < 10 DO SET r = r + 1; END WHILE w;\n  BEGIN SET r = r; END;\n  RETURN r;\nEND;\nSELECT f(1);',
  'BEGIN; INSERT INTO t VALUES (1); COMMIT', 'BEGIN NOT ATOMIC SELECT 1; SELECT 2; END; SELECT 3', "SELECT 'a;b';\nSELECT 2", 'show tables', 'DESCRIBE t',
  'EXPLAIN SELECT * FROM t', 'USE shop', 'START TRANSACTION', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'REPLACE INTO t VALUES (1)', 'SET SESSION TRANSACTION READ WRITE',
  'SET @@session.transaction_read_only = 0', 'SET autocommit = 0', "SELECT * FROM t INTO OUTFILE '/tmp/x'", 'SELECT 1 INTO @a', 'LOAD DATA INFILE "x" INTO TABLE t',
  "SELECT 'INSERT INTO t' AS s", 'SHOW PROCESSLIST', 'EXPLAIN ANALYZE SELECT 1', 'DELIMITER //\nCREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END//\nDELIMITER ;',
  'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM t; END; SELECT 1', 'REPEAT SET x = x + 1; UNTIL x > 3 END REPEAT; SELECT 1', 'l: LOOP LEAVE l; END LOOP l; SELECT 2',
  "ALTER USER app PASSWORD 'secret'", "CREATE USER u IDENTIFIED BY 'p''w'", "create role r with password E'x\\'y'", 'ALTER ROLE r PASSWORD $p$sec;ret$p$',
  "SELECT dblink_connect('host=h password=hunter2 user=u')", "SELECT 'password = abc'", "x password='q w' y", 'PASSWORD NULL', "IDENTIFIED  BY\n'x'",
  'SELECT 1; SELECT 2;', 'SELECT 🙂; SELECT ż', "SELECT '🙂;'; SELECT 2", 'SELECT $ż$;$ż$; SELECT 1', '$a$ x $a$', 'SELECT 1 /* a */ ; /* b */',
];

function sqlRows(m) {
  const { rows, add, skipped } = collect(m);
  const r = rng(0xd3);
  const dialects = ['postgres', 'mysql', 'sqlite'];
  const classifiers = ['firstKeyword', 'codeOnly', 'returnsRows', 'isReadStatement', 'readOnlyAllows', 'endsTransaction', 'sqliteCodeOnly', 'sqliteReadOnlyAllows',
    'sqliteIsReadStatement', 'sqliteEndsTransaction', 'mysqlCodeOnly', 'mysqlReadOnlyAllows', 'mysqlIsReadStatement', 'mysqlEndsTransaction', 'mysqlIsUse', 'redactSql'];
  const script = (text) => {
    for (const d of dialects) {
      add('splitSql', text, d);
      const spans = m.sql.splitSql(text, d);
      for (const s of spans) for (const fn of classifiers) add(fn, s.text);
      const n = text.length;
      for (const off of n > 200 ? [Math.floor(r() * (n + 2))] : [0, n, Math.floor(r() * (n + 2))]) add('statementAt', text, off, d);
    }
    for (const fn of classifiers) add(fn, text);
    for (const at of [0, text.length, text.length + 2, -1, Math.floor(r() * (text.length + 1))]) add('errorSpan', text, at);
  };
  for (const s of SQL_CASES) script(s);
  add('splitSql', 'SELECT 1; SELECT 2');
  add('statementAt', 'SELECT 1; SELECT 2', 2.5);
  add('statementAt', 'SELECT 1; SELECT 2', -1);
  for (let i = 0; i < 800; i++) script(randomSql(r, i < 650 ? 25 : 60));
  // A whole dump-like script in one piece.
  script(Array.from({ length: 25 }, () => randomSql(r, 10)).join(';\n'));

  // Error positions.
  const sqliteMsgs = (sql) => {
    const words = sql.split(/[\s;(),]+/).filter(Boolean);
    const pick = () => words[Math.floor(r() * words.length)] ?? 'x';
    return [`near "${pick().replace(/"/g, '""')}": syntax error`, `near "${pick()}": syntax error`, 'incomplete input', 'no such table: t', 'near "": syntax error',
      `near "${pick()}x": syntax error`, `prefix near "${pick().replace(/"/g, '""')}": syntax error in "${sql.slice(0, 10)}"`];
  };
  const mysqlMsg = (near, line) => `ERROR 1064 (42000): You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '${near}' at line ${line}`;
  const positions = (sql) => {
    for (const msg of sqliteMsgs(sql)) add('sqliteErrorPosition', msg, sql);
    const at = Math.floor(r() * (sql.length + 1));
    const lineNo = sql.slice(0, at).split('\n').length;
    for (const [near, line] of [[sql.slice(at, at + 80), lineNo], [sql.slice(at, at + 80), 1], ['', 1], [sql.slice(at, at + 80), lineNo + 1], [sql.slice(at, at + 30) + 'zz', lineNo], ['x', 0], ['x', 2.5]]) {
      add('mysqlErrorPosition', mysqlMsg(near, line), sql);
    }
  };
  add('sqliteErrorPosition', 'near "FRM": syntax error', "SELECT 'FRM' AS a\nFRM t");
  add('sqliteErrorPosition', 'incomplete input', 'SELECT (');
  add('sqliteErrorPosition', 'no such table: t', 'SELECT * FROM t');
  add('sqliteErrorPosition', 'near "\'abc\'": syntax error', "SELECT 'abc' 'abc'");
  add('sqliteErrorPosition', 'near "[a]": syntax error', 'SELECT [a] [a]');
  add('sqliteErrorPosition', 'near "a.b": syntax error', 'SELECT axb, a.b');
  add('sqliteErrorPosition', 'near "$x": syntax error', 'SELECT a$x, $x');
  add('mysqlErrorPosition', mysqlMsg('FRM t', 2), 'SELECT *\nFRM t');
  add('mysqlErrorPosition', mysqlMsg('x', 2), 'SELECT x\nFROM x');
  add('mysqlErrorPosition', mysqlMsg('', 1), 'SELECT (');
  add('mysqlErrorPosition', "ERROR 1146: Table 'a.b' doesn't exist", 'SELECT 1');
  add('mysqlErrorPosition', mysqlMsg("'abc' FRM t", 1), "SELECT 'abc' FRM t");
  add('mysqlErrorPosition', mysqlMsg('x', 7), 'SELECT x');
  add('mysqlErrorPosition', `${mysqlMsg('x', 1)}  \n`, 'SELECT x');
  for (const s of SQL_CASES) positions(s);
  for (let i = 0; i < 400; i++) positions(randomSql(r, 30));
  // The read-only checks are a security boundary: many more short statements through them alone.
  const rr = rng(0x5ec);
  for (let i = 0; i < 6000; i++) {
    const stmt = randomSql(rr, 8);
    for (const fn of ['readOnlyAllows', 'sqliteReadOnlyAllows', 'mysqlReadOnlyAllows', 'isReadStatement', 'sqliteIsReadStatement', 'mysqlIsReadStatement']) add(fn, stmt);
  }
  for (const [t, at] of [['SELECT * FRM t', 9], ['SELECT "my col" x', 7], ['SELECT (', 8], ['SELECT 1 +', 9], ['SELECT [a b] x', 7], ['SELECT `q', 7], ["SELECT 'a", 7],
    ['SELECT  \n  x', 8], ['', 0], ['   ', 1], [`SELECT "${'x'.repeat(250)}"`, 7], [`SELECT ${'y'.repeat(250)}`, 7], ['SELECT ż🙂x', 7], ['a b', 1]]) add('errorSpan', t, at);

  // Quoting.
  const NAMES = ['users', 'My "odd" Table', 'we`ird"name', '', 'a\0b', 'x'.repeat(1024), 'x'.repeat(1025), '🙂'.repeat(512), '🙂'.repeat(513), 'zażółć', 'main', 'rowid',
    '0', '1', '10', '__proto__', 'constructor', 'toString', 'a b', "it's", '[x]', ' ', 'id'];
  for (const n of NAMES) {
    for (const d of dialects) add('quoteIdent', n, d);
    add('quoteIdent', n);
    add('sqIdent', n);
    add('myIdent', n);
    add('qualifiedName', n, 't', 'postgres');
    add('qualifiedName', 's', n, 'mysql');
    add('qualifiedName', 's', n);
    add('sqQualified', n, 't');
    add('sqQualified', 'main', n);
    add('myQualified', n, 't');
  }
  const LITERALS = [null, '', "it's", 'back\\slash', 'a\0b', 'zażółć 🙂', '\\x0aff', '\\x0AFF', '\\x0af', '\\x', 'ab', "O'Brien\\", '\n\r\t', '$1', '?', ' '];
  for (const v of LITERALS) {
    add('quoteLiteral', v);
    add('mysqlLiteral', v);
    add('mysqlLiteral', v, true);
    add('mysqlLiteral', v, false);
    add('mysqlDisplayLiteral', v);
  }
  for (const [sql, params] of [['UPDATE t SET a = $1 WHERE b = $2', ["O'Brien", null]], ['$1 $10 $2 $0 $3', ['a', 'b']], ['$$1', ['x']], ['$01', ['z']], ['no params', []],
    ['$1$1', ['q']], ['$99999999999999999999', ['x']]]) add('inlineParams', sql, params);
  for (const [sql, params] of [['? ?', [null, { $bigint: '7' }]], ['?, ?, ?', ['x', { $bytes: '00ff' }, 1.5]], ['???', [{ $num: 'Infinity' }, { $num: '-0' }]], ['a', []],
    ['? ?', ['?']], ['?', [1e21, 1e-7]], ['?', [123456789.125]]]) {
    add('sqliteInline', sql, dec(params));
  }

  // Value kinds and values.
  for (const oid of [16, 17, 18, 19, 20, 21, 23, 25, 26, 114, 142, 700, 701, 790, 1042, 1043, 1082, 1083, 1114, 1184, 1186, 1266, 1700, 2950, 3802, 4072, 1007, 99999, 0, -1]) {
    for (const cat of [undefined, 'A', 'E', 'B', 'S', 'N', 'D', 'U', '']) add('valueKind', oid, cat);
  }
  const KINDS = ['text', 'int', 'bigint', 'float', 'numeric', 'bool', 'json', 'bytea', 'uuid', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'array', 'enum', 'other'];
  for (const k of KINDS) add('isNumericKind', k);
  const INPUTS = [' +42 ', '2147483648', '2147483647', '-2147483648', '-2147483649', '9223372036854775807', '9223372036854775808', '-9223372036854775808', '1.5', '-1.5e3',
    'abc', 'Infinity', '-inf', 'INF', 'NaN', 'nan', '+Infinity', '.5', '5.', '1e', 'Yes', 'maybe', 'off', '0', 'T', '{"a": 1}', '{a: 1}', '[1e400, "\\ud800"]', ' null ',
    '6f1d9a2e-4c1b-4c5e-9b7a-2a3b4c5d6e7f', '{6F1D9A2E4C1B4C5E9B7A2A3B4C5D6E7F}', '\\x0aff', '\\x0af', '\\X', '{1,2}', '1,2', '[1:2]={1,2}', '', '  spaced ', 'a\0b',
    '$1.00', ' 12 ', '٣', '1_000', '0x10', '00012', '+0', '-0', '{}', '[]', '"x"', 'true', '1 2', '{"a":1,"a":2}', '[01]', ' {} '];
  for (const k of KINDS) {
    for (const t of INPUTS) add('parseDbInput', k, t);
    add('parseDbInput', k, 'x', { asNull: true });
  }
  for (const t of ['$1.00', '', 'abc', 'Infinity', 'NaN', '12']) add('parseDbInput', 'numeric', t, { typeName: 'money' });
  const VALUES = [null, 't', 'f', 'x', '{"a":1}', '{"b":[1,{"c":null}],"a":"ż"}', '[1e400, 1.5, -0, 1e21, 1e-7, 123456789012345678901234567890]', '{bad', '12345678901234567890',
    '9007199254740991', '9007199254740993', '-9007199254740992', '1.5', '1e500', 'NaN', 'Infinity', '0x1F', ' 7 ', '', '{"__proto__":1,"2":2,"1":1}',
    { t: 'trunc', head: 'abc', chars: 10 }, { t: 'trunc', head: '{"a"', chars: 9 }, '"\\ud83d\\ude00"', '{"a":{"b":{"c":[[]]}}}', '[]', '{}', '"str"', '-1', '3.0'];
  for (const v of VALUES) {
    add('dbValueText', v);
    for (const k of KINDS) {
      add('formatDbValue', v, k);
      add('formatDbValue', v, k, { pretty: true });
      add('jsonValue', v, k);
    }
  }
  const cols = [{ name: 'id', kind: 'bigint' }, { name: 'note', kind: 'text' }, { name: 'ok', kind: 'bool' }, { name: 'doc', kind: 'json' }];
  const rowsA = [['9007199254740993', 'a,"b"', 't', '{"x":1}'], ['1', null, 'f', null]];
  add('rowsToCsv', cols, rowsA);
  add('rowsToCsv', cols, rowsA, ';');
  add('rowsToTsv', [['a\tb', null, 'c\nd']]);
  add('rowsToJson', cols, rowsA);
  for (let i = 0; i < 300; i++) {
    const nCols = 1 + Math.floor(r() * 5);
    const cs = Array.from({ length: nCols }, (_, j) => ({ name: [`c${j}`, String(j), 'a b', 'q"', 'x,y', ' lead', 'ż', '__proto__', `${j}0`][Math.floor(r() * 9)], kind: KINDS[Math.floor(r() * KINDS.length)] }));
    const rs = Array.from({ length: Math.floor(r() * 4) }, () => Array.from({ length: nCols + (r() < 0.2 ? -1 : 0) }, () => VALUES[Math.floor(r() * VALUES.length)]));
    const sep = [',', ';', '\t', '|'][Math.floor(r() * 4)];
    add('rowsToCsv', cs, rs, sep);
    add('rowsToTsv', rs);
    add('rowsToJson', cs, rs);
  }

  // SQLite types and parameters.
  const DECLS = ['INTEGER', 'BIGINT', 'varchar(20)', 'BLOB', '', '  ', 'REAL', 'DOUBLE', 'NUMERIC', 'DECIMAL(10,2)', 'DATETIME', 'TEXT', 'JSON', 'jsonb', 'BOOLEAN', 'bool',
    'UUID', 'guid', 'FLOATING POINT', 'CHARINT', 'POINT', 'number', 'clob', null, undefined, 'ınt', 'İNT', 'ﬂoat'];
  for (const d of DECLS) { add('sqliteAffinity', d); add('sqliteValueKind', d); }
  const AFFS = ['integer', 'text', 'blob', 'real', 'numeric'];
  const PARAMS = [null, '9007199254740993', '99999999999999999999', '9223372036854775807', '9223372036854775808', '-9223372036854775808', '+12', '-0', '00', '1.5', ' 1.5 ',
    '1e400', '-Infinity', 'Infinity', '\\x00ff', '\\x0', 'abc', '', ' 7', '1e3', '.5', '5.', '0x10', '1234567890123456789', '12345678901234567890', ' 1'];
  for (const a of AFFS) for (const p of PARAMS) add('sqliteParam', p, a);

  // MySQL types.
  const MT = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0xf2, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff, 0x11, 300];
  for (const t of MT) {
    for (const [flags, charset] of [[0, 224], [32, 224], [0, 63], [256, 224], [2048, 63], [32 | 256, 63], [4294967328, 224], [-1, 63]]) {
      add('mysqlFieldKind', { columnType: t, characterSet: charset, flags });
      add('mysqlFieldBinary', { columnType: t, characterSet: charset, flags });
    }
    add('mysqlFieldKind', { columnType: t, characterSet: 63, flags: 0, extendedTypeName: 'inet6' });
    add('mysqlFieldKind', { columnType: t, characterSet: 224, flags: 0, extendedTypeName: 'uuid' });
    add('mysqlFieldKind', { columnType: t, characterSet: 63, flags: 0, extendedFormat: 'json' });
    add('mysqlFieldKind', { columnType: t, characterSet: 63, flags: 0, extendedTypeName: '' });
    add('mysqlFieldBinary', { columnType: t, characterSet: 63, flags: 0, extendedFormat: 'json' });
  }
  const DT = ['tinyint', 'smallint', 'mediumint', 'year', 'int', 'INTEGER', 'bigint', 'float', 'double', 'real', 'decimal', 'numeric', 'date', 'time', 'datetime', 'timestamp',
    'json', 'uuid', 'enum', 'set', 'binary', 'VARBINARY', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit', 'char', 'varchar', 'text', 'longtext', 'geometry', 'point',
    'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection', 'vector', 'inet6', '', 'İNT'];
  for (const d of DT) {
    add('mysqlBinaryType', d);
    for (const ct of [d, `${d}(10) unsigned`, `${d} UNSIGNED zerofill`, `${d}_unsigned`]) add('mysqlColumnKind', d, ct);
  }
  for (const f of ['mysql', 'mariadb']) for (const ms of [null, 0, 1500, 1500.7, -5, 1, 999, 86400000, 1e21, 123456]) add('mysqlTimeoutSql', f, ms);
  for (const [e, s, msg] of [[1146, '42S02', "Table 'x.y' doesn't exist"], [undefined, undefined, 'plain'], [0, 'HY000', 'zero'], [1064, '', 'empty state'], [2013, undefined, 'lost'], [1.5, 'X', 'frac']]) {
    add('mysqlErrorText', e, s, msg);
  }
  for (const [v, c] of [['11.4.2-MariaDB-ubu2404', undefined], ['5.5.5-10.6.12-MariaDB', undefined], ['10.11.6', 'mariadb.org binary distribution'], ['8.0.36', 'MySQL Community Server - GPL'],
    ['8.0.35-27', 'Percona Server (GPL)'], ['5.5.5-10.6.12-MariaDB-1:10.6.12+maria~ubu2004', undefined], ['8.4.3', 'MySQL Community Server - GPL'], ['8.0.36-log', undefined],
    ['', ''], ['weird version string that is longer than forty characters in total', 'x'], ['5.5.5-', 'MARIADB'], ['9', undefined], ['1.2.3.4.5', undefined], ['ż'.repeat(50), undefined]]) {
    add('mysqlFlavorOf', v, c);
    add('mysqlServerLabel', v, c);
  }

  // Pages and cells.
  const pageInputs = [];
  pageInputs.push([{ schema: 's', table: 't', limit: 100, offset: 200 }, ['id']], [{ schema: 's', table: 't', limit: 10 }, null],
    [{ schema: 's', table: 't', limit: 5, sort: [{ column: 'name', desc: true }] }, ['id']],
    [{ schema: 's', table: 't', limit: 5, after: ['1', 'x'], sort: [{ column: 'a', desc: true }, { column: 'b', desc: true }] }, ['a', 'b']],
    [{ schema: 's', table: 't', limit: 5, after: ['1'], sort: [{ column: 'name', desc: false }] }, ['id']], [{ schema: 's', table: 't', limit: 5, after: ['1'] }, null],
    [{ schema: 's', table: 't', limit: 5, filter: ' a > 1 -- comment ', after: ['3'] }, ['id']], [{ schema: 's', table: 't', limit: 0 }, null],
    [{ schema: 's', table: 't', limit: 5, filter: 'a\0' }, null], [{ schema: 'main', table: 'notes', limit: 100, offset: 200, sort: [{ column: 'body', desc: true }], filter: 'n > 1' }, ['rowid']],
    [{ schema: 'main', table: 't', limit: 10 }, ['a', 'b']], [{ schema: 'other', table: 't', limit: 10 }, null], [{ schema: 'main', table: 't', limit: 10, after: ['1'] }, ['a']],
    [{ schema: 'shop', table: 'orders', limit: 100, offset: 200, sort: [{ column: 'total', desc: true }], filter: "status = 'new' -- x" }, ['id']],
    [{ schema: 'shop', table: 'orders', limit: 50, after: ['42', 'x'] }, ['id', 'code']]);
  // The filter limit (64 KiB in UTF-16 units, after the trim).
  const page = { schema: 'main', table: 't', limit: 1 };
  add('pageSql', { ...page, filter: ` ${'x'.repeat(65536)} ` }, null);
  add('mysqlPageSql', { ...page, filter: '🙂'.repeat(32768) }, null);
  add('sqlitePageSql', { ...page, filter: `${'🙂'.repeat(32767)}xx` }, null, null);
  for (const filter of [` ${'x'.repeat(65537)} `, `${'🙂'.repeat(32768)}x`]) {
    add('pageSql', { ...page, filter }, null);
    add('mysqlPageSql', { ...page, filter }, null);
    add('sqlitePageSql', { ...page, filter }, null, null);
  }
  const COLS = ['id', 'a', 'b', 'name', 'rowid', 'code', '', 'q"', 'w`', '0', '__proto__'];
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const num = () => pick([0, 1, 0.5, 1.9, 5, 100, 99999, 100000, 100001, -3, 2.7, 200, 1e21, { $num: 'NaN' }, { $num: 'Infinity' }, { $num: '-Infinity' }]);
  for (let i = 0; i < 800; i++) {
    const input = { schema: pick(['s', 'main', 'public', 'main', '', 'x"y']), table: pick(['t', 'orders', 'a`b', '']), limit: num() };
    if (r() < 0.5) input.offset = num();
    if (r() < 0.5) input.sort = Array.from({ length: r() < 0.05 ? 17 : Math.floor(r() * 4) }, () => ({ column: pick(COLS), desc: r() < 0.5 }));
    const key = r() < 0.2 ? null : r() < 0.1 ? [] : Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(COLS));
    if (r() < 0.4) {
      const n = key && r() < 0.8 ? key.length : Math.floor(r() * 3);
      input.after = Array.from({ length: n }, () => pick(['1', 'x', '\\x00ff', '', "it's", 7]));
      if (key && r() < 0.6) input.sort = key.map((c) => ({ column: c, desc: input.sort?.[0]?.desc ?? false }));
    }
    if (r() < 0.4) input.filter = pick([' a > 1 ', '', '   ', 'a\0', "s = 'ż' -- c", ' b = 1 ', '🙂']);
    pageInputs.push([input, key]);
  }
  for (const [input, key] of pageInputs) {
    const st = JSON.parse(JSON.stringify(input));
    add('pageSql', st, key);
    add('mysqlPageSql', st, key);
    add('mysqlPageSql', st, key, new Set(key ? [key[key.length - 1], 'code'] : ['code']));
    add('sqlitePageSql', st, key, null);
    add('sqlitePageSql', st, key, 'rowid');
    add('sqlitePageSql', st, key, '');
  }

  const SQ_COLS = [{ name: 'id', affinity: 'integer', generated: false }, { name: 'name', affinity: 'text', generated: false }, { name: 'n', affinity: 'blob', generated: false },
    { name: 'g', affinity: 'integer', generated: true }, { name: 'r', affinity: 'real', generated: false }, { name: 'num', affinity: 'numeric', generated: false },
    { name: '0', affinity: 'text', generated: false }, { name: '', affinity: 'text', generated: false }];
  const MY_COLS = [{ name: 'id', dataType: 'int', generated: false }, { name: 'name', dataType: 'varchar', generated: false }, { name: 'price', dataType: 'decimal', generated: false },
    { name: 'ratio', dataType: 'double', generated: false }, { name: 'raw', dataType: 'varbinary', generated: false }, { name: 'total', dataType: 'decimal', generated: true },
    { name: 'doc', dataType: 'JSON', generated: false }, { name: 'e', dataType: 'ENUM', generated: false }, { name: 'p', dataType: 'point', generated: false }, { name: '0', dataType: 'text', generated: false }];
  const CELL_NAMES = ['id', 'name', 'n', 'g', 'r', 'num', '0', 'rowid', 'nope', '', 'raw', 'price', 'ratio', 'doc', 'e', 'p', 'total', '__proto__'];
  const cellValue = () => pick(['7', '1', '42', "O'Hara", '\\x0a', '\\x00ff', '9.50', '0.1', '', 'ż🙂', '1.5', '-0', '99999999999999999999', null, 3, true, '{"a": 1}']);
  const obj = (names, value) => { const o = {}; for (const n of names) o[n] = value(); return o; };
  for (let i = 0; i < 300; i++) {
    const key = Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(['id', 'name', 'rowid', 'n', 'raw', '0']));
    const k = obj(r() < 0.8 ? key : [pick(CELL_NAMES)], () => pick(['7', '\\x00ff', 'x', null, 5]));
    add('cellSql', 's', 't', pick(CELL_NAMES), k, key);
    add('mysqlCellSql', 'shop', 'docs', pick(CELL_NAMES), k, key, new Set(['raw', 'n']));
    add('mysqlCellSql', 'shop', 'docs', pick(CELL_NAMES), k, key);
    add('sqliteCellSql', pick(['main', 'x']), 't', pick(CELL_NAMES), k, key, SQ_COLS, pick([null, 'rowid', '']));
  }
  add('cellSql', 's', 't', 'body', { id: '4' }, ['id']);
  add('cellSql', 's', 't', 'body', { other: '4' }, ['id']);
  add('cellSql', 's', 't', 'body', {}, []);
  add('mysqlCellSql', 'shop', 'docs', 'body', { id: '7' }, ['id']);
  add('mysqlCellSql', 'shop', 'docs', 'body', {}, ['id']);

  // Staged edits.
  const PG_FIXED = [
    ['public', 'users', ['id'], [{ op: 'update', key: { id: '7' }, set: { name: "O'Brien", note: null } }, { op: 'insert', values: { id: '8', name: 'new' } }, { op: 'insert', values: {} }, { op: 'delete', key: { id: '9' } }], ['id', 'name', 'note']],
    ['s', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { v: 'new' }, original: { v: 'old', n: null } }, { op: 'delete', key: { id: '2' }, original: { v: 'x' } }], ['id', 'v', 'n'], [], { id: 'integer', v: 'character(4)', n: 'boolean' }],
    ['s', 't', ['id'], [{ op: 'delete', key: { id: '1' }, original: { j: '{"a": 1}', b: '{}', x: 'y' } }], ['id', 'j', 'b', 'x'], [], { j: 'json', b: 'jsonb' }],
    ['s', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { v: 'a' }, original: { zz: 'a' } }], ['id', 'v']],
    ['s', 't', ['a', 'b'], [{ op: 'update', key: { b: '2', a: '1' }, set: { v: 'x' } }]], ['s', 't', null, [{ op: 'delete', key: { a: '1' } }]],
    ['s', 't', ['a', 'b'], [{ op: 'delete', key: { a: '1' } }]], ['s', 't', ['a'], [{ op: 'delete', key: { a: null } }]], ['s', 't', ['a'], [{ op: 'update', key: { a: '1' }, set: {} }]],
    ['s', 't', ['a'], [{ op: 'update', key: { a: '1' }, set: { zz: '1' } }], ['a', 'v']], ['s', 't', ['a'], [{ op: 'insert', values: { g: '1' } }], ['a', 'g'], ['g']], ['s', 't', ['a'], []],
    ['s', 't', ['a'], [{ op: 'upsert', values: {} }]], ['s', 't', ['a'], [{ op: 'insert', values: { a: 5 } }]], ['s', 't', ['2', '1'], [{ op: 'delete', key: { 1: 'x', 2: 'y' } }]],
  ];
  for (const args of PG_FIXED) add('buildEditStatements', ...args);
  add('buildEditStatements', 's', 't', ['id'], Array.from({ length: 5001 }, () => ({ op: 'insert', values: {} })));
  const randomEdit = (names) => {
    const op = pick(['update', 'update', 'insert', 'delete', 'delete', 'bogus']);
    const some = (n) => Array.from({ length: n }, () => pick(names));
    if (op === 'insert') return { op, values: obj(some(Math.floor(r() * 4)), cellValue) };
    const e = { op, key: obj(r() < 0.85 ? editKey : some(1 + Math.floor(r() * 2)), () => (r() < 0.95 ? pick(['7', '1', '\\x00ff', 'x', '-3']) : pick([null, 5]))) };
    if (op === 'update' || op === 'bogus') e.set = obj(some(Math.floor(r() * 3) + (r() < 0.9 ? 1 : 0)), cellValue);
    if (r() < 0.5) e.original = obj(some(Math.floor(r() * 4)), cellValue);
    return e;
  };
  let editKey = ['id'];
  const pgTypes = { id: 'integer', name: 'text', n: 'json', r: 'jsonb', num: 'numeric(10,2)', price: 'character(4)', '0': 'boolean' };
  for (let i = 0; i < 500; i++) {
    editKey = pick([['id'], ['id'], ['name', 'id'], ['rowid'], ['0'], []]);
    const keyCols = r() < 0.1 ? null : editKey;
    const edits = Array.from({ length: Math.floor(r() * 4) + (r() < 0.95 ? 1 : 0) }, () => randomEdit(CELL_NAMES));
    const schema = pick(['s', 'main', 'main', 'shop', '']);
    add('buildEditStatements', schema, 't', keyCols, edits, r() < 0.8 ? CELL_NAMES.slice(0, 12) : undefined, r() < 0.5 ? ['g', 'total'] : [], r() < 0.6 ? pgTypes : undefined);
    add('sqliteEditStatements', schema, 't', keyCols, edits, SQ_COLS, pick([null, 'rowid', '']));
    add('mysqlEditStatements', schema, 'items', keyCols, edits, MY_COLS);
  }
  const SQ_FIXED_COLS = SQ_COLS.slice(0, 4);
  add('sqliteEditStatements', 'main', 't', ['id'], [
    { op: 'update', key: { id: '7' }, set: { name: "O'Hara" }, original: { n: '42', name: null } }, { op: 'insert', values: { name: 'x', n: '\\x0a' } }, { op: 'delete', key: { id: '8' } },
  ], SQ_FIXED_COLS, null);
  add('sqliteEditStatements', 'main', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { g: '1' } }], SQ_FIXED_COLS, null);
  add('sqliteEditStatements', 'main', 't', ['rowid'], [{ op: 'delete', key: { rowid: '3' } }], SQ_FIXED_COLS, 'rowid');
  add('sqliteEditStatements', 'main', 't', ['rowid'], [{ op: 'update', key: { rowid: '3' }, set: { rowid: '4' } }], SQ_FIXED_COLS, 'rowid');
  add('sqliteEditStatements', 'main', 't', ['id'], [{ op: 'update', key: { id: '1' }, set: { n: '1' }, original: { n: '1.5', r: '1e400', num: '\\x00' } }], SQ_COLS, null);
  add('mysqlEditStatements', 'shop', 'items', ['id'], [
    { op: 'update', key: { id: '1' }, set: { name: 'New', raw: '\\x00ff' }, original: { name: 'Old', price: '9.50', ratio: '0.1', raw: null } }, { op: 'delete', key: { id: '2' } },
    { op: 'insert', values: { name: "it's", price: null } }, { op: 'insert', values: {} },
  ], MY_COLS.slice(0, 6));
  // Previews of built statements (the TS answer fed back in).
  const previewOf = (fn, buildFn, args) => {
    try { add(fn, buildFn(...args)); } catch { /* refused: nothing to preview */ }
  };
  for (const args of PG_FIXED) previewOf('editPreview', m.sql.buildEditStatements, args);
  previewOf('sqliteEditPreview', m.sqlite.sqliteEditStatements, ['main', 't', ['id'], [{ op: 'update', key: { id: '7' }, set: { name: "O'Hara" }, original: { n: '42', name: null } }, { op: 'delete', key: { id: '8' } }], SQ_FIXED_COLS, null]);
  previewOf('mysqlEditPreview', m.mysql.mysqlEditStatements, ['shop', 'items', ['id'], [{ op: 'update', key: { id: '1' }, set: { name: 'New', raw: '\\x00ff' }, original: { name: 'Old' } }, { op: 'insert', values: {} }], MY_COLS]);
  for (let i = 0; i < 60; i++) {
    editKey = ['id'];
    const edits = Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomEdit(['id', 'name', 'n', 'r', 'num', 'price', 'raw']));
    previewOf('editPreview', m.sql.buildEditStatements, ['s', 't', ['id'], edits]);
    previewOf('sqliteEditPreview', m.sqlite.sqliteEditStatements, ['main', 't', ['id'], edits, SQ_COLS, null]);
    previewOf('mysqlEditPreview', m.mysql.mysqlEditStatements, ['s', 't', ['id'], edits, MY_COLS]);
  }

  // redactSql on its own.
  for (const s of ["ALTER USER app PASSWORD 'secret'", "ALTER USER app WITH PASSWORD E'a\\'b'", 'ALTER ROLE r PASSWORD $x$a;b$x$', 'ALTER ROLE r PASSWORD $$ab$$ x', "IDENTIFIED   BY 'x' y",
    "identified by 'p''w'", "password = 'a b'", 'password=abc def', 'PASSWORD=x', 'mypassword=x', 'password  =  ', "SET PASSWORD = 'x'", 'host=h password=hunter2 user=u',
    "PASSWORD 'unterminated", "Password\t'x'", 'PASSWORD NULL', "x PASSWORD ''", 'ąPASSWORD \'x\'', "PASSWORD 'ż🙂'"]) add('redactSql', s);
  return { rows, skipped: skipped() };
}

// ── Redis ───────────────────────────────────────────────────────────────────

const REDIS_TOKENS = ['SET', 'set', 'GET', 'k', 'key', 'value', '"a b"', "'c d'", '"x\\ny"', '"\\x68\\x69"', '"\\x00\\xff"', '"\\xc5\\xbc"', '"\\xZZ"', '"\\x6"', "'it\\'s'", "'\\n'",
  '"\\"q\\""', '"\\\\"', '"', "'", '""', "''", 'a"b', "a'b", '"a"b', "'a'b", 'zażółć', '🙂', '\\', '\\x41', '"\\a\\b\\t\\r"', '"\\q"', 'CONFIG', 'config', 'CLIENT', 'KILL',
  'LIST', 'REPLY', 'OFF', 'FLUSHALL', 'XREAD', 'block', 'BLOCK', 'STREAMS', 'MULTI', 'SUBSCRIBE', 'MODULE', 'HELLO', 'GETdel', 'ß', 'ﬀ', 'ǆ', 'İ'];
const WS = [' ', ' ', '  ', '\t', '\n', '\r', '\v', '\f', ' '];

function redisRows(m) {
  const { rows, add, skipped } = collect(m);
  const r = rng(0x7ed15);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const LINES = ['  SET  key   value ', 'SET "a b" \'c d\'', 'SET k "line\\nnext\\t\\"q\\" \\\\"', "SET k 'it\\'s \\n raw'", 'SET k ""', 'SET zażółć 🙂', 'SET k a"b c"',
    'SET k "\\x68\\x69"', 'SET k "\\x00\\xff"', 'SET k "\\xc5\\xbc"', 'SET "abc', "SET 'abc", 'SET "a"b', '   ', '', 'SET k "\\', 'SET k "a\\"', "'\\'", '"\\x"', '"\\xg1"',
    'a b', '"🙂\\x41"', "'🙂'", '"\\xef\\xbb\\xbfx"', '"\\xed\\xa0\\x80"'];
  const lines = [...LINES];
  for (let i = 0; i < 2500; i++) {
    let s = '';
    const n = 1 + Math.floor(r() * 8);
    for (let j = 0; j < n; j++) s += pick(REDIS_TOKENS) + (r() < 0.75 ? pick(WS) : '');
    lines.push(r() < 0.3 ? s.trim() : s);
  }
  for (const line of lines) {
    add('parseRedisCommandLine', line);
    const parsed = m.redis.parseRedisCommandLine(line);
    if (parsed.ok) {
      add('redisCommandName', parsed.argv);
      add('classifyRedisCommand', parsed.argv);
      for (const a of parsed.argv) { add('quoteRedisArg', a); add('redisDataDisplay', a); add('redisDataHex', a); add('redisDataLength', a); add('redisDataKey', a); }
    }
  }
  const COMMANDS = ['FLUSHALL', 'flushdb', 'KEYS *', 'CONFIG SET maxmemory 1', 'config rewrite', 'CONFIG RESETSTAT', 'SHUTDOWN', 'DEBUG SLEEP 1', 'SAVE', 'BGREWRITEAOF', 'REPLICAOF a 1',
    'SLAVEOF NO ONE', 'CLIENT KILL ID 3', 'SCRIPT FLUSH', 'FUNCTION FLUSH', 'MIGRATE h 1 k 0 1', 'MODULE LIST', 'module foo', 'CONFIG GET x', 'CLIENT LIST', 'GET k', 'BLPOP k 0',
    'monitor', 'XREAD BLOCK 0 STREAMS s $', 'XREAD STREAMS s 0', 'xreadgroup group g c block 5 streams s >', 'SUBSCRIBE c', 'psubscribe c*', 'MULTI', 'WATCH k', 'AUTH pw',
    'CLIENT REPLY OFF', 'HELLO 3', 'SET k v', 'SET k v GET', 'SET k GET', 'SET k v EX 1 get', 'TYPE k', 'PING', 'CONFIG', 'client', 'ACL SETUSER x', 'XGROUP CREATE s g $',
    'quit', 'reset', 'READONLY', 'CLIENT NO-EVICT on', 'OBJECT FREQ k', 'SCRIPT LOAD x', 'EVAL x 0', 'PUBLISH c m', 'swapdb 0 1', 'FUNCTION RESTORE x', 'PFMERGE a b'];
  for (const c of COMMANDS) {
    const p = m.redis.parseRedisCommandLine(c);
    if (p.ok) { add('classifyRedisCommand', p.argv); add('redisCommandName', p.argv); }
  }
  for (const argv of [[], [{ b64: 'AP8=' }], [{ b64: 'AP8=' }, 'x'], ['CONFIG', { b64: 'AP8=' }], ['config', 'set', 'x', 'y'], ['get', 'k'], ['SET', 'k', 'v', { b64: 'AP8=' }, 'GET'], ['ß']]) {
    add('classifyRedisCommand', argv);
    add('redisCommandName', argv);
  }
  const DATA = ['', 'a', 'zażółć 🙂', 'a\x00"\\\n\xff', '\r\t\x7f\x1f', { b64: 'AP/D' }, { b64: 'AP8=' }, { b64: btoa('a\x00"\\\n\r\t\xff ~') }, { b64: '' }, { b64: 'YQ' }, { b64: 'Y Q = =' },
    { b64: 'YR==' }, { b64: '*' }, { b64: 'Y' }, { b64: 'YQ=' }, { b64: 'YQ===' }, { b64: 'Y\tQ\n=\f=' }, { b64: 'ab==cd' }, 'plain', 'a b', 'q"x', 'back\\slash', 'nl\nx', 'ż', ' ', '﻿bom'];
  for (const d of DATA) {
    for (const fn of ['redisDataBytes', 'redisDataLength', 'redisDataHex', 'redisDataDisplay', 'redisDataKey', 'quoteRedisArg']) add(fn, d);
    add('redisDataHex', d, ':');
    add('redisDataHex', d, '');
    for (const e of DATA) if (r() < 0.2) add('redisDataEquals', d, e);
    add('redisDataEquals', d, d);
  }
  add('redisDataEquals', 'a', { b64: btoa('a') });
  for (const b of ['', 'AP/D', 'AP8=', 'YQ', 'Y', '====', 'Y Q', '!!!!', 'YWJj', 'YWJ', 'YW==', 'YW=', 'YQ==YQ==']) add('base64ToBytes', b);
  for (const h of ['00 ff c3', '6869', '6', 'zz', '', '  ', 'C5 BC', 'c5\tbc\n', 'efbbbf41', 'ed a0 80', 'f0 9f 99 82', '0x41', '4 1', '41 42']) add('redisDataFromHex', h);
  for (let i = 0; i < 400; i++) {
    const bytes = Uint8Array.from({ length: Math.floor(r() * 12) }, () => (r() < 0.6 ? 0x20 + Math.floor(r() * 0x5f) : Math.floor(r() * 256)));
    add('redisDataFromBytes', bytes);
    add('bytesToBase64', bytes);
    add('redisDataFromHex', hexOf(bytes));
  }
  for (const s of ['zażółć 🙂', '﻿x', '﻿﻿', 'a']) add('redisDataFromBytes', new TextEncoder().encode(s));
  add('redisDataFromBytes', Uint8Array.from([0, 255, 0xc3]));

  const INFOS = ['# Server\r\nredis_version:7.2.4\r\nos:Linux\r\n\r\n# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=500\r\ndb5:keys=1,expires=0,avg_ttl=0\r\n',
    'a:b\nc:d:e\n:x\n#\n#  Named  \nk:\n  spaced key : v \n # hash \nnocolon', '', '\r\n\r\n', '# Keyspace\ndb10:keys=1\ndb2:keys=x,expires=,avg_ttl=1e3\ndb01:keys= 7 ,expires=0x10\ndbx:keys=1\ndb3:keys=1=2,expires\ndb99999999999999999999:keys=1\ndb4:__proto__=1,keys=-5,expires=1.5\n'];
  for (let i = 0; i < 150; i++) {
    const n = 1 + Math.floor(r() * 8);
    const lines = Array.from({ length: n }, () => pick(['# Keyspace', '# Server', '#', '', ' ', `db${pick(['0', '1', '7', '12', '01', 'x', ''])}:${pick(['keys', 'expires', 'avg_ttl', 'k'])}=${pick(['1', '0', '', 'x', '2.5', '-1', '1e3', ' 3 '])},${pick(['expires', 'keys', 'avg_ttl'])}=${pick(['9', '', 'NaN', 'Infinity'])}`, 'k:v', ':v', 'k:', 'redis_version:8.0.0']));
    INFOS.push(lines.join(pick(['\n', '\r\n', '\r'])));
  }
  for (const t of INFOS) {
    add('parseRedisInfo', t);
    add('parseRedisKeyspace', m.redis.parseRedisInfo(t));
  }
  const CLIENTS = ['id=3 addr=127.0.0.1:5000 name=unimux db=0 cmd=client|list\nid=4 addr=x name= db=2\n', '', '\n\n', ' id=1  a=b \r\nx y=z =q w=1=2 __proto__=p\n', 'id=5 id=6',
    ' id=1 ', 'k=v\r\n\r\nk2=v2'];
  for (const t of CLIENTS) add('parseRedisClientList', t);
  for (const id of ['1-2', '1', '5-1', '5-0', '0-0', 'x', '18446744073709551615-18446744073709551615', '18446744073709551616-0', '0-18446744073709551616', '01-02', '-1-2', '1-2-3', '1-', ' 1-2',
    '5-18446744073709551615', '18446744073709551615-0', '99999999999999999999999-1', '٣-1', '1-2\n']) {
    add('isStreamId', id);
    add('streamIdStep', id, 1);
    add('streamIdStep', id, -1);
  }
  return { rows, skipped: skipped() };
}

/** The DB vector files: name -> rows. */
export function dbGoldens(m) {
  const sql = sqlRows(m);
  const redis = redisRows(m);
  return { 'db-sql.jsonl': sql.rows, 'db-redis.jsonl': redis.rows, skipped: sql.skipped + redis.skipped };
}

/** The TS modules the vectors run through (paths from the repo root). */
export const DB_MODULES = { sql: 'src/shared/dbSql.ts', sqlite: 'src/shared/dbSqlite.ts', mysql: 'src/shared/dbMysql.ts', redis: 'src/shared/dbRedis.ts', db: 'src/shared/db.ts', tabs: 'src/shared/dbTabs.ts' };
