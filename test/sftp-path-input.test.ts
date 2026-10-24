import { describe, expect, it } from 'vitest';
import {
  applyCompletion, cleanPathInput, commonStart, completionMatches, completionQuery, editablePath, needsHome, resolveLocalInput, resolveRemoteInput, tabCompletion,
} from '../src/shared/sftpPathInput';
import { DRIVES } from '../src/shared/sftpView';

describe('typed remote paths', () => {
  const r = (text: string, cwd: string | null = '/srv/app', home: string | null = '/home/ola') => resolveRemoteInput(text, cwd, home);
  it('keeps absolute paths and normalizes them', () => {
    expect(r('/etc')).toBe('/etc');
    expect(r('/var//log/')).toBe('/var/log');
    expect(r('/var/log/../lib/./dpkg/')).toBe('/var/lib/dpkg');
    expect(r('/../..')).toBe('/');
    expect(r('/')).toBe('/');
  });
  it('resolves relative paths against the shown folder', () => {
    expect(r('logs')).toBe('/srv/app/logs');
    expect(r('./logs/')).toBe('/srv/app/logs');
    expect(r('..')).toBe('/srv');
    expect(r('../../../..')).toBe('/');
    expect(r('logs', null)).toBeNull();
  });
  it('expands ~ to the login folder', () => {
    expect(r('~')).toBe('/home/ola');
    expect(r('~/')).toBe('/home/ola');
    expect(r('~/.ssh')).toBe('/home/ola/.ssh');
    expect(r('~/a/../b')).toBe('/home/ola/b');
    expect(r('~', '/srv', null)).toBeNull();
    expect(r('~root')).toBeNull();
    expect(r('/tmp/~x')).toBe('/tmp/~x');
  });
  it('strips quotes and spaces around a pasted path', () => {
    expect(r('  /etc/nginx  ')).toBe('/etc/nginx');
    expect(r('"/srv/my files"')).toBe('/srv/my files');
    expect(r("'/srv'")).toBe('/srv');
  });
  it('refuses empty text, control characters and backslashes', () => {
    expect(r('')).toBeNull();
    expect(r('   ')).toBeNull();
    expect(r('/etc\nx')).toBeNull();
    expect(r('/a\0b')).toBeNull();
    expect(r('C:\\Users')).toBeNull();
  });
  it('knows when the home folder is needed', () => {
    expect(needsHome('~')).toBe(true);
    expect(needsHome(' ~/x ')).toBe(true);
    expect(needsHome('~\\x')).toBe(true);
    expect(needsHome('/~')).toBe(false);
    expect(needsHome('~root')).toBe(false);
  });
});

describe('typed local paths on Windows', () => {
  const w = (text: string, cwd: string | null = 'C:\\Users\\ola\\Documents', home: string | null = 'C:\\Users\\ola') => resolveLocalInput(text, cwd, home, 'win32');
  it('reads drive paths with either separator and normalizes them', () => {
    expect(w('D:\\Projekty')).toBe('D:\\Projekty');
    expect(w('d:/projekty/app/')).toBe('D:\\projekty\\app');
    expect(w('C:')).toBe('C:\\');
    expect(w('c:\\')).toBe('C:\\');
    expect(w('C:\\Windows\\..\\Users\\.\\ola\\\\')).toBe('C:\\Users\\ola');
    expect(w('C:\\..\\..')).toBe('C:\\');
    expect(w('C:foo')).toBe('C:\\foo');
  });
  it('drops the trailing dots and spaces Explorer ignores', () => {
    expect(w('C:\\Temp. ')).toBe('C:\\Temp');
    expect(w('C:\\a\\...')).toBe('C:\\a');
  });
  it('reads UNC shares and keeps .. inside the share', () => {
    expect(w('\\\\nas\\public\\docs')).toBe('\\\\nas\\public\\docs');
    expect(w('//nas/public/')).toBe('\\\\nas\\public\\');
    expect(w('\\\\nas\\public\\..\\..')).toBe('\\\\nas\\public\\');
    expect(w('\\\\nas')).toBeNull();
    expect(w('\\\\?\\C:\\x')).toBeNull();
    expect(w('\\\\.\\PhysicalDrive0')).toBeNull();
  });
  it('resolves relative paths, the drive root and ~', () => {
    expect(w('Projekty')).toBe('C:\\Users\\ola\\Documents\\Projekty');
    expect(w('..\\Desktop')).toBe('C:\\Users\\ola\\Desktop');
    expect(w('\\Temp')).toBe('C:\\Temp');
    expect(w('\\')).toBe('C:\\');
    expect(w('~')).toBe('C:\\Users\\ola');
    expect(w('~/Downloads')).toBe('C:\\Users\\ola\\Downloads');
    expect(w('a', '\\\\nas\\public\\')).toBe('\\\\nas\\public\\a');
    expect(w('Projekty', DRIVES)).toBeNull();
    expect(w('Projekty', null)).toBeNull();
    expect(w('~', DRIVES, null)).toBeNull();
  });
  it('strips the quotes of "Copy as path"', () => {
    expect(w('"C:\\Program Files\\Git"')).toBe('C:\\Program Files\\Git');
  });
  it('refuses reserved characters and streams', () => {
    expect(w('C:\\a|b')).toBeNull();
    expect(w('C:\\a?')).toBeNull();
    expect(w('C:\\file.txt:stream')).toBeNull();
    expect(w('')).toBeNull();
    expect(w('~ola')).toBeNull();
  });
});

