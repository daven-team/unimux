// The SSH mode navigation (0.9.2): Hosty, Klucze, Znane hosty and SFTP (0.9.8). In the side panel while the
// SSH view is in front; `compact` is the segmented row at the top of the view when the side panel is folded.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { railFocusTarget } from '../../../../shared/sidebarPanels';
import { SSH_NAV, type SshNavEntry } from '../../../../shared/sshView';
import { useI18n } from '../../i18n';
import { selectSshSection } from '../../ssh';
import { useSshStore } from '../../sshStore';
import { useStore } from '../../store';
import { IFolder, IKey, IServer, IShield } from '../icons';
import './sshNav.css';

const ICONS: Record<SshNavEntry['id'], () => ReactNode> = { hosts: IServer, keys: IKey, knownHosts: IShield, sftp: IFolder };
const ARROWS: Record<string, string> = { ArrowRight: 'ArrowDown', ArrowLeft: 'ArrowUp' };

export function SshNav({ compact = false }: { compact?: boolean }) {
  const { tr } = useI18n();
  const section = useSshStore((st) => st.section);
  const keyCount = useSshStore((st) => st.vault?.keys.length ?? 0);
  const hostCount = useStore((st) => st.s.sshHosts.length);
  const list = useRef<HTMLDivElement>(null);
  const counts: Partial<Record<SshNavEntry['id'], number>> = { hosts: hostCount, keys: keyCount };
  /** Arrows, Home and End move along the enabled entries and choose them (a disabled entry would be skipped). */
  const onKeyDown = (e: KeyboardEvent) => {
    const tabs = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role=tab]:not(:disabled)') ?? []);
    const key = compact ? ARROWS[e.key] ?? e.key : e.key;
    const target = railFocusTarget(tabs.length, tabs.indexOf(document.activeElement as HTMLButtonElement), key);
    if (target === null) return;
    e.preventDefault();
    tabs[target]?.focus();
    if (tabs[target]?.dataset.section) selectSshSection(tabs[target].dataset.section);
  };
  return (
    <div ref={list} className={`ssh-nav${compact ? ' compact' : ''}`} role="tablist" aria-orientation={compact ? 'horizontal' : 'vertical'} aria-label={tr('SSH')} onKeyDown={onKeyDown}>
      {SSH_NAV.map((entry) => {
        const Icon = ICONS[entry.id];
        const on = entry.id === section;
        const count = counts[entry.id];
        return (
          <button key={entry.id} type="button" role="tab" data-section={entry.id} className={`ssh-nav-item${on ? ' on' : ''}`}
            aria-selected={on} aria-controls={on ? 'ssh-section' : undefined} tabIndex={on ? 0 : -1} disabled={entry.disabled}
            title={tr(entry.label)}
            onClick={() => selectSshSection(entry.id)}>
            <Icon />
            <span className="ssh-nav-label">{tr(entry.label)}</span>
            {!compact && count !== undefined ? <span className="ssh-nav-count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
