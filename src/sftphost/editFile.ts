// Remote files in editor tabs (0.9.9): reading one into memory (no temp file) and saving it back. A save never leaves a
// half-written file under the real name: the bytes go to "<name>.unimux-part" next to it and are renamed into place, after the
// server file was checked to still be the one the tab was opened from (size and modification time, the content hash when the
// time cannot tell, or its text for a restored draft). The part file is created exclusively (never through an existing name or
// link) and private (0600) while it is written; the file's permissions are put on it before the rename and checked after it.
// A file owned by another user is not replaced by one of the SSH user unless the user agreed. A symlink stays a symlink.
import { createHash } from 'crypto';
import { finished } from 'stream/promises';
import type { Stats as SftpStats } from 'ssh2';
import {
  decodeText, EDITOR_IMAGE_BYTES, EDITOR_TEXT_BYTES, encodeText, needsHashCheck, remoteOpenPlan, sameStamp, validEditorText,
  type EditorRead, type EditorSave, type EditorWarning, type EditorWriteResult, type FileOwner, type FileStamp, type RemoteStamp,
} from '../shared/editorSource';
import { isPartName, kindFromMode, partName, posixBasename, posixJoin, posixParent, validRemotePath } from '../shared/sftp';
import { RemoteWriteStream, SftpError, remoteError, type RemoteSide } from './sides';

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

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const stampOf = (meta: { size: number; mtime: number }): FileStamp => ({ size: meta.size, mtimeMs: meta.mtime });

/** The raw attributes (owner, mode) of a path, following links; null when nothing is there. */
async function attrsAt(side: RemoteSide, path: string): Promise<SftpStats | null> {
  try { return await side.rq.call<SftpStats>((cb) => side.sftp.stat(path, cb)); } catch (error) {
    if (remoteError(error) === 'notFound') return null;
    throw error;
  }
}
const metaOf = (a: SftpStats) => ({ kind: kindFromMode(a.mode), size: typeof a.size === 'number' ? a.size : 0, mtime: typeof a.mtime === 'number' ? a.mtime * 1000 : 0 });
const ownerOf = (a: Partial<SftpStats>): FileOwner | null => (typeof a.uid === 'number' && typeof a.gid === 'number' ? { uid: a.uid, gid: a.gid } : null);
const sameOwner = (a: FileOwner | null, b: FileOwner | null): boolean => !a || !b || (a.uid === b.uid && a.gid === b.gid);

export async function readForEditor(side: RemoteSide, path: string): Promise<EditorRead> {
  if (!validRemotePath(path)) throw new SftpError('invalid');
  // Taken before the read: a write during the read shows up as a change at the next check.
  const meta = await side.stat(path);
  if (!meta) throw new SftpError('notFound');
  if (meta.kind === 'dir') throw new SftpError('isADirectory');
  if (meta.kind !== 'file') throw new SftpError('invalid');
  const plan = remoteOpenPlan(posixBasename(path), meta.size);
  if (plan.kind === 'tooLarge') return { kind: 'tooLarge', size: meta.size };
  const readAt = Date.now();
  const bytes = await readAll(side, path, plan.kind === 'image' ? EDITOR_IMAGE_BYTES : EDITOR_TEXT_BYTES);
  if (!bytes) return { kind: 'tooLarge', size: meta.size };
  const stamp: RemoteStamp = { ...stampOf(meta), hash: sha256(bytes), readAt };
  if (plan.kind === 'image') return { kind: 'image', mime: plan.mime, dataUrl: `data:${plan.mime};base64,${bytes.toString('base64')}`, size: bytes.length, stamp };
  const decoded = decodeText(bytes);
  return decoded ? { kind: 'text', text: decoded.text, encoding: decoded.encoding, size: bytes.length, stamp } : { kind: 'binary', size: meta.size };
}

/** Size and time of a file (following links), for the focus check of a tab: one request, no listing. */
export async function statForEditor(side: RemoteSide, path: string): Promise<FileStamp> {
  if (!validRemotePath(path)) throw new SftpError('invalid');
  const meta = await side.stat(path);
  if (!meta) throw new SftpError('notFound');
  if (meta.kind !== 'file') throw new SftpError('invalid');
  return stampOf(meta);
}

/**
 * Creates the part file exclusively with mode 0600. Something already under that name (a leftover, or a link someone planted)
 * is removed (unlink never follows a link) and the exclusive create is tried once more; nothing is ever written through it.
 */
async function openPart(side: RemoteSide, part: string): Promise<Buffer> {
  const create = () => side.rq.call<Buffer>((cb) => side.sftp.open(part, 'wx', { mode: 0o600 }, cb));
  try { return await create(); } catch (error) {
    if (!(await side.lstat(part).catch(() => null))) throw error;
    await side.unlink(part);
    return create();
  }
}

const chmod = (side: RemoteSide, path: string, mode: number): Promise<void> => side.rq.call<void>((cb) => side.sftp.chmod(path, mode, cb));

