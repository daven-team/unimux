// The DB Host core against PGlite over the real Postgres wire protocol (1.0.0): connect, metadata, DDL, table pages (paging,
// sort, filter in a READ ONLY transaction), scripts with several results, the row cap with "load more", transactions, staged
// edits with conflict rollback, read-only connections and type round-trips. PGlite is single-user (every connection shares one
// backend), so the read-only tests use a server of their own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_LIMITS, isTruncated, type DbTableInfo, type DbObjectInfo } from '../src/shared/db';
import { parseDbInput } from '../src/shared/dbSql';
import { rowOriginal } from '../src/shared/dbTabs';
import { dbHarness, startPglite, waitFor, type Pglite } from './helpers/dbHarness';

let pgl: Pglite;
beforeAll(async () => {
  pgl = await startPglite();
  await pgl.db.exec(`
    CREATE SCHEMA shop;
    COMMENT ON SCHEMA shop IS 'the shop';
    CREATE TABLE shop.items (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name text NOT NULL DEFAULT 'x',
      code varchar(20) NOT NULL UNIQUE,
      price numeric(12,2),
      total numeric GENERATED ALWAYS AS (price * 2) STORED,
      tags text[],
      meta jsonb,
      CONSTRAINT price_positive CHECK (price >= 0)
    );
    COMMENT ON TABLE shop.items IS 'items for sale';
    COMMENT ON COLUMN shop.items.name IS 'display name';
    CREATE INDEX items_name ON shop.items (name);
    INSERT INTO shop.items (name, code, price) SELECT 'item ' || g, 'C' || lpad(g::text, 4, '0'), g FROM generate_series(1, 250) g;
    CREATE VIEW shop.cheap AS SELECT id, name FROM shop.items WHERE price < 10;
    CREATE MATERIALIZED VIEW shop.stats AS SELECT count(*) AS n FROM shop.items;
    CREATE SEQUENCE shop.counter START 5 INCREMENT 2;
    CREATE FUNCTION shop.double(x integer) RETURNS integer LANGUAGE sql AS $$ SELECT x * 2; $$;
    CREATE FUNCTION shop.double(x numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT x * 2; $$;
    CREATE TABLE shop.nokey (a int, b text);
    INSERT INTO shop.nokey VALUES (1, 'one');
    CREATE TABLE shop.pair (a int NOT NULL, b int NOT NULL, v text, UNIQUE (a, b));
    INSERT INTO shop.pair VALUES (1, 1, 'x'), (1, 2, 'y');
    CREATE TABLE public.types (
      id serial PRIMARY KEY, big bigint, num numeric, j json, jb jsonb, ints int[], texts text[], bin bytea, ts timestamptz, t text, flag boolean, u uuid
    );
    ANALYZE shop.items;
  `);
}, 60000);
afterAll(async () => { await pgl?.close(); });

describe('DbHost on PGlite: connecting', () => {
  it('connects (prefer falls back to plain when the server has no TLS) and reports the server version', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port, tls: 'prefer' });
    expect(h.statuses(id).map((s) => s.phase)).toEqual(['connecting', 'database', 'connected']);
    expect(h.last(id)).toMatchObject({ phase: 'connected', database: 'postgres' });
    expect(h.last(id)?.serverVersion).toMatch(/^\d+/);
    h.host.close(id);
    expect(h.last(id)?.phase).toBe('closed');
    expect(await h.op(id, { op: 'schemas' })).toEqual({ ok: false, error: 'noSession' });
  });

  it('require fails clearly when the server has no TLS; a refused port reads dbRefused', async () => {
    const h = dbHarness();
    const a = await h.open({ port: pgl.port, tls: 'require' });
    expect(h.last(a)).toMatchObject({ phase: 'error', error: 'dbTlsUnsupported' });
    const b = await h.open({ port: 1, tls: 'disable' });
    expect(h.last(b)).toMatchObject({ phase: 'error', error: 'dbRefused' });
  });
});

