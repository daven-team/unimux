// Drives the DB Host core in-process (1.0.0): what main would send, what it gets back, and the DB port's messages collected
// per run. Used by the PGlite, fake-server and SSH tunnel integration tests.
import { randomUUID } from 'node:crypto';
import { connect, createServer, type Socket } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { DbHost, type DbHostTimers } from '../../src/dbhost/host';
import type { RedisLimits } from '../../src/dbhost/redisSession';
import { dbSessionId, type DbColumn, type DbErrorCode, type DbPortMessage, type DbQueryRequest, type DbResult, type DbServerError, type DbTablePageRequest, type DbValue } from '../../src/shared/db';
import type { DbHostOp, DbHostToMain, DbOpenConfig } from '../../src/shared/dbHostIpc';

export async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export interface Pglite { db: PGlite; server: PGLiteSocketServer; port: number; close(): Promise<void> }

export async function startPglite(): Promise<Pglite> {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 100 });
  await server.start();
  const port = Number(server.getServerConn().split(':').pop());
  return { db, server, port, close: async () => { await server.stop(); await db.close(); } };
}

/**
 * A TCP proxy in front of a server that hands every backend message to the client in a write of its own and holds each
 * ReadyForQuery back a little: what a server in another process does over a real socket (PGlite's socket server writes an
 * error and its extra ReadyForQuery separately, so they can arrive in different reads). In-process, they usually coalesce.
 */
export async function splittingProxy(targetPort: number): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.add(client); sockets.add(upstream);
    client.setNoDelay(true);
    client.pipe(upstream);
    let buf = Buffer.alloc(0);
    let chain = Promise.resolve();
    upstream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const messages: Buffer[] = [];
      while (buf.length >= 5 && buf.length >= 1 + buf.readInt32BE(1)) {
        const len = 1 + buf.readInt32BE(1);
        messages.push(buf.subarray(0, len));
        buf = buf.subarray(len);
      }
      for (const m of messages) {
        chain = chain.then(async () => {
          if (m[0] === 0x5a) await new Promise((r) => setTimeout(r, 15));
          else await new Promise((r) => setImmediate(r));
          if (!client.destroyed) client.write(m);
        });
      }
    });
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('close', end); upstream.on('close', end);
    client.on('error', end); upstream.on('error', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }) };
}

export interface StatementResult { columns: DbColumn[]; rows: DbValue[][]; end?: Extract<DbPortMessage, { t: 'statementEnd' }>; error?: { code: DbErrorCode; server?: DbServerError }; closed: boolean; span?: { start: number; end: number } }
export interface RunResult { statements: StatementResult[]; end: Extract<DbPortMessage, { t: 'queryEnd' }>; notices: string[] }

export const BASE_CONFIG: DbOpenConfig = { kind: 'postgres', host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres', tls: 'disable', readOnly: false, ssh: null };

export function dbHarness(opts: { timers?: Partial<DbHostTimers>; onMain?: (m: DbHostToMain, host: DbHost) => boolean; autoPassword?: string | null; redisLimits?: Partial<RedisLimits> } = {}) {
  const toMain: DbHostToMain[] = [];
  const port: DbPortMessage[] = [];
  const results = new Map<number, DbResult<unknown>>();
  let reqId = 0;
  const host: DbHost = new DbHost({
    toMain: (m) => {
      toMain.push(m);
      if (m.t === 'dbResult') results.set(m.reqId, m.result);
      if (opts.onMain?.(m, host)) return;
      if (m.t === 'sshHostKey') void host.handle({ t: 'sshHostKeyAnswer', id: m.id, promptId: m.promptId, accept: true });
      if (m.t === 'dbPasswordPrompt' && opts.autoPassword !== undefined) void host.handle({ t: 'dbPasswordAnswer', id: m.id, promptId: m.promptId, value: opts.autoPassword });
    },
    toRenderer: (m) => port.push(m),
  }, { killGraceMs: 300, dbConnectMs: 5000, ...opts.timers }, opts.redisLimits);

  const statuses = (id: string) => toMain.flatMap((m) => (m.t === 'dbStatus' && m.id === id ? [m] : []));
  const last = (id: string) => statuses(id).at(-1);
  const open = async (config: Partial<DbOpenConfig>, id = dbSessionId(randomUUID()), wait = true) => {
    await host.handle({ t: 'dbOpen', id, config: { ...BASE_CONFIG, ...config } });
    if (wait) await waitFor(() => ['connected', 'error', 'closed'].includes(last(id)?.phase ?? ''), 15000);
    return id;
  };
  const op = async <T>(id: string, o: DbHostOp): Promise<DbResult<T>> => {
    const n = ++reqId;
    await host.handle({ t: 'dbOp', reqId: n, id, op: o });
    await waitFor(() => results.has(n), 15000);
    return results.get(n) as DbResult<T>;
  };
  const value = async <T>(id: string, o: DbHostOp): Promise<T> => {
    const r = await op<T>(id, o);
    if (!r.ok) throw new Error(`${o.op} failed: ${r.error} ${r.server?.message ?? ''}`);
    return r.value;
  };
  const collect = (queryId: string): RunResult => {
    const statements: StatementResult[] = [];
    const at = (i: number) => (statements[i] ??= { columns: [], rows: [], closed: false });
    let end: RunResult['end'] | undefined;
    const notices: string[] = [];
    for (const m of port) {
      if (!('queryId' in m) || m.queryId !== queryId) continue;
      switch (m.t) {
        case 'statement': at(m.index).span = { start: m.start, end: m.end }; break;
        case 'columns': at(m.index).columns = m.columns; break;
        case 'rows': at(m.index).rows.push(...m.rows); break;
        case 'statementEnd': at(m.index).end = m; break;
        case 'statementError': at(m.index).error = { code: m.error, ...(m.server ? { server: m.server } : {}) }; break;
        case 'resultClosed': at(m.index).closed = true; break;
        case 'notice': notices.push(m.message); break;
        case 'queryEnd': end = m; break;
      }
    }
    return { statements, end: end!, notices };
  };
  const ended = (queryId: string) => port.some((m) => m.t === 'queryEnd' && m.queryId === queryId);
  const run = async (id: string, req: Omit<DbQueryRequest, 'queryId'>, wait = true): Promise<RunResult & { queryId: string }> => {
    const queryId = randomUUID();
    const r = await op(id, { op: 'query', req: { ...req, queryId } });
    if (!r.ok) throw new Error(`query refused: ${r.error}`);
    if (wait) await waitFor(() => ended(queryId), 15000);
    return { ...collect(queryId), queryId };
  };
  const page = async (id: string, req: Omit<DbTablePageRequest, 'queryId'>): Promise<RunResult> => {
    const queryId = randomUUID();
    const r = await op(id, { op: 'tablePage', req: { ...req, queryId } });
    if (!r.ok) throw new Error(`page refused: ${r.error}`);
    await waitFor(() => ended(queryId), 15000);
    return collect(queryId);
  };
  /** The next rows of an open result; waits for its statementEnd (or error). */
  const more = async (id: string, queryId: string, count: number) => {
    const before = port.filter((m) => 'queryId' in m && m.queryId === queryId && (m.t === 'statementEnd' || m.t === 'statementError')).length;
    const r = await op(id, { op: 'fetchMore', queryId, count });
    if (!r.ok) return r;
    await waitFor(() => port.filter((m) => 'queryId' in m && m.queryId === queryId && (m.t === 'statementEnd' || m.t === 'statementError')).length > before);
    return r;
  };
  return { host, toMain, port, statuses, last, open, op, value, run, page, more, collect, ended };
}
