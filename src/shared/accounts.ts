// src/shared/accounts.ts

/** Who a Claude login belongs to. accountUuid (with organizationUuid) identifies the account; e-mail and organisation name are labels and the fallback. */
export interface AccountIdentity {
  accountUuid?: string;
  organizationUuid?: string;
  email?: string;
  org?: string;
}

/**
 * Role of a saved account (0.9.1): `app` - the app holds the only copy and may renew it; `live` - the account signed in to
 * Claude Code (its profile dir is a backup that is never sent to the token endpoint); `foreign` - it left the live login
 * through another tool (cswap, /login), our copy may be outdated and is never renewed; `quarantined` - a duplicate set aside.
 */
export type AccountCustody = 'app' | 'live' | 'foreign' | 'quarantined';
/** Where the tokens in a profile dir came from: an app login (`own`) or a copy of the live login (`live`, another tool may hold the same family). */
export type TokenFamily = 'own' | 'live';

/** One Claude account known to the app (also the one signed in to Claude Code), with its own profile directory. */
export interface ManagedAccount extends AccountIdentity {
  id: string;
  addedAt: number;
  /** Absent in 0.9.0 records: `app`. */
  custody?: AccountCustody;
  /** Absent in 0.9.0 records: `live` (unknown provenance, the conservative reading). */
  family?: TokenFamily;
  /** For `quarantined`: the record that holds the account now. */
  duplicateOf?: string;
  /**
   * SHA-256 (hex, never the token) of a live refresh token that must never be copied into this record: the warning of an
   * interrupted swap was cleared while the live files may have held another account's tokens under this identity. Dropped
   * once the live login proves to be this record's own or the record is signed in again.
   */
  heldTokens?: string;
  /**
   * Set while the record is the live login because the app itself made it main (1.0.9): when that swap started (`at`),
   * the SHA-256 (hex, never the token) of the refresh token it swapped in (`from`) and whether the copy was the app's own
   * family before (`own`). When the app switches it out again these prove whether cswap may hold the tokens it leaves with
   * (see `keptOwnFamily`), so an adopted copy is not offered for renewal again after every switch. Dropped once it leaves.
   */
  appSwap?: AppSwap;
}

export interface AppSwap { at: number; from?: string; own?: true }

/** The identity last seen in the live Claude Code login and the record it belongs to. */
export interface LiveIdentity extends AccountIdentity { recordId?: string }

export type AccountNoticeKind = 'switchedOut' | 'loggedOut' | 'adopted' | 'migrated' | 'quarantined';
/** Something the app did to the saved accounts on its own, shown in the limits panel until dismissed. Never holds a token. */
export interface AccountNotice { id: string; kind: AccountNoticeKind; at: number; email?: string; recordId?: string; count?: number }

export type IdentityMatch = 'same' | 'different' | 'unknown';

export const custodyOf = (a: Pick<ManagedAccount, 'custody'>): AccountCustody => a.custody ?? 'app';
export const familyOf = (a: Pick<ManagedAccount, 'family'>): TokenFamily => a.family ?? 'live';

const norm = (value?: string): string | undefined => value?.trim().toLowerCase() || undefined;
const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

/** The four identity fields of any object, only those that are non-empty strings. */
export function identityFields(value: Partial<Record<keyof AccountIdentity, unknown>>): AccountIdentity {
  const out: AccountIdentity = {};
  for (const key of ['email', 'org', 'accountUuid', 'organizationUuid'] as const) {
    const v = nonEmpty(value[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Identity of an `oauthAccount` object as Claude Code writes it into `.claude.json`. */
export function identityFromOauthAccount(value: unknown): AccountIdentity {
  const a = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return identityFields({ email: a.emailAddress, org: a.organizationName, accountUuid: a.accountUuid, organizationUuid: a.organizationUuid });
}

/** accountUuid decides when both sides know it; otherwise the e-mail; the organisation (uuid, else name) tells two orgs of one person apart. */
export function compareIdentity(a: AccountIdentity, b: AccountIdentity): IdentityMatch {
  const orgDiffers = (): boolean => {
    if (a.organizationUuid && b.organizationUuid) return a.organizationUuid !== b.organizationUuid;
    const ao = norm(a.org);
    const bo = norm(b.org);
    return !!ao && !!bo && ao !== bo;
  };
  if (a.accountUuid && b.accountUuid) return a.accountUuid === b.accountUuid && !orgDiffers() ? 'same' : 'different';
  const ae = norm(a.email);
  const be = norm(b.email);
  if (ae && be) return ae === be && !orgDiffers() ? 'same' : 'different';
  return 'unknown';
}

/** Stable key of an account for caches and backoff (never the slot it sits in); undefined when nothing identifies it. */
export function identityKey(i: AccountIdentity): string | undefined {
  if (i.accountUuid) return `uuid:${i.accountUuid}:${i.organizationUuid ?? '-'}`;
  const email = norm(i.email);
  return email ? `email:${email}:${i.organizationUuid ?? norm(i.org) ?? '-'}` : undefined;
}

/** The identity fields `found` knows and `record` lacks (a known value is never overwritten). */
export function fillMissingIdentity(record: AccountIdentity, found: AccountIdentity): AccountIdentity {
  const patch: AccountIdentity = {};
  for (const key of ['accountUuid', 'organizationUuid', 'email', 'org'] as const) if (!record[key] && found[key]) patch[key] = found[key];
  return patch;
}

export type LoginTarget = { type: 'new' } | { type: 'main' } | { type: 'account'; id: string };

export interface LoginRequest {
  provider: 'claude' | 'codex';
  target: LoginTarget;
}

export type LoginStatus = 'waiting' | 'success' | 'failed' | 'duplicate' | 'mismatch';

export interface LoginState {
  sessionId: string;
  status: LoginStatus;
  email?: string;
  /** `mismatch` / error `restore` / `identity` of a card: the account the card belongs to (the login signed in `email` instead). */
  expected?: string;
  /** `restore`: the login was another account and the card's previous login could not be put back (`expected` names the card). */
  error?: 'timeout' | 'spawn' | 'identity' | 'restore';
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Account ids arrive over IPC and become path segments, so only UUIDs are accepted. */
export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

/** Why making a managed account the main one was refused or failed (see `swapMainAccount` in the main process). */
export const SWAP_ERRORS = ['unsupported', 'invalid', 'busy', 'envToken', 'noMain', 'noTarget', 'sameAccount', 'duplicate', 'dead', 'transient', 'write', 'manual', 'pending', 'locked', 'foreign'] as const;
export type SwapError = (typeof SWAP_ERRORS)[number];

/** Why "renew this copy in unimux" (`accounts:adoptCopy`) was refused: fixed codes only, never a path, token or system message. */
export type AdoptCopyError = 'invalid' | 'live' | 'readOnly' | 'busy' | 'pending' | 'write';
export type AdoptCopyResult = { ok: true } | { ok: false; error: AdoptCopyError };

export type SwapResult = { ok: true; email?: string } | { ok: false; error: SwapError; email?: string };

export function isSwapError(value: unknown): value is SwapError {
  return typeof value === 'string' && (SWAP_ERRORS as readonly string[]).includes(value);
}

/** Outcome of `recoverInterruptedSwap`: nothing to do, state repaired, or ambiguous (nothing modified; backup kept; tell the user to check). */
export type SwapRecovery = 'none' | 'recovered' | 'manual';

/** Outcome of restoring the pre-swap backup: done, refused (a swap runs) or not possible (nothing was changed, or check the accounts). */
