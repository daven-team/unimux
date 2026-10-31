// src/main/usage/credentials.ts
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { identityFromOauthAccount, type AccountIdentity } from '../../shared/accounts';
import { decodeJwtClaims } from './parse';

/** Where credentials come from; replaceable in tests. Everything here is read-only. */
export interface CredentialSource {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** File contents, or null when the file is missing or unreadable. */
  readFile(path: string): Promise<string | null>;
  /** Claude Code's Keychain secret on macOS, or null. */
  keychain(): Promise<string | null>;
  /** Forgets a remembered failed Keychain read (login flows need fresh reads). */
  resetKeychainCache?(): void;
}

/**
 * Remembers a null result (denied, missing, timed out) for `holdMs` so a system prompt is not raised on every
 * regular usage poll. The cache can be dropped with `reset()`: a login flow must see the credentials the moment
 * they are written, so it resets before every read it makes (the user is actively logging in then, so a
 * Keychain prompt is expected, and login polls run at most every 1.5 s for 10 min).
 */
export function withFailureCache(read: () => Promise<string | null>, holdMs: number, now: () => number = Date.now): (() => Promise<string | null>) & { reset(): void } {
  let holdUntil = 0;
  const cached = async () => {
    if (now() < holdUntil) return null;
    const value = await read();
    if (value === null) holdUntil = now() + holdMs;
    return value;
  };
  return Object.assign(cached, { reset: () => { holdUntil = 0; } });
}

const KEYCHAIN_HOLD_MS = 30 * 60_000;

export function systemCredentialSource(): CredentialSource {
  const keychain = withFailureCache(() => new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  }), KEYCHAIN_HOLD_MS);
  return {
    env: process.env,
    home: homedir(),
    platform: process.platform,
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    keychain,
    resetKeychainCache: () => keychain.reset(),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The same source seen through an isolated Claude profile: its own config dir, no env token, never the Keychain. */
export function profileSource(source: CredentialSource, configDir: string): CredentialSource {
  return { ...source, env: { ...source.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: '' }, platform: 'linux' };
}

/** Who a Claude login belongs to, from the config file Claude Code keeps next to it (read only). */
export async function readClaudeIdentity(source: CredentialSource): Promise<AccountIdentity> {
  const directory = source.env.CLAUDE_CONFIG_DIR?.trim();
  const raw = await source.readFile(directory ? join(directory, '.claude.json') : join(source.home, '.claude.json'));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return identityFromOauthAccount(isRecord(parsed) ? parsed.oauthAccount : undefined);
  } catch { return {}; }
}

/** The live Claude Code config exists but cannot be read or parsed (locked, a directory, half written): who is signed in is unknown. */
export class LiveIdentityUnknown extends Error {
  constructor() { super('live Claude config unreadable'); this.name = 'LiveIdentityUnknown'; }
}

/**
 * Who is signed in to Claude Code, for the account roles: null only when nobody is (no config file, or a config that parses
 * and has no account). Any other read error or a file that does not parse (Claude Code may be writing it) throws
 * `LiveIdentityUnknown`, so a busy file is never taken for a sign-out. Never includes a path or system message.
 */
