import { describe, expect, it } from 'vitest';
import { MRU_LIMIT, mruOrder, stepIndex, switchHeld, touchMru } from '../src/shared/tabMru';
import { decideShortcut } from '../src/shared/shortcutDispatch';
import { resolveShortcuts, shortcutDef } from '../src/shared/shortcuts';

describe('recently used tabs', () => {
  it('moves a tab to the front and keeps the list short', () => {
    let mru: string[] = [];
    for (const key of ['grid:a', 'grid:b', 'file:c', 'grid:a']) mru = touchMru(mru, key);
    expect(mru).toEqual(['grid:a', 'file:c', 'grid:b']);
    expect(touchMru(mru, 'grid:a')).toBe(mru);
    expect(touchMru(mru, null)).toBe(mru);
    const long = Array.from({ length: MRU_LIMIT + 10 }, (_, i) => `grid:${i}`).reduce<string[]>((list, key) => touchMru(list, key), []);
    expect(long.length).toBe(MRU_LIMIT);
    expect(long[0]).toBe(`grid:${MRU_LIMIT + 9}`);
  });

  it('orders the shown tabs: the one in front, then most recent first, then the never used ones in strip order', () => {
    const shown = ['grid:a', 'grid:b', 'file:c', 'settings', 'grid:d'];
    const mru = ['file:c', 'grid:x-closed', 'grid:a', 'grid:b'];
    expect(mruOrder(mru, shown, 'file:c')).toEqual(['file:c', 'grid:a', 'grid:b', 'settings', 'grid:d']);
    // The tab in front comes first even when the list has not caught up yet.
    expect(mruOrder(mru, shown, 'grid:d')).toEqual(['grid:d', 'file:c', 'grid:a', 'grid:b', 'settings']);
  });

  it('leaves out what the strip does not show (scope "project", grids in their own window)', () => {
    const mru = ['grid:other-project', 'grid:detached', 'grid:b', 'grid:a'];
    expect(mruOrder(mru, ['grid:a', 'grid:b'], 'grid:a')).toEqual(['grid:a', 'grid:b']);
    // The SSH view in front: no strip tab is active.
    expect(mruOrder(mru, ['grid:a', 'grid:b'], null)).toEqual(['grid:b', 'grid:a']);
  });

  it('a tap toggles between the last two tabs', () => {
    let mru: string[] = [];
    const shown = ['grid:a', 'grid:b', 'grid:c'];
    for (const key of ['grid:a', 'grid:c', 'grid:b']) mru = touchMru(mru, key);
    // Ctrl+Tab from b goes to c (index 1 of the order), and from c back to b.
    let order = mruOrder(mru, shown, 'grid:b');
    expect(order[stepIndex(order.length, 0, 1)]).toBe('grid:c');
    mru = touchMru(mru, 'grid:c');
    order = mruOrder(mru, shown, 'grid:c');
    expect(order[stepIndex(order.length, 0, 1)]).toBe('grid:b');
  });

  it('walks further while held and wraps both ways', () => {
    expect(stepIndex(4, 1, 1)).toBe(2);
    expect(stepIndex(4, 3, 1)).toBe(0);
    expect(stepIndex(4, 0, -1)).toBe(3);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });

  it('commits when the held modifier is released (Shift alone does not hold the switch)', () => {
    const mods = { ctrl: true, alt: false, shift: true, meta: false };
    expect(switchHeld(mods, { ctrlKey: true, altKey: false, metaKey: false })).toBe(true);
    expect(switchHeld(mods, { ctrlKey: false, altKey: false, metaKey: false })).toBe(false);
    expect(switchHeld({ ctrl: false, alt: true, shift: false, meta: false }, { ctrlKey: true, altKey: false, metaKey: false })).toBe(false);
  });
});

describe('the Ctrl+Tab shortcut', () => {
  const ctx = (platform: 'win32' | 'darwin', extra = {}) => ({
    resolution: resolveShortcuts({}, platform), languageChosen: true, recording: false, overlayOpen: false, paletteOpen: false,
    settingsActive: false, hasProject: true, hasTab: true, target: 'terminal' as const, ...extra,
  });
  const tab = (mods: { ctrl?: boolean; shift?: boolean; meta?: boolean }) => ({ code: 'Tab', key: 'Tab', ctrlKey: !!mods.ctrl, altKey: false, shiftKey: !!mods.shift, metaKey: !!mods.meta });

  it('is taken from the terminal on every platform (Ctrl, also on macOS) and stays rebindable', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      expect(decideShortcut(tab({ ctrl: true }), ctx(platform))).toBe('tab.next');
      expect(decideShortcut(tab({ ctrl: true, shift: true }), ctx(platform))).toBe('tab.prev');
      expect(decideShortcut(tab({}), ctx(platform))).toBeNull();
    }
    expect(decideShortcut(tab({ meta: true }), ctx('darwin'))).toBeNull();
    expect(shortcutDef('tab.next')?.rebindable).toBe(true);
    // The strip order keeps its actions, without a key unless the user gives them one.
    expect(resolveShortcuts({}, 'win32').combos['tab.right']).toBeNull();
    expect(resolveShortcuts({ 'tab.right': 'Ctrl+Shift+]' }, 'win32').combos['tab.right']).not.toBeNull();
  });

  it('is quiet over dialogs', () => {
    expect(decideShortcut(tab({ ctrl: true }), ctx('win32', { overlayOpen: true }))).toBeNull();
  });
});
