import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSshHandlers, readKeyFileFromDisk, registerSshIpc, SSH_CHANNELS, type SshIpcDeps } from '../src/main/ssh/ipc';
import { KeyDrafts } from '../src/main/ssh/keys';
import { KnownHostsStore } from '../src/main/ssh/knownHosts';
import { SshVault } from '../src/main/ssh/vault';
import { layoutForCount } from '../src/shared/layout';
import { addProject, addSshHost, addTab, defaultState } from '../src/shared/state';
import { upsertSshIdentity } from '../src/shared/sshIdentity';
import type { AppState } from '../src/shared/types';
import { fakeCertificate, fakeCipher, ppkV2Rsa, readableKeyPair } from './helpers/sshKeys';

const HOST = '00000000-0000-4000-8000-000000000001';
const IDENTITY = '00000000-0000-4000-8000-0000000000a1';
const pair = readableKeyPair('ed25519', { passphrase: 'ipc-pass-phrase', cipher: 'aes256-ctr', rounds: 16 });
const SECRETS = [pair.private.split('\n')[1], 'ipc-pass-phrase', 'ipc-host-password', 'ipc-identity-password'];
const leaks = (value: unknown) => SECRETS.filter((s) => JSON.stringify(value ?? null).includes(s));

let dir: string;
let state: AppState;
let deps: SshIpcDeps;
let written: Array<{ path: string; text: string }>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unimux-ipc-'));
  state = addSshHost(addProject(defaultState(), { name: 'p', path: dir }), { id: HOST, label: 'web', address: 'web.example', port: 22, username: 'u', createdAt: 0, updatedAt: 0 });
  state = addTab(state, state.projects[0].id, { layout: layoutForCount(1), cells: [{ profileId: 'shell', ssh: { hostId: HOST } }] });
  written = [];
  deps = {
    coordinator: { connect: vi.fn(async () => ({ ok: true as const })), sessions: vi.fn(() => ({ sessions: [], prompts: [] })), answer: vi.fn(() => ({ ok: true })) },
    vault: new SshVault(join(dir, 'ssh', 'vault.json'), fakeCipher()),
    knownHosts: new KnownHostsStore(join(dir, 'ssh', 'known_hosts.json')),
    drafts: new KeyDrafts(),
    state: () => state,
    change: (fn) => { state = fn(state); },
    vaultChanged: vi.fn(),
    pickKeyFile: vi.fn(async () => null),
    saveKeyFile: vi.fn(async () => join(dir, 'exported')),
    readKeyFile: readKeyFileFromDisk,
    writeKeyFile: async (path, text) => { written.push({ path, text }); },
    hostname: () => 'testbox',
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ssh IPC handlers', () => {
  it('rejects malformed payloads before anything runs', async () => {
    const h = createSshHandlers(deps);
    expect(await h.connect({ cellId: 'x', hostId: HOST, cols: 80, rows: 24 })).toEqual({ ok: false, error: 'badRequest' });
    expect(await h.connect({ cellId: state.projects[0].tabs[0].cells[0].id, hostId: HOST, cols: 80, rows: 24, extra: 1 })).toEqual({ ok: false, error: 'badRequest' });
    expect(await h.draftFromText({ privateKey: 'x'.repeat(64 * 1024 + 1) })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.setPassword({ hostId: HOST, password: 'x'.repeat(1025) })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.answer({ cellId: HOST, promptId: HOST, values: Array(11).fill('a') })).toEqual({ ok: false });
    expect(deps.coordinator.connect).not.toHaveBeenCalled();
  });

  it('refuses a cell of another host and unknown hosts', async () => {
    const h = createSshHandlers(deps);
    const cellId = state.projects[0].tabs[0].cells[0].id;
    expect(await h.connect({ cellId, hostId: '00000000-0000-4000-8000-000000000009', cols: 80, rows: 24 })).toEqual({ ok: false, error: 'hostMissing' });
    expect(await h.setPassword({ hostId: '00000000-0000-4000-8000-000000000009', password: 'p' })).toEqual({ ok: false, error: 'notFound' });
    expect(await h.connect({ cellId, hostId: HOST, cols: 80, rows: 24 })).toEqual({ ok: true });
  });

  it('reads key files only from absolute paths to small regular files', async () => {
    const h = createSshHandlers(deps);
    expect(await h.draftFromFile({ path: 'relative/key' })).toEqual({ ok: false, error: 'readFailed' });
    mkdirSync(join(dir, 'folder'));
    expect(await h.draftFromFile({ path: join(dir, 'folder') })).toEqual({ ok: false, error: 'readFailed' });
    writeFileSync(join(dir, 'big'), 'x'.repeat(64 * 1024 + 1));
    expect(await h.draftFromFile({ path: join(dir, 'big') })).toEqual({ ok: false, error: 'tooLarge' });
    writeFileSync(join(dir, 'id_test'), pair.private);
    expect(await h.draftFromFile({ path: join(dir, 'id_test') })).toMatchObject({ ok: true, needsPassphrase: true });
  });

  it('imports, unlocks and commits a key without returning private material', async () => {
    const h = createSshHandlers(deps);
    const draft = await h.draftFromText({ privateKey: pair.private });
    if (!draft.ok) throw new Error('draft');
    const unlocked = await h.unlockDraft({ draftId: draft.draftId, passphrase: 'ipc-pass-phrase' });
    const committed = await h.commitDraft({ draftId: draft.draftId, label: 'imported', savePassphrase: false });
    expect(committed).toMatchObject({ ok: true, key: { label: 'imported', encrypted: true, passphraseSaved: false } });
    const info = await h.vaultInfo();
    for (const result of [draft, unlocked, committed, info]) expect(leaks(result)).toEqual([]);
    expect(deps.vaultChanged).toHaveBeenCalled();
  });

  it('generates keys, exports the private key only to the chosen file, removes keys and clears host references', async () => {
    const h = createSshHandlers(deps);
    const generated = await h.generateKey({ label: 'gen', type: 'ed25519', savePassphrase: false });
    if (!generated.ok) throw new Error('generate');
    expect(generated.key.publicKey).toMatch(/^ssh-ed25519 \S+ unimux@testbox$/);
    expect(JSON.stringify(generated)).not.toContain('PRIVATE KEY');
    expect(await h.exportPrivateKey({ id: generated.key.id })).toEqual({ ok: true });
    expect(written[0].text).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(await h.exportPrivateKey({ id: '00000000-0000-4000-8000-000000000099' })).toEqual({ ok: false, error: 'notFound' });
    state = { ...state, sshHosts: state.sshHosts.map((x) => ({ ...x, keyId: generated.key.id })) };
    expect(await h.removeKey({ id: generated.key.id })).toEqual({ ok: true });
    expect(state.sshHosts[0].keyId).toBeUndefined();
  });

  it('stores passwords without echoing them', async () => {
    const h = createSshHandlers(deps);
    const r = await h.setPassword({ hostId: HOST, password: 'ipc-host-password' });
    expect(r).toEqual({ ok: true, ephemeral: false });
    expect(leaks(await h.vaultInfo())).toEqual([]);
    expect((await h.vaultInfo()).savedPasswords).toEqual([HOST]);
    expect(await h.clearPassword({ hostId: HOST })).toEqual({ ok: true });
  });

  it('stores identity passwords only for identities in the state, without echoing them', async () => {
    const h = createSshHandlers(deps);
    expect(await h.setIdentityPassword({ identityId: IDENTITY, password: 'ipc-identity-password' })).toEqual({ ok: false, error: 'notFound' });
    state = upsertSshIdentity(state, { id: IDENTITY, label: 'me', username: 'me', createdAt: 0, updatedAt: 0 });
    expect(await h.setIdentityPassword({ identityId: IDENTITY, password: 'x'.repeat(1025) })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.setIdentityPassword({ identityId: 'not-a-uuid', password: 'p' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.setIdentityPassword({ identityId: IDENTITY, password: '' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.setIdentityPassword({ identityId: IDENTITY, password: 'p', hostId: HOST })).toEqual({ ok: false, error: 'invalid' });
    const r = await h.setIdentityPassword({ identityId: IDENTITY, password: 'ipc-identity-password' });
    expect(r).toEqual({ ok: true, ephemeral: false });
    const info = await h.vaultInfo();
    expect(leaks(info)).toEqual([]);
    expect(info).toMatchObject({ savedPasswords: [], savedIdentityPasswords: [IDENTITY], lockedIdentityPasswords: [] });
    expect(deps.vault.identityPassword(IDENTITY)).toEqual({ ok: true, password: 'ipc-identity-password' });
    expect(deps.vaultChanged).toHaveBeenCalled();
    expect(await h.clearIdentityPassword({ identityId: 'nope' })).toEqual({ ok: false });
    expect(await h.clearIdentityPassword({ identityId: IDENTITY })).toEqual({ ok: true });
    expect((await h.vaultInfo()).savedIdentityPasswords).toEqual([]);
  });

  it('clears a deleted key from hosts and identities', async () => {
    const h = createSshHandlers(deps);
    const generated = await h.generateKey({ label: 'gen', type: 'ed25519', savePassphrase: false });
    if (!generated.ok) throw new Error('generate');
    state = upsertSshIdentity(state, { id: IDENTITY, label: 'me', username: 'me', keyId: generated.key.id, createdAt: 0, updatedAt: 0 });
    expect(await h.removeKey({ id: generated.key.id })).toEqual({ ok: true });
    expect(state.sshIdentities[0].keyId).toBeUndefined();
  });

  it('answers nothing to a window that is not the app window (R9)', async () => {
    const handle = vi.fn();
    const on = vi.fn();
    const h = createSshHandlers(deps);
    registerSshIpc({ handle, on } as never, h, (event) => event.sender === 'app');
    expect(handle.mock.calls.map((c) => c[0]).sort()).toEqual(Object.keys(SSH_CHANNELS).sort());
    const connect = handle.mock.calls.find((c) => c[0] === 'ssh:connect')![1];
    // L1: a foreign sender gets no answer at all (not a fake result of the wrong shape).
    expect(await connect({ sender: 'evil' }, { cellId: HOST, hostId: HOST, cols: 80, rows: 24 })).toBeUndefined();
    expect(deps.coordinator.connect).not.toHaveBeenCalled();
    const info = handle.mock.calls.find((c) => c[0] === 'ssh:vault:info')![1];
    expect(await info({ sender: 'evil' })).toBeUndefined();
    expect(await info({ sender: 'app' })).toMatchObject({ storage: 'dpapi', keys: [] });
    const discard = on.mock.calls.find((c) => c[0] === 'ssh:key:discardDraft')![1];
    const spy = vi.spyOn(deps.drafts, 'discard');
    discard({ sender: 'evil' }, 'x');
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a raw generateKey failure to a fixed code (carried a)', async () => {
    const h = createSshHandlers(deps);
    expect(await h.generateKey({ label: 'bad', type: 'rsa', bits: 1234, savePassphrase: false })).toEqual({ ok: false, error: 'failed' });
    const spy = vi.spyOn(ssh2.utils, 'generateKeyPair').mockImplementation(((_t: unknown, _o: unknown, cb: (e: Error) => void) => cb(new Error('raw ssh2 text ipc-pass-phrase'))) as never);
    try {
      const r = await h.generateKey({ label: 'x', type: 'ed25519', passphrase: 'ipc-pass-phrase', savePassphrase: true });
      expect(r).toEqual({ ok: false, error: 'failed' });
    } finally { spy.mockRestore(); }
    expect(deps.vault.info().keys).toEqual([]);
  });

  it('saves a passphrase only when it opens the key (carried b)', async () => {
    const h = createSshHandlers(deps);
    const generated = await h.generateKey({ label: 'gen', type: 'ed25519', passphrase: 'ipc-pass-phrase', savePassphrase: false });
    if (!generated.ok) throw new Error('generate');
    const update = vi.spyOn(deps.vault, 'updateKey');
    expect(await h.updateKey({ id: generated.key.id, passphrase: { save: 'not-the-passphrase' } })).toEqual({ ok: false, error: 'badPassphrase' });
    expect(update).not.toHaveBeenCalled();
    expect(deps.vault.key(generated.key.id)!.passphraseSaved).toBe(false);
    const saved = await h.updateKey({ id: generated.key.id, passphrase: { save: 'ipc-pass-phrase' } });
    expect(saved).toMatchObject({ ok: true, key: { passphraseSaved: true } });
    expect(leaks(saved)).toEqual([]);
    expect(await h.updateKey({ id: generated.key.id, passphrase: { forget: true } })).toMatchObject({ ok: true, key: { passphraseSaved: false } });
  });

  it('saves a key passphrase only when it opens the key', async () => {
    const h = createSshHandlers(deps);
    const draft = await h.draftFromText({ privateKey: pair.private });
    if (!draft.ok) throw new Error('draft');
    await h.unlockDraft({ draftId: draft.draftId, passphrase: 'ipc-pass-phrase' });
    const committed = await h.commitDraft({ draftId: draft.draftId, label: 'k', savePassphrase: false });
    if (!committed.ok) throw new Error('commit');
    expect(await h.updateKey({ id: committed.key.id, passphrase: { save: 'wrong' } })).toEqual({ ok: false, error: 'badPassphrase' });
    expect(await h.updateKey({ id: committed.key.id, passphrase: { save: 'ipc-pass-phrase' } })).toMatchObject({ ok: true, key: { passphraseSaved: true } });
  });

  it('answers fixed codes when the vault or known hosts file cannot be written', async () => {
    const h = createSshHandlers(deps);
    const boom = () => { throw new Error('EACCES D:\private\vault.json'); };
    vi.spyOn(deps.vault, 'setPassword').mockImplementation(boom);
    vi.spyOn(deps.vault, 'clearPassword').mockImplementation(boom);
    vi.spyOn(deps.vault, 'addKey').mockImplementation(boom);
    vi.spyOn(deps.vault, 'removeKey').mockImplementation(boom);
    vi.spyOn(deps.knownHosts, 'remove').mockImplementation(boom);
    const id = '00000000-0000-4000-8000-000000000042';
    expect(await h.setPassword({ hostId: HOST, password: 'ipc-host-password' })).toEqual({ ok: false, error: 'failed' });
    expect(await h.clearPassword({ hostId: HOST })).toEqual({ ok: false });
    expect(await h.generateKey({ label: 'gen', type: 'ed25519', savePassphrase: false })).toEqual({ ok: false, error: 'failed' });
    const draft = await h.draftFromText({ privateKey: pair.private });
    if (!draft.ok) throw new Error('draft');
    await h.unlockDraft({ draftId: draft.draftId, passphrase: 'ipc-pass-phrase' });
    expect(await h.commitDraft({ draftId: draft.draftId, label: 'x', savePassphrase: true })).toEqual({ ok: false, error: 'failed' });
    expect(await h.removeKey({ id })).toEqual({ ok: false });
    expect(await h.removeKnownHost({ id })).toEqual({ ok: false });
    expect(deps.vaultChanged).not.toHaveBeenCalled();
  });

  it('reports the file paths and which store opened read-only (task 13)', async () => {
    const vaultFile = join(dir, 'ssh', 'vault.json'), hostsFile = join(dir, 'ssh', 'known_hosts.json');
    expect(await createSshHandlers(deps).storageStatus()).toEqual({ vaultFile, vaultReadOnly: false, knownHostsFile: hostsFile, knownHostsReadOnly: false });
    // Files that exist but have the wrong shape are kept untouched and the stores open read-only.
    mkdirSync(join(dir, 'ssh'), { recursive: true });
    writeFileSync(vaultFile, '[]');
    writeFileSync(hostsFile, '{"version":1,"entries":"nope"}');
    const readOnly = createSshHandlers({ ...deps, vault: new SshVault(vaultFile, fakeCipher()), knownHosts: new KnownHostsStore(hostsFile) });
    expect(await readOnly.storageStatus()).toEqual({ vaultFile, vaultReadOnly: true, knownHostsFile: hostsFile, knownHostsReadOnly: true });
    expect(await readOnly.removeKnownHost({ id: '00000000-0000-4000-8000-000000000042' })).toEqual({ ok: false });
  });

  it('never returns a secret from any handler (L25)', async () => {
    const h = createSshHandlers(deps);
    const keyFile = join(dir, 'id_fixture');
    writeFileSync(keyFile, pair.private);
    deps.pickKeyFile = vi.fn(async () => keyFile);
    // A stored key with its passphrase saved, a saved password and a ready draft, so every handler has secrets it could leak.
    const draft = await h.draftFromText({ privateKey: pair.private });
    if (!draft.ok) throw new Error('draft');
    await h.unlockDraft({ draftId: draft.draftId, passphrase: 'ipc-pass-phrase' });
    const stored = await h.commitDraft({ draftId: draft.draftId, label: 'stored', savePassphrase: true });
    if (!stored.ok) throw new Error('commit');
    await h.setPassword({ hostId: HOST, password: 'ipc-host-password' });
    state = upsertSshIdentity(state, { id: IDENTITY, label: 'me', username: 'me', createdAt: 0, updatedAt: 0 });
    await h.setIdentityPassword({ identityId: IDENTITY, password: 'ipc-identity-password' });
    const ready = await h.draftFromText({ privateKey: pair.private });
    if (!ready.ok) throw new Error('draft');
    const cellId = state.projects[0].tabs[0].cells[0].id;
    const payloads: Record<(typeof SSH_CHANNELS)[keyof typeof SSH_CHANNELS], unknown> = {
      vaultInfo: undefined,
      generateKey: { label: 'gen', type: 'ed25519', passphrase: 'ipc-pass-phrase', savePassphrase: true },
      pickKeyFile: undefined,
      draftFromFile: { path: keyFile },
      draftFromText: { privateKey: pair.private },
      unlockDraft: { draftId: ready.draftId, passphrase: 'ipc-pass-phrase' },
      commitDraft: { draftId: ready.draftId, label: 'again', savePassphrase: true },
      updateKey: { id: stored.key.id, label: 'renamed', passphrase: { save: 'ipc-pass-phrase' } },
      removeKey: { id: '00000000-0000-4000-8000-000000000077' },
      exportPrivateKey: { id: stored.key.id },
      revealPrivateKey: { id: stored.key.id },
      replacePrivateKey: { id: stored.key.id, privateKey: pair.private, passphrase: 'ipc-pass-phrase', savePassphrase: true },
      setPassword: { hostId: HOST, password: 'ipc-host-password' },
      clearPassword: { hostId: HOST },
      setIdentityPassword: { identityId: IDENTITY, password: 'ipc-identity-password' },
      clearIdentityPassword: { identityId: IDENTITY },
      forgetPassphrases: undefined,
      storageStatus: undefined,
      knownHosts: undefined,
      removeKnownHost: { id: '00000000-0000-4000-8000-000000000078' },
      connect: { cellId, hostId: HOST, cols: 80, rows: 24 },
      sessions: undefined,
      answer: { cellId, promptId: HOST, cancel: true },
    };
    for (const [channel, name] of Object.entries(SSH_CHANNELS)) {
      // The explicit "Pokaż klucz prywatny" is the one allowed reveal path; it is checked on its own below.
      if (name === 'revealPrivateKey') continue;
      const result = await (h[name] as (payload?: unknown) => Promise<unknown>)(payloads[name]);
      expect(result, channel).not.toEqual({ ok: false, error: 'invalid' });
      expect(leaks(result), channel).toEqual([]);
      expect(JSON.stringify(result ?? null), channel).not.toContain('PRIVATE KEY');
    }
    expect(written).toHaveLength(1);
    // Only the reveal channel answers private key text, and only for the key that was asked for.
    expect(JSON.stringify(await h.revealPrivateKey(payloads.revealPrivateKey))).toContain('PRIVATE KEY');
  });

  it('answers a fixed code when exporting the private key fails (fix round 1)', async () => {
    const h = createSshHandlers(deps);
    const generated = await h.generateKey({ label: 'gen', type: 'ed25519', savePassphrase: false });
    if (!generated.ok) throw new Error('generate');
    deps.writeKeyFile = async () => { throw new Error('EPERM: operation not permitted, open D:\private\exported'); };
    const failedWrite = await h.exportPrivateKey({ id: generated.key.id });
    expect(failedWrite).toEqual({ ok: false, error: 'failed' });
    deps.saveKeyFile = async () => { throw new Error('EPERM dialog D:\private'); };
    const failedDialog = await h.exportPrivateKey({ id: generated.key.id });
    expect(failedDialog).toEqual({ ok: false, error: 'failed' });
    for (const r of [failedWrite, failedDialog]) expect(JSON.stringify(r)).not.toMatch(/EPERM|private/);
  });

  describe('private key reveal and replace (0.9.2)', () => {
    const KEY_GONE = '00000000-0000-4000-8000-000000000099';
    const generate = async (h: ReturnType<typeof createSshHandlers>, label = 'gen') => {
      const r = await h.generateKey({ label, type: 'ed25519', savePassphrase: false });
      if (!r.ok) throw new Error('generate');
      return r.key;
    };

    it('reveals the stored text only on an explicit call with a valid id; an encrypted key stays encrypted', async () => {
      const h = createSshHandlers(deps);
      const key = await generate(h);
      const r = await h.revealPrivateKey({ id: key.id });
      expect(r).toMatchObject({ ok: true });
      expect(r.ok && r.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
      expect(r.ok && r.privateKey).toBe(deps.vault.keySecret(key.id).ok && (deps.vault.keySecret(key.id) as { privateKey: string }).privateKey);
      expect(await h.revealPrivateKey({ id: KEY_GONE })).toEqual({ ok: false, error: 'notFound' });
      expect(await h.revealPrivateKey({ id: 'not-a-uuid' })).toEqual({ ok: false, error: 'notFound' });
      expect(await h.revealPrivateKey({ id: key.id, extra: true })).toEqual({ ok: false, error: 'notFound' });
      expect(await h.revealPrivateKey(undefined)).toEqual({ ok: false, error: 'notFound' });
      // A passphrase-protected key is returned as stored: the encrypted text, never decrypted with the saved passphrase.
      const draft = await h.draftFromText({ privateKey: pair.private });
      if (!draft.ok) throw new Error('draft');
      await h.unlockDraft({ draftId: draft.draftId, passphrase: 'ipc-pass-phrase' });
      const enc = await h.commitDraft({ draftId: draft.draftId, label: 'enc', savePassphrase: true });
      if (!enc.ok) throw new Error('commit');
      const shown = await h.revealPrivateKey({ id: enc.key.id });
      expect(shown).toEqual({ ok: true, privateKey: pair.private });
      expect(JSON.stringify(shown)).not.toContain('ipc-pass-phrase');
    });

    it('answers locked for a key this computer cannot decrypt, and still reveals from a read-only vault', async () => {
      const h = createSshHandlers(deps);
      const key = await generate(h);
      const vaultFile = join(dir, 'ssh', 'vault.json');
      const locked = createSshHandlers({ ...deps, vault: new SshVault(vaultFile, fakeCipher({ broken: true })) });
      expect(await locked.revealPrivateKey({ id: key.id })).toEqual({ ok: false, error: 'locked' });
      writeFileSync(vaultFile, readFileSync(vaultFile, 'utf8').replace('"version": 1', '"version": 99'));
      const readOnlyVault = new SshVault(vaultFile, fakeCipher());
      expect(readOnlyVault.readOnly()).toBe(true);
      expect(await createSshHandlers({ ...deps, vault: readOnlyVault }).revealPrivateKey({ id: key.id })).toMatchObject({ ok: true });
    });

    it('replaces the key material under the same id and reports whether the public key changed', async () => {
      const h = createSshHandlers(deps);
      const key = await generate(h, 'deploy');
      state = { ...state, sshHosts: state.sshHosts.map((x) => ({ ...x, keyId: key.id })) };
      const before = await h.revealPrivateKey({ id: key.id });
      if (!before.ok) throw new Error('reveal');
      // The same key again: nothing to update on the servers.
      expect(await h.replacePrivateKey({ id: key.id, privateKey: before.privateKey, savePassphrase: false })).toMatchObject({ ok: true, publicKeyChanged: false, key: { id: key.id, fingerprint: key.fingerprint } });
      const next = readableKeyPair('ecdsa', { bits: 256, comment: 'next@check' });
      const r = await h.replacePrivateKey({ id: key.id, privateKey: next.private, savePassphrase: false });
      if (!r.ok) throw new Error(`replace: ${r.error}`);
      expect(r.publicKeyChanged).toBe(true);
      expect(r.key).toMatchObject({ id: key.id, label: 'deploy', type: 'ecdsa-sha2-nistp256', bits: 256, comment: 'next@check', encrypted: false, createdAt: key.createdAt });
      expect(r.key.fingerprint).not.toBe(key.fingerprint);
      expect(r.key.publicKey).toMatch(/^ecdsa-sha2-nistp256 \S+ next@check$/);
      expect(JSON.stringify(r)).not.toContain('PRIVATE KEY');
      expect(await h.revealPrivateKey({ id: key.id })).toEqual({ ok: true, privateKey: next.private });
      expect(state.sshHosts[0].keyId).toBe(key.id);
      expect(deps.vault.info().keys).toHaveLength(1);
      expect(deps.vaultChanged).toHaveBeenCalled();
      // Written encrypted, like every stored key.
      expect(readFileSync(join(dir, 'ssh', 'vault.json'), 'utf8')).not.toContain('PRIVATE KEY');
    });

    it('stores an encrypted replacement only with the right passphrase and saves the passphrase only when asked', async () => {
      const h = createSshHandlers(deps);
      const key = await generate(h);
      expect(await h.replacePrivateKey({ id: key.id, privateKey: pair.private, savePassphrase: false })).toEqual({ ok: false, error: 'needsPassphrase' });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: pair.private, passphrase: 'wrong', savePassphrase: true })).toEqual({ ok: false, error: 'badPassphrase' });
      expect(deps.vault.key(key.id)!.fingerprint).toBe(key.fingerprint);
      const r = await h.replacePrivateKey({ id: key.id, privateKey: pair.private, passphrase: 'ipc-pass-phrase', savePassphrase: false });
      expect(r).toMatchObject({ ok: true, publicKeyChanged: true, key: { encrypted: true, passphraseSaved: false } });
      expect(leaks(r)).toEqual([]);
      expect(deps.vault.keySecret(key.id)).toEqual({ ok: true, privateKey: pair.private });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: pair.private, passphrase: 'ipc-pass-phrase', savePassphrase: true })).toMatchObject({ ok: true, publicKeyChanged: false, key: { passphraseSaved: true } });
      expect(deps.vault.keySecret(key.id)).toEqual({ ok: true, privateKey: pair.private, passphrase: 'ipc-pass-phrase' });
    });

    it('refuses invalid keys, PPK v3, public keys, wrong ids and malformed payloads with fixed codes', async () => {
      const h = createSshHandlers(deps);
      const key = await generate(h);
      const update = vi.spyOn(deps.vault, 'replaceKey');
      const ppk3 = 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\nPublic-Lines: 1\nAAAA\nPrivate-Lines: 1\nAAAA\nPrivate-MAC: 00\n';
      expect(await h.replacePrivateKey({ id: key.id, privateKey: 'hello', savePassphrase: false })).toEqual({ ok: false, error: 'notAKey' });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: ppk3, savePassphrase: false })).toEqual({ ok: false, error: 'ppkV3' });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: key.publicKey, savePassphrase: false })).toEqual({ ok: false, error: 'publicOnly' });
      expect(await h.replacePrivateKey({ id: KEY_GONE, privateKey: pair.private, passphrase: 'ipc-pass-phrase', savePassphrase: false })).toEqual({ ok: false, error: 'notFound' });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: '', savePassphrase: false })).toEqual({ ok: false, error: 'invalid' });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: 'x'.repeat(64 * 1024 + 1), savePassphrase: false })).toEqual({ ok: false, error: 'invalid' });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: pair.private, savePassphrase: false, label: 'x' })).toEqual({ ok: false, error: 'invalid' });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: pair.private })).toEqual({ ok: false, error: 'invalid' });
      expect(update).not.toHaveBeenCalled();
      // A PuTTY PPK v2 RSA key is accepted, like an import.
      expect(await h.replacePrivateKey({ id: key.id, privateKey: ppkV2Rsa('putty'), savePassphrase: false })).toMatchObject({ ok: true, publicKeyChanged: true, key: { type: 'ssh-rsa', comment: 'putty' } });
    });

    it('refuses a key that is already stored under another id, and a read-only vault', async () => {
      const h = createSshHandlers(deps);
      const a = await generate(h, 'a');
      const b = await generate(h, 'b');
      const bText = await h.revealPrivateKey({ id: b.id });
      if (!bText.ok) throw new Error('reveal');
      expect(await h.replacePrivateKey({ id: a.id, privateKey: bText.privateKey, savePassphrase: false })).toEqual({ ok: false, error: 'duplicate' });
      const vaultFile = join(dir, 'ssh', 'vault.json');
      writeFileSync(vaultFile, readFileSync(vaultFile, 'utf8').replace('"version": 1', '"version": 99'));
      const before = readFileSync(vaultFile, 'utf8');
      const ro = createSshHandlers({ ...deps, vault: new SshVault(vaultFile, fakeCipher()) });
      const next = readableKeyPair('ed25519');
      expect(await ro.replacePrivateKey({ id: a.id, privateKey: next.private, savePassphrase: false })).toEqual({ ok: false, error: 'readOnly' });
      expect(readFileSync(vaultFile, 'utf8')).toBe(before);
    });

    it('answers failed when the vault cannot be written, and drops a certificate of the old public key', async () => {
      const h = createSshHandlers(deps);
      const key = await generate(h);
      expect(await h.updateKey({ id: key.id, certificate: fakeCertificate(key.publicKey) })).toMatchObject({ ok: true });
      const current = await h.revealPrivateKey({ id: key.id });
      if (!current.ok) throw new Error('reveal');
      expect(await h.replacePrivateKey({ id: key.id, privateKey: current.privateKey, savePassphrase: false })).toMatchObject({ ok: true, certificateRemoved: false, key: { certificate: expect.any(String) } });
      const next = readableKeyPair('ed25519');
      const spy = vi.spyOn(deps.vault, 'replaceKey').mockImplementationOnce(() => { throw new Error('EACCES D:\\private\\vault.json'); });
      expect(await h.replacePrivateKey({ id: key.id, privateKey: next.private, savePassphrase: false })).toEqual({ ok: false, error: 'failed' });
      spy.mockRestore();
      const r = await h.replacePrivateKey({ id: key.id, privateKey: next.private, savePassphrase: false });
      expect(r).toMatchObject({ ok: true, publicKeyChanged: true, certificateRemoved: true });
      expect(r.ok && r.key.certificate).toBeUndefined();
      // Without a stored certificate nothing is reported as removed.
      expect(await h.replacePrivateKey({ id: key.id, privateKey: readableKeyPair('ed25519').private, savePassphrase: false })).toMatchObject({ ok: true, publicKeyChanged: true, certificateRemoved: false });
    });

    it('is registered behind the sender check like every ssh channel', async () => {
      const handle = vi.fn();
      const h = createSshHandlers(deps);
      const key = await generate(h);
      registerSshIpc({ handle, on: vi.fn() } as never, h, (event) => event.sender === 'app');
      const reveal = handle.mock.calls.find((c) => c[0] === 'ssh:key:revealPrivate')![1];
      const replace = handle.mock.calls.find((c) => c[0] === 'ssh:key:replacePrivate')![1];
      expect(await reveal({ sender: 'evil' }, { id: key.id })).toBeUndefined();
      expect(await replace({ sender: 'evil' }, { id: key.id, privateKey: readableKeyPair('ed25519').private, savePassphrase: false })).toBeUndefined();
      expect(deps.vault.key(key.id)!.fingerprint).toBe(key.fingerprint);
      expect(await reveal({ sender: 'app' }, { id: key.id })).toMatchObject({ ok: true });
    });
  });
});
