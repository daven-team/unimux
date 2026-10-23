// Remote path completion of the SSH autocomplete (1.0.6): which word of the typed command line is a path, what the server
// is asked to list (a POSIX sh script run on an exec channel of the cell's own SSH connection), how its answer is read, which
// entries match and how the chosen one goes back into the line (quoted like a shell would). Also the `cd` typed after an
// app-start reconnect into the folder the session was in. Pure: no DOM, no ssh2, tested in Node.
import { validRemotePath } from './sftp';

/** Entries the server sends at most for one folder (the rest is cut by `head`). */
export const REMOTE_LIST_LIMIT = 500;
/** Matches the popup shows (and Tab cycles through) at most. */
export const PATH_SUGGESTION_LIMIT = 100;
/** Bytes of exec output read at most (a listing of REMOTE_LIST_LIMIT long names fits). */
export const REMOTE_LIST_MAX_BYTES = 256 * 1024;
/** A folder listing is reused this long before it is asked for again (shown meanwhile). */
export const REMOTE_LIST_TTL_MS = 4000;

/** Commands whose arguments are usually files or folders (the word right after them completes even without a slash). */
const FILE_COMMANDS = new Set([
  'cd', 'pushd', 'ls', 'll', 'la', 'dir', 'cat', 'tac', 'less', 'more', 'most', 'head', 'tail', 'vim', 'vi', 'nvim', 'view', 'nano', 'pico',
  'emacs', 'micro', 'joe', 'ed', 'mcedit', 'rm', 'rmdir', 'cp', 'mv', 'ln', 'chmod', 'chown', 'chgrp', 'touch', 'mkdir', 'stat', 'file',
  'du', 'df', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz', 'unxz', 'zcat', 'zless', 'diff', 'cmp', 'md5sum', 'sha1sum',
  'sha256sum', 'wc', 'sort', 'uniq', 'source', '.', 'bash', 'sh', 'zsh', 'python', 'python3', 'perl', 'ruby', 'node', 'php', 'find',
  'tree', 'readlink', 'realpath', 'basename', 'dirname', 'scp', 'rsync', 'install', 'shred', 'truncate', 'hexdump', 'xxd', 'od',
  'strings', 'jq', 'yq', 'bat', 'code', 'chattr', 'lsattr', 'setfacl', 'getfacl', 'tee', 'nl', 'cut', 'awk', 'sed', 'grep', 'egrep', 'fgrep',
]);
/** Commands that take folders only. */
const DIR_COMMANDS = new Set(['cd', 'pushd', 'rmdir']);
/** Words that run the next word as the command. */
const PREFIX_COMMANDS = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'builtin', 'env', 'watch', 'xargs']);

/** The word under the cursor (the line's last one) when it is a path to complete. */
export interface PathToken {
  /** Where the word starts in the line (UTF-16 index). */
  start: number;
  /** The word as the shell reads it (quotes and backslashes removed). */
  value: string;
  /** The quote still open at the end of the word. */
  quote: "'" | '"' | null;
  /** The folder part of `value` up to its last '/' (with it): '' = the shell's current folder; may start with "~/". */
  dir: string;
  /** What follows the last '/': the start of the name to complete. */
  prefix: string;
  /** Only folders make sense here (cd, pushd, rmdir). */
  dirsOnly: boolean;
}

interface Word { start: number; value: string; quote: "'" | '"' | null; unsafe: boolean; escapedEnd: boolean; redirect: boolean }

/** Splits a command line like a POSIX shell's lexer does (enough for completion): words, and the command each one belongs to. */
function lex(line: string): { words: Word[]; command: string | null } | null {
  let words: Word[] = [];
  let cur: Word | null = null;
  let quote: "'" | '"' | null = null;
  let redirect = false;
  const end = () => { if (cur) { words.push(cur); cur = null; } };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else cur!.value += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '\\' && i + 1 < line.length && '$`"\\'.includes(line[i + 1])) { cur!.value += line[++i]; continue; }
      if (ch === '$' || ch === '`') cur!.unsafe = true;
      cur!.value += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') { end(); continue; }
    if (';|&()'.includes(ch)) { end(); words = []; redirect = false; continue; }
    if (ch === '<' || ch === '>') { end(); redirect = true; continue; }
    if (!cur) { cur = { start: i, value: '', quote: null, unsafe: false, escapedEnd: false, redirect }; redirect = false; }
    if (ch === '\\') {
      if (i + 1 >= line.length) { cur.escapedEnd = true; continue; }
      cur.value += line[++i];
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if ('$`*?[]{}!'.includes(ch)) cur.unsafe = true;
    cur.value += ch;
  }
  if (!cur) return null; // the line ends with a separator or a blank: no word is being typed
  const last: Word = cur;
  last.quote = quote;
  // The command of the last word: the first word that is not an assignment or a prefix command (sudo, env ...).
  let command: string | null = null;
  const all = [...words, last];
  for (let i = 0; i < all.length - 1; i++) {
    const w = all[i];
    if (w.redirect || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)) continue;
    const base = w.value.split('/').pop() ?? '';
    if (PREFIX_COMMANDS.has(base)) continue;
    if (w.value.startsWith('-') && i > 0) continue; // an option of a prefix command (sudo -u ...)
    command = base;
    break;
  }
  return { words: all, command };
}

