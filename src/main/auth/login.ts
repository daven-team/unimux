// src/main/auth/login.ts
import { randomUUID } from 'crypto';
import { compareIdentity, custodyOf, familyOf, identityFields, isAccountId, type AccountCustody, type AccountIdentity, type LoginRequest, type LoginState, type TokenFamily } from '../../shared/accounts';
import { resolve } from 'path';
import { LiveBackupFailed } from '../accounts/reconcile';
import type { AccountsStore } from '../accounts/store';
import type { ProfileSnapshot } from './profileSnapshot';

/**
 * An account the app knows: the live login (`live`, also a record holding it) or a saved record. `empty`: a record whose
 * profile holds no Claude login at all and that is not the signed-in live login (an identity left in `~/.claude.json` by
 * Claude Desktop or an earlier sign-in, adopted without credentials). It never blocks a login as a duplicate; a new login of
 * that account replaces it.
 */
export interface KnownIdentity extends AccountIdentity { recordId?: string; live?: boolean; empty?: boolean }
/** What a finished login changed, so the usage panel reads exactly that account at once. */
export interface LoginChange { provider: 'claude' | 'codex'; recordId?: string; ownChange?: boolean }

export interface LoginDeps {
  store: AccountsStore;
  /** Starts the login command in a pty; `env` holds only the extra variables. */
  spawnPty(spec: { id: string; env: Record<string, string>; command: string }): void | Promise<void>;
  /** True when the provider's CLI is known not to be installed: the login does not start (`cliMissing`), the app offers the install. */
  cliMissing?(provider: 'claude' | 'codex'): Promise<boolean>;
  /** False when Claude Code has no main login (nothing in `~/.claude/.credentials.json`): a new account is offered as main. */
  hasMainLogin?(): Promise<boolean>;
  killPty(id: string): void;
  /** Fingerprint (never the token) of the credentials the login writes, or null when there are none yet. */
  fingerprint(provider: 'claude' | 'codex', configDir: string | undefined): Promise<string | null>;
  /** Drops cached failed credential reads (macOS Keychain) so the login sees fresh credentials. Called before each fingerprint read. */
  resetCredentialCache?(): void;
  identity(provider: 'claude' | 'codex', configDir: string | undefined): Promise<AccountIdentity>;
  /** The live Claude login and every saved account that is not set aside. */
  knownIdentities(): Promise<KnownIdentity[]>;
  /** Login files of a saved profile, taken before it is signed in again (memory only). */
  snapshotProfile(dir: string): Promise<ProfileSnapshot>;
  /** Puts a snapshot back: the re-login signed in a different account, or one the app already has. */
  restoreProfile(dir: string, snapshot: ProfileSnapshot): Promise<void>;
  /**
   * True once the profile's `oauthAccount` is no longer the one of the snapshot: Claude Code wrote the identity of the new
   * login. Until then the identity read from the profile may still be the card's old one, so it never counts as `same`.
   */
  identityRewritten(dir: string, snapshot: ProfileSnapshot): Promise<boolean>;
  /**
   * Before a main Claude login: the outgoing live login is backed up into its record. Rejects when it could not be backed
   * up (or is not current); the login is then refused with `backup` (`LiveBackupFailed`) or `busy` (a swap holds the
   * slot, is unresolved or has a pending journal), so a live login is never replaced unsaved.
   */
  beforeMainLogin?(): Promise<void>;
  emit(state: LoginState): void;
  /** Called after a login succeeded. */
  onChanged(change: LoginChange): void;
  /** False where isolated Claude profiles cannot work (macOS keeps Claude tokens in the Keychain). Defaults to true. */
  profilesSupported?: boolean;
  /** True while the main account is being swapped; a login must not touch the same files meanwhile. */
  swapRunning?: () => boolean;
  pollMs?: number;
  settleMs?: number;
  timeoutMs?: number;
  /** Gap between the tries of a restore (3 tries). */
  restoreGapMs?: number;
}

/** A restore that failed: the card holds another login, so it is set aside until its snapshot is put back. */
interface Parked { dir: string; snapshot: ProfileSnapshot; custody: AccountCustody; family: TokenFamily }

