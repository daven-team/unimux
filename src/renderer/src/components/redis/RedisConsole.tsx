// The Redis console (1.0.0): a command line with history (up/down, kept per connection, never with passwords) and command name
// completion (Tab), replies rendered by type (simple, error, integer, bulk with a binary marker, nested arrays, nil, maps; big
// replies shown in parts with "show more"), dangerous commands asked about first (the command and where it runs shown), refusals
// of blocking and subscribe commands with a hint, read-only refusals with an explicit override, Ctrl+L clears.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { dbEndpoint } from '../../../../shared/db';
import { parseRedisCommandLine, redisCommandName, redisDataDisplay, type RedisData, type RedisReply } from '../../../../shared/dbRedis';
import { afterConsoleError, completeCommand, consoleRoute, historyLine, isMapReply, pushHistory, replyText } from '../../../../shared/redisView';
import { useI18n } from '../../i18n';
import { askChoice, toast } from '../../store';
import { connectionOf, onForgetTab, openRedisTab, resultText, whereText, withTab } from '../../redis/redisClient';
import { openMenuAt } from '../ContextMenu';
import { IMore } from '../icons';
import type { RedisViewProps } from './RedisTabView';

type Entry =
  | { id: number; kind: 'command'; line: string; db: number }
  | { id: number; kind: 'reply'; command: string; reply: RedisReply; timeMs: number }
  | { id: number; kind: 'note'; text: string; tone: 'error' | 'info'; action?: { label: string; run: () => void } };

/** The output of each console tab (kept while another tab is in front, dropped when it closes), at most this many entries. */
const MAX_ENTRIES = 500;
/** Items of one array or map shown at first (top level / nested); "show more" adds the next ones. */
const SHOW_ITEMS = 200, SHOW_NESTED = 50, SHOW_STEP = 1000;
const useOutputs = create<Record<string, Entry[]>>(() => ({}));
onForgetTab((tabId) => useOutputs.setState((st) => { const next = { ...st }; delete next[tabId]; return next; }, true));
let nextId = 1;
type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, 'id'> : never) : never;
const push = (tabId: string, entry: NewEntry) =>
  useOutputs.setState((st) => ({ [tabId]: [...(st[tabId] ?? []), { ...entry, id: nextId++ } as Entry].slice(-MAX_ENTRIES) }));

