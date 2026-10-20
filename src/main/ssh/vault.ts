// The SSH vault (<data>/ssh/vault.json, spec 7.3): key metadata in clear, secrets as safeStorage blobs. Main only.
// Saved passwords belong to a host or (since identities) to an identity; each kind is its own list in the file.
import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { KEY_ALGOS, type SshKeyAlgo, type SshKeyInfo, type SshVaultInfo } from '../../shared/ssh';
import { ensurePrivateDir, readJsonFile, writePrivateFile } from './files';

export interface Cipher {
  readonly storage: 'dpapi' | 'keychain' | 'unavailable';
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string; getSelectedStorageBackend?(): string }

/** safeStorage behind the Cipher interface. Only Windows (DPAPI) and macOS (Keychain) count as available (D8). */
export function electronCipher(safeStorage: SafeStorageLike, platform: NodeJS.Platform, forceUnavailable: boolean): Cipher {
  const available = () => !forceUnavailable && (platform === 'win32' || platform === 'darwin') && safeStorage.isEncryptionAvailable();
  return {
    get storage() { return !available() ? 'unavailable' : platform === 'darwin' ? 'keychain' : 'dpapi'; },
    available,
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };
}

export interface NewKey {
  label: string; type: SshKeyAlgo; bits: number; fingerprint: string; publicKey: string; comment: string; encrypted: boolean;
  privateKey: string; passphrase?: string; savePassphrase: boolean; certificate?: string; source: 'generated' | 'imported';
}

type KeyMetaRecord = Omit<SshKeyInfo, 'ephemeral' | 'locked'>;
interface KeyRecord { meta: KeyMetaRecord; secret: string | null; plain: { privateKey: string; passphrase?: string } | null; locked: boolean }
interface PasswordRecord { hostId: string; updatedAt: number; secret: string | null; plain: string | null; locked: boolean }
/** Whose password: a host's (`passwords` in the file, keyed by hostId) or an identity's (`identityPasswords`, keyed by identityId). */
type PasswordOwner = 'host' | 'identity';
type Passwords = Readonly<Record<PasswordOwner, readonly PasswordRecord[]>>;

/**
 * The newest format this version reads. A file is written as version 2 only while it holds identity passwords: a version 1 app
 * would drop that list on its next write, so it opens such a file read-only instead; a file without them stays version 1.
 */
const VERSION = 2;
const OWNER_FIELD: Record<PasswordOwner, 'hostId' | 'identityId'> = { host: 'hostId', identity: 'identityId' };
const ALGOS = new Set<string>(KEY_ALGOS);
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (v: unknown, max = 4000) => (typeof v === 'string' && v.length <= max ? v : undefined);

export class SshVault {
  private keys: KeyRecord[] = [];
  /** Records of both owners keep the owner's id in `hostId` (an identity id for identity passwords). */
  private passwords: Passwords = { host: [], identity: [] };
  /** A newer version, an unreadable file or one of the wrong shape: nothing is ever written over it (no stored secret is lost). */
  private newer = false;
  /** D7: passphrases typed into a prompt with "remember until the app quits". Never written. */
  private rememberedPassphrases = new Map<string, string>();
  /** Bumped when a key's material is replaced: a passphrase typed for the old material is never remembered for the new one. */
  private generations = new Map<string, number>();
  /** Saved passphrases already checked against their key this run (preflight M2: the bcrypt check is not repeated per connect).
   *  Only a SHA-256 of the passphrase is kept, never a second plaintext copy. */
  private verifiedPassphrases = new Map<string, string>();

