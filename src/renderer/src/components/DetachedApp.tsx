// A detached window (1.0.6): one tab of the app on its own, e.g. on a second monitor. A grid keeps its running terminals (this
// window adopts them, like a reloaded window) and gets the grid's own tools: add a cell, maximize, the cell menus. A file tab
// keeps its editor or diff and its unsaved text. No sidebar, no strip of other tabs. "Przypnij z powrotem", the close button
// or dragging the tab onto the main window puts it back. See main/detachedWindows.ts and shared/detached.ts.
// 1.0.8: a database, Redis or remote file tab too: it keeps its sessions (an open transaction, Pub/Sub), what it showed and its
// unsaved values; this window reports its unsaved database work to the main window's quit question.
import { useEffect, useState, type DragEvent } from 'react';
import { cleanWork, DETACHED_FILE_SHORTCUTS, DETACHED_GRID_SHORTCUTS, findDetached, viewOverlay } from '../../../shared/detached';
import { activeProject, activeTab, findCell, getProfile, updateCell } from '../../../shared/state';
import { describeLayout } from '../../../shared/layout';
import { isAuxPtyId } from '../../../shared/cliInstall';
import { ptyHostRestartToast } from '../../../shared/ssh';
import { addAgent, applyCliStatus, ensureStarted, flushPendingSaves, focusCell, releaseCellTerminal, resetStarted, setAliveAtStart } from '../actions';
import { alertForStatus } from '../alerts';
import { adoptDocuments, portableDoc, reopenTarget, tabHandoff } from '../detach';
import { activateFile, draftStorageKey, useFileStore, watchFilesOnDisk } from '../files';
import { databaseWork, dbTabBusy, initDbTabs } from '../db/tabs';
import { useDbStore } from '../db/dbClient';
import { initRedis } from '../redis/redisClient';
import { useRedisDrafts } from '../redis/redisDrafts';
import { initSftpFollow } from '../sftp';
import { chosenLanguage, loadLanguage, tr, useI18n } from '../i18n';
import { reportError } from '../errorReport';
import { useShortcuts, shortcutText, titleWithShortcut } from '../shortcuts';
import { initSsh, sshHostMenuItems } from '../ssh';
import { initPromptQueue } from '../promptQueue';
import { useSshStore } from '../sshStore';
import { getS, setStateOverlay, setUi, toast, useStore } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { isPermissionAnswer } from '../../../shared/permissionAction';
import { profileOptionLabel } from '../cliUi';
import { noteAgentTurnEnd } from '../turnRefresh';
import { detachedId, thisDetached } from '../windowRole';
import { openMenuAt, ContextMenuHost } from './ContextMenu';
import { ErrorBoundary, PanelFallback, WindowFallback } from './ErrorBoundary';
import { FileIcon } from './FileIcon';
import { GridView } from './GridView';
import { IChevron, IPlusBold, ITable, TGrid } from './icons';
import { DbKindIcon } from './db/DbKindIcon';
import { IAttachBack } from './detachIcons';
import { LazyScreen } from './LazyScreen';
import { Modals } from './Modals';
import { StatusBadges } from './StatusBadges';
import { useStatusCounts } from '../statusCounts';
import './detached.css';

const loadFileEditor = () => import('./FileEditor').then((m) => ({ default: m.FileEditor }));
const loadRedisTab = () => import('./redis/RedisTabView').then((m) => ({ default: m.RedisTabView }));
const loadDbTab = () => import('./db/DbTabView').then((m) => ({ default: m.DbTabView }));

// The window's own tab is the active project (and grid) for everything in this renderer.
if (detachedId !== null) setStateOverlay((s) => viewOverlay(s, findDetached(s, detachedId!)?.target ?? null));

let booted = false;
let attaching = false;

/**
 * Back into the main window: the file's document (unsaved text included) goes with it, and a database or Redis tab's handoff
 * (its sessions, what it showed, its unsaved values; a query that runs is asked about first); main closes this window.
 * `closing`: the window's close button asked (main waits only a moment unless this window says it needs longer).
 */
