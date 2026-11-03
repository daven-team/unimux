// src/main/auth/codexLogin.ts - 1.1.2: "Dodaj konto Codex" and "Zaloguj ponownie" of a saved Codex card. Runs `codex login`
// with CODEX_HOME pointing at the account's own profile directory in the auth terminal and watches that auth.json. The live
// ~/.codex is never touched here (its login stays LoginManager's `codex` / `main` flow).
import { randomUUID } from 'crypto';
import type { LoginState } from '../../shared/accounts';
import { CODEX_PROFILE_LOGIN, compareCodexIdentity, isCodexAccountId, type CodexIdentity } from '../../shared/codexAccounts';
import type { CodexAccountsStore } from '../accounts/codexStore';

export interface CodexLoginDeps {
  store: CodexAccountsStore;
  spawnPty(spec: { id: string; env: Record<string, string>; command: string }): void;
  killPty(id: string): void;
  /** Fingerprint (never the token) of the profile's auth.json login, or null when there is none. */
  fingerprint(dir: string): Promise<string | null>;
  identity(dir: string): Promise<CodexIdentity | null>;
  /** The account in the live auth.json: already the main card, so adding it again is a duplicate. */
  liveIdentity(): CodexIdentity | null;
  /** The raw auth.json of a profile (kept in memory only, for putting a card's login back), or null. */
  readAuth(dir: string): Promise<string | null>;
  /** Writes (or, with null, deletes) a profile's auth.json. */
  restoreAuth(dir: string, raw: string | null): Promise<void>;
  /** True while something else may change the account files (a swap, a Claude login). */
  busy(): boolean;
  emit(state: LoginState): void;
  onChanged(recordId: string): void;
  pollMs?: number;
  settleMs?: number;
  timeoutMs?: number;
}

export type CodexLoginTarget = { type: 'new' } | { type: 'account'; id: string };

interface Session {
  id: string;
  ptyId: string;
  target: CodexLoginTarget;
  dir: string;
  /** `new`: the record id prepared for it (discarded unless the login succeeds). */
  pendingId?: string;
  /** `account`: the card's previous auth.json (memory only). */
  previous?: string | null;
  initial: string | null;
  ended: boolean;
  polling: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  poll?: ReturnType<typeof setInterval>;
}

export class CodexLoginManager {
  private current: Session | null = null;

  constructor(private readonly deps: CodexLoginDeps) {}

  isActive(): boolean { return this.current !== null; }
  ownsSession(sessionId: string): boolean { return this.current?.id === sessionId; }

  async start(target: unknown): Promise<{ ok: true; sessionId: string; ptyId: string } | { ok: false; error: string }> {
    const t = target as { type?: unknown; id?: unknown } | null;
    if (!t || typeof t !== 'object' || (t.type !== 'new' && t.type !== 'account')) return { ok: false, error: 'invalid request' };
    if (t.type === 'account' && (!isCodexAccountId(t.id) || !this.deps.store.get(t.id))) return { ok: false, error: 'invalid request' };
    if (this.deps.busy()) return { ok: false, error: 'busy' };
    if (this.deps.store.readOnly()) return { ok: false, error: 'readOnly' };
    if (this.current) this.cancel(this.current.id);
    const sessionId = randomUUID();
    let dir: string;
    let pendingId: string | undefined;
    try {
      if (t.type === 'new') ({ id: pendingId, dir } = this.deps.store.prepare());
      else dir = this.deps.store.dirOf(t.id as string);
    } catch { return { ok: false, error: 'spawn' }; }
    const session: Session = {
      id: sessionId, ptyId: `auth:${sessionId}`, target: t.type === 'new' ? { type: 'new' } : { type: 'account', id: t.id as string },
      dir, ...(pendingId ? { pendingId } : {}), initial: null, ended: false, polling: false, timers: new Set(),
    };
    this.current = session;
    try {
      if (session.target.type === 'account') session.previous = await this.deps.readAuth(dir);
      session.initial = await this.deps.fingerprint(dir);
    } catch { session.initial = null; }
    if (session.ended) return { ok: false, error: 'cancelled' };
    try {
      // The profile's own CODEX_HOME; an API key in the environment must not stand in for the login.
      this.deps.spawnPty({ id: session.ptyId, env: { CODEX_HOME: dir, OPENAI_API_KEY: '', CODEX_API_KEY: '' }, command: CODEX_PROFILE_LOGIN });
    } catch {
      this.end(session);
      this.discard(session);
      return { ok: false, error: 'spawn' };
    }
    session.poll = setInterval(() => void this.tick(session), this.deps.pollMs ?? 1500);
    this.later(session, this.deps.timeoutMs ?? 600_000, () => this.fail(session, 'timeout'));
    this.deps.emit({ sessionId, status: 'waiting' });
    return { ok: true, sessionId, ptyId: session.ptyId };
  }