describe('DbHost on PGlite: metadata and DDL', () => {
  it('lists databases, schemas and the objects of a schema', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const dbs = await h.value<Array<{ name: string; isTemplate: boolean }>>(id, { op: 'databases' });
    expect(dbs.map((d) => d.name)).toContain('postgres');
    expect(dbs.find((d) => d.name === 'template0')?.isTemplate).toBe(true);
    const schemas = await h.value<Array<{ name: string; system: boolean; comment?: string }>>(id, { op: 'schemas' });
    expect(schemas.find((s) => s.name === 'shop')).toMatchObject({ system: false, comment: 'the shop' });
    expect(schemas.find((s) => s.name === 'pg_catalog')?.system).toBe(true);
    const objects = await h.value<DbObjectInfo[]>(id, { op: 'objects', schema: 'shop' });
    const kinds = Object.fromEntries(objects.filter((o) => o.kind !== 'function').map((o) => [o.name, o.kind]));
    expect(kinds).toMatchObject({ items: 'table', cheap: 'view', stats: 'matview', counter: 'sequence', nokey: 'table', items_id_seq: 'sequence' });
    expect(objects.find((o) => o.name === 'items')).toMatchObject({ rowEstimate: 250, comment: 'items for sale' });
    expect(objects.filter((o) => o.name === 'double').map((o) => o.args).sort()).toEqual(['x integer', 'x numeric']);
  });

  it('describes a table: columns with kinds, defaults, identity and generated columns, keys, indexes and constraints', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const info = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'shop', name: 'items' });
    const col = Object.fromEntries(info.columns.map((c) => [c.name, c]));
    expect(col.id).toMatchObject({ kind: 'int', identity: true, nullable: false, typeName: 'integer' });
    expect(col.name).toMatchObject({ kind: 'text', default: "'x'::text", comment: 'display name' });
    expect(col.code).toMatchObject({ typeName: 'character varying(20)', kind: 'text' });
    expect(col.price).toMatchObject({ kind: 'numeric', nullable: true });
    expect(col.total).toMatchObject({ generated: true, default: null });
    expect(col.tags.kind).toBe('array');
    expect(col.meta.kind).toBe('json');
    expect(info.primaryKey).toEqual(['id']);
    expect(info.uniqueKeys).toEqual([['code']]);
    expect(info.editKey).toEqual(['id']);
    expect(info.indexes.map((i) => i.name).sort()).toEqual(['items_code_key', 'items_name', 'items_pkey']);
    expect(info.constraints.find((c) => c.name === 'price_positive')).toMatchObject({ type: 'c', columns: ['price'] });
    const pair = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'shop', name: 'pair' });
    expect(pair.primaryKey).toBeNull();
    expect(pair.editKey).toEqual(['a', 'b']);
    const nokey = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'shop', name: 'nokey' });
    expect(nokey.editKey).toBeNull();
    const view = await h.value<DbTableInfo>(id, { op: 'tableInfo', schema: 'shop', name: 'cheap' });
    expect(view).toMatchObject({ kind: 'view', editKey: null });
    expect(await h.op(id, { op: 'tableInfo', schema: 'shop', name: 'nope' })).toEqual({ ok: false, error: 'notFound' });
  });

  it('rebuilds the DDL of a table, a view, a materialized view, a sequence and an overloaded function', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const table = await h.value<string>(id, { op: 'ddl', schema: 'shop', name: 'items', kind: 'table' });
    expect(table).toContain('CREATE TABLE "shop"."items" (');
    expect(table).toContain('"id" integer GENERATED ALWAYS AS IDENTITY NOT NULL');
    expect(table).toContain(`"name" text DEFAULT 'x'::text NOT NULL`);
    expect(table).toContain('"total" numeric GENERATED ALWAYS AS ((price * (2)::numeric)) STORED');
    expect(table).toContain('CONSTRAINT "items_pkey" PRIMARY KEY (id)');
    expect(table).toContain('CONSTRAINT "items_code_key" UNIQUE (code)');
    expect(table).toContain('CREATE INDEX items_name ON shop.items USING btree (name);');
    expect(table).not.toContain('CREATE UNIQUE INDEX items_code_key');
    expect(table).toContain(`COMMENT ON COLUMN "shop"."items"."name" IS 'display name';`);
    // The DDL runs: a copy in another schema builds.
    await pgl.db.exec('CREATE SCHEMA ddlcheck');
    await pgl.db.exec(table.split('\n').filter((l) => !l.startsWith('CREATE INDEX') && !l.startsWith('COMMENT')).join('\n').replace('"shop"."items"', '"ddlcheck"."items"'));
    expect(await h.value<string>(id, { op: 'ddl', schema: 'shop', name: 'cheap', kind: 'view' })).toMatch(/^CREATE OR REPLACE VIEW "shop"\."cheap" AS\nSELECT id,\n    name\n   FROM shop\.items\n  WHERE price < 10::numeric;$/);
    expect(await h.value<string>(id, { op: 'ddl', schema: 'shop', name: 'stats', kind: 'matview' })).toContain('CREATE MATERIALIZED VIEW "shop"."stats" AS');
    expect(await h.value<string>(id, { op: 'ddl', schema: 'shop', name: 'counter', kind: 'sequence' })).toContain('START WITH 5');
    const fn = await h.value<string>(id, { op: 'ddl', schema: 'shop', name: 'double', kind: 'function', args: 'x numeric' });
    expect(fn).toContain('CREATE OR REPLACE FUNCTION shop.double(x numeric)');
    expect(await h.op(id, { op: 'ddl', schema: 'shop', name: 'double', kind: 'function', args: 'x text' })).toEqual({ ok: false, error: 'notFound' });
  });
});

