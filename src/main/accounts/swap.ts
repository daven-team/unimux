// src/main/accounts/swap.ts
import { randomUUID } from 'crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join } from 'path';
import { isAccountId, type SwapError, type SwapRecovery, type SwapResult } from '../../shared/accounts';
import { withProfileLock, type RefreshOutcome } from './refresh';
import type { AccountsStore } from './store';

/*
 * Making a managed account the MAIN one is an EXCHANGE of two login blobs, never a copy: OAuth refresh tokens rotate,
 * so two live copies of one login would invalidate each other. The target's `claudeAiOauth` + `oauthAccount` move to
 * the machine's own Claude config, the old main login moves into the target's profile directory.
 *
 * Guiding principle: a token's lineage follows its POSITION, never stale bytes. Claude Code may rotate the main token
 * at any moment, so every step works on the CURRENT content of the shared files (read again right before each write,
 * guarded by an unchanged-since-read check before every rename attempt), and a rollback is a reverse exchange of the
 * current blobs - it never writes an old copy over a newer token.
 *
 * Crash safety: every file is replaced atomically (temp file + rename). Before anything is written the files that are
 * about to change are copied to `backupDir` (owner-only) and a `swap-journal.json` (account id, timestamp, phase, no
 * secrets) is written; the phase is advanced BEFORE each step starts, so it says how far the swap may have got.
 * After a verified swap the backups and the journal are DELETED (live tokens must not linger). They are kept only
 * when a rollback was not clean or the state is ambiguous. `recoverInterruptedSwap` decides once from the phase and
 * from which login (A = old main, X = the target's) each file's refresh token belongs to; when that is not provable
 * it modifies no credential file and reports 'manual'. On Windows the mode bits are ignored; the directory inherits
 * the ACL of %APPDATA%\unimux (the user's profile), no extra ACL is set.
 */

export interface SwapFs {
  /** File text, or null when the file does not exist; other read errors throw. */
  readFile(path: string): Promise<string | null>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** File names in a directory (empty when it does not exist). */
  readdir(path: string): Promise<string[]>;
  /** Removes an EMPTY directory; errors are for the caller to ignore. */
  rmdir(path: string): Promise<void>;
}

/** A missing file is null; any other read error (EIO, EACCES ...) is thrown so it is never mistaken for an absent file. */
function missingOrThrow(error: unknown): null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return null;
  throw error;
}

export const nodeSwapFs: SwapFs = {
  readFile: (path) => readFile(path, 'utf8').catch(missingOrThrow),
  stat: (path) => stat(path).then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }), missingOrThrow),
  writeFile: (path, data, mode) => writeFile(path, data, { mode }),
  rename,
  rm: (path) => rm(path, { force: true }),
  mkdir: (path) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined),
  readdir: (path) => readdir(path).catch((error) => missingOrThrow(error) ?? []),
  rmdir: (path) => rmdir(path),
};

export interface SwapDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  store: Pick<AccountsStore, 'list' | 'dirOf' | 'update'>;
  /** `<userData>/accounts/swap-backup`. */
  backupDir: string;
  now(): number;
  /** Renews a managed profile (`refreshClaudeProfile` bound to its network deps). */
  refresh(dir: string): Promise<RefreshOutcome>;
  delay(ms: number): Promise<void>;
  fs?: SwapFs;
}

type Rec = Record<string, unknown>;
export const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
export const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_RETRIES = 5;
const MAX_TRIES = 3;
const EXPIRY_MARGIN_MS = 60_000;
/** How long Claude Code gets to write its own refresh result before we trust what we wrote. */
const SETTLE_MS = 1500;
const TEMP_NAME = /^\.(credentials|claude)\.json\.[0-9a-f-]{36}\.tmp$/;
const JOURNAL = 'swap-journal.json';
const BACKUP = { mainCreds: 'main-credentials.json', mainJson: 'main-claude.json', targetCreds: 'target-credentials.json', targetJson: 'target-claude.json' };

type Phase = 'backed-up' | 'target-written' | 'main-creds-written' | 'main-json-written' | 'rolling-back' | 'verified';

class Fail extends Error {
  constructor(readonly code: SwapError) { super(code); }
}
/** A shared file changed between our read and our rename; the caller re-reads and recomputes. */
class Changed extends Error {}
/** Main credentials no longer hold what we wrote: whose lineage they are cannot be proven, so nothing more is touched. */
class Unprovable extends Error {}

