// The command history of SSH hosts for the terminal autocomplete: what the user ran at each host's shell, ranked by how
// recently and how often. Pure helpers shared by main (the store, <data>/ssh/command_history.json) and the renderer (its
// cache and the capture rules). The history stays on this computer: it is never synced, exported or sent anywhere.
import { isUuid } from './ssh';

export interface CommandHistoryEntry {
  command: string;
  /** Runs counted (a repeat of the line run just before it is not counted, like bash's ignoredups). */
  count: number;
  /** Last run, ms since epoch. */
  lastUsed: number;
}

export const COMMAND_HISTORY_LIMITS = {
  /** Entries kept per host; the lowest ranked one goes first. */
  perHost: 2000,
  /** Characters of one command (a longer line is not kept). */
  command: 1000,
  /** Hosts with a history (the least recently used host's history goes first). */
  hosts: 500,
} as const;

export const COMMAND_HISTORY_VERSION = 1;

/** What Settings > SSH shows of the history file. */
export interface SshHistoryStatus {
  /** Entries kept per host id. */
  counts: Record<string, number>;
  /** The file is from a newer version, not a history file or unreadable: nothing is recorded or cleared, it stays as it is. */
  readOnly: boolean;
  file: string;
}

/** `window.mc.sshHistory` (src/preload); every call is validated in src/main/ssh/commandHistory.ts. */
export interface SshHistoryApi {
  list(hostId: string): Promise<CommandHistoryEntry[]>;
  /** A command the user ran at the host's prompt (it passed captureCommand). */
  record(hostId: string, command: string): void;
  /** One host's history, or every host's (null). */
  clear(hostId: string | null): Promise<{ ok: boolean }>;
  status(): Promise<SshHistoryStatus>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Rank of an entry: more runs count, recent runs count more (a run in the last hour beats twenty a month ago). */
export function frecency(entry: CommandHistoryEntry, now: number): number {
  const age = Math.max(0, now - entry.lastUsed);
  const recency = age < HOUR ? 8 : age < DAY ? 4 : age < 7 * DAY ? 2 : age < 30 * DAY ? 1 : 0.5;
  return (1 + Math.log2(Math.max(1, entry.count))) * recency;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A secret echoed as stars or dots (sudo with pwfeedback, some login prompts). */
const MASKED = /^[*•●·∙]+$/u;

/** Lines the shell would not run as they are: a continuation (`\`, a pipe or `&&` at the end) or an unclosed quote. */
function incomplete(command: string): boolean {
  if (/(?:\\|\||&&)$/.test(command)) return true;
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
    } else if (ch === '\\') i++;
    else if (ch === '"' || ch === "'") quote = ch;
  }
  return quote !== null;
}

/**
 * The text kept for a submitted line, or null when it is not kept: an empty line, one starting with a blank (the user's
 * "do not remember this", like HISTCONTROL=ignorespace), a single character (never worth suggesting; often an answer like
 * `y`), control characters, masked input, an over-long or unfinished line.
 */
export function historyCommand(line: string): string | null {
  if (typeof line !== 'string' || !line || /^\s/.test(line)) return null;
  const text = line.trimEnd();
  if ([...text].length < 2 || text.length > COMMAND_HISTORY_LIMITS.command || CONTROL.test(text) || MASKED.test(text) || incomplete(text)) return null;
  return text;
}

/**
 * What to record for a line submitted with Enter, or null. Only a line that was echoed is ever kept: input typed with echo
 * off (a password at a sudo or ssh prompt) never shows in the buffer, so it never gets here. A repeat of the last entry is
 * not recorded again.
 */
export function captureCommand(line: string | null, ctx: { echoed: boolean; last?: string }): string | null {
  if (!ctx.echoed || line === null) return null;
  const command = historyCommand(line);
  return command && command !== ctx.last ? command : null;
}

/** Adds a run of `command` (most recent first); over the limit the lowest ranked older entry goes. */
export function recordCommand(entries: readonly CommandHistoryEntry[], command: string, now: number, limit: number = COMMAND_HISTORY_LIMITS.perHost): CommandHistoryEntry[] {
  if (entries[0]?.command === command) return entries as CommandHistoryEntry[];
  const old = entries.find((e) => e.command === command);
  const next = [{ command, count: (old?.count ?? 0) + 1, lastUsed: now }, ...entries.filter((e) => e.command !== command)];
  while (next.length > Math.max(1, limit)) {
    let worst = 1;
    for (let i = 2; i < next.length; i++) {
      const a = frecency(next[i], now);
      const b = frecency(next[worst], now);
      if (a < b || (a === b && next[i].lastUsed <= next[worst].lastUsed)) worst = i;
    }
    next.splice(worst, 1);
  }
  return next;
}

function normalizeEntries(raw: unknown): CommandHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CommandHistoryEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const r = value as Record<string, unknown>;
    const command = typeof r.command === 'string' ? historyCommand(r.command) : null;
    if (!command || command !== r.command || seen.has(command)) continue;
    const count = typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 1 ? r.count : 1;
    const lastUsed = typeof r.lastUsed === 'number' && Number.isFinite(r.lastUsed) && r.lastUsed >= 0 ? r.lastUsed : 0;
    seen.add(command);
    out.push({ command, count, lastUsed });
  }
  out.sort((a, b) => b.lastUsed - a.lastUsed);
  return out.slice(0, COMMAND_HISTORY_LIMITS.perHost);
}

/**
 * The hosts of a history file, cleaned (bad entries dropped, duplicates merged, limits applied), the most recently used
 * host last. `newer`: the file comes from a newer app version, `invalid`: it is not a history file at all; both are never
 * written over.
 */
export function normalizeCommandHistory(raw: unknown): { hosts: Map<string, CommandHistoryEntry[]>; newer: boolean; invalid: boolean } {
  const hosts = new Map<string, CommandHistoryEntry[]>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { hosts, newer: false, invalid: true };
  const r = raw as { version?: unknown; hosts?: unknown };
  const newer = typeof r.version === 'number' && r.version > COMMAND_HISTORY_VERSION;
  if (r.hosts === undefined) return { hosts, newer, invalid: false };
  if (!r.hosts || typeof r.hosts !== 'object' || Array.isArray(r.hosts)) return { hosts, newer, invalid: true };
  const list = Object.entries(r.hosts as Record<string, unknown>)
    .filter(([id]) => isUuid(id))
    .map(([id, entries]) => [id, normalizeEntries(entries)] as const)
    .filter(([, entries]) => entries.length > 0)
    .sort((a, b) => a[1][0].lastUsed - b[1][0].lastUsed)
    .slice(-COMMAND_HISTORY_LIMITS.hosts);
  for (const [id, entries] of list) hosts.set(id, entries);
  return { hosts, newer, invalid: false };
}
