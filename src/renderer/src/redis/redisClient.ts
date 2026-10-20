// The renderer side of the Redis views (1.0.0): the sessions of Redis tabs, their login prompts, Pub/Sub messages from the DB
// port, the tabs in the top strip (FileDocument with `redis`), pins, and the texts of failed calls. Kept apart from the Postgres
// client so both can grow.
//
// Sessions: the key browser, the server view and Pub/Sub of one connection and DB share one session (one login, one password
// prompt; the DB Host gives Pub/Sub its own subscriber connection). The console has its own session, because SELECT in the
// console moves its session to another DB.
import { create } from 'zustand';
import { setDbPins } from '../db/pins';
import { dbErrorText, type DbConnection, type DbErrorCode, type DbPortMessage, type DbPrompt, type DbResult, type DbSessionState } from '../../../shared/db';
import type { RedisData, RedisPubSubMessage, RedisPubSubState } from '../../../shared/dbRedis';
import { appendMessages, capMessages, redisTabId, type RedisPubSubRow, type RedisTabRef, type RedisTabView } from '../../../shared/redisView';
import { activateFile, useFileStore, type FileDocument } from '../files';
import { tr } from '../i18n';
import { getS, setUi } from '../store';
import { useSshStore } from '../sshStore';
import { dropRedisDrafts } from './redisDrafts';
import { sshContext } from '../ssh';

/** Pub/Sub of one session: the subscriber's state and the received messages (kept while the tab is hidden). */
export interface RedisPubSubTab {
  state: RedisPubSubState | null;
  messages: RedisPubSubRow[];
  nextSeq: number;
  /** Lost messages: dropped by the DB Host (its buffer was full) plus those the renderer's caps pushed out of the list or held buffer. */
  dropped: number;
  paused: boolean;
  /** Arrived while paused; shown on resume (capped like the list). */
  held: RedisPubSubMessage[];
}

/** Why a tab has no session: an error (with its text), or the user disconnected it ("Rozłączono"). */
export interface RedisTabProblem { text: string; closed: boolean }

export interface RedisStore {
  /** Redis sessions by id (live ones; an ended one is removed and kept in `ended`). */
  sessions: Record<string, DbSessionState>;
  prompts: Record<string, DbPrompt>;
  /** Tab id -> its session id (tabs of one connection and DB may share one). */
  tabSessions: Record<string, string>;
  /** Tab id -> why it has no session (shown with "connect again"). */
  tabErrors: Record<string, RedisTabProblem>;
  pubsub: Record<string, RedisPubSubTab>;
}

export const useRedisStore = create<RedisStore>(() => ({ sessions: {}, prompts: {}, tabSessions: {}, tabErrors: {}, pubsub: {} }));

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
    case 'keys': return tr('Przeglądarka kluczy');
    case 'console': return tr('Konsola');
    case 'pubsub': return tr('Pub/Sub');
    case 'info': return tr('Serwer');
  }
}

/** Where a destructive action runs, for its confirmation: "local redis · DB 3". */
export function whereText(tabId: string): string {
  const ref = refOf(tabId);
  const c = ref ? connectionOf(ref.connectionId) : undefined;
  return ref && c ? `${c.name} · DB ${ref.db}` : '';
}

/** What the "all tabs" menu and the tooltip show: "local redis · Konsola · DB 0". */
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

/** A key the "Bazy danych" tree asked a key browser tab to show (taken by the browser when it is on screen). */
export const useKeyFocus = create<Record<string, RedisData>>(() => ({}));
export function focusRedisKey(tabId: string, key: RedisData): void { useKeyFocus.setState({ [tabId]: key }); }
export function takeKeyFocus(tabId: string): void {
  useKeyFocus.setState((st) => { const next = { ...st }; delete next[tabId]; return next; }, true);
}

/** The tab now shows another DB (SELECT in the console). */
export function setTabDb(tabId: string, db: number): void {
  const doc = docOf(tabId);
  const c = doc?.redis ? connectionOf(doc.redis.connectionId) : undefined;
  if (!doc?.redis || !c || doc.redis.db === db) return;
  const redis = { ...doc.redis, db };
  useFileStore.setState((s) => ({ documents: s.documents.map((d) => (d.id === tabId ? { ...d, redis, relativePath: tabPath(c, redis.view, db) } : d)) }));
}

