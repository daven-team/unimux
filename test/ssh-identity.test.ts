// SSH identities and the Termius-like host cards: the shared layer (model, validation, resolution, state, migration, view helpers).
import { describe, expect, it } from 'vitest';
import { StateController } from '../src/main/stateController';
import { hostFormDirty, hostsUsingKey, hostToDraft, normalizeSshHosts, validateHostDraft, type SshHost, type SshHostDraft } from '../src/shared/ssh';
import {
  hostIdentity, hostLogin, hostsUsingIdentity, identitiesUsingKey, identityCredential, identityCredentialText, identityFormDirty, identityToDraft, matchIdentities,
  normalizeSshIdentities, removeKeyQuestion, removeSshIdentity, upsertSshIdentity, validateIdentityDraft, IDENTITY_LIMIT, type SshIdentity,
} from '../src/shared/sshIdentity';
import { cardKeyConnects, ctrlPick, detailKey, hostCardDetail, liveDetail, paneDetail, sectionForDetail } from '../src/shared/sshView';
import { addSshHost, clearSshKeyRefs, defaultState, normalizeState } from '../src/shared/state';
import type { AppState } from '../src/shared/types';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const KEY = ID(900);
const OTHER_KEY = ID(901);
const host = (n: number, patch: Partial<SshHost> = {}): SshHost => ({ id: ID(n), label: `h${n}`, address: `h${n}.example`, port: 22, username: 'deploy', createdAt: 1, updatedAt: 1, ...patch });
const identity = (n: number, patch: Partial<SshIdentity> = {}): SshIdentity => ({ id: ID(100 + n), label: `id${n}`, username: `user${n}`, createdAt: 1, updatedAt: 1, ...patch });
const withHosts = (...hosts: SshHost[]): AppState => hosts.reduce((s, h) => addSshHost(s, h), defaultState());

describe('identity normalization', () => {
  it('keeps valid identities, trims fields and falls back to the user name as label', () => {
    expect(normalizeSshIdentities([{ id: ID(1), label: '  Hetzner  ', username: ' adam ', keyId: KEY, createdAt: 5, updatedAt: 6, extra: true }]))
      .toEqual([{ id: ID(1), label: 'Hetzner', username: 'adam', keyId: KEY, createdAt: 5, updatedAt: 6 }]);
    expect(normalizeSshIdentities([{ id: ID(2), label: '', username: 'root', keyId: 'not-a-uuid', createdAt: -1 }]))
      .toEqual([{ id: ID(2), label: 'root', username: 'root', createdAt: 0, updatedAt: 0 }]);
    expect(normalizeSshIdentities([{ id: ID(3), label: 'x'.repeat(200), username: 'u' }])[0].label).toHaveLength(80);
    expect(normalizeSshIdentities([{ id: ID(4), label: 'bad\u0007label', username: 'u' }])[0].label).toBe('u');
  });

  it('drops junk, bad ids, bad user names and duplicates, and reads anything else as none', () => {
    const list = normalizeSshIdentities([null, 7, 'x', { id: 'nope', username: 'u' }, { id: ID(1), username: 'a b' }, { id: ID(2), username: '' }, { id: ID(3) }, identity(1), identity(1, { label: 'dup' })]);
    expect(list.map((i) => i.id)).toEqual([identity(1).id]);
    expect(normalizeSshIdentities(undefined)).toEqual([]);
    expect(normalizeSshIdentities({ id: ID(1) })).toEqual([]);
  });

  it('keeps at most IDENTITY_LIMIT identities', () => {
    const many = Array.from({ length: IDENTITY_LIMIT + 5 }, (_, i) => ({ id: ID(i + 1), username: `u${i}` }));
    expect(normalizeSshIdentities(many)).toHaveLength(IDENTITY_LIMIT);
  });
});

