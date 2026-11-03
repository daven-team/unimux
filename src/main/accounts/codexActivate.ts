// src/main/accounts/codexActivate.ts - 1.1.2: "make main" for a saved Codex account and the look at the live Codex login
// before every poll. Only files move: no token is ever sent anywhere (see shared/codexAccounts for the family rule).
import { createHash } from 'crypto';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SwapResult } from '../../shared/accounts';
import { codexActivationRefusal, codexStoresInKeyring, compareCodexIdentity, liveRecordOf, outsideSwitch, type CodexIdentity } from '../../shared/codexAccounts';
import { decodeJwtClaims } from '../usage/parse';
import { atomicWriteFileSync } from '../atomicWrite';
import type { CodexAccountsStore } from './codexStore';

export interface CodexActivateDeps {
  store: CodexAccountsStore;
  /** The live CODEX_HOME (CODEX_HOME, else ~/.codex). */
  liveHome(): string;
  now(): number;
  /** File contents or null (missing, unreadable); a test seam. */
  readText?(path: string): string | null;
  writeText?(path: string, text: string): void;
}

const readText = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const writeText = (path: string, text: string): void => atomicWriteFileSync(path, text, { mode: 0o600 });

let running = false;
/** True while a Codex "make main" moves files (a login, a poll's look at the live file and another switch wait). */
export function isCodexSwapRunning(): boolean { return running; }

export interface CodexLogin {
  identity: CodexIdentity;
  /** Signed in with ChatGPT (tokens) rather than an API key. */
  chatgpt: boolean;
  /** SHA-256 of the refresh token (never the token), for comparing copies. */
  refreshHash?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Who an auth.json belongs to, or null when it holds no usable login. Never returns a token. */
export function parseCodexAuth(raw: string | null): CodexLogin | null {
  if (!raw) return null;
  let auth: unknown;
  try { auth = JSON.parse(raw); } catch { return null; }
  if (!isRecord(auth)) return null;
  const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
    return typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY ? { identity: {}, chatgpt: false } : null;
  }
  const idClaims = typeof tokens.id_token === 'string' ? decodeJwtClaims(tokens.id_token) : null;
  const accessClaims = decodeJwtClaims(tokens.access_token);
  const claim = idClaims?.['https://api.openai.com/auth'] ?? accessClaims?.['https://api.openai.com/auth'];
  const authClaim = isRecord(claim) ? claim : {};
  const identity: CodexIdentity = {};
  if (typeof idClaims?.email === 'string' && idClaims.email) identity.email = idClaims.email;
  const userId = [authClaim.chatgpt_user_id, authClaim.user_id].find((v): v is string => typeof v === 'string' && !!v);
  if (userId) identity.userId = userId;
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id ? tokens.account_id : typeof authClaim.chatgpt_account_id === 'string' ? authClaim.chatgpt_account_id : undefined;
  if (accountId) identity.accountId = accountId;
  const refresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token ? createHash('sha256').update(tokens.refresh_token).digest('hex') : undefined;
  return { identity, chatgpt: true, ...(refresh ? { refreshHash: refresh } : {}) };
}

/** The live login's identity (null: none, or an API key). */
export function readLiveCodexIdentity(deps: Pick<CodexActivateDeps, 'liveHome' | 'readText'>): CodexIdentity | null {
  const login = parseCodexAuth((deps.readText ?? readText)(join(deps.liveHome(), 'auth.json')));
  return login?.chatgpt ? login.identity : null;
}

/**
 * Before every poll (never during a Codex swap): records who is in the live auth.json and marks the copy of an account that
 * left it without the app as possibly outdated (`outdated`). Returns the live identity.
 */
export function reconcileCodexLive(deps: Pick<CodexActivateDeps, 'store' | 'liveHome' | 'readText'>): CodexIdentity | null {
  const live = readLiveCodexIdentity(deps);
  if (running || deps.store.readOnly()) return live;
  const result = outsideSwitch(deps.store.snapshot(), live);
  if (!result.changed) return live;
  try {
    for (const id of result.outdated) deps.store.patch(id, { outdated: true, liveFamily: undefined });
    deps.store.setLive(result.live ?? null);
  } catch { /* read-only meanwhile: tried again on the next poll */ }
  return live;
}

