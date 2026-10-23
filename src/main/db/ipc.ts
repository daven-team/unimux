// IPC of the database viewer (1.0.0): zod-validated, sender-checked (guardedHandle / guardedOn with literal channel names),
// fixed error codes only. Passwords travel renderer -> main only (save, test, prompt answers); nothing sends one back.
import { z } from 'zod';
import { DB_KINDS, DB_LIMITS, DB_OBJECT_KINDS, DB_TLS_MODES, isDbSessionId, type DbConnectionInput, type DbPasswordChange, type DbPromptAnswer, type DbResult } from '../../shared/db';
import type { DbHostOp } from '../../shared/dbHostIpc';
import { REDIS_LIMITS, type RedisOp } from '../../shared/dbRedis';
import type { IpcGuard } from '../ipcGuard';
import type { DbService } from './service';

const uuid = z.string().uuid();
const sessionId = z.string().refine(isDbSessionId);
const name = z.string().min(1).max(DB_LIMITS.identifier).refine((s) => !s.includes('\0'));
const text = (max: number) => z.string().max(max);
const port = z.number().int().min(1).max(65535);
/** A SQLite connection has no port: 0 (the normalizer refuses 0 for every other kind). */
const connectionPort = z.number().int().min(0).max(65535);
const value = z.string().max(DB_LIMITS.fullValueChars).nullable();
const keyValues = z.record(name, z.string().max(DB_LIMITS.fullValueChars)).refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 32);
const values = z.record(name, value).refine((r) => Object.keys(r).length <= 1600);

const connectionInput = z.object({
  id: uuid.optional(),
  kind: z.enum(DB_KINDS as [string, ...string[]]),
  name: text(DB_LIMITS.name),
  color: z.string().max(16).optional(),
  group: text(DB_LIMITS.group).optional(),
  host: text(DB_LIMITS.host),
  port: connectionPort,
  user: text(DB_LIMITS.user),
  database: text(DB_LIMITS.database).optional(),
  dbIndex: z.number().int().min(0).max(10_000).optional(),
  tls: z.enum(DB_TLS_MODES as [string, ...string[]]),
  caPath: text(DB_LIMITS.caPath).optional(),
  ssh: z.object({ hostId: uuid, dbHost: text(DB_LIMITS.host), dbPort: port }).strict().nullable(),
  readOnly: z.boolean(),
  statementTimeoutMs: z.number().int().min(1).max(DB_LIMITS.statementTimeoutMaxMs).optional(),
  path: text(DB_LIMITS.caPath).optional(),
}).strict();
const password = z.string().min(1).max(DB_LIMITS.password);
const passwordChange = z.union([
  z.object({ keep: z.literal(true) }).strict(),
  z.object({ set: password }).strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);
const testPassword = z.union([z.object({ set: password }).strict(), z.object({ saved: uuid }).strict(), z.null()]);
const answer = z.union([
  z.object({ sessionId, promptId: uuid, cancel: z.literal(true) }).strict(),
  z.object({ sessionId, promptId: uuid, values: z.array(z.string().max(DB_LIMITS.password)).max(10), remember: z.boolean().optional() }).strict(),
  z.object({ sessionId, promptId: uuid, hostKey: z.enum(['once', 'save', 'replace']) }).strict(),
]);
const sort = z.array(z.object({ column: name, desc: z.boolean() }).strict()).max(DB_LIMITS.sortColumns);
const edit = z.union([
  z.object({ op: z.literal('update'), key: keyValues, set: values, original: values.optional() }).strict(),
  z.object({ op: z.literal('insert'), values }).strict(),
  z.object({ op: z.literal('delete'), key: keyValues, original: values.optional() }).strict(),
]);
const editRequest = z.object({ schema: name, table: name, edits: z.array(edit).min(1).max(DB_LIMITS.edits) }).strict();
const objectKind = z.enum(DB_OBJECT_KINDS as [string, ...string[]]);
const op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('databases') }).strict(),
  z.object({ op: z.literal('schemas') }).strict(),
  z.object({ op: z.literal('objects'), schema: name }).strict(),
  z.object({ op: z.literal('tableInfo'), schema: name, name }).strict(),
  z.object({ op: z.literal('ddl'), schema: name, name, kind: objectKind, args: text(8192).optional() }).strict(),
  z.object({ op: z.literal('tablePage'), req: z.object({
    queryId: uuid, schema: name, table: name, limit: z.number().int().min(1).max(DB_LIMITS.rowCapMax),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), after: z.array(z.string().max(DB_LIMITS.fullValueChars)).max(32).optional(),
    sort: sort.optional(), filter: text(DB_LIMITS.filter).optional(),
  }).strict() }).strict(),
  z.object({ op: z.literal('query'), req: z.object({
    queryId: uuid, sql: text(DB_LIMITS.sql), rowCap: z.number().int().min(1).max(DB_LIMITS.rowCapMax).optional(),
    statementTimeoutMs: z.number().int().min(0).max(DB_LIMITS.statementTimeoutMaxMs).nullable().optional(), readWrite: z.boolean().optional(), continueOnError: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ op: z.literal('fetchMore'), queryId: uuid, count: z.number().int().min(1).max(DB_LIMITS.rowCapMax) }).strict(),
  z.object({ op: z.literal('closeResult'), queryId: uuid }).strict(),
  z.object({ op: z.literal('cancel') }).strict(),
  z.object({ op: z.literal('transaction'), action: z.enum(['begin', 'commit', 'rollback']) }).strict(),
  z.object({ op: z.literal('previewEdits'), req: editRequest }).strict(),
  z.object({ op: z.literal('applyEdits'), req: editRequest }).strict(),
  z.object({ op: z.literal('cellValue'), req: z.object({ schema: name, table: name, key: keyValues, column: name }).strict() }).strict(),
]);

