import { describe, expect, it } from 'vitest';
import type { DbConnection, DbDatabaseInfo, DbObjectInfo, DbSchemaInfo, DbTableInfo } from '../src/shared/db';
import {
  addInsert, columnWindow, dbTabId, editRowLabel, EMPTY_STAGED, isDeleted, keyLabel, moveCell, nextSqlName, parseHistory, parseStaged, pushHistory,
  rangeOf, removeInserts, rowKey, rowOriginal, serializeStaged, setInsertValue, sliceRange, stageCell, stagedCell, stagedCount, stagedEdits, toggleDeletes, validDbTabRef,
} from '../src/shared/dbTabs';
import { buildDbTree, loadKey, nodeKey, toggleNode, type DbLoad } from '../src/shared/dbTree';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';

describe('database tab references', () => {
  it('gives one id per table, SQL tab and DDL object, and validates restored references', () => {
    const table = { kind: 'table' as const, connectionId: C1, database: 'app', schema: 'public', table: 'items', objectKind: 'table' as const };
    expect(dbTabId(table)).toBe(dbTabId({ ...table }));
    expect(dbTabId(table)).not.toBe(dbTabId({ ...table, database: 'other' }));
    expect(dbTabId({ kind: 'sql', connectionId: C1, database: 'app', uid: U })).toContain(U);
    expect(validDbTabRef(table)).toBe(true);
    expect(validDbTabRef({ ...table, connectionId: 'nope' })).toBe(false);
    expect(validDbTabRef({ ...table, objectKind: 'index' })).toBe(false);
    expect(validDbTabRef({ kind: 'sql', connectionId: C1, database: 'app', uid: 'x' })).toBe(false);
    expect(validDbTabRef({ kind: 'ddl', connectionId: C1, database: 'app', schema: 's', name: 'f', objectKind: 'function', args: 'x integer' })).toBe(true);
    expect(validDbTabRef(null)).toBe(false);
  });

  it('numbers SQL tabs with the first free number', () => {
    expect(nextSqlName([])).toBe('SQL 1');
    expect(nextSqlName(['SQL 1', 'SQL 3'])).toBe('SQL 2');
  });
});

describe('staged edits', () => {
  const columns = [{ name: 'id', kind: 'int' }, { name: 'name', kind: 'text' }, { name: 'ok', kind: 'bool' }, { name: 'big', kind: 'text' }];
  const row = ['1', 'a', 't', { t: 'trunc' as const, head: 'xx', chars: 99999 }];

  it('finds the key of a row (none for NULL or truncated key values)', () => {
    expect(rowKey(row, columns, ['id'])).toEqual({ id: '1' });
    expect(rowKey([null, 'a'], columns, ['id'])).toBeNull();
    expect(rowKey(row, columns, ['big'])).toBeNull();
    expect(rowKey(row, columns, null)).toBeNull();
  });

  it('stages cell changes with their loaded values and drops them when the original comes back', () => {
    let s = stageCell(EMPTY_STAGED, { id: '1' }, 'name', 'b', 'a');
    expect(stagedCell(s, { id: '1' }, 'name')).toEqual({ value: 'b' });
    expect(s.updates[0].original).toEqual({ name: 'a' });
    s = stageCell(s, { id: '1' }, 'name', 'c', 'a');
    expect(s.updates[0].original).toEqual({ name: 'a' });
    expect(stagedCount(s)).toBe(1);
    s = stageCell(s, { id: '1' }, 'name', 'a', 'a');
    expect(stagedCount(s)).toBe(0);
    // A value that arrived truncated is never compared (and never equals the typed one).
    s = stageCell(EMPTY_STAGED, { id: '1' }, 'big', 'xx', undefined);
    expect(s.updates[0]).toEqual({ key: { id: '1' }, set: { big: 'xx' } });
    // Booleans are not compared (their ::text differs from the wire text).
    s = stageCell(EMPTY_STAGED, { id: '1' }, 'ok', 'f', 't', false);
    expect(s.updates[0].original).toBeUndefined();
  });

  it('keeps the loaded row for a delete, toggles deletes and builds the save in order', () => {
    expect(rowOriginal(row, columns)).toEqual({ id: '1', name: 'a' });
    let s = stageCell(EMPTY_STAGED, { id: '1' }, 'name', 'b', 'a');
    s = stageCell(s, { id: '2' }, 'name', 'z', 'y');
    s = toggleDeletes(s, [{ key: { id: '2' }, original: { id: '2', name: 'y' } }]);
    expect(isDeleted(s, { id: '2' })).toBe(true);
    s = addInsert(s, 'n1');
    s = setInsertValue(s, 'n1', 'id', '9');
    s = setInsertValue(s, 'n1', 'name', null);
    expect(stagedEdits(s)).toEqual([
      { op: 'update', key: { id: '1' }, set: { name: 'b' }, original: { name: 'a' } },
      { op: 'delete', key: { id: '2' }, original: { id: '2', name: 'y' } },
      { op: 'insert', values: { id: '9', name: null } },
    ]);
    s = toggleDeletes(s, [{ key: { id: '2' } }]);
    expect(isDeleted(s, { id: '2' })).toBe(false);
    expect(removeInserts(s, ['n1']).inserts).toEqual([]);
  });

  it('round-trips through the draft text and survives damaged drafts', () => {
    const s = toggleDeletes(stageCell(EMPTY_STAGED, { id: '1' }, 'name', null, 'a'), [{ key: { id: '3' } }]);
    expect(parseStaged(serializeStaged(s))).toEqual(s);
    expect(serializeStaged(EMPTY_STAGED)).toBe('');
    expect(parseStaged('')).toEqual(EMPTY_STAGED);
    expect(parseStaged('{oops')).toEqual(EMPTY_STAGED);
    expect(parseStaged(JSON.stringify({ updates: [{ key: {}, set: {} }, { key: { id: 1 }, set: {} }], deletes: ['x'], inserts: [{ id: 3 }] }))).toEqual(EMPTY_STAGED);
  });

  it('names the row of a failed edit', () => {
    expect(keyLabel({ id: '5' })).toBe('id = 5');
    expect(keyLabel({ a: "it's", b: '2' })).toBe("a = 'it''s', b = 2");
    expect(editRowLabel({ op: 'insert', values: {} })).toBeNull();
    expect(editRowLabel({ op: 'delete', key: { id: '7' } })).toBe('id = 7');
  });
});

