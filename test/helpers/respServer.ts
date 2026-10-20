// In-process Redis-compatible test server (1.0.0): 127.0.0.1 only, RESP2 and RESP3 (HELLO), an in-memory keyspace with
// strings, hashes, lists, sets, sorted sets and streams, TTLs, SCAN with MATCH/COUNT/TYPE, AUTH (requirepass and ACL users),
// SELECT, MULTI/EXEC/WATCH, Pub/Sub, INFO, SLOWLOG, CLIENT LIST, MEMORY USAGE and COMMAND INFO, plus test hooks (denied
// commands, dropped clients, a stopped listener, TLS). Keys and values are binary safe (Buffers; keys as latin1 strings).
// Erasable TypeScript only and no relative imports: scripts/redis-test-server.mjs loads this file with Node's type stripping.
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';

export interface RespServerOptions {
  port?: number;
  /** requirepass: the default user needs this password. */
  password?: string;
  /** ACL users (name -> password) besides "default". */
  users?: Record<string, string>;
  databases?: number;
  /** Commands answered with -NOPERM (upper case, "MEMORY USAGE", "CONFIG GET", "COMMAND INFO", "INFO" ...). */
  deny?: string[];
  /** An old server: SCAN without TYPE (syntax error), no UNLINK, no HELLO. */
  noScanType?: boolean;
  noUnlink?: boolean;
  noHello?: boolean;
  /**
   * SCAN family like real Redis: cursors are stable positions (deleting an item never shifts the others); `scanRepeat` also
   * returns the last item of each page again at the start of the next one (Redis may return an element twice);
   * `wholeSmall`: H/S/ZSCAN of a container with at most this many items returns all of it at once with cursor 0 (listpack).
   */
  scanRepeat?: boolean;
  wholeSmall?: number;
  /** Renamed commands (new name -> real one), like rename-command; the real name is then unknown. */
  renames?: Record<string, string>;
  /** Redis 6 style: COMMAND INFO of a container has no subcommand entries. Before Redis 6: SET has no KEEPTTL. */
  noSubcommandInfo?: boolean;
  noKeepTtl?: boolean;
  /** Delays one command (upper case name, "MEMORY USAGE" style for subcommands) by ms before it runs. */
  commandDelays?: Record<string, number>;
  version?: string;
  /** Serve TLS with this key and certificate (PEM). */
  tls?: { key: string; cert: string };
}

type Reply =
  | { k: 'simple'; v: string } | { k: 'err'; v: string } | { k: 'int'; v: number | bigint } | { k: 'bulk'; v: Buffer | null }
  | { k: 'arr'; v: Reply[] | null } | { k: 'map'; v: Array<[Reply, Reply]> } | { k: 'push'; v: Reply[] } | { k: 'none' };

const S = (v: string): Reply => ({ k: 'simple', v });
const E = (v: string): Reply => ({ k: 'err', v });
const I = (v: number | bigint): Reply => ({ k: 'int', v });
const B = (v: Buffer | string | null): Reply => ({ k: 'bulk', v: v === null ? null : typeof v === 'string' ? Buffer.from(v) : v });
const A = (v: Reply[] | null): Reply => ({ k: 'arr', v });
const OK = S('OK');
const WRONGTYPE = E('WRONGTYPE Operation against a key holding the wrong kind of value');
const SYNTAX = E('ERR syntax error');
const NOT_INT = E('ERR value is not an integer or out of range');

type StreamId = [bigint, bigint];
interface StreamEntry { id: StreamId; fields: Buffer[] }
type Value =
  | { type: 'string'; v: Buffer }
  | { type: 'hash'; v: Map<string, Buffer> }
  | { type: 'list'; v: Buffer[] }
  | { type: 'set'; v: Map<string, Buffer> }
  | { type: 'zset'; v: Map<string, { member: Buffer; score: number }> }
  | { type: 'stream'; v: StreamEntry[]; last: StreamId };
interface Entry { value: Value; expireAt?: number }

interface Conn {
  id: number;
  sock: Socket;
  db: number;
  proto: 2 | 3;
  authed: boolean;
  user: string;
  name: string;
  subs: Set<string>;
  psubs: Set<string>;
  multi: Buffer[][] | null;
  multiError: boolean;
  watched: Map<string, number> | null;
  queue: Promise<void>;
  created: number;
  lastCmd: string;
}

export interface RespLogEntry { conn: number; db: number; argv: string[] }
export interface RespSlowEntry { id: number; time: number; durationUs: number; args: string[]; client: string; name: string }

export interface RespServer {
  port: number;
  /** Every command received (argv as UTF-8 text). */
  log: RespLogEntry[];
  slowlog: RespSlowEntry[];
  /** dbs[i]: key (latin1) -> entry. */
  dbs: Array<Map<string, Entry>>;
  options: RespServerOptions;
  connections(): number;
  /** Destroys every client connection (the clients see a dropped connection). */
  dropClients(): void;
  /** Destroys only the connections in subscriber mode. */
  dropSubscribers(): void;
  /** Stops accepting connections (refused) and drops the open ones, until resume(). */
  stopListening(): Promise<void>;
  resume(): Promise<void>;
  /** Delays every reply by this many ms (0: none). */
  delayMs: number;
  /** Per-command delays (mutable; see RespServerOptions.commandDelays). */
  commandDelays: Record<string, number>;
  /** Sets a string key directly (tests). */
  setString(key: string | Buffer, value: string | Buffer, db?: number): void;
  close(): Promise<void>;
}

const keyOf = (b: Buffer): string => b.toString('latin1');
const bufOf = (k: string): Buffer => Buffer.from(k, 'latin1');
const up = (b: Buffer | undefined): string => (b ? b.toString('utf8').toUpperCase() : '');
const num = (b: Buffer | undefined): number | null => {
  if (!b) return null;
  const s = b.toString();
  return /^-?\d+$/.test(s) ? Number(s) : null;
};
const fmtScore = (n: number): string => (n === Infinity ? 'inf' : n === -Infinity ? '-inf' : String(n));
const parseScore = (b: Buffer | undefined): number | null => {
  if (!b) return null;
  const s = b.toString().toLowerCase();
  if (s === 'inf' || s === '+inf') return Infinity;
  if (s === '-inf') return -Infinity;
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
};

