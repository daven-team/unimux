// The DB Host with SQLite sessions against real temporary database files (1.0.6): opening (missing file, not a database,
// read-only), the tree (tables, views, indexes, triggers), table info (primary key, rowid, unique keys, foreign keys), pages
// with sort, filter and paging, staged edits (rowid and primary key, conflicts), whole cells, SQL runs (several statements,
// "load more", errors with their position), read-only refusals and the one-run override, transactions, cancel (a row loop and
// a statement stuck in one step), and another connection holding the file's lock.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { dbHarness, waitFor } from './helpers/dbHarness';
import type { DbObjectInfo, DbTableInfo } from '../src/shared/db';
import type { DbOpenConfig } from '../src/shared/dbHostIpc';

const dir = mkdtempSync(join(tmpdir(), 'unimux-sqlite-'));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a worker may still close its file */ } });
let n = 0;
const others: DatabaseSync[] = [];
afterEach(() => { for (const d of others.splice(0)) { try { d.close(); } catch { /* closed */ } } });

/** A new database file with the shop schema. */
function shop(): string {
  const path = join(dir, `shop-${++n}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, score REAL, photo BLOB);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id), total NUMERIC, note TEXT);
    CREATE TABLE notes (body TEXT, n);
    CREATE TABLE tags (a TEXT NOT NULL, b INTEGER NOT NULL, label TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
    CREATE INDEX orders_by_customer ON orders(customer_id);
    CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
    INSERT INTO customers (id, name, email, score, photo) VALUES (1, 'Ala', 'ala@example.com', 1.5, x'00ff'), (2, 'Ola', NULL, NULL, NULL), (3, 'Ela', 'ela@example.com', 0.1, NULL);
    INSERT INTO notes (body, n) VALUES ('first', 1), ('second', '2'), (NULL, 3.5);
    INSERT INTO tags VALUES ('x', 1, 'one'), ('x', 2, 'two');
  `);
  db.exec('BEGIN');
  const ins = db.prepare('INSERT INTO orders (customer_id, total, note) VALUES (?, ?, ?)');
  for (let i = 1; i <= 250; i++) ins.run(i % 2 ? 1 : 3, i, `order ${i}`);
  db.exec('COMMIT');
  db.exec('CREATE TRIGGER orders_touch AFTER INSERT ON orders BEGIN UPDATE customers SET score = coalesce(score, 0) + 1 WHERE id = NEW.customer_id; END;');
  db.close();
  return path;
}
const sq = (path: string, extra: Partial<DbOpenConfig> = {}): Partial<DbOpenConfig> => ({ kind: 'sqlite', host: '', port: 0, user: '', database: 'main', path, tls: 'disable', ...extra });

describe('DbHost SQLite: opening', () => {
  it('opens a file and reports SQLite and its version; a missing file, a folder and a non-database are refused', async () => {
    const h = dbHarness();
    const id = await h.open(sq(shop()));
    expect(h.last(id)).toMatchObject({ phase: 'connected', database: 'main' });
    expect(h.last(id)?.tls).toBeUndefined();
    expect(h.last(id)?.serverVersion).toMatch(/^SQLite 3\.\d+/);
    expect(h.last(await h.open(sq(join(dir, 'missing.sqlite'))))).toMatchObject({ phase: 'error', error: 'dbFileMissing' });
    expect(h.last(await h.open(sq(dir)))).toMatchObject({ phase: 'error', error: 'dbFileMissing' });
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a database, just some text that is long enough to be read as a header '.repeat(20));
    expect(h.last(await h.open(sq(junk)))).toMatchObject({ phase: 'error', error: 'dbNotSqlite' });
    // A missing file is never created by opening it.
    expect(() => new DatabaseSync(join(dir, 'missing.sqlite'), { readOnly: true })).toThrow();
    h.host.close(id);
  });

  it('an empty file is a new, empty database', async () => {
    const path = join(dir, 'empty.sqlite');
    writeFileSync(path, '');
    const h = dbHarness();
    const id = await h.open(sq(path));
    expect(h.last(id)?.phase).toBe('connected');
    expect(await h.value(id, { op: 'objects', schema: 'main' })).toEqual([]);
    const r = await h.run(id, { sql: 'CREATE TABLE t (x); INSERT INTO t VALUES (1); SELECT * FROM t' });
    expect(r.end.ok).toBe(true);
    expect(r.statements[2].rows).toEqual([['1']]);
    h.host.close(id);
  });
});

