// The Redis contract of the database viewer (1.0.0): binary-safe values, key browsing, value pages, writes, the console (a
// typed line parsed with redis-cli's quoting rules, dangerous and blocking commands), Pub/Sub messages and the server views.
// Shared by main, the DB Host and the renderer: no Node or DOM imports (TextEncoder/TextDecoder, atob/btoa are global in both).
import type { DbResult } from './db';

// ── limits ──────────────────────────────────────────────────────────────────

export const REDIS_LIMITS = {
  /** One SCAN page: at most this many keys come back (the host calls SCAN until it has them or the cursor ends). */
  scanKeys: 2000, scanCountMax: 10_000, scanCountDefault: 200,
  /** One SCAN page stops after this long even with fewer keys (a MATCH that hits rarely); the cursor goes on. */
  scanBudgetMs: 1500,
  /** keyInfo for at most this many keys per call. */
  infoKeys: 1000,
  /** A list, hash, set, zset or stream page holds at most this many items. */
  pageItems: 5000,
  /** A value inside a page (hash value, list element, stream field value) is cut at this many bytes (readItem reads it whole). */
  itemBytes: 64 * 1024,
  /** A string value arrives up to this many bytes by default; one read may ask for up to stringBytesMax (offset paging). */
  stringBytes: 1024 * 1024, stringBytesMax: 16 * 1024 * 1024,
  /** Keys, fields, members and channel names (they identify things, so they are never cut). */
  nameBytes: 1024 * 1024,
  /** Values written in one call. */
  writeBytes: 64 * 1024 * 1024, writeItems: 10_000,
  /** Console: argv size, the reply's nodes and the bytes of one bulk string, and the time one command may take. */
  argv: 10_000, replyNodes: 10_000, replyBulkBytes: 1024 * 1024,
  consoleTimeoutMs: 30_000, consoleTimeoutMaxMs: 5 * 60_000,
  /**
   * Pattern deletes: keys counted at most (more: complete false), UNLINK batch size, how long a count's token is valid, and
   * the slack over the confirmed count a delete may reach (max(deleteSlackMin, count * deleteSlack)) before it stops with more.
   */
  countKeys: 1_000_000, deleteBatch: 500, tokenTtlMs: 5 * 60_000, deleteSlackMin: 100, deleteSlack: 0.05,
  /** Value pages are read in sub-batches of this many items and stop at this many bytes (the page comes back shorter). */
  pageBatch: 200, pageBytes: 8 * 1024 * 1024,
  /** Console reads above these sizes (items of a collection, bytes of a value) need `confirmed`. */
  consoleItemsConfirm: 100_000, consoleBytesConfirm: 64 * 1024 * 1024,
  /** One browsing operation on the server at most (then the connection is dropped and reconnected, reported). */
  opTimeoutMs: 60_000,
  /** Pub/Sub: messages waiting for the renderer at most (more are dropped and counted), bytes of one payload shown. */
  pubsubBuffer: 5000, pubsubBufferBytes: 8 * 1024 * 1024, pubsubPayloadBytes: 64 * 1024, pubsubBatch: 500, pubsubFlushMs: 50,
  pubsubChannels: 1000,
  slowlogMax: 1000,
  /** Reconnect attempts after a dropped connection before the session ends (each one is reported). */
  reconnectAttempts: 3,
} as const;

// ── binary-safe data ────────────────────────────────────────────────────────

/** Bytes as the API carries them: a string is the UTF-8 text of valid UTF-8 bytes; anything else is base64 (binary). */
export type RedisData = string | { b64: string };
/** A value that may be cut: its first bytes, its full length in bytes, and whether more bytes exist. */
export interface RedisBlob { data: RedisData; bytes: number; truncated?: true }

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export const isBinaryData = (d: RedisData): d is { b64: string } => typeof d !== 'string';

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** UTF-8 text when the bytes are valid UTF-8, else base64. */
export function redisDataFromBytes(bytes: Uint8Array): RedisData {
  try { return strictUtf8.decode(bytes); } catch { return { b64: bytesToBase64(bytes) }; }
}

export function redisDataBytes(d: RedisData): Uint8Array {
  return typeof d === 'string' ? utf8.encode(d) : base64ToBytes(d.b64);
}

export const redisDataLength = (d: RedisData): number => redisDataBytes(d).length;

