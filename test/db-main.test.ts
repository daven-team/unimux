// Main side of the database viewer (1.0.0) with a fake DB Host link and a fake coordinator: saved connections and their
// passwords, opening sessions (what the DB Host gets), states, the database password prompt, the idle disconnect and pins,
// a DB Host restart, and the IPC validation in front of it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbHandlers } from '../src/main/db/ipc';
import { DbService, strictConnection } from '../src/main/db/service';
import { DbVault } from '../src/main/db/vault';
import type { DbHostLink } from '../src/main/dbHostClient';
import type { DbConnection, DbConnectionInput, DbPrompt, DbResult, DbSessionState, DbStateLike } from '../src/shared/db';
import type { DbHostOp, MainToDbHost } from '../src/shared/dbHostIpc';
import type { SshPromptAnswer, SshSessionState } from '../src/shared/ssh';
import { fakeCipher } from './helpers/sshKeys';

const HOST = '00000000-0000-4000-8000-0000000000aa';
const input: DbConnectionInput = { kind: 'postgres', name: 'prod', host: 'db.example.com', port: 5432, user: 'app', database: 'shop', tls: 'disable', ssh: null, readOnly: false };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-dbmain-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(opts: { hostUp?: boolean; sshHosts?: string[]; ca?: string | null; cipher?: Parameters<typeof fakeCipher>[0] } = {}) {
  let state: DbStateLike = { dbConnections: [] };
  const sent: MainToDbHost[] = [];
  const requests: Array<{ id: string; op: DbHostOp }> = [];
  const sessions: DbSessionState[] = [];
  const prompts: Array<{ id: string; prompt: DbPrompt | null }> = [];
  const coordinatorCalls: string[] = [];
  const answers: SshPromptAnswer[] = [];
  let vaultChanges = 0;
  let crashes = 0;
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  let connectResult: { ok: true } | { ok: false; error: 'hostMissing' } = { ok: true };
  const host: DbHostLink = {
    ensure: () => opts.hostUp !== false, running: () => true,
    send: (m) => { sent.push(m); return opts.hostUp !== false; },
    request: async (id, op) => { requests.push({ id, op }); return { ok: true, value: 'answer' } as DbResult<unknown>; },
  };
  const vault = new DbVault(join(dir, 'db', 'vault.json'), fakeCipher(opts.cipher));
  const service = new DbService({
    host, vault,
    state: () => state, change: (fn) => { state = fn(state); },
    coordinator: {
      connectSession: async (r) => { coordinatorCalls.push(`connect ${r.sessionId} ${r.hostId}`); return connectResult; },
      endSession: (id) => { coordinatorCalls.push(`end ${id}`); },
      answer: (a) => { answers.push(a); return { ok: true }; },
      sessionSnapshot: () => ({ sessions: [], prompts: [] }),
      onHostMessage: () => true,
      sessionHostCrashed: (h) => { coordinatorCalls.push(`crashed ${h}`); },
    },
    sshHostExists: (id) => (opts.sshHosts ?? [HOST]).includes(id),
    readCa: async () => (opts.ca === undefined ? 'CA PEM' : opts.ca),
    events: { session: (s) => sessions.push(s), prompt: (id, p) => prompts.push({ id, prompt: p }), hostCrashed: () => { crashes++; }, vaultChanged: () => { vaultChanges++; } },
    now: () => 1000,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { live: boolean }).live = false; },
    defer: (fn) => fn(),
  });
  const flush = () => new Promise((r) => setImmediate(r));
  const fire = (ms: number) => { for (const t of timers.filter((x) => x.live && x.ms === ms)) { t.live = false; t.fn(); } };
  const save = (extra: Partial<DbConnectionInput> = {}, password: Parameters<DbService['saveConnection']>[1] = { keep: true }) => {
    const r = service.saveConnection({ ...input, ...extra }, password);
    if (!r.ok) throw new Error(r.error);
    return r.connection;
  };
  const last = (id: string) => sessions.filter((s) => s.id === id).at(-1);
  return {
    service, vault, sent, requests, sessions, prompts, coordinatorCalls, answers, timers, flush, fire, save, last,
    state: () => state, vaultChanges: () => vaultChanges, crashes: () => crashes, failConnect: () => { connectResult = { ok: false, error: 'hostMissing' }; },
  };
}