  constructor(private readonly file: string, private readonly cipher: Cipher, private readonly now: () => number = Date.now) {
    const read = readJsonFile(file);
    if (!read.ok) {
      // Missing, or unparsable and moved to vault.json.bak-<time>: start empty. Still there means it could not be read: keep it untouched.
      if (existsSync(file)) this.newer = true;
      return;
    }
    const v = read.value as { version?: unknown; keys?: unknown; passwords?: unknown; identityPasswords?: unknown };
    if (!isObject(v) || [v.keys, v.passwords, v.identityPasswords].some((list) => list !== undefined && !Array.isArray(list))) {
      this.newer = true;
      return;
    }
    if (typeof v.version === 'number' && v.version > VERSION) this.newer = true;
    const rawKeys: unknown[] = Array.isArray(v.keys) ? v.keys : [];
    const rawPasswords: Record<PasswordOwner, unknown[]> = {
      host: Array.isArray(v.passwords) ? v.passwords : [],
      identity: Array.isArray(v.identityPasswords) ? v.identityPasswords : [],
    };
    for (const raw of rawKeys) {
      if (!isObject(raw)) continue;
      const k = raw;
      const id = str(k.id, 64), label = str(k.label, 80), type = str(k.type, 40), fingerprint = str(k.fingerprint, 100), publicKey = str(k.publicKey, 20000), secret = str(k.secret, 400000);
      if (!id || label === undefined || !type || !ALGOS.has(type) || !fingerprint || !publicKey || !secret) continue;
      this.keys.push({ meta: {
        id, label, type: type as SshKeyAlgo, bits: typeof k.bits === 'number' ? k.bits : 0, fingerprint, publicKey, comment: str(k.comment, 200) ?? '',
        encrypted: k.encrypted === true, passphraseSaved: k.passphraseSaved === true, ...(str(k.certificate, 20000) ? { certificate: str(k.certificate, 20000) } : {}),
        source: k.source === 'generated' ? 'generated' : 'imported', createdAt: typeof k.createdAt === 'number' ? k.createdAt : 0,
      }, secret, plain: null, locked: false });
    }
    const loaded: Record<PasswordOwner, PasswordRecord[]> = { host: [], identity: [] };
    for (const owner of ['host', 'identity'] as const) {
      for (const raw of rawPasswords[owner]) {
        if (!isObject(raw)) continue;
        const id = str(raw[OWNER_FIELD[owner]], 64), secret = str(raw.secret, 20000);
        if (id && secret) loaded[owner].push({ hostId: id, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0, secret, plain: null, locked: false });
      }
    }
    this.passwords = loaded;
    // An entry this version cannot read would be dropped by the next write: open read-only instead.
    if (this.keys.length !== rawKeys.length || loaded.host.length !== rawPasswords.host.length || loaded.identity.length !== rawPasswords.identity.length) this.newer = true;
    // DPAPI decrypts without a prompt, so locked entries are known at once (spec 7.3). The Keychain stays lazy: no prompt at startup,
    // and a denial is retried on the next use. The decrypted values are dropped right away.
    if (this.cipher.storage === 'dpapi') {
      for (const k of this.keys) this.keySecret(k.meta.id);
      for (const owner of ['host', 'identity'] as const) for (const p of loaded[owner]) this.ownedPassword(owner, p.hostId);
    }
  }

  readOnly(): boolean { return this.newer; }
  filePath(): string { return this.file; }

  private infoOf(r: KeyRecord): SshKeyInfo { return { ...r.meta, ephemeral: r.secret === null, locked: r.locked }; }

  info(): SshVaultInfo {
    return {
      storage: this.cipher.storage,
      keys: this.keys.map((r) => this.infoOf(r)),
      savedPasswords: this.passwords.host.map((p) => p.hostId),
      lockedPasswords: this.passwords.host.filter((p) => p.locked).map((p) => p.hostId),
      savedIdentityPasswords: this.passwords.identity.map((p) => p.hostId),
      lockedIdentityPasswords: this.passwords.identity.filter((p) => p.locked).map((p) => p.hostId),
      readOnly: this.newer,
    };
  }

  key(id: string): SshKeyInfo | undefined { const r = this.keys.find((k) => k.meta.id === id); return r && this.infoOf(r); }
  findByFingerprint(fp: string): SshKeyInfo | undefined { const r = this.keys.find((k) => k.meta.fingerprint === fp); return r && this.infoOf(r); }

  private seal(value: string): string | null {
    return this.cipher.available() ? this.cipher.encrypt(value).toString('base64') : null;
  }

