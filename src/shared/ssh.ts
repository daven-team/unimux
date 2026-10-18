// The SSH model shared by main, the Pty Host and the renderer (spec 5): types, limits and pure helpers.
// No Node or DOM imports: this file is compiled for both sides.
import { fuzzyFilter } from './fuzzy';
import type { MessageKey, MessageParams } from './i18n';
import { terminalModeReset } from './termReset';
import type { PresetCell, Tab } from './types';

export const SSH_LIMITS = {
  startup: 8 * 1024, broadcast: 64 * 1024, privateKey: 64 * 1024, password: 1024, passphrase: 1024,
  label: 80, address: 253, username: 64, group: 60, tag: 24, tags: 8, serverText: 2048, hosts: 500, history: 20,
} as const;

export interface SshHost {
  id: string;
  label: string;
  address: string;
  port: number;
  username: string;
  group?: string;
  tags?: string[];
  keyId?: string;
  startupCommand?: string;
  color?: string;
  /** Cells of this host connect by themselves when their view first mounts after the app starts (stored only when on). */
  reconnectOnStart?: true;
  createdAt: number;
  updatedAt: number;
  // Reserved for later releases, never written now: agent, via, proxy, env, mosh, charset.
}

export interface SshCellRef { hostId: string }

export type SshKeyType = 'ed25519' | 'ecdsa' | 'rsa';
export type SshKeyAlgo = 'ssh-ed25519' | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384' | 'ecdsa-sha2-nistp521' | 'ssh-rsa';
/** Every key algorithm the vault stores (the one list main and the Pty Host check against). */
export const KEY_ALGOS: readonly SshKeyAlgo[] = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];
export const KEY_SIZES: Record<SshKeyType, readonly number[]> = { ed25519: [256], ecdsa: [256, 384, 521], rsa: [3072, 4096, 2048] };
export const DEFAULT_KEY_BITS: Record<SshKeyType, number> = { ed25519: 256, ecdsa: 256, rsa: 3072 };

export interface SshKeyInfo {
  id: string;
  label: string;
  type: SshKeyAlgo;
  bits: number;
  fingerprint: string;
  publicKey: string;
  comment: string;
  encrypted: boolean;
  passphraseSaved: boolean;
  certificate?: string;
  source: 'generated' | 'imported';
  ephemeral: boolean;
  locked: boolean;
  createdAt: number;
}

export interface SshVaultInfo {
  storage: 'dpapi' | 'keychain' | 'unavailable';
  keys: SshKeyInfo[];
  savedPasswords: string[];
  lockedPasswords: string[];
  /** The vault file comes from a newer app version: nothing can be changed. */
  readOnly: boolean;
}

export type SshPhase = 'idle' | 'connecting' | 'verifying' | 'authenticating' | 'connected' | 'closed' | 'error';
export const LIVE_PHASES: readonly SshPhase[] = ['connecting', 'verifying', 'authenticating', 'connected'];
export const isLivePhase = (phase: SshPhase | undefined): boolean => !!phase && LIVE_PHASES.includes(phase);

export type SshErrorCode = 'dns' | 'refused' | 'timeout' | 'unreachable' | 'reset' | 'protocol' | 'auth' | 'hostKeyRejected'
  | 'hostKeyChanged' | 'passphrase' | 'keyLocked' | 'keyMissing' | 'hostMissing' | 'shellDenied' | 'ptyHostCrashed' | 'cancelled' | 'unknown';

export interface SshSessionState {
  cellId: string;
  hostId: string;
  phase: SshPhase;
  since: number;
  error?: SshErrorCode;
  exitCode?: number;
  serverBanner?: string;
}

export type SshPrompt =
  | { id: string; kind: 'passphrase'; keyId: string; keyLabel: string; retry: boolean }
  | { id: string; kind: 'password'; user: string; endpoint: string; canSave: boolean; retry: boolean }
  | { id: string; kind: 'keyboard'; endpoint: string; name: string; instructions: string; fields: Array<{ text: string; echo: boolean }> }
  | { id: string; kind: 'hostKey'; endpoint: string; keyType: string; fingerprint: string; reason: 'unknown' | 'newType' | 'changed'; knownFingerprints: string[]; knownTypes: string[] };

export type SshPromptAnswer =
  | { cellId: string; promptId: string; cancel: true }
  | { cellId: string; promptId: string; values: string[]; remember?: boolean }
  | { cellId: string; promptId: string; hostKey: 'once' | 'save' | 'replace' };

/** What a (reloaded) renderer asks for: every session state and the prompts that are still open (R7). */
export interface SshSessionsSnapshot { sessions: SshSessionState[]; prompts: Array<{ cellId: string; prompt: SshPrompt }> }

export interface KnownHostInfo { id: string; display: string; keyType: string; fingerprint: string; addedAt: number }

/** Where the two SSH files live and whether either one opened read-only (unreadable, wrong shape, malformed entry or a newer format). */
export interface SshStorageStatus { vaultFile: string; vaultReadOnly: boolean; knownHostsFile: string; knownHostsReadOnly: boolean }

