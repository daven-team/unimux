// The DB main-side part of the golden corpus (1.2.0, PLAN D1), used by scripts/dump-goldens.mjs and
// test/db-ipc-vectors.test.ts:
//
//   test/golden/db-ipc.jsonl  {fn, args} -> what the TS reference answers:
//     schema      the zod schemas in front of every db:* channel (src/main/db/ipc.ts DB_IPC_SCHEMAS): accepted or not
//     redisOp     the db:redis check: null when the schema refuses it, else the byte count of the whole request (totalBytes)
//     strictConnection, dbEndpoint, dbDefaultDatabase, duplicateDbConnection, validDbFilePath   (src/shared/db.ts, service.ts)
//     historyRecord, normalizeHistoryItem, normalizeHistoryFile, addHistory, starHistory, clearHistoryEntries   (dbHistory.ts)
//
// The Rust port (crates/unimux-db/tests/db_ipc.rs) answers the same rows, and vitest runs every row through the TS code again
// (callDbIpc below). Inputs: hand-made valid requests of every shape, each mutated at every path (removed, replaced by values
// around every limit, an unknown key added), plus seeded random records, files and connections.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Map -> [[key, value]] (normalizeHistoryFile answers one). */
const plain = (v) => (v instanceof Map ? [...v.entries()].map(([k, x]) => [k, plain(x)]) : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
const json = (v) => (v === undefined ? { $undef: true } : JSON.parse(JSON.stringify(plain(v))));

const FNS = {
  schema: (m, name, input) => m.ipc.DB_IPC_SCHEMAS[name].safeParse(input).success,
  // null: refused by the schema; else the byte count db:redis compares with REDIS_LIMITS.writeBytes.
  redisOp: (m, input) => {
    const r = m.ipc.DB_IPC_SCHEMAS.redisOp.safeParse(input);
    return r.success ? m.ipc.dbIpcTotalBytes(r.data) : null;
  },
  strictConnection: (m, raw) => m.service.strictConnection(raw),
  dbEndpoint: (m, c) => m.db.dbEndpoint(c),
  dbDefaultDatabase: (m, c) => m.db.dbDefaultDatabase(c),
  duplicateDbConnection: (m, s, id, newId, now) => m.db.duplicateDbConnection(s, id, newId, now),
  validDbFilePath: (m, v) => m.db.validDbFilePath(v),
  historyRecord: (m, raw) => m.history.historyRecord(raw),
  normalizeHistoryItem: (m, raw) => m.history.normalizeHistoryItem(raw),
  normalizeHistoryFile: (m, raw) => m.history.normalizeHistoryFile(raw),
  addHistory: (m, entries, records, limit) => { let n = 0; return m.history.addHistory(entries, records, () => `id${++n}`, limit); },
  starHistory: (m, entries, id, star) => m.history.starHistory(entries, id, star),
  clearHistoryEntries: (m, entries, stars) => m.history.clearHistoryEntries(entries, stars),
};

/** What `fn(...args)` answers in the TS code, as JSON. */
export function callDbIpc(m, fn, args) {
  const f = FNS[fn];
  if (!f) throw new Error(`no function ${fn}`);
  return json(f(m, ...args));
}

const U = '00000000-0000-4000-8000-0000000000aa';
const U2 = 'ABCDEF00-0000-4000-8000-0000000000BB';
const SID = `db:${U}`;

// ── valid requests of every shape ─────────────────────────────────────────────

const pgInput = { kind: 'postgres', name: 'prod', host: 'db.example.com', port: 5432, user: 'app', database: 'shop', tls: 'disable', ssh: null, readOnly: false };
const BASES = {
  connectionInput: [
    pgInput,
    { ...pgInput, id: U, color: '#aabbcc', group: 'Prod', tls: 'verify-full', caPath: 'C:\\ca.pem', statementTimeoutMs: 5000 },
    { kind: 'mysql', name: 'm', host: '10.0.0.1', port: 3306, user: 'root', tls: 'prefer', ssh: { hostId: U, dbHost: '127.0.0.1', dbPort: 3306 }, readOnly: true },
    { kind: 'redis', name: 'r', host: 'localhost', port: 6379, user: '', dbIndex: 3, tls: 'disable', ssh: null, readOnly: false },
    { kind: 'sqlite', name: 'shop', host: '', port: 0, user: '', tls: 'disable', ssh: null, readOnly: true, path: 'C:\\data\\shop.sqlite' },
  ],
  passwordChange: [{ keep: true }, { set: 'pw' }, { clear: true }],
  testPassword: [{ set: 'pw' }, { saved: U }, null],
  answer: [
    { sessionId: SID, promptId: U, cancel: true },
    { sessionId: SID, promptId: U, values: ['pw'], remember: true },
    { sessionId: SID, promptId: U, values: [] },
    { sessionId: SID, promptId: U, hostKey: 'save' },
  ],
  connectOptions: [null, {}, { database: 'x' }, { database: '' }],
  pins: [[], [SID], [SID, `DB:${U2}`]],
  uuid: [U, U2],
  sessionId: [SID, `Db:${U2}`],
  op: [
    { op: 'databases' }, { op: 'schemas' }, { op: 'objects', schema: 'public' }, { op: 'tableInfo', schema: 'public', name: 'items' },
    { op: 'ddl', schema: 'public', name: 'f', kind: 'function', args: 'integer' },
    { op: 'tablePage', req: { queryId: U, schema: 's', table: 't', limit: 100, offset: 0, after: ['1'], sort: [{ column: 'id', desc: true }], filter: "name LIKE 'a%'" } },
    { op: 'query', req: { queryId: U, sql: 'SELECT 1', rowCap: 1000, statementTimeoutMs: null, readWrite: true, continueOnError: false } },
    { op: 'query', req: { queryId: U, sql: 'SELECT 1', statementTimeoutMs: 5000 } },
    { op: 'fetchMore', queryId: U, count: 1000 }, { op: 'closeResult', queryId: U }, { op: 'cancel' }, { op: 'transaction', action: 'commit' },
    { op: 'previewEdits', req: { schema: 's', table: 't', edits: [{ op: 'update', key: { id: '1' }, set: { name: 'x', other: null }, original: { name: 'y' } }, { op: 'insert', values: { a: '1' } }, { op: 'delete', key: { id: '2' } }] } },
    { op: 'applyEdits', req: { schema: 's', table: 't', edits: [{ op: 'delete', key: { id: '2' }, original: {} }] } },
    { op: 'cellValue', req: { schema: 's', table: 't', key: { id: '1' }, column: 'body' } },
  ],
  redisOp: [
    { kind: 'databases' }, { kind: 'select', index: 2 },
    { kind: 'scan', req: { cursor: '0', match: 'user:*', count: 200, type: 'hash', limit: 2000, details: true } }, { kind: 'scan', req: { cursor: '18446744073709551615' } },
    { kind: 'keyInfo', keys: ['a', { b64: 'QUJD' }] },
    { kind: 'read', req: { type: 'string', key: 'k', offset: 0, maxBytes: 1024 } },
    { kind: 'read', req: { type: 'hash', key: 'k', cursor: '0', count: 100, match: 'f*' } },
    { kind: 'read', req: { type: 'list', key: 'k', start: 0, count: 100 } },
    { kind: 'read', req: { type: 'set', key: 'k', cursor: '0', count: 100 } },
    { kind: 'read', req: { type: 'zset', key: 'k', start: 0, count: 100, rev: true } },
    { kind: 'read', req: { type: 'zset', key: 'k', cursor: '0', count: 100, match: 'm*' } },
    { kind: 'read', req: { type: 'stream', key: 'k', start: '-', end: '+', count: 100, rev: false } },
    { kind: 'read', req: { type: 'stream', key: 'k', start: '(1-2', end: '5', count: 10 } },
    { kind: 'readItem', req: { type: 'hash', key: 'k', field: 'f' } }, { kind: 'readItem', req: { type: 'list', key: 'k', index: -1 } },
    { kind: 'readItem', req: { type: 'stream', key: 'k', id: '1-0', field: 'f' } },
    ...[
      { op: 'set', key: 'k', value: 'v', keepTtl: true, ttlMs: 1000, existing: false }, { op: 'hset', key: 'k', field: 'f', value: { b64: 'AA==' }, onlyNew: true, existing: true },
      { op: 'hdel', key: 'k', fields: ['f'] }, { op: 'lpush', key: 'k', items: ['a', 'b'], existing: true }, { op: 'rpush', key: 'k', items: ['a'] },
      { op: 'lset', key: 'k', index: 0, value: 'v', expected: 'old' }, { op: 'lrem', key: 'k', count: -2, value: 'v' }, { op: 'ldel', key: 'k', index: 3, expected: 'e' },
      { op: 'sadd', key: 'k', members: ['m'], existing: false }, { op: 'srem', key: 'k', members: ['m'] },
      { op: 'zadd', key: 'k', entries: [['m', '1.5'], ['n', '-inf']], mode: 'nx', existing: true }, { op: 'zrem', key: 'k', members: ['m'] },
      { op: 'zincrby', key: 'k', member: 'm', by: '+2e3' }, { op: 'xadd', key: 'k', id: '*', fields: [['f', 'v']], maxLen: 100, approx: true, existing: false },
      { op: 'xdel', key: 'k', ids: ['1-1', '2'] }, { op: 'xtrim', key: 'k', strategy: 'minid', threshold: '5-0', approx: false },
      { op: 'rename', key: 'k', newKey: 'k2', overwrite: true }, { op: 'expire', key: 'k', ttlMs: 60000 }, { op: 'persist', key: 'k' }, { op: 'delete', keys: ['a', 'b'] },
      { op: 'create', key: 'k', value: { type: 'string', value: 'v' }, ttlMs: 5 }, { op: 'create', key: 'h', value: { type: 'hash', entries: [['f', 'v']] } },
      { op: 'create', key: 'l', value: { type: 'list', items: ['a'] } }, { op: 'create', key: 's', value: { type: 'set', members: ['a'] } },
      { op: 'create', key: 'z', value: { type: 'zset', entries: [['a', '1']] } }, { op: 'create', key: 'x', value: { type: 'stream', id: '1-*', fields: [['f', 'v']] } },
    ].map((write) => ({ kind: 'write', write })),
    { kind: 'countPattern', match: '*', type: 'string' }, { kind: 'deletePattern', token: U }, { kind: 'cancel' },
    { kind: 'command', req: { argv: ['GET', 'k'], readWrite: false, confirmed: true, timeoutMs: 30000 } }, { kind: 'command', req: { argv: ['SET', { b64: 'AA==' }, 'v'] } },
    { kind: 'info', section: 'keyspace' }, { kind: 'info' }, { kind: 'slowlog', count: 10 }, { kind: 'clients' },
    { kind: 'subscribe', channels: ['a'], patterns: ['b*'] }, { kind: 'unsubscribe', channels: [], all: true }, { kind: 'pubsubState' },
    { kind: 'publish', channel: 'c', message: 'm', readWrite: true },
  ],
};

// ── mutations ─────────────────────────────────────────────────────────────────

/** String lengths around the limits of the schemas (the long ones only for some leaves, to keep the file small). */
const LIMITS = [16, 32, 40, 60, 64, 80, 128, 253];
const LONG_LIMITS = [1024, 4096, 8192];
/** Replacements every path gets; each of SMALL is used with a probability (seeded). */
const ALWAYS = [null, true, 0, -1, 1.5, '', 'x', [], {}];
const SMALL = [
  null, true, false, 0, -1, 1, 1.5, 2, 32, 33, 100, 1000, 1001, 2000, 2001, 5000, 5001, 10000, 10001, 65535, 65536, 100000, 100001, 300000, 300001,
  86400000, 86400001, 2 ** 53 - 1, 2 ** 53, -(2 ** 53), 1e21, '', ' ', 'x', 'a b', 'a\0b', '\u0001', 'żółw', '😀', U, U2, SID, `sftp:${U}`, 'db:x', '0', '18446744073709551615',
  '123456789012345678901', '1-2', '1-*', '*', '-', '+', '(1', '((1', 'inf', '-INF', '1e5', '1.', '.5', 'e5', 'Q===', 'keyspace', 'key space', 'a_B', 'postgres', 'mysql', 'redis',
  'sqlite', 'other', 'disable', 'verify-full', 'update', 'insert', 'delete', 'begin', 'once', 'nx', 'maxlen', 'string', 'hash', 'stream', 'zset', 'list', 'set', 'C:\\x.db',
  '/a.db', 'relative.db', [], [1], ['a'], [['a', 'b']], [['a']], {}, { b64: 'QUJD' }, { b64: 'QQ==' }, { b64: 'Q===' }, { b64: 'QUJD', x: 1 }, { a: '1' }, { '': '1' },
];

function paths(v, at = []) {
  const out = [at];
  if (Array.isArray(v)) v.forEach((x, i) => out.push(...paths(x, [...at, i])));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) out.push(...paths(x, [...at, k]));
  return out;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
function setAt(v, path, value) {
  if (!path.length) return value;
  const out = clone(v);
  let node = out;
  for (const k of path.slice(0, -1)) node = node[k];
  node[path.at(-1)] = value;
  return out;
}
function removeAt(v, path) {
  const out = clone(v);
  let node = out;
  for (const k of path.slice(0, -1)) node = node[k];
  if (Array.isArray(node)) node.splice(path.at(-1), 1); else delete node[path.at(-1)];
  return out;
}
const getAt = (v, path) => path.reduce((n, k) => n?.[k], v);

function mutations(base, r) {
  const out = [base];
  for (const path of paths(base)) {
    const leaf = getAt(base, path);
    if (path.length) out.push(removeAt(base, path));
    for (const x of ALWAYS) out.push(setAt(base, path, x));
    for (const x of SMALL) if (r() < 0.2) out.push(setAt(base, path, x));
    if (typeof leaf === 'string') {
      for (const n of [...LIMITS, ...LONG_LIMITS.filter(() => r() < 0.25)]) {
        out.push(setAt(base, path, 'a'.repeat(n)), setAt(base, path, 'a'.repeat(n + 1)));
        if (r() < 0.2) out.push(setAt(base, path, '😀'.repeat(n / 2)), setAt(base, path, `${'😀'.repeat(Math.floor(n / 2))}a`));
      }
      out.push(setAt(base, path, '1'.repeat(20)), setAt(base, path, '1'.repeat(21)), setAt(base, path, `${'1'.repeat(20)}-${'2'.repeat(20)}`));
    }
    if (leaf && typeof leaf === 'object' && !Array.isArray(leaf)) out.push(setAt(base, path, { ...leaf, extra: 1 }));
    if (Array.isArray(leaf) && leaf.length) {
      out.push(setAt(base, path, [...leaf, leaf[0]]), setAt(base, path, Array.from({ length: 33 }, () => leaf[0])));
    }
  }
  return out;
}

// ── connections, history ──────────────────────────────────────────────────────

function connectionRows(m, add, r) {
  for (const base of BASES.connectionInput) {
    const raw = { ...base, id: base.id ?? U, createdAt: 1000, updatedAt: 1000 };
    for (const c of mutations(raw, r).slice(0, 400)) {
      add('strictConnection', c);
      // The endpoint and default database of a connection that passed (the service only ever has those).
      const strict = m.service.strictConnection(clone(c));
      if (strict) {
        add('dbEndpoint', strict);
        add('dbDefaultDatabase', strict);
      }
    }
  }
  const names = ['prod', 'prod (2)', 'prod (3)', 'a'.repeat(80), `${'a'.repeat(76)}😀`, 'x'];
  for (let i = 0; i < 60; i++) {
    const n = 1 + Math.floor(r() * 4);
    const list = Array.from({ length: n }, (_, k) => ({ ...pgInput, id: `00000000-0000-4000-8000-00000000000${k}`, name: names[Math.floor(r() * names.length)], createdAt: k, updatedAt: k, ...(r() < 0.3 ? { ssh: { hostId: U, dbHost: 'h', dbPort: 22 } } : {}) }));
    const s = { other: 1, dbConnections: list };
    add('duplicateDbConnection', s, list[Math.floor(r() * n)].id, U2, 77);
  }
  add('duplicateDbConnection', { dbConnections: [] }, U, U2, 1);
  add('duplicateDbConnection', {}, U, U2, 1);
  for (const p of ['C:\\data\\shop.sqlite', 'c:/x.db', 'C:', 'C:x', '\\\\srv\\share\\a.db', '\\\\\\x', '\\x', '/', '/a', '/a/', 'C:\\dir\\', ' /a', '/a ', '/a\u0007', 'relative.db', '', 'x'.repeat(4097), `/${'x'.repeat(4094)}`, `/${'x'.repeat(4095)}`, '/😀', 42, null]) add('validDbFilePath', p);
}

const SQLS = ['SELECT 1', '  SELECT 2  ', "CREATE USER u IDENTIFIED BY 'secret'", "ALTER USER x PASSWORD 'p'", 'postgres://u:pw@h/db?password=abc', '', '   ', 'sélect ł', '\tSELECT\n3\r\n'];
/** The statements at the length limit (16 Ki UTF-16 units), used in a few rows only. */
const LONG_SQLS = ['x'.repeat(16384), 'x'.repeat(16385), '😀'.repeat(8192), `${'😀'.repeat(8192)}x`, ` ${'x'.repeat(16384)} `];
const ERRORS = [undefined, '', ' ', 'line one\nline two', "bad password 'x' IDENTIFIED BY 'y'", 'e'.repeat(400), `${'😀'.repeat(150)}`, 42];
const NUMS = [0, 1, 2.4, 2.5, 2.6, -1, -0.5, 1e21, 1793974277195.7, 0.49999999999999994, 'now', null, undefined, true];
const pick = (r, list) => list[Math.floor(r() * list.length)];

function historyRows(add, r) {
  for (const sql of LONG_SQLS) {
    add('historyRecord', { sql, at: 1, timeMs: 1, rows: 1, ok: true });
    add('normalizeHistoryItem', { id: 'x1', sql, at: 1, timeMs: 1, rows: 1, ok: true });
  }
  for (let i = 0; i < 1500; i++) {
    const rec = { sql: pick(r, SQLS), at: pick(r, NUMS), timeMs: pick(r, NUMS), rows: pick(r, NUMS), ok: r() < 0.9 ? r() < 0.5 : pick(r, [1, 'true', null]) };
    const err = pick(r, ERRORS);
    if (err !== undefined) rec.error = err;
    for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
    add('historyRecord', rec);
    const item = { id: pick(r, ['x1', 'a'.repeat(40), 'a'.repeat(41), 'bad id!', '', 'A-_9', 7]), ...rec, ...(r() < 0.3 ? { star: pick(r, [true, false, 1]) } : {}) };
    add('normalizeHistoryItem', item);
  }
  for (const v of [null, [], 'x', 1, {}, { version: 'x' }, { version: 2 }, { version: 1 }, { version: 0, enabled: false }, { version: 1, enabled: 'no', connections: [] }, { version: 1, connections: { [U]: 'x' } }]) add('normalizeHistoryFile', v);
  for (let i = 0; i < 80; i++) {
    const connections = {};
    const n = Math.floor(r() * 4);
    for (let c = 0; c < n; c++) {
      const id = pick(r, [U, U2, 'nope', `00000000-0000-4000-8000-00000000000${c}`]);
      connections[id] = Array.from({ length: Math.floor(r() * 5) }, (_, k) => ({ id: pick(r, [`e${k}`, 'dup', 'bad id']), sql: pick(r, SQLS), at: pick(r, [1, 2.5, -1]), timeMs: 1.5, rows: pick(r, [1, null, -2]), ok: true, ...(r() < 0.3 ? { star: true } : {}), ...(r() < 0.2 ? { error: 'boom' } : {}) }));
    }
    add('normalizeHistoryFile', { version: 1, ...(r() < 0.3 ? { enabled: pick(r, [false, true, 0]) } : {}), connections });
  }
  const many = { version: 1, connections: Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, [{ id: 'a', sql: 'S', at: 1, timeMs: 1, rows: 1, ok: true }]])) };
  add('normalizeHistoryFile', many);
  add('normalizeHistoryFile', { version: 1, connections: { [U]: Array.from({ length: 1600 }, (_, i) => ({ id: `e${i}`, sql: 'S', at: 1, timeMs: 1, rows: 1, ok: true })) } });
  const entry = (id, star) => ({ sql: `S ${id}`, at: 1, timeMs: 1, rows: null, ok: true, id, ...(star ? { star: true } : {}) });
  for (let i = 0; i < 200; i++) {
    const entries = Array.from({ length: Math.floor(r() * 8) }, (_, k) => entry(`e${k}`, r() < 0.3));
    const records = Array.from({ length: Math.floor(r() * 4) }, (_, k) => ({ sql: `R ${k}`, at: k, timeMs: 0, rows: k, ok: r() < 0.5, ...(r() < 0.3 ? { error: 'x' } : {}) }));
    add('addHistory', entries, records, 1 + Math.floor(r() * 6));
    const id = entries.length ? entries[Math.floor(r() * entries.length)].id : 'none';
    add('starHistory', entries, r() < 0.1 ? 'missing' : id, r() < 0.5);
    add('clearHistoryEntries', entries, r() < 0.5);
  }
  const full = Array.from({ length: 501 }, (_, k) => entry(`s${k}`, k < 500));
  add('starHistory', full, 's500', true);
  add('starHistory', full, 's0', true);
  add('starHistory', full, 's1', false);
}

