import { shortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { fuzzyScore } from '../../../shared/fuzzy';
import { formatAgo } from '../../../shared/i18n';
import type { Note } from '../../../shared/types';
import { NOTE_LIMITS, notePreview } from '../../../shared/notes';
import { sendSnippet } from '../actions';
import { editNote, moveNote, PROJECT_COLORS, removeNote, uid, upsertNote, type DropEdge } from '../../../shared/state';
import { PANEL_LIMITS } from '../../../shared/panels';
import { askChoice, update, useStore } from '../store';
import { SNIPPET_MIME } from './CellView';
import { IArrowLeft, IMore, IPlus } from './icons';
import { dropEdge, scrollDragList } from './listDrag';
import { openMenu, type MenuItem } from './ContextMenu';
import { EmptyLink, fillTokens, PanelEmpty } from './PanelEmpty';
import type { PanelResizeProps } from './PanelResizeHandle';

const NOTE_MIME = 'application/x-mc-note';
/** Typing is written to the state after this pause, and at once when the editor loses focus or closes. */
const SAVE_DELAY_MS = 500;

/** Pastes a note like a snippet (without Enter), into the focused cell. */
const pasteNote = (note: Note) => sendSnippet({ id: note.id, name: note.name, text: note.text, autoSend: false }, 'focused');

export function NotesPanel({ resize }: { resize: PanelResizeProps }) {
  const { tr } = useI18n();
  const notes = useStore((st) => st.s.notes);
  const projectId = useStore((st) => st.s.activeProjectId);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusName, setFocusName] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string | null; edge: DropEdge } | null>(null);
  // Like the snippets: global notes and the active project's own, in the user's order.
  const available = notes.filter((n) => !n.projectId || n.projectId === projectId);
  const visible = available.filter((n) => fuzzyScore(q, `${n.name} ${n.text.slice(0, 5000)}`) !== null).slice(0, 500);
  // A note of another project (after a project switch) or a deleted one closes the editor.
  const opened = openId ? available.find((n) => n.id === openId) : undefined;
  const endDrag = () => { setDragId(null); setOver(null); };
  const title = (n: Note) => n.name.trim() || tr("Notatka bez nazwy");

  const open = (id: string, rename = false) => { setFocusName(rename); setOpenId(id); };
  const create = (projectId?: string) => {
    const note: Note = { id: uid(), name: tr("Nowa notatka"), text: '', updatedAt: Date.now(), ...(projectId ? { projectId } : {}) };
    update((st) => upsertNote(st, note));
    open(note.id, true);
  };
  const hide = () => update((st) => ({ ...st, notesOpen: false }));
  const backgroundMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, .snippet')) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { header: tr("Notatki") },
      { label: tr("Nowa notatka"), onClick: () => create() },
      ...(projectId ? [{ label: tr("Nowa notatka tylko w tym projekcie"), onClick: () => create(projectId) }] : []),
      { sep: true },
      { label: tr("Przywróć szerokość panelu"), onClick: () => resize.onFinish(PANEL_LIMITS.snippets.default) },
      { label: tr("Ukryj panel notatek"), hint: shortcutText('notes.toggle') || undefined, onClick: hide },
    ]);
  };
  const noteMenu = (e: React.MouseEvent, n: Note) => {
    e.preventDefault();
    e.stopPropagation();
    const index = visible.findIndex((item) => item.id === n.id);
    const items: MenuItem[] = [
      { header: title(n) },
      { label: tr("Otwórz"), onClick: () => open(n.id) },
      { label: tr("Zmień nazwę"), onClick: () => open(n.id, true) },
      { label: tr("Duplikuj"), onClick: () => update((st) => {
        const copy: Note = { ...n, id: uid(), name: tr('{name} (kopia)', { name: title(n) }).slice(0, NOTE_LIMITS.name), updatedAt: Date.now() };
        // The copy goes right below its note.
        return moveNote(upsertNote(st, copy), copy.id, n.id, 'after');
      }) },
      { label: tr("Kopiuj treść"), disabled: !n.text, onClick: () => window.mc.clipboardWrite(n.text) },
      { label: tr("Wklej do aktywnej komórki"), disabled: !n.text, onClick: () => pasteNote(n) },
      ...(index > 0 ? [{ label: tr("Przesuń wyżej"), onClick: () => update((st) => moveNote(st, n.id, visible[index - 1].id, 'before')) }] : []),
      ...(index < visible.length - 1 ? [{ label: tr("Przesuń niżej"), onClick: () => update((st) => moveNote(st, n.id, visible[index + 1].id, 'after')) }] : []),
      ...(projectId || n.projectId ? [n.projectId
        ? { label: tr("We wszystkich projektach"), onClick: () => update((st) => upsertNote(st, { ...withoutProject(n) })) }
        : { label: tr("Tylko w tym projekcie"), onClick: () => update((st) => upsertNote(st, { ...n, projectId: projectId! })) }] : []),
      { sep: true },
      { header: tr("Kolor") },
      { colors: PROJECT_COLORS, onPick: (color) => update((st) => upsertNote(st, { ...(st.notes.find((x) => x.id === n.id) ?? n), color })) },
      ...(n.color ? [{ label: tr("Bez koloru"), onClick: () => update((st) => upsertNote(st, withoutColor(st.notes.find((x) => x.id === n.id) ?? n))) }] : []),
      { sep: true },
      { label: tr("Usuń notatkę"), danger: true, onClick: () => void confirmDelete(n) },
    ];
    openMenu(e.clientX, e.clientY, items);
  };
  const confirmDelete = async (n: Note) => {
    const choice = await askChoice(tr('Usunąć notatkę „{name}”?', { name: title(n) }), tr("Notatka i cały jej tekst zostaną usunięte."), [{ label: tr("Usuń"), value: 'yes', danger: true }]);
    if (choice === 'yes') update((st) => removeNote(st, n.id));
  };

  return (
    <aside className="rpanel notes-panel" aria-label={tr("Panel notatek")} onContextMenu={backgroundMenu}>
      <div className="side-title">
        <span className="row" style={{ gap: 6 }}>
          {tr("Notatki")}
          <span className="help">
            ?
            <span className="help-pop">
              <span className="kbd">{tr("Klik")}</span><span>{tr("otwórz notatkę")}</span>
              <span className="kbd">{tr("Przeciągnij")}</span><span>{tr("zmień kolejność albo wklej do komórki")}</span>
            </span>
          </span>
        </span>
        <button className="sq" title={tr("Nowa notatka")} aria-label={tr("Nowa notatka")} onClick={() => create()}><IPlus /></button>
      </div>
      {opened ? (
        <NoteEditor key={opened.id} note={opened} focusName={focusName} onBack={() => setOpenId(null)} onMenu={(e) => noteMenu(e, opened)} />
      ) : !available.length ? (
        <PanelEmpty>
          <p>{notes.length ? tr("Brak notatek dostępnych w tym projekcie.") : tr("Zapisuj notatki, pomysły i fragmenty tekstu jako małe pliki, zawsze pod ręką.")}</p>
          <button className="btn primary" onClick={() => create()}>{tr("Nowa notatka")}</button>
          {projectId && <p>{fillTokens(tr("Możesz też {link}."), {
            link: <EmptyLink onClick={() => create(projectId)}>{tr("dodać notatkę tylko dla tego projektu")}</EmptyLink>,
          })}</p>}
        </PanelEmpty>
      ) : (
      <>
      <input className="search" aria-label={tr("Szukaj notatek")} placeholder={tr("Szukaj notatek") + '…'} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="snippets notes"
        onDragOver={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(NOTE_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          scrollDragList(e.currentTarget, e.clientY);
          if (!(e.target as HTMLElement).closest('.snippet')) setOver({ id: null, edge: 'after' });
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
        onDrop={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(NOTE_MIME)) return;
          e.preventDefault();
          update((st) => moveNote(st, dragId, visible.at(-1)?.id ?? null, 'after'));
          endDrag();
        }}
      >
        {visible.map((n) => {
          const preview = notePreview(n.text);
          return (
            <div
              key={n.id}
              className={`snippet note ${dragId === n.id ? 'dragging' : ''} ${over?.id === n.id && dragId !== n.id ? `drop-${over.edge}` : ''}`}
              data-note-id={n.id}
              style={n.color ? ({ '--sc': n.color } as React.CSSProperties) : undefined}
              data-colored={n.color ? '' : undefined}
              role="button"
              tabIndex={0}
              aria-label={title(n)}
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
                if (!dragId || !e.dataTransfer.types.includes(NOTE_MIME)) return;
                e.preventDefault();
                setOver({ id: n.id, edge: dropEdge(e.currentTarget, e.clientY) });
              }}
              onDrop={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(NOTE_MIME)) return;
                e.preventDefault();
                e.stopPropagation();
                update((st) => moveNote(st, dragId, n.id, dropEdge(e.currentTarget, e.clientY)));
                endDrag();
              }}
              onClick={() => open(n.id)}
              onContextMenu={(e) => noteMenu(e, n)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  open(n.id);
                }
              }}
              title={tr("Klik: otwórz notatkę · przeciągnij na komórkę, aby wkleić")}
            >
              <div className="s-head">
                <span className="s-name">{title(n)}</span>
                {n.projectId && <span className="tag">{tr("Projekt")}</span>}
              </div>
              <div className={`s-text n-text ${preview ? '' : 'empty'}`}>{preview || tr("Pusta notatka")}</div>
            </div>
          );
        })}
        {visible.length > 0 && <div className={`snippet-drop-space ${over?.id === null ? 'drop-end' : ''}`} aria-hidden="true" />}
        {!visible.length && <div className="muted snippet-empty">{tr('Nic nie pasuje do „{query}”.', { query: q })}</div>}
      </div>
      </>
      )}
    </aside>
  );
}