describe('DbHost on PGlite: table pages', () => {
  it('pages by offset and by key, sorts, filters, and reports whether more rows follow', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const first = await h.page(id, { schema: 'shop', table: 'items', limit: 100 });
    const s0 = first.statements[0];
    expect(s0.rows).toHaveLength(100);
    expect(s0.end).toMatchObject({ hasMore: true, rows: 100 });
    expect(s0.rows[0][0]).toBe('1');
    expect(s0.columns.map((c) => c.name)).toEqual(['id', 'name', 'code', 'price', 'total', 'tags', 'meta']);
    expect(first.end).toMatchObject({ ok: true, tx: 'idle' });
    const last = await h.page(id, { schema: 'shop', table: 'items', limit: 100, offset: 200 });
    expect(last.statements[0].rows).toHaveLength(50);
    expect(last.statements[0].end?.hasMore).toBe(false);
    const keyset = await h.page(id, { schema: 'shop', table: 'items', limit: 10, after: ['100'] });
    expect(keyset.statements[0].rows.map((r) => r[0])).toEqual(['101', '102', '103', '104', '105', '106', '107', '108', '109', '110']);
    const sorted = await h.page(id, { schema: 'shop', table: 'items', limit: 3, sort: [{ column: 'price', desc: true }] });
    expect(sorted.statements[0].rows.map((r) => r[3])).toEqual(['250.00', '249.00', '248.00']);
    const filtered = await h.page(id, { schema: 'shop', table: 'items', limit: 100, filter: "code LIKE 'C000%' -- the first nine" });
    expect(filtered.statements[0].rows).toHaveLength(9);
    expect(filtered.statements[0].end?.hasMore).toBe(false);
  });

  it('runs the filter in a READ ONLY transaction: a filter cannot change data', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const r = await h.page(id, { schema: 'shop', table: 'items', limit: 5, filter: "nextval('shop.counter') > 0" });
    expect(r.statements[0].error).toMatchObject({ code: 'readOnly', server: { code: '25006' } });
    expect(r.end.ok).toBe(false);
    const sneaky = await h.page(id, { schema: 'shop', table: 'items', limit: 5, filter: '1 = 1); DELETE FROM shop.items; SELECT (1' });
    expect(sneaky.statements[0].error?.code).toBe('server');
    expect((await pgl.db.query<{ n: number }>('SELECT count(*)::int AS n FROM shop.items')).rows[0].n).toBe(250);
    const bad = await h.page(id, { schema: 'shop', table: 'items', limit: 5, filter: 'nonsense' });
    expect(bad.statements[0].error).toMatchObject({ code: 'server', server: { code: '42703' } });
    // The session is usable afterwards (the failed transaction was rolled back).
    expect((await h.page(id, { schema: 'shop', table: 'items', limit: 1 })).end.ok).toBe(true);
  });
});

describe('DbHost on PGlite: queries', () => {
  it('splits a script, runs every statement and reports each result, command, row count and its place in the text', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const sql = `CREATE TABLE q1 (id int primary key, body text);
INSERT INTO q1 VALUES (1, 'a;b'), (2, $$c;d$$);
-- a comment; with a semicolon
SELECT * FROM q1 ORDER BY id;
SELECT count(*) AS n FROM q1;
CREATE FUNCTION q1f() RETURNS int LANGUAGE plpgsql AS $body$ BEGIN RETURN 1; END; $body$;`;
    const r = await h.run(id, { sql });
    expect(r.end).toMatchObject({ ok: true, cancelled: false, tx: 'idle' });
    expect(r.statements.map((s) => s.end?.command)).toEqual(['CREATE', 'INSERT', 'SELECT', 'SELECT', 'CREATE']);
    expect(r.statements[1].end?.rowCount).toBe(2);
    expect(r.statements[2].rows).toEqual([['1', 'a;b'], ['2', 'c;d']]);
    expect(r.statements[3].rows).toEqual([['2']]);
    expect(r.statements[3].columns[0]).toMatchObject({ name: 'n', kind: 'bigint', typeName: 'bigint' });
    expect(sql.slice(r.statements[2].span!.start, r.statements[2].span!.end)).toBe('SELECT * FROM q1 ORDER BY id');
  });

  it('stops at the first error (or goes on when asked) and keeps the server message and position', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const r = await h.run(id, { sql: 'SELECT 1; SELECT nope FROM nowhere; SELECT 3' });
    expect(r.end.ok).toBe(false);
    expect(r.statements).toHaveLength(2);
    expect(r.statements[1].error).toMatchObject({ code: 'server', server: { code: '42P01', position: 18 } });
    const go = await h.run(id, { sql: 'SELECT 1; SELECT nope FROM nowhere; SELECT 3', continueOnError: true });
    expect(go.statements).toHaveLength(3);
    expect(go.statements[2].rows).toEqual([['3']]);
  });

  it('caps rows, loads more through the open cursor, and closes a cursor another operation needs', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const r = await h.run(id, { sql: 'SELECT g FROM generate_series(1, 2500) g', rowCap: 1000 });
    expect(r.statements[0].rows).toHaveLength(1000);
    expect(r.statements[0].end).toMatchObject({ hasMore: true, rows: 1000, rowCount: null });
    await h.more(id, r.queryId, 1000);
    let c = h.collect(r.queryId).statements[0];
    expect(c.rows).toHaveLength(2000);
    expect(c.end).toMatchObject({ hasMore: true, rows: 2000 });
    await h.more(id, r.queryId, 1000);
    c = h.collect(r.queryId).statements[0];
    expect(c.rows).toHaveLength(2500);
    expect(c.rows.at(-1)).toEqual(['2500']);
    expect(c.end).toMatchObject({ hasMore: false, rows: 2500, rowCount: 2500, command: 'SELECT' });
    expect(await h.op(id, { op: 'fetchMore', queryId: r.queryId, count: 10 })).toEqual({ ok: false, error: 'notFound' });
    // An open cursor is closed when the next operation needs the connection.
    const open = await h.run(id, { sql: 'SELECT g FROM generate_series(1, 50) g', rowCap: 10 });
    expect(open.statements[0].end?.hasMore).toBe(true);
    expect((await h.value<unknown[]>(id, { op: 'schemas' })).length).toBeGreaterThan(0);
    expect(h.collect(open.queryId).statements[0].closed).toBe(true);
    // A statement before the last one cannot keep its cursor.
    const two = await h.run(id, { sql: 'SELECT g FROM generate_series(1, 50) g; SELECT 2', rowCap: 10 });
    expect(two.statements[0]).toMatchObject({ closed: false, end: { hasMore: false, truncated: true, rows: 10 } });
    expect(two.statements[1].rows).toEqual([['2']]);
  });

  it('runs an explicit transaction: BEGIN, a failed statement, ROLLBACK; table pages wait until it ends', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    await h.run(id, { sql: 'CREATE TABLE tx1 (id int primary key)' });
    expect(await h.value(id, { op: 'transaction', action: 'begin' })).toBe('transaction');
    await h.run(id, { sql: 'INSERT INTO tx1 VALUES (1)' });
    expect(h.toMain.filter((m) => m.t === 'dbTx' && m.id === id).map((m) => (m as { tx: string }).tx)).toContain('transaction');
    const page = await h.page(id, { schema: 'public', table: 'tx1', limit: 10 });
    expect(page.statements[0].error?.code).toBe('inTransaction');
    const failed = await h.run(id, { sql: 'INSERT INTO tx1 VALUES (1)' });
    expect(failed.end.tx).toBe('failed');
    expect(await h.value(id, { op: 'transaction', action: 'rollback' })).toBe('idle');
    const after = await h.run(id, { sql: 'SELECT count(*) FROM tx1' });
    expect(after.statements[0].rows).toEqual([['0']]);
  });
});