const historyKey = (connectionId: string) => `mc-redis-history-v1:${connectionId}`;
function readHistory(connectionId: string): string[] {
  try { const v: unknown = JSON.parse(localStorage.getItem(historyKey(connectionId)) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : []; } catch { return []; }
}
const writeHistory = (connectionId: string, h: string[]) => {
  try { if (h.length) localStorage.setItem(historyKey(connectionId), JSON.stringify(h)); else localStorage.removeItem(historyKey(connectionId)); } catch { /* full */ }
};

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
  /** "local redis · DB 0 · 127.0.0.1:6379" for dangerous confirmations. */
  const where = () => { const c = connectionOf(ref.connectionId); return [whereText(tabId), c ? dbEndpoint(c).replace(/\/\d+$/, '') : ''].filter(Boolean).join(' · '); };

  const send = async (argv: RedisData[], text: string, opts: { confirmed?: boolean; readWrite?: boolean } = {}) => {
    const command = redisCommandName(argv);
    setBusy(true);
    const r = await withTab(tabId, (sid) => window.mc.db.redis.command(sid, { argv, ...opts }));
    setBusy(false);
    // The input stays enabled (read-only while busy): the cursor is back for the next command at once.
    requestAnimationFrame(() => input.current?.focus());
    if (r.ok) { push(tabId, { kind: 'reply', command, reply: r.value.reply, timeMs: r.value.timeMs }); return; }
    const next = afterConsoleError(r.error, argv, !!opts.confirmed);
    if (next.kind === 'offerWrite') {
      push(tabId, { kind: 'note', tone: 'error', text: tr('To połączenie jest tylko do odczytu - polecenie nie zostało wysłane.'), action: {
        label: tr('Uruchom mimo to…'),
        run: () => void (async () => {
          const ok = await askChoice(tr('Uruchomić polecenie z zapisem?'), `${tr('Połączenie jest tylko do odczytu. To polecenie może zmienić dane:\n{command}', { command: text })}\n${where()}`, [
            { label: tr('Uruchom raz'), value: 'run', danger: true },
          ]);
          if (ok === 'run') { push(tabId, { kind: 'command', line: text, db: ref.db }); await send(argv, text, { ...opts, readWrite: true }); }
        })(),
      } });
      return;
    }
    // The server side asks too: a command the server marks dangerous, or a read whose reply would be very big.
    if (next.kind === 'ask') { await confirmAndSend(argv, text, opts, next.why); return; }
    // A command that hit its deadline is never sent again by itself.
    push(tabId, { kind: 'note', tone: 'error', text: resultText(r, ref.connectionId) });
  };
  const confirmAndSend = async (argv: RedisData[], text: string, opts: { readWrite?: boolean } = {}, why: 'danger' | 'big' = 'danger') => {
    const body = why === 'danger' ? tr('To polecenie może usunąć dane albo zatrzymać serwer:\n{command}', { command: text })
      : tr('Odpowiedź może być bardzo duża albo serwer oznacza to polecenie jako niebezpieczne:\n{command}', { command: text });
    const choice = await askChoice(why === 'danger' ? tr('Uruchomić niebezpieczne polecenie?') : tr('Uruchomić to polecenie?'), `${body}\n${where()}`, [
      { label: tr('Uruchom'), value: 'run', danger: true },
    ]);
    if (choice !== 'run') { push(tabId, { kind: 'note', tone: 'info', text: tr('Anulowano') }); requestAnimationFrame(() => input.current?.focus()); return; }
    await send(argv, text, { ...opts, confirmed: true });
  };
  const run = async () => {
    const text = line.trim();
    if (!text || busy) return;
    const parsed = parseRedisCommandLine(text);
    setAt(null); setLine('');
    // The history keeps only parsed lines, with passwords masked or the line left out (AUTH, HELLO ... AUTH).
    const kept = parsed.ok ? historyLine(parsed.argv) : null;
    if (kept !== null) { const next = pushHistory(history, kept); setHistory(next); writeHistory(ref.connectionId, next); }
    push(tabId, { kind: 'command', line: parsed.ok ? kept ?? `${redisCommandName(parsed.argv)} ***` : text, db: ref.db });
    if (!parsed.ok) { push(tabId, { kind: 'note', tone: 'error', text: parsed.error === 'unbalancedQuotes' ? tr('Niezamknięty cudzysłów') : tr('Puste polecenie') }); return; }
    const route = consoleRoute(parsed.argv);
    if (route.kind === 'refuse') {
      if (route.why === 'subscribe') push(tabId, { kind: 'note', tone: 'error', text: tr('Subskrypcje działają w zakładce Pub/Sub, nie w konsoli'), action: { label: tr('Otwórz Pub/Sub'), run: () => { openRedisTab(ref.connectionId, 'pubsub', ref.db); } } });
      else if (route.why === 'blocking') push(tabId, { kind: 'note', tone: 'error', text: tr('{command} blokuje połączenie i nie działa w konsoli. Do śledzenia wiadomości użyj zakładki Pub/Sub.', { command: redisCommandName(parsed.argv) }) });
      else push(tabId, { kind: 'note', tone: 'error', text: tr('Tego polecenia nie można użyć w konsoli') });
      return;
    }
    if (route.kind === 'confirm') { await confirmAndSend(parsed.argv, kept ?? text); return; }
    await send(parsed.argv, kept ?? text);
  };
  const clearOutput = () => useOutputs.setState({ [tabId]: [] });
  const clearHistory = () => { setHistory([]); writeHistory(ref.connectionId, []); setAt(null); toast(tr('Historia poleceń wyczyszczona')); };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); clearOutput(); return; }
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
        {output.map((e) => <EntryView key={e.id} entry={e} />)}
      </div>
      <div className="redis-console-input">
        {suggestions.length > 0 && (
          <ul className="redis-suggest" role="listbox" aria-label={tr('Podpowiedzi')}>
            {suggestions.map((s, i) => <li key={s} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); setLine(`${s} `); input.current?.focus(); }}>{s}</li>)}
          </ul>
        )}
        <span className="redis-prompt">db{ref.db}&gt;</span>
        <input ref={input} className="redis-console-line" value={line} spellCheck={false} autoComplete="off" aria-label={tr('Polecenie Redis')} readOnly={busy} aria-busy={busy}
          placeholder={readOnly ? tr('Tylko do odczytu: polecenia zapisu są blokowane') : ''} onChange={(e) => { setLine(e.target.value); setAt(null); }} onKeyDown={onKey} />
        {busy && <span className="muted">{tr('Wykonywanie…')}</span>}
        <button className="btn ghost icon small redis-console-menu" aria-label={tr('Więcej akcji')} title={tr('Więcej akcji')} onClick={(e) => openMenuAt(e.currentTarget, [
          { label: tr('Wyczyść wyjście'), hint: 'Ctrl+L', onClick: clearOutput },
          { label: tr('Wyczyść historię poleceń'), disabled: !history.length, onClick: clearHistory },
        ])}><IMore /></button>
      </div>
    </div>
  );
}

