// "Czeka na Ciebie" (1.0.9): a side panel listing every cell that needs the user, across all grids and windows, longest waiting
// first (shared/waiting.ts): what it waits for (the permission and its tool, a question, an error or a limit, a finished turn
// not seen yet) and for how long. A click or Enter shows the cell (its grid, its window, the focus in its terminal); the arrows
// move along the list. The "3 min" texts follow a 30 s clock that only runs while the panel is mounted and the window shown.
import { useRef, type KeyboardEvent } from 'react';
import { cellLabel } from '../../../shared/agentWork';
import { cellOwners } from '../../../shared/detached';
import { cellShell, shownProfileName } from '../../../shared/profiles';
import { sshHeaderName } from '../../../shared/ssh';
import { getProfile } from '../../../shared/state';
import { waitAge, waitText, waitTone, type WaitingEntry } from '../../../shared/waiting';
import type { AppState } from '../../../shared/types';
import { useI18n } from '../i18n';
import { useStore } from '../store';
import { revealWaiting, setHideMuted, useWaitClock, useWaitingCount, useWaitingEntries, useWaitingPrefs } from '../waiting';
import { IPrompt, IServer } from './icons';
import { PanelEmpty } from './PanelEmpty';
import { ProviderIcon } from './ProviderIcons';
import './waitingPanel.css';

const MutedIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0M3 3l18 18" /></svg>
);

interface RowInfo { label: string; place: string; agent: 'claude' | 'codex' | 'ssh' | 'shell'; detached: boolean }

/** The label, the grid and project, the kind of agent and whether a detached window has the cell (also for the palette). */
export function waitingRowInfo(s: Pick<AppState, 'projects' | 'profiles' | 'settings' | 'sshHosts' | 'detachedWindows'>, entry: WaitingEntry, sessionTitles: Record<string, string>, tr: ReturnType<typeof useI18n>['tr'], owners: Map<string, string>): RowInfo | null {
  const project = s.projects.find((p) => p.id === entry.projectId);
  const tab = project?.tabs.find((t) => t.id === entry.tabId);
  const cell = tab?.cells.find((c) => c.id === entry.cellId);
  if (!project || !tab || !cell) return null;
  const profile = getProfile(s as AppState, cell.profileId);
  const host = cell.ssh ? s.sshHosts.find((h) => h.id === cell.ssh!.hostId) : undefined;
  const label = cell.ssh
    ? sshHeaderName(cell.name) || host?.label || tr('Host usunięty')
    : cellLabel(cell, sessionTitles, shownProfileName(profile, cellShell(cell, s.settings.shell), tr));
  const agent = cell.ssh ? 'ssh' : profile.cli;
  return { label, place: `${tab.name} · ${project.name}`, agent, detached: owners.has(cell.id) };
}

function AgentMark({ agent }: { agent: RowInfo['agent'] }) {
  if (agent === 'claude' || agent === 'codex') return <ProviderIcon provider={agent} size={14} />;
  return agent === 'ssh' ? <IServer /> : <IPrompt />;
}

/** The count on the rail tile: the cells that need you, muted ones left out; nothing at zero. */
export function WaitingBadge() {
  const { tr } = useI18n();
  const count = useWaitingCount();
  if (!count) return null;
  return <span className="rail-badge" aria-label={tr('Czeka na Ciebie: {n}', { n: count })}>{count > 99 ? '99+' : count}</span>;
}

export function WaitingPanel() {
  const { tr, language } = useI18n();
  const entries = useWaitingEntries();
  const hideMuted = useWaitingPrefs((st) => st.hideMuted);
  const projects = useStore((st) => st.s.projects);
  const profiles = useStore((st) => st.s.profiles);
  const settings = useStore((st) => st.s.settings);
  const sshHosts = useStore((st) => st.s.sshHosts);
  const detachedWindows = useStore((st) => st.s.detachedWindows);
  const sessionTitles = useStore((st) => st.ui.sessionTitles);
  const now = useWaitClock(entries.length > 0);
  const list = useRef<HTMLDivElement>(null);
  const s = { projects, profiles, settings, sshHosts, detachedWindows };
  const owners = cellOwners(s);
  const anyMuted = projects.some((p) => p.tabs.some((t) => t.cells.some((c) => c.muted)));
  const rows = entries.flatMap((entry) => { const info = waitingRowInfo(s, entry, sessionTitles, tr, owners); return info ? [{ entry, info }] : []; });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.waiting-row') ?? []);
    if (!buttons.length) return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div className="waiting">
      {anyMuted && (
        <label className="waiting-filter" title={tr('Komórki z wyciszonymi alertami nie są liczone w plakietce.')}>
          <input type="checkbox" checked={hideMuted} onChange={(e) => setHideMuted(e.target.checked)} />
          <span>{tr('Ukryj wyciszone')}</span>
        </label>
      )}
      {!rows.length && (
        <PanelEmpty>
          <p>{tr('Nic na Ciebie nie czeka.')}</p>
          <p>{tr('Tu pojawią się komórki, które pytają, proszą o zgodę, zgłosiły błąd albo skończyły pracę i czekają, aż do nich zajrzysz.')}</p>
        </PanelEmpty>
      )}
      {!!rows.length && (
        <div ref={list} className="waiting-list" role="list" onKeyDown={onKeyDown}>
          {rows.map(({ entry, info }) => {
            const what = waitText(entry);
            const age = waitAge(entry.since, now);
            const since = new Date(entry.since).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
            return (
              <div key={entry.cellId} role="listitem">
                <button
                  type="button"
                  className={`waiting-row ${waitTone(entry.kind)} ${entry.muted ? 'muted' : ''}`}
                  data-cell={entry.cellId}
                  onClick={() => revealWaiting(entry.cellId)}
                >
                  <span className="waiting-agent"><AgentMark agent={info.agent} /></span>
                  <span className="waiting-main">
                    <span className="waiting-line">
                      <span className="waiting-name" title={info.label}>{info.label}</span>
                      {entry.muted && <span className="waiting-muted" title={tr('Alerty tej komórki są wyciszone')} aria-label={tr('Alerty tej komórki są wyciszone')}><MutedIcon /></span>}
                      <span className="waiting-age" title={tr('Czeka od {time}', { time: since })}>{tr(age.key, age.params)}</span>
                    </span>
                    <span className="waiting-what">{tr(what.key, what.params)}</span>
                    <span className="waiting-place" title={info.place}>{info.place}{info.detached ? ` · ${tr('w osobnym oknie')}` : ''}</span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