describe('DbHost on PGlite: staged edits', () => {
  it('previews and applies updates, inserts and deletes in one transaction by the primary key', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    await h.run(id, { sql: "CREATE TABLE e1 (id int primary key, name text, n int); INSERT INTO e1 VALUES (1, 'a', 1), (2, 'b', 2), (3, 'c', 3)" });
    const req = { schema: 'public', table: 'e1', edits: [
      { op: 'update' as const, key: { id: '1' }, set: { name: "it's", n: null } },
      { op: 'insert' as const, values: { id: '4', name: 'd' } },
      { op: 'delete' as const, key: { id: '3' } },
    ] };
    const preview = await h.value<{ sql: string; statements: number }>(id, { op: 'previewEdits', req });
    expect(preview).toEqual({ statements: 3, sql: [
      'BEGIN;',
      `UPDATE "public"."e1" SET "name" = 'it''s', "n" = NULL WHERE "id" = '1';`,
      `INSERT INTO "public"."e1" ("id", "name") VALUES ('4', 'd');`,
      `DELETE FROM "public"."e1" WHERE "id" = '3';`,
      'COMMIT;',
    ].join('\n') });
    expect(await h.value(id, { op: 'applyEdits', req })).toEqual({ affected: 3 });
    const rows = (await h.run(id, { sql: 'SELECT id, name, n FROM e1 ORDER BY id' })).statements[0].rows;
    expect(rows).toEqual([['1', "it's", null], ['2', 'b', '2'], ['4', 'd', null]]);
  });

  it('rolls everything back when a row changed meanwhile (0 rows) or the server refuses one, and names the edit', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    await h.run(id, { sql: "CREATE TABLE e2 (id int primary key, name text unique); INSERT INTO e2 VALUES (1, 'a'), (2, 'b')" });
    const conflict = await h.op(id, { op: 'applyEdits', req: { schema: 'public', table: 'e2', edits: [
      { op: 'insert', values: { id: '3', name: 'c' } },
      { op: 'update', key: { id: '99' }, set: { name: 'z' } },
    ] } });
    expect(conflict).toEqual({ ok: false, error: 'conflict', index: 1 });
    const refused = await h.op(id, { op: 'applyEdits', req: { schema: 'public', table: 'e2', edits: [
      { op: 'update', key: { id: '1' }, set: { name: 'x' } },
      { op: 'update', key: { id: '2' }, set: { name: 'x' } },
    ] } });
    expect(refused).toMatchObject({ ok: false, error: 'server', index: 1, server: { code: '23505' } });
    const rows = (await h.run(id, { sql: 'SELECT id, name FROM e2 ORDER BY id' })).statements[0].rows;
    expect(rows).toEqual([['1', 'a'], ['2', 'b']]);
    expect(h.collect((await h.run(id, { sql: 'SELECT 1' })).queryId).end.tx).toBe('idle');
  });

  it('refuses tables without a key, unknown or generated columns, and keys that are not the table key', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    expect(await h.op(id, { op: 'applyEdits', req: { schema: 'shop', table: 'nokey', edits: [{ op: 'delete', key: { a: '1' } }] } })).toEqual({ ok: false, error: 'noKey' });
    // An insert needs no key.
    expect(await h.value(id, { op: 'applyEdits', req: { schema: 'shop', table: 'nokey', edits: [{ op: 'insert', values: { a: '2', b: 'two' } }] } })).toEqual({ affected: 1 });
    expect(await h.op(id, { op: 'applyEdits', req: { schema: 'shop', table: 'items', edits: [{ op: 'update', key: { id: '1' }, set: { total: '5' } }] } })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.op(id, { op: 'applyEdits', req: { schema: 'shop', table: 'items', edits: [{ op: 'update', key: { id: '1' }, set: { nope: '5' } }] } })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.op(id, { op: 'applyEdits', req: { schema: 'shop', table: 'items', edits: [{ op: 'delete', key: { code: 'C0001' } }] } })).toEqual({ ok: false, error: 'invalid' });
    // A composite unique key identifies rows of a table without a primary key.
    expect(await h.value(id, { op: 'applyEdits', req: { schema: 'shop', table: 'pair', edits: [{ op: 'update', key: { a: '1', b: '2' }, set: { v: 'z' } }] } })).toEqual({ affected: 1 });
  });

  it('round-trips values of every kind exactly, NULL apart from the empty string, and truncates big values', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const input: Record<string, string | null> = {
      id: '1', big: '9223372036854775807', num: '12345678901234567890.123456789', j: '{"a": [1, 2.50, "x"]}', jb: '{"b": {"c": null}}',
      ints: '{1,2,NULL}', texts: '{"a b","c\\"d",NULL}', bin: '\\x00ff10', ts: '2026-10-19 12:34:56.789+00', t: '', flag: 't', u: '6f1d9a2e-4c1b-4c5e-9b7a-2a3b4c5d6e7f',
    };
    for (const [k, v] of Object.entries(input)) if (v !== null && k !== 'id') expect(parseDbInput(k === 'big' ? 'bigint' : 'text', v).ok).toBe(true);
    expect(await h.value(id, { op: 'applyEdits', req: { schema: 'public', table: 'types', edits: [{ op: 'insert', values: input }, { op: 'insert', values: { id: '2', t: null } }] } })).toEqual({ affected: 2 });
    await h.run(id, { sql: "SET TimeZone = 'UTC'" });
    const page = await h.page(id, { schema: 'public', table: 'types', limit: 10 });
    const cols = page.statements[0].columns;
    const row = Object.fromEntries(cols.map((c, i) => [c.name, page.statements[0].rows[0][i]]));
    expect(row).toEqual({ ...input, jb: '{"b": {"c": null}}', ints: '{1,2,NULL}', texts: '{"a b","c\\"d",NULL}', ts: '2026-10-19 12:34:56.789+00' });
    expect(Object.fromEntries(cols.map((c) => [c.name, c.kind]))).toMatchObject({ big: 'bigint', num: 'numeric', j: 'json', jb: 'json', ints: 'array', texts: 'array', bin: 'bytea', ts: 'timestamptz', t: 'text', flag: 'bool', u: 'uuid' });
    const second = page.statements[0].rows[1];
    expect(second[cols.findIndex((c) => c.name === 't')]).toBeNull();
    expect(row.t).toBe('');
    // A value above the cell limit arrives cut, with its length; cellValue reads it whole.
    const long = 'x'.repeat(DB_LIMITS.cellChars + 10);
    await h.value(id, { op: 'applyEdits', req: { schema: 'public', table: 'types', edits: [{ op: 'update', key: { id: '2' }, set: { t: long } }] } });
    const big = (await h.page(id, { schema: 'public', table: 'types', limit: 10, filter: 'id = 2' })).statements[0];
    const cell = big.rows[0][big.columns.findIndex((c) => c.name === 't')];
    expect(isTruncated(cell) && cell.chars).toBe(long.length);
    expect(await h.value(id, { op: 'cellValue', req: { schema: 'public', table: 'types', key: { id: '2' }, column: 't' } })).toBe(long);
    expect(await h.op(id, { op: 'cellValue', req: { schema: 'public', table: 'types', key: { id: '77' }, column: 't' } })).toEqual({ ok: false, error: 'notFound' });
    await h.run(id, { sql: 'RESET TimeZone' });
  });
});

