// The DB Host core against PGlite over the real Postgres wire protocol (1.0.0): connect, metadata, DDL, table pages (paging,
// sort, filter in a READ ONLY transaction), scripts with several results, the row cap with "load more", transactions, staged
// edits with conflict rollback, read-only connections and type round-trips. PGlite is single-user (every connection shares one
// backend), so the read-only tests use a server of their own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_LIMITS, isTruncated, type DbTableInfo, type DbObjectInfo } from '../src/shared/db';
import { parseDbInput } from '../src/shared/dbSql';
import { dbHarness, startPglite, type Pglite } from './helpers/dbHarness';

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
    expect(two.statements[0]).toMatchObject({ closed: true });
    expect(two.statements[0].end?.hasMore).toBe(true);
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
    const write = await h.run(id, { sql: "INSERT INTO r VALUES (2, 'b')" });
    expect(write.statements[0].error).toMatchObject({ code: 'readOnly', server: { code: '25006' } });
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
