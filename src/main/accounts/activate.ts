// "Set as main" (0.9.1). The outgoing live login is saved into ITS record (a new record when the app does not know the
// account), then the target's login is written into Claude Code's files - all under Claude Code's credential and config
// locks, so neither Claude Code nor cswap can write in between, and with no network while they are held. The target keeps
// its profile copy as a backup that is never renewed while it is live. A version-2 journal plus backups make an interrupted
// swap recoverable; the 0.9.0 exchange in swap.ts only remains for its version-1 journals.
import { join } from 'path';
import {
  compareIdentity, custodyOf, identityFields, identityFromOauthAccount, isAccountId,
  type AccountIdentity, type ManagedAccount, type SwapError, type SwapRecovery, type SwapResult,
} from '../../shared/accounts';
import { LockTimeout, withClaudeLocks, type LockDeps } from './claudeLocks';
import type { CswapRoster } from './cswap';
import { gateFamilyRefresh } from './guards';
import { renewRule } from './refs';
import { withProfileLock, type RefreshOutcome } from './refresh';
import { heldTokenHash } from './resync';
import type { AccountsStore } from './store';
import {
  atomicWrite, claimSwap, hasPendingSwap, isRecord, nodeSwapFs, readSnap, releaseSwap, setSwapUnresolved, str, swapPaths, validOauth,
  type Snap, type SwapFs,
} from './swap';

export interface ActivateDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  store: AccountsStore;
  /** `<data>/accounts/swap-backup`, shared with the 0.9.0 swap: one pending journal blocks both. */
  backupDir: string;
  now(): number;
  /** Renews a saved profile (`refreshClaudeProfile` bound to its network deps); only called through `gateFamilyRefresh`. */
  refresh(dir: string): Promise<RefreshOutcome>;
  delay(ms: number): Promise<void>;
  /** cswap's roster (R7); `{ present: false }` without cswap. */
  cswap(): Promise<CswapRoster>;
  fs?: SwapFs;
  locks?: LockDeps;
}

type Rec = Record<string, unknown>;
type Paths = { credentials: string; claudeJson: string };
const oauthOf = (snap: Snap | null): Rec | null => (snap && isRecord(snap.data.claudeAiOauth) ? snap.data.claudeAiOauth : null);
const expiry = (o: Rec | null): number => (typeof o?.expiresAt === 'number' ? o.expiresAt : 0);

const JOURNAL = 'swap-journal.json';
const BACKUP = { liveCreds: 'live-credentials.json', liveJson: 'live-claude.json', outCreds: 'outgoing-credentials.json', outJson: 'outgoing-claude.json' };
type Phase = 'backed-up' | 'outgoing-saved' | 'live-creds-written' | 'live-json-written' | 'verified';
const ORDER: readonly Phase[] = ['backed-up', 'outgoing-saved', 'live-creds-written', 'live-json-written', 'verified'];
/** The target is renewed first only when its access token runs out within this margin: a valid token is never rotated needlessly. */
export const TARGET_FRESH_MS = 5 * 60_000;
const MIN_VALID_MS = 60_000;
/** What the family gate answers for a profile it may not renew (never a real refresh outcome: compared by identity). */
const BLOCKED: RefreshOutcome = { kind: 'transient', detail: { reason: 'blocked' } };

interface Journal { version: 2; phase: Phase; outgoingId: string; targetId: string; created: boolean; outCredsExisted: boolean; outJsonExisted: boolean; startedAt: number }

class Fail extends Error {
  constructor(readonly code: SwapError, readonly email?: string) { super(code); }
}

/** An unreadable roster holds everything (conservative, like `readCswapRoster`). */
const rosterOf = (deps: Pick<ActivateDeps, 'cswap'>): Promise<CswapRoster> => deps.cswap().catch((): CswapRoster => ({ present: true, accounts: null }));