/** The rows of test/golden/db-ipc.jsonl. */
export function dbIpcGoldens(m) {
  const rows = [];
  const seen = new Set();
  const add = (fn, ...args) => {
    const stored = JSON.parse(JSON.stringify(args));
    const id = `${fn}${JSON.stringify(stored)}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ fn, args: stored, out: callDbIpc(m, fn, stored) });
  };
  const r = rng(0xd1);
  for (const [name, bases] of Object.entries(BASES)) {
    for (const base of bases) {
      for (const v of mutations(base, r)) {
        if (v === undefined) continue;
        // A Redis request: the schema and the byte budget together (what db:redis checks).
        if (name !== 'redisOp') add('schema', name, v);
        if (name === 'redisOp') add('redisOp', v);
      }
    }
  }
  connectionRows(m, add, r);
  historyRows(add, r);
  // Ids of exactly 39 (session) and 36 (guid) UTF-8 bytes with a multi-byte character near the start: the schemas refuse
  // them (a byte slice at 3 inside a character must not panic in the Rust port).
  const oddSid = `dbż${'a'.repeat(35)}`;
  const oddGuid = `0000000ż${'0'.repeat(27)}`;
  for (const sid of [oddSid, `ż:${U}`, `dż${U}`]) {
    add('schema', 'sessionId', sid);
    add('schema', 'pins', [sid]);
    add('schema', 'answer', { sessionId: sid, promptId: U, cancel: true });
  }
  for (const id of [oddGuid, `${U.slice(0, 34)}ż`]) {
    add('schema', 'uuid', id);
    add('schema', 'answer', { sessionId: SID, promptId: id, cancel: true });
  }
  return rows;
}

/** The TS modules the vectors run through (paths from the repo root). */
export const DB_IPC_MODULES = { ipc: 'src/main/db/ipc.ts', service: 'src/main/db/service.ts', db: 'src/shared/db.ts', history: 'src/shared/dbHistory.ts', redis: 'src/shared/dbRedis.ts' };
