// 1.1.2: the automatic account switch in the limits panel (a subtle state line opening the Switcher card) and the drag handle on
// the panel's top edge that makes it taller or shorter.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { accountKey, autoSwitchOn, autoSwitchStatus, type AutoSwitchSettings } from '../../../shared/autoSwitch';
import { updateSettings } from '../../../shared/state';
import { claudeLoginActions, type ProviderUsage, type UsageProvider } from '../../../shared/usage';
import { useI18n } from '../i18n';
import { setUi, update } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { settingsSectionIndex } from '../settingsSections';

const NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' };

/** The accounts of a provider the switch can name (main and saved, with an e-mail or card id), for the menus and settings. */
export function switchAccounts(providers: ProviderUsage[], provider: UsageProvider): Array<{ key: string; label: string }> {
  const seen = new Set<string>();
  return providers.filter((usage) => usage.provider === provider && usage.status !== 'signedOut' && (usage.active || usage.managed)).flatMap((usage) => {
    const key = accountKey(usage);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, label: usage.email || NAMES[provider] }];
  });
}

/** Whether the switch has anything to choose from for this provider here (a main and a saved account; Claude not on macOS). */
export function switchUseful(providers: ProviderUsage[], provider: UsageProvider): boolean {
  if (provider === 'claude' && !claudeLoginActions(window.mc.platform, true).managedAccounts) return false;
  return providers.some((u) => u.provider === provider && u.active) && providers.some((u) => u.provider === provider && u.managed && !u.active);
}

export const setAutoSwitch = (change: (current: AutoSwitchSettings) => AutoSwitchSettings) =>
  update((st) => updateSettings(st, { accountSwitch: change(st.settings.accountSwitch) }));

/** Settings at a row of the "Konta i limity" section (by default the switcher's). */
export const openAccountSettings = (focus = 'settings-switch-enabled') => setUi({ settingsTabOpen: true, settingsActive: true, settingsSection: { index: settingsSectionIndex('Konta i limity'), focus, seq: Date.now() } });
export const openSwitchSettings = () => openAccountSettings();

/** "Switcher: wł. · największy zapas · wraca na a@x" under the header, per provider that has something to switch; click: the Switcher card. */
export function AutoSwitchLine({ settings, providers, away, open, onOpen }: { settings: AutoSwitchSettings; providers: ProviderUsage[]; away?: Partial<Record<UsageProvider, string>>; open?: boolean; onOpen: (el: HTMLElement) => void }) {
  const { tr } = useI18n();
  // 1.1.2: shown whenever the switch is on, so it is always visible that a watcher looks after the limits.
  if (!settings.enabled) return null;
  const lines = (['claude', 'codex'] as const).filter((p) => autoSwitchOn(settings, p) && (p === 'claude' ? claudeLoginActions(window.mc.platform, true).managedAccounts : providers.some((u) => u.provider === 'codex')));
  if (!lines.length) return null;
  const limits = [settings.fiveHour.enabled ? `5 h ${settings.fiveHour.percent}%` : '', settings.sevenDay.enabled ? `7 d ${settings.sevenDay.percent}%` : ''].filter(Boolean).join(', ');
  return <>
    {lines.map((provider) => {
      // The dot says it is on; the line says what it watches, where it switches to and where it goes back.
      const rest = autoSwitchStatus(settings, provider, { away: away ?? {} }, tr).split(' · ').slice(1);
      const parts = [tr('pilnuje limitów: {limits}', { limits }), ...rest];
      if (!switchUseful(providers, provider)) parts.push(tr('dodaj drugie konto, aby było na co przełączać'));
      const text = parts.join(' · ');
      const label = lines.length > 1 ? `${NAMES[provider]}: ${text}` : text;
      return <button key={provider} type="button" className={`usage-auto-line ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={!!open} title={`${tr('Opcje automatycznego przełączania')}
${label}`}
        onClick={(e) => onOpen(e.currentTarget)}>
        <span className="usage-auto-line-dot" aria-hidden />
        <span className="usage-auto-line-text">{label}</span>
        <svg className="usage-auto-line-more" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m4 6 4 4 4-4" /></svg>
      </button>;
    })}
  </>;
}

const HEIGHT_KEY = 'mc-usage-height-v1';
export const USAGE_MIN_HEIGHT = 80;
/** The part of the side panel the panel above always keeps. */
const KEEP_ABOVE = 140;

function readHeight(): number | null {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(value) && value >= USAGE_MIN_HEIGHT ? Math.round(value) : null;
  } catch { return null; }
}

/** The saved height of the limits panel (null: the CSS default) and its setter (`save` writes it, null resets it). */
export function useUsageHeight(): [number | null, (height: number | null, save: boolean) => void] {
  const [height, setHeight] = useState<number | null>(readHeight);
  const change = (next: number | null, save: boolean) => {
    setHeight(next);
    if (!save) return;
    try { if (next === null) localStorage.removeItem(HEIGHT_KEY); else localStorage.setItem(HEIGHT_KEY, String(next)); } catch { /* not remembered */ }
  };
  return [height, change];
}

/**
 * The drag handle on the top edge of the limits panel: up makes it taller. Arrow keys (Shift: bigger steps), Home/End;
 * double-click resets to the default height. The panel above keeps at least KEEP_ABOVE pixels.
 */
export function UsageResizeHandle({ panel, onChange }: { panel: RefObject<HTMLElement | null>; onChange: (height: number | null, save: boolean) => void }) {
  const { tr } = useI18n();
  const drag = useRef<{ id: number; y: number; start: number; last: number | null; release: () => void } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => drag.current?.release(), []);
  const maxHeight = () => Math.max(USAGE_MIN_HEIGHT, (panel.current?.parentElement?.clientHeight ?? 600) - KEEP_ABOVE);
  const clamp = (value: number) => Math.round(Math.max(USAGE_MIN_HEIGHT, Math.min(maxHeight(), value)));
  const current = () => panel.current?.offsetHeight ?? USAGE_MIN_HEIGHT;
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (d.last !== null) onChange(d.last, true);
    setTimeout(d.release, 0);
  };
  return <div
    className={`usage-resize ${dragging ? 'dragging' : ''}`}
    role="separator"
    aria-orientation="horizontal"
    aria-label={tr('Zmień wysokość panelu limitów')}
    title={tr('Zmień wysokość panelu limitów')}
    tabIndex={0}
    onDoubleClick={() => onChange(null, true)}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current?.release();
      drag.current = { id: e.pointerId, y: e.clientY, start: current(), last: null, release: terminals.holdFits() };
      setDragging(true);
    }}
    onPointerMove={(e) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      d.last = clamp(d.start - (e.clientY - d.y));
      onChange(d.last, false);
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
    onLostPointerCapture={finish}
    onKeyDown={(e) => {
      const step = e.shiftKey ? 60 : 20;
      const next = e.key === 'ArrowUp' ? current() + step : e.key === 'ArrowDown' ? current() - step
        : e.key === 'Home' ? USAGE_MIN_HEIGHT : e.key === 'End' ? Number.POSITIVE_INFINITY : null;
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      onChange(clamp(next), true);
    }}
  />;
}