export type DraftError = 'tooLarge' | 'notAKey' | 'publicOnly' | 'ppkV3' | 'unsupportedType' | 'badPassphrase' | 'mismatch' | 'certMismatch' | 'readFailed' | 'invalid';
export type DraftResult =
  | { ok: true; draftId: string; type?: SshKeyAlgo; bits?: number; fingerprint?: string; comment: string; encrypted: boolean; needsPassphrase: boolean; publicKey?: string; certificateWarning?: boolean; duplicateOf?: string }
  | { ok: false; error: DraftError };
export type KeyError = DraftError | 'notFound' | 'readOnly' | 'failed';
export type KeyResult = { ok: true; key: SshKeyInfo; duplicate?: boolean } | { ok: false; error: KeyError };
export interface GenerateKeyRequest { label: string; type: SshKeyType; bits?: number; comment?: string; passphrase?: string; savePassphrase: boolean }
export interface UpdateKeyRequest { id: string; label?: string; certificate?: string | null; passphrase?: { save: string } | { forget: true } }
/** "Zastąp klucz prywatny": new private key text for a stored key (its id, label and hosts stay). */
export interface ReplaceKeyRequest { id: string; privateKey: string; passphrase?: string; savePassphrase: boolean }
export type ReplaceKeyError = KeyError | 'needsPassphrase' | 'duplicate';
export type ReplaceKeyResult = { ok: true; key: SshKeyInfo; publicKeyChanged: boolean; certificateRemoved: boolean } | { ok: false; error: ReplaceKeyError };
/** "Pokaż klucz prywatny": the stored text (still encrypted when it has a passphrase). The only IPC answer that carries private key text. */
export type RevealKeyResult = { ok: true; privateKey: string } | { ok: false; error: 'notFound' | 'locked' };
export interface SshConnectCellRequest { cellId: string; hostId: string; cols: number; rows: number }

/** `window.mc.ssh` (src/preload). Every call is validated in src/main/ssh/ipc.ts. */
export interface SshApi {
  vaultInfo(): Promise<SshVaultInfo>;
  generateKey(req: GenerateKeyRequest): Promise<KeyResult>;
  pickKeyFile(): Promise<DraftResult | { ok: false; error: 'cancelled' }>;
  draftFromFile(path: string): Promise<DraftResult>;
  draftFromText(req: { privateKey: string; publicKey?: string; certificate?: string }): Promise<DraftResult>;
  unlockDraft(draftId: string, passphrase: string): Promise<DraftResult>;
  commitDraft(req: { draftId: string; label: string; savePassphrase: boolean }): Promise<KeyResult>;
  discardDraft(draftId: string): void;
  updateKey(req: UpdateKeyRequest): Promise<KeyResult>;
  removeKey(id: string): Promise<{ ok: boolean }>;
  exportPrivateKey(id: string): Promise<{ ok: true } | { ok: false; error: 'cancelled' | 'locked' | 'notFound' | 'failed' }>;
  revealPrivateKey(id: string): Promise<RevealKeyResult>;
  replacePrivateKey(req: ReplaceKeyRequest): Promise<ReplaceKeyResult>;
  setPassword(hostId: string, password: string): Promise<{ ok: true; ephemeral: boolean } | { ok: false; error: 'notFound' | 'invalid' | 'readOnly' | 'failed' }>;
  clearPassword(hostId: string): Promise<{ ok: boolean }>;
  forgetPassphrases(): Promise<{ ok: boolean }>;
  storageStatus(): Promise<SshStorageStatus>;
  knownHosts(): Promise<KnownHostInfo[]>;
  removeKnownHost(id: string): Promise<{ ok: boolean }>;
  connect(req: SshConnectCellRequest): Promise<{ ok: true } | { ok: false; error: SshErrorCode }>;
  sessions(): Promise<SshSessionsSnapshot>;
  answer(answer: SshPromptAnswer): Promise<{ ok: boolean }>;
}

export interface Localized { key: MessageKey; params?: MessageParams }

// ── validation ───────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const stamp = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** Lower-cased, without the brackets of an IPv6 literal. */
export function normalizeAddress(raw: string): string {
  const trimmed = raw.trim();
  return (/^\[(.*)\]$/.exec(trimmed)?.[1] ?? trimmed).toLowerCase();
}

export function addressProblem(address: string): 'empty' | 'invalid' | 'hasPort' | null {
  if (!address) return 'empty';
  if (address.length > SSH_LIMITS.address || /\s/.test(address) || CONTROL.test(address) || address.startsWith('-')) return 'invalid';
  if (/^[^:]+:\d+$/.test(address)) return 'hasPort';
  if (address.includes(':')) return (address.match(/:/g)?.length ?? 0) >= 2 && /^[0-9a-f:.]+(%[\w.-]+)?$/.test(address) ? null : 'invalid';
  return /^[a-z0-9._-]+$/.test(address) ? null : 'invalid';
}

export const isValidUsername = (user: string): boolean => user.length >= 1 && user.length <= SSH_LIMITS.username && !/\s/.test(user) && !CONTROL.test(user);

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const tag = value.trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag || tag.length > SSH_LIMITS.tag || CONTROL.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === SSH_LIMITS.tags) break;
  }
  return out;
}

/** TAB, LF and CR are allowed; every other C0 control (ESC included) and DEL is refused. */
export function startupProblem(text: string): 'tooLong' | 'control' | null {
  if (text.length > SSH_LIMITS.startup) return 'tooLong';
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? 'control' : null;
}

