// The current folder a remote shell reports (0.9.8, "Otwórz SFTP tutaj"): OSC 7 ("file://host/path", percent-encoded) and
// OSC 9;9 (ConEmu / oh-my-posh) with a POSIX path. Pure: no DOM, tested in Node. The result is a normalized absolute POSIX
// path, or null for anything that is not one (a Windows path, a relative path, a broken escape, control characters).
import { posixNormalize, validRemotePath } from './sftp';

const MAX_PAYLOAD = 8192;

function remotePath(raw: string): string | null {
  if (!raw.startsWith('/') || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const path = posixNormalize(raw);
  return validRemotePath(path) ? path : null;
}

/** The payload of OSC 7 (what follows "7;"): "file://host/path" or "file:///path"; the host part is ignored. */
export function parseOsc7(payload: string): string | null {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) return null;
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(payload.trim());
  if (!match || !match[2]) return null;
  // The query and fragment of a URL are never part of a folder (an unencoded "?" or "#" is not valid in file URLs anyway).
  const encoded = match[2].replace(/[?#].*$/, '');
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); } catch { return null; }
  return remotePath(decoded);
}

/** The path of OSC 9;9 (what follows "9;9;"), possibly quoted. Only POSIX paths count: a remote shell has no "C:\". */
export function parseOsc99(path: string): string | null {
  if (typeof path !== 'string' || path.length > MAX_PAYLOAD) return null;
  let p = path.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return remotePath(p);
}
