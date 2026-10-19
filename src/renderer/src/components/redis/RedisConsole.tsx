// The Redis console (1.0.0): a command line with history (up/down, kept per connection) and command name completion (Tab),
// replies rendered by type (simple, error, integer, bulk with a binary marker, nested arrays, nil, maps), dangerous commands
// asked about first (the command shown), refusals of blocking and subscribe commands with a hint, read-only refusals with an
// explicit override, Ctrl+L clears.
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { classifyRedisCommand, parseRedisCommandLine, redisCommandName, redisDataDisplay, type RedisData, type RedisReply } from '../../../../shared/dbRedis';
import { completeCommand, isMapReply, pushHistory, replyText } from '../../../../shared/redisView';
import { useI18n } from '../../i18n';
import { askChoice, toast } from '../../store';
import { openRedisTab, resultText, withTab } from '../../redis/redisClient';
import type { RedisViewProps } from './RedisTabView';

type Entry =
  | { id: number; kind: 'command'; line: string; db: number }
  | { id: number; kind: 'reply'; command: string; reply: RedisReply; timeMs: number }
  | { id: number; kind: 'note'; text: string; tone: 'error' | 'info'; action?: { label: string; run: () => void } };

/** The output of each console tab (kept while another tab is in front), at most this many entries. */
const MAX_ENTRIES = 500;
const useOutputs = create<Record<string, Entry[]>>(() => ({}));
let nextId = 1;
type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, 'id'> : never) : never;
const push = (tabId: string, entry: NewEntry) =>
  useOutputs.setState((st) => ({ [tabId]: [...(st[tabId] ?? []), { ...entry, id: nextId++ } as Entry].slice(-MAX_ENTRIES) }));

const historyKey = (connectionId: string) => `mc-redis-history-v1:${connectionId}`;
function readHistory(connectionId: string): string[] {
  try { const v: unknown = JSON.parse(localStorage.getItem(historyKey(connectionId)) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : []; } catch { return []; }
}
const writeHistory = (connectionId: string, h: string[]) => { try { localStorage.setItem(historyKey(connectionId), JSON.stringify(h)); } catch { /* full */ } };

export default function RedisConsole({ tabId, ref, readOnly }: RedisViewProps) {
  const { tr } = useI18n();
  const output = useOutputs((st) => st[tabId]) ?? [];
  const [line, setLine] = useState('');
  const [history, setHistory] = useState(() => readHistory(ref.connectionId));
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(() => completeCommand(line), [line]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [output.length]);
  useEffect(() => setPick(0), [line]);

  const send = async (argv: RedisData[], text: string, opts: { confirmed?: boolean; readWrite?: boolean } = {}) => {
    const command = redisCommandName(argv);
    setBusy(true);
    const r = await withTab(tabId, (sid) => window.mc.db.redis.command(sid, { argv, ...opts }));
    setBusy(false);
    if (r.ok) { push(tabId, { kind: 'reply', command, reply: r.value.reply, timeMs: r.value.timeMs }); return; }
    if (r.error === 'readOnly') {
      push(tabId, { kind: 'note', tone: 'error', text: tr('To połączenie jest tylko do odczytu - polecenie nie zostało wysłane.'), action: {
        label: tr('Uruchom mimo to…'),
        run: () => void (async () => {
          const ok = await askChoice(tr('Uruchomić polecenie z zapisem?'), tr('Połączenie jest tylko do odczytu. To polecenie może zmienić dane:\n{command}', { command: text }), [
            { label: tr('Uruchom raz'), value: 'run', danger: true },
          ]);
          if (ok === 'run') { push(tabId, { kind: 'command', line: text, db: ref.db }); await send(argv, text, { ...opts, readWrite: true }); }
        })(),
      } });
      return;
    }
    if (r.error === 'needsConfirm' && !opts.confirmed) { await confirmAndSend(argv, text, opts); return; }
    push(tabId, { kind: 'note', tone: 'error', text: resultText(r, ref.connectionId) });
  };
  const confirmAndSend = async (argv: RedisData[], text: string, opts: { readWrite?: boolean } = {}) => {
    const choice = await askChoice(tr('Uruchomić niebezpieczne polecenie?'), tr('To polecenie może usunąć dane albo zatrzymać serwer:\n{command}', { command: text }), [
      { label: tr('Uruchom'), value: 'run', danger: true },
    ]);
    if (choice !== 'run') { push(tabId, { kind: 'note', tone: 'info', text: tr('Anulowano') }); return; }
    await send(argv, text, { ...opts, confirmed: true });
  };
  const run = async () => {
    const text = line.trim();
    if (!text || busy) return;
    const parsed = parseRedisCommandLine(text);
    const next = pushHistory(history, text);
    setHistory(next); writeHistory(ref.connectionId, next); setAt(null); setLine('');
    push(tabId, { kind: 'command', line: text, db: ref.db });
    if (!parsed.ok) { push(tabId, { kind: 'note', tone: 'error', text: parsed.error === 'unbalancedQuotes' ? tr('Niezamknięty cudzysłów') : tr('Puste polecenie') }); return; }
    const cls = classifyRedisCommand(parsed.argv);
    if (cls.refused === 'subscribe') {
      push(tabId, { kind: 'note', tone: 'error', text: tr('Subskrypcje działają w zakładce Pub/Sub, nie w konsoli'), action: { label: tr('Otwórz Pub/Sub'), run: () => { openRedisTab(ref.connectionId, 'pubsub', ref.db); } } });
      return;
    }
    if (cls.refused === 'blocking') { push(tabId, { kind: 'note', tone: 'error', text: tr('{command} blokuje połączenie i nie działa w konsoli. Do śledzenia wiadomości użyj zakładki Pub/Sub.', { command: cls.name }) }); return; }
    if (cls.refused) { push(tabId, { kind: 'note', tone: 'error', text: tr('Tego polecenia nie można użyć w konsoli') }); return; }
    if (cls.dangerous) { await confirmAndSend(parsed.argv, text); return; }
    await send(parsed.argv, text);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); useOutputs.setState({ [tabId]: [] }); return; }
    if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); setLine(`${suggestions[pick] ?? suggestions[0]} `); return; }
    if (e.key === 'Enter') { e.preventDefault(); void run(); return; }
    if (e.key === 'Escape') { setLine(''); setAt(null); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // With a completion list open the arrows pick in it; otherwise they walk the history.
      if (suggestions.length && line && at === null) { e.preventDefault(); setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return; }
      if (!history.length) return;
      e.preventDefault();
      const i = e.key === 'ArrowUp' ? (at === null ? history.length - 1 : Math.max(0, at - 1)) : at === null ? null : at + 1 >= history.length ? null : at + 1;
      setAt(i);
      setLine(i === null ? '' : history[i]);
    }
  };
  return (
    <div className="redis-console" onClick={(e) => { if (e.target === e.currentTarget) input.current?.focus(); }}>
      <div className="redis-console-log" ref={log} role="log" aria-live="polite">
        {!output.length && <p className="muted redis-console-hint">{tr('Wpisz polecenie Redis, np. GET klucz. Tab uzupełnia nazwę, strzałki przewijają historię, Ctrl+L czyści.')}</p>}
        {output.map((e) => e.kind === 'command' ? (
          <div key={e.id} className="redis-console-cmd"><span className="redis-prompt">db{e.db}&gt;</span> {e.line}</div>
        ) : e.kind === 'note' ? (
          <div key={e.id} className={`redis-console-note ${e.tone}`}>{e.text}{e.action && <button className="btn small" onClick={e.action.run}>{e.action.label}</button>}</div>
        ) : (
          <div key={e.id} className="redis-console-reply">
            <Reply reply={e.reply} command={e.command} />
            <span className="redis-console-meta">
              <span className="muted">{e.timeMs < 1 ? '<1 ms' : `${Math.round(e.timeMs)} ms`}</span>
              <button className="btn ghost small" onClick={() => { window.mc.clipboardWrite(replyText(e.reply)); toast(tr('Skopiowano')); }}>{tr('Kopiuj')}</button>
            </span>
          </div>
        ))}
      </div>
      <div className="redis-console-input">
        {suggestions.length > 0 && (
          <ul className="redis-suggest" role="listbox" aria-label={tr('Podpowiedzi')}>
            {suggestions.map((s, i) => <li key={s} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); setLine(`${s} `); input.current?.focus(); }}>{s}</li>)}
          </ul>
        )}
        <span className="redis-prompt">db{ref.db}&gt;</span>
        <input ref={input} className="redis-console-line" value={line} spellCheck={false} autoComplete="off" aria-label={tr('Polecenie Redis')} disabled={busy}
          placeholder={readOnly ? tr('Tylko do odczytu: polecenia zapisu są blokowane') : ''} onChange={(e) => { setLine(e.target.value); setAt(null); }} onKeyDown={onKey} />
        {busy && <span className="muted">{tr('Wykonywanie…')}</span>}
      </div>
    </div>
  );
}

