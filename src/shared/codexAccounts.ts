/**
 * 1.1.2: several Codex accounts. Codex CLI keeps its one login in `$CODEX_HOME/auth.json` (`~/.codex` by default), next to
 * config.toml, sessions and history. The app keeps every other account in its own profile directory (a CODEX_HOME of its
 * own, signed in with `codex login` there) and "make main" copies that profile's auth.json into the live CODEX_HOME,
 * after the outgoing login was copied into its own record. Codex cells keep using the one live CODEX_HOME, so sessions,
 * resume, history and config stay where they were.
 *
 * The family rule (Codex refresh tokens are single use: a second copy of the same login dies on the first renewal of the
 * other): the app never renews a Codex token itself (only Codex CLI does, and only in the live CODEX_HOME). Each login is
 * in use in exactly one place: the live auth.json for the main account, its profile for every other. A profile copied
 * into the live file is a stale twin from then on (`liveFamily`) and never used again; the live file is copied back into
 * it when the app switches it out. Switched out by anything else (another switcher, `codex login` in a terminal), the twin
 * may be outdated (`outdated`): it is never made main nor offered for a switch until it is signed in again.
 */
import type { IdentityMatch } from './accounts';

/** Who a Codex (ChatGPT) login belongs to: the user and the workspace (`chatgpt_account_id`), e-mail as the label. */
export interface CodexIdentity {
  email?: string;
  userId?: string;
  accountId?: string;
}

export interface CodexAccount extends CodexIdentity {
  id: string;
  addedAt: number;
  /** The profile's copy is the same login as the live auth.json (it was made main): a stale twin, never used. */
  liveFamily?: true;
  /** Switched out of the live file by something else while it was main: the copy may be outdated. */
  outdated?: true;
}

export interface CodexAccountsFile {
  version: 1;
  accounts: CodexAccount[];
  /** The identity last seen in the live auth.json and its record. */
  live?: CodexIdentity & { recordId?: string };
}

const norm = (value?: string): string | undefined => value?.trim().toLowerCase() || undefined;

/** User and workspace decide when both sides know them; otherwise the e-mail (with the workspace when both know it). */
export function compareCodexIdentity(a: CodexIdentity, b: CodexIdentity): IdentityMatch {
  const workspaceDiffers = !!a.accountId && !!b.accountId && a.accountId !== b.accountId;
  if (a.userId && b.userId) return a.userId === b.userId && !workspaceDiffers ? 'same' : 'different';
  const ae = norm(a.email);
  const be = norm(b.email);
  if (ae && be) return ae === be && !workspaceDiffers ? 'same' : 'different';
  if (a.accountId && b.accountId && !a.email && !b.email) return a.accountId === b.accountId ? 'same' : 'different';
  return 'unknown';
}

/** Stable key for caches (never the slot): user and workspace, else e-mail; undefined when nothing identifies it. */
export function codexIdentityKey(i: CodexIdentity): string | undefined {
  if (i.userId) return `codex-user:${i.userId}:${i.accountId ?? '-'}`;
  const email = norm(i.email);
  return email ? `codex-email:${email}:${i.accountId ?? '-'}` : undefined;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isCodexAccountId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() && value.length <= 200 ? value : undefined);

function identityOf(raw: Record<string, unknown>): CodexIdentity {
  const out: CodexIdentity = {};
  for (const key of ['email', 'userId', 'accountId'] as const) { const v = text(raw[key]); if (v) out[key] = v; }
  return out;
}

/** Reads accounts.json of the Codex profiles; damaged records are dropped, duplicate ids keep the first. */
export function normalizeCodexAccounts(value: unknown): CodexAccountsFile {
  const r = isRecord(value) ? value : {};
  const seen = new Set<string>();
  const accounts: CodexAccount[] = [];
  for (const raw of Array.isArray(r.accounts) ? r.accounts : []) {
    if (!isRecord(raw) || !isCodexAccountId(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const addedAt = typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : 0;
    accounts.push({ id: raw.id, addedAt, ...identityOf(raw), ...(raw.liveFamily === true ? { liveFamily: true } : {}), ...(raw.outdated === true ? { outdated: true } : {}) });
  }
  const liveRaw = isRecord(r.live) ? r.live : undefined;
  const live = liveRaw ? { ...identityOf(liveRaw), ...(isCodexAccountId(liveRaw.recordId) && seen.has(liveRaw.recordId) ? { recordId: liveRaw.recordId } : {}) } : undefined;
  return { version: 1, accounts, ...(live && (live.email || live.userId || live.accountId) ? { live } : {}) };
}

/** The saved record of the account in the live auth.json, if any. */
export function liveRecordOf(accounts: CodexAccount[], live: CodexIdentity | null): CodexAccount | undefined {
  if (!live) return undefined;
  return accounts.find((account) => compareCodexIdentity(account, live) === 'same');
}

/**
 * What the live auth.json changing to `now` means for the records (called on every poll, never during a swap of the app's
 * own): the record that was main and left without the app is marked `outdated` when its copy was the live login's twin.
 * Returns the records to mark and the new live identity; `changed` false when the live account is the same as before.
 */
export function outsideSwitch(file: CodexAccountsFile, now: CodexIdentity | null): { changed: boolean; outdated: string[]; live?: CodexAccountsFile['live'] } {
  const before = file.live;
  const record = liveRecordOf(file.accounts, now);
  const live = now && (now.email || now.userId || now.accountId) ? { ...now, ...(record ? { recordId: record.id } : {}) } : undefined;
  const same = !!before && !!now && compareCodexIdentity(before, now) === 'same';
  if (same || (!before && !now)) return { changed: before?.recordId !== live?.recordId, outdated: [], ...(live ? { live } : {}) };
  const leaving = before ? (before.recordId ? file.accounts.find((a) => a.id === before.recordId) : liveRecordOf(file.accounts, before)) : undefined;
  const outdated = leaving?.liveFamily ? [leaving.id] : [];
  return { changed: true, outdated, ...(live ? { live } : {}) };
}

/** Why making a saved Codex account the main one is refused, or null (the main process checks it again with the files). */
export function codexActivationRefusal(record: CodexAccount | undefined, live: CodexIdentity | null): 'noTarget' | 'foreign' | 'sameAccount' | null {
  if (!record) return 'noTarget';
  if (live && compareCodexIdentity(record, live) === 'same') return 'sameAccount';
  if (record.outdated) return 'foreign';
  return null;
}

/** The `cli_auth_credentials_store` of a config.toml that keeps the login outside auth.json (keyring, or auto on a system with one). */
export function codexStoresInKeyring(configToml: string | null): boolean {
  if (!configToml) return false;
  // Top-level key only: everything before the first [table] header.
  const top = configToml.split(/^\s*\[/m)[0];
  const match = /^\s*cli_auth_credentials_store\s*=\s*["']?([a-z]+)["']?/m.exec(top);
  return !!match && (match[1] === 'keyring' || match[1] === 'auto');
}

/** The login command of a Codex profile: always into auth.json of that CODEX_HOME, whatever the user's config says. */
export const CODEX_PROFILE_LOGIN = 'codex login -c cli_auth_credentials_store=file';
