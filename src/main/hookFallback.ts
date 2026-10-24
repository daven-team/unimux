// Claude Code 2.1.63+ cells post their status hooks as `type: "http"` hooks (1.0.6). Two things can make them vanish without
// an error: a managed `allowedHttpHookUrls` policy that does not allow 127.0.0.1, and a cell that runs an older `claude` than
// the detected one (a shell profile, an alias, an earlier PATH entry). SessionStart stays a curl command in every form, so it
// still arrives. This watch notices a cell that works (output-driven "working") for HTTP_HOOK_GRACE_MS after its SessionStart
// without a single http hook, switches every later Claude spawn back to command hooks and remembers that for this claude
// version (a new version tries http hooks again).
import { readFileSync } from 'fs';
import { atomicWriteFileSync } from './atomicWrite';
import type { ClaudeHookForm } from './hooks';

/** How long a cell may work, after SessionStart, without one http hook before http hooks count as blocked. */
export const HTTP_HOOK_GRACE_MS = 20_000;

interface Watched { sessionStarted: boolean; timer?: ReturnType<typeof setTimeout> }

export interface HttpHookWatchDeps {
  /** The version that fell back (persisted), or null; read once. */
  load: () => string | null;
  save: (version: string) => void;
  /** Called once per app run, when http hooks are found blocked. */
  onFallback: () => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class HttpHookWatch {
  private readonly cells = new Map<string, Watched>();
  /** The cell's claude version at its spawn (what a fallback is remembered for). */
  private readonly versions = new Map<string, string | undefined>();
  private blockedFor: string | null | undefined;
  private blockedNow = false;
  private hinted = false;
  constructor(private readonly deps: HttpHookWatchDeps) {}

  private blocked(version: string | undefined): boolean {
    if (this.blockedNow) return true;
    if (this.blockedFor === undefined) { try { this.blockedFor = this.deps.load(); } catch { this.blockedFor = null; } }
    return this.blockedFor !== null && this.blockedFor === (version ?? '');
  }

  /** The hook form a Claude spawn gets: the version's form, or command hooks once http hooks were found blocked. */
  formFor(form: ClaudeHookForm, version: string | undefined): ClaudeHookForm {
    return form !== 'shell' && this.blocked(version) ? 'shell' : form;
  }

  /** A Claude cell starts (again) with `form`; only http forms are watched. */
  spawned(cellId: string, form: ClaudeHookForm, version: string | undefined): void {
    this.forget(cellId);
    if (form === 'shell') return;
    this.cells.set(cellId, { sessionStarted: false });
    this.versions.set(cellId, version);
  }

  /** A hook of the cell arrived; everything but SessionStart travels as an http hook in the http forms. */
  hook(cellId: string, event: string): void {
    const cell = this.cells.get(cellId);
    if (!cell) return;
    if (event === 'session') { cell.sessionStarted = true; return; }
    // http hooks work for this process: nothing more to watch.
    this.forget(cellId);
  }

  /**
   * The renderer's status of the cell. Output-driven "working" (hooked = false) after SessionStart starts the grace timer;
   * any other status stops it (a menu or a short redraw is not a working agent).
   */
  status(cellId: string, status: string, hooked: boolean): void {
    const cell = this.cells.get(cellId);
    if (!cell) return;
    const working = status === 'working' && !hooked && cell.sessionStarted;
    if (!working) {
      if (cell.timer) { (this.deps.clearTimer ?? clearTimeout)(cell.timer); cell.timer = undefined; }
      return;
    }
    if (cell.timer) return;
    cell.timer = (this.deps.setTimer ?? setTimeout)(() => {
      cell.timer = undefined;
      if (this.cells.get(cellId) !== cell) return;
      this.fallBack(this.versions.get(cellId));
      this.forget(cellId);
    }, HTTP_HOOK_GRACE_MS);
  }

  /** The cell's process is gone. */
  forget(cellId: string): void {
    const cell = this.cells.get(cellId);
    if (cell?.timer) (this.deps.clearTimer ?? clearTimeout)(cell.timer);
    this.cells.delete(cellId);
    this.versions.delete(cellId);
  }

  private fallBack(version: string | undefined): void {
    this.blockedNow = true;
    this.blockedFor = version ?? '';
    try { this.deps.save(version ?? ''); } catch { /* remembered for this run only */ }
    if (this.hinted) return;
    this.hinted = true;
    this.deps.onFallback();
  }
}

/**
 * Claude Code settings files that can carry `allowedHttpHookUrls`: the managed policy, the user's settings and the project's.
 * (Checked with 2.1.310: a list in the user's settings.json blocks every http hook whose URL matches none of its patterns.)
 */
export function claudeSettingsFiles(platform: string, home: string, env: Record<string, string | undefined>, cwd: string): string[] {
  const join = (...parts: string[]) => parts.join(platform === 'win32' ? '\\' : '/');
  const managed = platform === 'win32'
    ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json'), join(env.ProgramData ?? 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')]
    : platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json'] : ['/etc/claude-code/managed-settings.json'];
  const user = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  return [...managed, join(user, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
}

/**
 * Whether the settings (file texts; null = missing) let an http hook post to `url`. No list anywhere allows everything; once
 * a list exists, the URL must match one of the patterns of the lists (`*` matches any run of characters, also `/`).
 */
export function httpHookUrlAllowed(texts: Array<string | null>, url: string): boolean {
  const patterns: string[] = [];
  let listed = false;
  for (const text of texts) {
    if (!text) continue;
    let list: unknown;
    try { list = (JSON.parse(text) as { allowedHttpHookUrls?: unknown } | null)?.allowedHttpHookUrls; } catch { continue; }
    if (!Array.isArray(list)) continue;
    listed = true;
    for (const p of list) if (typeof p === 'string') patterns.push(p);
  }
  if (!listed) return true;
  // Patterns come from settings files (a project's too): a linear glob match, never a regex built from them.
  return patterns.some((p) => p.length <= 2048 && globMatch(p, url));
}

/** `*` matches any run of characters; linear time (greedy with one backtrack point, no regex). */
export function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) { p++; t++; }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = t; }
    else if (star !== -1) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Reads the settings files (small JSON files; a missing or unreadable one counts as absent). */
export function readSettingsTexts(files: string[]): Array<string | null> {
  return files.map((file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } });
}

/** File-backed persistence of the fallback (`{ "claudeVersion": "2.1.310" }`). */
export function hookFallbackFile(file: string): Pick<HttpHookWatchDeps, 'load' | 'save'> {
  return {
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { claudeVersion?: unknown };
        return typeof parsed.claudeVersion === 'string' ? parsed.claudeVersion : null;
      } catch { return null; }
    },
    save: (version) => atomicWriteFileSync(file, JSON.stringify({ claudeVersion: version })),
  };
}
