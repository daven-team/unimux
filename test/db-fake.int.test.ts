// The DB Host core against the small fake Postgres server (1.0.0): what PGlite cannot do. Password prompts (cleartext and md5,
// saved, wrong, cancelled), TLS (require, verify-full with the CA, a wrong CA, a host name the certificate does not name,
// hostssl-only servers), cancel through pg_cancel_backend on a side connection, the protocol CancelRequest fallback, and
// statement timeouts (the connection's and one run's).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dbHarness, waitFor } from './helpers/dbHarness';
import { startFakePg, type FakePg, type FakePgOptions } from './helpers/pgFakeServer';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'pg-tls', name), 'utf8');
const TLS = { key: fixture('server.key'), cert: fixture('server.pem') };

let servers: FakePg[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => s.close())); servers = []; });
async function fake(opts: FakePgOptions = {}) { const s = await startFakePg(opts); servers.push(s); return s; }

describe('DbHost: passwords', () => {
  it('uses the saved password without asking (md5)', async () => {
    const s = await fake({ password: 'secret', auth: 'md5' });
    const h = dbHarness();
    const id = await h.open({ port: s.port, password: 'secret', user: 'alice', database: 'app' });
    expect(h.last(id)).toMatchObject({ phase: 'connected', serverVersion: '16.4 (fake)', database: 'app' });
    expect(h.toMain.some((m) => m.t === 'dbPasswordPrompt')).toBe(false);
    expect(s.logins).toEqual([{ user: 'alice', database: 'app', tls: false }]);
  });

  it('asks when none is saved, asks again (retry) after a wrong one, and fails after three wrong answers', async () => {
    const s = await fake({ password: 'secret' });
    const answers = ['wrong', 'secret'];
    const prompts: boolean[] = [];
    const h = dbHarness({ onMain: (m, host) => {
      if (m.t !== 'dbPasswordPrompt') return false;
      prompts.push(m.retry);
      void host.handle({ t: 'dbPasswordAnswer', id: m.id, promptId: m.promptId, value: answers.shift() ?? null });
      return true;
    } });
    const id = await h.open({ port: s.port });
    expect(h.last(id)?.phase).toBe('connected');
    expect(prompts).toEqual([false, true]);
    // A wrong saved password: asked with retry.
    const always = dbHarness({ autoPassword: 'nope' });
    const bad = await always.open({ port: s.port, password: 'stale' });
    expect(always.last(bad)).toMatchObject({ phase: 'error', error: 'dbAuth', message: 'password authentication failed for user "postgres"' });
    const asked = always.toMain.filter((m) => m.t === 'dbPasswordPrompt');
    expect(asked.map((m) => (m as { retry: boolean }).retry)).toEqual([true, true, true]);
  });

  it('a cancelled prompt ends the session as cancelled; a missing database reads dbNoDatabase', async () => {
    const s = await fake({ password: 'secret' });
    const h = dbHarness({ autoPassword: null });
    const id = await h.open({ port: s.port });
    expect(h.last(id)).toMatchObject({ phase: 'error', error: 'cancelled' });
    const t = await fake();
    const h2 = dbHarness();
    const missing = await h2.open({ port: t.port, database: 'missing' });
    expect(h2.last(missing)).toMatchObject({ phase: 'error', error: 'dbNoDatabase', message: 'database "missing" does not exist' });
  });

  it('closing a session while its password question is open answers it and ends quietly', async () => {
    const s = await fake({ password: 'secret' });
    const h = dbHarness();
    const id = await h.open({ port: s.port }, undefined, false);
    await waitFor(() => h.toMain.some((m) => m.t === 'dbPasswordPrompt'));
    h.host.close(id);
    expect(h.last(id)?.phase).toBe('closed');
  });
});

describe('DbHost: TLS', () => {
  it('require encrypts without checking the certificate; prefer uses TLS when offered', async () => {
    const s = await fake({ tls: TLS });
    const h = dbHarness();
    expect(h.last(await h.open({ port: s.port, tls: 'require' }))?.phase).toBe('connected');
    expect(h.last(await h.open({ port: s.port, tls: 'prefer' }))?.phase).toBe('connected');
    expect(s.logins.map((l) => l.tls)).toEqual([true, true]);
  });

  it('verify-full accepts the server only with the right CA and host name', async () => {
    const s = await fake({ tls: TLS });
    const h = dbHarness();
    expect(h.last(await h.open({ port: s.port, host: 'localhost', tls: 'verify-full', ca: fixture('ca.pem') }))?.phase).toBe('connected');
    expect(h.last(await h.open({ port: s.port, host: '127.0.0.1', tls: 'verify-full', ca: fixture('ca.pem') }))?.phase).toBe('connected');
    const wrongCa = await h.open({ port: s.port, host: 'localhost', tls: 'verify-full', ca: fixture('other-ca.pem') });
    expect(h.last(wrongCa)).toMatchObject({ phase: 'error', error: 'dbTls' });
    expect(h.last(wrongCa)?.message).toBeTruthy();
    expect(s.logins).toHaveLength(2);
  });

  it('disable against a hostssl-only server fails with the server message', async () => {
    const s = await fake({ tls: TLS, requireTls: true });
    const h = dbHarness();
    const id = await h.open({ port: s.port, tls: 'disable' });
    expect(h.last(id)).toMatchObject({ phase: 'error', error: 'dbAuth' });
    expect(h.last(id)?.message).toContain('no encryption');
  });
});

