// Notes (1.0.7), the renderer's side outside the panel: which note the panel shows, new notes (blank, from a template, from
// a selection, from files), a note as a tab, export and pasted images. The panel and the note tab both use these.
import { create } from 'zustand';
import type { Cell, Note } from '../../shared/types';
import { NOTE_LIMITS } from '../../shared/notes';
import { findCell, getProfile, moveNote, uid, upsertNote } from '../../shared/state';
import { cellLabel } from '../../shared/agentWork';
import { shownProfileName } from '../../shared/profiles';
import { sshHeaderName } from '../../shared/ssh';
import {
  captureSourceLine, exportFileName, IMPORT_MAX_BYTES, isImportableNoteFile, isoDate, noteFromFile, noteFromTemplate, noteImageMarkdown,
  NOTE_IMAGE_MAX_BYTES, NOTE_IMAGE_TYPES, plainLine, type NoteTemplateId,
} from '../../shared/noteTools';
import { chosenLanguage, tr } from './i18n';
import { getS, getUi, toast, update, useStore } from './store';
import { openNoteDocument, syncNoteDocuments } from './files';
import { terminals } from './terminals/TerminalManager';
import { focusedTerminalCell } from './terminals/terminalFind';

/**
 * The note open in the panel (null: the list) and how it opened: `fresh` = just created (the editor, not the preview, with
 * the name selected when `rename`); `seq` changes with every request so the same note asked again takes the focus again.
 */
export const useNotesUi = create<{ openId: string | null; rename: boolean; fresh: boolean; cursor: number | null; seq: number; query: string }>(() => ({ openId: null, rename: false, fresh: false, cursor: null, seq: 0, query: '' }));
export const setNotesQuery = (query: string): void => useNotesUi.setState({ query });

/** A #tag clicked in a note's preview: the panel shows the list of the notes with that tag. */
export function filterNotesByTag(tag: string): void {
  if (!tag) return;
  if (!getS().notesOpen) update((s) => ({ ...s, notesOpen: true }));
  useNotesUi.setState({ openId: null, rename: false, fresh: false, cursor: null, query: `#${tag} ` });
}

/** Shows a note in the panel (the panel opens when closed). */
export function openNoteInPanel(id: string, opts: { rename?: boolean; fresh?: boolean; cursor?: number } = {}): void {
  if (!getS().notesOpen) update((s) => ({ ...s, notesOpen: true }));
  useNotesUi.setState((st) => ({ openId: id, rename: !!opts.rename, fresh: !!opts.fresh, cursor: opts.cursor ?? null, seq: st.seq + 1 }));
}
export const closeNoteInPanel = (): void => useNotesUi.setState({ openId: null, rename: false, fresh: false, cursor: null });

/** Adds a note at the top of the list (or right below `after`) and returns it. */
export function addNote(fields: Partial<Note> & { name: string }, after?: string): Note {
  const note: Note = { id: uid(), text: '', updatedAt: Date.now(), ...fields, name: fields.name.slice(0, NOTE_LIMITS.name), ...(fields.text ? { text: fields.text.slice(0, NOTE_LIMITS.text) } : {}) };
  update((st) => {
    const added = upsertNote(st, note);
    // New notes come first: the list shows the newest work at the top in the user's own order too.
    const target = after ?? st.notes[0]?.id ?? null;
    return target ? moveNote(added, note.id, target, after ? 'after' : 'before') : added;
  });
  return note;
}

const templateWords = () => ({
  daily: tr('Notatka dzienna'), goals: tr('Cele na dziś'), notes: tr('Notatki'),
  meeting: tr('Spotkanie'), date: tr('Data'), attendees: tr('Uczestnicy'), agenda: tr('Agenda'), actions: tr('Do zrobienia'),
  checklist: tr('Lista zadań'),
});

/** A new note, blank or from a template, opened in the panel for writing. A second daily note of the same day opens the first. */
export function createNote(template: NoteTemplateId | null = null, projectId?: string): void {
  const scope = projectId ? { projectId } : {};
  if (!template) {
    const note = addNote({ name: tr('Nowa notatka'), ...scope });
    openNoteInPanel(note.id, { rename: true, fresh: true });
    return;
  }
  const { name, text, cursor } = noteFromTemplate(template, templateWords(), new Date(), chosenLanguage());
  if (template === 'daily') {
    const today = getS().notes.find((n) => n.name === name && (n.projectId ?? '') === (projectId ?? ''));
    if (today) { openNoteInPanel(today.id); return; }
  }
  const note = addNote({ name, text, ...scope });
  openNoteInPanel(note.id, { fresh: true, cursor });
}

/** A fence around captured terminal output, longer than any run of backticks in it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}\n`;
}

/** A cell's label as its header shows it: an SSH cell its name or host, others their name, conversation title or profile. */
function shownCellLabel(cell: Cell): string {
  const s = getS();
  if (cell.ssh) return sshHeaderName(cell.name) || s.sshHosts.find((h) => h.id === cell.ssh!.hostId)?.label || tr('Terminal');
  return cellLabel(cell, getUi().sessionTitles, shownProfileName(getProfile(s, cell.profileId), s.settings.shell, tr));
}

