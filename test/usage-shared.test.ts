import { describe, expect, it } from 'vitest';
import { claudeLoginActions, formatDuration, makeMainOffered, usageBand, usageDiagnostics, usageErrorKind, usageHttpStatus, worstPercent, type ProviderUsage } from '../src/shared/usage';
import { noticeText, setAsideText, usageErrorKey, usageMessages } from '../src/shared/usageMessages';
import { translate } from '../src/shared/i18n';

const NOW = Date.parse('2026-10-11T12:00:00Z');

describe('usage helpers', () => {
  it('picks the color band at 70 and 90 percent', () => {
    expect([0, 69.9, 70, 89.9, 90, 100].map(usageBand)).toEqual(['low', 'low', 'mid', 'mid', 'high', 'high']);
  });

  it('uses the highest window as the headline', () => {
    const usage: ProviderUsage = {
      accountId: 'claude:main', provider: 'claude', status: 'ok', fetchedAt: NOW, source: 'live',
      windows: [{ id: '5h', usedPercent: 20, resetsAt: Math.floor(NOW / 1000) + 600 }, { id: '7d', usedPercent: 64, resetsAt: Math.floor(NOW / 1000) + 9000 }],
    };
    expect(worstPercent(usage, NOW)).toBe(64);
    expect(worstPercent({ ...usage, windows: [] }, NOW)).toBe(0);
  });

  it('formats durations compactly', () => {
    expect(formatDuration(-5)).toBe('<1 min');
    expect(formatDuration(59)).toBe('<1 min');
    expect(formatDuration(12 * 60)).toBe('12 min');
    expect(formatDuration(2 * 3600 + 13 * 60)).toBe('2 h 13 min');
    expect(formatDuration(3 * 3600)).toBe('3 h');
    expect(formatDuration(6 * 86400 + 8 * 3600)).toBe('6 d 8 h');
    expect(formatDuration(2 * 86400)).toBe('2 d');
  });
});

describe('claudeLoginActions', () => {
  it('on macOS offers the main login only and hides managed-account actions', () => {
    expect(claudeLoginActions('darwin', false)).toEqual({ menu: 'main', emptyTarget: 'main', managedAccounts: false });
    expect(claudeLoginActions('darwin', true)).toEqual({ menu: null, emptyTarget: 'main', managedAccounts: false });
  });

  it('keeps Windows and Linux behaviour: add account, managed actions available', () => {
    for (const platform of ['win32', 'linux']) {
      for (const has of [false, true]) expect(claudeLoginActions(platform, has)).toEqual({ menu: 'new', emptyTarget: 'new', managedAccounts: true });
    }
  });
});

describe('failure reasons', () => {
  it('groups reason codes into what the card says', () => {
    expect(usageErrorKind('http-429')).toBe('rate');
    expect(usageErrorKind('refresh-http-429')).toBe('refreshLimited');
    expect(usageErrorKind('http-503')).toBe('server');
    expect(usageErrorKind('network')).toBe('network');
    expect(usageErrorKind('timeout')).toBe('network');
    expect(usageErrorKind('bad-response')).toBe('parse');
    expect(usageErrorKind('no-windows')).toBe('empty');
    expect(usageErrorKind('refresh-network')).toBe('refresh');
    expect(usageErrorKind('refresh-http-500')).toBe('refresh');
    expect(usageErrorKind('refresh-blocked')).toBe('blocked');
    expect(usageErrorKind('http-418')).toBe('other');
    expect(usageErrorKind(undefined)).toBe('other');
  });

  it('has a translated card text for every kind and extracts the HTTP status', () => {
    for (const kind of ['rate', 'server', 'network', 'parse', 'empty', 'refresh', 'refreshLimited', 'blocked', 'other'] as const) {
      expect(usageMessages[usageErrorKey(kind)]).toHaveLength(5);
    }
    expect(usageHttpStatus('http-429')).toBe(429);
    expect(usageHttpStatus('refresh-http-503')).toBe(503);
    expect(usageHttpStatus('network')).toBeUndefined();
  });

  it('builds a diagnostics text with reason, status and ages but no secrets', () => {
    const usage: ProviderUsage = {
      accountId: 'claude:abc', provider: 'claude', status: 'error', plan: 'Team 5x', managed: true, heldBy: 'cswap', error: 'http-429',
      windows: [{ id: '5h', usedPercent: 0, resetsAt: 0 }, { id: '7d', usedPercent: 100, resetsAt: 1 }],
      fetchedAt: NOW - 15 * 60_000, source: 'cache', attemptAt: NOW - 60_000, retryAt: NOW + 9 * 60_000, email: 'x@example.com',
    };
    const text = usageDiagnostics(usage, NOW, 'APP_label');
    expect(text).toContain('account: APP_label');
    expect(text).toContain('reason: http-429');
    expect(text).toContain('http status: 429');
    expect(text).toContain('last good data 15 min ago');
    expect(text).toContain('last attempt: 1 min ago');
    expect(text).toContain('next attempt: in 9 min');
    expect(text).toContain('7d 100%');
    expect(text).not.toContain('example.com');
    expect(text).toContain('renewal: held (cswap)');
    expect(usageDiagnostics({ ...usage, heldBy: undefined, active: true }, NOW, 'a')).toContain('active login: yes');
  });
});

