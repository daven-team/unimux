// The renderer side of the Redis views (1.0.0): the sessions of Redis tabs (one per tab: browsing, the console, Pub/Sub and the
// server views never wait for each other), their login prompts, Pub/Sub messages from the DB port, the tabs in the top strip
// (FileDocument with `redis`), pins, and the texts of failed calls. Kept apart from the Postgres client so both can grow.
import { create } from 'zustand';
import { dbErrorText, type DbConnection, type DbErrorCode, type DbPortMessage, type DbPrompt, type DbResult, type DbSessionState } from '../../../shared/db';
import type { RedisPubSubMessage, RedisPubSubState } from '../../../shared/dbRedis';
import { appendMessages, redisTabId, type RedisPubSubRow, type RedisTabRef, type RedisTabView } from '../../../shared/redisView';
import { activateFile, useFileStore, type FileDocument } from '../files';
import { tr } from '../i18n';
import { getS, setUi } from '../store';
import { useSshStore } from '../sshStore';
import { sshContext } from '../ssh';

/** Pub/Sub of one session: the subscriber's state and the received messages (kept while the tab is hidden). */
export interface RedisPubSubTab {
  state: RedisPubSubState | null;
  messages: RedisPubSubRow[];
  nextSeq: number;
  /** Dropped by the DB Host since the tab started listening (the buffer was full). */
  dropped: number;
  paused: boolean;
  /** Arrived while paused; shown on resume (capped like the list). */
  held: RedisPubSubMessage[];
}

export interface RedisStore {
  /** Redis sessions by id (live ones; an ended one is removed and kept in `ended`). */
  sessions: Record<string, DbSessionState>;
  prompts: Record<string, DbPrompt>;
  /** Tab id -> its session id. */
  tabSessions: Record<string, string>;
  /** Tab id -> why its session could not connect (shown with "connect again"). */
  tabErrors: Record<string, string>;
  pubsub: Record<string, RedisPubSubTab>;
}

export const useRedisStore = create<RedisStore>(() => ({ sessions: {}, prompts: {}, tabSessions: {}, tabErrors: {}, pubsub: {} }));

const MESSAGE_CAP = 5000;
const isLive = (s: DbSessionState | undefined): boolean => !!s && (s.state === 'connected' || s.state === 'connecting');

// ── texts of failures ───────────────────────────────────────────────────────

/** The translated text of an error code (SSH codes of a tunnel read like an SSH cell's). */
export function redisErrorText(error: DbErrorCode | string, connectionId?: string, serverMessage?: string): string {
  const connection = connectionId ? connectionOf(connectionId) : undefined;
  const t = dbErrorText(error as DbErrorCode, sshContext(connection?.ssh?.hostId));
  const base = tr(t.key, t.params);
  return serverMessage && serverMessage !== base ? `${base}: ${serverMessage}` : base;
}

/** The text of a failed call (with the server's words when it sent some). */
export const resultText = (r: Extract<DbResult<unknown>, { ok: false }>, connectionId?: string): string =>
  redisErrorText(r.error, connectionId, r.server?.message);

/** A call that failed in transport (the IPC itself threw) reads as a generic failure. */
export async function call<T>(run: () => Promise<DbResult<T>>): Promise<DbResult<T>> {
  try { return await run(); } catch { return { ok: false, error: 'dbFailed' }; }
}

// ── connections and tabs ────────────────────────────────────────────────────

export const connectionOf = (id: string): DbConnection | undefined => getS().dbConnections?.find((c) => c.id === id);
export const redisConnections = (): DbConnection[] => (getS().dbConnections ?? []).filter((c) => c.kind === 'redis');
export const docOf = (tabId: string): FileDocument | undefined => useFileStore.getState().documents.find((d) => d.id === tabId);
export const refOf = (tabId: string): RedisTabRef | undefined => docOf(tabId)?.redis;

export function viewLabel(view: RedisTabView): string {
  switch (view) {
    case 'keys': return tr('Klucze');
    case 'console': return tr('Konsola');
    case 'pubsub': return tr('Pub/Sub');
    case 'info': return tr('Serwer');
  }
}

