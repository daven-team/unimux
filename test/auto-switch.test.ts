import { describe, expect, it } from 'vitest';
import {
  defaultAutoSwitch, enableAutoSwitch,
} from '../src/shared/autoSwitch';
import type { ProviderUsage } from '../src/shared/usage';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const S = Math.floor(NOW / 1000);
const H = 3600;

function card(email: string, five: number, seven: number, patch: Partial<ProviderUsage> = {}, resets: { five?: number; seven?: number } = {}): ProviderUsage {
  return {
    accountId: patch.active ? 'claude:main' : `claude:${email}`, provider: 'claude', status: 'ok', email, windows: [
      { id: '5h', usedPercent: five, resetsAt: S + (resets.five ?? 2 * H) },
      { id: '7d', usedPercent: seven, resetsAt: S + (resets.seven ?? 3 * 24 * H) },
    ], fetchedAt: NOW - 60_000, source: 'live', managed: !patch.active, ...patch,
  };
}

describe('automatic account switch: settings', () => {
  it('turning it on makes the current main accounts primary (an existing choice stays)', () => {
    const providers = [card('a@x.com', 10, 10, { active: true }), card('b@x.com', 10, 10)];
    expect(enableAutoSwitch(defaultAutoSwitch(), providers)).toMatchObject({ enabled: true, primary: { claude: 'a@x.com' } });
    expect(enableAutoSwitch({ ...defaultAutoSwitch(), primary: { claude: 'b@x.com' } }, providers).primary).toEqual({ claude: 'b@x.com' });
  });
});

