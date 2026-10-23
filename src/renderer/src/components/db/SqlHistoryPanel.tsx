// The History panel of a SQL editor tab (1.0.6): the statements this connection ran (kept by main on this computer), newest
// first, with search, favourites and clearing. A click puts a statement at the editor's cursor, a double click (or Shift+Enter)
// puts it there and runs it. "Zapisuj historię" turns recording off for every connection.
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchHistory, type DbHistoryItem } from '../../../../shared/dbHistory';
import { historyChanged, onHistoryChanged } from '../../db/tabs';
import { useI18n } from '../../i18n';
import { askChoice, toast } from '../../store';
import { IX } from '../icons';

/** Entries the list shows at most (the search reaches every one). */
const SHOWN = 300;

export function SqlHistoryPanel({ connectionId, onInsert, onRun, onClose }: { connectionId: string; onInsert(sql: string): void; onRun(sql: string): void; onClose(): void }) {
  const { tr, language } = useI18n();
  const [entries, setEntries] = useState<DbHistoryItem[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [query, setQuery] = useState('');
  const [starred, setStarred] = useState(false);
  /**
   * Entries added while the pointer is over the list (a double click ran one): shown when it leaves, so the entry under the
   * pointer (and its tooltip) stays where it was instead of the list moving down by one.
   */
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const hovered = useRef(false);
  const shownIds = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.mc.db.history.list(connectionId).then((r) => {
        if (!alive) return;
        const before = shownIds.current;
        if (hovered.current && before) {
          const added = r.entries.filter((e) => !before.has(e.id)).map((e) => e.id);
          if (added.length) setHeld((h) => new Set([...h, ...added]));
        }
        setEntries(r.entries);
        setEnabled(r.enabled);
      }).catch(() => undefined);
    };
    load();
    const off = onHistoryChanged((id) => { if (id === connectionId) load(); });
    return () => { alive = false; off(); };
  }, [connectionId]);
  const visible = useMemo(() => (entries && held.size ? entries.filter((e) => !held.has(e.id)) : entries), [entries, held]);
  useEffect(() => { shownIds.current = visible ? new Set(visible.map((e) => e.id)) : null; }, [visible]);
  const found = useMemo(() => searchHistory(visible ?? [], query, { starred }), [visible, query, starred]);
  const time = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'medium' }), [language]);
  const nf = useMemo(() => new Intl.NumberFormat(language), [language]);

  const star = async (e: DbHistoryItem) => {
    const r = await window.mc.db.history.star(connectionId, e.id, !e.star);
    if (!r.ok) { toast(tr('Nie udało się zapisać zmian'), 'error'); return; }
    historyChanged(connectionId);
  };
  const clear = async () => {
    const stars = (entries ?? []).filter((e) => e.star).length;
    const choice = await askChoice(tr('Wyczyścić historię zapytań?'), stars ? tr('Ulubione ({count}) zostaną zachowane.', { count: stars }) : tr('Historia tego połączenia zostanie usunięta z tego komputera.'), [
      { label: tr('Wyczyść historię'), value: 'clear', danger: true },
    ]);
    if (choice !== 'clear') return;
    const r = await window.mc.db.history.clear(connectionId);
    if (!r.ok) toast(tr('Nie udało się zapisać zmian'), 'error');
    historyChanged(connectionId);
  };
  const toggleEnabled = async (on: boolean) => {
    const r = await window.mc.db.history.setEnabled(on);
    if (r.ok) setEnabled(on); else toast(tr('Nie udało się zapisać zmian'), 'error');
  };

  return (
    <aside className="db-history" aria-label={tr('Historia zapytań')} data-field="history">
      <div className="db-history-head">
        <strong>{tr('Historia zapytań')}</strong>
        <span className="grow" />
        <button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={onClose}><IX /></button>
      </div>
      <div className="db-history-tools">
        <input className="input" data-field="history-search" placeholder={tr('Szukaj w historii…')} aria-label={tr('Szukaj w historii…')} value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
        <button className={`btn small ghost db-history-starred ${starred ? 'on' : ''}`} aria-pressed={starred} title={tr('Tylko ulubione')} aria-label={tr('Tylko ulubione')} onClick={() => setStarred((v) => !v)}>{starred ? '★' : '☆'}</button>
      </div>
      <div className="db-history-list" role="listbox" aria-label={tr('Historia zapytań')}
        onMouseEnter={() => { hovered.current = true; }} onMouseLeave={() => { hovered.current = false; setHeld((h) => (h.size ? new Set() : h)); }}>
        {entries === null ? <div className="db-status">{tr('Wczytywanie…')}</div>
          : !found.length ? <div className="db-status">{query || starred ? tr('Nic nie pasuje') : enabled ? tr('Historia zapytań jest pusta') : tr('Historia zapytań jest wyłączona')}</div>
            : found.slice(0, SHOWN).map((e) => (
              <div key={e.id} className={`db-history-item ${e.ok ? '' : 'error'}`} role="option" aria-selected={false} tabIndex={0} data-history-id={e.id}
                title={`${e.sql}${e.error ? `\n\n${e.error}` : ''}\n\n${tr('Kliknij, aby wstawić; kliknij dwukrotnie, aby uruchomić')}`}
                onClick={(ev) => { if (ev.detail <= 1) onInsert(e.sql); }} onDoubleClick={(ev) => { ev.preventDefault(); onRun(e.sql); }}
                onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (ev.shiftKey) onRun(e.sql); else onInsert(e.sql); } }}>
                <button className={`db-history-star ${e.star ? 'on' : ''}`} aria-label={e.star ? tr('Usuń z ulubionych') : tr('Dodaj do ulubionych')} aria-pressed={!!e.star}
                  onClick={(ev) => { ev.stopPropagation(); void star(e); }} onDoubleClick={(ev) => ev.stopPropagation()}>{e.star ? '★' : '☆'}</button>
                <div className="db-history-body">
                  <div className="db-history-sql">{e.sql.replace(/\s+/g, ' ').slice(0, 400)}</div>
                  <div className="db-history-meta">
                    <span>{time.format(e.at)}</span>
                    <span>{e.timeMs} ms</span>
                    {e.rows !== null && <span>{tr('wiersze: {count}', { count: nf.format(e.rows) })}</span>}
                    {!e.ok && <span className="db-history-error">{e.error ?? tr('błąd')}</span>}
                  </div>
                </div>
              </div>
            ))}
        {found.length > SHOWN && <div className="db-status">{tr('…i jeszcze {count}', { count: found.length - SHOWN })}</div>}
      </div>
      <div className="db-history-foot">
        <label className="check" title={tr('Historia zostaje na tym komputerze i nie zawiera haseł z zapytań.')}>
          <input type="checkbox" data-field="history-enabled" checked={enabled} onChange={(e) => void toggleEnabled(e.target.checked)} />{tr('Zapisuj historię zapytań')}
        </label>
        <span className="grow" />
        <button className="btn small ghost" data-action="history-clear" disabled={!entries?.some((e) => !e.star)} onClick={() => void clear()}>{tr('Wyczyść')}</button>
      </div>
    </aside>
  );
}