let running = false;
/** Set synchronously whenever a swap or recovery left its journal and backups behind (checked by background refreshes). */
let unresolved = false;
export function isSwapUnresolved(): boolean { return unresolved; }
/** True while a swap runs; the login flow must not start meanwhile. */
export function isSwapRunning(): boolean { return running; }
/** Takes the one swap slot (swaps, recoveries and reconciliations of the live login share it); false while it is taken. */
export function claimSwap(): boolean {
  if (running) return false;
  running = true;
  return true;
}
/** Frees the slot; everyone waiting for it to be free (the quit, swapIdle) learns it at once. */
export function releaseSwap(): void {
  running = false;
  for (const resolve of idleWaiters.splice(0)) resolve();
}
const idleWaiters: Array<() => void> = [];
/** Resolves once no swap, "Set as main" activation, recovery or reconcile holds the slot (at once when none does). */
export function swapIdle(): Promise<void> {
  return running ? new Promise((resolve) => { idleWaiters.push(resolve); }) : Promise.resolve();
}
/** Set by the 0.9.1 activation and its recovery when they leave a journal and backups behind (or clear them). */
export function setSwapUnresolved(value: boolean): void { unresolved = value; }

export interface Snap { text: string; data: Rec; sig: string }
interface Identity { uuid?: string; email: string; org?: string }

/** Where the main login lives, or null when CLAUDE_CONFIG_DIR is set but not absolute (never resolved against the cwd). */
export function swapPaths(deps: Pick<SwapDeps, 'home' | 'env'>): { credentials: string; claudeJson: string } | null {
  const custom = deps.env.CLAUDE_CONFIG_DIR?.trim();
  if (custom && !isAbsolute(custom)) return null;
  const configDir = custom || join(deps.home, '.claude');
  return { credentials: join(configDir, '.credentials.json'), claudeJson: custom ? join(custom, '.claude.json') : join(deps.home, '.claude.json') };
}

export async function readSnap(fs: SwapFs, path: string): Promise<Snap | null> {
  const before = await fs.stat(path);
  const text = await fs.readFile(path);
  if (text === null || !before) return null;
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? { text, data, sig: `${before.mtimeMs}:${before.size}` } : null;
  } catch { return null; }
}

/** True while the file is still exactly what `snap` read (checked again before every rename attempt). */
const unchanged = (fs: SwapFs, path: string, snap: Snap) => async (): Promise<boolean> => {
  const now = await readSnap(fs, path);
  return now !== null && now.sig === snap.sig && now.text === snap.text;
};

async function retry<T>(deps: Pick<SwapDeps, 'delay'>, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (i >= MAX_RETRIES || typeof code !== 'string' || !RETRY_CODES.has(code)) throw error;
      await deps.delay(50 + ((i * 17) % 51));
    }
  }
}

/** Temp file next to the target + rename. `guard` runs before EVERY rename attempt; false means the file changed meanwhile. */
export async function atomicWrite(deps: Pick<SwapDeps, 'delay'>, fs: SwapFs, path: string, data: string, guard?: () => Promise<boolean>): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await retry(deps, () => fs.writeFile(temp, data, 0o600));
    await retry(deps, async () => {
      if (guard && !(await guard())) throw new Changed();
      await fs.rename(temp, path);
    });
  } catch (error) {
    await fs.rm(temp).catch(() => undefined);
    throw error;
  }
}

function identityOf(account: unknown, fallback?: { email?: string; org?: string }): Identity | null {
  const a = isRecord(account) ? account : {};
  const email = str(a.emailAddress) ?? str(fallback?.email);
  if (!email) return null;
  const org = str(a.organizationName) ?? (a.emailAddress === undefined || str(a.emailAddress) === undefined ? str(fallback?.org) : undefined);
  return { uuid: str(a.accountUuid), email: email.toLowerCase(), org: org?.toLowerCase() };
}

/** Conservative: an unknown organisation or a missing uuid never makes two logins look different. */
function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.uuid && b.uuid) return a.uuid === b.uuid;
  if (a.email !== b.email) return false;
  return a.org === undefined || b.org === undefined || a.org === b.org;
}

const oauthOf = (data: Rec): Rec | null => (isRecord(data.claudeAiOauth) ? data.claudeAiOauth : null);
export const validOauth = (o: Rec | null): o is Rec => o !== null && !!str(o.accessToken) && !!str(o.refreshToken);