describe('identity form', () => {
  it('needs a valid user name; the label falls back to it; only a uuid key is kept', () => {
    expect(validateIdentityDraft({ label: 'x', username: ' ' })).toEqual({ ok: false, errors: { username: 'Podaj nazwę użytkownika' } });
    expect(validateIdentityDraft({ label: '', username: 'two words' })).toMatchObject({ ok: false });
    expect(validateIdentityDraft({ label: ' ', username: ' adam ' })).toEqual({ ok: true, value: { label: 'adam', username: 'adam' } });
    expect(validateIdentityDraft({ label: 'Work', username: 'adam', keyId: KEY })).toEqual({ ok: true, value: { label: 'Work', username: 'adam', keyId: KEY } });
    expect(validateIdentityDraft({ label: 'Work', username: 'adam', keyId: 'junk' })).toEqual({ ok: true, value: { label: 'Work', username: 'adam' } });
  });

  it('is dirty only when it would save something different, or a password is typed or marked for removal', () => {
    const saved = identity(1, { keyId: KEY });
    const clean = { password: '', clearPassword: false };
    expect(identityFormDirty(saved, identityToDraft(saved), clean)).toBe(false);
    expect(identityFormDirty(saved, { ...identityToDraft(saved), username: ' user1 ' }, clean)).toBe(false);
    expect(identityFormDirty(saved, { ...identityToDraft(saved), keyId: undefined }, clean)).toBe(true);
    expect(identityFormDirty(saved, identityToDraft(saved), { password: 'x', clearPassword: false })).toBe(true);
    expect(identityFormDirty(saved, identityToDraft(saved), { password: '', clearPassword: true })).toBe(true);
    expect(identityFormDirty(undefined, identityToDraft(undefined), clean)).toBe(false);
    expect(identityFormDirty(undefined, { label: '', username: 'a' }, clean)).toBe(true);
  });
});

describe('host login resolution', () => {
  it('signs in with the host itself without an identity', () => {
    expect(hostLogin(host(1, { keyId: KEY }), [identity(1)])).toEqual({ username: 'deploy', keyId: KEY, secret: { kind: 'host', id: ID(1) } });
    expect(hostLogin(host(1), [])).toEqual({ username: 'deploy', secret: { kind: 'host', id: ID(1) } });
  });

  it('takes the user name, key and password of the identity, ignoring the host key', () => {
    const i = identity(1, { keyId: OTHER_KEY });
    expect(hostLogin(host(1, { identityId: i.id, keyId: KEY }), [i])).toEqual({ username: 'user1', keyId: OTHER_KEY, secret: { kind: 'identity', id: i.id } });
    // An identity without a key means no key, even when the host had one.
    expect(hostLogin(host(1, { identityId: i.id, keyId: KEY }), [identity(1)])).toEqual({ username: 'user1', secret: { kind: 'identity', id: i.id } });
  });

  it('falls back to the host fields when its identity no longer exists', () => {
    expect(hostLogin(host(1, { identityId: ID(555), keyId: KEY }), [identity(1)])).toEqual({ username: 'deploy', keyId: KEY, secret: { kind: 'host', id: ID(1) } });
    expect(hostIdentity(host(1, { identityId: ID(555) }), [identity(1)])).toBeUndefined();
    expect(hostIdentity(host(1, { identityId: identity(1).id }), [identity(1)])).toEqual(identity(1));
  });
});

describe('identity suggestions', () => {
  const list = [identity(1, { label: 'Hetzner', username: 'adam' }), identity(2, { label: 'ovh', username: 'root' }), identity(3, { label: 'Backup', username: 'adam-backup' })];
  it('offers every identity by label for an empty query, else those whose label or user name contains it', () => {
    expect(matchIdentities(list, '').map((i) => i.label)).toEqual(['Backup', 'Hetzner', 'ovh']);
    expect(matchIdentities(list, ' ADAM ').map((i) => i.label)).toEqual(['Backup', 'Hetzner']);
    expect(matchIdentities(list, 'ovh').map((i) => i.label)).toEqual(['ovh']);
    expect(matchIdentities(list, 'zzz')).toEqual([]);
    expect(list.map((i) => i.label)).toEqual(['Hetzner', 'ovh', 'Backup']);
  });

  it('describes what an identity carries; a key that is gone does not count', () => {
    const i = identity(1, { keyId: KEY });
    expect(identityCredential(i, [i.id], [KEY])).toBe('keyAndPassword');
    expect(identityCredential(i, [], [KEY])).toBe('key');
    expect(identityCredential(i, [i.id], [])).toBe('password');
    expect(identityCredential(identity(2), [], [KEY])).toBe('none');
    expect(['keyAndPassword', 'key', 'password', 'none'].map((c) => identityCredentialText(c as never))).toEqual(['klucz i hasło', 'klucz', 'hasło', 'tylko użytkownik']);
  });
});