/** Redis glob (stringmatchlen): * ? [abc] [^a] [a-z] and \ escapes, on latin1 strings (byte by byte). */
export function globMatch(pattern: string, text: string): boolean {
  const memo = new Map<string, boolean>();
  const go = (p: number, t: number): boolean => {
    const key = `${p},${t}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (p === pattern.length) r = t === text.length;
    else {
      const c = pattern[p];
      if (c === '*') r = go(p + 1, t) || (t < text.length && go(p, t + 1));
      else if (t >= text.length) r = false;
      else if (c === '?') r = go(p + 1, t + 1);
      else if (c === '[') {
        let q = p + 1;
        const not = pattern[q] === '^';
        if (not) q++;
        let match = false;
        while (q < pattern.length && pattern[q] !== ']') {
          if (pattern[q] === '\\' && q + 1 < pattern.length) { q++; if (pattern[q] === text[t]) match = true; q++; continue; }
          if (pattern[q + 1] === '-' && q + 2 < pattern.length && pattern[q + 2] !== ']') {
            let lo = pattern.charCodeAt(q), hi = pattern.charCodeAt(q + 2);
            if (lo > hi) [lo, hi] = [hi, lo];
            const ch = text.charCodeAt(t);
            if (ch >= lo && ch <= hi) match = true;
            q += 3;
            continue;
          }
          if (pattern[q] === text[t]) match = true;
          q++;
        }
        r = (not ? !match : match) && go(Math.min(q + 1, pattern.length), t + 1);
      } else if (c === '\\' && p + 1 < pattern.length) r = pattern[p + 1] === text[t] && go(p + 2, t + 1);
      else r = c === text[t] && go(p + 1, t + 1);
    }
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

const ID_MAX = 18446744073709551615n;
const idStr = (id: StreamId): string => `${id[0]}-${id[1]}`;
const idCmp = (a: StreamId, b: StreamId): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
function parseRangeId(s: string, isStart: boolean): { id: StreamId; exclusive: boolean } | null {
  let exclusive = false;
  if (s.startsWith('(')) { exclusive = true; s = s.slice(1); }
  if (s === '-') return { id: [0n, 0n], exclusive };
  if (s === '+') return { id: [ID_MAX, ID_MAX], exclusive };
  const m = /^(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) return null;
  return { id: [BigInt(m[1]), m[2] !== undefined ? BigInt(m[2]) : isStart ? 0n : ID_MAX], exclusive };
}

/** The command table COMMAND INFO answers from: flags of the commands this server knows, subcommands as "name|sub". */
const FLAGS: Record<string, string[]> = {
  get: ['readonly', 'fast'], set: ['write', 'denyoom'], getrange: ['readonly'], strlen: ['readonly', 'fast'], del: ['write'], unlink: ['write', 'fast'],
  exists: ['readonly', 'fast'], type: ['readonly', 'fast'], ttl: ['readonly', 'fast'], pttl: ['readonly', 'fast'], expire: ['write', 'fast'],
  pexpire: ['write', 'fast'], persist: ['write', 'fast'], rename: ['write'], renamenx: ['write', 'fast'], keys: ['readonly'], scan: ['readonly'],
  dbsize: ['readonly', 'fast'], randomkey: ['readonly'], hget: ['readonly', 'fast'], hset: ['write', 'denyoom', 'fast'], hsetnx: ['write', 'denyoom', 'fast'],
  hdel: ['write', 'fast'], hlen: ['readonly', 'fast'], hgetall: ['readonly'], hscan: ['readonly'], lrange: ['readonly'], llen: ['readonly', 'fast'],
  lindex: ['readonly'], lpush: ['write', 'denyoom', 'fast'], rpush: ['write', 'denyoom', 'fast'], lset: ['write', 'denyoom'], lrem: ['write'],
  sadd: ['write', 'denyoom', 'fast'], srem: ['write', 'fast'], scard: ['readonly', 'fast'], smembers: ['readonly'], sscan: ['readonly'], sismember: ['readonly', 'fast'],
  zadd: ['write', 'denyoom', 'fast'], zrem: ['write', 'fast'], zcard: ['readonly', 'fast'], zscore: ['readonly', 'fast'], zincrby: ['write', 'denyoom', 'fast'],
  zrange: ['readonly'], zscan: ['readonly'], xadd: ['write', 'denyoom', 'fast'], xrange: ['readonly'], xread: ['readonly', 'blocking', 'movablekeys'], replconf: ['admin', 'noscript', 'loading', 'stale', 'allow_busy'], xrevrange: ['readonly'], xdel: ['write', 'fast'],
  xtrim: ['write'], xlen: ['readonly', 'fast'], select: ['loading', 'stale', 'fast'], ping: ['fast'], echo: ['fast'], info: ['loading', 'stale'],
  flushdb: ['write'], flushall: ['write'], publish: ['pubsub', 'loading', 'stale', 'fast', 'may_replicate'], subscribe: ['pubsub', 'noscript', 'loading', 'stale'],
  psubscribe: ['pubsub', 'noscript', 'loading', 'stale'], unsubscribe: ['pubsub', 'noscript', 'loading', 'stale'], punsubscribe: ['pubsub', 'noscript', 'loading', 'stale'],
  multi: ['noscript', 'loading', 'stale', 'fast', 'allow_busy'], exec: ['noscript', 'loading', 'stale', 'skip_slowlog'], watch: ['noscript', 'loading', 'stale', 'fast'],
  eval: ['noscript', 'stale', 'skip_monitor', 'may_replicate', 'no_mandatory_keys', 'movablekeys'], time: ['loading', 'stale', 'fast'],
  blpop: ['write', 'blocking'], debug: ['admin', 'noscript', 'loading', 'stale'], auth: ['noscript', 'loading', 'stale', 'fast', 'no_auth', 'allow_busy'],
  hello: ['noscript', 'loading', 'stale', 'fast', 'no_auth', 'allow_busy'], quit: ['noscript', 'loading', 'stale', 'fast', 'no_auth', 'allow_busy'],
  shutdown: ['admin', 'noscript', 'loading', 'stale', 'no_multi', 'sentinel', 'allow_busy'], swapdb: ['write', 'fast'],
};
/** Commands (and "name|sub") in the @dangerous ACL category. */
const DANGEROUS = new Set(['flushall', 'flushdb', 'keys', 'debug', 'shutdown', 'swapdb', 'info', 'config|set', 'config|rewrite', 'config|resetstat', 'client|kill', 'client|list', 'slowlog|get', 'slowlog|reset']);
const SUBS: Record<string, Record<string, string[]>> = {
  config: { get: ['admin', 'noscript', 'loading', 'stale'], set: ['admin', 'noscript', 'loading', 'stale'], resetstat: ['admin', 'noscript', 'loading', 'stale'], rewrite: ['admin', 'noscript', 'loading', 'stale'] },
  client: { list: ['admin', 'noscript', 'loading', 'stale'], setname: ['noscript', 'loading', 'stale'], getname: ['noscript', 'loading', 'stale'], setinfo: ['noscript', 'loading', 'stale'], kill: ['admin', 'noscript', 'loading', 'stale'], id: ['noscript', 'loading', 'stale'] },
  memory: { usage: ['readonly'] },
  slowlog: { get: ['admin', 'loading', 'stale'], len: ['admin', 'loading', 'stale'], reset: ['admin', 'loading', 'stale'] },
  command: { info: ['loading', 'stale'], count: ['loading', 'stale'] },
};

export async function startRespServer(opts: RespServerOptions = {}): Promise<RespServer> {
  const ndb = opts.databases ?? 16;
  const dbs: Array<Map<string, Entry>> = Array.from({ length: ndb }, () => new Map());
  const versions = new Map<string, number>();
  const conns = new Set<Conn>();
  const log: RespLogEntry[] = [];
  const slowlog: RespSlowEntry[] = [];
  const deny = new Set((opts.deny ?? []).map((d) => d.toUpperCase()));
  const users: Record<string, string> = { ...(opts.users ?? {}) };
  let nextConn = 1;
  let slowId = 0;

  const touch = (db: number, key: string) => versions.set(`${db}:${key}`, (versions.get(`${db}:${key}`) ?? 0) + 1);
  const version = (db: number, key: string) => versions.get(`${db}:${key}`) ?? 0;
  const lookup = (db: number, key: string): Entry | undefined => {
    const e = dbs[db].get(key);
    if (e && e.expireAt !== undefined && e.expireAt <= Date.now()) { dbs[db].delete(key); touch(db, key); return undefined; }
    return e;
  };
  const setEntry = (db: number, key: string, value: Value, expireAt?: number) => { dbs[db].set(key, { value, ...(expireAt !== undefined ? { expireAt } : {}) }); touch(db, key); };
  const remove = (db: number, key: string): boolean => { const had = !!lookup(db, key); if (had) { dbs[db].delete(key); touch(db, key); } return had; };
  /** The entry of `type`, created when `create`; WRONGTYPE as a reply. */
  const typed = <T extends Value['type']>(c: Conn, key: Buffer, type: T, create: boolean): Extract<Value, { type: T }> | null | Reply => {
    const e = lookup(c.db, keyOf(key));
    if (e) return e.value.type === type ? e.value as Extract<Value, { type: T }> : WRONGTYPE;
    if (!create) return null;
    const v = (type === 'hash' || type === 'set' || type === 'zset' ? { type, v: new Map() } : type === 'list' ? { type, v: [] } : type === 'stream' ? { type, v: [], last: [0n, 0n] } : { type, v: Buffer.alloc(0) }) as Extract<Value, { type: T }>;
    setEntry(c.db, keyOf(key), v);
    return v;
  };
  const isReply = (x: unknown): x is Reply => !!x && typeof x === 'object' && 'k' in (x as object);
  const dropIfEmpty = (c: Conn, key: Buffer) => {
    const e = lookup(c.db, keyOf(key));
    if (!e) return;
    const v = e.value;
    const size = v.type === 'string' ? 1 : v.type === 'list' || v.type === 'stream' ? (v.type === 'stream' ? 1 : v.v.length) : v.v.size;
    if (size === 0) remove(c.db, keyOf(key));
  };

  function encode(r: Reply, proto: 2 | 3): Buffer[] {
    switch (r.k) {
      case 'none': return [];
      case 'simple': return [Buffer.from(`+${r.v}\r\n`)];
      case 'err': return [Buffer.from(`-${r.v}\r\n`)];
      case 'int': return [Buffer.from(`:${r.v}\r\n`)];
      case 'bulk': return r.v === null ? [Buffer.from(proto === 3 ? '_\r\n' : '$-1\r\n')] : [Buffer.from(`$${r.v.length}\r\n`), r.v, Buffer.from('\r\n')];
      case 'arr': return r.v === null ? [Buffer.from(proto === 3 ? '_\r\n' : '*-1\r\n')] : [Buffer.from(`*${r.v.length}\r\n`), ...r.v.flatMap((x) => encode(x, proto))];
      case 'map': return proto === 3
        ? [Buffer.from(`%${r.v.length}\r\n`), ...r.v.flatMap(([k, v]) => [...encode(k, proto), ...encode(v, proto)])]
        : [Buffer.from(`*${r.v.length * 2}\r\n`), ...r.v.flatMap(([k, v]) => [...encode(k, proto), ...encode(v, proto)])];
      case 'push': return [Buffer.from(`${proto === 3 ? '>' : '*'}${r.v.length}\r\n`), ...r.v.flatMap((x) => encode(x, proto))];
    }
  }
  const send = (c: Conn, r: Reply) => { if (!c.sock.destroyed) c.sock.write(Buffer.concat(encode(r, c.proto))); };

  const subscribed = (c: Conn) => c.subs.size + c.psubs.size;
  function publish(channel: Buffer, message: Buffer): number {
    let n = 0;
    const ch = keyOf(channel);
    for (const c of conns) {
      if (c.subs.has(ch)) { send(c, { k: 'push', v: [B('message'), B(channel), B(message)] }); n++; }
      for (const p of c.psubs) if (globMatch(p, ch)) { send(c, { k: 'push', v: [B('pmessage'), B(bufOf(p)), B(channel), B(message)] }); n++; }
    }
    return n;
  }

  function infoText(section: string | undefined, c: Conn): string {
    const all: Record<string, string[]> = {
      server: [`redis_version:${opts.version ?? '7.2.4'}`, 'redis_mode:standalone', 'os:unimux test', `tcp_port:${server.port}`, 'uptime_in_seconds:1'],
      clients: [`connected_clients:${conns.size}`, 'blocked_clients:0'],
      memory: ['used_memory:1048576', 'used_memory_human:1.00M', 'maxmemory:0'],
      stats: ['total_connections_received:1', 'total_commands_processed:1'],
      replication: ['role:master', 'connected_slaves:0'],
      keyspace: dbs.flatMap((m, i) => {
        let keys = 0, expires = 0;
        for (const k of [...m.keys()]) { const e = lookup(i, k); if (e) { keys++; if (e.expireAt !== undefined) expires++; } }
        return keys ? [`db${i}:keys=${keys},expires=${expires},avg_ttl=0`] : [];
      }),
    };
    void c;
    const names = section && !['all', 'default', 'everything'].includes(section.toLowerCase()) ? [section.toLowerCase()] : Object.keys(all);
    return names.filter((n) => all[n]).map((n) => `# ${n[0].toUpperCase()}${n.slice(1)}\r\n${all[n].join('\r\n')}${all[n].length ? '\r\n' : ''}`).join('\r\n');
  }

  const renamedFrom = new Map(Object.entries(opts.renames ?? {}).map(([to, from]) => [from.toLowerCase(), to.toLowerCase()]));
  function commandInfo(asked: string): Reply {
    const real = (opts.renames ?? {})[asked.toUpperCase()]?.toLowerCase() ?? (renamedFrom.has(asked) ? '' : asked);
    const flags = FLAGS[real];
    const subs = SUBS[real];
    if (!flags && !subs) return B(null);
    const cats = (n: string, f: string[]) => [...(f.includes('write') ? ['@write'] : []), ...(f.includes('readonly') ? ['@read'] : []), ...(DANGEROUS.has(n) ? ['@dangerous'] : [])];
    const entry = (n: string, shown: string, f: string[]): Reply => A([B(shown), I(-1), A(f.map(S)), I(0), I(0), I(0), A(cats(n, f).map(S)), A([]), A([]), A([])]);
    if (!subs) return entry(real, asked, flags!);
    if (opts.noSubcommandInfo) return entry(real, asked, ['admin', 'noscript', 'loading', 'stale']);
    const e = entry(real, asked, ['loading', 'stale']);
    (e as { v: Reply[] }).v[9] = A(Object.entries(subs).map(([s, f]) => entry(`${real}|${s}`, `${asked}|${s}`, f)));
    return e;
  }

  /** Stable positions per container (a key's position never changes; deleted keys leave a gap), like Redis' cursors. */
  const seqs = new WeakMap<object, Map<string, number>>();
  let nextSeq = 1;
  function ordered<T>(container: Map<string, T>): Array<[string, T, number]> {
    let s = seqs.get(container);
    if (!s) { s = new Map(); seqs.set(container, s); }
    for (const k of container.keys()) if (!s.has(k)) s.set(k, nextSeq++);
    return [...container.entries()].map(([k, v]) => [k, v, s!.get(k)!] as [string, T, number]).sort((x, y) => x[2] - y[2]);
  }

  /** SCAN-style iteration: the cursor is the position to go on from (0: start / done). */
  function scanItems<T>(container: Map<string, T>, cursorArg: Buffer | undefined, rest: Buffer[], extra?: (k: string, t: T, type: string | null) => boolean): { next: number; out: Array<[string, T]> } | Reply {
    const cursor = num(cursorArg);
    if (cursor === null || cursor < 0) return E('ERR invalid cursor');
    let count = 10, match: string | null = null, type: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      const o = up(rest[i]);
      if (o === 'COUNT') { const n = num(rest[++i]); if (n === null || n < 1) return SYNTAX; count = n; }
      else if (o === 'MATCH') { const m = rest[++i]; if (!m) return SYNTAX; match = keyOf(m); }
      else if (o === 'TYPE' && extra) { if (opts.noScanType) return SYNTAX; const t = rest[++i]; if (!t) return SYNTAX; type = t.toString(); }
      else if (o === 'NOVALUES') continue;
      else return SYNTAX;
    }
    const all = ordered(container);
    // A small hash, set or zset comes back whole (Redis ignores COUNT for listpack encodings).
    if (!extra && opts.wholeSmall !== undefined && all.length <= opts.wholeSmall) count = Infinity;
    const from = all.findIndex((x) => x[2] >= cursor);
    const out: Array<[string, T]> = [];
    if (from < 0) return { next: 0, out };
    let i = from;
    for (; i < all.length && i < from + count; i++) {
      const [k, v] = all[i];
      if (match !== null && !globMatch(match, k)) continue;
      if (extra && !extra(k, v, type)) continue;
      out.push([k, v]);
    }
    if (i >= all.length) return { next: 0, out };
    // scanRepeat: the next page starts with the last item of this one again (when that still makes progress).
    const next = opts.scanRepeat && i - 1 > from ? all[i - 1][2] : all[i][2];
    return { next, out };
  }

  function sortedZ(z: Map<string, { member: Buffer; score: number }>) {
    return [...z.values()].sort((a, b) => a.score - b.score || Buffer.compare(a.member, b.member));
  }

  function xrange(s: Extract<Value, { type: 'stream' }>, a: Buffer | undefined, b: Buffer | undefined, rest: Buffer[], rev: boolean): Reply {
    const startArg = rev ? b : a, endArg = rev ? a : b;
    if (!startArg || !endArg) return E('ERR wrong number of arguments');
    const st = parseRangeId(startArg.toString(), true), en = parseRangeId(endArg.toString(), false);
    if (!st || !en) return E('ERR Invalid stream ID specified as stream command argument');
    let count = Infinity;
    if (rest.length) { if (up(rest[0]) !== 'COUNT' || num(rest[1]) === null) return SYNTAX; count = num(rest[1])!; }
    let list = s.v.filter((e) => {
      const lo = idCmp(e.id, st.id), hi = idCmp(e.id, en.id);
      return (st.exclusive ? lo > 0 : lo >= 0) && (en.exclusive ? hi < 0 : hi <= 0);
    });
    if (rev) list = list.reverse();
    return A(list.slice(0, count).map((e) => A([B(idStr(e.id)), A(e.fields.map((f) => B(f)))])));
  }

  function lookupAuth(user: string, pass: string): boolean {
    if (user === 'default') return opts.password === undefined || opts.password === pass;
    return users[user] !== undefined && users[user] === pass;
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async function run(c: Conn, argv: Buffer[]): Promise<Reply> {
    const asked = up(argv[0]);
    const renamed = (opts.renames ?? {})[asked];
    if (!renamed && renamedFrom.has(asked.toLowerCase())) return E(`ERR unknown command '${argv[0].toString()}', with args beginning with: `);
    const cmd = renamed ? renamed.toUpperCase() : asked;
    const a = argv.slice(1);
    const sub = up(a[0]);
    const full = ['CONFIG', 'CLIENT', 'MEMORY', 'SLOWLOG', 'COMMAND', 'OBJECT', 'XINFO', 'ACL', 'SCRIPT', 'FUNCTION'].includes(cmd) && a.length ? `${cmd} ${sub}` : cmd;
    if (!c.authed && !['AUTH', 'HELLO', 'QUIT'].includes(cmd)) return E('NOAUTH Authentication required.');
    if (deny.has(full) || deny.has(cmd)) return E(`NOPERM User ${c.user} has no permissions to run the '${full.toLowerCase().replace(' ', '|')}' command`);
    if (c.multi && !['EXEC', 'DISCARD', 'MULTI', 'WATCH'].includes(cmd)) { c.multi.push(argv); return S('QUEUED'); }
    if (c.proto === 2 && subscribed(c) && !['SUBSCRIBE', 'PSUBSCRIBE', 'UNSUBSCRIBE', 'PUNSUBSCRIBE', 'PING', 'QUIT', 'RESET'].includes(cmd)) {
      return E(`ERR Can't execute '${cmd.toLowerCase()}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`);
    }
    const db = dbs[c.db];
    const k0 = a[0] ? keyOf(a[0]) : '';
    switch (cmd) {
      case 'PING': return c.proto === 2 && subscribed(c) ? A([B('pong'), B(a[0] ?? '')]) : a[0] ? B(a[0]) : S('PONG');
      case 'ECHO': return a[0] ? B(a[0]) : E('ERR wrong number of arguments for \'echo\' command');
      case 'QUIT': send(c, OK); c.sock.end(); return { k: 'none' };
      case 'HELLO': {
        if (opts.noHello) return E(`ERR unknown command 'HELLO', with args beginning with: ${a.map((x) => `'${x}' `).join('')}`);
        let proto = c.proto;
        let i = 0;
        if (a[0]) { const p = num(a[0]); if (p !== 2 && p !== 3) return E('NOPROTO unsupported protocol version'); proto = p; i = 1; }
        for (; i < a.length; i++) {
          const o = up(a[i]);
          if (o === 'AUTH') {
            const user = a[i + 1]?.toString() ?? '', pass = a[i + 2]?.toString() ?? '';
            i += 2;
            if (!lookupAuth(user, pass)) return E('WRONGPASS invalid username-password pair or user is disabled.');
            c.authed = true; c.user = user;
          } else if (o === 'SETNAME') { c.name = a[++i]?.toString() ?? ''; } else return SYNTAX;
        }
        if (!c.authed) return E('NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time');
        c.proto = proto;
        return { k: 'map', v: [[B('server'), B('redis')], [B('version'), B(opts.version ?? '7.2.4')], [B('proto'), I(proto)], [B('id'), I(c.id)], [B('mode'), B('standalone')], [B('role'), B('master')], [B('modules'), A([])]] };
      }
      case 'AUTH': {
        if (a.length === 1) {
          if (opts.password === undefined) return E('ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?');
          if (opts.password !== a[0].toString()) return E('WRONGPASS invalid username-password pair or user is disabled.');
          c.authed = true; c.user = 'default';
          return OK;
        }
        if (a.length === 2) {
          if (!lookupAuth(a[0].toString(), a[1].toString())) return E('WRONGPASS invalid username-password pair or user is disabled.');
          c.authed = true; c.user = a[0].toString();
          return OK;
        }
        return SYNTAX;
      }
      case 'SELECT': { const n = num(a[0]); if (n === null) return NOT_INT; if (n < 0 || n >= ndb) return E('ERR DB index is out of range'); c.db = n; return OK; }
      case 'CLIENT': {
        switch (sub) {
          case 'SETNAME': c.name = a[1]?.toString() ?? ''; return OK;
          case 'GETNAME': return c.name ? B(c.name) : B(null);
          case 'SETINFO': return OK;
          case 'ID': return I(c.id);
          case 'LIST': return B([...conns].map((x) => `id=${x.id} addr=127.0.0.1:${x.sock.remotePort ?? 0} laddr=127.0.0.1:${server.port} fd=8 name=${x.name} age=${Math.floor((Date.now() - x.created) / 1000)} idle=0 flags=${subscribed(x) ? 'P' : 'N'} db=${x.db} sub=${x.subs.size} psub=${x.psubs.size} multi=-1 cmd=${x.lastCmd} user=${x.user}\n`).join(''));
          case 'KILL': return OK;
          default: return E(`ERR unknown subcommand '${sub.toLowerCase()}'`);
        }
      }
      case 'INFO': return B(infoText(a[0]?.toString(), c));
      case 'CONFIG': {
        if (sub === 'GET') {
          const pat = a[1]?.toString() ?? '';
          const pairs: Array<[string, string]> = [['databases', String(ndb)], ['maxmemory', '0']].filter(([k]) => globMatch(pat, k)) as Array<[string, string]>;
          return c.proto === 3 ? { k: 'map', v: pairs.map(([k, v]) => [B(k), B(v)]) } : A(pairs.flatMap(([k, v]) => [B(k), B(v)]));
        }
        if (sub === 'SET' || sub === 'RESETSTAT' || sub === 'REWRITE') return OK;
        return E('ERR unknown subcommand');
      }
      case 'COMMAND': {
        if (sub === 'INFO') return A(a.slice(1).map((n) => commandInfo(n.toString().toLowerCase())));
        if (sub === 'COUNT') return I(Object.keys(FLAGS).length);
        return A([]);
      }
      case 'MEMORY': {
        if (sub !== 'USAGE') return E('ERR unknown subcommand');
        const e = a[1] ? lookup(c.db, keyOf(a[1])) : undefined;
        if (!e) return B(null);
        const v = e.value;
        const size = v.type === 'string' ? v.v.length : v.type === 'list' ? v.v.reduce((n, x) => n + x.length + 8, 0)
          : v.type === 'stream' ? v.v.reduce((n, x) => n + x.fields.reduce((m, f) => m + f.length, 16), 0) : [...v.v.values()].reduce((n: number, x: unknown) => n + (Buffer.isBuffer(x) ? x.length : (x as { member: Buffer }).member.length + 8) + 8, 0);
        return I(size + 56);
      }
      case 'SLOWLOG': {
        if (sub === 'GET') {
          const n = a[1] ? num(a[1]) ?? 10 : 10;
          const list = slowlog.slice().reverse().slice(0, n < 0 ? undefined : n);
          return A(list.map((e) => A([I(e.id), I(e.time), I(e.durationUs), A(e.args.map((x) => B(x))), B(e.client), B(e.name)])));
        }
        if (sub === 'LEN') return I(slowlog.length);
        if (sub === 'RESET') { slowlog.length = 0; return OK; }
        return E('ERR unknown subcommand');
      }
      case 'DEBUG': {
        if (sub === 'SLEEP') { const s = Number(a[1]?.toString() ?? '0'); await new Promise((r) => setTimeout(r, s * 1000)); return OK; }
        return OK;
      }
      case 'TIME': { const t = Date.now(); return A([B(String(Math.floor(t / 1000))), B(String((t % 1000) * 1000))]); }
      case 'DBSIZE': return I([...db.keys()].filter((k) => lookup(c.db, k)).length);
      case 'FLUSHDB': for (const k of [...db.keys()]) remove(c.db, k); return OK;
      case 'FLUSHALL': dbs.forEach((m, i) => { for (const k of [...m.keys()]) remove(i, k); }); return OK;
      case 'KEYS': { const p = a[0] ? keyOf(a[0]) : '*'; return A([...db.keys()].filter((k) => lookup(c.db, k) && globMatch(p, k)).map((k) => B(bufOf(k)))); }
      case 'SCAN': {
        const r = scanItems(db, a[0], a.slice(1), (k, _e, type) => { const e = lookup(c.db, k); return !!e && (type === null || e.value.type === type); });
        if (isReply(r)) return r;
        return A([B(String(r.next)), A(r.out.map(([k]) => B(bufOf(k))))]);
      }
      case 'TYPE': { const e = lookup(c.db, k0); return S(e ? e.value.type : 'none'); }
      case 'TTL': case 'PTTL': {
        const e = lookup(c.db, k0);
        if (!e) return I(-2);
        if (e.expireAt === undefined) return I(-1);
        const ms = Math.max(0, e.expireAt - Date.now());
        return I(cmd === 'TTL' ? Math.round(ms / 1000) : ms);
      }
      case 'EXPIRE': case 'PEXPIRE': {
        const e = lookup(c.db, k0);
        const n = num(a[1]);
        if (n === null) return NOT_INT;
        if (!e) return I(0);
        if (n <= 0) { remove(c.db, k0); return I(1); }
        e.expireAt = Date.now() + (cmd === 'EXPIRE' ? n * 1000 : n);
        touch(c.db, k0);
        return I(1);
      }
      case 'PERSIST': { const e = lookup(c.db, k0); if (!e || e.expireAt === undefined) return I(0); delete e.expireAt; touch(c.db, k0); return I(1); }
      case 'EXISTS': return I(a.filter((k) => lookup(c.db, keyOf(k))).length);
      case 'DEL': return I(a.filter((k) => remove(c.db, keyOf(k))).length);
      case 'UNLINK': if (opts.noUnlink) return E(`ERR unknown command 'UNLINK', with args beginning with: `); return I(a.filter((k) => remove(c.db, keyOf(k))).length);
      case 'RENAME': case 'RENAMENX': {
        const e = lookup(c.db, k0);
        if (!e || !a[1]) return E('ERR no such key');
        const to = keyOf(a[1]);
        if (cmd === 'RENAMENX' && to !== k0 && lookup(c.db, to)) return I(0);
        db.delete(k0); touch(c.db, k0);
        db.set(to, e); touch(c.db, to);
        return cmd === 'RENAME' ? OK : I(1);
      }
      case 'GET': { const s = typed(c, a[0], 'string', false); if (isReply(s)) return s; return B(s ? s.v : null); }
      case 'STRLEN': { const s = typed(c, a[0], 'string', false); if (isReply(s)) return s; return I(s ? s.v.length : 0); }
      case 'GETRANGE': {
        const s = typed(c, a[0], 'string', false); if (isReply(s)) return s;
        let st = num(a[1]), en = num(a[2]);
        if (st === null || en === null) return NOT_INT;
        const v = s ? s.v : Buffer.alloc(0);
        if (st < 0) st = Math.max(0, v.length + st);
        if (en < 0) en = v.length + en;
        en = Math.min(en, v.length - 1);
        return B(st > en || v.length === 0 ? Buffer.alloc(0) : v.subarray(st, en + 1));
      }
      case 'SET': {
        if (a.length < 2) return E('ERR wrong number of arguments for \'set\' command');
        let nx = false, xx = false, keep = false, get = false, exp: number | undefined;
        for (let i = 2; i < a.length; i++) {
          const o = up(a[i]);
          if (o === 'NX') nx = true; else if (o === 'XX') xx = true; else if (o === 'KEEPTTL' && !opts.noKeepTtl) keep = true; else if (o === 'GET') get = true;
          else if (o === 'EX' || o === 'PX') { const n = num(a[++i]); if (n === null || n <= 0) return E('ERR invalid expire time in \'set\' command'); exp = Date.now() + (o === 'EX' ? n * 1000 : n); }
          else return SYNTAX;
        }
        const old = lookup(c.db, k0);
        if (get && old && old.value.type !== 'string') return WRONGTYPE;
        const prev = old && old.value.type === 'string' ? old.value.v : null;
        if ((nx && old) || (xx && !old)) return get ? B(prev) : B(null);
        setEntry(c.db, k0, { type: 'string', v: Buffer.from(a[1]) }, exp ?? (keep ? old?.expireAt : undefined));
        return get ? B(prev) : OK;
      }
      case 'HSET': case 'HSETNX': {
        if (a.length < 3 || (a.length - 1) % 2) return E(`ERR wrong number of arguments for '${cmd.toLowerCase()}' command`);
        const h = typed(c, a[0], 'hash', true); if (isReply(h)) return h;
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          const f = keyOf(a[i]);
          if (cmd === 'HSETNX' && h!.v.has(f)) return I(0);
          if (!h!.v.has(f)) added++;
          h!.v.set(f, Buffer.from(a[i + 1]));
        }
        touch(c.db, k0);
        return I(added);
      }
      case 'HGET': { const h = typed(c, a[0], 'hash', false); if (isReply(h)) return h; return B(h?.v.get(keyOf(a[1])) ?? null); }
      case 'HDEL': { const h = typed(c, a[0], 'hash', false); if (isReply(h)) return h; if (!h) return I(0); const n = a.slice(1).filter((f) => h.v.delete(keyOf(f))).length; touch(c.db, k0); dropIfEmpty(c, a[0]); return I(n); }
      case 'HLEN': { const h = typed(c, a[0], 'hash', false); if (isReply(h)) return h; return I(h ? h.v.size : 0); }
      case 'HGETALL': { const h = typed(c, a[0], 'hash', false); if (isReply(h)) return h; const pairs = h ? [...h.v.entries()] : []; return c.proto === 3 ? { k: 'map', v: pairs.map(([f, v]) => [B(bufOf(f)), B(v)]) } : A(pairs.flatMap(([f, v]) => [B(bufOf(f)), B(v)])); }
      case 'HSCAN': {
        const h = typed(c, a[0], 'hash', false); if (isReply(h)) return h;
        const r = scanItems(h ? h.v : new Map<string, Buffer>(), a[1], a.slice(2));
        if (isReply(r)) return r;
        return A([B(String(r.next)), A(r.out.flatMap(([f, v]) => [B(bufOf(f)), B(v)]))]);
      }
      case 'LPUSH': case 'RPUSH': {
        if (a.length < 2) return E('ERR wrong number of arguments');
        const l = typed(c, a[0], 'list', true); if (isReply(l)) return l;
        for (const v of a.slice(1)) { if (cmd === 'LPUSH') l!.v.unshift(Buffer.from(v)); else l!.v.push(Buffer.from(v)); }
        touch(c.db, k0);
        return I(l!.v.length);
      }
      case 'LLEN': { const l = typed(c, a[0], 'list', false); if (isReply(l)) return l; return I(l ? l.v.length : 0); }
      case 'LINDEX': { const l = typed(c, a[0], 'list', false); if (isReply(l)) return l; let i = num(a[1]); if (i === null) return NOT_INT; if (!l) return B(null); if (i < 0) i += l.v.length; return B(l.v[i] ?? null); }
      case 'LRANGE': {
        const l = typed(c, a[0], 'list', false); if (isReply(l)) return l;
        let st = num(a[1]), en = num(a[2]);
        if (st === null || en === null) return NOT_INT;
        const v = l ? l.v : [];
        if (st < 0) st = Math.max(0, v.length + st);
        if (en < 0) en = v.length + en;
        return A(v.slice(st, en + 1).map((x) => B(x)));
      }
      case 'LSET': {
        const l = typed(c, a[0], 'list', false); if (isReply(l)) return l;
        if (!l) return E('ERR no such key');
        let i = num(a[1]); if (i === null) return NOT_INT;
        if (i < 0) i += l.v.length;
        if (i < 0 || i >= l.v.length) return E('ERR index out of range');
        l.v[i] = Buffer.from(a[2]); touch(c.db, k0);
        return OK;
      }
      case 'LREM': {
        const l = typed(c, a[0], 'list', false); if (isReply(l)) return l;
        const n = num(a[1]); if (n === null) return NOT_INT;
        if (!l) return I(0);
        const target = a[2];
        let removed = 0;
        const idx = l.v.map((x, i) => (x.equals(target) ? i : -1)).filter((i) => i >= 0);
        const pick = n === 0 ? idx : n > 0 ? idx.slice(0, n) : idx.slice(n);
        for (const i of pick.sort((x, y) => y - x)) { l.v.splice(i, 1); removed++; }
        touch(c.db, k0); dropIfEmpty(c, a[0]);
        return I(removed);
      }
      case 'SADD': { const s = typed(c, a[0], 'set', true); if (isReply(s)) return s; let n = 0; for (const m of a.slice(1)) if (!s!.v.has(keyOf(m))) { s!.v.set(keyOf(m), Buffer.from(m)); n++; } touch(c.db, k0); return I(n); }
      case 'SREM': { const s = typed(c, a[0], 'set', false); if (isReply(s)) return s; if (!s) return I(0); const n = a.slice(1).filter((m) => s.v.delete(keyOf(m))).length; touch(c.db, k0); dropIfEmpty(c, a[0]); return I(n); }
      case 'SCARD': { const s = typed(c, a[0], 'set', false); if (isReply(s)) return s; return I(s ? s.v.size : 0); }
      case 'SISMEMBER': { const s = typed(c, a[0], 'set', false); if (isReply(s)) return s; return I(s?.v.has(keyOf(a[1])) ? 1 : 0); }
      case 'SMEMBERS': { const s = typed(c, a[0], 'set', false); if (isReply(s)) return s; return A(s ? [...s.v.values()].map((x) => B(x)) : []); }
      case 'SSCAN': {
        const s = typed(c, a[0], 'set', false); if (isReply(s)) return s;
        const r = scanItems(s ? s.v : new Map<string, Buffer>(), a[1], a.slice(2));
        if (isReply(r)) return r;
        return A([B(String(r.next)), A(r.out.map(([, m]) => B(m)))]);
      }
      case 'ZADD': {
        let i = 1, nx = false, xx = false, ch = false;
        for (; i < a.length; i++) { const o = up(a[i]); if (o === 'NX') nx = true; else if (o === 'XX') xx = true; else if (o === 'CH') ch = true; else break; }
        const pairs = a.slice(i);
        if (!pairs.length || pairs.length % 2) return SYNTAX;
        for (let j = 0; j < pairs.length; j += 2) if (parseScore(pairs[j]) === null) return E('ERR value is not a valid float');
        const z = typed(c, a[0], 'zset', !xx); if (isReply(z)) return z;
        if (!z) return I(0);
        let added = 0, changed = 0;
        for (let j = 0; j < pairs.length; j += 2) {
          const score = parseScore(pairs[j])!, m = keyOf(pairs[j + 1]);
          const old = z.v.get(m);
          if ((nx && old) || (xx && !old)) continue;
          if (!old) added++; else if (old.score !== score) changed++;
          z.v.set(m, { member: Buffer.from(pairs[j + 1]), score });
        }
        touch(c.db, k0); dropIfEmpty(c, a[0]);
        return I(ch ? added + changed : added);
      }
      case 'ZINCRBY': {
        const by = parseScore(a[1]); if (by === null) return E('ERR value is not a valid float');
        const z = typed(c, a[0], 'zset', true); if (isReply(z)) return z;
        const m = keyOf(a[2]);
        const score = (z!.v.get(m)?.score ?? 0) + by;
        z!.v.set(m, { member: Buffer.from(a[2]), score }); touch(c.db, k0);
        return B(fmtScore(score));
      }
      case 'ZREM': { const z = typed(c, a[0], 'zset', false); if (isReply(z)) return z; if (!z) return I(0); const n = a.slice(1).filter((m) => z.v.delete(keyOf(m))).length; touch(c.db, k0); dropIfEmpty(c, a[0]); return I(n); }
      case 'ZCARD': { const z = typed(c, a[0], 'zset', false); if (isReply(z)) return z; return I(z ? z.v.size : 0); }
      case 'ZSCORE': { const z = typed(c, a[0], 'zset', false); if (isReply(z)) return z; const e = z?.v.get(keyOf(a[1])); return B(e ? fmtScore(e.score) : null); }
      case 'ZRANGE': {
        const z = typed(c, a[0], 'zset', false); if (isReply(z)) return z;
        let st = num(a[1]), en = num(a[2]);
        if (st === null || en === null) return NOT_INT;
        let rev = false, ws = false;
        for (const o of a.slice(3)) { const u = up(o); if (u === 'REV') rev = true; else if (u === 'WITHSCORES') ws = true; else return SYNTAX; }
        let list = z ? sortedZ(z.v) : [];
        if (rev) list = list.reverse();
        if (st < 0) st = Math.max(0, list.length + st);
        if (en < 0) en = list.length + en;
        return A(list.slice(st, en + 1).flatMap((e) => (ws ? [B(e.member), B(fmtScore(e.score))] : [B(e.member)])));
      }
      case 'ZSCAN': {
        const z = typed(c, a[0], 'zset', false); if (isReply(z)) return z;
        const r = scanItems(z ? z.v : new Map<string, { member: Buffer; score: number }>(), a[1], a.slice(2));
        if (isReply(r)) return r;
        return A([B(String(r.next)), A(r.out.flatMap(([, e]) => [B(e.member), B(fmtScore(e.score))]))]);
      }
      case 'XADD': {
        let i = 1, maxLen: number | null = null;
        if (up(a[i]) === 'NOMKSTREAM') i++;
        if (up(a[i]) === 'MAXLEN') { i++; if (up(a[i]) === '~' || up(a[i]) === '=') i++; maxLen = num(a[i]); if (maxLen === null) return SYNTAX; i++; }
        const idArg = a[i]?.toString();
        const fields = a.slice(i + 1);
        if (!idArg || !fields.length || fields.length % 2) return E('ERR wrong number of arguments for \'xadd\' command');
        const s = typed(c, a[0], 'stream', false); if (isReply(s)) return s;
        let id: StreamId;
        const last = s ? s.last : [0n, 0n] as StreamId;
        if (idArg === '*') { const ms = BigInt(Date.now()); id = ms > last[0] ? [ms, 0n] : [last[0], last[1] + 1n]; }
        else {
          const m = /^(\d+)-(\d+|\*)$/.exec(idArg) ?? /^(\d+)$/.exec(idArg);
          if (!m) return E('ERR Invalid stream ID specified as stream command argument');
          const ms = BigInt(m[1]);
          id = m[2] === '*' || m[2] === undefined ? (ms === last[0] ? [ms, last[1] + 1n] : [ms, 0n]) : [ms, BigInt(m[2])];
          if (idCmp(id, [0n, 0n]) === 0) return E('ERR The ID specified in XADD must be greater than 0-0');
          if (s && idCmp(id, last) <= 0) return E('ERR The ID specified in XADD is equal or smaller than the target stream top item');
        }
        const st = s ?? (() => { const v: Extract<Value, { type: 'stream' }> = { type: 'stream', v: [], last: [0n, 0n] }; setEntry(c.db, k0, v); return v; })();
        st.v.push({ id, fields: fields.map((f) => Buffer.from(f)) });
        st.last = id;
        if (maxLen !== null && st.v.length > maxLen) st.v.splice(0, st.v.length - maxLen);
        touch(c.db, k0);
        return B(idStr(id));
      }
      case 'XRANGE': case 'XREVRANGE': {
        const s = typed(c, a[0], 'stream', false); if (isReply(s)) return s;
        if (!s) return A([]);
        return xrange(s, a[1], a[2], a.slice(3), cmd === 'XREVRANGE');
      }
      case 'XLEN': { const s = typed(c, a[0], 'stream', false); if (isReply(s)) return s; return I(s ? s.v.length : 0); }
      case 'XDEL': {
        const s = typed(c, a[0], 'stream', false); if (isReply(s)) return s;
        if (!s) return I(0);
        let n = 0;
        for (const raw of a.slice(1)) {
          const p = parseRangeId(raw.toString(), true);
          if (!p) return E('ERR Invalid stream ID specified as stream command argument');
          const at = s.v.findIndex((e) => idCmp(e.id, p.id) === 0);
          if (at >= 0) { s.v.splice(at, 1); n++; }
        }
        touch(c.db, k0);
        return I(n);
      }
      case 'XTRIM': {
        const s = typed(c, a[0], 'stream', false); if (isReply(s)) return s;
        const strat = up(a[1]);
        let i = 2;
        if (up(a[i]) === '~' || up(a[i]) === '=') i++;
        if (!s) return I(0);
        const before = s.v.length;
        if (strat === 'MAXLEN') { const n = num(a[i]); if (n === null) return SYNTAX; if (s.v.length > n) s.v.splice(0, s.v.length - n); }
        else if (strat === 'MINID') { const p = parseRangeId(a[i]?.toString() ?? '', true); if (!p) return SYNTAX; s.v = s.v.filter((e) => idCmp(e.id, p.id) >= 0); }
        else return SYNTAX;
        touch(c.db, k0);
        return I(before - s.v.length);
      }
      case 'PUBLISH': return a.length === 2 ? I(publish(a[0], a[1])) : E('ERR wrong number of arguments for \'publish\' command');
      case 'SUBSCRIBE': case 'PSUBSCRIBE': {
        const set = cmd === 'SUBSCRIBE' ? c.subs : c.psubs;
        for (const ch of a) { set.add(keyOf(ch)); send(c, { k: 'push', v: [B(cmd.toLowerCase()), B(ch), I(subscribed(c))] }); }
        return { k: 'none' };
      }
      case 'UNSUBSCRIBE': case 'PUNSUBSCRIBE': {
        const set = cmd === 'UNSUBSCRIBE' ? c.subs : c.psubs;
        const list = a.length ? a.map(keyOf) : [...set];
        if (!list.length) { send(c, { k: 'push', v: [B(cmd.toLowerCase()), B(null), I(subscribed(c))] }); return { k: 'none' }; }
        for (const ch of list) { set.delete(ch); send(c, { k: 'push', v: [B(cmd.toLowerCase()), B(bufOf(ch)), I(subscribed(c))] }); }
        return { k: 'none' };
      }
      case 'MULTI': if (c.multi) return E('ERR MULTI calls can not be nested'); c.multi = []; return OK;
      case 'DISCARD': if (!c.multi) return E('ERR DISCARD without MULTI'); c.multi = null; c.watched = null; return OK;
      case 'WATCH': if (c.multi) return E('ERR WATCH inside MULTI is not allowed'); c.watched ??= new Map(); for (const k of a) c.watched.set(keyOf(k), version(c.db, keyOf(k))); return OK;
      case 'UNWATCH': c.watched = null; return OK;
      case 'EXEC': {
        if (!c.multi) return E('ERR EXEC without MULTI');
        const queued = c.multi;
        c.multi = null;
        const watched = c.watched;
        c.watched = null;
        if (watched && [...watched].some(([k, v]) => version(c.db, k) !== v)) return A(null);
        const out: Reply[] = [];
        for (const q of queued) out.push(await run(c, q));
        return A(out);
      }
      case 'SWAPDB': return OK;
      case 'REPLCONF': return OK;
      case 'XREAD': {
        const at = a.findIndex((x) => up(x) === 'STREAMS');
        if (at < 0) return SYNTAX;
        const rest = a.slice(at + 1);
        const half = rest.length / 2;
        const out: Reply[] = [];
        for (let i = 0; i < half; i++) {
          const s = typed(c, rest[i], 'stream', false); if (isReply(s)) return s;
          const p = parseRangeId(rest[half + i].toString(), true);
          if (!s || !p) continue;
          const list = s.v.filter((e) => idCmp(e.id, p.id) > 0);
          if (list.length) out.push(A([B(rest[i]), A(list.map((e) => A([B(idStr(e.id)), A(e.fields.map((f) => B(f)))])))]));
        }
        return out.length ? A(out) : A(null);
      }
      default: return E(`ERR unknown command '${argv[0]?.toString() ?? ''}', with args beginning with: ${a.slice(0, 3).map((x) => `'${x.toString()}' `).join('')}`);
    }
  }

  // ── wire ────────────────────────────────────────────────────────────────

  function parse(buf: Buffer): { argv: Buffer[]; used: number } | null {
    if (!buf.length) return null;
    if (buf[0] !== 0x2a) {
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return null;
      return { argv: buf.subarray(0, nl).toString().split(' ').filter(Boolean).map((s) => Buffer.from(s)), used: nl + 2 };
    }
    let p = buf.indexOf('\r\n');
    if (p < 0) return null;
    const n = Number(buf.subarray(1, p).toString());
    let at = p + 2;
    const argv: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      p = buf.indexOf('\r\n', at);
      if (p < 0 || buf[at] !== 0x24) return null;
      const len = Number(buf.subarray(at + 1, p).toString());
      const start = p + 2;
      if (buf.length < start + len + 2) return null;
      argv.push(Buffer.from(buf.subarray(start, start + len)));
      at = start + len + 2;
    }
    return { argv, used: at };
  }

  const handler = (sock: Socket) => {
    const c: Conn = {
      id: nextConn++, sock, db: 0, proto: 2, authed: opts.password === undefined, user: 'default', name: '', subs: new Set(), psubs: new Set(),
      multi: null, multiError: false, watched: null, queue: Promise.resolve(), created: Date.now(), lastCmd: 'NULL',
    };
    conns.add(c);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // A TLS ClientHello on the plain port: a protocol error and the connection closes (like Redis).
      if (!opts.tls && buf[0] === 0x16) { sock.end('-ERR Protocol error: invalid multibulk length\r\n'); buf = Buffer.alloc(0); return; }
      for (;;) {
        const r = parse(buf);
        if (!r) break;
        buf = buf.subarray(r.used);
        if (!r.argv.length) continue;
        const argv = r.argv;
        log.push({ conn: c.id, db: c.db, argv: argv.map((x) => x.toString('utf8')) });
        c.lastCmd = argv[0].toString().toLowerCase();
        c.queue = c.queue.then(async () => {
          let reply: Reply;
          const delays = server.commandDelays;
          const wait = delays[`${up(argv[0])} ${up(argv[1])}`] ?? delays[up(argv[0])];
          if (wait) await new Promise((res) => setTimeout(res, wait));
          try { reply = await run(c, argv); } catch (error) { reply = E(`ERR ${(error as Error).message}`); }
          if (server.delayMs) await new Promise((res) => setTimeout(res, server.delayMs));
          send(c, reply);
        });
      }
    });
    sock.on('error', () => undefined);
    sock.on('close', () => conns.delete(c));
  };

  const listener: Server = opts.tls ? createTlsServer({ key: opts.tls.key, cert: opts.tls.cert }, handler) : createNetServer(handler);
  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', () => { listener.off('error', reject); resolve((listener.address() as { port: number }).port); });
  });
  const port = await listen(opts.port ?? 0);

  const server: RespServer = {
    port, log, slowlog, dbs, options: opts, delayMs: 0, commandDelays: { ...(opts.commandDelays ?? {}) },
    connections: () => conns.size,
    dropClients: () => { for (const c of conns) c.sock.destroy(); },
    dropSubscribers: () => { for (const c of conns) if (subscribed(c)) c.sock.destroy(); },
    stopListening: () => new Promise((resolve) => { listener.close(() => resolve()); for (const c of conns) c.sock.destroy(); }),
    resume: async () => { await listen(port); },
    setString: (key, value, db = 0) => setEntry(db, keyOf(Buffer.from(key as never)), { type: 'string', v: Buffer.from(value as never) }),
    close: async () => {
      for (const c of conns) c.sock.destroy();
      await new Promise<void>((resolve) => { if (!listener.listening) resolve(); else listener.close(() => resolve()); });
    },
  };
  void slowId;
  return server;
}

/** A slowlog entry as a test or the script adds it. */
export function addSlowlog(server: RespServer, args: string[], durationUs = 12_000): void {
  const id = server.slowlog.length ? server.slowlog[server.slowlog.length - 1].id + 1 : 0;
  server.slowlog.push({ id, time: Math.floor(Date.now() / 1000), durationUs, args, client: '127.0.0.1:50000', name: '' });
}
