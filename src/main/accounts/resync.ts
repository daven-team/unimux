// Keeps the active account's profile dir a current backup of the live login (cswap's _resync_rotated_backup), so an account
// switched out by another tool is not lost. Read under Claude Code's credential lock (never a half-written switch or refresh)
// and only when the live identity proves the bytes are this account's. The lock is held for the two reads only; the copy is
// written after it is released, so Claude Code never waits for our disk writes or for a profile job. A `live` record's copy
// is never sent to the token endpoint.
import { createHash } from 'crypto';
import { join } from 'path';
import { compareIdentity, identityFromOauthAccount, type AccountIdentity } from '../../shared/accounts';
import { LockTimeout, withClaudeLocks, type LockDeps } from './claudeLocks';
import { deadTokenHash, isClearedLogin } from './dead';
import { withProfileLock } from './refresh';
import type { AccountsStore } from './store';
import { atomicWrite, isRecord, nodeSwapFs, readSnap, type SwapFs } from './swap';

/**
 * `settling`: the live files changed since the previous look; nothing is copied until they read the same twice in a row.
 * `held`: the live tokens are the ones held for this record (`heldTokens`, an interrupted swap may have left another
 * account's tokens under its identity): nothing is copied, its own saved copy stays.
 * `dead`: Claude Code cleared this account's live login after a rejected renewal (see dead.ts): nothing is copied, and the
 * record's saved copy (the same token family, so dead too) is marked dead (`deadTokens`).
 */
export type ResyncResult = 'copied' | 'unchanged' | 'mismatch' | 'missing' | 'locked' | 'settling' | 'held' | 'dead';

/** SHA-256 (hex) of a refresh token, the only form in which a held token is kept (`ManagedAccount.heldTokens`). */
export const heldTokenHash = (refreshToken: string): string => createHash('sha256').update(refreshToken).digest('hex');

export interface ResyncDeps {
  paths: { credentials: string; claudeJson: string };
  store: Pick<AccountsStore, 'dirOf' | 'setFamily' | 'get' | 'setHeldTokens' | 'setDeadTokens'>;
  delay(ms: number): Promise<void>;
  fs?: SwapFs;
  locks?: LockDeps;
  /**
   * Signature of the live files at the previous look, per record (kept by the caller across polls). Claude Code writes the
   * credentials and `.claude.json` separately (a `/login` can be seen with the new tokens and the old identity), so new tokens
   * are copied only once the tokens and the identity read the same as last time. The map keeps only the record looked at
   * last (others are dropped, so removed records never linger). A look is remembered even when the copy then fails, so the
   * next poll with the same files retries the copy at once. Absent: copied at once (tests of the copy itself).
   */
  seen?: Map<string, string>;
}

/**
 * `sig`: SHA-256 of the credentials text and of the `oauthAccount` object only (kept in memory only). The rest of
 * `.claude.json` (stats, projects, counters) changes all the time and must not keep a backup waiting.
 */
type Live = { oauth: Record<string, unknown>; account: unknown; sig: string };

export async function resyncActiveBackup(deps: ResyncDeps, recordId: string, expected: AccountIdentity): Promise<ResyncResult> {
  const fs = deps.fs ?? nodeSwapFs;
  let live: Live | ResyncResult;
  try {
    // Only the credential lock: cswap's switch and Claude Code's refresh hold it; the config lock is taken by Claude Code on
    // almost every config write and is not needed for a consistent read.
    live = await withClaudeLocks(deps.paths, async (): Promise<Live | ResyncResult> => {
      const creds = await readSnap(fs, deps.paths.credentials);
      const json = await readSnap(fs, deps.paths.claudeJson);
      const oauth = creds && isRecord(creds.data.claudeAiOauth) ? creds.data.claudeAiOauth : null;
      if (creds && json && isClearedLogin(creds.data)) {
        return compareIdentity(identityFromOauthAccount(json.data.oauthAccount), expected) === 'same' ? 'dead' : 'mismatch';
      }
      if (!creds || !json || !oauth || typeof oauth.refreshToken !== 'string' || !oauth.refreshToken) return 'missing';
      const account = json.data.oauthAccount;
      if (compareIdentity(identityFromOauthAccount(account), expected) !== 'same') return 'mismatch';
      return { oauth, account, sig: createHash('sha256').update(creds.text).update('|').update(JSON.stringify(account) ?? '').digest('hex') };
    }, { ...deps.locks, credentialsOnly: true });
  } catch (error) {
    if (error instanceof LockTimeout) return 'locked';
    throw error;
  }
  if (live === 'dead') {
    const dir = deps.store.dirOf(recordId);
    // The saved copy is the live family the record kept backing up, so it went with the live login. Tokens held as not the
    // record's own (`heldTokens`) prove nothing about its copy: then nothing is marked.
    await withProfileLock(dir, async () => {
      const own = await readSnap(fs, join(dir, '.credentials.json'));
      const ownOauth = own && isRecord(own.data.claudeAiOauth) ? own.data.claudeAiOauth : null;
      const token = typeof ownOauth?.refreshToken === 'string' ? ownOauth.refreshToken : '';
      const record = deps.store.get(recordId);
      if (token && record && !record.heldTokens) deps.store.setDeadTokens(recordId, deadTokenHash(token));
    });
    return 'dead';
  }
  if (typeof live === 'string') return live;
  const { oauth, account, sig } = live;
  const previous = deps.seen?.get(recordId);
  if (deps.seen) { for (const key of [...deps.seen.keys()]) if (key !== recordId) deps.seen.delete(key); deps.seen.set(recordId, sig); }
  const dir = deps.store.dirOf(recordId);
  return withProfileLock(dir, async (): Promise<ResyncResult> => {
    const own = await readSnap(fs, join(dir, '.credentials.json'));
    const ownOauth = own && isRecord(own.data.claudeAiOauth) ? own.data.claudeAiOauth : null;
    const ownJson = await readSnap(fs, join(dir, '.claude.json'));
    const sameTokens = !!ownOauth && ownOauth.refreshToken === oauth.refreshToken && ownOauth.accessToken === oauth.accessToken;
    const sameAccount = !!ownJson && JSON.stringify(ownJson.data.oauthAccount) === JSON.stringify(account);
    const held = deps.store.get(recordId)?.heldTokens;
    if (held) {
      // The hold ends once the live login is a different one (rewritten since) or exactly the record's own saved copy.
      if (heldTokenHash(String(oauth.refreshToken)) === held && !(ownOauth && ownOauth.refreshToken === oauth.refreshToken)) return 'held';
      deps.store.setHeldTokens(recordId, undefined);
    }
    if (sameTokens && sameAccount) return 'unchanged';
    // New tokens wait until both live files are stable; an identity-only change (organisation renamed) is copied at once.
    if (!sameTokens && deps.seen && previous !== sig) return 'settling';
    await fs.mkdir(dir);
    if (!sameTokens) await atomicWrite(deps, fs, join(dir, '.credentials.json'), JSON.stringify({ ...(own?.data ?? {}), claudeAiOauth: oauth }));
    if (!sameAccount) await atomicWrite(deps, fs, join(dir, '.claude.json'), JSON.stringify({ ...(ownJson?.data ?? {}), oauthAccount: account }, null, 2));
    if (!sameTokens) { deps.store.setFamily(recordId, 'live'); deps.store.setDeadTokens(recordId, undefined); }
    return 'copied';
  });
}
