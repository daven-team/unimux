// A dead Claude login, told without sending anything anywhere. When the token endpoint rejects a refresh token for good
// (invalid_grant), Claude Code itself clears the stored login on disk ("OAuth dead-token disk clear"): `claudeAiOauth` keeps
// its plan fields but `accessToken` and `refreshToken` become empty strings and `expiresAt` 0, and the session shows
// "Login expired · Please run /login". That is the one signal used here: it is Claude Code's own verdict, it costs no
// token request, and it ends by itself as soon as anybody signs in again (the file then holds new tokens).
import { createHash } from 'crypto';
import { join } from 'path';
import type { ManagedAccount } from '../../shared/accounts';
import { isRecord, readSnap, type SwapFs } from './swap';

/** SHA-256 (hex) of a refresh token: the only form in which a dead token is remembered (`ManagedAccount.deadTokens`). */
export const deadTokenHash = (refreshToken: string): string => createHash('sha256').update(refreshToken).digest('hex');

/** True for credentials Claude Code cleared after a rejected renewal: a login object whose two tokens are empty strings. */
export function isClearedLogin(credentials: unknown): boolean {
  const oauth = isRecord(credentials) ? credentials.claudeAiOauth : undefined;
  return isRecord(oauth) && oauth.accessToken === '' && oauth.refreshToken === '';
}

/** Refresh token of a profile's saved copy, or undefined (no file, no login, unreadable). */
export async function savedRefreshToken(fs: SwapFs, dir: string): Promise<string | undefined> {
  try {
    const snap = await readSnap(fs, join(dir, '.credentials.json'));
    const oauth = snap && isRecord(snap.data.claudeAiOauth) ? snap.data.claudeAiOauth : null;
    return oauth && typeof oauth.refreshToken === 'string' && oauth.refreshToken ? oauth.refreshToken : undefined;
  } catch { return undefined; }
}

/** The record's saved copy still holds exactly the token marked dead (`deadTokens`); a new sign-in ends it. */
export async function savedCopyDead(fs: SwapFs, dir: string, record: Pick<ManagedAccount, 'deadTokens'> | undefined): Promise<boolean> {
  if (!record?.deadTokens) return false;
  const token = await savedRefreshToken(fs, dir);
  return !!token && deadTokenHash(token) === record.deadTokens;
}