describe('DbService: saved connections', () => {
  it('saves, updates, duplicates (with the password) and deletes connections; passwords go to the vault only', () => {
    const t = setup();
    const c = t.save({}, { set: 'pw1' });
    expect(t.state().dbConnections).toEqual([{ ...input, id: c.id, createdAt: 1000, updatedAt: 1000 }]);
    expect(JSON.stringify(t.state())).not.toContain('pw1');
    expect(t.vault.password(c.id)).toEqual({ ok: true, password: 'pw1' });
    expect(t.vaultChanges()).toBe(1);
    const updated = t.service.saveConnection({ ...input, id: c.id, name: 'renamed' }, { keep: true });
    expect(updated).toMatchObject({ ok: true, connection: { id: c.id, name: 'renamed' } });
    expect(t.vault.password(c.id).ok).toBe(true);
    const copy = t.service.duplicateConnection(c.id);
    if (!copy.ok) throw new Error('duplicate');
    expect(copy.connection.name).toBe('renamed (2)');
    expect(t.vault.password(copy.connection.id)).toEqual({ ok: true, password: 'pw1' });
    expect(t.service.saveConnection({ ...input, id: c.id }, { clear: true }).ok).toBe(true);
    expect(t.vault.password(c.id).ok).toBe(false);
    expect(t.service.deleteConnection(copy.connection.id)).toEqual({ ok: true });
    expect(t.vault.password(copy.connection.id).ok).toBe(false);
    expect(t.state().dbConnections?.map((x) => x.id)).toEqual([c.id]);
    expect(t.service.deleteConnection(copy.connection.id)).toEqual({ ok: false });
  });

  it('refuses unknown ids, anything the normalizer would change, and password changes on a read-only vault', () => {
    const t = setup();
    expect(t.service.saveConnection({ ...input, id: HOST }, { keep: true })).toEqual({ ok: false, error: 'notFound' });
    expect(t.service.saveConnection({ ...input, port: 0 }, { keep: true })).toEqual({ ok: false, error: 'invalid' });
    expect(t.service.saveConnection({ ...input, tls: 'verify-full' }, { keep: true })).toEqual({ ok: false, error: 'invalid' });
    expect(t.service.saveConnection({ ...input, host: 'DB.example.com' }, { keep: true })).toEqual({ ok: false, error: 'invalid' });
    expect(strictConnection({ ...input, id: HOST, createdAt: 0, updatedAt: 0 })).toMatchObject({ id: HOST });
  });

  it('prunes the vault when connections disappear from the state', () => {
    const t = setup();
    const c = t.save({}, { set: 'x' });
    t.vault.setPassword(HOST, 'orphan');
    t.service.stateChanged();
    expect(t.vault.info().saved).toEqual([c.id]);
  });
});

