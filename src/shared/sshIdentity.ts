// SSH identities (Termius-like): a reusable login - user name, an optional vault key and an optional saved password - that
// hosts point to instead of keeping their own credentials. The identity lives in AppState next to the hosts (no secrets);
// its password is a vault entry owned by main, and main resolves host -> identity -> login at connect time (hostLogin).
// No Node or DOM imports: this file is compiled for both sides.
import type { MessageKey } from './i18n';
import { isUuid, isValidUsername, SSH_LIMITS, type SshHost } from './ssh';
import type { AppState } from './types';

export interface SshIdentity {
  id: string;
  label: string;
  username: string;
  keyId?: string;
  createdAt: number;
  updatedAt: number;
}

export const IDENTITY_LIMIT = 200;

const CONTROL = /[\u0000-\u001f\u007f]/;
const stamp = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

export function normalizeSshIdentity(raw: unknown): SshIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isUuid(r.id) || typeof r.username !== 'string') return null;
  const username = r.username.trim();
  if (!isValidUsername(username)) return null;
  const label = typeof r.label === 'string' && r.label.trim() && !CONTROL.test(r.label) ? r.label.trim().slice(0, SSH_LIMITS.label) : username;
  const identity: SshIdentity = { id: r.id, label, username, createdAt: stamp(r.createdAt), updatedAt: stamp(r.updatedAt) };
  if (isUuid(r.keyId)) identity.keyId = r.keyId;
  return identity;
}

/** The saved identities: junk, bad ids and duplicates are dropped; a state file without the list (before identities) reads as none. */
export function normalizeSshIdentities(raw: unknown): SshIdentity[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SshIdentity[] = [];
  for (const entry of raw) {
    const identity = normalizeSshIdentity(entry);
    if (!identity || seen.has(identity.id)) continue;
    seen.add(identity.id);
    out.push(identity);
    if (out.length >= IDENTITY_LIMIT) break;
  }
  return out;
}

// ── the identity form ────────────────────────────────────────────────────────

export interface SshIdentityDraft { label: string; username: string; keyId?: string }
export type IdentityDraftResult =
  | { ok: true; value: Omit<SshIdentity, 'id' | 'createdAt' | 'updatedAt'> }
  | { ok: false; errors: { username?: MessageKey } };

/** An empty label falls back to the user name (like a host falls back to its address). */
export function validateIdentityDraft(d: SshIdentityDraft): IdentityDraftResult {
  const username = d.username.trim();
  if (!isValidUsername(username)) return { ok: false, errors: { username: 'Podaj nazwę użytkownika' } };
  const label = d.label.trim() && !CONTROL.test(d.label) ? d.label.trim().slice(0, SSH_LIMITS.label) : username;
  return { ok: true, value: { label, username, ...(d.keyId && isUuid(d.keyId) ? { keyId: d.keyId } : {}) } };
}

export const identityToDraft = (i?: SshIdentity): SshIdentityDraft => ({ label: i?.label ?? '', username: i?.username ?? '', keyId: i?.keyId });

/** Like hostFormDirty: compared as it would be saved; a typed password or a saved one marked for removal is a change too. */
export function identityFormDirty(identity: SshIdentity | undefined, draft: SshIdentityDraft, typed: { password: string; clearPassword: boolean }): boolean {
  if (typed.password || typed.clearPassword) return true;
  const key = (d: SshIdentityDraft) => JSON.stringify([d.label.trim(), d.username.trim(), d.keyId ?? '']);
  if (!identity) return key(draft) !== key(identityToDraft(undefined));
  const v = validateIdentityDraft(draft);
  return key(v.ok ? identityToDraft({ ...identity, ...v.value, keyId: v.value.keyId }) : draft) !== key(identityToDraft(identity));
}

// ── resolution ───────────────────────────────────────────────────────────────

/** The identity a host points to, while it still exists. */
export const hostIdentity = (host: Pick<SshHost, 'identityId'>, identities: readonly SshIdentity[]): SshIdentity | undefined =>
  host.identityId ? identities.find((i) => i.id === host.identityId) : undefined;