/** "68 65 6c" style hex of the bytes (the binary view). */
export function redisDataHex(d: RedisData, sep = ' '): string {
  return Array.from(redisDataBytes(d), (b) => b.toString(16).padStart(2, '0')).join(sep);
}

/** Hex typed by the user (spaces allowed) as data; null when it is not hex. */
export function redisDataFromHex(hex: string): RedisData | null {
  const h = hex.replace(/\s+/g, '');
  if (h.length % 2 || !/^[0-9a-f]*$/i.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return redisDataFromBytes(out);
}

/** The text shown for data: the UTF-8 text, or a redis-cli style escaped form of binary ("\x00\xff"). */
export function redisDataDisplay(d: RedisData): string {
  if (typeof d === 'string') return d;
  let s = '';
  for (const b of base64ToBytes(d.b64)) {
    if (b === 0x5c) s += '\\\\';
    else if (b === 0x22) s += '\\"';
    else if (b === 0x0a) s += '\\n';
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x09) s += '\\t';
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return s;
}

/** A stable string for maps and React keys ("t:<text>" or "b:<base64>"). */
export const redisDataKey = (d: RedisData): string => (typeof d === 'string' ? `t:${d}` : `b:${d.b64}`);
export const redisDataEquals = (a: RedisData, b: RedisData): boolean => redisDataKey(a) === redisDataKey(b);

// ── console line parsing ────────────────────────────────────────────────────

export type RedisLineResult = { ok: true; argv: RedisData[] } | { ok: false; error: 'unbalancedQuotes' | 'empty' };

const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-f]$/i.test(c);

/**
 * A typed command line split like redis-cli (sdssplitargs): words separated by spaces; "double quotes" know \n \r \t \b \a
 * \\ \" and \xHH; 'single quotes' know only \'; a closing quote must be followed by a space or the end of the line.
 */
export function parseRedisCommandLine(line: string): RedisLineResult {
  const argv: RedisData[] = [];
  let i = 0;
  const n = line.length;
  const ws = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\v' || c === '\f';
  for (;;) {
    while (i < n && ws(line[i])) i++;
    if (i >= n) break;
    const bytes: number[] = [];
    const pushText = (t: string) => { for (const b of utf8.encode(t)) bytes.push(b); };
    let inDq = false, inSq = false, done = false;
    while (!done) {
      const c = line[i];
      if (inDq) {
        if (c === undefined) return { ok: false, error: 'unbalancedQuotes' };
        if (c === '\\' && line[i + 1] === 'x' && isHex(line[i + 2]) && isHex(line[i + 3])) {
          bytes.push(parseInt(line.slice(i + 2, i + 4), 16));
          i += 3;
        } else if (c === '\\' && i + 1 < n) {
          i++;
          const e = line[i];
          pushText(e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'b' ? '\b' : e === 'a' ? '\x07' : e);
        } else if (c === '"') {
          if (i + 1 < n && !ws(line[i + 1])) return { ok: false, error: 'unbalancedQuotes' };
          done = true;
        } else {
          const cp = line.codePointAt(i)!;
          pushText(String.fromCodePoint(cp));
          if (cp > 0xffff) i++;
        }
      } else if (inSq) {
        if (c === undefined) return { ok: false, error: 'unbalancedQuotes' };
        if (c === '\\' && line[i + 1] === "'") { i++; bytes.push(0x27); }
        else if (c === "'") {
          if (i + 1 < n && !ws(line[i + 1])) return { ok: false, error: 'unbalancedQuotes' };
          done = true;
        } else {
          const cp = line.codePointAt(i)!;
          pushText(String.fromCodePoint(cp));
          if (cp > 0xffff) i++;
        }
      } else if (c === undefined || ws(c)) {
        done = true;
      } else if (c === '"') inDq = true;
      else if (c === "'") inSq = true;
      else {
        const cp = line.codePointAt(i)!;
        pushText(String.fromCodePoint(cp));
        if (cp > 0xffff) i++;
      }
      if (i < n) i++;
    }
    argv.push(redisDataFromBytes(Uint8Array.from(bytes)));
  }
  return argv.length ? { ok: true, argv } : { ok: false, error: 'empty' };
}

