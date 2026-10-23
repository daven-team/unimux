// SQLite catalog reads of the DB Host (1.0.6): the tables, views, indexes and triggers of the main database (sqlite_schema), a
// table's columns, keys, indexes and foreign keys (the table-valued PRAGMA functions, names bound as parameters), and the CREATE
// statement of an object (sqlite_schema.sql; a table's indexes and triggers follow it).
import { SQLITE_MAIN, type DbColumnInfo, type DbConstraintInfo, type DbIndexInfo, type DbObjectInfo, type DbObjectKind, type DbTableInfo } from '../shared/db';
import { sqIdent, sqliteAffinity, sqliteValueKind, type SqliteAffinity, type SqliteParam } from '../shared/dbSqlite';

export type SqRow = Array<string | null>;
/** A catalog read on the session's connection: rows in array mode, every value as text. */
export type SqQuery = (sql: string, params?: SqliteParam[]) => Promise<SqRow[]>;

export interface SqliteTableInfo extends DbTableInfo {
  /** The name the rowid is read as (a rowid table without a primary key is edited by it); null: keyed by its primary key, or not editable. */
  rowid: string | null;
  /** Each real column's affinity (edits bind values by it). */
  affinities: Record<string, SqliteAffinity>;
}

const KIND: Record<string, DbObjectKind> = { table: 'table', view: 'view', index: 'index', trigger: 'trigger' };

