// SP9 (Tauri migration spike, DB wire fidelity): writes the 1.1.4 side of the value goldens in test/golden/db-wire/ from the
// real drivers (node-postgres, mysql2, ioredis) through the real DB host (src/dbhost) against real servers. Rust compares in
// src-tauri/crates/unimux-db/tests/wire_servers.rs. Driven by scripts/spike-db-wire.mjs, which starts the Docker servers and
// passes them as MC_SP9_SERVERS (JSON: [{label, kind, host, port, user, password}]); MC_SP9_WRITE=1 writes the goldens,
// without it the suite checks that the drivers still answer what the committed goldens say. Skipped without servers;
// the offline part (Node's UTF-8 decoding and toValue) always runs.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { isUtf8 } from 'node:buffer';
import pg from 'pg';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyRedisCommand, type RedisCommandResult, type RedisData } from '../src/shared/dbRedis';
import { RAW_TYPES, toValue } from '../src/dbhost/pgSession';
import { openRedis } from '../src/dbhost/redisSession';
import { dbHarness } from './helpers/dbHarness';

const DIR = join(__dirname, 'golden', 'db-wire');
const WRITE = process.env.MC_SP9_WRITE === '1';
interface Server { label: string; kind: 'postgres' | 'mysql' | 'mariadb' | 'redis'; host: string; port: number; user: string; password: string }
const servers: Server[] = process.env.MC_SP9_SERVERS ? JSON.parse(process.env.MC_SP9_SERVERS) : [];
const corpus = (name: string) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

/** A line longer than this is stored as its SHA-256 (Rust hashes its own line the same way), so the files stay small. */
const HASH_ABOVE = 8192;
const lineText = (l: unknown): string => {
  const t = JSON.stringify(l);
  if (t.length <= HASH_ABOVE) return t;
  const o = l as { id?: unknown; case?: unknown };
  return JSON.stringify({ id: o.id ?? o.case, sha256: createHash('sha256').update(t, 'utf8').digest('hex'), chars: t.length });
};

function golden(name: string, lines: unknown[]): void {
  const text = lines.map(lineText).join('\n') + '\n';
  const path = join(DIR, name);
  if (WRITE) writeFileSync(path, text);
  else expect(text).toBe(readFileSync(path, 'utf8'));
}

const data = (d: RedisData): Buffer => (typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d.b64, 'base64'));

describe('SP9 offline goldens', () => {
  it('Node UTF-8 decoding and toValue', () => {
    const inputs = ['ff', 'c0af', 'eda080', 'f4908080', 'e282', '6f6be2826f6b', 'f09f9880', 'f09f98', 'e2', 'fe', 'c3', 'e0a0', 'f0908080', 'f8888080', '80bf', 'c328', 'edbfbf', 'efbfbd', '00', ''];
    const decode = inputs.map((hex) => ({ hex, text: Buffer.from(hex, 'hex').toString('utf8'), isUtf8: isUtf8(Buffer.from(hex, 'hex')) }));
    const values = [
      'x'.repeat(65536), 'x'.repeat(65537), 'a' + '😀'.repeat(40000), '😀'.repeat(32768), '😀'.repeat(32769), 'ą'.repeat(70000), '',
    ].map((s) => ({ len: s.length, json: JSON.stringify(toValue(s)) }));
    golden('utf8-decode.jsonl', [...decode, ...values.map((v) => ({ value: v }))]);
  });
});