/** The path to complete at the end of `line` (the cursor is at its end), or null when the last word is no path. */
export function pathToken(line: string): PathToken | null {
  if (typeof line !== 'string' || line.length > 4096 || /[\u0000-\u001f\u007f]/.test(line)) return null;
  const lexed = lex(line);
  if (!lexed) return null;
  const word = lexed.words[lexed.words.length - 1];
  const value = word.value;
  if (!value || word.unsafe || word.escapedEnd || value.length > 1024) return null;
  if (value.startsWith('-') || value.startsWith('~') && !value.startsWith('~/')) return null;
  const slash = value.includes('/');
  const commandWord = lexed.command === null && !word.redirect;
  if (commandWord && !slash) return null;
  if (!commandWord && !word.redirect && !slash && !value.startsWith('.') && !FILE_COMMANDS.has(lexed.command ?? '')) return null;
  // An option with a value (--file=..., -I/usr/...) is left to the shell.
  if (/^[A-Za-z0-9_-]*=/.test(value) && !slash) return null;
  const cut = value.lastIndexOf('/') + 1;
  return {
    start: word.start, value, quote: word.quote, dir: value.slice(0, cut), prefix: value.slice(cut),
    dirsOnly: !commandWord && DIR_COMMANDS.has(lexed.command ?? ''),
  };
}

/** One entry of a remote folder. */
export interface RemoteEntry { name: string; dir: boolean }

/** A word in single quotes for POSIX sh (also right for bash, zsh and fish: the path never holds a backslash there). */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The folder for the listing script: "~/" becomes "$HOME"/..., '' stays the shell's current folder. */
function dirArg(dir: string): string {
  if (!dir) return "''";
  if (dir.startsWith('~/')) return `"$HOME"/${shQuote(dir.slice(2))}`;
  return shQuote(dir);
}

/**
 * The script the server runs (`exec sh -s`, the script on stdin, so the login shell's syntax never matters). It finds the
 * cell's interactive shell: the other child of the same sshd session process that has a terminal. When a program runs in
 * the foreground there (vim, a nested ssh, a REPL) the shell's prompt is not the one being typed at: `@busy`, no listing.
 * Then it goes to the shell's folder (`cwd` from OSC 7 when the shell reports one, else the shell's own), prints it, goes to
 * the folder being completed and lists it with `ls -1ApL` (folders get a '/').
 */
export function listScript(req: { dir: string; cwd: string | null; cwdOnly?: boolean }): string {
  const cwd = req.cwd && validRemotePath(req.cwd) ? req.cwd : '';
  return [
    `c=${shQuote(cwd)}`,
    `d=${dirArg(req.dir)}`,
    'p=',
    'for k in $(cat /proc/$PPID/task/*/children 2>/dev/null); do',
    '  [ "$k" = "$$" ] && continue',
    '  case "$(readlink /proc/$k/fd/0 2>/dev/null)" in /dev/pts/*|/dev/tty*) p=$k;; esac',
    'done',
    'if [ -n "$p" ]; then',
    '  s=$(cat /proc/$p/stat 2>/dev/null)',
    '  s=${s##*) }',
    '  set -- $s',
    '  [ -n "$6" ] && [ "$3" != "$6" ] && { echo @busy; exit 0; }',
    '  [ -n "$c" ] || c=$(readlink /proc/$p/cwd 2>/dev/null)',
    'fi',
    '[ -n "$c" ] && cd "$c" 2>/dev/null',
    'echo "@cwd $(pwd)"',
    ...(req.cwdOnly ? ['exit 0'] : [
      'if [ -n "$d" ]; then cd "$d" 2>/dev/null || { echo @nodir; exit 0; }; fi',
      'echo "@dir $(pwd)"',
      `ls -1ApL 2>/dev/null | head -n ${REMOTE_LIST_LIMIT + 1}`,
    ]),
    '',
  ].join('\n');
}