describe('identity state', () => {
  it('adds and replaces identities and mirrors the user name into the hosts that use it', () => {
    const i = identity(1);
    let s = withHosts(host(1, { identityId: i.id, username: 'old' }), host(2));
    s = upsertSshIdentity(s, i);
    expect(s.sshIdentities).toEqual([i]);
    expect(s.sshHosts.map((h) => h.username)).toEqual(['user1', 'deploy']);
    const renamed = { ...i, username: 'adam', label: 'renamed' };
    const before = s.sshHosts[1];
    s = upsertSshIdentity(s, renamed);
    expect(s.sshIdentities).toEqual([renamed]);
    expect(s.sshHosts[0].username).toBe('adam');
    expect(s.sshHosts[1]).toBe(before);
    // Nothing to mirror: the host list keeps its identity.
    const hosts = s.sshHosts;
    expect(upsertSshIdentity(s, { ...renamed, label: 'again' }).sshHosts).toBe(hosts);
  });

  it('detaches the hosts of a deleted identity: they keep the user name and take its key when they have none', () => {
    const i = identity(1, { keyId: KEY });
    let s = upsertSshIdentity(withHosts(host(1, { identityId: i.id }), host(2, { identityId: i.id, keyId: OTHER_KEY }), host(3)), i);
    s = removeSshIdentity(s, i.id);
    expect(s.sshIdentities).toEqual([]);
    expect(s.sshHosts[0]).toEqual({ ...host(1), username: 'user1', keyId: KEY });
    expect(s.sshHosts[1]).toEqual({ ...host(2), username: 'user1', keyId: OTHER_KEY });
    expect(s.sshHosts[2]).toEqual(host(3));
    expect(removeSshIdentity(s, ID(999))).toBe(s);
  });

  it('lists the hosts of an identity and the hosts that sign in with a key, directly or through their identity', () => {
    const withKey = identity(1, { keyId: KEY });
    const hosts = [host(1, { keyId: KEY }), host(2, { identityId: withKey.id }), host(3, { identityId: identity(2).id, keyId: KEY }), host(4, { identityId: ID(555), keyId: KEY })];
    expect(hostsUsingIdentity(hosts, withKey.id).map((h) => h.id)).toEqual([ID(2)]);
    expect(hostsUsingKey(hosts, KEY, [withKey, identity(2)]).map((h) => h.id)).toEqual([ID(1), ID(2), ID(4)]);
    expect(hostsUsingKey(hosts, KEY).map((h) => h.id)).toEqual([ID(1), ID(3), ID(4)]);
  });

  it('counts the identities that carry a key in the question before deleting it, also when no host uses them', () => {
    const withKey = identity(1, { keyId: KEY });
    expect(identitiesUsingKey([withKey, identity(2), identity(3, { keyId: OTHER_KEY })], KEY)).toEqual([withKey]);
    expect(identitiesUsingKey([], KEY)).toEqual([]);
    expect(removeKeyQuestion('main', 0, 1)).toEqual({ key: 'Klucz jest używany przez {count} tożsamości. Usunąć go?', params: { count: 1 } });
    expect(removeKeyQuestion('main', 2, 1)).toEqual({ key: 'Klucz jest używany przez {hosts} hostów i {identities} tożsamości. Usunąć go?', params: { hosts: 2, identities: 1 } });
    expect(removeKeyQuestion('main', 3, 0)).toEqual({ key: 'Klucz jest używany przez {count} hostów. Usunąć go?', params: { count: 3 } });
    expect(removeKeyQuestion('main', 0, 0)).toEqual({ key: 'Usunąć klucz {name}?', params: { name: 'main' } });
  });

  it('clears a deleted key from hosts and identities alike', () => {
    let s = upsertSshIdentity(withHosts(host(1, { keyId: KEY }), host(2, { keyId: OTHER_KEY })), identity(1, { keyId: KEY }));
    s = upsertSshIdentity(s, identity(2, { keyId: OTHER_KEY }));
    const next = clearSshKeyRefs(s, KEY);
    expect(next.sshHosts.map((h) => h.keyId)).toEqual([undefined, OTHER_KEY]);
    expect(next.sshIdentities.map((i) => i.keyId)).toEqual([undefined, OTHER_KEY]);
    expect('keyId' in next.sshIdentities[0]).toBe(false);
    expect(clearSshKeyRefs(next, ID(999))).toBe(next);
  });
});

