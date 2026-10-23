// MySQL / MariaDB sessions against real servers (1.0.5), when there are any: MC_MYSQL_TEST_SERVERS lists them as
// "label=user:password@host:port" separated by commas, e.g.
//   MC_MYSQL_TEST_SERVERS="mysql=root:pw@127.0.0.1:33061,mariadb=root:pw@127.0.0.1:33062"
// (docker run -p 127.0.0.1:33061:3306 -e MYSQL_ROOT_PASSWORD=pw mysql:8.4, and mariadb:11.4 the same). Without it the suite
// is skipped. Each server gets a scratch database unimux_t that the suite drops again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbDatabaseInfo, DbObjectInfo, DbTableInfo } from '../src/shared/db';
import type { DbOpenConfig } from '../src/shared/dbHostIpc';
import { dbHarness, waitFor } from './helpers/dbHarness';
import { startTestServer, type TestServer } from './helpers/sshServer';

interface Target { label: string; user: string; password: string; host: string; port: number }
const targets: Target[] = (process.env.MC_MYSQL_TEST_SERVERS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
  const m = /^([^=]+)=([^:]+):([^@]*)@([^:]+):(\d+)$/.exec(entry);
  if (!m) throw new Error(`bad MC_MYSQL_TEST_SERVERS entry: ${entry}`);
  return { label: m[1], user: m[2], password: m[3], host: m[4], port: Number(m[5]) };
});
const DB = 'unimux_t';
const FIXTURE = `DROP DATABASE IF EXISTS ${DB};
CREATE DATABASE ${DB} CHARACTER SET utf8mb4;
USE ${DB};
CREATE TABLE owners (id INT PRIMARY KEY, label VARCHAR(40) NOT NULL);
CREATE TABLE items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  price DECIMAL(8,2),
  ratio DOUBLE,
  raw VARBINARY(8),
  doc JSON,
  created DATETIME(3),
  big BIGINT UNSIGNED,
  owner INT,
  total DECIMAL(9,2) AS (price * 2) VIRTUAL,
  UNIQUE KEY uq_name (name),
  KEY ix_owner (owner),
  CONSTRAINT fk_owner FOREIGN KEY (owner) REFERENCES owners (id)
) COMMENT 'the items';
INSERT INTO owners VALUES (1, 'Ala'), (2, 'Olek');
INSERT INTO items (name, price, ratio, raw, doc, created, big, owner) VALUES
  ('zażółć', 9.50, 0.1, X'00ff', '{"a": 1}', '2026-01-02 03:04:05.678', 18446744073709551615, 1),
  ('it''s \\\\ back', NULL, NULL, NULL, NULL, NULL, NULL, 2),
  ('Third', 1.00, 2.5, X'01', '[1,2]', '2026-10-23 00:00:00.000', 1, NULL);
CREATE VIEW cheap AS SELECT id, name FROM items WHERE price < 5;
CREATE TABLE nums (n INT PRIMARY KEY);
INSERT INTO nums SELECT n FROM (WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 999) SELECT n FROM s) x;
CREATE PROCEDURE two_sets(IN x INT)
BEGIN
  IF x > 0 THEN SELECT x AS first; END IF;
  SELECT x + 1 AS second;
END;
CREATE FUNCTION twice(x INT) RETURNS INT DETERMINISTIC RETURN x * 2;
CREATE FUNCTION bump() RETURNS INT DETERMINISTIC
BEGIN
  INSERT INTO owners VALUES (99, 'from a function');
  RETURN 1;
END;
CREATE TRIGGER owners_bi BEFORE INSERT ON owners FOR EACH ROW SET NEW.label = TRIM(NEW.label);
CREATE EVENT nightly ON SCHEDULE EVERY 1 DAY DISABLE COMMENT 'cleanup' DO DELETE FROM nums WHERE n < 0`;

describe.skipIf(targets.length > 0)('MySQL protocol against real servers', () => {
  it.skip('needs MC_MYSQL_TEST_SERVERS', () => undefined);
});