/**
 * The key browser moves to another DB: it leaves the session of the old DB (shared ones stay with their other tabs) and the next
 * operation takes the session of the new DB (shared, or a new login).
 */
export function moveTabToDb(tabId: string, db: number): void {
  setTabDb(tabId, db);
  releaseTab(tabId);
}

// ── per-tab state of the view modules ───────────────────────────────────────

const forgetters = new Set<(tabId: string) => void>();
/** A view module registers how to drop what it keeps for a tab (called when the tab closes). */
export function onForgetTab(fn: (tabId: string) => void): void { forgetters.add(fn); }

// ── sessions ────────────────────────────────────────────────────────────────

/** The last state of sessions that ended (a wait that starts late still learns why). */
const ended = new Map<string, DbSessionState>();
const waiters = new Map<string, Array<(s: DbSessionState) => void>>();
/** Sessions this window ended on purpose (tab closed, "Rozłącz" from here): not reported as failures. */
const userClosed = new Set<string>();

const tabsOf = (st: Pick<RedisStore, 'tabSessions'>, sessionId: string): string[] => Object.entries(st.tabSessions).filter(([, sid]) => sid === sessionId).map(([tab]) => tab);

function onSession(s: DbSessionState): void {
  if (s.kind !== 'redis' || s.test) return;
  if (!isLive(s)) { ended.set(s.id, s); if (ended.size > 200) ended.delete(ended.keys().next().value!); }
  useRedisStore.setState((st) => {
    const sessions = { ...st.sessions };
    const prompts = { ...st.prompts };
    if (isLive(s)) { sessions[s.id] = s; return { sessions, prompts }; }
    delete sessions[s.id]; delete prompts[s.id];
    // The session of open tabs ended: dropped for good, login cancelled or refused (an error), or disconnected without an error
    // ("Rozłączono": the connections panel's "Rozłącz"). The tabs say so and offer to connect again.
    const tabs = tabsOf(st, s.id);
    if (!tabs.length) return { sessions, prompts };
    const tabSessions = { ...st.tabSessions };
    const tabErrors = { ...st.tabErrors };
    const closed = !s.error || userClosed.has(s.id);
    const problem: RedisTabProblem = closed ? { text: tr('Rozłączono'), closed: true } : { text: redisErrorText(s.error!, s.connectionId, s.message), closed: false };
    for (const tab of tabs) { delete tabSessions[tab]; tabErrors[tab] = problem; }
    const pubsub = { ...st.pubsub };
    delete pubsub[s.id];
    return { sessions, prompts, tabSessions, tabErrors, pubsub };
  });
  if (s.state !== 'connecting') { const list = waiters.get(s.id); waiters.delete(s.id); list?.forEach((fn) => fn(s)); }
  // SELECT in the console moves the console's session to another DB: its tab follows.
  if (s.state === 'connected' && s.database !== undefined && /^\d+$/.test(s.database)) {
    for (const tab of tabsOf(useRedisStore.getState(), s.id)) if (refOf(tab)?.view === 'console') setTabDb(tab, Number(s.database));
  }
}

function waitSession(sessionId: string): Promise<DbSessionState> {
  const now = useRedisStore.getState().sessions[sessionId] ?? ended.get(sessionId);
  if (now && now.state !== 'connecting') return Promise.resolve(now);
  return new Promise((resolve) => waiters.set(sessionId, [...(waiters.get(sessionId) ?? []), resolve]));
}

/** The session another open tab of the same connection and DB uses (not for the console). */
function sharedSession(tabId: string, ref: RedisTabRef): string | null {
  if (ref.view === 'console') return null;
  const st = useRedisStore.getState();
  for (const [tab, sid] of Object.entries(st.tabSessions)) {
    const other = refOf(tab);
    if (tab !== tabId && other && other.view !== 'console' && other.connectionId === ref.connectionId && other.db === ref.db && isLive(st.sessions[sid])) return sid;
  }
  return null;
}

