import { describe, expect, it } from 'vitest';
import {
  applyPortMessage, failUnfinished, isPartName, isSftpSessionId, keepBothName, kindFromMode, overallProgress, ownerFromLongname, partName,
  permissionString, posixBasename, posixContains, posixJoin, posixNormalize, posixParent, safeEntryName, sftpErrorText, sftpSessionId,
  sftpStatusOf, validRemoteName, validRemotePath, type SftpErrorCode, type TransferItem,
} from '../src/shared/sftp';
import { messages } from '../src/shared/messages';

describe('POSIX remote paths', () => {
  it('normalizes, joins and splits with "/" only', () => {
    expect(posixNormalize('/a//b/./c/../d/')).toBe('/a/b/d');
    expect(posixNormalize('/../..')).toBe('/');
    expect(posixNormalize('a/../../b')).toBe('../b');
    expect(posixNormalize('')).toBe('.');
    expect(posixJoin('/home/alice', 'docs', 'a.txt')).toBe('/home/alice/docs/a.txt');
    expect(posixJoin('/home/alice/', '/etc', 'x')).toBe('/etc/x');
    expect(posixJoin('/a', 'b\\c')).toBe('/a/b\\c');
    expect(posixParent('/a/b')).toBe('/a');
    expect(posixParent('/a')).toBe('/');
    expect(posixParent('/')).toBe('/');
    expect(posixBasename('/a/b.txt')).toBe('b.txt');
    expect(posixBasename('/')).toBe('');
    expect(posixContains('/a', '/a/b')).toBe(true);
    expect(posixContains('/a', '/ab')).toBe(false);
    expect(posixContains('/a', '/a/../b')).toBe(false);
    expect(posixContains('/', '/x')).toBe(true);
  });

  it('accepts only absolute POSIX paths and single names', () => {
    expect(validRemotePath('/home')).toBe(true);
    expect(validRemotePath('home')).toBe(false);
    expect(validRemotePath('C:\\x')).toBe(false);
    expect(validRemotePath('/a\0b')).toBe(false);
    expect(validRemoteName('a.txt')).toBe(true);
    expect(validRemoteName('..')).toBe(false);
    expect(validRemoteName('a/b')).toBe(false);
  });
});

describe('safeEntryName', () => {
  it('rejects names that are not one safe path segment', () => {
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256)]) expect(safeEntryName(bad), JSON.stringify(bad)).toBe(false);
    for (const good of ['a.txt', '.bashrc', 'c:d', 'NUL', 'name. ', 'a b']) expect(safeEntryName(good), good).toBe(true);
    expect(safeEntryName(3)).toBe(false);
  });

  it('adds the Windows rules for local Windows paths', () => {
    for (const bad of ['c:d', 'C:', 'NUL', 'nul.txt', 'COM1', 'lpt9.log', 'CON', 'trailing.', 'trailing ', 'a<b', 'a|b', 'a?b', 'a*b', 'a"b', 'tab\tx'])
      expect(safeEntryName(bad, { windows: true }), bad).toBe(false);
    for (const good of ['a.txt', 'console.log', 'nulls', '.git']) expect(safeEntryName(good, { windows: true }), good).toBe(true);
  });
});

