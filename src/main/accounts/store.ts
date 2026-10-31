// src/main/accounts/store.ts
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { atomicWriteFileSync } from '../atomicWrite';
import { join } from 'path';
import {
  identityFields, isAccountId, type AccountCustody, type AppSwap, type AccountIdentity, type AccountNotice, type AccountNoticeKind,
  type LiveIdentity, type ManagedAccount, type TokenFamily,
} from '../../shared/accounts';
import { readJsonFile } from '../ssh/files';

const MAX_TEXT = 120;
const MAX_NOTICES = 20;
/** accounts.json format: 1 = 0.9.0 (records only), 2 = identities, roles, the live login and notices (0.9.1). */
export const STORE_VERSION = 2;
const CUSTODY: readonly string[] = ['app', 'live', 'foreign', 'quarantined'] satisfies AccountCustody[];
const NOTICE_KINDS: readonly string[] = ['switchedOut', 'loggedOut', 'adopted', 'migrated', 'quarantined'] satisfies AccountNoticeKind[];

interface StoreFile {
  version: number; claude: ManagedAccount[]; live?: LiveIdentity; notices: AccountNotice[];
  /** The file exists but could not be read, has the wrong shape or a newer version: nothing is ever written over it. */
  readOnly: boolean;
}

/** A write was refused because accounts.json could not be read safely (see `AccountsStore.readOnly`). */
export class AccountsReadOnlyError extends Error {
  constructor() { super('accounts.json cannot be read safely; not writing over it'); this.name = 'AccountsReadOnlyError'; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const short = (value: unknown): string | undefined => (typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined);

/** Identity fields within the length limit (a longer value is dropped, as 0.9.0 did for e-mail and organisation). */
function boundedIdentity(value: Record<string, unknown>): AccountIdentity {
  return identityFields({ email: short(value.email), org: short(value.org), accountUuid: short(value.accountUuid), organizationUuid: short(value.organizationUuid) });
}

function parseAccount(value: unknown): ManagedAccount | null {
  if (!isRecord(value) || !isAccountId(value.id)) return null;
  if (typeof value.addedAt !== 'number' || !Number.isFinite(value.addedAt)) return null;
  const account: ManagedAccount = { id: value.id, addedAt: value.addedAt, ...boundedIdentity(value) };
  if (typeof value.custody === 'string' && CUSTODY.includes(value.custody)) account.custody = value.custody as AccountCustody;
  if (value.family === 'own' || value.family === 'live') account.family = value.family as TokenFamily;
  if (isAccountId(value.duplicateOf)) account.duplicateOf = value.duplicateOf;
  if (typeof value.heldTokens === 'string' && /^[0-9a-f]{64}$/.test(value.heldTokens)) account.heldTokens = value.heldTokens;
  if (typeof value.deadTokens === 'string' && /^[0-9a-f]{64}$/.test(value.deadTokens)) account.deadTokens = value.deadTokens;
  const swap = parseAppSwap(value.appSwap);
  if (swap) account.appSwap = swap;
  return account;
}

function parseAppSwap(value: unknown): AppSwap | undefined {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined;
  const swap: AppSwap = { at: value.at };
  if (typeof value.from === 'string' && /^[0-9a-f]{64}$/.test(value.from)) swap.from = value.from;
  if (value.own === true) swap.own = true;
  return swap;
}

function parseLive(value: unknown): LiveIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const live: LiveIdentity = boundedIdentity(value);
  if (isAccountId(value.recordId)) live.recordId = value.recordId;
  return live;
}

function parseNotice(value: unknown): AccountNotice | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.id.length > 64) return null;
  if (typeof value.kind !== 'string' || !NOTICE_KINDS.includes(value.kind) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  const notice: AccountNotice = { id: value.id, kind: value.kind as AccountNoticeKind, at: value.at };
  const email = short(value.email);
  if (email) notice.email = email;
  if (isAccountId(value.recordId)) notice.recordId = value.recordId;
  if (Number.isInteger(value.count) && (value.count as number) >= 0) notice.count = value.count as number;
  return notice;
}

/**
 * Every Claude account the app knows, including the one signed in to Claude Code; each lives in `<root>/claude/<uuid>` and is
 * listed in `<root>/accounts.json` with the last seen live identity and pending notices. Never holds a token.
 */