const connecting = new Map<string, Promise<SessionResult>>();
export type SessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** The tab's connected session: its own, one shared with another tab of the same connection and DB, or a new login. */
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
    // A session that is still connecting (a reconnect after a drop) is waited for; a shared one is joined; else a new login.
    let sessionId = sid && live ? sid : sharedSession(tabId, ref);
    if (!sessionId) {
      const r = await window.mc.db.connect(c.id).catch(() => ({ ok: false as const, error: 'dbFailed' as DbErrorCode }));
      if (!r.ok) return fail(tabId, redisErrorText(r.error, c.id));
      sessionId = r.sessionId;
    }
    useRedisStore.setState((st) => ({ tabSessions: { ...st.tabSessions, [tabId]: sessionId! } }));
    const state = await waitSession(sessionId);
    if (state.state !== 'connected') return { ok: false, error: useRedisStore.getState().tabErrors[tabId]?.text ?? redisErrorText(state.error ?? 'dbClosed', c.id, state.message) };
    if (docOf(tabId) === undefined) { releaseTab(tabId); return { ok: false, error: '' }; }
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

function fail(tabId: string, text: string): SessionResult {
  useRedisStore.setState((st) => ({ tabErrors: { ...st.tabErrors, [tabId]: { text, closed: false } } }));
  return { ok: false, error: text };
}

/** The tab leaves its session; a session no other tab uses is ended. */
function releaseTab(tabId: string): void {
  const st = useRedisStore.getState();
  const sid = st.tabSessions[tabId];
  if (!sid) return;
  const others = tabsOf(st, sid).filter((t) => t !== tabId && docOf(t));
  useRedisStore.setState((cur) => {
    const tabSessions = { ...cur.tabSessions };
    delete tabSessions[tabId];
    if (others.length) return { tabSessions };
    const pubsub = { ...cur.pubsub };
    delete pubsub[sid];
    return { tabSessions, pubsub };
  });
  if (!others.length) { userClosed.add(sid); void window.mc.db.disconnect(sid).catch(() => undefined); }
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

/** Logs in again after the session ended (the "connect again" button). */
export function reconnectTab(tabId: string): void {
  useRedisStore.setState((st) => { const tabErrors = { ...st.tabErrors }; delete tabErrors[tabId]; return { tabErrors }; });
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
    // Messages of a session no open tab owns (late batches after a close) are not kept.
    if (!Object.values(st.tabSessions).includes(sessionId)) return {};
    const current = st.pubsub[sessionId] ?? emptyPubSub();
    return { pubsub: { ...st.pubsub, [sessionId]: { ...current, ...fn(current) } } };
  });
}

function onPort(msg: DbPortMessage): void {
  if (msg.t === 'redisPubSub') {
    updatePubSub(msg.sessionId, (p) => {
      if (p.paused) {
        const held = capMessages([...p.held, ...msg.messages]);
        return { held: held.kept, dropped: p.dropped + msg.dropped + held.dropped };
      }
      const next = appendMessages(p.messages, msg.messages, p.nextSeq);
      return { messages: next.list, nextSeq: next.nextSeq, dropped: p.dropped + msg.dropped };
    });
  } else if (msg.t === 'redisPubSubState') updatePubSub(msg.sessionId, () => ({ state: msg.state }));
}

export function setPaused(sessionId: string, paused: boolean): void {
  updatePubSub(sessionId, (p) => {
    if (paused || !p.held.length) return { paused };
    const next = appendMessages(p.messages, p.held, p.nextSeq);
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
  // A tab that closed leaves its session (ended when no other tab uses it) and its views forget what they kept for it; the pins
  // follow the open tabs (no idle disconnect under an open tab).
  let openTabs = new Set(useFileStore.getState().documents.filter((d) => d.redis).map((d) => d.id));
  useFileStore.subscribe((s, prev) => {
    if (s.documents === prev.documents) return;
    const now = new Set(s.documents.filter((d) => d.redis).map((d) => d.id));
    const closed = [...openTabs].filter((tab) => !now.has(tab));
    openTabs = now;
    if (!closed.length) return;
    for (const tab of closed) {
      releaseTab(tab);
      dropRedisDrafts(tab);
      for (const forget of forgetters) forget(tab);
    }
    useRedisStore.setState((cur) => {
      const tabErrors = { ...cur.tabErrors };
      for (const tab of closed) delete tabErrors[tab];
      return { tabErrors };
    });
  });
  useRedisStore.subscribe((st, prev) => { if (st.tabSessions !== prev.tabSessions) setDbPins('redis', Object.values(st.tabSessions)); });
}
