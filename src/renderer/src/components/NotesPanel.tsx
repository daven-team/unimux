import { shortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Language } from '../../../shared/languages';
import { translate } from '../../../shared/i18n';
import type { Note } from '../../../shared/types';
import {
  emptyQuery, hitRanges, noteExcerpt, noteMatches, NOTE_SORT_KEY, noteTagsOf, normalizeNoteSort, parseNoteQuery, sortNotes, tagCounts,
  taskProgress, type NoteSort,
} from '../../../shared/noteTools';
import { moveNote, type DropEdge } from '../../../shared/state';
import { PANEL_LIMITS } from '../../../shared/panels';
import { update, useStore } from '../store';
import { captureSelectionToNote, closeNoteInPanel, createNote, importNoteFiles, openNoteInPanel, pickNoteFiles, setNotesQuery, useNotesUi } from '../notesUi';

const setQ = (next: string | ((q: string) => string)) => setNotesQuery(typeof next === 'function' ? next(useNotesUi.getState().query) : next);
import { noteMenuItems, noteTitle, togglePin } from '../noteMenu';
import { SNIPPET_MIME } from './CellView';
import { ICheck, IChevron, IPlus, IX } from './icons';
import { IEyeOff, IWidth } from './menuIcons';
import { ICalendar, ICapture, IChecklist, IImport, INoteBlank, IPeople, IPin, ISort } from './notesIcons';
import { dropEdge, scrollDragList } from './listDrag';
import { openMenu, openMenuAt, type MenuItem } from './ContextMenu';
import type { PanelResizeProps } from './PanelResizeHandle';
import { NoteEditor } from './NoteEditor';
import './notes.css';

const NOTE_MIME = 'application/x-mc-note';
/** The list renders at most this many cards (a search narrows it). */
const SHOWN_MAX = 500;

const readSort = (): NoteSort => { try { return normalizeNoteSort(localStorage.getItem(NOTE_SORT_KEY)); } catch { return 'manual'; } };

/** "2 min ago" in the short form of the cards. */
function shortAgo(language: Language, at: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) return translate(language, 'przed chwilą');
  const f = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
  if (seconds < 3600) return f.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return f.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 86400 * 7) return f.format(-Math.floor(seconds / 86400), 'day');
  return new Date(at).toLocaleDateString(language, { day: 'numeric', month: 'short' });
}

