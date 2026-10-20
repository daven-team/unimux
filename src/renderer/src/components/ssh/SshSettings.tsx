// Settings, section "SSH" (D12, spec 9 step 5): where secrets are kept, the trusted host keys, forgetting remembered passphrases.
// The SSH view lists the same known hosts (Znane hosty, useKnownHosts). A store that opened read-only (unreadable, wrong shape, malformed entry or a newer format) is explained here, with its file path.
import { knownHostsDescription, readOnlyStoreNote, storageLabel } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { toast } from '../../store';
import { useSshStore } from '../../sshStore';
import { SettingRow, SettingsGroup } from '../SettingRow';
import { SshAutocompleteSettings } from './SshAutocompleteSettings';
import { useKnownHosts } from './useKnownHosts';

export function SshSettings() {
  const { tr, language } = useI18n();
  const vault = useSshStore((st) => st.vault);
  const { known, status, readOnly: hostsReadOnly, remove } = useKnownHosts();
  const vaultReadOnly = !!vault?.readOnly || !!status?.vaultReadOnly;
  const vaultNote = readOnlyStoreNote('vault', vaultReadOnly, status?.vaultFile);
  const hostsNote = readOnlyStoreNote('knownHosts', hostsReadOnly, status?.knownHostsFile);
  return <>
    <SettingsGroup>
      <SettingRow title={tr('Sejf SSH')} hint={vault?.storage === 'unavailable' ? tr('Szyfrowanie systemowe jest niedostępne - klucze i hasła są trzymane tylko do zamknięcia aplikacji') : undefined}>
        <span>{tr(storageLabel(vault?.storage ?? 'unavailable'))}</span>
      </SettingRow>
      {vaultNote && <div className="ssh-banner-warn" role="alert">{tr(vaultNote, { file: status?.vaultFile ?? '' })}</div>}
      <SettingRow title={tr('Zapomnij zapamiętane hasła kluczy')} hint={tr('Hasła kluczy wpisane z opcją „Pamiętaj do zamknięcia aplikacji”.')}>
        <button className="btn" onClick={() => void window.mc.ssh.forgetPassphrases().then(() => toast(tr('Zapomniano zapamiętane hasła kluczy')))}>{tr('Zapomnij')}</button>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={tr('Znane hosty')}
      description={tr(knownHostsDescription(status?.knownHostsFile), { file: status?.knownHostsFile ?? '' })}>
      {hostsNote && <div className="ssh-banner-warn" role="alert">{tr(hostsNote, { file: status?.knownHostsFile ?? '' })}</div>}
      {known && !known.length && <p className="muted">{tr('Brak znanych hostów')}</p>}
      {!!known?.length && (
        <table className="ssh-known">
          <tbody>
            {known.map((k) => (
              <tr key={k.id}>
                <td>{k.display}</td><td>{k.keyType}</td><td><code className="ssh-fingerprint">{k.fingerprint}</code></td>
                <td>{k.addedAt ? new Date(k.addedAt).toLocaleDateString(language) : '-'}</td>
                <td><button className="btn small" disabled={hostsReadOnly} aria-label={tr('Usuń {host}', { host: k.display })} onClick={() => remove(k.id)}>{tr('Usuń')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsGroup>
    <SshAutocompleteSettings />
  </>;
}