describe('DbHost SQLite: the tree and table info', () => {
  it('lists tables, views, indexes and triggers of the main database', async () => {
    const h = dbHarness();
    const id = await h.open(sq(shop()));
    expect(await h.value(id, { op: 'databases' })).toMatchObject([{ name: 'main' }]);
    expect(await h.value(id, { op: 'schemas' })).toMatchObject([{ name: 'main', system: false }]);
    const objects = await h.value<DbObjectInfo[]>(id, { op: 'objects', schema: 'main' });
    const by = (name: string) => objects.find((o) => o.name === name);
    expect(objects.map((o) => `${o.kind}:${o.name}`).sort()).toEqual(['index:orders_by_customer', 'table:customers', 'table:notes', 'table:orders', 'table:tags', 'trigger:orders_touch', 'view:big_orders']);
    expect(by('orders_by_customer')?.detail).toBe('ON orders');
    expect(by('orders_touch')?.detail).toBe('ON orders · AFTER INSERT');
    // sqlite_sequence (AUTOINCREMENT) and the automatic indexes of UNIQUE stay out.
    expect(objects.some((o) => o.name.startsWith('sqlite_'))).toBe(false);
    h.host.close(id);
  });

  it('reads columns, keys, indexes and foreign keys; a table without a primary key is keyed by its rowid', async () => {
    const h = dbHarness();
    const id = await h.open(sq(shop()));
    const customers = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'main', name: 'customers' });
    expect(customers.primaryKey).toEqual(['id']);
    expect(customers.editKey).toEqual(['id']);
    expect(customers.columns.map((c) => [c.name, c.typeName, c.kind, c.nullable])).toEqual([
      ['id', 'INTEGER', 'bigint', false], ['name', 'TEXT', 'text', false], ['email', 'TEXT', 'text', true], ['score', 'REAL', 'float', true], ['photo', 'BLOB', 'bytea', true],
    ]);
    expect(customers.columns[0].identity).toBe(true);
    expect(customers.indexes.some((i) => i.unique && i.columns.join() === 'email')).toBe(true);
    const orders = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'main', name: 'orders' });
    expect(orders.constraints.find((c) => c.type === 'f')?.definition).toBe('FOREIGN KEY ("customer_id") REFERENCES "customers" ("id")');
    expect(orders.indexes.find((i) => i.name === 'orders_by_customer')?.definition).toBe('CREATE INDEX orders_by_customer ON orders(customer_id)');
    const notes = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'main', name: 'notes' });
    expect(notes.primaryKey).toBeNull();
    expect(notes.editKey).toEqual(['rowid']);
    expect(notes.columns[0]).toMatchObject({ name: 'rowid', generated: true, identity: true });
    const tags = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'main', name: 'tags' });
    expect(tags.editKey).toEqual(['a', 'b']);
    expect(tags.columns.map((c) => c.name)).toEqual(['a', 'b', 'label']);
    const view = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'main', name: 'big_orders' });
    expect(view).toMatchObject({ kind: 'view', editKey: null });
    expect((await h.op(id, { op: 'tableInfo', schema: 'main', name: 'nope' })).ok).toBe(false);
    h.host.close(id);
  });

  it('shows the DDL of a table (with its indexes and triggers), a view, an index and a trigger', async () => {
    const h = dbHarness();
    const id = await h.open(sq(shop()));
    const table = await h.value<string>(id, { op: 'ddl', schema: 'main', name: 'orders', kind: 'table' });
    expect(table).toContain('CREATE TABLE orders');
    expect(table).toContain('CREATE INDEX orders_by_customer');
    expect(table).toContain('CREATE TRIGGER orders_touch');
    expect(await h.value<string>(id, { op: 'ddl', schema: 'main', name: 'big_orders', kind: 'view' })).toMatch(/^CREATE VIEW big_orders/);
    expect(await h.value<string>(id, { op: 'ddl', schema: 'main', name: 'orders_by_customer', kind: 'index' })).toBe('CREATE INDEX orders_by_customer ON orders(customer_id);\n');
    expect(await h.value<string>(id, { op: 'ddl', schema: 'main', name: 'orders_touch', kind: 'trigger' })).toMatch(/^CREATE TRIGGER orders_touch AFTER INSERT ON orders BEGIN/);
    expect((await h.op(id, { op: 'ddl', schema: 'main', name: 'nope', kind: 'table' })).ok).toBe(false);
    h.host.close(id);
  });
});

