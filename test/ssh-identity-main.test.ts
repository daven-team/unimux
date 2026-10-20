// SSH identities in main: identity passwords in the vault (format, versions, pruning) and the coordinator signing a host in
// with the identity it uses.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshCoordinator, type SshHostCommand } from '../src/main/ssh/coordinator';
import { KnownHostsStore } from '../src/main/ssh/knownHosts';
import { parsePrivateKey } from '../src/main/ssh/keys';
import { SshVault } from '../src/main/ssh/vault';
import { layoutForCount } from '../src/shared/layout';
import type { SshPrompt } from '../src/shared/ssh';
import { removeSshIdentity, upsertSshIdentity } from '../src/shared/sshIdentity';
import { addProject, addSshHost, addTab, defaultState } from '../src/shared/state';
import type { AppState } from '../src/shared/types';
import { fakeCipher, readableKeyPair } from './helpers/sshKeys';

const HOST = '00000000-0000-4000-8000-000000000001';
const IDENTITY = '00000000-0000-4000-8000-0000000000a1';
const OTHER_IDENTITY = '00000000-0000-4000-8000-0000000000a2';

let dir: string;
const file = () => join(dir, 'ssh', 'vault.json');
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-identity-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('identity passwords in the vault', () => {
  it('stores them encrypted next to host passwords and reads them back', () => {
    const vault = new SshVault(file(), fakeCipher(), () => 3);
    vault.setPassword(HOST, 'host-secret-pw');
    expect(vault.setIdentityPassword(IDENTITY, 'identity-secret-pw')).toEqual({ ok: true, ephemeral: false });
    const raw = readFileSync(file(), 'utf8');
    for (const secret of ['identity-secret-pw', Buffer.from('identity-secret-pw').toString('base64')]) expect(raw).not.toContain(secret);
    const json = JSON.parse(raw);
    expect(json.version).toBe(2);
    expect(json.identityPasswords).toEqual([{ identityId: IDENTITY, updatedAt: 3, secret: expect.any(String) }]);
    expect(json.passwords).toEqual([{ hostId: HOST, updatedAt: 3, secret: expect.any(String) }]);
    const again = new SshVault(file(), fakeCipher());
    expect(again.identityPassword(IDENTITY)).toEqual({ ok: true, password: 'identity-secret-pw' });
    expect(again.password(HOST)).toEqual({ ok: true, password: 'host-secret-pw' });
    // Host and identity passwords are separate lists: one id never reads the other's secret.
    expect(again.password(IDENTITY)).toEqual({ ok: false, error: 'none' });
    expect(again.identityPassword(HOST)).toEqual({ ok: false, error: 'none' });
    expect(again.info()).toMatchObject({ savedPasswords: [HOST], savedIdentityPasswords: [IDENTITY], lockedIdentityPasswords: [], readOnly: false });
  });

  it('writes version 1 while no identity password is stored, so older versions keep writing the file', () => {
    const vault = new SshVault(file(), fakeCipher());
    vault.setPassword(HOST, 'pw');
    expect(JSON.parse(readFileSync(file(), 'utf8'))).not.toHaveProperty('identityPasswords');
    expect(JSON.parse(readFileSync(file(), 'utf8')).version).toBe(1);
    vault.setIdentityPassword(IDENTITY, 'pw');
    expect(JSON.parse(readFileSync(file(), 'utf8')).version).toBe(2);
    expect(vault.clearIdentityPassword(IDENTITY)).toBe(true);
    expect(vault.clearIdentityPassword(IDENTITY)).toBe(false);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ version: 1, passwords: [{ hostId: HOST }] });
  });

  it('opens a vault file of the version before identities as it is', () => {
    mkdirSync(join(dir, 'ssh'), { recursive: true });
    const seeded = new SshVault(join(dir, 'seed.json'), fakeCipher());
    seeded.setPassword(HOST, 'old-pw');
    const old = JSON.parse(readFileSync(join(dir, 'seed.json'), 'utf8'));
    writeFileSync(file(), JSON.stringify({ version: 1, keys: [], passwords: old.passwords }));
    const vault = new SshVault(file(), fakeCipher());
    expect(vault.readOnly()).toBe(false);
    expect(vault.password(HOST)).toEqual({ ok: true, password: 'old-pw' });
    expect(vault.info()).toMatchObject({ savedIdentityPasswords: [], lockedIdentityPasswords: [] });
  });

  it('opens read-only (and never writes) a file with a broken identity list or of a newer version', () => {
    mkdirSync(join(dir, 'ssh'), { recursive: true });
    for (const content of [
      { version: 2, keys: [], passwords: [], identityPasswords: 'nope' },
      { version: 2, keys: [], passwords: [], identityPasswords: [{ hostId: IDENTITY, secret: 'x' }] },
      { version: 3, keys: [], passwords: [] },
    ]) {
      const text = JSON.stringify(content);
      writeFileSync(file(), text);
      const vault = new SshVault(file(), fakeCipher());
      expect(vault.readOnly(), text).toBe(true);
      expect(vault.setIdentityPassword(IDENTITY, 'pw')).toEqual({ ok: false, error: 'readOnly' });
      expect(vault.pruneIdentityPasswords(new Set())).toBe(false);
      expect(readFileSync(file(), 'utf8')).toBe(text);
    }
  });

  it('prunes passwords of identities that no longer exist without touching host passwords', () => {
    const vault = new SshVault(file(), fakeCipher());
    vault.setPassword(HOST, 'host-pw');
    vault.setIdentityPassword(IDENTITY, 'a');
    vault.setIdentityPassword(OTHER_IDENTITY, 'b');
    expect(vault.pruneIdentityPasswords(new Set([OTHER_IDENTITY]))).toBe(true);
    expect(vault.pruneIdentityPasswords(new Set([OTHER_IDENTITY]))).toBe(false);
    const again = new SshVault(file(), fakeCipher());
    expect(again.info()).toMatchObject({ savedPasswords: [HOST], savedIdentityPasswords: [OTHER_IDENTITY] });
  });

  it('marks an identity password locked when it cannot be decrypted, and keeps it in memory only without encryption', () => {
    const vault = new SshVault(file(), fakeCipher());
    vault.setIdentityPassword(IDENTITY, 'pw');
    const foreign = new SshVault(file(), fakeCipher({ broken: true }));
    expect(foreign.identityPassword(IDENTITY)).toEqual({ ok: false, error: 'locked' });
    expect(foreign.info().lockedIdentityPasswords).toEqual([IDENTITY]);
    rmSync(file());
    const memory = new SshVault(file(), fakeCipher({ available: false }));
    expect(memory.setIdentityPassword(IDENTITY, 'pw')).toEqual({ ok: true, ephemeral: true });
    expect(memory.identityPassword(IDENTITY)).toEqual({ ok: true, password: 'pw' });
    expect(existsSync(file())).toBe(false);
  });
});

