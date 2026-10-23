// The renderer side of the database viewer (1.0.0): session and prompt state from main, the DB port (result rows straight
// from the DB Host) routed by query id, shared sessions (one per connection and database: the tree, table and DDL tabs) and
// the own sessions of SQL editor tabs, pins, and the loads of the panel's tree.
import { create } from 'zustand';
import { setDbPins } from './pins';
import { dbDefaultDatabase, dbErrorText, type DbConnection, type DbErrorCode, type DbKind, type DbPortMessage, type DbPrompt, type DbResult, type DbServerError, type DbSessionState, type DbVaultInfo } from '../../../shared/db';
import { loadKey, type DbLoad, type DbLoadRequest, type RedisKeysLoad } from '../../../shared/dbTree';
import { mergeKeys } from '../../../shared/redisView';
import { tr } from '../i18n';
import { getS } from '../store';
import { sshContext } from '../ssh';

export interface DbStore {
  sessions: Record<string, DbSessionState>;
  prompts: Record<string, DbPrompt>;
  vault: DbVaultInfo | null;
  /** sharedKey(connection, database) -> session id. */
  shared: Record<string, string>;
  /** Editor tab id -> its own session (SQL tabs). */
  tabSessions: Record<string, string>;
  /** Loaded lists of the tree (dbTree loadKey). */
  loads: Record<string, DbLoad>;
  /** Tree nodes the user opened or folded (dbTree toggleNode). */
  open: string[];
  filter: string;
}

const TREE_KEY = 'mc-db-tree-v1';
const SESSIONS_KEY = 'mc-db-sessions-v1';
const readOpen = (): string[] => {
  try { const v: unknown = JSON.parse(localStorage.getItem(TREE_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 5000) : []; } catch { return []; }
};

export const useDbStore = create<DbStore>(() => ({ sessions: {}, prompts: {}, vault: null, shared: {}, tabSessions: {}, loads: {}, open: readOpen(), filter: '' }));

export const sharedKey = (connectionId: string, database: string): string => `${connectionId}\n${database}`;
/**
 * The database whose shared session serves `database` of a connection: its own for Postgres (a session sees one database) and
 * Redis (one per DB), the connection's default one for MySQL (a MySQL session reads every database by its qualified names).
 */
export const sharedDatabase = (connection: Pick<DbConnection, 'kind' | 'database' | 'dbIndex'>, database?: string): string =>
  (connection.kind === 'mysql' || connection.kind === 'sqlite' || database === undefined ? dbDefaultDatabase(connection) : database);
export const isLive = (s: DbSessionState | undefined): boolean => !!s && (s.state === 'connected' || s.state === 'connecting');

/** The text of an error of a DB call or session (translated), with the server's own words when it sent some. */
export function dbErrorMessage(error: DbErrorCode | string, server?: DbServerError | string, connectionId?: string, kind?: DbKind): string {
  const connection = connectionId ? getS().dbConnections?.find((c) => c.id === connectionId) : undefined;
  // A code the core may add later (busy, caps) reads as a generic failure until it has a text. `kind`: of a form's draft
  // (not saved yet, or changed), else the saved connection's.
  const t = dbErrorText(error as DbErrorCode, sshContext(connection?.ssh?.hostId), kind ?? connection?.kind);
  const base = tr(t.key, t.params);
  const detail = typeof server === 'string' ? server : server?.message;
  return detail && detail !== base ? `${base}: ${detail}` : base;
}
export const resultError = (r: Extract<DbResult<unknown>, { ok: false }>, connectionId?: string): string => dbErrorMessage(r.error, r.server, connectionId);

// ── the DB port ─────────────────────────────────────────────────────────────

const listeners = new Map<string, (m: DbPortMessage) => void>();
/** Receives the port messages of one query id until the returned function is called. */
export function onQuery(queryId: string, fn: (m: DbPortMessage) => void): () => void {
  listeners.set(queryId, fn);
  return () => { if (listeners.get(queryId) === fn) listeners.delete(queryId); };
}

// The port arrives when the DB Host starts and again right after a reload (before the app boots): listen from the start.
let port: MessagePort | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data !== 'mc:db-port' || !e.ports[0]) return;
    port?.close();
    port = e.ports[0];
    // Query messages go to their query's listener; Redis Pub/Sub messages (keyed by session, no queryId) are not for these.
    port.onmessage = (m: MessageEvent<DbPortMessage>) => { const msg = m.data; if (msg && typeof msg === 'object' && 'queryId' in msg) listeners.get(msg.queryId)?.(msg); };
    port.start();
  });
}

