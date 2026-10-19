// A tiny Postgres wire-protocol server for the cases PGlite cannot show (1.0.0): password auth (cleartext and md5), TLS with
// a test certificate, several real backends (pg_cancel_backend and the protocol CancelRequest), statement_timeout and a
// pg_sleep that can be cancelled. 127.0.0.1 only. It understands just the statements the DB Host sends plus a few test ones.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';

export interface FakePgOptions {
  /** Required password for every user; absent: trust. */
  password?: string;
  auth?: 'cleartext' | 'md5';
  /** Answer SSLRequest with 'S' and speak TLS with this certificate. */
  tls?: { key: string; cert: string };
  /** Refuse plain connections (like hostssl only). */
  requireTls?: boolean;
}

export interface FakePg {
  port: number;
  /** Startup parameters of every connection that logged in. */
  logins: Array<{ user: string; database: string; tls: boolean }>;
  /** Statements in order (simple and extended). */
  statements: string[];
  cancels: Array<{ via: 'function' | 'protocol'; pid: number }>;
  close(): Promise<void>;
}

interface Backend { pid: number; secret: number; settings: Map<string, string>; tx: 'I' | 'T' | 'E'; sleeping: ((reason: 'cancel') => void) | null }

class SqlError extends Error { constructor(readonly code: string, message: string) { super(message); } }

const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const msg = (type: string, body: Buffer = Buffer.alloc(0)) => Buffer.concat([Buffer.from(type, 'ascii'), int32(body.length + 4), body]);

function rowDescription(fields: string[]): Buffer {
  return msg('T', Buffer.concat([int16(fields.length), ...fields.map((f) => Buffer.concat([cstr(f), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]))]));
}
function dataRow(row: Array<string | null>): Buffer {
  return msg('D', Buffer.concat([int16(row.length), ...row.map((v) => (v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)])))]));
}
function errorResponse(code: string, message: string): Buffer {
  return msg('E', Buffer.concat([cstr('SERROR'), cstr('VERROR'), cstr(`C${code}`), cstr(`M${message}`), Buffer.from([0])]));
}