describe('DbHost: cancel and statement timeout', () => {
  it('cancels a running statement through pg_cancel_backend on a side connection and skips the rest of the run', async () => {
    const s = await fake({ password: 'secret' });
    const h = dbHarness();
    const id = await h.open({ port: s.port, password: 'secret' });
    const run = await h.run(id, { sql: 'SELECT pg_sleep(5); SELECT 1' }, false);
    await waitFor(() => s.statements.includes('SELECT pg_sleep(5)'));
    expect(await h.value(id, { op: 'cancel' })).toBe(true);
    await waitFor(() => h.ended(run.queryId), 4000);
    const r = h.collect(run.queryId);
    expect(r.end).toMatchObject({ ok: false, cancelled: true });
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0].error).toMatchObject({ code: 'cancelled', server: { code: '57014' } });
    expect(s.cancels).toEqual([{ via: 'function', pid: 1000 }]);
    // The side connection logged in with the session's password, and the session goes on.
    expect(s.logins).toHaveLength(2);
    expect((await h.run(id, { sql: 'SELECT 1' })).statements[0].rows).toEqual([['1']]);
    expect(await h.value(id, { op: 'cancel' })).toBe(false);
  });

  it('falls back to the protocol CancelRequest when no side connection can log in', async () => {
    const s = await fake({ password: 'secret' });
    let typed = 0;
    // The password is typed once; the side connection then has it too, so make the side login fail by changing it.
    const h = dbHarness({ onMain: (m, host) => {
      if (m.t !== 'dbPasswordPrompt') return false;
      typed++;
      void host.handle({ t: 'dbPasswordAnswer', id: m.id, promptId: m.promptId, value: 'secret' });
      return true;
    } });
    const id = await h.open({ port: s.port });
    expect(typed).toBe(1);
    const side = h.host as unknown as { sessions: Map<string, { password?: string }> };
    side.sessions.get(id)!.password = 'changed';
    const run = await h.run(id, { sql: 'SELECT pg_sleep(5)' }, false);
    await waitFor(() => s.statements.includes('SELECT pg_sleep(5)'));
    expect(await h.value(id, { op: 'cancel' })).toBe(true);
    await waitFor(() => h.ended(run.queryId), 4000);
    expect(s.cancels.map((c) => c.via)).toEqual(['protocol']);
    expect(h.collect(run.queryId).end.cancelled).toBe(true);
  });

  it('applies the connection statement timeout at connect and a run-only timeout that is restored afterwards', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open({ port: s.port, statementTimeoutMs: 200 });
    expect(s.statements).toContain('SET statement_timeout = 200');
    const t0 = Date.now();
    const slow = await h.run(id, { sql: 'SELECT pg_sleep(3)' });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(slow.statements[0].error).toMatchObject({ code: 'statementTimeout', server: { code: '57014' } });
    expect(slow.end.cancelled).toBe(false);
    const longer = await h.run(id, { sql: 'SELECT pg_sleep(0.3)', statementTimeoutMs: 2000 });
    expect(longer.end.ok).toBe(true);
    expect(s.statements.slice(-3)).toEqual(['SET statement_timeout = 2000', 'SELECT pg_sleep(0.3)', 'SET statement_timeout = 200']);
  });

  it('a restore that fails ends the session instead of leaving it with the run-only settings', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open({ port: s.port, statementTimeoutMs: 200 });
    s.failing.add('SET statement_timeout = 200');
    const r = await h.run(id, { sql: 'SELECT 1', statementTimeoutMs: 5000 });
    expect(r.end.ok).toBe(false);
    await waitFor(() => h.last(id)?.phase === 'error');
    expect(h.last(id)?.error).toBe('dbFailed');
  });

  it('a read-only connection sets default_transaction_read_only at connect', async () => {
    const s = await fake();
    const h = dbHarness();
    await h.open({ port: s.port, readOnly: true });
    expect(s.statements).toContain('SET default_transaction_read_only = on');
  });
});