export type LoginStartResult = { ok: true; sessionId: string; ptyId: string } | { ok: false; error: string; email?: string };

type Timer = ReturnType<typeof setTimeout>;

interface Session {
  id: string;
  ptyId: string;
  provider: 'claude' | 'codex';
  target: LoginRequest['target'];
  configDir: string | undefined;
  pendingId?: string;
  snapshot?: ProfileSnapshot;
  initial: string | null;
  settled: boolean;
  ended: boolean;
  polling: boolean;
  poll?: Timer;
  settle?: Timer;
  timeout?: Timer;
  sleeps: Set<Timer>;
}

/** `--claudeai` is not in the public CLI reference but is what the existing login flow has used and verified; plain `claude auth login` would show an interactive method menu on some versions. */
export const loginCommand = (provider: 'claude' | 'codex'): string => (provider === 'claude' ? 'claude auth login --claudeai' : 'codex login');

const IDENTITY_TRIES = 5;
const IDENTITY_GAP_MS = 1000;
const RESTORE_TRIES = 3;

export class LoginManager {
  private current: Session | null = null;
  /** Restores in progress per profile dir (with their retries); a new login of that card waits for them. */
  private readonly restoring = new Map<string, Promise<boolean>>();
  /** Failed restores per record id, kept in memory only and retried (retryParkedRestores, the next start of that card). */
  private readonly parked = new Map<string, Parked>();
  /** The retry of the parked restores in progress (retryParkedRestores). */
  private retrying: Promise<void> | undefined;

  constructor(private readonly deps: LoginDeps) {}

  async start(request: LoginRequest): Promise<LoginStartResult> {
    const invalid = { ok: false as const, error: 'invalid request' };
    const provider = (request as { provider?: unknown } | null)?.provider;
    const target = (request as { target?: { type?: unknown; id?: unknown } } | null)?.target;
    if ((provider !== 'claude' && provider !== 'codex') || typeof target !== 'object' || target === null) return invalid;
    if (provider === 'codex' && target.type !== 'main') return invalid;
    if (this.deps.profilesSupported === false && (target.type === 'new' || target.type === 'account')) return { ok: false, error: 'unsupported' };
    if (this.deps.swapRunning?.()) return { ok: false, error: 'busy' };
    if (target.type === 'account') {
      if (!isAccountId(target.id) || !this.deps.store.list().some((account) => account.id === target.id)) return invalid;
    } else if (target.type !== 'new' && target.type !== 'main') {
      return invalid;
    }
    // A missing CLI would only print "command not found" in the login terminal: the renderer offers the install instead.
    if (this.deps.cliMissing) {
      let missing = false;
      try { missing = (await this.deps.cliMissing(provider)) === true; } catch { missing = false; }
      if (missing) return { ok: false, error: 'cliMissing' };
    }

    if (this.current) this.cancel(this.current.id);

    const sessionId = randomUUID();
    const session: Session = {
      id: sessionId,
      ptyId: `auth:${sessionId}`,
      provider,
      target: request.target,
      configDir: undefined,
      initial: null,
      settled: false,
      ended: false,
      polling: false,
      sleeps: new Set(),
    };
    if (target.type === 'new') {
      try {
        const pending = this.deps.store.prepare();
        session.pendingId = pending.id;
        session.configDir = pending.dir;
      } catch {
        return { ok: false, error: 'spawn' };
      }
    } else if (target.type === 'account') {
      session.configDir = this.deps.store.dirOf(target.id as string);
    }
    this.current = session;

    if (provider === 'claude' && target.type === 'account') {
      const id = target.id as string;
      const dir = session.configDir as string;
      // A restore of this card still running (a cancelled login) lands first, and a failed one is tried again: the snapshot
      // must be the card's own login, never the other account's files that are about to be replaced.
      await this.restoring.get(dir);
      if (this.parked.has(id)) await this.retryParked(id);
      if (session.ended) return { ok: false, error: 'cancelled' };
      if (this.parked.has(id)) { this.end(session); return { ok: false, error: 'restore' }; }
      try {
        session.snapshot = await this.deps.snapshotProfile(dir);
      } catch {
        // No snapshot: a wrong account could not be undone, so nothing starts.
        this.end(session);
        return { ok: false, error: 'spawn' };
      }
    } else if (provider === 'claude' && target.type === 'main') {
      try {
        await this.deps.beforeMainLogin?.();
      } catch (error) {
        // No backup: the live login would be lost, so nothing starts. The card of the outgoing account is named.
        this.end(session);
        if (!(error instanceof LiveBackupFailed) || error.reason === 'busy') return { ok: false, error: 'busy' };
        const email = this.deps.store.live()?.email;
        return { ok: false, error: 'backup', ...(email ? { email } : {}) };
      }
    }
    if (session.ended) return { ok: false, error: 'cancelled' };

    try {
      this.deps.resetCredentialCache?.();
      session.initial = await this.deps.fingerprint(provider, session.configDir);
    } catch {
      session.initial = null;
    }
    if (session.ended) return { ok: false, error: 'cancelled' };

    try {
      await this.deps.spawnPty({
        id: session.ptyId,
        // A user-level token or API key must not override the profile's own login.
        env: session.configDir ? { CLAUDE_CONFIG_DIR: session.configDir, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } : {},
        command: loginCommand(provider),
      });
    } catch {
      this.end(session);
      this.discard(session);
      return { ok: false, error: 'spawn' };
    }
    // Cancelled while the terminal was being started: it must not keep running behind a closed dialog.
    if (session.ended) { this.kill(session); return { ok: false, error: 'cancelled' }; }

    session.poll = setInterval(() => void this.tick(session), this.deps.pollMs ?? 1500);
    session.timeout = setTimeout(() => this.onTimeout(session), this.deps.timeoutMs ?? 600000);
    this.deps.emit({ sessionId, status: 'waiting' });
    return { ok: true, sessionId, ptyId: session.ptyId };
  }