/** What the Pty Host types after login (spec 6.1 step 6): one write, lines joined by CR, ending with CR; null = nothing to type. */
export function startupInput(text: string | undefined): string | null {
  if (!text || startupProblem(text)) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.length ? `${lines.join('\r')}\r` : null;
}

export function normalizeSshHost(raw: unknown): SshHost | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isUuid(r.id) || typeof r.address !== 'string' || typeof r.username !== 'string') return null;
  const address = normalizeAddress(r.address);
  const username = r.username.trim();
  if (addressProblem(address) || !isValidUsername(username)) return null;
  const label = typeof r.label === 'string' && r.label.trim() && !CONTROL.test(r.label) ? clip(r.label.trim(), SSH_LIMITS.label) : address;
  const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : 22;
  const host: SshHost = { id: r.id, label, address, port, username, createdAt: stamp(r.createdAt), updatedAt: stamp(r.updatedAt) };
  const group = typeof r.group === 'string' ? clip(r.group.trim(), SSH_LIMITS.group) : '';
  if (group && !CONTROL.test(group)) host.group = group;
  const tags = normalizeTags(r.tags);
  if (tags.length) host.tags = tags;
  if (isUuid(r.keyId)) host.keyId = r.keyId;
  if (typeof r.startupCommand === 'string' && r.startupCommand.trim() && !startupProblem(r.startupCommand)) host.startupCommand = r.startupCommand;
  if (typeof r.color === 'string' && HEX_COLOR.test(r.color)) host.color = r.color;
  if (r.reconnectOnStart === true) host.reconnectOnStart = true;
  return host;
}

export function normalizeSshHosts(raw: unknown): SshHost[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SshHost[] = [];
  for (const entry of raw) {
    const host = normalizeSshHost(entry);
    if (!host || seen.has(host.id)) continue;
    seen.add(host.id);
    out.push(host);
    if (out.length >= SSH_LIMITS.hosts) break;
  }
  return out;
}

export interface SshHostDraft { label: string; address: string; port: string; username: string; group: string; tags: string[]; keyId?: string; startupCommand: string; color?: string; reconnectOnStart: boolean }
export type HostDraftField = 'address' | 'port' | 'username' | 'startupCommand';
export type HostDraftResult =
  | { ok: true; value: Omit<SshHost, 'id' | 'createdAt' | 'updatedAt'> }
  | { ok: false; errors: Partial<Record<HostDraftField, MessageKey>> };

