import { chosenLanguage, loadLanguage, tr, useI18n } from './i18n';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { fitPanelWidths, MIN_WORKSPACE_WIDTH, RAIL_WIDTH, type Panel } from '../../shared/panels';
import { activeProject, activeTab, findCell, getProfile, updateCell } from '../../shared/state';
import { isAuxPtyId } from '../../shared/cliInstall';
import { ptyHostRestartToast } from '../../shared/ssh';
import type { McpInfo } from '../../shared/automation';
import { alertForStatus } from './alerts';
import { initQuitGuard } from './closeGuard';
import { noteAgentTurnEnd } from './turnRefresh';
import { initBackgroundLoader } from './backgroundLoader';
import { applyCliStatus, flushPendingSaves, ensureStarted, focusCell, hasBlockedCells, recheckCli, refreshSessionTitles, resetStarted, releaseCellTerminal, setAliveAtStart } from './actions';
import { CommandPalette } from './components/CommandPalette';
import { ContextMenuHost } from './components/ContextMenu';
import { ErrorBoundary, PanelFallback, WindowFallback } from './components/ErrorBoundary';
import { reportError } from './errorReport';
import { GridView } from './components/GridView';
import { LanguageSetup } from './components/LanguageSetup';
import { LazyScreen } from './components/LazyScreen';
import { Modals } from './components/Modals';
import { Sidebar } from './components/Sidebar';
import { SnippetPanel } from './components/SnippetPanel';
import { StatusBar } from './components/StatusBar';
import { TitleBar, WorkspaceTabs } from './components/TitleBar';
import { useShortcuts } from './shortcuts';
import { getS, getUi, setUi, toast, update, useStore } from './store';
import { terminals } from './terminals/TerminalManager';
// Rarely used screens load on demand: the editor alone (CodeMirror, language packs, Markdown preview) is about a third of the bundle.
const loadAutomationPanel = () => import('./components/AutomationPanel').then((m) => ({ default: m.AutomationPanel }));
const loadFileEditor = () => import('./components/FileEditor').then((m) => ({ default: m.FileEditor }));
const loadRedisTab = () => import('./components/redis/RedisTabView').then((m) => ({ default: m.RedisTabView }));
const loadSshView = () => import('./components/ssh/SshView').then((m) => ({ default: m.SshView }));
const loadSettingsPage = () => import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage }));
import { useFileStore, watchFilesOnDisk } from './files';
import { cancelReconnectAtStart, initSsh, markReconnectAtStart } from './ssh';
import { initSftp } from './sftp';
import { initRedis } from './redis/redisClient';
import { useSshStore } from './sshStore';
import { isWindowShown, onWindowShown } from './windowShown';

let booted = false;
/** Asked once per renderer (main answers true only to the first renderer load of the app run); a retried boot reuses it. */
let appStartClaim: Promise<boolean> | undefined;
/** The listeners registered before the first state arrives; a retried boot must not add them twice. */
let listening = false;

/** Starts the window; a failure before the state arrived can be retried (the window would stay blank otherwise). */
async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  try {
    await bootSteps();
  } catch (error) {
    reportError('boot', error);
    // Before the state arrived the window is blank: the user may try again. Afterwards the app runs; the error is only logged.
    if (useStore.getState().ready) return;
    booted = false;
    throw error;
  }
}

async function bootSteps(): Promise<void> {
  if (!listening) { listening = true; listenEarly(); }
  // Listening first: the startup scan may finish before the first answer arrives.
  const [snapshot, alive, mcpInfo, cliStatus] = await Promise.all([
    window.mc.loadSnapshot(), window.mc.aliveCells(), window.mc.getMcpInfo(), window.mc.cliStatus().catch(() => ({})),
  ]);
  setAliveAtStart(alive);
  appStartClaim ??= window.mc.claimAppStart().catch(() => false);
  // Before the state reaches the store, so no cell view can mount before its app-start mark (Łącz ponownie po uruchomieniu).
  if (await appStartClaim) markReconnectAtStart(snapshot.state);
  setUi({ cliStatus });
  // The translations of the chosen language load before the first real render: no untranslated texts at start.
  await loadLanguage(snapshot.state.settings.language ?? chosenLanguage()).catch((error) => reportError('boot', error));
  useStore.getState().init(snapshot);
  followScrollback();
  await bootRest(mcpInfo);
  window.mc.startupMark?.('renderer-boot');
}