export async function attachBack(overMain = false, closing = false): Promise<boolean> {
  if (attaching) return false;
  const entry = thisDetached();
  if (!entry) return false;
  attaching = true;
  try {
    flushPendingSaves();
    const fileId = entry.target.kind === 'file' ? entry.target.fileId : null;
    const docOf = () => useFileStore.getState().documents.find((d) => d.id === fileId);
    const before = docOf();
    // A question (a query that runs) or a page that loads takes longer than main waits for a closing window.
    if (closing && before?.db && dbTabBusy(before.id)) window.mc.detach.stay();
    const handoff = before ? await tabHandoff(before) : null;
    if (handoff === false) return false;
    const doc = docOf();
    const docs: unknown[] = doc ? [portableDoc(doc), ...(handoff ? [handoff] : [])] : [];
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
  window.mc.on('detach:closing', () => { void attachBack(false, true); });
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
  // 1.0.9: this window serves the prompt queues of the cells it holds.
  initPromptQueue();
  window.mc.on('mcp:info', (info) => setUi({ mcpInfo: info }));
  window.mc.on('cell:restarted', (cellId) => { terminals.prepareSpawn(cellId); terminals.syncSize(cellId); });
  window.mc.on('cell:hook', (cellId, event, info) => terminals.hook(cellId, event, info));
  window.mc.on('cell:session', (cellId, session) => useStore.getState().update((s) => updateCell(s, cellId, { session })));
  window.mc.on('cell:spawnError', (cellId, message) => setUi((ui) => ({ cellErrors: { ...ui.cellErrors, [cellId]: message } })));
  window.mc.on('focus-cell', (cellId) => focusCell(cellId));
  // 1.0.9: Zezwól / Odrzuć from a permission notification; a stale one (the cell changed since) only shows the cell.
  window.mc.on('notify:answer', (cellId, token, answer) => { if (!isPermissionAnswer(answer) || !terminals.answerPermission(cellId, token, answer)) window.mc.showCell(cellId); });
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
  // The short reason of a status ("czeka na zgodę: Bash", "praca: Edit") for the cell card.
  terminals.onDetail((cellId, detail) => {
    if (isAuxPtyId(cellId)) return;
    setUi((ui) => {
      if (detail) return { statusDetails: { ...ui.statusDetails, [cellId]: detail } };
      if (!(cellId in ui.statusDetails)) return {};
      const { [cellId]: _d, ...statusDetails } = ui.statusDetails;
      return { statusDetails };
    });
  });
  terminals.onExit((cellId) => {
    if (isAuxPtyId(cellId)) return;
    setUi((ui) => { const { [cellId]: _f, ...failures } = ui.failures; return { statuses: { ...ui.statuses, [cellId]: 'exited' }, failures }; });
  });
  const entry = thisDetached();
  if (entry?.target.kind === 'file') {
    // 1.0.8: database, Redis and remote file tabs: their sessions, ports and prompts work here as in the main window.
    initDbTabs();
    initRedis();
    watchFilesOnDisk();
    void initSftpFollow();
    await openTarget(entry.target);
    followClose(entry.target.fileId);
    reportWork();
  }
  const tab = activeTab(activeProject(getS()));
  setUi({ focusedCellId: tab?.cells[0]?.id ?? null });
}

/** This window's unsaved database work goes to the main window (its quit question counts it), whenever it changes. */
function reportWork(): void {
  let last = '';
  const send = () => {
    const work = cleanWork(databaseWork());
    const key = JSON.stringify(work);
    if (key === last) return;
    last = key;
    window.mc.detach.work(work);
  };
  useDbStore.subscribe((st, prev) => { if (st.sessions !== prev.sessions || st.tabSessions !== prev.tabSessions) send(); });
  useFileStore.subscribe((st, prev) => { if (st.documents !== prev.documents) send(); });
  useRedisDrafts.subscribe((st, prev) => { if (st.drafts !== prev.drafts) send(); });
  send();
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
  if (await adoptDocuments(handed)) {
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
  // What the file tab is: a database, a Redis or an editor view.
  const view = useFileStore((st) => {
    const d = entry?.target.kind === 'file' ? st.documents.find((x) => x.id === (entry.target as { fileId: string }).fileId) : undefined;
    return d?.redis ? 'redis' : d?.db ? 'db' : 'file';
  });
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
          : <div className="file-pane"><LazyScreen load={view === 'redis' ? loadRedisTab : view === 'db' ? loadDbTab : loadFileEditor} key={view} /></div>}
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
  const dirty = useFileStore((st) => st.documents.some((d) => entry?.target.kind === 'file' && d.id === entry.target.fileId && d.text !== d.savedText));
  // 1.0.8: a database, Redis or remote tab belongs to no project: its icon and where it is (connection, host) instead.
  const doc = useFileStore((st) => (entry?.target.kind === 'file' ? st.documents.find((d) => d.id === (entry.target as { fileId: string }).fileId) : undefined));
  const connection = useStore((st) => { const id = doc?.db?.connectionId ?? doc?.redis?.connectionId; return id ? st.s.dbConnections?.find((c) => c.id === id) : undefined; });
  const hostLabel = useStore((st) => (doc?.source?.kind === 'remote' ? st.s.sshHosts.find((h) => h.id === (doc.source as { hostId: string }).hostId)?.label : undefined));
  const countsOf = useStatusCounts();
  if (!entry) return null;
  const grid = entry.target.kind === 'grid';
  const name = grid ? tab?.name ?? '' : entry.target.kind === 'file' ? entry.target.name : '';
  const outside = entry.target.kind === 'file' && !entry.target.projectId;
  const color = outside ? undefined : project?.color;
  const icon = grid ? <TGrid /> : doc?.redis ? <DbKindIcon kind="redis" /> : doc?.db?.kind === 'table' ? <ITable />
    : doc?.db ? <DbKindIcon kind={connection?.kind === 'mysql' || connection?.kind === 'sqlite' ? connection.kind : 'postgres'} flavor={connection?.flavor} /> : <FileIcon name={name} />;
  // A Redis tab is named after its connection: its view and DB say where it is ("cache · Pub/Sub · DB 0").
  const where = !outside ? project?.name : doc?.redis ? doc.relativePath : doc?.db ? connection?.name : hostLabel ? `${hostLabel}:${doc?.relativePath ?? ''}` : doc?.relativePath;
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
        <span className="tab-type-icon" aria-hidden="true">{icon}</span>
        <span className="label">{name}</span>
        {grid && tab && <span className="size">{describeLayout(tab.layout)}</span>}
        {grid && tab && <StatusBadges counts={countsOf(tab.id)} />}
        {dirty && <span className="file-dirty" aria-label={tr('Niezapisane zmiany')}>●</span>}
      </div>
      {where && <span className="detached-project" title={doc?.relativePath}>{where}</span>}
      <div className="spacer" />
      <div className="row no-drag detached-tools">
        {grid && tab && <>
          {/* 1.0.7: no grid-wide maximize button here: every cell has its own (and the shortcut stays), a lone square looked lost. */}
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
