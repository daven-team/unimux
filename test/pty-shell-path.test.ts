import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveShell } from '../src/ptyhost/manager';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Windows shell lookup uses the cell PATH', () => {
  it('returns the absolute path of pwsh.exe found on the cell PATH (the pty host PATH may be older)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-pwsh-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'pwsh.exe'), '');
    expect(resolveShell('pwsh', { PATH: dir }, 'win32')).toEqual({ file: join(dir, 'pwsh.exe'), args: ['-NoLogo'] });
  });

  it('falls back to Windows PowerShell when pwsh is not on the PATH, and ignores the lookup for other shells', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-nopwsh-'));
    dirs.push(dir);
    // 1.1.3: by its absolute System32 path when it is there (not the bare name, which depends on the host's own PATH).
    const system = join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const expected = existsSync(system) ? system : 'powershell.exe';
    expect(resolveShell('pwsh', { PATH: dir }, 'win32')).toEqual({ file: expected, args: ['-NoLogo'] });
    expect(resolveShell('powershell', { PATH: dir }, 'win32')).toEqual({ file: expected, args: ['-NoLogo'] });
    const powershellDir = mkdtempSync(join(tmpdir(), 'mc-ps-'));
    dirs.push(powershellDir);
    writeFileSync(join(powershellDir, 'powershell.exe'), '');
    expect(resolveShell('pwsh', { PATH: powershellDir }, 'win32')).toEqual({ file: join(powershellDir, 'powershell.exe'), args: ['-NoLogo'] });
  });
});
