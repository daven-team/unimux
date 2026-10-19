// The login of a remote editor tab (0.9.9): while a save or reload connects to the saved host, its host key or password
// question appears inside the tab (the SFTP view shows the same prompt when it shows that host).
import { useRemoteSessions, promptOf } from '../remoteSessions';
import { useSshStore } from '../sshStore';
import { useI18n } from '../i18n';
import { AuthPrompt } from './ssh/AuthPrompt';
import { HostKeyPrompt } from './ssh/HostKeyPrompt';
import { sftpPromptReply } from './ssh/promptReply';
import { BusyRing } from './Spinner';
import './ssh/ssh.css';

export function RemoteLogin({ hostId, hostLabel }: { hostId: string; hostLabel: string }) {
  const { tr } = useI18n();
  const connecting = useRemoteSessions((st) => !!st.connecting[hostId]);
  // Two stable selections (a selector building a new object would re-render without end).
  const sessionId = useRemoteSessions((st) => promptOf(st, hostId)?.sessionId ?? null);
  const prompt = useRemoteSessions((st) => promptOf(st, hostId)?.prompt ?? null);
  const storage = useSshStore((st) => st.vault?.storage ?? 'unavailable');
  if (!connecting) return null;
  if (!sessionId || !prompt) return <div className="preview-notice remote-connecting" role="status"><BusyRing className="remote-connecting-ring" /> {tr('Łączenie z {host}…', { host: hostLabel })}</div>;
  const respond = sftpPromptReply(sessionId);
  return (
    <div className={`remote-login${prompt.kind === 'hostKey' && prompt.reason === 'changed' ? ' danger' : ''}`} role="dialog" aria-label={hostLabel}>
      <div className="remote-login-card">
        {prompt.kind === 'hostKey'
          ? <HostKeyPrompt key={prompt.id} cellId={sessionId} prompt={prompt} respond={respond} />
          : <AuthPrompt key={prompt.id} cellId={sessionId} prompt={prompt} storage={storage} respond={respond} />}
      </div>
    </div>
  );
}
