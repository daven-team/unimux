import { Select } from './Select';
import { SettingRow, SettingsGroup } from './SettingRow';
import { ColorPicker } from './ColorPicker';
import { ProfileOptions } from './ProfileOptions';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { pickLanguage, useI18n } from '../i18n';
import { update, useStore } from '../store';
import { updateSettings, upsertProfile, removeProfile, uid } from '../../../shared/state';
import type { CliKind, ShellKind } from '../../../shared/types';
import { normalizeUpdateMode } from '../../../shared/updateMode';
import { AlertsSettings } from './AlertsSettings';
import { ShortcutsSettings } from './ShortcutsSettings';
import { isLanguage, LANGUAGES } from '../../../shared/languages';
import { shellsForPlatform } from '../../../shared/platform';
import { shownProfileName } from '../../../shared/profiles';
import { USAGE_INTERVALS_MINUTES } from '../../../shared/usage';
import { BACKGROUND_LOAD_MODES, BACKGROUND_MAX_CELLS, normalizeBackgroundLoad, type BackgroundLoadMode } from '../../../shared/backgroundLoad';
import type { MessageKey } from '../../../shared/i18n';
import { DEFAULT_SCROLLBACK_LINES, normalizeScrollback, SCROLLBACK_CHOICES } from '../../../shared/terminalLimits';
import { normalizeStripScope } from '../../../shared/workspaceOrder';
import { searchText, settingsSearchMatches } from '../../../shared/settingsSearch';
import { ISearch, IX, TSettings } from './icons';
import { SshSettings } from './ssh/SshSettings';

const BACKGROUND_LABEL: Record<BackgroundLoadMode, MessageKey> = { visible: 'Tylko widoczne (jak dotąd)', project: 'Zakładki aktywnego projektu', all: 'Wszystkie projekty' };
const BACKGROUND_HINT: Record<BackgroundLoadMode, MessageKey> = {
  visible: 'Sesje startują dopiero po otwarciu zakładki. Zakładki bez uruchomionych sesji nie pokazują statusu ani alertów.',
  project: 'Pozostałe zakładki aktywnego projektu startują w tle (do {max} sesji po uruchomieniu). Inne projekty i reszta sesji startują po otwarciu.',
  all: 'Zakładki wszystkich projektów startują w tle, po kolei (do {max} sesji po uruchomieniu). Reszta startuje po otwarciu. Zużywa więcej pamięci i procesora.',
};
// 1.0.7: six sections instead of eight. Updates joined the general settings; the AI account limits sit with the agent profiles.
const sections = ["Ogólne", "Terminal", "Powiadomienia i dźwięki", "Agenci", "Skróty klawiszowe", "SSH"] as const;

/**
 * Hides, inside the rendered sections, what does not match the search: the rows of a settings card, then the groups and sections
 * left without a row. A hit in a section or group title keeps all of it. Marks with data-search-hidden (display: none in CSS),
 * so React's own markup stays as it is; returns whether anything is left.
 */
function applySearch(root: HTMLElement, query: string): boolean {
  for (const el of root.querySelectorAll('[data-search-hidden]')) el.removeAttribute('data-search-hidden');
  const hide = (el: Element) => el.setAttribute('data-search-hidden', '');
  const hit = (el: Element | null | undefined) => !!el && settingsSearchMatches(el.textContent ?? '', query);
  let any = false;
  for (const section of root.querySelectorAll<HTMLElement>('.settings-section')) {
    const sectionHit = hit(section.querySelector(':scope > h2'));
    let sectionAny = false;
    // The shortcuts list filters itself (ShortcutsSettings gets the query): it counts when it still shows a row.
    for (const self of section.querySelectorAll('[data-search-self]')) {
      if (sectionHit || self.querySelector('.shortcut-row')) sectionAny = true;
      else hide(self.closest('.settings-group') ?? self);
    }
    for (const group of section.querySelectorAll<HTMLElement>('.settings-group')) {
      if (group.querySelector('[data-search-self]')) continue;
      const groupHit = sectionHit || hit(group.querySelector(':scope > .settings-group-title')) || hit(group.querySelector(':scope > .settings-group-desc'));
      const rows = Array.from(group.querySelectorAll(':scope > .settings-card > *'));
      let groupAny = groupHit && !rows.length;
      for (const row of rows) {
        if (groupHit || hit(row)) groupAny = true;
        else hide(row);
      }
      if (groupAny) sectionAny = true;
      else hide(group);
    }
    if (!sectionAny) hide(section);
    any ||= sectionAny;
  }
  return any;
}

