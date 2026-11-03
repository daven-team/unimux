// 1.1.2: the Switcher's options as a card anchored to the limits panel (instead of a plain context menu): on/off, the mode,
// the target and primary account per provider, returning home, both thresholds and a link to Settings > Konta i limity.
// Every change applies at once (the sliders after a short pause). Esc or a click elsewhere closes it; it opens over the side
// panel when it fits there, otherwise to the right of the panel, and scrolls inside when the window is short.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { accountKey, enableAutoSwitch, type AutoSwitchSettings } from '../../../shared/autoSwitch';
import { effectivePercent, type ProviderUsage, type UsageProvider } from '../../../shared/usage';
import { useI18n } from '../i18n';
import { PercentSlider } from './PercentSlider';
import { Select } from './Select';
import { openAccountSettings, setAutoSwitch, switchUseful } from './UsageAutoSwitch';
import './switcherPopover.css';

const NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' };
const GAP = 6;
const MARGIN = 8;

/** "a@x.com · Max · 5 h 12% · 7 d 40%": the accounts of a provider the switch can name, with their plan and current use. */
function accountOptions(providers: ProviderUsage[], provider: UsageProvider, now: number): Array<{ key: string; label: string }> {
  const seen = new Set<string>();
  return providers.filter((u) => u.provider === provider && u.status !== 'signedOut' && (u.active || u.managed)).flatMap((u) => {
    const key = accountKey(u);
    if (seen.has(key)) return [];
    seen.add(key);
    const use = u.windows.map((w) => `${w.id === '5h' ? '5 h' : '7 d'} ${Math.round(effectivePercent(w, now))}%`);
    return [{ key, label: [u.email || NAMES[provider], u.plan, ...use].filter(Boolean).join(' · ') }];
  });
}

