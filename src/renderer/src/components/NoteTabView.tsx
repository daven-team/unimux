// A note of the Notes panel as a tab of the strip (1.0.7): the note's editor with room for the editor and the preview side
// by side. The tab holds no text of its own (the note does), so it never has unsaved changes.
import { useFileStore } from '../files';
import { useShownFileId } from '../splitView';
import { useStore } from '../store';
import { NoteEditor } from './NoteEditor';

export function NoteTabView() {
  const shownId = useShownFileId();
  const noteId = useFileStore((s) => s.documents.find((d) => d.id === shownId)?.note?.noteId);
  const note = useStore((st) => (noteId ? st.s.notes.find((n) => n.id === noteId) : undefined));
  // A deleted note closes its tab (notesUi.ts); until then nothing is shown.
  if (!note) return <div className="note-tab" />;
  return <div className="note-tab"><NoteEditor key={note.id} note={note} variant="tab" /></div>;
}