/** The target's access token is valid for longer than TARGET_FRESH_MS: it can be swapped in without any token request. */
const freshAt = (snap: Snap | null, now: number): boolean => validOauth(oauthOf(snap)) && expiry(oauthOf(snap)) - now >= TARGET_FRESH_MS;

/**
 * Why `record` may not become the main login, or null. One rule with the renewals (`renewRule`): a record that is or may be
 * the live account is already main, and a family held elsewhere (switched out, or a copy cswap may hold) is refused,
 * because its tokens may be outdated and swapping them in could hand Claude Code a dead login. A copy cswap may hold too
 * is swapped in while its access token is `fresh` (no token request at all: only files move, under the locks); one that
 * would need renewing is refused, since the app never renews a family cswap may hold.
 */
export function activationRefusal(record: ManagedAccount | undefined, live: AccountIdentity | null, roster: CswapRoster, fresh = false): { error: SwapError; email?: string } | null {
  const named = (error: SwapError) => ({ error, ...(record?.email ? { email: record.email } : {}) });
  if (!record || custodyOf(record) === 'quarantined') return named('noTarget');
  const rule = renewRule(record, live, roster);
  if (rule === 'allowed' || (rule === 'held-by-cswap' && fresh)) return null;
  if (custodyOf(record) === 'live' || (rule === 'held-by-live' && live && compareIdentity(record, live) === 'same')) return named('sameAccount');
  return named('foreign');
}

/** The checks of the `accounts:makeMain` IPC handler: the renderer's choice is never trusted. */
export async function checkActivationTarget(deps: Pick<ActivateDeps, 'store' | 'cswap' | 'now' | 'fs'>, targetId: string): Promise<SwapResult | null> {
  const record = deps.store.get(targetId);
  let fresh = false;
  if (record && isAccountId(targetId)) {
    try { fresh = freshAt(await readSnap(deps.fs ?? nodeSwapFs, join(deps.store.dirOf(targetId), '.credentials.json')), deps.now()); } catch { fresh = false; }
  }
  const refusal = activationRefusal(record, deps.store.live(), await rosterOf(deps), fresh);
  return refusal ? { ok: false, ...refusal } : null;
}

export async function activateAccount(deps: ActivateDeps, targetId: string): Promise<SwapResult> {
  if (deps.platform === 'darwin') return { ok: false, error: 'unsupported' };
  if (!isAccountId(targetId)) return { ok: false, error: 'invalid' };
  if (!claimSwap()) return { ok: false, error: 'busy' };
  try {
    if (await hasPendingSwap(deps)) return { ok: false, error: 'pending' };
    return await perform(deps, deps.fs ?? nodeSwapFs, targetId);
  } catch (error) {
    if (error instanceof Fail) {
      if (error.code === 'manual') setSwapUnresolved(true);
      return { ok: false, error: error.code, ...(error.email ? { email: error.email } : {}) };
    }
    return { ok: false, error: error instanceof LockTimeout ? 'locked' : 'write' };
  } finally {
    releaseSwap();
  }
}