interface Paths { credentials: string; claudeJson: string }
interface State {
  mainCreds: Snap; mainJson: Snap; targetCreds: Snap; targetJson: Snap | null;
  mainOauth: Rec; targetOauth: Rec; mainAccount: Rec; targetAccount: Rec;
  mainIdentity: Identity; targetIdentity: Identity;
}

async function inspect(deps: SwapDeps, fs: SwapFs, paths: Paths, accountId: string): Promise<State> {
  const entry = deps.store.list().find((a) => a.id === accountId);
  if (!entry) throw new Fail('noTarget');
  const targetDir = deps.store.dirOf(accountId);
  const mainCreds = await readSnap(fs, paths.credentials);
  const mainJson = await readSnap(fs, paths.claudeJson);
  const mainOauth = mainCreds ? oauthOf(mainCreds.data) : null;
  if (!mainCreds || !mainJson || !validOauth(mainOauth)) throw new Fail('noMain');
  const mainAccount = isRecord(mainJson.data.oauthAccount) ? mainJson.data.oauthAccount : null;
  const mainIdentity = identityOf(mainAccount);
  if (!mainAccount || !mainIdentity) throw new Fail('noMain');

  const targetCreds = await readSnap(fs, join(targetDir, '.credentials.json'));
  const targetOauth = targetCreds ? oauthOf(targetCreds.data) : null;
  if (!targetCreds || !targetOauth || !str(targetOauth.accessToken)) throw new Fail('noTarget');
  const targetJson = await readSnap(fs, join(targetDir, '.claude.json'));
  const fileAccount = targetJson && isRecord(targetJson.data.oauthAccount) ? targetJson.data.oauthAccount : null;
  const targetIdentity = identityOf(fileAccount, entry);
  if (!targetIdentity) throw new Fail('noTarget');
  // An account object without an e-mail is completed from the stored entry.
  const targetAccount: Rec = fileAccount
    ? (str(fileAccount.emailAddress) ? fileAccount : { ...fileAccount, emailAddress: entry.email, ...(entry.org && !str(fileAccount.organizationName) ? { organizationName: entry.org } : {}) })
    : { emailAddress: entry.email, ...(entry.org ? { organizationName: entry.org } : {}) };
  if (sameIdentity(mainIdentity, targetIdentity)) throw new Fail('sameAccount');

  for (const other of deps.store.list()) {
    if (other.id === accountId) continue;
    const otherJson = await readSnap(fs, join(deps.store.dirOf(other.id), '.claude.json'));
    const otherIdentity = identityOf(otherJson?.data.oauthAccount, other);
    if (otherIdentity && sameIdentity(otherIdentity, mainIdentity)) throw new Fail('duplicate');
  }
  return { mainCreds, mainJson, targetCreds, targetJson, mainOauth, targetOauth, mainAccount, targetAccount, mainIdentity, targetIdentity };
}

/** True while an earlier swap left a journal or backups behind (they are the only proof of whose login is whose). */
export async function hasPendingSwap(deps: Pick<SwapDeps, 'backupDir' | 'fs'>): Promise<boolean> {
  return ((await (deps.fs ?? nodeSwapFs).readdir(deps.backupDir)).length) > 0;
}

/** Deletes the journal and backups for good (the user confirmed). Refused while a swap runs. */
export async function clearPendingSwap(deps: Pick<SwapDeps, 'backupDir' | 'fs'>): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    const fs = deps.fs ?? nodeSwapFs;
    const names = await fs.readdir(deps.backupDir);
    for (const name of [...names.filter((n) => n === JOURNAL), ...names.filter((n) => n !== JOURNAL)]) await fs.rm(join(deps.backupDir, name));
    await fs.rmdir(deps.backupDir).catch(() => undefined);
    const empty = (await fs.readdir(deps.backupDir)).length === 0;
    if (empty) unresolved = false;
    return empty;
  } catch { return false; } finally { releaseSwap(); }
}

/**
 * @deprecated 0.9.0 exchange; no longer wired (0.9.1 uses activateAccount). Kept because recoverInterruptedSwap must still
 * repair its version-1 journals and its tests build those states.
 * Swaps the main Claude login with the one saved in managed account `accountId`. Never throws; never exposes a token.
 */
export async function swapMainAccount(deps: SwapDeps, accountId: string): Promise<SwapResult> {
  if (deps.platform === 'darwin') return { ok: false, error: 'unsupported' };
  if (!isAccountId(accountId)) return { ok: false, error: 'invalid' };
  if (running) return { ok: false, error: 'busy' };
  running = true;
  try {
    if (await hasPendingSwap(deps)) return { ok: false, error: 'pending' };
    return await perform(deps, deps.fs ?? nodeSwapFs, accountId);
  } catch (error) {
    if (error instanceof Fail && error.code === 'manual') unresolved = true;
    return { ok: false, error: error instanceof Fail ? error.code : 'write' };
  } finally {
    releaseSwap();
  }
}

