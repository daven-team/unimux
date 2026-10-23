// IPC of the SSH feature (spec 8.1): zod-validated, size-capped, ids resolved against state and vault. Results never carry
// private key text, passphrases or passwords (the one exception is revealPrivateKey, the explicit "Pokaż klucz prywatny");
// errors are fixed codes. Electron-free (except the IpcMain type) so it is unit tested.
import type { IpcMain } from 'electron';
import { isAbsolute } from 'path';
import { readFile, stat } from 'fs/promises';
import { z } from 'zod';
import { clearSshKeyRefs, findCell } from '../../shared/state';
import { SSH_LIMITS, type DraftResult, type KeyResult, type KnownHostInfo, type ReplaceKeyResult, type RevealKeyResult, type SshErrorCode, type SshSessionsSnapshot, type SshStorageStatus, type SshVaultInfo } from '../../shared/ssh';
import type { AppState } from '../../shared/types';
import type { SshCoordinator } from './coordinator';
import { certificateCheck, checkPassphrase, generateKey, keyMetaFromPublic, parsePrivateKey, type KeyDrafts } from './keys';
import type { KnownHostsStore } from './knownHosts';
import type { SshVault } from './vault';

export interface SshIpcDeps {
  coordinator: Pick<SshCoordinator, 'connect' | 'sessions' | 'answer'>;
  vault: SshVault;
  knownHosts: KnownHostsStore;
  drafts: KeyDrafts;
  state(): AppState;
  /** A main-side state edit (StateController.change). */
  change(fn: (s: AppState) => AppState): void;
  vaultChanged(): void;
  pickKeyFile(): Promise<string | null>;
  saveKeyFile(defaultName: string): Promise<string | null>;
  readKeyFile(path: string): Promise<{ ok: true; text: string } | { ok: false; error: 'tooLarge' | 'readFailed' }>;
  writeKeyFile(path: string, text: string): Promise<void>;
  hostname(): string;
}

const id = z.string().uuid();
const label = z.string().trim().min(1).max(SSH_LIMITS.label);
const secret = (max: number) => z.string().min(1).max(max);
const passphrase = secret(SSH_LIMITS.passphrase);
const text = (max: number) => z.string().max(max);
const S = {
  generate: z.object({ label, type: z.enum(['ed25519', 'ecdsa', 'rsa']), bits: z.number().int().optional(), comment: text(200).optional(), passphrase: passphrase.optional(), savePassphrase: z.boolean() }).strict(),
  path: z.object({ path: z.string().min(1).max(4096) }).strict(),
  draftText: z.object({ privateKey: secret(SSH_LIMITS.privateKey), publicKey: text(20000).optional(), certificate: text(20000).optional() }).strict(),
  unlock: z.object({ draftId: id, passphrase }).strict(),
  commit: z.object({ draftId: id, label, savePassphrase: z.boolean() }).strict(),
  update: z.object({ id, label: label.optional(), certificate: text(20000).nullable().optional(), passphrase: z.union([z.object({ save: passphrase }).strict(), z.object({ forget: z.literal(true) }).strict()]).optional() }).strict(),
  byId: z.object({ id }).strict(),
  replace: z.object({ id, privateKey: secret(SSH_LIMITS.privateKey), passphrase: passphrase.optional(), savePassphrase: z.boolean() }).strict(),
  setPassword: z.object({ hostId: id, password: secret(SSH_LIMITS.password) }).strict(),
  byHost: z.object({ hostId: id }).strict(),
  setIdentityPassword: z.object({ identityId: id, password: secret(SSH_LIMITS.password) }).strict(),
  byIdentity: z.object({ identityId: id }).strict(),
  connect: z.object({ cellId: id, hostId: id, cols: z.number().int().min(2).max(2000), rows: z.number().int().min(1).max(1000), restoreCwd: z.boolean().optional() }).strict(),
  answer: z.union([
    z.object({ cellId: id, promptId: id, cancel: z.literal(true) }).strict(),
    z.object({ cellId: id, promptId: id, values: z.array(z.string().max(SSH_LIMITS.password)).max(10), remember: z.boolean().optional() }).strict(),
    z.object({ cellId: id, promptId: id, hostKey: z.enum(['once', 'save', 'replace']) }).strict(),
  ]),
};

export async function readKeyFileFromDisk(path: string): Promise<{ ok: true; text: string } | { ok: false; error: 'tooLarge' | 'readFailed' }> {
  if (!isAbsolute(path) || path.includes('\0')) return { ok: false, error: 'readFailed' };
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, error: 'readFailed' };
    if (info.size > SSH_LIMITS.privateKey) return { ok: false, error: 'tooLarge' };
    return { ok: true, text: await readFile(path, 'utf8') };
  } catch { return { ok: false, error: 'readFailed' }; }
}

const safeFileName = (name: string) => (name.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 60) || 'id_key');

