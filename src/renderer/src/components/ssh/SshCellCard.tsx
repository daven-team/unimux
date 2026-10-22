// Overlay of an SSH cell (spec 6.3, R11): full card while idle, the connecting card (SshConnectCard, 1.0.4) until the shell
// opens or while a failed connect is shown, a bottom bar after the session ended (the last output stays readable above it).
import { connectingBanner, sanitizeServerText, sshErrorText, userAtEndpoint, type SshHost, type SshPrompt, type SshSessionState } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { connectCell, reconnectCell, sshContext } from '../../ssh';
import { useSshStore } from '../../sshStore';
import { connectCardShown } from '../../../../shared/sshConnect';
import { useSshConnectStore } from '../../sshConnectStore';
import { SshConnectCard } from './SshConnectCard';
import { AuthPrompt } from './AuthPrompt';
import { HostKeyPrompt } from './HostKeyPrompt';
import './ssh.css';

export function SshCellCard({ cellId, host, session, prompt }: { cellId: string; host: SshHost | undefined; session: SshSessionState | undefined; prompt: SshPrompt | undefined }) {
  const { tr } = useI18n();
  const storage = useSshStore((st) => st.vault?.storage ?? 'unavailable');
  const attempt = useSshConnectStore((st) => st.attempts[cellId]);
  if (!host) {
    return <div className="ssh-card" role="group"><div className="ssh-card-inner"><div className="ssh-card-title">{tr('Ten host został usunięty')}</div></div></div>;
  }
  // 1.0.4: from the connect until the shell opens (or the attempt failed) the connecting card covers the terminal.
  if (connectCardShown(attempt, session, prompt)) return <SshConnectCard cellId={cellId} host={host} session={session} prompt={prompt} />;
  if (prompt) {
    return (
      <div className={`ssh-card${prompt.kind === 'hostKey' && prompt.reason === 'changed' ? ' danger' : ''}`} role="dialog" aria-label={host.label}>
        <div className="ssh-card-inner">
          {session?.serverBanner && <pre className="ssh-banner">{sanitizeServerText(session.serverBanner)}</pre>}
          {prompt.kind === 'hostKey'
            ? <HostKeyPrompt key={prompt.id} cellId={cellId} prompt={prompt} />
            : <AuthPrompt key={prompt.id} cellId={cellId} prompt={prompt} storage={storage} />}
        </div>
      </div>
    );
  }
  const phase = session?.phase ?? 'idle';
  if (phase === 'idle') {
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
  const banner = connectingBanner(session);
  if (banner) {
    return (
      <div className="ssh-card" role="status" aria-label={host.label}>
        <div className="ssh-card-inner">
          <div className="ssh-card-title">{host.label}</div>
          <div className="ssh-card-text">{userAtEndpoint(host)}</div>
          <pre className="ssh-banner">{banner}</pre>
        </div>
      </div>
    );
  }
  if (phase !== 'closed' && phase !== 'error') return null;
  const error = phase === 'error' ? sshErrorText(session?.error ?? 'unknown', sshContext(host.id)) : null;
  const text = error ? tr(error.key, error.params) : session?.exitCode !== undefined ? tr('Sesja zakończona (kod {code})', { code: session.exitCode }) : tr('rozłączono');
  return (
    <div className={`ssh-bar${error ? ' error' : ''}`} role="status">
      <span className="grow">{text}</span>
      <button className="btn small primary" onClick={() => void reconnectCell(cellId)}>{tr('Połącz ponownie')}</button>
    </div>
  );
}