describe('DbHost on PGlite: read-only connections', () => {
  let ro: Pglite;
  beforeAll(async () => { ro = await startPglite(); await ro.db.exec('CREATE TABLE r (id int primary key, v text); INSERT INTO r VALUES (1, \'a\')'); }, 60000);
  afterAll(async () => { await ro?.close(); });

  it('refuses writes and edits, browses, and lets one run write with the explicit override', async () => {
    const h = dbHarness();
    const id = await h.open({ port: ro.port, readOnly: true });
    const write = await h.run(id, { sql: "SELECT 1; INSERT INTO r VALUES (2, 'b')" });
    // Refused before anything runs: the error names the statement, nothing reached the server.
    expect(write.statements).toHaveLength(2);
    expect(write.statements[1].error).toEqual({ code: 'readOnly' });
    expect(write.statements[0]).toBeUndefined();
    expect(await h.op(id, { op: 'applyEdits', req: { schema: 'public', table: 'r', edits: [{ op: 'delete', key: { id: '1' } }] } })).toEqual({ ok: false, error: 'readOnly' });
    expect((await h.page(id, { schema: 'public', table: 'r', limit: 10 })).statements[0].rows).toEqual([['1', 'a']]);
    const override = await h.run(id, { sql: "INSERT INTO r VALUES (2, 'b')", readWrite: true });
    expect(override.end.ok).toBe(true);
    // Read-only again right after.
    expect((await h.run(id, { sql: 'DELETE FROM r' })).statements[0].error?.code).toBe('readOnly');
    expect((await h.run(id, { sql: 'SELECT count(*) FROM r' })).statements[0].rows).toEqual([['2']]);
    h.host.close(id);
    await ro.db.exec('SET default_transaction_read_only = off');
  });
});