export class AccountsStore {
  private readonly file: string;

  constructor(private readonly root: string) {
    this.file = join(root, 'accounts.json');
  }

  /**
   * Missing: empty and writable. Unparsable: moved to a timestamped `accounts.json.bak-<time>` (never over an earlier backup),
   * then empty and writable. Unreadable (locked, a directory), of the wrong shape or of a newer version: read-only, so the
   * records in it are never lost (the same rule as the SSH vault).
   */
  /**
   * The last successfully parsed file and the stat stamp it was read at: the usage polls ask several times per second, and
   * one stat is much cheaper than reading and parsing the file. Callers get a copy (they may edit it). Own writes drop it.
   */
  private cached?: { stamp: string; file: StoreFile };

  private read(): StoreFile {
    let stamp: string | undefined;
    try {
      const info = statSync(this.file);
      if (info.isFile()) stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
    } catch { /* missing: read() reports it */ }
    if (stamp && this.cached?.stamp === stamp) return structuredClone(this.cached.file);
    const parsed = { ok: false };
    const file = this.readFile(parsed);
    this.cached = stamp && parsed.ok ? { stamp, file: structuredClone(file) } : undefined;
    return file;
  }

  private readFile(parsedOk: { ok: boolean }): StoreFile {
    const empty = (readOnly: boolean): StoreFile => ({ version: 1, claude: [], notices: [], readOnly });
    const result = readJsonFile(this.file);
    if (!result.ok) return empty(!result.missing && existsSync(this.file));
    // From here the answer depends on the file's content only, so it may be reused while the file is unchanged.
    parsedOk.ok = true;
    const parsed = result.value;
    if (!isRecord(parsed) || !Array.isArray(parsed.claude)) return empty(true);
    if (parsed.version !== undefined && !(typeof parsed.version === 'number' && Number.isInteger(parsed.version) && parsed.version >= 1)) return empty(true);
    if (parsed.notices !== undefined && !Array.isArray(parsed.notices)) return empty(true);
    if (parsed.live !== undefined && !isRecord(parsed.live)) return empty(true);
    const version = typeof parsed.version === 'number' ? parsed.version : 1;
    const live = parseLive(parsed.live);
    return {
      version,
      claude: parsed.claude.map(parseAccount).filter((account): account is ManagedAccount => account !== null),
      ...(live ? { live } : {}),
      notices: Array.isArray(parsed.notices) ? parsed.notices.map(parseNotice).filter((n): n is AccountNotice => n !== null) : [],
      readOnly: version > STORE_VERSION,
    };
  }

  private change(edit: (file: StoreFile) => void): void {
    const file = this.read();
    if (file.readOnly) throw new AccountsReadOnlyError();
    edit(file);
    this.write(file);
  }

  /** accounts.json exists but cannot be read safely (unreadable, wrong shape, newer version): every write is refused. */
  readOnly(): boolean { return this.read().readOnly; }

  /** Every record, quarantined ones included (callers filter with `custodyOf`). */
  list(): ManagedAccount[] { return this.read().claude; }
  get(id: string): ManagedAccount | undefined { return this.list().find((a) => a.id === id); }
  version(): number { return this.read().version; }
  markMigrated(): void { this.change((f) => { f.version = STORE_VERSION; }); }
  live(): LiveIdentity | null { return this.read().live ?? null; }
  setLive(live: LiveIdentity | null): void {
    this.change((f) => { const parsed = live ? parseLive(live) : undefined; if (parsed) f.live = parsed; else delete f.live; });
  }
  notices(): AccountNotice[] { return this.read().notices; }
  addNotice(notice: Omit<AccountNotice, 'id'>): void {
    this.change((f) => { const parsed = parseNotice({ ...notice, id: randomUUID() }); if (parsed) f.notices = [...f.notices, parsed].slice(-MAX_NOTICES); });
  }
  dismissNotice(id: string): void { this.change((f) => { f.notices = f.notices.filter((n) => n.id !== id); }); }

  dirOf(id: string): string {
    if (!isAccountId(id)) throw new Error('invalid account id');
    return join(this.root, 'claude', id);
  }

  /** Creates the profile directory for a login in progress; the account is not listed until `commit`. */
  prepare(): { id: string; dir: string } {
    const id = randomUUID();
    const dir = this.dirOf(id);
    mkdirSync(dir, { recursive: true });
    return { id, dir };
  }