// ── events ──────────────────────────────────────────────────────────────────

const waiters = new Map<string, Array<(s: DbSessionState) => void>>();
/** The last state of sessions that ended (a wait that starts late still gets the error). */
const ended = new Map<string, DbSessionState>();
function onSession(s: DbSessionState): void {
  if (!isLive(s)) {
    ended.set(s.id, s);
    if (ended.size > 200) ended.delete(ended.keys().next().value!);
  }
  useDbStore.setState((st) => {
    const sessions = { ...st.sessions, [s.id]: s };
    if (!isLive(s)) delete sessions[s.id];
    const prompts = { ...st.prompts };
    if (!isLive(s)) delete prompts[s.id];
    return { sessions, prompts, ...(isLive(s) ? {} : dropSession(st, s.id)) };
  });
  if (s.state !== 'connecting') { const list = waiters.get(s.id); waiters.delete(s.id); list?.forEach((fn) => fn(s)); }
}
/** Removes a session that ended from the maps (its tree loads too: they must load again on the next session). */
function dropSession(st: DbStore, id: string): Partial<DbStore> {
  const shared = Object.fromEntries(Object.entries(st.shared).filter(([, sid]) => sid !== id));
  const tabSessions = Object.fromEntries(Object.entries(st.tabSessions).filter(([, sid]) => sid !== id));
  const gone = Object.entries(st.shared).find(([, sid]) => sid === id)?.[0];
  if (!gone) return { shared, tabSessions };
  const [connectionId, database] = gone.split('\n');
  // A MySQL connection's one shared session loaded every database of its tree.
  const kind = getS().dbConnections?.find((c) => c.id === connectionId)?.kind;
  const wholeServer = kind === 'mysql' || kind === 'sqlite';
  const loads = Object.fromEntries(Object.entries(st.loads).filter(([key]) => {
    const parts = JSON.parse(key) as string[];
    if (parts[1] !== connectionId) return true;
    return parts[0] === 'databases' || wholeServer ? false : parts[2] !== database;
  }));
  return { shared, tabSessions, loads };
}

let booted = false;
export function initDb(): void {
  if (booted) return;
  booted = true;
  window.mc.on('db:session', onSession);
  window.mc.on('db:prompt', (sessionId, prompt) => useDbStore.setState((st) => {
    const prompts = { ...st.prompts };
    if (prompt) prompts[sessionId] = prompt; else delete prompts[sessionId];
    return { prompts };
  }));
  window.mc.on('db:vault:changed', (vault) => useDbStore.setState({ vault }));
  window.mc.on('db:hostCrashed', () => useDbStore.setState({ loads: {} }));
  void window.mc.db.vaultInfo().then((vault) => useDbStore.setState({ vault })).catch(() => undefined);
  // After a reload main still has the sessions: the shared ones and those of SQL tabs come back from this window's storage.
  void window.mc.db.sessions().then((snap) => {
    let saved: { shared?: Record<string, string>; tabSessions?: Record<string, string> } = {};
    try { saved = JSON.parse(sessionStorage.getItem(SESSIONS_KEY) ?? '{}'); } catch { /* none */ }
    const live = new Map(snap.sessions.filter(isLive).map((s) => [s.id, s]));
    const keep = (r: Record<string, string> | undefined) => Object.fromEntries(Object.entries(r ?? {}).filter(([, id]) => live.has(id)));
    useDbStore.setState((st) => ({
      sessions: { ...Object.fromEntries(live), ...st.sessions },
      prompts: { ...Object.fromEntries(snap.prompts.map((p) => [p.sessionId, p.prompt])), ...st.prompts },
      shared: { ...keep(saved.shared), ...st.shared }, tabSessions: { ...keep(saved.tabSessions), ...st.tabSessions },
    }));
  }).catch(() => undefined);
  useDbStore.subscribe((st, prev) => {
    if (st.open !== prev.open) { try { localStorage.setItem(TREE_KEY, JSON.stringify(st.open)); } catch { /* full */ } }
    if (st.shared === prev.shared && st.tabSessions === prev.tabSessions) return;
    try { sessionStorage.setItem(SESSIONS_KEY, JSON.stringify({ shared: st.shared, tabSessions: st.tabSessions })); } catch { /* full */ }
    // Every session this window uses stays connected until it is closed here (no idle disconnect under an open tab).
    const pins = [...new Set([...Object.values(st.shared), ...Object.values(st.tabSessions)])].sort();
    setDbPins('postgres', pins);
  });
}