async function perform(deps: SwapDeps, fs: SwapFs, accountId: string): Promise<SwapResult> {
  if (deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) throw new Fail('envToken');
  const paths = swapPaths(deps);
  if (!paths) throw new Fail('noMain');
  await inspect(deps, fs, paths, accountId);

  const targetDir = deps.store.dirOf(accountId);
  let outcome: RefreshOutcome;
  try { outcome = await deps.refresh(targetDir); } catch { outcome = { kind: 'transient' }; }
  if (outcome.kind === 'dead' || outcome.kind === 'unusable') throw new Fail('dead');
  return withProfileLock(targetDir, () => runSwap(deps, fs, paths, accountId, targetDir, outcome.kind === 'transient'));
}

interface Ctx {
  deps: SwapDeps; fs: SwapFs; paths: Paths; s: State; accountId: string;
  targetCredsPath: string; targetJsonPath: string;
  targetCredsWritten: boolean; targetJsonWritten: boolean; mainCredsReplaced: boolean; mainJsonReplaced: boolean;
  phase: Phase | null;
  /** Exact text we wrote to main credentials (null until then). */
  writtenMainCreds: string | null;
}

const write = (c: Ctx, path: string, data: string, guard?: () => Promise<boolean>) => atomicWrite(c.deps, c.fs, path, data, guard);

async function journal(c: Ctx, phase: Phase): Promise<void> {
  if (c.phase === phase) return;
  await write(c, join(c.deps.backupDir, JOURNAL), JSON.stringify({ version: 1, accountId: c.accountId, startedAt: c.deps.now(), phase, targetJsonExisted: c.s.targetJson !== null }));
  c.phase = phase;
}

/**
 * Moves the CURRENT main blob into the target profile and `toMain` into main. Main is re-read on every try and guarded
 * right before every rename attempt; when Claude Code wrote meanwhile the target copy is recomputed from the fresh blob.
 */
async function exchangeCreds(c: Ctx, toMain: Rec, journaled: boolean, expectText?: string): Promise<void> {
  let displaced: string | null = null;
  let touched = false;
  try {
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      const main = await readSnap(c.fs, c.paths.credentials);
      const mainOauth = main ? oauthOf(main.data) : null;
      if (!main || !validOauth(mainOauth)) throw new Fail('write');
      if (expectText !== undefined && main.text !== expectText) throw new Unprovable();
      const target = await readSnap(c.fs, c.targetCredsPath);
      // The backup always holds the CURRENT blob of both logins, so a token rotated since the first snapshot is never in no file.
      // Forward: the old main login is main's current blob, the target's login is its original. Reverse: the other way round.
      const backupDir = c.deps.backupDir;
      if (journaled) await write(c, join(backupDir, BACKUP.mainCreds), main.text);
      else {
        await write(c, join(backupDir, BACKUP.mainCreds), JSON.stringify({ claudeAiOauth: toMain }));
        await write(c, join(backupDir, BACKUP.targetCreds), JSON.stringify({ claudeAiOauth: mainOauth }));
      }
      if (journaled) await journal(c, 'target-written');
      if (displaced === null) displaced = target?.text ?? c.s.targetCreds.text;
      touched = true;
      await write(c, c.targetCredsPath, JSON.stringify({ ...(target?.data ?? c.s.targetCreds.data), claudeAiOauth: mainOauth }));
      c.targetCredsWritten = true;
      if (journaled) await journal(c, 'main-creds-written');
      try {
        const text = JSON.stringify({ ...main.data, claudeAiOauth: toMain });
        await write(c, c.paths.credentials, text, unchanged(c.fs, c.paths.credentials, main));
        c.mainCredsReplaced = true;
        c.writtenMainCreds = text;
        return;
      } catch (error) { if (!(error instanceof Changed)) throw error; }
    }
    throw new Fail('write');
  } catch (error) {
    // Whatever failed after the target was overwritten: the blob it displaced is put back first (it may be the only live copy).
    if (touched && displaced !== null) await write(c, c.targetCredsPath, displaced).catch(() => undefined);
    throw error;
  }
}