export function validateHostDraft(d: SshHostDraft): HostDraftResult {
  const errors: Partial<Record<HostDraftField, MessageKey>> = {};
  const address = normalizeAddress(d.address);
  const problem = addressProblem(address);
  if (problem) errors.address = problem === 'empty' ? 'Podaj adres hosta' : problem === 'hasPort' ? 'Port wpisz w polu Port' : 'Nieprawidłowy adres hosta';
  const portText = d.port.trim();
  const port = portText === '' ? 22 : Number(portText);
  if (!/^\d*$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Nieprawidłowy port';
  const username = d.username.trim();
  if (!isValidUsername(username)) errors.username = 'Podaj nazwę użytkownika';
  const startup = startupProblem(d.startupCommand);
  if (startup) errors.startupCommand = startup === 'tooLong' ? 'Polecenie startowe jest za długie' : 'Polecenie zawiera znaki sterujące';
  if (Object.keys(errors).length) return { ok: false, errors };
  const value: Omit<SshHost, 'id' | 'createdAt' | 'updatedAt'> = { label: clip(d.label.trim(), SSH_LIMITS.label) || address, address, port, username };
  const group = clip(d.group.trim(), SSH_LIMITS.group);
  if (group) value.group = group;
  const tags = normalizeTags(d.tags);
  if (tags.length) value.tags = tags;
  if (d.keyId) value.keyId = d.keyId;
  if (d.startupCommand.trim()) value.startupCommand = d.startupCommand;
  if (d.color && HEX_COLOR.test(d.color)) value.color = d.color;
  if (d.reconnectOnStart) value.reconnectOnStart = true;
  return { ok: true, value };
}

export function hostToDraft(h?: SshHost): SshHostDraft {
  return {
    label: h?.label ?? '', address: h?.address ?? '', port: h ? String(h.port) : '22', username: h?.username ?? '',
    group: h?.group ?? '', tags: h?.tags ?? [], keyId: h?.keyId, startupCommand: h?.startupCommand ?? '', color: h?.color,
    reconnectOnStart: h?.reconnectOnStart === true,
  };
}

/**
 * The host form would change the saved host on Zapisz (compared as it would be saved, so a label left empty or a port without
 * leading zeros is not a change), a new host form has anything in it, or a tag or password is typed but not added.
 */
export function hostFormDirty(host: SshHost | undefined, draft: SshHostDraft, typed: { tag: string; password: string }): boolean {
  if (typed.tag.trim() || typed.password) return true;
  const key = (d: SshHostDraft) => JSON.stringify([d.label.trim(), d.address.trim(), d.port.trim(), d.username.trim(), d.group.trim(), d.tags, d.keyId ?? '', d.startupCommand, d.color ?? '', d.reconnectOnStart]);
  if (!host) return key(draft) !== key(hostToDraft(undefined));
  const v = validateHostDraft(draft);
  if (!v.ok) return key(draft) !== key(hostToDraft(host));
  return key(hostToDraft({ id: host.id, createdAt: host.createdAt, updatedAt: host.updatedAt, ...v.value })) !== key(hostToDraft(host));
}

/** Anything typed into a form field, or an import draft waiting to be stored, counts as unsaved. */
export const formDirty = (fields: ReadonlyArray<string | null | undefined | false>): boolean => fields.some((f) => typeof f === 'string' && f.trim().length > 0);

// ── endpoints, search, groups ────────────────────────────────────────────────

/** The address as shown and as typed by OpenSSH users: `host`, `host:2222`, `::1`, `[::1]:2222`. */
export function hostEndpoint(address: string, port: number): string {
  if (port === 22) return address;
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}

/** Key of the known-hosts store and its display form (OpenSSH convention). */
export const knownHostId = (host: string, port: number): string => (port === 22 ? host : `[${host}]:${port}`);

export const userAtEndpoint = (h: Pick<SshHost, 'username' | 'address' | 'port'>): string => `${h.username}@${hostEndpoint(h.address, h.port)}`;

const searchText = (h: SshHost) => [h.label, h.address, h.username, h.group ?? '', ...(h.tags ?? [])].join(' ');
export const filterHosts = (hosts: readonly SshHost[], query: string): SshHost[] => fuzzyFilter([...hosts], query, searchText, Math.max(1, hosts.length));

export interface HostGroup { name: string | null; hosts: SshHost[] }
/** Named groups alphabetically, hosts without a group ("Bez grupy") last; hosts by label unless `sortByLabel` is false (search order). */
export function groupHosts(hosts: readonly SshHost[], sortByLabel = true): HostGroup[] {
  const map = new Map<string | null, SshHost[]>();
  for (const h of hosts) map.set(h.group ?? null, [...(map.get(h.group ?? null) ?? []), h]);
  const order = (list: SshHost[]) => (sortByLabel ? [...list].sort((a, b) => a.label.localeCompare(b.label)) : list);
  const named = [...map.keys()].filter((k): k is string => k !== null).sort((a, b) => a.localeCompare(b));
  const groups: HostGroup[] = named.map((name) => ({ name, hosts: order(map.get(name)!) }));
  if (map.has(null)) groups.push({ name: null, hosts: order(map.get(null)!) });
  return groups;
}

/** A grid opened from several hosts is named after their shared group, otherwise by how many hosts it has. */
export function sshGridName(hosts: readonly SshHost[]): { group: string } | { count: number } {
  const groups = new Set(hosts.map((h) => h.group ?? ''));
  const [only] = [...groups];
  return groups.size === 1 && only ? { group: only } : { count: hosts.length };
}

export const toggleSelection = (list: readonly string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** The selected host ids that still belong to a saved host (a deleted host must not inflate the grid count). */
export const existingSelection = (selected: readonly string[], hosts: readonly Pick<SshHost, 'id'>[]): string[] => {
  const ids = new Set(hosts.map((h) => h.id));
  return selected.filter((id) => ids.has(id));
};

/** The value of a grid dialog cell select: a profile id, or `ssh:<hostId>` for a saved host (spec 10.4). */
export const cellSourceValue = (cell: { profileId: string; sshHostId?: string }): string => (cell.sshHostId ? `ssh:${cell.sshHostId}` : cell.profileId);

export function parseCellSource(value: string): { kind: 'ssh'; hostId: string } | { kind: 'profile'; profileId: string } {
  return value.startsWith('ssh:') && value.length > 4 ? { kind: 'ssh', hostId: value.slice(4) } : { kind: 'profile', profileId: value };
}

/**
 * The New grid dialog's source choice for one cell (M4). Choosing a host never copies its label into the name: the cell header
 * already shows the label and follows renames. A name that only echoed the previous host's label goes away; a typed one stays.
 */
export function cellSourcePatch(value: string, previous: PresetCell | undefined, hosts: readonly Pick<SshHost, 'id' | 'label'>[], shellProfileId: string): Partial<PresetCell> {
  const source = parseCellSource(value);
  const previousHost = previous?.sshHostId ? hosts.find((h) => h.id === previous.sshHostId) : undefined;
  const clearedName = previousHost && previous?.name === previousHost.label ? { name: undefined } : {};
  if (source.kind === 'profile') return { profileId: source.profileId, sshHostId: undefined, ...clearedName };
  return { profileId: shellProfileId, sshHostId: source.hostId, role: undefined, prompt: undefined, worktree: false, ...clearedName };
}

/** The name an SSH cell gets from a grid spec (M4): one that only repeats the host label (older presets) is left out. */
export const sshSpecName = (name: string | undefined, host: Pick<SshHost, 'label'> | undefined): string | undefined =>
  host && name?.trim() === host.label ? undefined : name;

/** The folded group names kept in localStorage (`''` is "Bez grupy"); anything unexpected reads as none. */
export function parseFoldedGroups(raw: string | null): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 200) : [];
  } catch { return []; }
}

// ── session texts ────────────────────────────────────────────────────────────

