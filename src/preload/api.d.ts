import type { HookEvent, HookInfo } from '../shared/status';
import type { CellStatus, StatusReason } from '../shared/status';
import type { CliId, CliStatus, CliStatusMap, InstallMethod } from '../shared/cliStatus';
import type { InstallOptions, InstallRequest, InstallStartResult, InstallState } from '../shared/cliInstall';
import type { AgentRuntimeStatus, AutomationInput, AutomationOperation, McpInfo } from '../shared/automation';
import type { StateEdit, StateSnapshot } from '../shared/stateEdits';
import type { StateAck, StateChange } from '../shared/statePatch';
import type { AppPlatform } from '../shared/platform';
import type { ChangelogResult } from '../shared/changelog';
import type { AlertEventId } from '../shared/alerts';
import type { UsageState } from '../shared/usage';
import type { MonitorSample } from '../shared/monitor';
import type { ConvQuery, ConvSearchResult, ConvTranscript } from '../shared/convSearch';
import type { ContextUsage } from '../shared/contextUsage';
import type { AdoptCopyResult, LoginRequest, LoginState, SwapResult } from '../shared/accounts';
import type { ReplaceRequest, ReplaceResult, SearchOptions, SearchResult } from '../shared/search';
import type { CreateResult, DeleteResult, FileOpProgress, FileOpRequest, FileOpResult, RenameResult } from '../shared/fileOps';
import type { GitApi } from '../shared/git';
import type { GithubApi } from '../shared/github';
import type { SshApi, SshPrompt, SshSessionState, SshVaultInfo } from '../shared/ssh';
import type { LocalFilesApi, SftpApi, SftpSessionState } from '../shared/sftp';
import type { DbApi, DbPrompt, DbSessionState, DbVaultInfo } from '../shared/db';
import type { SshHistoryApi } from '../shared/commandHistory';
import type { DetachedTarget, DetachedWork, OpenInMain } from '../shared/detached';
import type { WaitMark } from '../shared/waiting';

export type DetachResult = { ok: true; id: string } | { ok: false; error: string };
import type { AppState, CellSession, Profile, ProjectDirectory, ProjectFilePreview, SessionInfo, UpdateState, Worktree, WorktreeInspection, WorktreeInspectResult, WorktreeRemoveResult } from '../shared/types';

export type { SessionInfo };

export interface SpawnCellRequest {
  /** Start although the CLI is known to be missing ("Uruchom mimo to"). */
  force?: boolean;
  cellId: string;
  cwd: string;
  cols: number;
  rows: number;
  profile: Profile;
  mode: 'new' | 'resume';
  sessionId?: string;
  sessionConfirmed?: boolean;
  /** First prompt for a new conversation. */
  startupPrompt?: string;
}

