// Files of the notes (1.0.7): images pasted into a note (kept in <data>/note-images, named by a random id) and a note
// exported as a file through the save dialog. The renderer never names a path: it sends bytes or a suggested file name.
import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import type { IpcGuard } from './ipcGuard';
import { isNoteImageName, NOTE_IMAGE_DIR, NOTE_IMAGE_MAX_BYTES, NOTE_IMAGE_TYPES } from '../shared/noteTools';

const MIME_OF: Record<string, string> = Object.fromEntries(Object.entries(NOTE_IMAGE_TYPES).map(([mime, ext]) => [ext, mime]));
const EXPORT_MAX = 4 * 1024 * 1024;

export interface NoteFilesDeps {
  dataDir: string;
  /** The save dialog: the chosen path, or null when cancelled. */
  pickSavePath(defaultName: string, kind?: 'conversation'): Promise<string | null>;
  /** Real-app checks of an unpackaged build: exports go into this folder without the dialog. */
  exportDir?: string | null;
}

/** Writes a pasted image; resolves to its name (`<uuid>.<ext>`), or null for anything that is not a small image of a known type. */
export async function saveNoteImage(dataDir: string, bytes: unknown, mime: unknown): Promise<string | null> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > NOTE_IMAGE_MAX_BYTES) return null;
  const ext = typeof mime === 'string' ? NOTE_IMAGE_TYPES[mime] : undefined;
  if (!ext) return null;
  const dir = join(dataDir, NOTE_IMAGE_DIR);
  await mkdir(dir, { recursive: true });
  const name = `${randomUUID()}.${ext}`;
  await writeFile(join(dir, name), bytes, { flag: 'wx' });
  return name;
}

/** An image of a note as a data URL (the page may show data: images only), or null when the name is not one the app gave. */
export async function readNoteImage(dataDir: string, name: unknown): Promise<string | null> {
  if (!isNoteImageName(name)) return null;
  try {
    const bytes = await readFile(join(dataDir, NOTE_IMAGE_DIR, name));
    if (bytes.byteLength > NOTE_IMAGE_MAX_BYTES) return null;
    return `data:${MIME_OF[name.split('.').pop()!]};base64,${bytes.toString('base64')}`;
  } catch { return null; }
}

export function registerNoteFilesIpc(guard: IpcGuard, deps: NoteFilesDeps): void {
  guard.guardedHandle('notes:image:save', (_e, bytes: unknown, mime: unknown) => saveNoteImage(deps.dataDir, bytes, mime).catch(() => null), () => null);
  guard.guardedHandle('notes:image:read', (_e, name: unknown) => readNoteImage(deps.dataDir, name), () => null);
  // 1.1.1: a conversation exported to Markdown is saved the same way (only the dialog's title differs).
  guard.guardedHandle('notes:export', async (_e, name: unknown, text: unknown, kind: unknown) => {
    if (typeof name !== 'string' || !name || name.length > 200 || /[\\/\0]/.test(name) || typeof text !== 'string' || text.length > EXPORT_MAX) return { ok: false };
    const path = deps.exportDir ? join(deps.exportDir, basename(name)) : await deps.pickSavePath(name, kind === 'conversation' ? kind : undefined);
    if (!path) return { ok: false, cancelled: true };
    try { await writeFile(path, text, 'utf8'); return { ok: true, path }; } catch { return { ok: false }; }
  }, () => ({ ok: false }));
}