export function sshErrorText(code: SshErrorCode, ctx: { host: string; endpoint: string }): Localized {
  switch (code) {
    case 'dns': return { key: 'Nie znaleziono hosta {host}', params: { host: ctx.host } };
    case 'refused': return { key: 'Połączenie odrzucone ({endpoint})', params: { endpoint: ctx.endpoint } };
    case 'timeout': return { key: 'Przekroczono czas połączenia' };
    case 'unreachable': return { key: 'Host jest nieosiągalny' };
    case 'reset': return { key: 'Połączenie zostało przerwane' };
    case 'protocol': return { key: 'Nie udało się uzgodnić szyfrowania z serwerem' };
    case 'auth': return { key: 'Logowanie nie powiodło się - sprawdź użytkownika, klucz lub hasło' };
    case 'hostKeyRejected': return { key: 'Klucz hosta odrzucony' };
    case 'hostKeyChanged': return { key: 'Połączenie przerwane: klucz hosta się zmienił' };
    case 'passphrase': return { key: 'Nieprawidłowe hasło klucza' };
    case 'keyLocked': return { key: 'Nie można odczytać klucza na tym komputerze' };
    case 'keyMissing': return { key: 'Klucz przypisany do hosta nie istnieje' };
    case 'hostMissing': return { key: 'Ten host został usunięty' };
    case 'shellDenied': return { key: 'Serwer nie otworzył powłoki' };
    case 'ptyHostCrashed': return { key: 'Proces terminali został uruchomiony ponownie' };
    case 'cancelled': return { key: 'Anulowano' };
    default: return { key: 'Nieznany błąd SSH' };
  }
}

/** The short text next to the cell name (spec 6.3); null when connected or idle. */
export function sshPhaseLabel(state: SshSessionState | undefined, prompt?: SshPrompt, ctx = { host: '', endpoint: '' }): Localized | null {
  if (prompt) return prompt.kind === 'hostKey' ? { key: 'weryfikacja klucza hosta' } : { key: 'czeka na hasło' };
  switch (state?.phase) {
    case 'connecting': return { key: 'łączenie…' };
    case 'verifying': return { key: 'weryfikacja klucza hosta' };
    case 'authenticating': return { key: 'logowanie…' };
    case 'closed': return { key: 'rozłączono' };
    case 'error': return sshErrorText(state.error ?? 'unknown', ctx);
    default: return null;
  }
}

export type SshNotice =
  | { key: '[SSH · łączenie z {endpoint}]'; params: { endpoint: string } }
  | { key: '[SSH · połączono]' }
  | { key: '[SSH · rozłączono]' }
  | { key: '[SSH · błąd: {reason}]'; reason: Localized };

/** The dim line the renderer writes into the terminal when a session changes phase (not part of the replay). */
export function sshNotice(prev: SshPhase | undefined, next: SshSessionState, ctx: { host: string; endpoint: string }): SshNotice | null {
  if (prev === next.phase) return null;
  switch (next.phase) {
    case 'connected': return { key: '[SSH · połączono]' };
    case 'closed': return { key: '[SSH · rozłączono]' };
    case 'error': return { key: '[SSH · błąd: {reason}]', reason: sshErrorText(next.error ?? 'unknown', ctx) };
    default: return null;
  }
}

/**
 * The "connecting" line is written by the renderer right before it sends the connect request: session events come over
 * IPC and terminal data over the Pty Host port, so an event-driven line could land after the server greeting (W4).
 */
export function connectingNotice(ctx: { host: string; endpoint: string }): Extract<SshNotice, { key: '[SSH · łączenie z {endpoint}]' }> {
  return { key: '[SSH · łączenie z {endpoint}]', params: { endpoint: ctx.endpoint } };
}

/**
 * I2: what a remote TUI (vim, htop) switched on - mouse tracking, application cursor keys, bracketed paste, the alternate
 * screen - must not leak into the next session. Written when a session ends and before a reconnect; never ConPTY.
 */
export const sshModeReset = (inAlternateScreen: boolean): string => terminalModeReset(inAlternateScreen, false);

/** A live session just ended (closed, error, network drop): the terminal modes are reset before the notice line. */
export const sshSessionEnded = (prev: SshPhase | undefined, next: SshPhase): boolean => isLivePhase(prev) && !isLivePhase(next);

/** M3: the pre-auth banner shown in the cell card while connecting, verifying or authenticating (spec 5); null otherwise. */
export function connectingBanner(session: Pick<SshSessionState, 'phase' | 'serverBanner'> | undefined): string | null {
  if (!session?.serverBanner || !['connecting', 'verifying', 'authenticating'].includes(session.phase)) return null;
  return sanitizeServerText(session.serverBanner) || null;
}

/** D1: a cell that was running when the Pty Host crashed; only Claude and Codex cells resume a conversation (SSH cells never do, D5). */
export const resumesConversation = (cells: ReadonlyArray<{ ssh: boolean; cli: string } | undefined>): boolean =>
  cells.some((c) => !!c && !c.ssh && (c.cli === 'claude' || c.cli === 'codex'));

/** D1: the toast after a Pty Host restart. */
export const ptyHostRestartToast = (resumes: boolean): MessageKey =>
  resumes ? 'Proces terminali się zrestartował, wznawiam rozmowy' : 'Proces terminali się zrestartował';

