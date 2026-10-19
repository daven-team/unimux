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

/** The payload of OSC 7 (what follows "7;"): "file://host/path" or "file:///path"; the host is lowercased ('' when absent). */
export function parseOsc7(payload: string): { host: string; path: string } | null {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) return null;
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(payload.trim());
  if (!match || !match[2]) return null;
  // The query and fragment of a URL are never part of a folder (an unencoded "?" or "#" is not valid in file URLs anyway).
  const encoded = match[2].replace(/[?#].*$/, '');
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); } catch { return null; }
  const path = remotePath(decoded);
  return path ? { host: match[1].toLowerCase(), path } : null;
}

/**
 * The folder of an SSH cell's shell, from its reports. The host of the first OSC 7 report is the cell's machine; a report
 * naming another host (the user went on with ssh, su to a container ...) clears the folder, and OSC 9;9 reports (no host) are
 * ignored until the cell's machine reports again. An empty host or "localhost" counts as the cell's machine.
 */
export interface CwdTrack { host: string | null; path: string | null; foreign: boolean }
export const EMPTY_CWD: CwdTrack = { host: null, path: null, foreign: false };

export function trackOsc7(t: CwdTrack, report: { host: string; path: string } | null): CwdTrack {
  if (!report) return t;
  const host = report.host === 'localhost' ? '' : report.host;
  if (!host || t.host === null || host === t.host) return { host: t.host ?? (host || null), path: report.path, foreign: false };
  return { host: t.host, path: null, foreign: true };
}

export function trackOsc99(t: CwdTrack, path: string | null): CwdTrack {
  return !path || t.foreign ? t : { ...t, path };
}

/** The path of OSC 9;9 (what follows "9;9;"), possibly quoted. Only POSIX paths count: a remote shell has no "C:\". */
export function parseOsc99(path: string): string | null {
  if (typeof path !== 'string' || path.length > MAX_PAYLOAD) return null;
  let p = path.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return remotePath(p);
}
