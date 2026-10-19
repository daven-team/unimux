// The value views of the six Redis types (1.0.0), each paged and editable (read-only connections show no edit controls):
// string (text, JSON pretty view with validation, hex for binary, save keeping the TTL), hash (fields, search, add, edit,
// delete), list (indexed, push left/right, set by index, remove by value), set (members, search, add, remove), sorted set
// (member and score, sortable by score, add, edit score, remove) and stream (entries newest first, add, delete, trim).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DbResult } from '../../../../shared/db';
import {
  isBinaryData, redisDataDisplay, redisDataFromHex, redisDataHex, type RedisBlob, type RedisData, type RedisHashEntry, type RedisReadRequest,
  type RedisReadResult, type RedisStreamEntry, type RedisWrite, type RedisZsetEntry,
} from '../../../../shared/dbRedis';
import { containsPattern, formatBytes, formatJson, hexDump, isJsonText, jsonError, validNewStreamId, validScore } from '../../../../shared/redisView';
import { useI18n } from '../../i18n';
import { askChoice, toast } from '../../store';
import { resultText, withTab } from '../../redis/redisClient';
import { IPlus, ISearch, IX } from '../icons';
import { DataText, preview, RedisDialog, VirtualList } from './common';
import type { ValueProps } from './RedisValuePanel';

const PAGE = 200;
const ROW = 28;
/** Binary strings up to this size can be edited as hex (bigger ones show a read-only dump). */
const HEX_EDIT_BYTES = 256 * 1024;

type Tr = ReturnType<typeof useI18n>['tr'];

// ── calls ───────────────────────────────────────────────────────────────────

async function read<T extends RedisReadResult['type']>(tabId: string, req: RedisReadRequest & { type: T }): Promise<DbResult<Extract<RedisReadResult, { type: T }>>> {
  const r = await withTab(tabId, (sid) => window.mc.db.redis.read(sid, req));
  return r as DbResult<Extract<RedisReadResult, { type: T }>>;
}

/**
 * Runs a write and reports the outcome in one place: true when it went through. A key that vanished or holds another type now
 * reloads the panel (`reload`); a refusal shows its text. Writes are never retried by themselves.
 */
async function write(tabId: string, w: RedisWrite, p: Pick<ValueProps, 'onChanged' | 'onReload'>, tr: Tr): Promise<{ changed: number; id?: string } | null> {
  const r = await withTab(tabId, (sid) => window.mc.db.redis.write(sid, w));
  if (r.ok) { p.onChanged(); return r.value; }
  if (r.error === 'notFound' || r.error === 'wrongType') {
    toast(r.error === 'notFound' ? tr('Klucz już nie istnieje') : tr('Klucz zmienił typ - wczytano go ponownie'), 'error');
    p.onReload();
    return null;
  }
  if (r.error === 'conflict') { toast(tr('Element zmienił się w międzyczasie - wczytano listę ponownie'), 'error'); p.onReload(); return null; }
  toast(resultText(r), 'error');
  return null;
}

async function readWhole(tabId: string, req: Parameters<typeof window.mc.db.redis.readItem>[1]): Promise<RedisBlob | null> {
  const r = await withTab(tabId, (sid) => window.mc.db.redis.readItem(sid, req));
  if (r.ok) return r.value;
  toast(resultText(r), 'error');
  return null;
}

const confirmDelete = async (tr: Tr, title: string, body: string): Promise<boolean> =>
  (await askChoice(title, body, [{ label: tr('Usuń'), value: 'delete', danger: true }])) === 'delete';

const copy = (tr: Tr, d: RedisData) => { window.mc.clipboardWrite(redisDataDisplay(d)); toast(tr('Skopiowano')); };

/** Text typed into an editor as data (a binary value shown escaped cannot be typed back: hex is used for it). */
const asData = (text: string): RedisData => text;

// ── shared layout ───────────────────────────────────────────────────────────

function Items({ toolbar, count, row, more, onMore, loading, error, editor, empty }: {
  toolbar?: ReactNode; count: number; row: (i: number) => ReactNode; more: boolean; onMore: () => void; loading: boolean; error: string | null; editor?: ReactNode; empty: string;
}) {
  const { tr } = useI18n();
  return (
    <div className="redis-items">
      {toolbar && <div className="redis-toolbar sub">{toolbar}</div>}
      {error && <div className="redis-error-text pad" role="alert">{error}</div>}
      <VirtualList className="redis-item-list" count={count} rowHeight={ROW} row={row}
        end={more ? <div className="redis-more"><button className="btn small redis-load-more" disabled={loading} onClick={onMore}>{loading ? tr('Wczytywanie…') : tr('Wczytaj więcej')}</button></div>
          : !count && !loading ? <div className="redis-empty muted">{empty}</div> : null} />
      {editor}
    </div>
  );
}

function SearchField({ value, onChange, onSubmit, label }: { value: string; onChange: (v: string) => void; onSubmit: () => void; label: string }) {
  return (
    <form className="redis-search" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <ISearch />
      <input className="input" value={value} placeholder={label} aria-label={label} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </form>
  );
}

