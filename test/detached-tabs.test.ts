// Database, Redis and remote file tabs in their own window (1.0.8): which window's DB port gets a result, what a moving tab
// takes along, how such a tab is opened again after a restart, the unsaved work a detached window reports, the tabs it opens in
// the main window, and the per-window pins of DB and SFTP sessions in main.
import { describe, expect, it } from 'vitest';
import {
  cleanOpenInMain, cleanTarget, cleanWork, handoffSessions, hasWork, normalizeDetachedWindows, routeMessage, splitHandoffs, sumWork,
} from '../src/shared/detached';
import { DB_ROUTE_QUERIES_MAX, DbPortRoutes, MAIN_DB_WINDOW, pickPort } from '../src/shared/dbPortRoutes';
import { dbTabId, type DbTabRef } from '../src/shared/dbTabs';
import { redisTabId, type RedisTabRef } from '../src/shared/redisView';
import type { DbPortMessage, DbSessionState } from '../src/shared/db';
import { DbService } from '../src/main/db/service';
import { SftpService } from '../src/main/sftp/service';
import { createDbHandlers } from '../src/main/db/ipc';
import { createSftpHandlers } from '../src/main/sftp/ipc';
import type { DbHostOp } from '../src/shared/dbHostIpc';

const CONN = '00000000-0000-4000-8000-0000000000c1';
const HOST = '00000000-0000-4000-8000-0000000000a1';
const UID = '00000000-0000-4000-8000-0000000000d1';
const W1 = 'f2b8a1c4-0000-4000-8000-000000000001';
const W2 = 'f2b8a1c4-0000-4000-8000-000000000002';
const S1 = 'db:00000000-0000-4000-8000-0000000000e1';
const S2 = 'db:00000000-0000-4000-8000-0000000000e2';

const rows = (queryId: string): DbPortMessage => ({ t: 'rows', queryId, index: 0, rows: [['1']] });
const pubsub = (sessionId: string): DbPortMessage => ({ t: 'redisPubSubState', sessionId, state: { channels: [], patterns: [], connected: true } as never });

describe('DB port routes', () => {
  it('sends a query, a table page and a later "load more" to the window that asked for each', () => {
    const r = new DbPortRoutes();
    r.noteOp(S1, { op: 'query', req: { queryId: 'q1', sql: 'select 1' } }, W1);
    r.noteOp(S1, { op: 'tablePage', req: { queryId: 'q2', schema: 'public', table: 't', limit: 10 } }, undefined);
    expect(r.target(rows('q1'))).toBe(W1);
    expect(r.target(rows('q2'))).toBe(MAIN_DB_WINDOW);
    expect(r.target(rows('unknown'))).toBe(MAIN_DB_WINDOW);
    // The tab moved: its "Wczytaj więcej" comes from the other window and the rows follow.
    r.noteOp(S1, { op: 'fetchMore', queryId: 'q1', count: 100 }, W2);
    expect(r.target(rows('q1'))).toBe(W2);
    r.noteOp(S1, { op: 'fetchMore', queryId: 'q1', count: 100 }, 'main');
    expect(r.target(rows('q1'))).toBe(MAIN_DB_WINDOW);
  });

  it('routes Pub/Sub by session: the subscribing window, a moved tab, a closed session', () => {
    const r = new DbPortRoutes();
    r.noteOp(S1, { op: 'redis', req: { kind: 'subscribe', channels: ['a'] } }, W1);
    // Reads of keys do not move the session's messages.
    r.noteOp(S1, { op: 'redis', req: { kind: 'databases' } }, W2);
    expect(r.target(pubsub(S1))).toBe(W1);
    r.moveSessions([S1, S2], W2);
    expect(r.target(pubsub(S1))).toBe(W2);
    expect(r.target(pubsub(S2))).toBe(W2);
    r.moveSessions([S1], null);
    expect(r.target(pubsub(S1))).toBe(MAIN_DB_WINDOW);
    r.forgetSession(S2);
    expect(r.target(pubsub(S2))).toBe(MAIN_DB_WINDOW);
  });

  it('keeps a bounded number of query routes (the oldest go first)', () => {
    const r = new DbPortRoutes(3);
    for (const q of ['a', 'b', 'c', 'd']) r.noteOp(S1, { op: 'query', req: { queryId: q, sql: 'x' } }, W1);
    expect(r.target(rows('a'))).toBe(MAIN_DB_WINDOW);
    expect(r.target(rows('d'))).toBe(W1);
    expect(DB_ROUTE_QUERIES_MAX).toBeGreaterThan(1000);
  });

  it('picks the window port, else the main one (a closed window drops nothing into nowhere)', () => {
    const ports = new Map([[MAIN_DB_WINDOW, 'main-port'], [W1, 'w1-port']]);
    expect(pickPort(ports, W1)).toBe('w1-port');
    expect(pickPort(ports, W2)).toBe('main-port');
    expect(pickPort(new Map<string, string>(), W2)).toBeUndefined();
  });
});

