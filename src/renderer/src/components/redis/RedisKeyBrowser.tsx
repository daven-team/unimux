// The key browser of a Redis tab (1.0.0): DB switcher with key counts, SCAN with a pattern and a type filter (never KEYS),
// keys as a ":"-tree or a flat list loaded page by page ("load more" for millions of keys), type, TTL and size per key,
// multi-select with delete, delete by pattern (count first, then confirmed with the count, cancellable), a new key of any type,
// and the value panel of the chosen key.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { REDIS_EDITABLE_TYPES, redisDataDisplay, redisDataKey, type RedisData, type RedisDbList, type RedisEditableType, type RedisKeyInfo, type RedisNewValue } from '../../../../shared/dbRedis';
import { formatBytes, formatTtl, mergeKeys, parseTtlInput, redisKeyRows, scanPattern, validScore } from '../../../../shared/redisView';
import { useI18n } from '../../i18n';
import { askChoice, toast } from '../../store';
import { resultText, setTabDb, withTab } from '../../redis/redisClient';
import { openMenu } from '../ContextMenu';
import { Select } from '../Select';
import { IChevron, IPlus, ISearch } from '../icons';
import { RefreshIcon } from '../Spinner';
import { RedisDialog, TypeBadge, VirtualList } from './common';
import { RedisValuePanel } from './RedisValuePanel';
import type { RedisViewProps } from './RedisTabView';

interface BrowserState {
  pattern: string;
  /** The pattern of the loaded keys (the field may hold an edit not applied yet). */
  applied: string;
  type: string;
  mode: 'tree' | 'flat';
  keys: RedisKeyInfo[];
  /** null: nothing loaded yet; '0': the scan is complete. */
  cursor: string | null;
  loading: boolean;
  error: string | null;
  open: string[];
  selected: string[];
  current: RedisKeyInfo | null;
  dbs: RedisDbList | null;
}

const fresh = (): BrowserState => ({ pattern: '', applied: '', type: '', mode: 'tree', keys: [], cursor: null, loading: false, error: null, open: [], selected: [], current: null, dbs: null });
/** Per tab (the view unmounts when another tab is in front; what was loaded stays). */
const useBrowsers = create<Record<string, BrowserState>>(() => ({}));
const getB = (tabId: string): BrowserState => useBrowsers.getState()[tabId] ?? fresh();
const patchB = (tabId: string, patch: Partial<BrowserState> | ((b: BrowserState) => Partial<BrowserState>)) =>
  useBrowsers.setState((st) => { const b = st[tabId] ?? fresh(); return { [tabId]: { ...b, ...(typeof patch === 'function' ? patch(b) : patch) } }; });

const PAGE_KEYS = 500;
const ROW = 26;
const loadTokens = new Map<string, number>();

async function loadKeys(tabId: string, reset: boolean): Promise<void> {
  const b = getB(tabId);
  const token = (loadTokens.get(tabId) ?? 0) + 1;
  loadTokens.set(tabId, token);
  const cursor = reset ? '0' : b.cursor ?? '0';
  patchB(tabId, reset ? { loading: true, error: null, keys: [], cursor: null, selected: [], applied: b.pattern } : { loading: true, error: null });
  const match = scanPattern(reset ? b.pattern : b.applied);
  const r = await withTab(tabId, (sid) => window.mc.db.redis.scan(sid, { cursor, match, type: b.type || undefined, limit: PAGE_KEYS, count: 250, details: true }));
  if (loadTokens.get(tabId) !== token) return;
  if (!r.ok) { patchB(tabId, { loading: false, error: resultText(r) }); return; }
  patchB(tabId, (cur) => ({ loading: false, keys: mergeKeys(cur.keys, r.value.keys.filter((k) => k.type !== undefined)), cursor: r.value.cursor }));
}

async function loadDbs(tabId: string): Promise<void> {
  const r = await withTab(tabId, (sid) => window.mc.db.redis.databases(sid));
  if (r.ok) patchB(tabId, { dbs: r.value });
}