// ── sessions ────────────────────────────────────────────────────────────────

export type SessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** Resolves when the session is connected (ok) or failed / closed (the error text). */
export function waitSession(sessionId: string, connectionId?: string): Promise<SessionResult> {
  const now = useDbStore.getState().sessions[sessionId] ?? ended.get(sessionId);
  const done = (s: DbSessionState | undefined): SessionResult => (s?.state === 'connected' ? { ok: true, sessionId }
    : { ok: false, error: s?.error ? dbErrorMessage(s.error, s.message, connectionId) : tr('Połączenie zostało zamknięte') });
  if (now && now.state !== 'connecting') return Promise.resolve(done(now));
  if (!now && !Object.values(useDbStore.getState().shared).includes(sessionId) && !Object.values(useDbStore.getState().tabSessions).includes(sessionId)) {
    return Promise.resolve(done(undefined));
  }
  return new Promise((resolve) => waiters.set(sessionId, [...(waiters.get(sessionId) ?? []), (s) => resolve(done(s))]));
}

const connecting = new Map<string, Promise<SessionResult>>();
/** The session for the tree and table tabs of a connection and database: the live one, or a new one (prompts may appear). */
export function ensureShared(connectionId: string, database?: string): Promise<SessionResult> {
  const connection = getS().dbConnections?.find((c) => c.id === connectionId);
  if (!connection) return Promise.resolve({ ok: false, error: dbErrorMessage('connectionMissing') });
  const db = sharedDatabase(connection, database);
  const key = sharedKey(connectionId, db);
  const st = useDbStore.getState();
  const id = st.shared[key];
  if (id && isLive(st.sessions[id])) return waitSession(id, connectionId);
  const running = connecting.get(key);
  if (running) return running;
  const p = (async (): Promise<SessionResult> => {
    // Redis: one session per DB of the tree (`database` names it), each SELECTs its DB itself (runLoad).
    const r = await window.mc.db.connect(connectionId, connection.kind !== 'postgres' || db === dbDefaultDatabase(connection) ? undefined : { database: db });
    if (!r.ok) return { ok: false, error: dbErrorMessage(r.error, undefined, connectionId) };
    useDbStore.setState((s) => ({ shared: { ...s.shared, [key]: r.sessionId } }));
    return waitSession(r.sessionId, connectionId);
  })().finally(() => connecting.delete(key));
  connecting.set(key, p);
  return p;
}

/** The live shared session of a connection and database, if any. */
export function sharedSession(connectionId: string, database: string): string | null {
  const st = useDbStore.getState();
  const connection = getS().dbConnections?.find((c) => c.id === connectionId);
  const id = st.shared[sharedKey(connectionId, connection ? sharedDatabase(connection, database) : database)];
  return id && isLive(st.sessions[id]) ? id : null;
}

/** A new own session for an editor tab (its own transaction). */
export async function connectTab(tabId: string, connectionId: string, database: string): Promise<SessionResult> {
  const connection = getS().dbConnections?.find((c) => c.id === connectionId);
  if (!connection) return { ok: false, error: dbErrorMessage('connectionMissing') };
  const st = useDbStore.getState();
  const own = st.tabSessions[tabId];
  if (own && isLive(st.sessions[own])) return waitSession(own, connectionId);
  const r = await window.mc.db.connect(connectionId, database === dbDefaultDatabase(connection) ? undefined : { database });
  if (!r.ok) return { ok: false, error: dbErrorMessage(r.error, undefined, connectionId) };
  useDbStore.setState((s) => ({ tabSessions: { ...s.tabSessions, [tabId]: r.sessionId } }));
  return waitSession(r.sessionId, connectionId);
}

export function releaseTab(tabId: string): void {
  const id = useDbStore.getState().tabSessions[tabId];
  if (!id) return;
  useDbStore.setState((s) => { const tabSessions = { ...s.tabSessions }; delete tabSessions[tabId]; return { tabSessions }; });
  void window.mc.db.disconnect(id);
}

/** Ends every session of a connection (tree, tabs) and forgets its tree loads. */
export function disconnectConnection(connectionId: string): void {
  const st = useDbStore.getState();
  for (const s of Object.values(st.sessions)) if (s.connectionId === connectionId) void window.mc.db.disconnect(s.id);
}

