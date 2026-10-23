// A detached window (1.0.6): one tab of the app on its own, e.g. on a second monitor. A grid keeps its running terminals (this
// window adopts them, like a reloaded window) and gets the grid's own tools: add a cell, maximize, the cell menus. A file tab
// keeps its editor or diff and its unsaved text. No sidebar, no strip of other tabs. "Przypnij z powrotem", the close button
// or dragging the tab onto the main window puts it back. See main/detachedWindows.ts and shared/detached.ts.
import { useEffect, useState, type DragEvent } from 'react';
import { DETACHED_FILE_SHORTCUTS, DETACHED_GRID_SHORTCUTS, findDetached, viewOverlay } from '../../../shared/detached';
import { activeProject, activeTab, findCell, getProfile, updateCell } from '../../../shared/state';
import { describeLayout } from '../../../shared/layout';
import { isAuxPtyId } from '../../../shared/cliInstall';
import { ptyHostRestartToast } from '../../../shared/ssh';
import { addAgent, applyCliStatus, ensureStarted, flushPendingSaves, focusCell, releaseCellTerminal, resetStarted, setAliveAtStart, toggleMaximize } from '../actions';
import { alertForStatus } from '../alerts';
import { adoptDocuments, portableDoc, reopenTarget } from '../detach';
import { activateFile, draftStorageKey, useFileStore } from '../files';
import { chosenLanguage, loadLanguage, tr, useI18n } from '../i18n';
import { reportError } from '../errorReport';
import { useShortcuts, shortcutText, titleWithShortcut } from '../shortcuts';
import { initSsh, sshHostMenuItems } from '../ssh';
import { useSshStore } from '../sshStore';
import { getS, setStateOverlay, setUi, toast, useStore } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { profileOptionLabel } from '../cliUi';
import { noteAgentTurnEnd } from '../turnRefresh';
import { detachedId, thisDetached } from '../windowRole';
import { openMenuAt, ContextMenuHost } from './ContextMenu';
import { ErrorBoundary, PanelFallback, WindowFallback } from './ErrorBoundary';
import { FileIcon } from './FileIcon';
import { GridView } from './GridView';
import { IChevron, IMax, IPlusBold, IRestore, TGrid } from './icons';
import { IAttachBack } from './detachIcons';
import { LazyScreen } from './LazyScreen';
import { Modals } from './Modals';
import { StatusBadges } from './StatusBadges';
import { useStatusCounts } from '../statusCounts';
import './detached.css';

const loadFileEditor = () => import('./FileEditor').then((m) => ({ default: m.FileEditor }));

// The window's own tab is the active project (and grid) for everything in this renderer.
if (detachedId !== null) setStateOverlay((s) => viewOverlay(s, findDetached(s, detachedId!)?.target ?? null));

let booted = false;
let attaching = false;