describe('connecting a host that uses an identity', () => {
  function setup(opts: { identityKey?: boolean } = {}) {
    const vault = new SshVault(join(dir, 'vault.json'), fakeCipher());
    const knownHosts = new KnownHostsStore(join(dir, 'known_hosts.json'));
    let keyId: string | undefined;
    let privateKey: string | undefined;
    if (opts.identityKey) {
      const pair = readableKeyPair('ed25519');
      const parsed = parsePrivateKey(pair.private);
      if (!parsed.ok) throw new Error('fixture');
      const added = vault.addKey({ label: 'id key', ...parsed.meta, encrypted: false, privateKey: pair.private, savePassphrase: false, source: 'generated' });
      keyId = added.ok ? added.key.id : undefined;
      privateKey = pair.private;
    }
    let state: AppState = addProject(defaultState(), { name: 'p', path: dir });
    state = upsertSshIdentity(state, { id: IDENTITY, label: 'Hetzner', username: 'adam', ...(keyId ? { keyId } : {}), createdAt: 0, updatedAt: 0 });
    state = addSshHost(state, { id: HOST, label: 'web', address: 'web.example', port: 2222, username: 'adam', identityId: IDENTITY, createdAt: 0, updatedAt: 0 });
    state = addTab(state, state.projects[0].id, { layout: layoutForCount(1), cells: [{ profileId: 'shell', ssh: { hostId: HOST } }] });
    const cellId = state.projects[0].tabs[0].cells[0].id;
    const sent: SshHostCommand[] = [];
    const prompts: Array<{ cellId: string; prompt: SshPrompt | null }> = [];
    const coordinator = new SshCoordinator({
      state: () => state, vault, knownHosts, host: (m) => { sent.push(m); return true; },
      events: { session: () => undefined, prompt: (id, prompt) => prompts.push({ cellId: id, prompt }), vaultChanged: () => undefined },
    });
    const open = () => [...prompts].reverse().find((p) => p.cellId === cellId)?.prompt ?? null;
    const connects = () => sent.filter((m): m is Extract<SshHostCommand, { t: 'sshConnect' }> => m.t === 'sshConnect');
    return { vault, coordinator, cellId, keyId, privateKey, open, connects, sent, prompts, getState: () => state, setState: (s: AppState) => { state = s; } };
  }

  it('signs in with the user name, key and saved password of the identity, not those of the host', async () => {
    const f = setup({ identityKey: true });
    f.vault.setPassword(HOST, 'own-host-password');
    f.vault.setIdentityPassword(IDENTITY, 'identity-password');
    f.setState(upsertSshIdentity(f.getState(), { ...f.getState().sshIdentities[0], username: 'deploy' }));
    expect(await f.coordinator.connect({ cellId: f.cellId, hostId: HOST, cols: 80, rows: 24 })).toEqual({ ok: true });
    expect(f.connects()[0].req).toMatchObject({ host: 'web.example', port: 2222, username: 'deploy', privateKey: f.privateKey, password: 'identity-password' });
  });

  it('saves a remembered password to the identity, and offers it to sudo', async () => {
    const f = setup();
    await f.coordinator.connect({ cellId: f.cellId, hostId: HOST, cols: 80, rows: 24 });
    expect(f.connects()[0].req.password).toBeUndefined();
    f.coordinator.onHostMessage({ t: 'sshAuthPrompt', id: f.cellId, promptId: 'auth1', kind: 'password', fields: [], retry: false });
    await tick();
    const prompt = f.open();
    expect(prompt).toMatchObject({ kind: 'password', user: 'adam', endpoint: 'web.example:2222' });
    f.coordinator.answer({ cellId: f.cellId, promptId: prompt!.id, values: ['typed-identity-pw'], remember: true });
    await tick();
    f.coordinator.onHostMessage({ t: 'sshStatus', id: f.cellId, phase: 'connected' });
    expect(f.vault.identityPassword(IDENTITY)).toEqual({ ok: true, password: 'typed-identity-pw' });
    expect(f.vault.password(HOST)).toEqual({ ok: false, error: 'none' });
    // SFTP through sudo: "Użyj zapisanego hasła" is the identity's password.
    const session = 'sftp:00000000-0000-4000-8000-0000000000f1';
    expect(await f.coordinator.connectSession({ sessionId: session, hostId: HOST, sudo: true })).toEqual({ ok: true });
    f.coordinator.onHostMessage({ t: 'sshAuthPrompt', id: session, promptId: 'sudo1', kind: 'sudo', fields: [], retry: false });
    await tick();
    const sudo = [...f.prompts].reverse().find((p) => p.cellId === session)?.prompt;
    expect(sudo).toMatchObject({ kind: 'sudo', user: 'adam', canUseSaved: true });
    f.coordinator.answer({ cellId: session, promptId: sudo!.id, values: [''], useSaved: true });
    await tick();
    expect(f.sent.at(-1)).toEqual({ t: 'sshAuthAnswer', id: session, promptId: 'sudo1', values: ['typed-identity-pw'] });
  });

  it('signs in with the host fields again once its identity is gone, and prunes the identity password', async () => {
    const f = setup({ identityKey: true });
    f.vault.setPassword(HOST, 'own-host-password');
    f.vault.setIdentityPassword(IDENTITY, 'identity-password');
    // A concurrent edit can leave the reference behind; removeSshIdentity itself detaches the host and hands it the key.
    f.setState({ ...f.getState(), sshIdentities: [] });
    f.coordinator.stateChanged(f.getState());
    expect(f.vault.info().savedIdentityPasswords).toEqual([]);
    await f.coordinator.connect({ cellId: f.cellId, hostId: HOST, cols: 80, rows: 24 });
    expect(f.connects()[0].req).toMatchObject({ username: 'adam', password: 'own-host-password' });
    expect(f.connects()[0].req.privateKey).toBeUndefined();
    const detached = removeSshIdentity(upsertSshIdentity(f.getState(), { id: IDENTITY, label: 'x', username: 'adam', keyId: f.keyId, createdAt: 0, updatedAt: 0 }), IDENTITY);
    expect(detached.sshHosts[0]).toMatchObject({ username: 'adam', keyId: f.keyId });
    expect(detached.sshHosts[0].identityId).toBeUndefined();
  });

  it('reports a missing identity key like a missing host key', async () => {
    const f = setup({ identityKey: true });
    expect(f.vault.removeKey(f.keyId!)).toBe(true);
    expect(await f.coordinator.connect({ cellId: f.cellId, hostId: HOST, cols: 80, rows: 24 })).toEqual({ ok: false, error: 'keyMissing' });
  });
});