/** Sets one key of a JSON file from its current content (guarded and recomputed on change when `guarded`). */
async function setKey(deps: SwapDeps, fs: SwapFs, path: string, key: string, value: unknown, guarded: boolean, accept?: (data: Rec) => boolean, indent: number | undefined = 2): Promise<void> {
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const snap = await readSnap(fs, path);
    if (!snap || (accept && !accept(snap.data))) throw new Fail('write');
    try {
      await atomicWrite(deps, fs, path, JSON.stringify({ ...snap.data, [key]: value }, null, indent), guarded ? unchanged(fs, path, snap) : undefined);
      return;
    } catch (error) { if (!(error instanceof Changed)) throw error; }
  }
  throw new Fail('write');
}

async function removeBackups(deps: SwapDeps, fs: SwapFs): Promise<void> {
  // The journal goes first: a crash in between leaves backups without a journal, which means no credential file was modified.
  for (const name of [JOURNAL, ...Object.values(BACKUP)]) await fs.rm(join(deps.backupDir, name)).catch(() => undefined);
  for (const name of await fs.readdir(deps.backupDir)) if (/\.[0-9a-f-]{36}\.tmp$/.test(name)) await fs.rm(join(deps.backupDir, name)).catch(() => undefined);
  await fs.rmdir(deps.backupDir).catch(() => undefined);
}

/** Only our own leftover temp files (`.credentials.json.<uuid>.tmp`, `.claude.json.<uuid>.tmp`) in the config dirs. */
async function removeStaleTemps(deps: SwapDeps, fs: SwapFs): Promise<void> {
  const paths = swapPaths(deps);
  const dirs = new Set<string>(paths ? [dirname(paths.credentials), dirname(paths.claudeJson)] : []);
  for (const account of deps.store.list()) { try { dirs.add(deps.store.dirOf(account.id)); } catch { /* invalid id */ } }
  for (const dir of dirs) {
    for (const name of await fs.readdir(dir)) if (TEMP_NAME.test(name)) await fs.rm(join(dir, name)).catch(() => undefined);
  }
}

async function runSwap(deps: SwapDeps, fs: SwapFs, paths: Paths, accountId: string, targetDir: string, requireValidToken: boolean): Promise<SwapResult> {
  const s = await inspect(deps, fs, paths, accountId);
  if (requireValidToken) {
    const expiresAt = s.targetOauth.expiresAt;
    if (typeof expiresAt !== 'number' || expiresAt <= deps.now() + EXPIRY_MARGIN_MS) throw new Fail('transient');
  }
  const c: Ctx = {
    deps, fs, paths, s, accountId, targetCredsPath: join(targetDir, '.credentials.json'), targetJsonPath: join(targetDir, '.claude.json'),
    targetCredsWritten: false, targetJsonWritten: false, mainCredsReplaced: false, mainJsonReplaced: false, phase: null, writtenMainCreds: null,
  };
  const jr = (phase: Phase) => journal(c, phase);

  try {
    await fs.mkdir(deps.backupDir);
    await write(c, join(deps.backupDir, BACKUP.mainCreds), s.mainCreds.text);
    await write(c, join(deps.backupDir, BACKUP.mainJson), s.mainJson.text);
    await write(c, join(deps.backupDir, BACKUP.targetCreds), s.targetCreds.text);
    if (s.targetJson) await write(c, join(deps.backupDir, BACKUP.targetJson), s.targetJson.text);
    else await fs.rm(join(deps.backupDir, BACKUP.targetJson));
    await jr('backed-up');

    // 1. target profile: identity, then credentials (together with main credentials)
    await jr('target-written');
    await write(c, c.targetJsonPath, JSON.stringify({ ...(s.targetJson?.data ?? {}), oauthAccount: s.mainAccount }, null, 2));
    c.targetJsonWritten = true;
    await exchangeCreds(c, s.targetOauth, true);
    await settle(c);

    // 2. main identity
    await jr('main-json-written');
    await setKey(deps, fs, paths.claudeJson, 'oauthAccount', s.targetAccount, true, (data) => {
      const id = identityOf(data.oauthAccount);
      return id !== null && sameIdentity(id, s.mainIdentity);
    });
    c.mainJsonReplaced = true;
    await settle(c);

    // 3. verify by reading everything back (a refreshed access token is fine; identity and a usable login are checked)
    const main = await readSnap(fs, paths.credentials);
    const mainJson = await readSnap(fs, paths.claudeJson);
    const target = await readSnap(fs, c.targetCredsPath);
    const targetJson = await readSnap(fs, c.targetJsonPath);
    const mainIdentity = identityOf(mainJson?.data.oauthAccount);
    const targetIdentity = identityOf(targetJson?.data.oauthAccount);
    if (!main || main.text !== c.writtenMainCreds || !validOauth(oauthOf(main.data)) || !target || !validOauth(oauthOf(target.data)) || !mainIdentity || !targetIdentity
      || !sameIdentity(mainIdentity, s.targetIdentity) || !sameIdentity(targetIdentity, s.mainIdentity)) throw new Fail('write');
    // Last look right before 'verified' is persisted: Claude Code may have written main credentials or .claude.json since.
    // Then nothing is declared done or deleted, and the user is told to check.
    const lastCreds = await readSnap(fs, paths.credentials);
    const lastJson = await readSnap(fs, paths.claudeJson);
    const lastIdentity = identityOf(lastJson?.data.oauthAccount);
    if (!lastCreds || lastCreds.text !== c.writtenMainCreds || !lastIdentity || !sameIdentity(lastIdentity, s.targetIdentity)) throw new Unprovable();
    await jr('verified');
  } catch (error) {
    if (error instanceof Unprovable) throw new Fail('manual');
    const clean = await rollback(c, jr);
    if (!clean) throw new Fail('manual');
    await removeBackups(deps, fs);
    throw error instanceof Fail && error.code !== 'manual' ? error : new Fail('write');
  }

  // The label goes first and cleanup is best effort: a completed swap never turns into an error because a file could not be
  // deleted (a leftover 'verified' journal or journal-less backups are removed by the next start).
  try {
    deps.store.update(accountId, { email: str(s.mainAccount.emailAddress), org: str(s.mainAccount.organizationName) });
  } catch { /* the swap itself is done; only the list label is stale */ }
  try { await removeBackups(deps, fs); } catch { /* removed at the next start */ }
  return { ok: true, email: str(s.targetAccount.emailAddress) };
}

