import { describe, expect, it } from 'vitest';
import { LOGIN_END_WARN_MS, cardState, unpaidSubscription, loginEndNotice, makeMainOffered, removedCardKey, summaryAccounts, usageDiagnostics, withoutRemovedCards, type ProviderUsage } from '../src/shared/usage';
import { usageMessages } from '../src/shared/usageMessages';
import { translate } from '../src/shared/i18n';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DAY = 86_400_000;

const card = (patch: Partial<ProviderUsage> = {}): ProviderUsage => ({
  accountId: 'claude:r1', provider: 'claude', status: 'ok', email: 'a@x.io', managed: true, source: 'live', fetchedAt: NOW,
  windows: [{ id: '5h', usedPercent: 10, resetsAt: NOW / 1000 + 3600 }], ...patch,
});

describe('a lapsed subscription (1.2.6)', () => {
  const lapsed = card({ status: 'lapsed', windows: [], plan: 'Free', error: 'subscription-lapsed' });

  it('has its own card state, shows no numbers and is never offered as the main account', () => {
    expect(cardState(lapsed)).toBe('lapsed');
    // Even old numbers on it never pass as limits.
    expect(cardState({ ...lapsed, windows: card().windows })).toBe('lapsed');
    expect(summaryAccounts([lapsed, card({ accountId: 'claude:r2' })]).map((u) => u.accountId)).toEqual(['claude:r2']);
    expect(makeMainOffered(lapsed)).toBe(false);
  });

  it('lets the card of a lapsed main login leave the panel until it works again', () => {
    const main = { ...lapsed, accountId: 'claude:main', managed: undefined };
    const key = removedCardKey(main);
    expect(withoutRemovedCards([main], [key])).toEqual({ cards: [], removed: [key] });
    // Renewed: the card is back and the key is forgotten.
    expect(withoutRemovedCards([{ ...main, status: 'ok', windows: card().windows }], [key]).removed).toEqual([]);
  });
});

describe('access denied (1.2.7)', () => {
  const denied = card({ status: 'forbidden', source: 'cache', error: 'http-403', loginExpiresAt: NOW + DAY });

  it('looks like an expired sign-in: no numbers (old ones included), no login-end line, removable from the panel', () => {
    expect(cardState(denied)).toBe('denied');
    expect(cardState({ ...denied, windows: [] })).toBe('denied');
    expect(summaryAccounts([denied, card({ accountId: 'claude:r2' })]).map((u) => u.accountId)).toEqual(['claude:r2']);
    expect(loginEndNotice(denied, NOW)).toBeUndefined();
    const main = { ...denied, accountId: 'claude:main', managed: undefined };
    expect(withoutRemovedCards([main], [removedCardKey(main)]).cards).toEqual([]);
  });

  it('tells an unpaid subscription apart and names the subscription in the diagnostics', () => {
    expect(unpaidSubscription({ subscription: 'past_due' })).toBe(true);
    expect(unpaidSubscription({ subscription: 'unpaid' })).toBe(true);
    expect(unpaidSubscription({ subscription: 'active' })).toBe(false);
    expect(unpaidSubscription({})).toBe(false);
    const unpaid = { ...denied, subscription: 'past_due', paymentUrl: 'https://claude.ai/settings/billing/o' };
    expect(cardState(unpaid)).toBe('denied');
    expect(usageDiagnostics(unpaid, NOW, 'saved 1')).toContain('subscription: past_due');
    expect(usageDiagnostics(unpaid, NOW, 'saved 1')).not.toContain('claude.ai/settings');
  });
});

describe('the end of a stored login (1.2.6)', () => {
  it('warns within a week, says when it ended, and says nothing without the field or far ahead', () => {
    expect(loginEndNotice(card(), NOW)).toBeUndefined();
    expect(loginEndNotice(card({ loginExpiresAt: NOW + 8 * DAY }), NOW)).toBeUndefined();
    expect(loginEndNotice(card({ loginExpiresAt: NOW + 5.5 * DAY }), NOW)).toEqual({ kind: 'soon', leftMs: 5.5 * DAY });
    expect(loginEndNotice(card({ loginExpiresAt: NOW + LOGIN_END_WARN_MS }), NOW)).toEqual({ kind: 'soon', leftMs: LOGIN_END_WARN_MS });
    expect(loginEndNotice(card({ loginExpiresAt: NOW - 1 }), NOW)).toEqual({ kind: 'ended' });
  });

  it('stays quiet where the card already asks for a new sign-in, on a copy held by the live login and on Codex', () => {
    const soon = NOW + DAY;
    expect(loginEndNotice(card({ status: 'expired', loginExpiresAt: soon }), NOW)).toBeUndefined();
    expect(loginEndNotice(card({ status: 'elsewhere', heldBy: 'switched-out', loginExpiresAt: soon }), NOW)).toBeUndefined();
    expect(loginEndNotice(card({ status: 'elsewhere', heldBy: 'live', loginExpiresAt: soon }), NOW)).toBeUndefined();
    expect(loginEndNotice(card({ provider: 'codex', loginExpiresAt: soon }), NOW)).toBeUndefined();
  });

  it('names the end in the diagnostics, never a token', () => {
    const text = usageDiagnostics(card({ loginExpiresAt: NOW + 2 * DAY }), NOW, 'claude saved #1');
    expect(text).toContain('login ends: in 2 d');
    expect(usageDiagnostics(card(), NOW, 'x')).toContain('login ends: n/a');
  });

  it('has every new text in every language', () => {
    const keys = ['Subskrypcja wygasła', 'Zaloguj ponownie za {time}', 'Wymaga ponownego logowania'] as const;
    for (const key of keys) {
      expect(usageMessages[key]).toHaveLength(5);
      for (const language of ['en', 'de', 'es', 'fr', 'pt'] as const) expect(translate(language, key, { time: '5 d 12 h' })).not.toBe(key);
    }
    expect(translate('en', 'Zaloguj ponownie za {time}', { time: '5 d 12 h' })).toBe('Sign in again within 5 d 12 h');
  });
});