/** What the "all tabs" menu and the tooltip show: "local redis · Klucze · DB 0". */
const tabPath = (c: DbConnection, view: RedisTabView, db: number): string => `${c.name} · ${viewLabel(view)} · DB ${db}`;

/**
 * Opens a Redis view of a saved connection in a tab of the top strip. The key browser opens one tab per DB (the same DB again
 * focuses it); the console, Pub/Sub and server views open once per connection. Returns the tab id (null: no such connection).
 */
export function openRedisTab(connectionId: string, view: RedisTabView, db?: number): string | null {
  const c = connectionOf(connectionId);
  if (!c || c.kind !== 'redis') return null;
  const index = db ?? c.dbIndex ?? 0;
  const existing = useFileStore.getState().documents.find((d) => d.redis && d.redis.connectionId === connectionId && d.redis.view === view && (view !== 'keys' || d.redis.db === index));
  setUi({ settingsActive: false });
  useSshStore.setState({ viewActive: false });
  if (existing) { activateFile(existing.id); return existing.id; }
  const ref: RedisTabRef = { kind: 'redis', view, connectionId, db: index, uid: crypto.randomUUID() };
  const id = redisTabId(ref);
  const doc: FileDocument = {
    id, projectId: '', relativePath: tabPath(c, view, index), name: c.name, text: '', savedText: '', diskText: '', status: 'ready', saving: false, error: null, wrap: false, redis: ref,
  };
  useFileStore.setState((s) => ({ documents: [...s.documents, doc], activeFileId: id }));
  return id;
}

/** The tab now shows another DB (the key browser's switcher, or SELECT in the console). */
export function setTabDb(tabId: string, db: number): void {
  const doc = docOf(tabId);
  const c = doc?.redis ? connectionOf(doc.redis.connectionId) : undefined;
  if (!doc?.redis || !c || doc.redis.db === db) return;
  const redis = { ...doc.redis, db };
  useFileStore.setState((s) => ({ documents: s.documents.map((d) => (d.id === tabId ? { ...d, redis, relativePath: tabPath(c, redis.view, db) } : d)) }));
}

// ── sessions ────────────────────────────────────────────────────────────────

/** The last state of sessions that ended (a wait that starts late still learns why). */
const ended = new Map<string, DbSessionState>();
const waiters = new Map<string, Array<(s: DbSessionState) => void>>();

function onSession(s: DbSessionState): void {
  if (s.kind !== 'redis' || s.test) return;
  if (!isLive(s)) { ended.set(s.id, s); if (ended.size > 200) ended.delete(ended.keys().next().value!); }
  useRedisStore.setState((st) => {
    const sessions = { ...st.sessions };
    const prompts = { ...st.prompts };
    if (isLive(s)) { sessions[s.id] = s; return { sessions, prompts }; }
    delete sessions[s.id]; delete prompts[s.id];
    // The session of an open tab ended (dropped for good, login cancelled or refused): the tab says why and offers to connect again.
    const tab = Object.entries(st.tabSessions).find(([, sid]) => sid === s.id)?.[0];
    if (!tab) return { sessions, prompts };
    const tabSessions = { ...st.tabSessions };
    delete tabSessions[tab];
    return { sessions, prompts, tabSessions, tabErrors: { ...st.tabErrors, [tab]: redisErrorText(s.error ?? 'dbClosed', s.connectionId, s.message) } };
  });
  if (s.state !== 'connecting') { const list = waiters.get(s.id); waiters.delete(s.id); list?.forEach((fn) => fn(s)); }
  // SELECT in the console moves the session to another DB: its tab follows.
  if (s.state === 'connected' && s.database !== undefined) {
    const tab = Object.entries(useRedisStore.getState().tabSessions).find(([, sid]) => sid === s.id)?.[0];
    const ref = tab ? refOf(tab) : undefined;
    if (tab && ref && ref.view !== 'keys' && /^\d+$/.test(s.database)) setTabDb(tab, Number(s.database));
  }
}