/** `text` with the search hits marked. */
function marked(text: string, terms: readonly string[]): ReactNode {
  const ranges = hitRanges(text, terms);
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([from, to], i) => {
    if (from > at) out.push(text.slice(at, from));
    out.push(<mark key={i}>{text.slice(from, to)}</mark>);
    at = to;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

/** Tasks and tags of a card, read once per version of a note (notes are never changed in place). */
const cardInfo = new WeakMap<Note, { progress: { done: number; total: number }; tags: string[] }>();
function infoOf(n: Note): { progress: { done: number; total: number }; tags: string[] } {
  let info = cardInfo.get(n);
  if (!info) { info = { progress: taskProgress(n.text), tags: noteTagsOf(n).slice(0, 4) }; cardInfo.set(n, info); }
  return info;
}

export function NotesPanel({ resize }: { resize: PanelResizeProps }) {
  const { tr, language } = useI18n();
  const notes = useStore((st) => st.s.notes);
  const projectId = useStore((st) => st.s.activeProjectId);
  const { openId, rename, fresh, cursor, seq, query: q } = useNotesUi();
  const [sort, setSortState] = useState<NoteSort>(readSort);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string | null; edge: DropEdge } | null>(null);
  const [fileDrop, setFileDrop] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  // Like the snippets: global notes and the active project's own, in the user's order.
  const available = useMemo(() => notes.filter((n) => !n.projectId || n.projectId === projectId), [notes, projectId]);
  const query = useMemo(() => parseNoteQuery(q), [q]);
  const visible = useMemo(() => sortNotes(available.filter((n) => noteMatches(n, query)), sort, language).slice(0, SHOWN_MAX), [available, query, sort, language]);
  const tags = useMemo(() => tagCounts(available), [available]);
  // A note of another project (after a project switch) or a deleted one closes the editor.
  const opened = openId ? available.find((n) => n.id === openId) : undefined;
  const canReorder = sort === 'manual';
  const endDrag = () => { setDragId(null); setOver(null); };
  const setSort = (next: NoteSort) => { setSortState(next); try { localStorage.setItem(NOTE_SORT_KEY, next); } catch { /* kept for this run */ } };
  const toggleTag = (tag: string) => {
    const words = q.trim().split(/\s+/).filter(Boolean);
    const has = words.some((w) => w.toLowerCase() === `#${tag}`);
    setQ((has ? words.filter((w) => w.toLowerCase() !== `#${tag}`) : [...words, `#${tag}`]).join(' ') + (has ? '' : ' '));
    search.current?.focus();
  };

  const hide = () => update((st) => ({ ...st, notesOpen: false }));
  const newItems = (): MenuItem[] => [
    { header: tr('Nowa notatka') },
    { label: tr('Pusta notatka'), icon: <INoteBlank />, onClick: () => createNote() },
    { label: tr('Notatka dzienna'), icon: <ICalendar />, onClick: () => createNote('daily') },
    { label: tr('Spotkanie'), icon: <IPeople />, onClick: () => createNote('meeting') },
    { label: tr('Lista zadań'), icon: <IChecklist size={14} />, onClick: () => createNote('checklist') },
    ...(projectId ? [{ label: tr('Nowa notatka tylko w tym projekcie'), icon: <IPlus />, onClick: () => createNote(null, projectId) }] : []),
    { sep: true },
    { label: tr('Z zaznaczonego tekstu'), icon: <ICapture />, hint: shortcutText('notes.capture') || undefined, onClick: captureSelectionToNote },
    { label: tr('Importuj pliki .md…'), icon: <IImport />, onClick: pickNoteFiles },
  ];
  const sortItems = (): MenuItem[] => [
    { header: tr('Kolejność') },
    ...([['manual', tr('Własna (przeciągnij)')], ['recent', tr('Ostatnio zmienione')], ['name', tr('Nazwa')]] as const)
      .map(([id, label]) => ({ label, icon: sort === id ? <ICheck /> : undefined, onClick: () => setSort(id) })),
  ];
  const backgroundMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, .note-card, .note-editor')) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      ...newItems(),
      { sep: true },
      ...sortItems(),
      { sep: true },
      { label: tr('Przywróć szerokość panelu'), icon: <IWidth />, onClick: () => resize.onFinish(PANEL_LIMITS.snippets.default) },
      { label: tr('Ukryj panel notatek'), icon: <IEyeOff />, hint: shortcutText('notes.toggle') || undefined, onClick: hide },
    ]);
  };
  const cardMenu = (e: React.MouseEvent, n: Note) => {
    e.preventDefault();
    e.stopPropagation();
    const index = visible.findIndex((item) => item.id === n.id);
    openMenu(e.clientX, e.clientY, noteMenuItems(n, {
      place: 'card',
      onOpen: () => openNoteInPanel(n.id),
      onRename: () => openNoteInPanel(n.id, { rename: true }),
      onMoveUp: canReorder && index > 0 ? () => update((st) => moveNote(st, n.id, visible[index - 1].id, 'before')) : undefined,
      onMoveDown: canReorder && index < visible.length - 1 ? () => update((st) => moveNote(st, n.id, visible[index + 1].id, 'after')) : undefined,
    }));
  };
  // Markdown and text files dropped anywhere on the panel become notes.
  const fileDropProps = {
    onDragOver: (e: React.DragEvent) => { if (!hasFiles(e) || dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!fileDrop) setFileDrop(true); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDrop(false); },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e) || dragId) return;
      e.preventDefault();
      setFileDrop(false);
      void importNoteFiles(Array.from(e.dataTransfer.files));
    },
  };
  const pinnedCount = visible.filter((n) => n.pinned).length;

  return (
    <aside className={`rpanel notes-panel ${fileDrop ? 'file-drop' : ''}`} aria-label={tr('Panel notatek')} onContextMenu={backgroundMenu} {...fileDropProps}>
      <div className="side-title">
        <span className="row" style={{ gap: 6 }}>
          {tr('Notatki')}
          <span className="help">
            ?
            <span className="help-pop">
              <span className="kbd">{tr('Klik')}</span><span>{tr('otwórz notatkę')}</span>
              <span className="kbd">{tr('Przeciągnij')}</span><span>{tr('zmień kolejność albo wklej do komórki')}</span>
              <span className="kbd">#tag</span><span>{tr('słowo z # w treści to tag; kliknij go, aby filtrować')}</span>
              <span className="kbd">- [ ]</span><span>{tr('zadanie; odhacz je w podglądzie albo Ctrl+Enter')}</span>
              {shortcutText('notes.capture') && <><span className="kbd">{shortcutText('notes.capture')}</span><span>{tr('notatka z zaznaczonego tekstu')}</span></>}
            </span>
          </span>
        </span>
        <span className="notes-new">
          <button className="sq" title={tr('Nowa notatka')} aria-label={tr('Nowa notatka')} onClick={() => createNote()}><IPlus /></button>
          <button className="sq notes-new-more" title={tr('Nowa notatka z szablonu')} aria-label={tr('Nowa notatka z szablonu')} onClick={(e) => openMenuAt(e.currentTarget, newItems())}><IChevron /></button>
        </span>
      </div>
      {opened ? (
        <NoteEditor key={opened.id} note={opened} variant="panel" rename={rename} fresh={fresh} cursor={cursor} focusSeq={seq} onBack={closeNoteInPanel} />
      ) : !available.length ? (
        <div className="notes-empty">
          <div className="notes-empty-art" aria-hidden="true"><span /><span /><span /></div>
          <p className="notes-empty-title">{notes.length ? tr('Brak notatek dostępnych w tym projekcie.') : tr('Twoje notatki, zawsze pod ręką')}</p>
          <p className="muted">{tr('Pomysły, listy zadań i fragmenty kodu obok terminali. Zacznij od szablonu albo upuść tu pliki .md.')}</p>
          <div className="notes-templates">
            <button onClick={() => createNote()}><INoteBlank /><span>{tr('Pusta notatka')}</span></button>
            <button onClick={() => createNote('daily')}><ICalendar /><span>{tr('Notatka dzienna')}</span></button>
            <button onClick={() => createNote('meeting')}><IPeople /><span>{tr('Spotkanie')}</span></button>
            <button onClick={() => createNote('checklist')}><IChecklist size={14} /><span>{tr('Lista zadań')}</span></button>
          </div>
          <p className="muted notes-empty-foot">
            <button className="link-btn" onClick={captureSelectionToNote}><ICapture /> {tr('Z zaznaczonego tekstu')}</button>
            {shortcutText('notes.capture') && <span className="kbd">{shortcutText('notes.capture')}</span>}
          </p>
          <p className="muted notes-empty-foot"><button className="link-btn" onClick={pickNoteFiles}><IImport /> {tr('Importuj pliki .md…')}</button></p>
        </div>
      ) : (
      <>
      <div className="notes-search">
        <input ref={search} className="search" aria-label={tr('Szukaj notatek')} placeholder={tr('Szukaj albo #tag') + '…'} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); } }} />
        {q && <button className="notes-search-clear" title={tr('Wyczyść')} aria-label={tr('Wyczyść')} onClick={() => { setQ(''); search.current?.focus(); }}><IX /></button>}
        <button className={`btn ghost icon notes-sort ${sort !== 'manual' ? 'on' : ''}`} title={tr('Kolejność')} aria-label={tr('Kolejność')} onClick={(e) => openMenuAt(e.currentTarget, sortItems())}><ISort /></button>
      </div>
      {tags.length > 0 && (
        <div className="notes-tags" aria-label={tr('Tagi')}>
          {tags.slice(0, 14).map(({ tag, count }) => (
            <button key={tag} className={`note-tag ${query.tags.includes(tag) ? 'on' : ''}`} onClick={() => toggleTag(tag)} title={tr('Notatki z tagiem #{tag}: {count}', { tag, count })}>#{tag}</button>
          ))}
        </div>
      )}
      <div className="snippets notes"
        onDragOver={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(NOTE_MIME) || !canReorder) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          scrollDragList(e.currentTarget, e.clientY);
          if (!(e.target as HTMLElement).closest('.note-card')) setOver({ id: null, edge: 'after' });
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
        onDrop={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(NOTE_MIME) || !canReorder) return;
          e.preventDefault();
          update((st) => moveNote(st, dragId, visible.at(-1)?.id ?? null, 'after'));
          endDrag();
        }}
      >
        {visible.map((n, i) => {
          const { progress, tags: own } = infoOf(n);
          const excerpt = noteExcerpt(n.text, query.terms, progress.total ? 1 : 2);
          const section = pinnedCount > 0 && (i === 0 || (i === pinnedCount && pinnedCount < visible.length))
            ? <div className="notes-section">{i === 0 ? <><IPin on size={10} /> {tr('Przypięte')}</> : tr('Pozostałe')}</div> : null;
          return (
            <Fragment key={n.id}>
            {section}
            <div
              className={`snippet note-card ${n.pinned ? 'pinned' : ''} ${dragId === n.id ? 'dragging' : ''} ${over?.id === n.id && dragId !== n.id ? `drop-${over.edge}` : ''}`}
              data-note-id={n.id}
              style={n.color ? ({ '--sc': n.color } as React.CSSProperties) : undefined}
              data-colored={n.color ? '' : undefined}
              role="button"
              tabIndex={0}
              aria-label={noteTitle(n)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(NOTE_MIME, n.id);
                // A cell takes a dragged note like a snippet: it pastes the text (without Enter).
                e.dataTransfer.setData(SNIPPET_MIME, JSON.stringify({ id: n.id, name: n.name, text: n.text, autoSend: false }));
                e.dataTransfer.effectAllowed = 'copyMove';
                setDragId(n.id);
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(NOTE_MIME) || !canReorder) return;
                e.preventDefault();
                setOver({ id: n.id, edge: dropEdge(e.currentTarget, e.clientY) });
              }}
              onDrop={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(NOTE_MIME) || !canReorder) return;
                e.preventDefault();
                e.stopPropagation();
                update((st) => moveNote(st, dragId, n.id, dropEdge(e.currentTarget, e.clientY)));
                endDrag();
              }}
              onClick={() => openNoteInPanel(n.id)}
              onContextMenu={(e) => cardMenu(e, n)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  openNoteInPanel(n.id);
                }
              }}
              title={tr('Klik: otwórz notatkę · przeciągnij na komórkę, aby wkleić')}
            >
              <div className="s-head">
                <span className="s-name">{marked(noteTitle(n), query.terms)}</span>
                {n.projectId && <span className="tag">{tr('Projekt')}</span>}
                {n.updatedAt > 0 && <span className="nc-time">{shortAgo(language, n.updatedAt)}</span>}
                <button className={`nc-pin ${n.pinned ? 'on' : ''}`} title={n.pinned ? tr('Odepnij') : tr('Przypnij na górze')} aria-label={n.pinned ? tr('Odepnij') : tr('Przypnij na górze')}
                  onClick={(e) => { e.stopPropagation(); togglePin(n); }} onKeyDown={(e) => e.stopPropagation()}><IPin on={!!n.pinned} size={12} /></button>
              </div>
              {progress.total > 0 && (
                <div className={`nc-progress ${progress.done === progress.total ? 'all' : ''}`} aria-label={tr('Zadania: {done} z {total}', progress)}>
                  <span className="nc-bar"><i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></span>
                  <span className="nc-count"><IChecklist size={11} /> {progress.done}/{progress.total}</span>
                </div>
              )}
              {(excerpt || !progress.total) && <div className={`s-text n-text ${excerpt ? '' : 'empty'}`}>{excerpt ? marked(excerpt, query.terms) : tr('Pusta notatka')}</div>}
              {own.length > 0 && (
                <div className="nc-tags">
                  {own.map((tag) => <span key={tag} className={`note-tag small ${query.tags.includes(tag) ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); toggleTag(tag); }}>#{tag}</span>)}
                </div>
              )}
            </div>
            </Fragment>
          );
        })}
        {visible.length > 0 && <div className={`snippet-drop-space ${over?.id === null ? 'drop-end' : ''}`} aria-hidden="true" />}
        {!visible.length && (
          <div className="muted snippet-empty">
            {emptyQuery(query) ? tr('Brak notatek.') : tr('Nic nie pasuje do „{query}”.', { query: q.trim() })}
            {!emptyQuery(query) && <> <button className="link-btn" onClick={() => setQ('')}>{tr('Wyczyść')}</button></>}
          </div>
        )}
      </div>
      </>
      )}
      {fileDrop && <div className="notes-drop-hint" aria-hidden="true"><IImport /><span>{tr('Upuść pliki .md lub .txt, aby dodać je jako notatki')}</span></div>}
    </aside>
  );
}
