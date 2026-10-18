import { create } from 'zustand';
import { detectLanguage, type Language } from '../../shared/languages';
import { askChoice, getS, getUi, setUi } from './store';
import { refreshGitBadges } from './git/gitBadges';
import { tr } from './i18n';
import { useSshStore } from './sshStore';
import type { GitDiffSource } from '../../shared/git';
import type { ProjectFilePreview } from '../../shared/types';
import { documentId, documentsUnder, removeDocuments, retargetDocuments, type FileMoveRecord } from '../../shared/fileOps';

export interface FileDocument {
  id: string;
  projectId: string;
  relativePath: string;
  name: string;
  text: string;
  savedText: string;
  diskText: string;
  status: 'loading' | 'ready' | 'error' | 'binary' | 'truncated' | 'image' | 'table';
  saving: boolean;
  error: string | null;
  wrap: boolean;
  markdownView?: 'preview' | 'source';
  /** CSV / TSV: the table or the text source. */
  dataView?: 'table' | 'source';
  /** Size on disk in bytes (shown for read-only views; a 'truncated' text holds only its beginning). */
  size?: number;
  /** An image or a Parquet table read by main; never persisted (only unsaved drafts are). */
  view?: Extract<ProjectFilePreview, { kind: 'image' | 'table' }>;
  /** A read-only git diff opened as a tab instead of a file. */
  diff?: DiffRef;
  /**
   * The file on disk is no longer the text this tab started from and the tab has unsaved edits: 'changed' = noticed by a
   * check (a notice), 'save' = a save was refused for it. Both offer Reload, Show diff and Overwrite.
   */
  diskConflict?: 'changed' | 'save';
  /** The text on disk when the conflict was last seen (for the diff). */
  externalText?: string;
}
export interface DiffRef { source: GitDiffSource; path: string; oldPath?: string; hash?: string; worktree?: string }
const labels = {
  dirty: ['Unsaved changes', 'Niezapisane zmiany', 'Ungespeicherte Änderungen', 'Cambios sin guardar', 'Modifications non enregistrées', 'Alterações não guardadas'],
  discard: ['Discard', 'Odrzuć', 'Verwerfen', 'Descartar', 'Ignorer', 'Descartar'],
  close: ['Save changes before closing?', 'Zapisać zmiany przed zamknięciem?', 'Änderungen vor dem Schließen speichern?', '¿Guardar antes de cerrar?', 'Enregistrer avant de fermer ?', 'Guardar antes de fechar?'],
  saving: ['Saving…', 'Zapisywanie…', 'Speichern…', 'Guardando…', 'Enregistrement…', 'A guardar…'],
  saved: ['Saved', 'Zapisano', 'Gespeichert', 'Guardado', 'Enregistré', 'Guardado'],
  largeNotice: ['Read-only view: the first {shown} of {total}. Open the file in an external editor to see all of it.', 'Tylko do odczytu: pierwsze {shown} z {total}. Otwórz plik w zewnętrznym edytorze, aby zobaczyć całość.', 'Nur Lesen: die ersten {shown} von {total}. Öffne die Datei in einem externen Editor, um alles zu sehen.', 'Solo lectura: los primeros {shown} de {total}. Abre el archivo en un editor externo para verlo completo.', 'Lecture seule : les premiers {shown} sur {total}. Ouvrez le fichier dans un éditeur externe pour tout voir.', 'Só de leitura: os primeiros {shown} de {total}. Abra o ficheiro num editor externo para ver tudo.'],
  tooLarge: ['This file exceeds 256 KB and cannot be edited safely here.', 'Ten plik przekracza 256 KB i nie może być tu bezpiecznie edytowany.', 'Diese Datei ist größer als 256 KB und kann hier nicht sicher bearbeitet werden.', 'Este archivo supera 256 KB y no se puede editar aquí con seguridad.', 'Ce fichier dépasse 256 Ko et ne peut pas être modifié ici en sécurité.', 'Este ficheiro excede 256 KB e não pode ser editado aqui em segurança.'],
  failed: ['Could not save. Your draft is preserved.', 'Nie udało się zapisać. Szkic został zachowany.', 'Speichern fehlgeschlagen. Der Entwurf bleibt erhalten.', 'No se pudo guardar. El borrador se conserva.', 'Échec de l’enregistrement. Le brouillon est conservé.', 'Não foi possível guardar. O rascunho foi preservado.'],
  conflict: ['The file changed outside the editor. Your draft is preserved.', 'Plik zmienił się poza edytorem. Twój szkic został zachowany.', 'Die Datei wurde außerhalb des Editors geändert. Der Entwurf bleibt erhalten.', 'El archivo cambió fuera del editor. El borrador se conserva.', 'Le fichier a été modifié en dehors de l’éditeur. Le brouillon est conservé.', 'O ficheiro foi alterado fora do editor. O rascunho foi preservado.'],
  invalid: ['Invalid file content.', 'Nieprawidłowa treść pliku.', 'Ungültiger Dateiinhalt.', 'Contenido de archivo no válido.', 'Contenu du fichier non valide.', 'Conteúdo de ficheiro inválido.'],
  binary: ['Binary files or unsupported encodings cannot be edited.', 'Nie można edytować pliku binarnego lub nieobsługiwanego kodowania.', 'Binärdateien oder nicht unterstützte Kodierungen können nicht bearbeitet werden.', 'No se pueden editar archivos binarios o codificaciones no admitidas.', 'Les fichiers binaires ou les encodages non pris en charge ne peuvent pas être modifiés.', 'Não é possível editar ficheiros binários ou codificações não suportadas.'],
} as const;
export function fileLabel(key: keyof typeof labels, language: Language = getS().settings.language ?? detectLanguage(navigator.languages)): string {
  return labels[key][['en', 'pl', 'de', 'es', 'fr', 'pt'].indexOf(language)];
}
export function fileErrorLabel(message: string, language: Language): string {
  // A save conflict comes as a code (ProjectFileWriteResult.code) and is shown as FileDocument.diskConflict, not here.
  const key = message === 'Nieprawidłowa treść pliku.' ? 'invalid'
    : message === 'Plik jest zbyt duży do bezpiecznej edycji.' ? 'tooLarge'
    : message.startsWith('Nie można edytować pliku binarnego') ? 'binary' : null;
  return key ? fileLabel(key, language) : message;
}
const normalize = (text: string) => text.replace(/\r\n|\r/g, '\n');
const storageKey = 'mc-file-drafts-v1';
function restoreDrafts(): FileDocument[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((d): d is FileDocument => d && typeof d.id === 'string' && typeof d.projectId === 'string' && typeof d.relativePath === 'string' && typeof d.name === 'string' && typeof d.text === 'string' && typeof d.savedText === 'string' && typeof d.diskText === 'string')
      .map((d) => ({ ...d, status: 'ready', saving: false, error: null, wrap: Boolean(d.wrap), diskConflict: undefined, externalText: undefined }));
  } catch { return []; }
}
export const useFileStore = create<{ documents: FileDocument[]; activeFileId: string | null }>(() => ({ documents: restoreDrafts(), activeFileId: null }));
/** Old tab id -> new tab id after a rename: an in-flight save or load still reports under the old id. */
const aliases = new Map<string, string>();
function patch(id: string, changes: Partial<FileDocument>): void {
  useFileStore.setState((s) => {
    let target = id;
    for (let hops = 0; hops < 8 && !s.documents.some((d) => d.id === target) && aliases.has(target); hops++) target = aliases.get(target)!;
    return { documents: s.documents.map((d) => d.id === target ? { ...d, ...changes } : d) };
  });
}
/** Set by the Files panel when a file is opened with the keyboard (Enter): the editor then takes focus. */
export const treeOpen = { keyboard: false, hold: false };
/** A rename or move from the tree re-creates editors: they must not steal the keyboard from the tree for a moment. */
export function holdTreeFocus(): void { treeOpen.hold = true; setTimeout(() => { treeOpen.hold = false; }, 600); }
export const isFileDirty = (d: FileDocument): boolean => d.text !== d.savedText;
export function activateFile(id: string): void {
  setUi({ settingsActive: false });
  useSshStore.setState({ viewActive: false });
  if (useFileStore.getState().documents.some((d) => d.id === id)) { useFileStore.setState({ activeFileId: id }); void checkFileOnDisk(id); }
}
export function showTerminalTabs(): void { setUi({ settingsActive: false }); useSshStore.setState({ viewActive: false }); useFileStore.setState({ activeFileId: null }); }
export async function openFile(projectId: string, relativePath: string): Promise<void> {
  setUi({ settingsActive: false });
  useSshStore.setState({ viewActive: false });
  const path = relativePath.replace(/\\/g, '/');
  const id = documentId(projectId, path);
  const existing = useFileStore.getState().documents.find((d) => d.id === id);
  if (existing) { activateFile(id); return; }
  const document: FileDocument = { id, projectId, relativePath: path, name: path.split('/').pop() ?? path, text: '', savedText: '', diskText: '', status: 'loading', saving: false, error: null, wrap: false };
  useFileStore.setState((s) => ({ documents: [...s.documents, document], activeFileId: id }));
  await retryFile(id);
}
const loads = new Map<string, symbol>();
export async function retryFile(id: string): Promise<void> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc || doc.diff || isFileDirty(doc) || doc.saving) return;
  const token = Symbol(); loads.set(id, token);
  patch(id, { status: 'loading', error: null });
  try {
    const result = await window.mc.readProjectFile(doc.projectId, doc.relativePath, true);
    if (loads.get(id) !== token) return;
    if (result.kind === 'text') patch(id, { status: result.truncated ? 'truncated' : 'ready', size: result.size, view: undefined, text: normalize(result.text), savedText: normalize(result.text), diskText: result.text, diskConflict: undefined, externalText: undefined });
    else if (result.kind === 'image' || result.kind === 'table') patch(id, { status: result.kind, size: result.size, view: result, text: '', savedText: '', diskText: '' });
    else patch(id, { status: result.kind, size: result.kind === 'binary' ? result.size : undefined, error: result.kind === 'error' ? result.message : null });
  } catch (error) { if (loads.get(id) === token) patch(id, { status: 'error', error: String(error) }); }
  finally { if (loads.get(id) === token) loads.delete(id); }
}
export function editFile(id: string, text: string): void {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (doc?.status === 'ready') patch(id, { text: normalize(text) });
}
export function toggleFileWrap(id: string): void {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (doc) patch(id, { wrap: !doc.wrap });
}
export function setFileDataView(id: string, dataView: 'table' | 'source'): void {
  patch(id, { dataView });
}
/** A git diff as a tab (read-only, next to the files). The same change opened twice focuses the existing tab. */
export function openDiffTab(projectId: string, diff: DiffRef): void {
  setUi({ settingsActive: false });
  const id = JSON.stringify([projectId, 'diff', diff.source, diff.hash ?? '', diff.worktree ?? '', diff.oldPath ?? '', diff.path]);
  if (!useFileStore.getState().documents.some((d) => d.id === id)) {
    const document: FileDocument = { id, projectId, relativePath: diff.path, name: diff.path.split('/').pop() ?? diff.path, text: '', savedText: '', diskText: '', status: 'ready', saving: false, error: null, wrap: false, diff };
    useFileStore.setState((s) => ({ documents: [...s.documents, document] }));
  }
  activateFile(id);
}
export function setFileMarkdownView(id: string, markdownView: 'preview' | 'source'): void {
  patch(id, { markdownView });
}
export async function saveFile(id: string): Promise<boolean> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc || doc.status !== 'ready' || doc.saving) return false;
  if (!isFileDirty(doc)) return true;
  patch(id, { saving: true, error: null });
  try {
    const result = await window.mc.writeProjectFile(doc.projectId, doc.relativePath, doc.text, doc.diskText);
    if (!result.ok) {
      if (result.code === 'conflict') patch(id, { diskConflict: 'save' });
      else patch(id, { error: result.error });
      return false;
    }
    const endings = doc.diskText.match(/\r\n|\r|\n/g) ?? [];
    let index = 0;
    const diskText = doc.text.replace(/\n/g, () => endings[index++] ?? endings[0] ?? '\n');
    // Edits made while saving stay dirty against the snapshot that was written.
    patch(id, { savedText: doc.text, diskText, diskConflict: undefined, externalText: undefined });
    refreshGitBadges(doc.projectId, 600);
    return true;
  } catch { patch(id, { error: fileLabel('failed') }); return false; }
  finally { patch(id, { saving: false }); }
}
// ── files changed on disk ───────────────────────────────────────────────────

