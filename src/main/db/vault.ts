// The DB vault (<data>/db/vault.json, 1.0.0): database passwords by connection id as safeStorage blobs, next to (never inside)
// the SSH vault. Same rules as the SSH vault: a newer or unreadable file opens read-only and is never written over; without
// safeStorage a password lives in memory only for this run (D8). Main only.
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { DbVaultInfo } from '../../shared/db';
import { ensurePrivateDir, readJsonFile, writePrivateFile } from '../ssh/files';
import type { Cipher } from '../ssh/vault';

interface PasswordRecord { connectionId: string; updatedAt: number; secret: string | null; plain: string | null; locked: boolean }

const VERSION = 1;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);

export class DbVault {
  private passwords: PasswordRecord[] = [];
  private newer = false;

  constructor(private readonly file: string, private readonly cipher: Cipher, private readonly now: () => number = Date.now) {
    const read = readJsonFile(file);
    if (!read.ok) {
      if (existsSync(file)) this.newer = true;
      return;
    }
    const v = read.value as { version?: unknown; passwords?: unknown };
    if (!isObject(v) || (v.passwords !== undefined && !Array.isArray(v.passwords))) { this.newer = true; return; }
    if (typeof v.version === 'number' && v.version > VERSION) this.newer = true;
    const raw: unknown[] = Array.isArray(v.passwords) ? v.passwords : [];
    for (const r of raw) {
      if (!isObject(r)) continue;
      const connectionId = str(r.connectionId, 64), secret = str(r.secret, 40_000);
      if (connectionId && secret) this.passwords.push({ connectionId, updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0, secret, plain: null, locked: false });
    }
    // An entry this version cannot read would be dropped by the next write: open read-only instead.
    if (this.passwords.length !== raw.length) this.newer = true;
    if (this.cipher.storage === 'dpapi') for (const p of this.passwords) this.password(p.connectionId);
  }

  readOnly(): boolean { return this.newer; }

  info(): DbVaultInfo {
    return {
      storage: this.cipher.storage,
      saved: this.passwords.map((p) => p.connectionId),
      locked: this.passwords.filter((p) => p.locked).map((p) => p.connectionId),
      readOnly: this.newer,
    };
  }

  has(connectionId: string): boolean { return this.passwords.some((p) => p.connectionId === connectionId); }

  setPassword(connectionId: string, password: string): { ok: true; ephemeral: boolean } | { ok: false; error: 'readOnly' } {
    if (this.newer) return { ok: false, error: 'readOnly' };
    const secret = this.cipher.available() ? this.cipher.encrypt(password).toString('base64') : null;
    const record: PasswordRecord = { connectionId, updatedAt: this.now(), secret, plain: secret === null ? password : null, locked: false };
    const next = [...this.passwords.filter((p) => p.connectionId !== connectionId), record];
    this.write(next);
    this.passwords = next;
    return { ok: true, ephemeral: secret === null };
  }

  clearPassword(connectionId: string): boolean {
    if (this.newer) return false;
    const next = this.passwords.filter((p) => p.connectionId !== connectionId);
    if (next.length === this.passwords.length) return false;
    this.write(next);
    this.passwords = next;
    return true;
  }

  password(connectionId: string): { ok: true; password: string } | { ok: false; error: 'none' | 'locked' } {
    const p = this.passwords.find((x) => x.connectionId === connectionId);
    if (!p) return { ok: false, error: 'none' };
    if (p.plain !== null) return { ok: true, password: p.plain };
    let text: string | null = null;
    try { text = p.secret ? this.cipher.decrypt(Buffer.from(p.secret, 'base64')) : null; } catch { text = null; }
    if (text === null) { p.locked = true; return { ok: false, error: 'locked' }; }
    p.locked = false;
    return { ok: true, password: text };
  }

  /** A duplicated connection gets the original's password (a copy of the sealed blob). */
  copyPassword(fromId: string, toId: string): boolean {
    if (this.newer) return false;
    const p = this.passwords.find((x) => x.connectionId === fromId);
    if (!p) return false;
    const next = [...this.passwords.filter((x) => x.connectionId !== toId), { ...p, connectionId: toId, updatedAt: this.now() }];
    this.write(next);
    this.passwords = next;
    return true;
  }

  /** Main calls this after every state change: passwords of connections that no longer exist are deleted. */
  prune(connectionIds: ReadonlySet<string>): boolean {
    if (this.newer) return false;
    const next = this.passwords.filter((p) => connectionIds.has(p.connectionId));
    if (next.length === this.passwords.length) return false;
    this.write(next);
    this.passwords = next;
    return true;
  }

  private write(all: readonly PasswordRecord[]): void {
    if (this.newer) return;
    const passwords = all.filter((p) => p.secret !== null);
    if (!passwords.length && !existsSync(this.file)) return; // memory-only: nothing touches the disk (D8)
    ensurePrivateDir(dirname(this.file));
    writePrivateFile(this.file, JSON.stringify({
      version: VERSION,
      passwords: passwords.map((p) => ({ connectionId: p.connectionId, updatedAt: p.updatedAt, secret: p.secret })),
    }, null, 1));
  }
}
