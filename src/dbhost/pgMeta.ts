// Postgres catalog reads of the DB Host (1.0.0): databases, schemas, objects, a table's columns, keys, indexes and constraints,
// and the CREATE statement (DDL) of a table, view, materialized view, sequence or function, rebuilt from the catalogs.
// Every query is parameterized; values arrive as text (the session's raw type parsers). Works with Postgres 12 and newer.
import type { DbColumnInfo, DbConstraintInfo, DbDatabaseInfo, DbIndexInfo, DbObjectInfo, DbObjectKind, DbSchemaInfo, DbTableInfo } from '../shared/db';
import { qualifiedName, quoteIdent, valueKind } from '../shared/dbSql';

export type Row = Array<string | null>;
/** A read on the session's connection: rows in array mode, every value as text. */
export type CatalogQuery = (text: string, params?: unknown[]) => Promise<Row[]>;

const num = (v: string | null): number => (v === null ? 0 : Number(v));
const bool = (v: string | null): boolean => v === 't' || v === 'true';
const opt = <K extends string>(key: K, v: string | null): Partial<Record<K, string>> => (v ? { [key]: v } as Record<K, string> : {});
/** int2vector ("1 2") or int2[] ("{1,2}") as numbers. */
const attnums = (v: string | null): number[] => (v ? v.replace(/[{}]/g, '').split(/[\s,]+/).filter(Boolean).map(Number) : []);

export async function listDatabases(q: CatalogQuery): Promise<DbDatabaseInfo[]> {
  const rows = await q(`SELECT d.datname, pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding), d.datistemplate, d.datallowconn,
    CASE WHEN d.datallowconn AND has_database_privilege(d.oid, 'CONNECT') THEN pg_database_size(d.oid) END,
    shobj_description(d.oid, 'pg_database')
    FROM pg_database d ORDER BY d.datistemplate, d.datname`);
  return rows.map((r) => ({
    name: r[0] ?? '', owner: r[1] ?? '', encoding: r[2] ?? '', isTemplate: bool(r[3]), allowConnections: bool(r[4]),
    sizeBytes: r[5] === null ? null : Number(r[5]), ...opt('comment', r[6]),
  }));
}

export async function listSchemas(q: CatalogQuery): Promise<DbSchemaInfo[]> {
  const rows = await q(`SELECT n.nspname, pg_get_userbyid(n.nspowner),
    n.nspname IN ('pg_catalog', 'information_schema'), obj_description(n.oid, 'pg_namespace')
    FROM pg_namespace n
    WHERE n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
    ORDER BY 3, 1`);
  return rows.map((r) => ({ name: r[0] ?? '', owner: r[1] ?? '', system: bool(r[2]), ...opt('comment', r[3]) }));
}

const RELKIND: Record<string, DbObjectKind> = { r: 'table', p: 'partitioned', v: 'view', m: 'matview', f: 'foreign', S: 'sequence' };

export async function listObjects(q: CatalogQuery, schema: string): Promise<DbObjectInfo[]> {
  const rels = await q(`SELECT c.relname, c.relkind, c.oid, c.reltuples, obj_description(c.oid, 'pg_class')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ORDER BY c.relname`, [schema]);
  const funcs = await q(`SELECT p.proname, p.prokind, p.oid, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), obj_description(p.oid, 'pg_proc')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
    ORDER BY p.proname, 4`, [schema]);
  const out: DbObjectInfo[] = rels.map((r) => {
    const kind = RELKIND[r[1] ?? ''] ?? 'table';
    const estimate = r[3] === null ? null : Number(r[3]);
    return {
      schema, name: r[0] ?? '', kind, oid: num(r[2]),
      ...(kind === 'table' || kind === 'partitioned' || kind === 'matview' || kind === 'foreign' ? { rowEstimate: estimate === null || estimate < 0 ? null : Math.round(estimate) } : {}),
      ...opt('comment', r[4]),
    };
  });
  for (const r of funcs) {
    out.push({ schema, name: r[0] ?? '', kind: r[1] === 'p' ? 'procedure' : 'function', oid: num(r[2]), args: r[3] ?? '', ...opt('returns', r[4]), ...opt('comment', r[5]) });
  }
  return out;
}

async function relation(q: CatalogQuery, schema: string, name: string): Promise<{ oid: number; kind: DbObjectKind; estimate: number | null; comment: string | null; partition: boolean; persistence: string } | null> {
  const rows = await q(`SELECT c.oid, c.relkind, c.reltuples, obj_description(c.oid, 'pg_class'), c.relispartition, c.relpersistence
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`, [schema, name]);
  const r = rows[0];
  if (!r) return null;
  const estimate = r[2] === null ? null : Number(r[2]);
  return { oid: num(r[0]), kind: RELKIND[r[1] ?? ''] ?? 'table', estimate: estimate === null || estimate < 0 ? null : Math.round(estimate), comment: r[3], partition: bool(r[4]), persistence: r[5] ?? 'p' };
}

