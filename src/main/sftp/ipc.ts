// IPC of SFTP (0.9.8): zod-validated, sender-checked (guardedHandle / guardedOn with literal channel names), fixed error
// codes only. Remote paths must be absolute POSIX paths, local ones absolute local paths.
import { z } from 'zod';
import {
  isLocalDirection, isSftpSessionId, SFTP_LIMITS, validRemotePath,
  type SftpResult, type TransferRequest,
} from '../../shared/sftp';
import { SSH_LIMITS, type SshPromptAnswer } from '../../shared/ssh';
import type { SftpOp } from '../../shared/sftpHostIpc';
import { cleanStamp, validEditorSave } from '../../shared/editorSource';
import type { IpcGuard } from '../ipcGuard';
import { validLocalPath } from '../localFiles';
import type { SftpService } from './service';

const uuid = z.string().uuid();
const sessionId = z.string().refine(isSftpSessionId);
const remotePath = z.string().refine(validRemotePath);
const remotePaths = z.array(remotePath).min(1).max(SFTP_LIMITS.paths);
const count = z.object({ files: z.number().int().min(0), dirs: z.number().int().min(0) }).strict();
const transfer = z.object({
  direction: z.enum(['upload', 'download', 'local-copy', 'move', 'local-move']),
  sources: z.array(z.string()).min(1).max(SFTP_LIMITS.paths),
  targetDir: z.string(),
  policy: z.enum(['overwrite', 'skip', 'keepBoth']).optional(),
  batchId: uuid.optional(),
}).strict().refine((r) => {
  const remote = (p: string) => validRemotePath(p);
  const sourceRemote = r.direction === 'download' || r.direction === 'move';
  const targetRemote = r.direction === 'upload' || r.direction === 'move';
  return r.sources.every(sourceRemote ? remote : validLocalPath) && (targetRemote ? remote(r.targetDir) : validLocalPath(r.targetDir));
});
const mode = z.number().int().min(0).max(0o7777);
const chmodRequest = z.object({
  paths: remotePaths,
  set: z.object({ bits: mode, mask: mode }).strict().nullable(),
  recursive: z.object({ dirMode: mode, fileMode: mode }).strict().nullable(),
  opId: uuid.optional(),
  total: z.number().int().min(0).max(10_000_000).optional(),
}).strict().refine((r) => r.set !== null || r.recursive !== null);
const answer = z.union([
  z.object({ sessionId, promptId: uuid, cancel: z.literal(true) }).strict(),
  z.object({ sessionId, promptId: uuid, values: z.array(z.string().max(SSH_LIMITS.password)).max(10), remember: z.boolean().optional(), useSaved: z.boolean().optional() }).strict(),
  z.object({ sessionId, promptId: uuid, hostKey: z.enum(['once', 'save', 'replace']) }).strict(),
]);
const cancelTarget = z.object({ itemIds: z.array(uuid).max(SFTP_LIMITS.paths).optional(), batchId: uuid.optional() }).strict();
const conflictAnswer = z.object({ choice: z.enum(['overwrite', 'skip', 'keepBoth']), applyToRest: z.boolean() }).strict();
const queueId = z.union([sessionId, z.null()]);

const INVALID: SftpResult<never> = { ok: false, error: 'invalid' };

