// DB sessions through an SSH tunnel (1.0.0): the DB Host logs in to the in-process SSH test server (host key and password
// questions), forwards its connections with direct-tcpip to PGlite or the fake server, refuses foreign local connections,
// and ends cleanly when the forward or the SSH connection fails. The last part runs the whole main chain: DbService, the real
// SSH coordinator (known hosts, SSH vault) and the DB vault.
import { mkdtempSync, rmSync } from 'node:fs';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbHost } from '../src/dbhost/host';
import { DbService } from '../src/main/db/service';
import { DbVault } from '../src/main/db/vault';
import { SshCoordinator } from '../src/main/ssh/coordinator';
import { KnownHostsStore } from '../src/main/ssh/knownHosts';
import { SshVault } from '../src/main/ssh/vault';
import { dbSessionId, upsertDbConnection, type DbConnection, type DbPrompt, type DbSessionState } from '../src/shared/db';
import type { DbHostToMain, MainToDbHost } from '../src/shared/dbHostIpc';
import type { SshConnectRequest } from '../src/shared/ipc';
import { addSshHost, defaultState } from '../src/shared/state';
import type { AppState } from '../src/shared/types';
import { dbHarness, startPglite, waitFor, type Pglite } from './helpers/dbHarness';
import { startFakePg, type FakePg } from './helpers/pgFakeServer';
import { startTestServer, type TestServer } from './helpers/sshServer';
import { fakeCipher } from './helpers/sshKeys';

let pgl: Pglite;
let servers: TestServer[] = [];
let fakes: FakePg[] = [];
let dir: string;
beforeAll(async () => { pgl = await startPglite(); await pgl.db.exec('CREATE TABLE tun (id int primary key, v text); INSERT INTO tun VALUES (1, \'through ssh\')'); }, 60000);
afterAll(async () => { await pgl?.close(); });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-db-')); });
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(fakes.map((s) => s.close()));
  servers = []; fakes = [];
  rmSync(dir, { recursive: true, force: true });
});

async function ssh(opts: Parameters<typeof startTestServer>[0] = {}) { const s = await startTestServer({ password: 'pw', ...opts }); servers.push(s); return s; }
let keyN = 0;
const via = (port: number, owner = true, key = `k${++keyN}`) => ({ dbHost: '127.0.0.1', dbPort: port, tunnelKey: key, owner });
const sshReq = (id: string, s: TestServer, extra: Partial<SshConnectRequest> = {}): SshConnectRequest => ({ id, host: '127.0.0.1', port: s.port, username: 'alice', cols: 80, rows: 24, allowPasswordPrompt: true, ...extra });

