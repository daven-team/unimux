// Settings > SSH, "Podpowiedzi poleceń": the switch of the SSH command autocomplete and the per-host command history
// behind it (kept by main on this computer only), which can be cleared host by host or all at once. A history file that
// opened read-only (newer version, not a history file, unreadable) is explained here with its path, like the vault's.
import { useEffect, useState } from 'react';
import type { SshHistoryStatus } from '../../../../shared/commandHistory';
import { updateSettings } from '../../../../shared/state';
import { useI18n } from '../../i18n';
import { askChoice, toast, update, useStore } from '../../store';
import { forgetHistory } from '../../terminals/sshAutocomplete';
import { SettingRow, SettingsGroup } from '../SettingRow';

export function SshAutocompleteSettings() {
  const { tr } = useI18n();
  const enabled = useStore((st) => st.s.settings.sshAutocomplete !== false);
  const hosts = useStore((st) => st.s.sshHosts);
  const [status, setStatus] = useState<SshHistoryStatus | null>(null);
  const load = () => void window.mc.sshHistory.status().then(setStatus, () => setStatus({ counts: {}, readOnly: false, file: '' }));
  useEffect(load, []);
  const counts = status?.counts;
  const readOnly = !!status?.readOnly;
  const withHistory = hosts.filter((h) => (counts?.[h.id] ?? 0) > 0);

  const clear = async (hostId: string | null) => {
    const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;
    const question = host ? tr('Wyczyścić historię poleceń hosta {name}?', { name: host.label }) : tr('Wyczyścić historię poleceń wszystkich hostów?');
    const choice = await askChoice(question, tr('Zapamiętane polecenia znikną z podpowiedzi.'), [{ label: tr('Wyczyść historię poleceń'), value: 'yes', danger: true }]);
    if (choice !== 'yes') return;
    const result = await window.mc.sshHistory.clear(hostId).catch(() => ({ ok: false }));
    forgetHistory(hostId);
    toast(result.ok ? tr('Historia poleceń wyczyszczona') : tr('Nie udało się wyczyścić historii poleceń'), result.ok ? 'info' : 'error');
    load();
  };

  return (
    <SettingsGroup title={tr('Podpowiedzi poleceń')} description={tr('Historia poleceń jest zapisywana tylko na tym komputerze, osobno dla każdego hosta, i nigdzie nie jest wysyłana. Polecenia zaczynające się od spacji oraz tekst wpisywany bez echa (hasła) nie są zapisywane.')}>
      <SettingRow title={tr('Podpowiedzi poleceń w terminalach SSH')} htmlFor="settings-ssh-autocomplete"
        hint={tr('Podczas pisania polecenia pod kursorem pojawiają się pasujące polecenia z historii hosta i jednowierszowe snippety. Klawisze należą do powłoki; gdy lista jest widoczna, strzałka w dół wchodzi w nią, strzałka w prawo dopełnia szary tekst za kursorem, a Esc ją zamyka. Nie działa w programach pełnoekranowych (vim, htop, tmux).')}>
        <input id="settings-ssh-autocomplete" className="setting-switch" type="checkbox" role="switch" checked={enabled}
          onChange={(e) => update((st) => updateSettings(st, { sshAutocomplete: e.target.checked }))} />
      </SettingRow>
      {readOnly && status?.file && (
        <div className="ssh-banner-warn" role="alert">
          {tr('Historia poleceń jest tylko do odczytu: plik {file} jest nieczytelny, ma nieprawidłowy format albo pochodzi z nowszej wersji aplikacji. Nowe polecenia nie są zapisywane, historii nie można wyczyścić, a plik pozostaje nietknięty. Napraw lub usuń ten plik i uruchom aplikację ponownie.', { file: status.file })}
        </div>
      )}
      {counts && !withHistory.length && <p className="muted">{tr('Brak zapisanej historii poleceń')}</p>}
      {withHistory.map((h) => (
        <SettingRow key={h.id} title={h.label} hint={tr('Poleceń w historii: {count}', { count: counts![h.id] })}>
          <button className="btn" disabled={readOnly} aria-label={`${tr('Wyczyść historię poleceń')}: ${h.label}`} onClick={() => void clear(h.id)}>{tr('Wyczyść')}</button>
        </SettingRow>
      ))}
      {withHistory.length > 1 && (
        <SettingRow title={tr('Wyczyść całą historię poleceń')}>
          <button className="btn danger" disabled={readOnly} onClick={() => void clear(null)}>{tr('Wyczyść')}</button>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}