interface ColumnRow { info: DbColumnInfo; attnum: number; collation: string | null; identityKind: string; generationExpression: string | null }

async function columnsOf(q: CatalogQuery, oid: number): Promise<ColumnRow[]> {
  // A domain column edits like its base type.
  const rows = await q(`SELECT a.attname, a.attnum, format_type(a.atttypid, a.atttypmod), a.atttypid,
      CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE a.atttypid END, bt.typcategory,
      NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated, col_description(a.attrelid, a.attnum),
      (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace
        WHERE co.oid = a.attcollation AND a.attcollation <> t.typcollation)
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE a.atttypid END
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`, [oid]);
  // A generated column's expression sits where a default would (pg_attrdef).
  return rows.map((r) => ({
    info: {
      name: r[0] ?? '', position: num(r[1]), typeName: r[2] ?? '', typeOid: num(r[3]), kind: valueKind(num(r[4]), r[5] ?? undefined),
      nullable: bool(r[6]), default: r[9] ? null : r[7], identity: !!r[8], generated: !!r[9], ...opt('comment', r[10]),
    },
    attnum: num(r[1]), collation: r[11], identityKind: r[8] ?? '', generationExpression: r[9] ? r[7] : null,
  }));
}

export async function tableInfo(q: CatalogQuery, schema: string, name: string): Promise<DbTableInfo | null> {
  const rel = await relation(q, schema, name);
  if (!rel || rel.kind === 'sequence') return null;
  const cols = await columnsOf(q, rel.oid);
  const byNum = new Map(cols.map((c) => [c.attnum, c.info.name]));
  const names = (nums: number[]) => nums.map((n) => byNum.get(n)).filter((n): n is string => !!n);
  const cons = await q(`SELECT conname, contype, pg_get_constraintdef(oid, true), conkey FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname`, [rel.oid]);
  const constraints: DbConstraintInfo[] = cons.map((r) => ({ name: r[0] ?? '', type: (r[1] ?? 'c') as DbConstraintInfo['type'], definition: r[2] ?? '', columns: names(attnums(r[3])) }));
  const idx = await q(`SELECT i.relname, pg_get_indexdef(x.indexrelid), x.indisunique, x.indisprimary, x.indkey, x.indpred IS NULL AND x.indexprs IS NULL AND x.indisvalid
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = $1 ORDER BY x.indisprimary DESC, i.relname`, [rel.oid]);
  const indexes: DbIndexInfo[] = idx.map((r) => ({ name: r[0] ?? '', definition: r[1] ?? '', unique: bool(r[2]), primary: bool(r[3]), columns: names(attnums(r[4]).filter((n) => n > 0)) }));
  const pk = constraints.find((c) => c.type === 'p');
  const notNull = new Set(cols.filter((c) => !c.info.nullable).map((c) => c.info.name));
  const uniqueKeys: string[][] = [];
  const addKey = (key: string[]) => { if (key.length && key.every((k) => notNull.has(k)) && !uniqueKeys.some((u) => u.join('\0') === key.join('\0'))) uniqueKeys.push(key); };
  for (const c of constraints) if (c.type === 'u') addKey(c.columns);
  for (let i = 0; i < idx.length; i++) {
    const r = idx[i];
    const plain = bool(r[5]) && attnums(r[4]).every((n) => n > 0);
    if (bool(r[2]) && !bool(r[3]) && plain) addKey(indexes[i].columns);
  }
  const primaryKey = pk && pk.columns.length ? pk.columns : null;
  const editable = rel.kind === 'table' || rel.kind === 'partitioned' || rel.kind === 'foreign';
  const editKey = !editable ? null : primaryKey ?? [...uniqueKeys].sort((a, b) => a.length - b.length)[0] ?? null;
  return {
    schema, name, kind: rel.kind, oid: rel.oid, rowEstimate: rel.estimate,
    columns: cols.map((c) => c.info),
    primaryKey, uniqueKeys, editKey, indexes, constraints, ...(rel.comment ? { comment: rel.comment } : {}),
  };
}