describe('DbHost: SSH tunnel', () => {
  it('logs in (host key and password questions), forwards to the database and runs queries through it', async () => {
    const s = await ssh();
    const asked: string[] = [];
    const h = dbHarness({ onMain: (m, host) => {
      if (m.t === 'sshHostKey') { asked.push('hostKey'); void host.handle({ t: 'sshHostKeyAnswer', id: m.id, promptId: m.promptId, accept: true }); return true; }
      if (m.t === 'sshAuthPrompt') { asked.push(m.kind); void host.handle({ t: 'sshAuthAnswer', id: m.id, promptId: m.promptId, values: ['pw'] }); return true; }
      return false;
    } });
    const id = dbSessionId('aaaaaaaa-0000-4000-8000-000000000001');
    await h.open({ ssh: via(pgl.port), host: 'ignored.example', port: 1 }, id, false);
    await h.host.handle({ t: 'sshConnect', req: sshReq(id, s) });
    await waitFor(() => ['connected', 'error'].includes(h.last(id)?.phase ?? ''), 15000);
    expect(h.last(id)?.phase).toBe('connected');
    expect(asked).toEqual(['hostKey', 'password']);
    expect(h.statuses(id).map((x) => x.phase)).toEqual(['connecting', 'verifying', 'authenticating', 'database', 'connected']);
    expect(h.toMain.filter((m) => m.t === 'sshStatus').map((m) => (m as { phase: string }).phase)).toEqual(['connecting', 'verifying', 'authenticating', 'connected']);
    expect(s.forwards).toEqual([{ host: '127.0.0.1', port: pgl.port, accepted: true }]);
    expect((await h.run(id, { sql: 'SELECT v FROM tun' })).statements[0].rows).toEqual([['through ssh']]);
    // There is no local end of the tunnel that another program could connect to: pg reads and writes the SSH channel itself.
    const listening = await new Promise<number>((resolve) => {
      // The Node process listens on nothing but the PGlite and SSH test servers (whose ports are known).
      const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
      resolve(handles.filter((x) => x instanceof Server && (x.address() as { port?: number } | null)?.port !== pgl.port && (x.address() as { port?: number } | null)?.port !== s.port && x.listening).length);
    });
    expect(listening).toBe(0);
    // A cancel goes through the tunnel too (its own channel).
    const slow = await h.run(id, { sql: 'SELECT count(*) FROM generate_series(1, 10)' });
    expect(slow.end.ok).toBe(true);
    expect(s.forwards).toHaveLength(1);
    h.host.close(id);
    expect(h.last(id)?.phase).toBe('closed');
    await waitFor(() => s.connections() === 0);
  });

  it('a server that refuses the forward ends the session as "tunnel"; a dropped SSH connection ends a live one', async () => {
    const s = await ssh({ tcpForwarding: false });
    const h = dbHarness();
    const id = dbSessionId('aaaaaaaa-0000-4000-8000-000000000002');
    await h.open({ ssh: via(pgl.port) }, id, false);
    await h.host.handle({ t: 'sshConnect', req: sshReq(id, s, { password: 'pw' }) });
    await waitFor(() => ['connected', 'error'].includes(h.last(id)?.phase ?? ''), 15000);
    expect(h.last(id)).toMatchObject({ phase: 'error', error: 'tunnel' });
    expect(s.forwards).toEqual([{ host: '127.0.0.1', port: pgl.port, accepted: false }]);

    const s2 = await ssh();
    const id2 = dbSessionId('aaaaaaaa-0000-4000-8000-000000000003');
    await h.open({ ssh: via(pgl.port) }, id2, false);
    await h.host.handle({ t: 'sshConnect', req: sshReq(id2, s2, { password: 'pw' }) });
    await waitFor(() => h.last(id2)?.phase === 'connected', 15000);
    s2.dropConnections();
    await waitFor(() => h.last(id2)?.phase === 'error', 15000);
    expect(['reset', 'tunnel', 'dbClosed']).toContain(h.last(id2)?.error);
    expect(h.host.has(id2)).toBe(false);
  });

  it('a wrong SSH password ends with the SSH error; no sshConnect within the wait ends with a timeout', async () => {
    const s = await ssh();
    const h = dbHarness({ onMain: (m, host) => {
      if (m.t === 'sshAuthPrompt') { void host.handle({ t: 'sshAuthAnswer', id: m.id, promptId: m.promptId, values: null }); return true; }
      return false;
    } });
    const id = dbSessionId('aaaaaaaa-0000-4000-8000-000000000004');
    await h.open({ ssh: via(pgl.port) }, id, false);
    await h.host.handle({ t: 'sshConnect', req: sshReq(id, s) });
    await waitFor(() => h.last(id)?.phase === 'error', 15000);
    expect(h.last(id)?.error).toBe('cancelled');
    expect(h.toMain.some((m) => m.t === 'sshStatus' && m.phase === 'error')).toBe(true);

    const quick = dbHarness({ timers: { sshWaitMs: 100 } });
    const id2 = await quick.open({ ssh: via(pgl.port) });
    expect(quick.last(id2)).toMatchObject({ phase: 'error', error: 'timeout' });
  });

  it('shares one tunnel (one SSH login) between the sessions of a connection and closes it with the last one', async () => {
    const s = await ssh();
    const h = dbHarness();
    const a = dbSessionId('aaaaaaaa-0000-4000-8000-000000000011');
    const b = dbSessionId('aaaaaaaa-0000-4000-8000-000000000012');
    await h.open({ ssh: via(pgl.port, true, 'shared') }, a, false);
    await h.open({ ssh: via(pgl.port, false, 'shared') }, b, false);
    await h.host.handle({ t: 'sshConnect', req: sshReq(a, s, { password: 'pw' }) });
    await waitFor(() => h.last(a)?.phase === 'connected' && h.last(b)?.phase === 'connected', 15000);
    expect(s.connections()).toBe(1);
    expect(s.forwards).toHaveLength(2);
    expect(h.host.tunnelCount()).toBe(1);
    // The owner closing does not end the tunnel of the other session.
    h.host.close(a);
    expect((await h.run(b, { sql: 'SELECT v FROM tun' })).statements[0].rows).toEqual([['through ssh']]);
    h.host.close(b);
    expect(h.host.tunnelCount()).toBe(0);
    await waitFor(() => s.connections() === 0);
    // A session that expects a shared tunnel nobody opened fails at once.
    const c = await h.open({ ssh: via(pgl.port, false, 'none') });
    expect(h.last(c)).toMatchObject({ phase: 'error', error: 'tunnel' });
  });
});

