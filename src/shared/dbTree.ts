// The tree of the "Bazy danych" panel (1.0.0) as a flat list of rows: connection groups, connections, databases, schemas,
// object folders, objects and, under a table or view, its columns, keys and indexes; for Redis (1.0.3) its DBs and, under a DB,
// the loaded keys as a ":"-tree. Pure: the panel keeps what is expanded
// and what was loaded; this file turns that into rows (virtualized by the panel) and says what still has to be loaded.
import { dbDefaultDatabase, isSqlKind, type DbColumnInfo, type DbConnection, type DbConstraintInfo, type DbDatabaseInfo, type DbIndexInfo, type DbObjectInfo, type DbObjectKind, type DbSchemaInfo, type DbTableInfo } from './db';
import { redisDataDisplay, type RedisDbList, type RedisKeyInfo } from './dbRedis';
import { REDIS_KEY_SEPARATOR, redisKeyRows } from './redisView';

export type DbLoad<T = unknown> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

/** Keys of loaded lists (one request each). */
export const loadKey = {
  databases: (c: string) => JSON.stringify(['databases', c]),
  schemas: (c: string, db: string) => JSON.stringify(['schemas', c, db]),
  objects: (c: string, db: string, schema: string) => JSON.stringify(['objects', c, db, schema]),
  info: (c: string, db: string, schema: string, name: string) => JSON.stringify(['info', c, db, schema, name]),
  redisDbs: (c: string) => JSON.stringify(['redisDbs', c]),
  redisKeys: (c: string, db: number) => JSON.stringify(['redisKeys', c, String(db)]),
};
/** The keys of a Redis DB loaded so far (SCAN pages); cursor '0': all of them. */
export interface RedisKeysLoad { keys: RedisKeyInfo[]; cursor: string }
/** DBs a Redis server shows when CONFIG GET databases is not allowed (the default of redis.conf), and at most. */
export const REDIS_DEFAULT_DBS = 16;
const REDIS_MAX_DBS = 256;
export type DbLoadRequest =
  | { kind: 'databases'; key: string; connectionId: string }
  | { kind: 'schemas'; key: string; connectionId: string; database: string }
  | { kind: 'objects'; key: string; connectionId: string; database: string; schema: string }
  | { kind: 'info'; key: string; connectionId: string; database: string; schema: string; name: string }
  | { kind: 'redisDbs'; key: string; connectionId: string }
  | { kind: 'redisKeys'; key: string; connectionId: string; db: number };

/** Keys of tree nodes (what is expanded). */
export const nodeKey = {
  group: (name: string) => JSON.stringify(['g', name]),
  connection: (c: string) => JSON.stringify(['c', c]),
  database: (c: string, db: string) => JSON.stringify(['d', c, db]),
  schema: (c: string, db: string, s: string) => JSON.stringify(['s', c, db, s]),
  folder: (c: string, db: string, s: string, folder: DbFolder) => JSON.stringify(['f', c, db, s, folder]),
  object: (c: string, db: string, s: string, name: string, args = '') => JSON.stringify(['o', c, db, s, name, args]),
  part: (c: string, db: string, s: string, name: string, part: DbPart) => JSON.stringify(['p', c, db, s, name, part]),
  redisDb: (c: string, db: number) => JSON.stringify(['rd', c, db]),
  /** A folder of the key tree: `path` ends with the separator ("user:" or "user:42:"). */
  redisFolder: (c: string, db: number, path: string) => JSON.stringify(['rf', c, db, path]),
};

export type DbFolder = 'tables' | 'views' | 'matviews' | 'sequences' | 'functions';
export type DbPart = 'columns' | 'keys' | 'indexes';
export const FOLDER_KINDS: Record<DbFolder, readonly DbObjectKind[]> = {
  tables: ['table', 'partitioned', 'foreign'], views: ['view'], matviews: ['matview'], sequences: ['sequence'], functions: ['function', 'procedure'],
};
const FOLDERS = Object.keys(FOLDER_KINDS) as DbFolder[];
/** Objects with columns (expandable in the tree). */
export const hasColumns = (kind: DbObjectKind): boolean => kind === 'table' || kind === 'partitioned' || kind === 'foreign' || kind === 'view' || kind === 'matview';

