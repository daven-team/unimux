// Main side of database connections and sessions (1.0.0): the saved connections (state.json, no secrets) and their passwords
// (DbVault), "Test connection", and the sessions: it starts the DB Host on first use, hands it the decrypted password and the CA
// file in the open message only, logs a tunnel in through the SSH coordinator (same vault, known hosts and prompts as a cell),
// asks the renderer for a database password when the server wants one, keeps the session state the renderer sees, and
// disconnects a session nobody pinned after it was idle for a while. Electron-free so it is unit tested.
import { randomUUID } from 'crypto';
import {
  DB_LIMITS, dbEndpoint, dbSessionId, dbStatusOf, duplicateDbConnection, isDbSessionId, isLiveDbPhase, normalizeDbConnection, removeDbConnection, upsertDbConnection,
  type DbConnection, type DbConnectionInput, type DbErrorCode, type DbPasswordChange, type DbPrompt, type DbPromptAnswer, type DbResult, type DbSessionState,
  type DbSnapshot, type DbStateLike, type DbTestResult, type DbVaultInfo,
} from '../../shared/db';
import type { DbHostOp, DbHostToMain, DbOpenConfig } from '../../shared/dbHostIpc';
import type { SshPrompt, SshPromptAnswer, SshSessionState } from '../../shared/ssh';
import type { SshCoordinator } from '../ssh/coordinator';
import type { DbHostLink } from '../dbHostClient';
import type { DbVault } from './vault';

export interface DbServiceDeps<S extends DbStateLike = DbStateLike> {
  coordinator: Pick<SshCoordinator, 'connectSession' | 'endSession' | 'answer' | 'sessionSnapshot' | 'onHostMessage' | 'sessionHostCrashed'>;
  host: DbHostLink;
  state(): S;
  /** A main-side state edit (StateController.change). */
  change(fn: (s: S) => S): void;
  sshHostExists(hostId: string): boolean;
  vault: Pick<DbVault, 'password' | 'setPassword' | 'clearPassword' | 'copyPassword' | 'readOnly' | 'info' | 'prune'>;
  /** The CA file of verify-full (null: unreadable, too big or not a file). */
  readCa(path: string): Promise<string | null>;
  events: { session(s: DbSessionState): void; prompt(sessionId: string, prompt: DbPrompt | null): void; hostCrashed(): void; vaultChanged(): void };
  now?(): number;
  idleMs?: number;
  promptTimeoutMs?: number;
  testTimeoutMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
  defer?(fn: () => void): void;
}

interface OwnPrompt { prompt: Extract<DbPrompt, { kind: 'dbPassword' }>; hostPromptId: string; timer: unknown }

interface Entry {
  state: DbSessionState;
  connection: DbConnection;
  idle: unknown;
  busy: boolean;
  closing: boolean;
  own: OwnPrompt | null;
  /** A typed password to save once the session connected ("Zapamiętaj"). */
  pendingSave?: string;
  test?: (r: DbTestResult) => void;
  /** A test was refused with the form's password: it ends as a wrong password instead of asking again. */
  testAuthFailed?: true;
  started: number;
  /** The shared SSH tunnel this session uses (key of `tunnels`). */
  tunnelKey?: string;
}

/** The SSH tunnel of a connection as main sees it: the session that logs it in and every session on it. */
interface TunnelRef { owner: string; refs: Set<string> }
const tunnelKeyOf = (c: DbConnection): string | null => (c.ssh ? `${c.id}|${c.ssh.hostId}|${c.ssh.dbHost}|${c.ssh.dbPort}` : null);

const PROMPT_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 7 * 60_000;

export class DbService<S extends DbStateLike = DbStateLike> {
  private sessions = new Map<string, Entry>();
  private tunnels = new Map<string, TunnelRef>();
  private pinned = new Set<string>();