/** Back into the main window: the file's document (unsaved text included) goes with it; main closes this window. */
export async function attachBack(overMain = false): Promise<boolean> {
  if (attaching) return false;
  const entry = thisDetached();
  if (!entry) return false;
  attaching = true;
  try {
    flushPendingSaves();
    const docs = entry.target.kind === 'file' ? useFileStore.getState().documents.filter((d) => d.id === (entry.target as { fileId: string }).fileId).map(portableDoc) : [];
    return await window.mc.detach.attach(docs, overMain);
  } catch (error) {
    reportError('detach', error);
    return false;
  } finally { attaching = false; }
}

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  terminals.setWindowsBuild(window.mc.windowsBuild);
  window.mc.on('state:changed', (change) => useStore.getState().applyChange(change));
  // A cell removed from this grid (closed here, by MCP or in the main window) loses its terminal.
  useStore.subscribe((st, prev) => {
    if (st.s.projects === prev.s.projects) return;
    const alive = new Set(st.s.projects.flatMap((p) => p.tabs.flatMap((t) => t.cells.map((c) => c.id))));
    for (const p of prev.s.projects) for (const t of p.tabs) for (const c of t.cells) if (!alive.has(c.id)) { releaseCellTerminal(c.id); useSshStore.getState().forgetCell(c.id); }
  });
  window.mc.on('app:before-quit', flushPendingSaves);
  window.addEventListener('beforeunload', flushPendingSaves);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPendingSaves(); });
  window.mc.on('cli:changed', applyCliStatus);
  window.mc.on('detach:closing', () => { void attachBack(); });
  const [snapshot, alive, mcpInfo, cliStatus] = await Promise.all([
    window.mc.loadSnapshot(), window.mc.aliveCells(), window.mc.getMcpInfo(), window.mc.cliStatus().catch(() => ({})),
  ]);
  // The running ptys of this grid are adopted (their output is replayed), never started again.
  setAliveAtStart(alive);
  setUi({ cliStatus, mcpInfo });
  await loadLanguage(snapshot.state.settings.language ?? chosenLanguage()).catch((error) => reportError('boot', error));
  useStore.getState().init(snapshot);
  terminals.setScrollback(getS().settings.scrollbackLines);
  useStore.subscribe((st, prev) => { if (st.s.settings.scrollbackLines !== prev.s.settings.scrollbackLines) terminals.setScrollback(st.s.settings.scrollbackLines); });
  await initSsh().catch((error) => reportError('boot', error));
  window.mc.on('mcp:info', (info) => setUi({ mcpInfo: info }));
  window.mc.on('cell:restarted', (cellId) => { terminals.prepareSpawn(cellId); terminals.syncSize(cellId); });
  window.mc.on('cell:hook', (cellId, event, info) => terminals.hook(cellId, event, info));
  window.mc.on('cell:session', (cellId, session) => useStore.getState().update((s) => updateCell(s, cellId, { session })));
  window.mc.on('cell:spawnError', (cellId, message) => setUi((ui) => ({ cellErrors: { ...ui.cellErrors, [cellId]: message } })));
  window.mc.on('focus-cell', (cellId) => focusCell(cellId));
  window.mc.on('automation:start-cells', (ids) => ids.forEach((id) => ensureStarted(id)));
  window.mc.on('ptyhost:crashed', (resumes) => { toast(tr(ptyHostRestartToast(resumes !== false)), 'error'); resetStarted(); });
  window.mc.on('ptyhost:fatal', () => { toast(tr('Proces terminali wielokrotnie się wysypał.'), 'error'); resetStarted(); });
  terminals.onStatus((cellId, status, prev, cause, reason, hooked, info) => {
    if (isAuxPtyId(cellId)) return;
    // Main relays the status to the main window too (its badges and its quit question count this grid's agents).
    window.mc.reportCellStatus(cellId, status, reason, hooked);
    setUi((ui) => {
      const { [cellId]: previous, ...rest } = ui.failures;
      const failures = status === 'waiting' && reason === 'error' ? { ...rest, [cellId]: info?.error ?? 'unknown' } : previous === undefined ? ui.failures : rest;
      return { statuses: { ...ui.statuses, [cellId]: status }, failures };
    });
    if (status !== 'waiting') return;
    if (prev === 'working') noteAgentTurnEnd(cellId);
    alertForStatus(cellId, status, prev, cause, reason, hooked, info);
    const found = findCell(getS(), cellId);
    if (!hooked && found && !found.cell.session && getProfile(getS(), found.cell.profileId).cli === 'codex') void window.mc.bindCodexSession(cellId, found.cell.worktree?.path ?? found.project.path);
  });
  terminals.onExit((cellId) => {
    if (isAuxPtyId(cellId)) return;
    setUi((ui) => { const { [cellId]: _f, ...failures } = ui.failures; return { statuses: { ...ui.statuses, [cellId]: 'exited' }, failures }; });
  });
  const entry = thisDetached();
  if (entry?.target.kind === 'file') {
    await openTarget(entry.target);
    followClose(entry.target.fileId);
  }
  const tab = activeTab(activeProject(getS()));
  setUi({ focusedCellId: tab?.cells[0]?.id ?? null });
}

/** The file tab closed here (its own close button, after the save question): the window goes, nothing returns to the main window. */
function followClose(fileId: string): void {
  useFileStore.subscribe((st, prev) => {
    if (attaching || st.documents.some((d) => d.id === fileId) || !prev.documents.some((d) => d.id === fileId)) return;
    try { localStorage.removeItem(draftStorageKey(detachedId)); } catch { /* nothing stored */ }
    void window.mc.detach.dismiss();
  });
}

/** The file of a detached tab: the document handed over, else the draft kept for this window, else read again. */
async function openTarget(target: Extract<NonNullable<ReturnType<typeof thisDetached>>['target'], { kind: 'file' }>): Promise<void> {
  const handed = await window.mc.detach.take().catch(() => []);
  if (adoptDocuments(handed)) {
    // The draft reaches this window's storage now, not after the usual delay.
    flushPendingSaves();
    return;
  }
  if (useFileStore.getState().documents.some((d) => d.id === target.fileId)) { activateFile(target.fileId); return; }
  await reopenTarget(target);
}

export function DetachedApp() {
  const { language } = useI18n();
  const ready = useStore((st) => st.ready);
  const entry = useStore((st) => (detachedId === null ? undefined : findDetached(st.s, detachedId)));
  const kind = entry?.target.kind;
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!failed) boot().catch((error) => { reportError('boot', error); booted = false; setFailed(true); }); }, [failed]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.platform = window.mc.platform;
    document.documentElement.dataset.detached = '';
  }, [language]);
  useShortcuts(kind === 'file' ? DETACHED_FILE_SHORTCUTS : DETACHED_GRID_SHORTCUTS);
  if (!ready) return failed ? <WindowFallback message={tr('Nie udało się wczytać danych aplikacji.')} retry={() => setFailed(false)} /> : <div className="app detached-app" />;
  if (!entry) return <div className="app detached-app"><div className="detached-gone">{tr('Ta karta wróciła do głównego okna.')}</div></div>;
  return (
    <div className="app detached-app">
      <DetachedTitleBar />
      <div className="detached-body">
        {kind === 'grid'
          ? <div className="terminal-workspace"><GridView /></div>
          : <div className="file-pane"><LazyScreen load={loadFileEditor} /></div>}
      </div>
      <ErrorBoundary name="modals" fallback={(retry) => <PanelFallback retry={() => { setUi({ modal: null }); retry(); }} className="modal-failed" />}><Modals /></ErrorBoundary>
      <ContextMenuHost />
      <DetachedToast />
    </div>
  );
}

