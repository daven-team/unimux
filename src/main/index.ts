import { createHash } from 'crypto';
import { execFile, spawn } from 'child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, powerMonitor, safeStorage, shell, type OpenDialogOptions } from 'electron';
import { createQuitConfirm, isQuitAnswer, sessionEndingNow } from './quitConfirm';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';
import { readFile, rm, stat, writeFile } from 'fs/promises';
import type { SpawnCellRequest } from '../preload/api';
import { cleanEnv } from '../shared/env';
import type { HostToMain } from '../shared/ipc';
import { buildLaunchCommand, type LaunchOptions } from '../shared/profiles';
import { endCellMcp, prepareCellMcp } from './mcpCellConfig';
import type { AppState, Worktree, WorktreeInspection, WorktreeInspectResult } from '../shared/types';
import { appPlatform, normalizeProjectPath } from '../shared/platform';
import { detectLanguage } from '../shared/languages';
import { CHROMIUM_WEBGL_CONTEXTS } from '../shared/terminalLimits';
import { translate, type MessageKey, type MessageParams } from '../shared/i18n';
import { bypassProxyForHooks, HookServer } from './hooks';
import { Monitor } from './monitor';
import { pathExists } from './fsProbe';
import { PromptFiles, pruneCellFiles, removeCellFiles } from './cellFiles';
import { applyDockIcon, windowIcon } from './appIcon';
import { LARGE_VIEW_BYTES, listProjectDirectories, listProjectDirectory, listProjectDirectoryBatch, readProjectFile, statProjectFile, writeProjectFile } from './files';
import { createTrash, registerFileOpsIpc } from './filesIpc';
import { createIpcGuard } from './ipcGuard';
import { closeAllDetached, fromDetachedWindow, initDetachedWindows, relayCellStatus, sendRouted, startDetachedWindows, stateChanged as detachedStateChanged } from './detachedWindows';
import { registerGitIpc } from './gitIpc';
import { Git } from './git';
import { createGithubService } from './github/service';
import { registerGithubIpc } from './github/ipc';
import { replaceInProject, searchProject } from './search';
import type { ReplaceRequest, SearchOptions } from '../shared/search';
import { PtyHostClient } from './ptyHostClient';
import { SftpHostClient } from './sftpHostClient';
import { SftpService } from './sftp/service';
import { createSftpHandlers, registerSftpIpc } from './sftp/ipc';
import { createLocalFiles, registerLocalFilesIpc } from './localFiles';
import { isSftpSessionId } from '../shared/sftp';
import type { SftpHostToMain } from '../shared/sftpHostIpc';
import { DbHostClient } from './dbHostClient';
import { DbService } from './db/service';
import { DbVault } from './db/vault';
import { createDbHandlers, registerDbIpc } from './db/ipc';
import { DB_LIMITS, isDbSessionId } from '../shared/db';
import type { DbHostToMain } from '../shared/dbHostIpc';
import { claudeProjectDirName, findRecentCodexSession, listSessionsAsync } from './sessions';
import { createSaver, flushUntilSaved, loadState, StateUnreadableError } from './store';
import { updateHandoverCommitted, blockUpdateVersion, canInstallNow, checkForUpdates, getUpdateState, handOver, initUpdater, isPortableBuild, isUpdateDownloaded, onUpdateTargetChange, previousMacUpdate, recheckUpdate, signalMacUpdateReady, updateHandoffStarted, updateTarget, RELEASES_URL, startupCheck, startupDownload, updatesEnabled } from './updater';
import { createUpdateUiGuard } from './updateUiGuard';
import { compareVersions, gateSkipVersion, isActiveFailure, parseFailure, runInstallWindow, runStartupGate, shouldGateOnStartup } from './startupGate';
import { createGateWindow, type GateTexts } from './gateWindow';
import { createDialogLimiter, decideUncaught, handoffWatchdogAction, isFromWindow, isLive, safeSend, shouldRelaunchAfterQuit, SHUTDOWN_HARD_LIMIT_MS, withLiveWindow } from './safeWindow';
import { createUpdaterLogger } from './updaterLog';
import { START_BLOCK_MS, abortUpdateWindow, scheduleUpdateCleanup, signalUpdateReady, updateInstalling, waitForUpdateWindowGone } from './updateSplash';
import { createChangelog } from './changelog';
import { refreshClaudeProfile, type RefreshOutcome } from './accounts/refresh';
import { createRefreshLimits } from './accounts/refreshLimits';
import { createTokenFetch } from './accounts/tokenTransport';
import { handleMakeMain } from './accounts/makeMain';
import { AccountsStore } from './accounts/store';
import { dismissAccountNotice, gateFamilyRefresh, gateProfileRefresh, handleAdoptCopy, handleRemoveAccount, loginBlock } from './accounts/guards';
import { registerAccountIpc } from './accountsIpc';
import { createSecretClipboard } from '../shared/sshClipboard';
import { clearPendingSwap, hasPendingSwap, isSwapRunning, isSwapUnresolved, recoverInterruptedSwap, swapIdle, swapPaths, type SwapDeps } from './accounts/swap';
import { QUIT_SWAP_AFTER_CELLS_MS, QUIT_SWAP_WAIT_MS, waitUntilIdle } from './quitWait';
import {
  activateAccount, activationJournalPending, checkActivationTarget, clearPendingActivation, isActivationRecoveryPending, recoverActivationWithRetry,
  recoverInterruptedActivation, startActivationRecoveryRetry, type ActivateDeps,
} from './accounts/activate';
import { backupLiveBeforeLogin, reconcileLive, reconcileWhenIdle, resyncOutgoingWhenIdle, type ReconcileDeps } from './accounts/reconcile';
import { resyncActiveBackup } from './accounts/resync';
import { accountsPanelInfo, claudeRefs } from './accounts/refs';
import { cswapRosterPath, readCswapRoster, type CswapRoster } from './accounts/cswap';
import { readManagedIdentity } from './accounts/identity';
import { migrateAccounts, type MigrationDeps } from './accounts/migrate';
import { LoginManager } from './auth/login';
import { identityRewritten, restoreProfile, snapshotProfile } from './auth/profileSnapshot';
import { custodyOf, identityFields, type AccountIdentity, type LoginRequest } from '../shared/accounts';
import { claudeCredentialsStamp, profileSource, readClaudeCredentials, readClaudeIdentity, readCodexCredentials, readLiveClaudeIdentity, systemCredentialSource } from './usage/credentials';
import { fetchClaude, fetchCodex, type FetcherDeps } from './usage/fetchers';
import { UsageService } from './usage/service';
import { MAIN_ACCOUNTS } from '../shared/usage';
import type { UpdateStrings } from '../shared/updateProgress';
import { createWorktree, currentBranch, inspectWorktree, isGitRepo, removeWorktree } from './worktree';
import { StateController } from './stateController';
import { SshCoordinator } from './ssh/coordinator';
import { createSshHandlers, readKeyFileFromDisk, registerSshIpc } from './ssh/ipc';
import { CommandHistoryStore, registerCommandHistoryIpc } from './ssh/commandHistory';
import { KeyDrafts } from './ssh/keys';
import { KnownHostsStore } from './ssh/knownHosts';
import { writePrivateFile } from './ssh/files';
import { electronCipher, SshVault } from './ssh/vault';
import { AutomationService } from './automation';
import { UnimuxMcpServer } from './mcp';
import { queueCodexMessage } from './agentDelivery';
import { CliDetector } from './cliDetect';
import { createCliHandlers, createInstallHandlers } from './cliIpc';
import { InstallManager } from './cliInstall';
import { killProcessTree, runProgram, systemCliDeps } from './cliSystem';
import { INSTALL_PTY_PREFIX } from '../shared/cliInstall';
import { cliForProfile, CLI_NAMES, isCliId, missingCli, resolveExecFile, spawnDecision, type CliId, type CliStatus } from '../shared/cliStatus';
import { automationSchemas, type AutomationOperation, type McpInfo } from '../shared/automation';
import type { StateEdit } from '../shared/stateEdits';
import { stateChange } from '../shared/statePatch';
import { findCell, getProfile, patchSshCell, unlessRestoring } from '../shared/state';
import { resumeForPhase, resumesConversation, type SshSessionState } from '../shared/ssh';
import { automationHintForHook, automationStatusFor } from '../shared/runtimeStatus';
import { followedSession, shouldUpdateCellSession } from '../shared/sessionTrack';
import type { CodexNotice } from '../shared/codexHooks';
import { isSoundFile, SOUND_EXTENSIONS } from '../shared/sound';
import { loadEventSound } from './alertSound';
import { notificationOptions } from './notifyOptions';
import { migrateDataDir } from './dataDirMigration';
import { updateWindowAlive } from './updateRuntime';
import { atomicWriteFileSync } from './atomicWrite';
import { defaultState } from '../shared/state';
import { createReloadLimiter, createReportLimiter, describeError, rendererReport, trimNotifications, UNRESPONSIVE_GRACE_MS } from './stability';
import { createStartupLog, createStartupTimer, isRendererMark } from './startupTiming';
import { createStartupGate, spawnWaitsFor } from './startupGates';
import { createAppStartClaim } from './appStartClaim';

// Startup timing: milliseconds since the process started, one line per launch in startup.log (startupTiming.ts).
const startupTimer = createStartupTimer(() => performance.now());
startupTimer.mark('modules-loaded');

// ── crash handling ──────────────────────────────────────────────────────────
// Registered before any other module code runs: a throw below (a locked file, a damaged install) must never leave an invisible
// process behind that holds the single-instance lock, and nothing that fails later may vanish without a trace in a packaged build.

/** crash.log in the data directory, once it is known (a small rolling file, like updater.log). */
let crashLogger: ReturnType<typeof createUpdaterLogger> | null = null;
/** Logging must never throw out of a crash or shutdown handler. */
const crashLog = {
  error: (message: string) => { try { if (crashLogger) crashLogger.error(message); else console.error(message); } catch { /* nothing else to do */ } },
  warn: (message: string) => { try { if (crashLogger) crashLogger.warn(message); else console.warn(message); } catch { /* nothing else to do */ } },
};
/** Set by the last line of this module: an exception before it is a failed start, not a runtime error. */
let moduleLoaded = false;
let superseded = false;
let quitting = false;
/** True while the startup update check owns the screen: closing its window must not quit the app. */
let gating = false;
const allowErrorDialog = createDialogLimiter();

/** Run and debug overrides (MC_DATA_DIR, MC_DEBUG_PORT, MC_OFFSCREEN, MC_HOOK_DEBUG) apply to unpackaged builds only. */
const devEnv = (name: string): string | undefined => (app.isPackaged ? undefined : process.env[name] || undefined);
let startFailing = false;

/** The start failed: say so, and end the process instead of keeping the lock with no window. */
function startupFailed(error: unknown): void {
  if (startFailing) return;
  startFailing = true;
  const detail = describeError(error);
  crashLog.error(`startup failed: ${detail}`);
  if (!superseded) {
    let language = detectLanguage([]);
    try { language = detectLanguage([app.getLocale()]); } catch { /* not ready yet */ }
    const text = error instanceof StateUnreadableError
      ? translate(language, 'Nie można odczytać pliku {path}. Inny program (antywirus, OneDrive, kopia zapasowa) może go blokować. Zamknij go i uruchom unimux ponownie.', { path: error.path })
      : translate(language, 'Nie udało się uruchomić unimux.');
    try { dialog.showErrorBox('unimux', `${text}\n\n${detail}`); } catch { /* no dialog possible */ }
  }
  app.exit(1);
}

// Registering a handler replaces Electron's blocking native error dialog; a dialog open during shutdown
// would keep the process alive while the installer waits for it to exit.
process.on('uncaughtException', (error) => {
  if (!moduleLoaded) { startupFailed(error); return; }
  const detail = describeError(error);
  const decision = decideUncaught(error, quitting || gating ? 'quiet' : 'running');
  crashLog.error(`uncaught exception (${decision}): ${detail}`);
  if (decision !== 'show' || !allowErrorDialog(Date.now())) return;
  void dialog.showMessageBox({ type: 'error', title: 'unimux', message: tr('Wystąpił nieoczekiwany błąd w głównym procesie'), detail }).catch(() => {});
});
// A forgotten promise (a background refresh, a fire-and-forget step) is logged only: no dialog for something nobody waits for.
process.on('unhandledRejection', (reason) => crashLog.error(`unhandled rejection: ${describeError(reason)}`));

// Moves %APPDATA%\ajzakomator (macOS: ~/Library/Application Support/ajzakomator) to `unimux` once, leaving a link behind, before
// anything else touches the data directory. While the previous version's update window still supervises an install the old
// directory stays in place for this run (its files are open and that window polls paths inside it).
const DATA_DIR = migrateDataDir({
  appData: app.getPath('appData'),
  platform: process.platform,
  env: process.env,
  packaged: app.isPackaged,
  busy: (legacy) => updateWindowAlive(join(legacy, 'update')),
  log: (message) => console.warn(message),
}).dataDir;
crashLogger = createUpdaterLogger(join(DATA_DIR, 'crash.log'), { rotateTo: join(DATA_DIR, 'crash.old.log') });
const startupLog = createStartupLog(join(DATA_DIR, 'startup.log'), `${new Date().toISOString()} ${app.getVersion()} ${process.platform}`, startupTimer);
const HOOKS_DIR = join(DATA_DIR, 'hooks');
const PROMPTS_DIR = join(DATA_DIR, 'prompts');
const MCP_DIR = join(DATA_DIR, 'mcp');
const cellFileDirs = { hooks: HOOKS_DIR, prompts: PROMPTS_DIR, mcp: MCP_DIR };
// The shell read the startup prompt when it started the agent; the task text does not stay on disk.
const prompts = new PromptFiles((file) => { void rm(file, { force: true }).catch(() => undefined); });
let promptSeq = 0;
const queuePrompt = (cellId: string, file: string | null) => prompts.queue(cellId, file);
const releasePrompt = (cellId: string) => prompts.release(cellId);
const releaseAllPrompts = () => prompts.releaseAll();
app.setPath('userData', DATA_DIR);
// Matches build.appId, which the installer also stamps on the shortcuts. A run from the repository (npm run dev, a clone of the
// project) gets its own identity: it must never share the taskbar entry (and its icon) with the installed app.
const APP_USER_MODEL_ID = app.isPackaged ? 'com.unimux.app' : 'com.unimux.app.dev';
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

