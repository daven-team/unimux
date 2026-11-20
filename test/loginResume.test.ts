import { describe, expect, it } from 'vitest';
import { accountVerdict, cellAccount, loginResumeOn, loginResumeVerdict } from '../src/shared/loginResume';
import type { ProviderUsage } from '../src/shared/usage';

const NOW = 1_800_000_000_000;
const inAnHour = NOW / 1000 + 3600;

const card = (patch: Partial<ProviderUsage> = {}): ProviderUsage => ({
  accountId: 'claude:main', provider: 'claude', status: 'ok', active: true, source: 'live', fetchedAt: NOW,
  windows: [{ id: '5h', usedPercent: 20, resetsAt: inAnHour }, { id: '7d', usedPercent: 40, resetsAt: inAnHour + 86400 }],
  ...patch,
});

const verdict = (providers: ProviderUsage[], state: Parameters<typeof loginResumeVerdict>[0]['state'] = 'ready', enabled = true) =>
  loginResumeVerdict({ enabled, state, providers, nowMs: NOW });

describe('login resume', () => {
  it('is on unless switched off', () => {
    expect(loginResumeOn({})).toBe(true);
    expect(loginResumeOn({ resumeAfterLoginChange: true })).toBe(true);
    expect(loginResumeOn({ resumeAfterLoginChange: false })).toBe(false);
  });

  it('sends to a ready cell, or one whose last turn hit the limit, when the login has room', () => {
    expect(verdict([card()])).toBe('send');
    expect(verdict([card()], 'limit')).toBe('send');
    expect(verdict([card()], 'ready', false)).toBe('off');
  });

  it('leaves a typing, working, asking, queued or stopped cell to the user', () => {
    for (const state of ['typing', 'working', 'question', 'permission', 'queued', 'paste', 'exited', 'notStarted', 'unreachable'] as const) {
      expect(verdict([card()], state)).toBe('busy');
    }
  });

  it('uses the live login, else the claude:main card', () => {
    const saved = card({ accountId: 'claude:saved', active: false, managed: true, windows: [{ id: '5h', usedPercent: 100, resetsAt: inAnHour }] });
    const live = card({ accountId: 'claude:other', email: 'b@x.io' });
    expect(cellAccount([saved, live])).toBe(live);
    expect(cellAccount([card({ active: false }), saved])?.accountId).toBe('claude:main');
    expect(cellAccount([card({ provider: 'codex', accountId: 'codex:main' })])).toBeUndefined();
    expect(verdict([saved, live])).toBe('send');
  });

  it('does not send on a full window, a signed-out, expired or forbidden login', () => {
    expect(verdict([card({ windows: [{ id: '5h', usedPercent: 100, resetsAt: inAnHour }] })])).toBe('limit');
    expect(verdict([card({ windows: [{ id: '7d', usedPercent: 120, resetsAt: inAnHour }] })])).toBe('limit');
    expect(verdict([card({ status: 'signedOut', windows: [] })])).toBe('signedOut');
    expect(verdict([card({ status: 'expired' })])).toBe('signedOut');
    expect(verdict([card({ status: 'forbidden' })])).toBe('signedOut');
  });

  it('does not block on unknown usage or a window that already reset', () => {
    expect(verdict([])).toBe('send');
    expect(accountVerdict(undefined, NOW)).toBe('ok');
    expect(verdict([card({ status: 'error', windows: [] })])).toBe('send');
    expect(verdict([card({ status: 'dormant' })])).toBe('send');
    expect(verdict([card({ windows: [{ id: '5h', usedPercent: 100, resetsAt: NOW / 1000 - 60 }] })])).toBe('send');
  });
});
