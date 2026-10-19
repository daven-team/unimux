// A Redis tab of the top strip (1.0.0): the connection bar (colour, name, endpoint, DB, version, TLS, read-only, switching to the
// other views), the login of its session (SSH host key and password, the Redis password) and the view itself.
import { lazy, Suspense, useEffect, useState } from 'react';
import { dbEndpoint, dbPhaseLabel, type DbPrompt } from '../../../../shared/db';
import type { RedisTabRef, RedisTabView as View } from '../../../../shared/redisView';
import { useFileStore } from '../../files';
import { useI18n } from '../../i18n';
import { useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { ensureTabSession, openRedisTab, reconnectTab, tabSessionState, useRedisStore, viewLabel } from '../../redis/redisClient';
import { AuthPrompt } from '../ssh/AuthPrompt';
import { HostKeyPrompt } from '../ssh/HostKeyPrompt';
import type { PromptReply } from '../ssh/promptReply';
import { BusyRing } from '../Spinner';
import '../ssh/ssh.css';
import './redis.css';

const RedisKeyBrowser = lazy(() => import('./RedisKeyBrowser'));
const RedisConsole = lazy(() => import('./RedisConsole'));
const RedisPubSub = lazy(() => import('./RedisPubSub'));
const RedisServer = lazy(() => import('./RedisServer'));

export interface RedisViewProps { tabId: string; sessionId: string; ref: RedisTabRef; readOnly: boolean }

const VIEWS: View[] = ['keys', 'console', 'pubsub', 'info'];

export function RedisTabView() {
  const { tr } = useI18n();
  const doc = useFileStore((s) => s.documents.find((d) => d.id === s.activeFileId && d.redis));
  const ref = doc?.redis;
  const tabId = doc?.id ?? '';
  const connection = useStore((s) => (ref ? s.s.dbConnections?.find((c) => c.id === ref.connectionId) : undefined));
  const sshLabel = useStore((s) => (connection?.ssh ? s.s.sshHosts.find((h) => h.id === connection.ssh!.hostId)?.label ?? '?' : ''));
  const session = useRedisStore((st) => tabSessionState(st, tabId));
  const sessionId = useRedisStore((st) => st.tabSessions[tabId]);
  const tabError = useRedisStore((st) => st.tabErrors[tabId]);
  const prompt = useRedisStore((st) => (sessionId ? st.prompts[sessionId] : undefined));
  // A tab connects when it is shown (also after its session ended unexpectedly: then it waits for "connect again").
  useEffect(() => { if (tabId && connection && !sessionId && !tabError) void ensureTabSession(tabId); }, [tabId, connection, sessionId, tabError]);
  if (!doc || !ref) return null;
  if (!connection) return <div className="redis-view"><div className="redis-center muted">{tr('To połączenie zostało usunięte')}</div></div>;
  const connected = session?.state === 'connected';
  const readOnly = session?.readOnly ?? connection.readOnly;
  const phase = session && session.state === 'connecting' ? dbPhaseLabel(session.phase) : null;
  return (
    <div className="redis-view" style={{ ['--conn-color' as string]: connection.color ?? '#dc382d' }}>
      <header className="redis-bar">
        <span className="redis-conn-dot" aria-hidden="true" />
        <strong className="redis-conn-name">{connection.name}</strong>
        <span className="muted redis-endpoint" title={dbEndpoint(connection)}>{dbEndpoint(connection).replace(/\/\d+$/, '')}{connection.ssh ? ` ${tr('przez {host}', { host: sshLabel })}` : ''}</span>
        <span className="redis-chip">DB {ref.db}</span>
        {session?.serverVersion && <span className="redis-chip muted">{session.serverVersion}</span>}
        {session?.tls && <span className="redis-chip">TLS</span>}
        {readOnly && <span className="redis-chip warn" title={tr('Zapisy są wyłączone')}>{tr('tylko do odczytu')}</span>}
        {session?.reconnecting && <span className="redis-chip warn">{tr('Ponowne łączenie ({n})…', { n: session.reconnecting })}</span>}
        <span className="grow" />
        <nav className="redis-views" aria-label={tr('Widoki Redis')}>
          {VIEWS.map((v) => (
            <button key={v} className={`redis-view-btn ${v === ref.view ? 'on' : ''}`} aria-pressed={v === ref.view}
              onClick={() => { if (v !== ref.view) openRedisTab(ref.connectionId, v, ref.db); }}>{viewLabel(v)}</button>
          ))}
        </nav>
      </header>
      {connected && sessionId
        ? <Suspense fallback={null}><Body view={ref.view} props={{ tabId, sessionId, ref, readOnly }} /></Suspense>
        : (
          <div className="redis-center">
            {prompt && sessionId ? <Login sessionId={sessionId} prompt={prompt} />
              : tabError ? (
                <div className="redis-card" role="alert">
                  <div className="redis-card-title">{tr('Nie udało się połączyć')}</div>
                  <p className="redis-error-text">{tabError}</p>
                  <button className="btn small primary" onClick={() => reconnectTab(tabId)}>{tr('Połącz ponownie')}</button>
                </div>
              ) : <div className="muted redis-connecting" role="status"><BusyRing className="redis-ring" /> {phase ? tr(phase.key, phase.params) : tr('łączenie…')}</div>}
          </div>
        )}
    </div>
  );
}

function Body({ view, props }: { view: View; props: RedisViewProps }) {
  switch (view) {
    case 'keys': return <RedisKeyBrowser key={props.tabId} {...props} />;
    case 'console': return <RedisConsole key={props.tabId} {...props} />;
    case 'pubsub': return <RedisPubSub key={props.tabId} {...props} />;
    case 'info': return <RedisServer key={props.tabId} {...props} />;
  }
}

/** The tab's login question: the SSH tunnel's (host key, password, passphrase) or the Redis password. */
function Login({ sessionId, prompt }: { sessionId: string; prompt: DbPrompt }) {
  const storage = useSshStore((st) => st.vault?.storage ?? 'unavailable');
  const respond = (reply: PromptReply) => { void window.mc.db.answer({ ...(reply as object), sessionId } as Parameters<typeof window.mc.db.answer>[0]); };
  return (
    <div className="redis-card login">
      {prompt.kind === 'dbPassword' ? <PasswordPrompt sessionId={sessionId} prompt={prompt} />
        : prompt.kind === 'hostKey' ? <HostKeyPrompt key={prompt.id} cellId={sessionId} prompt={prompt} respond={respond} />
          : prompt.kind === 'sudo' ? null
            : <AuthPrompt key={prompt.id} cellId={sessionId} prompt={prompt} storage={storage} respond={respond} />}
    </div>
  );
}

function PasswordPrompt({ sessionId, prompt }: { sessionId: string; prompt: Extract<DbPrompt, { kind: 'dbPassword' }> }) {
  const { tr } = useI18n();
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const submit = () => { void window.mc.db.answer({ sessionId, promptId: prompt.id, values: [value], ...(prompt.canSave ? { remember } : {}) }); setValue(''); };
  const cancel = () => { void window.mc.db.answer({ sessionId, promptId: prompt.id, cancel: true }); setValue(''); };
  return (
    <form className="redis-password" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') cancel(); }}>
      <div className="redis-card-title">{tr('Hasło do Redis')}</div>
      <p className="muted">{prompt.user ? `${prompt.user}@` : ''}{prompt.endpoint} · {prompt.connectionName}</p>
      {prompt.retry && <p className="redis-error-text">{tr('Serwer odrzucił hasło. Spróbuj ponownie.')}</p>}
      <input className="input" type="password" autoFocus value={value} aria-label={tr('Hasło')} onChange={(e) => setValue(e.target.value)} />
      {prompt.canSave && <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {tr('Zapamiętaj hasło')}</label>}
      <div className="redis-row-actions">
        <button type="submit" className="btn small primary">{tr('Połącz')}</button>
        <button type="button" className="btn small" onClick={cancel}>{tr('Anuluj')}</button>
      </div>
    </form>
  );
}

export default RedisTabView;
