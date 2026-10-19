// A Redis tab of the top strip (1.0.0): the connection bar (colour, name, endpoint, DB, version, TLS, read-only, switching to the
// other views), the login of its session (DbLogin: SSH host key and password, the Redis password) and the view itself.
import { lazy, Suspense, useEffect } from 'react';
import { dbEndpoint, dbPhaseLabel } from '../../../../shared/db';
import type { RedisTabRef, RedisTabView as View } from '../../../../shared/redisView';
import { useFileStore } from '../../files';
import { useI18n } from '../../i18n';
import { useStore } from '../../store';
import { ensureTabSession, openRedisTab, reconnectTab, tabSessionState, useRedisStore, viewLabel } from '../../redis/redisClient';
import { DbLogin } from '../db/DbLogin';
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
            {prompt && sessionId ? <div className="redis-card login"><DbLogin sessionId={sessionId} /></div>
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

export default RedisTabView;
