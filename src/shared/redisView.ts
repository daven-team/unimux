// The Redis views of the database viewer (1.0.0): tab references, the key tree, value formatting (TTL, sizes, JSON that keeps
// its number literals, hex dumps), console replies as text, command name completion and history, and the Pub/Sub message
// buffer. Pure helpers shared by the renderer and the tests: no Node or DOM imports.
import { isUuid } from './ssh';
import {
  classifyRedisCommand, isBinaryData, isStreamId, quoteRedisArg, REDIS_CONTAINER_COMMANDS, redisCommandName, redisDataBytes, redisDataDisplay, redisDataKey, type RedisData, type RedisInfoSection, type RedisKeyInfo,
  type RedisPubSubMessage, type RedisReply,
} from './dbRedis';

// ── tabs ────────────────────────────────────────────────────────────────────

/** keys: the key browser with the value panel; console; pubsub; info: the server views (INFO, SLOWLOG, CLIENT LIST). */
export type RedisTabView = 'keys' | 'console' | 'pubsub' | 'info';
export const REDIS_TAB_VIEWS: readonly RedisTabView[] = ['keys', 'console', 'pubsub', 'info'];

/** A Redis tab of the top strip: a view of one saved connection, on DB `db`. `uid` tells two tabs of one view apart. */
export interface RedisTabRef { kind: 'redis'; view: RedisTabView; connectionId: string; db: number; uid: string }

export const redisTabId = (ref: Pick<RedisTabRef, 'view' | 'connectionId' | 'uid'>): string => JSON.stringify(['redis', ref.view, ref.connectionId, ref.uid]);

export function validRedisTabRef(value: unknown): value is RedisTabRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'redis' && REDIS_TAB_VIEWS.includes(v.view as RedisTabView) && isUuid(v.connectionId) && isUuid(v.uid)
    && typeof v.db === 'number' && Number.isInteger(v.db) && v.db >= 0 && v.db <= 10_000;
}

// ── key tree ────────────────────────────────────────────────────────────────

export const REDIS_KEY_SEPARATOR = ':';

/** A row of the key list: a folder of the ":"-tree (its path ends with the separator) or a key. */
export type RedisKeyRow =
  | { kind: 'folder'; id: string; name: string; depth: number; count: number; open: boolean }
  | { kind: 'key'; id: string; name: string; depth: number; info: RedisKeyInfo };

interface Folder { name: string; path: string; folders: Map<string, Folder>; keys: Array<{ name: string; info: RedisKeyInfo }>; count: number }

const newFolder = (name: string, path: string): Folder => ({ name, path, folders: new Map(), keys: [], count: 0 });
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The loaded keys as rows: `tree` groups text keys by ":" into folders (open ones show their content), binary keys stay at the
 * top level; a flat list shows every key by its full name. Folders come before keys, both sorted by name.
 */
export function redisKeyRows(keys: readonly RedisKeyInfo[], mode: 'tree' | 'flat', open: ReadonlySet<string>, sep = REDIS_KEY_SEPARATOR): RedisKeyRow[] {
  if (mode === 'flat') {
    return keys.map((info) => ({ kind: 'key' as const, id: redisDataKey(info.key), name: redisDataDisplay(info.key), depth: 0, info }))
      .sort(byName);
  }
  const root = newFolder('', '');
  for (const info of keys) {
    const name = redisDataDisplay(info.key);
    const parts = isBinaryData(info.key) ? [name] : name.split(sep);
    let folder = root;
    folder.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = `${folder.path}${parts[i]}${sep}`;
      let next = folder.folders.get(parts[i]);
      if (!next) { next = newFolder(parts[i], path); folder.folders.set(parts[i], next); }
      next.count++;
      folder = next;
    }
    folder.keys.push({ name: parts[parts.length - 1], info });
  }
  const rows: RedisKeyRow[] = [];
  const walk = (folder: Folder, depth: number) => {
    for (const sub of [...folder.folders.values()].sort(byName)) {
      const isOpen = open.has(sub.path);
      rows.push({ kind: 'folder', id: `f:${sub.path}`, name: sub.name, depth, count: sub.count, open: isOpen });
      if (isOpen) walk(sub, depth + 1);
    }
    for (const k of [...folder.keys].sort(byName)) rows.push({ kind: 'key', id: redisDataKey(k.info.key), name: k.name, depth, info: k.info });
  };
  walk(root, 0);
  return rows;
}