describe('detached database, Redis and remote targets', () => {
  const tableRef: DbTabRef = { kind: 'table', connectionId: CONN, database: 'shop', schema: 'public', table: 'users', objectKind: 'table' };
  const sqlRef: DbTabRef = { kind: 'sql', connectionId: CONN, database: 'shop', uid: UID };
  const redisRef: RedisTabRef = { kind: 'redis', view: 'keys', connectionId: CONN, db: 2, uid: UID };

  it('keeps the new reopen kinds and refuses broken ones', () => {
    const db = { kind: 'file', fileId: dbTabId(tableRef), projectId: '', name: 'users', reopen: { kind: 'db', ref: tableRef, path: 'prod · shop · public.users' } };
    expect(cleanTarget(db)).toEqual(db);
    const sql = { kind: 'file', fileId: dbTabId(sqlRef), projectId: '', name: 'SQL 1', reopen: { kind: 'db', ref: sqlRef, path: 'prod · shop · SQL 1' } };
    expect(cleanTarget(sql)).toEqual(sql);
    const redis = { kind: 'file', fileId: redisTabId(redisRef), projectId: '', name: 'cache', reopen: { kind: 'redis', ref: redisRef, path: 'cache · Keys · DB 2' } };
    expect(cleanTarget(redis)).toEqual(redis);
    const remote = { kind: 'file', fileId: 'remote-id', projectId: '', name: 'nginx.conf', reopen: { kind: 'remote', hostId: HOST, path: '/etc/nginx/nginx.conf' } };
    expect(cleanTarget(remote)).toEqual(remote);
    expect(cleanTarget({ ...remote, reopen: { kind: 'remote', hostId: HOST, path: 'relative/path' } })).toBeUndefined();
    expect(cleanTarget({ ...remote, reopen: { kind: 'remote', hostId: 'not-a-uuid', path: '/etc/x' } })).toBeUndefined();
    expect(cleanTarget({ ...db, reopen: { kind: 'db', ref: { ...tableRef, connectionId: 'x' }, path: 'p' } })).toBeUndefined();
    expect(cleanTarget({ ...redis, reopen: { kind: 'redis', ref: { ...redisRef, view: 'nope' }, path: 'p' } })).toBeUndefined();
    // A registry with them survives a restart.
    const out = normalizeDetachedWindows([{ id: 'w1', target: db }, { id: 'w2', target: redis }, { id: 'w3', target: remote }], new Map());
    expect(out?.map((w) => w.id)).toEqual(['w1', 'w2', 'w3']);
  });

  it('tells documents and handoffs apart and takes only valid sessions of documents that travel', () => {
    const doc = { id: 'f1', text: '' };
    const handoff = { handoff: 'tab', fileId: 'f1', dbSessions: [S1, 'junk', S1, 42] };
    const stray = { handoff: 'tab', fileId: 'other', dbSessions: [S2] };
    const { docs, handoffs } = splitHandoffs([doc, handoff, stray, 'x']);
    expect(docs).toEqual([doc, 'x']);
    expect(handoffs).toEqual([handoff]);
    expect(handoffSessions(handoffs)).toEqual([S1]);
    expect(handoffSessions([])).toEqual([]);
  });

  it('repairs and sums the work reports of detached windows', () => {
    expect(cleanWork({ tx: 1, staged: 2, redis: 0 })).toEqual({ tx: 1, staged: 2, redis: 0 });
    expect(cleanWork({ tx: 0, staged: 0, redis: 0 })).toBeNull();
    expect(cleanWork({ tx: -1, staged: 1.5, redis: '3' })).toBeNull();
    expect(cleanWork(null)).toBeNull();
    expect(cleanWork({ tx: 1e9 })).toEqual({ tx: 100_000, staged: 0, redis: 0 });
    const sum = sumWork([{ tx: 1, staged: 0, redis: 2 }, { tx: 0, staged: 3, redis: 1 }]);
    expect(sum).toEqual({ tx: 1, staged: 3, redis: 3 });
    expect(hasWork(sum)).toBe(true);
    expect(hasWork(sumWork([]))).toBe(false);
  });

  it('accepts only well-formed tabs to open in the main window', () => {
    expect(cleanOpenInMain({ kind: 'sql', connectionId: CONN, database: 'shop', text: 'select 1' })).toEqual({ kind: 'sql', connectionId: CONN, database: 'shop', text: 'select 1' });
    expect(cleanOpenInMain({ kind: 'redis', connectionId: CONN, view: 'pubsub', db: 0 })).toEqual({ kind: 'redis', connectionId: CONN, view: 'pubsub', db: 0 });
    expect(cleanOpenInMain({ kind: 'redis', connectionId: CONN, view: 'pubsub', db: -1 })).toBeNull();
    expect(cleanOpenInMain({ kind: 'redis', connectionId: CONN, view: 'shell', db: 0 })).toBeNull();
    expect(cleanOpenInMain({ kind: 'sql', connectionId: 'x', database: 'shop', text: '' })).toBeNull();
    expect(cleanOpenInMain({ kind: 'file', connectionId: CONN })).toBeNull();
  });

  it('sends session and prompt events of databases and SFTP to every window', () => {
    for (const channel of ['db:session', 'db:prompt', 'db:hostCrashed', 'db:vault:changed', 'sftp:session', 'sftp:prompt', 'sftp:hostCrashed']) {
      expect(routeMessage(channel, [{}], new Map())).toEqual([{ window: '*', args: [{}] }]);
    }
    // Anything else of the database viewer stays with the main window.
    expect(routeMessage('db:other', [1], new Map())).toEqual([{ window: null, args: [1] }]);
  });
});

