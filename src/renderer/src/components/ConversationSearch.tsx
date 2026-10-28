// Search across every Claude Code and Codex conversation of every project (1.0.9): a query box with filters, the matching
// conversations newest first with highlighted snippets, and a read-only transcript of the selected one. Enter resumes it in a
// new cell of its project's grid, Ctrl+Enter in the focused cell when that one is free. The index lives in a worker thread
// of main (src/convsearch); this view only asks it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { markText, normalizeFolder, parseTerms, type ConvHit, type ConvQuery, type ConvSearchResult, type ConvTranscript } from '../../../shared/convSearch';
import type { MessageKey } from '../../../shared/i18n';
import { formatAgo } from '../../../shared/i18n';
import { copySessionId, focusedCellUse, openCellOf, resumeConversation, type FocusedUse } from '../conversationSearch';
import { useI18n } from '../i18n';
import { closeModal, useStore } from '../store';
import { IX } from './icons';
import { Select } from './Select';
import './conversationSearch.css';

type Range = 'any' | '1d' | '7d' | '30d' | '90d' | 'custom';
const DAY = 86_400_000;
const RANGE_DAYS: Record<Exclude<Range, 'any' | 'custom'>, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };
const DEBOUNCE_MS = 160;
const MOD = window.mc.platform === 'darwin' ? 'Cmd' : 'Ctrl';
const POLL_MS = 700;