/** Details of one key again (after an edit in the value panel: TTL, length, or gone). */
export async function refreshKey(tabId: string, key: RedisData): Promise<void> {
  const r = await withTab(tabId, (sid) => window.mc.db.redis.keyInfo(sid, [key]));
  if (!r.ok) return;
  const info = r.value[0];
  const id = redisDataKey(key);
  patchB(tabId, (b) => {
    if (!info?.type) return { keys: b.keys.filter((k) => redisDataKey(k.key) !== id), current: b.current && redisDataKey(b.current.key) === id ? null : b.current };
    const known = b.keys.some((k) => redisDataKey(k.key) === id);
    return { keys: known ? b.keys.map((k) => (redisDataKey(k.key) === id ? info : k)) : [...b.keys, info], current: b.current && redisDataKey(b.current.key) === id ? info : b.current };
  });
}

/** A key the value panel renamed or deleted. */
export function keyGone(tabId: string, key: RedisData, renamedTo?: RedisData): void {
  const id = redisDataKey(key);
  patchB(tabId, (b) => ({ keys: b.keys.filter((k) => redisDataKey(k.key) !== id), selected: b.selected.filter((s) => s !== id), current: b.current && redisDataKey(b.current.key) === id ? null : b.current }));
  if (renamedTo !== undefined) {
    void refreshKey(tabId, renamedTo).then(() => patchB(tabId, (b) => ({ current: b.keys.find((k) => redisDataKey(k.key) === redisDataKey(renamedTo)) ?? null })));
  }
}

