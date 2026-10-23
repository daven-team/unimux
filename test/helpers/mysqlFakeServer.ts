// A small fake MySQL / MariaDB server on mysql2's own server protocol (1.0.5): what the session tests need without a real server.
// mysql_native_password logins (one password, or none), the version it claims, the SET statements it was sent, transactions
// (the in-transaction status flag), SELECT SLEEP(n) that a KILL QUERY from another connection or the session's statement timeout
// interrupts, a numbers table to stream rows from, UPDATE / DELETE with a chosen row count, and server errors.
import { createHash } from 'node:crypto';
import mysql from 'mysql2';

const sha1 = (...parts: Buffer[]) => { const h = createHash('sha1'); for (const p of parts) h.update(p); return h.digest(); };
/** mysql_native_password: SHA1(pw) XOR SHA1(scramble + SHA1(SHA1(pw))). */
function nativeToken(password: string, scramble: Buffer): Buffer {
  const stage1 = sha1(Buffer.from(password, 'utf8'));
  const mix = sha1(scramble, sha1(stage1));
  return Buffer.from(stage1.map((b, i) => b ^ mix[i]));
}

export interface FakeMysqlOptions {
  version?: string;
  comment?: string;
  /** The password every user logs in with (absent: none). */
  password?: string;
  /** Rows of `numbers` (SELECT * FROM numbers). */
  numbers?: number;
  /** What UPDATE and DELETE report as matched. */
  affected?: number;
}

interface Conn {
  id: number;
  inTx: boolean;
  timeoutMs: number;
  sleeping: { finish(code: number, message: string): void } | null;
  user: string;
  database: string;
}

export interface FakeMysql {
  port: number;
  logins: Array<{ user: string; database: string }>;
  sets: string[];
  queries: string[];
  kills: number[];
  close(): Promise<void>;
}

const VARCHAR = 0xfd;
const LONGLONG = 0x08;
const col = (name: string, columnType = VARCHAR) => ({
  catalog: 'def', schema: 'shop', table: 't', orgTable: 't', name, orgName: name, characterSet: columnType === VARCHAR ? 33 : 63, columnLength: 255, columnType, flags: 0, decimals: 0,
});