async function perform(deps: ActivateDeps, fs: SwapFs, targetId: string): Promise<SwapResult> {
  const { store } = deps;
  if (deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) throw new Fail('envToken');
  const paths = swapPaths(deps);
  if (!paths) throw new Fail('noMain');
  const target = store.get(targetId);
  const roster = await rosterOf(deps);
  const dir = store.dirOf(targetId);
  const credsPath = join(dir, '.credentials.json');
  let snap = target ? await readSnap(fs, credsPath) : null;
  const refusal = activationRefusal(target, store.live(), roster, freshAt(snap, deps.now()));
  if (refusal || !target) throw new Fail(refusal?.error ?? 'noTarget', refusal?.email);
  if (!validOauth(oauthOf(snap))) throw new Fail('noTarget', target.email);
  // Network only outside the locks, and only through the one family rule (the same gate the background renewals use).
  if (!freshAt(snap, deps.now())) {
    const renew = gateFamilyRefresh(store, () => roster, (d) => deps.refresh(d), BLOCKED);
    let outcome: RefreshOutcome;
    try { outcome = await renew(dir); } catch { outcome = { kind: 'transient' }; }
    if (outcome === BLOCKED) throw new Fail('foreign', target.email);
    if (outcome.kind === 'dead' || outcome.kind === 'unusable') throw new Fail('dead', target.email);
    snap = await readSnap(fs, credsPath);
    if (!validOauth(oauthOf(snap))) throw new Fail('noTarget', target.email);
    if (outcome.kind === 'transient' && expiry(oauthOf(snap)) <= deps.now() + MIN_VALID_MS) throw new Fail('transient', target.email);
  }
  // Profile locks first (the target and every record that may receive the outgoing login): a renewal still in flight ends
  // before Claude Code's locks are taken, and none can overwrite the copy saved under them.
  const live = store.live();
  const outgoingIds = store.list()
    .filter((r) => r.id !== targetId && custodyOf(r) !== 'quarantined' && (r.id === live?.recordId || (!!live && compareIdentity(r, live) === 'same')))
    .map((r) => r.id);
  const dirs = [dir, ...outgoingIds.map((id) => store.dirOf(id))];
  return withProfileLocks(dirs, () => withClaudeLocks(paths, () => exchange(deps, fs, paths, roster, targetId, dir, new Set(outgoingIds)), deps.locks));
}

/** Nested `withProfileLock`s, one per distinct directory. Only one activation runs at a time, so the order cannot deadlock. */
function withProfileLocks<T>(dirs: string[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(dirs)];
  return first === undefined ? fn() : withProfileLock(first, () => withProfileLocks(rest, fn));
}

interface Originals { liveCreds: Snap; liveJson: Snap; liveAccount: Rec; outCreds: Snap | null; outJson: Snap | null; outDir: string; writtenCreds: string; targetIdentity: AccountIdentity }