/** Settings > Terminal > scrollback applies to every terminal, the open ones included. */
function followScrollback(): void {
  terminals.setScrollback(getS().settings.scrollbackLines);
  if (scrollbackFollowed) return;
  scrollbackFollowed = true;
  useStore.subscribe((st, prev) => {
    if (st.s.settings.scrollbackLines !== prev.s.settings.scrollbackLines) terminals.setScrollback(st.s.settings.scrollbackLines);
  });
}
let scrollbackFollowed = false;

function listenEarly(): void {
  terminals.setWindowsBuild(window.mc.windowsBuild);
  window.mc.on('state:changed', (change) => useStore.getState().applyChange(change));
  // A cell that disappears from the state (closed by main, MCP, a resync) loses its terminal, whichever way the state arrived.
  useStore.subscribe((st, prev) => {
    if (st.s.projects === prev.s.projects) return;
    const alive = new Set(st.s.projects.flatMap((p) => p.tabs.flatMap((t) => t.cells.map((c) => c.id))));
    for (const p of prev.s.projects) for (const t of p.tabs) for (const c of t.cells) if (!alive.has(c.id)) { releaseCellTerminal(c.id); useSshStore.getState().forgetCell(c.id); }
  });
  // Debounced edits (the font size of a wheel gesture) are sent before the window goes away or is reloaded.
  window.mc.on('app:before-quit', flushPendingSaves);
  window.addEventListener('beforeunload', flushPendingSaves);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPendingSaves(); });
  onWindowShown((shown) => { if (!shown) flushPendingSaves(); });
  window.mc.on('automation:start-cells', (ids) => ids.forEach((id) => ensureStarted(id)));
  window.mc.on('cli:changed', applyCliStatus);
  // Before the start claim is asked: a Pty Host restart heard before bootRest registers its full handlers still stops the
  // app-start SSH reconnect (main also refuses the claim after a restart).
  window.mc.on('ptyhost:crashed', cancelReconnectAtStart);
  window.mc.on('ptyhost:fatal', cancelReconnectAtStart);
}

/** One step of the start after the state arrived: a failure is reported and the start goes on (the listeners after it still register). */
function bootStep(step: () => void): void {
  try { step(); } catch (error) { reportError('boot', error); }
}