  /** True while a login session is in progress. */
  isActive(): boolean {
    return this.current !== null;
  }

  /** True while a main Claude login is in progress (its outgoing live login is still backed up by the polls). */
  isMainActive(): boolean {
    return this.current?.provider === 'claude' && this.current.target.type === 'main';
  }

  /**
   * True while the profile `dir` must not be renewed: a login of that card runs (its snapshot must stay the card's login),
   * or its restore is running or failed (the files may be another account's).
   */
  holdsProfile(dir: string): boolean {
    const norm = (path: string) => resolve(path);
    const target = norm(dir);
    if (this.current?.configDir !== undefined && norm(this.current.configDir) === target) return true;
    if ([...this.restoring.keys()].some((d) => norm(d) === target)) return true;
    return [...this.parked.values()].some((p) => norm(p.dir) === target);
  }

  /** Records whose failed restore is kept for a retry (set aside meanwhile); empty again after an app restart. */
  parkedIds(): string[] {
    return [...this.parked.keys()];
  }

  /**
   * Tries the failed restores again (called before every usage poll); a card whose login is back leaves the set-aside state.
   * One retry runs at a time (a call meanwhile joins it). With `waitMs` the caller waits at most that long: a restore waiting
   * for Claude Code's locks (about 30 s per card) keeps running on its own instead of holding up every account's poll.
   */
  async retryParkedRestores(waitMs?: number): Promise<void> {
    if (!this.retrying) this.retrying = this.retryAllParked().finally(() => { this.retrying = undefined; });
    const run = this.retrying;
    if (waitMs === undefined) return run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((done) => { timer = setTimeout(done, waitMs); });
    try { await Promise.race([run, waited]); } finally { clearTimeout(timer); }
  }

  private async retryAllParked(): Promise<void> {
    for (const id of [...this.parked.keys()]) {
      const session = this.current;
      if (session?.target.type === 'account' && session.target.id === id) continue;
      await this.retryParked(id);
    }
  }

  cancel(sessionId: string): void {
    const session = this.current;
    if (!session || session.id !== sessionId) return;
    const written = this.loginWritten(session);
    this.end(session);
    this.kill(session);
    this.undo(session, written);
    this.discard(session);
  }