describe('per-window pins in main', () => {
  function dbSetup() {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const requests: Array<{ id: string; op: DbHostOp; window?: string }> = [];
    const sessions: DbSessionState[] = [];
    const service = new DbService({
      host: { ensure: () => true, running: () => true, send: () => true, request: async (id, op, window) => { requests.push({ id, op, window }); return { ok: true, value: null }; } },
      vault: { password: () => ({ ok: false }), setPassword: () => ({ ok: true }), clearPassword: () => false, copyPassword: () => false, readOnly: () => false, info: () => ({ storage: 'unavailable', saved: [], locked: [], readOnly: true }), prune: () => false } as never,
      state: () => ({ dbConnections: [{ id: CONN, kind: 'postgres', name: 'p', host: 'h', port: 5432, user: 'u', database: 'd', tls: 'disable', ssh: null, readOnly: false, createdAt: 1, updatedAt: 1 }] }),
      change: () => undefined,
      coordinator: { connectSession: async () => ({ ok: true }), endSession: () => undefined, answer: () => ({ ok: true }), sessionSnapshot: () => ({ sessions: [], prompts: [] }), onHostMessage: () => true, sessionHostCrashed: () => undefined },
      sshHostExists: () => true, readCa: async () => null,
      events: { session: (s) => sessions.push(s), prompt: () => undefined, hostCrashed: () => undefined, vaultChanged: () => undefined },
      now: () => 1, defer: (fn) => fn(),
      setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clearTimer: (t) => { (t as { live: boolean }).live = false; },
    });
    const fire = () => { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); } };
    return { service, requests, sessions, fire, last: (id: string) => sessions.filter((s) => s.id === id).at(-1) };
  }

  it('keeps a DB session while any window pins it; a window that goes away drops only its own pins', async () => {
    const t = dbSetup();
    const r = t.service.connect(CONN);
    if (!r.ok) throw new Error('connect');
    await new Promise((resolve) => setImmediate(resolve));
    t.service.onHostMessage({ t: 'dbStatus', id: r.sessionId, phase: 'connected' });
    t.service.pin([r.sessionId], W1);
    t.service.pin([], 'main');
    t.fire();
    expect(t.last(r.sessionId)?.state).toBe('connected');
    // The main window reloads: the detached window's pin still holds.
    t.service.rendererGone();
    t.fire();
    expect(t.last(r.sessionId)?.state).toBe('connected');
    t.service.rendererGone(W1);
    t.fire();
    expect(t.last(r.sessionId)?.state).toBe('closed');
  });

  it('passes the asking window with every operation (its results go to that window)', async () => {
    const t = dbSetup();
    const h = createDbHandlers(t.service as never);
    const r = t.service.connect(CONN);
    if (!r.ok) throw new Error('connect');
    await new Promise((resolve) => setImmediate(resolve));
    t.service.onHostMessage({ t: 'dbStatus', id: r.sessionId, phase: 'connected' });
    await h.pg(r.sessionId, { op: 'query', req: { queryId: UID, sql: 'select 1' } }, W1);
    await h.redis(r.sessionId, { kind: 'pubsubState' }, W2);
    await h.pg(r.sessionId, { op: 'schemas' });
    expect(t.requests.map((x) => x.window)).toEqual([W1, W2, undefined]);
  });

  it('keeps an SFTP session of a host with unsaved remote tabs in any window', async () => {
    const timers: Array<{ fn: () => void; live: boolean }> = [];
    const sent: unknown[] = [];
    let session: ((s: { cellId: string; hostId: string; phase: 'connected'; since: number }) => void) | null = null;
    const service = new SftpService({
      coordinator: { connectSession: async () => ({ ok: true }), endSession: () => undefined, answer: () => ({ ok: true }), sessionSnapshot: () => ({ sessions: [], prompts: [] }), onHostMessage: () => true, sessionHostCrashed: () => undefined },
      host: { ensure: () => true, running: () => true, send: (m) => { sent.push(m); return true; }, request: async (_id, op) => (op.op === 'realpath' ? { ok: true, value: '/home' } : { ok: true, value: { kind: 'dir' } }) },
      hostExists: () => true,
      events: { session: () => undefined, prompt: () => undefined, hostCrashed: () => undefined },
      now: () => 1, defer: (fn) => fn(),
      setTimer: (fn) => { const t = { fn, live: true }; timers.push(t); return t; },
      clearTimer: (t) => { (t as { live: boolean }).live = false; },
    });
    session = (s) => service.onCoordinatorSession(s);
    const r = await service.connect(HOST, undefined, { plain: true });
    const id = r.ok ? r.sessionId : '';
    session({ cellId: id, hostId: HOST, phase: 'connected', since: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const h = createSftpHandlers(service);
    h.pinHosts([HOST], W1);
    h.pinHosts([], 'main');
    expect(timers.filter((t) => t.live)).toEqual([]);
    // A detached window cannot close the main window's SFTP view; its page going away drops its pins.
    service.rendererGone(W1);
    const live = timers.filter((t) => t.live);
    expect(live).toHaveLength(1);
    live[0].fn();
    expect(sent).toEqual([{ t: 'sftpDisconnect', id }]);
  });
});