describe('DbService: sessions', () => {
  it('answers at once with the id, then opens the session in the DB Host with the saved password and the CA', async () => {
    const t = setup();
    const c = t.save({ tls: 'verify-full', caPath: 'C:\\ca.pem', statementTimeoutMs: 5000, readOnly: true }, { set: 'pw' });
    const r = t.service.connect(c.id, { database: 'other' });
    if (!r.ok) throw new Error('connect');
    expect(r.sessionId).toMatch(/^db:/);
    await t.flush();
    expect(t.sent).toEqual([{ t: 'dbOpen', id: r.sessionId, config: {
      kind: 'postgres', host: 'db.example.com', port: 5432, user: 'app', database: 'other', tls: 'verify-full', ca: 'CA PEM', password: 'pw', readOnly: true, statementTimeoutMs: 5000, ssh: null,
    } }]);
    expect(t.sessions[0]).toMatchObject({ id: r.sessionId, connectionId: c.id, state: 'connecting', phase: 'connecting', database: 'other', readOnly: true });
    expect(t.coordinatorCalls).toEqual([]);
    t.service.onHostMessage({ t: 'dbStatus', id: r.sessionId, phase: 'database' });
    t.service.onHostMessage({ t: 'dbStatus', id: r.sessionId, phase: 'connected', serverVersion: '16.4', database: 'other' });
    expect(t.last(r.sessionId)).toMatchObject({ state: 'connected', phase: 'connected', serverVersion: '16.4', tx: 'idle' });
    t.service.onHostMessage({ t: 'dbTx', id: r.sessionId, tx: 'transaction' });
    expect(t.last(r.sessionId)?.tx).toBe('transaction');
    expect(await t.service.op(r.sessionId, { op: 'schemas' })).toEqual({ ok: true, value: 'answer' });
    expect(t.requests).toEqual([{ id: r.sessionId, op: { op: 'schemas' } }]);
    expect(await t.service.disconnect(r.sessionId)).toEqual({ ok: true });
    expect(t.sent.at(-1)).toEqual({ t: 'dbClose', id: r.sessionId });
    expect(t.last(r.sessionId)).toMatchObject({ state: 'closed', phase: 'closed' });
    expect(await t.service.op(r.sessionId, { op: 'schemas' })).toEqual({ ok: false, error: 'noSession' });
  });

  it('fails early for a missing connection, a missing SSH host, an unreadable CA and a DB Host that cannot start', async () => {
    const t = setup({ ca: null });
    expect(t.service.connect(HOST)).toEqual({ ok: false, error: 'connectionMissing' });
    const tunnel = t.save({ ssh: { hostId: '00000000-0000-4000-8000-0000000000ff', dbHost: '127.0.0.1', dbPort: 5432 } });
    expect(t.service.connect(tunnel.id)).toEqual({ ok: false, error: 'hostMissing' });
    const ca = t.save({ tls: 'verify-full', caPath: '/etc/ca.pem' });
    const r = t.service.connect(ca.id);
    if (!r.ok) throw new Error('connect');
    await t.flush();
    expect(t.last(r.sessionId)).toMatchObject({ state: 'error', error: 'caFile' });
    expect(t.sent).toEqual([]);
    const down = setup({ hostUp: false });
    expect(down.service.connect(down.save().id)).toEqual({ ok: false, error: 'dbHostCrashed' });
  });

  it('logs a tunnel in through the coordinator; a coordinator failure or refusal ends the session', async () => {
    const t = setup();
    const c = t.save({ ssh: { hostId: HOST, dbHost: '127.0.0.1', dbPort: 5433 } });
    const r = t.service.connect(c.id);
    if (!r.ok) throw new Error('connect');
    await t.flush();
    expect(t.sent[0]).toMatchObject({ t: 'dbOpen', config: { ssh: { dbHost: '127.0.0.1', dbPort: 5433 } } });
    expect(t.coordinatorCalls).toEqual([`connect ${r.sessionId} ${HOST}`]);
    const err: SshSessionState = { cellId: r.sessionId, hostId: HOST, phase: 'error', since: 1, error: 'hostKeyRejected' };
    t.service.onCoordinatorSession({ ...err, phase: 'authenticating' });
    expect(t.last(r.sessionId)?.state).toBe('connecting');
    t.service.onCoordinatorSession(err);
    expect(t.last(r.sessionId)).toMatchObject({ state: 'error', error: 'hostKeyRejected' });
    expect(t.sent.at(-1)).toEqual({ t: 'dbClose', id: r.sessionId });
    await t.flush();
    expect(t.coordinatorCalls.at(-1)).toBe(`end ${r.sessionId}`);
    t.failConnect();
    const r2 = t.service.connect(c.id);
    if (!r2.ok) throw new Error('connect');
    await t.flush();
    await t.flush();
    expect(t.last(r2.sessionId)).toMatchObject({ state: 'error', error: 'hostMissing' });
  });

  it('asks for the database password, passes the answer on, and saves it only once connected with "remember"', async () => {
    const t = setup();
    const c = t.save();
    const r = t.service.connect(c.id);
    if (!r.ok) throw new Error('connect');
    await t.flush();
    t.service.onHostMessage({ t: 'dbPasswordPrompt', id: r.sessionId, promptId: 'host-prompt-1', retry: false });
    const p = t.prompts.at(-1)!;
    expect(p.prompt).toMatchObject({ kind: 'dbPassword', connectionName: 'prod', user: 'app', endpoint: 'db.example.com:5432/shop', canSave: true, retry: false });
    expect(t.service.snapshot().prompts).toEqual([{ sessionId: r.sessionId, prompt: p.prompt }]);
    expect(t.service.answer({ sessionId: r.sessionId, promptId: p.prompt!.id, values: ['a', 'b'] })).toEqual({ ok: false });
    expect(t.service.answer({ sessionId: r.sessionId, promptId: p.prompt!.id, values: ['typed'], remember: true })).toEqual({ ok: true });
    expect(t.sent.at(-1)).toEqual({ t: 'dbPasswordAnswer', id: r.sessionId, promptId: 'host-prompt-1', value: 'typed' });
    expect(t.prompts.at(-1)).toEqual({ id: r.sessionId, prompt: null });
    expect(t.vault.password(c.id).ok).toBe(false);
    t.service.onHostMessage({ t: 'dbStatus', id: r.sessionId, phase: 'connected' });
    expect(t.vault.password(c.id)).toEqual({ ok: true, password: 'typed' });
    // Another prompt id goes to the coordinator (an SSH question of the tunnel).
    expect(t.service.answer({ sessionId: r.sessionId, promptId: 'other', cancel: true })).toEqual({ ok: true });
    expect(t.answers).toEqual([{ cellId: r.sessionId, promptId: 'other', cancel: true }]);
  });

  it('a prompt nobody answers is cancelled after the timeout; an error ends the session with the server text', async () => {
    const t = setup();
    const r = t.service.connect(t.save().id);
    if (!r.ok) throw new Error('connect');
    await t.flush();
    t.service.onHostMessage({ t: 'dbPasswordPrompt', id: r.sessionId, promptId: 'hp', retry: false });
    t.fire(5 * 60_000);
    expect(t.sent.at(-1)).toEqual({ t: 'dbPasswordAnswer', id: r.sessionId, promptId: 'hp', value: null });
    t.service.onHostMessage({ t: 'dbStatus', id: r.sessionId, phase: 'error', error: 'dbAuth', message: 'password authentication failed' });
    expect(t.last(r.sessionId)).toMatchObject({ state: 'error', error: 'dbAuth', message: 'password authentication failed' });
    expect(t.service.snapshot().sessions).toEqual([]);
  });

  it('disconnects an idle session unless a tab pins it or it is busy', async () => {
    const t = setup();
    const r = t.service.connect(t.save().id);
    if (!r.ok) throw new Error('connect');
    await t.flush();
    t.service.onHostMessage({ t: 'dbStatus', id: r.sessionId, phase: 'connected' });
    t.service.pin([r.sessionId]);
    t.fire(5 * 60_000);
    expect(t.last(r.sessionId)?.state).toBe('connected');
    t.service.pin([]);
    t.service.onHostMessage({ t: 'dbActivity', id: r.sessionId, busy: true });
    t.fire(5 * 60_000);
    expect(t.last(r.sessionId)?.state).toBe('connected');
    t.service.onHostMessage({ t: 'dbActivity', id: r.sessionId, busy: false });
    t.fire(5 * 60_000);
    expect(t.last(r.sessionId)?.state).toBe('closed');
    expect(t.sent.at(-1)).toEqual({ t: 'dbClose', id: r.sessionId });
  });

  it('a DB Host restart ends every session and tells the coordinator', async () => {
    const t = setup();
    const r = t.service.connect(t.save().id);
    if (!r.ok) throw new Error('connect');
    await t.flush();
    t.service.hostCrashed();
    expect(t.last(r.sessionId)).toMatchObject({ state: 'error', error: 'dbHostCrashed' });
    expect(t.coordinatorCalls).toContain('crashed db');
    expect(t.crashes()).toBe(1);
  });

  it('a test session resolves once connected and disconnects by itself; a failure resolves with the error', async () => {
    const t = setup();
    const pending = t.service.testConnection(input, { set: 'pw' });
    await t.flush();
    const open = t.sent.find((m) => m.t === 'dbOpen') as Extract<MainToDbHost, { t: 'dbOpen' }>;
    expect(open.config.password).toBe('pw');
    expect(t.sessions[0].test).toBe(true);
    t.service.onHostMessage({ t: 'dbStatus', id: open.id, phase: 'connected', serverVersion: '17.0' });
    expect(await pending).toEqual({ ok: true, serverVersion: '17.0', timeMs: 0 });
    expect(t.sent.at(-1)).toEqual({ t: 'dbClose', id: open.id });
    const failing = t.service.testConnection(input, null);
    await t.flush();
    const open2 = t.sent.filter((m) => m.t === 'dbOpen').at(-1) as Extract<MainToDbHost, { t: 'dbOpen' }>;
    expect(open2.config.password).toBeUndefined();
    t.service.onHostMessage({ t: 'dbStatus', id: open2.id, phase: 'error', error: 'dbRefused' });
    expect(await failing).toEqual({ ok: false, error: 'dbRefused' });
    expect(await t.service.testConnection({ ...input, port: -1 }, null)).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('DB IPC validation', () => {
  it('refuses malformed requests before the service sees them', async () => {
    const t = setup();
    const h = createDbHandlers(t.service as unknown as DbService);
    expect(h.save({ ...input, extra: 1 }, { keep: true })).toEqual({ ok: false, error: 'invalid' });
    expect(h.save(input, { set: '' })).toEqual({ ok: false, error: 'invalid' });
    const saved = h.save(input, { set: 'pw' });
    expect(saved.ok).toBe(true);
    const id = (saved as { connection: DbConnection }).connection.id;
    expect(h.connect('nope', undefined)).toEqual({ ok: false, error: 'invalid' });
    const c = h.connect(id, { database: 'x' });
    expect(c.ok).toBe(true);
    const sid = (c as { sessionId: string }).sessionId;
    expect(await h.pg('sftp:00000000-0000-4000-8000-000000000001', { op: 'schemas' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.pg(sid, { op: 'drop' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.pg(sid, { op: 'query', req: { queryId: 'x', sql: 'SELECT 1' } })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.pg(sid, { op: 'tablePage', req: { queryId: '00000000-0000-4000-8000-000000000001', schema: 's', table: 't', limit: 0 } })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.pg(sid, { op: 'applyEdits', req: { schema: 's', table: 't', edits: [{ op: 'update', key: {}, set: { a: '1' } }] } })).toEqual({ ok: false, error: 'invalid' });
    // A valid one reaches the service (not connected yet).
    expect(await h.pg(sid, { op: 'schemas' })).toEqual({ ok: false, error: 'notConnected' });
    expect(h.answer({ sessionId: sid, promptId: 'x', cancel: true })).toEqual({ ok: false });
    expect(await h.test({ ...input, id }, null)).toEqual({ ok: false, error: 'invalid' });
    h.pin(['bad']);
    h.pin([sid]);
  });
});
