// 1.1.2: the "Konta i limity" settings section, named like the panel: the panel itself, the account switcher and the limit
// warnings (until 1.1.2 the last two lived under "Powiadomienia i dźwięki", the panel under "Agenci").
import { Select } from './Select';
import { SettingRow, SettingsGroup } from './SettingRow';
import { PercentSlider } from './PercentSlider';
import type { LimitAlertSettings, LimitWindowAlert } from '../../../shared/alerts';
import { AUTO_SWITCH_COOLDOWNS, enableAutoSwitch, type AutoSwitchSettings } from '../../../shared/autoSwitch';
import { USAGE_INTERVALS_MINUTES, type UsageProvider } from '../../../shared/usage';
import { updateSettings } from '../../../shared/state';
import { useUsage } from '../usage';
import { switchAccounts } from './UsageAutoSwitch';
import { useI18n } from '../i18n';
import { update, useStore } from '../store';

type Window = 'fiveHour' | 'sevenDay';

export function AccountsSettings() {
  const { tr } = useI18n();
  const settings = useStore((st) => st.s.settings);
  const showAiUsage = settings.showAiUsage;
  const alertsOn = settings.alerts.enabled;
  const limits = settings.alerts.limits;
  const autoSwitch = settings.accountSwitch;
  const { providers: usageCards } = useUsage();

  // Every edit reads the current state, so a slider saved after its pause never overwrites a change made in the meantime.
  const setLimits = (change: (current: LimitAlertSettings) => Partial<LimitAlertSettings>) =>
    update((st) => updateSettings(st, { alerts: { ...st.settings.alerts, limits: { ...st.settings.alerts.limits, ...change(st.settings.alerts.limits) } } }));
  const setAutoSwitch = (change: (current: AutoSwitchSettings) => Partial<AutoSwitchSettings>) =>
    update((st) => updateSettings(st, { accountSwitch: { ...st.settings.accountSwitch, ...change(st.settings.accountSwitch) } }));
  const notAvailable = showAiUsage ? undefined : tr('Działa tylko przy włączonym panelu „Konta i limity”.');

  /** One threshold row: the slider (any whole percent) and the window's own switch. */
  const thresholdRow = (kind: 'limit' | 'switch', id: Window, title: string) => {
    const config = kind === 'limit' ? limits[id] : autoSwitch[id];
    const groupOn = kind === 'limit' ? limits.enabled : autoSwitch.enabled;
    const set = (patch: Partial<LimitWindowAlert>) => {
      if (kind === 'limit') setLimits((current) => ({ [id]: { ...current[id], ...patch } }));
      else setAutoSwitch((current) => ({ [id]: { ...current[id], ...patch } }));
    };
    return <SettingRow title={title} htmlFor={`settings-${kind}-${id}`}>
      <PercentSlider id={`settings-${kind}-${id}-percent`} label={tr('Próg: {window}', { window: title })} value={config.percent} disabled={!groupOn || !config.enabled}
        onCommit={(percent) => set({ percent })} />
      <input id={`settings-${kind}-${id}`} className="setting-switch" type="checkbox" role="switch" checked={config.enabled} disabled={!groupOn}
        onChange={(e) => set({ enabled: e.target.checked })} />
    </SettingRow>;
  };

  /** "Przełączaj na" and "Konto podstawowe" of one provider: the accounts the panel knows (the saved choice stays listed). */
  const accountSelect = (provider: UsageProvider, field: 'target' | 'primary', title: string, none: string) => {
    const accounts = switchAccounts(usageCards, provider);
    const value = autoSwitch[field][provider] ?? '';
    const listed = value && !accounts.some((a) => a.key === value) ? [...accounts, { key: value, label: value }] : accounts;
    return <SettingRow title={title} htmlFor={`settings-switch-${field}-${provider}`}>
      <Select id={`settings-switch-${field}-${provider}`} className="select" value={value} disabled={!autoSwitch.enabled}
        onChange={(e) => { const key = e.target.value || undefined; setAutoSwitch((current) => ({ [field]: { ...current[field], [provider]: key } })); }}>
        <option value="">{none}</option>
        {listed.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
      </Select>
    </SettingRow>;
  };

  return <>
    <SettingsGroup title={tr('Panel boczny')}>
      <SettingRow title={tr('Pokazuj panel „Konta i limity”')} htmlFor="settings-ai-usage" hint={tr('Pasek zużycia limitów Claude i Codex w panelu bocznym.')}>
        <input id="settings-ai-usage" className="setting-switch" type="checkbox" role="switch" checked={showAiUsage} onChange={(e) => update((st) => updateSettings(st, { showAiUsage: e.target.checked }))} />
      </SettingRow>
      <SettingRow title={tr('Odświeżanie limitów')} htmlFor="settings-usage-interval" hint={tr('Jak często odświeżać zużycie limitów.')}>
        <Select id="settings-usage-interval" className="select" value={settings.usageIntervalMinutes}
          onChange={(e) => update((st) => updateSettings(st, { usageIntervalMinutes: Number(e.target.value) }))}>
          {USAGE_INTERVALS_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{tr('co {count} min', { count: minutes })}</option>)}
        </Select>
      </SettingRow>
    </SettingsGroup>
    {/* The switcher has its own settings key and is not silenced by the alerts master switch. */}
    <SettingsGroup title={tr('Switcher kont')} description={tr('Gdy konto główne przekroczy próg, aplikacja przełącza na wybrane konto albo na zapisane konto z największym zapasem (przy równym zapasie - z najwcześniejszym resetem): tylko z ważnym logowaniem, poniżej progów i takie, którego zasady cswap nie blokują. Nigdy w trakcie zamiany ani logowania, najwyżej raz na wybrany czas i nigdy z powrotem na konto opuszczone z powodu limitu przed jego resetem. Gdy żadne konto nie ma zapasu, konto główne zostaje, a aplikacja powie o tym raz. Otwarte sesje Claude działają dalej i przejmują nowe logowanie przy następnej wiadomości.')}>
      <SettingRow title={tr('Przełączaj konto Claude automatycznie')} htmlFor="settings-switch-enabled" hint={notAvailable}>
        <input id="settings-switch-enabled" className="setting-switch" type="checkbox" role="switch" checked={autoSwitch.enabled} onChange={(e) => { const on = e.target.checked; update((st) => updateSettings(st, { accountSwitch: on ? enableAutoSwitch(st.settings.accountSwitch, usageCards) : { ...st.settings.accountSwitch, enabled: false } })); }} />
      </SettingRow>
      {thresholdRow('switch', 'fiveHour', tr('Limit 5-godzinny'))}
      {thresholdRow('switch', 'sevenDay', tr('Limit 7-dniowy'))}
      <SettingRow title={tr('Gdy jest konto z zapasem')} htmlFor="settings-switch-mode">
        <Select id="settings-switch-mode" className="select" value={autoSwitch.mode} disabled={!autoSwitch.enabled} onChange={(e) => { const mode = e.target.value === 'switch' ? 'switch' : 'ask'; setAutoSwitch(() => ({ mode })); }}>
          <option value="ask">{tr('Zapytaj w powiadomieniu')}</option>
          <option value="switch">{tr('Przełącz od razu')}</option>
        </Select>
      </SettingRow>
      {accountSelect('claude', 'target', tr('Przełączaj na'), tr('Konto z największym zapasem'))}
      {accountSelect('claude', 'primary', tr('Konto podstawowe'), tr('Brak'))}
      <SettingRow title={tr('Wracaj na konto podstawowe po resecie')} htmlFor="settings-switch-return" hint={tr('Gdy konto podstawowe opuszczone z powodu limitu znowu jest poniżej progów po swoim resecie.')}>
        <input id="settings-switch-return" className="setting-switch" type="checkbox" role="switch" checked={autoSwitch.returnHome} disabled={!autoSwitch.enabled} onChange={(e) => { const returnHome = e.target.checked; setAutoSwitch(() => ({ returnHome })); }} />
      </SettingRow>
      <SettingRow title={tr('Najwyżej jedno przełączenie na')} htmlFor="settings-switch-cooldown">
        <Select id="settings-switch-cooldown" className="select" value={String(autoSwitch.cooldownMinutes)} disabled={!autoSwitch.enabled} onChange={(e) => { const cooldownMinutes = Number(e.target.value); setAutoSwitch(() => ({ cooldownMinutes })); }}>
          {AUTO_SWITCH_COOLDOWNS.map((minutes) => <option key={minutes} value={String(minutes)}>{tr('{minutes} min', { minutes })}</option>)}
        </Select>
      </SettingRow>
      <SettingRow title={tr('Także konta Codex')} htmlFor="settings-switch-codex" hint={tr('Konta Codex zapisane w aplikacji. Otwarte sesje Codex mogą korzystać z poprzedniego konta, dopóki nie uruchomisz ich ponownie.')}>
        <input id="settings-switch-codex" className="setting-switch" type="checkbox" role="switch" checked={autoSwitch.codex} disabled={!autoSwitch.enabled} onChange={(e) => { const codex = e.target.checked; setAutoSwitch(() => ({ codex })); }} />
      </SettingRow>
      {autoSwitch.codex && accountSelect('codex', 'target', `Codex: ${tr('Przełączaj na')}`, tr('Konto z największym zapasem'))}
      {autoSwitch.codex && accountSelect('codex', 'primary', `Codex: ${tr('Konto podstawowe')}`, tr('Brak'))}
    </SettingsGroup>
    {/* The warnings are notifications: the alerts master switch and quiet hours (Powiadomienia i dźwięki) still silence them. */}
    <SettingsGroup title={tr('Ostrzeżenia o limitach')} description={tr('Powiadomienie systemowe, gdy konto Claude lub Codex wykorzysta wybraną część limitu: raz na konto, okno i okres limitu, także po ponownym uruchomieniu aplikacji. Nie dotyczy kont z wygasłym logowaniem. Kliknięcie otwiera panel „Konta i limity”. Obowiązują główny przełącznik i godziny ciszy z sekcji „Powiadomienia i dźwięki”.')}>
      <SettingRow title={tr('Ostrzeżenia o limitach')} htmlFor="settings-limits-enabled"
        hint={!alertsOn ? tr('Powiadomienia są wyłączone w sekcji „Powiadomienia i dźwięki”, więc ostrzeżenia się nie pokażą.') : notAvailable}>
        <button type="button" className="btn alert-test" disabled={!limits.enabled || !alertsOn} aria-label={tr('Test: {event}', { event: tr('Ostrzeżenia o limitach') })} onClick={() => window.mc.testLimitAlert()}>{tr('Test')}</button>
        <input id="settings-limits-enabled" className="setting-switch" type="checkbox" role="switch" checked={limits.enabled} onChange={(e) => { const enabled = e.target.checked; setLimits(() => ({ enabled })); }} />
      </SettingRow>
      {thresholdRow('limit', 'fiveHour', tr('Limit 5-godzinny'))}
      {thresholdRow('limit', 'sevenDay', tr('Limit 7-dniowy'))}
      <SettingRow title={tr('Powiadom, gdy limit znowu jest dostępny')} htmlFor="settings-limits-resets" hint={tr('Po resecie okna, które przekroczyło próg.')}>
        <input id="settings-limits-resets" className="setting-switch" type="checkbox" role="switch" checked={limits.resets} disabled={!limits.enabled} onChange={(e) => { const resets = e.target.checked; setLimits(() => ({ resets })); }} />
      </SettingRow>
    </SettingsGroup>
  </>;
}