/** client -> server bytes of one connection through a local proxy (the connect sequence of a driver). */
async function recordingProxy(target: { host: string; port: number }) {
  const sent: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const up = connect(target.port, target.host);
    sockets.add(client); sockets.add(up);
    client.on('data', (d: Buffer) => { sent.push(d); up.write(d); });
    up.on('data', (d: Buffer) => client.write(d));
    const end = () => { client.destroy(); up.destroy(); };
    client.on('close', end); up.on('close', end); client.on('error', end); up.on('error', end);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, sent: () => Buffer.concat(sent), close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

const pgServers = servers.filter((s) => s.kind === 'postgres');
const myServers = servers.filter((s) => s.kind === 'mysql' || s.kind === 'mariadb');
const redisServers = servers.filter((s) => s.kind === 'redis');

describe.skipIf(!pgServers.length).each(pgServers)('SP9 Postgres goldens: $label', (s) => {
  const h = dbHarness();
  afterAll(() => h.host.shutdown());
  const client = async (database: string) => {
    const c = new pg.Client({ host: s.host, port: s.port, user: s.user, password: s.password, database, application_name: 'unimux', types: RAW_TYPES as never });
    await c.connect();
    return c;
  };

  it('values, fields, tags, errors and notices', async () => {
    const c = corpus('pg-corpus.json');
    const admin = await client('postgres');
    for (const sql of c.setup) await admin.query(sql);
    await admin.end();
    const ascii = await client('sp9_ascii');
    for (const sql of c.asciiSetup) await ascii.query(sql);
    await ascii.end();

    // table OIDs change with every setup: the goldens name the table instead
    const relnames = new Map<string, string>();
    const relname = async (database: string, oid: number): Promise<string> => {
      const key = `${database}:${oid}`;
      if (!relnames.has(key)) {
        const c2 = await client(database);
        const r = await c2.query({ text: `SELECT relname FROM pg_class WHERE oid = ${oid}`, rowMode: 'array' } as never) as unknown as pg.QueryResult<unknown[]>;
        await c2.end();
        relnames.set(key, String(r.rows[0]?.[0] ?? oid));
      }
      return relnames.get(key)!;
    };
    const sessions: Record<string, string> = {};
    const lines: unknown[] = [];
    for (const q of c.queries as Array<{ id: string; sql: string; db?: string }>) {
      const database = q.db === 'ascii' ? 'sp9_ascii' : 'postgres';
      sessions[database] ??= await h.open({ kind: 'postgres', host: s.host, port: s.port, user: s.user, password: s.password, database, tls: 'disable' });
      const run = await h.run(sessions[database], { sql: q.sql });
      const st = run.statements[0];
      const host = {
        columns: await Promise.all(st.columns.map(async (col) => ({ name: col.name, typeOid: col.typeOid, ...(col.tableOid ? { table: await relname(database, col.tableOid) } : {}), ...(col.columnNumber ? { columnNumber: col.columnNumber } : {}) }))),
        rows: st.rows,
        ...(st.error ? { error: { code: st.error.code, ...(st.error.server ? { server: { code: st.error.server.code, message: st.error.server.message, ...(st.error.server.position ? { position: st.error.server.position } : {}), ...(st.error.server.detail ? { detail: st.error.server.detail } : {}) } } : {}) } } : {}),
      };
      // the same statement as a plain simple query (what the simple protocol gives)
      const raw = await client(database);
      const notices: string[] = [];
      raw.on('notice', (n) => notices.push(`${n.severity}: ${n.message}`));
      let simple: unknown;
      try {
        const r = await raw.query({ text: q.sql, rowMode: 'array', types: RAW_TYPES } as never) as unknown as pg.QueryResult<unknown[]>;
        simple = {
          fields: await Promise.all(r.fields.map(async (f) => ({ name: f.name, table: f.tableID ? await relname(database, f.tableID) : 0, columnID: f.columnID, dataTypeID: f.dataTypeID, dataTypeSize: f.dataTypeSize, dataTypeModifier: f.dataTypeModifier, format: f.format }))),
          rows: r.rows.map((row) => row.map(toValue)), command: r.command, rowCount: r.rowCount,
        };
      } catch (e) {
        const err = e as { code?: string; message?: string };
        simple = { error: { code: err.code, message: err.message } };
      }
      await raw.end();
      lines.push({ id: q.id, host, simple, notices });
    }
    for (const id of Object.values(sessions)) h.host.close(id);
    golden(`${s.label}.jsonl`, lines);
  }, 120000);

  it('the startup message', async () => {
    const proxy = await recordingProxy(s);
    const c = new pg.Client({ host: '127.0.0.1', port: proxy.port, user: 'sp9_none', password: 'x', database: 'postgres', application_name: 'unimux', types: RAW_TYPES as never });
    await c.connect().catch(() => undefined);
    await c.end().catch(() => undefined);
    const bytes = proxy.sent();
    await proxy.close();
    const len = bytes.readInt32BE(0);
    golden(`${s.label}-startup.jsonl`, [{ startup: bytes.subarray(0, len).toString('base64') }]);
  });

  it('logins: md5, SCRAM with a SASLprep-sensitive password, a wrong password', async () => {
    const tryLogin = async (user: string, password: string) => {
      const c = new pg.Client({ host: s.host, port: s.port, user, password, database: 'postgres' });
      try { await c.connect(); await c.end(); return { ok: true }; } catch (e) { const err = e as { code?: string; message?: string }; return { ok: false, code: err.code, message: err.message }; }
    };
    golden(`${s.label}-logins.jsonl`, [
      { user: 'sp9_md5', ...(await tryLogin('sp9_md5', 'md5-pw')) },
      { user: 'sp9_nfkc', ...(await tryLogin('sp9_nfkc', 'Ⅸ ﬁ x')) },
      { user: 'sp9_nfkc_composed', ...(await tryLogin('sp9_nfkc', 'IX fi x')) },
      { user: 'wrong', ...(await tryLogin(s.user, 'wrong')) },
    ]);
  });
});

describe.skipIf(!myServers.length).each(myServers)('SP9 MySQL goldens: $label', (s) => {
  const h = dbHarness();
  afterAll(() => h.host.shutdown());

  it('values, columns, counts, errors', async () => {
    const c = corpus('mysql-corpus.json');
    const admin = await mysql.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, multipleStatements: false });
    for (const sql of c.setup) await admin.query(sql);
    if (s.kind === 'mariadb') for (const sql of c.mariadbSetup) await admin.query(sql);
    await admin.end();
    const id = await h.open({ kind: 'mysql', host: s.host, port: s.port, user: s.user, password: s.password, database: 'sp9', tls: 'disable' });
    const lines: unknown[] = [];
    for (const q of c.queries as Array<{ id: string; sql: string; only?: string }>) {
      if (q.only && q.only !== s.kind) continue;
      const run = await h.run(id, { sql: q.sql });
      lines.push({
        id: q.id,
        statements: run.statements.map((st) => ({
          columns: st.columns.map((col) => ({ name: col.name, typeName: col.typeName, kind: col.kind })),
          rows: st.rows,
          ...(st.end ? { command: st.end.command, rowCount: st.end.rowCount } : {}),
          ...(st.error ? { error: { code: st.error.code, ...(st.error.server ? { server: { code: st.error.server.code, message: st.error.server.message } } : {}) } } : {}),
        })),
      });
    }
    h.host.close(id);
    golden(`${s.label}.jsonl`, lines);
  }, 120000);

  it('caching_sha2_password: full authentication over plain TCP (RSA key request), then the fast path', async () => {
    if (s.kind !== 'mysql') return;
    const admin = await mysql.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password });
    await admin.query("CREATE USER IF NOT EXISTS 'sp9_node'@'%' IDENTIFIED WITH caching_sha2_password BY 'sha2-pw'");
    await admin.query('FLUSH PRIVILEGES');
    await admin.end();
    const login = async () => {
      const c = await mysql.createConnection({ host: s.host, port: s.port, user: 'sp9_node', password: 'sha2-pw' });
      const [rows] = await c.query({ sql: 'SELECT CURRENT_USER()', rowsAsArray: true });
      await c.end();
      return rows;
    };
    expect(await login()).toEqual([['sp9_node@%']]);
    expect(await login()).toEqual([['sp9_node@%']]);
  });
});

