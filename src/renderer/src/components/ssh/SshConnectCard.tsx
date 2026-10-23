// The connecting card of an SSH cell. 1.0.4 brought it (steps, status, host key and login questions, a log, Anuluj); 1.0.5
// keeps it after the attempt (failed, cancelled, a dropped session) with Połącz ponownie and Zamknij komórkę, and draws it
// as a unimux panel: the host chip in the host's colour, the phases as a checklist with their times, the attempt's clock,
// the status and the buttons in a footer bar. The terminal under it never gets status lines of the app.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { connectingBanner, userAtEndpoint, type SshHost, type SshPrompt, type SshSessionState } from '../../../../shared/ssh';
import { connectCardView, formatClock, formatDuration, type ConnectStepState } from '../../../../shared/sshConnect';
import { useI18n } from '../../i18n';
import { removeCell } from '../../actions';
import { connectContext, disconnectCell, reconnectCell } from '../../ssh';
import { useSshConnectStore } from '../../sshConnectStore';
import { useSshStore } from '../../sshStore';
import { AuthPrompt } from './AuthPrompt';
import { HostKeyPrompt } from './HostKeyPrompt';
import { ILog, IMarkDone, IMarkFailed, IMarkStopped } from './sshIcons';
import './sshConnect.css';

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Up to two letters of the host's name for its chip: "prod db" -> "PD", "web-01" -> "WE". */
export function hostInitials(label: string): string {
  const words = label.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? [Array.from(words[0])[0], Array.from(words[1])[0]] : Array.from(words[0] ?? '').slice(0, 2);
  return letters.join('').toUpperCase() || '?';
}

/** The head shared by every card of an SSH cell: the chip in the host's colour, the name, user@address and optional tools. */
export function SshPanelHead({ host, children }: { host: SshHost; children?: ReactNode }) {
  return (
    <div className="ssh-panel-head">
      <span className={`ssh-chip${host.color ? '' : ' uncolored'}`} style={host.color ? { background: host.color } : undefined} aria-hidden="true">{hostInitials(host.label)}</span>
      <div className="ssh-panel-name">
        <strong title={host.label}>{host.label}</strong>
        <span title={userAtEndpoint(host)}>{userAtEndpoint(host)}</span>
      </div>
      {children}
    </div>
  );
}

function Mark({ state }: { state: ConnectStepState }) {
  return (
    <span className={`ssh-mark ${state}`} aria-hidden="true">
      {state === 'done' ? <IMarkDone /> : state === 'failed' ? <IMarkFailed /> : state === 'stopped' ? <IMarkStopped /> : null}
    </span>
  );
}

/** Now, once a second while `running` (the clock of a connect that is still on its way); frozen otherwise. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export function SshConnectCard({ cellId, host, session, prompt }: { cellId: string; host: SshHost; session: SshSessionState | undefined; prompt: SshPrompt | undefined }) {
  const { tr } = useI18n();
  const storage = useSshStore((st) => st.vault?.storage ?? 'unavailable');
  const attempt = useSshConnectStore((st) => st.attempts[cellId]);
  const logsOpen = useSshConnectStore((st) => !!st.logsOpen[cellId]);
  const logRef = useRef<HTMLOListElement>(null);
  const ctx = connectContext(host.id);
  const view = connectCardView(attempt, session, prompt, ctx);
  const banner = connectingBanner(session);
  const log = attempt?.log ?? [];
  const now = useNow(view.since !== undefined && view.until === undefined);
  useEffect(() => { if (logsOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logsOpen, log.length]);

  // Anuluj stops the attempt (the card then says Anulowano; an open login question has its own Anuluj); once the attempt is
  // over, Zamknij komórkę closes the cell like its X does. The raw terminal never shows while the cell is not connected.
  const cancel = () => {
    useSshConnectStore.getState().apply(cellId, { kind: 'cancel' });
    disconnectCell(cellId);
  };
  const danger = prompt?.kind === 'hostKey' && prompt.reason === 'changed';
  // The clock runs while connecting; once over it stays only when the attempt took a while (an instant failure needs no 0:00).
  const elapsed = view.since !== undefined && (view.until === undefined || view.until - view.since >= 1000) ? formatClock((view.until ?? now) - view.since) : null;
  return (
    <div className={`ssh-card ssh-connect is-${view.kind}${view.ended ? ' ended' : ''}${view.failed ? ' failed' : ''}${danger ? ' danger' : ''}`} role={prompt ? 'dialog' : 'group'} aria-label={host.label}>
      <div className="ssh-frame"><div className="ssh-panel">
        <SshPanelHead host={host}>
          <button type="button" className={`btn small ghost ssh-connect-logs-toggle${logsOpen ? ' on' : ''}`} aria-expanded={logsOpen}
            title={tr(logsOpen ? 'Ukryj logi' : 'Pokaż logi')} onClick={() => useSshConnectStore.getState().toggleLogs(cellId)}>
            <ILog /><span>{tr(logsOpen ? 'Ukryj logi' : 'Pokaż logi')}</span>
          </button>
        </SshPanelHead>
        <ol className="ssh-phases">
          {view.steps.map(({ id, state, label, ms }) => (
            <li key={id} className={`ssh-phase ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
              <Mark state={state} />
              <span className="ssh-phase-label">{tr(label.key, label.params)}</span>
              {ms !== undefined && <span className="ssh-phase-time">{formatDuration(ms)}</span>}
            </li>
          ))}
          {view.session && (
            <li className={`ssh-phase session ${view.session.state === 'failed' ? 'failed' : 'ended'}`}>
              <Mark state={view.session.state === 'failed' ? 'failed' : 'stopped'} />
              <span className="ssh-phase-label">{tr(view.session.label.key, view.session.label.params)}</span>
            </li>
          )}
        </ol>
        <div className={`ssh-panel-status${view.failed ? ' failed' : ''}`} role="status">
          <div className="ssh-panel-status-text">
            <strong>{tr(view.status.key, view.status.params)}</strong>
            {view.error && <span className="ssh-connect-error">{tr(view.error.key, view.error.params)}</span>}
          </div>
          {elapsed && <time className="ssh-clock" title={tr('Czas próby połączenia')}>{elapsed}</time>}
        </div>
        {banner && <pre className="ssh-banner">{banner}</pre>}
        {prompt && (
          <div className="ssh-connect-prompt">
            {prompt.kind === 'hostKey'
              ? <HostKeyPrompt key={prompt.id} cellId={cellId} prompt={prompt} />
              : <AuthPrompt key={prompt.id} cellId={cellId} prompt={prompt} storage={storage} />}
          </div>
        )}
        {logsOpen && (
          <ol className="ssh-connect-log" ref={logRef} aria-label={tr('Logi połączenia')}>
            {log.map((e, i) => (
              <li key={i} className={e.tone}><time>{clock(e.at)}</time><span>{tr(e.text.key, e.text.params)}</span></li>
            ))}
          </ol>
        )}
        {view.ended ? (
          <div className="ssh-connect-actions">
            <button type="button" className="btn small" onClick={() => void removeCell(cellId)}>{tr('Zamknij komórkę')}</button>
            <button type="button" className="btn small primary" autoFocus onClick={() => void reconnectCell(cellId)}>{tr('Połącz ponownie')}</button>
          </div>
        ) : !prompt && (
          <div className="ssh-connect-actions">
            <button type="button" className="btn small" onClick={cancel}>{tr('Anuluj')}</button>
          </div>
        )}
      </div></div>
    </div>
  );
}