// ── Redis ────────────────────────────────────────────────────────────────────

const RL = REDIS_LIMITS;
/** Bytes of binary-safe data (UTF-8 length of text, decoded length of base64). */
const dataBytes = (d: string | { b64: string }): number => (typeof d === 'string' ? Buffer.byteLength(d, 'utf8') : Math.floor(d.b64.length * 3 / 4) - (d.b64.endsWith('==') ? 2 : d.b64.endsWith('=') ? 1 : 0));
/** Binary-safe data: UTF-8 text or base64, limited in bytes. */
const data = (maxBytes: number) => z.union([
  z.string().max(maxBytes).refine((s) => Buffer.byteLength(s, 'utf8') <= maxBytes),
  z.object({ b64: z.string().max(Math.ceil(maxBytes / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
]);
/** The bytes of every value in a request together (a write, a command or a publish may not exceed REDIS_LIMITS.writeBytes). */
function totalBytes(v: unknown): number {
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf8');
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + totalBytes(x), 0);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.b64 === 'string' && Object.keys(o).length === 1) return dataBytes({ b64: o.b64 });
    return Object.values(o).reduce((n: number, x) => n + totalBytes(x), 0);
  }
  return 0;
}
const rKey = data(RL.nameBytes);
const rName = data(RL.nameBytes);
const rValue = data(RL.writeBytes);
const pattern = z.string().max(RL.nameBytes);
const cursor = z.string().regex(/^\d{1,20}$/);
const count = z.number().int().min(1).max(RL.pageItems);
const streamId = z.string().regex(/^(?:\d{1,20}-\d{1,20}|\d{1,20}|\*|\d{1,20}-\*)$/);
const rangeId = z.string().regex(/^\(?(?:\d{1,20}(?:-\d{1,20})?)$|^[-+]$/);
const score = z.string().regex(/^[+-]?(?:inf|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i);
const typeName = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const ttl = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const items = <T extends z.ZodTypeAny>(t: T) => z.array(t).min(1).max(RL.writeItems);
const pairs = <A extends z.ZodTypeAny, B extends z.ZodTypeAny>(a: A, b: B) => items(z.tuple([a, b]));
const newValue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), value: rValue }).strict(),
  z.object({ type: z.literal('hash'), entries: pairs(rName, rValue) }).strict(),
  z.object({ type: z.literal('list'), items: items(rValue) }).strict(),
  z.object({ type: z.literal('set'), members: items(rName) }).strict(),
  z.object({ type: z.literal('zset'), entries: pairs(rName, score) }).strict(),
  z.object({ type: z.literal('stream'), id: streamId.optional(), fields: pairs(rName, rValue) }).strict(),
]);
const write = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), key: rKey, value: rValue, keepTtl: z.boolean().optional(), ttlMs: ttl.optional(), existing: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('hset'), key: rKey, field: rName, value: rValue, onlyNew: z.boolean().optional(), existing: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('hdel'), key: rKey, fields: items(rName) }).strict(),
  z.object({ op: z.literal('lpush'), key: rKey, items: items(rValue), existing: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('rpush'), key: rKey, items: items(rValue), existing: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('lset'), key: rKey, index: z.number().int(), value: rValue, expected: rValue.optional() }).strict(),
  z.object({ op: z.literal('lrem'), key: rKey, count: z.number().int(), value: rValue }).strict(),
  z.object({ op: z.literal('ldel'), key: rKey, index: z.number().int(), expected: rValue }).strict(),
  z.object({ op: z.literal('sadd'), key: rKey, members: items(rName), existing: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('srem'), key: rKey, members: items(rName) }).strict(),
  z.object({ op: z.literal('zadd'), key: rKey, entries: pairs(rName, score), mode: z.enum(['nx', 'xx']).optional(), existing: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('zrem'), key: rKey, members: items(rName) }).strict(),
  z.object({ op: z.literal('zincrby'), key: rKey, member: rName, by: score, existing: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('xadd'), key: rKey, id: streamId.optional(), fields: pairs(rName, rValue), maxLen: z.number().int().min(0).optional(), approx: z.boolean().optional(), existing: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('xdel'), key: rKey, ids: items(streamId) }).strict(),
  z.object({ op: z.literal('xtrim'), key: rKey, strategy: z.enum(['maxlen', 'minid']), threshold: z.string().regex(/^\d{1,20}(?:-\d{1,20})?$/), approx: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('rename'), key: rKey, newKey: rKey, overwrite: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('expire'), key: rKey, ttlMs: ttl }).strict(),
  z.object({ op: z.literal('persist'), key: rKey }).strict(),
  z.object({ op: z.literal('delete'), keys: items(rKey) }).strict(),
  z.object({ op: z.literal('create'), key: rKey, value: newValue, ttlMs: ttl.optional() }).strict(),
]);
const readReq = z.union([
  z.object({ type: z.literal('string'), key: rKey, offset: z.number().int().min(0).optional(), maxBytes: z.number().int().min(1).max(RL.stringBytesMax).optional() }).strict(),
  z.object({ type: z.literal('hash'), key: rKey, cursor, count, match: pattern.optional() }).strict(),
  z.object({ type: z.literal('list'), key: rKey, start: z.number().int().min(0), count }).strict(),
  z.object({ type: z.literal('set'), key: rKey, cursor, count, match: pattern.optional() }).strict(),
  z.object({ type: z.literal('zset'), key: rKey, start: z.number().int().min(0), count, rev: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('zset'), key: rKey, cursor, count, match: pattern.optional() }).strict(),
  z.object({ type: z.literal('stream'), key: rKey, start: rangeId, end: rangeId, count, rev: z.boolean().optional() }).strict(),
]);
const itemReq = z.union([
  z.object({ type: z.literal('hash'), key: rKey, field: rName }).strict(),
  z.object({ type: z.literal('list'), key: rKey, index: z.number().int() }).strict(),
  z.object({ type: z.literal('stream'), key: rKey, id: z.string().regex(/^\d{1,20}-\d{1,20}$/), field: rName }).strict(),
]);
const channels = z.array(rName).max(RL.pubsubChannels);
const redisOp = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('databases') }).strict(),
  z.object({ kind: z.literal('select'), index: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ kind: z.literal('scan'), req: z.object({
    cursor, match: pattern.optional(), count: z.number().int().min(1).max(RL.scanCountMax).optional(), type: typeName.optional(),
    limit: z.number().int().min(1).max(RL.scanKeys).optional(), details: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ kind: z.literal('keyInfo'), keys: z.array(rKey).max(RL.infoKeys) }).strict(),
  z.object({ kind: z.literal('read'), req: readReq }).strict(),
  z.object({ kind: z.literal('readItem'), req: itemReq }).strict(),
  z.object({ kind: z.literal('write'), write }).strict(),
  z.object({ kind: z.literal('countPattern'), match: pattern, type: typeName.optional() }).strict(),
  z.object({ kind: z.literal('deletePattern'), token: uuid }).strict(),
  z.object({ kind: z.literal('cancel') }).strict(),
  z.object({ kind: z.literal('command'), req: z.object({
    argv: z.array(rValue).min(1).max(RL.argv).refine((a) => typeof a[0] === 'string' && a[0].length > 0 && a[0].length <= 64),
    readWrite: z.boolean().optional(), confirmed: z.boolean().optional(), timeoutMs: z.number().int().min(1).max(RL.consoleTimeoutMaxMs).optional(),
  }).strict() }).strict(),
  z.object({ kind: z.literal('info'), section: z.string().regex(/^[a-z_]{1,32}$/i).optional() }).strict(),
  z.object({ kind: z.literal('slowlog'), count: z.number().int().min(1).max(RL.slowlogMax).optional() }).strict(),
  z.object({ kind: z.literal('clients') }).strict(),
  z.object({ kind: z.literal('subscribe'), channels: channels.optional(), patterns: channels.optional() }).strict(),
  z.object({ kind: z.literal('unsubscribe'), channels: channels.optional(), patterns: channels.optional(), all: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('pubsubState') }).strict(),
  z.object({ kind: z.literal('publish'), channel: rName, message: rValue, readWrite: z.boolean().optional() }).strict(),
]);

