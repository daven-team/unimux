// The connecting card of an SSH cell (1.0.4): the host tile, three steps (connect, sign in, terminal) on a progress track,
// the status line, the host key and login questions, an optional log and Zamknij; on a failure the failed step is red.
import { useEffect, useRef, type ComponentType } from 'react';
import { connectingBanner, userAtEndpoint, type SshHost, type SshPrompt, type SshSessionState } from '../../../../shared/ssh';
import { connectCardView, type ConnectStepId } from '../../../../shared/sshConnect';
import { useI18n } from '../../i18n';
import { connectContext, disconnectCell, reconnectCell } from '../../ssh';
import { useSshConnectStore } from '../../sshConnectStore';
import { useSshStore } from '../../sshStore';
import { IServer } from '../icons';
import { AuthPrompt } from './AuthPrompt';
import { HostKeyPrompt } from './HostKeyPrompt';
import { ILog, ILoginKey, IPlug, IShellPrompt } from './sshIcons';
import './sshConnect.css';

const STEP_ICON: Record<ConnectStepId, ComponentType> ={ connect: IPlug, login: ILoginKey, terminal: IShellPrompt };
const STEP_LABEL = { connect: 'Łączenie', login: 'Logowanie', terminal: 'Terminal' } as const;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

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
  useEffect(() => { if (logsOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logsOpen, log.length]);

  // Zamknij: while connecting it cancels like Rozłącz; after a failure the card goes and the terminal with its bottom bar shows.
  const close = () => {
    useSshConnectStore.getState().apply(cellId, { kind: 'dismiss' });
    if (!view.failed) disconnectCell(cellId);
  };
  const danger = prompt?.kind === 'hostKey' && prompt.reason === 'changed';
  return (
    <div className={`ssh-card ssh-connect${view.failed ? ' failed' : ''}${danger ? ' danger' : ''}`} role={prompt ? 'dialog' : 'group'} aria-label={host.label}>
      <div className="ssh-connect-inner">
        <div className="ssh-connect-head">
          <span className={`ssh-host-icon${host.color ? '' : ' uncolored'}`} style={host.color ? { background: host.color } : undefined} aria-hidden="true"><IServer /></span>
          <div className="ssh-connect-name">
            <strong title={host.label}>{host.label}</strong>
            <span title={userAtEndpoint(host)}>SSH {userAtEndpoint(host)}</span>
          </div>
          <button type="button" className={`btn small ghost ssh-connect-logs-toggle${logsOpen ? ' on' : ''}`} aria-expanded={logsOpen}
            title={tr(logsOpen ? 'Ukryj logi' : 'Pokaż logi')} onClick={() => useSshConnectStore.getState().toggleLogs(cellId)}>
            <ILog /><span>{tr(logsOpen ? 'Ukryj logi' : 'Pokaż logi')}</span>
          </button>
        </div>
        <div className="ssh-steps" style={{ ['--ssh-progress' as string]: String(view.progress) }}>
          <span className="ssh-steps-track" aria-hidden="true"><span className="ssh-steps-fill" /></span>
          <ol>
            {view.steps.map(({ id, state }) => {
              const Icon = STEP_ICON[id];
              return (
                <li key={id} className={`ssh-step ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                  <span className="ssh-step-node"><Icon /></span>
                  <span className="ssh-step-label">{tr(STEP_LABEL[id])}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <div className={`ssh-connect-status${view.failed ? ' failed' : ''}`} role="status">
          <span>{tr(view.status.key, view.status.params)}</span>
          {view.error && <span className="ssh-connect-error">{tr(view.error.key, view.error.params)}</span>}
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
        <div className="ssh-connect-actions">
          <button type="button" className="btn small" onClick={close}>{tr('Zamknij')}</button>
          {view.failed && <button type="button" className="btn small primary" autoFocus onClick={() => void reconnectCell(cellId)}>{tr('Połącz ponownie')}</button>}
        </div>
      </div>
    </div>
  );
}