describe('identity persistence and migration', () => {
  it('loads a state file from before identities with none, and keeps host identity references', () => {
    const { sshIdentities: _gone, ...old } = defaultState();
    const loaded = normalizeState(JSON.parse(JSON.stringify({ ...old, sshHosts: [host(1)] })))!;
    expect(loaded.sshIdentities).toEqual([]);
    expect(loaded.sshHosts).toEqual([host(1)]);
    const i = identity(1);
    const saved = upsertSshIdentity(withHosts(host(1, { identityId: i.id }), host(2, { identityId: 'junk' } as Partial<SshHost>)), i);
    const again = normalizeState(JSON.parse(JSON.stringify(saved)))!;
    expect(again.sshIdentities).toEqual([i]);
    expect(again.sshHosts.map((h) => h.identityId)).toEqual([i.id, undefined]);
    expect(normalizeState(JSON.parse(JSON.stringify({ ...saved, sshIdentities: [{ id: 'bad' }, i, 'x'] })))!.sshIdentities).toEqual([i]);
  });

  it('normalizes identities edited in the renderer (R6) and keeps an unchanged list as it is', () => {
    const base = defaultState();
    const controller = new StateController(base, () => undefined);
    const i = identity(1);
    controller.apply({ id: 'e1', base, next: { ...base, sshIdentities: [i, { id: 'bad', username: 'x' } as unknown as SshIdentity, { ...i, label: 'dup' }] } });
    expect(controller.get().sshIdentities).toEqual([i]);
    const list = controller.get().sshIdentities;
    controller.apply({ id: 'e2', base: controller.get(), next: { ...controller.get(), sshHosts: [host(1, { identityId: i.id })] } });
    expect(controller.get().sshIdentities).toBe(list);
    expect(controller.get().sshHosts[0].identityId).toBe(i.id);
  });

  it('normalizes the identity reference of a host like its key reference', () => {
    expect(normalizeSshHosts([{ ...host(1), identityId: ID(7) }])[0].identityId).toBe(ID(7));
    expect(normalizeSshHosts([{ ...host(1), identityId: 'nope' }])[0]).toEqual(host(1));
  });
});

describe('host form with an identity', () => {
  const draft: SshHostDraft = { ...hostToDraft(undefined), address: 'example.com', username: 'me' };

  it('stores the identity instead of the host key', () => {
    expect(validateHostDraft({ ...draft, keyId: KEY, identityId: ID(101) })).toEqual({ ok: true, value: { label: 'example.com', address: 'example.com', port: 22, username: 'me', identityId: ID(101) } });
    expect(validateHostDraft({ ...draft, keyId: KEY, identityId: 'junk' })).toEqual({ ok: true, value: { label: 'example.com', address: 'example.com', port: 22, username: 'me', keyId: KEY } });
    expect(hostToDraft(host(1, { identityId: ID(101) })).identityId).toBe(ID(101));
  });

  it('counts attaching or detaching an identity and a saved password marked for removal as unsaved changes', () => {
    const saved = host(1, { identityId: ID(101) });
    const form = hostToDraft(saved);
    const typed = { tag: '', password: '' };
    expect(hostFormDirty(saved, form, typed)).toBe(false);
    // The host key the form keeps while an identity is attached is not a change.
    expect(hostFormDirty(saved, { ...form, keyId: KEY }, typed)).toBe(false);
    expect(hostFormDirty(saved, { ...form, identityId: undefined }, typed)).toBe(true);
    expect(hostFormDirty(host(2), { ...hostToDraft(host(2)), identityId: ID(101) }, typed)).toBe(true);
    expect(hostFormDirty(saved, form, { ...typed, clearPassword: true })).toBe(true);
  });
});