if (devEnv('MC_DEBUG_PORT')) app.commandLine.appendSwitch('remote-debugging-port', devEnv('MC_DEBUG_PORT')!);
// Every cell of a 5x4 grid draws through WebGL: Chromium's default of 16 active contexts would leave the rest on the slow DOM renderer.
app.commandLine.appendSwitch('max-active-webgl-contexts', String(CHROMIUM_WEBGL_CONTEXTS));
// Module code keeps running after app.quit(), so every later step checks `superseded` instead of assuming the exit is immediate.
// The lock is keyed by the userData directory (set above), so a run with MC_DATA_DIR only excludes other runs on the same folder:
// two instances writing one state.json would overwrite each other.
superseded = !app.requestSingleInstanceLock();
// The installer is replacing this build's files right now (the update window is showing it); starting would crash.
if (!superseded && process.platform === 'win32' && app.isPackaged && updateInstalling(START_BLOCK_MS)) superseded = true;
if (superseded) app.exit(0);

// Carry over state from the app's earliest name (MultiCoding) into the final data directory (never from a second instance).
const LEGACY_STATE = join(app.getPath('appData'), 'MultiCoding', 'state.json');
if (!superseded && !devEnv('MC_DATA_DIR') && !existsSync(join(DATA_DIR, 'state.json')) && existsSync(LEGACY_STATE)) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    copyFileSync(LEGACY_STATE, join(DATA_DIR, 'state.json'));
  } catch (error) { crashLog.warn(`legacy state not copied: ${describeError(error)}`); }
}