  /** The pty host died: ends the current session as failed. */
  failActive(error: 'spawn'): void {
    const session = this.current;
    if (!session) return;
    const written = this.loginWritten(session);
    this.end(session);
    this.kill(session);
    this.undo(session, written);
    this.discard(session);
    this.deps.emit({ sessionId: session.id, status: 'failed', error });
  }

  /** Cancels the active session when it targets this managed account. */
  cancelFor(accountId: string): void {
    // The account is being removed: its profile goes away, nothing is put back (also no failed restore of it).
    this.parked.delete(accountId);
    const session = this.current;
    if (!session || session.target.type !== 'account' || session.target.id !== accountId) return;
    session.snapshot = undefined;
    this.cancel(session.id);
  }

  dispose(): void {
    if (this.current) this.cancel(this.current.id);
  }

  private async tick(session: Session): Promise<void> {
    if (session.ended || session.settled || session.polling || session.settle) return;
    session.polling = true;
    let fingerprint: string | null = null;
    try {
      this.deps.resetCredentialCache?.();
      fingerprint = await this.deps.fingerprint(session.provider, session.configDir);
    } catch {
      fingerprint = null;
    }
    session.polling = false;
    if (session.ended || session.settled || session.settle) return;
    if (fingerprint !== null && fingerprint !== session.initial) {
      session.settle = setTimeout(() => void this.finalize(session), this.deps.settleMs ?? 1500);
    }
  }

  private onTimeout(session: Session): void {
    if (session.ended || session.settled) return;
    const written = this.loginWritten(session);
    session.settled = true;
    this.end(session);
    this.kill(session);
    this.undo(session, written);
    this.discard(session);
    this.deps.emit({ sessionId: session.id, status: 'failed', error: 'timeout' });
  }

  private async finalize(session: Session): Promise<void> {
    try {
      await this.runFinalize(session);
    } catch {
      // a store failure must not leave the session half-finished
      if (!session.ended) this.finish(session, { sessionId: session.id, status: 'failed', error: 'identity' }, true);
    }
  }