const withoutProject = (n: Note): Note => { const { projectId: _projectId, ...rest } = n; return rest; };
const withoutColor = (n: Note): Note => { const { color: _color, ...rest } = n; return rest; };

/**
 * One note opened in the panel: its name and a plain text area filling the panel. Changes are written after a short pause,
 * and at once on blur, on Back and when the editor goes away (another note, a closed panel, a project switch).
 */
function NoteEditor({ note, focusName, onBack, onMenu }: { note: Note; focusName: boolean; onBack: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const { tr, language } = useI18n();
  const [name, setName] = useState(note.name);
  const [text, setText] = useState(note.text);
  const draft = useRef({ name: note.name, text: note.text });
  const timer = useRef<number | undefined>(undefined);
  const nameInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const { name, text } = draft.current;
    // editNote returns the same state when nothing changed, so a blur without typing writes nothing.
    update((st) => editNote(st, note.id, { name, text }));
  };
  const change = (patch: Partial<{ name: string; text: string }>) => {
    draft.current = { ...draft.current, ...patch };
    if (patch.name !== undefined) setName(patch.name);
    if (patch.text !== undefined) setText(patch.text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };
  useEffect(() => {
    if (focusName) nameInput.current?.select();
    else textArea.current?.focus();
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); if (timer.current !== undefined) flush(); };
  }, []);
  const back = () => { flush(); onBack(); };
  const updatedAt = useStore((st) => st.s.notes.find((n) => n.id === note.id)?.updatedAt ?? 0);

  return (
    <div className="note-editor">
      <div className="note-editor-head">
        <button className="btn ghost icon" title={tr("Wróć do listy notatek")} aria-label={tr("Wróć do listy notatek")} onClick={back}><IArrowLeft /></button>
        <input ref={nameInput} className="note-name" aria-label={tr("Nazwa notatki")} placeholder={tr("Notatka bez nazwy")} value={name} maxLength={NOTE_LIMITS.name}
          onChange={(e) => change({ name: e.target.value })} onBlur={flush}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); textArea.current?.focus(); }
            if (e.key === 'Escape') { e.preventDefault(); back(); }
          }}
          onContextMenu={(e) => e.stopPropagation()} />
        {note.projectId && <span className="tag">{tr("Projekt")}</span>}
        <button className="btn ghost icon" title={tr("Więcej akcji")} aria-label={tr("Więcej akcji")} onClick={onMenu}><IMore /></button>
      </div>
      <textarea ref={textArea} className="note-text" aria-label={tr("Treść notatki")} placeholder={tr("Pisz tutaj…")} value={text} spellCheck={false}
        maxLength={NOTE_LIMITS.text} onChange={(e) => change({ text: e.target.value })} onBlur={flush}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); back(); } }}
        onContextMenu={(e) => e.stopPropagation()} />
      <div className="note-editor-foot muted">
        {updatedAt > 0 && <span>{tr('Zmieniono {ago}', { ago: formatAgo(language, updatedAt) })}</span>}
      </div>
    </div>
  );
}
