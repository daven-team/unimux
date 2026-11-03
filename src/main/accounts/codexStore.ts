// src/main/accounts/codexStore.ts - 1.1.2: the saved Codex accounts. Each lives in `<root>/profiles/<uuid>` (a CODEX_HOME of
// its own, holding the auth.json `codex login` wrote there) and is listed in `<root>/accounts.json`, which never holds a
// token. See shared/codexAccounts for the family rule.
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { isCodexAccountId, normalizeCodexAccounts, type CodexAccount, type CodexAccountsFile, type CodexIdentity } from '../../shared/codexAccounts';
import { atomicWriteFileSync } from '../atomicWrite';

export class CodexAccountsReadOnlyError extends Error {
  constructor() { super('codex accounts.json is read-only'); }
}

export class CodexAccountsStore {
  private readonly file: string;
  private cached?: { stamp: string; file: CodexAccountsFile; readOnly: boolean };

  constructor(readonly root: string) {
    this.file = join(root, 'accounts.json');
  }

  /** Missing: empty. Unreadable or unparsable: read-only, so the records in it are never overwritten. */
  private read(): { file: CodexAccountsFile; readOnly: boolean } {
    let stamp: string | undefined;
    try {
      const info = statSync(this.file);
      stamp = `${info.mtimeMs}:${info.size}:${info.ino}`;
    } catch {
      return { file: { version: 1, accounts: [] }, readOnly: false };
    }
    if (this.cached?.stamp === stamp) return { file: structuredClone(this.cached.file), readOnly: this.cached.readOnly };
    let result: { file: CodexAccountsFile; readOnly: boolean };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown };
      result = raw && typeof raw === 'object' && (raw.version === undefined || raw.version === 1)
        ? { file: normalizeCodexAccounts(raw), readOnly: false }
        : { file: { version: 1, accounts: [] }, readOnly: true };
    } catch {
      result = { file: { version: 1, accounts: [] }, readOnly: existsSync(this.file) };
    }
    this.cached = { stamp, file: structuredClone(result.file), readOnly: result.readOnly };
    return result;
  }

  private change(edit: (file: CodexAccountsFile) => void): void {
    const { file, readOnly } = this.read();
    if (readOnly) throw new CodexAccountsReadOnlyError();
    edit(file);
    mkdirSync(this.root, { recursive: true });
    atomicWriteFileSync(this.file, JSON.stringify(normalizeCodexAccounts(file), null, 1), { mode: 0o600 });
    this.cached = undefined;
  }

  readOnly(): boolean { return this.read().readOnly; }
  list(): CodexAccount[] { return this.read().file.accounts; }
  get(id: string): CodexAccount | undefined { return this.list().find((a) => a.id === id); }
  live(): CodexAccountsFile['live'] | null { return this.read().file.live ?? null; }
  snapshot(): CodexAccountsFile { return this.read().file; }

  setLive(live: CodexAccountsFile['live'] | null): void {
    this.change((f) => { if (live) f.live = live; else delete f.live; });
  }

  dirOf(id: string): string {
    if (!isCodexAccountId(id)) throw new Error('invalid account id');
    return join(this.root, 'profiles', id);
  }

  /** Creates the profile directory of a login in progress (Codex refuses a CODEX_HOME that does not exist); listed only after `commit`. */
  prepare(): { id: string; dir: string } {
    const id = randomUUID();
    const dir = this.dirOf(id);
    mkdirSync(dir, { recursive: true });
    return { id, dir };
  }

  commit(account: CodexAccount): void {
    this.change((f) => {
      const index = f.accounts.findIndex((entry) => entry.id === account.id);
      if (index >= 0) f.accounts[index] = account; else f.accounts.push(account);
    });
  }

  /** Sets the given fields; `undefined` removes one. */
  patch(id: string, patch: Partial<Omit<CodexAccount, 'id' | 'addedAt'>>): void {
    this.change((f) => {
      const account = f.accounts.find((entry) => entry.id === id);
      if (!account) return;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (account as unknown as Record<string, unknown>)[key];
        else (account as unknown as Record<string, unknown>)[key] = value;
      }
    });
  }

  updateIdentity(id: string, identity: CodexIdentity): void {
    this.patch(id, { email: identity.email, userId: identity.userId, accountId: identity.accountId });
  }

  /** Forgets the record and deletes its profile directory (the app created it; it is never a link to elsewhere). */
  remove(id: string): void {
    const dir = this.dirOf(id);
    if (this.get(id)) this.change((f) => { f.accounts = f.accounts.filter((a) => a.id !== id); if (f.live?.recordId === id) delete f.live.recordId; });
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* an orphaned dir is harmless and never listed */ }
  }
}