  private async runFinalize(session: Session): Promise<void> {
    if (session.ended || session.settled) return;
    session.settled = true;
    this.clearTimers(session);
    this.kill(session);

    // A re-login of a card: Claude Code may write the new credentials before the new `oauthAccount`, so the identity counts
    // only once the profile's `oauthAccount` is no longer the snapshot's (checked before each read, so the read is at least
    // as new). An identity that never gets confirmed is never taken for the card's own.
    const snapshot = session.target.type === 'account' ? session.snapshot : undefined;
    let identity: AccountIdentity = {};
    let confirmed = snapshot === undefined;
    for (let attempt = 0; attempt < IDENTITY_TRIES; attempt++) {
      if (snapshot && session.configDir) {
        try { confirmed = await this.deps.identityRewritten(session.configDir, snapshot); } catch { confirmed = false; }
        if (session.ended) return;
      }
      try {
        identity = await this.deps.identity(session.provider, session.configDir);
      } catch {
        identity = {};
      }
      if (session.ended) return;
      if (((identity.email || identity.accountUuid) && confirmed) || attempt === IDENTITY_TRIES - 1) break;
      await this.sleep(session, IDENTITY_GAP_MS);
      if (session.ended) return;
    }
    const { email } = identity;
    const target = session.target;
    if (session.provider === 'codex' || target.type === 'main') {
      this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}) }, false);
      this.deps.onChanged({ provider: session.provider, ...(session.provider === 'claude' ? { ownChange: true } : {}) });
      return;
    }
    const expected = target.type === 'account' ? this.deps.store.get(target.id)?.email : undefined;
    if ((!email && !identity.accountUuid) || !confirmed) {
      if (!(await this.restoreOrReport(session, email, expected))) return;
      // The card's previous login is back; the dialog names the card.
      this.finish(session, { sessionId: session.id, status: 'failed', error: 'identity', ...(expected ? { expected } : {}) }, true);
      return;
    }
    let known: KnownIdentity[] = [];
    try { known = await this.deps.knownIdentities(); } catch { known = []; }
    if (session.ended) return;
    const self = target.type === 'account' ? target.id : undefined;
    // The live login has no record id: it is compared too (a re-login of a card skips only that card itself).
    const sameAccount = known.filter((k) => (self === undefined || k.recordId !== self) && compareIdentity(k, identity) === 'same');
    // Only a login the app really holds is a duplicate: the signed-in live login or a saved card with a login in it.
    const holder = sameAccount.find((k) => k.live && !k.empty) ?? sameAccount.find((k) => !k.empty);
    if (holder) {
      if (!(await this.restoreOrReport(session, email, expected))) return;
      const named = holder.email ?? email;
      this.finish(session, { sessionId: session.id, status: 'duplicate', ...(named ? { email: named } : {}), duplicateOf: holder.live ? 'main' : 'saved' }, true);
      return;
    }
    if (target.type === 'new') {
      let offerMain = false;
      try { offerMain = this.deps.hasMainLogin ? !(await this.deps.hasMainLogin()) : false; } catch { offerMain = false; }
      if (session.ended) return;
      const recordId = session.pendingId as string;
      this.deps.store.commit({ id: recordId, addedAt: Date.now(), ...identityFields(identity), custody: 'app', family: 'own' });
      session.pendingId = undefined;
      // Records of this account without any login (see KnownIdentity.empty) are replaced by the new one, so one card is left.
      for (const stale of sameAccount) {
        if (!stale.empty || !stale.recordId || stale.recordId === recordId) continue;
        try { this.deps.store.remove(stale.recordId); } catch { /* read-only: the empty record stays hidden */ }
      }
      this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}), recordId, ...(offerMain ? { offerMain: true as const } : {}) }, false);
      this.deps.onChanged({ provider: 'claude', recordId });
      return;
    }
    // A card is signed in again only as the account it belongs to; another account never relabels it (R10).
    const record = this.deps.store.get(target.id);
    if (!record || compareIdentity(identity, record) !== 'same') {
      if (!(await this.restoreOrReport(session, email, expected))) return;
      this.finish(session, { sessionId: session.id, status: 'mismatch', ...(email ? { email } : {}), ...(record?.email ? { expected: record.email } : {}) }, true);
      return;
    }
    // A fresh token family of the card's own account: the app holds it alone (custody app, family own), also for a card
    // that another tool had switched out (foreign).
    this.deps.store.updateIdentity(target.id, identity);
    this.deps.store.setCustody(target.id, 'app');
    this.deps.store.setFamily(target.id, 'own');
    this.deps.store.setHeldTokens(target.id, undefined);
    this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}) }, false);
    this.deps.onChanged({ provider: 'claude', recordId: target.id });
  }

  /**
   * Restores the card; when that fails the session ends with `failed`/`restore` naming the card (the dialog must not say
   * "nothing was changed") and resolves false, so the caller emits nothing else.
   */
  private async restoreOrReport(session: Session, email: string | undefined, expected: string | undefined): Promise<boolean> {
    if (await this.restore(session)) return true;
    if (!session.ended) this.finish(session, { sessionId: session.id, status: 'failed', error: 'restore', ...(email ? { email } : {}), ...(expected ? { expected } : {}) }, true);
    return false;
  }

  /**
   * Puts the card's previous login back (3 tries). When it still fails the card holds another account's login under its
   * label: it is set aside (quarantined: never polled, never renewed) and the snapshot stays in memory for a later retry.
   */
  private async restore(session: Session): Promise<boolean> {
    const { snapshot, configDir } = session;
    session.snapshot = undefined;
    if (!snapshot || !configDir) return true;
    const restored = await this.putBack(configDir, snapshot);
    if (!restored && session.target.type === 'account') this.park(session.target.id, configDir, snapshot);
    return restored;
  }

  /** Runs the restore tries for one dir, registered in `restoring` (the first try starts synchronously). */
  private putBack(dir: string, snapshot: ProfileSnapshot): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < RESTORE_TRIES; attempt++) {
        if (attempt > 0) await new Promise<void>((done) => setTimeout(done, this.deps.restoreGapMs ?? 2_000));
        try { await this.deps.restoreProfile(dir, snapshot); return true; } catch { /* tried again */ }
      }
      return false;
    };
    const tracked: Promise<boolean> = run().finally(() => { if (this.restoring.get(dir) === tracked) this.restoring.delete(dir); });
    this.restoring.set(dir, tracked);
    return tracked;
  }

  private park(id: string, dir: string, snapshot: ProfileSnapshot): void {
    const record = this.deps.store.get(id);
    if (!record) return;
    const previous = this.parked.get(id);
    this.parked.set(id, { dir, snapshot, custody: previous?.custody ?? custodyOf(record), family: previous?.family ?? familyOf(record) });
    try { this.deps.store.setCustody(id, 'quarantined'); } catch { /* read-only: renewal stays blocked by holdsProfile */ }
  }

  /** One more restore of a parked card; on success the card gets its previous custody and family back. */
  private async retryParked(id: string): Promise<void> {
    const entry = this.parked.get(id);
    if (!entry) return;
    await this.restoring.get(entry.dir);
    if (this.parked.get(id) !== entry) return;
    if (!(await this.putBack(entry.dir, entry.snapshot))) return;
    if (this.parked.get(id) !== entry) return;
    this.parked.delete(id);
    if (!this.deps.store.get(id)) return;
    try {
      this.deps.store.setCustody(id, entry.custody);
      this.deps.store.setFamily(id, entry.family);
    } catch { /* the record stays set aside; its login is the card's own again */ }
  }

  /** The login has already written new files into the card's profile (its identity is checked only when it settles). */
  private loginWritten(session: Session): boolean {
    return session.settled || session.settle !== undefined;
  }

  /**
   * A session that ends without a verdict puts the card's previous login back once the login wrote new files. The polls look
   * only every 1.5 s, so a card whose login was not seen yet gets one more look: credentials that changed since the start
   * (or that cannot be read) are another login, and the snapshot goes back. The dir counts as restoring meanwhile, so no
   * renewal writes into it between the look and the restore.
   */
  private undo(session: Session, written: boolean): void {
    if (written) { void this.restore(session).catch(() => undefined); return; }
    const { snapshot, configDir, target } = session;
    session.snapshot = undefined;
    if (!snapshot || !configDir || target.type !== 'account') return;
    const look: Promise<boolean> = (async () => {
      let now: string | null | undefined;
      try {
        this.deps.resetCredentialCache?.();
        now = await this.deps.fingerprint(session.provider, configDir);
      } catch { now = undefined; }
      if (now === session.initial) return true;
      const restored = await this.putBack(configDir, snapshot);
      if (!restored) this.park(target.id, configDir, snapshot);
      return restored;
    })().catch(() => false).finally(() => { if (this.restoring.get(configDir) === look) this.restoring.delete(configDir); });
    this.restoring.set(configDir, look);
  }

  private finish(session: Session, state: LoginState, discard: boolean): void {
    session.snapshot = undefined;
    this.end(session);
    if (discard) this.discard(session);
    this.deps.emit(state);
  }

  private sleep(session: Session, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.sleeps.delete(timer);
        resolve();
      }, ms);
      session.sleeps.add(timer);
    });
  }

  private clearTimers(session: Session): void {
    if (session.poll) clearInterval(session.poll);
    if (session.settle) clearTimeout(session.settle);
    if (session.timeout) clearTimeout(session.timeout);
    session.poll = session.settle = session.timeout = undefined;
  }

  /** Clears every timer and forgets the session; the single place a session ends. */
  private end(session: Session): void {
    session.ended = true;
    this.clearTimers(session);
    for (const timer of session.sleeps) clearTimeout(timer);
    session.sleeps.clear();
    if (this.current === session) this.current = null;
  }

  private kill(session: Session): void {
    try {
      this.deps.killPty(session.ptyId);
    } catch {
      // the pty may already be gone
    }
  }

  private discard(session: Session): void {
    if (!session.pendingId) return;
    const id = session.pendingId;
    session.pendingId = undefined;
    try {
      this.deps.store.remove(id);
    } catch {
      // best effort; the directory is not listed anywhere
    }
  }
}