function waitSession(sessionId: string): Promise<DbSessionState> {
  const now = useRedisStore.getState().sessions[sessionId] ?? ended.get(sessionId);
  if (now && now.state !== 'connecting') return Promise.resolve(now);
  return new Promise((resolve) => waiters.set(sessionId, [...(waiters.get(sessionId) ?? []), resolve]));
}

const connecting = new Map<string, Promise<SessionResult>>();
export type SessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** The tab's connected session: an existing one, or a new login (its prompts show in the tab). */
export function ensureTabSession(tabId: string): Promise<SessionResult> {
  const sid = useRedisStore.getState().tabSessions[tabId];
  const live = sid ? useRedisStore.getState().sessions[sid] : undefined;
  if (sid && live?.state === 'connected') return Promise.resolve({ ok: true, sessionId: sid });
  const pending = connecting.get(tabId);
  if (pending) return pending;
  const run = (async (): Promise<SessionResult> => {
    const ref = refOf(tabId);
    const c = ref ? connectionOf(ref.connectionId) : undefined;
    if (!ref || !c) return { ok: false, error: redisErrorText('connectionMissing') };
    useRedisStore.setState((st) => { const tabErrors = { ...st.tabErrors }; delete tabErrors[tabId]; return { tabErrors }; });
    // A session that is still connecting (a reconnect after a drop) is waited for; anything else starts a new login.
    let sessionId = sid && live ? sid : null;
    if (!sessionId) {
      const r = await window.mc.db.connect(c.id).catch(() => ({ ok: false as const, error: 'dbFailed' as DbErrorCode }));
      if (!r.ok) return fail(tabId, redisErrorText(r.error, c.id));
      sessionId = r.sessionId;
      useRedisStore.setState((st) => ({ tabSessions: { ...st.tabSessions, [tabId]: sessionId! } }));
    }
    const state = await waitSession(sessionId);
    if (state.state !== 'connected') return fail(tabId, redisErrorText(state.error ?? 'dbClosed', c.id, state.message));
    if (docOf(tabId) === undefined) {
      // The tab closed during the login.
      void window.mc.db.disconnect(sessionId).catch(() => undefined);
      useRedisStore.setState((st) => { const tabSessions = { ...st.tabSessions }; delete tabSessions[tabId]; return { tabSessions }; });
      return { ok: false, error: '' };
    }
    const want = refOf(tabId)?.db ?? 0;
    if (String(want) !== state.database) {
      const sel = await call(() => window.mc.db.redis.select(sessionId!, want));
      if (!sel.ok) return fail(tabId, resultText(sel, c.id));
    }
    return { ok: true, sessionId };
  })().finally(() => connecting.delete(tabId));
  connecting.set(tabId, run);
  return run;
}

function fail(tabId: string, error: string): SessionResult {
  useRedisStore.setState((st) => ({ tabErrors: { ...st.tabErrors, [tabId]: error } }));
  return { ok: false, error };
}

/**
 * Runs one operation on the tab's session (connecting first when needed). A transport failure or a missing session reads as
 * a failed result, so callers handle every outcome in one place.
 */
export async function withTab<T>(tabId: string, run: (sessionId: string) => Promise<DbResult<T>>): Promise<DbResult<T>> {
  const s = await ensureTabSession(tabId);
  if (!s.ok) return { ok: false, error: 'notConnected' };
  return call(() => run(s.sessionId));
}

/** Ends the tab's session and logs in again (the "connect again" button). */
export function reconnectTab(tabId: string): void {
  const sid = useRedisStore.getState().tabSessions[tabId];
  if (sid) void window.mc.db.disconnect(sid).catch(() => undefined);
  useRedisStore.setState((st) => { const tabSessions = { ...st.tabSessions }; delete tabSessions[tabId]; return { tabSessions }; });
  void ensureTabSession(tabId);
}

/** The session state of a tab (undefined: none yet or it ended). */
export const tabSessionState = (st: RedisStore, tabId: string): DbSessionState | undefined => {
  const sid = st.tabSessions[tabId];
  return sid ? st.sessions[sid] : undefined;
};

// ── Pub/Sub messages from the DB port ───────────────────────────────────────

