// "Skróty klawiszowe" in Settings: every shortcut of the app (registry: shared/shortcuts.ts) with its current keys, recording of a
// new combination, reset, disable, and the warnings for combinations another action already uses or that cannot be used at all.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { askChoice, update, useStore } from '../store';
import { updateSettings } from '../../../shared/state';
import {
  backspaceDisables, checkAssignment, comboParts, eventToCombo, GROUP_LABEL, resolveShortcuts, setOverride, SHORTCUT_DEFS, SHORTCUT_GROUPS, swapShortcut,
  type Combo, type Overrides, type ShortcutCheck, type ShortcutDef, type ShortcutResolution,
} from '../../../shared/shortcuts';
import type { MessageKey } from '../../../shared/i18n';
import { setShortcutRecording } from '../shortcuts';
import { settingsSearchMatches } from '../../../shared/settingsSearch';
import './shortcuts.css';

const platform = () => window.mc.platform;
const editOverrides = (fn: (current: Overrides) => Overrides) => update((st) => updateSettings(st, { shortcuts: fn(st.settings.shortcuts ?? {}) }));

const Warn = () => (
  <svg className="shortcut-warn-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="6.2" /><path d="M8 4.6v4M8 11.2v.1" strokeWidth="1.8" />
  </svg>
);

function Keycaps({ combo }: { combo: Combo }) {
  return <span className="keycaps">{comboParts(combo, platform()).map((part, index) => <kbd key={index} className="keycap">{part}</kbd>)}</span>;
}

type Pending = { combo: Combo; check: Extract<ShortcutCheck, { kind: 'conflict' }> };

interface RecorderProps {
  def: ShortcutDef;
  resolution: ShortcutResolution;
  onCommit: (combo: Combo | null, swap?: readonly ShortcutDef[]) => void;
  onCancel: () => void;
}

/** Captures the next key combination. While it is open the app's own shortcuts are off and every key press is swallowed. */
function Recorder({ def, resolution, onCommit, onCancel }: RecorderProps) {
  const { tr } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const swapButton = useRef<HTMLButtonElement>(null);
  const [held, setHeld] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Pending | null>(null);
  const settled = useRef(false);
  const latest = useRef<{ resolution: ShortcutResolution; conflict: Pending | null; onCommit: RecorderProps['onCommit']; onCancel: () => void }>({ resolution, onCommit, onCancel, conflict });
  latest.current = {
    resolution, conflict,
    onCommit: (combo, swap) => { if (!settled.current) { settled.current = true; onCommit(combo, swap); } },
    onCancel: () => { if (!settled.current) { settled.current = true; onCancel(); } },
  };

  useEffect(() => {
    setShortcutRecording(true);
    box.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const { resolution: current, onCommit: commit, onCancel: cancel, conflict: pending } = latest.current;
      const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
      if (pending) {
        // The conflict question owns the keyboard: Esc cancels, Tab stays between its two buttons, the rest is the buttons' own.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
        else if (event.key === 'Tab') {
          const buttons = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
          if (!buttons.length) return;
          event.preventDefault();
          event.stopPropagation();
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(at + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (bare && event.key === 'Escape') { cancel(); return; }
      if (bare && event.key === 'Backspace' && backspaceDisables(def)) { commit(null); return; }
      const combo = eventToCombo(event);
      if (!combo) {
        // Only modifiers so far: show what is held.
        setHeld(['Control', 'Alt', 'Shift', 'Meta'].filter((name) => event.getModifierState(name)).map((name) => name === 'Control' ? 'Ctrl' : name === 'Meta' ? (platform() === 'darwin' ? 'Cmd' : 'Win') : name === 'Alt' && platform() === 'darwin' ? 'Option' : name).join('+'));
        return;
      }
      setHeld('');
      const check = checkAssignment(def.id, combo, current, platform());
      if (check.ok) { commit(combo); return; }
      if (check.kind === 'reserved') { setWarning(tr('Nie można użyć tego skrótu: {reason}', { reason: tr(check.reason) })); return; }
      if (check.kind === 'conflict') { setWarning(null); setConflict({ combo, check }); return; }
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); setShortcutRecording(false); };
  }, [def.id]);
  useEffect(() => { if (conflict) swapButton.current?.focus(); }, [conflict]);

  const names = conflict ? conflict.check.with.map((other) => tr(other.label)).join(', ') : '';
  return (
    <div className="shortcut-recorder" ref={box} tabIndex={-1} role="group" aria-label={tr('Nagrywanie skrótu: {name}', { name: tr(def.label) })}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) latest.current.onCancel(); }}>
      {!conflict && <>
        <div className="shortcut-prompt">{backspaceDisables(def) ? tr('Naciśnij nowy skrót… Esc anuluje, Backspace wyłącza') : tr('Naciśnij nowy skrót… Esc anuluje, przycisk „Wyłącz” wyłącza skrót')}</div>
        {held && <div className="shortcut-held" aria-hidden="true">{held}+…</div>}
        {warning && <div className="shortcut-warning" role="alert"><Warn /><span>{warning}</span></div>}
      </>}
      {conflict && <div className="shortcut-conflict">
        <div className="shortcut-warning" role="alert">
          <Warn /><span><Keycaps combo={conflict.combo} /> {tr('Ten skrót jest już używany przez: {name}', { name: names })}</span>
        </div>
        <div className="shortcut-conflict-actions">
          {conflict.check.swappable
            ? <button type="button" className="btn small primary" ref={swapButton} onClick={() => latest.current.onCommit(conflict.combo, conflict.check.with)}>{tr('Zamień (przypisz tutaj i wyłącz tamten)')}</button>
            : <span className="muted">{tr('Tego skrótu nie można odebrać. Wybierz inny.')}</span>}
          <button type="button" className="btn small" ref={conflict.check.swappable ? undefined : swapButton} onClick={() => latest.current.onCancel()}>{tr('Anuluj')}</button>
        </div>
      </div>}
    </div>
  );
}