  private open(secret: string): string | null {
    try { return this.cipher.decrypt(Buffer.from(secret, 'base64')); } catch { return null; }
  }

  addKey(k: NewKey): { ok: true; key: SshKeyInfo; duplicate: boolean } | { ok: false; error: 'readOnly' } {
    if (this.newer) return { ok: false, error: 'readOnly' };
    const existing = this.keys.find((r) => r.meta.fingerprint === k.fingerprint);
    if (existing) return { ok: true, key: this.infoOf(existing), duplicate: true };
    const plain = { privateKey: k.privateKey, ...(k.savePassphrase && k.passphrase ? { passphrase: k.passphrase } : {}) };
    const secret = this.seal(JSON.stringify(plain));
    const record: KeyRecord = {
      meta: {
        id: randomUUID(), label: k.label.slice(0, 80), type: k.type, bits: k.bits, fingerprint: k.fingerprint, publicKey: k.publicKey, comment: k.comment,
        encrypted: k.encrypted, passphraseSaved: !!plain.passphrase, ...(k.certificate ? { certificate: k.certificate } : {}), source: k.source, createdAt: this.now(),
      },
      secret, plain: secret === null ? plain : null, locked: false,
    };
    const next = [...this.keys, record];
    this.write(next, this.passwords);
    this.keys = next;
    return { ok: true, key: this.infoOf(record), duplicate: false };
  }

  keySecret(id: string): { ok: true; privateKey: string; passphrase?: string } | { ok: false; error: 'keyMissing' | 'keyLocked' } {
    const r = this.keys.find((k) => k.meta.id === id);
    if (!r) return { ok: false, error: 'keyMissing' };
    if (r.plain) return { ok: true, ...r.plain };
    const text = r.secret ? this.open(r.secret) : null;
    if (text === null) { r.locked = true; return { ok: false, error: 'keyLocked' }; }
    r.locked = false;
    try {
      const parsed = JSON.parse(text) as { privateKey?: unknown; passphrase?: unknown };
      if (typeof parsed.privateKey !== 'string') throw new Error('shape');
      return { ok: true, privateKey: parsed.privateKey, ...(typeof parsed.passphrase === 'string' ? { passphrase: parsed.passphrase } : {}) };
    } catch { r.locked = true; return { ok: false, error: 'keyLocked' }; }
  }

  updateKey(id: string, patch: { label?: string; certificate?: string | null; passphrase?: { save: string } | { forget: true } }): { ok: true; key: SshKeyInfo } | { ok: false; error: 'notFound' | 'readOnly' | 'keyLocked' | 'failed' } {
    if (this.newer) return { ok: false, error: 'readOnly' };
    const r = this.keys.find((k) => k.meta.id === id);
    if (!r) return { ok: false, error: 'notFound' };
    const updated: KeyRecord = { ...r, meta: { ...r.meta } };
    if (patch.passphrase) {
      // A stored key must be sealed again; without encryption it would turn memory-only and vanish from the file on the next write.
      if (r.secret !== null && !this.cipher.available()) return { ok: false, error: 'failed' };
      const current = this.keySecret(id);
      if (!current.ok) return { ok: false, error: 'keyLocked' };
      const plain = { privateKey: current.privateKey, ...('save' in patch.passphrase ? { passphrase: patch.passphrase.save } : {}) };
      const secret = r.secret === null ? null : this.seal(JSON.stringify(plain));
      if (r.secret !== null && secret === null) return { ok: false, error: 'failed' };
      updated.locked = false; // keySecret just decrypted it
      updated.secret = secret;
      updated.plain = secret === null ? plain : null;
      updated.meta.passphraseSaved = !!plain.passphrase;
    }
    if (patch.label !== undefined) updated.meta.label = patch.label.slice(0, 80);
    if (patch.certificate === null) delete updated.meta.certificate;
    else if (patch.certificate !== undefined) updated.meta.certificate = patch.certificate;
    const next = this.keys.map((k) => (k === r ? updated : k));
    this.write(next, this.passwords);
    this.keys = next;
    if (patch.passphrase) this.rememberedPassphrases.delete(id);
    this.verifiedPassphrases.delete(id);
    return { ok: true, key: this.infoOf(updated) };
  }