export interface McApi {
  platform: AppPlatform;
  loadState(): Promise<AppState>;
  loadSnapshot(): Promise<StateSnapshot>;
  applyStateEdit(edit: StateEdit): Promise<StateAck>;
  getMcpInfo(): Promise<McpInfo>;
  /** Starts the MCP server again when it is not running (it failed to start); answers with the new info. */
  retryMcp(): Promise<McpInfo>;
  automation<K extends AutomationOperation>(operation: K, input: AutomationInput<K>): Promise<unknown>;
  /** `cliMissing` = the profile's CLI is not installed: nothing was spawned. */
  spawnCell(req: SpawnCellRequest): Promise<{ ok: true } | { ok: false; error: string; cliMissing?: CliId; cliStatus?: CliStatus }>;
  /** Detected Claude Code / Codex binaries (may still be empty while the first scan runs; `cli:changed` follows). */
  cliStatus(): Promise<CliStatusMap>;
  /** Forgets cached results and detects again (one CLI or both). */
  cliRecheck(id?: CliId): Promise<CliStatusMap>;
  /** Opens the official documentation of the CLI (address comes from an allow-list in main). */
  cliOpenDocs(id: CliId): void;
  /** Install methods that can work on this machine, each with the exact command (nothing runs). Null for an unknown CLI. */
  installOptions(cli: CliId): Promise<InstallOptions | null>;
  /** Starts the guided install in a visible terminal; main validates {cli, method} against its allow-list. */
  startInstall(request: InstallRequest): Promise<InstallStartResult>;
  cancelInstall(sessionId: string): void;
  /** The install that is running now (a window opened while it runs attaches to it), or null. */
  installCurrent(): Promise<{ sessionId: string; ptyId: string; cli: CliId; method: InstallMethod; command: string } | null>;
  killCell(cellId: string): void;
  killCellAndWait(cellId: string): Promise<void>;
  /** Binds the freshest unclaimed Codex session in `cwd` to the cell (emits cell:session). */
  bindCodexSession(cellId: string, cwd: string): Promise<string | null>;
  /** How full the context window of the cell's conversation is (read now); null when unknown. Later changes come as cell:context. */
  contextUsage(cellId: string): Promise<ContextUsage | null>;
  aliveCells(): Promise<string[]>;
  /** The Monitor panel: one process sample (null for a refused sender). */
  monitorSample(): Promise<MonitorSample | null>;
  /** Kills one process of a cell's tree; false when it is not one (or is gone). */
  monitorKill(pid: number): Promise<boolean>;
  /** True only for the first renderer load of this app run (later loads and reloads get false). */
  claimAppStart(): Promise<boolean>;
  reportCellStatus(cellId: string, status: CellStatus, reason?: StatusReason, hooked?: boolean): void;
  /** True while quitting must ask first (an agent is working and the confirmation is on): main then sends 'app:confirm-quit'. */
  setQuitGuard(ask: boolean): void;
  /** The answer to 'app:confirm-quit': 'asking' at once (the dialog is open), then 'quit' or 'cancel'. */
  answerQuit(answer: 'asking' | 'quit' | 'cancel'): void;
  pickFolder(): Promise<string | null>;
  /** Native dialog for an own alert sound; null when cancelled. */
  pickSoundFile(): Promise<string | null>;
  /** Bytes of the saved own sound of an alert event (main reads the path from settings); `data` is null when `knownKey` is still current. */
  loadAlertSound(event: AlertEventId, knownKey?: string): Promise<{ ok: true; key: string; data: Uint8Array | null } | { ok: false }>;
  systemBeep(): void;
  pathExists(path: string): Promise<boolean>;
  /** Folder, file or gone, for absolute paths (files dropped from the system file manager). */
  pathKinds(paths: string[]): Promise<Array<'dir' | 'file' | null>>;
  /** The absolute path of a File from a drop ('' when it has none). */
  pathForFile(file: File): string;
  listProjectDirectory(projectId: string, relativePath?: string): Promise<ProjectDirectory>;
  /** Listings of many folders at once (empty when the project is gone). */
  listProjectDirectoryBatch(projectId: string, relativePaths: string[]): Promise<Record<string, ProjectDirectory>>;
  /** `large`: the editor's read (images, Parquet tables and up to 8 MB of text); without it the small preview. */
  readProjectFile(projectId: string, relativePath: string, large?: boolean): Promise<ProjectFilePreview>;
  /** Size and modification time (null when unreadable): open tabs read a file again only when these changed. */
  statProjectFile(projectId: string, relativePath: string): Promise<{ size: number; mtimeMs: number } | 'gone' | null>;
  listProjectDirectories(projectId: string): Promise<{ ok: true; paths: string[]; truncated: boolean } | { ok: false; error: string }>;
  searchProject(projectId: string, options: SearchOptions): Promise<SearchResult>;
  replaceInProject(projectId: string, request: ReplaceRequest): Promise<ReplaceResult>;
  renameProjectEntry(projectId: string, relativePath: string, newName: string): Promise<RenameResult>;
  createProjectEntry(projectId: string, directory: string, name: string, kind: 'file' | 'directory'): Promise<CreateResult>;
  deleteProjectEntries(projectId: string, relativePaths: string[]): Promise<DeleteResult>;
  transferProjectEntries(projectId: string, request: FileOpRequest): Promise<FileOpResult>;
  cancelFileOp(opId: string): void;
  /** code 'conflict': the file on disk is not `expectedText` any more (nothing written). */
  writeProjectFile(projectId: string, relativePath: string, text: string, expectedText: string): Promise<{ ok: true } | { ok: false; error: string; code?: 'conflict' }>;
  listSessions(projectPath: string): Promise<SessionInfo[]>;
  /** Search across every Claude Code and Codex conversation (1.0.9) and the read-only transcript of a result. */
  conversations: {
    search(query: ConvQuery): Promise<ConvSearchResult>;
    transcript(file: string): Promise<ConvTranscript>;
  };
  isGitRepo(path: string): Promise<boolean>;
  createWorktree(projectPath: string, name: string): Promise<Worktree>;
  /** What removing the worktree would lose (uncommitted files, commits the project's HEAD cannot reach). */
  inspectWorktree(projectPath: string, wt: Worktree): Promise<WorktreeInspectResult>;
  /** Main refuses (code 'unsafe', with the new inspection) when work would be lost beyond `confirmed` (what the user accepted). */
  removeWorktree(projectPath: string, wt: Worktree, deleteBranch: boolean, confirmed?: WorktreeInspection): Promise<WorktreeRemoveResult>;
  /** The Git panel (see shared/git.ts): every call names a project; main resolves the folder and validates the request. */
  git: GitApi;
  /** "Publish to GitHub" of the Git panel (see shared/github.ts): the sign-in and the publishing; tokens never leave main. */
  github: GithubApi;
  ssh: SshApi;
  /** SFTP sessions and transfers (0.9.8); progress arrives on the 'mc:sftp-port' MessagePort (SftpPortMessage). */
  sftp: SftpApi;
  /** Database connections and sessions (1.0.0); result rows arrive on the 'mc:db-port' MessagePort (DbPortMessage). */
  db: DbApi;
  /** The CA certificate file of a connection (native dialog); null when cancelled. */
  dbPickCaFile(): Promise<string | null>;
  /** Saves an exported result where the user picks in the save dialog. */
  dbExport(name: string, text: string): Promise<{ ok: boolean; path?: string; cancelled?: boolean }>;
  /** Notes (1.0.7): pasted images kept in the data folder (resolves to the image name, null when refused) and a note saved as a file. */
  notes: {
    saveImage(bytes: Uint8Array, mime: string): Promise<string | null>;
    /** The image as a data URL, null when it is gone or the name is not one the app gave. */
    readImage(name: string): Promise<string | null>;
    exportFile(name: string, text: string): Promise<{ ok: boolean; path?: string; cancelled?: boolean }>;
  };
  /** The local pane of the SFTP view: any folder, drives, home, new folder, rename, trash, show in Explorer/Finder. */
  localFs: LocalFilesApi;
  /** The command history of SSH hosts for the terminal autocomplete (kept by main on this computer only). */
  sshHistory: SshHistoryApi;
  /**
   * An OS notification; a click shows the window and `cellId`. 1.0.9: `actions` 'answer' (with the cell's permission `token`)
   * offers Zezwól / Odrzuć / Pokaż, 'show' only Pokaż (when the setting is on).
   */
  notify(n: { title: string; body: string; cellId: string; actions?: 'answer' | 'show'; token?: string }): void;
  /** 1.0.9: an answer from a notification could not be typed (the cell changed): show the window and the cell instead. */
  showCell(cellId: string): void;
  /** 1.1.1: shows a sample limit warning (the "Test" button of the limit warnings). */
  testLimitAlert(): void;
  /** 1.0.9: an agent needs the user: flash this window's taskbar button / bounce the Dock icon if the window is not focused. */
  flashAttention(): void;
  openExternal(url: string): void;
  openPath(path: string): void;
  revealPath(path: string): void;
  openInEditor(path: string): void;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): void;
  /** A copied private key: main clears the clipboard after a minute (or on quit) if it still holds this text. False when refused. */
  clipboardWriteSecret(text: string): Promise<boolean>;
  /** Startup timing (startup.log): the renderer finished booting or showed the first terminal output. */
  startupMark(name: 'renderer-boot' | 'first-output'): void;
  /** An error of the renderer for main's crash.log (rate-limited and cut there). `kind`: lowercase letters and dashes. */
  reportError(kind: string, message: string, stack?: string): void;
  windowsBuild: number;
  getUpdate(): Promise<UpdateState & { currentVersion: string }>;
  checkUpdates(): Promise<void>;
  installUpdate(): void;
  openReleases(): void;
  getChangelog(force?: boolean): Promise<ChangelogResult>;
  getUsage(): Promise<UsageState>;
  refreshUsage(): Promise<UsageState>;
  /** `error: 'backup'` names the outgoing main account in `email`; `readOnly`: accounts.json cannot be read safely (no Claude login starts). */
  startLogin(request: LoginRequest): Promise<{ ok: true; sessionId: string; ptyId: string } | { ok: false; error: string; email?: string }>;
  cancelLogin(sessionId: string): void;
  /** `readOnly`: accounts.json cannot be read safely, nothing was removed. */
  removeAccount(id: string): Promise<{ ok: boolean; error?: 'busy' | 'pending' | 'readOnly' | 'live' }>;
  makeMainAccount(id: string): Promise<SwapResult>;
  /** "Renew this copy in unimux": a saved copy cswap also lists becomes the app's own login (validated in the main process). */
  adoptAccountCopy(id: string): Promise<AdoptCopyResult>;
  /** True while an interrupted swap is unresolved (swaps are blocked). Also pushed on the 'accounts:swapPending' channel. */
  swapPending(): Promise<boolean>;
  /** `locked`: the recovery of an interrupted activation waits for Claude Code's locks and is retried automatically. */
  clearSwapPending(): Promise<{ ok: boolean; error?: 'locked' }>;
  /** Hides a notice about the saved accounts (the state is pushed again on 'usage:state'). */
  dismissAccountNotice(id: string): Promise<void>;
  /** 1.0.6: tabs in their own window (main/detachedWindows.ts). Documents are FileDocument objects of the renderer. */
  detach: {
    /** From the main window: the tab goes to a new window (on another display when there is one). */
    open(target: DetachedTarget, docs?: unknown[]): Promise<DetachResult>;
    /** From the main window, at the end of a tab drag: a new window under the cursor, unless it is over the main window. */
    dropOutside(target: DetachedTarget, docs?: unknown[]): Promise<DetachResult>;
    /** In a detached window: the documents handed over for it (once). */
    take(): Promise<unknown[]>;
    /** In a detached window: back into the main window (`overMain`: only when the cursor is over it). */
    attach(docs?: unknown[], overMain?: boolean): Promise<boolean>;
    /** In a detached window: its tab was closed there; the window goes and nothing returns. */
    dismiss(): Promise<boolean>;
    /** From the main window: asks a detached window to give its tab back. */
    requestAttach(id: string): void;
    focus(id: string): void;
    /** 1.0.8, in a detached window: its unsaved database work (null: none), counted by the main window's quit question. */
    work(work: DetachedWork | null): void;
    /** 1.0.8, in the main window: what the detached windows reported (after a reload). */
    works(): Promise<Array<{ id: string; work: DetachedWork }>>;
    /** 1.0.8, in a detached window: a new database or Redis tab opens in the main window. */
    openInMain(request: OpenInMain): void;
    /** 1.0.8, in a closing detached window: it needs longer to give its tab back (a question is open); main waits. */
    stay(): void;
    /** 1.0.9, from any window: what one of its cells waits for (null: nothing any more); main passes a detached window's on. */
    wait(cellId: string, mark: WaitMark | null): void;
    /** 1.0.9: the waits main kept (the main window: every cell's; a detached window: its own cells'). */
    waits(): Promise<Array<{ cellId: string; mark: WaitMark }>>;
    /** 1.0.9, in a detached window: "next / previous waiting cell" (the main window picks the cell). */
    waitStep(dir: 1 | -1): void;
    /** 1.0.9, from the main window: shows a cell in whichever window has it (that window comes up and focuses it). */
    revealCell(cellId: string): void;
  };
  /** In a detached window: it is being closed, its tab goes back (detach.attach). */
  on(channel: 'detach:closing', cb: () => void): () => void;
  /** In the main window: a detached tab came back (its running cells, or its documents). */
  on(channel: 'detach:returned', cb: (back: { id: string; target: DetachedTarget; docs: unknown[]; alive: string[] }) => void): () => void;
  /** In the main window: the status of a cell shown in a detached window. */
  on(channel: 'detach:status', cb: (cellId: string, status: CellStatus) => void): () => void;
  /** 1.0.8, in the main window: a detached window's unsaved database work changed (null: none or gone). */
  on(channel: 'detach:work', cb: (id: string, work: DetachedWork | null) => void): () => void;
  /** 1.0.8, in the main window: a detached window opens a tab here. */
  on(channel: 'detach:openInMain', cb: (request: OpenInMain) => void): () => void;
  /** 1.0.9, in the main window: what a cell of a detached window waits for (null: nothing any more). */
  on(channel: 'detach:wait', cb: (cellId: string, mark: WaitMark | null) => void): () => void;
  /** 1.0.9, in the main window: "next / previous waiting cell" was pressed in a detached window. */
  on(channel: 'waiting:step', cb: (dir: 1 | -1) => void): () => void;
  on(channel: 'auth:state', cb: (state: LoginState) => void): () => void;
  on(channel: 'install:state', cb: (state: InstallState) => void): () => void;
  on(channel: 'cli:changed', cb: (status: CliStatusMap) => void): () => void;
  /** False while the main window is minimized or hidden (the page itself always counts as visible: no background throttling). */
  on(channel: 'window:shown', cb: (shown: boolean) => void): () => void;
  on(channel: 'cell:restarted', cb: (cellId: string) => void): () => void;
  on(channel: 'cell:hook', cb: (cellId: string, event: HookEvent, info?: HookInfo) => void): () => void;
  on(channel: 'cell:session', cb: (cellId: string, session: CellSession) => void): () => void;
  on(channel: 'cell:context', cb: (cellId: string, usage: ContextUsage | null) => void): () => void;
  on(channel: 'cell:spawnError', cb: (cellId: string, message: string) => void): () => void;
  /** A notice from the main process, already translated (e.g. Claude http hooks found blocked). */
  on(channel: 'app:notice', cb: (text: string) => void): () => void;
  on(channel: 'focus-cell', cb: (cellId: string) => void): () => void;
  on(channel: 'notify:answer', cb: (cellId: string, token: string, answer: 'allow' | 'deny') => void): () => void;
  on(channel: 'ptyhost:crashed', cb: (resumesConversation: boolean) => void): () => void;
  /** The Pty Host crashed too often and is not restarted until the user asks for it (cells show why they do not start). */
  on(channel: 'ptyhost:fatal', cb: () => void): () => void;
  on(channel: 'ssh:session', cb: (state: SshSessionState) => void): () => void;
  on(channel: 'ssh:prompt', cb: (cellId: string, prompt: SshPrompt | null) => void): () => void;
  on(channel: 'ssh:vault:changed', cb: (info: SshVaultInfo) => void): () => void;
  on(channel: 'sftp:session', cb: (state: SftpSessionState) => void): () => void;
  on(channel: 'sftp:prompt', cb: (sessionId: string, prompt: SshPrompt | null) => void): () => void;
  /** The SFTP Host restarted: every SFTP session ended and unfinished transfers are lost (failUnfinished). */
  on(channel: 'sftp:hostCrashed', cb: () => void): () => void;
  on(channel: 'db:session', cb: (state: DbSessionState) => void): () => void;
  on(channel: 'db:prompt', cb: (sessionId: string, prompt: DbPrompt | null) => void): () => void;
  /** The DB Host restarted: every DB session ended (each one also got a 'db:session' with error 'dbHostCrashed'). */
  on(channel: 'db:hostCrashed', cb: () => void): () => void;
  on(channel: 'db:vault:changed', cb: (info: DbVaultInfo) => void): () => void;
  on(channel: 'app:before-quit', cb: () => void): () => void;
  /** The user closes the window or quits while agents work: the renderer asks and answers with answerQuit. */
  on(channel: 'app:confirm-quit', cb: () => void): () => void;
  on(channel: 'update:state', cb: (s: UpdateState) => void): () => void;
  on(channel: 'usage:state', cb: (state: UsageState) => void): () => void;
  /** A limit warning was clicked (1.1.1): open the AI account limits panel. */
  on(channel: 'usage:open', cb: () => void): () => void;
  on(channel: 'accounts:swapPending', cb: (pending: boolean) => void): () => void;
  on(channel: 'state:changed', cb: (change: StateChange) => void): () => void;
  on(channel: 'fs:progress', cb: (progress: FileOpProgress) => void): () => void;
  on(channel: 'automation:start-cells', cb: (cellIds: string[]) => void): () => void;
  /** Pushed when the MCP server info changes (tokens issued or revoked, an agent connected, the server started). */
  on(channel: 'mcp:info', cb: (info: McpInfo) => void): () => void;
  /** Pushed when an agent's runtime status changes: every known cell's status. */
  on(channel: 'automation:statuses', cb: (statuses: Record<string, AgentRuntimeStatus>) => void): () => void;
}

declare global {
  interface Window {
    mc: McApi;
  }
}