describe('DbHost SQLite: table pages and edits', () => {
  it('pages with offset, sorts, filters and says whether more rows follow; values arrive as text', async () => {
    const h = dbHarness();
    const id = await h.open(sq(shop()));
    const first = await h.page(id, { schema: 'main', table: 'orders', limit: 100 });
    expect(first.statements[0].rows).toHaveLength(100);
    expect(first.statements[0].end).toMatchObject({ hasMore: true, rows: 100 });
    expect(first.statements[0].rows[0]).toEqual(['1', '1', '1', 'order 1']);
    const last = await h.page(id, { schema: 'main', table: 'orders', limit: 100, offset: 200 });
    expect(last.statements[0].rows).toHaveLength(50);
    expect(last.statements[0].end?.hasMore).toBe(false);
    const sorted = await h.page(id, { schema: 'main', table: 'orders', limit: 3, sort: [{ column: 'total', desc: true }] });
    expect(sorted.statements[0].rows.map((r) => r[2])).toEqual(['250', '249', '248']);
    const filtered = await h.page(id, { schema: 'main', table: 'orders', limit: 100, filter: "note LIKE '%5'" });
    expect(filtered.statements[0].rows).toHaveLength(25);
    const customers = await h.page(id, { schema: 'main', table: 'customers', limit: 10 });
    expect(customers.statements[0].rows[0]).toEqual(['1', 'Ala', 'ala@example.com', '1.5', '\\x00ff']);
    expect(customers.statements[0].rows[1]).toEqual(['2', 'Ola', null, null, null]);
    // A table keyed by its rowid reads it first.
    const notes = await h.page(id, { schema: 'main', table: 'notes', limit: 10 });
    expect(notes.statements[0].columns.map((c) => c.name)).toEqual(['rowid', 'body', 'n']);
    expect(notes.statements[0].rows).toEqual([['1', 'first', '1'], ['2', 'second', '2'], ['3', null, '3.5']]);
    // A filter cannot write (PRAGMA query_only holds during the page).
    const bad = await h.page(id, { schema: 'main', table: 'orders', limit: 5, filter: 'nope = 1' });
    expect(bad.statements[0].error?.code).toBe('server');
    h.host.close(id);
  });

  it('applies updates, inserts and deletes in one transaction; a row changed meanwhile is a conflict and nothing is saved', async () => {
    const path = shop();
    const h = dbHarness();
    const id = await h.open(sq(path));
    const preview = await h.value<{ sql: string; statements: number }>(id, { op: 'previewEdits', req: { schema: 'main', table: 'customers', edits: [
      { op: 'update', key: { id: '1' }, set: { name: 'Alicja' }, original: { name: 'Ala', score: '1.5' } },
    ] } });
    expect(preview.sql).toBe(`BEGIN;\nUPDATE "main"."customers" SET "name" = 'Alicja' WHERE "id" = 1 AND ("name" IS 'Ala') AND ("score" IS 1.5);\nCOMMIT;`);
    const saved = await h.value<{ affected: number }>(id, { op: 'applyEdits', req: { schema: 'main', table: 'customers', edits: [
      { op: 'update', key: { id: '1' }, set: { name: 'Alicja', photo: '\\x0102' }, original: { name: 'Ala', score: '1.5', photo: '\\x00ff' } },
      { op: 'insert', values: { name: 'Iza', score: '2.25' } },
      { op: 'delete', key: { id: '2' }, original: { email: null } },
    ] } });
    expect(saved.affected).toBe(3);
    const check = new DatabaseSync(path, { readOnly: true });
    others.push(check);
    expect(check.prepare('SELECT id, name, hex(photo) AS photo, score FROM customers ORDER BY id').all()).toEqual([
      { id: 1, name: 'Alicja', photo: '0102', score: 1.5 }, { id: 3, name: 'Ela', photo: '', score: 0.1 }, { id: 4, name: 'Iza', photo: '', score: 2.25 },
    ]);
    // Someone else changed Ela: the stale original is a conflict, the other edit of the same save is rolled back.
    const other = new DatabaseSync(path);
    others.push(other);
    other.exec("UPDATE customers SET name = 'Elżbieta' WHERE id = 3");
    const conflict = await h.op(id, { op: 'applyEdits', req: { schema: 'main', table: 'customers', edits: [
      { op: 'update', key: { id: '1' }, set: { name: 'Ala' } },
      { op: 'update', key: { id: '3' }, set: { score: '9' }, original: { name: 'Ela' } },
    ] } });
    expect(conflict).toMatchObject({ ok: false, error: 'conflict', index: 1 });
    expect(other.prepare('SELECT name FROM customers WHERE id = 1').get()).toEqual({ name: 'Alicja' });
    h.host.close(id);
  });

  it('edits a rowid table (untyped values match in any stored form) and a WITHOUT ROWID table; whole cells read by key', async () => {
    const path = shop();
    const h = dbHarness();
    const id = await h.open(sq(path));
    // "2" was stored as text, 3.5 as a real, 1 as an integer: each loaded text form still matches.
    const r = await h.value<{ affected: number }>(id, { op: 'applyEdits', req: { schema: 'main', table: 'notes', edits: [
      { op: 'update', key: { rowid: '1' }, set: { body: 'one' }, original: { n: '1' } },
      { op: 'update', key: { rowid: '2' }, set: { body: 'two' }, original: { n: '2' } },
      { op: 'delete', key: { rowid: '3' }, original: { n: '3.5', body: null } },
    ] } });
    expect(r.affected).toBe(3);
    expect((await h.op(id, { op: 'applyEdits', req: { schema: 'main', table: 'notes', edits: [{ op: 'update', key: { rowid: '1' }, set: { rowid: '9' } }] } })).ok).toBe(false);
    const t = await h.value<{ affected: number }>(id, { op: 'applyEdits', req: { schema: 'main', table: 'tags', edits: [{ op: 'update', key: { a: 'x', b: '2' }, set: { label: 'dwa' } }] } });
    expect(t.affected).toBe(1);
    const check = new DatabaseSync(path, { readOnly: true });
    others.push(check);
    expect(check.prepare('SELECT rowid, body FROM notes ORDER BY rowid').all()).toEqual([{ rowid: 1, body: 'one' }, { rowid: 2, body: 'two' }]);
    expect(check.prepare("SELECT label FROM tags WHERE b = 2").get()).toEqual({ label: 'dwa' });
    expect(await h.value(id, { op: 'cellValue', req: { schema: 'main', table: 'customers', key: { id: '1' }, column: 'photo' } })).toBe('\\x00ff');
    expect(await h.value(id, { op: 'cellValue', req: { schema: 'main', table: 'notes', key: { rowid: '2' }, column: 'body' } })).toBe('two');
    // A view has no key: it is never edited.
    expect(await h.op(id, { op: 'applyEdits', req: { schema: 'main', table: 'big_orders', edits: [{ op: 'delete', key: { id: '1' } }] } })).toMatchObject({ ok: false, error: 'noKey' });
    h.host.close(id);
  });
});

