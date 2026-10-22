import { shortcutText, titleWithShortcut, useShortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { activeWorkspaceKey, gridTabLabels, groupWorkspaceKeys, mergeWorkspaceOrder, migrateWorkspaceOrders, reorderWorkspace, sameOrder, scopeWorkspaceKeys, stripKeyOwner, stripKeys, syncTabsToOrder } from '../../../shared/workspaceOrder';
import { readLegacyOrders } from '../workspaceStrip';
import type { Project } from '../../../shared/types';
import { describeLayout } from '../../../shared/layout';
import { activeProject, renameTab, updateProject, updateSettings, PROJECT_COLORS } from '../../../shared/state';
import { addAgent, closeTab, selectTab } from '../actions';
import { setUi, update, useStore } from '../store';
import { profileOptionLabel } from '../cliUi';
import { openMenu, openMenuAt } from './ContextMenu';
import { IChevron, IPlusBold, ISearch, ITable, IX, TGrid, THistory, TSettings, TSidebar, TSnippet } from './icons';
import { DbKindIcon } from './db/DbKindIcon';
import { FileIcon } from './FileIcon';
import { StatusBadges } from './StatusBadges';
import { Brand } from './Brand';
import { activateFile, closeFile, closeFiles, keepFile, useFileStore, type FileDocument } from '../files';
import { useStatusCounts } from '../statusCounts';
import { locateInFiles } from '../explorer';
import { fullProjectPath } from '../../../shared/platform';
import { tabsToClose } from '../../../shared/fileOps';
import { sourceTitle, type FileSource } from '../../../shared/editorSource';
import type { RedisTabRef } from '../../../shared/redisView';
import { viewLabel } from '../redis/redisClient';
import type { DbTabRef } from '../../../shared/dbTabs';
import { revealScroll, scrollEdges, stepScroll, stripTabColor, wheelScroll } from '../../../shared/tabStrip';
import { dbConnectionColor } from '../../../shared/db';
import { useSshStore } from '../sshStore';
import { reconnectAllSsh, reconnectAllTargetsOf, sshHostMenuItems } from '../ssh';

export const TitleBar = memo(function TitleBar() {
  const { tr } = useI18n();
  useShortcutText(); // memoized: the shortcuts in the tooltips must still follow the settings
  const sidebarCollapsed = useStore((st) => st.s.sidebarCollapsed);
  const snippetsOpen = useStore((st) => st.s.snippetsOpen);
  const projectId = useStore((st) => activeProject(st.s)?.id);
  const automationOpen = useStore((st) => st.ui.automationOpen);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  const pendingTasks = useStore((st) => st.s.automation.tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length);
  return (
    <div className="titlebar">
      <Brand collapsed={sidebarCollapsed} />
      <div className="spacer" />
      <div className="row no-drag" style={{ gap: 2 }}>
        <button className="tb-btn" title={titleWithShortcut(tr("Szukaj wszędzie"), 'palette.open')} aria-label={tr("Szukaj wszędzie")} onClick={() => setUi({ palette: true })}><ISearch /></button>
        <button className={`tb-btn team-toggle ${automationOpen ? 'on' : ''}`} title={tr('Zadania i wiadomości agentów')} onClick={() => setUi({ automationOpen: !automationOpen })}>
          AI{pendingTasks > 0 && <span className="team-count">{pendingTasks}</span>}
        </button>
        {projectId && <button className="tb-btn" title={titleWithShortcut(tr("Historia czatów i gridów"), 'history.open')} onClick={() => setUi({ modal: { kind: 'history', projectId } })}><THistory /></button>}
        <button className={`tb-btn ${snippetsOpen ? 'on' : ''}`} title={titleWithShortcut(tr("Snippety"), 'snippets.toggle')} onClick={() => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen }))}><TSnippet /></button>
        <button className={`tb-btn ${!sidebarCollapsed ? 'on' : ''}`} title={titleWithShortcut(tr("Panel projektów"), 'sidebar.toggle')} onClick={() => update((st) => ({ ...st, sidebarCollapsed: !st.sidebarCollapsed }))}><TSidebar /></button>
        <button className={`tb-btn ${settingsActive ? 'on' : ''}`} title={tr("Ustawienia")} aria-label={tr("Ustawienia")} onClick={() => setUi({ settingsTabOpen: true, settingsActive: true })}><TSettings /></button>
      </div>
    </div>
  );
});

