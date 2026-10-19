// Redis through the main chain (1.0.0): DbService + the real DB Host + the DB vault + the SSH coordinator against the in-process
// RESP server (database password prompt and "remember", DB index in the session state, reconnect reporting, test connection),
// and the zod validation of the db:redis channel.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbHost } from '../src/dbhost/host';
import { createDbHandlers } from '../src/main/db/ipc';
import { redisDeadline } from '../src/main/dbHostClient';
import { DbService } from '../src/main/db/service';
import { DbVault } from '../src/main/db/vault';
import { SshCoordinator } from '../src/main/ssh/coordinator';
import { KnownHostsStore } from '../src/main/ssh/knownHosts';
import { SshVault } from '../src/main/ssh/vault';
import { upsertDbConnection, type DbConnection, type DbPrompt, type DbSessionState } from '../src/shared/db';
import type { DbHostOp, DbHostToMain, MainToDbHost } from '../src/shared/dbHostIpc';
import { defaultState } from '../src/shared/state';
import type { AppState } from '../src/shared/types';
import { waitFor } from './helpers/dbHarness';
import { startRespServer, type RespServer } from './helpers/respServer';
import { fakeCipher } from './helpers/sshKeys';

let dir: string;
let servers: RespServer[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-redis-main-')); });
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

const CONN_ID = '00000000-0000-4000-8000-0000000000dd';

function chain(conn: Omit<DbConnection, 'id' | 'createdAt' | 'updatedAt'>) {
  const dbVault = new DbVault(join(dir, 'db', 'vault.json'), fakeCipher());
  let state: AppState = upsertDbConnection(defaultState(), { ...conn, id: CONN_ID, createdAt: 0, updatedAt: 0 });
  const sessions: DbSessionState[] = [];
  const prompts: Array<{ id: string; prompt: DbPrompt | null }> = [];
  let host!: DbHost;
  let service!: DbService<AppState>;
  const coordinator = new SshCoordinator({
    state: () => state, vault: new SshVault(join(dir, 'ssh-vault.json'), fakeCipher()), knownHosts: new KnownHostsStore(join(dir, 'known_hosts.json')),
    host: (m) => { void host.handle(m as MainToDbHost); return true; },
    events: { session: (st) => service.onCoordinatorSession(st), prompt: (id, p) => service.onPrompt(id, p), vaultChanged: () => undefined },
  });
  host = new DbHost({ toMain: (m: DbHostToMain) => service.onHostMessage(m), toRenderer: () => undefined }, { killGraceMs: 300, dbConnectMs: 5000 });
  service = new DbService<AppState>({
    coordinator, vault: dbVault, state: () => state, change: (fn) => { state = fn(state); },
    host: { ensure: () => true, running: () => true, send: (m) => { void host.handle(m); return true; }, request: async (id, op) => host.op(id, op) },
    sshHostExists: () => false, readCa: async () => null,
    events: { session: (st) => sessions.push(st), prompt: (id, p) => prompts.push({ id, prompt: p }), hostCrashed: () => undefined, vaultChanged: () => undefined },
    defer: (fn) => setImmediate(fn),
  });
  const open = (id: string) => [...prompts].reverse().find((p) => p.id === id)?.prompt ?? null;
  const last = (id: string) => sessions.filter((x) => x.id === id).at(-1);
  return { service, dbVault, sessions, open, last, host };
}

describe('Redis through DbService', () => {
  it('asks for the password, saves it when asked, follows SELECT and reports a reconnect in the session state', async () => {
    const s = await startRespServer({ password: 'redis-pw' });
    servers.push(s);
    const c = chain({ kind: 'redis', name: 'cache', host: '127.0.0.1', port: s.port, user: '', dbIndex: 2, tls: 'disable', ssh: null, readOnly: false });
    const r = c.service.connect(CONN_ID);
    if (!r.ok) throw new Error(r.error);
    const id = r.sessionId;
    expect(c.sessions[0]).toMatchObject({ id, kind: 'redis', state: 'connecting', database: '2' });
    await waitFor(() => c.open(id)?.kind === 'dbPassword');
    expect(c.open(id)).toMatchObject({ kind: 'dbPassword', connectionName: 'cache', user: '', endpoint: `127.0.0.1:${s.port}/2`, canSave: true, retry: false });
    c.service.answer({ sessionId: id, promptId: c.open(id)!.id, values: ['redis-pw'], remember: true });
    await waitFor(() => c.last(id)?.state === 'connected', 10000);
    expect(c.last(id)).toMatchObject({ kind: 'redis', database: '2', serverVersion: '7.2.4' });
    expect(c.last(id)?.tx).toBeUndefined();
    const saved = c.dbVault.password(CONN_ID);
    expect(saved.ok && saved.password).toBe('redis-pw');

    expect(await c.service.op(id, { op: 'redis', req: { kind: 'select', index: 7 } })).toEqual({ ok: true, value: 7 });
    expect(c.last(id)?.database).toBe('7');
    // A Postgres operation on a Redis session is refused.
    expect(await c.service.op(id, { op: 'schemas' })).toEqual({ ok: false, error: 'invalid' });

    s.dropClients();
    await waitFor(() => c.sessions.some((x) => x.id === id && x.reconnecting === 1));
    expect(c.sessions.find((x) => x.id === id && x.reconnecting === 1)).toMatchObject({ state: 'connecting', phase: 'database' });
    expect(await c.service.op(id, { op: 'redis', req: { kind: 'databases' } })).toEqual({ ok: false, error: 'notConnected' });
    await waitFor(() => c.last(id)?.state === 'connected', 10000);
    expect(c.last(id)?.reconnecting).toBeUndefined();
    expect(c.last(id)?.database).toBe('7');
    const after = await c.service.op(id, { op: 'redis', req: { kind: 'databases' } });
    expect(after).toMatchObject({ ok: true, value: { current: 7 } });
    await c.service.disconnect(id);
    await waitFor(() => s.connections() === 0);
  });

  it('tests a Redis connection (and a wrong password)', async () => {
    const s = await startRespServer({ password: 'pw' });
    servers.push(s);
    const c = chain({ kind: 'redis', name: 'x', host: '127.0.0.1', port: s.port, user: '', dbIndex: 0, tls: 'disable', ssh: null, readOnly: false });
    const input = { kind: 'redis' as const, name: 'form', host: '127.0.0.1', port: s.port, user: '', dbIndex: 0, tls: 'disable' as const, ssh: null, readOnly: false };
    expect(await c.service.testConnection(input, { set: 'pw' })).toMatchObject({ ok: true, serverVersion: '7.2.4' });
    const bad = c.service.testConnection(input, { set: 'nope' });
    await waitFor(() => c.sessions.some((x) => x.test) && [...c.sessions].reverse().some((x) => c.open(x.id)?.kind === 'dbPassword'));
    const sid = [...c.sessions].reverse().find((x) => c.open(x.id)?.kind === 'dbPassword')!.id;
    expect(c.open(sid)).toMatchObject({ retry: true, canSave: false });
    c.service.answer({ sessionId: sid, promptId: c.open(sid)!.id, cancel: true });
    expect(await bad).toEqual({ ok: false, error: 'cancelled' });
  });
});

describe('db:redis IPC validation', () => {
  const SID = 'db:00000000-0000-4000-8000-000000000001';
  function handlers() {
    const calls: Array<{ id: string; op: DbHostOp }> = [];
    const service = { op: async (id: string, op: DbHostOp) => { calls.push({ id, op }); return { ok: true, value: 1 }; } } as unknown as DbService;
    return { h: createDbHandlers(service), calls };
  }

  it('passes valid operations on as { op: "redis", req }', async () => {
    const { h, calls } = handlers();
    const valid: unknown[] = [
      { kind: 'scan', req: { cursor: '0', match: 'user:*', count: 100, type: 'hash', limit: 500, details: true } },
      { kind: 'read', req: { type: 'string', key: { b64: 'AP8=' }, offset: 10, maxBytes: 1000 } },
      { kind: 'read', req: { type: 'zset', key: 'z', start: 0, count: 50, rev: true } },
      { kind: 'read', req: { type: 'zset', key: 'z', cursor: '0', count: 50 } },
      { kind: 'read', req: { type: 'stream', key: 's', start: '(1-0', end: '+', count: 10 } },
      { kind: 'readItem', req: { type: 'stream', key: 's', id: '1-0', field: 'f' } },
      { kind: 'write', write: { op: 'zadd', key: 'z', entries: [['m', '-inf'], ['n', '1.5e3']], mode: 'xx' } },
      { kind: 'write', write: { op: 'create', key: 'k', value: { type: 'hash', entries: [['f', 'v']] }, ttlMs: 1000 } },
      { kind: 'write', write: { op: 'xadd', key: 's', id: '5-*', fields: [['a', 'b']] } },
      { kind: 'command', req: { argv: ['SET', 'k', { b64: 'AP8=' }], readWrite: true, timeoutMs: 1000 } },
      { kind: 'subscribe', channels: ['a', { b64: 'AA==' }], patterns: ['x*'] },
      { kind: 'publish', channel: 'c', message: 'm' },
      { kind: 'deletePattern', token: '00000000-0000-4000-8000-000000000009' },
      { kind: 'info', section: 'keyspace' },
    ];
    for (const req of valid) expect(await h.redis(SID, req), JSON.stringify(req)).toEqual({ ok: true, value: 1 });
    expect(calls.map((c) => c.op)).toEqual(valid.map((req) => ({ op: 'redis', req })));
  });

  it('refuses malformed operations without calling the service', async () => {
    const { h, calls } = handlers();
    const invalid: unknown[] = [
      { kind: 'scan', req: { cursor: 'abc' } },
      { kind: 'scan', req: { cursor: '0', limit: 100000 } },
      { kind: 'scan', req: { cursor: '0', extra: 1 } },
      { kind: 'read', req: { type: 'string', key: { b64: 'not base64!' } } },
      { kind: 'read', req: { type: 'stream', key: 's', start: 'abc', end: '+', count: 10 } },
      { kind: 'read', req: { type: 'list', key: 'l', start: -1, count: 10 } },
      { kind: 'write', write: { op: 'flushall' } },
      { kind: 'write', write: { op: 'zadd', key: 'z', entries: [['m', 'NaN']] } },
      { kind: 'write', write: { op: 'expire', key: 'k', ttlMs: 0 } },
      { kind: 'write', write: { op: 'delete', keys: [] } },
      { kind: 'command', req: { argv: [{ b64: 'AA==' }] } },
      { kind: 'command', req: { argv: [] } },
      { kind: 'info', section: 'a b' },
      { kind: 'nope' },
      { op: 'schemas' },
    ];
    for (const req of invalid) expect(await h.redis(SID, req), JSON.stringify(req)).toEqual({ ok: false, error: 'invalid' });
    expect(await h.redis('sftp:00000000-0000-4000-8000-000000000001', { kind: 'databases' })).toEqual({ ok: false, error: 'invalid' });
    // The Postgres channel does not take Redis operations.
    expect(await h.pg(SID, { op: 'redis', req: { kind: 'databases' } })).toEqual({ ok: false, error: 'invalid' });
    expect(calls).toEqual([]);
  });

  it('limits bytes, not characters: per value and for the whole request', async () => {
    const { h, calls } = handlers();
    // 600k two-byte characters: under the 1 MB name limit in characters, over it in bytes.
    expect(await h.redis(SID, { kind: 'keyInfo', keys: ['ż'.repeat(600_000)] })).toEqual({ ok: false, error: 'invalid' });
    const big = 'x'.repeat(40 * 1024 * 1024);
    expect(await h.redis(SID, { kind: 'write', write: { op: 'rpush', key: 'l', items: [big, big] } })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.redis(SID, { kind: 'command', req: { argv: ['MSET', 'a', big, 'b', big] } })).toEqual({ ok: false, error: 'invalid' });
    expect(calls).toEqual([]);
    expect(await h.redis(SID, { kind: 'write', write: { op: 'rpush', key: 'l', items: [big], existing: true } })).toEqual({ ok: true, value: 1 });
  });

  it('Redis operations carry a deadline before main gives up', () => {
    expect(redisDeadline(1_000_000, 120_000)).toBe(1_000_000 + 110_000);
    expect(redisDeadline(0, 5000)).toBe(4500);
    expect(redisDeadline(0, 500)).toBe(1000);
  });
});
