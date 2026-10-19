// The server views of a Redis tab (1.0.0): INFO as readable groups (summary, memory, clients, keyspace, replication,
// persistence, stats, then the other sections), the SLOWLOG list and the CLIENT LIST table; refresh.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { parseRedisKeyspace, redisDataDisplay, type RedisClientInfo, type RedisInfoSection, type RedisSlowlogEntry } from '../../../../shared/dbRedis';
import { formatBytes, formatTtl, formatUptime, hitRatio, infoGroups, infoValue } from '../../../../shared/redisView';
import { useI18n } from '../../i18n';
import { onForgetTab, resultText, withTab } from '../../redis/redisClient';
import { RefreshIcon } from '../Spinner';
import type { RedisViewProps } from './RedisTabView';

type Section = 'info' | 'slowlog' | 'clients';
interface ServerData { info: RedisInfoSection[] | null; slowlog: RedisSlowlogEntry[] | null; clients: RedisClientInfo[] | null; error: string | null; loading: boolean; at: number | null }
const empty: ServerData = { info: null, slowlog: null, clients: null, error: null, loading: false, at: null };
const useServer = create<Record<string, ServerData>>(() => ({}));
const patch = (tabId: string, p: Partial<ServerData>) => useServer.setState((st) => ({ [tabId]: { ...(st[tabId] ?? empty), ...p } }));
onForgetTab((tabId) => useServer.setState((st) => { const next = { ...st }; delete next[tabId]; return next; }, true));

async function load(tabId: string): Promise<void> {
  patch(tabId, { loading: true, error: null });
  const info = await withTab(tabId, (sid) => window.mc.db.redis.info(sid));
  const slowlog = await withTab(tabId, (sid) => window.mc.db.redis.slowlog(sid, 128));
  const clients = await withTab(tabId, (sid) => window.mc.db.redis.clients(sid));
  const firstError = [info, slowlog, clients].find((r) => !r.ok);
  patch(tabId, {
    loading: false, at: Date.now(), error: firstError && !firstError.ok ? resultText(firstError) : null,
    info: info.ok ? info.value : null, slowlog: slowlog.ok ? slowlog.value : null, clients: clients.ok ? clients.value : null,
  });
}

const CLIENT_COLUMNS = ['id', 'addr', 'name', 'db', 'cmd', 'age', 'idle', 'flags', 'user'];