export function SwitcherPopover({ anchor, panel, settings, providers, onClose }: {
  anchor: HTMLElement;
  panel: HTMLElement | null;
  settings: AutoSwitchSettings;
  providers: ProviderUsage[];
  onClose: () => void;
}) {
  const { tr } = useI18n();
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const on = settings.enabled;
  const now = Date.now();
  const hasCodex = providers.some((u) => u.provider === 'codex');

  const place = useCallback(() => {
    const el = card.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const box = (panel?.closest('.side-panel') ?? panel)?.getBoundingClientRect() ?? a;
    const width = el.offsetWidth;
    const height = el.scrollHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxHeight = vh - 2 * MARGIN;
    const shown = Math.min(height, maxHeight);
    let left: number;
    let top: number;
    if (box.width >= width + 2 * GAP) {
      // Over the side panel, under (or above) the row it opened from.
      left = Math.max(box.left + GAP, Math.min(a.left, box.right - GAP - width));
      top = a.bottom + 4 + shown <= vh - MARGIN ? a.bottom + 4 : a.top - 4 - shown;
    } else {
      // A narrow side panel: to its right (or left when the window has no room there), level with the row.
      left = box.right + GAP + width <= vw - MARGIN ? box.right + GAP : box.left - GAP - width;
      top = a.top;
    }
    left = Math.max(MARGIN, Math.min(left, vw - MARGIN - width));
    top = Math.max(MARGIN, Math.min(top, vh - MARGIN - shown));
    setPos({ left, top, maxHeight });
  }, [anchor, panel]);
  useLayoutEffect(() => { place(); }, [place, settings.codex, hasCodex]);

  // Focus moves into the card when it opens; Esc gives it back to where it came from (a click elsewhere keeps its own).
  const restore = useRef(false);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    return () => { if (restore.current && from && document.contains(from)) from.focus({ preventScroll: true }); };
  }, []);
  // The card is hidden until it is placed (a hidden element takes no focus): the focus moves in once it shows.
  const placed = pos !== null;
  useEffect(() => {
    if (placed) card.current?.querySelector<HTMLElement>('.switcher-pop-toggle')?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    // A list opened from a select of the card lives in its own portal: it is part of the card for these checks.
    const inside = (target: EventTarget | null) => target instanceof Node && (card.current?.contains(target) || anchor.contains(target) || !!(target as Element).closest?.('.select-popup'));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.select-popup')) return;
      e.preventDefault();
      e.stopPropagation();
      restore.current = true;
      onClose();
    };
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) onClose(); };
    const onFocus = (e: FocusEvent) => { if (e.target instanceof Node && e.target !== document.body && !inside(e.target)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('focusin', onFocus, true);
    window.addEventListener('resize', place);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('focusin', onFocus, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('blur', onClose);
    };
  }, [anchor, onClose, place]);

  const set = (change: Partial<AutoSwitchSettings> | ((current: AutoSwitchSettings) => Partial<AutoSwitchSettings>)) =>
    setAutoSwitch((current) => ({ ...current, ...(typeof change === 'function' ? change(current) : change) }));
  const toggle = () => setAutoSwitch((current) => (current.enabled ? { ...current, enabled: false } : enableAutoSwitch(current, providers)));

  const modes = [{ id: 'ask', label: tr('Zapytaj') }, { id: 'switch', label: tr('Przełącz od razu') }] as const;
  const modeKeys = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 'ask' : e.key === 'End' ? 'switch' : settings.mode === 'ask' ? 'switch' : 'ask';
    set({ mode: next });
    card.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };

  const accountRows = (provider: UsageProvider) => {
    const options = accountOptions(providers, provider, now);
    const prefix = provider === 'codex' ? 'Codex: ' : '';
    const select = (field: 'target' | 'primary', title: string, none: string) => {
      const value = settings[field][provider] ?? '';
      const listed = value && !options.some((o) => o.key === value) ? [...options, { key: value, label: value }] : options;
      const id = `switcher-pop-${field}-${provider}`;
      return <div className="switcher-pop-field">
        <label htmlFor={id}>{prefix}{title}</label>
        <Select id={id} className="select switcher-pop-select" value={value} disabled={!on}
          onChange={(e) => { const key = e.target.value || undefined; set((current) => ({ [field]: { ...current[field], [provider]: key } })); }}>
          <option value="">{none}</option>
          {listed.map((o) => <option key={o.key} value={o.key} title={o.label}>{o.label}</option>)}
        </Select>
      </div>;
    };
    return <div key={provider} className="switcher-pop-accounts">
      {select('target', tr('Przełączaj na'), tr('Największy zapas'))}
      {select('primary', tr('Konto podstawowe'), tr('Brak'))}
    </div>;
  };
  const shownProviders = (['claude', 'codex'] as const).filter((p) => switchUseful(providers, p) && (p === 'claude' || settings.codex));

  return createPortal(
    <div ref={card} role="dialog" aria-label={tr('Switcher')} className={`switcher-pop ${pos ? 'on' : ''}`}
      style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : undefined}
      // React events bubble through the portal to the panel: its own menus are not for the card.
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div className="switcher-pop-head">
        <div className="switcher-pop-title">
          <span className={`switcher-pop-dot ${on ? 'on' : ''}`} aria-hidden />
          <label htmlFor="switcher-pop-enabled">{tr('Switcher')}</label>
        </div>
        <input id="switcher-pop-enabled" className="setting-switch switcher-pop-toggle" type="checkbox" role="switch" checked={on} onChange={toggle}
          aria-describedby="switcher-pop-state" />
      </div>
      <p id="switcher-pop-state" className="switcher-pop-state">
        {on ? tr('Pilnuje limitów konta głównego i przełącza, gdy przekroczy próg.') : tr('Wyłączony. Włącz, aby przełączać konto przy limicie.')}
      </p>
      <fieldset className="switcher-pop-body" disabled={!on}>
        <div className="switcher-pop-field">
          <span className="switcher-pop-label" id="switcher-pop-mode">{tr('Gdy jest konto z zapasem')}</span>
          <div className="switcher-pop-segments" role="radiogroup" aria-labelledby="switcher-pop-mode">
            {modes.map((m) => <button key={m.id} type="button" role="radio" data-mode={m.id} aria-checked={settings.mode === m.id}
              tabIndex={settings.mode === m.id ? 0 : -1} className={settings.mode === m.id ? 'on' : ''}
              onClick={() => set({ mode: m.id })} onKeyDown={modeKeys}>{m.label}</button>)}
          </div>
        </div>
        {shownProviders.map(accountRows)}
        <div className="switcher-pop-thresholds">
          {(['fiveHour', 'sevenDay'] as const).map((id) => {
            const title = id === 'fiveHour' ? tr('Limit 5-godzinny') : tr('Limit 7-dniowy');
            return <div key={id} className="switcher-pop-threshold">
              <span className="switcher-pop-label">{title}</span>
              <PercentSlider id={`switcher-pop-${id}`} label={tr('Próg: {window}', { window: title })} value={settings[id].percent} disabled={!on || !settings[id].enabled}
                onCommit={(percent) => set((current) => ({ [id]: { ...current[id], percent } }))} />
            </div>;
          })}
        </div>
        <label className="switcher-pop-switch" htmlFor="switcher-pop-return">
          <span>{tr('Wracaj na konto podstawowe po resecie')}</span>
          <input id="switcher-pop-return" className="setting-switch" type="checkbox" role="switch" checked={settings.returnHome} onChange={(e) => set({ returnHome: e.target.checked })} />
        </label>
        {hasCodex && <label className="switcher-pop-switch" htmlFor="switcher-pop-codex">
          <span>{tr('Także konta Codex')}</span>
          <input id="switcher-pop-codex" className="setting-switch" type="checkbox" role="switch" checked={settings.codex} onChange={(e) => set({ codex: e.target.checked })} />
        </label>}
      </fieldset>
      <div className="switcher-pop-foot">
        <button type="button" className="switcher-pop-link" onClick={() => { onClose(); openAccountSettings(); }}>{tr('Wszystkie ustawienia…')}</button>
      </div>
    </div>,
    document.body,
  );
}
