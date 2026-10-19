// SFTP sessions of remote editor tabs (0.9.9). A remote tab names a saved host and a path, never a session: every read, check
// and save uses a connected session of that host (the SFTP view's one when it shows that host, else one opened for the editor).
// When none is connected, a read or save the user asked for logs in with the saved host data (its login prompts appear inside the
// tab) and runs again; a background check never connects. No imports of files.ts (it imports this module).
import { create } from 'zustand';
import { sftpErrorText, type SftpErrorCode, type SftpResult, type SftpSessionState } from '../../shared/sftp';
import { hostEndpoint, sshErrorText, type SshPrompt } from '../../shared/ssh';
import { tr } from './i18n';
import { getS } from './store';
import { useSftpStore } from './sftpStore';

interface RemoteSessionStore {
  /** Every SFTP session main reported (the view's and the editor's), by session id. */
  sessions: Record<string, SftpSessionState>;
  prompts: Record<string, SshPrompt | null>;
  /** The session a login for an editor tab waits on, by host id (shown as "connecting" with its prompt in the tab). */
  connecting: Record<string, string>;
}

export const useRemoteSessions = create<RemoteSessionStore>(() => ({ sessions: {}, prompts: {}, connecting: {} }));

let started = false;
/** Follows session events from the start (boot), so the view's session is known when a file is opened from it. */
export function initRemoteSessions(): void {
  if (started) return;
  started = true;
  window.mc.on('sftp:session', (state: SftpSessionState) => {
    useRemoteSessions.setState((st) => ({ sessions: { ...st.sessions, [state.id]: state } }));
  });
  window.mc.on('sftp:prompt', (sessionId: string, prompt: SshPrompt | null) => {
    useRemoteSessions.setState((st) => ({ prompts: { ...st.prompts, [sessionId]: prompt } }));
  });
  window.mc.on('sftp:hostCrashed', () => {
    useRemoteSessions.setState((st) => ({ sessions: Object.fromEntries(Object.entries(st.sessions).map(([id, s]) => [id, { ...s, state: 'closed' as const, phase: 'closed' as const }])) }));
  });
  void window.mc.sftp.sessions().then((snapshot) => {
    useRemoteSessions.setState((st) => ({
      sessions: { ...Object.fromEntries(snapshot.sessions.map((s) => [s.id, s])), ...st.sessions },
      prompts: { ...Object.fromEntries(snapshot.prompts.map((p) => [p.sessionId, p.prompt])), ...st.prompts },
    }));
  }).catch(() => undefined);
}

const connected = (s: SftpSessionState | undefined | null): boolean => s?.state === 'connected';

/**
 * A session with raised rights (a sudo session of the SFTP view) is never used for an editor tab: its saves would be written as
 * another user. Read defensively: the field belongs to the session state of the view.
 */
const elevated = (s: SftpSessionState | null | undefined): boolean => !!(s as (SftpSessionState & { sudo?: unknown; elevated?: unknown }) | null | undefined)?.sudo
  || !!(s as (SftpSessionState & { elevated?: unknown }) | null | undefined)?.elevated;

/** A connected session of `hostId` (the SFTP view's first) that runs with the SSH user's own rights, or null. */
export function liveSession(hostId: string): string | null {
  const view = useSftpStore.getState();
  if (view.sessionId && view.hostId === hostId && connected(view.session) && !elevated(view.session)) return view.sessionId;
  const found = Object.values(useRemoteSessions.getState().sessions).find((s) => s.hostId === hostId && connected(s) && !elevated(s));
  return found?.id ?? null;
}

/** A session of `hostId` that is still logging in (an editor login or the view's), or null. */
function pendingSession(hostId: string): string | null {
  const editor = useRemoteSessions.getState().connecting[hostId];
  if (editor) return editor;
  const view = useSftpStore.getState();
  // The view's login of a sudo host would end in a session with raised rights: never waited for.
  if (getS().sshHosts.some((h) => h.id === hostId && h.sftpSudo)) return null;
  return view.sessionId && view.hostId === hostId && view.session?.state === 'connecting' ? view.sessionId : null;
}

const hostLabel = (hostId: string): string => getS().sshHosts.find((h) => h.id === hostId)?.label ?? '';
/** Like ssh.ts sshContext (not imported: ssh.ts imports the editor's files module). */
function sshContext(hostId: string): { host: string; endpoint: string } {
  const host = getS().sshHosts.find((h) => h.id === hostId);
  return host ? { host: host.address, endpoint: hostEndpoint(host.address, host.port) } : { host: '', endpoint: '' };
}

/** Waits until `sessionId` is connected (true) or ended (false). */
function settle(sessionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = (): boolean | null => {
      const s = useRemoteSessions.getState().sessions[sessionId];
      const view = useSftpStore.getState();
      const state = s?.state ?? (view.sessionId === sessionId ? view.session?.state : undefined);
      if (state === 'connected') return true;
      if (state === 'error' || state === 'closed') return false;
      return null;
    };
    const now = check();
    if (now !== null) { resolve(now); return; }
    const done = (value: boolean) => { offA(); offB(); resolve(value); };
    const onChange = () => { const v = check(); if (v !== null) done(v); };
    const offA = useRemoteSessions.subscribe(onChange);
    const offB = useSftpStore.subscribe(onChange);
  });
}

