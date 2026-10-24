// The typed path of the SFTP path bar (1.0.8): what a path typed or pasted into the bar of a pane means, and the folder-name
// completion while typing. Remote panes are POSIX ("~" is the login folder, relative paths start at the shown folder);
// local panes are POSIX on macOS and Windows paths on Windows (drives, UNC shares, "/" as a separator, "~").
// No DOM or Electron imports: tested in Node.
import { posixNormalize, validRemotePath } from './sftp';
import { DRIVES, validLocalPath, type PathFlavor } from './sftpView';

/** Copied paths often come quoted (Explorer's "Copy as path") or with spaces around them. */
export function cleanPathInput(text: string): string {
  let t = text.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
  return t;
}

/** The typed path starts at the home folder ("~" or "~/..."), so its resolution needs to know it. */
export const needsHome = (text: string): boolean => { const t = cleanPathInput(text); return t === '~' || /^~[\\/]/.test(t); };

const CONTROL = /[\u0000-\u001f]/;

/** "." and ".." resolved; ".." never climbs above the root. */
function resolveParts(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out;
}

/** A typed POSIX path made absolute: "~" is `home`, a relative path starts at `cwd`. null when it cannot be resolved. */
function resolvePosix(text: string, cwd: string | null, home: string | null): string | null {
  const t = cleanPathInput(text);
  if (!t || CONTROL.test(t)) return null;
  let abs: string;
  if (t === '~' || t.startsWith('~/')) { if (!home?.startsWith('/')) return null; abs = `${home}/${t.slice(1)}`; }
  else if (t.startsWith('~')) return null; // another user's home: SFTP cannot expand it
  else if (t.startsWith('/')) abs = t;
  else { if (!cwd?.startsWith('/')) return null; abs = `${cwd}/${t}`; }
  return posixNormalize(abs);
}

/** A path typed into the remote pane: an absolute, normalized POSIX path, or null. Backslashes are refused (never a separator). */
export function resolveRemoteInput(text: string, cwd: string | null, home: string | null): string | null {
  const p = resolvePosix(text, cwd, home);
  return p !== null && validRemotePath(p) ? p : null;
}

// ── Windows ─────────────────────────────────────────────────────────────────