/** Gives Claude Code time to write its own result, then requires main credentials to still be exactly what we wrote. */
async function settle(c: Ctx): Promise<void> {
  await c.deps.delay(SETTLE_MS);
  const now = await readSnap(c.fs, c.paths.credentials);
  if (!now || now.text !== c.writtenMainCreds) throw new Unprovable();
}

/**
 * Undoes a failed swap on the CURRENT content. Before main was replaced only the target profile was touched and its
 * own originals go back. Afterwards it is a reverse exchange: the blob now in main (the target account's login,
 * possibly rotated by Claude Code) returns to the target profile and the blob now in the target profile (the old
 * main login) returns to main. Returns false when anything could not be undone (nothing is retried then).
 */
async function rollback(c: Ctx, jr: (phase: Phase) => Promise<void>): Promise<boolean> {
  const { deps, fs, s } = c;
  let clean = true;
  let moved: Rec | null = null;
  const step = async (fn: () => Promise<void>) => { try { await fn(); } catch { clean = false; } };
  if (c.mainCredsReplaced) {
    await step(() => jr('rolling-back'));
    await step(async () => {
      const target = await readSnap(fs, c.targetCredsPath);
      const back = target ? oauthOf(target.data) : null;
      if (!validOauth(back)) throw new Fail('manual');
      moved = back;
      await exchangeCreds(c, back, false, c.writtenMainCreds ?? undefined);
    });
  } else if (c.targetCredsWritten) {
    await step(() => write(c, c.targetCredsPath, s.targetCreds.text));
  }
  // After a failed credential step the identities stay as they are: resetting them would label a profile with a login it does not hold.
  if (c.targetJsonWritten && clean) {
    await step(() => (s.targetJson ? write(c, c.targetJsonPath, s.targetJson.text) : fs.rm(c.targetJsonPath)));
  }
  if (c.mainCredsReplaced && clean) {
    await step(async () => {
      const now = await readSnap(fs, c.paths.claudeJson);
      const id = now ? identityOf(now.data.oauthAccount) : null;
      if (id && sameIdentity(id, s.mainIdentity)) return;
      await setKey(deps, fs, c.paths.claudeJson, 'oauthAccount', s.mainAccount, true);
    });
  }
  // Only a verified rollback may be reported as "nothing was changed".
  await step(async () => {
    if (!clean) return;
    if (c.mainCredsReplaced) {
      const main = await readSnap(fs, c.paths.credentials);
      const now = main ? oauthOf(main.data) : null;
      if (!moved || !now || now.refreshToken !== moved.refreshToken) throw new Fail('manual');
    } else if (c.targetCredsWritten) {
      const target = await readSnap(fs, c.targetCredsPath);
      if (!target || target.text !== s.targetCreds.text) throw new Fail('manual');
    }
  });
  return clean;
}

