// SFTP file management of 0.9.9 without a server: permission bits (octal <-> grid), move plans, the in-app move drag, the sudo
// command rules, the host fields, the sudo prompt in the coordinator and the ssh2 internal the exec adapter depends on.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshCoordinator, type SshHostCommand } from '../src/main/ssh/coordinator';
import { KnownHostsStore } from '../src/main/ssh/knownHosts';
import { SshVault } from '../src/main/ssh/vault';
import { createSftpHandlers } from '../src/main/sftp/ipc';
import type { SftpService } from '../src/main/sftp/service';
import { SSH2_SFTP_ADAPTER_VERSION, sftpClass, sftpOverStream } from '../src/sftphost/execSftp';
import { classifySudo, markerCount, passwordCommand, SUDO_MARKER, sudoCommands, sudoError, validSudoPassword } from '../src/sftphost/sudo';
import {
  applyMode, commonMode, modeFromPermissions, octalMode, parseOctalMode, permissionString, planRemoteMove, PERM_MASK, sftpSessionId, symbolicMode,
} from '../src/shared/sftp';
import type { SftpOp } from '../src/shared/sftpHostIpc';
import { localContains, planLocalMove, reenqueueRequest, resolveDrop, resolveMove, symbolicPreview, toggleModeBit, type ActiveDrag } from '../src/shared/sftpView';
import { hostFormDirty, hostToDraft, normalizeSshHost, validateHostDraft, type SshPrompt } from '../src/shared/ssh';
import { addSshHost, defaultState } from '../src/shared/state';
import type { AppState } from '../src/shared/types';
import { fakeCipher } from './helpers/sshKeys';

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

