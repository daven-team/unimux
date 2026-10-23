// Overlay of an SSH cell (spec 6.3, R11): full card while idle; from the connect on, every state that is not connected
// (connecting, a login question, failed, cancelled, a dropped session) is the connecting card (SshConnectCard, 1.0.4 and 1.0.5).
// Only an open shell shows the terminal.
import { userAtEndpoint, type SshHost, type SshPrompt, type SshSessionState } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { connectCell } from '../../ssh';
import { connectCardShown } from '../../../../shared/sshConnect';
import { SshConnectCard } from './SshConnectCard';
import './ssh.css';

export function SshCellCard({ cellId, host, session, prompt }: { cellId: string; host: SshHost | undefined; session: SshSessionState | undefined; prompt: SshPrompt | undefined }) {
  const { tr } = useI18n();
  if (!host) {
    return <div className="ssh-card" role="group"><div className="ssh-card-inner"><div className="ssh-card-title">{tr('Ten host został usunięty')}</div></div></div>;
  }
  if (connectCardShown(session, prompt)) return <SshConnectCard cellId={cellId} host={host} session={session} prompt={prompt} />;
  if ((session?.phase ?? 'idle') !== 'idle') return null;
  return (
    <div className="ssh-card" role="group" aria-label={host.label}>
      <div className="ssh-card-inner">
        <div className="ssh-card-title">{host.label}</div>
        <div className="ssh-card-text">{userAtEndpoint(host)}</div>
        <div className="ssh-card-hint">{tr('Sesja SSH nie jest wznawiana po ponownym uruchomieniu aplikacji')}</div>
        <div className="ssh-actions">
          <button className="btn small primary" autoFocus onClick={() => void connectCell(cellId)}>{tr('Połącz')}</button>
        </div>
      </div>
    </div>
  );
}