export default function RedisServer({ tabId }: RedisViewProps) {
  const { tr } = useI18n();
  const data = useServer((st) => st[tabId]) ?? empty;
  const [section, setSection] = useState<Section>('info');
  const [showOther, setShowOther] = useState(false);
  useEffect(() => { if (!data.at && !data.loading) void load(tabId); }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = data.info ?? [];
  const groups = infoGroups(info);
  const keyspace = parseRedisKeyspace(info);
  const totalKeys = keyspace.reduce((n, d) => n + d.keys, 0);
  const ratio = hitRatio(info);
  const used = Number(infoValue(info, 'used_memory'));
  const summary: Array<[string, string]> = [
    [tr('Wersja'), infoValue(info, 'redis_version') ?? infoValue(info, 'valkey_version') ?? '?'],
    [tr('Tryb'), infoValue(info, 'redis_mode') ?? '-'],
    [tr('Czas działania'), formatUptime(infoValue(info, 'uptime_in_seconds')) ?? '-'],
    [tr('Klienci'), infoValue(info, 'connected_clients') ?? '-'],
    [tr('Pamięć'), Number.isFinite(used) ? formatBytes(used) : infoValue(info, 'used_memory_human') ?? '-'],
    [tr('Klucze'), totalKeys.toLocaleString()],
    [tr('Operacje/s'), infoValue(info, 'instantaneous_ops_per_sec') ?? '-'],
    [tr('Trafienia'), ratio === null ? '-' : `${ratio}%`],
  ];
  const sectionName = (name: string) => ({ Memory: tr('Pamięć'), Clients: tr('Klienci'), Keyspace: tr('Bazy i klucze'), Replication: tr('Replikacja'), Persistence: tr('Trwałość'), Stats: tr('Statystyki') } as Record<string, string>)[name] ?? name;
  return (
    <div className="redis-server">
      <div className="redis-toolbar">
        <div className="redis-seg" role="tablist" aria-label={tr('Widoki serwera')}>
          {(['info', 'slowlog', 'clients'] as Section[]).map((s) => (
            <button key={s} role="tab" aria-selected={section === s} className={section === s ? 'on' : ''} onClick={() => setSection(s)}>
              {s === 'info' ? tr('Informacje') : s === 'slowlog' ? tr('Wolne polecenia') : tr('Klienci')}
              {s === 'slowlog' && data.slowlog ? ` (${data.slowlog.length})` : s === 'clients' && data.clients ? ` (${data.clients.length})` : ''}
            </button>
          ))}
        </div>
        <span className="grow" />
        {data.at && <span className="muted">{tr('Odczytano {time}', { time: new Date(data.at).toLocaleTimeString() })}</span>}
        <button className="btn small icon ghost redis-server-refresh" title={tr('Odśwież')} aria-label={tr('Odśwież')} onClick={() => void load(tabId)}><RefreshIcon spinning={data.loading} /></button>
      </div>
      {data.error && <div className="redis-error-text pad" role="alert">{data.error}</div>}
      <div className="redis-server-body">
        {section === 'info' && <>
          <div className="redis-stats">
            {summary.map(([k, v]) => <div key={k} className="redis-stat"><span className="muted">{k}</span><strong>{v}</strong></div>)}
          </div>
          <div className="redis-info-grid">
            {groups.main.map((s) => (s.name.toLowerCase() === 'keyspace' ? <KeyspaceCard key={s.name} title={sectionName(s.name)} section={s} /> : <InfoCard key={s.name} title={sectionName(s.name)} section={s} />))}
          </div>
          {groups.other.length > 0 && <>
            <button className="btn small ghost" onClick={() => setShowOther(!showOther)}>{showOther ? tr('Ukryj pozostałe sekcje') : tr('Pokaż pozostałe sekcje ({count})', { count: groups.other.length })}</button>
            {showOther && <div className="redis-info-grid">{groups.other.map((s) => <InfoCard key={s.name} title={s.name || '-'} section={s} />)}</div>}
          </>}
        </>}
        {section === 'slowlog' && (
          data.slowlog?.length ? (
            <table className="redis-table">
              <thead><tr><th>#</th><th>{tr('Czas')}</th><th className="num">{tr('Trwanie')}</th><th>{tr('Polecenie')}</th><th>{tr('Klient')}</th></tr></thead>
              <tbody>{data.slowlog.map((e) => (
                <tr key={e.id}>
                  <td className="num muted">{e.id}</td>
                  <td className="muted">{new Date(e.time * 1000).toLocaleString()}</td>
                  <td className="num">{e.durationUs >= 1000 ? `${(e.durationUs / 1000).toFixed(1)} ms` : `${e.durationUs} µs`}</td>
                  <td className="mono">{e.args.map(redisDataDisplay).join(' ')}</td>
                  <td className="muted">{[e.client, e.clientName].filter(Boolean).join(' ')}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div className="redis-empty muted">{tr('Brak wolnych poleceń')}</div>
        )}
        {section === 'clients' && (
          data.clients?.length ? (
            <table className="redis-table">
              <thead><tr>{CLIENT_COLUMNS.map((c) => <th key={c} className={c === 'age' || c === 'idle' || c === 'id' ? 'num' : ''}>{c}</th>)}</tr></thead>
              <tbody>{data.clients.map((c, i) => <tr key={c.id ?? i}>{CLIENT_COLUMNS.map((col) => <td key={col} className={col === 'age' || col === 'idle' || col === 'id' ? 'num' : col === 'cmd' ? 'mono' : ''}>{c[col] ?? ''}</td>)}</tr>)}</tbody>
            </table>
          ) : <div className="redis-empty muted">{tr('Brak danych')}</div>
        )}
      </div>
    </div>
  );
}

/** INFO keyspace as a table: DB, keys, keys with an expiry, average TTL. */
function KeyspaceCard({ title, section }: { title: string; section: RedisInfoSection }) {
  const { tr } = useI18n();
  const dbs = parseRedisKeyspace([section]);
  return (
    <section className="redis-info-card">
      <h3>{title}</h3>
      {dbs.length ? (
        <table className="redis-table compact">
          <thead><tr><th>DB</th><th className="num">{tr('Klucze')}</th><th className="num">{tr('Z wygaśnięciem')}</th><th className="num">{tr('Średni TTL')}</th></tr></thead>
          <tbody>{dbs.map((d) => <tr key={d.index}><td>db{d.index}</td><td className="num">{d.keys.toLocaleString()}</td><td className="num">{d.expires.toLocaleString()}</td><td className="num">{d.avgTtlMs ? formatTtl(d.avgTtlMs) : '-'}</td></tr>)}</tbody>
        </table>
      ) : <p className="muted">{tr('Brak kluczy')}</p>}
    </section>
  );
}

function InfoCard({ title, section }: { title: string; section: RedisInfoSection }) {
  return (
    <section className="redis-info-card">
      <h3>{title}</h3>
      <table className="redis-kv"><tbody>
        {section.entries.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}
      </tbody></table>
    </section>
  );
}