type Tr = ReturnType<typeof useI18n>['tr'];
const problemText = (problem: NonNullable<ShortcutResolution['problems'][string]>, names: (id: string) => string, tr: Tr): string => {
  switch (problem.kind) {
    case 'conflict': return tr('Zapisany skrót {keys} koliduje z akcją „{name}” i nie działa. Używany jest domyślny.', { keys: problem.stored, name: names(problem.with ?? '') });
    case 'reserved': return tr('Zapisany skrót {keys} nie może być użyty i nie działa: {reason} Używany jest domyślny.', { keys: problem.stored, reason: problem.reason ? tr(problem.reason) : '' });
    case 'fixed': return tr('Tego skrótu nie można zmieniać, zapisana wartość jest ignorowana.');
    default: return tr('Zapisany skrót jest nieprawidłowy i nie działa. Używany jest domyślny.');
  }
};

/** `search`: the query of the Settings search box (1.0.7); it replaces this page's own search field while it is set. */
export function ShortcutsSettings({ search }: { search?: string } = {}) {
  const { tr } = useI18n();
  const overrides = useStore((st) => st.s.settings.shortcuts);
  const resolution = useMemo(() => resolveShortcuts(overrides, platform()), [overrides]);
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const labelOf = (id: string) => tr((SHORTCUT_DEFS.find((def) => def.id === id)?.label ?? id) as MessageKey);
  const keysOf = (def: ShortcutDef): string => {
    const combo = resolution.combos[def.id];
    return combo ? comboParts(combo, platform()).join('+') : def.fixedText ? def.fixedText.replace(/\bMod\b/, platform() === 'darwin' ? 'Cmd' : 'Ctrl') : '';
  };

  const finish = (def: ShortcutDef, message: string) => {
    setRecording(null);
    setAnnounce(message);
    // The recorder is gone: the keyboard goes back to the row's button.
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-shortcut="${def.id}"] button`)?.focus());
  };
  const commit = (def: ShortcutDef, combo: Combo | null, swap: readonly ShortcutDef[] = []) => {
    editOverrides((current) => swap.length && combo ? swapShortcut(current, def.id, combo, swap, platform()) : setOverride(current, def.id, combo, platform()));
    finish(def, combo
      ? tr('Zapisano skrót: {name} - {keys}', { name: tr(def.label), keys: comboParts(combo, platform()).join('+') })
      : tr('Wyłączono skrót: {name}', { name: tr(def.label) }));
  };
  const reset = (def: ShortcutDef) => {
    editOverrides((current) => setOverride(current, def.id, undefined, platform()));
    setAnnounce(tr('Przywrócono domyślny skrót: {name}', { name: tr(def.label) }));
  };
  const resetAll = async () => {
    const choice = await askChoice(tr('Przywrócić wszystkie skróty do domyślnych?'), tr('Wszystkie własne i wyłączone skróty zostaną usunięte, a akcje wrócą do domyślnych klawiszy.'),
      [{ label: tr('Przywróć domyślne'), value: 'yes', danger: true }]);
    if (choice !== 'yes') return;
    editOverrides(() => ({}));
    setAnnounce(tr('Przywrócono wszystkie domyślne skróty.'));
  };

  const outside = search !== undefined;
  const needle = (outside ? search : query).trim().toLowerCase();
  const visible = (def: ShortcutDef) => !needle || (outside
    ? settingsSearchMatches(`${tr('Skróty klawiszowe')} ${tr(def.label)} ${tr(GROUP_LABEL[def.group])} ${keysOf(def)}`, needle)
    : [tr(def.label), tr(GROUP_LABEL[def.group]), keysOf(def)].some((text) => text.toLowerCase().includes(needle)));
  const changed = Object.keys(overrides ?? {}).length > 0;
  const groups = SHORTCUT_GROUPS.map((group) => ({ group, defs: SHORTCUT_DEFS.filter((def) => def.group === group && visible(def)) })).filter((entry) => entry.defs.length);

  return (
    <div className="shortcuts-settings" data-search-self={outside ? '' : undefined}>
      {!outside && <>
        <div className="muted">{tr('Kliknij „Zmień”, a potem naciśnij nową kombinację klawiszy. Dwie akcje nie mogą mieć tego samego skrótu, a klawisze zarezerwowane przez system i terminal są niedostępne.')}</div>
        <div className="shortcuts-toolbar">
          <input type="search" className="input" aria-label={tr('Szukaj skrótu')} placeholder={tr('Szukaj skrótu…')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" className="btn" disabled={!changed} onClick={() => void resetAll()}>{tr('Przywróć wszystkie domyślne')}</button>
        </div>
      </>}
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      {!groups.length && !outside && <div className="muted">{tr('Nic nie znaleziono.')}</div>}
      {groups.map(({ group, defs }) => (
        <section key={group} className="shortcut-group" aria-label={tr(GROUP_LABEL[group])}>
          <h3>{tr(GROUP_LABEL[group])}</h3>
          {defs.map((def) => {
            const combo = resolution.combos[def.id];
            const source = resolution.source[def.id];
            const problem = resolution.problems[def.id];
            const active = recording === def.id;
            const name = tr(def.label);
            return (
              <div key={def.id} className={`shortcut-row ${def.rebindable ? '' : 'fixed'} ${problem ? 'problem' : ''}`} role="group" aria-label={name} data-shortcut={def.id}>
                <div className="shortcut-name">
                  <span>{name}</span>
                  {problem && <span className="shortcut-badge bad" title={problemText(problem, labelOf, tr)}><Warn /><span className="sr-only">{problemText(problem, labelOf, tr)}</span></span>}
                  {source === 'custom' && <span className="shortcut-badge">{tr('Własny')}</span>}
                  {source === 'disabled' && <span className="shortcut-badge">{tr('Wyłączony')}</span>}
                </div>
                <div className="shortcut-keys">
                  {active
                    ? <Recorder def={def} resolution={resolution} onCommit={(next, swap) => commit(def, next, swap)} onCancel={() => finish(def, tr('Anulowano zmianę skrótu: {name}', { name }))} />
                    : combo ? <Keycaps combo={combo} />
                      : def.fixedText ? <span className="keycaps"><kbd className="keycap">{keysOf(def)}</kbd></span>
                        : <span className="muted">{tr('Brak skrótu')}</span>}
                </div>
                {def.rebindable && !active && (
                  <div className="shortcut-actions">
                    <button type="button" className="btn small" aria-label={`${tr('Zmień')}: ${name}`} onClick={() => setRecording(def.id)}>{tr('Zmień')}</button>
                    <button type="button" className="btn small ghost hover-only" aria-label={`${tr('Wyłącz')}: ${name}`} disabled={source === 'disabled'} onClick={() => commit(def, null)}>{tr('Wyłącz')}</button>
                    <button type="button" className="btn small ghost" aria-label={`${tr('Domyślny')}: ${name}`} disabled={source === 'default' && !problem} onClick={() => reset(def)}>{tr('Domyślny')}</button>
                  </div>
                )}
                {problem && !active && <div className="shortcut-warning" role="note"><Warn /><span>{problemText(problem, labelOf, tr)}</span></div>}
                {!def.rebindable && def.reason && <div className="shortcut-reason muted">{tr('Tego skrótu nie można zmienić.')} {tr(def.reason)}</div>}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