export async function startFakeMysql(opts: FakeMysqlOptions = {}): Promise<FakeMysql> {
  const server = (mysql as unknown as { createServer(): { listen(port: number, host: string, cb: () => void): void; close(cb?: () => void): void; _server: import('net').Server; on(e: string, f: (c: never) => void): void } }).createServer();
  const conns = new Map<number, Conn>();
  const sockets = new Set<{ stream: { destroy(): void } }>();
  let nextId = 100;
  const state: FakeMysql = { port: 0, logins: [], sets: [], queries: [], kills: [], close: async () => undefined };
  server.on('connection', (raw: never) => {
    const c = raw as unknown as {
      serverHandshake(a: object): void; on(e: string, f: (...a: never[]) => void): void; writeOk(a?: object): void; writeError(a: object): void;
      writeColumns(c: object[]): void; writeTextRow(r: unknown[]): void; writeEof(w?: number, s?: number): void; stream: { destroy(): void; on(e: string, f: () => void): void }; clientHelloReply?: { database?: string };
    };
    sockets.add(c);
    const me: Conn = { id: nextId++, inTx: false, timeoutMs: 0, sleeping: null, user: '', database: '' };
    conns.set(me.id, me);
    c.stream.on('close', () => { conns.delete(me.id); sockets.delete(c); });
    c.on('error', () => undefined);
    c.serverHandshake({
      protocolVersion: 10, serverVersion: opts.version ?? '8.0.36', connectionId: me.id, statusFlags: 2, characterSet: 8, capabilityFlags: 0xf7ff & ~0x0800,
      authCallback: (p: { user: string; database: string; authPluginData1: Buffer; authPluginData2: Buffer; authToken: Buffer }, cb: (err: unknown, e?: { message: string; code: number }) => void) => {
        const okLogin = opts.password === undefined ? p.authToken.length === 0
          : p.authToken.length > 0 && nativeToken(opts.password, Buffer.concat([p.authPluginData1, p.authPluginData2])).equals(p.authToken);
        if (!okLogin) { cb(null, { message: `Access denied for user '${p.user}'@'localhost' (using password: ${p.authToken.length ? 'YES' : 'NO'})`, code: 1045 }); return; }
        if (p.database === 'missing') { cb(null, { message: "Unknown database 'missing'", code: 1049 }); return; }
        me.user = p.user;
        me.database = p.database ?? '';
        state.logins.push({ user: p.user, database: me.database });
        cb(null);
      },
    });
    const status = () => 2 | (me.inTx ? 1 : 0);
    const ok = (affectedRows = 0) => c.writeOk({ affectedRows, serverStatus: status() });
    const rows = (names: Array<[string, number?]>, data: unknown[][]) => {
      c.writeColumns(names.map(([n, t]) => col(n, t)));
      for (const r of data) c.writeTextRow(r.map((v) => (v === null ? null : String(v))));
      c.writeEof(0, status());
    };
    // Every answer starts at sequence id 1 (the command was 0): mysql2's server side does not reset it between commands.
    const reply = () => { (c as unknown as { sequenceId: number }).sequenceId = 1; };
    const handle = (sql: string) => {
      reply();
      state.queries.push(sql);
      const s = sql.trim();
      if (/^SET\b/i.test(s)) {
        state.sets.push(s);
        const t = /max_(?:execution|statement)_time = ([\d.]+|DEFAULT)/i.exec(s);
        if (t) me.timeoutMs = t[1] === 'DEFAULT' ? 0 : /statement/i.test(s) ? Number(t[1]) * 1000 : Number(t[1]);
        ok();
        return;
      }
      if (/^SELECT VERSION\(\)/i.test(s)) { rows([['VERSION()'], ['@@version_comment'], ['DATABASE()']], [[opts.version ?? '8.0.36', opts.comment ?? 'fake', me.database || null]]); return; }
      if (/^DO 0$/i.test(s)) { ok(); return; }
      if (/^(START TRANSACTION|BEGIN)\b/i.test(s)) { me.inTx = true; ok(); return; }
      if (/^(COMMIT|ROLLBACK)\b/i.test(s)) { me.inTx = false; ok(); return; }
      const kill = /^KILL QUERY (\d+)$/i.exec(s);
      if (kill) {
        const target = conns.get(Number(kill[1]));
        state.kills.push(Number(kill[1]));
        target?.sleeping?.finish(1317, 'Query execution was interrupted');
        ok();
        return;
      }
      const sleep = /^SELECT SLEEP\((\d+)\)/i.exec(s);
      if (sleep) {
        const timer = setTimeout(() => { me.sleeping = null; reply(); rows([['SLEEP']], [[0]]); }, Number(sleep[1]) * 1000);
        const limit = me.timeoutMs ? setTimeout(() => me.sleeping?.finish(opts.version?.includes('MariaDB') ? 1969 : 3024, 'Query execution was interrupted, maximum statement execution time exceeded'), me.timeoutMs) : null;
        me.sleeping = { finish: (code, message) => { clearTimeout(timer); if (limit) clearTimeout(limit); me.sleeping = null; reply(); c.writeError({ code, message }); } };
        return;
      }
      if (/^SELECT \* FROM `?numbers`?/i.test(s) || /^SELECT n FROM numbers/i.test(s)) {
        const n = opts.numbers ?? 10;
        rows([['n', LONGLONG], ['label']], Array.from({ length: n }, (_, i) => [i + 1, `row ${i + 1}`]));
        return;
      }
      if (/^SELECT 1\b/i.test(s)) { rows([['1', LONGLONG]], [[1]]); return; }
      if (/^(UPDATE|DELETE)\b/i.test(s)) { ok(opts.affected ?? 1); return; }
      if (/^INSERT\b/i.test(s)) { ok(1); return; }
      if (/^USE\b/i.test(s)) { me.database = s.replace(/^USE\s+`?|`?$/gi, ''); ok(); return; }
      if (/^SELECT DATABASE\(\)/i.test(s)) { rows([['DATABASE()']], [[me.database || null]]); return; }
      c.writeError({ code: 1146, message: "Table 'shop.missing' doesn't exist" });
    };
    c.on('query', handle as never);
    // mysql2's server hands statements starting with SET to stmt_prepare.
    c.on('stmt_prepare', handle as never);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server._server.address() as { port: number }).port;
  state.close = () => new Promise<void>((resolve) => { for (const s of sockets) s.stream.destroy(); server.close(() => resolve()); });
  return state;
}
