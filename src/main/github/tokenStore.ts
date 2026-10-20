// The GitHub token unimux got from the device flow (<data>/github/token.json): a safeStorage blob, never in clear on the disk,
// never logged, never sent to the renderer. Without safeStorage the token lives in memory until the app quits (like the SSH
// vault, D8). A newer or unreadable file is left alone (read-only) instead of being written over. Main only.
import { existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { ensurePrivateDir, readJsonFile, writePrivateFile } from '../ssh/files';
import type { Cipher } from '../ssh/vault';

const VERSION = 1;
const TOKEN = /^[\x21-\x7e]{10,1024}$/;

/** A token is printable ASCII without spaces (it goes into an HTTP header). */
export const isTokenText = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

export class GithubTokenStore {
  private secret: string | null = null;
  private plain: string | null = null;
  private user: string | null = null;
  private readOnly = false;

  constructor(private readonly file: string, private readonly cipher: Cipher, private readonly now: () => number = Date.now) {
    const read = readJsonFile(file);
    if (!read.ok) { if (existsSync(file)) this.readOnly = true; return; }
    const value = read.value as { version?: unknown; secret?: unknown; login?: unknown } | null;
    if (!value || typeof value !== 'object' || (typeof value.version === 'number' && value.version > VERSION)) { this.readOnly = true; return; }
    if (typeof value.secret === 'string' && value.secret.length <= 20_000) this.secret = value.secret;
    if (typeof value.login === 'string' && value.login.length <= 100) this.user = value.login;
  }

  get storage(): Cipher['storage'] { return this.cipher.storage; }
  has(): boolean { return this.plain !== null || this.secret !== null; }
  login(): string | null { return this.has() ? this.user : null; }

  /** The token, or null (none, or the system cannot decrypt it any more). Decrypted once per run. */
  get(): string | null {
    if (this.plain !== null) return this.plain;
    if (this.secret === null) return null;
    try {
      const text = this.cipher.decrypt(Buffer.from(this.secret, 'base64'));
      if (!isTokenText(text)) return null;
      this.plain = text;
      return text;
    } catch { return null; }
  }

  /** Keeps the token (encrypted on disk when the system can, else in memory only). False when the file is read-only. */
  set(token: string, login: string | null): boolean {
    if (!isTokenText(token)) return false;
    this.plain = token;
    this.user = login;
    if (this.readOnly) return false;
    if (!this.cipher.available()) { this.secret = null; this.removeFile(); return true; }
    this.secret = this.cipher.encrypt(token).toString('base64');
    try {
      ensurePrivateDir(dirname(this.file));
      writePrivateFile(this.file, JSON.stringify({ version: VERSION, login, savedAt: this.now(), secret: this.secret }, null, 1));
    } catch { /* kept for this run */ }
    return true;
  }

  /** Forgets the token (memory and disk). */
  clear(): void {
    this.plain = null;
    this.secret = null;
    this.user = null;
    if (!this.readOnly) this.removeFile();
  }

  private removeFile(): void {
    try { if (existsSync(this.file)) unlinkSync(this.file); } catch { /* best effort: the blob is useless without this user's key */ }
  }
}