describe('host cards and the keychain pane', () => {
  it('picks one card with a plain click and starts a Ctrl+click selection from it', () => {
    const shown = ['a', 'b', 'c', 'z'];
    expect(ctrlPick([], 'a', 'b', shown)).toEqual({ selected: ['a', 'b'], picked: 'b' });
    expect(ctrlPick([], null, 'b', shown)).toEqual({ selected: ['b'], picked: 'b' });
    expect(ctrlPick([], 'b', 'b', shown)).toEqual({ selected: ['b'], picked: 'b' });
    expect(ctrlPick(['a'], 'z', 'b', shown)).toEqual({ selected: ['a', 'b'], picked: 'b' });
  });

  it('never starts a selection from a hidden pick and drops the pick of a card Ctrl+clicked out of the selection', () => {
    // Click A, search A away, Ctrl+click B: only B ("Otwórz jako siatkę" never counts a host that is not shown).
    expect(ctrlPick([], 'a', 'b', ['b', 'c'])).toEqual({ selected: ['b'], picked: 'b' });
    // A card in a folded group is not shown either.
    expect(ctrlPick([], 'a', 'b', [])).toEqual({ selected: ['b'], picked: 'b' });
    // Ctrl+click A again in [A, C]: A leaves the selection and is not picked (it would look selected).
    expect(ctrlPick(['a', 'c'], 'a', 'a', ['a', 'c'])).toEqual({ selected: ['c'], picked: null });
    expect(ctrlPick(['a', 'c'], 'z', 'c', ['a', 'c', 'z'])).toEqual({ selected: ['a'], picked: null });
    // After "Wyczyść zaznaczenie" (the pick is cleared with it) a Ctrl+click starts afresh.
    expect(ctrlPick([], null, 'c', ['a', 'b', 'c'])).toEqual({ selected: ['c'], picked: 'c' });
  });

  it('shows "ssh, user, tags" under the label and connects on a plain Enter only', () => {
    expect(hostCardDetail(host(1, { tags: ['hetzner', 'prod'] }))).toBe('ssh, deploy, hetzner, prod');
    expect(hostCardDetail(host(1))).toBe('ssh, deploy');
    const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
    expect(cardKeyConnects(key('Enter'))).toBe(true);
    expect(cardKeyConnects(key('Enter', { ctrlKey: true }))).toBe(false);
    expect(cardKeyConnects(key('Enter', { shiftKey: true }))).toBe(false);
    expect(cardKeyConnects(key(' '))).toBe(false);
  });

  it('keys, sections and forgets identity panes like key panes', () => {
    expect(detailKey({ kind: 'identity' })).toBe('identity:new');
    expect(detailKey({ kind: 'identity', identityId: ID(101) })).toBe(`identity:${ID(101)}`);
    expect(sectionForDetail({ kind: 'identity' })).toBe('keys');
    expect(paneDetail('keys', { kind: 'identity' })).toEqual({ kind: 'identity' });
    expect(paneDetail('hosts', { kind: 'identity' })).toBeNull();
    expect(liveDetail({ kind: 'identity', identityId: ID(101) }, [], [], [ID(101)])).toEqual({ kind: 'identity', identityId: ID(101) });
    expect(liveDetail({ kind: 'identity', identityId: ID(101) }, [], [])).toBeNull();
    expect(liveDetail({ kind: 'identity' }, [], [])).toEqual({ kind: 'identity' });
  });
});