/** One entry of the output; memoized, so a new entry renders only itself. */
const EntryView = memo(function EntryView({ entry: e }: { entry: Entry }) {
  const { tr } = useI18n();
  if (e.kind === 'command') return <div className="redis-console-cmd"><span className="redis-prompt">db{e.db}&gt;</span> {e.line}</div>;
  if (e.kind === 'note') return <div className={`redis-console-note ${e.tone}`}>{e.text}{e.action && <button className="btn small" onClick={e.action.run}>{e.action.label}</button>}</div>;
  return (
    <div className="redis-console-reply">
      <Reply reply={e.reply} command={e.command} depth={0} />
      <span className="redis-console-meta">
        <span className="muted">{e.timeMs < 1 ? '<1 ms' : `${Math.round(e.timeMs)} ms`}</span>
        <button className="btn ghost small" onClick={() => { window.mc.clipboardWrite(replyText(e.reply)); toast(tr('Skopiowano')); }}>{tr('Kopiuj')}</button>
      </span>
    </div>
  );
});

/** A reply by its RESP type; arrays nest with their positions, map replies (HGETALL, CONFIG GET ...) show as pairs. */
function Reply({ reply, command, depth }: { reply: RedisReply; command: string; depth: number }) {
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
    case 'array': return reply.items.length ? <ReplyArray reply={reply} command={command} depth={depth} /> : <span className="rr nil">(empty array)</span>;
  }
}

/** An array or map reply shown in parts: the first items, then "show more" (a reply may hold 10000 nodes). */
function ReplyArray({ reply, command, depth }: { reply: Extract<RedisReply, { t: 'array' }>; command: string; depth: number }) {
  const { tr } = useI18n();
  const map = isMapReply(command, reply);
  const [shown, setShown] = useState(depth ? SHOW_NESTED : SHOW_ITEMS);
  const total = map ? reply.items.length / 2 : reply.items.length;
  const visible = Math.min(total, shown);
  const more = total > visible ? (
    <button className="btn ghost small redis-show-more" onClick={() => setShown((n) => n + SHOW_STEP)}>{tr('Pokaż więcej ({count} z {total})', { count: Math.min(SHOW_STEP, total - visible), total })}</button>
  ) : null;
  if (map) {
    const rows = [];
    for (let i = 0; i < visible; i++) {
      const k = reply.items[i * 2], v = reply.items[i * 2 + 1];
      rows.push(<tr key={i}><th>{k.t === 'bulk' || k.t === 'simple' ? (typeof k.v === 'string' ? k.v : redisDataDisplay(k.v)) : <Reply reply={k} command="" depth={depth + 1} />}</th><td><Reply reply={v} command="" depth={depth + 1} /></td></tr>);
    }
    return <><table className="rr map"><tbody>{rows}</tbody></table>{more}</>;
  }
  return (
    <ol className="rr array">
      {reply.items.slice(0, visible).map((item, i) => <li key={i}><span className="rr-index">{i + 1})</span> <Reply reply={item} command="" depth={depth + 1} /></li>)}
      {more && <li>{more}</li>}
      {reply.length > reply.items.length && <li className="muted">{tr('… i jeszcze {count}', { count: reply.length - reply.items.length })}</li>}
    </ol>
  );
}
