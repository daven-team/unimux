// "Renew this copy in unimux" (0.9.2): a saved copy cswap also lists becomes the app's own login on request.
import { describe, expect, it } from 'vitest';
import { adoptCopyOffered, type ProviderUsage } from '../src/shared/usage';
import { cswapNoteText } from '../src/shared/usageMessages';
import { translate } from '../src/shared/i18n';
import { LANGUAGES } from '../src/shared/languages';

describe('adoptCopyOffered', () => {
  const card: Pick<ProviderUsage, 'provider' | 'managed' | 'active' | 'heldBy' | 'status'> = { provider: 'claude', managed: true, heldBy: 'cswap', status: 'ok' };
  it('offers the action only on a saved Claude card held by cswap', () => {
    expect(adoptCopyOffered(card)).toBe(true);
    expect(adoptCopyOffered({ ...card, status: 'elsewhere' })).toBe(true);
    expect(adoptCopyOffered({ ...card, status: 'expired' })).toBe(false);
    expect(adoptCopyOffered({ ...card, heldBy: undefined })).toBe(false);
    expect(adoptCopyOffered({ ...card, heldBy: 'live' })).toBe(false);
    expect(adoptCopyOffered({ ...card, heldBy: 'switched-out' })).toBe(false);
    expect(adoptCopyOffered({ ...card, active: true })).toBe(false);
    expect(adoptCopyOffered({ ...card, managed: false })).toBe(false);
    expect(adoptCopyOffered({ ...card, provider: 'codex' })).toBe(false);
  });
});

describe('cswapNoteText', () => {
  it('names the action in every held-by-cswap state but an expired sign-in, in every language', () => {
    for (const status of ['ok', 'error', 'dormant', 'elsewhere'] as const) {
      const key = cswapNoteText(status);
      expect(key, status).toBeDefined();
      for (const { code } of LANGUAGES) expect(translate(code, key!), `${code} ${status}`).toContain(translate(code, 'Odświeżaj tę kopię w unimuxie'));
    }
    // An access token that ran out: the text says so and does not promise that Make main account works.
    expect(cswapNoteText('elsewhere')).toContain('wygasł');
    expect(cswapNoteText('elsewhere')).not.toContain('Ustawienie jako główne');
    expect(cswapNoteText('ok')).toContain('Ustawienie jako główne');
    expect(cswapNoteText('expired')).toBeUndefined();
  });
});
