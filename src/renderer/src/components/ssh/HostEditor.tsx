// Host details (spec 10.2). A new host is stored on "Zapisz" only; the password is write-only (D6).
import { useMemo, useState } from 'react';
import { useClearWhenHidden, useReportDirty, withoutPaneGuard } from './paneVisibility';
import { hostFormDirty, hostToDraft, READ_ONLY_VAULT_HINT, validateHostDraft, type HostDraftField, type SshHostDraft } from '../../../../shared/ssh';
import { addSshHost, uid, updateSshHost } from '../../../../shared/state';
import type { MessageKey } from '../../../../shared/i18n';
import { showTerminalTabs } from '../../files';
import { useI18n } from '../../i18n';
import { toast, update, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { confirmRemoveSshHost, openHostInCell, showSshDetail } from '../../ssh';
import { ColorPicker } from '../ColorPicker';
import { Select } from '../Select';
import { SshThemeSelect } from './SshThemePicker';

export function HostEditor({ paneId, hostId }: { paneId: string; hostId?: string }) {
  const { tr } = useI18n();
  const host = useStore((st) => st.s.sshHosts.find((h) => h.id === hostId));
  const allHosts = useStore((st) => st.s.sshHosts);
  const vault = useSshStore((st) => st.vault);
  const groups = useMemo(() => [...new Set(allHosts.map((h) => h.group).filter((g): g is string => !!g))].sort(), [allHosts]);
  const [draft, setDraft] = useState<SshHostDraft>(() => hostToDraft(host));
  const [errors, setErrors] = useState<Partial<Record<HostDraftField, MessageKey>>>({});
  const [tag, setTag] = useState('');
  const [password, setPassword] = useState('');
  useClearWhenHidden(() => setPassword(''));
  useReportDirty(hostFormDirty(host, draft, { tag, password }));
  const set = (patch: Partial<SshHostDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const saved = host ? vault?.savedPasswords.includes(host.id) : false;
  const locked = host ? vault?.lockedPasswords.includes(host.id) : false;
  const readOnly = !!vault?.readOnly;

  const save = (connect: boolean) => {
    const r = validateHostDraft(draft);
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors({});
    const now = Date.now();
    let id = host?.id;
    if (host) update((s) => updateSshHost(s, host.id, { group: undefined, tags: undefined, keyId: undefined, startupCommand: undefined, color: undefined, reconnectOnStart: undefined, sftpSudo: undefined, sftpCommand: undefined, theme: undefined, ...r.value }, now));
    else {
      id = uid();
      const created = { id, ...r.value, createdAt: now, updatedAt: now };
      update((s) => addSshHost(s, created));
      // Saved: the form is clean once it re-renders, so moving on must not ask about the edits just stored.
      withoutPaneGuard(() => showSshDetail({ kind: 'host', hostId: id }));
    }
    if (connect && id) {
      // The new cell asks for the host key and the password in the grid: show the grid (the SSH tab stays open).
      showTerminalTabs();
      void openHostInCell(id, 'cell');
    }
  };

  const remove = async () => {
    if (!host) { showSshDetail(null); return; }
    if (await confirmRemoveSshHost(host.id)) withoutPaneGuard(() => showSshDetail(null));
  };

  const setPw = async () => {
    if (!host || !password) return;
    const value = password;
    setPassword('');
    const r = await window.mc.ssh.setPassword(host.id, value);
    if (!r.ok) toast(tr(r.error === 'readOnly' ? READ_ONLY_VAULT_HINT : r.error === 'failed' ? 'Nie udało się zapisać zmian' : 'Nieprawidłowe dane'), 'error');
  };
  const clearPw = async () => {
    if (!host) return;
    if (!(await window.mc.ssh.clearPassword(host.id)).ok) toast(tr('Nie udało się zapisać zmian'), 'error');
  };

  const field = (name: HostDraftField) => errors[name] && <div className="ssh-error" role="alert">{tr(errors[name]!)}</div>;
  const addTag = () => {
    const t = tag.trim();
    if (t && !draft.tags.includes(t)) set({ tags: [...draft.tags, t] });
    setTag('');
  };

  return (
    <form className="ssh-editor" onSubmit={(e) => { e.preventDefault(); save(false); }}>
      <h2>{host ? host.label : tr('Nowy host')}</h2>
      <div className="ssh-section">
        <label className="ssh-field"><span>{tr('Etykieta')}</span><input className="input" data-field="label" value={draft.label} maxLength={80} placeholder={draft.address} onChange={(e) => set({ label: e.target.value })} /></label>
        <div className="ssh-row">
          <label className="ssh-field grow"><span>{tr('Adres')}</span><input className="input" data-field="address" value={draft.address} spellCheck={false} onChange={(e) => set({ address: e.target.value })} />{field('address')}</label>
          <label className="ssh-field port"><span>{tr('Port')}</span><input className="input" data-field="port" value={draft.port} inputMode="numeric" onChange={(e) => set({ port: e.target.value })} />{field('port')}</label>
        </div>
        <label className="ssh-field"><span>{tr('Użytkownik')}</span><input className="input" data-field="username" value={draft.username} spellCheck={false} onChange={(e) => set({ username: e.target.value })} />{field('username')}</label>
      </div>
      <div className="ssh-section">
        <label className="ssh-field"><span>{tr('Klucz')}</span>
          <Select className="select" value={draft.keyId ?? ''} onChange={(e) => (e.target.value === '__new' ? showSshDetail({ kind: 'newKey' }) : set({ keyId: e.target.value || undefined }))}>
            <option value="">{tr('Brak')}</option>
            {(vault?.keys ?? []).map((k) => <option key={k.id} value={k.id}>{`${k.label} (${k.type.replace('ecdsa-sha2-', '')})`}</option>)}
            {!readOnly && <option value="__new">{tr('Nowy klucz...')}</option>}
          </Select>
        </label>
        <div className="ssh-field"><span>{tr('Hasło')}</span>
          {!host ? <div className="ssh-card-hint">{tr('Najpierw zapisz host')}</div> : <>
            <div className="ssh-card-hint">{locked ? tr('Nie można odczytać tego sekretu na tym komputerze. Usuń go i dodaj ponownie.') : saved ? tr('Hasło zapisane') : tr('Hasło nie jest zapisane - zapytamy przy łączeniu')}</div>
            {readOnly ? <div className="ssh-card-hint">{tr(READ_ONLY_VAULT_HINT)}</div> : (
              <div className="ssh-row">
                <input className="input grow" type="password" autoComplete="off" value={password} maxLength={1024} onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void setPw(); } }} />
                <button type="button" className="btn" disabled={!password} onClick={() => void setPw()}>{tr('Ustaw hasło')}</button>
                {(saved || locked) && <button type="button" className="btn" onClick={() => void clearPw()}>{tr('Usuń hasło')}</button>}
              </div>
            )}
          </>}
        </div>
      </div>
      <div className="ssh-section">
        <label className="ssh-field"><span>{tr('Grupa')}</span>
          <input className="input" list={`${paneId}-groups`} value={draft.group} maxLength={60} onChange={(e) => set({ group: e.target.value })} />
          <datalist id={`${paneId}-groups`}>{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </label>
        <div className="ssh-field"><span>{tr('Tagi')}</span>
          <div className="ssh-tags">
            {draft.tags.map((t) => <span key={t} className="ssh-tag">{t}<button type="button" aria-label={tr('Usuń')} onClick={() => set({ tags: draft.tags.filter((x) => x !== t) })}>×</button></span>)}
            <input className="input" value={tag} maxLength={24} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }} onBlur={addTag} />
          </div>
        </div>
        <div className="ssh-field"><span>{tr('Kolor')}</span>
          <div className="ssh-row"><ColorPicker value={draft.color ?? '#60a5fa'} label={tr('Kolor')} onChange={(color) => set({ color })} />
            {draft.color && <button type="button" className="btn small ghost" onClick={() => set({ color: undefined })}>{tr('Usuń kolor')}</button>}</div>
        </div>
        <SshThemeSelect value={draft.theme} onChange={(theme) => set({ theme })} />
      </div>
      <div className="ssh-section">
        <label className="ssh-field"><span>{tr('Polecenie startowe')}</span>
          <textarea className="input mono" rows={4} value={draft.startupCommand} spellCheck={false} onChange={(e) => set({ startupCommand: e.target.value })} />
          <span className="ssh-card-hint">{tr('Każda linia jest wpisywana tak, jakby ją wpisano ręcznie')}</span>{field('startupCommand')}
        </label>
        <div className="ssh-field">
          <label className="check"><input type="checkbox" data-field="reconnectOnStart" checked={draft.reconnectOnStart} onChange={(e) => set({ reconnectOnStart: e.target.checked })} />{tr('Łącz ponownie po uruchomieniu aplikacji')}</label>
          <span className="ssh-card-hint">{tr('Komórki tego hosta łączą się same, gdy po starcie aplikacji pojawią się na ekranie. Pytanie o hasło lub nieznany klucz hosta i tak pojawi się w komórce.')}</span>
        </div>
      </div>
      <div className="ssh-section">
        <div className="ssh-field">
          <label className="check"><input type="checkbox" data-field="sftpSudo" checked={draft.sftpSudo === true} onChange={(e) => set({ sftpSudo: e.target.checked })} />{tr('Uruchamiaj SFTP przez sudo')}</label>
          <span className="ssh-card-hint">{tr('Pliki w widoku SFTP są wtedy widoczne i zmieniane jako root. Hasło sudo, jeśli jest potrzebne, zostanie zapytane w widoku SFTP i nie jest zapisywane.')} {tr('Karty edytora otwierają pliki z uprawnieniami użytkownika SSH (bez sudo).')}</span>
        </div>
        {draft.sftpSudo && (
          <label className="ssh-field"><span>{tr('Polecenie serwera SFTP')}</span>
            <input className="input mono" data-field="sftpCommand" value={draft.sftpCommand ?? ''} spellCheck={false} maxLength={512} placeholder="sudo -n /usr/lib/openssh/sftp-server" onChange={(e) => set({ sftpCommand: e.target.value })} />
            <span className="ssh-card-hint">{tr('Puste: sudo -n z typowymi ścieżkami sftp-server')}</span>{field('sftpCommand')}
          </label>
        )}
      </div>
      <div className="ssh-actions">
        <button type="submit" className="btn primary">{tr('Zapisz')}</button>
        <button type="button" className="btn" onClick={() => save(true)}>{tr('Zapisz i połącz')}</button>
        <span className="grow" />
        <button type="button" className="btn danger" onClick={() => void remove()}>{tr('Usuń host')}</button>
      </div>
    </form>
  );
}