async function bootRest(mcpInfo: Awaited<ReturnType<typeof window.mc.getMcpInfo>>): Promise<void> {
  // Session states and open prompts of SSH cells (a reload finds them in main, R7).
  await initSsh().catch((error) => reportError('boot', error));
  await initSftp().catch((error) => reportError('boot', error));
  bootStep(initRedis);
  setUi({ mcpInfo });
  const state = getS();

  const missing: Record<string, true> = {};
  await Promise.all(state.projects.map(async (p) => {
    // A project folder that cannot be checked counts as present (the cell reports a missing folder when it starts).
    if (!(await window.mc.pathExists(p.path).catch((error) => { reportError('boot', error); return true; }))) missing[p.id] = true;
  }));
  setUi({ missingPaths: missing, focusedCellId: activeTab(activeProject(state))?.cells[0]?.id ?? null });
  bootStep(() => refreshSessionTitles(activeProject(state)?.path));
  let lastProject = state.activeProjectId;
  useStore.subscribe((st) => {
    if (st.s.activeProjectId === lastProject) return;
    lastProject = st.s.activeProjectId;
    refreshSessionTitles(activeProject(st.s)?.path);
  });

  // A conversation renamed inside the CLI (/rename) shows its new title in the cell header: look again now and then while the window is in use.
  // Titles show only on cells bound to a conversation: a project without any skips the periodic read.
  window.setInterval(() => {
    const project = activeProject(useStore.getState().s);
    if (document.hasFocus() && project?.tabs.some((t) => t.cells.some((c) => c.session))) refreshSessionTitles(project.path);
  }, 20000);
  window.addEventListener('focus', () => refreshSessionTitles(activeProject(useStore.getState().s)?.path, 800));

  // Coming back to the app (after installing a CLI in another window) is the moment to look again, but only if a cell waits for it.
  let focusTimer: number | undefined;
  window.addEventListener('focus', () => {
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => { if (hasBlockedCells()) void recheckCli(); }, 500);
  });
  // Open editor tabs follow files an agent (or anything else) changed on disk.
  bootStep(watchFilesOnDisk);
  window.mc.on('cell:restarted', (cellId) => { terminals.prepareSpawn(cellId); terminals.syncSize(cellId); });
  window.mc.on('cell:hook', (cellId, event, info) => terminals.hook(cellId, event, info));
  window.mc.on('cell:session', (cellId, session) => {
    update((s) => updateCell(s, cellId, { session }));
    // A different conversation: its title may not be indexed yet.
    const found = findCell(getS(), cellId);
    if (found && session.cli === 'claude') refreshSessionTitles(found.project.path, 1500);
  });
  window.mc.on('cell:spawnError', (cellId, message) => setUi((ui) => ({ cellErrors: { ...ui.cellErrors, [cellId]: message } })));
  window.mc.on('focus-cell', (cellId) => focusCell(cellId));
  window.mc.on('ptyhost:crashed', (resumes) => {
    // D1: SSH cells do not resume (D5), so the toast promises conversations only when a Claude or Codex cell was running.
    toast(tr(ptyHostRestartToast(resumes !== false)), 'error');
    resetStarted();
  });
  // No restart by itself: the visible cells try to start and show why they cannot.
  window.mc.on('ptyhost:fatal', () => {
    toast(tr('Proces terminali wielokrotnie się wysypał.'), 'error');
    resetStarted();
  });

  terminals.onStatus((cellId, status, prev, cause, reason, hooked, info) => {
    if (isAuxPtyId(cellId)) return; // login and install windows are not cells
    window.mc.reportCellStatus(cellId, status, reason, hooked);
    setUi((ui) => {
      const { [cellId]: previous, ...rest } = ui.failures;
      const failures = status === 'waiting' && reason === 'error' ? { ...rest, [cellId]: info?.error ?? 'unknown' } : previous === undefined ? ui.failures : rest;
      return { statuses: { ...ui.statuses, [cellId]: status }, failures };
    });
    if (status !== 'waiting') return;
    // A turn ended: the Files tree and the Git views of its project (or worktree) are read again, debounced (turnRefresh).
    if (prev === 'working') noteAgentTurnEnd(cellId);
    alertForStatus(cellId, status, prev, cause, reason, hooked, info);
    if (!hooked) bindCodexSession(cellId); // a cell whose notify hook works is bound by its committed turn ends instead
    // A turn finished: the agent may have (re)titled the conversation.
    const found = findCell(getS(), cellId);
    if (found && !found.cell.name) refreshSessionTitles(found.project.path, 3000);
  });
  // A Codex turn end the tracker committed (notify followed by quiet) names the thread the cell is really on.
  terminals.onCodexBind((cellId, thread) => {
    const found = findCell(getS(), cellId);
    if (!found || getProfile(getS(), found.cell.profileId).cli !== 'codex') return;
    const current = found.cell.session;
    // Never downgrade: the same thread stays as it is unless this report confirms it.
    if (current?.cli === 'codex' && current.id.toLowerCase() === thread.id && (current.confirmed || !thread.confirmed)) return;
    update((s) => updateCell(s, cellId, { session: { cli: 'codex', id: thread.id, confirmed: thread.confirmed } }));
  });
  terminals.onExit((cellId) => {
    if (isAuxPtyId(cellId)) return; // login and install windows are not cells
    // Shell exited (e.g. user typed `exit`) - keep the cell, offer a restart from its header.
    setUi((ui) => {
      const { [cellId]: _f, ...failures } = ui.failures;
      return { statuses: { ...ui.statuses, [cellId]: 'exited' }, failures };
    });
  });
  // Restore background cells with unfinished assigned work, without changing the user's selection.
  for (const task of state.automation.tasks) {
    if (!['completed', 'cancelled'].includes(task.status)) bootStep(() => ensureStarted(task.cellId));
  }
  bootStep(initBackgroundLoader);
  bootStep(initQuitGuard);
}