interface Ctx { connectionId: string; database: string }
interface RedisCtx { connectionId: string; db: number }
/** `auto`: the node starts open (folding it is what gets remembered). */
export type DbTreeRow = { key: string; depth: number; auto?: boolean } & (
  | { type: 'group'; name: string; expanded: boolean; count: number }
  | { type: 'connection'; connection: DbConnection; expanded: boolean }
  | ({ type: 'database'; info: DbDatabaseInfo; current: boolean; expanded: boolean } & Ctx)
  | ({ type: 'schema'; schema: DbSchemaInfo; expanded: boolean } & Ctx)
  | ({ type: 'folder'; schema: string; folder: DbFolder; count: number; expanded: boolean } & Ctx)
  | ({ type: 'object'; object: DbObjectInfo; expanded: boolean; expandable: boolean } & Ctx)
  | ({ type: 'part'; schema: string; name: string; part: DbPart; count: number; expanded: boolean } & Ctx)
  | { type: 'column'; column: DbColumnInfo; primary: boolean }
  | { type: 'constraint'; constraint: DbConstraintInfo }
  | { type: 'index'; index: DbIndexInfo }
  /** `keys`: an empty Redis DB ("no keys" instead of "no objects"). */
  | { type: 'status'; status: 'loading' | 'error' | 'empty'; message?: string; retry?: string; keys?: true }
  | ({ type: 'redisDb'; keys: number; current: boolean; expanded: boolean } & RedisCtx)
  | ({ type: 'redisFolder'; path: string; name: string; count: number; expanded: boolean } & RedisCtx)
  | ({ type: 'redisKey'; info: RedisKeyInfo; name: string } & RedisCtx)
  /** More keys wait on the server (the SCAN is not complete): a row that loads the next page. */
  | ({ type: 'redisMore'; loaded: number } & RedisCtx)
);

export interface DbTreeInput {
  connections: readonly DbConnection[];
  open: ReadonlySet<string>;
  loads: Readonly<Record<string, DbLoad>>;
  filter: string;
  /** Whether a connection's tree may show children (it has a live session or is connecting). */
  live: (connectionId: string) => boolean;
}

const sortedGroups = (connections: readonly DbConnection[]): Array<{ group: string | null; items: DbConnection[] }> => {
  const groups = new Map<string | null, DbConnection[]>();
  for (const c of connections) groups.set(c.group ?? null, [...(groups.get(c.group ?? null) ?? []), c]);
  const names = [...groups.keys()].filter((g): g is string => g !== null).sort((a, b) => a.localeCompare(b));
  return [...(groups.has(null) ? [{ group: null, items: groups.get(null)! }] : []), ...names.map((g) => ({ group: g, items: groups.get(g)! }))];
};

