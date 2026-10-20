import { describe, expect, it } from 'vitest';
import { hostFormDirty, hostToDraft, normalizeSshHost, validateHostDraft, type SshHost } from '../src/shared/ssh';
import {
  ANSI_KEYS, DEFAULT_SSH_THEME, FOLLOW_GLOBAL_THEME, hostThemeFromValue, hostThemeValue, isSshThemeId, normalizeSshThemeId, resolveSshTheme,
  SSH_THEME_IDS, SSH_THEMES, sshThemeById, type TerminalPalette,
} from '../src/shared/sshThemes';
import { defaultState, normalizeState, updateSettings, updateSshHost } from '../src/shared/state';
import { StateController } from '../src/main/stateController';

const ID = '00000000-0000-4000-8000-000000000001';
const host = (patch: Partial<SshHost> = {}): SshHost => ({ id: ID, label: 'web', address: 'web.example', port: 22, username: 'deploy', createdAt: 1, updatedAt: 1, ...patch });

// WCAG 2 relative luminance and contrast; a colour with alpha is blended over the theme background first.
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const over = (hex: string, background: string) => {
  const alpha = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
  const [fg, bg] = [rgb(hex), rgb(background)];
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
};
const luminance = (channels: number[]) => {
  const [r, g, b] = channels.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('SSH terminal theme registry', () => {
  it('lists every id once, in the stored order, with a unique name', () => {
    expect(SSH_THEMES.map((t) => t.id)).toEqual([...SSH_THEME_IDS]);
    expect(new Set(SSH_THEMES.map((t) => t.id)).size).toBe(SSH_THEMES.length);
    expect(new Set(SSH_THEMES.map((t) => t.name)).size).toBe(SSH_THEMES.length);
    expect(SSH_THEMES.every((t) => t.name.trim().length > 0)).toBe(true);
    expect(SSH_THEMES.length).toBeGreaterThanOrEqual(7);
    expect(isSshThemeId(DEFAULT_SSH_THEME)).toBe(true);
    expect(isSshThemeId(FOLLOW_GLOBAL_THEME)).toBe(false);
  });

  it('gives every theme the 16 ANSI colours and the base colours as valid hex (alpha only in the selection)', () => {
    const base: Array<keyof TerminalPalette> = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionInactiveBackground'];
    expect(ANSI_KEYS).toHaveLength(16);
    for (const theme of SSH_THEMES) {
      expect(Object.keys(theme.colors).filter((key) => key !== 'selectionForeground').sort(), theme.id).toEqual([...base, ...ANSI_KEYS].sort());
      for (const [key, value] of Object.entries(theme.colors)) {
        const pattern = key.startsWith('selection') ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/ : /^#[0-9a-f]{6}$/;
        expect(value, `${theme.id}.${key}`).toMatch(pattern);
      }
    }
  });

  it('keeps every theme readable', () => {
    const problems: string[] = [];
    const check = (theme: string, what: string, ratio: number, min: number) => { if (ratio < min) problems.push(`${theme} ${what}: ${ratio.toFixed(2)} < ${min}`); };
    for (const { id, colors } of SSH_THEMES) {
      const bg = rgb(colors.background);
      check(id, 'foreground', contrast(rgb(colors.foreground), bg), 4.5);
      check(id, 'cursor', contrast(rgb(colors.cursor), bg), 3);
      check(id, 'selected text', contrast(rgb(colors.selectionForeground ?? colors.foreground), over(colors.selectionBackground, colors.background)), 4.5);
      check(id, 'selection', contrast(over(colors.selectionBackground, colors.background), bg), 1.25);
      // The default keeps the colours terminals always had (Campbell); the new themes keep their accents and dim text legible.
      if (id === DEFAULT_SSH_THEME) continue;
      for (const key of ANSI_KEYS) {
        if (key === 'black' || key === 'white' || key === 'brightWhite') continue;
        check(id, key, contrast(rgb(colors[key]), bg), 3);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the default theme as the classic look (Campbell on the app background)', () => {
    const dark = sshThemeById(DEFAULT_SSH_THEME);
    expect(dark.name).toBe('Unimux Dark');
    expect(dark.colors).toMatchObject({ background: '#0d0d0d', foreground: '#cccccc', red: '#c50f1f', brightBlue: '#3b78ff' });
  });
});

describe('SSH terminal theme choice', () => {
  it('resolves the host override first, then the global setting, then the default', () => {
    expect(resolveSshTheme('unimux-daylight', 'unimux-midnight').id).toBe('unimux-daylight');
    expect(resolveSshTheme(undefined, 'unimux-midnight').id).toBe('unimux-midnight');
    expect(resolveSshTheme(FOLLOW_GLOBAL_THEME, 'unimux-cyberpunk').id).toBe('unimux-cyberpunk');
    expect(resolveSshTheme('gone-theme', 'unimux-fjord').id).toBe('unimux-fjord');
    expect(resolveSshTheme(undefined, undefined).id).toBe(DEFAULT_SSH_THEME);
    expect(resolveSshTheme('nope', 42).id).toBe(DEFAULT_SSH_THEME);
    // The same object every time: the renderer compares themes by identity.
    expect(resolveSshTheme(undefined, 'unimux-lagoon')).toBe(sshThemeById('unimux-lagoon'));
  });

  it('reads an unknown saved id as the default and maps the host picker values', () => {
    expect(normalizeSshThemeId('unimux-nightshade')).toBe('unimux-nightshade');
    expect(normalizeSshThemeId('Unimux-Dark')).toBe(DEFAULT_SSH_THEME);
    expect(normalizeSshThemeId(null)).toBe(DEFAULT_SSH_THEME);
    expect(normalizeSshThemeId('__proto__')).toBe(DEFAULT_SSH_THEME);
    expect(sshThemeById('toString').id).toBe(DEFAULT_SSH_THEME);
    expect(hostThemeValue(undefined)).toBe(FOLLOW_GLOBAL_THEME);
    expect(hostThemeValue('missing')).toBe(FOLLOW_GLOBAL_THEME);
    expect(hostThemeValue('unimux-fjord')).toBe('unimux-fjord');
    expect(hostThemeFromValue(FOLLOW_GLOBAL_THEME)).toBeUndefined();
    expect(hostThemeFromValue('unimux-fjord')).toBe('unimux-fjord');
  });

  it('stores the global setting with a default and repairs an unknown one when loading and when the renderer edits it', () => {
    expect(defaultState().settings.sshTheme).toBe(DEFAULT_SSH_THEME);
    const { sshTheme: _gone, ...older } = defaultState().settings;
    expect(normalizeState({ ...defaultState(), settings: older })!.settings.sshTheme).toBe(DEFAULT_SSH_THEME);
    expect(normalizeState({ ...defaultState(), settings: { ...older, sshTheme: 'retro-9000' } })!.settings.sshTheme).toBe(DEFAULT_SSH_THEME);
    const saved = JSON.parse(JSON.stringify(updateSettings(defaultState(), { sshTheme: 'unimux-cyberpunk' })));
    expect(normalizeState(saved)!.settings.sshTheme).toBe('unimux-cyberpunk');

    const base = defaultState();
    const controller = new StateController(base, () => {});
    controller.apply({ id: 'e1', base, next: { ...base, settings: { ...base.settings, sshTheme: 'bogus' as never } } });
    expect(controller.get().settings.sshTheme).toBe(DEFAULT_SSH_THEME);
    const now = controller.get();
    controller.apply({ id: 'e2', base: now, next: updateSettings(now, { sshTheme: 'unimux-midnight' }) });
    expect(controller.get().settings.sshTheme).toBe('unimux-midnight');
  });

  it('keeps a known host theme, drops an unknown one (the host follows the setting)', () => {
    expect(normalizeSshHost(host({ theme: 'unimux-lagoon' }))!.theme).toBe('unimux-lagoon');
    expect(normalizeSshHost({ ...host(), theme: 'neon-dream' })).not.toHaveProperty('theme');
    expect(normalizeSshHost({ ...host(), theme: FOLLOW_GLOBAL_THEME })).not.toHaveProperty('theme');
    const loaded = normalizeState({ ...defaultState(), sshHosts: [host({ theme: 'unimux-fjord' }), { ...host({ id: ID.replace(/1$/, '2') }), theme: 7 }] })!;
    expect(loaded.sshHosts.map((h) => h.theme)).toEqual(['unimux-fjord', undefined]);
  });

  it('edits the host theme through the host form (follow the setting = no field)', () => {
    const saved = host({ theme: 'unimux-daylight' });
    expect(hostToDraft(saved).theme).toBe('unimux-daylight');
    expect(hostToDraft(host()).theme).toBeUndefined();
    expect(hostFormDirty(saved, hostToDraft(saved), { tag: '', password: '' })).toBe(false);
    expect(hostFormDirty(saved, { ...hostToDraft(saved), theme: undefined }, { tag: '', password: '' })).toBe(true);
    expect(hostFormDirty(host(), { ...hostToDraft(host()), theme: 'unimux-midnight' }, { tag: '', password: '' })).toBe(true);
    expect(validateHostDraft({ ...hostToDraft(saved), theme: 'unimux-midnight' })).toMatchObject({ ok: true, value: { theme: 'unimux-midnight' } });
    const follow = validateHostDraft({ ...hostToDraft(saved), theme: undefined });
    expect(follow.ok && 'theme' in follow.value).toBe(false);
    const unknown = validateHostDraft({ ...hostToDraft(saved), theme: 'nope' });
    expect(unknown.ok && 'theme' in unknown.value).toBe(false);
    // Saving "follow the setting" removes the stored field (the editor patches it with undefined).
    const state = { ...defaultState(), sshHosts: [saved] };
    expect(updateSshHost(state, ID, { theme: undefined }, 2).sshHosts[0]).not.toHaveProperty('theme');
  });
});
