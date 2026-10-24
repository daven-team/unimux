// The menu of a note (1.0.7): the same actions on its card, in its editor in the panel and in its tab.
import type { Note } from '../../shared/types';
import { NOTE_LIMITS } from '../../shared/notes';
import { moveNote, PROJECT_COLORS, removeNote, uid, upsertNote } from '../../shared/state';
import { sendSnippet } from './actions';
import { tr } from './i18n';
import { askChoice, getS, update } from './store';
import type { MenuItem } from './components/ContextMenu';
import { createElement } from 'react';
import { IDownload, IEdit, IFolder, IPrompt } from './components/icons';
import { ICopy, IMoveDown, IMoveUp, IPaste, ITrash } from './components/menuIcons';
import { IOpenTab, IPanelRight, IPin, INoteBlank } from './components/notesIcons';
import { exportNote, openNoteInPanel, openNoteTab } from './notesUi';

export const noteTitle = (n: Pick<Note, 'name'>): string => n.name.trim() || tr('Notatka bez nazwy');
const current = (n: Note): Note => getS().notes.find((x) => x.id === n.id) ?? n;
const withoutProject = (n: Note): Note => { const { projectId: _projectId, ...rest } = n; return rest; };
const withoutColor = (n: Note): Note => { const { color: _color, ...rest } = n; return rest; };
const withoutPin = (n: Note): Note => { const { pinned: _pinned, ...rest } = n; return rest; };

/** Pins a note to the top of the list, or unpins it. */
export function togglePin(n: Note): void {
  update((st) => { const note = st.notes.find((x) => x.id === n.id); return note ? upsertNote(st, note.pinned ? withoutPin(note) : { ...note, pinned: true }) : st; });
}

/** Pastes a note like a snippet (without Enter), into the focused cell. */
export const pasteNote = (note: Note): void => sendSnippet({ id: note.id, name: note.name, text: note.text, autoSend: false }, 'focused');

export async function confirmDeleteNote(n: Note): Promise<void> {
  const choice = await askChoice(tr('Usunąć notatkę „{name}”?', { name: noteTitle(n) }), tr('Notatka i cały jej tekst zostaną usunięte.'), [{ label: tr('Usuń'), value: 'yes', danger: true }]);
  if (choice === 'yes') update((st) => removeNote(st, n.id));
}

export interface NoteMenuContext {
  /** Where the menu opens: a card of the list, the editor in the panel, or the note's tab. */
  place: 'card' | 'panel' | 'tab';
  onOpen?: () => void;
  onRename?: () => void;
  /** Move up / down in the list (cards in the user's own order). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

export function noteMenuItems(n: Note, ctx: NoteMenuContext): MenuItem[] {
  const projectId = getS().activeProjectId;
  return [
    { header: noteTitle(n) },
    ...(ctx.onOpen ? [{ label: tr('Otwórz'), icon: createElement(INoteBlank), onClick: ctx.onOpen }] : []),
    ...(ctx.place === 'tab'
      ? [{ label: tr('Pokaż w panelu notatek'), icon: createElement(IPanelRight), onClick: () => openNoteInPanel(n.id) }]
      : [{ label: tr('Otwórz w karcie'), icon: createElement(IOpenTab), onClick: () => openNoteTab(current(n)) }]),
    ...(ctx.onRename ? [{ label: tr('Zmień nazwę'), icon: createElement(IEdit), onClick: ctx.onRename }] : []),
    { label: n.pinned ? tr('Odepnij') : tr('Przypnij na górze'), icon: createElement(IPin, { size: 14, on: !!n.pinned }), onClick: () => togglePin(n) },
    { label: tr('Duplikuj'), icon: createElement(ICopy), onClick: () => update((st) => {
      const source = st.notes.find((x) => x.id === n.id) ?? n;
      const { pinned: _pinned, ...rest } = source;
      const copy: Note = { ...rest, id: uid(), name: tr('{name} (kopia)', { name: noteTitle(source) }).slice(0, NOTE_LIMITS.name), updatedAt: Date.now() };
      // The copy goes right below its note.
      return moveNote(upsertNote(st, copy), copy.id, n.id, 'after');
    }) },
    { sep: true },
    { label: tr('Kopiuj treść'), icon: createElement(IPaste), disabled: !n.text, onClick: () => window.mc.clipboardWrite(current(n).text) },
    { label: tr('Wklej do aktywnej komórki'), icon: createElement(IPrompt), disabled: !n.text, onClick: () => pasteNote(current(n)) },
    { label: tr('Eksportuj do pliku…'), icon: createElement(IDownload), onClick: () => void exportNote(current(n)) },
    ...(ctx.onMoveUp || ctx.onMoveDown ? [{ sep: true } as const] : []),
    ...(ctx.onMoveUp ? [{ label: tr('Przesuń wyżej'), icon: createElement(IMoveUp), onClick: ctx.onMoveUp }] : []),
    ...(ctx.onMoveDown ? [{ label: tr('Przesuń niżej'), icon: createElement(IMoveDown), onClick: ctx.onMoveDown }] : []),
    ...(projectId || n.projectId ? [n.projectId
      ? { label: tr('We wszystkich projektach'), icon: createElement(IFolder), onClick: () => update((st) => upsertNote(st, withoutProject(current(n)))) }
      : { label: tr('Tylko w tym projekcie'), icon: createElement(IFolder), onClick: () => update((st) => upsertNote(st, { ...current(n), projectId: projectId! })) }] : []),
    { sep: true },
    { header: tr('Kolor') },
    { colors: PROJECT_COLORS, onPick: (color) => update((st) => upsertNote(st, { ...(st.notes.find((x) => x.id === n.id) ?? n), color })) },
    ...(n.color ? [{ label: tr('Bez koloru'), onClick: () => update((st) => upsertNote(st, withoutColor(st.notes.find((x) => x.id === n.id) ?? n))) }] : []),
    { sep: true },
    { label: tr('Usuń notatkę'), icon: createElement(ITrash), danger: true, onClick: () => void confirmDeleteNote(n) },
  ];
}