/** One argument written back for the console history: bare when safe, else double-quoted with escapes. */
export function quoteRedisArg(d: RedisData): string {
  const shown = redisDataDisplay(d);
  if (typeof d === 'string' && d !== '' && !/[\s"'\\]/.test(d) && !/[\u0000-\u001f\u007f]/.test(d)) return d;
  if (typeof d !== 'string') return `"${shown}"`;
  let s = '';
  for (const ch of d) {
    if (ch === '\\') s += '\\\\';
    else if (ch === '"') s += '\\"';
    else if (ch === '\n') s += '\\n';
    else if (ch === '\r') s += '\\r';
    else if (ch === '\t') s += '\\t';
    else if (/[\u0000-\u001f\u007f]/.test(ch)) s += `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
    else s += ch;
  }
  return `"${s}"`;
}

// ── command classes ─────────────────────────────────────────────────────────

/** Commands whose second word is a subcommand (their names read "CONFIG SET", "CLIENT KILL" ...). */
export const REDIS_CONTAINER_COMMANDS: ReadonlySet<string> = new Set([
  'ACL', 'CLIENT', 'CLUSTER', 'COMMAND', 'CONFIG', 'FUNCTION', 'LATENCY', 'MEMORY', 'MODULE', 'OBJECT', 'PUBSUB', 'SCRIPT', 'SLOWLOG', 'XGROUP', 'XINFO',
]);

/** Asked about before they run (the host refuses them without `confirmed`). */
export const REDIS_DANGEROUS_COMMANDS: ReadonlySet<string> = new Set([
  'FLUSHALL', 'FLUSHDB', 'KEYS', 'CONFIG SET', 'CONFIG REWRITE', 'CONFIG RESETSTAT', 'SHUTDOWN', 'DEBUG', 'SAVE', 'BGSAVE', 'BGREWRITEAOF',
  'REPLICAOF', 'SLAVEOF', 'FAILOVER', 'CLIENT KILL', 'CLIENT PAUSE', 'SCRIPT FLUSH', 'FUNCTION FLUSH', 'MIGRATE', 'SWAPDB', 'ACL SETUSER', 'ACL DELUSER',
  'MODULE LOAD', 'MODULE LOADEX', 'MODULE UNLOAD', 'MODULE LIST', 'MODULE HELP',
]);

/** Blocking the connection: refused in the console. */
const REDIS_BLOCKING = new Set(['BLPOP', 'BRPOP', 'BRPOPLPUSH', 'BLMOVE', 'BLMPOP', 'BZPOPMIN', 'BZPOPMAX', 'BZMPOP', 'WAIT', 'WAITAOF', 'MONITOR', 'SYNC', 'PSYNC']);
const REDIS_SUBSCRIBE = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'UNSUBSCRIBE', 'PUNSUBSCRIBE', 'SUNSUBSCRIBE']);
const REDIS_TRANSACTION = new Set(['MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH']);
/** Would change or break the session's own connection. */
const REDIS_CONNECTION = new Set(['QUIT', 'RESET', 'HELLO', 'AUTH', 'CLIENT REPLY', 'CLIENT NO-EVICT', 'CLIENT NO-TOUCH', 'CLIENT TRACKING', 'CLIENT CACHING', 'READONLY', 'READWRITE', 'ASKING']);

/** On a read-only connection these are refused whatever the server's command table says. */
export const REDIS_READ_ONLY_REFUSED: ReadonlySet<string> = new Set([
  ...REDIS_DANGEROUS_COMMANDS, 'EVAL', 'EVALSHA', 'FCALL', 'SCRIPT LOAD', 'SCRIPT KILL', 'FUNCTION LOAD', 'FUNCTION DELETE', 'FUNCTION RESTORE', 'FUNCTION KILL',
  'PUBLISH', 'SPUBLISH', 'CONFIG SET', 'ACL LOAD', 'ACL SAVE', 'SLOWLOG RESET', 'LATENCY RESET', 'MEMORY PURGE', 'CLIENT SETNAME', 'CLIENT SETINFO', 'CLIENT UNPAUSE',
  'CLUSTER', 'OBJECT FREQ',
]);

/** Commands known to only read: used on a read-only connection when the server's command table cannot be read (ACL). */
export const REDIS_READ_COMMANDS: ReadonlySet<string> = new Set([
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'SUBSTR', 'LCS', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'EXPIRETIME', 'PEXPIRETIME', 'DUMP', 'TOUCH',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HSTRLEN', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS', 'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SSCAN', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF', 'SINTERCARD',
  'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGEBYLEX', 'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT',
  'ZRANK', 'ZREVRANK', 'ZSCAN', 'ZRANDMEMBER', 'ZINTER', 'ZUNION', 'ZDIFF', 'ZINTERCARD',
  'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO STREAM', 'XINFO GROUPS', 'XINFO CONSUMERS', 'XPENDING', 'XREAD',
  'BITCOUNT', 'BITPOS', 'GETBIT', 'BITFIELD_RO', 'GEOPOS', 'GEODIST', 'GEOHASH', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER_RO', 'GEOSEARCH',
  'SORT_RO', 'EVAL_RO', 'EVALSHA_RO', 'FCALL_RO', 'SCAN', 'DBSIZE', 'RANDOMKEY', 'INFO', 'PING', 'ECHO', 'TIME', 'LASTSAVE', 'ROLE', 'LOLWUT',
  'MEMORY USAGE', 'MEMORY STATS', 'MEMORY DOCTOR', 'OBJECT ENCODING', 'OBJECT IDLETIME', 'OBJECT REFCOUNT', 'SLOWLOG GET', 'SLOWLOG LEN',
  'CLIENT LIST', 'CLIENT INFO', 'CLIENT GETNAME', 'CLIENT ID', 'COMMAND', 'COMMAND INFO', 'COMMAND COUNT', 'COMMAND DOCS', 'COMMAND LIST',
  'COMMAND GETKEYS', 'CONFIG GET', 'PUBSUB CHANNELS', 'PUBSUB NUMSUB', 'PUBSUB NUMPAT', 'LATENCY LATEST', 'LATENCY HISTORY', 'SELECT',
]);

/** Status replies of these commands are shown as simple strings (the client cannot tell them from bulk strings itself). */
const REDIS_STATUS_REPLIES = new Set([
  'SET', 'SELECT', 'PING', 'FLUSHDB', 'FLUSHALL', 'RENAME', 'LSET', 'LTRIM', 'MSET', 'HMSET', 'TYPE', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'SETEX', 'PSETEX',
  'SWAPDB', 'RESTORE', 'CONFIG SET', 'CONFIG REWRITE', 'CONFIG RESETSTAT', 'CLIENT SETNAME', 'CLIENT KILL', 'CLIENT PAUSE', 'CLIENT UNPAUSE', 'SCRIPT FLUSH',
  'SCRIPT KILL', 'FUNCTION FLUSH', 'FUNCTION DELETE', 'FUNCTION RESTORE', 'XGROUP CREATE', 'XGROUP SETID', 'XSETID', 'ACL SETUSER', 'ACL LOAD', 'ACL SAVE',
  'MIGRATE', 'REPLICAOF', 'SLAVEOF', 'DEBUG', 'SLOWLOG RESET', 'LATENCY RESET', 'MEMORY PURGE', 'SHUTDOWN', 'FAILOVER', 'MODULE LOAD', 'MODULE UNLOAD',
  'PFMERGE', 'QUIT', 'RESET',
]);

export type RedisConsoleRefusal = 'blocking' | 'subscribe' | 'transaction' | 'connection';

export interface RedisCommandClass {
  /** Upper case, with the subcommand of a container command ("CONFIG SET"). */
  name: string;
  /** Asks first (FLUSHALL, KEYS, CONFIG SET ...). */
  dangerous: boolean;
  /** Not run in the console: blocking (BLPOP, MONITOR, XREAD BLOCK), subscribe (use Pub/Sub), transaction, connection. */
  refused?: RedisConsoleRefusal;
  /** The reply of a status command (shown as a simple string). */
  status: boolean;
}

const word = (d: RedisData | undefined): string => (d === undefined ? '' : typeof d === 'string' ? d.toUpperCase() : '');

export function redisCommandName(argv: readonly RedisData[]): string {
  const first = word(argv[0]);
  return REDIS_CONTAINER_COMMANDS.has(first) && argv.length > 1 ? `${first} ${word(argv[1])}` : first;
}

export function classifyRedisCommand(argv: readonly RedisData[]): RedisCommandClass {
  const first = word(argv[0]);
  const name = redisCommandName(argv);
  const dangerous = REDIS_DANGEROUS_COMMANDS.has(name) || REDIS_DANGEROUS_COMMANDS.has(first) || (first === 'MODULE');
  let refused: RedisConsoleRefusal | undefined;
  if (REDIS_BLOCKING.has(first)) refused = 'blocking';
  else if ((first === 'XREAD' || first === 'XREADGROUP') && argv.some((a) => word(a) === 'BLOCK')) refused = 'blocking';
  if (REDIS_SUBSCRIBE.has(first)) refused = 'subscribe';
  else if (REDIS_TRANSACTION.has(first)) refused = 'transaction';
  else if (REDIS_CONNECTION.has(name) || REDIS_CONNECTION.has(first)) refused = 'connection';
  const status = REDIS_STATUS_REPLIES.has(name) || REDIS_STATUS_REPLIES.has(first);
  return { name, dangerous, ...(refused ? { refused } : {}), status: status && !(first === 'SET' && argv.some((a, i) => i > 2 && word(a) === 'GET')) };
}

// ── key browsing ────────────────────────────────────────────────────────────

/** TYPE's answer; modules report their own names (e.g. "ReJSON-RL"). */
export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | (string & {});
export const REDIS_EDITABLE_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const;
export type RedisEditableType = (typeof REDIS_EDITABLE_TYPES)[number];

export interface RedisDbInfo { index: number; keys: number; expires: number; avgTtlMs: number }
/** count: CONFIG GET databases (null: not allowed, the UI offers 0-15); dbs: the databases that hold keys (INFO keyspace). */
export interface RedisDbList { count: number | null; current: number; dbs: RedisDbInfo[] }

export interface RedisScanRequest {
  /** "0" starts; the previous page's cursor goes on. */
  cursor: string;
  /** A glob pattern (MATCH); absent: every key. */
  match?: string;
  /** COUNT hint per SCAN call (default REDIS_LIMITS.scanCountDefault). */
  count?: number;
  /** Only keys of this type (SCAN TYPE, or checked one by one on servers without it). */
  type?: string;
  /** Keys wanted for this page (default 500, at most REDIS_LIMITS.scanKeys). */
  limit?: number;
  /** Also each key's type, TTL, length and memory (keyInfo). */
  details?: boolean;
}

export interface RedisKeyInfo {
  key: RedisData;
  /** Absent: the key vanished meanwhile. */
  type?: RedisKeyType;
  /** Milliseconds left; null: no expiry. */
  ttlMs?: number | null;
  /** STRLEN, HLEN, LLEN, SCARD, ZCARD or XLEN. */
  length?: number;
  /** MEMORY USAGE in bytes (absent: not allowed or not supported). */
  memory?: number;
}

/** cursor "0": the scan is complete. */
export interface RedisScanPage { cursor: string; keys: RedisKeyInfo[] }

// ── values ──────────────────────────────────────────────────────────────────

export type RedisReadRequest =
  /** offset/maxBytes page through a big string (default 0 and REDIS_LIMITS.stringBytes). */
  | { type: 'string'; key: RedisData; offset?: number; maxBytes?: number }
  | { type: 'hash'; key: RedisData; cursor: string; count: number; match?: string }
  | { type: 'list'; key: RedisData; start: number; count: number }
  | { type: 'set'; key: RedisData; cursor: string; count: number; match?: string }
  /** By rank (start, count, rev) or, with `cursor`, ZSCAN (match). */
  | { type: 'zset'; key: RedisData; start: number; count: number; rev?: boolean }
  | { type: 'zset'; key: RedisData; cursor: string; count: number; match?: string }
  /** start/end: stream ids or "-" / "+"; rev: newest first (XREVRANGE, start is then the upper end). */
  | { type: 'stream'; key: RedisData; start: string; end: string; count: number; rev?: boolean };

export interface RedisHashEntry { field: RedisData; value: RedisBlob }
export interface RedisZsetEntry { member: RedisData; score: string }
export interface RedisStreamEntry { id: string; fields: Array<{ field: RedisData; value: RedisBlob }> }

/** ttlMs: null when the key has no expiry; length: the whole value's size (bytes of a string, items otherwise). */
export type RedisReadResult =
  /** pageBytes: bytes of this page (the next page starts at offset + pageBytes; a page never ends inside a UTF-8 character). */
  | { type: 'string'; ttlMs: number | null; length: number; offset: number; pageBytes: number; value: RedisBlob }
  | { type: 'hash'; ttlMs: number | null; length: number; cursor: string; entries: RedisHashEntry[] }
  | { type: 'list'; ttlMs: number | null; length: number; start: number; items: RedisBlob[] }
  | { type: 'set'; ttlMs: number | null; length: number; cursor: string; members: RedisData[] }
  | { type: 'zset'; ttlMs: number | null; length: number; start?: number; cursor?: string; entries: RedisZsetEntry[] }
  /** next: the id to start the next page from (null: no more entries in that direction). */
  | { type: 'stream'; ttlMs: number | null; length: number; entries: RedisStreamEntry[]; next: string | null };

/** One whole value of a page that arrived cut (up to REDIS_LIMITS.stringBytesMax). */
export type RedisItemRequest =
  | { type: 'hash'; key: RedisData; field: RedisData }
  | { type: 'list'; key: RedisData; index: number }
  | { type: 'stream'; key: RedisData; id: string; field: RedisData };

// ── writes ──────────────────────────────────────────────────────────────────

/** The first value of a new key (created only when the key does not exist: else 'keyExists'). */
export type RedisNewValue =
  | { type: 'string'; value: RedisData }
  | { type: 'hash'; entries: Array<[RedisData, RedisData]> }
  | { type: 'list'; items: RedisData[] }
  | { type: 'set'; members: RedisData[] }
  | { type: 'zset'; entries: Array<[RedisData, string]> }
  | { type: 'stream'; id?: string; fields: Array<[RedisData, RedisData]> };

/**
 * Writes. `existing: true` (hset, lpush, rpush, sadd, zadd, zincrby, xadd): the edit comes from an open value view, so a key
 * that expired or was deleted meanwhile answers 'notFound' (and another type 'wrongType') instead of creating a new key.
 */
export type RedisWrite =
  /**
   * keepTtl: SET ... KEEPTTL (the default keeps the TTL; false clears it); ttlMs: a new expiry. Only replaces a string (or
   * creates the key): a key that holds another type answers 'wrongType' and stays untouched.
   */
  | { op: 'set'; key: RedisData; value: RedisData; keepTtl?: boolean; ttlMs?: number }
  | { op: 'hset'; key: RedisData; field: RedisData; value: RedisData; onlyNew?: boolean; existing?: boolean }
  | { op: 'hdel'; key: RedisData; fields: RedisData[] }
  | { op: 'lpush' | 'rpush'; key: RedisData; items: RedisData[]; existing?: boolean }
  /** expected: the element's current value; a different value is a conflict (nothing is written). */
  | { op: 'lset'; key: RedisData; index: number; value: RedisData; expected?: RedisData }
  /** LREM count value: count > 0 from the head, < 0 from the tail, 0 all. */
  | { op: 'lrem'; key: RedisData; count: number; value: RedisData }
  /** Removes the element at index when it still has the expected value (WATCH + LSET to a marker + LREM). */
  | { op: 'ldel'; key: RedisData; index: number; expected: RedisData }
  | { op: 'sadd'; key: RedisData; members: RedisData[]; existing?: boolean }
  | { op: 'srem'; key: RedisData; members: RedisData[] }
  /** mode: nx only new members, xx only existing (score edits). Scores as text ("1.5", "-inf"). */
  | { op: 'zadd'; key: RedisData; entries: Array<[RedisData, string]>; mode?: 'nx' | 'xx'; existing?: boolean }
  | { op: 'zrem'; key: RedisData; members: RedisData[] }
  | { op: 'zincrby'; key: RedisData; member: RedisData; by: string; existing?: boolean }
  /** id default "*"; maxLen trims with "~" when approx. */
  | { op: 'xadd'; key: RedisData; id?: string; fields: Array<[RedisData, RedisData]>; maxLen?: number; approx?: boolean; existing?: boolean }
  | { op: 'xdel'; key: RedisData; ids: string[] }
  | { op: 'xtrim'; key: RedisData; strategy: 'maxlen' | 'minid'; threshold: string; approx?: boolean }
  /** RENAMENX unless overwrite (then RENAME): an existing new name answers 'keyExists'. */
  | { op: 'rename'; key: RedisData; newKey: RedisData; overwrite?: boolean }
  | { op: 'expire'; key: RedisData; ttlMs: number }
  | { op: 'persist'; key: RedisData }
  /** UNLINK (DEL on servers without it). */
  | { op: 'delete'; keys: RedisData[] }
  | { op: 'create'; key: RedisData; value: RedisNewValue; ttlMs?: number };

/** changed: the server's count (fields added, members removed, keys deleted ...); id: the new stream entry's id. */
export interface RedisWriteResult { changed: number; id?: string }

/** A pattern delete: the count first (token), then the delete with that token. complete false: the count stopped at the cap. */
export interface RedisPatternCount { token: string; count: number; complete: boolean }
/**
 * The pattern delete's answer. It stops near the confirmed count (count + max(100, 5 %)): `more` means keys still match
 * (new ones appeared meanwhile, or the count was incomplete) and the user should count and confirm again.
 */
export interface RedisPatternDelete { deleted: number; cancelled: boolean; more: boolean }

// ── console ─────────────────────────────────────────────────────────────────

export interface RedisCommandRequest {
  argv: RedisData[];
  /** A read-only connection runs this one command with writes allowed (the explicit override). */
  readWrite?: boolean;
  /** The user confirmed a dangerous command (else 'needsConfirm'). */
  confirmed?: boolean;
  /** Default REDIS_LIMITS.consoleTimeoutMs. */
  timeoutMs?: number;
}

/** A reply by RESP type. Integers stay text (no precision loss). Arrays may be cut: `length` is the real item count. */
export type RedisReply =
  | { t: 'simple'; v: string }
  | { t: 'error'; v: string }
  | { t: 'integer'; v: string }
  | { t: 'bulk'; v: RedisData; bytes: number; truncated?: true }
  | { t: 'null' }
  | { t: 'array'; items: RedisReply[]; length: number };

/** db: the session's DB index after the command (SELECT changes it). */
export interface RedisCommandResult { reply: RedisReply; timeMs: number; db: number }

// ── server views ────────────────────────────────────────────────────────────

export interface RedisInfoSection { name: string; entries: Array<[string, string]> }
export interface RedisSlowlogEntry { id: number; time: number; durationUs: number; args: RedisData[]; client?: string; clientName?: string }
/** One CLIENT LIST line as its key=value fields (id, addr, name, db, cmd, age, idle ...). */
export type RedisClientInfo = Record<string, string>;

/** INFO's text as sections ("# Server" headers, "key:value" lines). */
export function parseRedisInfo(text: string): RedisInfoSection[] {
  const sections: RedisInfoSection[] = [];
  let current: RedisInfoSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { current = { name: line.slice(1).trim(), entries: [] }; sections.push(current); continue; }
    const at = line.indexOf(':');
    if (at <= 0) continue;
    if (!current) { current = { name: '', entries: [] }; sections.push(current); }
    current.entries.push([line.slice(0, at), line.slice(at + 1)]);
  }
  return sections;
}

/** "db0:keys=1,expires=0,avg_ttl=0" lines of INFO keyspace. */
export function parseRedisKeyspace(sections: RedisInfoSection[]): RedisDbInfo[] {
  const out: RedisDbInfo[] = [];
  for (const s of sections) {
    for (const [k, v] of s.entries) {
      const m = /^db(\d+)$/.exec(k);
      if (!m) continue;
      const f = Object.fromEntries(v.split(',').map((p) => p.split('=') as [string, string]));
      out.push({ index: Number(m[1]), keys: Number(f.keys) || 0, expires: Number(f.expires) || 0, avgTtlMs: Number(f.avg_ttl) || 0 });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export function parseRedisClientList(text: string): RedisClientInfo[] {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const rec: RedisClientInfo = {};
    for (const part of line.trim().split(' ')) {
      const at = part.indexOf('=');
      if (at > 0) rec[part.slice(0, at)] = part.slice(at + 1);
    }
    return rec;
  });
}

const STREAM_ID = /^(\d+)-(\d+)$/;
const U64_MAX = 18446744073709551615n;
export const isStreamId = (id: string): boolean => STREAM_ID.test(id) && BigInt(id.split('-')[0]) <= U64_MAX && BigInt(id.split('-')[1]) <= U64_MAX;

/** The id right after (or before) a stream id: the next page of XRANGE (XREVRANGE) starts there; null past the ends. */
export function streamIdStep(id: string, dir: 1 | -1): string | null {
  const m = STREAM_ID.exec(id);
  if (!m) return null;
  let ms = BigInt(m[1]), seq = BigInt(m[2]);
  if (dir === 1) {
    if (seq < U64_MAX) seq++;
    else if (ms < U64_MAX) { ms++; seq = 0n; } else return null;
  } else if (seq > 0n) seq--;
  else if (ms > 0n) { ms--; seq = U64_MAX; } else return null;
  return `${ms}-${seq}`;
}

// ── Pub/Sub ─────────────────────────────────────────────────────────────────

export interface RedisPubSubMessage {
  channel: RedisData;
  /** The pattern that matched (PSUBSCRIBE). */
  pattern?: RedisData;
  /** When the DB Host received it (ms since epoch). */
  time: number;
  payload: RedisBlob;
}

/** connecting: the subscriber connection is opening (or reconnecting: `reconnect` is the attempt); closed: it ended (error says why). */
export interface RedisPubSubState {
  state: 'idle' | 'connecting' | 'ready' | 'closed';
  channels: RedisData[];
  patterns: RedisData[];
  /** Messages dropped so far because the renderer could not keep up (the buffer cap). */
  dropped: number;
  reconnect?: number;
  error?: string;
}

/** DB port messages of Redis sessions (next to the Postgres ones, keyed by the session id). */
export type RedisPortMessage =
  /** dropped: messages lost since the previous batch (the buffer was full). */
  | { t: 'redisPubSub'; sessionId: string; messages: RedisPubSubMessage[]; dropped: number }
  | { t: 'redisPubSubState'; sessionId: string; state: RedisPubSubState };

// ── host operations and the API ─────────────────────────────────────────────

/** What the renderer asks the DB Host for (DbHostOp { op: 'redis', req }). */
export type RedisOp =
  | { kind: 'databases' }
  | { kind: 'select'; index: number }
  | { kind: 'scan'; req: RedisScanRequest }
  | { kind: 'keyInfo'; keys: RedisData[] }
  | { kind: 'read'; req: RedisReadRequest }
  | { kind: 'readItem'; req: RedisItemRequest }
  | { kind: 'write'; write: RedisWrite }
  | { kind: 'countPattern'; match: string; type?: string }
  | { kind: 'deletePattern'; token: string }
  /**
   * Stops every console command, count and pattern delete enqueued before it (between batches; queued ones never start).
   * Those three run on the session's own console connection, so browsing never waits for them.
   */
  | { kind: 'cancel' }
  | { kind: 'command'; req: RedisCommandRequest }
  | { kind: 'info'; section?: string }
  | { kind: 'slowlog'; count?: number }
  | { kind: 'clients' }
  | { kind: 'subscribe'; channels?: RedisData[]; patterns?: RedisData[] }
  | { kind: 'unsubscribe'; channels?: RedisData[]; patterns?: RedisData[]; all?: boolean }
  | { kind: 'pubsubState' }
  | { kind: 'publish'; channel: RedisData; message: RedisData; readWrite?: boolean };

export interface DbRedisApi {
  databases(sessionId: string): Promise<DbResult<RedisDbList>>;
  /** Switches the session's DB index (the 'db:session' state's database follows). */
  select(sessionId: string, index: number): Promise<DbResult<number>>;
  scan(sessionId: string, req: RedisScanRequest): Promise<DbResult<RedisScanPage>>;
  keyInfo(sessionId: string, keys: RedisData[]): Promise<DbResult<RedisKeyInfo[]>>;
  read(sessionId: string, req: RedisReadRequest): Promise<DbResult<RedisReadResult>>;
  readItem(sessionId: string, req: RedisItemRequest): Promise<DbResult<RedisBlob>>;
  write(sessionId: string, write: RedisWrite): Promise<DbResult<RedisWriteResult>>;
  countPattern(sessionId: string, match: string, type?: string): Promise<DbResult<RedisPatternCount>>;
  deletePattern(sessionId: string, token: string): Promise<DbResult<RedisPatternDelete>>;
  cancel(sessionId: string): Promise<DbResult<boolean>>;
  command(sessionId: string, req: RedisCommandRequest): Promise<DbResult<RedisCommandResult>>;
  info(sessionId: string, section?: string): Promise<DbResult<RedisInfoSection[]>>;
  slowlog(sessionId: string, count?: number): Promise<DbResult<RedisSlowlogEntry[]>>;
  clients(sessionId: string): Promise<DbResult<RedisClientInfo[]>>;
  subscribe(sessionId: string, target: { channels?: RedisData[]; patterns?: RedisData[] }): Promise<DbResult<RedisPubSubState>>;
  unsubscribe(sessionId: string, target: { channels?: RedisData[]; patterns?: RedisData[]; all?: boolean }): Promise<DbResult<RedisPubSubState>>;
  pubsubState(sessionId: string): Promise<DbResult<RedisPubSubState>>;
  /** Answers the number of receivers. Refused on a read-only connection unless readWrite. */
  publish(sessionId: string, channel: RedisData, message: RedisData, readWrite?: boolean): Promise<DbResult<number>>;
}
