// Colour themes of SSH terminals (shared/sshThemes.ts): the theme tiles of Settings > SSH and the host form's picker.
// A choice applies at once: CellView hands the resolved theme to the open terminals.
import { useId, useRef, type KeyboardEvent } from 'react';
import {
  FOLLOW_GLOBAL_THEME, hostThemeFromValue, hostThemeValue, resolveSshTheme, SSH_THEMES, sshThemeById, type SshTheme, type SshThemeId, type TerminalPalette,
} from '../../../../shared/sshThemes';
import { updateSettings } from '../../../../shared/state';
import { useI18n } from '../../i18n';
import { update, useStore } from '../../store';
import { ICheck } from '../icons';
import { Select } from '../Select';
import { SettingsGroup } from '../SettingRow';
import './sshTheme.css';

/** The strip under a preview: the six accent colours of the theme. */
const PALETTE: ReadonlyArray<keyof TerminalPalette> = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

/** A small picture of a terminal in the theme: a prompt with a command, some output, the cursor and the palette strip. */
export function SshThemePreview({ theme, compact = false }: { theme: SshTheme; compact?: boolean }) {
  const c = theme.colors;
  const line = (parts: Array<[string, number]>) => (
    <span className="ssh-theme-line">{parts.map(([color, width], i) => <span key={i} style={{ background: color, width: `${width}%` }} />)}</span>
  );
  return (
    <span className={`ssh-theme-preview${compact ? ' compact' : ''}`} style={{ background: c.background }} aria-hidden="true">
      {line([[c.green, 24], [c.blue, 14], [c.foreground, 32]])}
      {!compact && <>
        {line([[c.foreground, 64]])}
        {line([[c.red, 18], [c.foreground, 28], [c.yellow, 16]])}
      </>}
      {line([[c.magenta, 20], [c.cyan, 26], [c.cursor, 6]])}
      <span className="ssh-theme-palette">{PALETTE.map((key) => <span key={key} style={{ background: c[key] }} />)}</span>
    </span>
  );
}

/** Settings > SSH: the theme of every SSH terminal, as preview tiles (a radio group: arrows move the choice). */
export function SshThemeSettings() {
  const { tr } = useI18n();
  const current = useStore((st) => st.s.settings.sshTheme);
  const tiles = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(0, SSH_THEMES.findIndex((t) => t.id === current));
  const choose = (id: SshThemeId) => { if (id !== current) update((s) => updateSettings(s, { sshTheme: id })); };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = SSH_THEMES.length - 1;
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
    if (next === undefined) return;
    event.preventDefault();
    choose(SSH_THEMES[next].id);
    tiles.current[next]?.focus();
  };
  return (
    <SettingsGroup title={tr('Motyw terminala SSH')} description={tr('Kolory terminali w komórkach SSH. Zmiana działa od razu, także w otwartych sesjach. Terminale lokalne i agenci zachowują wygląd aplikacji, a każdy host może mieć własny motyw w swoich ustawieniach.')}>
      <div className="ssh-theme-tiles" role="radiogroup" aria-label={tr('Motyw terminala SSH')}>
        {SSH_THEMES.map((theme, index) => {
          const on = index === selected;
          return (
            <button key={theme.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={`ssh-theme-tile${on ? ' on' : ''}`}
              ref={(element) => { tiles.current[index] = element; }} onClick={() => choose(theme.id)} onKeyDown={(event) => onKeyDown(event, index)}>
              <SshThemePreview theme={theme} />
              <span className="ssh-theme-name"><span className="grow">{theme.name}</span>{on && <ICheck />}</span>
            </button>
          );
        })}
      </div>
    </SettingsGroup>
  );
}

/** The host form's theme: one of the themes, or the one of Settings > SSH (stored as no `theme` on the host). */
export function SshThemeSelect({ value, onChange }: { value: string | undefined; onChange: (theme: SshThemeId | undefined) => void }) {
  const { tr } = useI18n();
  const labelId = useId();
  const setting = useStore((st) => st.s.settings.sshTheme);
  return (
    <div className="ssh-field">
      <span id={labelId}>{tr('Motyw terminala')}</span>
      <div className="ssh-row ssh-theme-select">
        <Select className="select grow" aria-labelledby={labelId} value={hostThemeValue(value)} onChange={(e) => onChange(hostThemeFromValue(e.target.value))}>
          <option value={FOLLOW_GLOBAL_THEME} title={tr('Motyw dla wszystkich hostów zmienisz w Ustawienia > SSH.')}>{tr('Jak w ustawieniach ({name})', { name: sshThemeById(setting).name })}</option>
          {SSH_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
        </Select>
        <SshThemePreview theme={resolveSshTheme(value, setting)} compact />
      </div>
    </div>
  );
}