/**
 * A Codex cell just finished a turn. Cells with a working notify hook are bound exactly by the hook (main process); this
 * heuristic (the freshest unclaimed session file of the folder) only serves cells whose hook never reported.
 */
function bindCodexSession(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found || found.cell.session || getProfile(getS(), found.cell.profileId).cli !== 'codex') return;
  void window.mc.bindCodexSession(cellId, found.cell.worktree?.path ?? found.project.path);
}

// Parts without props, created once: when the app re-renders (a side panel edge dragged, a view switched) React skips them;
// they follow the store through their own selectors.
const titleBar = <TitleBar />;
const workspaceTabs = <WorkspaceTabs />;
const gridView = <GridView />;
const statusBar = <ErrorBoundary name="statusbar" fallback={(retry) => <PanelFallback retry={retry} className="statusbar" />}><StatusBar /></ErrorBoundary>;
const commandPalette = <ErrorBoundary name="palette" fallback={() => null}><CommandPalette /></ErrorBoundary>;
const modals = <ErrorBoundary name="modals" fallback={(retry) => <PanelFallback retry={() => { setUi({ modal: null }); retry(); }} className="modal-failed" />}><Modals /></ErrorBoundary>;
const contextMenuHost = <ContextMenuHost />;
const toastView = <Toast />;

