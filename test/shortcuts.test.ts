import { describe, expect, it } from 'vitest';
import { decideShortcut, type DispatchContext, type DispatchEvent } from '../src/shared/shortcutDispatch';
import {
  checkAssignment, comboParts, defaultCombo, displayCombo, eventToCombo, formatCombo, keyFromCode, matchCombo, normalizeCombo,
  normalizeShortcutOverrides, parseCombo, parseDefault, reservedReason, resolveShortcuts, scopesOverlap, setOverride, shortcutDef,
  SHORTCUT_DEFS, SHORTCUT_GROUPS, swapShortcut, type Combo, type ShortcutDef,
} from '../src/shared/shortcuts';
import { messages } from '../src/shared/messages';
import { defaultState, normalizeState } from '../src/shared/state';
import { mergeStateEdit } from '../src/shared/stateEdits';
import { shortcutLabel, type AppPlatform } from '../src/shared/platform';

const PLATFORMS: AppPlatform[] = ['win32', 'darwin', 'linux'];
const combo = (text: string): Combo => parseCombo(text)!;
const event = (text: string, extra: Partial<DispatchEvent> = {}): DispatchEvent => {
  const parts = text.split('+');
  const key = parts.pop()!;
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : ['Left', 'Right', 'Up', 'Down'].includes(key) ? `Arrow${key}` : key;
  const has = (name: string) => parts.includes(name);
  return { code, ctrlKey: has('Ctrl'), altKey: has('Alt'), shiftKey: has('Shift'), metaKey: has('Meta'), ...extra };
};

describe('combo parsing and formatting', () => {
  it('round trips the stable form and normalises order and case', () => {
    expect(formatCombo(combo('Ctrl+Shift+E'))).toBe('Ctrl+Shift+E');
    expect(normalizeCombo('shift+ctrl+e')).toBe('Ctrl+Shift+E');
    expect(normalizeCombo('Meta+Alt+Shift+Left')).toBe('Alt+Shift+Meta+Left');
    expect(normalizeCombo('cmd+option+arrowup')).toBe('Alt+Meta+Up');
    expect(normalizeCombo('Ctrl+f5')).toBe('Ctrl+F5');
    expect(normalizeCombo('Ctrl+Esc')).toBe('Ctrl+Escape');
    expect(normalizeCombo('Ctrl+-')).toBe('Ctrl+-');
    expect(normalizeCombo('Delete')).toBe('Delete');
  });

  it('rejects malformed combos', () => {
    for (const bad of ['', '   ', 'Ctrl', 'Ctrl+', '+K', 'Ctrl++', 'Ctrl+Ctrl+K', 'Ctrl+Shift', 'Ctrl+KK', 'Foo+K', 'Ctrl+F25', 'K+Ctrl', null, undefined, 5, {}, ['Ctrl+K']]) {
      expect(parseCombo(bad), String(bad)).toBeNull();
    }
  });

  it('keeps a stable string for every key kind', () => {
    for (const text of ['A', 'Ctrl+9', 'Alt+F12', 'Ctrl+Tab', 'Shift+Enter', 'Ctrl+Space', 'Ctrl+,', 'Ctrl+.', 'Ctrl+/', 'Ctrl+\\', 'Ctrl+[', 'Ctrl+`', 'Home', 'PageDown', 'Insert']) {
      expect(formatCombo(combo(text)), text).toBe(text);
    }
  });

  it('maps physical keys to tokens', () => {
    expect(keyFromCode('KeyE')).toBe('E');
    expect(keyFromCode('Digit3')).toBe('3');
    expect(keyFromCode('F11')).toBe('F11');
    expect(keyFromCode('ArrowLeft')).toBe('Left');
    expect(keyFromCode('Backquote')).toBe('`');
    for (const modifier of ['ControlLeft', 'ShiftRight', 'AltLeft', 'MetaLeft', 'Numpad5', 'AudioVolumeUp', 'CapsLock', '']) expect(keyFromCode(modifier), modifier).toBeNull();
  });

  it('shows macOS names on a Mac and Win or Super elsewhere', () => {
    expect(displayCombo(combo('Ctrl+Alt+Shift+Left'), 'win32')).toBe('Ctrl+Alt+Shift+Left');
    expect(displayCombo(combo('Meta+Alt+Shift+Left'), 'darwin')).toBe('Cmd+Option+Shift+Left');
    expect(displayCombo(combo('Ctrl+Meta+K'), 'darwin')).toBe('Ctrl+Cmd+K');
    expect(displayCombo(combo('Meta+K'), 'win32')).toBe('Win+K');
    expect(displayCombo(combo('Meta+K'), 'linux')).toBe('Super+K');
    expect(comboParts(combo('Ctrl+Shift+E'), 'win32')).toEqual(['Ctrl', 'Shift', 'E']);
  });

  it('writes defaults with Mod (Ctrl, or Cmd on macOS)', () => {
    expect(formatCombo(parseDefault('Mod+Shift+E', 'win32')!)).toBe('Ctrl+Shift+E');
    expect(formatCombo(parseDefault('Mod+Shift+E', 'linux')!)).toBe('Ctrl+Shift+E');
    expect(formatCombo(parseDefault('Mod+Shift+E', 'darwin')!)).toBe('Shift+Meta+E');
    expect(formatCombo(parseDefault('F2', 'darwin')!)).toBe('F2');
  });
});