  commit(account: ManagedAccount): void {
    const clean = parseAccount(account);
    if (!clean) throw new Error('invalid account');
    this.change((f) => {
      const index = f.claude.findIndex((entry) => entry.id === clean.id);
      if (index >= 0) f.claude[index] = clean; else f.claude.push(clean);
    });
  }

  update(id: string, patch: Partial<Pick<ManagedAccount, 'email' | 'org'>>): void { this.patch(id, patch); }
  /**
   * Sets the identity fields that are given; an absent key stays, so a partial identity never erases a known uuid.
   * With `replace` the record takes exactly this identity: absent fields are removed (the login belongs to someone else).
   */
  updateIdentity(id: string, identity: AccountIdentity, options: { replace?: boolean } = {}): void {
    const given = identityFields(identity);
    if (!options.replace) { this.patch(id, { ...given }); return; }
    this.patch(id, { email: given.email, org: given.org, accountUuid: given.accountUuid, organizationUuid: given.organizationUuid });
  }
  setCustody(id: string, custody: AccountCustody, duplicateOf?: string): void {
    this.patch(id, { custody, duplicateOf: custody === 'quarantined' ? duplicateOf : undefined });
  }
  setFamily(id: string, family: TokenFamily): void { this.patch(id, { family }); }
  /** Sets or (undefined) drops `heldTokens`; a record without it is not written again. */
  setHeldTokens(id: string, hash: string | undefined): void {
    if (hash === undefined && !this.get(id)?.heldTokens) return;
    this.patch(id, { heldTokens: hash });
  }
  /** Sets or (undefined) drops `deadTokens`; a record without it is not written again. */
  setDeadTokens(id: string, hash: string | undefined): void {
    if (this.get(id)?.deadTokens === hash) return;
    this.patch(id, { deadTokens: hash });
  }
  /** Sets or (undefined) drops `appSwap`; a record without it is not written again. */
  setAppSwap(id: string, swap: AppSwap | undefined): void {
    if (swap === undefined && !this.get(id)?.appSwap) return;
    this.patch(id, { appSwap: swap });
  }

  remove(id: string): void {
    if (!isAccountId(id)) return;
    const file = this.read();
    if (file.readOnly) throw new AccountsReadOnlyError();
    rmSync(this.dirOf(id), { recursive: true, force: true });
    // Copies set aside for this record are released: no longer a copy of anything (still set aside, never renewed), so the
    // panel offers signing in again or removing them, never a "Delete copy" that would drop the account's last saved copy.
    const released = new Set(file.claude.filter((entry) => entry.duplicateOf === id).map((entry) => entry.id));
    const claude = file.claude.filter((entry) => entry.id !== id).map((entry) => {
      if (!released.has(entry.id)) return entry;
      const { duplicateOf: _drop, ...rest } = entry;
      return rest;
    });
    const notices = file.notices.filter((n) => n.recordId !== id && !(n.kind === 'quarantined' && n.recordId && released.has(n.recordId)));
    let live = file.live;
    if (live?.recordId === id) { const { recordId: _drop, ...rest } = live; live = rest; }
    if (claude.length === file.claude.length && !released.size && notices.length === file.notices.length && live === file.live) return;
    this.write({ version: file.version, claude, notices, readOnly: false, ...(live ? { live } : {}) });
  }

  /** `undefined` in the patch removes the field; the record is validated again, so a bad value never reaches the file. */
  private patch(id: string, fields: Record<string, unknown>): void {
    this.change((f) => {
      const index = f.claude.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const next: Record<string, unknown> = { ...f.claude[index] };
      for (const [key, value] of Object.entries(fields)) { if (value === undefined) delete next[key]; else next[key] = value; }
      const clean = parseAccount(next);
      if (clean) f.claude[index] = clean;
    });
  }

  private write(file: StoreFile): void {
    this.cached = undefined;
    mkdirSync(this.root, { recursive: true });
    const body = { version: file.version, claude: file.claude, ...(file.live ? { live: file.live } : {}), ...(file.notices.length ? { notices: file.notices } : {}) };
    atomicWriteFileSync(this.file, JSON.stringify(body, null, 2));
  }}