/** Who signs in to a host and whose vault entry holds the password: the identity it points to, or the host itself. */
export interface HostLogin { username: string; keyId?: string; secret: { kind: 'host' | 'identity'; id: string } }

/**
 * An identity replaces every credential of the host (user name, key, password). A host whose identity was deleted meanwhile
 * (a concurrent edit; removeSshIdentity detaches it otherwise) signs in with its own fields: the user name it mirrors and its key.
 */
export function hostLogin(host: SshHost, identities: readonly SshIdentity[]): HostLogin {
  const identity = hostIdentity(host, identities);
  if (identity) return { username: identity.username, ...(identity.keyId ? { keyId: identity.keyId } : {}), secret: { kind: 'identity', id: identity.id } };
  return { username: host.username, ...(host.keyId ? { keyId: host.keyId } : {}), secret: { kind: 'host', id: host.id } };
}

/** The identities offered under the user name field: every one for an empty query, else those whose label or user name contains it. */
export function matchIdentities(identities: readonly SshIdentity[], query: string): SshIdentity[] {
  const q = query.trim().toLowerCase();
  const shown = q ? identities.filter((i) => i.label.toLowerCase().includes(q) || i.username.toLowerCase().includes(q)) : [...identities];
  return shown.sort((a, b) => a.label.localeCompare(b.label));
}

export type IdentityCredential = 'keyAndPassword' | 'key' | 'password' | 'none';

/** What an identity signs in with besides its user name (a key it names that is gone does not count). */
export function identityCredential(identity: SshIdentity, savedPasswords: readonly string[], keyIds: readonly string[]): IdentityCredential {
  const key = !!identity.keyId && keyIds.includes(identity.keyId);
  const password = savedPasswords.includes(identity.id);
  return key && password ? 'keyAndPassword' : key ? 'key' : password ? 'password' : 'none';
}

export const identityCredentialText = (c: IdentityCredential): MessageKey =>
  c === 'keyAndPassword' ? 'klucz i hasło' : c === 'key' ? 'klucz' : c === 'password' ? 'hasło' : 'tylko użytkownik';

export const hostsUsingIdentity = (hosts: readonly SshHost[], identityId: string): SshHost[] => hosts.filter((h) => h.identityId === identityId);

// ── state ────────────────────────────────────────────────────────────────────

/**
 * Adds or replaces an identity. The hosts that use it mirror its user name: everything that shows `user@host` (the host cards,
 * the SFTP and database pickers, older app versions that do not know identities) stays right without resolving the identity.
 */
export function upsertSshIdentity(s: AppState, identity: SshIdentity): AppState {
  const list = s.sshIdentities ?? [];
  const sshIdentities = list.some((i) => i.id === identity.id) ? list.map((i) => (i.id === identity.id ? identity : i)) : [...list, identity];
  const mirrored = s.sshHosts.some((h) => h.identityId === identity.id && h.username !== identity.username);
  return {
    ...s, sshIdentities,
    ...(mirrored ? { sshHosts: s.sshHosts.map((h) => (h.identityId === identity.id && h.username !== identity.username ? { ...h, username: identity.username } : h)) } : {}),
  };
}

/**
 * Deletes an identity. Its hosts are detached and keep what can be kept: the user name they mirror and the identity's key when
 * they have none of their own (its saved password goes with it: main prunes it from the vault).
 */
export function removeSshIdentity(s: AppState, identityId: string): AppState {
  const identity = (s.sshIdentities ?? []).find((i) => i.id === identityId);
  if (!identity) return s;
  return {
    ...s,
    sshIdentities: (s.sshIdentities ?? []).filter((i) => i.id !== identityId),
    sshHosts: s.sshHosts.map((h) => {
      if (h.identityId !== identityId) return h;
      const { identityId: _identityId, ...rest } = h;
      return identity.keyId && !rest.keyId ? { ...rest, keyId: identity.keyId } : rest;
    }),
  };
}