  cancel(sessionId: string): void {
    const session = this.current;
    if (!session || session.id !== sessionId) return;
    this.end(session);
    this.kill(session);
    void this.undo(session);
  }

  /** The record is being removed: its login session ends without putting anything back. */
  cancelFor(id: string): void {
    const session = this.current;
    if (!session || session.target.type !== 'account' || session.target.id !== id) return;
    this.end(session);
    this.kill(session);
  }

  dispose(): void { if (this.current) this.cancel(this.current.id); }

  private async tick(session: Session): Promise<void> {
    if (session.ended || session.polling) return;
    session.polling = true;
    let fingerprint: string | null = null;
    try { fingerprint = await this.deps.fingerprint(session.dir); } catch { fingerprint = null; }
    session.polling = false;
    if (session.ended || fingerprint === null || fingerprint === session.initial) return;
    if (session.poll) clearInterval(session.poll);
    session.poll = undefined;
    // Codex writes the file once; a short pause lets the write settle before it is read.
    this.later(session, this.deps.settleMs ?? 1000, () => void this.finalize(session).catch(() => this.fail(session, 'identity')));
  }

  private async finalize(session: Session): Promise<void> {
    if (session.ended) return;
    const identity = await this.deps.identity(session.dir);
    if (session.ended) return;
    this.kill(session);
    if (!identity || (!identity.email && !identity.userId)) { await this.fail(session, 'identity'); return; }
    const { email } = identity;
    const target = session.target;
    const others = this.deps.store.list().filter((a) => target.type !== 'account' || a.id !== target.id);
    const live = target.type === 'new' ? this.deps.liveIdentity() : null;
    if (others.some((a) => compareCodexIdentity(a, identity) === 'same') || (live && compareCodexIdentity(live, identity) === 'same')) {
      await this.finish(session, { sessionId: session.id, status: 'duplicate', ...(email ? { email } : {}) }, true);
      return;
    }
    if (target.type === 'new') {
      const recordId = session.pendingId!;
      this.deps.store.commit({ id: recordId, addedAt: Date.now(), ...identity });
      session.pendingId = undefined;
      await this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}) }, false);
      this.deps.onChanged(recordId);
      return;
    }
    const record = this.deps.store.get(target.id);
    if (!record || compareCodexIdentity(identity, record) === 'different') {
      await this.finish(session, { sessionId: session.id, status: 'mismatch', ...(email ? { email } : {}), ...(record?.email ? { expected: record.email } : {}) }, true);
      return;
    }
    // A fresh login of the card's own account: the only copy of a new token family, no longer a twin nor outdated.
    this.deps.store.updateIdentity(target.id, { ...record, ...identity });
    this.deps.store.patch(target.id, { liveFamily: undefined, outdated: undefined });
    await this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}) }, false);
    this.deps.onChanged(target.id);
  }

  private async fail(session: Session, error: 'timeout' | 'identity'): Promise<void> {
    if (session.ended) return;
    await this.finish(session, { sessionId: session.id, status: 'failed', error }, true);
  }

  /** Ends the session; `undo` puts a card's previous login back (or drops a new profile) before the state is told. */
  private async finish(session: Session, state: LoginState, undo: boolean): Promise<void> {
    this.end(session);
    this.kill(session);
    if (undo) await this.undo(session);
    this.deps.emit(state);
  }

  private async undo(session: Session): Promise<void> {
    if (session.target.type === 'account' && session.previous !== undefined) {
      const previous = session.previous;
      session.previous = undefined;
      try { await this.deps.restoreAuth(session.dir, previous); } catch { /* the card shows whatever login is there */ }
    }
    this.discard(session);
  }

  private discard(session: Session): void {
    if (!session.pendingId) return;
    const id = session.pendingId;
    session.pendingId = undefined;
    try { this.deps.store.remove(id); } catch { /* an orphaned dir is never listed */ }
  }

  private later(session: Session, ms: number, run: () => void): void {
    const timer = setTimeout(() => { session.timers.delete(timer); run(); }, ms);
    session.timers.add(timer);
  }

  private end(session: Session): void {
    session.ended = true;
    if (session.poll) clearInterval(session.poll);
    session.poll = undefined;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    if (this.current === session) this.current = null;
  }

  private kill(session: Session): void {
    try { this.deps.killPty(session.ptyId); } catch { /* already gone */ }
  }
}