export function createSftpHandlers(service: SftpService) {
  const run = async (id: unknown, op: SftpOp): Promise<SftpResult<unknown>> => {
    const s = sessionId.safeParse(id);
    return s.success ? service.op(s.data, op) : INVALID;
  };
  const queueOp = async (id: unknown, op: SftpOp): Promise<{ ok: boolean }> => {
    const q = queueId.safeParse(id);
    if (!q.success) return { ok: false };
    const r = await service.op(q.data, op);
    return { ok: r.ok && r.value !== false };
  };
  return {
    connect: async (hostId: unknown, initialPath: unknown, opts?: unknown) => {
      if (!uuid.safeParse(hostId).success || (initialPath !== undefined && initialPath !== null && !validRemotePath(initialPath))) return { ok: false as const, error: 'unknown' as const };
      const o = z.object({ plain: z.boolean().optional() }).strict().optional().nullable().safeParse(opts);
      if (!o.success) return { ok: false as const, error: 'unknown' as const };
      return service.connect(hostId as string, (initialPath ?? undefined) as string | undefined, o.data?.plain ? { plain: true } : {});
    },
    disconnect: async (id: unknown) => (sessionId.safeParse(id).success ? service.disconnect(id as string) : { ok: false }),
    sessions: async () => service.snapshot(),
    answer: async (raw: unknown) => {
      const p = answer.safeParse(raw);
      if (!p.success) return { ok: false };
      const { sessionId: id, ...rest } = p.data;
      return service.answer({ cellId: id, ...rest } as SshPromptAnswer);
    },
    list: (id: unknown, path: unknown) => (remotePath.safeParse(path).success ? run(id, { op: 'list', path: path as string }) : INVALID),
    stat: (id: unknown, path: unknown) => (remotePath.safeParse(path).success ? run(id, { op: 'stat', path: path as string }) : INVALID),
    realpath: (id: unknown, path: unknown) => (typeof path === 'string' && (path === '.' || validRemotePath(path)) ? run(id, { op: 'realpath', path }) : INVALID),
    mkdir: (id: unknown, path: unknown) => (remotePath.safeParse(path).success ? run(id, { op: 'mkdir', path: path as string }) : INVALID),
    rename: (id: unknown, from: unknown, to: unknown) => (remotePath.safeParse(from).success && remotePath.safeParse(to).success ? run(id, { op: 'rename', from: from as string, to: to as string }) : INVALID),
    deleteCount: (id: unknown, paths: unknown) => { const p = remotePaths.safeParse(paths); return p.success ? run(id, { op: 'deleteCount', paths: p.data }) : INVALID; },
    delete: (id: unknown, paths: unknown, confirmed: unknown) => {
      const p = remotePaths.safeParse(paths), c = count.safeParse(confirmed);
      return p.success && c.success ? run(id, { op: 'delete', paths: p.data, confirmed: c.data }) : INVALID;
    },
    enqueue: async (id: unknown, req: unknown): Promise<SftpResult<unknown>> => {
      const q = queueId.safeParse(id), r = transfer.safeParse(req);
      if (!q.success || !r.success || (q.data === null) !== isLocalDirection(r.data.direction)) return INVALID;
      return service.op(q.data, { op: 'enqueue', req: r.data as TransferRequest });
    },
    cancel: (id: unknown, target: unknown) => { const t = cancelTarget.safeParse(target); return t.success ? queueOp(id, { op: 'cancel', ...t.data }) : Promise.resolve({ ok: false }); },
    answerConflict: (id: unknown, itemId: unknown, a: unknown) => {
      const i = uuid.safeParse(itemId), c = conflictAnswer.safeParse(a);
      return i.success && c.success ? queueOp(id, { op: 'answerConflict', itemId: i.data, answer: c.data }) : Promise.resolve({ ok: false });
    },
    retry: (id: unknown, itemIds: unknown) => { const i = z.array(uuid).min(1).max(SFTP_LIMITS.paths).safeParse(itemIds); return i.success ? queueOp(id, { op: 'retry', itemIds: i.data }) : Promise.resolve({ ok: false }); },
    clearFinished: (id: unknown) => queueOp(id, { op: 'clearFinished' }),
    chmodCount: (id: unknown, paths: unknown, recursive: unknown) => {
      const p = remotePaths.safeParse(paths);
      return p.success && typeof recursive === 'boolean' ? run(id, { op: 'chmodCount', paths: p.data, recursive }) : INVALID;
    },
    chmod: (id: unknown, req: unknown) => { const r = chmodRequest.safeParse(req); return r.success ? run(id, { op: 'chmod', req: r.data }) : INVALID; },
    cancelOp: async (id: unknown, opId: unknown) => {
      if (!uuid.safeParse(opId).success) return { ok: false };
      const r = await run(id, { op: 'cancelOp', opId: opId as string });
      return { ok: r.ok && r.value === true };
    },
    statFile: (id: unknown, path: unknown) => (remotePath.safeParse(path).success ? run(id, { op: 'statFile', path: path as string }) : INVALID),
    readFile: (id: unknown, path: unknown) => (remotePath.safeParse(path).success ? run(id, { op: 'readFile', path: path as string }) : INVALID),
    writeFile: (id: unknown, path: unknown, save: unknown) => (remotePath.safeParse(path).success && validEditorSave(save)
      ? run(id, { op: 'writeFile', path: path as string, save: { text: save.text, baseline: save.baseline, encoding: save.encoding, expected: cleanStamp(save.expected), ...(save.allowOwnerChange ? { allowOwnerChange: true } : {}) } })
      : INVALID),
    pinHosts: (hostIds: unknown) => { const h = z.array(uuid).max(200).safeParse(hostIds); if (h.success) service.pinHosts(h.data); },
    viewOpened: () => service.viewOpened(),
    viewClosed: () => service.viewClosed(),
  };
}

