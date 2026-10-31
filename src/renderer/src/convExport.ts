// Export of a Claude Code or Codex conversation to Markdown (1.1.1): from a cell (its menu, the palette) or from a result of
// the conversation search. The search thread of main reads the transcript; this side renders the Markdown and saves it to a
// file (the notes' save dialog), to the clipboard or as a note.
import { capText, exportBaseName, renderConvMarkdown, type ConvExportData, type ConvExportSource, type MarkdownLabels } from '../../shared/convExport';
import { NOTE_LIMITS } from '../../shared/notes';
import { exportFileName } from '../../shared/noteTools';
import { findCell, getProfile } from '../../shared/state';
import { tr } from './i18n';
import { addNote, openNoteInPanel } from './notesUi';
import { getS, setUi, toast } from './store';

/** The conversation of a cell, or null for a shell, SSH cell or an agent that has no conversation yet. */
export function cellExportSource(cellId: string | null | undefined): ConvExportSource | null {
  if (!cellId) return null;
  const found = findCell(getS(), cellId);
  const cell = found?.cell;
  if (!cell || cell.ssh || !cell.session) return null;
  const cli = getProfile(getS(), cell.profileId).cli;
  if (cli === 'shell') return null;
  return { cli: cell.session.cli, id: cell.session.id };
}

/** Is the cell one whose conversation can be exported (a Claude or Codex cell, even before its first turn)? */
export function cellCanExport(cellId: string | null | undefined): boolean {
  if (!cellId) return false;
  const cell = findCell(getS(), cellId)?.cell;
  return !!cell && !cell.ssh && getProfile(getS(), cell.profileId).cli !== 'shell';
}

/** Opens the export dialog for a cell (a toast when the cell has no conversation yet). */
export function exportCellConversation(cellId: string | null | undefined): void {
  const source = cellExportSource(cellId);
  if (!source) { toast(tr('Ta komórka nie ma jeszcze rozmowy do wyeksportowania.')); return; }
  setUi({ modal: { kind: 'convExport', source } });
}

export const markdownLabels = (): MarkdownLabels => ({
  you: tr('Ty'), date: tr('Data'), folder: tr('Folder projektu'), agent: tr('Agent'), session: tr('Sesja'), tool: tr('Narzędzie'),
  untitled: tr('Rozmowa bez tytułu'), cutMessage: tr('wiadomość skrócona'), capped: tr('Rozmowa jest bardzo długa: wyeksportowano tylko jej początek.'),
});

export const renderExport = (data: ConvExportData, tools: boolean): string => renderConvMarkdown(data, { tools }, markdownLabels());

const fileNameOf = (data: ConvExportData) => exportFileName(exportBaseName(data.title, data.startedAt, tr('Rozmowa bez tytułu')), undefined);

export async function saveExportToFile(data: ConvExportData, markdown: string): Promise<boolean> {
  const r = await window.mc.notes.exportFile(fileNameOf(data), markdown, 'conversation');
  if (r.ok) toast(tr('Zapisano rozmowę w {path}', { path: r.path ?? '' }));
  else if (!r.cancelled) toast(tr('Nie udało się zapisać rozmowy do pliku.'), 'error');
  return r.ok;
}

export function copyExport(markdown: string): void {
  window.mc.clipboardWrite(markdown);
  toast(tr('Skopiowano rozmowę jako Markdown ({count} znaków).', { count: markdown.length.toLocaleString() }));
}

/** A note named after the conversation; a very long one is cut to what a note holds (with a line saying so). */
export function saveExportAsNote(data: ConvExportData, markdown: string): void {
  const { text, cut } = capText(markdown, NOTE_LIMITS.text, tr('Notatka mieści tylko początek tej rozmowy. Całość zapiszesz do pliku.'));
  const name = data.title.trim() || tr('Rozmowa bez tytułu');
  const note = addNote({ name, text });
  openNoteInPanel(note.id);
  toast(cut ? tr('Utworzono notatkę „{name}” (skróconą: rozmowa jest za długa na notatkę).', { name }) : tr('Utworzono notatkę „{name}”.', { name }));
}