export type RemoteListResult =
  | { ok: true; cwd: string | null; entries: RemoteEntry[]; truncated: boolean }
  | { ok: false; reason: 'busy' | 'nodir' | 'failed' | 'unsupported' | 'timeout' | 'cancelled' | 'gone' };

/** Reads what listScript printed. Lines before the first marker (a chatty .bashrc) are skipped. */
export function parseListing(output: string, cwdOnly = false): RemoteListResult {
  const lines = output.replace(/\r/g, '').split('\n');
  const cwdAt = lines.findIndex((l) => l.startsWith('@cwd '));
  if (lines.some((l) => l === '@busy')) return { ok: false, reason: 'busy' };
  if (cwdAt < 0) return { ok: false, reason: 'failed' };
  const rawCwd = lines[cwdAt].slice(5);
  const cwd = validRemotePath(rawCwd) ? rawCwd : null;
  if (cwdOnly) return { ok: true, cwd, entries: [], truncated: false };
  if (lines.slice(cwdAt + 1).some((l) => l === '@nodir')) return { ok: false, reason: 'nodir' };
  const dirAt = lines.findIndex((l, i) => i > cwdAt && l.startsWith('@dir '));
  if (dirAt < 0) return { ok: false, reason: 'failed' };
  const entries: RemoteEntry[] = [];
  for (const line of lines.slice(dirAt + 1)) {
    if (!line || line === './' || line === '../') continue;
    const dir = line.endsWith('/');
    const name = dir ? line.slice(0, -1) : line;
    if (!name || name.includes('/') || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) continue;
    entries.push({ name, dir });
    if (entries.length > REMOTE_LIST_LIMIT) break;
  }
  const truncated = entries.length > REMOTE_LIST_LIMIT;
  return { ok: true, cwd, entries: truncated ? entries.slice(0, REMOTE_LIST_LIMIT) : entries, truncated };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });

/**
 * The entries that complete `token`: names starting with its prefix (case-sensitive like a shell; any case when nothing
 * matches exactly), hidden ones only when the prefix starts with '.', folders only for cd. Folders first, then in natural
 * order (TEST2 before TEST10). The name already typed in full is no suggestion (a folder still is: its '/' is missing).
 */
export function matchEntries(token: PathToken, entries: readonly RemoteEntry[], limit = PATH_SUGGESTION_LIMIT): RemoteEntry[] {
  const hidden = token.prefix.startsWith('.');
  const usable = entries.filter((e) => (hidden || !e.name.startsWith('.')) && (!token.dirsOnly || e.dir));
  let found = usable.filter((e) => e.name.startsWith(token.prefix));
  if (!found.length && token.prefix) {
    const lower = token.prefix.toLowerCase();
    found = usable.filter((e) => e.name.toLowerCase().startsWith(lower));
  }
  found = found.filter((e) => e.dir || e.name !== token.prefix);
  found.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
  return found.slice(0, limit);
}