async function exchange(deps: ActivateDeps, fs: SwapFs, paths: Paths, roster: CswapRoster, targetId: string, dir: string, locked: Set<string>): Promise<SwapResult> {
  const { store } = deps;
  const liveCreds = await readSnap(fs, paths.credentials);
  const liveJson = await readSnap(fs, paths.claudeJson);
  const liveOauth = oauthOf(liveCreds);
  const liveAccount = liveJson && isRecord(liveJson.data.oauthAccount) ? liveJson.data.oauthAccount : null;
  const liveIdentity = identityFromOauthAccount(liveAccount);
  if (!liveCreds || !liveJson || !validOauth(liveOauth) || !liveAccount || (!liveIdentity.email && !liveIdentity.accountUuid)) throw new Fail('noMain');
  // Checked again under the locks against whoever is signed in right now (the stored live identity may lag behind).
  const target = store.get(targetId);
  const targetSnap = await readSnap(fs, join(dir, '.credentials.json'));
  const refusal = activationRefusal(target, liveIdentity, roster, freshAt(targetSnap, deps.now()));
  if (refusal || !target) throw new Fail(refusal?.error ?? 'noTarget', refusal?.email);
  const targetOauth = oauthOf(targetSnap);
  if (!validOauth(targetOauth)) throw new Fail('noTarget', target.email);
  const targetJson = await readSnap(fs, join(dir, '.claude.json'));
  const targetAccount: Rec = targetJson && isRecord(targetJson.data.oauthAccount) && str(targetJson.data.oauthAccount.emailAddress)
    ? targetJson.data.oauthAccount
    : { emailAddress: target.email, ...(target.org ? { organizationName: target.org } : {}), ...(target.accountUuid ? { accountUuid: target.accountUuid } : {}), ...(target.organizationUuid ? { organizationUuid: target.organizationUuid } : {}) };
  // The outgoing login goes into its own record (the one the app knows as live first); an account the app did not know
  // gets one, so a login is never dropped.
  const same = store.list().filter((r) => custodyOf(r) !== 'quarantined' && compareIdentity(r, liveIdentity) === 'same');
  const named = store.live()?.recordId;
  const existing = same.find((r) => r.id === named) ?? same.find((r) => custodyOf(r) === 'live') ?? same[0];
  // The live login changed after the profile locks were chosen: its record is not locked, so try again later.
  if (existing && !locked.has(existing.id)) throw new Fail('busy');
  const created = !existing;
  // Live tokens that an interrupted swap may have left under this identity (`heldTokens`) are not this account's: its own
  // saved copy stays as it is.
  const keepOutgoing = !!existing?.heldTokens && typeof liveOauth?.refreshToken === 'string' && heldTokenHash(liveOauth.refreshToken) === existing.heldTokens;
  const outgoingId = existing?.id ?? store.prepare().id;
  const outDir = store.dirOf(outgoingId);
  const outCreds = await readSnap(fs, join(outDir, '.credentials.json'));
  const outJson = await readSnap(fs, join(outDir, '.claude.json'));
  const journal: Journal = { version: 2, phase: 'backed-up', outgoingId, targetId: target.id, created, outCredsExisted: !!outCreds, outJsonExisted: !!outJson, startedAt: deps.now() };
  const write = (path: string, data: string) => atomicWrite(deps, fs, path, data);
  // The phase is advanced BEFORE each step, so it says how far the swap may have got.
  const advance = async (phase: Phase) => { journal.phase = phase; await write(join(deps.backupDir, JOURNAL), JSON.stringify(journal)); };
  const writtenCreds = JSON.stringify({ ...liveCreds.data, claudeAiOauth: targetOauth });
  try {
    // Backups inside the try: a failure before the first journal write still removes them (no live file was touched yet).
    await fs.mkdir(deps.backupDir);
    await write(join(deps.backupDir, BACKUP.liveCreds), liveCreds.text);
    await write(join(deps.backupDir, BACKUP.liveJson), liveJson.text);
    if (outCreds) await write(join(deps.backupDir, BACKUP.outCreds), outCreds.text);
    if (outJson) await write(join(deps.backupDir, BACKUP.outJson), outJson.text);
    await advance('backed-up');
    // A record for an account the app did not know is committed only once the journal names it, so a crash never leaves
    // a record without files that the recovery does not know about.
    if (created) store.commit({ id: outgoingId, addedAt: deps.now(), ...identityFields(liveIdentity), custody: 'live', family: 'live' });
    await advance('outgoing-saved');
    if (!keepOutgoing) {
      await fs.mkdir(outDir);
      await write(join(outDir, '.credentials.json'), JSON.stringify({ ...(outCreds?.data ?? {}), claudeAiOauth: liveOauth }));
      await write(join(outDir, '.claude.json'), JSON.stringify({ ...(outJson?.data ?? {}), oauthAccount: liveAccount }, null, 2));
    }
    await advance('live-creds-written');
    await write(paths.credentials, writtenCreds);
    await advance('live-json-written');
    const nowJson = await readSnap(fs, paths.claudeJson);
    await write(paths.claudeJson, JSON.stringify({ ...(nowJson?.data ?? liveJson.data), oauthAccount: targetAccount }, null, 2));
    // The locks keep Claude Code and cswap out, so the files must be exactly what was written.
    const vCreds = await readSnap(fs, paths.credentials);
    const vJson = await readSnap(fs, paths.claudeJson);
    if (vCreds?.text !== writtenCreds || !vJson || compareIdentity(identityFromOauthAccount(vJson.data.oauthAccount), identityFromOauthAccount(targetAccount)) !== 'same') throw new Fail('write');
    await advance('verified');
  } catch (error) {
    const targetIdentity = identityFromOauthAccount(targetAccount);
    const clean = await rollback(deps, fs, paths, journal, { liveCreds, liveJson, liveAccount, outCreds, outJson, outDir, writtenCreds, targetIdentity });
    if (!clean) throw new Fail('manual');
    // The record goes before the journal: a crash in between is repaired by the recovery, which removes it again.
    if (created) store.remove(outgoingId);
    await removeBackups(deps, fs);
    throw error instanceof Fail ? error : new Fail('write');
  }
  finishRoles(store, outgoingId, target.id, identityFromOauthAccount(targetAccount));
  try { await removeBackups(deps, fs); } catch { /* removed at the next start */ }
  return { ok: true, ...(str(targetAccount.emailAddress) ? { email: str(targetAccount.emailAddress) } : {}) };
}