export async function listObjects(q: SqQuery, schema: string): Promise<DbObjectInfo[]> {
  if (schema !== SQLITE_MAIN) return [];
  const rows = await q(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`);
  const out: DbObjectInfo[] = [];
  for (const r of rows) {
    const kind = KIND[r[0] ?? ''];
    // An index SQLite made for a UNIQUE or PRIMARY KEY constraint has no SQL of its own: the table shows it.
    if (!kind || (kind === 'index' && !r[3])) continue;
    const virtual = kind === 'table' && /^\s*CREATE\s+VIRTUAL\b/i.test(r[3] ?? '');
    const detail = kind === 'index' || kind === 'trigger' ? `ON ${r[2] ?? ''}${kind === 'trigger' ? ` · ${triggerTiming(r[3] ?? '')}` : ''}` : virtual ? 'VIRTUAL' : null;
    out.push({ schema, name: r[1] ?? '', kind, oid: 0, ...(kind === 'table' ? { rowEstimate: null } : {}), ...(detail ? { detail } : {}) });
  }
  return out;
}

/** "BEFORE INSERT" from a CREATE TRIGGER statement. */
function triggerTiming(sql: string): string {
  const m = /\b(BEFORE|AFTER|INSTEAD\s+OF)?\s*(INSERT|DELETE|UPDATE)\b/i.exec(sql.replace(/^[\s\S]*?\bTRIGGER\b/i, ''));
  return m ? `${m[1] ? `${m[1].toUpperCase().replace(/\s+/, ' ')} ` : ''}${m[2].toUpperCase()}` : '';
}

const ROWID_NAMES = ['rowid', '_rowid_', 'oid'];

export async function tableInfo(q: SqQuery, schema: string, name: string): Promise<SqliteTableInfo | null> {
  if (schema !== SQLITE_MAIN) return null;
  const rel = (await q(`SELECT type, sql FROM main.sqlite_schema WHERE name = ? AND type IN ('table', 'view')`, [name]))[0];
  if (!rel) return null;
  const kind: DbObjectKind = rel[0] === 'view' ? 'view' : 'table';
  const virtual = kind === 'table' && /^\s*CREATE\s+VIRTUAL\b/i.test(rel[1] ?? '');
  const colRows = await q(`SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid`, [name]);
  const affinities: Record<string, SqliteAffinity> = {};
  const pkOrder: Array<[number, string]> = [];
  const real = colRows.filter((r) => r[6] !== '1');
  const columns: DbColumnInfo[] = real.map((r, i) => {
    const colName = r[1] ?? '';
    const type = r[2] ?? '';
    affinities[colName] = sqliteAffinity(type);
    const pk = Number(r[5] ?? 0);
    if (pk > 0) pkOrder.push([pk, colName]);
    return {
      name: colName, position: i + 1, typeName: type, typeOid: 0, kind: sqliteValueKind(type), nullable: r[3] !== '1' && pk === 0, default: r[4],
      identity: false, generated: r[6] === '2' || r[6] === '3',
    };
  });
  const primaryKey = pkOrder.length ? pkOrder.sort((a, b) => a[0] - b[0]).map((p) => p[1]) : null;
  // INTEGER PRIMARY KEY is the rowid itself: SQLite numbers new rows (like an identity column).
  if (primaryKey?.length === 1) {
    const c = columns.find((x) => x.name === primaryKey[0]);
    if (c && c.typeName.toUpperCase() === 'INTEGER') c.identity = true;
  }
  let withoutRowid = false;
  if (kind === 'table' && !virtual) {
    try { withoutRowid = (await q(`SELECT wr FROM pragma_table_list(?, 'main')`, [name]))[0]?.[0] === '1'; } catch { withoutRowid = /\bWITHOUT\s+ROWID\s*;?\s*$/i.test(rel[1] ?? ''); }
  }
  const notNull = new Set(columns.filter((c) => !c.nullable).map((c) => c.name));
  const idxRows = kind === 'table' ? await q(`SELECT name, "unique", origin, partial FROM pragma_index_list(?, 'main')`, [name]) : [];
  const idxSql = new Map((await q(`SELECT name, sql FROM main.sqlite_schema WHERE type = 'index' AND tbl_name = ?`, [name])).map((r) => [r[0] ?? '', r[1]]));
  const indexes: DbIndexInfo[] = [];
  const uniqueKeys: string[][] = [];
  const constraints: DbConstraintInfo[] = [];
  if (primaryKey) constraints.push({ name: 'PRIMARY KEY', type: 'p', definition: `PRIMARY KEY (${primaryKey.map(sqIdent).join(', ')})`, columns: primaryKey });
  for (const r of idxRows) {
    const idx = r[0] ?? '';
    const cols = await q(`SELECT name FROM pragma_index_info(?, 'main') ORDER BY seqno`, [idx]);
    const names = cols.map((c) => c[0]);
    const expression = names.some((n) => n === null);
    const columnsOf = names.filter((n): n is string => n !== null);
    const unique = r[1] === '1';
    const origin = r[2] ?? 'c';
    const partial = r[3] === '1';
    const definition = idxSql.get(idx) ?? `${origin === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'} (${columnsOf.map(sqIdent).join(', ')})`;
    indexes.push({ name: idx, definition, unique, primary: origin === 'pk', columns: columnsOf });
    if (origin === 'u') constraints.push({ name: idx, type: 'u', definition: `UNIQUE (${columnsOf.map(sqIdent).join(', ')})`, columns: columnsOf });
    if (unique && origin !== 'pk' && !partial && !expression && columnsOf.length && columnsOf.every((c) => notNull.has(c))) uniqueKeys.push(columnsOf);
  }
  if (kind === 'table') {
    const fks = await q(`SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq`, [name]);
    const byId = new Map<string, { table: string; from: string[]; to: Array<string | null> }>();
    for (const r of fks) {
      const e = byId.get(r[0] ?? '') ?? { table: r[1] ?? '', from: [], to: [] };
      e.from.push(r[2] ?? '');
      e.to.push(r[3]);
      byId.set(r[0] ?? '', e);
    }
    for (const [id, e] of byId) {
      const to = e.to.every((t) => t !== null) ? ` (${e.to.map((t) => sqIdent(t!)).join(', ')})` : '';
      constraints.push({ name: `fk_${id}_${e.table}`, type: 'f', definition: `FOREIGN KEY (${e.from.map(sqIdent).join(', ')}) REFERENCES ${sqIdent(e.table)}${to}`, columns: e.from });
    }
  }
  // A rowid table without a primary key is edited by its rowid, read under a name no column hides.
  const taken = new Set(columns.map((c) => c.name.toLowerCase()));
  const rowid = kind === 'table' && !virtual && !withoutRowid && !primaryKey ? ROWID_NAMES.find((n) => !taken.has(n)) ?? null : null;
  if (rowid) columns.unshift({ name: rowid, position: 0, typeName: 'ROWID', typeOid: 0, kind: 'bigint', nullable: false, default: null, identity: true, generated: true });
  const editKey = kind !== 'table' || virtual ? null : primaryKey ?? (rowid ? [rowid] : uniqueKeys[0] ?? null);
  return { schema, name, kind, oid: 0, rowEstimate: null, columns, primaryKey, uniqueKeys, editKey, indexes, constraints, rowid, affinities };
}

/** The CREATE statement of an object; a table's indexes and triggers follow it. Null when there is none. */
export async function objectDdl(q: SqQuery, schema: string, name: string, kind: DbObjectKind): Promise<string | null> {
  if (schema !== SQLITE_MAIN) return null;
  const type = kind === 'view' ? 'view' : kind === 'index' ? 'index' : kind === 'trigger' ? 'trigger' : 'table';
  const sql = (await q(`SELECT sql FROM main.sqlite_schema WHERE name = ? AND type = ?`, [name, type]))[0]?.[0];
  if (!sql) return null;
  const parts = [`${sql.replace(/\s+$/, '')};`];
  if (type === 'table') {
    const more = await q(`SELECT sql FROM main.sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`, [name]);
    for (const r of more) if (r[0]) parts.push(`${r[0].replace(/\s+$/, '')};`);
  }
  return `${parts.join('\n\n')}\n`;
}