export async function startFakePg(opts: FakePgOptions = {}): Promise<FakePg> {
  const backends = new Map<number, Backend>();
  const logins: FakePg['logins'] = [];
  const statements: string[] = [];
  const cancels: FakePg['cancels'] = [];
  const sockets = new Set<Duplex>();
  let nextPid = 1000;

  const cancel = (pid: number) => { const b = backends.get(pid); if (b?.sleeping) { b.sleeping('cancel'); return true; } return false; };

  async function run(b: Backend, sql: string, params: Array<string | null>): Promise<{ fields: string[]; rows: Array<Array<string | null>>; command: string }> {
    statements.push(sql);
    const text = sql.trim().replace(/;$/, '');
    let m: RegExpExecArray | null;
    if ((m = /^SET\s+(\w+)\s*(?:=|TO)\s*(.+)$/i.exec(text))) { b.settings.set(m[1].toLowerCase(), m[2].trim().replace(/^'|'$/g, '')); return { fields: [], rows: [], command: 'SET' }; }
    if (/^BEGIN/i.test(text)) { b.tx = 'T'; return { fields: [], rows: [], command: 'BEGIN' }; }
    if (/^(COMMIT|END)$/i.test(text)) { const failed = b.tx === 'E'; b.tx = 'I'; return { fields: [], rows: [], command: failed ? 'ROLLBACK' : 'COMMIT' }; }
    if (/^ROLLBACK$/i.test(text)) { b.tx = 'I'; return { fields: [], rows: [], command: 'ROLLBACK' }; }
    if (/^SHOW server_version$/i.test(text)) return { fields: ['server_version'], rows: [['16.4 (fake)']], command: 'SHOW' };
    if (/FROM pg_type/i.test(text)) return { fields: ['oid', 'format_type', 'typcategory'], rows: [['23', 'integer', 'N'], ['25', 'text', 'S']], command: 'SELECT 2' };
    if ((m = /^SELECT pg_sleep\(([\d.]+)\)$/i.exec(text))) {
      const ms = Number(m[1]) * 1000;
      const timeout = Number(b.settings.get('statement_timeout') ?? '0');
      const reason = await new Promise<'done' | 'cancel' | 'timeout'>((resolve) => {
        const t1 = setTimeout(() => resolve('done'), ms);
        const t2 = timeout > 0 && timeout < ms ? setTimeout(() => resolve('timeout'), timeout) : null;
        b.sleeping = () => { clearTimeout(t1); if (t2) clearTimeout(t2); resolve('cancel'); };
      });
      b.sleeping = null;
      if (reason === 'timeout') throw new SqlError('57014', 'canceling statement due to statement timeout');
      if (reason === 'cancel') throw new SqlError('57014', 'canceling statement due to user request');
      return { fields: ['pg_sleep'], rows: [['']], command: 'SELECT 1' };
    }
    if (/^SELECT pg_cancel_backend\(\$1\)$/i.test(text)) {
      const pid = Number(params[0]);
      cancels.push({ via: 'function', pid });
      return { fields: ['pg_cancel_backend'], rows: [[cancel(pid) ? 't' : 'f']], command: 'SELECT 1' };
    }
    if (/^SELECT 1$/i.test(text)) return { fields: ['?column?'], rows: [['1']], command: 'SELECT 1' };
    if ((m = /^SELECT current_setting\('([\w.]+)'\)$/i.exec(text))) return { fields: ['current_setting'], rows: [[b.settings.get(m[1].toLowerCase()) ?? '']], command: 'SELECT 1' };
    throw new SqlError('42601', `fake server does not know: ${text.slice(0, 80)}`);
  }

  function serve(raw: Socket): void {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => undefined);
    let stream: Duplex = raw;
    let buf = Buffer.alloc(0);
    let started = false;
    let tlsOn = false;
    let backend: Backend | null = null;
    let authState: { user: string; database: string; salt?: Buffer } | null = null;
    let busy = Promise.resolve();
    // Extended protocol state.
    let parsed = '';
    let bound: Array<string | null> = [];
    let portal: { rows: Array<Array<string | null>>; fields: string[]; command: string; at: number; error?: SqlError } | null = null;
    let skipToSync = false;
    const write = (b: Buffer) => { try { stream.write(b); } catch { /* gone */ } };

    const finishLogin = (user: string, database: string) => {
      if (database === 'missing') { write(errorResponse('3D000', `database "${database}" does not exist`)); stream.end(); return; }
      const pid = nextPid++;
      backend = { pid, secret: randomBytes(4).readInt32BE(), settings: new Map(), tx: 'I', sleeping: null };
      backends.set(pid, backend);
      stream.on('close', () => backends.delete(pid));
      logins.push({ user, database, tls: tlsOn });
      write(msg('R', int32(0)));
      for (const [k, v] of [['server_version', '16.4 (fake)'], ['client_encoding', 'UTF8'], ['standard_conforming_strings', 'on'], ['DateStyle', 'ISO, MDY'], ['integer_datetimes', 'on']]) write(msg('S', Buffer.concat([cstr(k), cstr(v)])));
      write(msg('K', Buffer.concat([int32(pid), int32(backend.secret)])));
      write(msg('Z', Buffer.from(backend.tx)));
    };

    const onStartup = (body: Buffer): boolean => {
      const code = body.readInt32BE(0);
      if (code === 80877103) { // SSLRequest
        if (!opts.tls) { write(Buffer.from('N')); return true; }
        write(Buffer.from('S'));
        const secure = new TLSSocket(raw, { isServer: true, key: opts.tls.key, cert: opts.tls.cert });
        secure.on('error', () => raw.destroy());
        raw.removeAllListeners('data');
        stream = secure;
        tlsOn = true;
        buf = Buffer.alloc(0);
        secure.on('data', onData);
        return false;
      }
      if (code === 80877102) { // CancelRequest
        const pid = body.readInt32BE(4), secret = body.readInt32BE(8);
        const b = backends.get(pid);
        if (b && b.secret === secret) { cancels.push({ via: 'protocol', pid }); cancel(pid); }
        stream.end();
        return false;
      }
      const parts = body.subarray(4).toString('utf8').split('\0');
      const params: Record<string, string> = {};
      for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) params[parts[i]] = parts[i + 1];
      const user = params.user ?? '', database = params.database ?? user;
      started = true;
      if (opts.requireTls && !tlsOn) { write(errorResponse('28000', 'no pg_hba.conf entry for host "127.0.0.1", no encryption')); stream.end(); return false; }
      if (opts.password === undefined) { finishLogin(user, database); return true; }
      if (opts.auth === 'md5') { const salt = randomBytes(4); authState = { user, database, salt }; write(msg('R', Buffer.concat([int32(5), salt]))); }
      else { authState = { user, database }; write(msg('R', int32(3))); }
      return true;
    };

    const onMessage = (type: string, body: Buffer) => {
      if (type === 'p' && authState) {
        const given = body.subarray(0, body.length - 1).toString('utf8');
        const { user, database, salt } = authState;
        authState = null;
        const md5 = (s: string | Buffer) => createHash('md5').update(s).digest('hex');
        const expected = salt ? `md5${md5(Buffer.concat([Buffer.from(md5(opts.password! + user)), salt]))}` : opts.password!;
        if (given !== expected) { write(errorResponse('28P01', `password authentication failed for user "${user}"`)); stream.end(); return; }
        finishLogin(user, database);
        return;
      }
      const b = backend;
      if (!b) return;
      if (type === 'X') { stream.end(); return; }
      if (type === 'Q') {
        const sql = body.subarray(0, body.length - 1).toString('utf8');
        busy = busy.then(async () => {
          try {
            const r = await run(b, sql, []);
            if (r.fields.length) { write(rowDescription(r.fields)); for (const row of r.rows) write(dataRow(row)); }
            write(msg('C', cstr(r.command)));
          } catch (e) {
            if (b.tx === 'T') b.tx = 'E';
            write(e instanceof SqlError ? errorResponse(e.code, e.message) : errorResponse('XX000', 'internal'));
          }
          write(msg('Z', Buffer.from(b.tx)));
        });
        return;
      }
      busy = busy.then(async () => {
        if (type === 'S') { skipToSync = false; portal = null; write(msg('Z', Buffer.from(b.tx))); return; }
        if (skipToSync) return;
        if (type === 'H') return;
        if (type === 'P') { const name = body.subarray(0, body.indexOf(0)); parsed = body.subarray(name.length + 1, body.indexOf(0, name.length + 1)).toString('utf8'); write(msg('1')); return; }
        if (type === 'B') {
          let at = body.indexOf(0) + 1; // portal
          at = body.indexOf(0, at) + 1; // statement
          const nFormats = body.readInt16BE(at); at += 2 + nFormats * 2;
          const n = body.readInt16BE(at); at += 2;
          bound = [];
          for (let i = 0; i < n; i++) { const len = body.readInt32BE(at); at += 4; if (len < 0) bound.push(null); else { bound.push(body.subarray(at, at + len).toString('utf8')); at += len; } }
          write(msg('2'));
          try { const r = await run(b, parsed, bound); portal = { ...r, at: 0 }; } catch (e) { portal = { rows: [], fields: [], command: '', at: 0, error: e instanceof SqlError ? e : new SqlError('XX000', 'internal') }; }
          return;
        }
        if (type === 'D') {
          if (portal?.error) { if (b.tx === 'T') b.tx = 'E'; write(errorResponse(portal.error.code, portal.error.message)); skipToSync = true; return; }
          write(portal && portal.fields.length ? rowDescription(portal.fields) : msg('n'));
          return;
        }
        if (type === 'E') {
          if (!portal) return;
          if (portal.error) { if (b.tx === 'T') b.tx = 'E'; write(errorResponse(portal.error.code, portal.error.message)); skipToSync = true; return; }
          const max = body.readInt32BE(body.indexOf(0) + 1);
          const end = max > 0 ? Math.min(portal.rows.length, portal.at + max) : portal.rows.length;
          for (; portal.at < end; portal.at++) write(dataRow(portal.rows[portal.at]));
          if (portal.at < portal.rows.length) write(msg('s'));
          else write(msg('C', cstr(portal.command)));
          return;
        }
        if (type === 'C') { write(msg('3')); return; }
      });
    };

    function onData(chunk: Buffer): void {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 4) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const body = buf.subarray(4, len);
          buf = buf.subarray(len);
          if (!onStartup(body)) return;
          continue;
        }
        if (buf.length < 5) return;
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const type = String.fromCharCode(buf[0]);
        const body = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        onMessage(type, body);
      }
    }
    raw.on('data', onData);
  }

  const server: Server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    logins, statements, cancels,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}