describe('account notices', () => {
  it('has a text for every kind, naming the account, in every language', () => {
    const kinds = ['switchedOut', 'loggedOut', 'adopted', 'migrated', 'quarantined'] as const;
    for (const kind of kinds) {
      const { key, params } = noticeText({ id: 'n', kind, at: 1, email: 'g@x.com', count: 2 });
      for (const lang of ['pl', 'en', 'de', 'es', 'fr', 'pt'] as const) {
        const text = translate(lang, key, params);
        expect(text.length).toBeGreaterThan(10);
        if (kind !== 'migrated') expect(text).toContain('g@x.com');
      }
    }
  });

  it('never claims a kept copy on macOS (the live login is in the Keychain) (F24)', () => {
    for (const kind of ['switchedOut', 'loggedOut'] as const) {
      const notice = { id: 'n', kind, at: 1, email: 'g@x.com' };
      const mac = noticeText(notice, 'darwin');
      expect(mac.key).not.toBe(noticeText(notice, 'win32').key);
      expect(noticeText(notice).key).toBe(noticeText(notice, 'win32').key);
      for (const lang of ['pl', 'en', 'de', 'es', 'fr', 'pt'] as const) expect(translate(lang, mac.key, mac.params)).toContain('g@x.com');
      expect(translate('en', mac.key, mac.params)).not.toContain('kept its copy');
    }
    expect(noticeText({ id: 'n', kind: 'adopted', at: 1, email: 'g@x.com' }, 'darwin').key).toBe(noticeText({ id: 'n', kind: 'adopted', at: 1, email: 'g@x.com' }).key);
  });

  it('tells why a card is set aside after a failed restore and what to do, naming it, in every language', () => {
    expect(setAsideText(true)).not.toBe(setAsideText(false));
    for (const restoring of [true, false]) {
      for (const lang of ['pl', 'en', 'de', 'es', 'fr', 'pt'] as const) expect(translate(lang, setAsideText(restoring), { email: 'g@x.com' })).toContain('g@x.com');
    }
    expect(translate('en', setAsideText(false), { email: 'g@x.com' })).toMatch(/sign in to it again or remove the account/i);
  });
});

describe('makeMainOffered (I3)', () => {
  it('offers Make main account on a saved card that is not main, also on one cswap may hold, never on a live or switched-out one', () => {
    const card = { provider: 'claude' as const, managed: true };
    expect(makeMainOffered(card)).toBe(true);
    expect(makeMainOffered({ ...card, heldBy: 'cswap' })).toBe(true);
    expect(makeMainOffered({ ...card, heldBy: 'live' })).toBe(false);
    expect(makeMainOffered({ ...card, heldBy: 'switched-out' })).toBe(false);
    expect(makeMainOffered({ ...card, active: true })).toBe(false);
    expect(makeMainOffered({ provider: 'claude' })).toBe(false);
    expect(makeMainOffered({ provider: 'codex', managed: true })).toBe(false);
  });
});