export function App() {
  const { language } = useI18n();
  const projectId = useStore((st) => st.s.activeProjectId);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  const settingsTabOpen = useStore((st) => st.ui.settingsTabOpen);
  // A boolean, not the documents: typing in the editor must not re-render the whole app.
  // Tabs of files outside the projects (remote and local SFTP files, projectId '') show in every project.
  const fileOpen = useFileStore((st) => st.documents.some((doc) => doc.id === st.activeFileId && (doc.projectId === projectId || !doc.projectId)));
  const redisOpen = useFileStore((st) => st.documents.some((doc) => doc.id === st.activeFileId && !!doc.redis));
  const sshViewActive = useSshStore((st) => st.viewActive);
  const sshViewOpen = useSshStore((st) => st.viewOpen);
  const ready = useStore((st) => st.ready);
  const automationOpen = useStore((st) => st.ui.automationOpen);
  const languageChosen = useStore((st) => st.s.settings.language !== null);
  const snippetsOpen = useStore((st) => st.s.snippetsOpen);
  const collapsed = useStore((st) => st.s.sidebarCollapsed);
  const sidebarWidth = useStore((st) => st.s.sidebarWidth);
  const snippetsWidth = useStore((st) => st.s.snippetsWidth);
  const body = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(window.innerWidth);
  const [live, setLive] = useState<Partial<Record<Panel, number>>>({});
  const [bootFailed, setBootFailed] = useState(false);
  useEffect(() => {
    // The retry card is translated too: its language loads first (the state may not have arrived, so the system language).
    if (!bootFailed) boot().catch(() => loadLanguage(chosenLanguage()).catch(() => undefined).then(() => setBootFailed(true)));
  }, [bootFailed]);
  useEffect(() => {
    if (!ready) return;
    // Not while the window is hidden, and the store is only touched when the answer differs (every cell reads mcpInfo).
    const apply = (mcpInfo: McpInfo) => { if (JSON.stringify(mcpInfo) !== JSON.stringify(getUi().mcpInfo)) setUi({ mcpInfo }); };
    const refresh = () => {
      if (!isWindowShown()) return;
      void window.mc.getMcpInfo().then(apply).catch(() => {});
    };
    // Main pushes every change; the slow poll only catches a connection that went quiet (it expires without an event).
    const off = window.mc.on('mcp:info', apply);
    refresh();
    const timer = window.setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    const offShown = onWindowShown(refresh);
    return () => { off(); window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); offShown(); };
  }, [ready]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.platform = window.mc.platform;
  }, [language]);
  useLayoutEffect(() => {
    if (!ready || !body.current) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(body.current);
    return () => observer.disconnect();
  }, [ready, languageChosen]);
  useShortcuts();
  if (!ready) return bootFailed ? <WindowFallback message={tr('Nie udało się wczytać danych aplikacji.')} retry={() => setBootFailed(false)} /> : <div className="app" />;
  // The toast too: a language that fails to load in the preview says so.
  if (!languageChosen) return <><LanguageSetup />{toastView}</>;
  const widths = fitPanelWidths(available, live.sidebar ?? sidebarWidth, live.snippets ?? snippetsWidth, collapsed, snippetsOpen);
  const resizeProps = (panel: Panel) => ({
    panel,
    // The sidebar handle sizes the panel content; the rail in front of it is not part of that width.
    width: panel === 'sidebar' ? widths.sidebar - RAIL_WIDTH : widths.snippets,
    maxWidth: panel === 'sidebar'
      ? available - MIN_WORKSPACE_WIDTH - widths.snippets - RAIL_WIDTH
      : available - MIN_WORKSPACE_WIDTH - widths.sidebar,
    onResize: (width: number) => setLive((current) => ({ ...current, [panel]: width })),
    onFinish: (width: number | null) => {
      if (width !== null) update((s) => ({ ...s, [panel === 'sidebar' ? 'sidebarWidth' : 'snippetsWidth']: width }));
      setLive((current) => { const next = { ...current }; delete next[panel]; return next; });
    },
  });
  return (
    <div className="app" style={{ '--sidebar-width': `${widths.sidebar}px`, '--snippets-width': `${widths.snippets}px` } as CSSProperties}>
      {titleBar}
      <div className="app-body" ref={body}>
        <ErrorBoundary name="sidebar" fallback={(retry) => <PanelFallback retry={retry} className="sidebar" />}><Sidebar resize={resizeProps('sidebar')} /></ErrorBoundary>
        <div className="main">
          {workspaceTabs}
          <div className="workspace-content">
            <div className="terminal-workspace" style={{ display: fileOpen || settingsActive || sshViewActive ? 'none' : 'flex' }}>{gridView}</div>
            {settingsTabOpen && <div className="settings-workspace" style={{ display: settingsActive ? 'flex' : 'none' }}><LazyScreen load={loadSettingsPage} /></div>}
            {sshViewOpen && <div className="ssh-workspace" style={{ display: sshViewActive && !settingsActive ? 'flex' : 'none' }}><LazyScreen load={loadSshView} /></div>}
            {!settingsActive && !sshViewActive && fileOpen && <LazyScreen load={redisOpen ? loadRedisTab : loadFileEditor} key={redisOpen ? 'redis' : 'file'} />}
          </div>
          {automationOpen && <LazyScreen load={loadAutomationPanel} />}
        </div>
        {snippetsOpen && <ErrorBoundary name="snippets" fallback={(retry) => <PanelFallback retry={retry} />}><SnippetPanel resize={resizeProps('snippets')} /></ErrorBoundary>}
      </div>
      {statusBar}
      {commandPalette}
      {modals}
      {contextMenuHost}
      {toastView}
    </div>
  );
}

function Toast() {
  const t = useStore((st) => st.ui.toast);
  if (!t) return null;
  return <div className={`toast ${t.kind}`}>{t.text}</div>;
}