describe.skipIf(!redisServers.length).each(redisServers)('SP9 Redis goldens: $label', (s) => {
  const h = dbHarness();
  afterAll(() => h.host.shutdown());

  it('console replies', async () => {
    const c = corpus('redis-corpus.json');
    const admin = new Redis({ host: s.host, port: s.port, lazyConnect: true });
    await admin.connect();
    for (const argv of c.setup as RedisData[][]) await admin.callBuffer(String(argv[0]), ...argv.slice(1).map(data));
    admin.disconnect();
    const id = await h.open({ kind: 'redis', host: s.host, port: s.port, user: '', database: '0', tls: 'disable' });
    const lines: unknown[] = [];
    for (const q of c.commands as Array<{ id: string; argv: RedisData[] }>) {
      const r = await h.op<RedisCommandResult>(id, { op: 'redis', req: { kind: 'command', req: { argv: q.argv, confirmed: true, readWrite: true } } });
      if (!r.ok) throw new Error(`${q.id}: ${r.error}`);
      lines.push({ id: q.id, status: classifyRedisCommand(q.argv).status, reply: r.value.reply });
    }
    h.host.close(id);
    golden(`${s.label}.jsonl`, lines);
  }, 60000);

  it('the connect sequence (default user; ACL user on DB 2)', async () => {
    const seq = async (user: string, password: string | undefined, dbIndex: number) => {
      const proxy = await recordingProxy(s);
      const opened = await openRedis({ host: '127.0.0.1', port: proxy.port, tls: null, user, password, connectTimeoutMs: 5000, viaTunnel: false, dbIndex });
      opened.client.disconnect();
      await new Promise((r) => setTimeout(r, 50));
      const bytes = proxy.sent();
      await proxy.close();
      return bytes.toString('base64');
    };
    golden(`${s.label}-connect.jsonl`, [
      { case: 'default', sent: await seq('', undefined, 0) },
      { case: 'acl', sent: await seq('sp9', 'pw', 2) },
    ]);
  });
});