/** Keys of a new SCAN page added to the loaded ones (a key seen twice keeps its newer details), in load order. */
export function mergeKeys(loaded: readonly RedisKeyInfo[], page: readonly RedisKeyInfo[]): RedisKeyInfo[] {
  const at = new Map(loaded.map((k, i) => [redisDataKey(k.key), i]));
  const out = [...loaded];
  for (const k of page) {
    const i = at.get(redisDataKey(k.key));
    if (i === undefined) { at.set(redisDataKey(k.key), out.length); out.push(k); } else out[i] = k;
  }
  return out;
}

/**
 * A glob for every search field (keys, fields, members): plain text matches anywhere ("*text*", glob characters in it escaped);
 * text with a glob character (* ? [) is used as typed. Empty (or "*"): no MATCH.
 */
export function containsPattern(text: string): string | undefined {
  const t = text.trim();
  if (!t || t === '*') return undefined;
  return /[*?[]/.test(t) ? t : `*${globEscape(t)}*`;
}

/** The SCAN MATCH pattern of the key search field (the same rule as the field and member searches). */
export const scanPattern = containsPattern;

/** Text matched literally inside a glob: a backslash before \ * ? [ ] (a folder "a[1]:" must not match "a1:"). */
export const globEscape = (text: string): string => text.replace(/[\\*?[\]]/g, (c) => `\\${c}`);

/** The pattern of everything under a ":"-folder (its path ends with the separator), literal up to the final "*". */
export const folderPattern = (path: string): string => `${globEscape(path)}*`;

// ── numbers, sizes, TTLs ────────────────────────────────────────────────────

/** "512 B", "1.5 KB", "3.2 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

/** A TTL in milliseconds as two units at most: "45s", "12m 5s", "3h 20m", "4d 2h". null: no expiry (the caller shows its text). */
export function formatTtl(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 1) return `${ms}ms`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return sec ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/** A TTL typed by the user: seconds ("90"), or with a unit ("500ms", "30s", "5m", "2h", "1d", combined "1h 30m"). null: invalid. */
export function parseTtlInput(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/,/g, '.');
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) { const ms = Math.round(Number(t) * 1000); return ms > 0 ? ms : null; }
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  let rest = t;
  const part = /^\s*(\d+(?:\.\d+)?)\s*(ms|min|s|m|h|d)/;
  while (rest.trim()) {
    const m = part.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * unit[m[2]];
    rest = rest.slice(m[0].length);
  }
  const ms = Math.round(total);
  return ms > 0 && ms <= 100 * 365 * 86_400_000 ? ms : null;
}

/** A sorted set score as Redis accepts it: a float, "inf", "+inf" or "-inf". */
export const validScore = (text: string): boolean => {
  const t = text.trim().toLowerCase();
  return t === 'inf' || t === '+inf' || t === '-inf' || /^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/.test(t);
};

/** A stream entry id the user may give when adding: "*" (the server picks), "<ms>-<seq>", "<ms>-*" or "<ms>". */
export const validNewStreamId = (text: string): boolean => {
  const t = text.trim();
  return t === '*' || isStreamId(t) || /^\d+-\*$/.test(t) || /^\d+$/.test(t);
};