function DetachedToast() {
  const t = useStore((st) => st.ui.toast);
  return t ? <div className={`toast ${t.kind}`}>{t.text}</div> : null;
}

function DetachedTitleBar() {
  const { tr } = useI18n();
  const entry = useStore((st) => (detachedId === null ? undefined : findDetached(st.s, detachedId)));
  const project = useStore((st) => activeProject(st.s));
  const tab = useStore((st) => activeTab(activeProject(st.s)));
  const profiles = useStore((st) => st.s.profiles);
  const lastProfileId = useStore((st) => st.s.settings.lastProfileId);
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const maximized = useStore((st) => st.ui.maximizedCellId);
  const focused = useStore((st) => st.ui.focusedCellId);
  const dirty = useFileStore((st) => st.documents.some((d) => entry?.target.kind === 'file' && d.id === entry.target.fileId && d.text !== d.savedText));
  const countsOf = useStatusCounts();
  if (!entry) return null;
  const grid = entry.target.kind === 'grid';
  const name = grid ? tab?.name ?? '' : entry.target.kind === 'file' ? entry.target.name : '';
  const color = project?.color;
  const agentMenu = (el: HTMLElement) => openMenuAt(el, [
    { header: tr('Dodaj komórkę do siatki') },
    ...profiles.map((p) => ({ label: profileOptionLabel(p, cliStatus, tr), color: p.color, onClick: () => void addAgent(p.id), hint: p.id === lastProfileId ? shortcutText('agent.add') || undefined : undefined })),
    ...(profiles.some((p) => p.cli !== 'shell') ? [
      { sep: true as const },
      { header: tr('W osobnym git worktree') },
      ...profiles.filter((p) => p.cli !== 'shell').map((p) => ({ label: `${profileOptionLabel(p, cliStatus, tr)} + worktree`, color: p.color, onClick: () => void addAgent(p.id, true) })),
    ] : []),
    { sep: true as const },
    ...sshHostMenuItems('Komórka SSH'),
  ]);
  const maxTarget = maximized ?? focused ?? tab?.cells[0]?.id ?? null;
  // Dragged onto the main window (anywhere over it), the tab goes back; dropped elsewhere nothing happens.
  const dragProps = {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData('application/x-unimux-detached', detachedId ?? '');
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: (e: DragEvent<HTMLDivElement>) => { if (e.dataTransfer.dropEffect === 'none') void attachBack(true); },
  };
  return (
    <div className="titlebar detached-titlebar">
      <div className="detached-tab no-drag" {...dragProps} style={color ? { ['--project-color' as string]: color } : undefined}
        title={tr('Przeciągnij na główne okno, aby przypiąć z powrotem')}>
        {color && <span className="tab-project" aria-hidden="true" />}
        <span className="tab-type-icon" aria-hidden="true">{grid ? <TGrid /> : <FileIcon name={name} />}</span>
        <span className="label">{name}</span>
        {grid && tab && <span className="size">{describeLayout(tab.layout)}</span>}
        {grid && tab && <StatusBadges counts={countsOf(tab.id)} />}
        {dirty && <span className="file-dirty" aria-label={tr('Niezapisane zmiany')}>●</span>}
      </div>
      {project && <span className="detached-project">{project.name}</span>}
      <div className="spacer" />
      <div className="row no-drag detached-tools">
        {grid && tab && <>
          <button className="tb-btn" disabled={!maxTarget} title={titleWithShortcut(maximized ? tr('Przywróć') : tr('Maksymalizuj'), 'cell.maximize')} aria-label={maximized ? tr('Przywróć') : tr('Maksymalizuj')}
            onClick={() => maxTarget && toggleMaximize(maxTarget)}>{maximized ? <IRestore /> : <IMax />}</button>
          <button className="tb-add" title={titleWithShortcut(tr('Dodaj agenta do siatki'), 'agent.add')} onClick={(e) => agentMenu(e.currentTarget)}>
            <IPlusBold />  {tr('Dodaj')} <IChevron />
          </button>
        </>}
        <button className="btn small detached-attach" title={tr('Przypnij kartę z powrotem do głównego okna')} onClick={() => void attachBack()}>
          <IAttachBack /> {tr('Przypnij z powrotem')}
        </button>
      </div>
    </div>
  );
}