type Lineage = 'A' | 'X' | 'unknown' | 'none';

/**
 * Call once at app start. Decides once for the whole interrupted swap from the journal phase and from which login each
 * credentials file holds (A = the old main login, X = the target's), by refresh token against the backups. It acts
 * only when that is provable; otherwise nothing is modified, backup and journal stay, and 'manual' is returned.
 * Only the `claudeAiOauth` / `oauthAccount` keys are ever written.
 */
export async function recoverInterruptedSwap(deps: SwapDeps): Promise<SwapRecovery> {
  if (running) return 'none';
  running = true; // no swap may race the recovery
  try {
    const result = await recover(deps);
    unresolved = result === 'manual';
    return result;
  } catch { unresolved = true; return 'manual'; } finally { releaseSwap(); }
}

async function recover(deps: SwapDeps): Promise<SwapRecovery> {
  const fs = deps.fs ?? nodeSwapFs;
  const journalText = await fs.readFile(join(deps.backupDir, JOURNAL));
  if (journalText === null) {
    // No journal: it is written before the first credential file changes, so nothing was modified. Stray backups
    // (a crash while they were being made) only hold live tokens and go away.
    try { await removeBackups(deps, fs); await removeStaleTemps(deps, fs); } catch { /* best effort */ }
    return 'none';
  }
  let info: unknown;
  try { info = JSON.parse(journalText); } catch { info = null; }
  if (!isRecord(info) || !isAccountId(info.accountId) || typeof info.phase !== 'string') return 'manual';
  const accountId = info.accountId;
  const phase = info.phase as Phase;
  if (phase === 'verified') {
    // The swap was complete; only the label of the saved account may still show the old owner. But if main holds the
    // old main login again (a stale write), the old target login may exist only in the backup: keep everything.
    try {
      const path = swapPaths(deps);
      const aText = await fs.readFile(join(deps.backupDir, BACKUP.mainCreds));
      const aRefresh = aText === null ? undefined : str(oauthOf(JSON.parse(aText) as Rec)?.refreshToken);
      const main = path ? await readSnap(fs, path.credentials) : null;
      const mainRefresh = main ? str(oauthOf(main.data)?.refreshToken) : undefined;
      if (aRefresh !== undefined && mainRefresh !== undefined && aRefresh === mainRefresh) return 'manual';
    } catch { return 'manual'; }
    try {
      const text = await fs.readFile(join(deps.backupDir, BACKUP.mainJson));
      const acct = text === null ? null : (JSON.parse(text) as Rec).oauthAccount;
      if (isRecord(acct)) deps.store.update(accountId, { email: str(acct.emailAddress), org: str(acct.organizationName) });
    } catch { /* label only */ }
  }
  if (phase === 'verified' || phase === 'backed-up') { await removeBackups(deps, fs); await removeStaleTemps(deps, fs).catch(() => undefined); return 'none'; }
  const paths = swapPaths(deps);
  if (!paths) return 'manual';

  const read = async (name: string) => {
    const text = await fs.readFile(join(deps.backupDir, name));
    try { const data: unknown = text === null ? null : JSON.parse(text); return isRecord(data) ? data : null; } catch { return null; }
  };
  const mainCredsB = await read(BACKUP.mainCreds);
  const mainJsonB = await read(BACKUP.mainJson);
  const targetCredsB = await read(BACKUP.targetCreds);
  const targetJsonB = await read(BACKUP.targetJson);
  const aBlob = mainCredsB ? oauthOf(mainCredsB) : null;
  const xBlob = targetCredsB ? oauthOf(targetCredsB) : null;
  if (!validOauth(aBlob) || !validOauth(xBlob) || !mainJsonB || !isRecord(mainJsonB.oauthAccount)) return 'manual';
  const accountA = mainJsonB.oauthAccount;

  const classify = (snap: Snap | null): Lineage => {
    const o = snap ? oauthOf(snap.data) : null;
    const refresh = o ? str(o.refreshToken) : undefined;
    if (!refresh) return 'none';
    return refresh === aBlob.refreshToken ? 'A' : refresh === xBlob.refreshToken ? 'X' : 'unknown';
  };

  const targetDir = deps.store.dirOf(accountId);
  const targetCredsPath = join(targetDir, '.credentials.json');
  const targetJsonPath = join(targetDir, '.claude.json');
  try {
    const outcome = await withProfileLock(targetDir, async (): Promise<SwapRecovery> => {
      const mainSnap = await readSnap(fs, paths.credentials);
      const main = classify(mainSnap);
      const targetSnap = await readSnap(fs, targetCredsPath);
      const target = classify(targetSnap);
      const refreshOf = (snap: Snap | null) => { const o = snap ? oauthOf(snap.data) : null; return o ? str(o.refreshToken) : undefined; };
      const shared = refreshOf(mainSnap) !== undefined && refreshOf(mainSnap) === refreshOf(targetSnap);
      const entry = deps.store.list().find((a) => a.id === accountId);
      const accountX: Rec = targetJsonB && isRecord(targetJsonB.oauthAccount)
        ? targetJsonB.oauthAccount
        : { emailAddress: entry?.email, ...(entry?.org ? { organizationName: entry.org } : {}) };
      const setTargetAccount = async (value: Rec | undefined) => {
        const cur = await readSnap(fs, targetJsonPath);
        if (value === undefined) {
          if (!cur) return;
          const { oauthAccount: _drop, ...rest } = cur.data;
          if (Object.keys(rest).length === 0) await fs.rm(targetJsonPath);
          else await atomicWrite(deps, fs, targetJsonPath, JSON.stringify(rest, null, 2));
          return;
        }
        await atomicWrite(deps, fs, targetJsonPath, JSON.stringify({ ...(cur?.data ?? {}), oauthAccount: value }, null, 2));
      };
      const setMainAccount = async (value: Rec) => {
        const cur = await readSnap(fs, paths.claudeJson);
        const id = cur ? identityOf(cur.data.oauthAccount) : null;
        const want = identityOf(value);
        if (id && want && sameIdentity(id, want)) return;
        await setKey(deps, fs, paths.claudeJson, 'oauthAccount', value, true);
      };

      if (shared && main !== 'X' && (phase === 'target-written' || phase === 'main-creds-written')) {
        // Identical tokens: the target copy provably came from main (forward), so the target gets its own login back.
        await atomicWrite(deps, fs, targetCredsPath, JSON.stringify({ ...(targetSnap?.data ?? {}), claudeAiOauth: xBlob }));
        await setTargetAccount(targetJsonB && isRecord(targetJsonB.oauthAccount) ? targetJsonB.oauthAccount : undefined);
        await setMainAccount(accountA);
        return 'recovered';
      }
      if (shared && main === 'X' && phase === 'rolling-back') {
        // Reverse exchange: the target copy came from main (the target login X); the old main login A returns to the target.
        await atomicWrite(deps, fs, targetCredsPath, JSON.stringify({ ...(targetSnap?.data ?? {}), claudeAiOauth: aBlob }));
        await setTargetAccount(accountA);
        await setMainAccount(accountX);
        try { deps.store.update(accountId, { email: str(accountA.emailAddress), org: str(accountA.organizationName) }); } catch { /* label only */ }
        return 'recovered';
      }
      const originalPositions = main === 'A' && target === 'X';
      const targetCopiedOnly = main === 'A' && target === 'A' && (phase === 'target-written' || phase === 'main-creds-written' || phase === 'main-json-written');
      if (originalPositions || targetCopiedOnly) {
        // Main still holds exactly the old main login: the target profile gets its own login back.
        if (targetCopiedOnly) await atomicWrite(deps, fs, targetCredsPath, JSON.stringify({ ...(targetSnap?.data ?? {}), claudeAiOauth: xBlob }));
        await setTargetAccount(targetJsonB && isRecord(targetJsonB.oauthAccount) ? targetJsonB.oauthAccount : undefined);
        await setMainAccount(accountA);
        return 'recovered';
      }
      if (main === 'X' && target === 'A' && (phase === 'main-creds-written' || phase === 'main-json-written' || phase === 'rolling-back')) {
        // The credentials were exchanged: finish the identity half.
        await setTargetAccount(accountA);
        await setMainAccount(accountX);
        try { deps.store.update(accountId, { email: str(accountA.emailAddress), org: str(accountA.organizationName) }); } catch { /* label only */ }
        return 'recovered';
      }
      return 'manual';
    });
    if (outcome === 'recovered') { await removeBackups(deps, fs); await removeStaleTemps(deps, fs).catch(() => undefined); }
    return outcome;
  } catch {
    return 'manual';
  }
}

