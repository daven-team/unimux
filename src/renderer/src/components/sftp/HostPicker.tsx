// "Wybierz host" of the SFTP view: the saved SSH hosts by group with their address, a search field (fuzzy, like the SSH view).
// One compact column in place of the whole remote pane: the title row (in line with the head of the local pane), the search,
// then the hosts as cards (icon, label, user@host:port; the connected one with a green dot). The arrow keys move through the
// card grid by rows and columns (shared/sftpView.ts cardStep).
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { filterHosts, groupHosts, userAtEndpoint, type SshHost } from '../../../../shared/ssh';
import { cardStep } from '../../../../shared/sftpView';
import { useI18n } from '../../i18n';
import { openSshView } from '../../ssh';
import { ISearch, IServer } from '../icons';

export function HostPicker({ hosts, currentHostId, onPick, onCancel }: { hosts: SshHost[]; currentHostId: string | null; onPick(hostId: string): void; onCancel?: () => void }) {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => (query.trim() ? filterHosts(hosts, query) : hosts), [hosts, query]);
  const groups = useMemo(() => groupHosts(shown, !query.trim()), [shown, query]);
  const headings = hosts.some((h) => !!h.group);
  const buttons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.sftp-host-option') ?? []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // The cards sit in a grid: Up/Down go by rows (the nearest card above/below), Left/Right by one card.
    const all = buttons();
    const next = cardStep(all.map((b) => b.getBoundingClientRect()), all.indexOf(document.activeElement as HTMLButtonElement), e.key);
    if (next === null) return;
    e.preventDefault();
    (next < 0 ? search.current : all[next])?.focus();
  };
  return (
    <div className="sftp-picker" role="dialog" aria-label={tr('Wybierz host')} onKeyDown={onKeyDown}>
      <div className="sftp-pane-head sftp-picker-head">
        <h3 className="sftp-title">{tr('Wybierz host')}</h3>
        <span className="grow" />
        {onCancel && <button type="button" className="btn small" onClick={onCancel}>{tr('Anuluj')}</button>}
      </div>
      {hosts.length > 0 && (
        <div className="sftp-filter sftp-picker-search">
          <ISearch />
          <input ref={search} className="input" type="search" autoFocus value={query} placeholder={tr('Szukaj hostów')} aria-label={tr('Szukaj hostów')} spellCheck={false}
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
            <div className="sftp-picker-cards">
              {g.hosts.map((h) => (
                <button key={h.id} type="button" className={`sftp-host-option${h.id === currentHostId ? ' on' : ''}`} data-host-id={h.id} title={`${h.label} · ${userAtEndpoint(h)}`} onClick={() => onPick(h.id)}>
                  <span className="sftp-host-icon" style={h.color ? { color: h.color } : undefined}><IServer /></span>
                  <span className="sftp-host-text">
                    <span className="sftp-host-label">{h.label}</span>
                    <span className="sftp-host-address">{userAtEndpoint(h)}</span>
                  </span>
                  {h.id === currentHostId && <span className="sftp-dot connected" role="img" aria-label={tr('połączono')} />}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