describe('DbHost on PGlite: read-only cannot be switched off (fix round 1)', () => {
  let ro: Pglite;
  beforeAll(async () => { ro = await startPglite(); await ro.db.exec("CREATE TABLE r (id int primary key, v text); INSERT INTO r VALUES (1, 'a'); CREATE FUNCTION wipe() RETURNS int LANGUAGE sql AS $$ DELETE FROM r RETURNING 1 $$;"); }, 60000);
  afterAll(async () => { await ro?.close(); });
  const count = async () => (await ro.db.query<{ n: number }>('SELECT count(*)::int AS n FROM r')).rows[0].n;

  it('refuses SET, RESET, DISCARD, READ WRITE transactions and set_config before anything runs', async () => {
    const h = dbHarness();
    const id = await h.open({ port: ro.port, readOnly: true });
    for (const sql of ["BEGIN READ WRITE; INSERT INTO r VALUES (5, 'x'); COMMIT", 'SET default_transaction_read_only = off', 'RESET ALL', 'DISCARD ALL',
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', "SELECT set_config('default_transaction_read_only', 'off', false)", 'START TRANSACTION READ WRITE']) {
      const r = await h.run(id, { sql });
      expect(r.end.ok, sql).toBe(false);
      expect(r.statements.find(Boolean)?.error?.code, sql).toBe('readOnly');
    }
    // A function a SELECT calls is refused by the server's read-only transaction.
    expect((await h.run(id, { sql: 'SELECT wipe()' })).statements[0].error?.code).toBe('readOnly');
    expect(await count()).toBe(1);
    expect(h.last(id)?.phase).toBe('connected');
    h.host.close(id);
  });

  it('after an override run that failed inside its transaction and a ROLLBACK, a plain DELETE is still refused', async () => {
    const h = dbHarness();
    const id = await h.open({ port: ro.port, readOnly: true });
    const over = await h.run(id, { sql: "BEGIN; INSERT INTO r VALUES (1, 'dup')", readWrite: true });
    expect(over.end.tx).toBe('failed');
    // Inside the override's transaction only ending it runs without the override.
    expect((await h.run(id, { sql: 'SELECT 1' })).statements.find(Boolean)?.error?.code).toBe('inTransaction');
    expect((await h.run(id, { sql: 'ROLLBACK' })).end).toMatchObject({ ok: true, tx: 'idle' });
    expect((await h.run(id, { sql: 'DELETE FROM r' })).statements.find(Boolean)?.error?.code).toBe('readOnly');
    expect((await h.run(id, { sql: 'SHOW default_transaction_read_only' })).statements[0].rows).toEqual([['on']]);
    // An override that committed restores read-only right after.
    expect((await h.run(id, { sql: "INSERT INTO r VALUES (2, 'b')", readWrite: true })).end.ok).toBe(true);
    expect((await h.run(id, { sql: 'SHOW default_transaction_read_only' })).statements[0].rows).toEqual([['on']]);
    expect(await count()).toBe(2);
    h.host.close(id);
    await ro.db.exec('SET default_transaction_read_only = off');
    await ro.db.exec('DELETE FROM r WHERE id = 2');
  });

  it('a page filter that switches read-only off with set_config is undone after the page', async () => {
    const h = dbHarness();
    const id = await h.open({ port: ro.port, readOnly: true });
    await h.page(id, { schema: 'public', table: 'r', limit: 5, filter: "set_config('default_transaction_read_only', 'off', false) IS NOT NULL" });
    expect((await h.run(id, { sql: 'SHOW default_transaction_read_only' })).statements[0].rows).toEqual([['on']]);
    h.host.close(id);
    await ro.db.exec('SET default_transaction_read_only = off');
  });
});

describe('DbHost on PGlite: cursors, memory and busy (fix round 1)', () => {
  it('reads data-changing statements up to the cap and commits them at once (truncated, no open cursor)', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    await h.run(id, { sql: 'CREATE TABLE ret (id int)' });
    const r = await h.run(id, { sql: 'INSERT INTO ret SELECT g FROM generate_series(1, 50) g RETURNING id', rowCap: 10 });
    expect(r.statements[0].rows).toHaveLength(10);
    expect(r.statements[0].end).toMatchObject({ hasMore: false, truncated: true });
    expect(r.end.tx).toBe('idle');
    expect(await h.op(id, { op: 'fetchMore', queryId: r.queryId, count: 10 })).toEqual({ ok: false, error: 'notFound' });
    expect((await pgl.db.query<{ n: number }>('SELECT count(*)::int AS n FROM ret')).rows[0].n).toBe(50);
  });

  it('stops a read at the character budget for very wide rows and loads the rest later', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const r = await h.run(id, { sql: `SELECT g, repeat('x', ${DB_LIMITS.cellChars}) FROM generate_series(1, 600) g`, rowCap: 1000 });
    const first = r.statements[0].rows.length;
    expect(first).toBeLessThan(600);
    expect(first * DB_LIMITS.cellChars).toBeGreaterThanOrEqual(DB_LIMITS.pageChars);
    expect(r.statements[0].end?.hasMore).toBe(true);
    const chunks = h.port.filter((m) => m.t === 'rows' && m.queryId === r.queryId);
    expect(chunks.length).toBeGreaterThan(10);
    await h.more(id, r.queryId, 1000);
    expect(h.collect(r.queryId).statements[0].rows).toHaveLength(600);
  });

  it('closes a result cursor nobody fetched from after the idle time', async () => {
    const h = dbHarness({ timers: { cursorIdleMs: 150 } });
    const id = await h.open({ port: pgl.port });
    const r = await h.run(id, { sql: 'SELECT g FROM generate_series(1, 50) g', rowCap: 10 });
    expect(r.statements[0].end?.hasMore).toBe(true);
    await waitFor(() => h.port.some((m) => m.t === 'resultClosed' && m.queryId === r.queryId), 3000);
    expect(await h.op(id, { op: 'fetchMore', queryId: r.queryId, count: 10 })).toEqual({ ok: false, error: 'notFound' });
  });

  it('answers metadata with busy while a run is in flight', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    const slow = await h.run(id, { sql: 'SELECT pg_sleep(0.5)' }, false);
    expect(await h.op(id, { op: 'schemas' })).toEqual({ ok: false, error: 'busy' });
    await waitFor(() => h.ended(slow.queryId), 5000);
    expect((await h.op(id, { op: 'schemas' })).ok).toBe(true);
  });

  it('a row changed since it was loaded is a conflict when the loaded values are sent', async () => {
    const h = dbHarness();
    const id = await h.open({ port: pgl.port });
    await h.run(id, { sql: `CREATE TABLE oc (id int primary key, v text, j json); INSERT INTO oc VALUES (1, 'a', '{"x":1}')` });
    await pgl.db.exec("UPDATE oc SET v = 'changed elsewhere'");
    expect(await h.op(id, { op: 'applyEdits', req: { schema: 'public', table: 'oc', edits: [{ op: 'update', key: { id: '1' }, set: { v: 'mine' }, original: { v: 'a' } }] } })).toEqual({ ok: false, error: 'conflict', index: 0 });
    expect(await h.value(id, { op: 'applyEdits', req: { schema: 'public', table: 'oc', edits: [{ op: 'update', key: { id: '1' }, set: { v: 'mine' }, original: { v: 'changed elsewhere', j: '{"x":1}' } }] } })).toEqual({ affected: 1 });
  });
});