const emptyPubSub = (): RedisPubSubTab => ({ state: null, messages: [], nextSeq: 0, dropped: 0, paused: false, held: [] });
export const pubsubOf = (st: RedisStore, sessionId: string | undefined): RedisPubSubTab | undefined => (sessionId ? st.pubsub[sessionId] : undefined);

export function updatePubSub(sessionId: string, fn: (p: RedisPubSubTab) => Partial<RedisPubSubTab>): void {
  useRedisStore.setState((st) => {
    const current = st.pubsub[sessionId] ?? emptyPubSub();
    return { pubsub: { ...st.pubsub, [sessionId]: { ...current, ...fn(current) } } };
  });
}

function onPort(msg: DbPortMessage): void {
  if (msg.t === 'redisPubSub') {
    updatePubSub(msg.sessionId, (p) => {
      if (p.paused) return { held: [...p.held, ...msg.messages].slice(-MESSAGE_CAP), dropped: p.dropped + msg.dropped };
      const next = appendMessages(p.messages, msg.messages, p.nextSeq, MESSAGE_CAP);
      return { messages: next.list, nextSeq: next.nextSeq, dropped: p.dropped + msg.dropped };
    });
  } else if (msg.t === 'redisPubSubState') updatePubSub(msg.sessionId, () => ({ state: msg.state }));
}

export function setPaused(sessionId: string, paused: boolean): void {
  updatePubSub(sessionId, (p) => {
    if (paused || !p.held.length) return { paused };
    const next = appendMessages(p.messages, p.held, p.nextSeq, MESSAGE_CAP);
    return { paused, held: [], messages: next.list, nextSeq: next.nextSeq };
  });
}

// The port arrives when the DB Host starts and again after a reload: listen from the start. Another listener (the Postgres
// views) may use the same port; both receive every message.
let port: MessagePort | null = null;
const portHandler = (e: MessageEvent<DbPortMessage>) => { const m = e.data; if (m && typeof m === 'object' && 'sessionId' in m) onPort(m); };
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data !== 'mc:db-port' || !e.ports[0]) return;
    port?.removeEventListener('message', portHandler as EventListener);
    port = e.ports[0];
    port.addEventListener('message', portHandler as EventListener);
    port.start();
  });
}

// ── boot ────────────────────────────────────────────────────────────────────

let booted = false;
export function initRedis(): void {
  if (booted) return;
  booted = true;
  window.mc.on('db:session', onSession);
  window.mc.on('db:prompt', (sessionId, prompt) => useRedisStore.setState((st) => {
    const prompts = { ...st.prompts };
    if (prompt) prompts[sessionId] = prompt; else delete prompts[sessionId];
    return { prompts };
  }));
  // A tab that closed ends its session; the pins follow the open tabs (no idle disconnect under an open tab).
  useFileStore.subscribe((s, prev) => {
    if (s.documents === prev.documents) return;
    const open = new Set(s.documents.filter((d) => d.redis).map((d) => d.id));
    const st = useRedisStore.getState();
    const gone = Object.keys(st.tabSessions).filter((tab) => !open.has(tab));
    const errs = Object.keys(st.tabErrors).filter((tab) => !open.has(tab));
    if (!gone.length && !errs.length) return;
    for (const tab of gone) void window.mc.db.disconnect(st.tabSessions[tab]).catch(() => undefined);
    useRedisStore.setState((cur) => {
      const tabSessions = { ...cur.tabSessions };
      const tabErrors = { ...cur.tabErrors };
      const pubsub = { ...cur.pubsub };
      for (const tab of gone) { delete pubsub[tabSessions[tab]]; delete tabSessions[tab]; }
      for (const tab of errs) delete tabErrors[tab];
      return { tabSessions, tabErrors, pubsub };
    });
  });
  let lastPins = '';
  useRedisStore.subscribe((st, prev) => {
    if (st.tabSessions === prev.tabSessions) return;
    const pins = [...new Set(Object.values(st.tabSessions))].sort();
    if (pins.join() !== lastPins) { lastPins = pins.join(); window.mc.db.pin(pins); }
  });
}