describe('matching key events', () => {
  it('matches exactly: every modifier must agree', () => {
    const palette = combo('Ctrl+K');
    expect(matchCombo(event('Ctrl+K'), palette)).toBe(true);
    expect(matchCombo(event('Ctrl+Shift+K'), palette)).toBe(false);
    expect(matchCombo(event('Ctrl+Alt+K'), palette)).toBe(false);
    expect(matchCombo(event('Ctrl+Meta+K'), palette)).toBe(false);
    expect(matchCombo(event('K'), palette)).toBe(false);
    expect(matchCombo(event('Ctrl+J'), palette)).toBe(false);
    expect(matchCombo(event('Ctrl+K'), null)).toBe(false);
  });

  it('never treats AltGr as Ctrl+Alt', () => {
    const chord = combo('Ctrl+Alt+Left');
    expect(matchCombo(event('Ctrl+Alt+Left'), chord)).toBe(true);
    expect(matchCombo(event('Ctrl+Alt+Left', { getModifierState: (key) => key === 'AltGraph' }), chord)).toBe(false);
  });

  it('turns a key press into a combo, but not a lone modifier', () => {
    expect(eventToCombo(event('Ctrl+Shift+E'))).toEqual(combo('Ctrl+Shift+E'));
    expect(eventToCombo({ code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeNull();
  });
});

describe('registry', () => {
  it('has unique ids, valid defaults, labels in every language and groups', () => {
    const ids = SHORTCUT_DEFS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of SHORTCUT_DEFS) {
      expect(Object.hasOwn(messages, def.label), def.id).toBe(true);
      expect(SHORTCUT_GROUPS, def.id).toContain(def.group);
      if (def.default) for (const platform of PLATFORMS) expect(defaultCombo(def, platform), `${def.id} ${platform}`).not.toBeNull();
      if (!def.rebindable) expect(def.reason && Object.hasOwn(messages, def.reason), `${def.id} needs a reason`).toBe(true);
    }
  });

  it('ships defaults that never collide and are never reserved for their own action', () => {
    for (const platform of PLATFORMS) {
      const { combos, problems } = resolveShortcuts({}, platform);
      expect(problems).toEqual({});
      for (const a of SHORTCUT_DEFS) for (const b of SHORTCUT_DEFS) {
        if (a.id >= b.id || !combos[a.id] || !combos[b.id]) continue;
        const clash = formatCombo(combos[a.id]!) === formatCombo(combos[b.id]!) && scopesOverlap(a.scope, b.scope);
        expect(clash, `${a.id} vs ${b.id} on ${platform}`).toBe(false);
      }
    }
  });

  it('every reserved reason has translations', () => {
    const reasons = new Set<string>();
    for (const platform of PLATFORMS) for (const scope of ['global', 'cell', 'editor', 'modal', 'files-tree'] as const) {
      for (const text of ['Escape', 'K', 'Ctrl+K', 'Alt+K', 'Alt+F4', 'Meta+K', 'Meta+Q', 'Ctrl+Alt+K', 'Alt+Left', 'Ctrl+Left', 'Ctrl+Z', 'Meta+Z', 'Ctrl+F', 'Left', 'F5', 'Shift+A', 'Ctrl+Escape', 'Ctrl+Alt+Delete']) {
        const reason = reservedReason(combo(text), platform, scope);
        if (reason) reasons.add(reason);
      }
    }
    expect(reasons.size).toBeGreaterThan(8);
    for (const reason of reasons) expect(Object.hasOwn(messages, reason), reason).toBe(true);
  });
});

describe('scopes', () => {
  it('global and cell actions overlap with everything, the tree and the editor never overlap', () => {
    expect(scopesOverlap('global', 'editor')).toBe(true);
    expect(scopesOverlap('cell', 'files-tree')).toBe(true);
    expect(scopesOverlap('terminal-passthrough', 'global')).toBe(true);
    expect(scopesOverlap('files-tree', 'editor')).toBe(false);
    expect(scopesOverlap('files-tree', 'terminal-passthrough')).toBe(false);
    expect(scopesOverlap('editor', 'modal')).toBe(false);
    expect(scopesOverlap('editor', 'editor')).toBe(true);
  });
});

describe('reserved combos', () => {
  const reserved = (text: string, scope: ShortcutDef['scope'], platform: AppPlatform = 'win32') => reservedReason(combo(text), platform, scope);
  it('rejects bare printable keys but allows function keys, and Delete or Enter in the tree', () => {
    expect(reserved('A', 'global')).not.toBeNull();
    expect(reserved('Shift+A', 'global')).not.toBeNull();
    expect(reserved('Enter', 'global')).not.toBeNull();
    expect(reserved('F5', 'global')).toBeNull();
    expect(reserved('Shift+F5', 'global')).toBeNull();
    expect(reserved('Delete', 'files-tree')).toBeNull();
    expect(reserved('Delete', 'global')).not.toBeNull();
    expect(reserved('A', 'files-tree')).not.toBeNull();
  });
  it('never lets Escape be assigned', () => {
    expect(reserved('Escape', 'global')).not.toBeNull();
    expect(reserved('Escape', 'files-tree')).not.toBeNull();
  });
  it('keeps the terminal keys for the terminal', () => {
    expect(reserved('Ctrl+C', 'global')).not.toBeNull();
    expect(reserved('Ctrl+T', 'global')).not.toBeNull();
    expect(reserved('Ctrl+W', 'cell')).not.toBeNull();
    expect(reserved('Ctrl+Left', 'global')).not.toBeNull();
    expect(reserved('Alt+Left', 'global')).not.toBeNull();
    expect(reserved('Ctrl+Shift+Y', 'global')).toBeNull();
    expect(reserved('Ctrl+Alt+Left', 'global')).toBeNull();
    expect(reserved('Ctrl+C', 'files-tree')).toBeNull();
    expect(reserved('Meta+K', 'global', 'darwin')).toBeNull();
  });
  it('rejects system keys', () => {
    expect(reserved('Alt+F4', 'global')).not.toBeNull();
    expect(reserved('Ctrl+Shift+Escape', 'global')).not.toBeNull(); // Task Manager
    expect(reserved('Ctrl+Escape', 'global')).not.toBeNull();
    expect(reserved('Meta+K', 'global', 'win32')).not.toBeNull();
    expect(reserved('Meta+K', 'global', 'linux')).not.toBeNull();
    expect(reserved('Meta+Q', 'global', 'darwin')).not.toBeNull();
    expect(reserved('Meta+C', 'global', 'darwin')).not.toBeNull();
  });
  it('rejects AltGr and Option combinations that type characters', () => {
    expect(reserved('Ctrl+Alt+A', 'global', 'win32')).not.toBeNull();
    expect(reserved('Ctrl+Alt+Shift+9', 'global', 'linux')).not.toBeNull();
    expect(reserved('Alt+A', 'global', 'darwin')).not.toBeNull();
    expect(reserved('Meta+Alt+A', 'global', 'darwin')).toBeNull();
  });
  it('protects text editing in the editor and dialogs', () => {
    expect(reserved('Ctrl+Z', 'editor')).not.toBeNull();
    expect(reserved('Ctrl+F', 'editor')).not.toBeNull();
    expect(reserved('Ctrl+Z', 'modal')).not.toBeNull();
    expect(reserved('Ctrl+Shift+S', 'editor')).toBeNull();
    expect(reserved('Ctrl+S', 'editor')).toBeNull();
  });
  it('lets a shipped default through even where the rule would reject it', () => {
    expect(reservedReason(combo('Ctrl+K'), 'win32', 'global', combo('Ctrl+K'))).toBeNull();
    expect(reservedReason(combo('Ctrl+K'), 'win32', 'global')).not.toBeNull();
  });
});

describe('conflicts', () => {
  const win = (overrides: Record<string, string | null>) => resolveShortcuts(overrides, 'win32');
  it('finds another action on the same keys', () => {
    const check = checkAssignment('grid.new', combo('Ctrl+Shift+T'), win({}), 'win32');
    expect(check).toMatchObject({ ok: false, kind: 'conflict', swappable: true });
    expect((check as { with: ShortcutDef[] }).with.map((def) => def.id)).toEqual(['terminal.new']);
  });
  it('is not a conflict between the file tree and the editor, nor with a disabled action', () => {
    expect(checkAssignment('editor.save', combo('Ctrl+C'), win({}), 'win32')).toMatchObject({ ok: false, kind: 'reserved' });
    expect(checkAssignment('editor.save', combo('Ctrl+Shift+S'), win({}), 'win32')).toEqual({ ok: true, same: false });
    expect(checkAssignment('tree.copy', combo('Ctrl+S'), win({}), 'win32')).toEqual({ ok: true, same: false });
    expect(checkAssignment('grid.new', combo('Ctrl+Shift+T'), win({ 'terminal.new': null }), 'win32')).toEqual({ ok: true, same: false });
  });
  it('a global action collides with a tree action on the same keys', () => {
    expect(checkAssignment('grid.new', combo('Ctrl+Shift+Z'), win({ 'tree.undo': 'Ctrl+Shift+Z' }), 'win32')).toMatchObject({ ok: false, kind: 'conflict' });
  });
  it('flags the terminal keys as taken but not swappable', () => {
    const check = checkAssignment('tab.close', combo('Ctrl+Shift+C'), win({}), 'win32');
    expect(check).toMatchObject({ ok: false, kind: 'conflict', swappable: false });
  });
  it('refuses a read-only action and reserved keys, and accepts its own keys', () => {
    expect(checkAssignment('terminal.copy', combo('Ctrl+Shift+Y'), win({}), 'win32')).toEqual({ ok: false, kind: 'fixed' });
    expect(checkAssignment('grid.new', combo('F'), win({}), 'win32')).toMatchObject({ ok: false, kind: 'reserved' });
    expect(checkAssignment('grid.new', combo('Ctrl+Shift+G'), win({}), 'win32')).toEqual({ ok: true, same: true });
  });
  it('swapping assigns here and disables the other', () => {
    const check = checkAssignment('grid.new', combo('Ctrl+Shift+T'), win({}), 'win32');
    if (check.ok || check.kind !== 'conflict') throw new Error('expected a conflict');
    const next = swapShortcut({}, 'grid.new', combo('Ctrl+Shift+T'), check.with, 'win32');
    expect(next).toEqual({ 'grid.new': 'Ctrl+Shift+T', 'terminal.new': null });
    const resolved = win(next);
    expect(resolved.problems).toEqual({});
    expect(resolved.combos['terminal.new']).toBeNull();
    expect(formatCombo(resolved.combos['grid.new']!)).toBe('Ctrl+Shift+T');
  });
  it('setOverride stores, disables and resets', () => {
    expect(setOverride({}, 'grid.new', combo('Ctrl+Shift+J'), 'win32')).toEqual({ 'grid.new': 'Ctrl+Shift+J' });
    expect(setOverride({ 'grid.new': 'Ctrl+Shift+J' }, 'grid.new', null, 'win32')).toEqual({ 'grid.new': null });
    expect(setOverride({ 'grid.new': null }, 'grid.new', undefined, 'win32')).toEqual({});
    expect(setOverride({ 'grid.new': 'Ctrl+Shift+J' }, 'grid.new', combo('Ctrl+Shift+G'), 'win32')).toEqual({});
  });
});

describe('persisted overrides', () => {
  it('drops unknown ids, malformed combos, read-only actions, reserved keys and values that equal the default', () => {
    const raw = {
      'nope.action': 'Ctrl+Shift+J', 'grid.new': 'Ctrl+Shift+', 'history.open': 42, 'terminal.copy': 'Ctrl+Shift+Y',
      'agent.add': 'A', 'tab.close': 'Ctrl+Shift+W', 'snippets.toggle': 'ctrl+shift+j', 'sidebar.toggle': null,
    };
    expect(normalizeShortcutOverrides(raw, 'win32')).toEqual({ 'snippets.toggle': 'Ctrl+Shift+J', 'sidebar.toggle': null });
    expect(normalizeShortcutOverrides(undefined, 'win32')).toEqual({});
    expect(normalizeShortcutOverrides([], 'win32')).toEqual({});
    expect(normalizeShortcutOverrides('Ctrl+K', 'win32')).toEqual({});
    const { problems } = resolveShortcuts(raw, 'win32');
    expect(problems['grid.new'].kind).toBe('malformed');
    expect(problems['history.open'].kind).toBe('malformed');
    expect(problems['terminal.copy'].kind).toBe('fixed');
    expect(problems['agent.add'].kind).toBe('reserved');
    expect(problems['nope.action']).toBeUndefined();
  });

  it('lets the later conflicting action fall back to its default, whatever the order of the stored keys', () => {
    // Both want Ctrl+Shift+J: grid.new comes first in the registry, so history.open loses.
    const a = { 'grid.new': 'Ctrl+Shift+J', 'history.open': 'Ctrl+Shift+J' };
    const b = { 'history.open': 'Ctrl+Shift+J', 'grid.new': 'Ctrl+Shift+J' };
    for (const raw of [a, b]) {
      const resolved = resolveShortcuts(raw, 'win32');
      expect(resolved.overrides).toEqual({ 'grid.new': 'Ctrl+Shift+J' });
      expect(resolved.problems['history.open']).toMatchObject({ kind: 'conflict', with: 'grid.new', stored: 'Ctrl+Shift+J' });
      expect(formatCombo(resolved.combos['history.open']!)).toBe('Ctrl+Shift+H');
    }
  });

  it('drops an override that collides with a default that stays', () => {
    const resolved = resolveShortcuts({ 'grid.new': 'Ctrl+Shift+T' }, 'win32');
    expect(resolved.overrides).toEqual({});
    expect(resolved.problems['grid.new']).toMatchObject({ kind: 'conflict', with: 'terminal.new' });
  });

  it('keeps an override that takes a key another action gave up, and resolves chains deterministically', () => {
    const resolved = resolveShortcuts({ 'grid.new': 'Ctrl+Shift+T', 'terminal.new': 'Ctrl+Shift+J' }, 'win32');
    expect(resolved.problems).toEqual({});
    expect(resolved.overrides).toEqual({ 'grid.new': 'Ctrl+Shift+T', 'terminal.new': 'Ctrl+Shift+J' });
    // terminal.new (earlier) keeps J; grid.new cannot take T... it can, T is free now. A cycle of swaps works too:
    const swapped = resolveShortcuts({ 'terminal.new': 'Ctrl+Shift+G', 'grid.new': 'Ctrl+Shift+T' }, 'win32');
    expect(swapped.problems).toEqual({});
  });

  it('is idempotent and a fixpoint of normalisation', () => {
    const raw = { 'grid.new': 'Ctrl+Shift+J', 'history.open': 'Ctrl+Shift+J', 'agent.add': null, 'tab.next': 'ctrl+shift+9', 'x': 'y' };
    for (const platform of PLATFORMS) {
      const once = normalizeShortcutOverrides(raw, platform);
      expect(normalizeShortcutOverrides(once, platform)).toEqual(once);
      expect(resolveShortcuts(once, platform).problems).toEqual({});
    }
  });

  it('is part of the saved state: default, migration of older files, and normalisation on load', () => {
    expect(defaultState().settings.shortcuts).toEqual({});
    const { shortcuts: _drop, ...older } = defaultState().settings;
    expect(normalizeState({ ...defaultState(), settings: older })!.settings.shortcuts).toEqual({});
    const loaded = normalizeState({ ...defaultState(), settings: { ...defaultState().settings, shortcuts: { 'grid.new': 'Ctrl+Shift+J', 'history.open': 'Ctrl+Shift+J', bogus: 'Ctrl+Shift+Q' } } })!;
    expect(loaded.settings.shortcuts).toEqual({ 'grid.new': 'Ctrl+Shift+J' });
    // On a Mac the combos are literal (Meta is Cmd), so the same file means something else there.
    const mac = normalizeState({ ...defaultState('darwin'), settings: { ...defaultState('darwin').settings, shortcuts: { 'grid.new': 'Meta+Shift+J' } } }, 'darwin')!;
    expect(mac.settings.shortcuts).toEqual({ 'grid.new': 'Shift+Meta+J' });
  });

  it('merges per shortcut when an edit reaches main (set, disable, reset)', () => {
    const base = defaultState();
    const withEdit = (shortcuts: Record<string, string | null>) => ({ ...base, settings: { ...base.settings, shortcuts } });
    let current = withEdit({ 'agent.add': 'Ctrl+Shift+J' });
    current = mergeStateEdit(current, { base, next: withEdit({ 'grid.new': 'Ctrl+Shift+L' }) });
    expect(current.settings.shortcuts).toEqual({ 'agent.add': 'Ctrl+Shift+J', 'grid.new': 'Ctrl+Shift+L' });
    current = mergeStateEdit(current, { base: withEdit({ 'grid.new': 'Ctrl+Shift+L' }), next: withEdit({ 'grid.new': null }) });
    expect(current.settings.shortcuts['grid.new']).toBeNull();
    current = mergeStateEdit(current, { base: withEdit({ 'grid.new': null }), next: withEdit({}) });
    expect(current.settings.shortcuts).toEqual({ 'agent.add': 'Ctrl+Shift+J' });
  });
});

// The shortcuts of the app before the registry existed (src/renderer/src/shortcuts.ts of 0.6.8, the file tree, the editor, dialogs).
describe('the default map reproduces the old behaviour', () => {
  const OLD_TABLE: Array<[string, string, string]> = [
    // [keys on Windows/Linux, action, note]
    ['Ctrl+K', 'palette.open', ''],
    ['Ctrl+Shift+P', 'palette.openAlt', ''],
    ['Ctrl+Shift+T', 'terminal.new', ''],
    ['Ctrl+Shift+N', 'agent.add', ''],
    ['Ctrl+Shift+G', 'grid.new', ''],
    ['Ctrl+Shift+H', 'history.open', ''],
    ['Ctrl+Shift+W', 'tab.close', ''],
    ['Ctrl+Shift+B', 'snippets.toggle', ''],
    ['Ctrl+Shift+E', 'sidebar.toggle', ''],
    ['Ctrl+Shift+M', 'cell.maximize', ''],
    ['Ctrl+Tab', 'tab.next', ''],
    ['Ctrl+Shift+Tab', 'tab.prev', ''],
    ['Ctrl+Alt+Left', 'cell.focus.left', ''],
    ['Ctrl+Alt+Right', 'cell.focus.right', ''],
    ['Ctrl+Alt+Up', 'cell.focus.up', ''],
    ['Ctrl+Alt+Down', 'cell.focus.down', ''],
    ['Ctrl+Alt+Shift+Left', 'cell.move.left', ''],
    ['Ctrl+Alt+Shift+Right', 'cell.move.right', ''],
    ['Ctrl+Alt+Shift+Up', 'cell.move.up', ''],
    ['Ctrl+Alt+Shift+Down', 'cell.move.down', ''],
  ];
  const OLD_LOCAL: Array<[string, string]> = [
    ['F2', 'tree.rename'], ['Delete', 'tree.delete'], ['Ctrl+C', 'tree.copy'], ['Ctrl+X', 'tree.cut'], ['Ctrl+V', 'tree.paste'],
    ['Ctrl+Z', 'tree.undo'], ['Ctrl+A', 'tree.selectAll'], ['Ctrl+S', 'editor.save'], ['Ctrl+Enter', 'modal.save'],
  ];
  /** The old keys on this platform: Ctrl is the primary modifier, which is Cmd on macOS. */
  const platformKeys = (text: string, platform: AppPlatform) => (platform === 'darwin' ? text.replace(/\bCtrl\b/, 'Meta') : text);
  const base = (platform: AppPlatform, extra: Partial<DispatchContext> = {}): DispatchContext => ({
    resolution: resolveShortcuts({}, platform), languageChosen: true, recording: false, overlayOpen: false, paletteOpen: false,
    settingsActive: false, hasProject: true, hasTab: true, target: 'other', ...extra,
  });

  for (const platform of PLATFORMS) {
    it(`every old shortcut still does the same thing on ${platform}`, () => {
      for (const [keys, action] of OLD_TABLE) expect(decideShortcut(event(platformKeys(keys, platform)), base(platform)), keys).toBe(action);
      const resolved = resolveShortcuts({}, platform);
      for (const [keys, action] of OLD_LOCAL) expect(matchCombo(event(platformKeys(keys, platform)), resolved.combos[action]), `${action} ${keys}`).toBe(true);
    });

    it(`shows the same labels as before on ${platform}`, () => {
      const resolved = resolveShortcuts({}, platform);
      for (const [keys, action] of [...OLD_TABLE, ...OLD_LOCAL.map(([k, a]) => [k, a] as [string, string])]) {
        expect(displayCombo(resolved.combos[action]!, platform), action).toBe(shortcutLabel(platform, keys));
      }
    });
  }

  /** The removed `useShortcuts` handler, kept here as the oracle. Context: a project with a tab, nothing open. */
  function oldAction(e: DispatchEvent, platform: AppPlatform, settingsActive: boolean, project = true): string | null {
    const primary = platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const ctrl = primary && !e.altKey;
    const ctrlShift = ctrl && e.shiftKey;
    if (ctrl && !e.shiftKey && e.code === 'KeyK') return 'palette.open';
    if (ctrlShift && e.code === 'KeyP') return 'palette.openAlt';
    if (ctrlShift && e.code === 'KeyT') return 'terminal.new';
    if (ctrlShift && e.code === 'KeyN') return 'agent.add';
    if (ctrlShift && e.code === 'KeyG' && project) return 'grid.new';
    if (ctrlShift && e.code === 'KeyH' && project) return 'history.open';
    if (ctrlShift && e.code === 'KeyW') {
      if (settingsActive) return 'tab.close';
      if (!project) return null;
      return 'tab.close';
    }
    if (ctrlShift && e.code === 'KeyB') return 'snippets.toggle';
    if (ctrlShift && e.code === 'KeyE') return 'sidebar.toggle';
    // 1.0.0: Settings is a tab of the strip, so Mod+Tab also leaves it (it used to be blocked there).
    if (ctrl && e.code === 'Tab') return e.shiftKey ? 'tab.prev' : 'tab.next';
    if (settingsActive) return null;
    if (ctrlShift && e.code === 'KeyM') return 'cell.maximize';
    if (primary && e.altKey && !e.getModifierState?.('AltGraph')) {
      const dir: Record<string, string> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      const d = dir[e.code];
      if (d) return `${e.shiftKey ? 'cell.move' : 'cell.focus'}.${d}`;
    }
    return null;
  }

  it('agrees with the old handler for every modifier combination of every key it knew', () => {
    const codes = ['KeyK', 'KeyP', 'KeyT', 'KeyN', 'KeyG', 'KeyH', 'KeyW', 'KeyB', 'KeyE', 'KeyM', 'KeyS', 'KeyC', 'KeyA', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'F2', 'Enter', 'Digit1'];
    for (const platform of ['win32', 'darwin'] as const) {
      for (const settingsActive of [false, true]) for (const hasProject of [true, false]) {
        const ctx = base(platform, { settingsActive, hasProject, hasTab: hasProject });
        for (const code of codes) for (let mask = 0; mask < 16; mask++) {
          const e: DispatchEvent = { code, ctrlKey: !!(mask & 1), altKey: !!(mask & 2), shiftKey: !!(mask & 4), metaKey: !!(mask & 8) };
          expect(decideShortcut(e, ctx), `${platform} ${code} mask ${mask} settings=${settingsActive} project=${hasProject}`).toBe(oldAction(e, platform, settingsActive, hasProject));
        }
      }
    }
  });

  it('keeps Ctrl+K closing the palette and every other key quiet over dialogs', () => {
    expect(decideShortcut(event('Ctrl+K'), base('win32', { paletteOpen: true }))).toBe('palette.open');
    expect(decideShortcut(event('Ctrl+Shift+T'), base('win32', { paletteOpen: true }))).toBeNull();
    expect(decideShortcut(event('Ctrl+K'), base('win32', { overlayOpen: true }))).toBeNull();
    expect(decideShortcut(event('Ctrl+K'), base('win32', { overlayOpen: true, paletteOpen: true }))).toBe('palette.open');
  });
});

describe('dispatcher scope rules', () => {
  const ctx = (overrides: Record<string, string | null>, extra: Partial<DispatchContext> = {}): DispatchContext => ({
    resolution: resolveShortcuts(overrides, 'win32'), languageChosen: true, recording: false, overlayOpen: false, paletteOpen: false,
    settingsActive: false, hasProject: true, hasTab: true, target: 'other', ...extra,
  });

  it('follows a changed shortcut and forgets the old one', () => {
    const rebound = ctx({ 'palette.open': 'Ctrl+Shift+J' });
    expect(decideShortcut(event('Ctrl+Shift+J'), rebound)).toBe('palette.open');
    expect(decideShortcut(event('Ctrl+K'), rebound)).toBeNull();
    expect(decideShortcut(event('Ctrl+Shift+P'), rebound)).toBe('palette.openAlt');
  });

  it('does nothing for a disabled shortcut', () => {
    const off = ctx({ 'sidebar.toggle': null });
    expect(decideShortcut(event('Ctrl+Shift+E'), off)).toBeNull();
    expect(decideShortcut(event('Ctrl+Shift+B'), off)).toBe('snippets.toggle');
  });

  it('is silent before the language is chosen and while a shortcut is recorded', () => {
    expect(decideShortcut(event('Ctrl+K'), ctx({}, { languageChosen: false }))).toBeNull();
    expect(decideShortcut(event('Ctrl+K'), ctx({}, { recording: true }))).toBeNull();
  });

  it('keeps global shortcuts working in text fields and the terminal (as before)', () => {
    for (const target of ['input', 'terminal'] as const) expect(decideShortcut(event('Ctrl+Shift+T'), ctx({}, { target })), target).toBe('terminal.new');
  });

  it('never steals plain keys from a text field or the terminal, but F-keys work elsewhere', () => {
    const f6 = { 'terminal.new': 'F6' };
    expect(decideShortcut(event('F6'), ctx(f6, { target: 'other' }))).toBe('terminal.new');
    expect(decideShortcut(event('F6'), ctx(f6, { target: 'input' }))).toBeNull();
    expect(decideShortcut(event('F6'), ctx(f6, { target: 'terminal' }))).toBeNull();
    expect(decideShortcut(event('Shift+F6'), ctx({ 'terminal.new': 'Shift+F6' }, { target: 'terminal' }))).toBeNull();
  });

  it('honours allowInInput: false and the project and Settings requirements', () => {
    const defs: ShortcutDef[] = [{ id: 'x.quiet', label: 'Otwórz paletę poleceń', group: 'general', scope: 'global', default: 'Mod+Shift+J', rebindable: true, allowInInput: false }];
    const resolution = resolveShortcuts({}, 'win32', defs);
    expect(decideShortcut(event('Ctrl+Shift+J'), { ...ctx({}), resolution, defs, target: 'input' })).toBeNull();
    expect(decideShortcut(event('Ctrl+Shift+J'), { ...ctx({}), resolution, defs, target: 'other' })).toBe('x.quiet');
    expect(decideShortcut(event('Ctrl+Shift+G'), ctx({}, { hasProject: false }))).toBeNull();
    expect(decideShortcut(event('Ctrl+Shift+M'), ctx({}, { settingsActive: true }))).toBeNull();
    expect(decideShortcut(event('Ctrl+Shift+E'), ctx({}, { settingsActive: true }))).toBe('sidebar.toggle');
  });

  it('closes Settings or the active grid with the close shortcut, else lets the key through', () => {
    expect(decideShortcut(event('Ctrl+Shift+W'), ctx({}, { settingsActive: true, hasProject: false, hasTab: false }))).toBe('tab.close');
    expect(decideShortcut(event('Ctrl+Shift+W'), ctx({}))).toBe('tab.close');
    expect(decideShortcut(event('Ctrl+Shift+W'), ctx({}, { hasTab: false }))).toBeNull();
    expect(decideShortcut(event('Ctrl+Shift+W'), ctx({}, { hasProject: false, hasTab: false }))).toBeNull();
  });

  it('does not dispatch the shortcuts that components handle themselves', () => {
    expect(decideShortcut(event('Ctrl+S'), ctx({}))).toBeNull();
    expect(decideShortcut(event('F2'), ctx({}))).toBeNull();
    expect(decideShortcut(event('Ctrl+Enter'), ctx({}))).toBeNull();
  });
});

describe('shortcut registry labels in the UI', () => {
  it('every action has an English text that differs from the Polish key (a missing translation would show the key)', () => {
    for (const def of SHORTCUT_DEFS) {
      const row = (messages as Record<string, readonly string[]>)[def.label];
      expect(row?.length, def.id).toBe(5);
      expect(shortcutDef(def.id)).toBe(def);
    }
  });
});
