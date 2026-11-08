import { describe, expect, it } from 'vitest';
import { fullProjectPath, shortcutLabel } from '../src/shared/platform';

describe('platform support', () => {
  it('uses native paths for file explorer actions', () => {
    expect(fullProjectPath('/Users/ala/My Project/', 'src/file.ts', 'darwin')).toBe('/Users/ala/My Project/src/file.ts');
    expect(fullProjectPath('D:\\My Project\\', 'src/file.ts', 'win32')).toBe('D:\\My Project\\src\\file.ts');
    expect(fullProjectPath('/Users/ala', '', 'darwin')).toBe('/Users/ala');
  });

  it('displays Command and Option on macOS', () => {
    expect(shortcutLabel('darwin', 'Ctrl+Shift+G · Ctrl+Alt+Arrows')).toBe('Cmd+Shift+G · Cmd+Option+Arrows');
    expect(shortcutLabel('win32', 'Ctrl+K')).toBe('Ctrl+K');
  });
});