export interface BroadcastCell { cellId: string; label: string; endpoint: string }
export interface BroadcastRow extends BroadcastCell { enabled: boolean; checked: boolean; reason?: MessageKey }

export function broadcastTargets(
  cells: readonly BroadcastCell[],
  sessions: Readonly<Record<string, SshSessionState | undefined>>,
  prompts: Readonly<Record<string, SshPrompt | undefined>>,
): BroadcastRow[] {
  return cells.map((cell) => {
    const phase = sessions[cell.cellId]?.phase;
    if (prompts[cell.cellId]) return { ...cell, enabled: false, checked: false, reason: 'czeka na hasło' };
    if (phase === 'connected') return { ...cell, enabled: true, checked: true };
    if (isLivePhase(phase)) return { ...cell, enabled: false, checked: false, reason: 'łączenie…' };
    return { ...cell, enabled: false, checked: false, reason: 'rozłączono' };
  });
}

/** TAB, LF and CR are allowed; every other C0 control (Ctrl-C, Ctrl-D, ESC...) and DEL is refused, like the startup command: one paste must not hit every host with a signal. */
export function broadcastProblem(text: string): MessageKey | null {
  if (text.length > SSH_LIMITS.broadcast) return 'Polecenie jest za długie';
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? 'Polecenie zawiera znaki sterujące' : null;
}

export type BroadcastResult = 'sent' | 'skipped';

/** What the dialog writes: every checked cell that is still connected right now gets the text (and Enter when `enter`); the others are skipped. */
export function broadcastSend(
  checkedCellIds: readonly string[],
  sessions: Readonly<Record<string, SshSessionState | undefined>>,
  text: string,
  enter: boolean,
  paste: (cellId: string, text: string, submit: boolean) => void,
): Record<string, BroadcastResult> {
  const results: Record<string, BroadcastResult> = {};
  for (const cellId of checkedCellIds) {
    if (sessions[cellId]?.phase !== 'connected') { results[cellId] = 'skipped'; continue; }
    paste(cellId, text, enter);
    results[cellId] = 'sent';
  }
  return results;
}

/** The state text of a dialog row: a "sent" result only counts while the cell is still connected, otherwise the row's own reason shows. */
export function broadcastRowState(row: Pick<BroadcastRow, 'enabled' | 'reason'>, result: BroadcastResult | undefined): MessageKey | null {
  if (result === 'skipped') return 'pominięto: rozłączono';
  if (result === 'sent' && row.enabled) return 'wysłano';
  return row.reason ?? null;
}

/** A broadcast result with the session it was sent to (D2). */
export interface StampedBroadcastResult { result: BroadcastResult; phase?: SshPhase; since?: number }

export function stampBroadcastResults(results: Readonly<Record<string, BroadcastResult>>, sessions: Readonly<Record<string, SshSessionState | undefined>>): Record<string, StampedBroadcastResult> {
  return Object.fromEntries(Object.entries(results).map(([cellId, result]) => [cellId, { result, phase: sessions[cellId]?.phase, since: sessions[cellId]?.since }]));
}

/** D2: a row shows its result only while its session is still the one it was sent to; any phase change (a reconnect) clears it. */
export function currentBroadcastResult(stamped: StampedBroadcastResult | undefined, session: SshSessionState | undefined): BroadcastResult | undefined {
  if (!stamped) return undefined;
  return session?.phase === stamped.phase && session?.since === stamped.since ? stamped.result : undefined;
}

/** Newest last, no consecutive duplicate, at most `max` entries; blank text changes nothing. */
export function pushHistory(list: readonly string[], text: string, max: number = SSH_LIMITS.history): string[] {
  if (!text.trim()) return list as string[];
  if (list[list.length - 1] === text) return [...list];
  return [...list, text].slice(-max);
}

/** The SSH cells of a grid as broadcast targets: a custom cell name wins over the host label. */
export function sshCellsOfTab(tab: Tab, hosts: readonly SshHost[]): BroadcastCell[] {
  return tab.cells.flatMap((cell) => {
    if (!cell.ssh) return [];
    const host = hosts.find((h) => h.id === cell.ssh!.hostId);
    return [{ cellId: cell.id, label: cell.name ?? host?.label ?? cell.id.slice(0, 8), endpoint: host ? userAtEndpoint(host) : '' }];
  });
}

