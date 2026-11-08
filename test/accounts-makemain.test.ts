// test/accounts-makemain.test.ts
import { describe, expect, it } from 'vitest';
import { SWAP_ERRORS } from '../src/shared/accounts';
import { LANGUAGES } from '../src/shared/languages';
import { translate } from '../src/shared/i18n';
import { swapErrorKey, swapErrorText, swapMessages } from '../src/shared/swapMessages';

describe('swap error messages', () => {
  it('maps every SwapError to a catalog message in all languages without leaking anything', () => {
    for (const error of SWAP_ERRORS) {
      const key = swapErrorKey(error);
      expect(Object.keys(swapMessages)).toContain(key);
      for (const { code } of LANGUAGES) expect(translate(code, key).trim().length, `${code}: ${error}`).toBeGreaterThan(0);
    }
  });

  it('falls back to the generic message for unknown values', () => {
    expect(swapErrorKey('nope')).toBe(swapErrorKey('invalid'));
    expect(swapErrorKey(undefined)).toBe(swapErrorKey('invalid'));
    expect(swapErrorKey('toString')).toBe(swapErrorKey('invalid'));
  });

  it('uses distinct messages for the specific errors', () => {
    const specific = SWAP_ERRORS.filter((e) => e !== 'invalid');
    expect(new Set(specific.map((e) => swapErrorKey(e))).size).toBe(specific.length);
  });

  it('names the account in the texts that concern one, and falls back to the plain text otherwise', () => {
    const named = swapErrorText({ error: 'foreign', email: 'x@x.com' });
    expect(named.params).toEqual({ email: 'x@x.com' });
    expect(translate('en', named.key, named.params)).toContain('x@x.com');
    for (const error of ['dead', 'transient', 'sameAccount', 'noTarget', 'duplicate', 'locked', 'manual'] as const) {
      const text = swapErrorText({ error, email: 'x@x.com' });
      for (const { code } of LANGUAGES) expect(translate(code, text.key, text.params), `${code}: ${error}`).toContain('x@x.com');
    }
    expect(swapErrorText({ error: 'foreign' })).toEqual({ key: swapErrorKey('foreign') });
    expect(swapErrorText({ error: 'busy', email: 'x@x.com' })).toEqual({ key: swapErrorKey('busy') });
    expect(swapErrorText({ error: 'nope', email: 'x@x.com' })).toEqual({ key: swapErrorKey('invalid') });
  });
});
