// Opening SFTP files in editor tabs (0.9.9): "Otwórz" (double click, Enter, the menus) on a remote or local file of the SFTP
// view. Remote text and images open in a tab; a binary file or one over the editor's limit offers "Pobierz" instead (a download
// into the local pane's folder through the transfer queue). Kept apart from files.ts, which this module imports.
import { remoteOpenPlan, sourceDocumentId, EDITOR_TEXT_BYTES } from '../../shared/editorSource';
import { formatBytes } from '../../shared/sftpView';
import { chosenLanguage, tr } from './i18n';
import { dropTab, openLocalFile, openRemoteFile, useFileStore } from './files';
import { ensureSession } from './remoteSessions';
import { enqueueTransfer } from './sftp';
import { askChoice, getS, toast } from './store';

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path;

/** Downloads a remote file into the SFTP view's local folder (the home folder when none was chosen yet). */
export async function downloadRemoteFile(hostId: string, path: string): Promise<boolean> {
  const session = await ensureSession(hostId);
  if (!session.ok) { toast(session.error, 'error'); return false; }
  const targetDir = getS().sftp?.localPath || (await window.mc.localFs.roots()).home;
  if (!targetDir) return false;
  const ok = await enqueueTransfer(session.sessionId, { direction: 'download', sources: [path], targetDir });
  if (ok) toast(tr('Pobieranie do {folder}', { folder: targetDir }));
  return ok;
}

/** The question instead of a tab: the file cannot be shown in the editor, it can be downloaded. */
async function offerDownload(hostId: string, path: string, reason: 'binary' | 'tooLarge', size: number): Promise<void> {
  const language = chosenLanguage();
  const body = reason === 'tooLarge'
    ? tr('Plik ma {size}, a edytor otwiera pliki tekstowe do {limit}. Możesz go pobrać na ten komputer.', { size: formatBytes(size, language), limit: formatBytes(EDITOR_TEXT_BYTES, language) })
    : tr('To plik binarny lub w nieobsługiwanym kodowaniu. Możesz go pobrać na ten komputer.');
  const choice = await askChoice(tr('Nie można otworzyć {name} w edytorze', { name: nameOf(path) }), body, [{ label: tr('Pobierz'), value: 'download', primary: true }]);
  if (choice === 'download') await downloadRemoteFile(hostId, path);
}

/**
 * Opens a remote file of a saved host in an editor tab. `size` from the listing: a file over the limit is offered for download
 * without being read. A file that turns out binary right after it was opened closes its new tab and offers the download.
 */
export async function openRemoteEntry(hostId: string, path: string, size?: number): Promise<void> {
  const open = useFileStore.getState().documents.some((d) => d.id === sourceDocumentId({ kind: 'remote', hostId, path }));
  if (!open && size !== undefined && remoteOpenPlan(nameOf(path), size).kind === 'tooLarge') { await offerDownload(hostId, path, 'tooLarge', size); return; }
  const status = await openRemoteFile(hostId, path);
  if (status !== 'binary' && status !== 'tooLarge') return;
  const id = sourceDocumentId({ kind: 'remote', hostId, path });
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  dropTab(id);
  await offerDownload(hostId, path, status, doc?.size ?? size ?? 0);
}

export function openLocalEntry(path: string): void { void openLocalFile(path); }