/**
 * The roles follow the files: the outgoing record now holds the only copy of its login (the live family), the target is
 * live. Its family becomes `live` too: Claude Code renews it from now on and cswap may back it up, so once it leaves the
 * live login again it is never renewed by the app while cswap lists it. The live login is exactly its saved copy now, so
 * a hold on its tokens (`heldTokens`) is over.
 */
function finishRoles(store: AccountsStore, outgoingId: string, targetId: string, identity: AccountIdentity): void {
  store.setCustody(outgoingId, 'app');
  store.setFamily(outgoingId, 'live');
  store.setCustody(targetId, 'live');
  store.setFamily(targetId, 'live');
  store.setHeldTokens(targetId, undefined);
  store.setLive({ ...identityFields(identity), recordId: targetId });
}

/**
 * Still under the locks: every step that may have started is undone from the backups taken in this run - but only what
 * this swap wrote. A login someone else wrote meanwhile (a /login that ignores the locks, a holder that broke them as
 * stale) may be the only copy of that login: then nothing is touched, the outgoing copy stays, and the swap is 'manual'
 * with its journal and backups kept.
 */
async function rollback(deps: ActivateDeps, fs: SwapFs, paths: Paths, journal: Journal, o: Originals): Promise<boolean> {
  const reached = (phase: Phase) => ORDER.indexOf(journal.phase) >= ORDER.indexOf(phase);
  const liveId = identityFromOauthAccount(o.liveAccount);
  let creds: Snap | null = null;
  let json: Snap | null = null;
  try {
    if (reached('live-creds-written')) {
      creds = await readSnap(fs, paths.credentials);
      if (!creds || (creds.text !== o.writtenCreds && creds.text !== o.liveCreds.text)) return false;
    }
    if (reached('live-json-written')) {
      json = await readSnap(fs, paths.claudeJson);
      const now = identityFromOauthAccount(json?.data.oauthAccount);
      if (!json || (compareIdentity(now, o.targetIdentity) !== 'same' && compareIdentity(now, liveId) !== 'same')) return false;
    }
  } catch { return false; }
  let clean = true;
  const step = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { clean = false; } };
  // Each restore is guarded: the file must still be exactly what was inspected above.
  const still = (path: string, text: string) => async () => (await fs.readFile(path)) === text;
  const credsNow = creds;
  if (credsNow && credsNow.text !== o.liveCreds.text) {
    await step(() => atomicWrite(deps, fs, paths.credentials, o.liveCreds.text, still(paths.credentials, credsNow.text)));
  }
  const jsonNow = json;
  if (jsonNow && compareIdentity(identityFromOauthAccount(jsonNow.data.oauthAccount), liveId) !== 'same') {
    await step(() => atomicWrite(deps, fs, paths.claudeJson, JSON.stringify({ ...jsonNow.data, oauthAccount: o.liveAccount }, null, 2), still(paths.claudeJson, jsonNow.text)));
  }
  // The outgoing record's new copy is the only one of its login until the live files are restored.
  if (!clean) return false;
  if (reached('outgoing-saved')) {
    await step(() => (o.outCreds ? atomicWrite(deps, fs, join(o.outDir, '.credentials.json'), o.outCreds.text) : fs.rm(join(o.outDir, '.credentials.json'))));
    await step(() => (o.outJson ? atomicWrite(deps, fs, join(o.outDir, '.claude.json'), o.outJson.text) : fs.rm(join(o.outDir, '.claude.json'))));
  }
  return clean;
}