const checks = new Set<string>();
/**
 * Compares an open text tab with its file on disk. A clean tab takes the new text at once; a tab with unsaved edits keeps
 * them and gets a notice (diskConflict 'changed'). Other results (gone, binary, unreadable for a moment while an agent
 * rewrites it) change nothing: saving reports them.
 */
export async function checkFileOnDisk(id: string): Promise<void> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc || doc.diff || doc.status !== 'ready' || doc.saving || loads.has(id) || checks.has(id)) return;
  checks.add(id);
  try {
    const result = await window.mc.readProjectFile(doc.projectId, doc.relativePath, true);
    const now = useFileStore.getState().documents.find((d) => d.id === id);
    // A save, load or rename that happened meanwhile knows better.
    if (!now || now.saving || loads.has(id) || now.diskText !== doc.diskText || now.relativePath !== doc.relativePath) return;
    if (result.kind !== 'text') return;
    if (result.truncated) { if (!isFileDirty(now)) void retryFile(id); return; }
    if (result.text === now.diskText) {
      if (now.diskConflict === 'changed') patch(id, { diskConflict: undefined, externalText: undefined });
      return;
    }
    if (!isFileDirty(now)) patch(id, { text: normalize(result.text), savedText: normalize(result.text), diskText: result.text, size: result.size, diskConflict: undefined, externalText: undefined, error: null });
    else patch(id, { diskConflict: now.diskConflict ?? 'changed', externalText: result.text });
  } catch { /* the next check tries again */ }
  finally { checks.delete(id); }
}
/** Every open text tab (on focus and when an agent finished a turn). */
export function checkOpenFilesOnDisk(): void {
  for (const d of useFileStore.getState().documents) if (!d.diff && d.status === 'ready') void checkFileOnDisk(d.id);
}
/** Conflict choice "Reload": drops the unsaved edits and reads the file again. */
export async function reloadFileFromDisk(id: string): Promise<void> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc || doc.saving) return;
  patch(id, { text: doc.savedText, diskConflict: undefined, externalText: undefined, error: null });
  await retryFile(id);
}
/** Conflict choice "Show diff": reads the current disk text into externalText; resolves to it (null when unreadable). */
export async function loadDiskText(id: string): Promise<string | null> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc) return null;
  try {
    const result = await window.mc.readProjectFile(doc.projectId, doc.relativePath, true);
    if (result.kind !== 'text' || result.truncated) return null;
    patch(id, { externalText: result.text });
    return result.text;
  } catch { return null; }
}
/** Conflict choice "Overwrite": keeps the editor text and writes it over what is on disk now (another change in between is a new conflict). */
export async function overwriteFileOnDisk(id: string): Promise<boolean> {
  const disk = await loadDiskText(id);
  if (disk === null) { patch(id, { error: fileLabel('failed') }); return false; }
  patch(id, { diskText: disk, diskConflict: undefined, externalText: undefined, error: null });
  return saveFile(id);
}
let watching = false;
/**
 * Keeps open tabs in step with the disk without polling every file: all open tabs are checked when the window gets focus
 * or becomes visible and when an agent finishes a turn, and only the tab on screen every few seconds while the window is visible.
 */
