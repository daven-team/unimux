// "Wybierz host" of the SFTP view: the saved SSH hosts by group with their address, a search field (fuzzy, like the SSH view).
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { filterHosts, groupHosts, userAtEndpoint, type SshHost } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { openSshView } from '../../ssh';
import { ISearch, IServer } from '../icons';

export function HostPicker({ hosts, currentHostId, onPick, onCancel }: { hosts: SshHost[]; currentHostId: string | null; onPick(hostId: string): void; onCancel?: () => void }) {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => (query.trim() ? filterHosts(hosts, query) : hosts), [hosts, query]);
  const groups = useMemo(() => groupHosts(shown, !query.trim()), [shown, query]);
  const headings = hosts.some((h) => !!h.group);
  const buttons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.sftp-host-option') ?? []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = buttons();
    if (!all.length) return;
    e.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % all.length : at <= 0 ? all.length - 1 : at - 1;
    all[next].focus();
  };
  return (
    <div className="sftp-picker" role="dialog" aria-label={tr('Wybierz host')} onKeyDown={onKeyDown}>
      <div className="sftp-picker-head">
        <h3>{tr('Wybierz host')}</h3>
        <span className="grow" />
        {onCancel && <button type="button" className="btn small" onClick={onCancel}>{tr('Anuluj')}</button>}
      </div>
      {hosts.length > 0 && (
        <div className="sftp-filter wide">
          <ISearch />
          <input className="input" type="search" autoFocus value={query} placeholder={tr('Szukaj hostów')} aria-label={tr('Szukaj hostów')} spellCheck={false}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); onPick(shown[0].id); } }} />
        </div>
      )}
      <div ref={list} className="sftp-picker-list">
        {!hosts.length && (
          <div className="sftp-center">
            <p>{tr('Brak zapisanych hostów SSH')}</p>
            <button type="button" className="btn primary" onClick={() => openSshView({ kind: 'host' })}>{tr('Dodaj host SSH…')}</button>
          </div>
        )}
        {hosts.length > 0 && !shown.length && <p className="sftp-picker-none">{tr('Brak hostów pasujących do wyszukiwania')}</p>}
        {groups.map((g) => (
          <div key={g.name ?? ''} className="sftp-picker-group">
            {headings && <div className="sftp-picker-group-name">{g.name ?? tr('Bez grupy')}</div>}
            {g.hosts.map((h) => (
              <button key={h.id} type="button" className={`sftp-host-option${h.id === currentHostId ? ' on' : ''}`} data-host-id={h.id} onClick={() => onPick(h.id)}>
                <span className="sftp-host-icon" style={h.color ? { color: h.color } : undefined}><IServer /></span>
                <span className="sftp-host-text">
                  <span className="sftp-host-label">{h.label}</span>
                  <span className="sftp-host-address">{userAtEndpoint(h)}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