/** Why a saved Codex account cannot be made main now, or null; the same checks `activateCodexAccount` makes first. */
export function checkCodexTarget(deps: CodexActivateDeps, id: string): SwapResult | null {
  const record = deps.store.get(id);
  const named = (error: 'noTarget' | 'foreign' | 'sameAccount' | 'invalid' | 'unsupported' | 'busy') => ({ ok: false as const, error, ...(record?.email ? { email: record.email } : {}) });
  if (running) return named('busy');
  if (deps.store.readOnly()) return named('busy');
  const read = deps.readText ?? readText;
  // A config that keeps the login in the system keyring would ignore the auth.json the swap writes.
  if (codexStoresInKeyring(read(join(deps.liveHome(), 'config.toml')))) return named('unsupported');
  const refusal = codexActivationRefusal(record, readLiveCodexIdentity(deps));
  if (refusal) return named(refusal);
  const target = parseCodexAuth(read(join(deps.store.dirOf(id), 'auth.json')));
  if (!target) return named('invalid');
  return null;
}

/**
 * Makes a saved Codex account the main one: the outgoing live auth.json is copied into its own record first (a new record
 * when it has none, so no login is ever dropped) and into one emergency copy, then the target's auth.json replaces the live
 * one atomically. Running Codex processes keep running; Codex reads the file again before it renews a token and skips a
 * renewal when the account in it changed, so it never writes the outgoing login back over the new one.
 */
export async function activateCodexAccount(deps: CodexActivateDeps, id: string): Promise<SwapResult> {
  const refusal = checkCodexTarget(deps, id);
  if (refusal) return refusal;
  running = true;
  try {
    const read = deps.readText ?? readText;
    const write = deps.writeText ?? writeText;
    const record = deps.store.get(id)!;
    const targetRaw = read(join(deps.store.dirOf(id), 'auth.json'));
    const target = parseCodexAuth(targetRaw);
    if (!targetRaw || !target) return { ok: false, error: 'invalid', ...(record.email ? { email: record.email } : {}) };
    const liveHome = deps.liveHome();
    const livePath = join(liveHome, 'auth.json');
    const outgoingRaw = read(livePath);
    const outgoing = parseCodexAuth(outgoingRaw);
    if (outgoing && outgoingRaw) {
      // The emergency copy first (one, overwritten each time), then the outgoing account's own record.
      const backupDir = join(deps.store.root, 'swap-backup');
      mkdirSync(backupDir, { recursive: true });
      write(join(backupDir, 'auth.json'), outgoingRaw);
      if (outgoing.chatgpt) {
        let holder = liveRecordOf(deps.store.list(), outgoing.identity);
        if (!holder) {
          const prepared = deps.store.prepare();
          write(join(prepared.dir, 'auth.json'), outgoingRaw);
          deps.store.commit({ id: prepared.id, addedAt: deps.now(), ...outgoing.identity });
          holder = deps.store.get(prepared.id);
        } else {
          write(join(deps.store.dirOf(holder.id), 'auth.json'), outgoingRaw);
          // Its copy is the newest login now and the only one in use: no longer a twin, no longer outdated.
          deps.store.patch(holder.id, { liveFamily: undefined, outdated: undefined, ...outgoing.identity });
        }
      }
    }
    mkdirSync(liveHome, { recursive: true });
    write(livePath, targetRaw);
    const check = parseCodexAuth(read(livePath));
    if (!check || (target.chatgpt && compareCodexIdentity(check.identity, target.identity) !== 'same')) return { ok: false, error: 'write', ...(record.email ? { email: record.email } : {}) };
    deps.store.patch(id, { liveFamily: true, outdated: undefined });
    deps.store.setLive(target.chatgpt ? { ...target.identity, recordId: id } : null);
    return { ok: true, ...(target.identity.email ?? record.email ? { email: target.identity.email ?? record.email } : {}) };
  } catch {
    return { ok: false, error: 'write' };
  } finally {
    running = false;
  }
}