/** Server-provided text (banner, keyboard-interactive name, instructions, prompts) as plain, short text. */
export function sanitizeServerText(text: unknown, max: number = SSH_LIMITS.serverText): string {
  if (typeof text !== 'string') return '';
  const cleaned = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

// ── renderer helpers ─────────────────────────────────────────────────────────

/** A cell is an SSH session by its ssh ref alone, whatever its profile says (R5). */
export const isSshCell = (cell: { ssh?: SshCellRef }): boolean => !!cell.ssh;

export function applySshSnapshot(snapshot: SshSessionsSnapshot): { sessions: Record<string, SshSessionState>; prompts: Record<string, SshPrompt> } {
  return {
    sessions: Object.fromEntries(snapshot.sessions.map((s) => [s.cellId, s])),
    prompts: Object.fromEntries(snapshot.prompts.map((p) => [p.cellId, p.prompt])),
  };
}

/** A new prompt for a cell the user cannot see right now is announced with a toast (Review Focus 3). */
export const promptNeedsToast = (input: { visible: boolean; previousId?: string; nextId: string }): boolean => !input.visible && input.previousId !== input.nextId;

/** Prompts found in the snapshot after a renderer reload: the cells whose prompt is announced like a new one. */
export const restoredPromptToasts = (prompts: Readonly<Record<string, SshPrompt>>, visible: (cellId: string) => boolean): string[] =>
  Object.entries(prompts).filter(([cellId, prompt]) => promptNeedsToast({ visible: visible(cellId), nextId: prompt.id })).map(([cellId]) => cellId);

/**
 * The user can see the cell: it is in the active tab, no settings page, editor or file covers the grid, and no other
 * cell of the tab is maximized (`maximizedCellId` only counts when that cell is in the active tab).
 */
export const sshCellVisible = (v: { inActiveTab: boolean; covered: boolean; maximizedCellId: string | null; cellId: string }): boolean =>
  v.inActiveTab && !v.covered && (!v.maximizedCellId || v.maximizedCellId === v.cellId);

/** The header of an SSH cell: the chip always names the host; a cell name shows next to it only when the user gave one. */
export const sshHeaderName = (name: string | undefined): string | null => (name?.trim() ? name : null);

/** Enter submits a sign-in prompt only from its text fields; buttons and checkboxes handle Enter themselves. */
export const enterSubmitsPrompt = (target: { tagName: string; type?: string }): boolean =>
  target.tagName === 'INPUT' && (target.type === 'text' || target.type === 'password');

/** What a freshly mounted SSH cell does (spec 6.1 step 2). */
export interface SshCellStartInput {
  /** The session survived a renderer reload (main reported the cell alive). */
  alive: boolean;
  /** The user created the cell in this renderer session. */
  connectOnMount: boolean;
  /** The cell was in the state when this app run's first renderer load booted, and no Pty Host restart came since. */
  appStart?: boolean;
  /** The cell's host has "Łącz ponownie po uruchomieniu aplikacji" on. */
  reconnectOnStart?: boolean;
  /** The start comes from the cell view mounting (not the background loader or automation). */
  mounted?: boolean;
  /** The session phase the renderer already knows for the cell ("Połącz ponownie wszystkie SSH" may have connected it). */
  phase?: SshPhase;
}

/**
 * D5 with one opt-in exception: a cell connects by itself only when the user just created it, or when the app has just
 * started, the host asks for it and the cell view mounts (hidden tabs connect when opened). A renderer reload or a Pty Host
 * restart is not an app start.
 */
export type SshStartDecision = 'attach' | 'connect' | 'idle';

export function sshCellStart(input: SshCellStartInput): SshStartDecision {
  if (input.alive || isLivePhase(input.phase)) return 'attach';
  if (input.connectOnMount) return 'connect';
  const untouched = input.phase === undefined || input.phase === 'idle';
  return input.appStart && input.reconnectOnStart && input.mounted && untouched ? 'connect' : 'idle';
}

/**
 * What a start of an SSH cell leaves behind: the app-start mark is spent only by the mounted cell view, and a start from
 * elsewhere (boot restore of a task, automation, a path drop) that ends idle does not count as started, so the later mount
 * decides again.
 */
export function sshStartEffects(mounted: boolean, decision: SshStartDecision): { spendMark: boolean; keepStarted: boolean } {
  return { spendMark: mounted, keepStarted: mounted || decision !== 'idle' };
}

/** SSH cells (any project and tab) whose host has the reconnect option on: the candidates of the first renderer load. */
export function reconnectAtStartCells(projects: ReadonlyArray<{ tabs: ReadonlyArray<{ cells: ReadonlyArray<{ id: string; ssh?: SshCellRef }> }> }>, hosts: readonly SshHost[]): string[] {
  const on = new Set(hosts.filter((h) => h.reconnectOnStart).map((h) => h.id));
  return projects.flatMap((p) => p.tabs.flatMap((t) => t.cells.filter((c) => c.ssh && on.has(c.ssh.hostId)).map((c) => c.id)));
}

/**
 * The cells "Połącz ponownie wszystkie SSH" connects in a tab: SSH cells whose session is idle, ended or failed (or not
 * started yet), with a host that still exists; connecting and connected ones are never touched. At most a grid's 20 cells.
 */
export function reconnectAllTargets(
  cells: ReadonlyArray<{ id: string; ssh?: SshCellRef }>,
  sessions: Readonly<Record<string, Pick<SshSessionState, 'phase'> | undefined>>,
  hostIds: ReadonlySet<string>,
): string[] {
  return cells.filter((c) => c.ssh && hostIds.has(c.ssh.hostId) && !isLivePhase(sessions[c.id]?.phase)).map((c) => c.id).slice(0, 20);
}

// ── key editors ──────────────────────────────────────────────────────────────

export function draftErrorKey(error: DraftError | KeyError | 'cancelled'): MessageKey | null {
  switch (error) {
    case 'tooLarge': return 'Plik jest za duży na klucz SSH';
    case 'notAKey': return 'To nie jest klucz prywatny SSH';
    case 'publicOnly': return 'To jest klucz publiczny - potrzebny jest prywatny';
    case 'ppkV3': return 'Klucz PuTTY w wersji 3 nie jest obsługiwany. Zapisz go w PuTTYgen jako OpenSSH.';
    case 'unsupportedType': return 'Ten typ klucza nie jest obsługiwany';
    case 'badPassphrase': return 'Nieprawidłowe hasło klucza';
    case 'mismatch': return 'Klucz publiczny nie pasuje do prywatnego';
    case 'certMismatch': return 'Certyfikat nie pasuje do klucza';
    case 'readFailed': return 'Nie udało się odczytać pliku';
    case 'readOnly': return READ_ONLY_VAULT_HINT;
    case 'notFound': return 'Klucz przypisany do hosta nie istnieje';
    case 'failed': return 'Nie udało się wygenerować klucza';
    case 'invalid': return 'Nieprawidłowe dane';
    default: return null;
  }
}

/** The message of a failed "Zastąp klucz prywatny" (the pasted text and passphrase are already cleared from the form). */
export function replaceKeyErrorKey(error: ReplaceKeyError): MessageKey {
  if (error === 'needsPassphrase') return 'Ten klucz jest zaszyfrowany - wklej go ponownie razem z hasłem';
  if (error === 'duplicate') return 'Ten klucz już jest w sejfie';
  if (error === 'failed') return 'Nie udało się zapisać zmian';
  return draftErrorKey(error) ?? 'Nieprawidłowe dane';
}

/** Short text for any read-only vault (unreadable, damaged or newer); Settings > SSH explains the cause with the file path. */
export const READ_ONLY_VAULT_HINT: MessageKey = 'Sejf SSH jest tylko do odczytu - szczegóły w Ustawienia > SSH';

export const storageLabel = (storage: SshVaultInfo['storage']): MessageKey =>
  storage === 'dpapi' ? 'Szyfrowanie: Windows (DPAPI)' : storage === 'keychain' ? 'Szyfrowanie: pęk kluczy macOS' : 'Szyfrowanie: niedostępne';

/** Settings text for a store that opened read-only (it takes the file path as {file}); null while the store is writable
 *  or while the path is not known yet (storage status loading or failed), so no note shows an empty path. */
export const readOnlyStoreNote = (store: 'vault' | 'knownHosts', readOnly: boolean, file: string | undefined): MessageKey | null =>
  !readOnly || !file ? null : store === 'vault'
    ? 'Sejf SSH jest tylko do odczytu: plik {file} jest nieczytelny, ma nieprawidłowy format, zawiera uszkodzony wpis albo pochodzi z nowszej wersji aplikacji. Nie można dodawać ani zmieniać kluczy i haseł, a plik pozostaje nietknięty. Napraw lub usuń ten plik i uruchom aplikację ponownie.'
    : 'Lista znanych hostów jest tylko do odczytu: plik {file} jest nieczytelny, ma nieprawidłowy format albo pochodzi z nowszej wersji aplikacji. Nie można usuwać wpisów, a klucz hosta zaakceptowany z opcją „Zaufaj i zapisz” albo zmieniony klucz przyjęty przyciskiem „Zastąp zapisany klucz” obowiązuje tylko dla tego jednego połączenia. Napraw lub usuń ten plik i uruchom aplikację ponownie.';

/**
 * Whether Remove is withheld in a known hosts list: while the store status loads, yes (it may turn out read-only); if the status
 * call failed, no (main still refuses a change of a read-only store, and the list must not stay locked for the whole session).
 */
export const knownHostsLocked = (status: SshStorageStatus | null, failed: boolean): boolean => (status ? status.knownHostsReadOnly : !failed);

/** Description of Settings > SSH > Known hosts: with the file path ({file}) once known, a generic text before that. */
export const knownHostsDescription = (file: string | undefined): MessageKey =>
  file
    ? 'Klucze hostów zaakceptowane z opcją „Zaufaj i zapisz”. Gdy lista jest tylko do odczytu, zaakceptowany klucz obowiązuje tylko dla tego jednego połączenia. Gdy zapis do pliku {file} nieoczekiwanie się nie uda (np. brak uprawnień albo miejsca na dysku), połączenie jest odrzucane z ogólnym błędem - sprawdź wtedy ten plik i spróbuj ponownie.'
    : 'Klucze hostów zaakceptowane z opcją „Zaufaj i zapisz”. Gdy lista jest tylko do odczytu, zaakceptowany klucz obowiązuje tylko dla tego jednego połączenia. Gdy zapis do pliku znanych hostów nieoczekiwanie się nie uda (np. brak uprawnień albo miejsca na dysku), połączenie jest odrzucane z ogólnym błędem - sprawdź wtedy ten plik i spróbuj ponownie.';

export function newKeyProblem(p: { label: string; passphrase: string; repeat: string }): MessageKey | null {
  if (!p.label.trim()) return 'Podaj etykietę';
  if (p.passphrase !== p.repeat) return 'Hasła się różnią';
  return null;
}

export const hostsUsingKey = (hosts: readonly SshHost[], keyId: string): SshHost[] => hosts.filter((h) => h.keyId === keyId);

/** The key label field follows the stored label (renamed elsewhere, late vault push) unless the user is typing in it. */
export const labelFieldValue = (p: { field: string; stored: string; focused: boolean }): string => (p.focused ? p.field : p.stored);