const INVALID: DbResult<never> = { ok: false, error: 'invalid' };

export function createDbHandlers(service: DbService) {
  return {
    save: (input: unknown, change: unknown) => {
      const i = connectionInput.safeParse(input), p = passwordChange.safeParse(change);
      if (!i.success || !p.success) return { ok: false as const, error: 'invalid' as const };
      return service.saveConnection(i.data as DbConnectionInput & { id?: string }, p.data as DbPasswordChange);
    },
    remove: (id: unknown) => (uuid.safeParse(id).success ? service.deleteConnection(id as string) : { ok: false }),
    duplicate: (id: unknown) => (uuid.safeParse(id).success ? service.duplicateConnection(id as string) : { ok: false as const }),
    test: async (input: unknown, pw: unknown) => {
      const i = connectionInput.safeParse(input), p = testPassword.safeParse(pw);
      if (!i.success || !p.success || i.data.id !== undefined) return { ok: false as const, error: 'invalid' as const };
      return service.testConnection(i.data as DbConnectionInput, p.data);
    },
    vaultInfo: () => service.vaultInfo(),
    connect: (connectionId: unknown, opts: unknown) => {
      // An empty database: MySQL without a default database (the service ignores it for other kinds).
      const o = z.object({ database: z.string().max(DB_LIMITS.database).refine((d) => !d.includes(' ')).optional() }).strict().optional().nullable().safeParse(opts);
      if (!uuid.safeParse(connectionId).success || !o.success) return { ok: false as const, error: 'invalid' as const };
      return service.connect(connectionId as string, o.data?.database !== undefined ? { database: o.data.database } : {});
    },
    disconnect: async (id: unknown) => (sessionId.safeParse(id).success ? service.disconnect(id as string) : { ok: false }),
    sessions: () => service.snapshot(),
    answer: (raw: unknown) => {
      const a = answer.safeParse(raw);
      return a.success ? service.answer(a.data as DbPromptAnswer) : { ok: false };
    },
    pg: async (id: unknown, raw: unknown): Promise<DbResult<unknown>> => {
      const s = sessionId.safeParse(id), o = op.safeParse(raw);
      return s.success && o.success ? service.op(s.data, o.data as DbHostOp) : INVALID;
    },
    redis: async (id: unknown, raw: unknown): Promise<DbResult<unknown>> => {
      const s = sessionId.safeParse(id), o = redisOp.safeParse(raw);
      if (!s.success || !o.success) return INVALID;
      if (totalBytes(o.data) > REDIS_LIMITS.writeBytes) return INVALID;
      return service.op(s.data, { op: 'redis', req: o.data as RedisOp });
    },
    pin: (ids: unknown) => { const p = z.array(sessionId).max(1000).safeParse(ids); if (p.success) service.pin(p.data); },
  };
}