  constructor(private readonly deps: DbServiceDeps<S>) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private defer(fn: () => void): void { if (this.deps.defer) this.deps.defer(fn); else setImmediate(fn); }
  private setTimer(fn: () => void, ms: number): unknown { return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms); }
  private clearTimer(t: unknown): void { if (t === undefined || t === null) return; if (this.deps.clearTimer) this.deps.clearTimer(t); else clearTimeout(t as NodeJS.Timeout); }
  private connections(): DbConnection[] { return this.deps.state().dbConnections ?? []; }

  // ── saved connections ───────────────────────────────────────────────────────

  vaultInfo(): DbVaultInfo { return this.deps.vault.info(); }

  saveConnection(input: DbConnectionInput & { id?: string }, password: DbPasswordChange): { ok: true; connection: DbConnection } | { ok: false; error: 'invalid' | 'notFound' | 'readOnly' | 'failed' } {
    const existing = input.id ? this.connections().find((c) => c.id === input.id) : undefined;
    if (input.id && !existing) return { ok: false, error: 'notFound' };
    const now = this.now();
    const connection = strictConnection({ ...input, id: input.id ?? randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now });
    if (!connection) return { ok: false, error: 'invalid' };
    if (!('keep' in password) && this.deps.vault.readOnly()) return { ok: false, error: 'readOnly' };
    try {
      if ('set' in password) this.deps.vault.setPassword(connection.id, password.set);
      else if ('clear' in password) this.deps.vault.clearPassword(connection.id);
    } catch { return { ok: false, error: 'failed' }; }
    this.deps.change((s) => upsertDbConnection(s, connection));
    if (!('keep' in password)) this.deps.events.vaultChanged();
    return { ok: true, connection };
  }

  deleteConnection(id: string): { ok: boolean } {
    if (!this.connections().some((c) => c.id === id)) return { ok: false };
    for (const [sid, e] of this.sessions) if (e.connection.id === id) void this.disconnect(sid);
    this.deps.change((s) => removeDbConnection(s, id));
    try { if (this.deps.vault.clearPassword(id)) this.deps.events.vaultChanged(); } catch { /* pruned on the next state change */ }
    return { ok: true };
  }

  duplicateConnection(id: string): { ok: true; connection: DbConnection } | { ok: false } {
    if (!this.connections().some((c) => c.id === id)) return { ok: false };
    const newId = randomUUID();
    this.deps.change((s) => duplicateDbConnection(s, id, newId, this.now()));
    const copy = this.connections().find((c) => c.id === newId);
    if (!copy) return { ok: false };
    try { if (this.deps.vault.copyPassword(id, newId)) this.deps.events.vaultChanged(); } catch { /* the copy asks for its password */ }
    return { ok: true, connection: copy };
  }

  /** After every state change: passwords of deleted connections go. */
  stateChanged(): void {
    try { if (this.deps.vault.prune(new Set(this.connections().map((c) => c.id)))) this.deps.events.vaultChanged(); } catch { /* retried next time */ }
  }

  /** Connects with the form's values, waits until connected or failed (prompts included) and disconnects again. */
  testConnection(input: DbConnectionInput, password: { set: string } | { saved: string } | null): Promise<DbTestResult> {
    const now = this.now();
    const connection = strictConnection({ ...input, id: randomUUID(), createdAt: now, updatedAt: now });
    if (!connection) return Promise.resolve({ ok: false, error: 'invalid' });
    let secret: string | undefined;
    if (password && 'set' in password) secret = password.set;
    else if (password && 'saved' in password) {
      // A saved password goes only to the server it was saved for: same kind, host, port, user and tunnel.
      const saved = this.connections().find((c) => c.id === password.saved);
      const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      if (!saved || saved.kind !== connection.kind || saved.user !== connection.user || !same(saved.ssh, connection.ssh)
        || (!connection.ssh && (saved.host !== connection.host || saved.port !== connection.port))) return Promise.resolve({ ok: false, error: 'invalid' });
      const p = this.deps.vault.password(password.saved);
      if (p.ok) secret = p.password;
    }
    return new Promise((resolve) => {
      const r = this.open(connection, { password: secret ?? null, test: resolve });
      if (!r.ok) { resolve({ ok: false, error: r.error }); return; }
      const timer = this.setTimer(() => {
        const e = this.sessions.get(r.sessionId);
        if (e?.test) { const done = e.test; e.test = undefined; done({ ok: false, error: 'dbTimeout' }); void this.disconnect(r.sessionId); }
      }, this.deps.testTimeoutMs ?? TEST_TIMEOUT_MS);
      const e = this.sessions.get(r.sessionId);
      if (e?.test) { const done = e.test; e.test = (result) => { this.clearTimer(timer); done(result); }; }
    });
  }

  // ── sessions ────────────────────────────────────────────────────────────────

  /** Answers at once with the session id; the login (which may wait for prompts) runs after this answer went out. */
  connect(connectionId: string, opts: { database?: string } = {}): { ok: true; sessionId: string } | { ok: false; error: DbErrorCode } {
    const connection = this.connections().find((c) => c.id === connectionId);
    if (!connection) return { ok: false, error: 'connectionMissing' };
    const target = opts.database && connection.kind === 'postgres' ? { ...connection, database: opts.database } : connection;
    return this.open(target, { password: 'saved' });
  }

  private open(connection: DbConnection, opts: { password: string | null | 'saved'; test?: (r: DbTestResult) => void }): { ok: true; sessionId: string } | { ok: false; error: DbErrorCode } {
    if (connection.ssh && !this.deps.sshHostExists(connection.ssh.hostId)) return { ok: false, error: 'hostMissing' };
    const all = [...this.sessions.values()];
    if (all.length >= DB_LIMITS.sessionsTotal || all.filter((e) => e.connection.id === connection.id).length >= DB_LIMITS.sessionsPerConnection) return { ok: false, error: 'tooMany' };
    if (!this.deps.host.ensure()) return { ok: false, error: 'dbHostCrashed' };
    const id = dbSessionId(randomUUID());
    const entry: Entry = {
      state: {
        id, connectionId: connection.id, kind: connection.kind, state: 'connecting', phase: 'connecting', since: this.now(), readOnly: connection.readOnly,
        database: connection.kind === 'postgres' ? connection.database ?? 'postgres' : String(connection.dbIndex ?? 0), ...(opts.test ? { test: true as const } : {}),
      },
      connection, idle: null, busy: false, closing: false, own: null, ...(opts.test ? { test: opts.test } : {}), started: this.now(),
    };
    this.sessions.set(id, entry);
    this.deps.events.session(entry.state);
    // The id goes back first, so every 'db:session' and 'db:prompt' event names an id the renderer already has.
    this.defer(() => { void this.start(entry, opts.password); });
    return { ok: true, sessionId: id };
  }

  private async start(entry: Entry, password: string | null | 'saved'): Promise<void> {
    const c = entry.connection;
    const id = entry.state.id;
    let ca: string | undefined;
    if (c.tls === 'verify-full') {
      const text = c.caPath ? await this.deps.readCa(c.caPath) : null;
      if (this.sessions.get(id) !== entry) return;
      if (text === null) { this.end(entry, 'error', 'caFile'); return; }
      ca = text;
    }
    let secret: string | undefined;
    if (password === 'saved') { const p = this.deps.vault.password(c.id); if (p.ok) secret = p.password; } else if (password !== null) secret = password;
    // One SSH login per connection: the first session opens the tunnel, the others ride on it.
    const key = tunnelKeyOf(c);
    let owner = false;
    if (key) {
      let t = this.tunnels.get(key);
      if (!t) { t = { owner: id, refs: new Set() }; this.tunnels.set(key, t); owner = true; }
      t.refs.add(id);
      entry.tunnelKey = key;
    }
    const config: DbOpenConfig = {
      kind: c.kind, host: c.host, port: c.port, user: c.user, database: c.database ?? (c.kind === 'postgres' ? 'postgres' : String(c.dbIndex ?? 0)),
      tls: c.tls, ...(ca ? { ca } : {}), ...(secret !== undefined ? { password: secret } : {}), readOnly: c.readOnly,
      ...(c.statementTimeoutMs ? { statementTimeoutMs: c.statementTimeoutMs } : {}), ssh: c.ssh && key ? { dbHost: c.ssh.dbHost, dbPort: c.ssh.dbPort, tunnelKey: key, owner } : null,
    };
    if (!this.deps.host.send({ t: 'dbOpen', id, config })) { this.end(entry, 'error', 'dbHostCrashed'); return; }
    if (!c.ssh || !owner) return;
    await this.loginTunnel(entry);
  }

  /** The coordinator's SSH login of a tunnel owner (the first session of a connection, or one that took a closed owner's login over). */
  private async loginTunnel(entry: Entry): Promise<void> {
    const id = entry.state.id;
    const ssh = entry.connection.ssh;
    if (!ssh) return;
    const r = await this.deps.coordinator.connectSession({ sessionId: id, hostId: ssh.hostId });
    // The coordinator reports most failures as an 'error' state itself (onCoordinatorSession); one it refused up front is reported here.
    if (!r.ok && this.sessions.get(id) === entry) this.failTunnelLogin(entry, r.error);
  }

  /**
   * The SSH login of a tunnel failed: the sessions waiting on that tunnel end with the same error first (they would otherwise
   * take the refused login over and ask again), then its owner.
   */
  private failTunnelLogin(entry: Entry, error: DbErrorCode): void {
    const id = entry.state.id;
    const t = entry.tunnelKey ? this.tunnels.get(entry.tunnelKey) : undefined;
    for (const rider of [...(t?.refs ?? [])]) {
      const e = this.sessions.get(rider);
      if (rider === id || !e || e.state.state !== 'connecting') continue;
      this.end(e, 'error', error);
      this.deps.host.send({ t: 'dbClose', id: rider });
    }
    this.end(entry, 'error', error);
    this.deps.host.send({ t: 'dbClose', id });
  }

  /** Ends a session in main: the last state goes out, prompts close, the coordinator forgets the tunnel. */
  private end(entry: Entry, phase: 'error' | 'closed', error?: DbErrorCode, message?: string): void {
    const id = entry.state.id;
    if (this.sessions.get(id) !== entry) return;
    this.sessions.delete(id);
    this.clearTimer(entry.idle);
    if (entry.tunnelKey) {
      const t = this.tunnels.get(entry.tunnelKey);
      t?.refs.delete(id);
      if (t && !t.refs.size) this.tunnels.delete(entry.tunnelKey);
    }
    if (entry.own) { this.clearTimer(entry.own.timer); entry.own = null; this.deps.events.prompt(id, null); }
    entry.pendingSave = undefined;
    entry.state = {
      ...entry.state, state: dbStatusOf(phase), phase, since: this.now(),
      ...(error ? { error } : {}), ...(message ? { message } : {}),
    };
    if (phase === 'closed') { delete entry.state.error; delete entry.state.message; }
    this.deps.events.session(entry.state);
    if (entry.test) {
      const done = entry.test;
      entry.test = undefined;
      done({ ok: false, error: entry.testAuthFailed && error === 'cancelled' ? 'dbAuth' : error ?? 'dbClosed', ...(message ? { message } : {}) });
    }
    // Out of the coordinator's own loop (it may be iterating its sessions right now).
    queueMicrotask(() => this.deps.coordinator.endSession(id));
  }

  async disconnect(id: string): Promise<{ ok: boolean }> {
    const entry = this.sessions.get(id);
    if (!entry) return { ok: false };
    entry.closing = true;
    this.end(entry, 'closed');
    this.deps.host.send({ t: 'dbClose', id });
    return { ok: true };
  }

  /** A tunnel state from the coordinator (index.ts routes "db:" ids here): only its failures matter, the DB Host reports the rest. */
  onCoordinatorSession(s: SshSessionState): void {
    const entry = this.sessions.get(s.cellId);
    if (!entry || s.phase !== 'error') return;
    this.failTunnelLogin(entry, s.error ?? 'tunnel');
  }

  onPrompt(sessionId: string, prompt: SshPrompt | null): void { if (this.sessions.has(sessionId)) this.deps.events.prompt(sessionId, prompt); }

  onHostMessage(m: DbHostToMain): void {
    switch (m.t) {
      case 'sshStatus': case 'sshHostKey': case 'sshAuthPrompt':
        // Only for sessions this service started: the DB Host can never move a cell's or an SFTP session's state.
        if (isDbSessionId(m.id) && this.sessions.has(m.id)) this.deps.coordinator.onHostMessage(m);
        return;
      case 'dbStatus': {
        const entry = this.sessions.get(m.id);
        if (!entry) return;
        if (!isLiveDbPhase(m.phase)) { this.end(entry, m.phase === 'closed' ? 'closed' : 'error', m.error ?? (m.phase === 'error' ? 'dbFailed' : undefined), m.message); return; }
        const wasConnected = entry.state.phase === 'connected' || entry.state.reconnecting !== undefined;
        entry.state = {
          ...entry.state, state: dbStatusOf(m.phase), phase: m.phase, since: this.now(),
          ...(m.serverVersion ? { serverVersion: m.serverVersion } : {}), ...(m.database ? { database: m.database } : {}), ...(m.tls !== undefined ? { tls: m.tls } : {}),
          ...(m.phase === 'connected' && entry.connection.kind === 'postgres' ? { tx: 'idle' as const } : {}),
          ...(m.reconnect ? { reconnecting: m.reconnect } : {}),
        };
        if (!m.reconnect) delete entry.state.reconnecting;
        this.deps.events.session(entry.state);
        // A Redis reconnect that worked is not a new login (no password to save, no test to answer).
        if (m.phase === 'connected' && !wasConnected) this.connected(entry);
        else if (m.phase === 'connected') this.scheduleIdle(entry);
        return;
      }
      case 'dbDatabase': {
        const entry = this.sessions.get(m.id);
        if (!entry || entry.state.database === m.database) return;
        entry.state = { ...entry.state, database: m.database };
        this.deps.events.session(entry.state);
        return;
      }
      case 'dbPasswordPrompt': this.askPassword(m.id, m.promptId, m.retry); return;
      case 'dbTunnelOwner': {
        // The owner of this session's tunnel was closed during the login: this session logs the tunnel in now.
        const entry = this.sessions.get(m.id);
        if (!entry?.connection.ssh || !entry.tunnelKey) return;
        const t = this.tunnels.get(entry.tunnelKey);
        if (t) t.owner = m.id;
        void this.loginTunnel(entry);
        return;
      }
      case 'dbTx': {
        const entry = this.sessions.get(m.id);
        if (!entry || entry.state.tx === m.tx) return;
        entry.state = { ...entry.state, tx: m.tx };
        this.deps.events.session(entry.state);
        return;
      }
      case 'dbActivity': {
        const entry = this.sessions.get(m.id);
        if (!entry) return;
        entry.busy = m.busy;
        this.scheduleIdle(entry);
        return;
      }
      default: return;
    }
  }

  private connected(entry: Entry): void {
    if (entry.pendingSave !== undefined) {
      const value = entry.pendingSave;
      entry.pendingSave = undefined;
      // A failed write only loses the "remember" wish; the session itself is fine.
      try { if (this.deps.vault.setPassword(entry.connection.id, value).ok) this.deps.events.vaultChanged(); } catch { /* not saved */ }
    }
    if (entry.test) {
      const done = entry.test;
      entry.test = undefined;
      done({ ok: true, timeMs: this.now() - entry.started, ...(entry.state.serverVersion ? { serverVersion: entry.state.serverVersion } : {}) });
      void this.disconnect(entry.state.id);
      return;
    }
    this.scheduleIdle(entry);
  }

  private askPassword(id: string, hostPromptId: string, retry: boolean): void {
    const entry = this.sessions.get(id);
    if (!entry) { this.deps.host.send({ t: 'dbPasswordAnswer', id, promptId: hostPromptId, value: null }); return; }
    // "Testuj połączenie" checks the form's password: a refused one is the answer, the user fixes it in the form.
    if (entry.state.test && retry) {
      entry.testAuthFailed = true;
      this.deps.host.send({ t: 'dbPasswordAnswer', id, promptId: hostPromptId, value: null });
      return;
    }
    if (entry.own) this.clearTimer(entry.own.timer);
    const c = entry.connection;
    const promptId = randomUUID();
    const prompt: OwnPrompt['prompt'] = {
      id: promptId, kind: 'dbPassword', connectionName: c.name, user: c.user, endpoint: dbEndpoint(c),
      // A test of an unsaved form never saves; the form saves its own password field.
      canSave: !entry.state.test && !this.deps.vault.readOnly(), retry,
    };
    const timer = this.setTimer(() => this.answer({ sessionId: id, promptId, cancel: true }), this.deps.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
    entry.own = { prompt, hostPromptId, timer };
    this.deps.events.prompt(id, prompt);
  }

  answer(a: DbPromptAnswer): { ok: boolean } {
    const entry = this.sessions.get(a.sessionId);
    if (!entry) return { ok: false };
    const own = entry.own;
    if (own && own.prompt.id === a.promptId) {
      if ('hostKey' in a) return { ok: false };
      if ('values' in a && a.values.length !== 1) return { ok: false };
      entry.own = null;
      this.clearTimer(own.timer);
      const value = 'values' in a ? a.values[0] : null;
      // Only the latest answer decides: a retry answered without "remember" drops an earlier (wrong) password.
      entry.pendingSave = value !== null && 'remember' in a && a.remember && own.prompt.canSave ? value : undefined;
      this.deps.events.prompt(a.sessionId, null);
      this.deps.host.send({ t: 'dbPasswordAnswer', id: a.sessionId, promptId: own.hostPromptId, value });
      return { ok: true };
    }
    const { sessionId, ...rest } = a;
    return this.deps.coordinator.answer({ cellId: sessionId, ...rest } as SshPromptAnswer);
  }

  snapshot(): DbSnapshot {
    const prompts: DbSnapshot['prompts'] = this.deps.coordinator.sessionSnapshot('db').prompts
      .filter((p) => this.sessions.has(p.cellId)).map((p) => ({ sessionId: p.cellId, prompt: p.prompt }));
    for (const [id, e] of this.sessions) if (e.own) prompts.push({ sessionId: id, prompt: e.own.prompt });
    return { sessions: [...this.sessions.values()].map((e) => e.state), prompts };
  }

  async op(sessionId: string, op: DbHostOp): Promise<DbResult<unknown>> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, error: 'noSession' };
    if (entry.state.phase !== 'connected') return { ok: false, error: 'notConnected' };
    // Every operation counts as use: the idle timer starts again.
    this.scheduleIdle(entry);
    return this.deps.host.request(sessionId, op);
  }

  hostCrashed(): void {
    this.deps.coordinator.sessionHostCrashed('db');
    for (const entry of [...this.sessions.values()]) this.end(entry, 'error', 'dbHostCrashed');
    this.deps.events.hostCrashed();
  }

  /** The sessions open tabs use: never disconnected for being idle. */
  pin(sessionIds: string[]): void {
    this.pinned = new Set(sessionIds.filter((id) => isDbSessionId(id)).slice(0, 1000));
    for (const e of this.sessions.values()) this.scheduleIdle(e);
  }

  /** The renderer reloads or crashed: the new page pins its tabs again. */
  rendererGone(): void { this.pin([]); }

  private kept(entry: Entry): boolean {
    return entry.state.phase !== 'connected' || entry.busy || this.pinned.has(entry.state.id);
  }

  private scheduleIdle(entry: Entry): void {
    this.clearTimer(entry.idle);
    entry.idle = null;
    if (this.kept(entry)) return;
    const id = entry.state.id;
    entry.idle = this.setTimer(() => {
      const e = this.sessions.get(id);
      if (e === entry && !this.kept(e)) void this.disconnect(id);
    }, this.deps.idleMs ?? DB_LIMITS.idleMs);
  }

  ids(): string[] { return [...this.sessions.keys()]; }
}

/**
 * A connection exactly as sent: the normalizer must not have changed anything that matters (a bad port or an unknown TLS mode
 * would otherwise be saved as the default silently).
 */
export function strictConnection(raw: DbConnection): DbConnection | null {
  const c = normalizeDbConnection(raw);
  if (!c) return null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const fields: Array<keyof DbConnection> = ['kind', 'host', 'port', 'user', 'tls', 'caPath', 'ssh', 'readOnly', 'statementTimeoutMs', 'color', 'group'];
  if (!fields.every((f) => same(c[f], raw[f]))) return null;
  if (c.kind === 'postgres' && !same(c.database, raw.database ?? 'postgres')) return null;
  if (c.kind === 'redis' && !same(c.dbIndex, raw.dbIndex ?? 0)) return null;
  if (typeof raw.name !== 'string' || raw.name.trim().length > DB_LIMITS.name) return null;
  return c;
}