describe.skipIf(!targets.length).each(targets)('MySQL protocol against $label', (t) => {
  const base = (extra: Partial<DbOpenConfig> = {}): Partial<DbOpenConfig> => ({ kind: 'mysql', host: t.host, port: t.port, user: t.user, password: t.password, database: DB, tls: 'disable', ...extra });
  const h = dbHarness();
  let id = '';
  let ssh: TestServer | null = null;

  beforeAll(async () => {
    const setup = await h.open(base({ database: '' }));
    expect(h.last(setup)?.phase).toBe('connected');
    const r = await h.run(setup, { sql: FIXTURE });
    const failed = r.statements.find((s) => s.error);
    if (failed) throw new Error(`fixture: ${failed.error?.server?.message ?? failed.error?.code}`);
    h.host.close(setup);
    id = await h.open(base());
  }, 60000);
  afterAll(async () => {
    const tear = await h.open(base({ database: '' }));
    await h.run(tear, { sql: `DROP DATABASE IF EXISTS ${DB}` });
    await h.host.shutdown();
    await ssh?.close();
  }, 60000);

  it('connects and names the flavour', () => {
    const s = h.last(id);
    expect(s).toMatchObject({ phase: 'connected', database: DB });
    expect(s?.serverVersion).toMatch(t.label.toLowerCase().includes('maria') ? /^MariaDB \d+\.\d+/ : /^MySQL \d+\.\d+/);
  });

  it('lists databases and objects, and reads a table with its keys', async () => {
    const dbs = await h.value<DbDatabaseInfo[]>(id, { op: 'databases' });
    expect(dbs.find((d) => d.name === DB)?.system).toBeUndefined();
    expect(dbs.find((d) => d.name === 'information_schema')?.system).toBe(true);
    expect(dbs.findIndex((d) => d.name === DB)).toBeLessThan(dbs.findIndex((d) => d.name === 'information_schema'));
    const objects = await h.value<DbObjectInfo[]>(id, { op: 'objects', schema: DB });
    expect(objects.map((o) => `${o.kind}:${o.name}`).sort()).toEqual(['event:nightly', 'function:bump', 'function:twice', 'procedure:two_sets', 'table:items', 'table:nums', 'table:owners', 'trigger:owners_bi', 'view:cheap']);
    // 1.0.6: a trigger names its timing and table, an event its schedule and state.
    expect(objects.find((o) => o.name === 'owners_bi')?.detail).toBe('BEFORE INSERT ON owners');
    expect(objects.find((o) => o.name === 'nightly')).toMatchObject({ detail: expect.stringMatching(/^EVERY 1 DAY · (DISABLED|SLAVESIDE_DISABLED)$/), comment: 'cleanup' });
    const info = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: DB, name: 'items' });
    expect(info.primaryKey).toEqual(['id']);
    expect(info.editKey).toEqual(['id']);
    expect(info.uniqueKeys).toEqual([['name']]);
    expect(info.comment).toBe('the items');
    const col = (n: string) => info.columns.find((c) => c.name === n)!;
    expect([col('id').identity, col('total').generated, col('created').generated, col('big').kind, col('raw').kind, col('price').kind]).toEqual([true, true, false, 'numeric', 'bytea', 'numeric']);
    expect(info.constraints.find((c) => c.type === 'f')).toMatchObject({ name: 'fk_owner', columns: ['owner'], definition: 'FOREIGN KEY (`owner`) REFERENCES `owners` (`id`)' });
    expect(info.indexes.map((i) => i.name).sort()).toEqual(['PRIMARY', 'ix_owner', 'uq_name']);
    const view = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: DB, name: 'cheap' });
    expect([view.kind, view.editKey]).toEqual(['view', null]);
  });

  it('shows the CREATE statements', async () => {
    expect(await h.value<string>(id, { op: 'ddl', schema: DB, name: 'items', kind: 'table' })).toMatch(/^CREATE TABLE `items`[\s\S]*fk_owner[\s\S]*;\n$/);
    expect(await h.value<string>(id, { op: 'ddl', schema: DB, name: 'cheap', kind: 'view' })).toMatch(/VIEW `cheap`/);
    expect(await h.value<string>(id, { op: 'ddl', schema: DB, name: 'two_sets', kind: 'procedure' })).toMatch(/PROCEDURE `two_sets`/);
    expect(await h.value<string>(id, { op: 'ddl', schema: DB, name: 'owners_bi', kind: 'trigger' })).toMatch(/TRIGGER `?owners_bi`? BEFORE INSERT ON `?owners`? FOR EACH ROW SET NEW\.label = TRIM\(NEW\.label\);\n$/);
    expect(await h.value<string>(id, { op: 'ddl', schema: DB, name: 'nightly', kind: 'event' })).toMatch(/EVENT `nightly` ON SCHEDULE EVERY 1 DAY[\s\S]*DO DELETE FROM nums WHERE n < 0;\n$/);
  });

  it('pages a table as the server writes its values, sorted, filtered and by keyset', async () => {
    const page = await h.page(id, { schema: DB, table: 'items', limit: 2 });
    const s = page.statements[0];
    expect(s.end).toMatchObject({ rows: 2, hasMore: true });
    const names = s.columns.map((c) => c.name);
    const row = Object.fromEntries(names.map((n, i) => [n, s.rows[0][i]]));
    expect(row).toMatchObject({ id: '1', name: 'zażółć', price: '9.50', raw: '\\x00ff', created: '2026-01-02 03:04:05.678', big: '18446744073709551615', total: '19.00' });
    expect(JSON.parse(row.doc as string)).toEqual({ a: 1 });
    expect(s.rows[1][1]).toBe("it's \\ back");
    const sorted = await h.page(id, { schema: DB, table: 'items', limit: 10, sort: [{ column: 'price', desc: true }], filter: "name <> 'Third'" });
    expect(sorted.statements[0].rows.map((r) => r[0])).toEqual(['1', '2']);
    const after = await h.page(id, { schema: DB, table: 'items', limit: 10, after: ['1'] });
    expect(after.statements[0].rows.map((r) => r[0])).toEqual(['2', '3']);
    const bad = await h.page(id, { schema: DB, table: 'items', limit: 10, filter: 'nope = 1' });
    expect(bad.statements[0].error?.code).toBe('server');
    // The filter runs in a READ ONLY transaction.
    const write = await h.page(id, { schema: DB, table: 'items', limit: 10, filter: '(SELECT 1) = 1 AND twice(1) = 2' });
    expect(write.statements[0].error).toBeUndefined();
  });

  it('applies staged edits in one transaction and refuses a row someone else changed', async () => {
    const preview = await h.value<{ sql: string }>(id, { op: 'previewEdits', req: { schema: DB, table: 'items', edits: [{ op: 'update', key: { id: '3' }, set: { name: 'Trzeci' } }] } });
    expect(preview.sql).toBe("START TRANSACTION;\nUPDATE `unimux_t`.`items` SET `name` = 'Trzeci' WHERE `id` = '3';\nCOMMIT;");
    const done = await h.op(id, { op: 'applyEdits', req: { schema: DB, table: 'items', edits: [
      { op: 'update', key: { id: '3' }, set: { name: 'Trzeci', raw: '\\x0a0b', price: '1.00' }, original: { name: 'Third', price: '1.00', ratio: '2.5', raw: '\\x01' } },
      { op: 'insert', values: { name: 'Nowy', price: '3.25', owner: '2' } },
    ] } });
    expect(done).toEqual({ ok: true, value: { affected: 2 } });
    const check = await h.run(id, { sql: "SELECT name, HEX(raw), price FROM items WHERE id = 3 OR name = 'Nowy' ORDER BY id" });
    expect(check.statements[0].rows).toEqual([['Trzeci', '0A0B', '1.00'], ['Nowy', null, '3.25']]);
    // A case-only change by someone else is a conflict: everything is rolled back.
    await h.run(id, { sql: "UPDATE items SET name = 'TRZECI' WHERE id = 3" });
    const stale = await h.op(id, { op: 'applyEdits', req: { schema: DB, table: 'items', edits: [
      { op: 'delete', key: { id: '4' } },
      { op: 'update', key: { id: '3' }, set: { name: 'x' }, original: { name: 'Trzeci' } },
    ] } });
    expect(stale).toMatchObject({ ok: false, error: 'conflict', index: 1 });
    expect((await h.run(id, { sql: 'SELECT COUNT(*) FROM items' })).statements[0].rows).toEqual([['4']]);
    const gen = await h.op(id, { op: 'applyEdits', req: { schema: DB, table: 'items', edits: [{ op: 'update', key: { id: '3' }, set: { total: '1' } }] } });
    expect(gen).toMatchObject({ ok: false, error: 'invalid' });
    expect(await h.value(id, { op: 'cellValue', req: { schema: DB, table: 'items', key: { id: '1' }, column: 'raw' } })).toBe('\\x00ff');
    expect(await h.value(id, { op: 'cellValue', req: { schema: DB, table: 'items', key: { id: '1' }, column: 'name' } })).toBe('zażółć');
  });

  it('runs scripts: procedure bodies without DELIMITER, several result sets, errors and warnings', async () => {
    const r = await h.run(id, { sql: 'SELECT twice(21) AS v; CALL two_sets(1); SELECT * FROM nope; SELECT 1', continueOnError: true });
    expect(r.statements[0].rows).toEqual([['42']]);
    // 1.0.6: every result set of the CALL is a result of its own.
    expect(r.statements[1].rows).toEqual([['1']]);
    expect(r.statements[1].columns.map((c) => c.name)).toEqual(['first']);
    expect(r.statements[2].rows).toEqual([['2']]);
    expect(r.statements[2].columns.map((c) => c.name)).toEqual(['second']);
    expect(h.port.some((m) => m.t === 'statement' && m.queryId === r.queryId && m.index === 2 && m.set === 2)).toBe(true);
    expect(r.statements[3].error?.server?.message).toMatch(/^ERROR 1146 \(42S02\): Table 'unimux_t\.nope' doesn't exist/);
    expect(r.statements[4].rows).toEqual([['1']]);
    // A procedure with one set, and a syntax error placed by its "near ... at line N".
    expect((await h.run(id, { sql: 'CALL two_sets(0)' })).statements.map((x) => x.rows)).toEqual([[['1']]]);
    const typo = await h.run(id, { sql: 'SELECT id FROM\nWHERE' });
    expect(typo.statements[0].error?.server).toMatchObject({ code: '42000', position: 16 });
    const w = await h.run(id, { sql: "INSERT INTO owners VALUES (3, REPEAT('x', 60))" });
    expect(w.statements[0].error?.code).toBe('server');
    const warn = await h.run(id, { sql: "SELECT CAST('12abc' AS SIGNED)" });
    expect(warn.statements[0].rows).toEqual([['12']]);
  });

  it('keeps a big read open for more rows and stops it on the server when something else runs', async () => {
    const r = await h.run(id, { sql: 'SELECT a.n * 1000 + b.n AS v FROM nums a CROSS JOIN nums b ORDER BY v', rowCap: 1000 });
    expect(r.statements[0].end).toMatchObject({ rows: 1000, hasMore: true });
    await h.more(id, r.queryId, 2000);
    const rows = h.collect(r.queryId).statements[0].rows;
    expect(rows.length).toBe(3000);
    expect(rows[2999]).toEqual(['2999']);
    const started = Date.now();
    const next = await h.run(id, { sql: 'SELECT 7' });
    expect(next.statements[0].rows).toEqual([['7']]);
    expect(h.collect(r.queryId).statements[0].closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('cancels a running statement with KILL QUERY and keeps the session', async () => {
    const run = await h.run(id, { sql: 'SELECT SUM(a.n + b.n + c.n) FROM nums a, nums b, nums c WHERE a.n + b.n + c.n >= 0' }, false);
    await new Promise((r) => setTimeout(r, 400));
    expect(await h.op(id, { op: 'cancel' })).toEqual({ ok: true, value: true });
    await waitFor(() => h.ended(run.queryId), 20000);
    const done = h.collect(run.queryId);
    expect(done.end.cancelled).toBe(true);
    expect(done.statements[0].error?.code).toBe('cancelled');
    expect((await h.run(id, { sql: 'SELECT 1' })).statements[0].rows).toEqual([['1']]);
  });

  it('a run with its own statement timeout ends with statementTimeout', async () => {
    const r = await h.run(id, { sql: 'SELECT SUM(a.n + b.n + c.n) FROM nums a, nums b, nums c WHERE a.n + b.n + c.n >= 0', statementTimeoutMs: 300 });
    expect(r.statements[0].error?.code).toBe('statementTimeout');
    expect((await h.run(id, { sql: 'SELECT 1' })).statements[0].rows).toEqual([['1']]);
  });

  it('transactions: the state follows the server, edits wait for the end', async () => {
    expect(await h.value(id, { op: 'transaction', action: 'begin' })).toBe('transaction');
    const ins = await h.run(id, { sql: "INSERT INTO owners VALUES (9, 'tmp')" });
    expect(ins.end.tx).toBe('transaction');
    expect(await h.op(id, { op: 'applyEdits', req: { schema: DB, table: 'owners', edits: [{ op: 'delete', key: { id: '9' } }] } })).toMatchObject({ ok: false, error: 'inTransaction' });
    expect(await h.value(id, { op: 'transaction', action: 'rollback' })).toBe('idle');
    expect((await h.run(id, { sql: 'SELECT COUNT(*) FROM owners WHERE id = 9' })).statements[0].rows).toEqual([['0']]);
  });

  it('a read-only connection refuses writes, also on the server, and allows one run with writes', async () => {
    const ro = await h.open(base({ readOnly: true }));
    expect((await h.run(ro, { sql: "UPDATE owners SET label = 'x'" })).statements[0].error?.code).toBe('readOnly');
    // A function that writes passes the client's check (it is a SELECT) and is stopped by the server's read-only session.
    expect((await h.run(ro, { sql: 'SELECT twice(2)' })).statements[0].rows).toEqual([['4']]);
    expect((await h.run(ro, { sql: 'SELECT bump()' })).statements[0].error?.code).toBe('readOnly');
    expect(await h.op(ro, { op: 'applyEdits', req: { schema: DB, table: 'owners', edits: [{ op: 'delete', key: { id: '1' } }] } })).toMatchObject({ ok: false, error: 'readOnly' });
    const once = await h.run(ro, { sql: "UPDATE owners SET label = 'Ala!' WHERE id = 1", readWrite: true });
    expect(once.statements[0].end?.rowCount).toBe(1);
    // Read-only again afterwards, on the server too.
    expect((await h.run(ro, { sql: 'SELECT bump()' })).statements[0].error?.code).toBe('readOnly');
    expect((await h.run(ro, { sql: 'SELECT COUNT(*) FROM owners WHERE id = 99' })).statements[0].rows).toEqual([['0']]);
    h.host.close(ro);
  });

  it('TLS: require encrypts; verify-full checks the CA and the name', async () => {
    const tls = await h.open(base({ tls: 'require' }));
    expect(h.last(tls)).toMatchObject({ phase: 'connected', tls: true });
    h.host.close(tls);
    const ca = readFileSync(join(__dirname, 'fixtures', 'pg-tls', 'ca.pem'), 'utf8');
    const wrong = await h.open(base({ tls: 'verify-full', ca }));
    expect(h.last(wrong)).toMatchObject({ phase: 'error', error: 'dbTls' });
  });

  it('a wrong password is asked for again; a missing database reads as such', async () => {
    const h2 = dbHarness({ autoPassword: null });
    const bad = await h2.open(base({ password: 'not-it' }));
    expect(h2.last(bad)).toMatchObject({ phase: 'error', error: 'cancelled' });
    expect(h2.toMain.filter((m) => m.t === 'dbPasswordPrompt').map((m) => (m as { retry: boolean }).retry)).toEqual([true]);
    const missing = await h2.open(base({ database: 'no_such_db_here' }));
    expect(h2.last(missing)).toMatchObject({ phase: 'error', error: 'dbNoDatabase' });
    await h2.host.shutdown();
  });

  it('goes through an SSH tunnel', async () => {
    ssh = await startTestServer({ password: 'pw' });
    const h3 = dbHarness({ onMain: (m, host) => {
      if (m.t === 'sshAuthPrompt') { void host.handle({ t: 'sshAuthAnswer', id: m.id, promptId: m.promptId, values: ['pw'] }); return true; }
      return false;
    } });
    const tid = await h3.open(base({ host: 'ignored.example', port: 1, ssh: { dbHost: t.host, dbPort: t.port, tunnelKey: `t-${t.label}`, owner: true } }), undefined, false);
    await h3.host.handle({ t: 'sshConnect', req: { id: tid, host: '127.0.0.1', port: ssh.port, username: 'alice', cols: 80, rows: 24, allowPasswordPrompt: true } });
    await waitFor(() => ['connected', 'error'].includes(h3.last(tid)?.phase ?? ''), 20000);
    expect(h3.last(tid)?.phase).toBe('connected');
    expect((await h3.run(tid, { sql: 'SELECT label FROM owners WHERE id = 2' })).statements[0].rows).toEqual([['Olek']]);
    // KILL QUERY goes through the tunnel too.
    const run = await h3.run(tid, { sql: 'SELECT SUM(a.n + b.n + c.n) FROM nums a, nums b, nums c WHERE a.n + b.n + c.n >= 0' }, false);
    await new Promise((r) => setTimeout(r, 300));
    expect(await h3.op(tid, { op: 'cancel' })).toEqual({ ok: true, value: true });
    await waitFor(() => h3.ended(run.queryId), 20000);
    expect(h3.collect(run.queryId).end.cancelled).toBe(true);
    await h3.host.shutdown();
  });
});