describe('DbHost on PGlite: a failing page filter keeps the shared session (core fix)', () => {
  // A server of its own: the read-only variants change session settings, and PGlite shares one backend between connections.
  let own: Pglite;
  beforeAll(async () => {
    own = await startPglite();
    await own.db.exec(`CREATE TABLE f (id int PRIMARY KEY, price numeric(10,2)); INSERT INTO f SELECT g, g FROM generate_series(1, 20) g;`);
  }, 60000);
  afterAll(async () => { await own?.close(); });

  const variants: Array<{ name: string; cfg: { readOnly?: boolean; statementTimeoutMs?: number } }> = [
    { name: 'read-write', cfg: {} },
    { name: 'read-write with a statement timeout', cfg: { statementTimeoutMs: 30000 } },
    { name: 'read-only', cfg: { readOnly: true } },
    { name: 'read-only with a statement timeout', cfg: { readOnly: true, statementTimeoutMs: 30000 } },
  ];
  for (const variant of variants) {
    it(`answers a query error with the server message, rolls back and the next page works (${variant.name})`, async () => {
      const h = dbHarness();
      const id = await h.open({ port: own.port, ...variant.cfg });
      expect(h.last(id)?.phase).toBe('connected');
      const statusesBefore = h.statuses(id).length;
      for (const filter of ['no_such_column = 1', 'nonsense', '1/0 = 1', "price > 'abc'", 'id = (SELECT id FROM f)']) {
        const bad = await h.page(id, { schema: 'public', table: 'f', limit: 5, filter });
        expect(bad.statements[0].error?.code, filter).toBe('server');
        expect(bad.statements[0].error?.server?.message, filter).toBeTruthy();
        expect(bad.end, filter).toMatchObject({ ok: false, tx: 'idle' });
        expect(h.last(id)?.phase, filter).toBe('connected');
        const next = await h.page(id, { schema: 'public', table: 'f', limit: 3 });
        expect(next.end.ok, filter).toBe(true);
        expect(next.statements[0].rows, filter).toHaveLength(3);
      }
      // No reconnect, no new status: the same session answered everything.
      expect(h.statuses(id).length).toBe(statusesBefore);
      const show = async (name: string) => (await h.run(id, { sql: `SHOW ${name}` })).statements[0].rows[0][0];
      expect(await show('default_transaction_read_only')).toBe(variant.cfg.readOnly ? 'on' : 'off');
      if (variant.cfg.statementTimeoutMs) expect(await show('statement_timeout')).toBe('30s');
      expect((await h.op(id, { op: 'schemas' })).ok).toBe(true);
      h.host.close(id);
      await own.db.exec('RESET ALL');
    });
  }
});