/** Text with highlighted ranges. */
function Marked({ text, marks }: { text: string; marks: Array<[number, number]> }) {
  if (!marks.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  marks.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i} className="find-mark">{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const dayStart = (value: string) => (value ? new Date(`${value}T00:00:00`).getTime() : undefined);
const dayEnd = (value: string) => (value ? new Date(`${value}T23:59:59.999`).getTime() : undefined);

const FOCUSED_REASON: Record<Exclude<FocusedUse, { ok: true }>['reason'], MessageKey> = {
  none: 'Najpierw zaznacz komórkę w gridzie.',
  project: 'Aktywna komórka należy do innego projektu niż ta rozmowa.',
  folder: 'Aktywna komórka pracuje w innym folderze niż ta rozmowa.',
  busy: 'Aktywna komórka jest zajęta (agent pracuje albo czeka na odpowiedź).',
  ssh: 'Aktywna komórka to sesja SSH.',
};

export function ConversationSearch() {
  const { tr, language } = useI18n();
  const s = useStore((st) => st.s);
  const focusedId = useStore((st) => st.ui.focusedCellId);
  const statuses = useStore((st) => st.ui.statuses);
  const [q, setQ] = useState('');
  const [cli, setCli] = useState<'all' | 'claude' | 'codex'>('all');
  const [role, setRole] = useState<'all' | 'user' | 'assistant'>('all');
  const [project, setProject] = useState('');
  const [range, setRange] = useState<Range>('any');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<ConvSearchResult | null>(null);
  const [sel, setSel] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<{ file: string; data: ConvTranscript } | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [poll, setPoll] = useState(0);

  const query = useMemo<ConvQuery>(() => {
    const out: ConvQuery = { text: q, cli, role };
    if (project) out.project = project;
    if (range === 'custom') {
      const a = dayStart(from), b = dayEnd(to);
      if (a !== undefined) out.from = a;
      if (b !== undefined) out.to = b;
    } else if (range !== 'any') out.from = Date.now() - RANGE_DAYS[range] * DAY;
    return out;
  }, [q, cli, role, project, range, from, to]);

  useEffect(() => {
    const id = ++seq.current;
    const timer = window.setTimeout(() => {
      void window.mc.conversations.search(query).then((r) => {
        if (seq.current !== id) return; // a newer query replaced this one
        setResult(r);
        // While the index is being built the answer grows: ask again until it is complete.
        if (r.indexing) window.setTimeout(() => { if (seq.current === id) setPoll((n) => n + 1); }, POLL_MS);
      });
    }, poll ? 0 : DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, poll]);

  useEffect(() => { setSel(0); setFocusIndex(null); }, [query]);

  const hits = result?.hits ?? [];
  const current: ConvHit | undefined = hits[Math.min(sel, hits.length - 1)];
  const terms = useMemo(() => parseTerms(q), [q]);

  // The transcript of the selected conversation, read when the selection rests for a moment.
  useEffect(() => {
    if (!current) { setTranscript(null); return; }
    if (transcript?.file === current.file) return;
    const file = current.file;
    const timer = window.setTimeout(() => {
      void window.mc.conversations.transcript(file).then((data) => setTranscript((t) => (t?.file === file ? t : { file, data })));
    }, 140);
    return () => window.clearTimeout(timer);
  }, [current?.file]);

  const target = focusIndex ?? current?.snippets[0]?.index ?? null;
  useEffect(() => {
    if (!transcript || transcript.file !== current?.file) return;
    const box = previewRef.current;
    if (!box) return;
    const el = target !== null ? box.querySelector<HTMLElement>(`[data-msg="${target}"]`) : null;
    if (el) el.scrollIntoView({ block: 'start' }); else box.scrollTop = 0;
  }, [transcript, target, current?.file]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-hit="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const focused = current ? focusedCellUse(s, { focusedCellId: focusedId, statuses }, current) : null;
  const openCell = current ? openCellOf(s, current) : null;
  const resume = (hit: ConvHit | undefined, where: 'newCell' | 'cell') => { if (hit) void resumeConversation(hit, where); };

  const onKey = (e: React.KeyboardEvent) => {
    // Keys in the filters (a list box, a date field) stay with them; the query box and the results drive the list.
    const el = e.target as HTMLElement;
    if (el.closest('.conv-toolbar') && !el.classList.contains('conv-query')) return;
    if (el.closest('.conv-actions')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      setSel((i) => Math.max(0, Math.min(hits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
      setFocusIndex(null);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      setSel((i) => Math.max(0, Math.min(hits.length - 1, i + (e.key === 'PageDown' ? 8 : -8))));
      setFocusIndex(null);
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && focused?.ok) resume(current, 'cell');
      else if (!e.ctrlKey && !e.metaKey) resume(current, 'newCell');
    }
  };

  const projects = result?.projects ?? [];
  const projectLabel = (cwd: string) => {
    const known = s.projects.find((p) => normalizeFolder(p.path) === normalizeFolder(cwd));
    return known ? known.name : baseName(cwd);
  };

  const status = (() => {
    if (!result) return tr('Wczytywanie…');
    if (result.error) return tr('Wyszukiwanie nie powiodło się: {error}', { error: result.error });
    const parts = [tr('Rozmowy: {count} z {all}', { count: result.total, all: result.conversations })];
    if (result.indexing) parts.push(tr('Indeksowanie: {done} z {total} plików', { done: result.indexing.done, total: result.indexing.total }));
    else parts.push(`${result.tookMs} ms`);
    if (result.total > hits.length) parts.push(tr('Pokazano najnowsze {count}', { count: hits.length }));
    return parts.join(' · ');
  })();

  return (
    <div className="modal conv-search" onKeyDown={onKey}>
      <div className="modal-head">
        <h3>{tr('Szukaj w rozmowach')}</h3>
        <span className="muted conv-scope">{tr('Wszystkie projekty, Claude Code i Codex')}</span>
        <button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={closeModal}><IX /></button>
      </div>
      <div className="conv-toolbar">
        <input className="input conv-query" autoFocus value={q} spellCheck={false} placeholder={tr('Szukaj słów lub "całej frazy"…')}
          aria-label={tr('Szukaj w rozmowach')} onChange={(e) => setQ(e.target.value)} />
        <Select className="select" value={cli} aria-label={tr('Agent')} onChange={(e) => setCli(e.target.value as typeof cli)}>
          <option value="all">{tr('Claude i Codex')}</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </Select>
        <Select className="select" value={role} aria-label={tr('Wiadomości')} onChange={(e) => setRole(e.target.value as typeof role)}>
          <option value="all">{tr('Wszystkie wiadomości')}</option>
          <option value="user">{tr('Tylko moje prompty')}</option>
          <option value="assistant">{tr('Tylko odpowiedzi agenta')}</option>
        </Select>
        <Select className="select conv-project" value={project} aria-label={tr('Projekt')} onChange={(e) => setProject(e.target.value)}>
          <option value="">{tr('Wszystkie projekty')}</option>
          {projects.map((p) => <option key={p.key} value={p.key} title={p.cwd}>{`${projectLabel(p.cwd)} (${p.count})`}</option>)}
        </Select>
        <Select className="select" value={range} aria-label={tr('Okres')} onChange={(e) => setRange(e.target.value as Range)}>
          <option value="any">{tr('Dowolny czas')}</option>
          <option value="1d">{tr('Ostatnie 24 godziny')}</option>
          <option value="7d">{tr('Ostatnie 7 dni')}</option>
          <option value="30d">{tr('Ostatnie 30 dni')}</option>
          <option value="90d">{tr('Ostatnie 90 dni')}</option>
          <option value="custom">{tr('Zakres dat…')}</option>
        </Select>
        {range === 'custom' && (
          <span className="conv-dates">
            <input type="date" className="input" aria-label={tr('Od dnia')} value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="muted">-</span>
            <input type="date" className="input" aria-label={tr('Do dnia')} value={to} onChange={(e) => setTo(e.target.value)} />
          </span>
        )}
      </div>
      <div className="conv-status muted" role="status">{status}</div>
      <div className="conv-body">
        <div className="conv-list" ref={listRef} role="listbox" aria-label={tr('Wyniki')}>
          {result && !hits.length && !result.indexing && (
            <div className="muted conv-empty">{result.conversations ? tr('Żadna rozmowa nie pasuje do zapytania.') : tr('Nie znaleziono jeszcze żadnych rozmów Claude Code ani Codex.')}</div>
          )}
          {hits.map((h, i) => (
            <div key={`${h.cli}:${h.id}`} data-hit={i} role="option" aria-selected={i === sel} className={`conv-hit ${i === sel ? 'on' : ''}`}
              onMouseDown={() => { setSel(i); setFocusIndex(null); }} onDoubleClick={() => resume(h, 'newCell')}>
              <div className="conv-hit-head">
                <span className={`cli ${h.cli}`}>{h.cli}</span>
                <span className="conv-title" title={h.title}><Marked text={h.title} marks={h.titleMarks} /></span>
                <span className="conv-time" title={new Date(h.updatedAt).toLocaleString(language)}>{formatAgo(language, h.updatedAt)}</span>
              </div>
              <div className="conv-hit-meta muted">
                <span title={h.cwd}>{projectLabel(h.cwd)}</span>
                {h.hits > 0 && <span>{tr('Trafienia w wiadomościach: {count}', { count: h.hits })}</span>}
              </div>
              {h.snippets.map((sn) => (
                <button type="button" key={sn.index} className="conv-snippet" tabIndex={-1}
                  onMouseDown={(e) => { e.stopPropagation(); setSel(i); setFocusIndex(sn.index); }}>
                  <span className={`conv-role ${sn.role}`}>{sn.role === 'user' ? tr('Ty') : tr('Agent')}</span>
                  <span className="conv-snippet-text">{sn.before ? '… ' : ''}<Marked text={sn.text} marks={sn.marks} />{sn.after ? ' …' : ''}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="conv-preview">
          {current ? (
            <>
              <div className="conv-preview-head">
                <div className="conv-preview-title" title={current.title}>{current.title}</div>
                <div className="conv-preview-meta muted">
                  <span className={`cli ${current.cli}`}>{current.cli}</span>
                  {current.model && <span>{current.model}</span>}
                  <span title={current.cwd}>{current.cwd}</span>
                  <span>{tr('Wiadomości: {count}', { count: current.messages })}</span>
                  <span title={new Date(current.startedAt).toLocaleString(language)}>{tr('Rozpoczęta {when}', { when: formatAgo(language, current.startedAt) })}</span>
                </div>
                <div className="conv-actions">
                  {openCell ? (
                    <button className="btn small primary" onClick={() => resume(current, 'newCell')}>{tr('Pokaż otwartą komórkę')}</button>
                  ) : (
                    <>
                      <button className="btn small primary" title="Enter" onClick={() => resume(current, 'newCell')}>{tr('Wznów w nowej komórce')}</button>
                      <button className="btn small" disabled={!focused?.ok} title={focused && !focused.ok ? tr(FOCUSED_REASON[focused.reason]) : `${MOD}+Enter`}
                        onClick={() => resume(current, 'cell')}>{tr('Wznów w aktywnej komórce')}</button>
                    </>
                  )}
                  <button className="btn small" onClick={() => copySessionId(current)}>{tr('Kopiuj ID')}</button>
                  <span className="conv-id muted" title={current.id}>{current.id}</span>
                </div>
              </div>
              <div className="conv-transcript" ref={previewRef}>
                {transcript?.file !== current.file && <div className="muted conv-empty">{tr('Wczytywanie…')}</div>}
                {transcript?.file === current.file && !transcript.data.ok && <div className="muted conv-empty">{tr('Nie udało się odczytać tej rozmowy.')}</div>}
                {transcript?.file === current.file && transcript.data.messages.map((m, i) => (
                  <div key={i} data-msg={i} className={`conv-msg ${m.role} ${i === target ? 'target' : ''}`}>
                    <div className="conv-msg-head">
                      <span className={`conv-role ${m.role}`}>{m.role === 'user' ? tr('Ty') : tr('Agent')}</span>
                      {m.ts > 0 && <span className="muted">{new Date(m.ts).toLocaleString(language)}</span>}
                    </div>
                    <div className="conv-msg-text"><Marked text={m.text} marks={markText(m.text, terms)} />{m.cut ? ' …' : ''}</div>
                  </div>
                ))}
                {transcript?.file === current.file && transcript.data.capped && <div className="muted conv-empty">{tr('Dalsza część rozmowy jest za długa, żeby ją tu pokazać.')}</div>}
              </div>
            </>
          ) : <div className="muted conv-empty">{tr('Wybierz rozmowę, żeby zobaczyć jej przebieg.')}</div>}
        </div>
      </div>
      <div className="conv-foot muted">{tr('↑↓ wybór · Enter wznawia w nowej komórce · {mod}+Enter w aktywnej komórce · Esc zamyka', { mod: MOD })}</div>
    </div>
  );
}
