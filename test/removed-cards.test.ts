import { describe, expect, it } from 'vitest';
import { removedCardKey, withoutRemovedCards, type ProviderUsage } from '../src/shared/usage';

const card = (accountId: string, email: string, status: ProviderUsage['status']): ProviderUsage =>
  ({ accountId, provider: 'codex', email, status, windows: [], fetchedAt: 0, source: 'live' } as ProviderUsage);

describe('removed cards of expired main logins (1.2.5)', () => {
  it('hides a removed expired card and keeps its key', () => {
    const dead = card('codex:main', 'a@x.pl', 'expired');
    const view = withoutRemovedCards([dead, card('codex:abc', 'b@x.pl', 'ok')], [removedCardKey(dead)]);
    expect(view.cards.map((c) => c.accountId)).toEqual(['codex:abc']);
    expect(view.removed).toEqual(['codex:main|a@x.pl']);
  });

  it('shows the card again and forgets the key once that login works or another account signs in there', () => {
    const key = 'codex:main|a@x.pl';
    expect(withoutRemovedCards([card('codex:main', 'a@x.pl', 'ok')], [key])).toMatchObject({ removed: [] });
    const other = withoutRemovedCards([card('codex:main', 'c@x.pl', 'expired')], [key]);
    expect(other.cards).toHaveLength(1);
    expect(other.removed).toEqual([]);
    // A card that is not listed right now keeps its key.
    expect(withoutRemovedCards([], [key]).removed).toEqual([key]);
  });
});
