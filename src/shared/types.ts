import type { DetachedWindow } from './detached';
import type { GridLayout } from './layout';
import type { Language } from './languages';
import type { AlertSettings } from './alerts';
import type { UpdateMode } from './updateMode';
import type { AgentRole, AutomationState } from './automation';
import type { BackgroundLoadMode } from './backgroundLoad';
import type { Overrides as ShortcutOverrides } from './shortcuts';
import type { SshCellRef, SshHost } from './ssh';
import type { SshIdentity } from './sshIdentity';
import type { SshThemeId } from './sshThemes';
import type { SshBarItem } from './sshBar';
import type { SftpPlaces } from './sftpView';
import type { DbConnection } from './db';
import type { StripScope } from './workspaceOrder';

export type CliKind = 'claude' | 'codex' | 'shell';
/** A forced path format of a shell cell: Claude (@path), Codex (plain path) or the quoted shell form. */
export type PathMode = 'claude' | 'codex' | 'shell';

export interface Profile {
  id: string;
  name: string;
  cli: CliKind;
  /** Extra CLI arguments, typed verbatim using the selected shell's syntax. */
  args: string;
  color: string;
}

export interface CellSession {
  cli: 'claude' | 'codex';
  id: string;
  /** Explicitly chosen by the user; transcript timestamp guesses cannot authorize delivery. */
  confirmed?: boolean;
}

export interface Worktree {
  path: string;
  /** '' when unknown (an adopted worktree on a detached HEAD). */
  branch: string;
  /** A worktree the cell joined (a resumed conversation), not one unimux created for it: its branch is never deleted. */
  adopted?: boolean;
}

/** What removing a worktree would lose (src/main/worktree.ts inspectWorktree). */
export interface WorktreeInspection {
  /** The folder is still on disk. */
  exists: boolean;
  /** Files with uncommitted changes, untracked ones included (ignored ones not). */
  dirty: number;
  /** Commits of the worktree branch that the project's current HEAD cannot reach. */
  unmerged: number;
  /** Commits reachable from the worktree's HEAD but from no branch, remote or tag (a detached HEAD). */
  detached: number;
  /** The project's current branch (the base of `unmerged`), "HEAD" when detached. */
  base: string;
  /** The worktree's HEAD and the branch tip (commit ids, '' when none): a confirmed removal checks they did not move. */
  head: string;
  tip: string;
}

export type WorktreeInspectResult = { ok: true; inspection: WorktreeInspection } | { ok: false; error: string };

/** 'unsafe': work would be lost and the removal was not forced (nothing removed); 'branch': the worktree is gone, its branch stayed. */
export type WorktreeRemoveResult = { ok: true } | { ok: false; code: 'unsafe' | 'failed' | 'branch'; error: string; inspection?: WorktreeInspection };

export interface Cell {
  id: string;
  profileId: string;
  role?: AgentRole;
  model?: string;
  /** User-given label; without it the header shows the conversation title. */
  name?: string;
  /** Accent color of the cell (header tint + border). */
  color?: string;
  /** Sent to the agent as its first prompt on the next new-conversation start, then cleared. */
  startupPrompt?: string;
  worktree?: Worktree;
  session?: CellSession;
  fontSize?: number;
  /** The user muted this cell's alerts (notification and sound); its status is still shown. */
  muted?: boolean;
  /** Format of paths inserted into a shell cell (drop from the Files tree, "Add to conversation"); absent = detect the agent running in it. */
  pathMode?: PathMode;
  /** Present = an SSH cell: a session to this saved host instead of a local shell (the profile is a shell profile). */
  ssh?: SshCellRef;
  /** 1.0.7: the SSH status bar is hidden in this cell (its right-click menu); Settings > SSH shows it again. */
  sshBarHidden?: true;
}

export interface Tab {
  id: string;
  color?: string;
  name: string;
  layout: GridLayout;
  cells: Cell[];
}

export interface ArchivedTab extends Tab {
  closedAt: number;
}

export type ProjectIcon = { kind: 'emoji'; value: string } | { kind: 'image'; dataUrl: string };

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  icon?: ProjectIcon;
  tabs: Tab[];
  archive: ArchivedTab[];
  activeTabId: string | null;
}

export interface PresetCell {
  color?: string;
  profileId: string;
  role?: AgentRole;
  model?: string;
  worktree: boolean;
  name?: string;
  prompt?: string;
  /** The cell connects to this saved host when the preset is opened (a deleted host gives a local shell). */
  sshHostId?: string;
}

export interface Preset {
  id: string;
  name: string;
  layout: GridLayout;
  cells: PresetCell[];
  projectId?: string;
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
  autoSend: boolean;
  icon?: string;
  color?: string;
  projectId?: string;
  /** Highlighting of the text (shared/codeLanguages.ts); absent = shell. */
  language?: string;
  /** The values last entered for its variables (shared/snippetVars.ts), offered again on the next send. */
  values?: Record<string, string>;
}

/** A note of the Notes panel (1.0.4): a small plain-text page; `projectId` keeps it to one project. */
export interface Note {
  id: string;
  name: string;
  text: string;
  projectId?: string;
  color?: string;
  /** Highlighting of the text (shared/codeLanguages.ts); absent = Markdown with highlighted code blocks. */
  language?: string;
  /** Pinned to the top of the list (1.0.7); absent = not pinned. */
  pinned?: boolean;
  /** Last change of the name or text (ms since the epoch); 0 when unknown. */
  updatedAt: number;
}

export type ShellKind ='pwsh' | 'powershell' | 'cmd' | 'zsh' | 'bash';

