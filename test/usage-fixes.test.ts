import { describe, expect, it } from 'vitest';
import { diagnosticLabel, usageDiagnostics, type ProviderUsage } from '../src/shared/usage';
import { usageErrorKey, usageMessages } from '../src/shared/usageMessages';

const NOW = Date.parse('2026-10-11T12:00:00Z');

describe('provider-specific usage card wording', () => {
  it('names OpenAI for Codex and Anthropic for Claude, in all six languages', () => {
    for (const kind of ['rate', 'server', 'network', 'parse'] as const) {
      const claude = usageErrorKey(kind, 'claude');
      const codex = usageErrorKey(kind, 'codex');
      expect(usageErrorKey(kind)).toBe(claude);
      expect(claude).toContain('Anthropic');
      expect(codex).toContain('OpenAI');
      expect(codex).not.toContain('Anthropic');
      expect(usageMessages[codex]).toHaveLength(5);
      for (const text of usageMessages[codex]) {
        expect(text).toContain('OpenAI');
        expect(text).not.toContain('Anthropic');
        expect(text).toContain('{name}');
        expect(text).toContain('{retry}');
      }
    }
    for (const kind of ['empty', 'refresh', 'blocked', 'other'] as const) expect(usageErrorKey(kind, 'codex')).toBe(usageErrorKey(kind, 'claude'));
  });
});

describe('diagnostics privacy', () => {
  const usage: ProviderUsage = {
    accountId: 'claude:abc', provider: 'claude', status: 'error', managed: true, error: 'http-429', windows: [], fetchedAt: NOW - 60_000, source: 'cache',
    email: 'jan.kowalski@example.com', org: 'Secret Org', plan: 'Team',
  };

  it('names accounts by provider and role, never by e-mail', () => {
    expect(diagnosticLabel({ provider: 'claude' })).toBe('claude main');
    expect(diagnosticLabel({ provider: 'claude', managed: true }, 2)).toBe('claude saved #2');
    expect(diagnosticLabel({ provider: 'claude', managed: true }, 0)).toBe('claude saved #1');
    expect(diagnosticLabel({ provider: 'codex' })).toBe('codex');
    const text = usageDiagnostics(usage, NOW, diagnosticLabel(usage, 3));
    expect(text).toContain('account: claude saved #3');
    expect(text).toContain('reason: http-429');
    expect(text).not.toMatch(/example\.com|kowalski|Secret Org/);
  });
});