export default function RedisKeyBrowser({ tabId, ref, readOnly }: RedisViewProps) {
  const { tr } = useI18n();
  const b = useBrowsers((st) => st[tabId]) ?? fresh();
  const [dialog, setDialog] = useState<null | 'new' | { pattern: string }>(null);
  useEffect(() => { if (b.cursor === null && !b.loading && !b.error) void loadKeys(tabId, true); }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!b.dbs) void loadDbs(tabId); }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = useMemo(() => new Set(b.open), [b.open]);
  const rows = useMemo(() => redisKeyRows(b.keys, b.mode, open), [b.keys, b.mode, open]);
  const selected = useMemo(() => new Set(b.selected), [b.selected]);
  const currentId = b.current ? redisDataKey(b.current.key) : null;
  const dbCount = b.dbs?.count ?? 16;
  const dbKeys = (i: number) => b.dbs?.dbs.find((d) => d.index === i)?.keys ?? 0;
  const done = b.cursor === '0';

  const switchDb = async (index: number) => {
    const r = await withTab(tabId, (sid) => window.mc.db.redis.select(sid, index));
    if (!r.ok) { toast(resultText(r), 'error'); return; }
    setTabDb(tabId, index);
    patchB(tabId, { current: null, selected: [], open: [] });
    void loadKeys(tabId, true);
    void loadDbs(tabId);
  };
  const refresh = () => { void loadKeys(tabId, true); void loadDbs(tabId); };
  const toggleSelect = (id: string) => patchB(tabId, (cur) => ({ selected: cur.selected.includes(id) ? cur.selected.filter((s) => s !== id) : [...cur.selected, id] }));
  const toggleFolder = (path: string) => patchB(tabId, (cur) => ({ open: cur.open.includes(path) ? cur.open.filter((p) => p !== path) : [...cur.open, path] }));
  const deleteSelected = async () => {
    const keys = b.keys.filter((k) => selected.has(redisDataKey(k.key))).map((k) => k.key);
    if (!keys.length) return;
    const choice = await askChoice(tr('Usunąć zaznaczone klucze?'), tr('Zostanie usuniętych kluczy: {count}. Tego nie można cofnąć.', { count: keys.length }), [
      { label: tr('Usuń ({count})', { count: keys.length }), value: 'delete', danger: true },
    ]);
    if (choice !== 'delete') return;
    const r = await withTab(tabId, (sid) => window.mc.db.redis.write(sid, { op: 'delete', keys }));
    if (!r.ok) { toast(resultText(r), 'error'); return; }
    toast(tr('Usunięto kluczy: {count}', { count: r.value.changed }));
    for (const k of keys) keyGone(tabId, k);
    void loadDbs(tabId);
  };
  const folderMenu = (x: number, y: number, path: string) => openMenu(x, y, [
    { header: path },
    { label: tr('Szukaj w tym folderze'), onClick: () => { patchB(tabId, { pattern: `${path}*` }); void loadKeys(tabId, true); } },
    { label: tr('Kopiuj prefiks'), onClick: () => window.mc.clipboardWrite(path) },
    ...(readOnly ? [] : [{ sep: true as const }, { label: tr('Usuń klucze pasujące do {pattern}…', { pattern: `${path}*` }), danger: true, onClick: () => setDialog({ pattern: `${path}*` }) }]),
  ]);
  const keyMenu = (x: number, y: number, info: RedisKeyInfo) => openMenu(x, y, [
    { header: redisDataDisplay(info.key) },
    { label: tr('Kopiuj nazwę klucza'), onClick: () => window.mc.clipboardWrite(redisDataDisplay(info.key)) },
    { label: selected.has(redisDataKey(info.key)) ? tr('Odznacz') : tr('Zaznacz'), onClick: () => toggleSelect(redisDataKey(info.key)) },
  ]);

  return (
    <div className="redis-browser">
      <section className="redis-keys-pane" aria-label={tr('Przeglądarka kluczy')}>
        <div className="redis-toolbar">
          <Select className="select redis-db-select" value={String(ref.db)} title={tr('Baza danych')} onChange={(e) => void switchDb(Number(e.target.value))}>
            {Array.from({ length: Math.max(dbCount, ref.db + 1) }, (_, i) => <option key={i} value={String(i)}>{`DB ${i}${dbKeys(i) ? ` (${dbKeys(i).toLocaleString()})` : ''}`}</option>)}
          </Select>
          <form className="redis-search" onSubmit={(e) => { e.preventDefault(); void loadKeys(tabId, true); }}>
            <ISearch />
            <input className="input" value={b.pattern} placeholder={tr('Wzorzec, np. user:*')} aria-label={tr('Wzorzec kluczy')} spellCheck={false}
              onChange={(e) => patchB(tabId, { pattern: e.target.value })} />
          </form>
          <Select className="select redis-type-select" value={b.type} title={tr('Typ')} onChange={(e) => { patchB(tabId, { type: e.target.value }); void loadKeys(tabId, true); }}>
            <option value="">{tr('Wszystkie typy')}</option>
            {REDIS_EDITABLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          <button className="btn small icon ghost" title={tr('Odśwież')} aria-label={tr('Odśwież')} onClick={refresh}><RefreshIcon spinning={b.loading} /></button>
        </div>
        <div className="redis-toolbar sub">
          <div className="redis-seg" role="group" aria-label={tr('Widok kluczy')}>
            <button className={b.mode === 'tree' ? 'on' : ''} aria-pressed={b.mode === 'tree'} onClick={() => patchB(tabId, { mode: 'tree' })}>{tr('Drzewo')}</button>
            <button className={b.mode === 'flat' ? 'on' : ''} aria-pressed={b.mode === 'flat'} onClick={() => patchB(tabId, { mode: 'flat' })}>{tr('Lista')}</button>
          </div>
          <span className="grow" />
          {!readOnly && <button className="btn small" onClick={() => setDialog({ pattern: b.applied || '*' })}>{tr('Usuń wg wzorca…')}</button>}
          {!readOnly && <button className="btn small primary redis-new-key" onClick={() => setDialog('new')}><IPlus /> {tr('Nowy klucz')}</button>}
        </div>
        {b.error && <div className="redis-error-text pad" role="alert">{b.error}</div>}
        <VirtualList className="redis-key-list" label={tr('Przeglądarka kluczy')} count={rows.length} rowHeight={ROW}
          scrollTo={currentId ? rows.findIndex((r) => r.id === currentId) : null}
          row={(i) => {
            const r = rows[i];
            if (r.kind === 'folder') {
              const path = r.id.slice(2);
              return (
                <div className="redis-key-row folder" role="listitem" style={{ paddingLeft: 8 + r.depth * 14 }} onClick={() => toggleFolder(path)}
                  onContextMenu={(e) => { e.preventDefault(); folderMenu(e.clientX, e.clientY, path); }}>
                  <span className={`redis-chev ${r.open ? 'open' : ''}`}><IChevron /></span>
                  <span className="redis-key-name">{r.name}</span>
                  <span className="redis-count">{r.count.toLocaleString()}</span>
                </div>
              );
            }
            const id = r.id;
            const ttl = formatTtl(r.info.ttlMs);
            return (
              <div className={`redis-key-row ${id === currentId ? 'current' : ''} ${selected.has(id) ? 'selected' : ''}`} role="listitem" title={redisDataDisplay(r.info.key)}
                style={{ paddingLeft: 8 + r.depth * 14 }} onClick={() => patchB(tabId, { current: r.info })}
                onContextMenu={(e) => { e.preventDefault(); keyMenu(e.clientX, e.clientY, r.info); }}>
                <input type="checkbox" className="redis-key-check" checked={selected.has(id)} aria-label={tr('Zaznacz')} onClick={(e) => e.stopPropagation()} onChange={() => toggleSelect(id)} />
                <TypeBadge type={r.info.type} />
                <span className="redis-key-name">{r.name}</span>
                <span className={`redis-ttl ${ttl ? '' : 'none'}`} title={ttl ? tr('Wygasa za {ttl}', { ttl }) : tr('Bez wygaśnięcia')}>{ttl ?? ''}</span>
                <span className="redis-size">{r.info.memory !== undefined ? formatBytes(r.info.memory) : ''}</span>
              </div>
            );
          }}
          end={!done && b.cursor !== null ? (
            <div className="redis-more"><button className="btn small redis-load-more" disabled={b.loading} onClick={() => void loadKeys(tabId, false)}>{b.loading ? tr('Wczytywanie…') : tr('Wczytaj więcej')}</button></div>
          ) : rows.length === 0 && !b.loading && b.cursor !== null ? <div className="redis-empty muted">{tr('Brak kluczy')}</div> : null}
        />
        <footer className="redis-foot">
          <span className="muted redis-loaded">{done ? tr('Kluczy: {count}', { count: b.keys.length.toLocaleString() }) : tr('Wczytano kluczy: {count}', { count: b.keys.length.toLocaleString() })}</span>
          <span className="grow" />
          {b.selected.length > 0 && <>
            <span className="muted">{tr('Zaznaczono: {count}', { count: b.selected.length })}</span>
            <button className="btn small ghost" onClick={() => patchB(tabId, { selected: [] })}>{tr('Odznacz')}</button>
            {!readOnly && <button className="btn small danger redis-delete-selected" onClick={() => void deleteSelected()}>{tr('Usuń zaznaczone')}</button>}
          </>}
        </footer>
      </section>
      <section className="redis-value-pane">
        {b.current
          ? <RedisValuePanel key={`${ref.db}:${redisDataKey(b.current.key)}`} tabId={tabId} info={b.current} readOnly={readOnly} onChanged={(k) => void refreshKey(tabId, k)} onGone={(k, to) => keyGone(tabId, k, to)} />
          : <div className="redis-center muted">{tr('Wybierz klucz, aby zobaczyć jego wartość')}</div>}
      </section>
      {dialog === 'new' && <NewKeyDialog tabId={tabId} onClose={() => setDialog(null)} onCreated={(k) => { setDialog(null); void refreshKey(tabId, k).then(() => patchB(tabId, (cur) => ({ current: cur.keys.find((x) => redisDataKey(x.key) === redisDataKey(k)) ?? null }))); void loadDbs(tabId); }} />}
      {dialog && dialog !== 'new' && <PatternDeleteDialog tabId={tabId} initial={dialog.pattern} type={b.type} onClose={() => setDialog(null)} onDeleted={() => { setDialog(null); void loadKeys(tabId, true); void loadDbs(tabId); }} />}
    </div>
  );
}

