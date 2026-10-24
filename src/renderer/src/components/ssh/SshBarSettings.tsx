// Settings > SSH, "Pasek stanu" (1.0.7): the switch of the SSH status bar, its items, and the cells where it was hidden.
import { shownBarItems, SSH_BAR_ITEMS } from '../../../../shared/sshBar';
import { updateSettings } from '../../../../shared/state';
import { useI18n } from '../../i18n';
import { update, useStore } from '../../store';
import { SettingRow, SettingsGroup } from '../SettingRow';
import { BAR_ITEM_LABELS, setBarItem, showBarEverywhere } from './SshStatusBar';

export function SshBarSettings() {
  const { tr } = useI18n();
  const enabled = useStore((st) => st.s.settings.sshStatusBar !== false);
  const toggles = useStore((st) => st.s.settings.sshStatusBarItems);
  const hiddenCells = useStore((st) => st.s.projects.reduce((n, p) => n + p.tabs.reduce((m, t) => m + t.cells.filter((c) => c.ssh && c.sshBarHidden).length, 0), 0));
  const shown = new Set(shownBarItems(toggles));
  return (
    <SettingsGroup title={tr('Pasek stanu')}>
      <SettingRow title={tr('Pasek stanu pod terminalami SSH')} htmlFor="settings-ssh-bar"
        hint={tr('Pod terminalem połączonej komórki SSH: system i nazwa hosta, procesor, pamięć, sieć, czas działania, zalogowani użytkownicy i zajętość dysku. Dane są odczytywane co 3 sekundy tym samym połączeniem SSH (krótki skrypt sh, bez ponownego logowania i bez wpisów w historii powłoki), tylko gdy komórka jest widoczna. Prawy przycisk myszy na pasku ukrywa go lub wybrane elementy.')}>
        <input id="settings-ssh-bar" className="setting-switch" type="checkbox" role="switch" checked={enabled}
          onChange={(e) => update((st) => updateSettings(st, { sshStatusBar: e.target.checked }))} />
      </SettingRow>
      {/* With the bar switched off its items cannot be changed: the row is dimmed, not only the inputs (1.0.7). */}
      <SettingRow title={<span className={enabled ? undefined : 'ssh-bar-setting-off'}>{tr('Elementy paska')}</span>}>
        <span className={`ssh-bar-setting-items${enabled ? '' : ' ssh-bar-setting-off'}`} aria-disabled={!enabled || undefined}>
          {SSH_BAR_ITEMS.map((item) => (
            <label key={item} className="check">
              <input type="checkbox" checked={shown.has(item)} disabled={!enabled || (shown.has(item) && shown.size === 1)}
                onChange={(e) => setBarItem(item, e.target.checked)} />
              {tr(BAR_ITEM_LABELS[item])}
            </label>
          ))}
        </span>
      </SettingRow>
      {hiddenCells > 0 && (
        <SettingRow title={tr('Komórki z ukrytym paskiem: {count}', { count: hiddenCells })}>
          <button className="btn" onClick={showBarEverywhere}>{tr('Pokaż we wszystkich')}</button>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}