describe('names, modes and ids', () => {
  it('keep-both names avoid every existing name and part file', () => {
    expect(keepBothName('report.pdf', ['report.pdf'])).toBe('report (1).pdf');
    expect(keepBothName('report.pdf', ['report.pdf', 'report (1).pdf'])).toBe('report (2).pdf');
    expect(keepBothName('report (1).pdf', ['report (1).pdf'])).toBe('report (2).pdf');
    expect(keepBothName('archive.tar.gz', [])).toBe('archive.tar (1).gz');
    expect(keepBothName('.bashrc', ['.bashrc'])).toBe('.bashrc (1)');
    expect(keepBothName('site.v2', [], { directory: true })).toBe('site.v2 (1)');
    expect(keepBothName('A.txt', ['a (1).txt'], { caseInsensitive: true })).toBe('A (2).txt');
    expect(keepBothName('a.txt', ['a (1).txt.unimux-part'])).toBe('a (2).txt');
    expect(partName('a.txt')).toBe('a.txt.unimux-part');
    expect(isPartName('a.txt.unimux-part')).toBe(true);
    expect(isPartName('.unimux-part')).toBe(false);
  });

  it('turns mode bits into ls strings and kinds', () => {
    expect(permissionString(0o040755)).toBe('drwxr-xr-x');
    expect(permissionString(0o100644)).toBe('-rw-r--r--');
    expect(permissionString(0o120777)).toBe('lrwxrwxrwx');
    expect(permissionString(0o104755)).toBe('-rwsr-xr-x');
    expect(permissionString(0o102644)).toBe('-rw-r-Sr--');
    expect(permissionString(0o041777)).toBe('drwxrwxrwt');
    expect(permissionString(undefined)).toBe('');
    expect(kindFromMode(0o040000)).toBe('dir');
    expect(kindFromMode(0o100000)).toBe('file');
    expect(kindFromMode(0o120000)).toBe('symlink');
    expect(kindFromMode(0o010000)).toBe('other');
    expect(ownerFromLongname('-rw-r--r--    1 alice    staff 12 Jan  1 00:00 a.txt')).toEqual({ owner: 'alice', group: 'staff' });
    expect(ownerFromLongname('a.txt')).toEqual({});
  });

  it('session ids live in the "sftp:" namespace', () => {
    const id = sftpSessionId('11111111-2222-4333-8444-555555555555');
    expect(isSftpSessionId(id)).toBe(true);
    expect(isSftpSessionId('11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(isSftpSessionId('sftp:x')).toBe(false);
    expect(sftpStatusOf('verifying')).toBe('connecting');
    expect(sftpStatusOf('connected')).toBe('connected');
    expect(sftpStatusOf('error')).toBe('error');
    expect(sftpStatusOf('closed')).toBe('closed');
  });
});

describe('transfer items on the renderer side', () => {
  const item = (id: string, state: TransferItem['state'], done = 0): TransferItem => ({ id, batchId: 'b', sessionId: 's', direction: 'upload', source: '/x', target: '/y', name: id, bytesDone: done, bytesTotal: 10, speed: 0, state });
  it('applies port messages in order and fails what was unfinished after a host restart', () => {
    let list = applyPortMessage([], { t: 'snapshot', items: [item('a', 'running', 5)] });
    list = applyPortMessage(list, { t: 'items', items: [item('b', 'queued'), item('a', 'running', 7)] });
    expect(list.map((i) => [i.id, i.bytesDone])).toEqual([['a', 7], ['b', 0]]);
    expect(overallProgress(list)).toEqual({ done: 7, total: 20, files: 2, finished: 0 });
    list = applyPortMessage(list, { t: 'items', items: [item('a', 'done', 10)] });
    expect(failUnfinished(list, 1).map((i) => [i.id, i.state, i.error])).toEqual([['a', 'done', undefined], ['b', 'failed', 'sftpHostCrashed']]);
    expect(applyPortMessage(list, { t: 'removed', ids: ['a'] }).map((i) => i.id)).toEqual(['b']);
  });

  it('has a translated text for every error code', () => {
    const codes: SftpErrorCode[] = ['notFound', 'exists', 'permission', 'notEmpty', 'notADirectory', 'isADirectory', 'noSpace', 'invalid', 'noSession', 'notConnected', 'changed', 'cancelled', 'connectionLost', 'sftpHostCrashed', 'unsupported', 'tooMany', 'invalidName', 'linkOutside', 'linkFolder', 'failed'];
    for (const c of codes) expect(Object.hasOwn(messages, sftpErrorText(c).key), c).toBe(true);
  });
});
