// MySQL / MariaDB catalog reads of the DB Host (1.0.5): databases, the tables, views and routines of a database, a table's
// columns, keys, indexes and constraints (information_schema), and the CREATE statement of an object (SHOW CREATE ...). A MySQL
// database is what Postgres calls a schema: every request names it as `schema`. Values are written as hex literals
// (mysqlLiteral), never escaped on the client. Works with MySQL 5.7 / 8 / 9 and MariaDB 10.3 and newer.
import type { DbColumnInfo, DbConstraintInfo, DbDatabaseInfo, DbIndexInfo, DbObjectInfo, DbObjectKind, DbSchemaInfo, DbTableInfo } from '../shared/db';
import { myIdent, myQualified, mysqlColumnKind, mysqlLiteral } from '../shared/dbMysql';

export type MyRow = Array<string | null>;
/** A read on the session's connection: rows in array mode, every value as text. */
export type MyQuery = (sql: string) => Promise<MyRow[]>;

const lit = (v: string) => mysqlLiteral(v);
const opt = <K extends string>(key: K, v: string | null): Partial<Record<K, string>> => (v ? { [key]: v } as Record<K, string> : {});
const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export async function listDatabases(q: MyQuery): Promise<DbDatabaseInfo[]> {
  const rows = await q('SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
  return rows.map((r) => {
    const name = r[0] ?? '';
    const system = SYSTEM_DATABASES.has(name.toLowerCase());
    return { name, owner: '', encoding: r[1] ?? '', isTemplate: false, allowConnections: true, sizeBytes: null, ...(system ? { system } : {}) };
  }).sort((a, b) => Number(!!a.system) - Number(!!b.system) || a.name.localeCompare(b.name));
}

/** MySQL has no schemas inside a database: the databases are the schemas. */
export async function listSchemas(q: MyQuery): Promise<DbSchemaInfo[]> {
  return (await listDatabases(q)).map((d) => ({ name: d.name, owner: '', system: !!d.system }));
}

const tableKind = (type: string | null): DbObjectKind => (type === 'VIEW' || type === 'SYSTEM VIEW' ? 'view' : type === 'SEQUENCE' ? 'sequence' : 'table');

export async function listObjects(q: MyQuery, db: string): Promise<DbObjectInfo[]> {
  const tables = await q(`SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${lit(db)} ORDER BY TABLE_NAME`);
  let routines: MyRow[] = [];
  try {
    routines = await q(`SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${lit(db)} ORDER BY ROUTINE_NAME`);
  } catch { /* routines are a bonus: a server that refuses them still shows its tables */ }
  const out: DbObjectInfo[] = tables.map((r) => {
    const kind = tableKind(r[1]);
    // InnoDB views carry "VIEW" as their comment.
    const comment = kind === 'view' && r[3] === 'VIEW' ? null : r[3];
    return { schema: db, name: r[0] ?? '', kind, oid: 0, ...(kind === 'table' ? { rowEstimate: r[2] === null ? null : Number(r[2]) } : {}), ...opt('comment', comment) };
  });
  for (const r of routines) out.push({ schema: db, name: r[0] ?? '', kind: r[1] === 'PROCEDURE' ? 'procedure' : 'function', oid: 0, ...opt('returns', r[2]), ...opt('comment', r[3]) });
  // Triggers and events (1.0.6) are bonuses too: a user without the TRIGGER or EVENT privilege on the database sees none.
  try {
    const triggers = await q(`SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ${lit(db)} ORDER BY TRIGGER_NAME`);
    for (const r of triggers) out.push({ schema: db, name: r[0] ?? '', kind: 'trigger', oid: 0, ...opt('detail', [r[1], r[2], r[3] ? `ON ${r[3]}` : null].filter(Boolean).join(' ')) });
  } catch { /* no triggers shown */ }
  try {
    const events = await q(`SELECT EVENT_NAME, EVENT_TYPE, INTERVAL_VALUE, INTERVAL_FIELD, EXECUTE_AT, STATUS, EVENT_COMMENT FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${lit(db)} ORDER BY EVENT_NAME`);
    for (const r of events) {
      const when = r[1] === 'RECURRING' ? `EVERY ${r[2] ?? '?'} ${r[3] ?? ''}`.trim() : r[4] ? `AT ${r[4]}` : r[1];
      out.push({ schema: db, name: r[0] ?? '', kind: 'event', oid: 0, ...opt('detail', [when, r[5]].filter(Boolean).join(' · ')), ...opt('comment', r[6]) });
    }
  } catch { /* no events shown */ }
  return out;
}

/** EXTRA of a generated column ("VIRTUAL GENERATED", "STORED GENERATED", MariaDB "PERSISTENT"), not MySQL 8's DEFAULT_GENERATED. */
const isGenerated = (extra: string): boolean => /(?:^|\s)(?:VIRTUAL|STORED|PERSISTENT)(?:\s+GENERATED)?(?:\s|$)/i.test(extra);

export interface MysqlTableInfo extends DbTableInfo {
  /** information_schema DATA_TYPE of each column (edits pick literals and checks by it). */
  dataTypes: Record<string, string>;
}

export async function tableInfo(q: MyQuery, db: string, name: string): Promise<MysqlTableInfo | null> {
  const rel = (await q(`SELECT TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${lit(db)} AND TABLE_NAME = ${lit(name)}`))[0];
  if (!rel) return null;
  const kind = tableKind(rel[0]);
  const colRows = await q(`SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${lit(db)} AND TABLE_NAME = ${lit(name)} ORDER BY ORDINAL_POSITION`);
  const dataTypes: Record<string, string> = {};
  const columns: DbColumnInfo[] = colRows.map((r) => {
    const colName = r[0] ?? '';
    const columnType = r[2] ?? '';
    const dataType = (r[3] ?? '').toLowerCase();
    const extra = r[6] ?? '';
    dataTypes[colName] = dataType;
    return {
      name: colName, position: Number(r[1] ?? 0), typeName: columnType, typeOid: 0, kind: mysqlColumnKind(dataType, columnType), nullable: r[4] === 'YES',
      default: r[5], identity: /auto_increment/i.test(extra), generated: isGenerated(extra), ...opt('comment', r[7]),
    };
  });
  const notNull = new Set(columns.filter((c) => !c.nullable).map((c) => c.name));
  const idxRows = await q(`SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SUB_PART, INDEX_TYPE FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ${lit(db)} AND TABLE_NAME = ${lit(name)} ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`);
  const byIndex = new Map<string, { unique: boolean; columns: string[]; prefix: boolean; expression: boolean; type: string }>();
  for (const r of idxRows) {
    const idx = r[0] ?? '';
    const entry = byIndex.get(idx) ?? { unique: r[1] === '0', columns: [], prefix: false, expression: false, type: r[4] ?? '' };
    if (r[2] === null) entry.expression = true; else entry.columns.push(r[2]);
    if (r[3] !== null) entry.prefix = true;
    byIndex.set(idx, entry);
  }
  const indexes: DbIndexInfo[] = [...byIndex].map(([idx, e]) => ({
    name: idx, unique: e.unique, primary: idx === 'PRIMARY', columns: e.columns,
    definition: `${idx === 'PRIMARY' ? 'PRIMARY KEY' : `${e.unique ? 'UNIQUE ' : ''}INDEX ${myIdent(idx)}`} (${e.columns.map(myIdent).join(', ')}${e.expression ? `${e.columns.length ? ', ' : ''}(...)` : ''})${e.type && e.type !== 'BTREE' ? ` USING ${e.type}` : ''}`,
  }));
  const pk = byIndex.get('PRIMARY');
  const primaryKey = pk && !pk.prefix && !pk.expression ? pk.columns : null;
  const uniqueKeys = [...byIndex].filter(([idx, e]) => idx !== 'PRIMARY' && e.unique && !e.prefix && !e.expression && e.columns.length && e.columns.every((c) => notNull.has(c))).map(([, e]) => e.columns);
  const conRows = await q(`SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
    FROM information_schema.TABLE_CONSTRAINTS tc
    LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME
    WHERE tc.TABLE_SCHEMA = ${lit(db)} AND tc.TABLE_NAME = ${lit(name)} ORDER BY tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`);
  const byCon = new Map<string, { type: DbConstraintInfo['type']; columns: string[]; refDb: string | null; refTable: string | null; refColumns: string[] }>();
  for (const r of conRows) {
    const type = r[1] === 'PRIMARY KEY' ? 'p' : r[1] === 'UNIQUE' ? 'u' : r[1] === 'FOREIGN KEY' ? 'f' : r[1] === 'CHECK' ? 'c' : null;
    if (!type) continue;
    const key = `${type}\0${r[0] ?? ''}`;
    const entry = byCon.get(key) ?? { type, columns: [], refDb: r[3], refTable: r[4], refColumns: [] };
    if (r[2] !== null) entry.columns.push(r[2]);
    if (r[5] !== null) entry.refColumns.push(r[5]);
    byCon.set(key, entry);
  }
  let checks = new Map<string, string>();
  if ([...byCon.values()].some((c) => c.type === 'c')) {
    try {
      const rows = await q(`SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ${lit(db)}`);
      checks = new Map(rows.map((r) => [r[0] ?? '', r[1] ?? '']));
    } catch { /* older servers: the name is enough */ }
  }
  const constraints: DbConstraintInfo[] = [...byCon].map(([key, c]) => {
    const conName = key.slice(2);
    const cols = c.columns.map(myIdent).join(', ');
    const definition = c.type === 'p' ? `PRIMARY KEY (${cols})` : c.type === 'u' ? `UNIQUE (${cols})`
      : c.type === 'f' ? `FOREIGN KEY (${cols}) REFERENCES ${c.refTable ? (c.refDb && c.refDb !== db ? myQualified(c.refDb, c.refTable) : myIdent(c.refTable)) : '?'} (${c.refColumns.map(myIdent).join(', ')})`
        : `CHECK (${checks.get(conName) ?? '...'})`;
    return { name: conName === 'PRIMARY' ? 'PRIMARY KEY' : conName, type: c.type, definition, columns: c.columns };
  });
  // Views have no keys of their own: they are not edited (like Postgres views).
  const editKey = kind === 'table' ? primaryKey ?? uniqueKeys[0] ?? null : null;
  return {
    schema: db, name, kind, oid: 0, rowEstimate: kind === 'table' && rel[1] !== null ? Number(rel[1]) : null, columns, primaryKey, uniqueKeys, editKey, indexes, constraints,
    ...opt('comment', kind === 'view' && rel[2] === 'VIEW' ? null : rel[2]), dataTypes,
  };
}

/** The CREATE statement of a table, view, sequence (MariaDB), function, procedure, trigger or event; null when the server shows none. */
export async function objectDdl(q: MyQuery, db: string, name: string, kind: DbObjectKind): Promise<string | null> {
  const target = myQualified(db, name);
  // SHOW CREATE TRIGGER: Trigger, sql_mode, SQL Original Statement, ...; SHOW CREATE EVENT: Event, sql_mode, time_zone, Create Event, ...
  const [sql, column] = kind === 'view' ? [`SHOW CREATE VIEW ${target}`, 1]
    : kind === 'sequence' ? [`SHOW CREATE SEQUENCE ${target}`, 1]
      : kind === 'function' ? [`SHOW CREATE FUNCTION ${target}`, 2]
        : kind === 'procedure' ? [`SHOW CREATE PROCEDURE ${target}`, 2]
          : kind === 'trigger' ? [`SHOW CREATE TRIGGER ${target}`, 2]
            : kind === 'event' ? [`SHOW CREATE EVENT ${target}`, 3]
              : [`SHOW CREATE TABLE ${target}`, 1];
  const row = (await q(sql))[0];
  const text = row?.[column as number];
  if (!text) return null;
  return `${text.replace(/\s+$/, '')};\n`;
}