/**
 * Quick capture (Mod+Shift+L, the palette, the panel's menu): the selected text of the terminal in focus, of an editor or of
 * the page becomes a new note. Terminal output goes into a code block (its spacing kept); the first line names the note.
 */
export function captureSelectionToNote(): void {
  const cellId = focusedTerminalCell() ?? getUi().focusedCellId;
  const fromTerminal = cellId ? terminals.xterm(cellId)?.getSelection() ?? '' : '';
  const text = (fromTerminal.trim() ? fromTerminal : window.getSelection()?.toString() ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!text.trim()) { toast(tr('Zaznacz tekst w terminalu albo w edytorze, aby zrobić z niego notatkę.')); return; }
  const first = plainLine(text.split('\n').find((line) => line.trim()) ?? '').replace(/\s+/g, ' ');
  const name = first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first || tr('Zaznaczenie {date}', { date: isoDate(new Date()) });
  // Where it came from: the cell as its header names it, its grid and the time, in a quiet line above the captured text.
  const found = fromTerminal.trim() && cellId ? findCell(getS(), cellId) : null;
  const source = `${captureSourceLine(found ? { cell: shownCellLabel(found.cell), grid: found.tab.name } : null, new Date())}\n\n`;
  const body = source + (fromTerminal.trim() ? fenced(text) : `${text}\n`);
  const note = addNote({ name, text: body });
  openNoteInPanel(note.id, { fresh: false });
  toast(tr('Utworzono notatkę „{name}”.', { name }));
}

/** Files dropped on the panel or picked to import: Markdown and text files become notes (others and big ones are skipped). */
export async function importNoteFiles(files: readonly File[]): Promise<void> {
  const usable = files.filter((f) => isImportableNoteFile(f.name) && f.size <= IMPORT_MAX_BYTES);
  const skipped = files.length - usable.length;
  let added = 0;
  let last: Note | null = null;
  for (const file of usable.slice(0, 50)) {
    try {
      const { name, text, language } = noteFromFile(file.name, await file.text());
      last = addNote({ name: name || tr('Notatka bez nazwy'), text, ...(language ? { language } : {}) }, last?.id);
      added++;
    } catch { /* unreadable: counted as skipped below */ }
  }
  if (added === 1 && last) openNoteInPanel(last.id);
  const missed = skipped + usable.length - added;
  if (added) toast(missed ? tr('Zaimportowano notatki: {count}. Pominięto pliki: {skipped}.', { count: added, skipped: missed }) : tr('Zaimportowano notatki: {count}.', { count: added }));
  else toast(tr('Nie znaleziono plików .md ani .txt do zaimportowania.'), 'error');
}

/** The picker of "Import files…": a file input outside the page (no main process needed to read the chosen files). */
export function pickNoteFiles(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.md,.markdown,.txt,.text';
  input.onchange = () => { void importNoteFiles(Array.from(input.files ?? [])); };
  input.click();
}

/** Saves the note as a file where the user picks (Markdown as .md, a note in another language with its own extension). */
export async function exportNote(note: Note): Promise<void> {
  const r = await window.mc.notes.exportFile(exportFileName(note.name.trim() || tr('Notatka bez nazwy'), note.language), note.text);
  if (r.ok) toast(tr('Zapisano notatkę w {path}', { path: r.path ?? '' }));
  else if (!r.cancelled) toast(tr('Nie udało się zapisać notatki do pliku.'), 'error');
}

/** A pasted image is saved in the data folder; its Markdown link goes into the note (null when refused). */
export async function saveNoteImage(file: File): Promise<string | null> {
  if (!NOTE_IMAGE_TYPES[file.type]) { toast(tr('Ten format obrazu nie jest obsługiwany (PNG, JPEG, GIF, WebP).'), 'error'); return null; }
  if (file.size > NOTE_IMAGE_MAX_BYTES) { toast(tr('Obraz jest za duży (najwyżej 8 MB).'), 'error'); return null; }
  const name = await window.mc.notes.saveImage(new Uint8Array(await file.arrayBuffer()), file.type).catch(() => null);
  if (!name) { toast(tr('Nie udało się zapisać obrazu.'), 'error'); return null; }
  return noteImageMarkdown(name, tr('obraz'));
}

/** The note in a tab of the strip (the panel goes back to its list, the note is not shown twice). */
export function openNoteTab(note: Note): void {
  if (useNotesUi.getState().openId === note.id) closeNoteInPanel();
  openNoteDocument(note.id, note.name.trim() || tr('Notatka bez nazwy'), note.projectId ?? '');
}

// Note tabs follow their notes (renamed, moved to a project, deleted), whoever changed them (this window, MCP, a sync).
useStore.subscribe((st, prev) => {
  if (st.s.notes !== prev.s.notes) syncNoteDocuments(st.s.notes, tr('Notatka bez nazwy'));
});
