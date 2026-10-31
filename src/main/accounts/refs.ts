// The Claude cards of the limits panel: one per account. The live login is read through Claude Code's files and never
// renewed here; a saved account is renewed only when its token family lives nowhere else (R6).
import { compareIdentity, custodyOf, familyOf, identityKey, type AccountNotice, type LiveIdentity, type ManagedAccount } from '../../shared/accounts';
import type { AccountRef, SetAsideAccount } from '../../shared/usage';
import { cswapHolds, type CswapRoster } from './cswap';

export type RenewRule = NonNullable<AccountRef['renew']>;

/**
 * The one rule for which saved Claude profiles this app may send to the token endpoint (the card's `renew` and the
 * refresh gate `gateFamilyRefresh` both use it): never a record that is or was the live login, never one with the live
 * identity, and never a copy of the live family (`family: live`, also a 0.9.0 record) that cswap may hold as well.
 */
export function renewRule(record: ManagedAccount, live: LiveIdentity | null, cswap: CswapRoster): RenewRule {
  const custody = custodyOf(record);
  // A set-aside duplicate is never renewed: another record holds the account (callers also skip it, as defence in depth).
  if (custody === 'quarantined') return 'switched-out';
  if (custody === 'foreign') return 'switched-out';
  // Like cswapHolds: only a proven different identity lets a record be renewed while someone is signed in.
  if (custody === 'live' || (live && compareIdentity(record, live) !== 'different')) return 'held-by-live';
  if (familyOf(record) === 'live' && cswapHolds(cswap, record)) return 'held-by-cswap';
  return 'allowed';
}

/**
 * What the limits panel tells about records that have no card: set-aside cards (quarantined without a holder - a failed
 * restore, or a copy whose holder was removed - or parked while their restore is retried) and the copies whose holder still
 * exists (only those may be deleted as "a copy").
 */
export function accountsPanelInfo(records: ManagedAccount[], parkedIds: string[]): { setAside: SetAsideAccount[]; duplicateCopies: string[] } {
  const parked = new Set(parkedIds);
  const ids = new Set(records.map((r) => r.id));
  const quarantined = (r: ManagedAccount) => custodyOf(r) === 'quarantined';
  const isCopy = (r: ManagedAccount) => quarantined(r) && !!r.duplicateOf && ids.has(r.duplicateOf) && r.duplicateOf !== r.id;
  return {
    setAside: records
      .filter((r) => !parked.has(r.id) ? quarantined(r) && !isCopy(r) : true)
      .map((r) => ({ recordId: r.id, ...(r.email ? { email: r.email } : {}), restoring: parked.has(r.id) })),
    duplicateCopies: records.filter((r) => isCopy(r) && !parked.has(r.id)).map((r) => r.id),
  };
}

/**
 * The notices the limits panel shows. An outside switch (`switchedOut`, 0.9.1 to 1.0.9) is no longer a banner (1.0.10): the
 * card of the account that left says it in one line, or "Sign-in expired" when that login was dead. Older ones stay hidden.
 */
export function panelNotices(notices: AccountNotice[]): AccountNotice[] {
  return notices.filter((notice) => notice.kind !== 'switchedOut');
}

export interface RefsInput { records: ManagedAccount[]; dirOf(id: string): string; live: LiveIdentity | null; cswap: CswapRoster; platform: NodeJS.Platform }

/** The live login first (one record), then every other visible record. Codex is added by the caller. */
export function claudeRefs(input: RefsInput): AccountRef[] {
  const visible = input.records.filter((r) => custodyOf(r) !== 'quarantined');
  const activeId = input.live?.recordId;
  const active = activeId ? visible.find((r) => r.id === activeId) : undefined;
  const refs: AccountRef[] = [];
  if (active) refs.push({ id: `claude:${active.id}`, provider: 'claude', key: identityKey(active) ?? `claude:${active.id}`, active: true });
  else refs.push({ id: 'claude:main', provider: 'claude', ...(input.live ? { key: identityKey(input.live) ?? 'claude:main', active: true } : {}) });
  // macOS keeps Claude logins in the Keychain: saved profiles cannot be read there.
  if (input.platform === 'darwin') return refs;
  for (const record of visible) {
    if (record.id === active?.id) continue;
    refs.push({
      id: `claude:${record.id}`, provider: 'claude', configDir: input.dirOf(record.id), key: identityKey(record) ?? `claude:${record.id}`,
      renew: renewRule(record, input.live, input.cswap), ...(record.deadTokens ? { deadTokens: record.deadTokens } : {}),
    });
  }
  return refs;
}
