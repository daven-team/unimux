// The DB Host with MySQL / MariaDB sessions against the fake server on mysql2's server protocol (1.0.5): logins and password
// prompts, the flavour from the version, the session settings (read-only, statement timeout), rows and "load more", cancel
// with KILL QUERY on a side connection, timeouts, server errors, the transaction state and the row count of edits.
import { afterEach, describe, expect, it } from 'vitest';
import { dbHarness, waitFor } from './helpers/dbHarness';
import { startFakeMysql, type FakeMysql, type FakeMysqlOptions } from './helpers/mysqlFakeServer';
import type { DbOpenConfig } from '../src/shared/dbHostIpc';

let servers: FakeMysql[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => s.close())); servers = []; });
async function fake(opts: FakeMysqlOptions = {}) { const s = await startFakeMysql(opts); servers.push(s); return s; }
const my = (port: number, extra: Partial<DbOpenConfig> = {}): Partial<DbOpenConfig> => ({ kind: 'mysql', port, user: 'root', database: 'shop', tls: 'disable', ...extra });

describe('DbHost MySQL: connecting', () => {
  it('logs in with the saved password and reads the flavour from the version', async () => {
    const s = await fake({ password: 'pw', version: '11.4.2-MariaDB-ubu2404' });
    const h = dbHarness();
    const id = await h.open(my(s.port, { password: 'pw' }));
    expect(h.last(id)).toMatchObject({ phase: 'connected', serverVersion: 'MariaDB 11.4.2', database: 'shop', tls: false });
    expect(s.logins).toEqual([{ user: 'root', database: 'shop' }]);
    h.host.close(id);
  });

  it('tries no password first, then asks; a wrong typed one asks again with retry', async () => {
    const s = await fake({ password: 'pw' });
    const answers = ['wrong', 'pw'];
    const prompts: boolean[] = [];
    const h = dbHarness({ onMain: (m, host) => {
      if (m.t !== 'dbPasswordPrompt') return false;
      prompts.push(m.retry);
      void host.handle({ t: 'dbPasswordAnswer', id: m.id, promptId: m.promptId, value: answers.shift() ?? null });
      return true;
    } });
    const id = await h.open(my(s.port));
    expect(h.last(id)).toMatchObject({ phase: 'connected', serverVersion: 'MySQL 8.0.36' });
    expect(prompts).toEqual([false, true]);
    // A server without a password for the user: no question at all.
    const open = await fake();
    const h2 = dbHarness();
    expect(h2.last(await h2.open(my(open.port)))?.phase).toBe('connected');
    expect(h2.toMain.some((m) => m.t === 'dbPasswordPrompt')).toBe(false);
  });

  it('maps a missing database, a refused port and prefer without TLS on the server', async () => {
    const s = await fake();
    const h = dbHarness();
    expect(h.last(await h.open(my(s.port, { database: 'missing' })))).toMatchObject({ phase: 'error', error: 'dbNoDatabase', message: "ERROR 1049: Unknown database 'missing'" });
    expect(h.last(await h.open(my(1, { host: '127.0.0.1' })))).toMatchObject({ phase: 'error', error: 'dbRefused' });
    // The fake offers no TLS: prefer falls back to plain, require fails.
    expect(h.last(await h.open(my(s.port, { tls: 'prefer' })))).toMatchObject({ phase: 'connected', tls: false });
    expect(h.last(await h.open(my(s.port, { tls: 'require' })))).toMatchObject({ phase: 'error', error: 'dbTlsUnsupported' });
  });

  it('a read-only connection with a timeout sets both on the session (MariaDB in seconds)', async () => {
    const s = await fake({ version: '10.11.6-MariaDB' });
    const h = dbHarness();
    const id = await h.open(my(s.port, { readOnly: true, statementTimeoutMs: 1500 }));
    expect(h.last(id)?.phase).toBe('connected');
    expect(s.sets).toEqual(['SET SESSION TRANSACTION READ ONLY', 'SET SESSION max_statement_time = 1.500']);
    const refused = await h.run(id, { sql: 'SELECT 1; DELETE FROM t' });
    expect(refused.statements[1]?.error?.code).toBe('readOnly');
    expect(s.queries.some((q) => q.startsWith('DELETE'))).toBe(false);
  });
});

