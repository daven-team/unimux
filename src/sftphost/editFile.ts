// Remote files in editor tabs (0.9.9): reading one into memory (no temp file) and saving it back. A save never leaves a
// half-written file under the real name: the bytes go to "<name>.unimux-part" next to it and are renamed into place, after the
// server file was checked to still be the one the tab was opened from (size and modification time, or its text for a restored
// draft). The file's permissions are kept, and a symlink stays a symlink (the file it points to is written).
import { finished } from 'stream/promises';
import {
  decodeText, EDITOR_IMAGE_BYTES, EDITOR_TEXT_BYTES, encodeText, remoteOpenPlan, sameStamp, validEditorText,
  type EditorRead, type EditorSave, type FileStamp,
} from '../shared/editorSource';
import { partName, posixBasename, posixJoin, posixParent, validRemotePath } from '../shared/sftp';
import { SftpError, type RemoteSide } from './sides';

/** The whole file, or null when it has more than `limit` bytes (the read stops there). */
async function readAll(side: RemoteSide, path: string, limit: number): Promise<Buffer | null> {
  const { stream } = await side.openRead(path);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > limit) return null;
      chunks.push(chunk);
    }
  } finally { if (!stream.destroyed) stream.destroy(); }
  return Buffer.concat(chunks, total);
}

const stampOf = (meta: { size: number; mtime: number }): FileStamp => ({ size: meta.size, mtimeMs: meta.mtime });

export async function readForEditor(side: RemoteSide, path: string): Promise<EditorRead> {
  if (!validRemotePath(path)) throw new SftpError('invalid');
  // Taken before the read: a write during the read shows up as a change at the next check.
  const meta = await side.stat(path);
  if (!meta) throw new SftpError('notFound');
  if (meta.kind === 'dir') throw new SftpError('isADirectory');
  if (meta.kind !== 'file') throw new SftpError('invalid');
  const plan = remoteOpenPlan(posixBasename(path), meta.size);
  if (plan.kind === 'tooLarge') return { kind: 'tooLarge', size: meta.size };
  const bytes = await readAll(side, path, plan.kind === 'image' ? EDITOR_IMAGE_BYTES : EDITOR_TEXT_BYTES);
  if (!bytes) return { kind: 'tooLarge', size: meta.size };
  const stamp = stampOf(meta);
  if (plan.kind === 'image') return { kind: 'image', mime: plan.mime, dataUrl: `data:${plan.mime};base64,${bytes.toString('base64')}`, size: bytes.length, stamp };
  const decoded = decodeText(bytes);
  return decoded ? { kind: 'text', text: decoded.text, encoding: decoded.encoding, size: bytes.length, stamp } : { kind: 'binary', size: meta.size };
}

const chmod = (side: RemoteSide, path: string, mode: number): Promise<void> => side.rq.call<void>((cb) => side.sftp.chmod(path, mode, cb));

/** Saves an editor tab's text; 'changed' when the server file is no longer the one the tab was opened from. */
export async function writeFromEditor(side: RemoteSide, path: string, save: EditorSave, owner: string): Promise<{ stamp: FileStamp }> {
  if (!validRemotePath(path)) throw new SftpError('invalid');
  if (!validEditorText(save.text)) throw new SftpError('invalid');
  // A symlink keeps pointing where it did: the file it points to is the one written.
  const target = await side.realpath(path);
  if (!target || !validRemotePath(target)) throw new SftpError('notFound');
  const meta = await side.stat(target);
  if (!meta) throw new SftpError('notFound');
  if (meta.kind !== 'file') throw new SftpError('invalid');
  if (save.expected) {
    if (!sameStamp(save.expected, stampOf(meta))) throw new SftpError('changed');
  } else {
    const bytes = await readAll(side, target, EDITOR_TEXT_BYTES);
    if (!bytes || decodeText(bytes)?.text !== save.baseline) throw new SftpError('changed');
  }
  const output = Buffer.from(encodeText(save.text, save.baseline, save.encoding));
  if (output.length > EDITOR_TEXT_BYTES) throw new SftpError('invalid');
  // A transfer writing the same file right now: the file is changing under the tab.
  if (!side.inflight.hold(target, owner)) throw new SftpError('changed');
  const part = posixJoin(posixParent(target), partName(posixBasename(target)));
  let partWritten = false;
  try {
    // The target is held, so a part file under its name is a leftover of a crash, never another job's.
    await side.unlink(part).catch(() => undefined);
    const writer = await side.openWrite(part);
    partWritten = true;
    writer.end(output);
    await finished(writer);
    const mode = meta.mode === undefined ? undefined : meta.mode & 0o7777;
    if (mode !== undefined) await chmod(side, part, mode).catch(() => undefined);
    // Last look before the rename: a write that came in while the part file was written is a conflict too.
    const now = await side.stat(target);
    if (!now || !sameStamp(stampOf(now), stampOf(meta))) throw new SftpError('changed');
    try { await side.rename(part, target, true); } catch (error) {
      if (error instanceof SftpError && error.keepPart) partWritten = false; // the only copy: it stays
      throw error;
    }
    partWritten = false;
    let after = await side.stat(target);
    if (after && mode !== undefined && after.mode !== undefined && (after.mode & 0o7777) !== mode) {
      await chmod(side, target, mode).catch(() => undefined);
      after = (await side.stat(target)) ?? after;
    }
    return { stamp: stampOf(after ?? { size: output.length, mtime: 0 }) };
  } finally {
    if (partWritten) await side.unlink(part).catch(() => undefined);
    side.inflight.release(target, owner);
  }
}
