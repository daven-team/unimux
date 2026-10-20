// Host details (spec 10.2), laid out like Termius: Adres (the icon tile holds the host colour), Ogólne (label, group, tags), one
// card with "SSH na porcie", the credentials and "Pokaż więcej" for the rest. A new host is stored on "Zapisz" only. The
// password is write-only (D6): typed here it goes to the vault on "Zapisz"; a saved one is a masked placeholder that can be
// replaced or removed, never read back. An identity picked under the user name replaces the user name, password and key.
import { useMemo, useState } from 'react';
import { useClearWhenHidden, useReportDirty, withoutPaneGuard } from './paneVisibility';
import { hostFormDirty, hostToDraft, READ_ONLY_VAULT_HINT, validateHostDraft, type HostDraftField, type SshHostDraft } from '../../../../shared/ssh';
import type { SshIdentity } from '../../../../shared/sshIdentity';
import { addSshHost, uid, updateSshHost } from '../../../../shared/state';
import type { MessageKey } from '../../../../shared/i18n';
import { showTerminalTabs } from '../../files';
import { useI18n } from '../../i18n';
import { toast, update, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { confirmRemoveSshHost, openHostInCell, showSshDetail } from '../../ssh';
import { ColorPicker } from '../ColorPicker';
import { IChevron, IFolder, IServer, ITag } from '../icons';
import { IconInput, IdentityChip, KeyField, PasswordField, UsernameField } from './CredentialFields';

/** The colour the palette opens with while the host has none (the tile itself stays neutral then). */
const PALETTE_START = '#60a5fa';

export function HostEditor({ paneId, hostId }: { paneId: string; hostId?: string }) {
  const { tr } = useI18n();
  const host = useStore((st) => st.s.sshHosts.find((h) => h.id === hostId));
  const allHosts = useStore((st) => st.s.sshHosts);
  const identities = useStore((st) => st.s.sshIdentities);
  const vault = useSshStore((st) => st.vault);
  const groups = useMemo(() => [...new Set(allHosts.map((h) => h.group).filter((g): g is string => !!g))].sort(), [allHosts]);
  const [draft, setDraft] = useState<SshHostDraft>(() => hostToDraft(host));
  const [errors, setErrors] = useState<Partial<Record<HostDraftField, MessageKey>>>({});
  const [tag, setTag] = useState('');
  const [password, setPassword] = useState('');
  /** The saved password is marked for removal on "Zapisz" (× in the password field). */
  const [clearSaved, setClearSaved] = useState(false);
  const [more, setMore] = useState(false);
  useClearWhenHidden(() => setPassword(''));
  useReportDirty(hostFormDirty(host, draft, { tag, password, clearPassword: clearSaved }));
  const set = (patch: Partial<SshHostDraft>) => setDraft((d) => ({ ...d, ...patch }));
  // An identity deleted while the form is open counts as detached.
  const identity = draft.identityId ? identities.find((i) => i.id === draft.identityId) : undefined;
  const saved = !!host && !!vault?.savedPasswords.includes(host.id);
  const locked = !!host && !!vault?.lockedPasswords.includes(host.id);
  const readOnly = !!vault?.readOnly;

  const save = async (connect: boolean) => {
    // A picked identity decides the user name the host mirrors.
    const r = validateHostDraft(identity ? { ...draft, username: identity.username } : { ...draft, identityId: undefined });
    if (!r.ok) {
      setErrors(r.errors);
      if (r.errors.startupCommand || r.errors.sftpCommand) setMore(true);
      return;
    }
    setErrors({});
    // An identity brings its own password: what was typed for the host is not stored then.
    const typed = identity ? '' : password;
    const clear = !identity && clearSaved;
    setPassword('');
    setClearSaved(false);
    const now = Date.now();
    let id = host?.id;
    if (host) update((s) => updateSshHost(s, host.id, { group: undefined, tags: undefined, keyId: undefined, identityId: undefined, startupCommand: undefined, color: undefined, reconnectOnStart: undefined, sftpSudo: undefined, sftpCommand: undefined, ...r.value }, now));
    else {
      id = uid();
      const created = { id, ...r.value, createdAt: now, updatedAt: now };
      update((s) => addSshHost(s, created));
      // Saved: the form is clean once it re-renders, so moving on must not ask about the edits just stored.
      withoutPaneGuard(() => showSshDetail({ kind: 'host', hostId: id }));
    }
    if (!id) return;
    // Sent after the state edit (main handles both in order), so main already knows a new host when its password arrives.
    if (typed) {
      const result = await window.mc.ssh.setPassword(id, typed);
      if (!result.ok) toast(tr(result.error === 'readOnly' ? READ_ONLY_VAULT_HINT : result.error === 'failed' ? 'Nie udało się zapisać zmian' : 'Nieprawidłowe dane'), 'error');
    } else if (clear && !(await window.mc.ssh.clearPassword(id)).ok) toast(tr('Nie udało się zapisać zmian'), 'error');
    if (connect) {
      // The new cell asks for the host key and the password in the grid: show the grid (the SSH tab stays open).
      showTerminalTabs();
      void openHostInCell(id, 'cell');
    }
  };

  const remove = async () => {
    if (!host) { showSshDetail(null); return; }
    if (await confirmRemoveSshHost(host.id)) withoutPaneGuard(() => showSshDetail(null));
  };

  const pickIdentity = (picked: SshIdentity) => {
    set({ identityId: picked.id, username: picked.username });
    setPassword('');
    setClearSaved(false);
    setErrors((e) => ({ ...e, username: undefined }));
  };
  const field = (name: HostDraftField) => errors[name] && <div className="ssh-error" role="alert">{tr(errors[name]!)}</div>;
  const addTag = () => {
    const t = tag.trim();
    if (t && !draft.tags.includes(t)) set({ tags: [...draft.tags, t] });
    setTag('');
  };

  return (
    <form className="ssh-editor ssh-he" onSubmit={(e) => { e.preventDefault(); void save(false); }}>
      <h2>{host ? host.label : tr('Nowy host')}</h2>
      <section className="ssh-he-card" aria-label={tr('Adres')}>
        <h3>{tr('Adres')}</h3>
        <div className="ssh-he-row">
          <ColorPicker value={draft.color ?? PALETTE_START} label={tr('Kolor')} swatch={<IServer />}
            swatchClassName={`ssh-icon-tile${draft.color ? '' : ' uncolored'}`}
            onChange={(color) => set({ color })} onClear={draft.color ? () => set({ color: undefined }) : undefined} />
          <input className="input" data-field="address" value={draft.address} spellCheck={false} autoFocus={!host}
            placeholder={tr('IP lub nazwa hosta')} aria-label={tr('Adres')} onChange={(e) => set({ address: e.target.value })} />
        </div>
        {field('address')}
      </section>
      <section className="ssh-he-card" aria-label={tr('Ogólne')}>
        <h3>{tr('Ogólne')}</h3>
        <input className="input" data-field="label" value={draft.label} maxLength={80} placeholder={tr('Etykieta')} aria-label={tr('Etykieta')}
          onChange={(e) => set({ label: e.target.value })} />
        <IconInput icon={<IFolder />}>
          <input className="input" data-field="group" list={`${paneId}-groups`} value={draft.group} maxLength={60} placeholder={tr('Grupa')} aria-label={tr('Grupa')}
            onChange={(e) => set({ group: e.target.value })} />
          <datalist id={`${paneId}-groups`}>{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </IconInput>
        <IconInput icon={<ITag />} className="ssh-he-tags">
          {draft.tags.map((t) => <span key={t} className="ssh-tag">{t}<button type="button" aria-label={tr('Usuń')} onClick={() => set({ tags: draft.tags.filter((x) => x !== t) })}>×</button></span>)}
          <input className="input" value={tag} maxLength={24} placeholder={draft.tags.length ? '' : tr('Tagi')} aria-label={tr('Tagi')}
            onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }} onBlur={addTag} />
        </IconInput>
      </section>
      <section className="ssh-he-card" aria-label={tr('Dane logowania')}>
        <label className="ssh-he-port">
          <span>{tr('SSH na porcie')}</span>
          <input className="input" data-field="port" value={draft.port} inputMode="numeric" placeholder="22" maxLength={5} aria-label={tr('Port')} onChange={(e) => set({ port: e.target.value })} />
        </label>
        {field('port')}
        <div className="ssh-he-sep" />
        <h3>{tr('Dane logowania')}</h3>
        {identity ? <IdentityChip identity={identity} onDetach={() => set({ identityId: undefined })} /> : <>
          <UsernameField value={draft.username} onChange={(username) => set({ username })} onPick={pickIdentity} identities={identities} />
          {field('username')}
          <PasswordField value={password} onChange={setPassword} saved={saved} locked={locked} cleared={clearSaved} onClear={() => setClearSaved(true)} disabled={readOnly} />
          <KeyField keyId={draft.keyId} onChange={(keyId) => set({ keyId })} />
        </>}
        <div className="ssh-he-sep" />
        <button type="button" className="ssh-he-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          {tr(more ? 'Pokaż mniej' : 'Pokaż więcej')}<span className={more ? 'ssh-he-chev up' : 'ssh-he-chev'}><IChevron /></span>
        </button>
        {more && (
          <div className="ssh-he-more-body">
            <textarea className="input mono" data-field="startupCommand" rows={3} value={draft.startupCommand} spellCheck={false}
              placeholder={tr('Polecenie startowe')} aria-label={tr('Polecenie startowe')} onChange={(e) => set({ startupCommand: e.target.value })} />
            {field('startupCommand')}
            <label className="check"><input type="checkbox" data-field="reconnectOnStart" checked={draft.reconnectOnStart} onChange={(e) => set({ reconnectOnStart: e.target.checked })} />{tr('Łącz ponownie po uruchomieniu aplikacji')}</label>
            <label className="check"><input type="checkbox" data-field="sftpSudo" checked={draft.sftpSudo === true} onChange={(e) => set({ sftpSudo: e.target.checked })} />{tr('Uruchamiaj SFTP przez sudo')}</label>
            {draft.sftpSudo && <>
              <input className="input mono" data-field="sftpCommand" value={draft.sftpCommand ?? ''} spellCheck={false} maxLength={512} placeholder="sudo -n /usr/lib/openssh/sftp-server"
                aria-label={tr('Polecenie serwera SFTP')} title={tr('Polecenie serwera SFTP')} onChange={(e) => set({ sftpCommand: e.target.value })} />
              {field('sftpCommand')}
            </>}
            {/* More per-host options (the terminal theme of SSH cells, ...) go in this card. */}
          </div>
        )}
      </section>
      <div className="ssh-actions">
        <button type="submit" className="btn primary">{tr('Zapisz')}</button>
        <button type="button" className="btn" onClick={() => void save(true)}>{tr('Zapisz i połącz')}</button>
        <span className="grow" />
        <button type="button" className="btn danger" onClick={() => void remove()}>{tr('Usuń host')}</button>
      </div>
    </form>
  );
}