describe('DbService behind the SSH coordinator (main chain)', () => {
  const HOST_ID = '00000000-0000-4000-8000-0000000000bb';
  const CONN_ID = '00000000-0000-4000-8000-0000000000cc';

  function chain(s: TestServer, conn: Omit<DbConnection, 'id' | 'createdAt' | 'updatedAt'>) {
    const sshVault = new SshVault(join(dir, 'ssh-vault.json'), fakeCipher());
    const knownHosts = new KnownHostsStore(join(dir, 'known_hosts.json'));
    const dbVault = new DbVault(join(dir, 'db', 'vault.json'), fakeCipher());
    let state: AppState = upsertDbConnection(addSshHost(defaultState(), { id: HOST_ID, label: 'vps', address: '127.0.0.1', port: s.port, username: 'alice', createdAt: 0, updatedAt: 0 }), { ...conn, id: CONN_ID, createdAt: 0, updatedAt: 0 });
    const sessions: DbSessionState[] = [];
    const prompts: Array<{ id: string; prompt: DbPrompt | null }> = [];
    let host!: DbHost;
    let service!: DbService<AppState>;
    const coordinator = new SshCoordinator({
      state: () => state, vault: sshVault, knownHosts,
      host: (m) => { void host.handle(m as MainToDbHost); return true; },
      events: { session: (st) => service.onCoordinatorSession(st), prompt: (id, p) => service.onPrompt(id, p), vaultChanged: () => undefined },
    });
    host = new DbHost({ toMain: (m: DbHostToMain) => service.onHostMessage(m), toRenderer: () => undefined }, { killGraceMs: 300, dbConnectMs: 5000 });
    service = new DbService<AppState>({
      coordinator, vault: dbVault, state: () => state, change: (fn) => { state = fn(state); },
      host: { ensure: () => true, running: () => true, send: (m) => { void host.handle(m); return true; }, request: async (id, op) => host.op(id, op) },
      sshHostExists: (id) => state.sshHosts.some((h) => h.id === id),
      readCa: async () => null,
      events: { session: (st) => sessions.push(st), prompt: (id, p) => prompts.push({ id, prompt: p }), hostCrashed: () => undefined, vaultChanged: () => undefined },
      defer: (fn) => setImmediate(fn),
    });
    const open = (id: string) => [...prompts].reverse().find((p) => p.id === id)?.prompt ?? null;
    const last = (id: string) => sessions.filter((x) => x.id === id).at(-1);
    return { service, coordinator, dbVault, knownHosts, sessions, prompts, open, last, host };
  }

  it('asks for the host key, the SSH password and the database password, connects and saves the DB password when asked', async () => {
    const s = await ssh();
    const pg = await startFakePg({ password: 'dbpw', auth: 'md5' });
    fakes.push(pg);
    const c = chain(s, { kind: 'postgres', name: 'prod', host: 'localhost', port: 5432, user: 'app', database: 'app', tls: 'disable', ssh: { hostId: HOST_ID, dbHost: '127.0.0.1', dbPort: pg.port }, readOnly: false });
    const r = c.service.connect(CONN_ID);
    expect(r.ok).toBe(true);
    const id = (r as { sessionId: string }).sessionId;
    await waitFor(() => c.open(id)?.kind === 'hostKey');
    expect(c.service.snapshot().prompts.map((p) => p.prompt.kind)).toEqual(['hostKey']);
    expect(c.service.answer({ sessionId: id, promptId: c.open(id)!.id, hostKey: 'save' })).toEqual({ ok: true });
    await waitFor(() => c.open(id)?.kind === 'password');
    expect(c.service.answer({ sessionId: id, promptId: c.open(id)!.id, values: ['pw'] })).toEqual({ ok: true });
    await waitFor(() => c.open(id)?.kind === 'dbPassword');
    expect(c.open(id)).toMatchObject({ kind: 'dbPassword', connectionName: 'prod', user: 'app', endpoint: `127.0.0.1:${pg.port}/app`, canSave: true, retry: false });
    expect(c.service.answer({ sessionId: id, promptId: c.open(id)!.id, values: ['dbpw'], remember: true })).toEqual({ ok: true });
    await waitFor(() => c.last(id)?.state === 'connected', 15000);
    expect(c.last(id)).toMatchObject({ connectionId: CONN_ID, kind: 'postgres', database: 'app', serverVersion: '16.4 (fake)', tx: 'idle', readOnly: false });
    const saved = c.dbVault.password(CONN_ID);
    expect(saved.ok && saved.password).toBe('dbpw');
    expect(c.knownHosts.list()).toHaveLength(1);
    expect(c.service.snapshot()).toMatchObject({ prompts: [] });
    expect(await c.service.op(id, { op: 'cancel' })).toEqual({ ok: true, value: false });
    // The DB Host restarting ends the session (and the coordinator's tunnel login with it).
    c.service.hostCrashed();
    expect(c.last(id)).toMatchObject({ state: 'error', error: 'dbHostCrashed' });
    expect(c.coordinator.sessionSnapshot('db').sessions.filter((x) => x.phase === 'connected')).toEqual([]);
    c.host.close(id);
  });

  it('an unknown SSH host key that the user refuses ends the session with the coordinator error', async () => {
    const s = await ssh();
    const c = chain(s, { kind: 'postgres', name: 'x', host: 'localhost', port: 5432, user: 'app', database: 'app', tls: 'disable', ssh: { hostId: HOST_ID, dbHost: '127.0.0.1', dbPort: pgl.port }, readOnly: false });
    const id = (c.service.connect(CONN_ID) as { sessionId: string }).sessionId;
    await waitFor(() => c.open(id)?.kind === 'hostKey');
    c.service.answer({ sessionId: id, promptId: c.open(id)!.id, cancel: true });
    await waitFor(() => c.last(id)?.state === 'error', 15000);
    expect(c.last(id)?.error).toBe('hostKeyRejected');
    expect(c.service.snapshot().sessions).toEqual([]);
  });

  it('tests a connection: connects, reports the version and disconnects; a wrong password reads dbAuth', async () => {
    const s = await ssh();
    const pg = await startFakePg({ password: 'dbpw' });
    fakes.push(pg);
    const c = chain(s, { kind: 'postgres', name: 'x', host: '127.0.0.1', port: pg.port, user: 'app', database: 'app', tls: 'disable', ssh: null, readOnly: false });
    const input = { kind: 'postgres' as const, name: 'form', host: '127.0.0.1', port: pg.port, user: 'app', database: 'app', tls: 'disable' as const, ssh: null, readOnly: false };
    const ok = await c.service.testConnection(input, { set: 'dbpw' });
    expect(ok).toMatchObject({ ok: true, serverVersion: '16.4 (fake)' });
    await waitFor(() => c.service.ids().length === 0);
    const bad = c.service.testConnection(input, { set: 'nope' });
    await waitFor(() => c.prompts.some((p) => p.prompt?.kind === 'dbPassword'));
    const p = [...c.prompts].reverse().find((x) => x.prompt?.kind === 'dbPassword')!;
    expect(p.prompt).toMatchObject({ retry: true, canSave: false });
    c.service.answer({ sessionId: p.id, promptId: p.prompt!.id, cancel: true });
    expect(await bad).toEqual({ ok: false, error: 'cancelled' });
    expect(c.dbVault.info().saved).toEqual([]);
  });
});
