// Overlay of an SSH cell (spec 6.3, R11): the idle card before the first connect; from the connect on, every state that is not
// connected (connecting, a login question, failed, cancelled, a dropped session) is the connecting card (SshConnectCard, 1.0.4
// and 1.0.5). Only an open shell shows the terminal. Both draw the same unimux panel (1.0.5).
import { type SshHost, type SshPrompt, type SshSessionState } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { connectCell } from '../../ssh';
import { connectCardShown } from '../../../../shared/sshConnect';
import { SshConnectCard } from './SshConnectCard';
import './ssh.css';

export function SshCellCard({ cellId, host, session, prompt }: { cellId: string; host: SshHost | undefined; session: SshSessionState | undefined; prompt: SshPrompt | undefined }) {
  const { tr } = useI18n();
  if (!host) {
    return (
      <div className="ssh-card ssh-idle" role="group">
        <div className="ssh-frame"><div className="ssh-panel"><p className="ssh-panel-note">{tr('Ten host został usunięty')}</p></div></div>
      </div>
    );
  }
  if (connectCardShown(session, prompt)) return <SshConnectCard cellId={cellId} host={host} session={session} prompt={prompt} />;
  if ((session?.phase ?? 'idle') !== 'idle') return null;
  return (
    <div className="ssh-card ssh-idle" role="group" aria-label={host.label}>
      {/* 1.0.7: no host head here - the cell's own header already names the host and user@address right above. */}
      <div className="ssh-frame"><div className="ssh-panel">
        <p className="ssh-panel-note">{tr('Sesja SSH nie jest wznawiana po ponownym uruchomieniu aplikacji')}</p>
        <div className="ssh-connect-actions">
          <button className="btn small primary" autoFocus onClick={() => void connectCell(cellId)}>{tr('Połącz')}</button>
        </div>
      </div></div>
    </div>
  );
}
