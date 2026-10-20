// One SSH identity (the Klucze section, next to the keys): a label, a user name, an optional saved password (write-only, like
// a host's, D6) and an optional vault key. Hosts that use it sign in with these; main resolves them at connect time.
import { useMemo, useState } from 'react';
import { useClearWhenHidden, useReportDirty, withoutPaneGuard } from './paneVisibility';
import { READ_ONLY_VAULT_HINT } from '../../../../shared/ssh';
import {
  hostsUsingIdentity, identityFormDirty, identityToDraft, removeSshIdentity, upsertSshIdentity, validateIdentityDraft, type SshIdentity, type SshIdentityDraft,
} from '../../../../shared/sshIdentity';
import { uid } from '../../../../shared/state';
import type { MessageKey } from '../../../../shared/i18n';
import { useI18n } from '../../i18n';
import { askChoice, toast, update, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { showSshDetail } from '../../ssh';
import { IconInput, KeyField, PasswordField } from './CredentialFields';
import { IUser } from './sshIcons';

export function IdentityEditor({ identityId }: { identityId?: string }) {
  const { tr } = useI18n();
  const identity = useStore((st) => st.s.sshIdentities.find((i) => i.id === identityId));
  const hosts = useStore((st) => st.s.sshHosts);
  const using = useMemo(() => (identity ? hostsUsingIdentity(hosts, identity.id) : []), [hosts, identity]);
  const vault = useSshStore((st) => st.vault);
  const [draft, setDraft] = useState<SshIdentityDraft>(() => identityToDraft(identity));
  const [error, setError] = useState<MessageKey | null>(null);
  const [password, setPassword] = useState('');
  const [clearSaved, setClearSaved] = useState(false);
  useClearWhenHidden(() => setPassword(''));
  useReportDirty(identityFormDirty(identity, draft, { password, clearPassword: clearSaved }));
  const set = (patch: Partial<SshIdentityDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const saved = !!identity && !!vault?.savedIdentityPasswords?.includes(identity.id);
  const locked = !!identity && !!vault?.lockedIdentityPasswords?.includes(identity.id);
  const readOnly = !!vault?.readOnly;

  const save = async () => {
    const r = validateIdentityDraft(draft);
    if (!r.ok) { setError(r.errors.username ?? null); return; }
    setError(null);
    const typed = password;
    const clear = clearSaved;
    setPassword('');
    setClearSaved(false);
    const now = Date.now();
    const id = identity?.id ?? uid();
    const next: SshIdentity = { id, ...r.value, createdAt: identity?.createdAt ?? now, updatedAt: now };
    update((s) => upsertSshIdentity(s, next));
    // Saved: the form is clean once it re-renders, so moving on must not ask about the edits just stored.
    if (!identity) withoutPaneGuard(() => showSshDetail({ kind: 'identity', identityId: id }));
    // After the state edit (main handles both in order): main stores a password only for an identity it knows.
    if (typed) {
      const result = await window.mc.ssh.setIdentityPassword(id, typed);
      if (!result.ok) toast(tr(result.error === 'readOnly' ? READ_ONLY_VAULT_HINT : result.error === 'failed' ? 'Nie udało się zapisać zmian' : 'Nieprawidłowe dane'), 'error');
    } else if (clear && !(await window.mc.ssh.clearIdentityPassword(id)).ok) toast(tr('Nie udało się zapisać zmian'), 'error');
  };

  /** An identity in use asks with the number of its hosts; they keep the user name (and its key when they have none). */
  const remove = async () => {
    if (!identity) { showSshDetail(null); return; }
    const title = using.length
      ? tr('Tożsamość jest używana przez {count} hostów. Usunąć ją?', { count: using.length })
      : tr('Usunąć tożsamość {name}?', { name: identity.label });
    if (await askChoice(title, '', [{ label: tr('Usuń tożsamość'), value: 'yes', danger: true }]) !== 'yes') return;
    update((s) => removeSshIdentity(s, identity.id));
    withoutPaneGuard(() => showSshDetail(null));
  };

  return (
    <form className="ssh-editor ssh-he" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>{identity ? identity.label : tr('Nowa tożsamość')}</h2>
      <section className="ssh-he-card" aria-label={tr('Tożsamość')}>
        <h3>{tr('Tożsamość')}</h3>
        <input className="input" data-field="identityLabel" value={draft.label} maxLength={80} placeholder={tr('Etykieta')} aria-label={tr('Etykieta')} autoFocus={!identity}
          onChange={(e) => set({ label: e.target.value })} />
        <IconInput icon={<IUser />}>
          <input className="input" data-field="identityUsername" value={draft.username} maxLength={64} spellCheck={false} autoComplete="off" placeholder={tr('Użytkownik')} aria-label={tr('Użytkownik')}
            onChange={(e) => set({ username: e.target.value })} />
        </IconInput>
        {error && <div className="ssh-error" role="alert">{tr(error)}</div>}
        <PasswordField value={password} onChange={setPassword} saved={saved} locked={locked} cleared={clearSaved} onClear={() => setClearSaved(true)} disabled={readOnly} />
        <KeyField keyId={draft.keyId} onChange={(keyId) => set({ keyId })} />
      </section>
      {using.length > 0 && (
        <section className="ssh-he-card" aria-label={tr('Hosty używające tożsamości')}>
          <h3>{tr('Hosty używające tożsamości')}</h3>
          <ul className="ssh-list">
            {using.map((h) => <li key={h.id}><button type="button" className="btn small ghost" onClick={() => showSshDetail({ kind: 'host', hostId: h.id })}>{h.label}</button></li>)}
          </ul>
        </section>
      )}
      <div className="ssh-actions">
        <button type="submit" className="btn primary">{tr('Zapisz')}</button>
        <span className="grow" />
        {identity && <button type="button" className="btn danger" onClick={() => void remove()}>{tr('Usuń tożsamość')}</button>}
      </div>
    </form>
  );
}
