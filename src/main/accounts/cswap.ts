// Read-only view of claude-swap's roster (`sequence.json`: e-mail, uuid, organizationUuid per account; no tokens). cswap's
// files are never written, and of its credentials only the file names and times are read (never their content). It only
// decides which saved accounts this app must not renew or swap in (R6, R7).
import { readdir, readFile, stat } from 'fs/promises';
import { dirname, isAbsolute, join } from 'path';
import { compareIdentity, identityFields, type AccountIdentity } from '../../shared/accounts';

export type CswapRoster = { present: false } | { present: true; accounts: AccountIdentity[] | null };

/** Where cswap keeps its roster (claude_swap/paths.py, get_backup_root). */
export function cswapRosterPath(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    let xdg = env.XDG_DATA_HOME?.trim();
    // cswap expands a leading `~` (os.path.expanduser) before the absolute-path check.
    if (xdg === '~' || xdg?.startsWith('~/')) xdg = join(home, xdg.slice(2));
    return join(xdg && isAbsolute(xdg) ? join(xdg, 'claude-swap') : join(home, '.local', 'share', 'claude-swap'), 'sequence.json');
  }
  return join(home, '.claude-swap-backup', 'sequence.json');
}

/** A real roster is a few KB; anything bigger is not read and counts as holding everything. */
export const CSWAP_ROSTER_MAX_BYTES = 1024 * 1024;

export async function readCswapRoster(path: string): Promise<CswapRoster> {
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > CSWAP_ROSTER_MAX_BYTES) return { present: true, accounts: null };
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { present: false } : { present: true, accounts: null };
  }
  try {
    const data: unknown = JSON.parse(text);
    const accounts = typeof data === 'object' && data !== null ? (data as { accounts?: unknown }).accounts : undefined;
    if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) return { present: true, accounts: null };
    return {
      present: true,
      accounts: Object.values(accounts)
        .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null && !Array.isArray(a))
        .map((a) => identityFields({ email: a.email, accountUuid: a.uuid, organizationUuid: a.organizationUuid, org: a.organizationName })),
    };
  } catch { return { present: true, accounts: null }; }
}

/** File timestamps may be coarse (2 s on FAT); a write this close before `since` still counts as after it. */
const MTIME_SLACK_MS = 2_000;

export interface CswapFilesFs {
  readdir(path: string): Promise<string[]>;
  mtimeMs(path: string): Promise<number>;
}
const nodeCswapFs: CswapFilesFs = { readdir: (path) => readdir(path), mtimeMs: async (path) => (await stat(path)).mtimeMs };

/**
 * Whether cswap may have saved this account's tokens at `since` or later. cswap keeps one credentials file per account in
 * `<backup root>/credentials` (`.creds-<n>-<email>.enc`, plus `.prev`) and rewrites it whenever it backs up or resyncs the
 * live login; the files are only listed and their times read, never opened. Anything unclear answers true (conservative):
 * an unreadable roster or folder, an account without an e-mail, or no file of that account (cswap may keep it elsewhere,
 * e.g. a keyring). An account cswap does not list was never saved by it.
 */
export async function cswapWroteSince(rosterPath: string, roster: CswapRoster, identity: AccountIdentity, since: number, fs: CswapFilesFs = nodeCswapFs): Promise<boolean> {
  if (!roster.present) return false;
  if (roster.accounts === null) return true;
  const listed = roster.accounts.filter((entry) => compareIdentity(entry, identity) !== 'different');
  if (!listed.length) return false;
  const emails = [...new Set([identity, ...listed].map((i) => i.email?.trim().toLowerCase()).filter((e): e is string => !!e))];
  if (!emails.length) return true;
  const dir = join(dirname(rosterPath), 'credentials');
  try {
    const mine = (await fs.readdir(dir)).filter((name) => emails.some((email) => name.toLowerCase().includes(`-${email}`)));
    if (!mine.length) return true;
    for (const name of mine) if ((await fs.mtimeMs(join(dir, name))) >= since - MTIME_SLACK_MS) return true;
    return false;
  } catch { return true; }
}

/** cswap may hold a copy of this account's tokens. An unreadable roster holds everything (conservative). */
export function cswapHolds(roster: CswapRoster, identity: AccountIdentity): boolean {
  if (!roster.present) return false;
  if (roster.accounts === null) return true;
  return roster.accounts.some((entry) => compareIdentity(entry, identity) !== 'different');
}
