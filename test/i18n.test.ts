import { readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { formatAgo, translate, translateError, type MessageKey } from '../src/shared/i18n';
import { detectLanguage, isLanguage, LANGUAGES } from '../src/shared/languages';
import { messages } from '../src/shared/messages';
import { defaultState, normalizeState, updateSettings } from '../src/shared/state';

describe('app languages', () => {
  it('suggests a supported system language and falls back to English', () => {
    expect(detectLanguage(['de-DE', 'en-US'])).toBe('de');
    expect(detectLanguage(['ja-JP', 'pl-PL'])).toBe('pl');
    expect(detectLanguage(['pt_BR'])).toBe('pt');
    expect(detectLanguage(['zh-CN'])).toBe('en');
    expect(detectLanguage()).toBe('en');
    expect(isLanguage('de')).toBe(true);
    expect(isLanguage('xx')).toBe(false);
  });

  it('shows onboarding until the language is explicitly chosen', () => {
    const fresh = defaultState();
    expect(fresh.settings.language).toBeNull();
    expect(normalizeState(JSON.parse(JSON.stringify(fresh)))!.settings.language).toBeNull();
    const chosen = updateSettings(fresh, { language: 'de' });
    expect(normalizeState(JSON.parse(JSON.stringify(chosen)))!.settings.language).toBe('de');
    expect(fresh.settings.language).toBeNull();
  });

  it('preserves Polish for existing installations without a language preference', () => {
    const { language: _language, ...oldSettings } = defaultState().settings;
    expect(normalizeState({ ...defaultState(), settings: oldSettings })!.settings.language).toBe('pl');
  });

  it('requests a new choice when a saved language is unsupported', () => {
    expect(normalizeState({ ...defaultState(), settings: { language: 'xx' } })!.settings.language).toBeNull();
  });

  it('has a nonempty translation and identical placeholders for every message and language', () => {
    const tokens = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(messages) as MessageKey[]) {
      for (const { code } of LANGUAGES) {
        const translated = translate(code, key);
        expect(translated.trim().length, `${code}: ${key}`).toBeGreaterThan(0);
        expect(tokens(translated), `${code}: ${key}`).toEqual(tokens(key));
      }
    }
  });

  it('translates UI messages and interpolates user content without changing it', () => {
    expect(translate('en', 'Ustawienia')).toBe('Settings');
    expect(translate('de', 'Wybierz język')).toBe('Sprache wählen');
    expect(translate('pl', 'Komórka {number}', { number: 2 })).toBe('Komórka 2');
    expect(translate('en', 'Usunąć projekt „{name}” z listy?', { name: 'Mój projekt <dev>' }))
      .toBe('Remove “Mój projekt <dev>” from the project list?');
    expect(translateError('en', 'Ścieżka jest poza projektem.')).toBe('The path is outside the project.');
    expect(translateError('en', 'EIO: raw system error')).toBe('EIO: raw system error');
  });

  it('formats history times in the selected language', () => {
    const now = Date.UTC(2026, 9, 9, 12);
    expect(formatAgo('en', now - 20000, now)).toBe('just now');
    expect(formatAgo('en', now - 120000, now)).toBe('2 minutes ago');
    expect(formatAgo('de', now - 86400000, now)).toBe('gestern');
    expect(formatAgo('pl', now + 1000, now)).toBe('przed chwilą');
  });

  it('never defines one Polish key in two message tables with different translations', async () => {
    // messages.ts spreads every table into one object, so a later table would silently override an earlier row.
    const dir = join(__dirname, '../src/shared');
    const files = readdirSync(dir).filter((f) => /Messages\.ts$/.test(f) && f !== 'messages.ts');
    expect(files.length).toBeGreaterThan(10);
    const conflicts: string[] = [];
    const final = messages as Record<string, readonly string[]>;
    for (const file of files) {
      const mod = (await import(/* @vite-ignore */ join(dir, file))) as Record<string, unknown>;
      for (const [name, table] of Object.entries(mod)) {
        if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
        for (const [key, row] of Object.entries(table as Record<string, unknown>)) {
          if (!Array.isArray(row)) continue;
          if (JSON.stringify(final[key]) !== JSON.stringify(row)) conflicts.push(`${file} ${name}: '${key}'`);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });
});