describe('query history', () => {
  it('keeps the newest first, moves a repeated text to the top and caps the list', () => {
    let list = pushHistory([], { sql: ' SELECT 1 ', at: 1, ok: true, timeMs: 2 });
    list = pushHistory(list, { sql: 'SELECT 2', at: 2, ok: true, timeMs: 2 });
    list = pushHistory(list, { sql: 'SELECT 1', at: 3, ok: false, timeMs: 2 });
    expect(list.map((e) => [e.sql, e.at])).toEqual([['SELECT 1', 3], ['SELECT 2', 2]]);
    expect(pushHistory(list, { sql: '   ', at: 4, ok: true, timeMs: 0 })).toHaveLength(2);
    expect(pushHistory(list, { sql: 'x', at: 5, ok: true, timeMs: 0 }, 2)).toHaveLength(2);
    expect(parseHistory({ [C1]: [{ sql: 'a', at: 1, ok: true, timeMs: 1 }, { sql: 2 }], bad: [] })).toEqual({ [C1]: [{ sql: 'a', at: 1, ok: true, timeMs: 1 }] });
    expect(parseHistory(null)).toEqual({});
  });
});

describe('data grid math', () => {
  it('windows columns for a horizontal scroll position', () => {
    const widths = Array.from({ length: 100 }, () => 100);
    const w = columnWindow(widths, 0, 350, 1);
    expect([w.start, w.end, w.total]).toEqual([0, 5, 10000]);
    const far = columnWindow(widths, 5000, 300, 2);
    expect(far.start).toBe(48);
    expect(far.end).toBe(55);
    expect(far.lefts[50]).toBe(5000);
    expect(columnWindow([], 0, 100)).toEqual({ start: 0, end: 0, lefts: [], total: 0 });
  });

  it('moves the cursor inside the grid and slices selections', () => {
    expect(moveCell({ row: 0, col: 0 }, 'ArrowUp', 10, 3)).toEqual({ row: 0, col: 0 });
    expect(moveCell({ row: 0, col: 0 }, 'ArrowRight', 10, 3)).toEqual({ row: 0, col: 1 });
    expect(moveCell({ row: 5, col: 1 }, 'End', 10, 3)).toEqual({ row: 5, col: 2 });
    expect(moveCell({ row: 5, col: 1 }, 'PageDown', 10, 3, 20)).toEqual({ row: 9, col: 1 });
    const r = rangeOf({ row: 2, col: 2 }, { row: 1, col: 0 });
    expect(r).toEqual({ r0: 1, r1: 2, c0: 0, c1: 2 });
    expect(sliceRange([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']], { r0: 1, r1: 5, c0: 1, c1: 1 })).toEqual([['e'], ['h']]);
  });
});

describe('database tree', () => {
  const conn = (id: string, patch: Partial<DbConnection> = {}): DbConnection => ({
    id, kind: 'postgres', name: id === C1 ? 'one' : 'two', host: 'localhost', port: 5432, user: 'u', database: 'app', tls: 'prefer', ssh: null, readOnly: false, createdAt: 0, updatedAt: 0, ...patch,
  });
  const ready = <T,>(value: T): DbLoad => ({ status: 'ready', value });
  const dbs: DbDatabaseInfo[] = [
    { name: 'app', owner: 'u', encoding: 'UTF8', isTemplate: false, allowConnections: true, sizeBytes: null },
    { name: 'other', owner: 'u', encoding: 'UTF8', isTemplate: false, allowConnections: true, sizeBytes: null },
    { name: 'template1', owner: 'u', encoding: 'UTF8', isTemplate: true, allowConnections: true, sizeBytes: null },
  ];
  const schemas: DbSchemaInfo[] = [{ name: 'pg_catalog', owner: 'u', system: true }, { name: 'public', owner: 'u', system: false }, { name: 'shop', owner: 'u', system: false }];
  const obj = (name: string, kind: DbObjectInfo['kind'], schema = 'public'): DbObjectInfo => ({ schema, name, kind, oid: 1 });
  const objects = [obj('items', 'table'), obj('orders', 'table'), obj('v_items', 'view'), obj('f', 'function')];
  const info: DbTableInfo = {
    schema: 'public', name: 'items', kind: 'table', oid: 1, rowEstimate: 3,
    columns: [{ name: 'id', position: 1, typeName: 'integer', typeOid: 23, kind: 'int', nullable: false, default: null, identity: false, generated: false }],
    primaryKey: ['id'], uniqueKeys: [], editKey: ['id'], indexes: [{ name: 'items_pkey', definition: 'x', unique: true, primary: true, columns: ['id'] }],
    constraints: [{ name: 'items_pkey', type: 'p', definition: 'PRIMARY KEY (id)', columns: ['id'] }],
  };
  const loads: Record<string, DbLoad> = {
    [loadKey.databases(C1)]: ready(dbs), [loadKey.schemas(C1, 'app')]: ready(schemas), [loadKey.objects(C1, 'app', 'public')]: ready(objects),
    [loadKey.info(C1, 'app', 'public', 'items')]: ready(info),
  };

  it('groups connections and shows nothing below one without a session', () => {
    const { rows, needed } = buildDbTree({ connections: [conn(C1, { group: 'Prod' }), conn(C2)], open: new Set([nodeKey.connection(C1)]), loads: {}, filter: '', live: () => false });
    expect(rows.map((r) => r.type)).toEqual(['connection', 'group', 'connection']);
    expect(needed).toEqual([]);
  });

  it('opens the default database, public and the tables folder by itself and asks for what is missing', () => {
    const open = new Set([nodeKey.connection(C1), nodeKey.object(C1, 'app', 'public', 'items')]);
    const { rows, needed } = buildDbTree({ connections: [conn(C1)], open, loads, filter: '', live: () => true });
    const names = rows.map((r) => ('object' in r ? r.object.name : r.type === 'database' ? `db:${r.database}` : r.type === 'schema' ? `s:${r.schema.name}` : r.type === 'folder' ? `f:${r.folder}` : r.type === 'part' ? `p:${r.part}` : r.type === 'column' ? `c:${r.column.name}` : r.type));
    expect(names).toEqual(['connection', 'db:app', 's:public', 'f:tables', 'items', 'p:columns', 'c:id', 'p:keys', 'p:indexes', 'orders', 'f:views', 'f:functions', 's:shop', 's:pg_catalog', 'db:other']);
    expect(rows.find((r) => r.type === 'column')).toMatchObject({ primary: true });
    expect(needed).toEqual([]);
    // shop is folded: opening it asks for its objects.
    const shop = rows.find((r) => r.type === 'schema' && r.schema.name === 'shop')!;
    const next = buildDbTree({ connections: [conn(C1)], open: toggleNode(open, shop), loads, filter: '', live: () => true });
    expect(next.needed).toEqual([{ kind: 'objects', key: loadKey.objects(C1, 'app', 'shop'), connectionId: C1, database: 'app', schema: 'shop' }]);
    expect(next.rows.some((r) => r.type === 'status' && r.status === 'loading')).toBe(true);
  });

  it('folds nodes that start open and filters objects by name', () => {
    const open = new Set([nodeKey.connection(C1)]);
    const first = buildDbTree({ connections: [conn(C1)], open, loads, filter: '', live: () => true });
    const tables = first.rows.find((r) => r.type === 'folder' && r.folder === 'tables')!;
    const folded = buildDbTree({ connections: [conn(C1)], open: toggleNode(open, tables), loads, filter: '', live: () => true });
    expect(folded.rows.some((r) => r.type === 'object' && r.object.name === 'items')).toBe(false);
    const filtered = buildDbTree({ connections: [conn(C1)], open, loads, filter: 'ORD', live: () => true });
    expect(filtered.rows.filter((r) => r.type === 'object').map((r) => (r.type === 'object' ? r.object.name : ''))).toEqual(['orders']);
    expect(filtered.rows.some((r) => r.type === 'folder' && r.folder === 'views')).toBe(false);
  });

  it('shows a load error with its retry key', () => {
    const { rows } = buildDbTree({ connections: [conn(C1)], open: new Set([nodeKey.connection(C1)]), loads: { [loadKey.databases(C1)]: { status: 'error', message: 'boom' } }, filter: '', live: () => true });
    expect(rows[1]).toMatchObject({ type: 'status', status: 'error', message: 'boom', retry: loadKey.databases(C1) });
  });
});