/** Temp files of the version-2 backups and journal (`<name>.<uuid>.tmp`); 0.9.0's files are left alone. */
const isV2Temp = (name: string) => [JOURNAL, ...Object.values(BACKUP)].some((base) => name.startsWith(`${base}.`) && /\.[0-9a-f-]{36}\.tmp$/.test(name));

async function removeBackups(deps: ActivateDeps, fs: SwapFs): Promise<void> {
  // The journal goes first: backups without a journal mean that no live file was modified.
  for (const name of [JOURNAL, ...Object.values(BACKUP)]) await fs.rm(join(deps.backupDir, name)).catch(() => undefined);
  for (const name of await fs.readdir(deps.backupDir)) if (isV2Temp(name)) await fs.rm(join(deps.backupDir, name)).catch(() => undefined);
  await fs.rmdir(deps.backupDir).catch(() => undefined);
}

/** 'legacy': no version-2 journal (the 0.9.0 recovery decides); 'locked': Claude Code's locks were busy, retry later. */
export type ActivationRecovery = SwapRecovery | 'legacy' | 'locked';

/** True while a version-2 recovery waits for Claude Code's locks: its journal stays, nothing reads or renews meanwhile. */
let retryPending = false;
export function isActivationRecoveryPending(): boolean { return retryPending; }

/**
 * True while a version-2 journal exists (or the journal cannot be read): the live files may be half written, so the live
 * login must not be reconciled (resync would copy the target's tokens over the outgoing record's only copy).
 */
export async function activationJournalPending(deps: Pick<ActivateDeps, 'backupDir' | 'fs'>): Promise<boolean> {
  let text: string | null;
  try { text = await (deps.fs ?? nodeSwapFs).readFile(join(deps.backupDir, JOURNAL)); } catch { return true; }
  if (text === null) return false;
  try { const info: unknown = JSON.parse(text); return !isRecord(info) || info.version === 2; } catch { return true; }
}

/** The start-up recovery: a few tries while Claude Code holds its locks; after that the polls retry (`isActivationRecoveryPending`). */
export async function recoverActivationWithRetry(deps: ActivateDeps, attempts = 3, waitMs = 1_000, stopped: () => boolean = () => false): Promise<ActivationRecovery> {
  for (let i = 1; ; i++) {
    // Once the app quits no further attempt starts (0.9.6): the journal stays and the next start retries.
    if (stopped()) return 'locked';
    const result = await recoverInterruptedActivation(deps);
    if (result !== 'locked' || i >= attempts) return result;
    await deps.delay(waitMs);
  }
}

/** How often a version-2 recovery that found Claude Code's locks busy is tried again, independent of the limits panel. */
export const RECOVERY_RETRY_MS = 30_000;

/**
 * Tries a pending version-2 recovery (`isActivationRecoveryPending`) again every `intervalMs`, also while the limits panel
 * and its polls are off: until it has run, renewals and logins stay blocked. One try at a time; `retry` runs the recovery
 * and reports its result. Returns the stop function.
 */
export function startActivationRecoveryRetry(retry: () => Promise<unknown>, intervalMs = RECOVERY_RETRY_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running || !retryPending) return;
    running = true;
    void retry().catch(() => undefined).finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Clears the warning of an unresolved swap (`clear` deletes the journal and backups; the user confirmed). A version-2 swap
 * that may have written the live credentials (phase `live-creds-written` or `live-json-written`) can have left the
 * target's tokens under the outgoing account's identity, so a backup of the live login would copy them over the outgoing
 * record's only copy: that record is marked switched out (`foreign`) and, when the live tokens are not its own saved
 * ones, they are held (`heldTokens`): never copied into it until the live login proves to be its own or it is signed in
 * again.
 */