/** "12:04:05.123" in local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ── JSON and hex ────────────────────────────────────────────────────────────

/** Whether text is one JSON value (objects and arrays only: a bare number or word is not worth a JSON view). */
export function isJsonText(text: string): boolean {
  const t = text.trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

/** The JSON.parse error of a text, or null when it is valid JSON. */
export function jsonError(text: string): string | null {
  try { JSON.parse(text); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/**
 * JSON re-indented (indent > 0) or compacted (0) without parsing values: numbers keep every digit (a big integer must not be
 * rounded by a reformat), strings keep their escapes. Returns null for text that is not valid JSON.
 */
export function formatJson(text: string, indent = 2): string | null {
  if (jsonError(text) !== null) return null;
  let out = '';
  let depth = 0;
  const pad = (n: number) => (indent > 0 ? `\n${' '.repeat(indent * n)}` : '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '{' || c === '[') {
      // An empty object or array stays on one line.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === (c === '{' ? '}' : ']')) { out += c + text[j]; i = j; continue; }
      depth++;
      out += c + pad(depth);
    } else if (c === '}' || c === ']') {
      depth--;
      out += pad(depth) + c;
    } else if (c === ',') out += `,${pad(depth)}`;
    else if (c === ':') out += indent > 0 ? ': ' : ':';
    else if (!/\s/.test(c)) out += c;
  }
  return out;
}

/** A hex dump of bytes: "00000000  68 65 6c 6c 6f ...  |hello|" lines of 16 bytes (at most `maxBytes`). */
export function hexDump(data: RedisData | Uint8Array, maxBytes = 64 * 1024): string[] {
  const bytes = data instanceof Uint8Array ? data : redisDataBytes(data);
  const lines: string[] = [];
  const end = Math.min(bytes.length, maxBytes);
  for (let at = 0; at < end; at += 16) {
    const row = bytes.subarray(at, Math.min(at + 16, end));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0'));
    const left = hex.slice(0, 8).join(' '), right = hex.slice(8).join(' ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${at.toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${ascii}|`);
  }
  return lines;
}

// ── console ─────────────────────────────────────────────────────────────────

/** Commands whose flat array reply is a map (field, value, field, value ...): shown as pairs. */
const MAP_REPLIES = new Set(['HGETALL', 'CONFIG GET', 'XINFO STREAM', 'XINFO GROUPS', 'XINFO CONSUMERS', 'MEMORY STATS', 'PUBSUB NUMSUB', 'HELLO', 'COMMAND DOCS', 'CLIENT TRACKINGINFO', 'ACL GETUSER', 'FUNCTION STATS', 'LATENCY HISTOGRAM']);
export const isMapReply = (command: string, reply: RedisReply): boolean =>
  MAP_REPLIES.has(command) && reply.t === 'array' && reply.items.length % 2 === 0 && reply.items.length === reply.length;

/** A bulk string quoted like redis-cli (binary is already escaped by redisDataDisplay). */
const quoteBulk = (d: RedisData): string =>
  `"${typeof d === 'string' ? d.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') : redisDataDisplay(d)}"`;

/** A reply as redis-cli prints it (copy as text): "OK", "(integer) 5", "\"text\"", "(nil)", numbered nested arrays. */
export function replyText(reply: RedisReply, indent = ''): string {
  switch (reply.t) {
    case 'simple': return reply.v;
    case 'error': return `(error) ${reply.v}`;
    case 'integer': return `(integer) ${reply.v}`;
    case 'null': return '(nil)';
    case 'bulk': return quoteBulk(reply.v) + (reply.truncated ? ` (${reply.bytes} B)` : '');
    case 'array': {
      if (!reply.items.length) return '(empty array)';
      const width = String(reply.length).length;
      const lines = reply.items.map((item, i) => {
        const label = `${String(i + 1).padStart(width)}) `;
        const inner = replyText(item, indent + ' '.repeat(label.length));
        return `${i ? indent : ''}${label}${inner}`;
      });
      if (reply.length > reply.items.length) lines.push(`${indent}... (${reply.length - reply.items.length})`);
      return lines.join('\n');
    }
  }
}

/** Command names offered by the console's completion (upper case; container commands with their subcommand). */
export const REDIS_COMMAND_NAMES: readonly string[] = [
  'APPEND', 'BITCOUNT', 'BITFIELD', 'BITOP', 'BITPOS', 'COPY', 'DBSIZE', 'DECR', 'DECRBY', 'DEL', 'DUMP', 'ECHO', 'EXISTS', 'EXPIRE', 'EXPIREAT',
  'EXPIRETIME', 'FLUSHALL', 'FLUSHDB', 'GEOADD', 'GEODIST', 'GEOHASH', 'GEOPOS', 'GEOSEARCH', 'GET', 'GETBIT', 'GETDEL', 'GETEX', 'GETRANGE', 'GETSET',
  'HDEL', 'HEXISTS', 'HGET', 'HGETALL', 'HINCRBY', 'HINCRBYFLOAT', 'HKEYS', 'HLEN', 'HMGET', 'HMSET', 'HRANDFIELD', 'HSCAN', 'HSET', 'HSETNX', 'HSTRLEN',
  'HVALS', 'INCR', 'INCRBY', 'INCRBYFLOAT', 'INFO', 'KEYS', 'LASTSAVE', 'LCS', 'LINDEX', 'LINSERT', 'LLEN', 'LMOVE', 'LMPOP', 'LPOP', 'LPOS', 'LPUSH',
  'LPUSHX', 'LRANGE', 'LREM', 'LSET', 'LTRIM', 'MGET', 'MOVE', 'MSET', 'MSETNX', 'OBJECT ENCODING', 'OBJECT FREQ', 'OBJECT IDLETIME', 'OBJECT REFCOUNT',
  'PERSIST', 'PEXPIRE', 'PEXPIREAT', 'PEXPIRETIME', 'PFADD', 'PFCOUNT', 'PFMERGE', 'PING', 'PSETEX', 'PTTL', 'PUBLISH', 'PUBSUB CHANNELS', 'PUBSUB NUMPAT',
  'PUBSUB NUMSUB', 'RANDOMKEY', 'RENAME', 'RENAMENX', 'RESTORE', 'ROLE', 'RPOP', 'RPOPLPUSH', 'RPUSH', 'RPUSHX', 'SADD', 'SAVE', 'SCAN', 'SCARD', 'SDIFF',
  'SDIFFSTORE', 'SELECT', 'SET', 'SETBIT', 'SETEX', 'SETNX', 'SETRANGE', 'SINTER', 'SINTERCARD', 'SINTERSTORE', 'SISMEMBER', 'SLOWLOG GET', 'SLOWLOG LEN',
  'SLOWLOG RESET', 'SMEMBERS', 'SMISMEMBER', 'SMOVE', 'SORT', 'SORT_RO', 'SPOP', 'SRANDMEMBER', 'SREM', 'SSCAN', 'STRLEN', 'SUNION', 'SUNIONSTORE', 'SWAPDB',
  'TIME', 'TOUCH', 'TTL', 'TYPE', 'UNLINK', 'XACK', 'XADD', 'XAUTOCLAIM', 'XCLAIM', 'XDEL', 'XGROUP CREATE', 'XGROUP DESTROY', 'XINFO GROUPS',
  'XINFO STREAM', 'XLEN', 'XPENDING', 'XRANGE', 'XREAD', 'XREVRANGE', 'XTRIM', 'ZADD', 'ZCARD', 'ZCOUNT', 'ZDIFF', 'ZINCRBY', 'ZINTER', 'ZINTERCARD',
  'ZLEXCOUNT', 'ZMPOP', 'ZMSCORE', 'ZPOPMAX', 'ZPOPMIN', 'ZRANDMEMBER', 'ZRANGE', 'ZRANGEBYLEX', 'ZRANGEBYSCORE', 'ZRANGESTORE', 'ZRANK', 'ZREM',
  'ZREMRANGEBYLEX', 'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZREVRANK', 'ZSCAN', 'ZSCORE', 'ZUNION', 'ZUNIONSTORE',
  'CLIENT GETNAME', 'CLIENT ID', 'CLIENT INFO', 'CLIENT KILL', 'CLIENT LIST', 'CLIENT SETNAME', 'COMMAND COUNT', 'COMMAND DOCS', 'COMMAND INFO',
  'CONFIG GET', 'CONFIG RESETSTAT', 'CONFIG REWRITE', 'CONFIG SET', 'MEMORY DOCTOR', 'MEMORY STATS', 'MEMORY USAGE', 'LATENCY LATEST', 'EVAL', 'EVALSHA',
  'EVAL_RO', 'SCRIPT EXISTS', 'SCRIPT FLUSH', 'SCRIPT LOAD', 'FCALL', 'FUNCTION LIST', 'DEBUG', 'BGSAVE', 'BGREWRITEAOF', 'SHUTDOWN',
];

/** Completions of the first word(s) typed: names starting with what is typed (case-insensitive), at most `max`. */
export function completeCommand(line: string, max = 8): string[] {
  const words = line.replace(/^\s+/, '').toUpperCase().split(/\s+/);
  // Only while the command name is typed: one word, or a container command (CONFIG, CLIENT ...) and its subcommand.
  if (!words[0] || words.length > 2 || (words.length === 2 && !REDIS_CONTAINER_COMMANDS.has(words[0]))) return [];
  const prefix = words.join(' ');
  return REDIS_COMMAND_NAMES.filter((n) => n.startsWith(prefix) && n !== prefix).slice(0, max);
}

/** The console history with a new line at the end (the same line twice in a row is kept once), at most `max` lines. */
export function pushHistory(history: readonly string[], line: string, max = 200): string[] {
  const t = line.trim();
  if (!t) return [...history];
  const next = history[history.length - 1] === t ? [...history] : [...history, t];
  return next.slice(-max);
}

// ── Pub/Sub ─────────────────────────────────────────────────────────────────

/** A received message in the renderer's list: seq (a stable key) and `search`, its lower-cased text for the filter (built once). */
export interface RedisPubSubRow extends RedisPubSubMessage { seq: number; search: string }

/** The list keeps at most this many messages and this many payload bytes; older ones go first (and count as dropped). */
export const PUBSUB_LIST_CAP = 5000;
export const PUBSUB_LIST_BYTES = 16 * 1024 * 1024;

const searchText = (m: RedisPubSubMessage): string =>
  [m.channel, m.pattern, m.payload.data].filter((d): d is RedisData => d !== undefined).map((d) => redisDataDisplay(d).toLowerCase()).join('\n');

/** Messages kept under both caps (count and payload bytes), newest last; `dropped`: how many older ones did not fit. */
export function capMessages<T extends { payload: { bytes: number } }>(all: readonly T[], cap = PUBSUB_LIST_CAP, maxBytes = PUBSUB_LIST_BYTES): { kept: T[]; dropped: number } {
  let bytes = 0;
  let from = all.length;
  while (from > 0 && all.length - from < cap && bytes + all[from - 1].payload.bytes <= maxBytes) { from--; bytes += all[from].payload.bytes; }
  return { kept: from ? all.slice(from) : [...all], dropped: from };
}

/** Messages added to the list under the caps; `dropped`: older messages that had to go. */
export function appendMessages(list: readonly RedisPubSubRow[], incoming: readonly RedisPubSubMessage[], nextSeq: number, cap = PUBSUB_LIST_CAP, maxBytes = PUBSUB_LIST_BYTES): { list: RedisPubSubRow[]; nextSeq: number; dropped: number } {
  let seq = nextSeq;
  const added = incoming.map((m) => ({ ...m, seq: seq++, search: searchText(m) }));
  const { kept, dropped } = capMessages([...list, ...added], cap, maxBytes);
  return { list: kept, nextSeq: seq, dropped };
}

/** A message matches the filter when its channel, pattern or payload contains the text (case-insensitive). */
export function messageMatches(m: RedisPubSubMessage & { search?: string }, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return (m.search ?? searchText(m)).includes(f);
}

// ── server info ─────────────────────────────────────────────────────────────

/** The INFO sections shown first, in this order (the rest follow under "other"). */
export const INFO_MAIN_SECTIONS = ['Memory', 'Clients', 'Keyspace', 'Replication', 'Persistence', 'Stats'] as const;

export function infoGroups(sections: readonly RedisInfoSection[]): { main: RedisInfoSection[]; other: RedisInfoSection[] } {
  const lower = (s: string) => s.toLowerCase();
  const main = INFO_MAIN_SECTIONS.map((name) => sections.find((s) => lower(s.name) === lower(name))).filter((s): s is RedisInfoSection => !!s);
  const other = sections.filter((s) => !main.includes(s));
  return { main, other };
}

/** One value of INFO by key (any section). */
export const infoValue = (sections: readonly RedisInfoSection[], key: string): string | undefined => {
  for (const s of sections) for (const [k, v] of s.entries) if (k === key) return v;
  return undefined;
};

/** "3d 4h" for INFO uptime_in_seconds. */
export const formatUptime = (seconds: string | undefined): string | null => (seconds && /^\d+$/.test(seconds) ? formatTtl(Number(seconds) * 1000) : null);

/** The keyspace hit ratio in percent from INFO stats, or null without hits and misses. */
export function hitRatio(sections: readonly RedisInfoSection[]): number | null {
  const hits = Number(infoValue(sections, 'keyspace_hits')), misses = Number(infoValue(sections, 'keyspace_misses'));
  if (!Number.isFinite(hits) || !Number.isFinite(misses) || hits + misses === 0) return null;
  return Math.round((hits / (hits + misses)) * 1000) / 10;
}

// ── text editing: line endings ──────────────────────────────────────────────

/**
 * How a text value can be edited in a textarea (which turns every CR and CRLF into LF): `lf` as is; `crlf` (every line break is
 * CRLF) shown with LF and turned back on save; `mixed` (lone CR, or LF and CRLF together) cannot round-trip, so the text editor is
 * read-only for it (a string value can be edited as hex).
 */
export type LineEndings = 'lf' | 'crlf' | 'mixed';

export function lineEndings(text: string): LineEndings {
  if (!text.includes('\r')) return 'lf';
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const cr = (text.match(/\r/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf === cr && crlf === lf ? 'crlf' : 'mixed';
}

/** The text a textarea shows for a value (LF line breaks). */
export const editorText = (text: string): string => text.replace(/\r\n/g, '\n');

/** The value to save from a textarea's text: CRLF values get their CRLF back; null for `mixed` (never saved from text). */
export function savedText(edited: string, eol: LineEndings): string | null {
  if (eol === 'mixed') return null;
  const lf = edited.replace(/\r\n?/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

// ── console history ─────────────────────────────────────────────────────────

const MASK = '***';
const upper = (d: RedisData | undefined): string => (typeof d === 'string' ? d.toUpperCase() : '');

/**
 * The console line as it may be kept in the history (localStorage), or null when it must not be kept at all. AUTH and HELLO ...
 * AUTH lines are dropped; the secrets of CONFIG SET requirepass / masterauth / masteruser, ACL SETUSER ">pass" / "#hash" rules
 * and MIGRATE ... AUTH / AUTH2 are masked.
 */
export function historyLine(argv: readonly RedisData[]): string | null {
  const first = upper(argv[0]);
  if (first === 'AUTH') return null;
  if (first === 'HELLO' && argv.some((a) => upper(a) === 'AUTH')) return null;
  const out = argv.map((a) => quoteRedisArg(a));
  const name = redisCommandName(argv);
  if (name === 'CONFIG SET') {
    for (let i = 2; i + 1 < argv.length; i += 2) if (['REQUIREPASS', 'MASTERAUTH', 'MASTERUSER'].includes(upper(argv[i]))) out[i + 1] = MASK;
  } else if (name === 'ACL SETUSER') {
    for (let i = 3; i < argv.length; i++) {
      const a = argv[i];
      if (typeof a !== 'string') out[i] = MASK;
      else if (/^[>#<!]/.test(a)) out[i] = `${a[0]}${MASK}`;
    }
  } else if (first === 'MIGRATE') {
    for (let i = 0; i < argv.length; i++) {
      if (upper(argv[i]) === 'AUTH' && i + 1 < argv.length) out[i + 1] = MASK;
      if (upper(argv[i]) === 'AUTH2' && i + 2 < argv.length) out[i + 2] = MASK;
    }
  }
  return out.join(' ');
}

// ── outcomes of calls (what the views do with a result) ─────────────────────

type Failure = { ok: false; error: string };

/**
 * What a write from an open value view leads to: done; `reload` (the key vanished, holds another type now or the item changed:
 * read it again, with `why`); `timeout` (not run or cut: tell the user, never retried by itself); `error` (show the text).
 */
export type WriteOutcome = { kind: 'done' } | { kind: 'reload'; why: 'notFound' | 'wrongType' | 'conflict' } | { kind: 'timeout' } | { kind: 'error' };

export function writeOutcome(r: { ok: true } | Failure): WriteOutcome {
  if (r.ok) return { kind: 'done' };
  if (r.error === 'notFound' || r.error === 'wrongType' || r.error === 'conflict') return { kind: 'reload', why: r.error };
  if (r.error === 'dbTimeout' || r.error === 'statementTimeout') return { kind: 'timeout' };
  return { kind: 'error' };
}

/** The pattern delete's steps: ask with the count, nothing matches, done, count again and ask again, or an error. */
export type PatternStep =
  | { kind: 'confirm'; token: string; count: number; complete: boolean }
  | { kind: 'empty' }
  | { kind: 'done'; deleted: number; cancelled: boolean }
  | { kind: 'recount'; deleted: number }
  | { kind: 'error'; recount: boolean };

export function afterPatternCount(r: { ok: true; value: { token: string; count: number; complete: boolean } } | Failure): PatternStep {
  if (!r.ok) return { kind: 'error', recount: false };
  return r.value.count > 0 ? { kind: 'confirm', token: r.value.token, count: r.value.count, complete: r.value.complete } : { kind: 'empty' };
}

/** After a delete: done; `recount` (`more`: keys still match, count and confirm again); error (staleToken: count again first). */
export function afterPatternDelete(r: { ok: true; value: { deleted: number; cancelled: boolean; more: boolean } } | Failure, deletedBefore: number): PatternStep {
  if (!r.ok) return { kind: 'error', recount: r.error === 'staleToken' };
  const deleted = deletedBefore + r.value.deleted;
  if (r.value.cancelled || !r.value.more) return { kind: 'done', deleted, cancelled: r.value.cancelled };
  return { kind: 'recount', deleted };
}

/** What the console does with a parsed command before sending it. */
export type ConsoleRoute = { kind: 'send' } | { kind: 'confirm' } | { kind: 'refuse'; why: 'subscribe' | 'blocking' | 'unsupported' };

export function consoleRoute(argv: readonly RedisData[]): ConsoleRoute {
  const cls = classifyRedisCommand(argv);
  if (cls.refused === 'subscribe') return { kind: 'refuse', why: 'subscribe' };
  if (cls.refused === 'blocking') return { kind: 'refuse', why: 'blocking' };
  if (cls.refused) return { kind: 'refuse', why: 'unsupported' };
  return cls.dangerous ? { kind: 'confirm' } : { kind: 'send' };
}

/** What the console does with a refused send: offer the read-only override, ask (dangerous, or a big reply), or show the error. */
export type ConsoleRetry = { kind: 'offerWrite' } | { kind: 'ask'; why: 'danger' | 'big' } | { kind: 'error' };

export function afterConsoleError(error: string, argv: readonly RedisData[], confirmed: boolean): ConsoleRetry {
  if (error === 'readOnly') return { kind: 'offerWrite' };
  if (error === 'needsConfirm' && !confirmed) return { kind: 'ask', why: classifyRedisCommand(argv).dangerous ? 'danger' : 'big' };
  return { kind: 'error' };
}

/**
 * The text to save from the JSON view: a stored value already in the pretty (2 spaces) or compact form keeps that form; any
 * other formatting (4 spaces, tabs, one line with spaces) is not rewritten silently: `ask` (pretty or compact).
 */
export type JsonSave = { kind: 'save'; text: string } | { kind: 'ask'; pretty: string; compact: string } | { kind: 'invalid' };

export function jsonSaveText(stored: string, edited: string): JsonSave {
  const pretty = formatJson(edited, 2), compact = formatJson(edited, 0);
  if (pretty === null || compact === null) return { kind: 'invalid' };
  if (formatJson(stored, 2) === stored) return { kind: 'save', text: pretty };
  if (formatJson(stored, 0) === stored) return { kind: 'save', text: compact };
  return { kind: 'ask', pretty, compact };
}
