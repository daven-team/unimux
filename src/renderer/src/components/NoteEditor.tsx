// One note open for reading and writing (1.0.7): in the Notes panel (narrow, with a way back to the list) or as a tab of the
// strip (wide, with the editor and the preview side by side). Markdown notes open as their preview; a double click or
// "Edit" writes. Changes are written after a short pause, at once on blur, on Back and when the editor goes away.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { formatAgo } from '../../../shared/i18n';
import type { Note } from '../../../shared/types';
import { NOTE_LIMITS, notePreviewMarkdown } from '../../../shared/notes';
import { noteTags, noteTasks, noteWordCount, toggleTask, toggleTaskLine } from '../../../shared/noteTools';
import { CODE_LANGUAGES, codeLanguageLabel, normalizeCodeLanguage, type CodeLanguage } from '../../../shared/codeLanguages';
import { editNote, upsertNote } from '../../../shared/state';
import { update, useStore } from '../store';
import { filterNotesByTag, saveNoteImage, openNoteInPanel, openNoteTab } from '../notesUi';
import { noteMenuItems, togglePin } from '../noteMenu';
import { openMenu } from './ContextMenu';
import { IArrowLeft, IMore } from './icons';
import { IChecklist, IOpenTab, IPanelRight, IPin } from './notesIcons';
import { LazyTextCodeEditor } from './LazyTextCodeEditor';
import type { TextCodeEditorApi } from './TextCodeEditor';
import { Select } from './Select';
import './notes.css';

// The preview (marked, DOMPurify) loads on first use, like the file editor's.
const MarkdownPreview = lazy(() => import('./MarkdownPreview').then((m) => ({ default: m.MarkdownPreview })));
/** Typing is written to the state after this pause, and at once when the editor loses focus or closes. */
const SAVE_DELAY_MS = 500;

export type NoteMode = 'edit' | 'preview' | 'split';
/** The mode each note was last shown in, per place (panel or tab), kept while the app runs. */
const modes = new Map<string, NoteMode>();