// ── new key ─────────────────────────────────────────────────────────────────

function NewKeyDialog({ tabId, onClose, onCreated }: { tabId: string; onClose: () => void; onCreated: (key: RedisData) => void }) {
  const { tr } = useI18n();
  const [key, setKey] = useState('');
  const [type, setType] = useState<RedisEditableType>('string');
  const [a, setA] = useState('');
  const [v, setV] = useState('');
  const [ttl, setTtl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsField = type === 'hash' || type === 'zset' || type === 'stream';
  const firstLabel = type === 'hash' || type === 'stream' ? tr('Pole') : type === 'zset' ? tr('Element') : type === 'string' ? tr('Wartość') : tr('Element');
  const create = async () => {
    if (!key) { setError(tr('Podaj nazwę klucza')); return; }
    const ttlMs = ttl.trim() ? parseTtlInput(ttl) : undefined;
    if (ttlMs === null) { setError(tr('Nieprawidłowy czas wygaśnięcia')); return; }
    if (type === 'zset' && !validScore(v)) { setError(tr('Nieprawidłowy wynik')); return; }
    if (needsField && !a) { setError(tr('Podaj nazwę pola')); return; }
    const value: RedisNewValue = type === 'string' ? { type, value: a }
      : type === 'hash' ? { type, entries: [[a, v]] }
        : type === 'list' ? { type, items: [a] }
          : type === 'set' ? { type, members: [a] }
            : type === 'zset' ? { type, entries: [[a, v.trim()]] }
              : { type, fields: [[a, v]] };
    setBusy(true);
    const r = await withTab(tabId, (sid) => window.mc.db.redis.write(sid, { op: 'create', key, value, ...(ttlMs ? { ttlMs } : {}) }));
    setBusy(false);
    if (!r.ok) { setError(resultText(r)); return; }
    onCreated(key);
  };
  return (
    <RedisDialog title={tr('Nowy klucz')} onClose={onClose} actions={<>
      <button className="btn small" onClick={onClose}>{tr('Anuluj')}</button>
      <button className="btn small primary redis-create" disabled={busy} onClick={() => void create()}>{tr('Utwórz')}</button>
    </>}>
      <label className="field"><span>{tr('Nazwa klucza')}</span><input className="input redis-new-name" autoFocus value={key} spellCheck={false} onChange={(e) => setKey(e.target.value)} /></label>
      <div className="field"><span>{tr('Typ')}</span>
        <div className="redis-seg wrap" role="radiogroup" aria-label={tr('Typ')}>
          {REDIS_EDITABLE_TYPES.map((t) => <button key={t} role="radio" aria-checked={type === t} className={type === t ? 'on' : ''} onClick={() => setType(t)}><TypeBadge type={t} /> {t}</button>)}
        </div>
      </div>
      {type === 'string' || type === 'list' || type === 'set'
        ? <label className="field"><span>{firstLabel}</span><textarea className="textarea redis-new-value" rows={4} value={a} spellCheck={false} onChange={(e) => setA(e.target.value)} /></label>
        : <div className="redis-two">
          <label className="field"><span>{firstLabel}</span><input className="input redis-new-field" value={a} spellCheck={false} onChange={(e) => setA(e.target.value)} /></label>
          <label className="field"><span>{type === 'zset' ? tr('Wynik') : tr('Wartość')}</span><input className="input redis-new-value" value={v} spellCheck={false} onChange={(e) => setV(e.target.value)} /></label>
        </div>}
      <label className="field"><span>{tr('Czas wygaśnięcia (opcjonalnie)')}</span><input className="input" value={ttl} placeholder={tr('np. 60, 5m, 2h, 1d')} onChange={(e) => setTtl(e.target.value)} /></label>
      {error && <p className="redis-error-text" role="alert">{error}</p>}
    </RedisDialog>
  );
}

// ── delete by pattern ───────────────────────────────────────────────────────

function PatternDeleteDialog({ tabId, initial, type, onClose, onDeleted }: { tabId: string; initial: string; type: string; onClose: () => void; onDeleted: () => void }) {
  const { tr } = useI18n();
  const [pattern, setPattern] = useState(initial);
  const [count, setCount] = useState<{ token: string; count: number; complete: boolean; pattern: string } | null>(null);
  const [step, setStep] = useState<'idle' | 'counting' | 'deleting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [deletedSoFar, setDeletedSoFar] = useState(0);
  const run = async () => {
    setError(null);
    if (!count || count.pattern !== pattern) {
      setStep('counting');
      const r = await withTab(tabId, (sid) => window.mc.db.redis.countPattern(sid, pattern || '*', type || undefined));
      setStep('idle');
      if (!r.ok) { setError(resultText(r)); return; }
      setCount({ ...r.value, pattern });
      return;
    }
    if (count.count === 0) { onClose(); return; }
    setStep('deleting');
    const r = await withTab(tabId, (sid) => window.mc.db.redis.deletePattern(sid, count.token));
    setStep('idle');
    if (!r.ok) { setError(resultText(r)); setCount(null); return; }
    const total = deletedSoFar + r.value.deleted;
    setDeletedSoFar(total);
    if (r.value.cancelled) { toast(tr('Przerwano. Usunięto kluczy: {count}', { count: total })); onDeleted(); return; }
    // The delete stops near the confirmed count: `more` means keys still match (added meanwhile, or the count was capped).
    // Count again and offer to go on, asking with the new count; nothing more is deleted without that confirmation.
    if (!r.value.more) { toast(tr('Usunięto kluczy: {count}', { count: total })); onDeleted(); return; }
    setStep('counting');
    const again = await withTab(tabId, (sid) => window.mc.db.redis.countPattern(sid, pattern || '*', type || undefined));
    setStep('idle');
    if (again.ok && again.value.count > 0) { setCount({ ...again.value, pattern }); return; }
    toast(tr('Usunięto kluczy: {count}', { count: total }));
    onDeleted();
  };
  const cancel = () => { if (step !== 'idle') void withTab(tabId, (sid) => window.mc.db.redis.cancel(sid)); else onClose(); };
  const ready = count && count.pattern === pattern;
  const countText = ready ? (count.complete ? String(count.count) : tr('co najmniej {count}', { count: count.count })) : '';
  return (
    <RedisDialog title={tr('Usuń klucze wg wzorca')} onClose={cancel} actions={<>
      <button className="btn small" onClick={cancel}>{step === 'idle' ? tr('Anuluj') : tr('Przerwij')}</button>
      <button className={`btn small ${ready && count.count > 0 ? 'danger' : 'primary'} redis-pattern-run`} disabled={step !== 'idle'} onClick={() => void run()}>
        {!ready ? tr('Policz klucze') : count.count === 0 ? tr('Zamknij') : tr('Usuń {count} kluczy', { count: countText })}
      </button>
    </>}>
      <label className="field"><span>{tr('Wzorzec')}</span><input className="input redis-pattern-input" autoFocus value={pattern} spellCheck={false} disabled={step !== 'idle'} onChange={(e) => setPattern(e.target.value)} /></label>
      {type && <p className="muted">{tr('Tylko klucze typu {type}', { type })}</p>}
      {step === 'counting' && <p className="muted" role="status">{tr('Liczenie kluczy…')}</p>}
      {step === 'deleting' && <p className="muted" role="status">{tr('Usuwanie kluczy…')}</p>}
      {deletedSoFar > 0 && step === 'idle' && <p className="muted" role="status">{tr('Usunięto już kluczy: {count}. Część pasujących kluczy wciąż istnieje.', { count: deletedSoFar })}</p>}
      {ready && step === 'idle' && <p className={count.count ? 'redis-warn-text' : 'muted'} role="status">{count.count ? tr('Pasujące klucze: {count}. Usunięcia nie można cofnąć.', { count: countText }) : tr('Żaden klucz nie pasuje do wzorca')}</p>}
      {error && <p className="redis-error-text" role="alert">{error}</p>}
    </RedisDialog>
  );
}