/** Runs a vault or known-hosts mutation; a failed write (it throws) becomes `fallback`, never the raw error text. */
function guarded<T, F>(fallback: F, fn: () => T): T | F {
  try { return fn(); } catch { return fallback; }
}

export function createSshHandlers(deps: SshIpcDeps) {
  const duplicateOf = (fp: string) => deps.vault.findByFingerprint(fp)?.id;
  const draftFromPath = async (path: string): Promise<DraftResult> => {
    const read = await deps.readKeyFile(path);
    return read.ok ? deps.drafts.create({ privateKey: read.text }, duplicateOf) : { ok: false, error: read.error };
  };
  const changed = <T>(value: T): T => { deps.vaultChanged(); return value; };
  return {
    vaultInfo: async (): Promise<SshVaultInfo> => deps.vault.info(),
    async generateKey(raw: unknown): Promise<KeyResult> {
      const p = S.generate.safeParse(raw);
      if (!p.success) return { ok: false, error: 'invalid' };
      if (deps.vault.readOnly()) return { ok: false, error: 'readOnly' };
      const comment = (p.data.comment ?? '').replace(/[\u0000-\u001f]/g, ' ').trim() || `unimux@${deps.hostname()}`;
      try {
        const { privateKey, meta } = await generateKey({ type: p.data.type, bits: p.data.bits, comment, passphrase: p.data.passphrase });
        const r = deps.vault.addKey({ label: p.data.label, type: meta.type, bits: meta.bits, fingerprint: meta.fingerprint, publicKey: meta.publicKey, comment: meta.comment,
          encrypted: !!p.data.passphrase, privateKey, passphrase: p.data.passphrase, savePassphrase: p.data.savePassphrase, source: 'generated' });
        return r.ok ? changed({ ok: true, key: r.key }) : { ok: false, error: r.error };
      } catch { return { ok: false, error: 'failed' }; }
    },
    async pickKeyFile(): Promise<DraftResult | { ok: false; error: 'cancelled' }> {
      const path = await deps.pickKeyFile();
      return path ? draftFromPath(path) : { ok: false, error: 'cancelled' };
    },
    async draftFromFile(raw: unknown): Promise<DraftResult> {
      const p = S.path.safeParse(raw);
      return p.success ? draftFromPath(p.data.path) : { ok: false, error: 'invalid' };
    },
    async draftFromText(raw: unknown): Promise<DraftResult> {
      const p = S.draftText.safeParse(raw);
      return p.success ? deps.drafts.create(p.data, duplicateOf) : { ok: false, error: 'invalid' };
    },
    async unlockDraft(raw: unknown): Promise<DraftResult> {
      const p = S.unlock.safeParse(raw);
      return p.success ? deps.drafts.unlock(p.data.draftId, p.data.passphrase, duplicateOf) : { ok: false, error: 'invalid' };
    },
    async commitDraft(raw: unknown): Promise<KeyResult> {
      const p = S.commit.safeParse(raw);
      if (!p.success) return { ok: false, error: 'invalid' };
      if (deps.vault.readOnly()) return { ok: false, error: 'readOnly' };
      const d = deps.drafts.take(p.data.draftId);
      if (!d) return { ok: false, error: 'notFound' };
      const r = guarded({ ok: false as const, error: 'failed' as const }, () => deps.vault.addKey({ label: p.data.label, type: d.meta.type, bits: d.meta.bits, fingerprint: d.meta.fingerprint, publicKey: d.meta.publicKey, comment: d.meta.comment,
        encrypted: d.encrypted, privateKey: d.text, passphrase: d.passphrase, savePassphrase: p.data.savePassphrase, certificate: d.certificate, source: 'imported' }));
      return r.ok ? changed({ ok: true, key: r.key, ...(r.duplicate ? { duplicate: true } : {}) }) : { ok: false, error: r.error };
    },
    discardDraft(raw: unknown): void { if (typeof raw === 'string' && raw.length <= 64) deps.drafts.discard(raw); },
    async updateKey(raw: unknown): Promise<KeyResult> {
      const p = S.update.safeParse(raw);
      if (!p.success) return { ok: false, error: 'invalid' };
      const key = deps.vault.key(p.data.id);
      if (!key) return { ok: false, error: 'notFound' };
      if (typeof p.data.certificate === 'string' && p.data.certificate.trim()) {
        const meta = keyMetaFromPublic(key.publicKey);
        if (!meta || certificateCheck(p.data.certificate, meta) === 'mismatch') return { ok: false, error: 'certMismatch' };
      }
      const pp = p.data.passphrase;
      if (pp && 'save' in pp) {
        // Only a passphrase that opens the key is stored (a wrong saved one would fail every later sign-in silently).
        const material = deps.vault.keySecret(key.id);
        if (!material.ok) return { ok: false, error: 'failed' };
        if (!checkPassphrase(material.privateKey, pp.save)) return { ok: false, error: 'badPassphrase' };
      }
      const r = guarded({ ok: false as const, error: 'failed' as const }, () => deps.vault.updateKey(p.data.id, {
        label: p.data.label, certificate: p.data.certificate === undefined ? undefined : p.data.certificate?.trim() || null, passphrase: pp,
      }));
      if (!r.ok) return { ok: false, error: r.error === 'keyLocked' ? 'failed' : r.error };
      return changed({ ok: true, key: r.key });
    },
    async removeKey(raw: unknown): Promise<{ ok: boolean }> {
      const p = S.byId.safeParse(raw);
      if (!p.success || !guarded(false, () => deps.vault.removeKey(p.data.id))) return { ok: false };
      deps.change((s) => clearSshKeyRefs(s, p.data.id));
      return changed({ ok: true });
    },
    async exportPrivateKey(raw: unknown): Promise<{ ok: true } | { ok: false; error: 'cancelled' | 'locked' | 'notFound' | 'failed' }> {
      const p = S.byId.safeParse(raw);
      const key = p.success ? deps.vault.key(p.data.id) : undefined;
      if (!p.success || !key) return { ok: false, error: 'notFound' };
      const material = deps.vault.keySecret(key.id);
      if (!material.ok) return { ok: false, error: material.error === 'keyLocked' ? 'locked' : 'notFound' };
      // A failing dialog or write must not reject the invoke: Electron would hand the raw error text (paths) to the renderer.
      try {
        const target = await deps.saveKeyFile(safeFileName(key.label));
        if (!target) return { ok: false, error: 'cancelled' };
        await deps.writeKeyFile(target, material.privateKey);
      } catch { return { ok: false, error: 'failed' }; }
      return { ok: true };
    },
    /** "Pokaż klucz prywatny" (an explicit, confirmed user action): the stored text as it is, never decrypted for display. */
    async revealPrivateKey(raw: unknown): Promise<RevealKeyResult> {
      const p = S.byId.safeParse(raw);
      const key = p.success ? deps.vault.key(p.data.id) : undefined;
      if (!p.success || !key) return { ok: false, error: 'notFound' };
      const material = deps.vault.keySecret(key.id);
      return material.ok ? { ok: true, privateKey: material.privateKey } : { ok: false, error: material.error === 'keyLocked' ? 'locked' : 'notFound' };
    },
    /** "Zastąp klucz prywatny": the new text is parsed like an import (PPK v3, public-only and unsupported keys are refused). */
    async replacePrivateKey(raw: unknown): Promise<ReplaceKeyResult> {
      const p = S.replace.safeParse(raw);
      if (!p.success) return { ok: false, error: 'invalid' };
      if (!deps.vault.key(p.data.id)) return { ok: false, error: 'notFound' };
      if (deps.vault.readOnly()) return { ok: false, error: 'readOnly' };
      const parsed = parsePrivateKey(p.data.privateKey, p.data.passphrase);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const { meta, encrypted } = parsed;
      const r = guarded({ ok: false as const, error: 'failed' as const }, () => deps.vault.replaceKey(p.data.id, {
        type: meta.type, bits: meta.bits, fingerprint: meta.fingerprint, publicKey: meta.publicKey, comment: meta.comment, encrypted,
        privateKey: p.data.privateKey, passphrase: encrypted ? p.data.passphrase : undefined, savePassphrase: p.data.savePassphrase,
      }));
      return r.ok ? changed({ ok: true, key: r.key, publicKeyChanged: r.publicKeyChanged, certificateRemoved: r.certificateRemoved }) : { ok: false, error: r.error };
    },
    async setPassword(raw: unknown): Promise<{ ok: true; ephemeral: boolean } | { ok: false; error: 'notFound' | 'invalid' | 'readOnly' | 'failed' }> {
      const p = S.setPassword.safeParse(raw);
      if (!p.success) return { ok: false, error: 'invalid' };
      if (!deps.state().sshHosts.some((h) => h.id === p.data.hostId)) return { ok: false, error: 'notFound' };
      const r = guarded({ ok: false as const, error: 'failed' as const }, () => deps.vault.setPassword(p.data.hostId, p.data.password));
      return r.ok ? changed({ ok: true, ephemeral: r.ephemeral }) : r;
    },
    async clearPassword(raw: unknown): Promise<{ ok: boolean }> {
      const p = S.byHost.safeParse(raw);
      if (!p.success) return { ok: false };
      try { deps.vault.clearPassword(p.data.hostId); } catch { return { ok: false }; }
      return changed({ ok: true });
    },
    /** The password of an identity (shared/sshIdentity.ts): only for an identity that exists in the state; never echoed back. */
    async setIdentityPassword(raw: unknown): Promise<{ ok: true; ephemeral: boolean } | { ok: false; error: 'notFound' | 'invalid' | 'readOnly' | 'failed' }> {
      const p = S.setIdentityPassword.safeParse(raw);
      if (!p.success) return { ok: false, error: 'invalid' };
      if (!(deps.state().sshIdentities ?? []).some((i) => i.id === p.data.identityId)) return { ok: false, error: 'notFound' };
      const r = guarded({ ok: false as const, error: 'failed' as const }, () => deps.vault.setIdentityPassword(p.data.identityId, p.data.password));
      return r.ok ? changed({ ok: true, ephemeral: r.ephemeral }) : r;
    },
    async clearIdentityPassword(raw: unknown): Promise<{ ok: boolean }> {
      const p = S.byIdentity.safeParse(raw);
      if (!p.success) return { ok: false };
      try { deps.vault.clearIdentityPassword(p.data.identityId); } catch { return { ok: false }; }
      return changed({ ok: true });
    },
    async forgetPassphrases(): Promise<{ ok: boolean }> { deps.vault.forgetRemembered(); return { ok: true }; },
    async storageStatus(): Promise<SshStorageStatus> {
      return { vaultFile: deps.vault.filePath(), vaultReadOnly: deps.vault.readOnly(), knownHostsFile: deps.knownHosts.filePath(), knownHostsReadOnly: deps.knownHosts.readOnly() };
    },
    async knownHosts(): Promise<KnownHostInfo[]> { return deps.knownHosts.info(); },
    async removeKnownHost(raw: unknown): Promise<{ ok: boolean }> {
      const p = S.byId.safeParse(raw);
      return { ok: p.success && guarded(false, () => deps.knownHosts.remove(p.data.id)) };
    },
    async connect(raw: unknown): Promise<{ ok: true } | { ok: false; error: SshErrorCode }> {
      const p = S.connect.safeParse(raw);
      if (!p.success) return { ok: false, error: 'unknown' };
      const state = deps.state();
      if (findCell(state, p.data.cellId)?.cell.ssh?.hostId !== p.data.hostId || !state.sshHosts.some((h) => h.id === p.data.hostId)) return { ok: false, error: 'hostMissing' };
      return deps.coordinator.connect(p.data);
    },
    async sessions(): Promise<SshSessionsSnapshot> { return deps.coordinator.sessions(); },
    async answer(raw: unknown): Promise<{ ok: boolean }> {
      const p = S.answer.safeParse(raw);
      return p.success ? deps.coordinator.answer(p.data) : { ok: false };
    },
  };
}

