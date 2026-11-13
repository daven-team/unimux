import { describe, expect, it } from 'vitest';
import { decideShortcut, type DispatchContext, type DispatchEvent } from '../src/shared/shortcutDispatch';
import { displayCombo, resolveShortcuts } from '../src/shared/shortcuts';
import type { AppPlatform } from '../src/shared/platform';
import { readZoomLevel, stepZoomLevel, UI_ZOOM_LEVELS } from '../src/shared/uiZoomLevels';

const ctx = (platform: AppPlatform, target: DispatchContext['target']): DispatchContext => ({
  resolution: resolveShortcuts({}, platform), languageChosen: true, recording: false, overlayOpen: false, paletteOpen: false,
  settingsActive: false, hasProject: true, hasTab: true, target,
});
const press = (code: string, mods: Partial<DispatchEvent> = {}): DispatchEvent => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('File > New text file (Mod+N)', () => {
  it('opens an untitled tab, but Ctrl+N in a terminal stays with the program there', () => {
    expect(decideShortcut(press('KeyN', { ctrlKey: true }), ctx('win32', 'other'))).toBe('file.new');
    expect(decideShortcut(press('KeyN', { ctrlKey: true }), ctx('win32', 'input'))).toBe('file.new');
    expect(decideShortcut(press('KeyN', { ctrlKey: true }), ctx('win32', 'terminal'))).toBeNull();
    // Cmd+N never reaches a program in the terminal.
    expect(decideShortcut(press('KeyN', { metaKey: true }), ctx('darwin', 'terminal'))).toBe('file.new');
    expect(decideShortcut(press('KeyN', { ctrlKey: true }), ctx('darwin', 'terminal'))).toBeNull();
    // Ctrl+Shift+N stays "add an agent".
    expect(decideShortcut(press('KeyN', { ctrlKey: true, shiftKey: true }), ctx('win32', 'terminal'))).toBe('agent.add');
  });

  it('has Save As on Mod+Shift+S next to Save, without any conflict', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const resolved = resolveShortcuts({}, platform);
      expect(resolved.problems).toEqual({});
      expect(displayCombo(resolved.combos['editor.saveAs']!, platform)).toBe(platform === 'darwin' ? 'Cmd+Shift+S' : 'Ctrl+Shift+S');
      expect(displayCombo(resolved.combos['file.new']!, platform)).toBe(platform === 'darwin' ? 'Cmd+N' : 'Ctrl+N');
    }
  });
});

describe('window zoom levels', () => {
  it('reads only known levels', () => {
    expect(readZoomLevel('1.25')).toBe(1.25);
    expect(readZoomLevel('1.3')).toBe(1);
    expect(readZoomLevel(null)).toBe(1);
    expect(readZoomLevel('abc')).toBe(1);
  });
  it('steps through the levels and stops at either end', () => {
    expect(stepZoomLevel(1, 1)).toBe(1.1);
    expect(stepZoomLevel(1, -1)).toBe(0.9);
    expect(stepZoomLevel(UI_ZOOM_LEVELS[UI_ZOOM_LEVELS.length - 1], 1)).toBe(2);
    expect(stepZoomLevel(UI_ZOOM_LEVELS[0], -1)).toBe(0.67);
    expect(stepZoomLevel(1.3, -1)).toBe(1.25);
  });
});