describe('IPC validation of moves and permission changes', () => {
  const calls: Array<{ id: string | null; op: SftpOp }> = [];
  const service = { op: async (id: string | null, op: SftpOp) => { calls.push({ id, op }); return { ok: true, value: null }; } } as unknown as SftpService;
  const h = createSftpHandlers(service);
  const SID = sftpSessionId('11111111-2222-4333-8444-555555555555');
  beforeEach(() => { calls.length = 0; });

  it('moves stay on one side and in their queue', async () => {
    expect((await h.enqueue(SID, { direction: 'move', sources: ['/a/x'], targetDir: '/b' })).ok).toBe(true);
    expect((await h.enqueue(null, { direction: 'local-move', sources: ['C:\\a\\x'], targetDir: 'C:\\b' })).ok).toBe(true);
    expect(await h.enqueue(null, { direction: 'move', sources: ['/a/x'], targetDir: '/b' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.enqueue(SID, { direction: 'local-move', sources: ['C:\\a\\x'], targetDir: 'C:\\b' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.enqueue(SID, { direction: 'move', sources: ['C:\\a\\x'], targetDir: '/b' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.enqueue(null, { direction: 'local-move', sources: ['C:\\a\\x'], targetDir: 'b' })).toEqual({ ok: false, error: 'invalid' });
    expect(calls).toHaveLength(2);
  });

  it('permission changes need remote paths and bits in 0..7777', async () => {
    expect((await h.chmod(SID, { paths: ['/a'], set: { bits: 0o644, mask: 0o777 }, recursive: null })).ok).toBe(true);
    expect((await h.chmod(SID, { paths: ['/a'], set: null, recursive: { dirMode: 0o755, fileMode: 0o644 }, opId: '11111111-2222-4333-8444-555555555555' })).ok).toBe(true);
    expect(await h.chmod(SID, { paths: ['/a'], set: null, recursive: null })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.chmod(SID, { paths: ['/a'], set: { bits: 0o10000, mask: 0o777 }, recursive: null })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.chmod(SID, { paths: ['a'], set: { bits: 0o644, mask: 0o777 }, recursive: null })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.chmod(SID, { paths: ['/a'], set: { bits: 0o644, mask: 0o777 }, recursive: null, extra: 1 })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.chmodCount(SID, ['/a'], 'yes')).toEqual({ ok: false, error: 'invalid' });
    expect((await h.chmodCount(SID, ['/a'], true)).ok).toBe(true);
    expect(await h.cancelOp(SID, 'not-a-uuid')).toEqual({ ok: false });
    expect(calls.map((c) => c.op.op)).toEqual(['chmod', 'chmod', 'chmodCount']);
  });
});

describe('SFTP through sudo: rules', () => {
  it('tries the usual sftp-server places, or only the own command; a password turns -n into -S', () => {
    expect(sudoCommands()).toEqual(['sudo -n /usr/lib/openssh/sftp-server', 'sudo -n /usr/libexec/openssh/sftp-server', 'sudo -n /usr/lib/ssh/sftp-server']);
    expect(sudoCommands('  doas /usr/lib/sftp-server ')).toEqual(['doas /usr/lib/sftp-server']);
    expect(passwordCommand('sudo -n /usr/lib/openssh/sftp-server')).toBe(`sudo -S -p '${SUDO_MARKER}' /usr/lib/openssh/sftp-server`);
    expect(passwordCommand('sudo -n -u www /usr/lib/sftp-server -l INFO')).toBe(`sudo -S -p '${SUDO_MARKER}' -u www /usr/lib/sftp-server -l INFO`);
    expect(markerCount(`${SUDO_MARKER}Sorry, try again.\n${SUDO_MARKER}`)).toBe(2);
    expect(passwordCommand('doas /usr/lib/sftp-server')).toBeNull();
    expect(validSudoPassword('pw')).toBe(true);
    expect(validSudoPassword('a\nb')).toBe(false);
    expect(validSudoPassword('')).toBe(false);
  });

  it('reads what sudo says', () => {
    expect(classifySudo('sudo: a password is required\n', 1)).toBe('password');
    expect(classifySudo('Sorry, try again.\n')).toBe('wrongPassword');
    expect(classifySudo('sudo: 3 incorrect password attempts\n', 1)).toBe('wrongPassword');
    expect(classifySudo('sudo: sorry, you must have a tty to run sudo\n', 1)).toBe('tty');
    expect(classifySudo("Sorry, user alice is not allowed to execute '/x' as root on h.\n", 1)).toBe('denied');
    expect(classifySudo('alice is not in the sudoers file.  This incident will be reported.\n', 1)).toBe('denied');
    expect(classifySudo('sudo: /usr/lib/openssh/sftp-server: command not found\n', 1)).toBe('notFound');
    expect(classifySudo('', 127)).toBe('notFound');
    expect(classifySudo('')).toBeNull();
    expect(classifySudo('something else', 2)).toBe('other');
    expect(sudoError('wrongPassword')).toBe('sudoPassword');
    expect(sudoError('tty')).toBe('sudoTty');
    expect(sudoError('denied')).toBe('sudoDenied');
    expect(sudoError('notFound')).toBe('sudoNoServer');
    expect(sudoError('timeout')).toBe('sudoFailed');
    expect(sudoError('noSudo')).toBe('sudoMissing');
  });

  it('reads Polish sudo, a missing sudo, and an unknown language by the exit status of sudo -n', () => {
    expect(classifySudo('sudo: wymagane jest hasło\n', 1)).toBe('password');
    expect(classifySudo('Niestety, spróbuj ponownie.\n')).toBe('wrongPassword');
    expect(classifySudo('sudo: /usr/lib/openssh/sftp-server: nie znaleziono polecenia\n', 1)).toBe('notFound');
    expect(classifySudo("Niestety, użytkownik alice nie ma uprawnień do uruchamiania '/x' jako root na h.\n", 1)).toBe('denied');
    expect(classifySudo('sudo: niestety, aby uruchomić sudo, musisz mieć terminal\n', 1)).toBe('tty');
    expect(classifySudo('sh: 1: sudo: not found\n', 127)).toBe('noSudo');
    expect(classifySudo('bash: sudo: command not found\n', 127)).toBe('noSudo');
    expect(classifySudo('sudo: /x: command not found\n', 1)).toBe('notFound');
    expect(classifySudo('sudo: ффф\n', 1, true)).toBe('password');
    expect(classifySudo('sudo: ффф\n', 1)).toBe('other');
    expect(classifySudo(`${SUDO_MARKER}`)).toBeNull();
  });

  it('the host keeps the sudo option and a one-line command; the editor validates it', () => {
    const base = { id: '00000000-0000-4000-8000-000000000001', address: 'h', username: 'u' };
    expect(normalizeSshHost({ ...base, sftpSudo: true, sftpCommand: ' sudo -n /opt/sftp-server ' })).toMatchObject({ sftpSudo: true, sftpCommand: 'sudo -n /opt/sftp-server' });
    const plain = normalizeSshHost({ ...base, sftpSudo: 'yes', sftpCommand: 'a\u001bb' })!;
    expect(plain.sftpSudo).toBeUndefined();
    expect(plain.sftpCommand).toBeUndefined();
    const draft = { ...hostToDraft(), address: 'h', username: 'u', sftpSudo: true, sftpCommand: 'x\ny' };
    expect(validateHostDraft(draft)).toMatchObject({ ok: false, errors: { sftpCommand: 'Polecenie zawiera znaki sterujące' } });
    const ok = validateHostDraft({ ...draft, sftpCommand: '' });
    expect(ok).toMatchObject({ ok: true, value: { sftpSudo: true } });
    expect(ok.ok && 'sftpCommand' in ok.value).toBe(false);
    const host = { ...base, label: 'h', port: 22, createdAt: 0, updatedAt: 0 };
    expect(hostFormDirty(host, hostToDraft(host), { tag: '', password: '' })).toBe(false);
    expect(hostFormDirty(host, { ...hostToDraft(host), sftpSudo: true }, { tag: '', password: '' })).toBe(true);
  });
});

describe('SFTP through sudo: the coordinator', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-sudo-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const HOST = '00000000-0000-4000-8000-000000000001';
  const SID = sftpSessionId('11111111-2222-4333-8444-555555555555');
  const tick = () => new Promise((r) => setTimeout(r, 10));

  function setup(command?: string) {
    const vault = new SshVault(join(dir, 'vault.json'), fakeCipher());
    let state: AppState = addSshHost(defaultState(), { id: HOST, label: 'web', address: 'web.example', port: 22, username: 'deploy', sftpSudo: true, ...(command ? { sftpCommand: command } : {}), createdAt: 0, updatedAt: 0 });
    const sent: SshHostCommand[] = [];
    const prompts: Array<{ id: string; prompt: SshPrompt | null }> = [];
    const coordinator = new SshCoordinator({
      state: () => state, vault, knownHosts: new KnownHostsStore(join(dir, 'kh.json')), host: (m) => { sent.push(m); return true; },
      events: { session: () => undefined, prompt: (id, prompt) => prompts.push({ id, prompt }), vaultChanged: () => undefined },
    });
    return { vault, sent, prompts, coordinator, setState: (s: AppState) => { state = s; } };
  }

  it('sends the sudo option with the login and asks the sudo password without a save option', async () => {
    const f = setup('sudo -n /opt/sftp-server');
    expect(await f.coordinator.connectSession({ sessionId: SID, hostId: HOST })).toEqual({ ok: true });
    expect(f.sent[0]).toMatchObject({ t: 'sshConnect', req: { id: SID, sftpSudo: { command: 'sudo -n /opt/sftp-server' } } });
    f.coordinator.onHostMessage({ t: 'sshAuthPrompt', id: SID, promptId: 'p1', kind: 'sudo', fields: [], retry: false });
    await tick();
    const prompt = f.prompts.at(-1)!.prompt!;
    expect(prompt).toMatchObject({ kind: 'sudo', user: 'deploy', endpoint: 'web.example', canUseSaved: false, retry: false });
    // Without a saved password "use the saved one" is refused.
    expect(f.coordinator.answer({ cellId: SID, promptId: prompt.id, values: [''], useSaved: true })).toEqual({ ok: false });
    expect(f.coordinator.answer({ cellId: SID, promptId: prompt.id, values: ['s3cret'], remember: true })).toEqual({ ok: true });
    await tick();
    expect(f.sent.at(-1)).toEqual({ t: 'sshAuthAnswer', id: SID, promptId: 'p1', values: ['s3cret'] });
    // Never saved, whatever "remember" said.
    expect(f.vault.password(HOST).ok).toBe(false);
    expect(existsSync(join(dir, 'vault.json')) ? readFileSync(join(dir, 'vault.json'), 'utf8') : '').not.toContain('s3cret');
  });

  it('a plain session (editor tabs) of a sudo host never runs through sudo', async () => {
    const f = setup('sudo -n /opt/sftp-server');
    expect(await f.coordinator.connectSession({ sessionId: SID, hostId: HOST, plain: true })).toEqual({ ok: true });
    expect(f.sent[0]).toMatchObject({ t: 'sshConnect', req: { id: SID } });
    expect((f.sent[0] as { req: { sftpSudo?: unknown } }).req.sftpSudo).toBeUndefined();
  });

  it('uses the saved login password for sudo only on the explicit choice', async () => {
    const f = setup();
    expect(f.vault.setPassword(HOST, 'login-pw').ok).toBe(true);
    await f.coordinator.connectSession({ sessionId: SID, hostId: HOST });
    expect(f.sent[0]).toMatchObject({ req: { sftpSudo: {} } });
    f.coordinator.onHostMessage({ t: 'sshAuthPrompt', id: SID, promptId: 'p2', kind: 'sudo', fields: [], retry: true });
    await tick();
    const prompt = f.prompts.at(-1)!.prompt!;
    expect(prompt).toMatchObject({ kind: 'sudo', canUseSaved: true, retry: true });
    expect(f.coordinator.answer({ cellId: SID, promptId: prompt.id, values: [''], useSaved: true })).toEqual({ ok: true });
    await tick();
    expect(f.sent.at(-1)).toEqual({ t: 'sshAuthAnswer', id: SID, promptId: 'p2', values: ['login-pw'] });
  });
});

describe('the ssh2 internal behind SFTP over an exec channel', () => {
  it('is the pinned ssh2 version with its SFTP protocol class (update execSftp.ts and this test with ssh2)', () => {
    const pkg = JSON.parse(readFileSync('node_modules/ssh2/package.json', 'utf8')) as { version: string };
    expect(pkg.version).toBe(SSH2_SFTP_ADAPTER_VERSION);
    const SFTP = sftpClass();
    expect(typeof SFTP).toBe('function');
    for (const method of ['push', '_init', 'readdir', 'setstat', 'ext_openssh_rename']) expect(typeof (SFTP.prototype as unknown as Record<string, unknown>)[method], method).toBe('function');
  });

  it('runs a client and a server SFTP over a plain byte pipe', async () => {
    // Two duplex ends wired to each other (what an exec channel is to both sides).
    let toServer: Duplex, toClient: Duplex;
    toClient = new Duplex({ read() {}, write(chunk, _e, cb) { toServer.push(chunk); cb(); }, final(cb) { toServer.push(null); cb(); } });
    toServer = new Duplex({ read() {}, write(chunk, _e, cb) { toClient.push(chunk); cb(); }, final(cb) { toClient.push(null); cb(); } });
    const server = sftpOverStream(toServer, { server: true }).sftp;
    server.on('REALPATH', (reqId: number) => server.name(reqId, [{ filename: '/root', longname: '/root', attrs: {} as never }]));
    const client = sftpOverStream(toClient);
    const ready = new Promise<void>((resolve) => client.sftp.once('ready', () => resolve()));
    client.start();
    await ready;
    const path = await new Promise<string>((resolve, reject) => client.sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p))));
    expect(path).toBe('/root');
    const closed = new Promise<void>((resolve) => client.sftp.once('close', () => resolve()));
    toClient.destroy();
    await closed;
  });
});