describe('DbHost SQLite: SQL runs', () => {
  it('runs a script statement by statement: rows, affected counts, a CREATE TRIGGER body, and "load more" of the last read', async () => {
    const h = dbHarness();
    const id = await h.open(sq(shop()));
    const r = await h.run(id, { sql: `UPDATE orders SET note = 'x' WHERE id <= 10;
CREATE TRIGGER t2 BEFORE DELETE ON customers BEGIN SELECT CASE WHEN OLD.id = 1 THEN RAISE(ABORT, 'keep Ala') END; END;
SELECT id, total FROM orders ORDER BY id`, rowCap: 100 });
    expect(r.end.ok).toBe(true);
    expect(r.statements[0].end).toMatchObject({ command: 'UPDATE', rowCount: 10 });
    expect(r.statements[1].end?.command).toBe('CREATE');
    expect(r.statements[2].rows).toHaveLength(100);
    expect(r.statements[2].end).toMatchObject({ hasMore: true, rowCount: null });
    expect(r.statements[2].columns.map((c) => [c.name, c.kind])).toEqual([['id', 'bigint'], ['total', 'numeric']]);
    await h.more(id, r.queryId, 200);
    const all = h.collect(r.queryId).statements[2];
    expect(all.rows).toHaveLength(250);
    expect(all.end).toMatchObject({ hasMore: false, rowCount: 250 });
    // The trigger works: deleting Ala is refused by it.
    const refused = await h.run(id, { sql: 'DELETE FROM customers WHERE id = 1' });
    expect(refused.statements[0].error).toMatchObject({ code: 'server', server: { message: 'keep Ala' } });
    h.host.close(id);
  });

  it('a syntax error names its position; an earlier statement with more rows than the cap is cut, not kept open', async () => {
    const h = dbHarness();
    const id = await h.open(sq(shop()));
    const r = await h.run(id, { sql: 'SELECT *\nFRM orders' });
    expect(r.statements[0].error).toMatchObject({ code: 'server', server: { message: expect.stringContaining('near "FRM": syntax error'), position: 10 } });
    const two = await h.run(id, { sql: 'SELECT * FROM orders; SELECT 1', rowCap: 10 });
    expect(two.statements[0].end).toMatchObject({ rows: 10, hasMore: false, truncated: true });
    expect(two.statements[1].rows).toEqual([['1']]);
    h.host.close(id);
  });

  it('keeps an explicit transaction across runs and reports its state', async () => {
    const path = shop();
    const h = dbHarness();
    const id = await h.open(sq(path));
    expect(await h.value(id, { op: 'transaction', action: 'begin' })).toBe('transaction');
    const r = await h.run(id, { sql: "UPDATE customers SET name = 'tx' WHERE id = 1" });
    expect(r.end.tx).toBe('transaction');
    expect(h.toMain.some((m) => m.t === 'dbTx' && m.id === id && m.tx === 'transaction')).toBe(true);
    expect(await h.value(id, { op: 'transaction', action: 'rollback' })).toBe('idle');
    const check = new DatabaseSync(path, { readOnly: true });
    others.push(check);
    expect(check.prepare('SELECT name FROM customers WHERE id = 1').get()).toEqual({ name: 'Ala' });
    const commit = await h.run(id, { sql: "BEGIN; UPDATE customers SET name = 'c' WHERE id = 1; COMMIT" });
    expect(commit.end).toMatchObject({ ok: true, tx: 'idle' });
    expect(check.prepare('SELECT name FROM customers WHERE id = 1').get()).toEqual({ name: 'c' });
    h.host.close(id);
  });
});

