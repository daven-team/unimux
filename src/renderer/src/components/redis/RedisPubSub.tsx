// The Pub/Sub tab (1.0.0): subscribe to channels and patterns (chips to remove them), the live message list (time, channel,
// pattern, payload; JSON pretty view and a binary marker in the detail), pause, clear, filter, the count of dropped messages
// and a publish form. Messages keep arriving while another tab is in front (redisClient keeps them).
import { useEffect, useMemo, useState } from 'react';
import { isBinaryData, redisDataDisplay, redisDataKey, type RedisData } from '../../../../shared/dbRedis';
import { clockTime, formatBytes, formatJson, hexDump, isJsonText, messageMatches, type RedisPubSubRow } from '../../../../shared/redisView';
import { useI18n } from '../../i18n';
import { toast } from '../../store';
import { pubsubOf, resultText, setPaused, updatePubSub, useRedisStore, withTab } from '../../redis/redisClient';
import { IX } from '../icons';
import { DataText, preview, VirtualList } from './common';
import type { RedisViewProps } from './RedisTabView';

export default function RedisPubSub({ tabId, sessionId, readOnly }: RedisViewProps) {
  const { tr } = useI18n();
  const ps = useRedisStore((st) => pubsubOf(st, sessionId));
  const [target, setTarget] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [channel, setChannel] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    void withTab(tabId, (sid) => window.mc.db.redis.pubsubState(sid)).then((r) => { if (r.ok) updatePubSub(sessionId, () => ({ state: r.value })); });
  }, [tabId, sessionId]);
  const messages = ps?.messages ?? [];
  const shown = useMemo(() => {
    const list = filter.trim() ? messages.filter((m) => messageMatches(m, filter)) : messages;
    return [...list].reverse(); // newest on top
  }, [messages, filter]);
  const current = shown.find((m) => m.seq === selected);
  const state = ps?.state;
  const subscribe = async (kind: 'channels' | 'patterns') => {
    const name = target.trim();
    if (!name) return;
    const r = await withTab(tabId, (sid) => window.mc.db.redis.subscribe(sid, { [kind]: [name] }));
    if (!r.ok) { toast(resultText(r), 'error'); return; }
    updatePubSub(sessionId, () => ({ state: r.value }));
    // Something typed meanwhile stays in the field.
    setTarget((t) => (t.trim() === name ? '' : t));
  };
  const unsubscribe = async (kind: 'channels' | 'patterns', name: RedisData) => {
    const r = await withTab(tabId, (sid) => window.mc.db.redis.unsubscribe(sid, { [kind]: [name] }));
    if (!r.ok) { toast(resultText(r), 'error'); return; }
    updatePubSub(sessionId, () => ({ state: r.value }));
  };
  const publish = async () => {
    if (!channel) return;
    const r = await withTab(tabId, (sid) => window.mc.db.redis.publish(sid, channel, message));
    if (!r.ok) { toast(resultText(r), 'error'); return; }
    toast(tr('Wysłano. Odbiorców: {count}', { count: r.value }));
  };
  const stateText = !state || state.state === 'idle' ? tr('brak subskrypcji') : state.state === 'ready' ? tr('nasłuchiwanie')
    : state.state === 'connecting' ? (state.reconnect ? tr('Ponowne łączenie ({n})…', { n: state.reconnect }) : tr('łączenie…')) : tr('zamknięte');
  const dropped = Math.max(ps?.dropped ?? 0, state?.dropped ?? 0);
  return (
    <div className="redis-pubsub">
      <div className="redis-toolbar">
        <input className="input redis-sub-input" value={target} placeholder={tr('Kanał lub wzorzec, np. news lub events:*')} aria-label={tr('Kanał lub wzorzec')} spellCheck={false}
          onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void subscribe(/[*?[]/.test(target) ? 'patterns' : 'channels'); }} />
        <button className="btn small redis-sub-channel" onClick={() => void subscribe('channels')}>{tr('Subskrybuj kanał')}</button>
        <button className="btn small redis-sub-pattern" onClick={() => void subscribe('patterns')}>{tr('Subskrybuj wzorzec')}</button>
        <span className={`redis-chip ${state?.state === 'ready' ? 'ok' : state?.state === 'closed' ? 'warn' : ''}`} role="status">{stateText}</span>
        {state?.error && <span className="redis-error-text">{state.error}</span>}
      </div>
      {(state?.channels.length || state?.patterns.length) ? (
        <div className="redis-chips" aria-label={tr('Subskrypcje')}>
          {state.channels.map((c) => <Chip key={`c${redisDataKey(c)}`} data={c} kind={tr('kanał')} onRemove={() => void unsubscribe('channels', c)} />)}
          {state.patterns.map((p) => <Chip key={`p${redisDataKey(p)}`} data={p} kind={tr('wzorzec')} onRemove={() => void unsubscribe('patterns', p)} />)}
        </div>
      ) : null}
      <div className="redis-toolbar sub">
        <form className="redis-search" onSubmit={(e) => e.preventDefault()}>
          <input className="input redis-msg-filter" value={filter} placeholder={tr('Filtruj wiadomości')} aria-label={tr('Filtruj wiadomości')} spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
        </form>
        <button className={`btn small redis-pause ${ps?.paused ? 'on' : ''}`} aria-pressed={!!ps?.paused} onClick={() => setPaused(sessionId, !ps?.paused)}>
          {ps?.paused ? tr('Wznów ({count} nowych)', { count: ps.held.length }) : tr('Wstrzymaj')}
        </button>
        <button className="btn small" onClick={() => { updatePubSub(sessionId, () => ({ messages: [], held: [] })); setSelected(null); }}>{tr('Wyczyść')}</button>
        <span className="grow" />
        {dropped > 0 && <span className="redis-chip warn" title={tr('Wiadomości przychodziły szybciej, niż można je pokazać')}>{tr('Pominięto: {count}', { count: dropped })}</span>}
        <span className="muted redis-msg-count">{tr('Wiadomości: {count}', { count: messages.length })}</span>
      </div>
      <div className="redis-pubsub-main">
        <div className="redis-msg-head" aria-hidden="true"><span>{tr('Czas')}</span><span>{tr('Kanał')}</span><span>{tr('Wiadomość')}</span></div>
        <VirtualList className="redis-msg-list" label={tr('Wiadomości')} count={shown.length} rowHeight={26}
          row={(i) => <MessageRow m={shown[i]} current={shown[i].seq === selected} onPick={() => setSelected(shown[i].seq)} />}
          end={!shown.length ? <div className="redis-empty muted">{state?.state === 'ready' ? tr('Czekam na wiadomości…') : tr('Zasubskrybuj kanał, aby zobaczyć wiadomości')}</div> : null} />
        {current && <MessageDetail m={current} onClose={() => setSelected(null)} />}
      </div>
      {readOnly ? <div className="redis-foot muted">{tr('Połączenie tylko do odczytu: publikowanie jest wyłączone.')}</div> : (
        <form className="redis-publish" onSubmit={(e) => { e.preventDefault(); void publish(); }}>
          <input className="input redis-pub-channel" value={channel} placeholder={tr('Kanał')} aria-label={tr('Kanał')} spellCheck={false} onChange={(e) => setChannel(e.target.value)} />
          <input className="input redis-pub-message" value={message} placeholder={tr('Wiadomość')} aria-label={tr('Wiadomość')} spellCheck={false} onChange={(e) => setMessage(e.target.value)} />
          <button type="submit" className="btn small primary redis-publish-btn" disabled={!channel}>{tr('Opublikuj')}</button>
        </form>
      )}
    </div>
  );
}