export type SshHandlers = ReturnType<typeof createSshHandlers>;

/** Invoke channels and the handler each one calls. `ssh:key:discardDraft` is a send (no answer). */
export const SSH_CHANNELS = {
  'ssh:vault:info': 'vaultInfo', 'ssh:key:generate': 'generateKey', 'ssh:key:pickFile': 'pickKeyFile', 'ssh:key:draftFromFile': 'draftFromFile',
  'ssh:key:draftFromText': 'draftFromText', 'ssh:key:unlockDraft': 'unlockDraft', 'ssh:key:commitDraft': 'commitDraft', 'ssh:key:update': 'updateKey',
  'ssh:key:remove': 'removeKey', 'ssh:key:exportPrivate': 'exportPrivateKey', 'ssh:key:revealPrivate': 'revealPrivateKey', 'ssh:key:replacePrivate': 'replacePrivateKey', 'ssh:password:set': 'setPassword', 'ssh:password:clear': 'clearPassword',
  'ssh:identityPassword:set': 'setIdentityPassword', 'ssh:identityPassword:clear': 'clearIdentityPassword',
  'ssh:passphrases:forget': 'forgetPassphrases', 'ssh:storage:status': 'storageStatus', 'ssh:knownHosts:list': 'knownHosts', 'ssh:knownHosts:remove': 'removeKnownHost',
  'ssh:connect': 'connect', 'ssh:sessions': 'sessions', 'ssh:prompt:answer': 'answer',
} as const satisfies Record<string, Exclude<keyof SshHandlers, 'discardDraft'>>;

/** Only the app window may call these (R9). Payloads are never logged. */
export function registerSshIpc(ipc: Pick<IpcMain, 'handle' | 'on'>, handlers: SshHandlers, allowed: (event: { sender: unknown }) => boolean): void {
  for (const [channel, name] of Object.entries(SSH_CHANNELS)) {
    const handler = handlers[name] as (payload?: unknown) => Promise<unknown>;
    // L1: a foreign sender gets no answer (undefined), not a result of a made-up shape.
    ipc.handle(channel, (event, payload) => (allowed(event) ? handler(payload) : undefined));
  }
  ipc.on('ssh:key:discardDraft', (event, draftId) => { if (allowed(event)) handlers.discardDraft(draftId); });
}