const commentLine = (target: string, comment: string | null | undefined): string[] => (comment ? [`COMMENT ON ${target} IS ${literal(comment)};`] : []);
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The CREATE statement of an object, rebuilt from the catalogs (tables) or from pg_get_*def (views, functions). */
export async function objectDdl(q: CatalogQuery, schema: string, name: string, kind: DbObjectKind, args?: string): Promise<string | null> {
  const target = qualifiedName(schema, name);
  if (kind === 'function' || kind === 'procedure') {
    // `args` is pg_get_function_identity_arguments as listObjects reported it (names included, so to_regprocedure cannot read it).
    const rows = await q(`SELECT pg_get_functiondef(p.oid), obj_description(p.oid, 'pg_proc') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3 AND p.prokind IN ('f', 'p')`, [schema, name, args ?? '']);
    const r = rows[0];
    if (!r || r[0] === null) return null;
    const def = r[0].trimEnd();
    return [def.endsWith(';') ? def : `${def};`, ...commentLine(`${kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'} ${target}(${args ?? ''})`, r[1])].join('\n');
  }
  const rel = await relation(q, schema, name);
  if (!rel) return null;
  if (rel.kind === 'view' || rel.kind === 'matview') {
    const rows = await q(`SELECT pg_get_viewdef($1::oid, true)`, [rel.oid]);
    const body = (rows[0]?.[0] ?? '').trim().replace(/;$/, '');
    const head = rel.kind === 'view' ? `CREATE OR REPLACE VIEW ${target} AS` : `CREATE MATERIALIZED VIEW ${target} AS`;
    const extra: string[] = [];
    if (rel.kind === 'matview') {
      const idx = await q(`SELECT pg_get_indexdef(x.indexrelid) FROM pg_index x WHERE x.indrelid = $1 ORDER BY 1`, [rel.oid]);
      for (const r of idx) if (r[0]) extra.push(`${r[0]};`);
    }
    return [head, `${body}${rel.kind === 'matview' ? '\nWITH DATA' : ''};`, ...extra, ...commentLine(`${rel.kind === 'view' ? 'VIEW' : 'MATERIALIZED VIEW'} ${target}`, rel.comment)].join('\n');
  }
  if (rel.kind === 'sequence') {
    const rows = await q(`SELECT format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle FROM pg_sequence s WHERE s.seqrelid = $1`, [rel.oid]);
    const r = rows[0];
    if (!r) return null;
    return [`CREATE SEQUENCE ${target}`, `    AS ${r[0]}`, `    INCREMENT BY ${r[2]}`, `    MINVALUE ${r[3]}`, `    MAXVALUE ${r[4]}`, `    START WITH ${r[1]}`, `    CACHE ${r[5]}${bool(r[6]) ? '\n    CYCLE' : ''};`,
      ...commentLine(`SEQUENCE ${target}`, rel.comment)].join('\n');
  }
  return tableDdl(q, schema, name, rel);
}

async function tableDdl(q: CatalogQuery, schema: string, name: string, rel: NonNullable<Awaited<ReturnType<typeof relation>>>): Promise<string> {
  const target = qualifiedName(schema, name);
  const cols = await columnsOf(q, rel.oid);
  const cons = await q(`SELECT conname, contype, pg_get_constraintdef(oid, true), conislocal FROM pg_constraint
    WHERE conrelid = $1 AND contype <> 'n' ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname`, [rel.oid]);
  const lines: string[] = [];
  for (const c of cols) {
    let line = `    ${quoteIdent(c.info.name)} ${c.info.typeName}`;
    if (c.collation) line += ` COLLATE ${c.collation}`;
    if (c.identityKind) line += ` GENERATED ${c.identityKind === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
    else if (c.generationExpression) line += ` GENERATED ALWAYS AS (${c.generationExpression}) STORED`;
    else if (c.info.default !== null) line += ` DEFAULT ${c.info.default}`;
    if (!c.info.nullable) line += ' NOT NULL';
    lines.push(line);
  }
  for (const r of cons) if (bool(r[3])) lines.push(`    CONSTRAINT ${quoteIdent(r[0] ?? '')} ${r[2] ?? ''}`);
  const head = `CREATE ${rel.persistence === 'u' ? 'UNLOGGED ' : ''}${rel.kind === 'foreign' ? 'FOREIGN ' : ''}TABLE ${target}`;
  const out: string[] = [];
  const extras = await q(`SELECT CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
      (SELECT quote_ident(pn.nspname) || '.' || quote_ident(pc.relname) FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE i.inhrelid = c.oid AND c.relispartition LIMIT 1),
      CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END
    FROM pg_class c WHERE c.oid = $1`, [rel.oid]);
  const [partKey, parent, bound] = extras[0] ?? [null, null, null];
  if (parent && bound) {
    out.push(`${head} PARTITION OF ${parent}`, `    ${bound};`);
  } else {
    out.push(`${head} (`, lines.join(',\n'), `)${partKey ? ` PARTITION BY ${partKey}` : ''};`);
  }
  const idx = await q(`SELECT pg_get_indexdef(x.indexrelid) FROM pg_index x
    WHERE x.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid AND k.conrelid = x.indrelid)
    ORDER BY 1`, [rel.oid]);
  for (const r of idx) if (r[0]) out.push(`${r[0]};`);
  out.push(...commentLine(`TABLE ${target}`, rel.comment));
  for (const c of cols) out.push(...commentLine(`COLUMN ${target}.${quoteIdent(c.info.name)}`, c.info.comment));
  return out.join('\n');
}
