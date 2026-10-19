// IPC of the database viewer (1.0.0): zod-validated, sender-checked (guardedHandle / guardedOn with literal channel names),
// fixed error codes only. Passwords travel renderer -> main only (save, test, prompt answers); nothing sends one back.
import { z } from 'zod';
import { DB_KINDS, DB_LIMITS, DB_TLS_MODES, isDbSessionId, type DbConnectionInput, type DbPasswordChange, type DbPromptAnswer, type DbResult } from '../../shared/db';
import type { DbHostOp } from '../../shared/dbHostIpc';
import type { IpcGuard } from '../ipcGuard';
import type { DbService } from './service';

const uuid = z.string().uuid();
const sessionId = z.string().refine(isDbSessionId);
const name = z.string().min(1).max(DB_LIMITS.identifier).refine((s) => !s.includes('\0'));
const text = (max: number) => z.string().max(max);
const port = z.number().int().min(1).max(65535);
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
  port,
  user: text(DB_LIMITS.user),
  database: text(DB_LIMITS.database).optional(),
  dbIndex: z.number().int().min(0).max(10_000).optional(),
  tls: z.enum(DB_TLS_MODES as [string, ...string[]]),
  caPath: text(DB_LIMITS.caPath).optional(),
  ssh: z.object({ hostId: uuid, dbHost: text(DB_LIMITS.host), dbPort: port }).strict().nullable(),
  readOnly: z.boolean(),
  statementTimeoutMs: z.number().int().min(1).max(DB_LIMITS.statementTimeoutMaxMs).optional(),
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
  z.object({ op: z.literal('update'), key: keyValues, set: values }).strict(),
  z.object({ op: z.literal('insert'), values }).strict(),
  z.object({ op: z.literal('delete'), key: keyValues }).strict(),
]);
const editRequest = z.object({ schema: name, table: name, edits: z.array(edit).min(1).max(DB_LIMITS.edits) }).strict();
const objectKind = z.enum(['table', 'partitioned', 'view', 'matview', 'foreign', 'sequence', 'function', 'procedure']);
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
      const o = z.object({ database: z.string().min(1).max(DB_LIMITS.database).optional() }).strict().optional().nullable().safeParse(opts);
      if (!uuid.safeParse(connectionId).success || !o.success) return { ok: false as const, error: 'invalid' as const };
      return service.connect(connectionId as string, o.data?.database ? { database: o.data.database } : {});
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
  guard.guardedOn('db:pin', (_e, ids: unknown) => h.pin(ids));
}