export type DbHandlers = ReturnType<typeof createDbHandlers>;

export function registerDbIpc(guard: IpcGuard, h: DbHandlers): void {
  const no = () => ({ ok: false });
  guard.guardedHandle('db:connections:save', (_e, input: unknown, change: unknown) => h.save(input, change), () => ({ ok: false, error: 'invalid' }));
  guard.guardedHandle('db:connections:delete', (_e, id: unknown) => h.remove(id), no);
  guard.guardedHandle('db:connections:duplicate', (_e, id: unknown) => h.duplicate(id), no);
  guard.guardedHandle('db:connections:test', (_e, input: unknown, pw: unknown) => h.test(input, pw), () => ({ ok: false, error: 'invalid' }));
  guard.guardedHandle('db:vault:info', () => h.vaultInfo(), () => ({ storage: 'unavailable', saved: [], locked: [], readOnly: true }));
  guard.guardedHandle('db:connect', (_e, connectionId: unknown, opts: unknown) => h.connect(connectionId, opts), () => ({ ok: false, error: 'invalid' }));
  guard.guardedHandle('db:disconnect', (_e, id: unknown) => h.disconnect(id), no);
  guard.guardedHandle('db:sessions', () => h.sessions(), () => ({ sessions: [], prompts: [] }));
  guard.guardedHandle('db:prompt:answer', (_e, a: unknown) => h.answer(a), no);
  guard.guardedHandle('db:pg', (_e, id: unknown, o: unknown) => h.pg(id, o), () => INVALID);
  guard.guardedHandle('db:redis', (_e, id: unknown, o: unknown) => h.redis(id, o), () => INVALID);
  guard.guardedOn('db:pin', (_e, ids: unknown) => h.pin(ids));
}