export type SftpHandlers = ReturnType<typeof createSftpHandlers>;

export function registerSftpIpc(guard: IpcGuard, h: SftpHandlers): void {
  const no = () => ({ ok: false });
  const invalid = () => INVALID;
  guard.guardedHandle('sftp:connect', (_e, hostId: unknown, initialPath: unknown, opts: unknown) => h.connect(hostId, initialPath, opts), () => ({ ok: false, error: 'unknown' }));
  guard.guardedHandle('sftp:disconnect', (_e, id: unknown) => h.disconnect(id), no);
  guard.guardedHandle('sftp:sessions', () => h.sessions(), () => ({ sessions: [], prompts: [] }));
  guard.guardedHandle('sftp:prompt:answer', (_e, a: unknown) => h.answer(a), no);
  guard.guardedHandle('sftp:list', (_e, id: unknown, path: unknown) => h.list(id, path), invalid);
  guard.guardedHandle('sftp:stat', (_e, id: unknown, path: unknown) => h.stat(id, path), invalid);
  guard.guardedHandle('sftp:realpath', (_e, id: unknown, path: unknown) => h.realpath(id, path), invalid);
  guard.guardedHandle('sftp:mkdir', (_e, id: unknown, path: unknown) => h.mkdir(id, path), invalid);
  guard.guardedHandle('sftp:rename', (_e, id: unknown, from: unknown, to: unknown) => h.rename(id, from, to), invalid);
  guard.guardedHandle('sftp:deleteCount', (_e, id: unknown, paths: unknown) => h.deleteCount(id, paths), invalid);
  guard.guardedHandle('sftp:delete', (_e, id: unknown, paths: unknown, confirmed: unknown) => h.delete(id, paths, confirmed), invalid);
  guard.guardedHandle('sftp:enqueue', (_e, id: unknown, req: unknown) => h.enqueue(id, req), invalid);
  guard.guardedHandle('sftp:cancel', (_e, id: unknown, target: unknown) => h.cancel(id, target), no);
  guard.guardedHandle('sftp:answerConflict', (_e, id: unknown, itemId: unknown, a: unknown) => h.answerConflict(id, itemId, a), no);
  guard.guardedHandle('sftp:retry', (_e, id: unknown, itemIds: unknown) => h.retry(id, itemIds), no);
  guard.guardedHandle('sftp:clearFinished', (_e, id: unknown) => h.clearFinished(id), no);
  guard.guardedHandle('sftp:chmodCount', (_e, id: unknown, paths: unknown, recursive: unknown) => h.chmodCount(id, paths, recursive), invalid);
  guard.guardedHandle('sftp:chmod', (_e, id: unknown, req: unknown) => h.chmod(id, req), invalid);
  guard.guardedHandle('sftp:cancelOp', (_e, id: unknown, opId: unknown) => h.cancelOp(id, opId), no);
  guard.guardedHandle('sftp:statFile', (_e, id: unknown, path: unknown) => h.statFile(id, path), invalid);
  guard.guardedHandle('sftp:readFile', (_e, id: unknown, path: unknown) => h.readFile(id, path), invalid);
  guard.guardedHandle('sftp:writeFile', (_e, id: unknown, path: unknown, save: unknown) => h.writeFile(id, path, save), invalid);
  guard.guardedOn('sftp:pinHosts', (_e, hostIds: unknown) => h.pinHosts(hostIds));
  guard.guardedOn('sftp:viewOpened', () => h.viewOpened());
  guard.guardedOn('sftp:viewClosed', () => h.viewClosed());
}