describe('DbHost on PGlite: the conflict check compares in each column\'s own type (core fix)', () => {
  let own: Pglite;
  const ROW = (id: number) => `(${id}, true, 1.5, '2026-10-20 12:34:56.789+02', '{"b": 2,  "a": [1, 2]}', '{"b": 2, "a": 1}', '{1,2,NULL}',
    '\\x00ff10', '1 day 02:03:04', 0.1, 'ab', '10.0.0.1', '10.0.0.0/8', '{"a b",NULL,c}', NULL, '3.141592653589793', 'x')`;
  beforeAll(async () => {
    own = await startPglite();
    await own.db.exec(`CREATE TABLE ty (
      id int PRIMARY KEY, flag boolean, price numeric(10,2), at timestamptz, j json, jb jsonb, ints int[], bin bytea, span interval,
      f double precision, ch char(5), ip inet, net cidr, texts text[], missing numeric, r real, v text
    );
    INSERT INTO ty VALUES ${[1, 2, 3, 4].map(ROW).join(', ')};`);
  }, 60000);
  afterAll(async () => { await own?.close(); });

  const load = async (h: ReturnType<typeof dbHarness>, id: string, rowId: number) => {
    const page = (await h.page(id, { schema: 'public', table: 'ty', limit: 1, filter: `id = ${rowId}` })).statements[0];
    expect(page.rows).toHaveLength(1);
    return { row: page.rows[0], original: rowOriginal(page.rows[0], page.columns) };
  };

  it('updates and deletes rows of boolean, numeric(10,2), timestamptz, json, jsonb, int[], bytea, interval, float, char(n), inet and cidr columns', async () => {
    const h = dbHarness();
    const id = await h.open({ port: own.port });
    const { row, original } = await load(h, id, 1);
    // The wire forms really differ from ::text for some of them (the reason for the old false conflicts).
    expect(original).toMatchObject({ flag: 't', price: '1.50', ch: 'ab   ', ip: '10.0.0.1', missing: null });
    expect(Object.keys(original)).toHaveLength(row.length);
    expect(await h.value(id, { op: 'applyEdits', req: { schema: 'public', table: 'ty', edits: [{ op: 'update', key: { id: '1' }, set: { v: 'saved' }, original }] } })).toEqual({ affected: 1 });
    // Every edited column checked with its loaded value: update each column of a row in turn, each against what was loaded.
    const second = await load(h, id, 2);
    const changes: Record<string, string> = { flag: 'f', price: '2.25', at: '2020-01-01 00:00:00+00', j: '{"z":1}', jb: '{"z": 1}', ints: '{3}', bin: '\\x01', span: '00:00:01',
      f: '0.30000000000000004', ch: 'zz', ip: '192.168.1.1', net: '192.168.0.0/16', texts: '{}', missing: '7', r: '1.5' };
    let current = second.original;
    for (const [col, value] of Object.entries(changes)) {
      expect(await h.value(id, { op: 'applyEdits', req: { schema: 'public', table: 'ty', edits: [{ op: 'update', key: { id: '2' }, set: { [col]: value }, original: { [col]: current[col] } }] } }), col).toEqual({ affected: 1 });
      current = (await load(h, id, 2)).original;
    }
    // A delete checks the whole loaded row.
    const third = await load(h, id, 3);
    expect(await h.value(id, { op: 'applyEdits', req: { schema: 'public', table: 'ty', edits: [{ op: 'delete', key: { id: '3' }, original: third.original }] } })).toEqual({ affected: 1 });
    expect((await own.db.query<{ n: number }>('SELECT count(*)::int AS n FROM ty WHERE id = 3')).rows[0].n).toBe(0);
    h.host.close(id);
  });

  it('a timestamptz loaded in one time zone still matches after the session switched time zones', async () => {
    const h = dbHarness();
    const id = await h.open({ port: own.port });
    await h.run(id, { sql: `SET TimeZone = 'Asia/Tokyo'` });
    const { original } = await load(h, id, 4);
    expect(original.at).toBe('2026-10-20 19:34:56.789+09');
    await h.run(id, { sql: `SET TimeZone = 'America/New_York'` });
    expect(await h.value(id, { op: 'applyEdits', req: { schema: 'public', table: 'ty', edits: [{ op: 'update', key: { id: '4' }, set: { v: 'tz' }, original: { at: original.at, v: original.v } }] } })).toEqual({ affected: 1 });
    await h.run(id, { sql: 'RESET TimeZone' });
    h.host.close(id);
  });

  it('a real change made elsewhere is still a conflict, for every type', async () => {
    const h = dbHarness();
    const id = await h.open({ port: own.port });
    await own.db.exec(`INSERT INTO ty VALUES ${ROW(10)}`);
    const { original } = await load(h, id, 10);
    const elsewhere: Record<string, string> = {
      flag: 'false', price: '1.51', at: `'2026-10-20 12:34:56.79+02'`, j: `'{"b": 2,  "a": [1, 3]}'`, jb: `'{"b": 2, "a": 2}'`, ints: `'{1,2}'`, bin: `'\\x00ff11'`,
      span: `'1 day 02:03:05'`, f: '0.1000000000000001', ch: `'ab  c'`, ip: `'10.0.0.2'`, net: `'10.0.0.0/9'`, texts: `'{"a b",c}'`, missing: '0', r: '3.1415925',
    };
    for (const [col, sqlValue] of Object.entries(elsewhere)) {
      await own.db.exec(`UPDATE ty SET ${col} = ${sqlValue} WHERE id = 10`);
      expect(await h.op(id, { op: 'applyEdits', req: { schema: 'public', table: 'ty', edits: [{ op: 'update', key: { id: '10' }, set: { v: 'mine' }, original: { [col]: original[col] } }] } }), col).toEqual({ ok: false, error: 'conflict', index: 0 });
      expect(await h.op(id, { op: 'applyEdits', req: { schema: 'public', table: 'ty', edits: [{ op: 'delete', key: { id: '10' }, original }] } }), col).toEqual({ ok: false, error: 'conflict', index: 0 });
      // Put it back (row 1 holds the same values; only its v was saved): then the loaded values match again.
      await own.db.exec(`UPDATE ty SET ${col} = (SELECT ${col} FROM ty WHERE id = 1) WHERE id = 10`);
    }
    // A json value whose text changed only in spacing or key order is the same jsonb: not a conflict.
    await own.db.exec(`UPDATE ty SET j = '{"a":[1,2],"b":2}' WHERE id = 10`);
    expect(await h.value(id, { op: 'applyEdits', req: { schema: 'public', table: 'ty', edits: [{ op: 'delete', key: { id: '10' }, original }] } })).toEqual({ affected: 1 });
    h.host.close(id);
  });
});