export function watchFilesOnDisk(): void {
  if (watching) return;
  watching = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => { clearTimeout(timer); timer = setTimeout(checkOpenFilesOnDisk, 300); };
  window.addEventListener('focus', soon);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });
  window.mc.on('cell:hook', (_cellId, event) => { if (event === 'stop') soon(); });
  setInterval(() => {
    const active = useFileStore.getState().activeFileId;
    if (active && !document.hidden) void checkFileOnDisk(active);
  }, ACTIVE_CHECK_MS);
}
const ACTIVE_CHECK_MS = 2500;

const closing = new Set<string>();
export async function closeFile(id: string): Promise<boolean> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc) return true;
  if (doc.saving || closing.has(id) || getUi().dialog) return false;
  closing.add(id);
  try {
    if (isFileDirty(doc)) {
      const choice = await askChoice(fileLabel('close'), doc.relativePath, [
        { label: tr('Zapisz'), value: 'save', primary: true },
        { label: fileLabel('discard'), value: 'discard', danger: true },
        { label: tr('Anuluj'), value: 'cancel' },
      ]);
      if (choice !== 'save' && choice !== 'discard') return false;
      if (choice === 'save' && (!await saveFile(id) || useFileStore.getState().documents.some((d) => d.id === id && isFileDirty(d)))) return false;
    }
    loads.delete(id);
    useFileStore.setState((s) => {
      const documents = s.documents.filter((d) => d.id !== id);
      const next = documents.filter((d) => d.projectId === doc.projectId).at(-1);
      return { documents, activeFileId: s.activeFileId === id ? next?.id ?? null : s.activeFileId };
    });
    return true;
  } finally { closing.delete(id); }
}
export function hasDirtyFiles(): boolean { return useFileStore.getState().documents.some(isFileDirty); }
/**
 * Unsaved drafts reach localStorage at most this long after a change (not on every keystroke: each write serializes every
 * draft). flushDrafts writes at once; it runs before a reload, when the window is hidden and when the app quits.
 */