export function NoteEditor({ note, variant, rename = false, fresh = false, cursor = null, focusSeq = 0, onBack }: {
  note: Note;
  variant: 'panel' | 'tab';
  /** Just created: the name is selected (rename) or the editor takes the keyboard. */
  rename?: boolean;
  fresh?: boolean;
  /** Where the cursor starts in a note made from a template. */
  cursor?: number | null;
  /** Changes when the same note is asked for again (the editor takes the focus again). */
  focusSeq?: number;
  onBack?: () => void;
}) {
  const { tr, language: uiLanguage } = useI18n();
  const stored = useStore((st) => st.s.notes.find((n) => n.id === note.id)) ?? note;
  const language: CodeLanguage = normalizeCodeLanguage(stored.language) ?? 'markdown';
  const markdown = language === 'markdown';
  const [name, setName] = useState(stored.name);
  const [text, setText] = useState(stored.text);
  const modeKey = `${variant}:${note.id}`;
  const [mode, setModeState] = useState<NoteMode>(() => {
    const kept = modes.get(modeKey);
    if (kept && (kept !== 'split' || variant === 'tab')) return kept;
    if (fresh || rename || !stored.text.trim()) return 'edit';
    return variant === 'tab' && markdown ? 'split' : 'preview';
  });
  const draft = useRef({ name: stored.name, text: stored.text });
  const timer = useRef<number | undefined>(undefined);
  const nameInput = useRef<HTMLInputElement>(null);
  const editor = useRef<TextCodeEditorApi | null>(null);
  // A new note: the cursor starts where the template wants it, or at the end.
  const focusAt = useRef<number | null>(fresh && !rename ? cursor ?? -1 : null);

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
  // The same note may be open in the panel and in a tab, or changed from outside (a task ticked, MCP): with nothing waiting
  // to be written, this editor takes the stored text.
  useEffect(() => {
    if (timer.current !== undefined) return;
    if (stored.text !== draft.current.text) { draft.current = { ...draft.current, text: stored.text }; setText(stored.text); }
    if (stored.name !== draft.current.name && document.activeElement !== nameInput.current) { draft.current = { ...draft.current, name: stored.name }; setName(stored.name); }
  }, [stored.text, stored.name]);
  const setMode = (next: NoteMode, focus = false) => {
    flush();
    modes.set(modeKey, next);
    setModeState(next);
    if (focus && next !== 'preview') requestAnimationFrame(() => editor.current?.focus());
  };
  const setLanguage = (next: CodeLanguage) => {
    flush();
    update((st) => {
      const current = st.notes.find((n) => n.id === note.id);
      if (!current || (current.language ?? 'markdown') === next) return st;
      // Markdown is the default and is not stored: notes of the textarea era and Markdown notes look the same on disk.
      if (next === 'markdown') { const { language: _language, ...rest } = current; return upsertNote(st, rest); }
      return upsertNote(st, { ...current, language: next });
    });
  };
  const toggleTaskAt = (index: number, checked: boolean) => {
    const next = toggleTask(draft.current.text, index, checked);
    if (next === draft.current.text) return;
    change({ text: next });
    flush();
  };
  useEffect(() => {
    if (rename) nameInput.current?.select();
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); if (timer.current !== undefined) flush(); };
  }, []);
  useEffect(() => { if (focusSeq && !rename && mode !== 'preview') editor.current?.focus(); }, [focusSeq]);
  const back = () => { flush(); onBack?.(); };
  const escapeBack = (e: React.KeyboardEvent) => { if (onBack && e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); back(); } };
  const languageName = (id: CodeLanguage) => id === 'text' ? tr('Zwykły tekst') : codeLanguageLabel(id);
  const tasks = useMemo(() => noteTasks(text), [text]);
  // Empty tasks (a template's `- [ ] `) are not counted, like on the card.
  const counted = tasks.filter((t) => t.text);
  const done = counted.filter((t) => t.checked).length;
  const tags = useMemo(() => noteTags(text), [text]);
  // Markdown syntax (task boxes, link targets, fences) is no words: ticking a task keeps the count (noteWordCount).
  const count = useMemo(() => noteWordCount(text, markdown), [text, markdown]);
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    flush();
    openMenu(e.clientX, e.clientY, noteMenuItems(stored, { place: variant, onRename: () => nameInput.current?.select() }));
  };
  const title = name.trim() || tr('Notatka bez nazwy');

  const editorView = (
    <LazyTextCodeEditor key="editor" value={text} language={language} onChange={(value) => change({ text: value })} onBlur={flush}
      ariaLabel={tr('Treść notatki')} placeholder={markdown ? tr('Pisz tutaj… Markdown, #tagi, - [ ] zadania') : tr('Pisz tutaj…')}
      autoFocus={!rename && mode !== 'preview' && (fresh || variant === 'tab' || focusSeq > 0)} maxLength={NOTE_LIMITS.text} tabIndents
      onKeyDown={escapeBack}
      onToggleLine={markdown ? toggleTaskLine : undefined}
      onPasteImage={markdown ? saveNoteImage : undefined}
      onApi={(api) => {
        editor.current = api;
        if (api && focusAt.current !== null) { const at = focusAt.current; focusAt.current = null; api.focus(at); }
      }} />
  );
  const previewView = (
    <div key="preview" className="note-preview" onKeyDown={escapeBack} onContextMenu={(e) => e.stopPropagation()}>
      {text.trim() ? (
        <Suspense fallback={null}>
          <MarkdownPreview text={notePreviewMarkdown(text, language)} projectId="" path={title} codeTools={{ copyLabel: tr('Kopiuj kod') }}
            note={markdown ? { tasks: tasks.length, noteImages: true, tags: true } : undefined} onToggleTask={toggleTaskAt} onTag={(tag) => { flush(); filterNotesByTag(tag); }}
            onDoubleClick={(e) => { if (!(e.target as Element).closest('a, input, button') && mode === 'preview') setMode('edit', true); }} />
        </Suspense>
      ) : (
        <button className="note-preview-empty" onClick={() => setMode('edit', true)}>{tr('Pusta notatka. Kliknij, aby pisać.')}</button>
      )}
    </div>
  );

  return (
    <div className={`note-editor note-editor-${variant} mode-${mode}`} style={stored.color ? ({ '--sc': stored.color } as React.CSSProperties) : undefined} data-colored={stored.color ? '' : undefined}>
      <div className="note-editor-head">
        {onBack && <button className="btn ghost icon" title={tr('Wróć do listy notatek')} aria-label={tr('Wróć do listy notatek')} onClick={back}><IArrowLeft /></button>}
        <input ref={nameInput} className="note-name" aria-label={tr('Nazwa notatki')} placeholder={tr('Notatka bez nazwy')} value={name} maxLength={NOTE_LIMITS.name}
          onChange={(e) => change({ name: e.target.value })} onBlur={flush}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (mode === 'preview') setMode('edit', true); else editor.current?.focus(); }
            if (e.key === 'Escape' && onBack) { e.preventDefault(); back(); }
          }}
          onContextMenu={(e) => e.stopPropagation()} />
        <button className={`btn ghost icon note-pin ${stored.pinned ? 'on' : ''}`} aria-pressed={!!stored.pinned}
          title={stored.pinned ? tr('Odepnij') : tr('Przypnij na górze')} aria-label={stored.pinned ? tr('Odepnij') : tr('Przypnij na górze')}
          onClick={() => togglePin(stored)}><IPin on={!!stored.pinned} /></button>
        {variant === 'panel'
          ? <button className="btn ghost icon" title={tr('Otwórz w karcie')} aria-label={tr('Otwórz w karcie')} onClick={() => { flush(); openNoteTab(stored); }}><IOpenTab /></button>
          : <button className="btn ghost icon" title={tr('Pokaż w panelu notatek')} aria-label={tr('Pokaż w panelu notatek')} onClick={() => { flush(); openNoteInPanel(note.id); }}><IPanelRight /></button>}
        <button className="btn ghost icon" title={tr('Więcej akcji')} aria-label={tr('Więcej akcji')} onClick={menu}><IMore /></button>
      </div>
      <div className="note-editor-tools">
        <Select className="select note-language" value={language} aria-label={tr('Język notatki')} title={tr('Język notatki')} onChange={(e) => setLanguage(e.target.value as CodeLanguage)}>
          {CODE_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{languageName(l.id)}</option>)}
        </Select>
        {stored.projectId && <span className="tag">{tr('Projekt')}</span>}
        {variant === 'tab' && tags.length > 0 && <span className="note-head-tags">{tags.slice(0, 6).map((tag) => <span key={tag} className="note-tag">#{tag}</span>)}</span>}
        <span style={{ flex: 1 }} />
        <div className="note-modes" role="group" aria-label={tr('Widok notatki')}>
          <button className={mode === 'edit' ? 'on' : ''} aria-pressed={mode === 'edit'} onClick={() => setMode('edit', true)}>{tr('Edytuj')}</button>
          <button className={mode === 'preview' ? 'on' : ''} aria-pressed={mode === 'preview'} title={tr('Pokaż notatkę sformatowaną jak Markdown')} onClick={() => setMode('preview')}>{tr('Podgląd')}</button>
          {variant === 'tab' && <button className={mode === 'split' ? 'on' : ''} aria-pressed={mode === 'split'} title={tr('Edycja i podgląd obok siebie')} onClick={() => setMode('split', true)}>{tr('Obok')}</button>}
        </div>
      </div>
      <div className="note-body">
        {mode === 'edit' ? editorView : mode === 'preview' ? previewView : <>{editorView}{previewView}</>}
      </div>
      <div className="note-editor-foot muted">
        {stored.updatedAt > 0 && <span>{tr('Zmieniono {ago}', { ago: formatAgo(uiLanguage, stored.updatedAt) })}</span>}
        <span>{tr('Słowa: {count}', { count })}</span>
        {counted.length > 0 && <span className={`note-foot-tasks ${done === counted.length ? 'all' : ''}`}><IChecklist size={11} /> {done}/{counted.length}</span>}
        <span style={{ flex: 1 }} />
        {markdown && mode !== 'preview' && <span className="note-hint" title={tr('Ctrl+Enter zamienia wiersz w zadanie albo je odhacza. Obraz ze schowka wkleja się do notatki.')}>{tr('{key}: zadanie', { key: window.mc.platform === 'darwin' ? 'Cmd+Enter' : 'Ctrl+Enter' })}</span>}
      </div>
    </div>
  );
}