/** The editor under a list: the chosen item, its value and the actions. */
function Editor({ title, children, actions, onClose }: { title: ReactNode; children: ReactNode; actions: ReactNode; onClose: () => void }) {
  const { tr } = useI18n();
  return (
    <div className="redis-editor">
      <div className="redis-editor-head">{title}<span className="grow" /><button className="btn ghost icon small" aria-label={tr('Zamknij')} onClick={onClose}><IX /></button></div>
      <div className="redis-editor-body">{children}</div>
      <div className="redis-row-actions">{actions}</div>
    </div>
  );
}

/** A value of a page that may have arrived cut: the editor loads it whole first. */
function useWhole(blob: RedisBlob | null, load: () => Promise<RedisBlob | null>): { value: RedisBlob | null; loading: boolean } {
  const [whole, setWhole] = useState<RedisBlob | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setWhole(null);
    if (!blob?.truncated) return;
    let live = true;
    setLoading(true);
    void load().then((v) => { if (live) { setWhole(v); setLoading(false); } });
    return () => { live = false; };
  }, [blob]); // eslint-disable-line react-hooks/exhaustive-deps
  return { value: blob?.truncated ? whole : blob, loading };
}

/** A textarea for a value; binary data is shown escaped and read-only (edit it as hex in a string key). */
function ValueBox({ blob, text, onText, readOnly, className = '' }: { blob: RedisBlob | null; text: string; onText: (t: string) => void; readOnly: boolean; className?: string }) {
  const { tr } = useI18n();
  const binary = !!blob && isBinaryData(blob.data);
  return (
    <>
      {binary && <p className="muted small">{tr('Wartość binarna - pokazano bajty spoza tekstu jako \\xHH')}</p>}
      <textarea className={`textarea redis-value-text ${className}`} value={text} readOnly={readOnly || binary} spellCheck={false} onChange={(e) => onText(e.target.value)} />
    </>
  );
}

// ── string ──────────────────────────────────────────────────────────────────

type StringMode = 'text' | 'json' | 'hex';