  /**
   * "Zastąp klucz prywatny": new key material under the same id (label, hosts using it and createdAt stay). The public key,
   * fingerprint, type and comment follow the new key; a certificate of another public key is dropped. A remembered or
   * verified passphrase of the old key is forgotten.
   */
  replaceKey(id: string, k: Omit<NewKey, 'label' | 'certificate' | 'source'>): { ok: true; key: SshKeyInfo; publicKeyChanged: boolean; certificateRemoved: boolean } | { ok: false; error: 'notFound' | 'readOnly' | 'duplicate' | 'failed' } {
    if (this.newer) return { ok: false, error: 'readOnly' };
    const r = this.keys.find((x) => x.meta.id === id);
    if (!r) return { ok: false, error: 'notFound' };
    if (this.keys.some((x) => x !== r && x.meta.fingerprint === k.fingerprint)) return { ok: false, error: 'duplicate' };
    // A stored key must stay stored: without encryption it would turn memory-only and vanish from the file on the next write.
    if (r.secret !== null && !this.cipher.available()) return { ok: false, error: 'failed' };
    const plain = { privateKey: k.privateKey, ...(k.encrypted && k.savePassphrase && k.passphrase ? { passphrase: k.passphrase } : {}) };
    const secret = r.secret === null ? null : this.seal(JSON.stringify(plain));
    const publicKeyChanged = r.meta.fingerprint !== k.fingerprint;
    const { certificate, ...rest } = r.meta;
    const updated: KeyRecord = {
      meta: { ...rest, type: k.type, bits: k.bits, fingerprint: k.fingerprint, publicKey: k.publicKey, comment: k.comment, encrypted: k.encrypted,
        passphraseSaved: !!plain.passphrase, ...(certificate && !publicKeyChanged ? { certificate } : {}) },
      secret, plain: secret === null ? plain : null, locked: false,
    };
    const next = this.keys.map((x) => (x === r ? updated : x));
    this.write(next, this.passwords);
    this.keys = next;
    this.generations.set(id, this.generation(id) + 1);
    this.rememberedPassphrases.delete(id);
    this.verifiedPassphrases.delete(id);
    return { ok: true, key: this.infoOf(updated), publicKeyChanged, certificateRemoved: !!certificate && publicKeyChanged };
  }

  removeKey(id: string): boolean {
    if (this.newer) return false;
    const next = this.keys.filter((k) => k.meta.id !== id);
    if (next.length === this.keys.length) return false;
    this.write(next, this.passwords);
    this.keys = next;
    this.rememberedPassphrases.delete(id);
    this.verifiedPassphrases.delete(id);
    return true;
  }

  /** The material generation of a key (0 until it is replaced). */
  generation(keyId: string): number { return this.generations.get(keyId) ?? 0; }
  /** Remembers a typed passphrase; with `generation`, only if the key was not replaced since the passphrase was checked against it. */
  remember(keyId: string, passphrase: string, generation?: number): boolean {
    if (generation !== undefined && generation !== this.generation(keyId)) return false;
    this.rememberedPassphrases.set(keyId, passphrase);
    return true;
  }
  remembered(keyId: string): string | undefined { return this.rememberedPassphrases.get(keyId); }
  forgetRemembered(): void { this.rememberedPassphrases.clear(); this.verifiedPassphrases.clear(); }
  markVerified(keyId: string, passphrase: string): void { this.verifiedPassphrases.set(keyId, digest(passphrase)); }
  isVerified(keyId: string, passphrase: string): boolean { return this.verifiedPassphrases.get(keyId) === digest(passphrase); }

  setPassword(hostId: string, password: string): { ok: true; ephemeral: boolean } | { ok: false; error: 'readOnly' } { return this.setOwnedPassword('host', hostId, password); }
  clearPassword(hostId: string): boolean { return this.clearOwnedPassword('host', hostId); }
  password(hostId: string): { ok: true; password: string } | { ok: false; error: 'none' | 'locked' } { return this.ownedPassword('host', hostId); }
  /** Main calls this after every state change: passwords of hosts that no longer exist are deleted. */
  prunePasswords(hostIds: ReadonlySet<string>): boolean { return this.pruneOwned('host', hostIds); }