const WIN_BAD = /[<>"|?*]/;

/** A Windows path split into its root ("C:\" or "\\server\share\") and its folders; null when it is no absolute path. */
function splitWindows(path: string): { root: string; parts: string[] } | null {
  const p = path.replace(/\//g, '\\');
  if (p.startsWith('\\\\')) {
    if (/^\\\\[?.]\\/.test(p)) return null; // device paths (\\?\, \\.\)
    const [server, share, ...rest] = p.slice(2).split('\\');
    if (!server || !share) return null;
    return { root: `\\\\${server}\\${share}\\`, parts: rest };
  }
  const drive = /^([A-Za-z]):(.*)$/.exec(p);
  if (!drive) return null;
  return { root: `${drive[1].toUpperCase()}:\\`, parts: drive[2].split('\\') };
}

function joinWindows(root: string, parts: readonly string[]): string {
  const rest = parts.join('\\');
  return rest ? `${root}${rest}` : root;
}

function resolveWindows(text: string, cwd: string | null, home: string | null): string | null {
  let t = cleanPathInput(text).replace(/\//g, '\\');
  if (!t || CONTROL.test(t)) return null;
  if (t === '~' || t.startsWith('~\\')) { if (!home) return null; t = `${home.replace(/\\+$/, '')}\\${t.slice(2)}`; }
  else if (t.startsWith('~')) return null;
  let base: { root: string; parts: string[] } | null;
  if (t.startsWith('\\\\') || /^[A-Za-z]:/.test(t)) base = splitWindows(t);
  else {
    const here = cwd && cwd !== DRIVES ? splitWindows(cwd) : null;
    if (!here) return null;
    // "\folder" is the root of the shown folder's drive (or share).
    base = t.startsWith('\\') ? { root: here.root, parts: t.split('\\') } : { root: here.root, parts: [...here.parts, ...t.split('\\')] };
  }
  if (!base) return null;
  // Names may keep spaces, but no reserved characters and no ":" (alternate data streams) after the drive.
  if (base.parts.some((part) => WIN_BAD.test(part) || part.includes(':'))) return null;
  // Explorer drops trailing dots and spaces of a name ("folder." is "folder"); ".." stays a step up.
  const parts = resolveParts(base.parts.map((part) => (part === '.' || part === '..' ? part : part.replace(/[. ]+$/, ''))));
  return joinWindows(base.root, parts);
}

/** A path typed into the local pane: an absolute path of this computer, or null when it cannot be resolved. */
export function resolveLocalInput(text: string, cwd: string | null, home: string | null, flavor: PathFlavor): string | null {
  const p = flavor === 'win32' ? resolveWindows(text, cwd, home) : resolvePosix(text, cwd, home);
  return p !== null && validLocalPath(p) ? p : null;
}

// ── completion ──────────────────────────────────────────────────────────────

const lastSeparator = (text: string, flavor: PathFlavor): number =>
  flavor === 'win32' ? Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) : text.lastIndexOf('/');

/**
 * The typed text split for completion: `dir` is everything up to and including the last separator (the folder to list,
 * '' = the shown folder), `partial` the start of the name being typed.
 */
export function completionQuery(text: string, flavor: PathFlavor): { dir: string; partial: string } {
  const cut = lastSeparator(text, flavor);
  return cut < 0 ? { dir: '', partial: text } : { dir: text.slice(0, cut + 1), partial: text.slice(cut + 1) };
}

const fold = (s: string, insensitive: boolean) => (insensitive ? s.toLocaleLowerCase() : s);

/**
 * The folder names that complete `partial`: names starting with it (case-insensitive when `insensitive`, otherwise exact
 * matches first and then the ones that differ only in case), hidden ones (".x") only when the partial starts with a dot.
 */
export function completionMatches(names: readonly string[], partial: string, insensitive: boolean, max = 50): string[] {
  const hidden = partial.startsWith('.');
  const pool = names.filter((n) => n !== '.' && n !== '..' && (hidden || !n.startsWith('.')));
  const sort = (list: string[]) => list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const exact = sort(pool.filter((n) => n.startsWith(partial)));
  const loose = sort(pool.filter((n) => !n.startsWith(partial) && n.toLocaleLowerCase().startsWith(partial.toLocaleLowerCase())));
  const out = insensitive ? sort([...exact, ...loose]) : [...exact, ...loose];
  return out.slice(0, max);
}

/** The longest start all `names` share (compared case-insensitively when `insensitive`; the first name's spelling wins). */
export function commonStart(names: readonly string[], insensitive: boolean): string {
  if (!names.length) return '';
  let end = names[0].length;
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < end && i < n.length && fold(n[i], insensitive) === fold(names[0][i], insensitive)) i++;
    end = i;
  }
  return names[0].slice(0, end);
}

/** The separator the text already uses (a Windows path typed with "/" keeps "/"). */
function separatorOf(text: string, flavor: PathFlavor): string {
  if (flavor === 'posix') return '/';
  const cut = lastSeparator(text, flavor);
  return cut >= 0 ? text[cut] : '\\';
}

/** The text with the partial name replaced by `name`; a whole folder name (`done`) gets its separator for the next name. */
export function applyCompletion(text: string, name: string, flavor: PathFlavor, done = true): string {
  const { dir } = completionQuery(text, flavor);
  return `${dir}${name}${done ? separatorOf(text, flavor) : ''}`;
}

/**
 * Tab in the path bar: one match completes the whole folder name (with its separator), several extend the text to the start
 * they share; null when Tab adds nothing (the list of matches is all it can offer).
 */
export function tabCompletion(text: string, matches: readonly string[], flavor: PathFlavor, insensitive: boolean): string | null {
  if (!matches.length) return null;
  if (matches.length === 1) return applyCompletion(text, matches[0], flavor);
  const { partial } = completionQuery(text, flavor);
  const start = commonStart(matches, insensitive);
  return start.length > partial.length ? applyCompletion(text, start, flavor, false) : null;
}

/** The text the path bar shows for editing (the drive list of Windows has no path). */
export const editablePath = (path: string | null): string => (path === null || path === DRIVES ? '' : path);