describe('DbHost SQLite: read-only connections', () => {
  it('refuses writes (also PRAGMAs that set something), allows reads, and runs one run with writes when asked', async () => {
    const path = shop();
    const h = dbHarness();
    const id = await h.open(sq(path, { readOnly: true }));
    const refused = await h.run(id, { sql: "SELECT 1; DELETE FROM orders" });
    expect(refused.statements[1].error?.code).toBe('readOnly');
    expect(refused.statements[0]?.rows ?? []).toEqual([]);
    expect((await h.run(id, { sql: 'PRAGMA query_only = 0' })).statements[0].error?.code).toBe('readOnly');
    expect((await h.run(id, { sql: "PRAGMA journal_mode = WAL" })).statements[0].error?.code).toBe('readOnly');
    const reads = await h.run(id, { sql: "PRAGMA table_info('orders'); SELECT count(*) FROM orders; PRAGMA journal_mode" });
    expect(reads.end.ok).toBe(true);
    expect(reads.statements[1].rows).toEqual([['250']]);
    // A write that slips past the client side (a function, a CTE) is refused by SQLite itself.
    const sneaky = await h.run(id, { sql: 'SELECT 1', readWrite: false });
    expect(sneaky.end.ok).toBe(true);
    expect(await h.op(id, { op: 'applyEdits', req: { schema: 'main', table: 'customers', edits: [{ op: 'delete', key: { id: '1' } }] } })).toMatchObject({ ok: false, error: 'readOnly' });
    const once = await h.run(id, { sql: 'DELETE FROM orders WHERE id = 1', readWrite: true });
    expect(once.end.ok).toBe(true);
    expect((await h.run(id, { sql: 'DELETE FROM orders WHERE id = 2' })).statements[0].error?.code).toBe('readOnly');
    const check = new DatabaseSync(path, { readOnly: true });
    others.push(check);
    expect(check.prepare('SELECT count(*) AS n FROM orders').get()).toEqual({ n: 249 });
    h.host.close(id);
  });
});