let win: BrowserWindow | null = null;
/** The first renderer load of this app run, for SSH hosts that reconnect at start (appStartClaim.ts). */
const appStartClaim = createAppStartClaim();
/** The sender check of every IPC channel that changes accounts, logins, usage, SSH data or the secret clipboard (R9). */
// 1.0.6: the windows main created for detached tabs (detachedWindows.ts) count as the app window too.
const fromAppWindow = (event: { sender: unknown; senderFrame?: unknown }): boolean => isFromWindow(win, event) || fromDetachedWindow(event);
/** The same check for every other channel that changes something (0.9.6, ipcGuard.ts); pure reads stay on ipcMain. */
const { guardedHandle, guardedOn } = createIpcGuard(ipcMain, fromAppWindow);
/** SSH sessions: created after app.whenReady() (safeStorage needs it), before the window (startSsh). */
let ssh: SshCoordinator | null = null;
// A second instance never reads (nor backs up) the state: it only hands over to the first one and exits.
// A state.json that stays locked ends the start here (with a message): saving the defaults over it would lose the user's data.
// With "Przywracaj sesje SSH po ponownym uruchomieniu" off, which sessions the last run had open means nothing for this one.
let state: AppState = superseded ? defaultState(appPlatform(process.platform)) : unlessRestoring(loadStateOrFail());
function loadStateOrFail(): AppState {
  try {
    return loadState(DATA_DIR, appPlatform(process.platform), { log: crashLog.warn });
  } catch (error) {
    startupFailed(error);
    throw error; // nothing below may run (and no saver may write) in a start that failed
  }
}
startupTimer.mark('state-loaded');
const tr = (key: MessageKey, params?: MessageParams) => translate(state.settings.language ?? detectLanguage([app.getLocale()]), key, params);
const saver = createSaver(DATA_DIR, { log: crashLog.warn });
const usageDeps: FetcherDeps = {
  credentials: systemCredentialSource(),
  // net.fetch follows the system proxy settings, like the rest of Chromium. Redirects are refused so a bearer token never follows one.
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => net.fetch(String(input), { ...init, redirect: 'error' })) as typeof fetch,
  now: () => Date.now(),
  codexHome: () => process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
  claudeUrl: (!app.isPackaged && process.env.MC_USAGE_CLAUDE_URL) || 'https://api.anthropic.com/api/oauth/usage',
  codexUrl: (!app.isPackaged && process.env.MC_USAGE_CODEX_URL) || 'https://chatgpt.com/backend-api/wham/usage',
  // The usage endpoint counts its limit per client: the app reads as itself, never as Claude Code.
  userAgent: `unimux/${app.getVersion()}`,
};
/** Token renewals: our own headers (no Chromium fingerprint, no Claude Code User-Agent), a persisted backoff after HTTP 429, system proxy only as a fallback. */
const refreshLimits = createRefreshLimits(join(DATA_DIR, 'refresh-limits.json'));
const tokenFetch = createTokenFetch(usageDeps.fetch);
const renewProfile = (dir: string) => refreshClaudeProfile(dir, { fetch: tokenFetch, now: usageDeps.now, limits: refreshLimits, userAgent: `unimux/${app.getVersion()}`, tokenUrl: app.isPackaged ? undefined : process.env.MC_USAGE_CLAUDE_TOKEN_URL });
const accounts = new AccountsStore(join(DATA_DIR, 'accounts'));
/** cswap's roster, read before every poll (R6); `{ present: false }` without cswap. */
let cswapRoster: CswapRoster = { present: false };
/** How long a poll waits for the retry of failed profile restores before it reads the accounts. */
const PARKED_RESTORE_WAIT_MS = 2_000;
const usage = new UsageService({
  accounts: () => [
    ...claudeRefs({ records: accounts.list(), dirOf: (id) => accounts.dirOf(id), live: accounts.live(), cswap: cswapRoster, platform: process.platform }),
    MAIN_ACCOUNTS[1],
  ],
  fetchAccount: (ref) => (ref.provider === 'claude' ? fetchClaude(usageDeps, ref) : fetchCodex(usageDeps)),
  cacheFile: join(DATA_DIR, 'usage-cache.json'),
  credentialsStamp: (ref) => (ref.provider === 'claude' && !ref.configDir ? claudeCredentialsStamp(usageDeps.credentials) : Promise.resolve(null)),
  enabled: () => state.settings.showAiUsage,
  intervalMs: () => state.settings.usageIntervalMinutes * 60_000,
  // Every poll first looks at who is signed in to Claude Code (cswap switch, /login); never while a swap or a login runs.
  // The swap slot is held meanwhile, so a "Set as main" or a recovery can never interleave with the role changes.
  beforeRun: async () => {
    cswapRoster = await readCswapRoster(cswapRosterPath(homedir(), process.env, process.platform));
    // An activation whose recovery found Claude Code's locks busy is retried first; the live login is not reconciled while
    // its journal exists (the live files may be half written).
    if (isActivationRecoveryPending()) await retryActivationRecovery();
    // A re-login whose restore failed earlier is tried again (the card stays set aside until it works). The poll waits for it
    // briefly only: a restore waiting for Claude Code's locks goes on by itself instead of delaying every account's read.
    // A poll already running when the app quits (usage.stop() does not abort it) starts no further account work.
    if (quitting) return;
    await login.retryParkedRestores(PARKED_RESTORE_WAIT_MS).catch(() => undefined);
    if (quitting) return;
    // During a main login the roles stay as they are, but the outgoing live login keeps being backed up.
    if (login.isMainActive()) await resyncOutgoingWhenIdle(liveGuard(), reconcileDeps()).catch(() => null);
    else await reconcileIdle();
  },
  watchLive: true,
  notices: () => accounts.notices(),
  // An unreadable accounts.json is explained in the panel; set-aside cards are listed with what to do about them.
  accountsInfo: () => (accounts.readOnly()
    ? { accountsReadOnly: join(DATA_DIR, 'accounts', 'accounts.json') }
    : accountsPanelInfo(accounts.list(), login.parkedIds())),
  liveEmail: () => accounts.live()?.email,
});
/** Finds Claude Code / Codex even when the app's own PATH lacks them (GUI launch on macOS, installer run after start on Windows). */
const cliDetector = new CliDetector(systemCliDeps({
  disableRegistry: !app.isPackaged && process.env.MC_CLI_NO_REGISTRY === '1',
  shell: () => state.settings.shell,
  // Unpackaged builds only: a script dot-sourced instead of the real PowerShell profile (UI checks must not run the user's profile).
  probeProfile: !app.isPackaged ? process.env.MC_CLI_PROBE_PROFILE || undefined : undefined,
}));
/** How long a spawn may wait for a detection before it proceeds anyway (unknown never blocks). */
const CLI_WAIT_MS = 7000;
const execText = async (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> => {
  // `claude` / `codex` run from where they were detected, with a PATH that has their directory.
  const cli = isCliId(command) ? command : undefined;
  const status = cli ? await cliDetector.get(cli, { waitMs: CLI_WAIT_MS }).catch(() => undefined) : undefined;
  const file = resolveExecFile(command, status, process.platform);
  const runEnv = await cliDetector.applyEnv(cleanEnv(env), cli);
  return new Promise((resolve) => {
    execFile(file, args, { env: runEnv, timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }, (error, stdout) => resolve(error ? null : stdout));
  });
};
/** Bumped when a cell is killed, so a spawn that was waiting for the detection does not resurrect it. */
const killCount = new Map<string, number>();
const noteKill = (id: string) => killCount.set(id, (killCount.get(id) ?? 0) + 1);
let usageKey = `${state.settings.showAiUsage}:${state.settings.usageIntervalMinutes}`;
const ptyHost = new PtyHostClient();
/** The SFTP Host (0.9.8): started on the first SFTP use, never at app start. */
const sftpHost = new SftpHostClient();
let sftp: SftpService | null = null;
/** The DB Host (1.0.0): started on the first database use, never at app start. */
const dbHost = new DbHostClient();
let db: DbService<AppState> | null = null;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const login = new LoginManager({
  store: accounts,
  spawnPty: (spec) => ptyHost.spawn({
    id: spec.id, cwd: homedir(), cols: 100, rows: 28,
    env: { ...cleanEnv(process.env), ...spec.env }, shell: state.settings.shell, command: spec.command,
  }),
  killPty: (id) => ptyHost.kill(id),
  resetCredentialCache: () => usageDeps.credentials.resetKeychainCache?.(),
  fingerprint: async (provider, configDir) => {
    if (provider === 'claude') {
      const credentials = await readClaudeCredentials(configDir ? profileSource(usageDeps.credentials, configDir) : usageDeps.credentials);
      return credentials ? sha256(credentials.accessToken) : null;
    }
    const credentials = await readCodexCredentials(usageDeps.credentials);
    return credentials?.accessToken ? sha256(credentials.accessToken) : null;
  },
  identity: async (provider, configDir) => {
    if (provider === 'codex') {
      const credentials = await readCodexCredentials(usageDeps.credentials);
      return credentials?.email ? { email: credentials.email } : {};
    }
    if (configDir) return readManagedIdentity(configDir, { source: usageDeps.credentials, exec: execText });
    return readClaudeIdentity(usageDeps.credentials);
  },
  knownIdentities: async () => {
    // An unreadable live login must not hide the saved accounts from the duplicate check.
    const live = await readLiveIdentity().catch(() => null);
    return [
      ...(live ? [{ ...live, live: true }] : []),
      ...accounts.list().filter((a) => custodyOf(a) !== 'quarantined').map((a) => ({ ...identityFields(a), recordId: a.id })),
    ];
  },
  snapshotProfile,
  restoreProfile,
  identityRewritten,
  // The live login is backed up into its record before `claude auth login` replaces it (nothing is dropped); refused
  // (the login does not start) unless that backup is current.
  beforeMainLogin: () => backupLiveBeforeLogin(liveGuard(), reconcileDeps(), {
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ownChange: ownLoginChange,
    ownChangeApplied: () => { ownLoginChange = false; },
  }),
  emit: (s) => send('auth:state', s),
  onChanged: (change) => {
    if (change.ownChange) ownLoginChange = true;
    // The account the login was about is read at once, whatever its read spacing (`claude:main` = the live Claude card).
    const subject = change.provider === 'codex' ? 'codex:main' : change.recordId ? `claude:${change.recordId}` : 'claude:main';
    void (async () => {
      if (change.ownChange) await reconcileIdle().catch(() => false);
      void usage.refresh(true, true, subject);
    })();
  },
  profilesSupported: process.platform !== 'darwin',
  swapRunning: isSwapRunning,
});
const swapDeps = (): SwapDeps => ({
  home: homedir(),
  env: process.env,
  platform: process.platform,
  store: accounts,
  backupDir: join(DATA_DIR, 'accounts', 'swap-backup'),
  now: () => Date.now(),
  // The 0.9.0 exchange is no longer wired; should it ever run, it renews only through the one family rule too.
  refresh: (dir) => familyRenew(dir),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
/** "Set as main" (0.9.1): renewals inside go through gateFamilyRefresh with the roster read for that activation. */
const activateDeps = (): ActivateDeps => ({
  home: homedir(), env: process.env, platform: process.platform, store: accounts,
  backupDir: join(DATA_DIR, 'accounts', 'swap-backup'),
  now: () => Date.now(),
  refresh: (dir) => renewProfile(dir),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  cswap: () => readCswapRoster(cswapRosterPath(homedir(), process.env, process.platform)),
});
const guardDeps = { swapRunning: isSwapRunning, swapPending: () => hasPendingSwap(swapDeps()), swapPendingNow: () => isSwapUnresolved() || isActivationRecoveryPending(), readOnly: () => accounts.readOnly() };
/** The live Claude login's identity (`~/.claude.json`), null when nobody is signed in; throws when the file cannot be read or parsed. */
const readLiveIdentity = () => readLiveClaudeIdentity(usageDeps.credentials);
/** One more try of a version-2 recovery that found Claude Code's locks busy (from the polls and from its own timer). */
async function retryActivationRecovery(): Promise<void> {
  if (quitting) return; // no new account work once the app quits
  const recovered = await recoverInterruptedActivation(activateDeps()).catch(() => 'manual' as const);
  if (recovered !== 'locked') void pushSwapPending();
}
const migrationDeps = (): MigrationDeps => ({
  store: accounts,
  readProfileIdentity: (dir) => readClaudeIdentity(profileSource(usageDeps.credentials, dir)),
  readLiveIdentity,
  readExpiry: async (dir) => (await readClaudeCredentials(profileSource(usageDeps.credentials, dir)))?.expiresAt,
  now: () => Date.now(),
});
/** Live-file signatures of the previous reconcile per record: a backup is only taken of files that read the same twice. */
const resyncSeen = new Map<string, string>();
const reconcileDeps = (): ReconcileDeps => {
  const paths = swapPaths({ home: homedir(), env: process.env });
  return {
    store: accounts,
    readLiveIdentity,
    // macOS keeps the live login in the Keychain: there is no file to back up.
    ...(paths && process.platform !== 'darwin'
      ? { resync: (recordId: string, identity: AccountIdentity) => resyncActiveBackup({ paths, store: accounts, seen: resyncSeen, delay: (ms) => new Promise((r) => setTimeout(r, ms)) }, recordId, identity) }
      : {}),
    now: () => Date.now(),
  };
};
/**
 * Set by a finished main Claude login until a reconcile has run: the record that left the live login was backed up by the
 * app (beforeMainLogin), so it becomes `app`, not `foreign` with a "switched out" notice. Kept until a reconcile actually
 * runs, so a poll that wins the swap slot first applies it too.
 */
let ownLoginChange = false;
/** What stops any look at the live login: an unresolved swap or an interrupted activation's journal (the slot is checked too). */
const liveGuard = () => ({ swapUnresolved: isSwapUnresolved, journalPending: () => activationJournalPending(activateDeps()) });
/** Reconciles the live login holding the swap slot; skipped while a swap, a login or an activation journal is pending. */
function reconcileIdle(): Promise<boolean> {
  if (quitting) return Promise.resolve(false); // no new account work once the app quits
  return reconcileWhenIdle({ ...liveGuard(), loginActive: () => login.isActive() }, async () => {
    // The own change is used by this one reconcile, also when it fails halfway.
    const ownChange = ownLoginChange;
    ownLoginChange = false;
    await reconcileLive(reconcileDeps(), ownChange ? { ownChange } : {});
  });
}
/** Tells the renderer whether an unresolved swap blocks further swaps. */
async function pushSwapPending(): Promise<void> {
  send('accounts:swapPending', await hasPendingSwap(swapDeps()).catch(() => true));
}
// Background refreshes never write into a managed profile while a swap runs or is unresolved.
// Only profiles whose token family lives nowhere else are renewed (renewRule, R6): never the live login, a switched-out
// record or a copy of the live family that cswap also holds.
const refreshBlocked: RefreshOutcome = { kind: 'transient', detail: { reason: 'blocked' } };
// Nor a card being signed in again or whose restore runs or failed: its files must stay the snapshot's (or are another account's).
const familyRenew = gateFamilyRefresh(accounts, () => cswapRoster, (dir) => (login.holdsProfile(dir) ? Promise.resolve(refreshBlocked) : renewProfile(dir)), refreshBlocked);
usageDeps.refreshClaude = gateProfileRefresh<RefreshOutcome>(guardDeps, familyRenew, refreshBlocked);
const hooks = new HookServer();
if (devEnv('MC_HOOK_DEBUG') === '1') hooks.debugDir = DATA_DIR;
const alive = new Set<string>();
/** The pty shell pid of each running cell (the Monitor panel's process trees). */
const cellPids = new Map<string, number>();
/** Codex session ids handed to cells this run (state may lag behind the renderer). */
const claimedCodex = new Set<string>();
/** Live notifications - Windows drops click handlers of garbage-collected ones. */
const notifications = new Set<Notification>();
/** Only sessions explicitly chosen by the user authorize native message delivery. */
const verifiedCodex = new Map<string, string>();
let mcpError: string | undefined;

/**
 * Startup order (0.9.4): the window is created first and the other startup steps run behind it, in parallel. What must still
 * come first is enforced by two gates instead of by delaying the window:
 * - `accountsReady`: the recovery of an interrupted swap or "Set as main" and the account migration have finished. Every
 *   accounts:, auth: and usage: channel that can start a swap, an activation, a login, a removal or a reconcile waits for it
 *   (registerAccountIpc), and the usage polls (which reconcile the live login) only start after it.
 * - `accountsRecovered`: the recovery alone (opened before the migration). Claude cells use the live ~/.claude login, so
 *   their spawns wait for it (spawnWaitsFor); shells, Codex and SSH cells do not.
 * - `cellServicesReady`: the hook server and the MCP server listen (their ports are known) and files of removed cells were
 *   pruned. Every agent spawn waits for it (a plain shell only with a startup prompt); the renderer shows the cells meanwhile.
 * The gates always open (the steps catch their errors and open them in `finally`).
 * The single-instance lock and the Windows update hand-off (signalUpdateReady, waitForUpdateWindowGone, runUpdateGate) keep
 * running before startMainApp, unchanged.
 */
const accountsReady = createStartupGate();
const accountsRecovered = createStartupGate();
const cellServicesReady = createStartupGate();
/** True until the first start of the MCP server finished: the panel shows no "unavailable" while it is only starting. */
let mcpStarting = true;

/** Localized texts for the detached update window (it cannot load the app's catalog). */
const updateStrings = (): UpdateStrings => ({
  title: tr('Aktualizacja do wersji {version}', { version: getUpdateState().version ?? '' }),
  hint: tr('Nie wyłączaj komputera. unimux uruchomi się automatycznie.'),
  stages: {
    preparing: tr('Przygotowanie aktualizacji…'),
    closing: tr('Zamykanie unimux…'),
    installing: tr('Instalowanie nowej wersji…'),
    launching: tr('Uruchamianie unimux…'),
  },
  done: tr('Gotowe - uruchamiam nową wersję'),
  slow: tr('Aktualizacja trwa dłużej niż zwykle'),
  slowHint: tr('Możesz uruchomić unimux ręcznie.'),
  open: tr('Uruchom unimux'),
  close: tr('Zamknij'),
  waitingClose: tr('Czekam na zamknięcie unimux…'),
  waitingInstaller: tr('Czekam na instalator. Jeśli Windows poprosi o zgodę, potwierdź ją.'),
  installingLong: tr('Instalacja trwa dłużej niż zwykle - to może jeszcze chwilę potrwać…'),
  background: tr('Aktualizacja trwa dalej w tle'),
});

// The main window, and (1.0.6) the detached windows for the state and the messages of their own cells (detachedWindows.ts).
const send = (channel: string, ...args: unknown[]) => { sendRouted(win, channel, args); };
/** The OS ends the session (Windows shutdown or log-off, macOS shutdown): nothing may hold the quit any more. */
let sessionEndingAt: number | undefined;
/** The OS announced a session end: quits within the next minute are never held, and an open question lets the quit go on. */
const markSessionEnding = (): void => { sessionEndingAt = Date.now(); quitConfirm.release(); };
/** Closing the window or quitting while agents work asks first (in the renderer); see quitConfirm.ts for what is never held. */
const quitConfirm = createQuitConfirm({
  exempt: () => quitting || gating || superseded || sessionEndingNow(sessionEndingAt, Date.now()) || updateHandoffStarted() || !isLive(win) || win!.webContents.isCrashed(),
  // A minimized or hidden window (taskbar "Close window", Dock "Quit" after Cmd+H) is brought up first: the question must be seen.
  ask: () => {
    withLiveWindow(win, (w) => {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    });
    if (process.platform === 'darwin') { try { app.focus({ steal: true }); } catch { /* the window is shown anyway */ } }
    send('app:confirm-quit');
  },
  quit: () => app.quit(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
guardedOn('app:quitGuard', (_e, ask: unknown) => { quitConfirm.setGuard(ask === true); });
guardedOn('app:quitAnswer', (_e, answer: unknown) => { if (isQuitAnswer(answer)) quitConfirm.answer(answer); });
cliDetector.onChange((map) => send('cli:changed', map));
/** Guided install of the agent CLIs in a visible terminal (`install:` ptys are not cells). */
const install = new InstallManager({
  platform: process.platform,
  home: homedir(),
  shell: () => state.settings.shell,
  env: () => process.env,
  exec: runProgram,
  detector: cliDetector,
  spawnPty: (spec) => ptyHost.spawn({ id: spec.id, cwd: homedir(), cols: 100, rows: 28, env: spec.env, shell: state.settings.shell, command: spec.command, tap: true }),
  killPty: (id) => ptyHost.kill(id),
  killTree: killProcessTree,
  emit: (installState) => send('install:state', installState),
  // Test hook of unpackaged builds: a harmless local script instead of the vendor's installer.
  commandOverride: app.isPackaged ? undefined : () => process.env.MC_INSTALL_COMMAND_OVERRIDE || undefined,
});

/** Ids of the cells of every project's grids (and, unless `tabsOnly`, its archive), optionally filtered. */
function cellIdsOf(s: AppState, tabsOnly: boolean, keep: (cell: AppState['projects'][number]['tabs'][number]['cells'][number]) => boolean = () => true): Set<string> {
  const ids = new Set<string>();
  for (const project of s.projects) for (const tab of tabsOnly ? project.tabs : [...project.tabs, ...project.archive]) {
    for (const cell of tab.cells) if (keep(cell)) ids.add(cell.id);
  }
  return ids;
}
/** A cell left the state for good (archive emptied, project removed): its per-cell bookkeeping goes too. */
function forgetCell(id: string): void {
  // killCount stays: a spawn still waiting for its CLI lookup compares against it (a few bytes per removed cell).
  codexHooked.delete(id);
  verifiedCodex.delete(id);
  // A process that still runs keeps its hook settings and MCP config (Claude may read them again); the next start prunes them.
  if (alive.has(id)) return;
  hooks.forget(id);
  void removeCellFiles(cellFileDirs, id);
  automation.forgetCell(id);
}
const controller = new StateController(state, (snapshot) => {
  if (snapshot.state.projects !== state.projects) {
    // One pass over each state (a lookup per cell was quadratic in the number of cells).
    const roles = cellIdsOf(snapshot.state, true, (cell) => !!cell.role);
    for (const id of cellIdsOf(state, true, (cell) => !!cell.role)) if (!roles.has(id)) mcp.revokeCell(id);
    const kept = cellIdsOf(snapshot.state, false);
    for (const id of cellIdsOf(state, false)) if (!kept.has(id)) forgetCell(id);
  }
  const previous = state;
  state = snapshot.state;
  ssh?.stateChanged(state);
  db?.stateChanged();
  detachedStateChanged(state);
  const key = `${state.settings.showAiUsage}:${state.settings.usageIntervalMinutes}`;
  if (key !== usageKey) { usageKey = key; usage.reschedule(); }
  saver.save(state);
  send('state:changed', stateChange(previous, snapshot));
});
const automation = new AutomationService(controller, {
  createWorktree,
  // Rolls back worktrees it has just created: nothing is in them yet, so the unforced removal goes through.
  removeWorktree: async (path, wt) => { await removeWorktree(path, wt, true); },
  startCells: (ids) => send('automation:start-cells', ids),
  missingCli: (profileId) => {
    const profile = state.profiles.find((p) => p.id === profileId);
    return profile ? missingCli(profile, cliDetector.snapshot()) ?? undefined : undefined;
  },
  stopCells: async (ids) => {
    for (const id of ids) { noteKill(id); ssh?.killed(id); endCellMcp(mcp, MCP_DIR, id); verifiedCodex.delete(id); alive.delete(id); automation.statuses.set(id, 'exited'); }
    await Promise.all(ids.map((id) => ptyHost.killAndWait(id)));
  },
  isCellRunning: (cellId) => alive.has(cellId),
  restartAgent: async (cellId) => {
    const found = findCell(state, cellId);
    if (!found || !alive.has(cellId)) return { restarted: false, reason: 'Agent is not running.' };
    const profile = getProfile(state, found.cell.profileId);
    const session = found.cell.session;
    if (!session || session.cli !== profile.cli || !session.confirmed) return { restarted: false, reason: 'Choose a compatible conversation from History before restarting through MCP.' };
    const cwd = found.cell.worktree?.path ?? found.project.path;
    if (!(await pathExists(cwd))) return { restarted: false, reason: 'Project folder does not exist.' };
    if (!alive.has(cellId)) return { restarted: false, reason: 'Agent is not running.' };
    endCellMcp(mcp, MCP_DIR, cellId);
    verifiedCodex.delete(cellId);
    alive.delete(cellId);
    await ptyHost.killAndWait(cellId);
    const result = await spawnRequest({ cellId, cwd, profile, mode: 'resume', sessionId: session.id, sessionConfirmed: true, cols: 100, rows: 30 });
    if (result.ok) send('cell:restarted', cellId);
    return { restarted: result.ok, reason: result.ok ? undefined : result.error };
  },
  deliver: async (cellId, text) => {
    const found = findCell(state, cellId);
    if (!found || !alive.has(cellId)) throw new Error('Agent is not running. The item is available in its MCP inbox.');
    if (getProfile(state, found.cell.profileId).cli !== 'codex') throw new Error('Available in the MCP inbox. Use Paste to insert it into this agent without submitting.');
    const sessionId = verifiedCodex.get(cellId);
    if (!sessionId || found.cell.session?.id !== sessionId) throw new Error('Session identity is not verified. The item is available in the MCP inbox.');
    const codex = await cliDetector.get('codex', { waitMs: CLI_WAIT_MS }).catch(() => undefined);
    await queueCodexMessage(sessionId, text, {
      command: codex?.state === 'found' ? codex.path : undefined,
      env: await cliDetector.applyEnv(cleanEnv(process.env), 'codex'),
    });
  },
});
const mcp = new UnimuxMcpServer(automation, { log: (message) => crashLog.warn(message) });
const mcpInfo = (): McpInfo => ({ ...mcp.getInfo(), error: mcpError, ...(mcpStarting && !mcp.getInfo().running ? { starting: true } : {}) });
/** Tells the renderer what changed instead of being polled (the renderer keeps a slow fallback poll). */
const pushLater = (push: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => { timer ??= setTimeout(() => { timer = undefined; push(); }, 250); };
};
mcp.onChange(pushLater(() => send('mcp:info', mcpInfo())));
automation.statuses.onChange = pushLater(() => send('automation:statuses', Object.fromEntries(automation.statuses)));
/** Starts the MCP server; a failed listen (security software, a busy port range) is retried twice in the background. */
async function startMcp(retries = 2): Promise<void> {
  try {
    await mcp.start();
    mcpError = undefined;
  } catch (error) {
    mcpError = error instanceof Error ? error.message : String(error);
    crashLog.warn(`MCP server did not start: ${mcpError}`);
    if (retries > 0) setTimeout(() => void startMcp(retries - 1), 1000);
  }
  mcpStarting = false;
  send('mcp:info', mcpInfo());
}
guardedHandle('mcp:retry', async () => { if (!mcp.getInfo().running) await startMcp(0); return mcpInfo(); }, () => mcpInfo());

function createWindow(): void {
  win = new BrowserWindow({
    width: devEnv('MC_OFFSCREEN') ? 1100 : 1600,
    height: devEnv('MC_OFFSCREEN') ? 700 : 1000,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#0d0d0d',
    title: 'unimux',
    icon: windowIcon(),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: '#0d0d0d', symbolColor: '#8a8a8a', height: 36 } }),
    show: false,
    webPreferences: {
      // Sandboxed: the preload uses only contextBridge, ipcRenderer, webUtils and the sandbox's process object.
      preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true,
      // Status ticks and alerts keep their 400 ms cadence and output keeps flowing while the window is minimized or covered;
      // the renderer stops drawing terminals on its own while minimized or hidden ('window:shown').
      backgroundThrottling: false,
      // A terminal app: no red underlines under paths and commands, no dictionary downloads.
      spellcheck: false,
    },
    // Off-screen, non-focusable window for automated screenshots (docs).
    ...(devEnv('MC_OFFSCREEN') ? { x: -6000, y: 0, skipTaskbar: true, focusable: false } : {}),
  });
  // The taskbar button shows our icon (not the Electron one), whatever was cached for this identity before.
  if (process.platform === 'win32') {
    try { win.setAppDetails({ appId: APP_USER_MODEL_ID, appIconPath: app.isPackaged ? process.execPath : windowIcon(), appIconIndex: 0 }); } catch { /* the window icon still applies */ }
  }
  win.once('ready-to-show', () => {
    startupTimer.mark('ready-to-show');
    if (devEnv('MC_OFFSCREEN')) win?.showInactive(); else win?.show();
    void signalUpdateReady();
    signalMacUpdateReady();
    clearGateFailureIfUpdated();
  });
  const created = win;
  // Async callbacks outlive the native window (shutdown, update hand-over); they must see "no window", not a destroyed one.
  created.once('closed', () => { install.dispose(); if (win === created) win = null; closeAllDetached(); });
  // Without background throttling the page always counts as visible, so the renderer learns from here when nobody can see it.
  const sendShown = () => { if (isLive(created)) safeSend(created, 'window:shown', created.isVisible() && !created.isMinimized()); };
  win.on('minimize', () => { usage.setActive(false); sendShown(); });
  win.on('hide', () => { usage.setActive(false); sendShown(); });
  win.on('restore', () => { usage.setActive(true); sendShown(); });
  win.on('show', () => { usage.setActive(true); sendShown(); });
  win.on('focus', () => cliDetector.invalidateRegistry());
  if (!app.isPackaged) win.webContents.on('console-message', (e) => e.level !== 'debug' && console.log('[renderer]', e.level, e.message));
  // The install window lives in the renderer: a reload or crash must not leave an invisible install running.
  win.webContents.on('did-start-loading', () => { install.dispose(); quitConfirm.rendererGone(); sftp?.rendererGone(); db?.rendererGone(); localFiles.rendererGone(); });
  // The close button (or Alt+F4, or the last window on macOS) while agents work: the renderer asks first.
  win.on('close', (e) => { if (quitConfirm.hold()) e.preventDefault(); });
  win.webContents.on('render-process-gone', (_e, details) => {
    install.dispose();
    quitConfirm.rendererGone();
    sftp?.rendererGone();
    db?.rendererGone();
    localFiles.rendererGone();
    onRendererGone(created, details.reason, details.exitCode);
  });
  // A renderer stuck in a loop: after a grace period the user may reload it (the terminals keep running in the Pty Host).
  let hung: ReturnType<typeof setTimeout> | undefined;
  win.on('unresponsive', () => {
    if (hung || quitting) return;
    hung = setTimeout(() => { hung = undefined; askAboutHungRenderer(created); }, UNRESPONSIVE_GRACE_MS);
  });
  win.on('responsive', () => { clearTimeout(hung); hung = undefined; });
  // Windows ends the session without before-quit: the last changes are written now (the renderer was asked to send its own).
  win.on('query-session-end', () => { markSessionEnding(); send('app:before-quit'); });
  win.on('session-end', () => { saver.flush(); });
  win.webContents.on('did-finish-load', () => { startupTimer.mark('did-finish-load'); hungReloadRequested = false; if (isLive(win)) { ptyHost.connectRenderer(win.webContents); sftpHost.connectRenderer(win.webContents); dbHost.connectRenderer(win.webContents); void accountsReady.promise.then(pushSwapPending); sendShown(); } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(win);
  startupTimer.mark('window-created');
}

/** The renderer page; a detached window (1.0.6) gets `?detached=<id>`. */
function loadRenderer(w: BrowserWindow, query: Record<string, string> = {}): void {
  const search = new URLSearchParams(query).toString();
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(search ? `${process.env.ELECTRON_RENDERER_URL}?${search}` : process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(__dirname, '../renderer/index.html'), search ? { query } : undefined);
}

initDetachedWindows({
  state: () => state,
  change: (fn) => { controller.change(fn); },
  mainWindow: () => win,
  load: loadRenderer,
  preload: join(__dirname, '../preload/index.js'),
  icon: windowIcon,
  pty: ptyHost,
  isAlive: (cellId) => alive.has(cellId),
  quitting: () => quitting,
  offscreen: !!devEnv('MC_OFFSCREEN'),
  devConsole: !app.isPackaged,
  log: (message) => crashLog.warn(message),
}, { guardedHandle, guardedOn });

/** Renderer crashes reloaded without asking (3 within a minute); after that the user decides. */
const allowRendererReload = createReloadLimiter();
/** The user chose to reload a hung renderer: the crash that ends it is reloaded without counting or asking. */
let hungReloadRequested = false;

/**
 * The renderer died (out of memory in a busy grid, a GPU or renderer crash): the terminals live on in the Pty Host and a
 * reload adopts them (aliveAtStart) and replays their output, so the window is reloaded instead of staying black.
 */
function onRendererGone(window: BrowserWindow, reason: string, exitCode: number): void {
  // The user's reload covers this one crash only: any later one is counted again.
  const asked = hungReloadRequested;
  hungReloadRequested = false;
  if (reason === 'clean-exit' || quitting || gating || window !== win || !isLive(window)) return;
  crashLog.error(`renderer gone (${reason}, exit code ${exitCode})`);
  if (asked || allowRendererReload(Date.now())) { reloadWindow(window); return; }
  const options = {
    type: 'error' as const, title: 'unimux',
    message: tr('Okno aplikacji kilka razy przestało działać.'),
    detail: tr('Terminale działają dalej. Możesz wczytać okno ponownie albo zamknąć aplikację.'),
    buttons: [tr('Wczytaj ponownie'), tr('Zamknij aplikację')],
    defaultId: 0, cancelId: 0, noLink: true,
  };
  void dialog.showMessageBox(window, options).then(({ response }) => {
    if (quitting || !isLive(window)) return;
    if (response === 1) { quitConfirm.confirm(); app.quit(); } else reloadWindow(window);
  }).catch(() => {});
}

function reloadWindow(window: BrowserWindow): void {
  try { window.webContents.reload(); } catch (error) { crashLog.error(`reload failed: ${describeError(error)}`); }
}

/** The renderer has not answered for a while: waiting is the default, reloading ends whatever blocks it. */
function askAboutHungRenderer(window: BrowserWindow): void {
  if (quitting || gating || window !== win || !isLive(window)) return;
  crashLog.warn('renderer unresponsive');
  const options = {
    type: 'warning' as const, title: 'unimux',
    message: tr('Okno aplikacji nie odpowiada.'),
    detail: tr('Terminale działają dalej. Możesz poczekać albo wczytać okno ponownie.'),
    buttons: [tr('Czekaj'), tr('Wczytaj ponownie')],
    defaultId: 0, cancelId: 0, noLink: true,
  };
  void dialog.showMessageBox(window, options).then(({ response }) => {
    if (response !== 1 || quitting || !isLive(window)) return;
    crashLog.warn('hung renderer reloaded by the user');
    // A renderer stuck in a loop does not navigate: it is ended first, and render-process-gone reloads it.
    hungReloadRequested = true;
    try { window.webContents.forcefullyCrashRenderer(); } catch { hungReloadRequested = false; reloadWindow(window); }
  }).catch(() => {});
}

function startSsh(): void {
  const dir = join(DATA_DIR, 'ssh');
  const cipher = electronCipher(safeStorage, process.platform, !app.isPackaged && process.env.MC_SSH_NO_SAFESTORAGE === '1');
  const vault = new SshVault(join(dir, 'vault.json'), cipher);
  const knownHosts = new KnownHostsStore(join(dir, 'known_hosts.json'));
  const vaultChanged = () => send('ssh:vault:changed', vault.info());
  // The command history of the SSH autocomplete (local only); pending changes are written before the app quits.
  const commandHistory = new CommandHistoryStore(join(dir, 'command_history.json'), { hostExists: (hostId) => state.sshHosts.some((h) => h.id === hostId) });
  registerCommandHistoryIpc({ guardedHandle, guardedOn }, commandHistory);
  app.on('before-quit', () => commandHistory.flush());
  ssh = new SshCoordinator({
    state: () => state, vault, knownHosts,
    // SFTP sessions ("sftp:<uuid>") log in through the SFTP Host, DB tunnels ("db:<uuid>") through the DB Host, cells through the Pty Host.
    host: (m) => {
      const id = m.t === 'sshConnect' ? m.req.id : m.id;
      return isSftpSessionId(id) ? sftpHost.send(m) : isDbSessionId(id) ? dbHost.send(m) : ptyHost.sendSsh(m);
    },
    events: {
      session: (s) => { if (isSftpSessionId(s.cellId)) sftp?.onCoordinatorSession(s); else if (isDbSessionId(s.cellId)) db?.onCoordinatorSession(s); else { noteSshResume(s); send('ssh:session', s); } },
      prompt: (cellId, prompt) => { if (isSftpSessionId(cellId)) sftp?.onPrompt(cellId, prompt); else if (isDbSessionId(cellId)) db?.onPrompt(cellId, prompt); else send('ssh:prompt', cellId, prompt); },
      vaultChanged,
    },
    debug: !app.isPackaged && process.env.MC_SSH_DEBUG === '1',
  });
  const coordinator = ssh;
  sftp = new SftpService({
    coordinator, host: sftpHost,
    hostExists: (hostId) => state.sshHosts.some((h) => h.id === hostId),
    hostSudo: (hostId) => state.sshHosts.some((h) => h.id === hostId && h.sftpSudo === true),
    events: {
      session: (s) => send('sftp:session', s),
      prompt: (sessionId, prompt) => send('sftp:prompt', sessionId, prompt),
      hostCrashed: () => send('sftp:hostCrashed'),
    },
  });
  registerSftpIpc({ guardedHandle, guardedOn }, createSftpHandlers(sftp));
  const dbVault = new DbVault(join(DATA_DIR, 'db', 'vault.json'), cipher);
  db = new DbService<AppState>({
    coordinator, host: dbHost, vault: dbVault,
    state: () => state,
    change: (fn) => { controller.change(fn); },
    sshHostExists: (hostId) => state.sshHosts.some((h) => h.id === hostId),
    readCa: async (path) => {
      if (!isAbsolute(path)) return null;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > DB_LIMITS.caBytes) return null;
        return await readFile(path, 'utf8');
      } catch { return null; }
    },
    events: {
      session: (s) => send('db:session', s),
      prompt: (sessionId, prompt) => send('db:prompt', sessionId, prompt),
      hostCrashed: () => send('db:hostCrashed'),
      vaultChanged: () => send('db:vault:changed', dbVault.info()),
    },
  });
  registerDbIpc({ guardedHandle, guardedOn }, createDbHandlers(db));
  // The CA file of a verify-full connection: only its path goes back (main reads it at connect time).
  guardedHandle('db:pickCaFile', async () => {
    const r = await showOpen({ title: tr('Wybierz plik certyfikatu CA'), properties: ['openFile'], filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer'] }, { name: '*', extensions: ['*'] }] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  }, () => null);
  // Export of a result (CSV / JSON): the user picks where in the save dialog; the renderer never names a path.
  // MC_DB_EXPORT_DIR (real-app checks of an unpackaged build only) writes into that folder without the dialog.
  guardedHandle('db:export', async (_e, name: unknown, text: unknown) => {
    if (typeof name !== 'string' || !name || name.length > 200 || /[\\/\0]/.test(name) || typeof text !== 'string' || text.length > 512 * 1024 * 1024) return { ok: false };
    let path: string | null = null;
    if (process.env.MC_DB_EXPORT_DIR && !app.isPackaged) path = join(process.env.MC_DB_EXPORT_DIR, basename(name));
    else {
      const ext = name.split('.').pop() ?? '';
      const options = { title: tr('Eksportuj wynik'), defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] };
      const r = isLive(win) ? await dialog.showSaveDialog(win!, options) : await dialog.showSaveDialog(options);
      path = r.canceled || !r.filePath ? null : r.filePath;
    }
    if (!path) return { ok: false, cancelled: true };
    try { await writeFile(path, text, 'utf8'); return { ok: true, path }; } catch { return { ok: false }; }
  }, () => ({ ok: false }));
  registerSshIpc(ipcMain, createSshHandlers({
    coordinator, vault, knownHosts, drafts: new KeyDrafts(),
    state: () => state,
    change: (fn) => { controller.change(fn); },
    vaultChanged,
    pickKeyFile: async () => {
      // The default folder is only passed to the dialog; the app never reads ~/.ssh by itself.
      const sshDir = join(homedir(), '.ssh');
      const r = await showOpen({ title: tr('Importuj z pliku'), properties: ['openFile', 'showHiddenFiles'], ...(existsSync(sshDir) ? { defaultPath: sshDir } : {}) });
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
    saveKeyFile: async (name) => {
      const options = { title: tr('Zapisz klucz prywatny do pliku...'), defaultPath: name };
      const r = isLive(win) ? await dialog.showSaveDialog(win!, options) : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    readKeyFile: readKeyFileFromDisk,
    writeKeyFile: async (path, text) => writePrivateFile(path, text),
    hostname: () => hostname(),
  }), fromAppWindow);
}

// ── pty host ────────────────────────────────────────────────────────────────

/** Errors the Pty Host reports, at most 20 a minute (a failing terminal in a loop must not fill the disk). */
const allowHostLog = createReportLimiter();
ptyHost.on('message', (m: HostToMain) => {
  if (m.t === 'log') {
    if (allowHostLog(Date.now())) { if (m.level === 'warn') crashLog.warn(m.message); else crashLog.error(m.message); }
    return;
  }
  if ('id' in m && m.id.startsWith(INSTALL_PTY_PREFIX)) { install.onHostMessage(m); return; } // the install window is not a cell
  if ('id' in m && m.id.startsWith('auth:')) return; // login windows are not cells
  if (ssh?.onHostMessage(m)) return;
  if (m.t === 'spawned') {
    automation.runtimeStarted(m.id); alive.add(m.id); automation.statuses.set(m.id, 'unknown');
    if (m.pid > 0) cellPids.set(m.id, m.pid); else cellPids.delete(m.id);
  } else if (m.t === 'exit') {
    alive.delete(m.id);
    cellPids.delete(m.id);
    verifiedCodex.delete(m.id);
    endCellMcp(mcp, MCP_DIR, m.id);
    automation.statuses.set(m.id, 'exited');
    releasePrompt(m.id);
  } else if (m.t === 'spawnError') {
    releasePrompt(m.id);
    alive.delete(m.id);
    endCellMcp(mcp, MCP_DIR, m.id);
    automation.statuses.set(m.id, 'exited');
    send('cell:spawnError', m.id, m.message);
  }
});
/**
 * 1.0.6, "Przywracaj sesje SSH po ponownym uruchomieniu": whether each SSH cell's session is connected is kept in the cell
 * (cell.ssh.resume), so the next app start knows which ones to restore. The sessions the quit (or the end of the system
 * session, or an update taking over) closes leave it as it was: they were connected when the app closed.
 */
function noteSshResume(s: SshSessionState): void {
  if (quitting || gating || superseded || sessionEndingNow(sessionEndingAt, Date.now())) return;
  const resume = resumeForPhase(s.phase);
  if (resume === null || patchSshCell(state, s.cellId, { resume }) === state) return;
  controller.change((st) => patchSshCell(st, s.cellId, { resume }));
}
/** Everything that ran in the Pty Host is gone: logins, the install window, MCP tokens, SSH sessions. Returns what the toast promises. */
function forgetHostTerminals(code: unknown, stderrTail: unknown): boolean {
  // A restart before the renderer listens must still stop the app-start SSH reconnect (D5 after a Pty Host restart).
  appStartClaim.cancel();
  const tail = typeof stderrTail === 'string' && stderrTail.trim() ? `\n${stderrTail.trim()}` : '';
  crashLog.error(`pty host exited (code ${String(code)})${tail}`);
  releaseAllPrompts();
  login.failActive('spawn');
  install.failActive();
  for (const id of alive) { endCellMcp(mcp, MCP_DIR, id); automation.statuses.set(id, 'exited'); }
  verifiedCodex.clear();
  ssh?.hostCrashed();
  const resumes = resumesConversation([...alive].map((id) => {
    const found = findCell(state, id);
    return found ? { ssh: !!found.cell.ssh, cli: getProfile(state, found.cell.profileId).cli } : undefined;
  }));
  alive.clear();
  return resumes;
}
sftpHost.on('message', (m: SftpHostToMain) => {
  if (m.t === 'log') {
    if (allowHostLog(Date.now())) { if (m.level === 'warn') crashLog.warn(m.message); else crashLog.error(m.message); }
    return;
  }
  sftp?.onHostMessage(m);
});
dbHost.on('message', (m: DbHostToMain) => {
  if (m.t === 'log') {
    if (allowHostLog(Date.now())) { if (m.level === 'warn') crashLog.warn(m.message); else crashLog.error(m.message); }
    return;
  }
  db?.onHostMessage(m);
});
// Its sessions are gone; the next database use starts it again.
dbHost.on('crashed', (code: unknown, stderrTail: unknown) => {
  const tail = typeof stderrTail === 'string' && stderrTail.trim() ? `\n${stderrTail.trim()}` : '';
  crashLog.error(`db host exited (code ${String(code)})${tail}`);
  db?.hostCrashed();
});
// Its sessions and transfers are gone; the next SFTP use starts it again.
sftpHost.on('crashed', (code: unknown, stderrTail: unknown) => {
  const tail = typeof stderrTail === 'string' && stderrTail.trim() ? `\n${stderrTail.trim()}` : '';
  crashLog.error(`sftp host exited (code ${String(code)})${tail}`);
  sftp?.hostCrashed();
});
// The renderer starts its visible cells again at once; PtyHostClient keeps those spawns until the new host is up.
ptyHost.on('crashed', (code: unknown, stderrTail: unknown) => {
  send('ptyhost:crashed', forgetHostTerminals(code, stderrTail));
});
// Too many crashes in a row: nothing restarts by itself. The cells show why they do not start; the user may try once more.
ptyHost.on('fatal', (code: unknown, stderrTail: unknown) => {
  const resumes = forgetHostTerminals(code, stderrTail);
  send('ptyhost:fatal');
  if (quitting) return;
  // Not the blocking error box: main keeps serving IPC, hooks and MCP while the question is open.
  const options = {
    type: 'error' as const, title: 'unimux',
    message: tr('Proces terminali wielokrotnie się wysypał.'),
    detail: tr('Terminale nie działają. Możesz spróbować uruchomić je ponownie albo zamknąć aplikację.'),
    buttons: [tr('Uruchom terminale ponownie'), tr('Zamknij aplikację')],
    defaultId: 0, cancelId: 0, noLink: true,
  };
  void (isLive(win) ? dialog.showMessageBox(win!, options) : dialog.showMessageBox(options)).then(({ response }) => {
    if (quitting) return;
    if (response === 1) { quitConfirm.confirm(); app.quit(); return; }
    ptyHost.restartAfterFatal();
    send('ptyhost:crashed', resumes);
  }).catch(() => {});
});

hooks.on('hook', (cellId: string, event: string, info?: unknown) => {
  if (!findCell(state, cellId)) return; // stale or foreign id
  // Immediate hints only for events the tracker always applies; busy is left to the tracker (it may ignore late tool hooks)
  // and reaches automation through cell:runtime.
  const hint = automationHintForHook(event);
  if (hint) automation.statuses.set(cellId, hint);
  send('cell:hook', cellId, event, info);
});

// SessionStart ends the "background tasks still running" mode of the cell (they belong to a previous conversation).
hooks.on('sessionstart', (cellId: string, source?: string) => {
  if (!findCell(state, cellId)) return;
  send('cell:hook', cellId, 'session', { source });
});

// The user switched conversation inside a running Claude (/resume, /clear): follow it so a restart
// resumes the right one. Events for cells that are not alive are dropped (late hook of an old process).
hooks.on('session', (cellId: string, sessionId: string) => {
  const found = findCell(state, cellId);
  if (!shouldUpdateCellSession({
    known: !!found,
    isClaude: !!found && getProfile(state, found.cell.profileId).cli === 'claude',
    alive: alive.has(cellId),
    currentId: found?.cell.session?.id,
    reportedId: sessionId,
  })) return;
  send('cell:session', cellId, followedSession(sessionId));
});

/** Cells whose notify hook reported in this process: their session is bound by the renderer's committed turn ends and the file-timestamp guess never touches it. */
const codexHooked = new Set<string>();

// A Codex turn completed (its `notify` program posted the payload). The renderer's StatusTracker decides whether it was the
// cell's own turn end (quiet follows) or a sub-agent / mid-turn one (output goes on), and binds the thread accordingly.
hooks.on('codex', (cellId: string, notice: CodexNotice) => {
  const found = findCell(state, cellId);
  if (!found || !alive.has(cellId) || getProfile(state, found.cell.profileId).cli !== 'codex') return; // stale or foreign
  codexHooked.add(cellId);
  send('cell:hook', cellId, 'stop', { codex: true, ...(notice.turnId ? { turnId: notice.turnId } : {}), ...(notice.threadId ? { threadId: notice.threadId } : {}) });
});

function boundCodexIds(): Set<string> {
  const ids = new Set<string>(claimedCodex);
  for (const p of state.projects)
    for (const t of [...p.tabs, ...p.archive])
      for (const c of t.cells) if (c.session?.cli === 'codex') ids.add(c.session.id);
  return ids;
}

/**
 * Codex picks its own session id. The renderer calls this right after a Codex cell finished a
 * turn: its rollout file was just written, so the freshest unclaimed one in that cwd is the cell's.
 */
guardedHandle('codex:bind', async (_e, cellId: string, cwd: string) => {
  const peers = state.projects.flatMap((p) => p.tabs.flatMap((t) => t.cells
    .filter((c) => alive.has(c.id) && getProfile(state, c.profileId).cli === 'codex' && (c.worktree?.path ?? p.path) === cwd)));
  // Shared-directory simultaneous starts are ambiguous. Never guess a message recipient.
  if (peers.length !== 1 || peers[0].id !== cellId) return null;
  if (codexHooked.has(cellId)) return null; // its notify hook binds the exact thread; a timestamp guess must never overwrite it
  const id = await findRecentCodexSession(homedir(), cwd, 20_000, boundCodexIds());
  // Re-checked after the file reads: the cell may have been closed, hooked or the id claimed meanwhile.
  if (!id || !alive.has(cellId) || codexHooked.has(cellId) || boundCodexIds().has(id)) return null;
  claimedCodex.add(id);
  send('cell:session', cellId, { cli: 'codex', id, confirmed: false });
  return id;
}, () => null);

// ── ipc ─────────────────────────────────────────────────────────────────────

ipcMain.handle('state:load', () => state);
ipcMain.handle('state:snapshot', () => controller.snapshot());
// The answer is an acknowledgement; the new state reaches the renderer once, as the patch `state:changed` carries.
// A foreign sender is refused the way an edit the controller rejects is: a rejected call.
guardedHandle('state:edit', (_e, edit: StateEdit) => { const { revision, editId } = controller.apply(edit); return { revision, editId }; }, () => Promise.reject(new Error('Refused.')));
ipcMain.handle('mcp:info', (): McpInfo => mcpInfo());
guardedHandle('automation:execute', (_e, operation: AutomationOperation, input: unknown) => {
  if (!Object.hasOwn(automationSchemas, operation)) throw new Error('Unknown operation.');
  return automation.execute(operation, input);
}, () => Promise.reject(new Error('Unknown operation.')));

guardedHandle('cell:spawn', (_e, req: SpawnCellRequest) => spawnRequest(req), (): SpawnResult => ({ ok: false, error: 'invalid request' }));
type SpawnResult = { ok: true } | { ok: false; error: string; cliMissing?: CliId; cliStatus?: CliStatus };
async function spawnRequest(req: SpawnCellRequest): Promise<SpawnResult> {
  // A file write that fails (an antivirus lock on the hooks file, a full disk) answers with an error the cell shows, never a
  // rejected call that leaves the cell blank with an MCP token issued.
  try {
    return await spawnRequestUnsafe(req);
  } catch (error) {
    crashLog.warn(`spawn of a cell failed: ${describeError(error)}`);
    endCellMcp(mcp, MCP_DIR, req.cellId);
    alive.delete(req.cellId);
    automation.statuses.set(req.cellId, 'exited');
    return { ok: false, error: tr('Nie udało się uruchomić terminala: {error}', { error: error instanceof Error ? error.message : String(error) }) };
  }
}
async function spawnRequestUnsafe(req: SpawnCellRequest): Promise<SpawnResult> {
  if (ptyHost.isFatal()) return { ok: false, error: tr('Proces terminali nie działa. Uruchom aplikację ponownie.') };
  // Taken before the first await: a kill while the folder or the CLI is being checked must not be undone by this spawn.
  const killsBefore = killCount.get(req.cellId) ?? 0;
  // No agent starts before the hook and MCP servers have their ports, nor a Claude cell before the account recovery (the window
  // opens before both).
  await Promise.all(spawnWaitsFor({ cellServices: cellServicesReady, accountsRecovered }, { cli: req.profile.cli, startupPrompt: req.mode === 'new' ? req.startupPrompt : undefined }));
  if (!(await pathExists(req.cwd))) return { ok: false, error: tr('Folder nie istnieje: {path}', { path: req.cwd }) };
  const cli = cliForProfile(req.profile);
  // `force`: the user chose "start anyway" on the install card (the detection may be wrong, e.g. an alias).
  if (cli && req.force !== true) {
    // A definite "not installed" never spawns a shell that would only print "command not found"; unknown fails open.
    const status = await cliDetector.get(cli, { waitMs: CLI_WAIT_MS }).catch(() => undefined);
    if (!spawnDecision(req.profile, status).spawn) {
      endCellMcp(mcp, MCP_DIR, req.cellId);
      alive.delete(req.cellId);
      automation.statuses.set(req.cellId, 'exited');
      return { ok: false, error: tr('{name} nie jest zainstalowany', { name: CLI_NAMES[cli] }), cliMissing: cli, cliStatus: status };
    }
  }
  const baseEnv = await cliDetector.applyEnv({ ...cleanEnv(process.env), MC_CELL_ID: req.cellId }, cli ?? undefined);
  if ((killCount.get(req.cellId) ?? 0) !== killsBefore) return { ok: true }; // the cell was closed while the CLI was being looked up
  // The detected version picks http hooks (no process per tool call) or the curl commands older versions need.
  const claudeSettingsPath = req.profile.cli === 'claude' ? hooks.writeClaudeSettings(HOOKS_DIR, req.cellId, cliDetector.snapshot().claude?.version) : undefined;
  let mode = req.mode;
  // Claude only writes a transcript after the first prompt: resuming an unused id would fail,
  // so start a new conversation that keeps the same id instead.
  if (mode === 'resume' && req.profile.cli === 'claude' && req.sessionId) {
    const file = join(homedir(), '.claude', 'projects', claudeProjectDirName(req.cwd), `${req.sessionId}.jsonl`);
    if (!existsSync(file)) mode = 'new';
  }
  if (mode === 'resume' && !req.sessionId) mode = 'new';
  let initialPrompt: { file: string; text: string } | undefined;
  if (mode === 'new' && req.startupPrompt?.trim()) {
    mkdirSync(PROMPTS_DIR, { recursive: true });
    const file = join(PROMPTS_DIR, `${req.cellId}-${(++promptSeq).toString(36)}.txt`);
    writeFileSync(file, req.startupPrompt, 'utf8');
    initialPrompt = { file, text: req.startupPrompt };
  }
  const env: Record<string, string> = baseEnv;
  // Claude Code's own requests to 127.0.0.1 (http hooks, the MCP server) would otherwise go through the user's proxy.
  if (req.profile.cli === 'claude') bypassProxyForHooks(env);
  let mcpConfig: LaunchOptions['mcp'];
  // The token reaches Claude through its per-cell --mcp-config file only (not the environment every tool process inherits);
  // Codex can only read it from a variable (see mcpCellConfig.ts).
  if (req.profile.cli !== 'shell' && findCell(state, req.cellId)?.cell.role && mcp.getInfo().running) {
    mcpConfig = prepareCellMcp(req.profile.cli, { dir: MCP_DIR, cellId: req.cellId, url: mcp.getInfo().url!, token: mcp.issueToken(req.cellId), env });
  } else endCellMcp(mcp, MCP_DIR, req.cellId);
  // Codex reports every finished turn (and its conversation id) to the local hook server through a per-process `notify`.
  let codexNotifyUrl: string | undefined;
  if (req.profile.cli === 'codex') {
    codexNotifyUrl = hooks.prepareCodex(req.cellId);
    codexHooked.delete(req.cellId);
  }
  const command = buildLaunchCommand(req.profile, { mode, sessionId: req.sessionId, claudeSettingsPath, codexNotifyUrl,
    shell: state.settings.shell, model: findCell(state, req.cellId)?.cell.model, initialPrompt, mcp: mcpConfig }) ?? undefined;
  verifiedCodex.delete(req.cellId);
  if (req.profile.cli === 'codex' && mode === 'resume' && req.sessionId && req.sessionConfirmed) verifiedCodex.set(req.cellId, req.sessionId);
  automation.runtimeStarted(req.cellId);
  automation.statuses.set(req.cellId, 'starting');
  alive.add(req.cellId);
  queuePrompt(req.cellId, initialPrompt?.file ?? null);
  ptyHost.spawn({ id: req.cellId, cwd: req.cwd, cols: req.cols, rows: req.rows, env, shell: state.settings.shell, command });
  startupTimer.mark('first-spawn');
  return { ok: true };
}
guardedOn('cell:kill', (_e, id: string) => {
  noteKill(id);
  ssh?.killed(id);
  endCellMcp(mcp, MCP_DIR, id);
  verifiedCodex.delete(id);
  automation.statuses.set(id, 'exited');
  alive.delete(id);
  ptyHost.kill(id);
});
guardedHandle('cell:killAndWait', async (_e, id: string) => {
  noteKill(id);
  ssh?.killed(id);
  endCellMcp(mcp, MCP_DIR, id);
  verifiedCodex.delete(id);
  automation.statuses.set(id, 'exited');
  alive.delete(id);
  await ptyHost.killAndWait(id);
}, () => undefined);
ipcMain.handle('cell:alive', () => [...alive]);
// The Monitor panel asks every 2 s while it is on screen; nothing samples otherwise (the snapshot helper ends 15 s after the last ask).
const monitor = new Monitor({
  appMetrics: () => app.getAppMetrics(),
  cells: () => [...cellPids].filter(([id]) => alive.has(id)).map(([cellId, pid]) => ({ cellId, pid })),
});
guardedHandle('monitor:sample', () => monitor.sample(), () => null);
guardedHandle('monitor:kill', (_e, pid: unknown) => monitor.kill(pid), () => false);
app.on('will-quit', () => monitor.dispose());
// True for the first app window renderer that asks in this app run, false for every later one (a reload, a crash reload) and
// after a Pty Host restart: SSH hosts with "Łącz ponownie po uruchomieniu aplikacji" connect at an app start only.
guardedHandle('app:claimStart', () => appStartClaim.claim(), () => false);
const cliHandlers = createCliHandlers(cliDetector, (url) => { void shell.openExternal(url); });
ipcMain.handle('cli:status', () => cliHandlers.status());
// A recheck runs the detection (it starts processes); a foreign sender gets the cached answer.
guardedHandle('cli:recheck', (_e, id?: unknown) => cliHandlers.recheck(id), () => cliHandlers.status());
guardedOn('cli:openDocs', (_e, id?: unknown) => { cliHandlers.openDocs(id); });
const installHandlers = createInstallHandlers(install);
ipcMain.handle('install:options', (_e, cli?: unknown) => installHandlers.options(cli));
guardedHandle('install:start', (_e, request?: unknown) => installHandlers.start(request), () => ({ ok: false, error: 'invalid' }));
guardedOn('install:cancel', (_e, id?: unknown) => { installHandlers.cancel(id); });
ipcMain.handle('install:current', () => installHandlers.current());
guardedOn('cell:runtime', (_e, cellId: string, status: string, reason?: string, hooked?: boolean) => {
  relayCellStatus(_e, cellId, status);
  const found = findCell(state, cellId);
  if (!found || !alive.has(cellId)) return;
  // The renderer's StatusTracker decides; heuristics (hooked = false) never yield "ready".
  const next = automationStatusFor(status, reason, hooked === true, automation.statuses.get(cellId));
  if (next) automation.statuses.set(cellId, next);
});

/** Opens the dialog on the main window while it exists, free-standing otherwise. */
const showOpen = (options: OpenDialogOptions) => (isLive(win) ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));

guardedHandle('dialog:pickFolder', async () => {
  const r = await showOpen({ properties: ['openDirectory'], title: tr('Wybierz folder projektu') });
  return r.canceled ? null : r.filePaths[0];
}, () => null);
guardedHandle('sound:pick', async () => {
  const r = await showOpen({
    properties: ['openFile'],
    title: tr('Wybierz plik dźwiękowy'),
    filters: [{ name: tr('Pliki dźwiękowe'), extensions: [...SOUND_EXTENSIONS] }],
  });
  return r.canceled || !isSoundFile(r.filePaths[0]) ? null : r.filePaths[0];
}, () => null);
// The path is never taken from the renderer: only the saved setting of that event (set from the dialog result) is read.
ipcMain.handle('sound:load', (_e, event?: unknown, knownKey?: unknown) => loadEventSound(state.settings.alerts, event, knownKey));
guardedOn('sound:beep', () => shell.beep());
ipcMain.handle('fs:exists', (_e, p: string) => pathExists(p));
/** Files dropped from the system file manager: whether each absolute path is a folder, a file or gone. */
ipcMain.handle('fs:pathKinds', async (_e, paths: unknown): Promise<Array<'dir' | 'file' | null>> => {
  if (!Array.isArray(paths) || paths.length > 200) return [];
  return Promise.all(paths.map(async (p) => {
    if (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0')) return null;
    try { const info = await stat(p); return info.isDirectory() ? 'dir' as const : info.isFile() ? 'file' as const : null; } catch { return null; }
  }));
});
ipcMain.handle('fs:listProjectDirectory', (_e, projectId: string, path: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? listProjectDirectory(project.path, path) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:listProjectDirectoryBatch', (_e, projectId: string, paths: unknown) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? listProjectDirectoryBatch(project.path, paths) : {};
});
ipcMain.handle('fs:listProjectDirectories', (_e, projectId: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? listProjectDirectories(project.path) : { ok: false, error: 'Projekt już nie istnieje.' };
});
/** The running search per window: a new one (typing goes on) stops the previous, whose answer nobody shows. */
const searches = new Map<number, AbortController>();
ipcMain.handle('fs:searchProject', async (e, projectId: string, options: SearchOptions) => {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return { ok: false, error: 'Projekt już nie istnieje.' };
  searches.get(e.sender.id)?.abort();
  const controller = new AbortController();
  searches.set(e.sender.id, controller);
  try { return await searchProject(project.path, options, Date.now, controller.signal); }
  finally { if (searches.get(e.sender.id) === controller) searches.delete(e.sender.id); }
});
guardedHandle('fs:replaceInProject', (_e, projectId: string, request: ReplaceRequest) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? replaceInProject(project.path, request) : { ok: false, error: 'Projekt już nie istnieje.' };
}, () => ({ ok: false, error: 'Projekt już nie istnieje.' }));
ipcMain.handle('fs:statProjectFile', (_e, projectId: string, path: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? statProjectFile(project.path, path) : null;
});
ipcMain.handle('fs:readProjectFile', (_e, projectId: string, path: string, large?: boolean) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? readProjectFile(project.path, path, large === true ? LARGE_VIEW_BYTES : undefined) : { kind: 'error', message: 'Projekt już nie istnieje.' };
});
guardedHandle('fs:writeProjectFile', (_e, projectId: string, path: string, text: string, expectedText: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? writeProjectFile(project.path, path, text, expectedText) : { ok: false, error: 'Projekt już nie istnieje.' };
}, () => ({ ok: false, error: 'Projekt już nie istnieje.' }));
registerFileOpsIpc({ projectPath: (projectId) => state.projects.find((p) => p.id === projectId)?.path, send, allowed: fromAppWindow });
const localFiles = createLocalFiles({
  platform: process.platform,
  trash: createTrash(),
  openFolder: async (path) => { const error = await shell.openPath(path); if (error) throw new Error('open failed'); },
  showFile: (path) => shell.showItemInFolder(path),
  // The editor never reads or writes the app's own data (state, vault, logs) or its install.
  forbidden: [DATA_DIR, app.getPath('userData'), dirname(app.getPath('exe')), ...(app.isPackaged ? [app.getAppPath()] : [])],
});
registerLocalFilesIpc({ guardedHandle, guardedOn }, localFiles);
/** Worktrees of the project's cells, open and in closed grids (History lists their conversations too). */
function projectWorktrees(projectPath: string): Worktree[] {
  const key = normalizeProjectPath(projectPath);
  return state.projects.filter((p) => normalizeProjectPath(p.path) === key)
    .flatMap((p) => [...p.tabs, ...p.archive].flatMap((t) => t.cells.flatMap((c) => (c.worktree ? [c.worktree] : []))));
}
ipcMain.handle('sessions:list', (_e, projectPath: string) => listSessionsAsync(homedir(), projectPath, projectWorktrees(projectPath), currentBranch));
// "Publish to GitHub" (src/main/github): the sign-in unimux stores there also lets fetch, pull and push reach https://github.com.
const github = createGithubService({
  dataDir: DATA_DIR,
  cipher: electronCipher(safeStorage, process.platform, !app.isPackaged && process.env.MC_SSH_NO_SAFESTORAGE === '1'),
  fetch: (url, init) => net.fetch(url, init),
  env: () => cliDetector.applyEnv(cleanEnv(process.env)),
});
const gitEngine = new Git({ trustFile: join(DATA_DIR, 'git-trust.json'), remoteAuth: github.remoteAuth, remoteAuthRefused: github.remoteAuthRefused });
const gitProject = {
  projectPath: (projectId: string) => state.projects.find((p) => p.id === projectId)?.path,
  worktreePaths: (projectId: string) => state.projects.find((p) => p.id === projectId)?.tabs.flatMap((t) => t.cells.flatMap((c) => (c.worktree ? [c.worktree.path] : []))) ?? [],
};
registerGitIpc({ ...gitProject, git: gitEngine, allowed: fromAppWindow });
registerGithubIpc({ guardedHandle }, github.handlers(gitEngine, gitProject));
ipcMain.handle('git:isRepo', (_e, p: string) => isGitRepo(p));
guardedHandle('git:createWorktree', (_e, p: string, name: string) => createWorktree(p, name), () => Promise.reject(new Error('Refused.')));
guardedHandle('git:inspectWorktree', (_e, p: string, wt: Worktree): Promise<WorktreeInspectResult> => inspectWorktree(p, wt).then((inspection) => ({ ok: true as const, inspection }), (error: Error) => ({ ok: false as const, error: error.message })), () => ({ ok: false, error: 'Refused.' }));
guardedHandle('git:removeWorktree', (_e, p: string, wt: Worktree, del: boolean, confirmed?: WorktreeInspection) => removeWorktree(p, wt, del, confirmed ?? undefined), () => Promise.reject(new Error('Refused.')));

guardedOn('notify', (_e, n: { title: string; body: string; cellId: string }) => {
  if (!n || typeof n !== 'object' || typeof n.title !== 'string' || typeof n.body !== 'string' || (n.cellId !== undefined && typeof n.cellId !== 'string')) return;
  if (!Notification.isSupported()) return;
  const notification = new Notification(notificationOptions(n));
  notifications.add(notification);
  // Toasts parked in the Action Center never close by themselves: only the newest ones keep their click handler.
  trimNotifications(notifications);
  const forget = () => notifications.delete(notification);
  notification.on('close', forget);
  notification.on('failed', forget);
  notification.on('click', () => {
    forget();
    withLiveWindow(win, (w) => {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    });
    if (n.cellId) send('focus-cell', n.cellId);
  });
  notification.show();
});
/** Errors of the renderer (error boundaries, window.onerror, unhandled rejections) for crash.log; packaged builds keep no console. */
const allowRendererReport = createReportLimiter();
guardedOn('app:reportError', (_e, kind: unknown, message: unknown, stack: unknown) => {
  const line = rendererReport(kind, message, stack);
  if (line && allowRendererReport(Date.now())) crashLog.error(line);
});
/** Startup marks of the renderer (its boot finished, the first terminal output arrived): a fixed list, from the app window only. */
guardedOn('app:startupMark', (_e, name: unknown) => {
  if (!isRendererMark(name) || startupTimer.has(name)) return;
  startupTimer.mark(name);
  void startupLog.flush();
});
guardedHandle('clipboard:read', () => clipboard.readText(), () => '');
guardedOn('clipboard:write', (_e, text: unknown) => { if (typeof text === 'string') clipboard.writeText(text); });
/** A copied private key (0.9.3): the clearing waits here, not in the window, so a reload or quit within the minute still clears it. */
const secretClipboard = createSecretClipboard({
  read: () => clipboard.readText(),
  write: (text) => clipboard.writeText(text),
  digest: (text) => createHash('sha256').update(text).digest('hex'),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
/** Clears a still waiting copied key now; resolves within `ms` whatever the clipboard does. */
const flushSecretClipboard = (ms = 400): Promise<void> =>
  Promise.race([secretClipboard.flush().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, ms))]);
guardedHandle('clipboard:writeSecret', async (_e, text: unknown) => {
  if (typeof text !== 'string' || !text) return false;
  await secretClipboard.copy(text);
  return true;
}, () => false);
// A quit that skips the wind-down below (an update taking over) still clears a waiting key before the process ends.
app.on('will-quit', (e) => {
  if (!secretClipboard.pending()) return;
  e.preventDefault();
  void flushSecretClipboard().then(() => app.exit(0));
});
guardedOn('shell:openExternal', (_e, address: string) => {
  try { const url = new URL(address); if (['http:', 'https:'].includes(url.protocol)) void shell.openExternal(url.href); } catch { /* invalid address */ }
});
const isPathArg = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && !p.includes('\0');
guardedOn('shell:openPath', (_e, p: unknown) => { if (isPathArg(p)) void shell.openPath(p).catch(() => undefined); });
guardedOn('shell:revealPath', (_e, p: unknown) => { if (isPathArg(p)) shell.showItemInFolder(p); });
const changelog = createChangelog({
  cacheFile: join(DATA_DIR, 'changelog.json'),
  fetchJson: async (url) => {
    const response = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'unimux' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    return response.json();
  },
});
// `force` skips the freshness check (a GitHub request each time): a foreign sender only ever gets the cached answer.
guardedHandle('changelog:get', (_e, force: boolean) => changelog.get(force), () => changelog.get(false));
// Accounts, login and usage (0.9.3): everything that changes something only answers the app window (accountsIpc.ts).
registerAccountIpc(ipcMain, {
  getUsage: () => usage.getState(),
  refreshUsage: () => usage.refresh(true),
  startLogin: (request) => {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return { ok: false, error: 'invalid request' };
    return loginBlock(guardDeps, request).then((block) => (block ? { ok: false as const, error: block } : login.start(request as LoginRequest)));
  },
  cancelLogin: (id) => { if (typeof id === 'string') login.cancel(id); },
  removeAccount: (id) => handleRemoveAccount({
    ...guardDeps,
    isLive: (accountId) => accounts.live()?.recordId === accountId || custodyOf(accounts.get(accountId) ?? {}) === 'live',
    cancelLogin: (accountId) => login.cancelFor(accountId),
    remove: (accountId) => accounts.remove(accountId),
    onRemoved: () => { void usage.refresh(true, true); },
  }, id),
  makeMain: async (id) => {
    const result = await handleMakeMain({
      loginActive: () => login.isActive(),
      validate: (accountId) => checkActivationTarget(activateDeps(), accountId),
      swap: (accountId) => activateAccount(activateDeps(), accountId),
      onSwapped: () => { if (typeof id === 'string') void usage.refresh(true, true, `claude:${id}`); },
    }, id);
    void pushSwapPending();
    return result;
  },
  /** "Renew this copy in unimux": the user confirmed that a saved copy cswap also lists is the app's own login. */
  adoptCopy: (id) => handleAdoptCopy({
    ...guardDeps,
    loginActive: () => login.isActive(),
    get: (accountId) => accounts.get(accountId),
    live: () => accounts.live(),
    setFamily: (accountId, family) => accounts.setFamily(accountId, family),
    onAdopted: (accountId) => { void usage.refresh(true, true, `claude:${accountId}`); },
  }, true, id), // the sender was checked by registerAccountIpc
  swapPending: () => hasPendingSwap(swapDeps()).catch(() => true),
  /** The user confirmed that the emergency copy of an unresolved swap may be deleted for good. */
  clearSwapPending: async () => {
    // A recovery still waiting for Claude Code's locks can repair the state itself: its backups are not deleted meanwhile
    // (the panel says so and that the app retries).
    if (isActivationRecoveryPending()) return { ok: false, error: 'locked' as const };
    const cleared = await clearPendingActivation(activateDeps(), () => clearPendingSwap(swapDeps()));
    void pushSwapPending();
    return { ok: cleared };
  },
  dismissNotice: (id) => {
    try {
      dismissAccountNotice(accounts, id);
    } finally {
      send('usage:state', usage.getState());
    }
  },
}, fromAppWindow, accountsReady.promise, () => quitting);
usage.onChange((snapshot) => send('usage:state', snapshot));
// A check changes the update state (and may start a download); a foreign sender gets nothing done.
guardedHandle('update:check', () => checkForUpdates(), () => undefined);
ipcMain.handle('update:get', () => ({ ...getUpdateState(), currentVersion: app.getVersion() }));
guardedOn('update:install', () => openInstallWindow());
guardedOn('update:open', () => shell.openExternal(RELEASES_URL));
/** `cursor` / `code` found on PATH, looked up without blocking main (a slow PATH on network drives) and kept for a few minutes. */
let editorLookup: { at: number; found: Promise<string | undefined> } | undefined;
const EDITOR_LOOKUP_MS = 5 * 60_000;
function findEditor(): Promise<string | undefined> {
  if (editorLookup && Date.now() - editorLookup.at < EDITOR_LOOKUP_MS) return editorLookup.found;
  const onPath = (cmd: string) => new Promise<boolean>((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : '/usr/bin/which', [cmd], { windowsHide: true, timeout: 5000 }, (error) => resolve(!error));
  });
  const found = (async () => { for (const cmd of ['cursor', 'code']) if (await onPath(cmd)) return cmd; return undefined; })();
  editorLookup = { at: Date.now(), found };
  return found;
}
guardedOn('shell:openInEditor', (_e, p: unknown) => {
  if (!isPathArg(p)) return;
  void findEditor().then((editor) => openInEditor(p, editor)).catch((error) => crashLog.warn(`open in editor failed: ${describeError(error)}`));
});
function openInEditor(p: string, editor: string | undefined): void {
  // `cursor` / `code` are .cmd launchers → need a shell; they get our clean env.
  if (!editor && process.platform === 'darwin') {
    const application = ['Cursor', 'Visual Studio Code'].find((name) =>
      existsSync(join('/Applications', `${name}.app`)) || existsSync(join(homedir(), 'Applications', `${name}.app`)));
    if (application) {
      spawn('/usr/bin/open', ['-a', application, p], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
  }
  if (!editor) return void shell.openPath(p);
  spawn(editor, process.platform === 'win32' ? [`"${p}"`] : [p], { shell: process.platform === 'win32', detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv(process.env) }).on('error', () => undefined).unref();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/** A launch that arrived while this process was winding down; the new instance already exited, so it is repeated at exit. */
let relaunchRequested = false;

app.on('second-instance', () => {
  // Also fires while this process is winding down after its window closed; then there is nothing to focus.
  const focused = withLiveWindow(win, (w) => {
    if (w.isMinimized()) w.restore();
    w.focus();
    return true;
  });
  if (!focused && quitting) relaunchRequested = true;
});

const GATE_FILE = join(DATA_DIR, 'update-gate.json');
const readGateFailure = () => { try { return parseFailure(JSON.parse(readFileSync(GATE_FILE, 'utf8'))); } catch { return undefined; } };

/** If the installer has not quit the app this long after the hand-over, the app starts normally instead of hanging unseen. */
const HANDOFF_QUIT_WATCHDOG_MS = 15 * 1000;
let handoffWatchdog: ReturnType<typeof setTimeout> | undefined;

const MAC_GATE_DOWNLOAD_TOTAL_MS = 10 * 60 * 1000;
const writeGateRecord = (version: string) => { try { atomicWriteFileSync(GATE_FILE, JSON.stringify({ version, at: Date.now() })); } catch { /* best effort */ } };
const recordUpdateFailure = (version: string) => { writeGateRecord(version); blockUpdateVersion(version); };

/** The record of an attempt or failure ends once the version it targeted (or a newer one) is actually running. */
function clearGateFailureIfUpdated(): void {
  const record = readGateFailure();
  if (record && compareVersions(app.getVersion(), record.version) >= 0) { try { rmSync(GATE_FILE, { force: true }); } catch { /* retried on next start */ } }
}

/** The texts of the in-app update window (startup prompt and the window opened from the status bar). */
const gateTexts = (failed: string): GateTexts => ({
  checking: tr('Sprawdzanie aktualizacji…'),
  downloading: tr('Pobieranie aktualizacji…'),
  updating: (next) => tr('Aktualizacja do wersji {version}', { version: next }),
  hint: tr('Nie wyłączaj komputera. unimux uruchomi się automatycznie.'),
  preparing: tr('Przygotowanie aktualizacji…'),
  failed,
  close: tr('Zamknij'),
  available: (next) => tr('Dostępna nowa wersja {version}', { version: next }),
  askMessage: tr('Zainstalować ją teraz?'),
  askHint: tr('„Później” uruchamia obecną wersję. Zainstalujesz ją przyciskiem w stopce.'),
  install: tr('Zainstaluj teraz'),
  later: tr('Później'),
});

/** At most one update window or prompt at a time: the startup prompt, the window of the status bar button and the hand-over. */
const updateUi = createUpdateUiGuard();

/** Runs the updater before the main window exists; resolves true when the installer took over and the app must not start. */
async function runUpdateGate(): Promise<boolean> {
  let window: ReturnType<typeof createGateWindow> | undefined;
  try {
    const failure = readGateFailure();
    const recent = isActiveFailure(failure, app.getVersion(), Date.now());
    if (failure && recent && state.settings.updateMode !== 'manual') blockUpdateVersion(failure.version);
    if (!shouldGateOnStartup({
      platform: process.platform, packaged: updatesEnabled(), portable: isPortableBuild(),
      mode: state.settings.updateMode, recentFailure: recent,
    })) return false;
    const version = app.getVersion();
    if (!updateUi.acquire('startup-gate')) return false;
    window = createGateWindow(gateTexts(tr('Aktualizacja nie powiodła się - uruchamiam obecną wersję')), version);
    gating = true;
    let handedOver = '';
    const result = await runStartupGate({
      check: startupCheck, recheck: recheckUpdate, download: startupDownload, target: updateTarget, onTargetChange: onUpdateTargetChange, isDownloaded: isUpdateDownloaded,
      handoff: (next, hide, signal) => { handedOver = next; return handOver(next, hide, signal); }, handoffCommitted: updateHandoverCommitted,
      show: window.show, hide: window.hide, onCancel: window.onCancel, onInstall: window.onInstall,
      // Only while the failure is recent (after the cooldown the version is offered again).
      skipVersion: gateSkipVersion(failure, app.getVersion(), Date.now()),
      // The macOS archive is about 140 MB: allow more than the default for the whole download.
      downloadTotalMs: process.platform === 'darwin' ? MAC_GATE_DOWNLOAD_TOTAL_MS : undefined,
      markAttempt: writeGateRecord, recordFailure: recordUpdateFailure,
    });
    if (result !== 'installing') { gating = false; updateUi.release('startup-gate'); return false; }
    // After a hand-over `gating` stays on: the app is quitting for the installer and must not wind anything down.
    const armedAt = Date.now();
    const watch = () => {
      // The update window still supervising means the installer is only slow (late administrator prompt): keep waiting.
      if (handoffWatchdogAction(updateInstalling(START_BLOCK_MS), Date.now() - armedAt) === 'wait') {
        handoffWatchdog = setTimeout(watch, HANDOFF_QUIT_WATCHDOG_MS / 3);
        return;
      }
      console.error('the installer did not quit the app, starting normally');
      recordUpdateFailure(handedOver);
      void abortUpdateWindow();
      gating = false;
      updateUi.release('startup-gate');
      void startMainApp().catch(startFailedLate);
    };
    handoffWatchdog = setTimeout(watch, HANDOFF_QUIT_WATCHDOG_MS);
    return true;
  } catch (error) {
    console.error('startup update gate failed', error);
    try { window?.hide(); } catch { /* already gone */ }
    gating = false;
    updateUi.release('startup-gate');
    return false;
  }
}

/**
 * The status bar button of an offered, downloading or downloaded update: opens the one update window, which shows the
 * download (joining the running one), then the hand-over to the installer. A window that is already open (also the
 * startup prompt) is the only one there ever is.
 */
function openInstallWindow(): void {
  const version = updateTarget();
  if (!version || !canInstallNow() || !updateUi.acquire('install-window')) return;
  void (async () => {
    let handed = false;
    try {
      const window = createGateWindow(gateTexts(tr('Aktualizacja nie powiodła się')), app.getVersion());
      // macOS has no separate installing window: the in-app one stays visible while the app winds down.
      const keepOpen = process.platform === 'darwin';
      const result = await runInstallWindow({
        check: startupCheck, recheck: recheckUpdate, download: startupDownload, target: updateTarget, onTargetChange: onUpdateTargetChange, isDownloaded: isUpdateDownloaded,
        handoff: (next, hide, signal) => handOver(next, keepOpen ? () => {} : hide, signal), handoffCommitted: updateHandoverCommitted,
        markAttempt: writeGateRecord,
        show: window.show, hide: window.hide, onCancel: window.onCancel, onInstall: window.onInstall,
        // The failure is shown by the status bar (with a retry); nothing is remembered for the next start.
        recordFailure: () => {},
        downloadTotalMs: process.platform === 'darwin' ? MAC_GATE_DOWNLOAD_TOTAL_MS : undefined,
      }, version);
      handed = result === 'installing';
    } catch (error) {
      // A window that cannot be created must not make the button dead: an update that is already downloaded installs without it.
      console.error('update window failed', error);
      if (!handed && isUpdateDownloaded(version)) handed = await handOver(version, () => {}).catch(() => false);
    }
    finally { if (!handed) updateUi.release('install-window'); }
  })();
}

let mainAppStarted = false;
/** The window first, then the rest in parallel behind it (the gates are described at `accountsReady`). */
async function startMainApp(): Promise<void> {
  if (mainAppStarted) return;
  mainAppStarted = true;
  startupTimer.mark('main-app-start');
  createWindow();
  try {
    // The Pty Host process boots while the page loads; it is connected to the renderer on did-finish-load.
    ptyHost.start();
    startupTimer.mark('pty-host-started');
    // Its IPC handlers are registered in the same tick as the window: the page cannot call them before it has loaded.
    startSsh();
    startupTimer.mark('ssh-started');
    // Tabs that were in their own window at the last quit open there again.
    startDetachedWindows();
  } catch (error) {
    // As before the window came first: without terminals or SSH the start failed (with a message), it does not run half.
    startupFailed(error);
    return;
  }
  void cliDetector.refreshAll(); // async: the window does not wait for it, spawns wait only for their own CLI
  scheduleUpdateCleanup();
  const services = Promise.all([
    // Before any cell can start: files of removed cells and old startup prompts go.
    pruneCellFiles(cellFileDirs, cellIdsOf(state, false)).catch(() => 0).then(() => startupTimer.mark('cell-files-pruned')),
    // Without the hook server (loopback blocked by security software) the app still starts: agent states fall back to heuristics.
    hooks.start().catch((error: unknown) => { crashLog.error(`hook server did not start: ${describeError(error)}`); }).then(() => startupTimer.mark('hooks-started')),
    startMcp().then(() => startupTimer.mark('mcp-started')),
  ]).finally(() => { startupTimer.mark('cell-services-ready'); cellServicesReady.open(); });
  const accountsDone = recoverAccounts().finally(() => {
    accountsRecovered.open();
    accountsReady.open();
    usage.start();
    void pushSwapPending();
  });
  await Promise.all([services, accountsDone]);
}

/** Stops the timer that retries a 'locked' activation recovery (the quit calls it). */
let stopActivationRetry: (() => void) | undefined;
/** Startup account work; account IPC and the usage polls wait for it (`accountsReady`). */
async function recoverAccounts(): Promise<void> {
  try { await recoverActivation(); } finally { accountsRecovered.open(); }
  // A recovery still 'locked' is retried by its own timer too: the polls do not run while the limits panel is off.
  if (!quitting) stopActivationRetry = startActivationRecoveryRetry(retryActivationRecovery);
  // 0.9.0 -> 0.9.1: identities and duplicates of the saved accounts (once; nothing is deleted).
  try { await migrateAccounts(migrationDeps()); } catch { /* retried at the next start */ }
  startupTimer.mark('accounts-migrated');
}

async function recoverActivation(): Promise<void> {
  // An interrupted main-account swap is repaired (or reported as pending) before any IPC call can start another:
  // first a 0.9.1 (version 2) journal, otherwise the 0.9.0 recovery decides.
  try {
    // Shorter lock waits here: account actions wait for this; a recovery still 'locked' is retried by the polls.
    // Once the app quits no further attempt (nor the legacy recovery) starts: the journal stays and the next start retries.
    const recovered = await recoverActivationWithRetry({ ...activateDeps(), locks: { timeoutMs: 3_000 } }, undefined, undefined, () => quitting);
    if (recovered === 'legacy' && !quitting) await recoverInterruptedSwap(swapDeps());
  } catch { /* the journal stays and the next start retries */ }
  startupTimer.mark('accounts-recovered');
}

app.whenReady().then(async () => {
  startupTimer.mark('app-ready');
  // macOS and Linux shutdown or log-off: the quit that follows is never held by the "agents are working" question.
  // Whatever the order of this event and the quit, a held quit is released here (and the answer wait has an upper bound anyway).
  try { powerMonitor.on('shutdown', markSessionEnding); } catch { /* not available: only the question's upper bound applies */ }
  applyDockIcon();
  if (superseded) return;
  // The line is written when the renderer reports in; a start that never gets that far is written after a minute.
  setTimeout(() => void startupLog.flush(), 60_000).unref();
  // No default menu: its Ctrl+W / Ctrl+R accelerators would close or reload the window. macOS needs the app menu (Cmd+Q, hide)
  // and the Edit menu (Cmd+C / V / X / A / Z in text fields), still without View or Window roles (no Cmd+R, no Cmd+W).
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  initUpdater((s) => send('update:state', s), { strings: updateStrings });
  // macOS: an update whose swap did not happen counts as a failure of that version (the cooldown applies).
  const previous = await previousMacUpdate();
  if (previous.kind === 'failed') recordUpdateFailure(previous.version);
  // The new version is up: the update window of the update that just finished may say "done" now, and nothing of this start may
  // appear next to it (the prompt of a still newer release comes after it has gone).
  if (process.platform === 'win32' && app.isPackaged) { await signalUpdateReady(); await waitForUpdateWindowGone(4000); }
  if (await runUpdateGate()) return;
  startupTimer.mark('update-gate-done');
  await startMainApp();
}).catch(startFailedLate);

/** A start that failed after the module loaded: with no window yet the process would hold the lock unseen, so it ends. */
function startFailedLate(error: unknown): void {
  if (win || quitting) { crashLog.error(`startup step failed: ${describeError(error)}`); return; }
  startupFailed(error);
}

/** Ends the process; a launch that was swallowed during the wind-down is repeated, unless an update took over. */
function exitNow(): void {
  if (shouldRelaunchAfterQuit(relaunchRequested, updateHandoffStarted())) { try { app.relaunch(); } catch { /* nothing else to do */ } }
  // A key copied during the wind-down is cleared too (before-quit already cleared the earlier one).
  if (secretClipboard.pending()) void flushSecretClipboard().then(() => app.exit(0));
  else app.exit(0);
}

app.on('before-quit', (e) => {
  // Cmd+Q, the Dock or the macOS menu while agents work: held once while the renderer asks (never for a session end or an update).
  if (quitConfirm.hold()) { e.preventDefault(); return; }
  clearTimeout(handoffWatchdog);
  // A copied private key does not outlive the app in the clipboard, however the quit goes on (the wind-down below waits).
  void flushSecretClipboard();
  // The installer took over before anything was started, so there is nothing to wind down.
  if (quitting || gating || superseded) return;
  e.preventDefault();
  quitting = true;
  // However the wind-down goes (stuck terminals), the process must end: a running installer waits for it.
  const shutdownLimit = setTimeout(() => { crashLog.warn('shutdown overran its limit, exiting'); ptyHost.forceKill(); sftpHost.forceKill(); dbHost.forceKill(); exitNow(); }, SHUTDOWN_HARD_LIMIT_MS);
  usage.stop();
  stopActivationRetry?.();
  login.dispose();
  install.dispose();
  send('app:before-quit');
  // Give the renderer a moment to push its final state, then wind down terminals cleanly.
  setTimeout(async () => {
    // Detached windows close as they are (their registry stays for the next start); their pages flushed on app:before-quit.
    closeAllDetached();
    // Never throws; a save that still fails is logged by the saver and tried again below.
    saver.flush();
    // A running swap or "Set as main" finishes first (bounded, inside the hard limit): exiting in the middle of one can leave
    // the live login half swapped and Claude Code's lock directories behind. No new one starts now (account IPC refuses).
    const swapWait = {
      busy: isSwapRunning, idle: swapIdle,
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
    await waitUntilIdle(swapWait, QUIT_SWAP_WAIT_MS);
    try {
      await Promise.all([ptyHost.shutdown(), sftpHost.shutdown(), dbHost.shutdown()]);
      // An activation waiting for a Claude Code lock that a cell held gets it now: it may finish within the rest of the budget
      // (no wait at all when nothing runs).
      if (!(await waitUntilIdle(swapWait, QUIT_SWAP_AFTER_CELLS_MS))) {
        crashLog.warn(`quit did not wait for the account swap: still running after ${QUIT_SWAP_WAIT_MS + QUIT_SWAP_AFTER_CELLS_MS} ms`);
      }
      // A save that hit a lock gets a few more seconds (well inside the hard limit) instead of being lost.
      if (saver.hasPending() && !(await flushUntilSaved(saver, 3000))) crashLog.error('the last state changes could not be saved');
      await mcp.stop();
      hooks.stop();
    } catch (err) {
      crashLog.error(`shutdown failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    clearTimeout(shutdownLimit);
    exitNow();
  }, 150);
});
app.on('window-all-closed', () => { if (!gating) app.quit(); });

// Everything above ran: from here on an uncaught exception is a runtime error, not a failed start.
moduleLoaded = true;
startupTimer.mark('module-end');