/** The visible rows and the loads expanded nodes still wait for. */
export function buildDbTree(input: DbTreeInput): { rows: DbTreeRow[]; needed: DbLoadRequest[] } {
  const rows: DbTreeRow[] = [];
  const needed: DbLoadRequest[] = [];
  const filter = input.filter.trim().toLowerCase();
  const matches = (name: string) => !filter || name.toLowerCase().includes(filter);
  const opened = (key: string) => input.open.has(key);
  /** Rows of a load: its status row while it is not ready, else null. */
  const pending = (key: string, depth: number, request: DbLoadRequest): DbLoad | null => {
    const load = input.loads[key];
    if (!load) { needed.push(request); rows.push({ key: `${key}#status`, depth, type: 'status', status: 'loading' }); return null; }
    if (load.status === 'loading') { rows.push({ key: `${key}#status`, depth, type: 'status', status: 'loading' }); return null; }
    if (load.status === 'error') { rows.push({ key: `${key}#status`, depth, type: 'status', status: 'error', message: load.message, retry: key }); return null; }
    return load;
  };

  const table = (ctx: Ctx, schema: string, object: DbObjectInfo, depth: number) => {
    const key = loadKey.info(ctx.connectionId, ctx.database, schema, object.name);
    const load = pending(key, depth, { kind: 'info', key, ...ctx, schema, name: object.name });
    if (!load || load.status !== 'ready') return;
    const info = load.value as DbTableInfo;
    const keys = info.constraints.filter((c) => c.type === 'p' || c.type === 'u' || c.type === 'f');
    const parts: Array<[DbPart, number]> = [['columns', info.columns.length], ['keys', keys.length], ['indexes', info.indexes.length]];
    for (const [part, count] of parts) {
      if (!count) continue;
      const pk = nodeKey.part(ctx.connectionId, ctx.database, schema, object.name, part);
      const auto = part === 'columns';
      const expanded = auto ? !input.open.has(`${pk}!`) : opened(pk);
      rows.push({ key: pk, depth, auto, type: 'part', ...ctx, schema, name: object.name, part, count, expanded });
      if (!expanded) continue;
      if (part === 'columns') for (const c of info.columns) rows.push({ key: `${pk}:${c.name}`, depth: depth + 1, type: 'column', column: c, primary: !!info.primaryKey?.includes(c.name) });
      if (part === 'keys') for (const c of keys) rows.push({ key: `${pk}:${c.name}`, depth: depth + 1, type: 'constraint', constraint: c });
      if (part === 'indexes') for (const i of info.indexes) rows.push({ key: `${pk}:${i.name}`, depth: depth + 1, type: 'index', index: i });
    }
  };

  const schemaRows = (ctx: Ctx, schema: string, depth: number) => {
    const key = loadKey.objects(ctx.connectionId, ctx.database, schema);
    const load = pending(key, depth, { kind: 'objects', key, ...ctx, schema });
    if (!load || load.status !== 'ready') return;
    const objects = load.value as DbObjectInfo[];
    let shown = 0;
    for (const folder of FOLDERS) {
      const items = objects.filter((o) => FOLDER_KINDS[folder].includes(o.kind) && matches(o.name));
      if (!items.length) continue;
      shown++;
      const fk = nodeKey.folder(ctx.connectionId, ctx.database, schema, folder);
      // Tables are open until folded; the other folders until opened. A filter opens every folder with a match.
      const auto = folder === 'tables';
      const expanded = !!filter || (auto ? !input.open.has(`${fk}!`) : opened(fk));
      rows.push({ key: fk, depth, auto, type: 'folder', ...ctx, schema, folder, count: items.length, expanded });
      if (!expanded) continue;
      for (const o of items) {
        const ok = nodeKey.object(ctx.connectionId, ctx.database, schema, o.name, o.args ?? '');
        const expandable = hasColumns(o.kind);
        const isOpen = expandable && opened(ok);
        rows.push({ key: ok, depth: depth + 1, type: 'object', ...ctx, object: o, expanded: isOpen, expandable });
        if (isOpen) table(ctx, schema, o, depth + 2);
      }
    }
    if (!shown) rows.push({ key: `${key}#empty`, depth, type: 'status', status: 'empty' });
  };

  const databaseRows = (ctx: Ctx, depth: number, mysql: boolean) => {
    // A MySQL database holds its objects itself (no schemas inside it).
    if (mysql) { schemaRows(ctx, ctx.database, depth); return; }
    const key = loadKey.schemas(ctx.connectionId, ctx.database);
    const load = pending(key, depth, { kind: 'schemas', key, ...ctx });
    if (!load || load.status !== 'ready') return;
    // User schemas first, then the system ones (pg_catalog, information_schema).
    const schemas = [...(load.value as DbSchemaInfo[])].sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
    const user = schemas.filter((x) => !x.system);
    for (const s of schemas) {
      const sk = nodeKey.schema(ctx.connectionId, ctx.database, s.name);
      // "public" (or the only user schema) starts open.
      const auto = !s.system && (s.name === 'public' || user.length === 1);
      const expanded = auto ? !input.open.has(`${sk}!`) : opened(sk);
      rows.push({ key: sk, depth, auto, type: 'schema', ...ctx, schema: s, expanded });
      if (expanded) schemaRows(ctx, s.name, depth + 1);
    }
  };

  // The open folders of each key tree, by connection and DB.
  const redisOpen = new Map<string, Set<string>>();
  for (const key of input.open) {
    if (!key.startsWith('["rf"')) continue;
    const [, c, db, path] = JSON.parse(key) as [string, string, number, string];
    const id = JSON.stringify([c, db]);
    redisOpen.set(id, (redisOpen.get(id) ?? new Set()).add(path));
  }

  const redisKeyTree = (ctx: RedisCtx, depth: number) => {
    const key = loadKey.redisKeys(ctx.connectionId, ctx.db);
    const load = pending(key, depth, { kind: 'redisKeys', key, ...ctx });
    if (!load || load.status !== 'ready') return;
    const value = load.value as RedisKeysLoad;
    // A filter shows the keys whose name contains it, as a flat list (a tree would hide them in closed folders).
    const keys = filter ? value.keys.filter((k) => matches(redisDataDisplay(k.key))) : value.keys;
    const open = redisOpen.get(JSON.stringify([ctx.connectionId, ctx.db])) ?? new Set<string>();
    for (const r of redisKeyRows(keys, filter ? 'flat' : 'tree', open, REDIS_KEY_SEPARATOR)) {
      if (r.kind === 'folder') {
        const path = r.id.slice(2);
        rows.push({ key: nodeKey.redisFolder(ctx.connectionId, ctx.db, path), depth: depth + r.depth, type: 'redisFolder', ...ctx, path, name: r.name, count: r.count, expanded: r.open });
      } else rows.push({ key: `${key}:${r.id}`, depth: depth + r.depth, type: 'redisKey', ...ctx, info: r.info, name: r.name });
    }
    if (value.cursor !== '0') rows.push({ key: `${key}#more`, depth, type: 'redisMore', ...ctx, loaded: value.keys.length });
    else if (!keys.length) rows.push({ key: `${key}#empty`, depth, type: 'status', status: 'empty', keys: true });
  };

  const redisRows = (c: DbConnection, depth: number) => {
    const key = loadKey.redisDbs(c.id);
    const load = pending(key, depth, { kind: 'redisDbs', key, connectionId: c.id });
    if (!load || load.status !== 'ready') return;
    const list = load.value as RedisDbList;
    const current = c.dbIndex ?? 0;
    const count = Math.min(REDIS_MAX_DBS, Math.max(list.count ?? REDIS_DEFAULT_DBS, current + 1, ...list.dbs.map((d) => d.index + 1)));
    for (let db = 0; db < count; db++) {
      const dk = nodeKey.redisDb(c.id, db);
      const isCurrent = db === current;
      // The connection's own DB starts open, like the default database of a Postgres server.
      const expanded = isCurrent ? !input.open.has(`${dk}!`) : opened(dk);
      const keys = list.dbs.find((d) => d.index === db)?.keys ?? 0;
      rows.push({ key: dk, depth, auto: isCurrent, type: 'redisDb', connectionId: c.id, db, keys, current: isCurrent, expanded });
      if (expanded) redisKeyTree({ connectionId: c.id, db }, depth + 1);
    }
  };

  const connectionRows = (c: DbConnection, depth: number) => {
    const ck = nodeKey.connection(c.id);
    const expanded = opened(ck) && input.live(c.id);
    rows.push({ key: ck, depth, type: 'connection', connection: c, expanded });
    if (expanded && c.kind === 'redis') { redisRows(c, depth + 1); return; }
    if (!expanded || !isSqlKind(c.kind)) return;
    const key = loadKey.databases(c.id);
    const load = pending(key, depth + 1, { kind: 'databases', key, connectionId: c.id });
    if (!load || load.status !== 'ready') return;
    const current = dbDefaultDatabase(c);
    const dbs = (load.value as DbDatabaseInfo[]).filter((d) => d.allowConnections && !d.isTemplate);
    if (current && !dbs.some((d) => d.name === current)) dbs.unshift({ name: current, owner: '', encoding: '', isTemplate: false, allowConnections: true, sizeBytes: null });
    for (const d of dbs) {
      const dk = nodeKey.database(c.id, d.name);
      const isCurrent = d.name === current;
      const dbExpanded = isCurrent ? !input.open.has(`${dk}!`) : opened(dk);
      rows.push({ key: dk, depth: depth + 1, auto: isCurrent, type: 'database', connectionId: c.id, database: d.name, info: d, current: isCurrent, expanded: dbExpanded });
      if (dbExpanded) databaseRows({ connectionId: c.id, database: d.name }, depth + 2, c.kind === 'mysql');
    }
  };

  for (const g of sortedGroups(input.connections)) {
    if (g.group === null) { for (const c of g.items) connectionRows(c, 0); continue; }
    const gk = nodeKey.group(g.group);
    const expanded = !input.open.has(`${gk}!`);
    rows.push({ key: gk, depth: 0, auto: true, type: 'group', name: g.group, expanded, count: g.items.length });
    if (expanded) for (const c of g.items) connectionRows(c, 1);
  }
  return { rows, needed };
}

/** Opens or folds a row: a node that starts open (`auto`) remembers "<key>!" when folded, the others their key when opened. */
export function toggleNode(open: ReadonlySet<string>, row: DbTreeRow): Set<string> {
  const next = new Set(open);
  const mark = row.auto ? `${row.key}!` : row.key;
  if (next.has(mark)) next.delete(mark); else next.add(mark);
  return next;
}