export const DRAFT_SAVE_MS = 700;
let draftTimer: ReturnType<typeof setTimeout> | null = null;
/** The dirty documents of the last write: the same objects again need no new write. */
let writtenDrafts: FileDocument[] | null = null;
function writeDrafts(): void {
  if (draftTimer !== null) clearTimeout(draftTimer);
  draftTimer = null;
  const dirty = useFileStore.getState().documents.filter(isFileDirty);
  const last = writtenDrafts;
  if (last && dirty.length === last.length && dirty.every((d, i) => d === last[i])) return;
  writtenDrafts = dirty;
  try { localStorage.setItem(storageKey, JSON.stringify(dirty)); } catch { /* In-memory drafts still remain protected by close confirmation. */ }
}
/** Writes pending drafts now (no-op when nothing is waiting). */
export function flushDrafts(): void {
  if (draftTimer !== null) writeDrafts();
}
useFileStore.subscribe((s, prev) => {
  if (s.documents === prev.documents) return;
  // A stored draft whose document is now clean (saved, discarded, closed) is removed at once: after a crash it must not come back.
  const written = writtenDrafts ?? [];
  if (written.some((d) => !s.documents.some((n) => n.id === d.id && isFileDirty(n)))) { writeDrafts(); return; }
  if (draftTimer === null) draftTimer = setTimeout(writeDrafts, DRAFT_SAVE_MS);
});
writtenDrafts = useFileStore.getState().documents.filter(isFileDirty); // the restored drafts are what storage holds