function Chip({ data, kind, onRemove }: { data: RedisData; kind: string; onRemove: () => void }) {
  const { tr } = useI18n();
  return (
    <span className="redis-sub-chip" title={kind}>
      <span className="muted">{kind}</span> <DataText data={data} />
      <button className="btn ghost icon small" aria-label={tr('Anuluj subskrypcję {name}', { name: redisDataDisplay(data) })} onClick={onRemove}><IX /></button>
    </span>
  );
}

function MessageRow({ m, current, onPick }: { m: RedisPubSubRow; current: boolean; onPick: () => void }) {
  return (
    <div className={`redis-msg-row ${current ? 'current' : ''}`} onClick={onPick}>
      <span className="mono muted">{clockTime(m.time)}</span>
      <span className="redis-msg-channel"><DataText data={m.channel} />{m.pattern !== undefined && <span className="redis-msg-pattern">{redisDataDisplay(m.pattern)}</span>}</span>
      <span className="redis-msg-payload">{isBinaryData(m.payload.data) && <span className="redis-bin">bin</span>}{preview(m.payload.data, 400)}</span>
    </div>
  );
}

function MessageDetail({ m, onClose }: { m: RedisPubSubRow; onClose: () => void }) {
  const { tr } = useI18n();
  const binary = isBinaryData(m.payload.data);
  const text = redisDataDisplay(m.payload.data);
  const json = !binary && isJsonText(text);
  const [pretty, setPretty] = useState(true);
  const body = binary ? hexDump(m.payload.data).join('\n') : json && pretty ? formatJson(text) ?? text : text;
  return (
    <div className="redis-editor redis-msg-detail">
      <div className="redis-editor-head">
        <span className="mono muted">{clockTime(m.time)}</span> <DataText data={m.channel} className="strong" />
        {m.pattern !== undefined && <span className="muted">{tr('wzorzec {pattern}', { pattern: redisDataDisplay(m.pattern) })}</span>}
        <span className="muted">{formatBytes(m.payload.bytes)}{m.payload.truncated ? ` ${tr('(ucięto)')}` : ''}</span>
        <span className="grow" />
        {json && <label className="check"><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> JSON</label>}
        <button className="btn ghost small" onClick={() => { window.mc.clipboardWrite(text); toast(tr('Skopiowano')); }}>{tr('Kopiuj')}</button>
        <button className="btn ghost icon small" aria-label={tr('Zamknij')} onClick={onClose}><IX /></button>
      </div>
      <pre className="redis-msg-body">{body}</pre>
    </div>
  );
}