describe('typed local paths on macOS', () => {
  const m = (text: string) => resolveLocalInput(text, '/Users/ola/Documents', '/Users/ola', 'posix');
  it('is POSIX with ~', () => {
    expect(m('/Applications/')).toBe('/Applications');
    expect(m('~/Desktop')).toBe('/Users/ola/Desktop');
    expect(m('../Downloads')).toBe('/Users/ola/Downloads');
    expect(m('a\\b')).toBe('/Users/ola/Documents/a\\b');
    expect(m('')).toBeNull();
  });
});

describe('path completion', () => {
  it('splits the text at the last separator', () => {
    expect(completionQuery('/var/lo', 'posix')).toEqual({ dir: '/var/', partial: 'lo' });
    expect(completionQuery('/var/', 'posix')).toEqual({ dir: '/var/', partial: '' });
    expect(completionQuery('log', 'posix')).toEqual({ dir: '', partial: 'log' });
    expect(completionQuery('C:\\Users/ol', 'win32')).toEqual({ dir: 'C:\\Users/', partial: 'ol' });
    expect(completionQuery('a\\b', 'posix')).toEqual({ dir: '', partial: 'a\\b' });
  });
  it('lists matching folder names, hidden ones only for a dot', () => {
    const names = ['log', 'lib', 'Local', '.cache', 'lib64', '..'];
    expect(completionMatches(names, 'l', false)).toEqual(['lib', 'lib64', 'log', 'Local']);
    expect(completionMatches(names, 'l', true)).toEqual(['lib', 'lib64', 'Local', 'log']);
    expect(completionMatches(names, '', false)).toEqual(['lib', 'lib64', 'Local', 'log']);
    expect(completionMatches(names, '.', false)).toEqual(['.cache']);
    expect(completionMatches(names, 'x', false)).toEqual([]);
    expect(completionMatches(names, 'l', false, 2)).toEqual(['lib', 'lib64']);
  });
  it('finds the common start', () => {
    expect(commonStart(['lib', 'lib64'], false)).toBe('lib');
    expect(commonStart(['Program Files', 'program data'], true)).toBe('Program ');
    expect(commonStart(['Program Files', 'program data'], false)).toBe('');
    expect(commonStart([], false)).toBe('');
  });
  it('completes with Tab', () => {
    expect(tabCompletion('/var/lo', ['log'], 'posix', false)).toBe('/var/log/');
    expect(tabCompletion('/usr/li', ['lib', 'lib64'], 'posix', false)).toBe('/usr/lib');
    expect(tabCompletion('/usr/lib', ['lib', 'lib64'], 'posix', false)).toBeNull();
    expect(tabCompletion('/x/', [], 'posix', false)).toBeNull();
    expect(tabCompletion('c:\\users\\o', ['ola'], 'win32', true)).toBe('c:\\users\\ola\\');
    expect(tabCompletion('c:/users/o', ['ola'], 'win32', true)).toBe('c:/users/ola/');
    expect(tabCompletion('pro', ['Projekty'], 'win32', true)).toBe('Projekty\\');
  });
  it('applies a picked name', () => {
    expect(applyCompletion('/var/l', 'log', 'posix')).toBe('/var/log/');
    expect(applyCompletion('/var/l', 'lo', 'posix', false)).toBe('/var/lo');
  });
  it('shows no text for the drive list', () => {
    expect(editablePath(DRIVES)).toBe('');
    expect(editablePath(null)).toBe('');
    expect(editablePath('/etc')).toBe('/etc');
  });
});

describe('cleanPathInput', () => {
  it('trims and unquotes', () => {
    expect(cleanPathInput('  "x"  ')).toBe('x');
    expect(cleanPathInput('"')).toBe('"');
  });
});