/** The aside copy a failed overwrite left ("<name>.unimux-old", "<name>.unimux-old1" ...): the newest one. */
async function findAside(side: RemoteSide, target: string): Promise<string | null> {
  const name = posixBasename(target);
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.unimux-old\\d*$`);
  const entries = await side.readdir(posixParent(target)).catch(() => []);
  const found = entries.filter((e) => pattern.test(e.name)).sort((a, b) => b.mtime - a.mtime)[0];
  return found ? posixJoin(posixParent(target), found.name) : null;
}

/** Saves an editor tab's text; 'changed' when the server file is no longer the one the tab was opened from. */
export async function writeFromEditor(side: RemoteSide, path: string, save: EditorSave, owner: string): Promise<EditorWriteResult> {
  if (!validRemotePath(path)) throw new SftpError('invalid');
  if (!validEditorText(save.text)) throw new SftpError('invalid');
  // A symlink keeps pointing where it did: the file it points to is the one written.
  const target = await side.realpath(path);
  if (!target || !validRemotePath(target) || isPartName(posixBasename(target))) throw new SftpError('notFound');
  const attrs = await attrsAt(side, target);
  if (!attrs) throw new SftpError('notFound');
  const meta = metaOf(attrs);
  if (meta.kind !== 'file') throw new SftpError('invalid');
  if (save.expected) {
    if (!sameStamp(save.expected, stampOf(meta))) throw new SftpError('changed');
    // Within the time resolution the stamp cannot tell a change apart: the content decides.
    if (needsHashCheck(save.expected)) {
      const bytes = await readAll(side, target, EDITOR_TEXT_BYTES);
      if (!bytes || sha256(bytes) !== save.expected.hash) throw new SftpError('changed');
    }
  } else {
    const bytes = await readAll(side, target, EDITOR_TEXT_BYTES);
    if (!bytes || decodeText(bytes)?.text !== save.baseline) throw new SftpError('changed');
  }
  const output = Buffer.from(encodeText(save.text, save.baseline, save.encoding));
  if (output.length > EDITOR_TEXT_BYTES) throw new SftpError('invalid');
  // A transfer writing the same file right now: the file is changing under the tab.
  if (!side.inflight.hold(target, owner)) throw new SftpError('changed');
  const part = posixJoin(posixParent(target), partName(posixBasename(target)));
  const warnings: EditorWarning[] = [];
  let partExists = false;
  let writer: RemoteWriteStream | null = null;
  try {
    const handle = await openPart(side, part);
    partExists = true;
    writer = new RemoteWriteStream(side.rq, handle);
    // The owner of a new file is the SSH user: when the server file has another one, it is put back (fchown) or the user decides.
    const theirs = ownerOf(attrs);
    let mine = ownerOf(await side.rq.call<SftpStats>((cb) => side.sftp.fstat(handle, cb)).catch(() => ({})));
    if (!sameOwner(theirs, mine) && theirs) {
      await side.rq.call<void>((cb) => side.sftp.fchown(handle, theirs.uid, theirs.gid, cb)).catch(() => undefined);
      mine = ownerOf(await side.rq.call<SftpStats>((cb) => side.sftp.fstat(handle, cb)).catch(() => ({})));
      if (!sameOwner(theirs, mine) && mine) {
        if (!save.allowOwnerChange) return { kind: 'ownerChange', from: theirs, to: mine };
        warnings.push({ kind: 'owner', from: theirs, to: mine });
      }
    }
    writer.end(output);
    await finished(writer);
    // The part file stayed private while it was written; now it gets the permissions of the file it replaces.
    const mode = typeof attrs.mode === 'number' ? attrs.mode & 0o7777 : undefined;
    if (mode !== undefined && mode !== 0o600) {
      try { await chmod(side, part, mode); } catch { warnings.push({ kind: 'mode', mode }); }
    }
    // Last look before the rename: a write that came in while the part file was written is a conflict too.
    const now = await attrsAt(side, target);
    if (!now || !sameStamp(stampOf(metaOf(now)), stampOf(meta))) throw new SftpError('changed');
    try { await side.rename(part, target, true); } catch (error) {
      if (error instanceof SftpError && error.keepPart) {
        partExists = false; // the only copy of the new text: it stays
        return { kind: 'stranded', part, aside: await findAside(side, target) };
      }
      throw error;
    }
    partExists = false;
    let after = await attrsAt(side, target).catch(() => null);
    if (after && mode !== undefined && typeof after.mode === 'number' && (after.mode & 0o7777) !== mode && !warnings.some((w) => w.kind === 'mode')) {
      try { await chmod(side, target, mode); after = (await attrsAt(side, target).catch(() => null)) ?? after; } catch { /* checked below */ }
      if (typeof after.mode === 'number' && (after.mode & 0o7777) !== mode) warnings.push({ kind: 'mode', mode });
    }
    // Not read back: no stamp, so the next save compares the text instead of failing on a made-up one.
    const stamp: RemoteStamp | null = after ? { ...stampOf(metaOf(after)), hash: sha256(output), readAt: Date.now() } : null;
    return { kind: 'saved', stamp, warnings };
  } finally {
    // An early return or failure: the handle closes before the part file goes.
    if (writer && !writer.writableFinished && !writer.destroyed) { writer.destroy(); await finished(writer).catch(() => undefined); }
    if (partExists) await side.unlink(part).catch(() => undefined);
    side.inflight.release(target, owner);
  }
}
