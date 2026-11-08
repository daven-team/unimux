// SFTP file management of 0.9.9 without a server: permission bits (octal <-> grid), move plans, the in-app move drag, the sudo
// command rules, the host fields, the sudo prompt in the coordinator and the ssh2 internal the exec adapter depends on.
import { describe, expect, it } from 'vitest';
import {
  applyMode, commonMode, modeFromPermissions, octalMode, parseOctalMode, permissionString, planRemoteMove, PERM_MASK, symbolicMode,
} from '../src/shared/sftp';
import { localContains, planLocalMove, reenqueueRequest, resolveDrop, resolveMove, symbolicPreview, toggleModeBit, type ActiveDrag } from '../src/shared/sftpView';

describe('permission bits', () => {
  it('reads 3 or 4 octal digits and writes them back', () => {
    expect(parseOctalMode('644')).toBe(0o644);
    expect(parseOctalMode(' 0755 ')).toBe(0o755);
    expect(parseOctalMode('4755')).toBe(0o4755);
    expect(parseOctalMode('1777')).toBe(0o1777);
    for (const bad of ['', '64', '64a', '888', '07555', '-644', '6 4 4']) expect(parseOctalMode(bad), bad).toBeNull();
    expect(octalMode(0o644)).toBe('644');
    expect(octalMode(0o7)).toBe('007');
    expect(octalMode(0o4755)).toBe('4755');
    expect(octalMode(0o100644)).toBe('644');
  });

  it('turns the listing column back into bits (special bits too) and shows them like ls', () => {
    expect(modeFromPermissions('drwxr-xr-x')).toBe(0o755);
    expect(modeFromPermissions('-rw-r--r--')).toBe(0o644);
    expect(modeFromPermissions('-rwsr-xr-x')).toBe(0o4755);
    expect(modeFromPermissions('-rwSr--r--')).toBe(0o4644);
    expect(modeFromPermissions('drwxrwsr-x')).toBe(0o2775);
    expect(modeFromPermissions('drwxrwxrwt')).toBe(0o1777);
    expect(modeFromPermissions('')).toBeNull();
    expect(modeFromPermissions('rwxr-xr-x')).toBeNull();
    for (const m of [0o644, 0o755, 0o4755, 0o2775, 0o1777, 0o7777, 0, 0o600]) expect(modeFromPermissions(permissionString(0o100000 | m))).toBe(m);
    expect(symbolicMode(0o755)).toBe('rwxr-xr-x');
    expect(symbolicMode(0o4754)).toBe('rwsr-xr--');
    expect(symbolicMode(0o1776)).toBe('rwxrwxrwT');
  });

  it('a mixed selection keeps the common bits and marks the others indeterminate; a change touches only defined bits', () => {
    const c = commonMode([0o644, 0o664, 0o640]);
    expect(c.bits).toBe(0o640);
    expect(c.mixed).toBe(0o024);
    const mask = PERM_MASK & ~c.mixed;
    // Owner execute switched on in the grid: the mixed group-write and others-read stay per entry.
    const state = toggleModeBit({ bits: c.bits, mask }, 0o100);
    expect(state).toEqual({ bits: 0o740, mask });
    expect(applyMode(0o644, state.bits, state.mask)).toBe(0o744);
    expect(applyMode(0o664, state.bits, state.mask)).toBe(0o764);
    expect(applyMode(0o100640, state.bits, state.mask)).toBe(0o740);
    // An indeterminate checkbox clicked turns on and becomes defined.
    expect(toggleModeBit({ bits: 0o640, mask }, 0o020)).toEqual({ bits: 0o660, mask: mask | 0o020 });
    expect(toggleModeBit({ bits: 0o660, mask: PERM_MASK }, 0o020)).toEqual({ bits: 0o640, mask: PERM_MASK });
    expect(symbolicPreview(0o640, mask)).toBe('rw-r?-?--');
    expect(symbolicPreview(0o755, PERM_MASK)).toBe('rwxr-xr-x');
    expect(commonMode([])).toEqual({ bits: 0, mixed: 0 });
  });
});

describe('moves', () => {
  it('refuses a folder into itself or its child and leaves out entries already in the target', () => {
    expect(planRemoteMove(['/a/site'], '/a/site')).toEqual({ sources: [], problem: 'intoItself' });
    expect(planRemoteMove(['/a/site'], '/a/site/img')).toEqual({ sources: [], problem: 'intoItself' });
    expect(planRemoteMove(['/a/site', '/a/x.txt'], '/a/sites')).toEqual({ sources: ['/a/site', '/a/x.txt'], problem: null });
    expect(planRemoteMove(['/a/x.txt', '/b/y.txt'], '/a')).toEqual({ sources: ['/b/y.txt'], problem: null });
    expect(planLocalMove(['C:\\w\\site'], 'c:\\W\\Site\\img', 'win32').problem).toBe('intoItself');
    expect(planLocalMove(['C:\\w\\a.txt', 'C:\\x\\b.txt'], 'c:\\W', 'win32')).toEqual({ sources: ['C:\\x\\b.txt'], problem: null });
    expect(planLocalMove(['/home/u/a'], '/home/u/ab', 'posix')).toEqual({ sources: ['/home/u/a'], problem: null });
    expect(localContains('C:\\', 'C:\\x', 'win32')).toBe(true);
    expect(localContains('/home/u', '/home/user', 'posix')).toBe(false);
  });

  it('an in-pane drop moves only with the nonce of a drag that started in that pane', () => {
    const active: ActiveDrag = { side: 'remote', paths: ['/a/x.txt'], nonce: 'n1' };
    expect(resolveMove(active, 'n1', 'remote')).toEqual(['/a/x.txt']);
    expect(resolveMove(active, 'forged', 'remote')).toBeNull();
    expect(resolveMove(null, 'n1', 'remote')).toBeNull();
    expect(resolveMove(active, 'n1', 'local')).toBeNull();
    // A cross-pane drop stays a transfer, a same-pane one never is.
    expect(resolveDrop(active, 'n1', 'remote')).toBeNull();
    expect(resolveDrop(active, 'n1', 'local')).toEqual({ side: 'remote', paths: ['/a/x.txt'] });
  });

  it('a move item lost with the SFTP Host is enqueued again into its folder', () => {
    expect(reenqueueRequest({ direction: 'move', source: '/a/x.txt', target: '/b/x.txt' }, 'win32')).toEqual({ direction: 'move', sources: ['/a/x.txt'], targetDir: '/b' });
    expect(reenqueueRequest({ direction: 'local-move', source: 'C:\\a\\x.txt', target: 'C:\\b\\x.txt' }, 'win32')).toEqual({ direction: 'local-move', sources: ['C:\\a\\x.txt'], targetDir: 'C:\\b' });
  });
});