/** The sessions of a connection that are connecting or connected (the panel's state dot). */
/** The state of a connection from all its sessions (tree, table and SQL tabs; never a "Testuj połączenie" one). */
export function connectionState(st: Pick<DbStore, 'sessions'>, connectionId: string): 'connected' | 'connecting' | 'closed' {
  const own = Object.values(st.sessions).filter((s) => s.connectionId === connectionId && !s.test);
  if (own.some((s) => s.state === 'connected')) return 'connected';
  if (own.some((s) => s.state === 'connecting')) return 'connecting';
  return 'closed';
}

/** Live sessions of a connection (not test ones). */
export const liveSessionsOf = (connectionId: string): number =>
  Object.values(useDbStore.getState().sessions).filter((s) => s.connectionId === connectionId && !s.test && isLive(s)).length;

// ── tree loads ──────────────────────────────────────────────────────────────

const setLoad = (key: string, load: DbLoad | null) => useDbStore.setState((st) => {
  const loads = { ...st.loads };
  if (load) loads[key] = load; else delete loads[key];
  return { loads };
});

/**
 * Loads one list of the tree through the shared session of its database. While a long query or a page runs on that session
 * the host answers `busy`: the load waits and tries again (for about a minute), then says so.
 */
/** Keys per page of a Redis DB in the tree (the key browser of a tab loads the same). */
const REDIS_TREE_PAGE = 500;

/** The keys of a Redis DB in the tree: the first page, or with `more` the next one added to those loaded. */
async function loadRedisKeys(req: Extract<DbLoadRequest, { kind: 'redisKeys' }>, sid: string, more: boolean): Promise<DbResult<RedisKeysLoad>> {
  const before = useDbStore.getState().loads[req.key];
  const loaded = more && before?.status === 'ready' ? before.value as RedisKeysLoad : { keys: [], cursor: '0' };
  const selected = await window.mc.db.redis.select(sid, req.db);
  if (!selected.ok) return selected;
  const r = await window.mc.db.redis.scan(sid, { cursor: loaded.cursor, limit: REDIS_TREE_PAGE, count: 250 });
  return r.ok ? { ok: true, value: { keys: mergeKeys(loaded.keys, r.value.keys), cursor: r.value.cursor } } : r;
}

export async function runLoad(req: DbLoadRequest, attempt = 0, more = false): Promise<void> {
  if (attempt === 0 && !more && useDbStore.getState().loads[req.key]?.status === 'loading') return;
  if (!more) setLoad(req.key, { status: 'loading' });
  const session = await ensureShared(req.connectionId, req.kind === 'databases' || req.kind === 'redisDbs' ? undefined : req.kind === 'redisKeys' ? `db${req.db}` : req.database);
  if (!session.ok) { setLoad(req.key, { status: 'error', message: session.error }); return; }
  const sid = session.sessionId;
  const pg = window.mc.db.pg;
  const r = req.kind === 'redisDbs' ? await window.mc.db.redis.databases(sid)
    : req.kind === 'redisKeys' ? await loadRedisKeys(req, sid, more)
    : req.kind === 'databases' ? await pg.databases(sid)
    : req.kind === 'schemas' ? await pg.schemas(sid)
      : req.kind === 'objects' ? await pg.objects(sid, req.schema)
        : await pg.tableInfo(sid, req.schema, req.name);
  if (!r.ok && r.error === 'busy' && attempt < 60) { setTimeout(() => void runLoad(req, attempt + 1, more), 1000); return; }
  setLoad(req.key, r.ok ? { status: 'ready', value: r.value } : { status: 'error', message: resultError(r, req.connectionId) });
}

/** Loads the next page of keys of a Redis DB in the tree ("Załaduj więcej"). */
export const loadMoreRedisKeys = (connectionId: string, db: number): Promise<void> =>
  runLoad({ kind: 'redisKeys', key: loadKey.redisKeys(connectionId, db), connectionId, db }, 0, true);

/** Drops loaded lists (all of a connection, or those whose key starts with a prefix) so they load again. */
export function refreshLoads(match: (key: string[]) => boolean): void {
  useDbStore.setState((st) => ({ loads: Object.fromEntries(Object.entries(st.loads).filter(([key]) => !match(JSON.parse(key) as string[]))) }));
}

/** Opens a connection in the panel's tree (connects when needed); resolves to the error text, or null. */
export async function revealConnection(connectionId: string): Promise<string | null> {
  const key = JSON.stringify(['c', connectionId]);
  useDbStore.setState((st) => (st.open.includes(key) ? st : { open: [...st.open, key] }));
  const r = await ensureShared(connectionId);
  return r.ok ? null : r.error;
}