/** Open tabs follow renamed or moved files and folders (their text and unsaved changes stay untouched). */
export function retargetOpenFiles(projectId: string, moves: FileMoveRecord[], replaced: string[] = []): void {
  const before = useFileStore.getState();
  const result = retargetDocuments(before.documents, before.activeFileId, projectId, moves, { isDirty: isFileDirty, replaced });
  if (!result.changed) return;
  const detached = new Set(result.detached);
  // Only the tabs that changed lose their in-flight load; the others keep loading. A tab that is saving keeps its state
  // and its save reports under the old id, which now points to the new one.
  const reload: string[] = [];
  for (const [oldId, newId] of result.idMap) {
    loads.delete(oldId);
    aliases.set(oldId, newId);
    if (!detached.has(newId) && result.documents.some((d) => d.id === newId && d.status === 'loading')) reload.push(newId);
  }
  for (const id of result.closed) loads.delete(id);
  useFileStore.setState({
    documents: result.documents.map((d) => detached.has(d.id) ? { ...d, error: 'Ten plik został usunięty z dysku. Niezapisany szkic został zachowany.' } : d),
    activeFileId: result.activeId,
  });
  for (const id of reload) void retryFile(id);
}

/** After a copy replaced files: clean tabs on them reload the new content (unsaved ones keep their text; saving them reports the conflict). */
export function refreshReplacedFiles(projectId: string, replaced: string[]): void {
  if (!replaced.length) return;
  for (const id of documentsUnder(useFileStore.getState().documents, projectId, replaced)) void retryFile(id);
}

/** Tabs of trashed files: clean ones close, tabs with unsaved changes stay (marked) so the draft is not lost. */
export function forgetDeletedFiles(projectId: string, paths: string[]): void {
  const state = useFileStore.getState();
  const ids = documentsUnder(state.documents, projectId, paths);
  if (!ids.length) return;
  const keep = new Set(ids.filter((id) => state.documents.some((d) => d.id === id && isFileDirty(d))));
  const gone = ids.filter((id) => !keep.has(id));
  for (const id of ids) loads.delete(id);
  const removed = removeDocuments(state.documents, state.activeFileId, gone);
  useFileStore.setState({
    documents: removed.documents.map((d) => keep.has(d.id) ? { ...d, error: 'Ten plik został usunięty z dysku. Niezapisany szkic został zachowany.' } : d),
    activeFileId: removed.activeId,
  });
}

/** Closes several tabs one by one (each unsaved one asks first); stops when the user cancels. */
export async function closeFiles(ids: string[]): Promise<void> {
  for (const id of ids) if (!await closeFile(id)) return;
}