/** A reply by its RESP type; arrays nest with their positions, map replies (HGETALL, CONFIG GET ...) show as pairs. */
function Reply({ reply, command }: { reply: RedisReply; command: string }) {
  const { tr } = useI18n();
  switch (reply.t) {
    case 'simple': return <span className="rr simple">{reply.v}</span>;
    case 'error': return <span className="rr error">(error) {reply.v}</span>;
    case 'integer': return <span className="rr integer">(integer) {reply.v}</span>;
    case 'null': return <span className="rr nil">(nil)</span>;
    case 'bulk': return (
      <span className="rr bulk">
        {typeof reply.v !== 'string' && <span className="redis-bin" title={tr('Dane binarne')}>bin</span>}
        "{redisDataDisplay(reply.v)}"
        {reply.truncated && <span className="redis-cut"> {tr('(ucięto, całość: {bytes} B)', { bytes: reply.bytes })}</span>}
      </span>
    );
    case 'array': {
      if (!reply.items.length) return <span className="rr nil">(empty array)</span>;
      if (isMapReply(command, reply)) {
        const pairs: Array<[RedisReply, RedisReply]> = [];
        for (let i = 0; i < reply.items.length; i += 2) pairs.push([reply.items[i], reply.items[i + 1]]);
        return (
          <table className="rr map"><tbody>
            {pairs.map(([k, v], i) => <tr key={i}><th>{k.t === 'bulk' || k.t === 'simple' ? (typeof k.v === 'string' ? k.v : redisDataDisplay(k.v)) : <Reply reply={k} command="" />}</th><td><Reply reply={v} command="" /></td></tr>)}
          </tbody></table>
        );
      }
      return (
        <ol className="rr array">
          {reply.items.map((item, i) => <li key={i}><span className="rr-index">{i + 1})</span> <Reply reply={item} command="" /></li>)}
          {reply.length > reply.items.length && <li className="muted">{tr('… i jeszcze {count}', { count: reply.length - reply.items.length })}</li>}
        </ol>
      );
    }
  }
}