export type SessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

const logins = new Map<string, Promise<SessionResult>>();

/** The reason a login failed, as text for the tab. */
function loginError(hostId: string, sessionId: string | null, fallback?: string): string {
  const s = sessionId ? useRemoteSessions.getState().sessions[sessionId] : undefined;
  const reason = s?.error ? (() => { const t = sshErrorText(s.error, sshContext(hostId)); return tr(t.key, t.params); })() : fallback ?? tr('Brak połączenia SFTP');
  return tr('Nie udało się połączyć z {host}: {error}', { host: hostLabel(hostId), error: reason });
}

/** A connected session of the saved host: an existing one, the one logging in, or a new login (prompts show in the tab). */
export function ensureSession(hostId: string): Promise<SessionResult> {
  const live = liveSession(hostId);
  if (live) return Promise.resolve({ ok: true, sessionId: live });
  const running = logins.get(hostId);
  if (running) return running;
  const login = (async (): Promise<SessionResult> => {
    if (!getS().sshHosts.some((h) => h.id === hostId)) { const t = sshErrorText('hostMissing', sshContext(hostId)); return { ok: false, error: tr(t.key, t.params) }; }
    let id = pendingSession(hostId);
    if (!id) {
      // Its own rights only: a host with "Uruchamiaj SFTP przez sudo" still gets a plain session for editor tabs.
      const r = await window.mc.sftp.connect(hostId, undefined, { plain: true }).catch(() => null);
      if (!r || !r.ok) {
        const t = r ? sshErrorText(r.error, sshContext(hostId)) : null;
        return { ok: false, error: loginError(hostId, null, t ? tr(t.key, t.params) : undefined) };
      }
      id = r.sessionId;
      // Known before the first event arrives: "connecting" until main says otherwise.
      useRemoteSessions.setState((st) => ({
        sessions: st.sessions[r.sessionId] ? st.sessions : { ...st.sessions, [r.sessionId]: { id: r.sessionId, hostId, state: 'connecting', phase: 'connecting', since: Date.now() } },
        connecting: { ...st.connecting, [hostId]: r.sessionId },
      }));
    }
    try {
      return (await settle(id)) ? { ok: true, sessionId: id } : { ok: false, error: loginError(hostId, id) };
    } finally {
      useRemoteSessions.setState((st) => { const connecting = { ...st.connecting }; if (connecting[hostId] === id) delete connecting[hostId]; return { connecting }; });
    }
  })();
  logins.set(hostId, login);
  void login.finally(() => { if (logins.get(hostId) === login) logins.delete(hostId); });
  return login;
}

/** The login prompt a tab of `hostId` shows while it connects (null: none). */
export function promptOf(st: RemoteSessionStore, hostId: string): { sessionId: string; prompt: SshPrompt } | null {
  const id = st.connecting[hostId];
  const prompt = id ? st.prompts[id] : null;
  return id && prompt ? { sessionId: id, prompt } : null;
}

/** Codes after which the session is not usable any more: a user action connects again and retries once. */
const SESSION_GONE: readonly SftpErrorCode[] = ['noSession', 'notConnected', 'connectionLost', 'sftpHostCrashed'];

export const sftpErrorMessage = (code: SftpErrorCode): string => { const t = sftpErrorText(code); return tr(t.key, t.params); };

/**
 * Runs an operation on a connected session of `hostId`. `interactive` (the user opened, reloaded or saved): connects when needed
 * and retries once after the session turned out to be gone. A background check (`interactive` false) never connects.
 */
export async function withSession<T>(hostId: string, interactive: boolean, fn: (sessionId: string) => Promise<SftpResult<T>>): Promise<SftpResult<T> | { ok: false; error: 'login'; message: string }> {
  let id = liveSession(hostId);
  if (!id) {
    if (!interactive) return { ok: false, error: 'notConnected' };
    const s = await ensureSession(hostId);
    if (!s.ok) return { ok: false, error: 'login', message: s.error };
    id = s.sessionId;
  }
  const first = await fn(id).catch((): SftpResult<T> => ({ ok: false, error: 'failed' }));
  if (first.ok || !interactive || !SESSION_GONE.includes(first.error)) return first;
  // The session ended under the tab (idle disconnect, network): forget it and log in again.
  const gone = id;
  useRemoteSessions.setState((st) => ({ sessions: { ...st.sessions, [gone]: { ...(st.sessions[gone] ?? { id: gone, hostId, phase: 'closed', since: Date.now() }), state: 'closed' } } }));
  const s = await ensureSession(hostId);
  if (!s.ok) return { ok: false, error: 'login', message: s.error };
  return fn(s.sessionId).catch((): SftpResult<T> => ({ ok: false, error: 'failed' }));
}

let lastPins = '';
/** Hosts whose sessions dirty remote tabs need (the SFTP view does not drop such a session without asking). */
export const pinnedHosts = (): Set<string> => new Set(lastPins ? lastPins.split(',') : []);
/** The hosts of remote tabs with unsaved changes: main keeps their sessions while the SFTP view is closed. */
export function pinHosts(hostIds: string[]): void {
  const key = [...new Set(hostIds)].sort().join(',');
  if (key === lastPins) return;
  lastPins = key;
  window.mc.sftp.pinHosts(key ? key.split(',') : []);
}