/** What a file tab shows (not the text): typing in the editor changes none of it except `dirty`. */
interface FileTab { id: string; projectId: string; name: string; relativePath: string; diff: boolean; dirty: boolean; source: FileSource | null; db: DbTabRef | null; redis: RedisTabRef | null; preview: boolean }
const fileTabsKey = (documents: readonly FileDocument[]): string =>
  JSON.stringify(documents.map((d) => [d.id, d.projectId, d.name, d.relativePath, !!d.diff, d.text !== d.savedText, d.source ?? null, d.db ?? null, d.redis ?? null, !!d.preview]));
/** A tab of the project on screen, or of a file outside the projects (remote and local SFTP files show in every project). */
const tabShown = (doc: { projectId: string }, projectId: string | undefined): boolean => !doc.projectId || doc.projectId === projectId;
/** A strip tab's place in the order and its one colour (the chip, the active top line), from stripTabColor. */
const stripTabStyle = (order: number, color: string | null): CSSProperties => ({ order, ...(color ? { '--project-color': color } : {}) }) as CSSProperties;

export const WorkspaceTabs = memo(function WorkspaceTabs() {
  const { tr } = useI18n();
  useShortcutText(); // memoized: the shortcuts in the tooltips must still follow the settings
  const project = useStore((st) => activeProject(st.s));
  // 1.0.0: the strip shows the open grids of every project.
  const projects = useStore((st) => st.s.projects);
  const savedOrder = useStore((st) => st.s.workspaceOrder);
  const profiles = useStore((st) => st.s.profiles);
  const lastProfileId = useStore((st) => st.s.settings.lastProfileId);
  const countsOf = useStatusCounts();
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const tabsKey = useFileStore((st) => fileTabsKey(st.documents));
  const documents = useMemo(() => (JSON.parse(tabsKey) as Array<[string, string, string, string, boolean, boolean, FileSource | null, DbTabRef | null, RedisTabRef | null, boolean]>)
    .map(([id, projectId, name, relativePath, diff, dirty, source, db, redis, preview]): FileTab => ({ id, projectId, name, relativePath, diff, dirty, source, db, redis, preview })), [tabsKey]);
  const dbConnections = useStore((st) => st.s.dbConnections);
  const dbGroupColors = useStore((st) => st.s.dbGroupColors);
  const dbConnection = (id: string) => dbConnections.find((c) => c.id === id);
  const sshHosts = useStore((st) => st.s.sshHosts);
  const hostLabel = (hostId: string) => sshHosts.find((h) => h.id === hostId)?.label ?? '?';
  const selectedFile = useFileStore((st) => st.activeFileId);
  const activeFileId = documents.some((doc) => doc.id === selectedFile && tabShown(doc, project?.id)) ? selectedFile : null;
  const settingsTabOpen = useStore((st) => st.ui.settingsTabOpen);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  // The SSH view has no tab (1.0.4); while it is in front no tab of the strip is.
  const sshActive = useSshStore((st) => st.viewActive);
  const stripScope = useStore((st) => st.s.settings.stripScope);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string } | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  // One global order in state.json; the first start of 1.0.0 builds it from the per-project orders of 0.9.x.
  const keys = useMemo(() => stripKeys({ settingsOpen: settingsTabOpen, projects, files: documents }), [settingsTabOpen, projects, documents]);
  const legacy = useRef<string[] | null>(null);
  if (!savedOrder && !legacy.current) legacy.current = migrateWorkspaceOrders(readLegacyOrders(), projects);
  // The tab that was in front at the last render: a grid opened now (sidebar, palette, History) lands right after it.
  const anchor = useRef<string | null>(null);
  const allKey = keys.join('\n');
  const order = useMemo(() => mergeWorkspaceOrder(savedOrder ?? legacy.current ?? [], keys, anchor.current), [savedOrder, allKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The order goes to state.json, and each project's grids follow it (the sidebar and its "last 3" agree with the strip).
  const gridIdsKey = projects.map((p) => p.tabs.map((t) => t.id).join(',')).join('|');
  useEffect(() => {
    update((st) => {
      const projectsInOrder = syncTabsToOrder(st.projects, order);
      if (sameOrder(st.workspaceOrder, order) && projectsInOrder === st.projects) return st;
      return { ...st, workspaceOrder: order, projects: projectsInOrder };
    });
  }, [order, savedOrder, gridIdsKey]);
  // 1.0.4: with the strip scope 'project' only the active project's tabs (and those of no project) show; the order keeps them all.
  const ownerOf = useMemo(() => stripKeyOwner({ projects, files: documents }), [projects, documents]);
  const shown = useMemo(() => scopeWorkspaceKeys(order, stripScope, project?.id ?? null, ownerOf), [order, stripScope, project?.id, ownerOf]);
  const visible = useMemo(() => new Set(shown), [shown]);
  const tabLabels = useMemo(() => gridTabLabels(projects), [projects]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const endDrag = () => { setDrag(null); setDrop(null); };
  const dragProps = (id: string) => ({
    draggable: editing !== id.slice(5),
    'data-workspace-id': id,
    'data-dragging': drag?.id === id ? '' : undefined,
    'data-drop': drop?.id === id ? (drop.after ? 'after' : 'before') : undefined,
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('input, .x')) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-unimux-workspace-tab', id);
      e.dataTransfer.effectAllowed = 'move';
      setDrag({ id });
    },
    onDragEnd: endDrag,
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!drag || drag.id === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const bounds = e.currentTarget.getBoundingClientRect();
      setDrop({ id, after: e.clientX > bounds.left + bounds.width / 2 });
      const strip = e.currentTarget.parentElement!;
      const viewport = strip.getBoundingClientRect();
      if (e.clientX < viewport.left + 32) strip.scrollLeft -= 20;
      if (e.clientX > viewport.right - 32) strip.scrollLeft += 20;
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!drag) return;
      e.preventDefault(); e.stopPropagation();
      const bounds = e.currentTarget.getBoundingClientRect();
      const next = reorderWorkspace(order, drag.id, id, e.clientX > bounds.left + bounds.width / 2);
      // Across projects too; each project's grids follow the strip (the sidebar lists them in that order).
      if (next !== order) update((st) => ({ ...st, workspaceOrder: next, projects: syncTabsToOrder(st.projects, next) }));
      if (next !== order && drag.id.startsWith('file:')) keepFile(drag.id.slice(5)); // a moved preview tab stays
      endDrag();
    },
  });

  // Many open tabs: the strip scrolls (wheel, arrows), keeps the active tab in view and has a list of all tabs.
  const stripRef = useRef<HTMLDivElement>(null);
  // The tab under the first click of a double click (null for a close button): a double click keeps only that tab, never one
  // that slid under the pointer because the first click closed a tab before it.
  const firstClick = useRef<string | null>(null);
  const [edges, setEdges] = useState({ canLeft: false, canRight: false });
  const measure = () => {
    const el = stripRef.current;
    if (!el) return;
    const next = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setEdges((prev) => prev.canLeft === next.canLeft && prev.canRight === next.canRight ? prev : next);
  };
  // After the strip's content changed (tabs, names, badges, dirty marks); changes of its own size are the ResizeObserver's.
  useLayoutEffect(measure, [projects, project?.id, countsOf, documents, editing, settingsTabOpen, shown, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || el.scrollWidth <= el.clientWidth) return;
      const delta = wheelScroll(e, el.clientWidth);
      if (!delta) return;
      e.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); el.removeEventListener('wheel', wheel); };
  }, []);
  const activeKey = activeWorkspaceKey({ settingsActive, sshActive, fileId: activeFileId, gridId: project?.activeTabId ?? null });
  useEffect(() => {
    const el = stripRef.current;
    if (!el || !activeKey) return;
    const tab = Array.from(el.children).find((child) => (child as HTMLElement).dataset.workspaceId === activeKey) as HTMLElement | undefined;
    if (!tab) return;
    const next = revealScroll({ scrollLeft: el.scrollLeft, width: el.clientWidth, scrollWidth: el.scrollWidth }, { left: tab.offsetLeft, width: tab.offsetWidth });
    if (next !== el.scrollLeft) el.scrollLeft = next;
  }, [activeKey, shown.length]);
  useEffect(() => { anchor.current = activeKey; });
  const scrollStrip = (direction: -1 | 1) => {
    const el = stripRef.current;
    if (el) el.scrollBy({ left: stepScroll(direction, el.clientWidth), behavior: 'smooth' });
  };
  const allTabsMenu = (el: HTMLElement) => {
    const gridProject = new Map<string, Project>(projects.flatMap((p) => p.tabs.map((t) => [`grid:${t.id}`, p] as [string, Project])));
    const item = (key: string) => {
      const hint = key === activeKey ? '✓' : undefined;
      if (key === 'settings') return [{ label: tr('Ustawienia'), hint, onClick: () => setUi({ settingsActive: true }) }];
      const owner = gridProject.get(key);
      if (owner) {
        const t = owner.tabs.find((tab) => `grid:${tab.id}` === key)!;
        return [{ label: t.name, hint, onClick: () => selectTab(owner.id, t) }];
      }
      const doc = documents.find((d) => `file:${d.id}` === key);
      return doc ? [{ label: (doc.dirty ? '● ' : '') + doc.relativePath, hint, onClick: () => activateFile(doc.id) }] : [];
    };
    // Grouped by project: Settings and files outside the projects first, then each project with its grids and files.
    const projectOf = (key: string) => gridProject.get(key)?.id ?? (documents.find((d) => `file:${d.id}` === key)?.projectId || null);
    const groups = groupWorkspaceKeys(shown, projectOf, projects.map((p) => p.id));
    openMenuAt(el, [
      { header: tr('Wszystkie karty') },
      // 1.0.4: the same switch as in Settings > App: the tabs of every project, or only of the project on screen.
      { label: tr('Tylko karty aktywnego projektu'), hint: stripScope === 'project' ? '✓' : undefined, onClick: () => update((st) => updateSettings(st, { stripScope: stripScope === 'project' ? 'all' : 'project' })) },
      { sep: true as const },
      ...groups.flatMap((group) => [
        ...(group.projectId ? [{ header: projects.find((p) => p.id === group.projectId)?.name ?? '' }] : []),
        ...group.keys.flatMap(item),
      ]),
    ]);
  };
  const fileTabMenu = (x: number, y: number, doc: FileTab) => {
    const fileKeys = shown.filter((key) => key.startsWith('file:'));
    const idsFor = (mode: 'others' | 'right' | 'all') => tabsToClose(fileKeys, `file:${doc.id}`, mode).map((key) => key.slice(5));
    if (doc.redis) {
      openMenu(x, y, [
        { header: doc.relativePath },
        { label: tr('Zamknij'), onClick: () => void closeFile(doc.id) },
        { label: tr('Zamknij pozostałe'), disabled: idsFor('others').length === 0, onClick: () => void closeFiles(idsFor('others')) },
        { label: tr('Zamknij karty po prawej'), disabled: idsFor('right').length === 0, onClick: () => void closeFiles(idsFor('right')) },
      ]);
      return;
    }
    if (doc.db) {
      const ref = doc.db;
      const objectName = ref.kind === 'table' ? `${ref.schema}.${ref.table}` : ref.kind === 'ddl' ? `${ref.schema}.${ref.name}` : null;
      openMenu(x, y, [
        { header: doc.name },
        { label: tr('Zamknij'), onClick: () => void closeFile(doc.id) },
        { label: tr('Zamknij pozostałe'), disabled: idsFor('others').length === 0, onClick: () => void closeFiles(idsFor('others')) },
        { label: tr('Zamknij karty po prawej'), disabled: idsFor('right').length === 0, onClick: () => void closeFiles(idsFor('right')) },
        ...(objectName ? [{ sep: true } as const, { label: tr('Kopiuj nazwę'), onClick: () => window.mc.clipboardWrite(objectName) }] : []),
      ]);
      return;
    }
    const owner = projects.find((p) => p.id === doc.projectId);
    const full = doc.source ? doc.source.path : owner ? fullProjectPath(owner.path, doc.relativePath, window.mc.platform) : doc.relativePath;
    openMenu(x, y, [
      { header: doc.name },
      { label: tr('Zamknij'), onClick: () => void closeFile(doc.id) },
      { label: tr('Zamknij pozostałe'), disabled: idsFor('others').length === 0, onClick: () => void closeFiles(idsFor('others')) },
      { label: tr('Zamknij karty po prawej'), disabled: idsFor('right').length === 0, onClick: () => void closeFiles(idsFor('right')) },
      { label: tr('Zamknij wszystkie pliki'), onClick: () => void closeFiles(idsFor('all')) },
      { sep: true },
      { label: tr('Kopiuj ścieżkę'), onClick: () => window.mc.clipboardWrite(full) },
      // A remote file has no local path; a local file outside the projects has no project to be relative to.
      ...(doc.source ? [] : [{ label: tr('Kopiuj ścieżkę względną'), onClick: () => window.mc.clipboardWrite(doc.relativePath) }]),
      ...(doc.source?.kind === 'remote' ? [] : [{ label: tr('Pokaż w menedżerze plików'), onClick: () => window.mc.revealPath(full) }]),
      ...(doc.source ? [] : [{ label: tr('Pokaż w panelu plików'), onClick: () => locateInFiles(doc.projectId, doc.relativePath) }]),
    ]);
  };

  const agentMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: tr("Dodaj komórkę do siatki") },
      ...profiles.map((p) => ({ label: profileOptionLabel(p, cliStatus, tr), color: p.color, onClick: () => void addAgent(p.id), hint: p.id === lastProfileId ? shortcutText('agent.add') || undefined : undefined })),
      { sep: true as const },
      { header: tr("W osobnym git worktree") },
      ...profiles.filter((p) => p.cli !== 'shell').map((p) => ({ label: `${profileOptionLabel(p, cliStatus, tr)} + worktree`, color: p.color, onClick: () => void addAgent(p.id, true) })),
      { sep: true as const },
      ...sshHostMenuItems('Komórka SSH'),
    ]);

  return <div className="workspace-tabs" aria-label={tr('Gridy i pliki')}>
    {(edges.canLeft || edges.canRight) && <button className="tabs-scroll no-drag" disabled={!edges.canLeft} title={tr('Przewiń karty w lewo')} aria-label={tr('Przewiń karty w lewo')} onClick={() => scrollStrip(-1)}><span className="chev-left"><IChevron /></span></button>}
    <div className="tabs no-drag" ref={stripRef} onScroll={measure}
      onMouseDownCapture={(e) => {
        const target = e.target as HTMLElement;
        if (e.detail <= 1) firstClick.current = target.closest('.x') ? null : target.closest<HTMLElement>('[data-workspace-id]')?.dataset.workspaceId ?? null;
      }}>
      {settingsTabOpen && <div {...dragProps('settings')} style={{ order: order.indexOf('settings') }} className={`tab settings-tab ${settingsActive ? 'active' : ''}`} onClick={() => setUi({ settingsActive: true })} onAuxClick={(e) => { if (e.button === 1) setUi({ settingsTabOpen: false, settingsActive: false }); }}>
        <span className="tab-type-icon"><TSettings /></span><span className="label">{tr('Ustawienia')}</span>
        <button className="x" aria-label={tr('Zamknij')} onClick={(e) => { e.stopPropagation(); setUi({ settingsTabOpen: false, settingsActive: false }); }}><IX /></button>
      </div>}
      {/* The open grids of every project (1.0.0); a click on a grid of another project switches the project. */}
      {projects.flatMap((project) => project.tabs.map((t) => {
            if (!visible.has(`grid:${t.id}`)) return null;
            const counts = countsOf(t.id);
            const color = stripTabColor({ project, grid: t });
            return (
              <div
                key={`${project.id}:${t.id}`}
                {...dragProps(`grid:${t.id}`)}
                data-project-id={project.id}
                className={`tab grid-tab ${activeKey === `grid:${t.id}` ? 'active' : ''}`}
                style={stripTabStyle(order.indexOf(`grid:${t.id}`), color)}
                onMouseDown={(e) => e.button === 0 && selectTab(project.id, t)}
                onAuxClick={(e) => e.button === 1 && void closeTab(project.id, t.id)}
                onDoubleClick={() => setEditing(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, [
                    { label: tr("Zmień nazwę"), onClick: () => setEditing(t.id) },
                    // The strip shows the project's colour (not the grid's own), so this is what the swatches change.
                    { header: tr('Kolor projektu') },
                    { colors: PROJECT_COLORS, onPick: (color) => update((st) => updateProject(st, project.id, { color })) },
                    { label: tr("Nowy grid") + '…', onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
                    ...(t.cells.some((c) => c.ssh) ? [{ label: tr('Wysyłanie masowe'), onClick: () => setUi({ modal: { kind: 'broadcast', projectId: project.id, tabId: t.id } }) }] : []),
                    ...(reconnectAllTargetsOf(project.id, t.id).length ? [{ label: tr('Połącz ponownie wszystkie SSH'), onClick: () => reconnectAllSsh(project.id, t.id) }] : []),
                    { sep: true },
                    { label: tr("Zamknij (do historii)"), danger: true, onClick: () => void closeTab(project.id, t.id), hint: shortcutText('tab.close') || undefined },
                  ]);
                }}
                title={`${tr('Projekt: {name}', { name: project.name })}\n${tr("Dwuklik lub prawy klik: zmień nazwę · środkowy przycisk: zamknij")}`}
              >
                {color && <span className="tab-project" aria-hidden="true" />}
                <span className="tab-type-icon" aria-hidden="true"><TGrid /></span>
                {editing === t.id ? (
                  <input
                    autoFocus
                    defaultValue={t.name}
                    onBlur={(e) => {
                      update((st) => renameTab(st, project.id, t.id, e.target.value.trim() || t.name));
                      setEditing(null);
                    }}
                    onFocus={(e) => e.target.select()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                ) : (
                  <span className="label">{tabLabels.get(t.id) ?? t.name}</span>
                )}
                <span className="size">{describeLayout(t.layout)}</span>
                <StatusBadges counts={counts} />
                <span className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeTab(project.id, t.id)}><IX /></span>
              </div>
            );
          }))}
          {/* Files of every project (1.0.0) with their project's colour chip; files outside the projects have none. */}
          {documents.map((doc) => {
            if (!visible.has(`file:${doc.id}`)) return null;
            if (doc.redis) {
              const c = dbConnection(doc.redis.connectionId);
              const color = stripTabColor({ connection: c ? { color: dbConnectionColor(dbGroupColors, c) } : null });
              return (
                <div key={doc.id} {...dragProps(`file:${doc.id}`)} style={stripTabStyle(order.indexOf(`file:${doc.id}`), color)}
                  className={`tab file-tab redis-strip-tab ${activeKey === `file:${doc.id}` ? 'active' : ''}`} title={doc.relativePath}
                  onClick={() => activateFile(doc.id)} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void closeFile(doc.id); } }}
                  onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
                  onContextMenu={(e) => { e.preventDefault(); fileTabMenu(e.clientX, e.clientY, doc); }}>
                  {color && <span className="tab-project" aria-hidden="true" />}
                  <span className="tab-type-icon" aria-hidden="true"><DbKindIcon kind="redis" /></span><span className="label">{doc.name}</span>
                  <span className="tab-host-tag">{doc.redis.view === 'keys' ? `DB ${doc.redis.db}` : viewLabel(doc.redis.view)}</span>
                  <button className="x" aria-label={tr('Zamknij')} onClick={(e) => { e.stopPropagation(); void closeFile(doc.id); }}><IX /></button>
                </div>
              );
            }
            const owner = projectById.get(doc.projectId);
            if (doc.db) {
              const c = dbConnection(doc.db.connectionId);
              const color = stripTabColor({ connection: c ? { color: dbConnectionColor(dbGroupColors, c) } : null });
              return (
                <div key={doc.id} {...dragProps(`file:${doc.id}`)}
                  style={stripTabStyle(order.indexOf(`file:${doc.id}`), color)}
                  className={`tab file-tab db-tab-strip ${activeKey === `file:${doc.id}` ? 'active' : ''}`}
                  title={doc.relativePath}
                  onClick={() => activateFile(doc.id)} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void closeFile(doc.id); } }}
                  onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
                  onContextMenu={(e) => { e.preventDefault(); fileTabMenu(e.clientX, e.clientY, doc); }}>
                  {color && <span className="tab-project" aria-hidden="true" />}
                  <span className="tab-type-icon" aria-hidden="true">{doc.db.kind === 'table' ? <ITable /> : <DbKindIcon kind="postgres" />}</span><span className="label">{doc.name}</span>
                  {doc.db.kind === 'ddl' && <span className="tab-diff-tag">DDL</span>}
                  <span className="tab-host-tag">{c?.name ?? '?'}</span>
                  {doc.dirty && <span className="file-dirty" aria-label={tr('Niezapisane zmiany')}>●</span>}
                  <button className="x" aria-label={tr('Zamknij')} onClick={(e) => { e.stopPropagation(); void closeFile(doc.id); }}><IX /></button>
                </div>
              );
            }
            const color = stripTabColor({ project: owner });
            return (
            <div key={doc.id} {...dragProps(`file:${doc.id}`)} data-project-id={owner?.id}
              style={stripTabStyle(order.indexOf(`file:${doc.id}`), color)}
              className={`tab file-tab ${activeKey === `file:${doc.id}` ? 'active' : ''} ${doc.preview ? 'preview' : ''}`}
              title={(doc.source ? sourceTitle(doc.source, doc.source.kind === 'remote' ? hostLabel(doc.source.hostId) : undefined) : `${doc.relativePath}${owner ? `
${tr('Projekt: {name}', { name: owner.name })}` : ''}`)
                + (doc.preview ? `
${tr('Podgląd: następny kliknięty plik zastąpi tę kartę. Dwuklik zachowuje ją na stałe.')}` : '')}
              onClick={() => activateFile(doc.id)} onDoubleClick={() => { if (firstClick.current === `file:${doc.id}`) keepFile(doc.id); }} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void closeFile(doc.id); } }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onContextMenu={(e) => { e.preventDefault(); fileTabMenu(e.clientX, e.clientY, doc); }}>
              {color && <span className="tab-project" aria-hidden="true" />}
              <span className="tab-type-icon" aria-hidden="true"><FileIcon name={doc.name} /></span><span className="label">{doc.name}</span>{doc.diff && <span className="tab-diff-tag">diff</span>}
              {doc.source?.kind === 'remote' && <span className="tab-host-tag">{hostLabel(doc.source.hostId)}</span>}
              {doc.dirty && <span className="file-dirty" aria-label={tr('Niezapisane zmiany')}>●</span>}
              <button className="x" aria-label={tr('Zamknij')} onClick={(e) => { e.stopPropagation(); void closeFile(doc.id); }}><IX /></button>
            </div>
            );
          })}
    </div>
    {(edges.canLeft || edges.canRight) && <button className="tabs-scroll no-drag" disabled={!edges.canRight} title={tr('Przewiń karty w prawo')} aria-label={tr('Przewiń karty w prawo')} onClick={() => scrollStrip(1)}><span className="chev-right"><IChevron /></span></button>}
    {project && <>
      <button className="tabs-scroll tabs-all no-drag" title={tr('Wszystkie karty')} aria-label={tr('Wszystkie karty')} aria-haspopup="menu" onClick={(e) => allTabsMenu(e.currentTarget)}><IChevron /></button>
      <button className="tb-btn" title={titleWithShortcut(tr("Nowy grid"), 'grid.new')} onClick={() => setUi({ modal: { kind: 'grid', projectId: project.id } })}><TGrid /></button>
      <button className="tb-add" title={titleWithShortcut(tr("Dodaj agenta do siatki"), 'agent.add')} onClick={(e) => agentMenu(e.currentTarget)}>
        <IPlusBold />  {tr("Dodaj")} <IChevron />
      </button>
    </>}
  </div>;
});