export function StringView(p: ValueProps) {
  const { tr } = useI18n();
  const [blob, setBlob] = useState<RedisBlob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<StringMode>('text');
  const [draft, setDraft] = useState<string | null>(null);
  const [keepTtl, setKeepTtl] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = async (maxBytes?: number) => {
    setError(null);
    const r = await read(p.tabId, { type: 'string', key: p.keyName, ...(maxBytes ? { maxBytes } : {}) });
    if (!r.ok) { setError(resultText(r)); return; }
    const v = r.value.value;
    setBlob(v);
    setDraft(null);
    setMode(isBinaryData(v.data) ? 'hex' : isJsonText(v.data as string) ? 'json' : 'text');
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const binary = !!blob && isBinaryData(blob.data);
  const sourceText = useMemo(() => {
    if (!blob) return '';
    if (mode === 'hex') return blob.bytes <= HEX_EDIT_BYTES ? redisDataHex(blob.data) : '';
    const text = redisDataDisplay(blob.data);
    return mode === 'json' ? formatJson(text) ?? text : text;
  }, [blob, mode]);
  if (error) return <div className="redis-error-text pad" role="alert">{error}</div>;
  if (!blob) return <div className="redis-center muted">{tr('Wczytywanie…')}</div>;
  const text = draft ?? sourceText;
  const dirty = draft !== null && draft !== sourceText;
  const truncated = !!blob.truncated;
  const editable = !p.readOnly && !truncated && !(binary && mode !== 'hex') && !(mode === 'hex' && blob.bytes > HEX_EDIT_BYTES);
  const jsonProblem = mode === 'json' ? jsonError(text) : null;
  const switchMode = (next: StringMode) => {
    if (next === mode) return;
    // An edit goes along to the other view when it can be expressed there; else the stored value is shown again.
    if (draft !== null && dirty) {
      if (next === 'hex' && mode !== 'hex') setDraft(redisDataHex(asData(draft)));
      else if (mode === 'hex') { const d = redisDataFromHex(draft); setDraft(d !== null && !isBinaryData(d) ? (next === 'json' ? formatJson(d) ?? d : d) : null); }
      else if (next === 'json') setDraft(formatJson(draft) ?? draft);
    } else setDraft(null);
    setMode(next);
  };
  const save = async () => {
    let value: RedisData | null;
    if (mode === 'hex') { value = redisDataFromHex(text); if (value === null) { toast(tr('Nieprawidłowy zapis szesnastkowy'), 'error'); return; } }
    else if (mode === 'json') {
      if (jsonProblem) { toast(tr('Nieprawidłowy JSON: {error}', { error: jsonProblem }), 'error'); return; }
      // A compact stored JSON stays compact (the pretty view is only how it is shown).
      const stored = redisDataDisplay(blob.data);
      value = stored.includes('\n') ? text : formatJson(text, 0) ?? text;
    } else value = text;
    setBusy(true);
    const ok = await write(p.tabId, { op: 'set', key: p.keyName, value, keepTtl }, p, tr);
    setBusy(false);
    if (ok) { toast(tr('Zapisano')); void load(); }
  };
  return (
    <div className="redis-string">
      <div className="redis-toolbar sub">
        <div className="redis-seg" role="group" aria-label={tr('Widok wartości')}>
          <button className={mode === 'text' ? 'on' : ''} aria-pressed={mode === 'text'} onClick={() => switchMode('text')}>{tr('Tekst')}</button>
          <button className={mode === 'json' ? 'on' : ''} aria-pressed={mode === 'json'} disabled={binary} onClick={() => switchMode('json')}>JSON</button>
          <button className={mode === 'hex' ? 'on' : ''} aria-pressed={mode === 'hex'} onClick={() => switchMode('hex')}>Hex</button>
        </div>
        {binary && <span className="redis-bin" title={tr('Dane binarne')}>bin</span>}
        <span className="muted">{formatBytes(blob.bytes)}</span>
        {mode === 'json' && <span className={jsonProblem ? 'redis-error-text' : 'redis-ok-text'}>{jsonProblem ? tr('Nieprawidłowy JSON') : tr('Poprawny JSON')}</span>}
        <span className="grow" />
        <button className="btn small ghost" onClick={() => copy(tr, blob.data)}>{tr('Kopiuj wartość')}</button>
      </div>
      {truncated && (
        <div className="redis-note" role="status">
          {tr('Pokazano pierwsze {shown} z {total}. Edycja jest wyłączona.', { shown: formatBytes(redisDataHex(blob.data, '').length / 2), total: formatBytes(blob.bytes) })}
          {blob.bytes <= 16 * 1024 * 1024 && <button className="btn small" onClick={() => void load(16 * 1024 * 1024)}>{tr('Wczytaj całość')}</button>}
        </div>
      )}
      {mode === 'hex' && blob.bytes > HEX_EDIT_BYTES
        ? <pre className="redis-hexdump">{hexDump(blob.data).join('\n')}</pre>
        : <textarea className={`textarea redis-string-text ${mode === 'hex' ? 'hex' : ''} ${jsonProblem ? 'invalid' : ''}`} value={binary && mode === 'text' ? redisDataDisplay(blob.data) : text}
          readOnly={!editable} spellCheck={false} aria-label={tr('Wartość')} onChange={(e) => setDraft(e.target.value)} />}
      {editable && (
        <div className="redis-row-actions">
          <label className="check"><input type="checkbox" checked={keepTtl} onChange={(e) => setKeepTtl(e.target.checked)} /> {tr('Zachowaj czas wygaśnięcia')}</label>
          <span className="grow" />
          <button className="btn small" disabled={!dirty} onClick={() => setDraft(null)}>{tr('Cofnij zmiany')}</button>
          <button className="btn small primary redis-save" disabled={!dirty || busy} onClick={() => void save()}>{tr('Zapisz')}</button>
        </div>
      )}
    </div>
  );
}

// ── hash ────────────────────────────────────────────────────────────────────

export function HashView(p: ValueProps) {
  const { tr } = useI18n();
  const [entries, setEntries] = useState<RedisHashEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const token = useRef(0);
  const load = async (reset: boolean) => {
    const t = ++token.current;
    setLoading(true); setError(null);
    const r = await read(p.tabId, { type: 'hash', key: p.keyName, cursor: reset ? '0' : cursor ?? '0', count: PAGE, match: containsPattern(search) });
    if (t !== token.current) return;
    setLoading(false);
    if (!r.ok) { setError(resultText(r)); return; }
    setEntries((cur) => (reset ? r.value.entries : [...cur, ...r.value.entries]));
    setCursor(r.value.cursor);
    if (reset) setSel(null);
  };
  useEffect(() => { void load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = sel !== null ? entries[sel] : undefined;
  return (
    <Items loading={loading} error={error} count={entries.length} more={cursor !== null && cursor !== '0'} onMore={() => void load(false)} empty={tr('Brak pól')}
      toolbar={<>
        <SearchField value={search} onChange={setSearch} onSubmit={() => void load(true)} label={tr('Szukaj pól')} />
        <span className="grow" />
        {!p.readOnly && <button className="btn small redis-add" onClick={() => { setAdding(true); setSel(null); }}><IPlus /> {tr('Dodaj pole')}</button>}
      </>}
      row={(i) => {
        const e = entries[i];
        return (
          <div className={`redis-item two ${i === sel ? 'current' : ''}`} role="listitem" onClick={() => { setSel(i); setAdding(false); }}>
            <DataText data={e.field} className="redis-item-field" />
            <span className="redis-item-value">{preview(e.value.data)}{e.value.truncated ? <span className="redis-cut"> ({formatBytes(e.value.bytes)})</span> : null}</span>
          </div>
        );
      }}
      editor={adding ? <AddPair tr={tr} first={tr('Pole')} second={tr('Wartość')} onClose={() => setAdding(false)} onAdd={async (field, value) => {
        const r = await write(p.tabId, { op: 'hset', key: p.keyName, field, value, onlyNew: true }, p, tr);
        if (!r) return false;
        if (r.changed === 0) { toast(tr('Takie pole już istnieje'), 'error'); return false; }
        void load(true); return true;
      }} />
        : current ? <HashEditor key={`${current.field}`} p={p} entry={current} onClose={() => setSel(null)} onDone={() => void load(true)} /> : undefined}
    />
  );
}

function HashEditor({ p, entry, onClose, onDone }: { p: ValueProps; entry: RedisHashEntry; onClose: () => void; onDone: () => void }) {
  const { tr } = useI18n();
  const whole = useWhole(entry.value, () => readWhole(p.tabId, { type: 'hash', key: p.keyName, field: entry.field }));
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (whole.value ? redisDataDisplay(whole.value.data) : '');
  const save = async () => { if (await write(p.tabId, { op: 'hset', key: p.keyName, field: entry.field, value: asData(shown) }, p, tr)) { toast(tr('Zapisano')); onDone(); } };
  const remove = async () => {
    if (!await confirmDelete(tr, tr('Usunąć pole?'), redisDataDisplay(entry.field))) return;
    if (await write(p.tabId, { op: 'hdel', key: p.keyName, fields: [entry.field] }, p, tr)) onDone();
  };
  return (
    <Editor title={<DataText data={entry.field} className="strong" />} onClose={onClose} actions={<>
      <button className="btn small ghost" onClick={() => whole.value && copy(tr, whole.value.data)}>{tr('Kopiuj wartość')}</button>
      <span className="grow" />
      {!p.readOnly && <button className="btn small danger" onClick={() => void remove()}>{tr('Usuń pole')}</button>}
      {!p.readOnly && <button className="btn small primary redis-save" disabled={text === null || whole.loading} onClick={() => void save()}>{tr('Zapisz')}</button>}
    </>}>
      {whole.loading ? <p className="muted">{tr('Wczytywanie…')}</p> : <ValueBox blob={whole.value} text={shown} onText={setText} readOnly={p.readOnly} />}
    </Editor>
  );
}

function AddPair({ tr, first, second, onAdd, onClose, secondCheck }: {
  tr: Tr; first: string; second: string; onAdd: (a: string, b: string) => Promise<boolean>; onClose: () => void; secondCheck?: (b: string) => string | null;
}) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!a) { setError(tr('Podaj nazwę pola')); return; }
    const problem = secondCheck?.(b) ?? null;
    if (problem) { setError(problem); return; }
    if (await onAdd(a, b)) onClose();
  };
  return (
    <Editor title={<strong>{tr('Dodaj')}</strong>} onClose={onClose} actions={<>
      {error && <span className="redis-error-text">{error}</span>}
      <span className="grow" />
      <button className="btn small" onClick={onClose}>{tr('Anuluj')}</button>
      <button className="btn small primary redis-add-save" onClick={() => void submit()}>{tr('Dodaj')}</button>
    </>}>
      <div className="redis-two">
        <label className="field"><span>{first}</span><input className="input redis-add-first" autoFocus value={a} spellCheck={false} onChange={(e) => setA(e.target.value)} /></label>
        <label className="field"><span>{second}</span><input className="input redis-add-second" value={b} spellCheck={false} onChange={(e) => setB(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} /></label>
      </div>
    </Editor>
  );
}

// ── list ────────────────────────────────────────────────────────────────────

export function ListView(p: ValueProps) {
  const { tr } = useI18n();
  const [items, setItems] = useState<RedisBlob[]>([]);
  const [length, setLength] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [push, setPush] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const token = useRef(0);
  const load = async (reset: boolean) => {
    const t = ++token.current;
    setLoading(true); setError(null);
    const r = await read(p.tabId, { type: 'list', key: p.keyName, start: reset ? 0 : items.length, count: PAGE });
    if (t !== token.current) return;
    setLoading(false);
    if (!r.ok) { setError(resultText(r)); return; }
    setItems((cur) => (reset ? r.value.items : [...cur, ...r.value.items]));
    setLength(r.value.length);
    if (reset) setSel(null);
  };
  useEffect(() => { void load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const doPush = async (op: 'lpush' | 'rpush') => {
    if (await write(p.tabId, { op, key: p.keyName, items: [push] }, p, tr)) { setPush(''); void load(true); }
  };
  const current = sel !== null ? items[sel] : undefined;
  return (
    <Items loading={loading} error={error} count={items.length} more={items.length < length} onMore={() => void load(false)} empty={tr('Lista jest pusta')}
      toolbar={!p.readOnly ? <>
        <input className="input redis-push-input" value={push} placeholder={tr('Nowy element')} aria-label={tr('Nowy element')} spellCheck={false} onChange={(e) => setPush(e.target.value)} />
        <button className="btn small redis-lpush" onClick={() => void doPush('lpush')}>{tr('Dodaj na początek')}</button>
        <button className="btn small redis-rpush" onClick={() => void doPush('rpush')}>{tr('Dodaj na koniec')}</button>
        <span className="grow" />
        <button className="btn small" onClick={() => { setRemoveOpen(true); setSel(null); }}>{tr('Usuń wg wartości…')}</button>
      </> : undefined}
      row={(i) => (
        <div className={`redis-item idx ${i === sel ? 'current' : ''}`} role="listitem" onClick={() => { setSel(i); setRemoveOpen(false); }}>
          <span className="redis-item-index">{i}</span>
          <span className="redis-item-value">{preview(items[i].data)}{items[i].truncated ? <span className="redis-cut"> ({formatBytes(items[i].bytes)})</span> : null}</span>
        </div>
      )}
      editor={removeOpen ? <RemoveByValue p={p} onClose={() => setRemoveOpen(false)} onDone={() => void load(true)} />
        : current && sel !== null ? <ListEditor key={sel} p={p} index={sel} blob={current} onClose={() => setSel(null)} onDone={() => void load(true)} /> : undefined}
    />
  );
}

function ListEditor({ p, index, blob, onClose, onDone }: { p: ValueProps; index: number; blob: RedisBlob; onClose: () => void; onDone: () => void }) {
  const { tr } = useI18n();
  const whole = useWhole(blob, () => readWhole(p.tabId, { type: 'list', key: p.keyName, index }));
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (whole.value ? redisDataDisplay(whole.value.data) : '');
  // The element must still hold what was loaded (else someone changed the list meanwhile: conflict).
  const expected = whole.value && !whole.value.truncated ? whole.value.data : undefined;
  const save = async () => { if (await write(p.tabId, { op: 'lset', key: p.keyName, index, value: asData(shown), ...(expected !== undefined ? { expected } : {}) }, p, tr)) { toast(tr('Zapisano')); onDone(); } };
  const remove = async () => {
    if (expected === undefined || !await confirmDelete(tr, tr('Usunąć element {index}?', { index }), preview(expected, 200))) return;
    if (await write(p.tabId, { op: 'ldel', key: p.keyName, index, expected }, p, tr)) onDone();
  };
  return (
    <Editor title={<strong>{tr('Element {index}', { index })}</strong>} onClose={onClose} actions={<>
      <button className="btn small ghost" onClick={() => whole.value && copy(tr, whole.value.data)}>{tr('Kopiuj wartość')}</button>
      <span className="grow" />
      {!p.readOnly && <button className="btn small danger" disabled={expected === undefined} onClick={() => void remove()}>{tr('Usuń element')}</button>}
      {!p.readOnly && <button className="btn small primary redis-save" disabled={text === null || whole.loading} onClick={() => void save()}>{tr('Zapisz')}</button>}
    </>}>
      {whole.loading ? <p className="muted">{tr('Wczytywanie…')}</p> : <ValueBox blob={whole.value} text={shown} onText={setText} readOnly={p.readOnly} />}
    </Editor>
  );
}

function RemoveByValue({ p, onClose, onDone }: { p: ValueProps; onClose: () => void; onDone: () => void }) {
  const { tr } = useI18n();
  const [value, setValue] = useState('');
  const [which, setWhich] = useState<'all' | 'first' | 'last'>('all');
  const submit = async () => {
    const count = which === 'all' ? 0 : which === 'first' ? 1 : -1;
    const r = await write(p.tabId, { op: 'lrem', key: p.keyName, count, value }, p, tr);
    if (r) { toast(tr('Usunięto elementów: {count}', { count: r.changed })); onDone(); onClose(); }
  };
  return (
    <Editor title={<strong>{tr('Usuń elementy o wartości')}</strong>} onClose={onClose} actions={<>
      <span className="grow" />
      <button className="btn small" onClick={onClose}>{tr('Anuluj')}</button>
      <button className="btn small danger redis-lrem" onClick={() => void submit()}>{tr('Usuń')}</button>
    </>}>
      <input className="input redis-lrem-value" autoFocus value={value} placeholder={tr('Wartość')} aria-label={tr('Wartość')} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
      <div className="redis-seg" role="radiogroup">
        <button role="radio" aria-checked={which === 'all'} className={which === 'all' ? 'on' : ''} onClick={() => setWhich('all')}>{tr('Wszystkie')}</button>
        <button role="radio" aria-checked={which === 'first'} className={which === 'first' ? 'on' : ''} onClick={() => setWhich('first')}>{tr('Pierwszy od początku')}</button>
        <button role="radio" aria-checked={which === 'last'} className={which === 'last' ? 'on' : ''} onClick={() => setWhich('last')}>{tr('Pierwszy od końca')}</button>
      </div>
    </Editor>
  );
}

// ── set ─────────────────────────────────────────────────────────────────────

export function SetView(p: ValueProps) {
  const { tr } = useI18n();
  const [members, setMembers] = useState<RedisData[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [add, setAdd] = useState('');
  const token = useRef(0);
  const load = async (reset: boolean) => {
    const t = ++token.current;
    setLoading(true); setError(null);
    const r = await read(p.tabId, { type: 'set', key: p.keyName, cursor: reset ? '0' : cursor ?? '0', count: PAGE, match: containsPattern(search) });
    if (t !== token.current) return;
    setLoading(false);
    if (!r.ok) { setError(resultText(r)); return; }
    setMembers((cur) => (reset ? r.value.members : [...cur, ...r.value.members]));
    setCursor(r.value.cursor);
    if (reset) setSel(null);
  };
  useEffect(() => { void load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const doAdd = async () => {
    if (!add) return;
    const r = await write(p.tabId, { op: 'sadd', key: p.keyName, members: [add] }, p, tr);
    if (r) { if (r.changed === 0) toast(tr('Ten element już jest w zbiorze')); setAdd(''); void load(true); }
  };
  const remove = async (m: RedisData) => {
    if (!await confirmDelete(tr, tr('Usunąć element?'), preview(m, 200))) return;
    if (await write(p.tabId, { op: 'srem', key: p.keyName, members: [m] }, p, tr)) void load(true);
  };
  const current = sel !== null ? members[sel] : undefined;
  return (
    <Items loading={loading} error={error} count={members.length} more={cursor !== null && cursor !== '0'} onMore={() => void load(false)} empty={tr('Zbiór jest pusty')}
      toolbar={<>
        <SearchField value={search} onChange={setSearch} onSubmit={() => void load(true)} label={tr('Szukaj elementów')} />
        {!p.readOnly && <>
          <input className="input redis-add-member" value={add} placeholder={tr('Nowy element')} aria-label={tr('Nowy element')} spellCheck={false} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doAdd(); }} />
          <button className="btn small redis-add" onClick={() => void doAdd()}><IPlus /> {tr('Dodaj')}</button>
        </>}
      </>}
      row={(i) => (
        <div className={`redis-item ${i === sel ? 'current' : ''}`} role="listitem" onClick={() => setSel(i)}>
          <DataText data={members[i]} className="redis-item-value" />
        </div>
      )}
      editor={current !== undefined ? (
        <Editor title={<DataText data={current} className="strong" />} onClose={() => setSel(null)} actions={<>
          <button className="btn small ghost" onClick={() => copy(tr, current)}>{tr('Kopiuj')}</button>
          <span className="grow" />
          {!p.readOnly && <button className="btn small danger redis-remove" onClick={() => void remove(current)}>{tr('Usuń element')}</button>}
        </>}><textarea className="textarea redis-value-text" readOnly value={redisDataDisplay(current)} /></Editor>
      ) : undefined}
    />
  );
}

// ── sorted set ──────────────────────────────────────────────────────────────

export function ZsetView(p: ValueProps) {
  const { tr } = useI18n();
  const [entries, setEntries] = useState<RedisZsetEntry[]>([]);
  const [length, setLength] = useState(0);
  const [rev, setRev] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const token = useRef(0);
  const load = async (reset: boolean, desc = rev) => {
    const t = ++token.current;
    setLoading(true); setError(null);
    const r = await read(p.tabId, { type: 'zset', key: p.keyName, start: reset ? 0 : entries.length, count: PAGE, rev: desc });
    if (t !== token.current) return;
    setLoading(false);
    if (!r.ok) { setError(resultText(r)); return; }
    setEntries((cur) => (reset ? r.value.entries : [...cur, ...r.value.entries]));
    setLength(r.value.length);
    if (reset) setSel(null);
  };
  useEffect(() => { void load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = sel !== null ? entries[sel] : undefined;
  return (
    <Items loading={loading} error={error} count={entries.length} more={entries.length < length} onMore={() => void load(false)} empty={tr('Zbiór jest pusty')}
      toolbar={<>
        <button className="btn small redis-sort" aria-label={tr('Sortuj wg wyniku')} onClick={() => { setRev(!rev); void load(true, !rev); }}>
          {rev ? tr('Wynik: malejąco') : tr('Wynik: rosnąco')}
        </button>
        <span className="grow" />
        {!p.readOnly && <button className="btn small redis-add" onClick={() => { setAdding(true); setSel(null); }}><IPlus /> {tr('Dodaj element')}</button>}
      </>}
      row={(i) => (
        <div className={`redis-item zset ${i === sel ? 'current' : ''}`} role="listitem" onClick={() => { setSel(i); setAdding(false); }}>
          <span className="redis-item-index">{rev ? length - 1 - i : i}</span>
          <DataText data={entries[i].member} className="redis-item-value" />
          <span className="redis-item-score">{entries[i].score}</span>
        </div>
      )}
      editor={adding ? <AddPair tr={tr} first={tr('Element')} second={tr('Wynik')} onClose={() => setAdding(false)} secondCheck={(s) => (validScore(s) ? null : tr('Nieprawidłowy wynik'))}
        onAdd={async (member, score) => { if (!await write(p.tabId, { op: 'zadd', key: p.keyName, entries: [[member, score.trim()]] }, p, tr)) return false; void load(true); return true; }} />
        : current ? <ZsetEditor key={`${sel}:${current.score}`} p={p} entry={current} onClose={() => setSel(null)} onDone={() => void load(true)} /> : undefined}
    />
  );
}

function ZsetEditor({ p, entry, onClose, onDone }: { p: ValueProps; entry: RedisZsetEntry; onClose: () => void; onDone: () => void }) {
  const { tr } = useI18n();
  const [score, setScore] = useState(entry.score);
  const save = async () => {
    if (!validScore(score)) { toast(tr('Nieprawidłowy wynik'), 'error'); return; }
    if (await write(p.tabId, { op: 'zadd', key: p.keyName, entries: [[entry.member, score.trim()]], mode: 'xx' }, p, tr)) { toast(tr('Zapisano')); onDone(); }
  };
  const remove = async () => {
    if (!await confirmDelete(tr, tr('Usunąć element?'), preview(entry.member, 200))) return;
    if (await write(p.tabId, { op: 'zrem', key: p.keyName, members: [entry.member] }, p, tr)) onDone();
  };
  return (
    <Editor title={<DataText data={entry.member} className="strong" />} onClose={onClose} actions={<>
      <button className="btn small ghost" onClick={() => copy(tr, entry.member)}>{tr('Kopiuj')}</button>
      <span className="grow" />
      {!p.readOnly && <button className="btn small danger" onClick={() => void remove()}>{tr('Usuń element')}</button>}
      {!p.readOnly && <button className="btn small primary redis-save" disabled={score === entry.score} onClick={() => void save()}>{tr('Zapisz wynik')}</button>}
    </>}>
      <label className="field"><span>{tr('Wynik')}</span>
        <input className="input redis-score-input" value={score} readOnly={p.readOnly} spellCheck={false} onChange={(e) => setScore(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
      </label>
    </Editor>
  );
}

// ── stream ──────────────────────────────────────────────────────────────────

export function StreamView(p: ValueProps) {
  const { tr } = useI18n();
  const [entries, setEntries] = useState<RedisStreamEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [length, setLength] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [dialog, setDialog] = useState<null | 'add' | 'trim'>(null);
  const token = useRef(0);
  const load = async (reset: boolean) => {
    const t = ++token.current;
    setLoading(true); setError(null);
    // Newest first: XREVRANGE from the end ("+") down to the start ("-").
    const r = await read(p.tabId, { type: 'stream', key: p.keyName, start: reset ? '+' : next ?? '+', end: '-', count: 100, rev: true });
    if (t !== token.current) return;
    setLoading(false);
    if (!r.ok) { setError(resultText(r)); return; }
    setEntries((cur) => (reset ? r.value.entries : [...cur, ...r.value.entries]));
    setNext(r.value.next);
    setLength(r.value.length);
    if (reset) setSel(null);
  };
  useEffect(() => { void load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = sel !== null ? entries[sel] : undefined;
  const remove = async (e: RedisStreamEntry) => {
    if (!await confirmDelete(tr, tr('Usunąć wpis?'), e.id)) return;
    if (await write(p.tabId, { op: 'xdel', key: p.keyName, ids: [e.id] }, p, tr)) void load(true);
  };
  return (
    <>
      <Items loading={loading} error={error} count={entries.length} more={next !== null && entries.length < length} onMore={() => void load(false)} empty={tr('Strumień jest pusty')}
        toolbar={<>
          <span className="muted">{tr('Najnowsze najpierw')}</span>
          <span className="grow" />
          {!p.readOnly && <button className="btn small" onClick={() => setDialog('trim')}>{tr('Przytnij…')}</button>}
          {!p.readOnly && <button className="btn small redis-add" onClick={() => setDialog('add')}><IPlus /> {tr('Dodaj wpis')}</button>}
        </>}
        row={(i) => {
          const e = entries[i];
          return (
            <div className={`redis-item two ${i === sel ? 'current' : ''}`} role="listitem" onClick={() => setSel(i)}>
              <span className="redis-item-field mono">{e.id}</span>
              <span className="redis-item-value">{e.fields.map((f) => `${redisDataDisplay(f.field)}=${preview(f.value.data, 80)}`).join('  ')}</span>
            </div>
          );
        }}
        editor={current ? (
          <Editor title={<span className="mono strong">{current.id}</span>} onClose={() => setSel(null)} actions={<>
            <span className="grow" />
            {!p.readOnly && <button className="btn small danger redis-remove" onClick={() => void remove(current)}>{tr('Usuń wpis')}</button>}
          </>}>
            <table className="redis-kv"><tbody>
              {current.fields.map((f, i) => <tr key={i}><th><DataText data={f.field} /></th><td><DataText data={f.value.data} />{f.value.truncated && <span className="redis-cut"> ({formatBytes(f.value.bytes)})</span>}</td></tr>)}
            </tbody></table>
          </Editor>
        ) : undefined}
      />
      {dialog === 'add' && <StreamAddDialog p={p} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(true); }} />}
      {dialog === 'trim' && <StreamTrimDialog p={p} length={length} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(true); }} />}
    </>
  );
}

function StreamAddDialog({ p, onClose, onDone }: { p: ValueProps; onClose: () => void; onDone: () => void }) {
  const { tr } = useI18n();
  const [id, setId] = useState('*');
  const [fields, setFields] = useState<Array<[string, string]>>([['', '']]);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, j: 0 | 1, v: string) => setFields((f) => f.map((pair, k) => (k === i ? (j === 0 ? [v, pair[1]] : [pair[0], v]) : pair)));
  const submit = async () => {
    const pairs = fields.filter(([f]) => f);
    if (!pairs.length) { setError(tr('Podaj nazwę pola')); return; }
    if (!validNewStreamId(id)) { setError(tr('Nieprawidłowy identyfikator wpisu')); return; }
    const r = await write(p.tabId, { op: 'xadd', key: p.keyName, id: id.trim(), fields: pairs }, p, tr);
    if (r) { toast(tr('Dodano wpis {id}', { id: r.id ?? '' })); onDone(); }
  };
  return (
    <RedisDialog title={tr('Nowy wpis strumienia')} onClose={onClose} actions={<>
      <button className="btn small" onClick={onClose}>{tr('Anuluj')}</button>
      <button className="btn small primary redis-xadd" onClick={() => void submit()}>{tr('Dodaj')}</button>
    </>}>
      <label className="field"><span>{tr('Identyfikator (* = nadany przez serwer)')}</span><input className="input mono" value={id} onChange={(e) => setId(e.target.value)} /></label>
      {fields.map(([f, v], i) => (
        <div className="redis-two" key={i}>
          <input className="input redis-xadd-field" autoFocus={i === 0} value={f} placeholder={tr('Pole')} aria-label={tr('Pole')} spellCheck={false} onChange={(e) => set(i, 0, e.target.value)} />
          <input className="input redis-xadd-value" value={v} placeholder={tr('Wartość')} aria-label={tr('Wartość')} spellCheck={false} onChange={(e) => set(i, 1, e.target.value)} />
        </div>
      ))}
      <button className="btn small ghost" onClick={() => setFields((f) => [...f, ['', '']])}><IPlus /> {tr('Dodaj pole')}</button>
      {error && <p className="redis-error-text" role="alert">{error}</p>}
    </RedisDialog>
  );
}

function StreamTrimDialog({ p, length, onClose, onDone }: { p: ValueProps; length: number; onClose: () => void; onDone: () => void }) {
  const { tr } = useI18n();
  const [strategy, setStrategy] = useState<'maxlen' | 'minid'>('maxlen');
  const [threshold, setThreshold] = useState('');
  const [approx, setApprox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const t = threshold.trim();
    if (strategy === 'maxlen' ? !/^\d+$/.test(t) : !validNewStreamId(t) || t.includes('*')) { setError(strategy === 'maxlen' ? tr('Podaj liczbę wpisów') : tr('Nieprawidłowy identyfikator wpisu')); return; }
    const body = strategy === 'maxlen' ? tr('Zostanie najwyżej {count} najnowszych wpisów (teraz: {length}).', { count: t, length }) : tr('Wpisy starsze niż {id} zostaną usunięte.', { id: t });
    if ((await askChoice(tr('Przyciąć strumień?'), body, [{ label: tr('Przytnij'), value: 'trim', danger: true }])) !== 'trim') return;
    const r = await write(p.tabId, { op: 'xtrim', key: p.keyName, strategy, threshold: t, approx }, p, tr);
    if (r) { toast(tr('Usunięto wpisów: {count}', { count: r.changed })); onDone(); }
  };
  return (
    <RedisDialog title={tr('Przytnij strumień')} onClose={onClose} actions={<>
      <button className="btn small" onClick={onClose}>{tr('Anuluj')}</button>
      <button className="btn small danger redis-xtrim" onClick={() => void submit()}>{tr('Przytnij…')}</button>
    </>}>
      <div className="redis-seg" role="radiogroup">
        <button role="radio" aria-checked={strategy === 'maxlen'} className={strategy === 'maxlen' ? 'on' : ''} onClick={() => setStrategy('maxlen')}>{tr('Zostaw N najnowszych')}</button>
        <button role="radio" aria-checked={strategy === 'minid'} className={strategy === 'minid' ? 'on' : ''} onClick={() => setStrategy('minid')}>{tr('Usuń starsze niż id')}</button>
      </div>
      <input className="input mono redis-xtrim-threshold" autoFocus value={threshold} placeholder={strategy === 'maxlen' ? '1000' : '1700000000000-0'} aria-label={tr('Próg')} onChange={(e) => setThreshold(e.target.value)} />
      <label className="check"><input type="checkbox" checked={approx} onChange={(e) => setApprox(e.target.checked)} /> {tr('W przybliżeniu (~, szybciej)')}</label>
      {error && <p className="redis-error-text" role="alert">{error}</p>}
    </RedisDialog>
  );
}
