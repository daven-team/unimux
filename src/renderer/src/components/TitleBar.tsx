import { shortcutText, titleWithShortcut, useShortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { activeWorkspaceKey, workspaceOrder, reorderWorkspace } from '../../../shared/workspaceOrder';
import { describeLayout } from '../../../shared/layout';
import { activeProject, renameTab, PROJECT_COLORS } from '../../../shared/state';
import { addAgent, closeTab, selectTab } from '../actions';
import { setUi, update, useStore } from '../store';
import { profileOptionLabel } from '../cliUi';
import { openMenu, openMenuAt } from './ContextMenu';
import { IChevron, IPlusBold, ISearch, IX, TGrid, THistory, TSettings, TSidebar, TSnippet, TTerminal } from './icons';
import { FileIcon } from './FileIcon';
import { StatusBadges } from './StatusBadges';
import { Brand } from './Brand';
import { activateFile, closeFile, closeFiles, useFileStore, type FileDocument } from '../files';
import { useStatusCounts } from '../statusCounts';
import { locateInFiles } from '../explorer';
import { fullProjectPath } from '../../../shared/platform';
import { tabsToClose } from '../../../shared/fileOps';
import { revealScroll, scrollEdges, stepScroll, wheelScroll } from '../../../shared/tabStrip';
import { useSshStore } from '../sshStore';
import { activateSshView, closeSshView, reconnectAllSsh, reconnectAllTargetsOf, sshHostMenuItems } from '../ssh';

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
interface FileTab { id: string; projectId: string; name: string; relativePath: string; diff: boolean; dirty: boolean }
const fileTabsKey = (documents: readonly FileDocument[]): string =>
  JSON.stringify(documents.map((d) => [d.id, d.projectId, d.name, d.relativePath, !!d.diff, d.text !== d.savedText]));

export const WorkspaceTabs = memo(function WorkspaceTabs() {
  const { tr } = useI18n();
  useShortcutText(); // memoized: the shortcuts in the tooltips must still follow the settings
  const project = useStore((st) => activeProject(st.s));
  const profiles = useStore((st) => st.s.profiles);
  const lastProfileId = useStore((st) => st.s.settings.lastProfileId);
  const countsOf = useStatusCounts();
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const tabsKey = useFileStore((st) => fileTabsKey(st.documents));
  const documents = useMemo(() => (JSON.parse(tabsKey) as Array<[string, string, string, string, boolean, boolean]>)
    .map(([id, projectId, name, relativePath, diff, dirty]): FileTab => ({ id, projectId, name, relativePath, diff, dirty })), [tabsKey]);
  const selectedFile = useFileStore((st) => st.activeFileId);
  const activeFileId = documents.some((doc) => doc.id === selectedFile && doc.projectId === project?.id) ? selectedFile : null;
  const settingsTabOpen = useStore((st) => st.ui.settingsTabOpen);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  const sshOpen = useSshStore((st) => st.viewOpen);
  const sshActive = useSshStore((st) => st.viewActive);
  const [editing, setEditing] = useState<string | null>(null);
  const [orders, setOrders] = useState<Record<string, string[]>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('mc-workspace-order-v1') ?? '{}');
      return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((id) => typeof id === 'string')));
    } catch { return {}; }
  });
  const [drag, setDrag] = useState<{ id: string; projectId: string } | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const projectKey = project?.id ?? 'no-project';
  const order = workspaceOrder(orders[projectKey] ?? [], [
    ...(settingsTabOpen ? ['settings'] : []),
    ...(sshOpen ? ['ssh'] : []),
    ...(project?.tabs.map((t) => `grid:${t.id}`) ?? []),
    ...documents.filter((doc) => doc.projectId === project?.id).map((doc) => `file:${doc.id}`),
  ]);
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
      setDrag({ id, projectId: projectKey });
    },
    onDragEnd: endDrag,
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!drag || drag.projectId !== projectKey || drag.id === id) return;
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
      if (!drag || drag.projectId !== projectKey) return;
      e.preventDefault(); e.stopPropagation();
      const bounds = e.currentTarget.getBoundingClientRect();
      const next = reorderWorkspace(order, drag.id, id, e.clientX > bounds.left + bounds.width / 2);
      const saved = { ...orders, [projectKey]: next };
      setOrders(saved);
      try { localStorage.setItem('mc-workspace-order-v1', JSON.stringify(saved)); } catch { /* Current session order is retained. */ }
      if (project) update((st) => ({ ...st, projects: st.projects.map((p) => p.id === project.id
        ? { ...p, tabs: [...p.tabs].sort((a, b) => next.indexOf(`grid:${a.id}`) - next.indexOf(`grid:${b.id}`)) } : p) }));
      endDrag();
    },
  });

  // Many open tabs: the strip scrolls (wheel, arrows), keeps the active tab in view and has a list of all tabs.
  const stripRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ canLeft: false, canRight: false });
  const measure = () => {
    const el = stripRef.current;
    if (!el) return;
    const next = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setEdges((prev) => prev.canLeft === next.canLeft && prev.canRight === next.canRight ? prev : next);
  };
  // After the strip's content changed (tabs, names, badges, dirty marks); changes of its own size are the ResizeObserver's.
  useLayoutEffect(measure, [project, countsOf, documents, editing, settingsTabOpen, sshOpen, orders, tr]); // eslint-disable-line react-hooks/exhaustive-deps
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
  }, [activeKey, order.length]);
  const scrollStrip = (direction: -1 | 1) => {
    const el = stripRef.current;
    if (el) el.scrollBy({ left: stepScroll(direction, el.clientWidth), behavior: 'smooth' });
  };
  const allTabsMenu = (el: HTMLElement) => {
    if (!project) return;
    openMenuAt(el, [
      { header: tr('Wszystkie karty') },
      ...order.flatMap((key) => {
        const hint = key === activeKey ? '✓' : undefined;
        if (key === 'settings') return [{ label: tr('Ustawienia'), hint, onClick: () => setUi({ settingsActive: true }) }];
        if (key === 'ssh') return [{ label: tr('SSH'), hint, onClick: activateSshView }];
        if (key.startsWith('grid:')) {
          const t = project.tabs.find((tab) => `grid:${tab.id}` === key);
          return t ? [{ label: t.name, hint, onClick: () => selectTab(project.id, t) }] : [];
        }
        const doc = documents.find((d) => `file:${d.id}` === key);
        return doc ? [{ label: (doc.dirty ? '● ' : '') + doc.relativePath, hint, onClick: () => activateFile(doc.id) }] : [];
      }),
    ]);
  };
  const fileTabMenu = (x: number, y: number, doc: FileTab) => {
    const fileKeys = order.filter((key) => key.startsWith('file:'));
    const idsFor = (mode: 'others' | 'right' | 'all') => tabsToClose(fileKeys, `file:${doc.id}`, mode).map((key) => key.slice(5));
    const full = project ? fullProjectPath(project.path, doc.relativePath, window.mc.platform) : doc.relativePath;
    openMenu(x, y, [
      { header: doc.name },
      { label: tr('Zamknij'), onClick: () => void closeFile(doc.id) },
      { label: tr('Zamknij pozostałe'), disabled: idsFor('others').length === 0, onClick: () => void closeFiles(idsFor('others')) },
      { label: tr('Zamknij karty po prawej'), disabled: idsFor('right').length === 0, onClick: () => void closeFiles(idsFor('right')) },
      { label: tr('Zamknij wszystkie pliki'), onClick: () => void closeFiles(idsFor('all')) },
      { sep: true },
      { label: tr('Kopiuj ścieżkę'), onClick: () => window.mc.clipboardWrite(full) },
      { label: tr('Kopiuj ścieżkę względną'), onClick: () => window.mc.clipboardWrite(doc.relativePath) },
      { label: tr('Pokaż w menedżerze plików'), onClick: () => window.mc.revealPath(full) },
      { label: tr('Pokaż w panelu plików'), onClick: () => locateInFiles(doc.projectId, doc.relativePath) },
    ]);
  };

  const agentMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: tr("Dodaj komórkę do siatki") },
      ...profiles.map((p) => ({ label: profileOptionLabel(p, cliStatus, tr), onClick: () => void addAgent(p.id), hint: p.id === lastProfileId ? shortcutText('agent.add') || undefined : undefined })),
      { sep: true as const },
      { header: tr("W osobnym git worktree") },
      ...profiles.filter((p) => p.cli !== 'shell').map((p) => ({ label: `${profileOptionLabel(p, cliStatus, tr)} + worktree`, onClick: () => void addAgent(p.id, true) })),
      { sep: true as const },
      ...sshHostMenuItems('Komórka SSH'),
    ]);

  return <div className="workspace-tabs" aria-label={tr('Gridy i pliki')}>
    {(edges.canLeft || edges.canRight) && <button className="tabs-scroll no-drag" disabled={!edges.canLeft} title={tr('Przewiń karty w lewo')} aria-label={tr('Przewiń karty w lewo')} onClick={() => scrollStrip(-1)}><span className="chev-left"><IChevron /></span></button>}
    <div className="tabs no-drag" ref={stripRef} onScroll={measure}>
      {settingsTabOpen && <div {...dragProps('settings')} style={{ order: order.indexOf('settings') }} className={`tab settings-tab ${settingsActive ? 'active' : ''}`} onClick={() => setUi({ settingsActive: true })} onAuxClick={(e) => { if (e.button === 1) setUi({ settingsTabOpen: false, settingsActive: false }); }}>
        <span className="tab-type-icon"><TSettings /></span><span className="label">{tr('Ustawienia')}</span>
        <button className="x" aria-label={tr('Zamknij')} onClick={(e) => { e.stopPropagation(); setUi({ settingsTabOpen: false, settingsActive: false }); }}><IX /></button>
      </div>}
      {sshOpen && (
        <div {...dragProps('ssh')} style={{ order: order.indexOf('ssh') }} className={`tab ssh-tab ${activeKey === 'ssh' ? 'active' : ''}`}
          onClick={activateSshView} onAuxClick={(ev) => { if (ev.button === 1) closeSshView(); }}>
          <span className="tab-type-icon" aria-hidden="true"><TTerminal /></span><span className="label">{tr('SSH')}</span>
          <button className="x" aria-label={tr('Zamknij')} onClick={(ev) => { ev.stopPropagation(); closeSshView(); }}><IX /></button>
        </div>
      )}
      {project && (
        <>
          {project.tabs.map((t) => {
            const counts = countsOf(t.id);
            return (
              <div
                key={t.id}
                {...dragProps(`grid:${t.id}`)}
                className={`tab grid-tab ${activeKey === `grid:${t.id}` ? 'active' : ''}`}
                style={{ order: order.indexOf(`grid:${t.id}`), ...(t.color ? { '--tab-color': t.color } : {}) } as CSSProperties}
                onMouseDown={(e) => e.button === 0 && selectTab(project.id, t)}
                onAuxClick={(e) => e.button === 1 && void closeTab(project.id, t.id)}
                onDoubleClick={() => setEditing(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, [
                    { label: tr("Zmień nazwę"), onClick: () => setEditing(t.id) },
                    { header: tr('Kolor') },
                    { colors: PROJECT_COLORS, onPick: (color) => update((st) => ({ ...st, projects: st.projects.map((p) => p.id === project.id ? { ...p, tabs: p.tabs.map((tab) => tab.id === t.id ? { ...tab, color } : tab) } : p) })) },
                    ...(t.color ? [{ label: tr('Usuń kolor'), onClick: () => update((st) => ({ ...st, projects: st.projects.map((p) => p.id === project.id ? { ...p, tabs: p.tabs.map((tab) => tab.id === t.id ? { ...tab, color: undefined } : tab) } : p) })) }] : []),
                    { label: tr("Nowy grid") + '…', onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
                    ...(t.cells.some((c) => c.ssh) ? [{ label: tr('Wysyłanie masowe'), onClick: () => setUi({ modal: { kind: 'broadcast', projectId: project.id, tabId: t.id } }) }] : []),
                    ...(reconnectAllTargetsOf(project.id, t.id).length ? [{ label: tr('Połącz ponownie wszystkie SSH'), onClick: () => reconnectAllSsh(project.id, t.id) }] : []),
                    { sep: true },
                    { label: tr("Zamknij (do historii)"), danger: true, onClick: () => void closeTab(project.id, t.id), hint: shortcutText('tab.close') || undefined },
                  ]);
                }}
                title={tr("Dwuklik lub prawy klik: zmień nazwę · środkowy przycisk: zamknij")}
              >
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
                  <span className="label">{t.name}</span>
                )}
                <span className="size">{describeLayout(t.layout)}</span>
                <StatusBadges counts={counts} />
                <span className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeTab(project.id, t.id)}><IX /></span>
              </div>
            );
          })}
          {documents.filter((doc) => doc.projectId === project.id).map((doc) => (
            <div key={doc.id} {...dragProps(`file:${doc.id}`)} style={{ order: order.indexOf(`file:${doc.id}`) }} className={`tab file-tab ${activeKey === `file:${doc.id}` ? 'active' : ''}`} title={doc.relativePath}
              onClick={() => activateFile(doc.id)} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void closeFile(doc.id); } }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onContextMenu={(e) => { e.preventDefault(); fileTabMenu(e.clientX, e.clientY, doc); }}>
              <span className="tab-type-icon" aria-hidden="true"><FileIcon name={doc.name} /></span><span className="label">{doc.name}</span>{doc.diff && <span className="tab-diff-tag">diff</span>}
              {doc.dirty && <span className="file-dirty" aria-label={tr('Niezapisane zmiany')}>●</span>}
              <button className="x" aria-label={tr('Zamknij')} onClick={(e) => { e.stopPropagation(); void closeFile(doc.id); }}><IX /></button>
            </div>
          ))}
        </>
      )}
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