export function SettingsPage() {
  const { tr, language } = useI18n();
  // Only the slices shown here: the page stays mounted (hidden) after a visit and must not re-render on every state edit.
  const settings = useStore((st) => st.s.settings);
  const profiles = useStore((st) => st.s.profiles);
  const [section, setSection] = useState(0);
  const [query, setQuery] = useState('');
  const [noMatch, setNoMatch] = useState(false);
  const settingsId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searching = searchText(query) !== '';
  const selectSection = (index: number) => {
    setSection(index);
    setQuery('');
    contentRef.current?.scrollTo({ top: 0 });
  };
  const setSetting = (patch: Partial<typeof settings>) => update((st) => updateSettings(st, patch));
  // While searching, a section may re-render on its own (a list loads, a setting changes) and add rows: the filter runs again
  // on every change of the markup (only childList, so its own data-search-hidden marks do not trigger it).
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    if (!searching) { setNoMatch(false); return; }
    const run = () => setNoMatch(!applySearch(root, query));
    run();
    let frame = 0;
    const observer = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(run); });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [searching, query]);

  const body = (index: number): ReactNode => {
    switch (index) {
      case 0: return <>
        <SettingsGroup>
          <SettingRow title={tr('Język aplikacji')} htmlFor="settings-language" hint={tr('Zmiana języka działa od razu.')}>
            <Select id="settings-language" className="select" value={language} onChange={(event) => {
              // The new language's texts load first, so the page never shows untranslated keys.
              if (isLanguage(event.target.value)) pickLanguage(event.target.value, (language) => setSetting({ language }));
            }}>
              {LANGUAGES.map((option) => <option key={option.code} value={option.code} lang={option.code}>{option.name}</option>)}
            </Select>
          </SettingRow>
          <SettingRow title={tr('Pytaj przed zamknięciem pracujących agentów')} htmlFor="settings-confirm-close" hint={tr('Zamknięcie zakładki, komórki lub aplikacji, gdy agent Claude lub Codex jest w trakcie tury, najpierw pyta o potwierdzenie.')}>
            <input id="settings-confirm-close" className="setting-switch" type="checkbox" role="switch" checked={settings.confirmCloseWorking} onChange={(e) => setSetting({ confirmCloseWorking: e.target.checked })} />
          </SettingRow>
          <SettingRow title={tr('Karty na górnym pasku')} htmlFor="settings-strip-scope" hint={tr(settings.stripScope === 'project'
            ? 'Pasek pokazuje tylko gridy i pliki aktywnego projektu (oraz karty spoza projektów). Wybór innego projektu po lewej pokazuje jego karty.'
            : 'Pasek pokazuje otwarte gridy i pliki wszystkich projektów naraz.')}>
            <Select id="settings-strip-scope" className="select" value={settings.stripScope}
              onChange={(e) => setSetting({ stripScope: normalizeStripScope(e.target.value) })}>
              <option value="all">{tr('Wszystkich projektów')}</option>
              <option value="project">{tr('Tylko aktywnego projektu')}</option>
            </Select>
          </SettingRow>
        </SettingsGroup>
        <SettingsGroup title={tr('Aktualizacje')}>
          <SettingRow title={tr('Sposób instalowania aktualizacji')} htmlFor="settings-updates" hint={{
              manual: tr('Aplikacja startuje od razu. Aktualizacje pobierają się w tle, a przycisk w stopce zainstaluje je, gdy zechcesz.'),
              ask: tr('Przy starcie aplikacja sprawdza aktualizacje i pyta, czy zainstalować od razu. Pobieranie rusza w tle już podczas pytania. „Później” uruchamia obecną wersję, a przycisk w stopce zainstaluje aktualizację.'),
            }[settings.updateMode]}>
            <Select id="settings-updates" className="select" value={settings.updateMode}
              onChange={(e) => setSetting({ updateMode: normalizeUpdateMode(e.target.value) })}>
              <option value="ask">{tr('Automatycznie')}</option>
              <option value="manual">{tr('Ręcznie')}</option>
            </Select>
          </SettingRow>
        </SettingsGroup>
      </>;
      case 1: return <SettingsGroup>
        <SettingRow title={tr("Rozmiar czcionki terminala (nowe komórki)")} htmlFor="settings-font-size" hint={tr('Dotyczy nowo otwieranych komórek terminala.')}>
          <input id="settings-font-size" className="input" type="number" min={8} max={32} value={settings.fontSize} style={{ width: 72 }}
            onChange={(e) => setSetting({ fontSize: Math.max(8, Math.min(32, Number(e.target.value) || 13)) })} />
        </SettingRow>
        <SettingRow title={tr("Shell")} htmlFor="settings-shell" hint={tr('Powłoka uruchamiana w nowych komórkach shell.')}>
          <Select id="settings-shell" className="select" value={settings.shell} onChange={(e) => setSetting({ shell: e.target.value as ShellKind })}>
            {shellsForPlatform(window.mc.platform).map((shell) => <option key={shell.code} value={shell.code}>{shell.name}</option>)}
          </Select>
        </SettingRow>
        <SettingRow title={tr('Historia przewijania terminala')} htmlFor="settings-scrollback" hint={tr('Ile wierszy historii trzyma każdy terminal. Więcej wierszy to więcej pamięci. Zmiana działa od razu we wszystkich terminalach; zmniejszenie usuwa najstarsze wiersze.')}>
          <Select id="settings-scrollback" className="select" value={settings.scrollbackLines}
            onChange={(e) => setSetting({ scrollbackLines: normalizeScrollback(Number(e.target.value)) })}>
            {SCROLLBACK_CHOICES.map((lines) => <option key={lines} value={lines}>
              {tr(lines === DEFAULT_SCROLLBACK_LINES ? '{count} wierszy (domyślnie)' : '{count} wierszy', { count: lines.toLocaleString(language) })}
            </option>)}
          </Select>
        </SettingRow>
        <SettingRow title={tr('Wczytywanie sesji w tle po uruchomieniu')} htmlFor="settings-background-load" hint={tr(BACKGROUND_HINT[settings.backgroundLoad], { max: BACKGROUND_MAX_CELLS })}>
          <Select id="settings-background-load" className="select" value={settings.backgroundLoad}
            onChange={(e) => setSetting({ backgroundLoad: normalizeBackgroundLoad(e.target.value) })}>
            {BACKGROUND_LOAD_MODES.map((mode) => <option key={mode} value={mode}>{tr(BACKGROUND_LABEL[mode])}</option>)}
          </Select>
        </SettingRow>
      </SettingsGroup>;
      case 2: return <AlertsSettings />;
      case 3: return <>
        <SettingsGroup title={tr('Limity kont AI')}>
          <SettingRow title={tr('Pokazuj limity kont AI')} htmlFor="settings-ai-usage" hint={tr('Pasek zużycia limitów Claude i Codex w panelu bocznym.')}>
            <input id="settings-ai-usage" className="setting-switch" type="checkbox" role="switch" checked={settings.showAiUsage} onChange={(e) => setSetting({ showAiUsage: e.target.checked })} />
          </SettingRow>
          <SettingRow title={tr('Odświeżanie limitów')} htmlFor="settings-usage-interval" hint={tr('Jak często odświeżać zużycie limitów.')}>
            <Select id="settings-usage-interval" className="select" value={settings.usageIntervalMinutes}
              onChange={(e) => setSetting({ usageIntervalMinutes: Number(e.target.value) })}>
              {USAGE_INTERVALS_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{tr('co {count} min', { count: minutes })}</option>)}
            </Select>
          </SettingRow>
        </SettingsGroup>
        <section className="settings-group settings-group-head">
          <h3 className="settings-group-title">{tr('Profile agentów')}</h3>
          <p className="settings-group-desc">{tr('Profil to gotowy sposób uruchamiania agenta: wybierasz polecenie (Claude, Codex lub zwykła powłoka), nazwę, kolor i opcje startowe. Każda nowa komórka z tym profilem startuje z tymi opcjami.')}</p>
        </section>
        {profiles.map((p) => (
          <SettingsGroup key={p.id}>
            <div className="profile-card" role="group" aria-label={shownProfileName(p, settings.shell, tr) || tr('Nowy profil')}>
              <div className="profile-head">
                <ColorPicker value={p.color} label={`${tr('Kolor')}: ${shownProfileName(p, settings.shell, tr)}`} onChange={(color) => update((st) => upsertProfile(st, { ...p, color }))} />
                <input id={`settings-profile-name-${p.id}`} className="input profile-name" aria-label={tr('Nazwa')} value={shownProfileName(p, settings.shell, tr)} placeholder={tr('Nazwa')} onChange={(e) => update((st) => upsertProfile(st, { ...p, name: e.target.value }))} />
                <Select id={`settings-profile-cli-${p.id}`} className="select profile-cli" aria-label="CLI" value={p.cli} onChange={(e) => update((st) => upsertProfile(st, { ...p, cli: e.target.value as CliKind }))}>
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                  <option value="shell">shell</option>
                </Select>
                <button className="btn ghost icon" aria-label={tr('Usuń profil')} title={tr("Usuń profil")} onClick={() => update((st) => removeProfile(st, p.id))}><IX /></button>
              </div>
              <ProfileOptions profile={p} onChange={(args) => update((st) => upsertProfile(st, { ...p, args }))} />
            </div>
          </SettingsGroup>
        ))}
        {!searching && <div>
          <button className="btn" onClick={() => update((st) => upsertProfile(st, { id: uid(), name: tr("Nowy profil"), cli: 'claude', args: '', color: '#8b5cf6' }))}>{tr("+ Dodaj profil")}</button>
        </div>}
      </>;
      case 4: return <SettingsGroup><ShortcutsSettings search={searching ? query : undefined} /></SettingsGroup>;
      default: return <SshSettings />;
    }
  };

  return <div className="settings-page">
    <nav className="settings-nav" aria-label={tr('Ustawienia')}>
      <div className="settings-nav-title"><TSettings />{tr('Ustawienia')}</div>
      <label className="settings-search">
        <ISearch />
        <input type="search" aria-label={tr('Szukaj w ustawieniach')} placeholder={tr('Szukaj w ustawieniach') + '…'} value={query}
          onChange={(e) => { setQuery(e.target.value); contentRef.current?.scrollTo({ top: 0 }); }}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); } }} />
      </label>
      <div role="tablist" aria-label={tr('Ustawienia')} aria-orientation="vertical">
        {sections.map((label, index) => <button key={label} type="button" role="tab"
          id={`${settingsId}-section-${index}`} aria-controls={`${settingsId}-content`} aria-selected={!searching && section === index}
          tabIndex={section === index ? 0 : -1} ref={(element) => { sectionRefs.current[index] = element; }}
          className={!searching && section === index ? 'on' : ''} onClick={() => selectSection(index)}
          onKeyDown={(event) => {
            const next = event.key === 'ArrowDown' ? (index + 1) % sections.length
              : event.key === 'ArrowUp' ? (index + sections.length - 1) % sections.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : undefined;
            if (next === undefined) return;
            event.preventDefault();
            selectSection(next);
            sectionRefs.current[next]?.focus();
          }}>{tr(label)}</button>)}
      </div>
    </nav>
    <div className="settings-content" ref={contentRef} role="tabpanel" id={`${settingsId}-content`}
      aria-labelledby={searching ? undefined : `${settingsId}-section-${section}`} aria-label={searching ? tr('Szukaj w ustawieniach') : undefined} tabIndex={0}>
      {searching
        ? <>
          {sections.map((label, index) => <section key={label} className="settings-section">
            <h2>{tr(label)}</h2>
            <div className="settings-groups">{body(index)}</div>
          </section>)}
          {noMatch && <p className="settings-no-match">{tr('Nic nie znaleziono.')}</p>}
        </>
        : <>
          <h2>{tr(sections[section])}</h2>
          <div className="settings-groups">{body(section)}</div>
        </>}
    </div>
  </div>;
}