describe('DbHost MySQL: running', () => {
  it('streams rows as text, keeps the last read open for more and closes it with KILL QUERY', async () => {
    const s = await fake({ numbers: 25 });
    const h = dbHarness();
    const id = await h.open(my(s.port));
    const r = await h.run(id, { sql: 'SELECT * FROM numbers', rowCap: 10 });
    expect(r.statements[0].columns.map((c) => [c.name, c.kind])).toEqual([['n', 'bigint'], ['label', 'text']]);
    expect(r.statements[0].rows.slice(0, 2)).toEqual([['1', 'row 1'], ['2', 'row 2']]);
    expect(r.statements[0].end).toMatchObject({ rows: 10, hasMore: true });
    await h.more(id, r.queryId, 10);
    expect(h.collect(r.queryId).statements[0].rows.length).toBe(20);
    // Another statement needs the connection: the open result goes.
    const next = await h.run(id, { sql: 'SELECT 1' });
    expect(next.statements[0].rows).toEqual([['1']]);
    expect(h.collect(r.queryId).statements[0].closed).toBe(true);
  });

  it('cancel stops a running statement with KILL QUERY from a side connection', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open(my(s.port));
    const run = await h.run(id, { sql: 'SELECT SLEEP(30)' }, false);
    await waitFor(() => s.queries.includes('SELECT SLEEP(30)'));
    const c = await h.op<boolean>(id, { op: 'cancel' });
    expect(c).toEqual({ ok: true, value: true });
    await waitFor(() => h.ended(run.queryId));
    const done = h.collect(run.queryId);
    expect(done.statements[0].error?.code).toBe('cancelled');
    expect(done.end).toMatchObject({ cancelled: true, ok: false });
    expect(s.kills.length).toBe(1);
    // The session still works.
    expect((await h.run(id, { sql: 'SELECT 1' })).statements[0].rows).toEqual([['1']]);
  });

  it('a statement timeout reads as such; one run may set its own and the connection setting comes back', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open(my(s.port));
    const r = await h.run(id, { sql: 'SELECT SLEEP(30)', statementTimeoutMs: 200 });
    expect(r.statements[0].error?.code).toBe('statementTimeout');
    expect(s.sets).toEqual(['SET SESSION max_execution_time = 200', 'SET SESSION max_execution_time = DEFAULT']);
  });

  it('server errors carry the code; the transaction state follows the status flags', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open(my(s.port));
    const bad = await h.run(id, { sql: 'SELECT * FROM missing' });
    expect(bad.statements[0].error).toMatchObject({ code: 'server', server: { message: "ERROR 1146: Table 'shop.missing' doesn't exist" } });
    const begun = await h.run(id, { sql: 'START TRANSACTION; UPDATE t SET a = 1' });
    expect(begun.end.tx).toBe('transaction');
    expect(begun.statements[1].end).toMatchObject({ command: 'UPDATE', rowCount: 1 });
    expect(h.toMain.some((m) => m.t === 'dbTx' && m.tx === 'transaction')).toBe(true);
    const tx = await h.op(id, { op: 'transaction', action: 'rollback' });
    expect(tx).toEqual({ ok: true, value: 'idle' });
  });

  it('a CALL shows every result set of the procedure as a result of its own; the next statement follows them', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open(my(s.port));
    const r = await h.run(id, { sql: 'CALL multi(); SELECT 1' });
    expect(r.end.ok).toBe(true);
    const starts = h.port.filter((m) => m.t === 'statement' && m.queryId === r.queryId);
    expect(starts.map((m) => m.t === 'statement' && [m.index, m.set ?? null, m.start])).toEqual([[0, null, 0], [1, 2, 0], [2, null, 14]]);
    expect(r.statements[0].rows).toEqual([['1'], ['2']]);
    expect(r.statements[0].columns.map((c) => c.name)).toEqual(['a']);
    expect(r.statements[0].end).toMatchObject({ command: 'CALL', rowCount: 2, hasMore: false });
    expect(r.statements[1].rows).toEqual([['x']]);
    expect(r.statements[1].columns.map((c) => c.name)).toEqual(['b']);
    expect(r.statements[2].rows).toEqual([['1']]);
    // Without result sets: the affected rows. Failing after a set: the set stays, the error is a result of its own.
    expect((await h.run(id, { sql: 'CALL noop()' })).statements[0].end).toMatchObject({ command: 'CALL', rowCount: 3 });
    const half = await h.run(id, { sql: 'CALL half()' });
    expect(half.statements[0].rows).toEqual([['1']]);
    expect(half.statements[1].error).toMatchObject({ code: 'server', server: { message: "ERROR 1146: Table 'shop.gone' doesn't exist" } });
    expect(half.end.ok).toBe(false);
  });

  it('a syntax error is placed in the statement from "near ... at line N"', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open(my(s.port));
    const r = await h.run(id, { sql: 'SELECT 1;\nSELECT *\n  FRM t' });
    expect(r.statements[1].error?.server).toMatchObject({ position: 12 });
    expect('SELECT *\n  FRM t'.slice(11)).toBe('FRM t');
  });

  it('lists triggers and events with the tables and routines, and shows their CREATE statements', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open(my(s.port));
    const objects = await h.value<Array<{ name: string; kind: string; detail?: string; comment?: string }>>(id, { op: 'objects', schema: 'shop' });
    expect(objects.map((o) => [o.kind, o.name, o.detail ?? null])).toEqual([
      ['table', 'orders', null], ['procedure', 'multi', null], ['trigger', 'orders_ai', 'AFTER INSERT ON orders'], ['event', 'nightly', 'EVERY 1 DAY · ENABLED'],
    ]);
    expect(objects[3].comment).toBe('cleanup');
    expect(await h.value(id, { op: 'ddl', schema: 'shop', name: 'orders_ai', kind: 'trigger' })).toBe('CREATE DEFINER=`root`@`%` TRIGGER `orders_ai` AFTER INSERT ON `orders` FOR EACH ROW SET @n = 1;\n');
    expect(await h.value(id, { op: 'ddl', schema: 'shop', name: 'nightly', kind: 'event' })).toMatch(/^CREATE DEFINER=`root`@`%` EVENT `nightly` ON SCHEDULE EVERY 1 DAY/);
  });

  it('USE reports the new default database', async () => {
    const s = await fake();
    const h = dbHarness();
    const id = await h.open(my(s.port));
    await h.run(id, { sql: 'USE `other`' });
    await waitFor(() => h.toMain.some((m) => m.t === 'dbDatabase' && m.database === 'other'));
  });
});