export async function clearPendingActivation(deps: Pick<ActivateDeps, 'backupDir' | 'fs' | 'store' | 'home' | 'env'>, clear: () => Promise<boolean>): Promise<boolean> {
  const fs = deps.fs ?? nodeSwapFs;
  let suspect: string | null = null;
  let held: string | undefined;
  try {
    const text = await fs.readFile(join(deps.backupDir, JOURNAL));
    const info: unknown = text === null ? null : JSON.parse(text);
    if (isRecord(info) && info.version === 2 && isAccountId(info.outgoingId) && (info.phase === 'live-creds-written' || info.phase === 'live-json-written')) {
      suspect = info.outgoingId;
      const paths = swapPaths(deps);
      const liveRefresh = str(oauthOf(paths ? await readSnap(fs, paths.credentials) : null)?.refreshToken);
      const ownRefresh = str(oauthOf(await readSnap(fs, join(deps.store.dirOf(suspect), '.credentials.json')))?.refreshToken);
      if (liveRefresh && liveRefresh !== ownRefresh) held = heldTokenHash(liveRefresh);
    }
  } catch { /* an unreadable journal names no record */ }
  const cleared = await clear();
  if (cleared && suspect && deps.store.get(suspect)) {
    try {
      deps.store.setCustody(suspect, 'foreign');
      if (held) deps.store.setHeldTokens(suspect, held);
    } catch { /* accounts.json read-only: nothing reconciles or backs up meanwhile either */ }
  }
  return cleared;
}

/**
 * Call at app start, before the 0.9.0 recovery; 'legacy' means there is no version-2 journal and recoverInterruptedSwap
 * decides. Version-2 backups without any journal (a crash before the first journal write) are deleted first: no live file
 * was modified before that write. Busy Claude Code locks give 'locked': the journal stays and the swap is NOT marked
 * unresolved, so nobody is invited to clear a state the next try can still repair.
 */
export async function recoverInterruptedActivation(deps: ActivateDeps): Promise<ActivationRecovery> {
  const fs = deps.fs ?? nodeSwapFs;
  let text: string | null;
  // An unreadable journal is not a missing one: nothing is deleted then. Without a version-2 journal no version-2 recovery
  // waits any more, so a pending retry stops (the legacy recovery and the pending warning take over).
  try { text = await fs.readFile(join(deps.backupDir, JOURNAL)); } catch { retryPending = false; return 'legacy'; }
  if (text === null) {
    retryPending = false;
    if (claimSwap()) {
      try {
        // Re-checked under the slot: only without a journal are the backups orphans.
        if ((await fs.readFile(join(deps.backupDir, JOURNAL))) === null) {
          for (const name of Object.values(BACKUP)) await fs.rm(join(deps.backupDir, name));
          for (const name of await fs.readdir(deps.backupDir)) if (isV2Temp(name)) await fs.rm(join(deps.backupDir, name));
          await fs.rmdir(deps.backupDir).catch(() => undefined);
        }
      } catch { /* the legacy recovery and the pending warning take over */ } finally { releaseSwap(); }
    }
    return 'legacy';
  }
  let info: unknown;
  try { info = JSON.parse(text); } catch { retryPending = false; return 'legacy'; }
  if (!isRecord(info) || info.version !== 2) { retryPending = false; return 'legacy'; }
  if (!claimSwap()) return 'none';
  try {
    const result = await recoverV2(deps, fs, info);
    retryPending = result === 'locked';
    if (result !== 'locked') setSwapUnresolved(result === 'manual');
    return result;
  } catch {
    retryPending = false;
    setSwapUnresolved(true);
    return 'manual';
  } finally {
    releaseSwap();
  }
}