export interface Settings {
  /** null until the language is confirmed on first launch. */
  language: Language | null;
  fontSize: number;
  shell: ShellKind;
  lastProfileId: string;
  /** Startup update behaviour (see `UpdateMode`); replaces the former boolean `autoInstallUpdates`. */
  updateMode: UpdateMode;
  /** Show the docked "AI account limits" section in the sidebar. */
  showAiUsage: boolean;
  /** How often the limits are read, in minutes (1, 5 or 15). */
  usageIntervalMinutes: number;
  /** The docked section is folded to one line. */
  usageCollapsed: boolean;
  /** Notifications and sounds for the agent events (finished, needs you, error); replaces the retired `notifications` and `waitingSound*` keys. */
  alerts: AlertSettings;
  /** Which grids start in the background after launch (see shared/backgroundLoad.ts). */
  backgroundLoad: BackgroundLoadMode;
  /** Keyboard shortcuts the user changed: action id to combo (`Ctrl+Shift+E`), or null when the shortcut is switched off (see shared/shortcuts.ts). */
  shortcuts: ShortcutOverrides;
  /** Ask before closing a grid, a cell or the app while a Claude or Codex cell is working ("do not ask again" turns it off). */
  confirmCloseWorking: boolean;
  /** Lines of history each terminal keeps (one of SCROLLBACK_CHOICES, shared/terminalLimits.ts). */
  scrollbackLines: number;
  /** Colour theme of SSH terminals (Settings > SSH); a host may choose its own (shared/sshThemes.ts). */
  sshTheme: SshThemeId;
  /** Command suggestions in SSH terminals and the host command history behind them; only `false` turns them off. */
  sshAutocomplete?: boolean;
  /** Path completion from the server in SSH terminals (1.0.6, remotePaths.ts); only `false` turns it off. */
  sshPathComplete?: boolean;
  /** 1.0.6: SSH cells connected when the app closed connect again at start, into the folder they were in. Off by default. */
  sshRestoreSessions?: boolean;
  /** 1.0.7: the status bar under connected SSH terminals (sshBar.ts); only `false` turns it off. */
  sshStatusBar?: boolean;
  /** 1.0.7: items of the SSH status bar switched off (`false`); absent = shown. */
  sshStatusBarItems?: Partial<Record<SshBarItem, boolean>>;
  /** The top strip shows the tabs of every project ('all', 1.0.0) or only of the active project (shared/workspaceOrder.ts). */
  stripScope: StripScope;
}

export interface AppState {
  version: 1;
  automation: AutomationState;
  projects: Project[];
  activeProjectId: string | null;
  profiles: Profile[];
  presets: Preset[];
  snippets: Snippet[];
  /** The notes of the Notes panel (1.0.4, shared/notes.ts); absent in older files. */
  notes: Note[];
  /** Saved SSH hosts (no secrets: those live in <data>/ssh/vault.json, owned by main). */
  sshHosts: SshHost[];
  /** Saved SSH identities (user name and key reference; their passwords live in the SSH vault). Absent in files before identities. */
  sshIdentities: SshIdentity[];
  /** The SFTP view's last local folder and last remote folder per host (0.9.8). */
  sftp: SftpPlaces;
  /**
   * The order of the top strip (1.0.0): grids of all projects, file tabs, Settings and the SSH view, as keys of
   * shared/workspaceOrder.ts. Absent until the per-project orders of 0.9.x are migrated.
   */
  workspaceOrder?: string[];
  /** Tabs in their own window (1.0.6, shared/detached.ts); written by main only. Absent when none is detached. */
  detachedWindows?: DetachedWindow[];
  /** Saved database connections (1.0.0; no secrets: passwords live in <data>/db/vault.json, owned by main). */
  dbConnections: DbConnection[];
  /** Colours of the connection folders (1.0.3, shared/db.ts normalizeDbGroupColors); a connection shows its folder's. */
  dbGroupColors: Record<string, string>;
  settings: Settings;
  sidebarCollapsed: boolean;
  snippetsOpen: boolean;
  /** The Notes panel is open; it shares the right column (and `snippetsWidth`) with the snippets. */
  notesOpen: boolean;
  sidebarWidth: number;
  snippetsWidth: number;
}

export interface ProjectFileEntry {
  name: string;
  /** Relative to the project root, with forward slashes. */
  path: string;
  kind: 'directory' | 'file' | 'symlink';
}

export type ProjectDirectory =
  | { ok: true; entries: ProjectFileEntry[]; truncated: boolean }
  | { ok: false; error: string };

export type ProjectFilePreview =
  | { kind: 'text'; text: string; size: number; truncated: boolean }
  | { kind: 'image'; mime: string; dataUrl: string; size: number }
  /** A columnar file (Parquet) read by main: the first rows as display strings (null = NULL). */
  | { kind: 'table'; format: 'parquet'; columns: string[]; types: string[]; rows: (string | null)[][]; totalRows: number; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'error'; message: string };

export interface SessionInfo {
  cli: 'claude' | 'codex';
  id: string;
  cwd: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  /** Held in a worktree folder of the project (not the project folder): its branch (or folder name) and whether it still exists. */
  worktree?: { path: string; label: string; branch?: string; exists: boolean };
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'unavailable';
  message?: string;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  version?: string;
  percent?: number;
  /** When the last successful check finished (ms since epoch) and the newest version GitHub reported. */
  checkedAt?: number;
  /** Builds without automatic installation (portable Windows, and a macOS app that cannot replace itself) link to downloads. */
  portable?: boolean;
  url?: string;
}