  setIdentityPassword(identityId: string, password: string): { ok: true; ephemeral: boolean } | { ok: false; error: 'readOnly' } { return this.setOwnedPassword('identity', identityId, password); }
  clearIdentityPassword(identityId: string): boolean { return this.clearOwnedPassword('identity', identityId); }
  identityPassword(identityId: string): { ok: true; password: string } | { ok: false; error: 'none' | 'locked' } { return this.ownedPassword('identity', identityId); }
  /** Like prunePasswords, for identities that no longer exist. */
  pruneIdentityPasswords(identityIds: ReadonlySet<string>): boolean { return this.pruneOwned('identity', identityIds); }

  private withPasswords(owner: PasswordOwner, list: readonly PasswordRecord[]): Passwords { return { ...this.passwords, [owner]: list }; }

  private setOwnedPassword(owner: PasswordOwner, id: string, password: string): { ok: true; ephemeral: boolean } | { ok: false; error: 'readOnly' } {
    if (this.newer) return { ok: false, error: 'readOnly' };
    const secret = this.seal(password);
    const record: PasswordRecord = { hostId: id, updatedAt: this.now(), secret, plain: secret === null ? password : null, locked: false };
    const next = this.withPasswords(owner, [...this.passwords[owner].filter((p) => p.hostId !== id), record]);
    this.write(this.keys, next);
    this.passwords = next;
    return { ok: true, ephemeral: secret === null };
  }

  private clearOwnedPassword(owner: PasswordOwner, id: string): boolean {
    if (this.newer) return false;
    const list = this.passwords[owner].filter((p) => p.hostId !== id);
    if (list.length === this.passwords[owner].length) return false;
    const next = this.withPasswords(owner, list);
    this.write(this.keys, next);
    this.passwords = next;
    return true;
  }

  private ownedPassword(owner: PasswordOwner, id: string): { ok: true; password: string } | { ok: false; error: 'none' | 'locked' } {
    const p = this.passwords[owner].find((x) => x.hostId === id);
    if (!p) return { ok: false, error: 'none' };
    if (p.plain !== null) return { ok: true, password: p.plain };
    const text = p.secret ? this.open(p.secret) : null;
    if (text === null) { p.locked = true; return { ok: false, error: 'locked' }; }
    p.locked = false;
    return { ok: true, password: text };
  }

  private pruneOwned(owner: PasswordOwner, ids: ReadonlySet<string>): boolean {
    if (this.newer) return false;
    const list = this.passwords[owner].filter((p) => ids.has(p.hostId));
    if (list.length === this.passwords[owner].length) return false;
    const next = this.withPasswords(owner, list);
    this.write(this.keys, next);
    this.passwords = next;
    return true;
  }

  /** Writes the given lists; callers adopt them only after this returns, so a failed write leaves memory as it was. */
  private write(allKeys: readonly KeyRecord[], allPasswords: Passwords): void {
    if (this.newer) return;
    const keys = allKeys.filter((k) => k.secret !== null);
    const stored = (owner: PasswordOwner) => allPasswords[owner].filter((p) => p.secret !== null)
      .map((p) => ({ [OWNER_FIELD[owner]]: p.hostId, updatedAt: p.updatedAt, secret: p.secret }));
    const passwords = stored('host');
    const identityPasswords = stored('identity');
    if (!keys.length && !passwords.length && !identityPasswords.length && !existsSync(this.file)) return; // memory-only vault: nothing touches the disk (D8)
    ensurePrivateDir(dirname(this.file));
    writePrivateFile(this.file, JSON.stringify({
      version: identityPasswords.length ? VERSION : 1,
      keys: keys.map((k) => ({ ...k.meta, certificate: k.meta.certificate ?? null, secret: k.secret })),
      passwords,
      ...(identityPasswords.length ? { identityPasswords } : {}),
    }, null, 1));
  }
}