/** Characters a bare word must escape with a backslash. */
const SPECIAL = /[\s'"\\$`!*?[\]{}()<>|&;#]/g;

/** `value` written for the shell: in the quote the user opened, else with backslashes (a leading "~/" stays as it is). */
function writeWord(value: string, quote: "'" | '"' | null, close: boolean): string {
  const home = value.startsWith('~/') ? '~/' : '';
  const rest = value.slice(home.length);
  if (quote === "'") return `${home}'${rest.replace(/'/g, `'\\''`)}${close ? "'" : ''}`;
  if (quote === '"') return `${home}"${rest.replace(/["\\$`]/g, '\\$&')}${close ? '"' : ''}`;
  return home + rest.replace(SPECIAL, '\\$&').replace(/^~/, '\\~');
}

/**
 * The line with the path word completed to `name` in its folder: a folder gets its '/' and the quote stays open (the
 * next name follows), a file closes the quote; `partial` (the common start of several names) closes nothing.
 */
export function completeLine(line: string, token: PathToken, name: string, kind: 'dir' | 'file' | 'partial'): string {
  const value = token.dir + name + (kind === 'dir' ? '/' : '');
  return line.slice(0, token.start) + writeWord(value, token.quote, kind === 'file' && token.quote !== null);
}

/** The longest start every name shares (by UTF-16 units, never splitting a surrogate pair). */
export function commonStart(names: readonly string[]): string {
  if (!names.length) return '';
  let end = names[0].length;
  for (const n of names) {
    let i = 0;
    while (i < end && i < n.length && n[i] === names[0][i]) i++;
    end = i;
  }
  if (end > 0 && /[\ud800-\udbff]/.test(names[0][end - 1])) end--;
  return names[0].slice(0, end);
}

/** The next index of a Tab cycle over `count` items (-1 = none chosen yet); Shift+Tab goes back. Wraps around. */
export function cycleIndex(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return step > 0 ? 0 : count - 1;
  return (current + step + count) % count;
}

/** Commands after which the shell's folder may have changed (the restored folder is looked up again). */
export const changesFolder = (line: string): boolean => /(^|[\s;&|(])(cd|pushd|popd|z|j|zi)(\s|$)/.test(line);

/**
 * What is typed into a session reconnected at app start to go back to its last folder: a leading space keeps it out of the
 * shell's history (HISTCONTROL=ignorespace), single quotes work in sh, bash, zsh and fish. Null for anything that is not an
 * absolute folder.
 */
export function restoreCwdInput(cwd: unknown): string | null {
  if (!validRemotePath(cwd) || cwd.length > 1024 || /[\u0000-\u001f\u007f]/.test(cwd)) return null;
  return ` cd ${shQuote(cwd)}\r`;
}

/** A folder listing as the follower gets it: the entries, or null when there is none to offer (busy, missing, refused). */
export type CachedListing = { entries: readonly RemoteEntry[] } | null;

interface CacheSlot { at: number; listing: CachedListing }

/** Results that mean the server does not run the listing at all: after this many in a row a cell stops asking. */
const MAX_FAILURES = 3;
const MAX_SLOTS = 64;

/**
 * The listings of one SSH cell, asked from the server one at a time: a slot younger than `ttl` is reused, an older one is
 * shown while it is asked for again, and while a request runs only the newest wanted folder waits (older ones are dropped,
 * so fast typing never queues work on the server). `fetch` never rejects; `changed` runs when a listing arrived.
 */
export class RemoteDirCache {
  private slots = new Map<string, CacheSlot>();
  private running: string | null = null;
  private waiting: { key: string; dir: string; cwd: string | null } | null = null;
  private failures = 0;
  private generation = 0;

  constructor(
    private readonly fetch: (dir: string, cwd: string | null) => Promise<RemoteListResult>,
    private readonly changed: () => void,
    private readonly now: () => number,
    private readonly ttl = REMOTE_LIST_TTL_MS,
  ) {}

  /** The server refused the listing too often (no exec channel, no `sh`): nothing is asked any more. */
  get disabled(): boolean { return this.failures >= MAX_FAILURES; }

  /** The listing of `dir` (relative to `cwd`, the shell's folder when known): undefined while it is on its way. */
  get(dir: string, cwd: string | null): CachedListing | undefined {
    if (this.disabled) return null;
    const key = `${cwd ?? ''}\0${dir}`;
    const slot = this.slots.get(key);
    if (slot && this.now() - slot.at < this.ttl) return slot.listing;
    this.ask(key, dir, cwd);
    return slot ? slot.listing : undefined;
  }

  /** A command ran (it may have changed the folder or its files): every listing is asked for again. */
  clear(): void {
    this.slots.clear();
    this.waiting = null;
    this.generation++;
  }

  private ask(key: string, dir: string, cwd: string | null): void {
    if (this.running === key) return;
    if (this.running !== null) { this.waiting = { key, dir, cwd }; return; }
    this.running = key;
    const generation = this.generation;
    void this.fetch(dir, cwd).then((result) => {
      this.running = null;
      const stored = generation === this.generation && this.store(key, result);
      const next = this.waiting;
      this.waiting = null;
      if (next && !this.fresh(next.key)) this.ask(next.key, next.dir, next.cwd);
      if (stored) this.changed();
    });
  }

  private fresh(key: string): boolean {
    const slot = this.slots.get(key);
    return !!slot && this.now() - slot.at < this.ttl;
  }

  /** Keeps a result (a cancelled one never: a newer request replaced it); false when nothing was kept. */
  private store(key: string, result: RemoteListResult): boolean {
    if (!result.ok && result.reason === 'cancelled') return false;
    if (!result.ok && (result.reason === 'unsupported' || result.reason === 'failed' || result.reason === 'timeout')) this.failures++;
    else if (result.ok) this.failures = 0;
    this.slots.delete(key);
    this.slots.set(key, { at: this.now(), listing: result.ok ? { entries: result.entries } : null });
    if (this.slots.size > MAX_SLOTS) this.slots.delete(this.slots.keys().next().value!);
    return true;
  }
}