async function recoverV2(deps: ActivateDeps, fs: SwapFs, info: Rec): Promise<SwapRecovery | 'locked'> {
  const { store } = deps;
  const phase = info.phase as Phase;
  const { outgoingId, targetId } = info;
  if (!ORDER.includes(phase) || !isAccountId(outgoingId) || !isAccountId(targetId)) return 'manual';
  const paths = swapPaths(deps);
  if (phase === 'verified') {
    // The outgoing record holds the live family it received either way. The other roles only when the target is still
    // the one signed in; otherwise the login changed since and reconcile assigns them from what is signed in now.
    const target = store.get(targetId);
    const liveJson = paths ? await readSnap(fs, paths.claudeJson) : null;
    const liveId = identityFromOauthAccount(liveJson?.data.oauthAccount);
    if (target && custodyOf(target) !== 'quarantined' && compareIdentity(liveId, target) === 'same') finishRoles(store, outgoingId, targetId, liveId);
    else if (store.get(outgoingId)) store.setFamily(outgoingId, 'live');
    await removeBackups(deps, fs);
    return 'none';
  }
  if (phase === 'backed-up') {
    // The record before the journal: a crash in between leaves the journal, and the next start removes it again.
    if (info.created === true) store.remove(outgoingId);
    await removeBackups(deps, fs);
    return 'none';
  }
  if (!paths) return 'manual';
  const read = (name: string) => fs.readFile(join(deps.backupDir, name));
  const liveB = await read(BACKUP.liveCreds);
  const liveJsonB = await read(BACKUP.liveJson);
  const outCredsB = await read(BACKUP.outCreds);
  const outJsonB = await read(BACKUP.outJson);
  if (liveB === null || liveJsonB === null) return 'manual';
  if ((info.outCredsExisted === true && outCredsB === null) || (info.outJsonExisted === true && outJsonB === null)) return 'manual';
  let liveAccountB: unknown;
  try { liveAccountB = (JSON.parse(liveJsonB) as Rec).oauthAccount; } catch { return 'manual'; }
  if (!isRecord(liveAccountB)) return 'manual';
  try {
    const targetRecord = store.get(targetId);
    return await withClaudeLocks(paths, async (): Promise<SwapRecovery> => {
      const live = await readSnap(fs, paths.credentials);
      const targetCreds = await readSnap(fs, join(store.dirOf(targetId), '.credentials.json'));
      const untouched = live?.text === liveB;
      // Still exactly the target's login that was written (nobody renewed it since): the old one may go back.
      const liveRefresh = str(oauthOf(live)?.refreshToken);
      const ours = !!liveRefresh && liveRefresh === str(oauthOf(targetCreds)?.refreshToken);
      if (!untouched && !ours) return 'manual';
      // The identity too must be the old one or the target's; anything else was written by someone else and is kept.
      const nowJson = await readSnap(fs, paths.claudeJson);
      const nowId = identityFromOauthAccount(nowJson?.data.oauthAccount);
      const oldJson = !!nowJson && compareIdentity(nowId, identityFromOauthAccount(liveAccountB)) === 'same';
      if (nowJson && !oldJson && !(targetRecord && compareIdentity(nowId, targetRecord) === 'same')) return 'manual';
      if (!untouched) await atomicWrite(deps, fs, paths.credentials, liveB);
      if (nowJson && !oldJson) {
        await atomicWrite(deps, fs, paths.claudeJson, JSON.stringify({ ...nowJson.data, oauthAccount: liveAccountB }, null, 2));
      }
      const outDir = store.dirOf(outgoingId);
      if (outCredsB !== null) await atomicWrite(deps, fs, join(outDir, '.credentials.json'), outCredsB); else await fs.rm(join(outDir, '.credentials.json'));
      if (outJsonB !== null) await atomicWrite(deps, fs, join(outDir, '.claude.json'), outJsonB); else await fs.rm(join(outDir, '.claude.json'));
      if (info.created === true) store.remove(outgoingId);
      await removeBackups(deps, fs);
      return 'recovered';
    }, deps.locks);
  } catch (error) {
    return error instanceof LockTimeout ? 'locked' : 'manual';
  }
}