describe('DbHost SQLite: cancel and locks', () => {
  it('cancels a long row loop at once and the session goes on', async () => {
    const h = dbHarness();
    const id = await h.open(sq(shop()));
    const r = await h.run(id, { sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x % 1000000 = 0', rowCap: 5 }, false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await h.value(id, { op: 'cancel' })).toBe(true);
    await waitFor(() => h.ended(r.queryId), 10000);
    const end = h.collect(r.queryId);
    expect(end.end).toMatchObject({ cancelled: true, ok: false });
    expect((await h.run(id, { sql: 'SELECT 42' })).statements[0].rows).toEqual([['42']]);
    h.host.close(id);
  });

  it('a statement stuck in one step ends with its worker: the file opens again and the transaction is gone', async () => {
    const h = dbHarness({ sqlite: { killGraceMs: 200 } });
    const id = await h.open(sq(shop()));
    await h.run(id, { sql: 'BEGIN; UPDATE customers SET name = \'tx\' WHERE id = 1' });
    // One row only after the whole count: no row loop to stop in.
    const r = await h.run(id, { sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 300000000) SELECT count(*) FROM c' }, false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await h.value(id, { op: 'cancel' })).toBe(true);
    await waitFor(() => h.ended(r.queryId), 10000);
    expect(h.collect(r.queryId).end).toMatchObject({ cancelled: true, tx: 'idle' });
    const after = await h.run(id, { sql: 'SELECT name FROM customers WHERE id = 1' });
    expect(after.statements[0].rows).toEqual([['Ala']]);
    expect(h.last(id)?.phase).toBe('connected');
    h.host.close(id);
  });

  it('another program holding the write lock: a write waits, then reports the file as locked; reads in WAL mode go on', async () => {
    const path = shop();
    const h = dbHarness({ sqlite: { busyMs: 300 } });
    const id = await h.open(sq(path));
    const other = new DatabaseSync(path);
    others.push(other);
    other.exec('BEGIN IMMEDIATE; UPDATE customers SET name = \'locked\' WHERE id = 1');
    const write = await h.run(id, { sql: "UPDATE customers SET name = 'me' WHERE id = 2" });
    expect(write.statements[0].error?.code).toBe('dbLocked');
    const save = await h.op(id, { op: 'applyEdits', req: { schema: 'main', table: 'customers', edits: [{ op: 'update', key: { id: '2' }, set: { name: 'me' } }] } });
    expect(save).toMatchObject({ ok: false, error: 'dbLocked' });
    // Rollback journal: reading still works while the other program only holds RESERVED.
    expect((await h.run(id, { sql: 'SELECT name FROM customers WHERE id = 1' })).statements[0].rows).toEqual([['Ala']]);
    other.exec('ROLLBACK');
    other.exec('PRAGMA journal_mode = WAL');
    other.exec('BEGIN IMMEDIATE; UPDATE customers SET name = \'wal\' WHERE id = 1');
    expect((await h.run(id, { sql: 'SELECT name FROM customers WHERE id = 1' })).statements[0].rows).toEqual([['Ala']]);
    other.exec('COMMIT');
    expect((await h.run(id, { sql: 'SELECT name FROM customers WHERE id = 1' })).statements[0].rows).toEqual([['wal']]);
    h.host.close(id);
  });
});
