// What in a repository's own configuration can make git start a program. Pure functions (the scan itself, which has to read files and
// ask git, lives in src/main/git.ts); the keys they return are what the Git panel lists when it asks the user to trust a repository.
import { redactSecrets } from './git';

export interface ConfigEntry { key: string; value: string }

/** `git config --list -z`: "key" LF "value" NUL, a key without a value has no LF. */
export function parseConfigList(stdout: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const lf = record.indexOf('\n');
    entries.push(lf < 0 ? { key: record, value: '' } : { key: record.slice(0, lf), value: record.slice(lf + 1) });
  }
  return entries;
}

const ABSOLUTE_PROGRAM = /^(!|\/|[A-Za-z]:[\\/]|\\\\)/;
const OFF = /^(false|no|off|0)?$/i;
/**
 * A credential helper named without a path runs as the shell command `git credential-<value>`, so anything after the name (`x; calc`,
 * `x $(calc)`) runs too. Only the well-known helpers, with plain `--option[=value]` arguments, are left alone; an empty value only
 * resets the list.
 */
const SAFE_CREDENTIAL_HELPER = /^((manager|manager-core|wincred|osxkeychain|libsecret|gnome-keyring|cache|store)([ \t]+--[A-Za-z][\w-]*(=[\w.:/@~+-]*)?)*)?$/;
const EXEC_KEYS = new Set([
  'diff.external', 'core.hookspath', 'core.sshcommand', 'core.pager', 'core.editor', 'core.askpass', 'core.gitproxy', 'core.worktree',
  'sequence.editor', 'gpg.program', 'gpg.openpgp.program', 'gpg.x509.program', 'gpg.ssh.program', 'uploadpack.packobjectshook',
  'interactive.difffilter', 'include.path',
]);
const EXEC_PATTERNS: RegExp[] = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.(driver|recursivedriver)$/,
  /^remote\..+\.(uploadpack|receivepack|uploadarchive|proxy|vcs)$/,
  /^pager\..+$/,
  /^includeif\..+\.path$/,
  /^protocol\..+\.allow$/,
  /^url\..+\.(insteadof|pushinsteadof)$/,
  /^gpg\..+\.program$/,
];

/** The configuration keys (never the values: they may hold secrets) that can start a program or redirect git to another one. */
export function dangerousConfigKeys(entries: readonly ConfigEntry[]): string[] {
  const found = new Set<string>();
  for (const { key, value } of entries) {
    const k = key.toLowerCase();
    let hit = EXEC_KEYS.has(k) || EXEC_PATTERNS.some((pattern) => pattern.test(k));
    if (k === 'core.fsmonitor') hit = !OFF.test(value.trim());
    else if (k === 'protocol.allow') hit = true;
    else if (/^credential(\..+)?\.helper$/.test(k)) hit = ABSOLUTE_PROGRAM.test(value.trim()) || !SAFE_CREDENTIAL_HELPER.test(value.trim());
    else if (/^submodule\..+\.update$/.test(k)) hit = value.trim().startsWith('!');
    if (hit) found.add(redactSecrets(key));
  }
  return [...found].sort();
}

/** Driver names an attributes file hands out: `*.png filter=lfs diff=lfs` gives filter=lfs and diff=lfs. */
export function attributeDrivers(text: string): Array<{ kind: 'filter' | 'diff' | 'merge'; name: string }> {
  const out: Array<{ kind: 'filter' | 'diff' | 'merge'; name: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    for (const m of trimmed.matchAll(/(?:^|\s)(filter|diff|merge)=([^\s]+)/g)) out.push({ kind: m[1] as 'filter' | 'diff' | 'merge', name: m[2] });
  }
  return out;
}

const DRIVER_KEYS: Record<'filter' | 'diff' | 'merge', string[]> = { filter: ['clean', 'smudge', 'process'], diff: ['textconv', 'command'], merge: ['driver'] };

/** Attribute references (`filter=lfs`) to drivers that some configuration (any scope) defines with a program. */
export function configuredAttributeDrivers(attributes: ReadonlyArray<{ kind: 'filter' | 'diff' | 'merge'; name: string }>, all: readonly ConfigEntry[]): string[] {
  const defined = new Set(all.map((e) => e.key.toLowerCase()));
  const found = new Set<string>();
  for (const { kind, name } of attributes) {
    const lower = name.toLowerCase();
    if (DRIVER_KEYS[kind].some((variable) => [...defined].some((key) => key === `${kind}.${lower}.${variable}`))) found.add(`.gitattributes: ${kind}=${name}`);
  }
  return [...found].sort();
}