export async function readLiveClaudeIdentity(
  source: Pick<CredentialSource, 'env' | 'home'>,
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<AccountIdentity | null> {
  const directory = source.env.CLAUDE_CONFIG_DIR?.trim();
  let raw: string;
  try {
    raw = await read(directory ? join(directory, '.claude.json') : join(source.home, '.claude.json'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new LiveIdentityUnknown();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new LiveIdentityUnknown(); }
  if (!isRecord(parsed)) throw new LiveIdentityUnknown();
  const identity = identityFromOauthAccount(parsed.oauthAccount);
  return identity.email || identity.accountUuid ? identity : null;
}

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt?: number;
  plan?: string;
  /** A refresh token is stored, so Claude Code can renew an expired access token by itself. The token itself is never exposed. */
  hasRefresh?: boolean;
  /** SHA-256 of the refresh token, to tell whether two logins share one token without ever holding it elsewhere. */
  refreshHash?: string;
}

/** Cheap change marker (mtime and size) of the Claude credentials file, or null when it cannot be statted (missing, Keychain). */
export async function claudeCredentialsStamp(source: CredentialSource): Promise<string | null> {
  const directory = source.env.CLAUDE_CONFIG_DIR?.trim() || join(source.home, '.claude');
  try {
    const info = await stat(join(directory, '.credentials.json'));
    return `${info.mtimeMs}:${info.size}`;
  } catch { return null; }
}

export function claudePlanLabel(subscriptionType?: unknown, rateLimitTier?: unknown): string | undefined {
  if (typeof subscriptionType !== 'string' || !subscriptionType) return undefined;
  const name = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1).toLowerCase();
  const multiplier = typeof rateLimitTier === 'string' ? /(\d+)x/i.exec(rateLimitTier)?.[1] : undefined;
  return multiplier ? `${name} ${multiplier}x` : name;
}

export async function readClaudeCredentials(source: CredentialSource): Promise<ClaudeCredentials | null> {
  const fromEnv = source.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return { accessToken: fromEnv };
  const directory = source.env.CLAUDE_CONFIG_DIR?.trim() || join(source.home, '.claude');
  let raw = await source.readFile(join(directory, '.credentials.json'));
  if (!raw && source.platform === 'darwin') raw = await source.keychain();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : undefined;
    const token = oauth?.accessToken;
    if (!oauth || typeof token !== 'string' || !token) return null;
    return {
      accessToken: token,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
      hasRefresh: typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0,
      ...(typeof oauth.refreshToken === 'string' && oauth.refreshToken ? { refreshHash: createHash('sha256').update(oauth.refreshToken).digest('hex') } : {}),
      plan: claudePlanLabel(oauth.subscriptionType, oauth.rateLimitTier),
    };
  } catch { return null; }
}

/**
 * A Claude login that Claude Code itself cleared after the token endpoint rejected its refresh token for good (see
 * accounts/dead.ts): the login object is still there with its plan, but both tokens are empty strings. Null for anything
 * else (a usable login, no login at all, the environment token, an unreadable file). Never holds a token.
 */
export async function readClearedClaudeLogin(source: CredentialSource): Promise<{ plan?: string } | null> {
  if (source.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return null;
  const directory = source.env.CLAUDE_CONFIG_DIR?.trim() || join(source.home, '.claude');
  let raw = await source.readFile(join(directory, '.credentials.json'));
  if (!raw && source.platform === 'darwin') raw = await source.keychain();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : undefined;
    if (!oauth || oauth.accessToken !== '' || oauth.refreshToken !== '') return null;
    return { plan: claudePlanLabel(oauth.subscriptionType, oauth.rateLimitTier) };
  } catch { return null; }
}

export interface CodexCredentials {
  mode: 'chatgpt' | 'apiKey';
  accessToken?: string;
  accountId?: string;
  expiresAt?: number;
  plan?: string;
  email?: string;
}

export async function readCodexCredentials(source: CredentialSource): Promise<CodexCredentials | null> {
  const directory = source.env.CODEX_HOME?.trim() || join(source.home, '.codex');
  const raw = await source.readFile(join(directory, 'auth.json'));
  if (!raw) return null;
  let auth: unknown;
  try { auth = JSON.parse(raw); } catch { return null; }
  if (!isRecord(auth)) return null;
  const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
  const accessToken = typeof tokens?.access_token === 'string' && tokens.access_token ? tokens.access_token : undefined;
  if (!tokens || !accessToken) return typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY ? { mode: 'apiKey' } : null;
  const idClaims = typeof tokens.id_token === 'string' ? decodeJwtClaims(tokens.id_token) : null;
  const accessClaims = decodeJwtClaims(accessToken);
  const authClaim = idClaims?.['https://api.openai.com/auth'] ?? accessClaims?.['https://api.openai.com/auth'];
  const plan = isRecord(authClaim) && typeof authClaim.chatgpt_plan_type === 'string' ? authClaim.chatgpt_plan_type : undefined;
  return {
    mode: 'chatgpt',
    accessToken,
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : undefined,
    expiresAt: typeof accessClaims?.exp === 'number' ? accessClaims.exp * 1000 : undefined,
    plan,
    email: typeof idClaims?.email === 'string' ? idClaims.email : undefined,
  };
}
