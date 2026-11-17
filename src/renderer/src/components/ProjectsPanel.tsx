import { shortcutText, titleWithShortcut } from '../shortcuts';
import type { MenuItem } from './ContextMenu';
import { useI18n } from '../i18n';
import { useMemo, useState } from 'react';
import { PROJECT_COLORS, renameTab, updateProject } from '../../../shared/state';
import { dropOnProject, folderOf, moveTreeItem, newFolderWith, projectTree, removeFolder, setFoldersCollapsed, updateFolder, type TreeItem, type TreeTarget } from '../../../shared/projectFolders';
import { PANEL_LIMITS } from '../../../shared/panels';
import type { StatusCounts } from '../../../shared/status';
import { projectCountsKey } from '../../../shared/statusCounts';
import { useStatusCounts } from '../statusCounts';
import { describeLayout } from '../../../shared/layout';
import type { Project, ProjectFolder } from '../../../shared/types';
import { addProjectFolder, closeTab, createProject, createProjectFolder, relocateProject, removeProject, renameProjectFolder, selectTab, switchProject } from '../actions';
import { askText, getS, setUi, toast, update, useStore } from '../store';
import { useSshStore } from '../sshStore';
import { openMenu } from './ContextMenu';
import { IChevron, ICollapseAll, IExpandAll, IFolder, IGrid, IHistory, INewFolder, IPlus } from './icons';
import { dropZone, scrollDragList, type DropZone } from './listDrag';
import { PanelEmpty } from './PanelEmpty';
import { StatusBadges } from './StatusBadges';
import type { PanelProps } from '../panelRegistry';
import { ProjectIconView } from './ProjectIcon';

const INACTIVE_TABS = 3;
const PROJECT_MIME = 'application/x-mc-project';
/** Files and folders dragged in from the system file manager (Explorer, Finder). */
const osDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

/**
 * 1.2.5: folders dropped from the system file manager become projects (into `folderId` when dropped on a folder); a
 * folder that already is a project is switched to (and moved there). Files are skipped with a note.
 */
async function addDroppedFolders(files: File[], folderId: string | null, tr: ReturnType<typeof useI18n>['tr']): Promise<void> {
  const paths = (await window.mc.pathsForFiles(files).catch(() => [] as string[])).filter(Boolean);
  if (!paths.length) return void toast(tr('Nie udało się dodać projektu.'), 'error');
  const kinds = await window.mc.pathKinds(paths).catch(() => paths.map(() => null));
  const dirs = paths.filter((_, i) => kinds[i] === 'dir');
  for (const path of dirs) {
    const id = addProjectFolder(path);
    if (id && folderId && getS().projectFolders?.some((f) => f.id === folderId)) update((st) => moveTreeItem(st, id, { kind: 'into', folderId }));
  }
  if (dirs.length < paths.length) toast(tr('Pominięto pliki ({count}): projektem może być tylko folder.', { count: paths.length - dirs.length }), dirs.length ? undefined : 'error');
}

/** 1.2.5: the Projects panel header's icons (add a project, a new folder, fold or unfold every folder), like Cursor's Explorer. */
export function ProjectsPanelActions() {
  const { tr } = useI18n();
  const folders = useStore((st) => st.s.projectFolders);
  const anyOpen = (folders ?? []).some((f) => !f.collapsed);
  const toggleLabel = anyOpen ? tr('Zwiń wszystkie foldery') : tr('Rozwiń wszystkie foldery');
  return (
    <div className="side-panel-actions">
      <button className="btn ghost icon" title={tr('Dodaj projekt')} aria-label={tr('Dodaj projekt')} onClick={() => void createProject()}><IPlus /></button>
      <button className="btn ghost icon" title={titleWithShortcut(tr('Nowy folder'), 'folder.new')} aria-label={tr('Nowy folder')} onClick={() => void createProjectFolder()}><INewFolder /></button>
      {!!folders?.length && (
        <button className="btn ghost icon" title={toggleLabel} aria-label={toggleLabel} onClick={() => update((st) => setFoldersCollapsed(st, anyOpen))}>{anyOpen ? <ICollapseAll /> : <IExpandAll />}</button>
      )}
    </div>
  );
}
const FOLDER_MIME = 'application/x-mc-project-folder';

const sumCounts = (list: StatusCounts[]): StatusCounts => list.reduce<StatusCounts>((a, c) => ({
  working: a.working + c.working, waiting: a.waiting + c.waiting, exited: a.exited + c.exited, failed: (a.failed ?? 0) + (c.failed ?? 0),
}), { working: 0, waiting: 0, exited: 0, failed: 0 });

/** A folder's tile: the icons of its first four projects in a 2x2 grid (Discord-like). */
function FolderTile({ projects }: { projects: Project[] }) {
  return (
    <span className="folder-tile" aria-hidden="true">
      {projects.slice(0, 4).map((p) => <ProjectIconView key={p.id} project={p} size="sm" />)}
    </span>
  );
}

/** Open grids of a project: all for the active one, the last few for the others. */
function TabList({ project, active, countsOf }: { project: Project; active: boolean; countsOf: (key: string) => StatusCounts }) {
  const { tr } = useI18n();
  const tabs = active ? project.tabs : project.tabs.slice(-INACTIVE_TABS);
  const hidden = project.tabs.length - tabs.length;
  if (!project.tabs.length) return null;
  return (
    <>
      {tabs.map((t) => {
        const counts = countsOf(t.id);
        const on = active && project.activeTabId === t.id;
        return (
          <div
            key={t.id}
            className={`sub-item tab-item ${on ? 'on' : ''}`}
            title={`${t.name} · ${describeLayout(t.layout)}`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openMenu(e.clientX, e.clientY, [
                { label: tr("Zmień nazwę gridu…"), onClick: async () => {
                  const name = await askText(tr("Nazwa gridu"), t.name);
                  if (name?.trim()) update((s) => renameTab(s, project.id, t.id, name.trim()));
                } },
                { label: tr("Nowy grid") + '…', onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
                { sep: true },
                { label: tr("Zamknij grid"), onClick: () => void closeTab(project.id, t.id) },
              ]);
            }}
            onClick={() => selectTab(project.id, t)}
          >
            <IGrid />
            <span className="tname">{t.name}</span>
            <StatusBadges counts={counts} />
          </div>
        );
      })}
      {hidden > 0 && (
        <div className="sub-item more" onClick={() => switchProject(project.id)}>{tr('+{count} więcej', { count: hidden })}</div>
      )}
    </>
  );
}

export function ProjectsPanel({ resize }: PanelProps) {
  const { tr } = useI18n();
  // The slices this list shows, and badge counts instead of every cell status (a flip that changes no count re-renders nothing).
  const projects = useStore((st) => st.s.projects);
  const activeProjectId = useStore((st) => st.s.activeProjectId);
  const snippetsOpen = useStore((st) => st.s.snippetsOpen);
  const countsOf = useStatusCounts();
  const missing = useStore((st) => st.ui.missingPaths);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const folders = useStore((st) => st.s.projectFolders);
  const order = useStore((st) => st.s.sidebarOrder);
  const tree = useMemo(() => projectTree({ projects, projectFolders: folders, sidebarOrder: order }), [projects, folders, order]);
  const [drag, setDrag] = useState<{ id: string; folder: boolean } | null>(null);
  const [over, setOver] = useState<{ id: string | null; zone: DropZone } | null>(null);
  /** 1.2.5: files from the system file manager over the panel: null, or the folder they would go into ('' = the list). */
  const [osOver, setOsOver] = useState<string | null>(null);
  const dragId = drag?.id ?? null;
  const endDrag = () => { setDrag(null); setOver(null); };
  const dragging = (e: React.DragEvent) => !!drag && (e.dataTransfer.types.includes(PROJECT_MIME) || e.dataTransfer.types.includes(FOLDER_MIME));
  const renameFolder = (folder: Pick<ProjectFolder, 'id' | 'name'>) => renameProjectFolder(folder.id, folder.name);

  /** Drops the dragged item on a row: `into` a folder or onto a project, else next to it. */
  const dropOn = (target: { id: string; folderId: string | null; isFolder: boolean }, zone: DropZone) => {
    if (!drag) return;
    if (zone === 'into' && !drag.folder) {
      if (target.isFolder) update((st) => moveTreeItem(st, drag.id, { kind: 'into', folderId: target.id }));
      else {
        let made: string | null = null;
        update((st) => { const r = dropOnProject(st, drag.id, target.id, tr("Nowy folder")); made = r.folderId; return r.state; });
        if (made) void renameFolder({ id: made, name: tr("Nowy folder") });
      }
    } else {
      const to: TreeTarget = { kind: zone === 'before' ? 'before' : 'after', id: target.isFolder || !drag.folder ? target.id : (target.folderId ?? target.id) };
      update((st) => moveTreeItem(st, drag.id, to));
    }
  };
  const openFiles = (p: Project) => {
    if (activeProjectId !== p.id) switchProject(p.id);
    update((st) => ({ ...st, sidebarCollapsed: false }));
    useSshStore.setState({ viewActive: false }); // SSH mode ends, so the Files panel shows
    setUi({ sidebarView: 'files' });
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, .project, .sub-item')) return;
    e.preventDefault();
    // 1.2.5: Cursor-like menus here: no title row, no icons, shortcuts at the right.
    openMenu(e.clientX, e.clientY, [
      { label: tr("Dodaj projekt") + '…', onClick: () => void createProject() },
      { label: tr("Nowy folder") + '…', hint: shortcutText('folder.new') || undefined, onClick: () => void createProjectFolder() },
      ...(project ? [
        { label: tr("Nowy grid") + '…', hint: shortcutText('grid.new') || undefined, onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
        { label: tr("Przeglądaj pliki projektu"), onClick: () => openFiles(project) },
      ] : []),
      { sep: true },
      { label: tr("Nowy snippet") + '…', onClick: () => {
        update((st) => ({ ...st, snippetsOpen: true }));
        setUi({ modal: { kind: 'snippet', snippetId: null } });
      } },
      { label: snippetsOpen ? tr("Ukryj snippety") : tr("Pokaż snippety"), hint: shortcutText('snippets.toggle') || undefined, onClick: () => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen })) },
      { sep: true },
      { label: tr("Przywróć szerokość panelu"), onClick: () => resize.onFinish(PANEL_LIMITS.sidebar.default) },
    ]);
  };

  const menu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    e.stopPropagation();
    const holder = folderOf(tree, p.id);
    const active = p.id === activeProjectId;
    // "Przenieś do folderu ›": the other folders, a new one made with this project, and out of its folder.
    const targets: MenuItem[] = tree.flatMap((i): MenuItem[] => (i.kind === 'folder' && i.folder.id !== holder?.id
      ? [{ label: i.folder.name || tr('Nowy folder'), onClick: () => update((st) => moveTreeItem(st, p.id, { kind: 'into', folderId: i.folder.id })) }] : []));
    const toFolder: MenuItem[] = [
      ...targets,
      ...(targets.length ? [{ sep: true } as const] : []),
      { label: tr("Nowy folder") + '…', onClick: async () => {
        const name = (await askText(tr('Nazwa folderu'), tr('Nowy folder')))?.trim();
        if (name) update((st) => newFolderWith(st, p.id, name).state);
      } },
      ...(holder ? [{ label: tr("Wyjmij z folderu"), onClick: () => update((st) => moveTreeItem(st, p.id, { kind: 'after', id: holder.id })) }] : []),
    ];
    // 1.2.5 (M2): Cursor-like: no title row, no icons, short labels, shortcuts at the right; the colours stay one click away.
    // Moving up and down is dragging; "Wyjmij z folderu" lives in "Przenieś do folderu".
    openMenu(e.clientX, e.clientY, [
      { label: tr("Otwórz w Cursorze"), onClick: () => window.mc.openInEditor(p.path) },
      { label: window.mc.platform === 'darwin' ? tr('Pokaż w Finderze') : tr('Otwórz w Eksploratorze'), onClick: () => window.mc.openPath(p.path) },
      { sep: true },
      { label: tr("Nowy grid") + '…', hint: active ? shortcutText('grid.new') || undefined : undefined, onClick: () => setUi({ modal: { kind: 'grid', projectId: p.id } }) },
      { label: tr("Przeglądaj pliki projektu"), onClick: () => openFiles(p) },
      { label: tr("Historia czatów i gridów"), hint: active ? shortcutText('history.open') || undefined : undefined, onClick: () => setUi({ modal: { kind: 'history', projectId: p.id } }) },
      { sep: true },
      { label: tr("Przenieś do folderu"), submenu: toFolder },
      { colors: PROJECT_COLORS, onPick: (color) => update((st) => updateProject(st, p.id, { color })) },
      { sep: true },
      { label: tr("Kopiuj ścieżkę"), onClick: () => { window.mc.clipboardWrite(p.path); toast(tr('Skopiowano ścieżkę.')); } },
      { sep: true },
      // 1.0.7: no separate "Zmień nazwę" here: the project editor renames as well.
      { label: tr("Edytuj nazwę i ikonę…"), onClick: () => setUi({ modal: { kind: 'project', projectId: p.id } }) },
      { label: tr("Zmień folder…"), onClick: () => void relocateProject(p.id) },
      { label: tr("Usuń z listy"), danger: true, onClick: () => void removeProject(p.id) },
    ]);
  };

  const renderProject = (p: Project, folderId: string | null) => {
          const counts = countsOf(projectCountsKey(p.id));
          const active = p.id === activeProjectId;
          return (
            <div key={p.id} data-project-id={p.id} className={`project-group ${folderId ? 'in-folder' : ''} ${dragId === p.id ? 'dragging' : ''} ${over?.id === p.id && dragId !== p.id ? `drop-${over.zone}` : ''}`}
              onDragOver={(e) => {
                if (!dragging(e)) return;
                e.preventDefault();
                e.stopPropagation();
                scrollDragList(e.currentTarget.closest('.side-list')!, e.clientY);
                const row = e.currentTarget.querySelector<HTMLElement>('.project')!;
                setOver({ id: p.id, zone: dropZone(row, e.clientY, !drag!.folder && !folderId) });
              }}
              onDrop={(e) => {
                if (!dragging(e)) return;
                e.preventDefault();
                e.stopPropagation();
                const row = e.currentTarget.querySelector<HTMLElement>('.project')!;
                if (dragId !== p.id) dropOn({ id: p.id, folderId, isFolder: false }, dropZone(row, e.clientY, !drag!.folder && !folderId));
                endDrag();
              }}
            >
              <div
                className={`project ${active ? 'active' : ''} ${missing[p.id] ? 'missing' : ''}`}
                // 1.2.5: only the path (the name is on the row; dragging needs no hint).
                title={missing[p.id] ? tr('Folder nie istnieje: {path}', { path: p.path }) : p.path}
                onClick={() => switchProject(p.id)}
                onDoubleClick={() => setUi({ modal: { kind: 'project', projectId: p.id } })}
                onContextMenu={(e) => menu(e, p)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(PROJECT_MIME, p.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDrag({ id: p.id, folder: false });
                }}
                onDragEnd={endDrag}
              >
                <button className="project-avatar" title={tr('Edytuj ikonę projektu {name}', { name: p.name })} aria-label={tr('Edytuj ikonę projektu {name}', { name: p.name })} onClick={(e) => {
                  e.stopPropagation();
                  setUi({ modal: { kind: 'project', projectId: p.id } });
                }} onDoubleClick={(e) => e.stopPropagation()} draggable={false}>
                  <ProjectIconView project={p} />
                </button>
                <span className="name">{p.name}</span>
                <StatusBadges counts={counts} />
              </div>
              <TabList project={p} active={active} countsOf={countsOf} />
              {active && (
                <>
                  {missing[p.id] && (
                    <div className="sub-item" onClick={() => void relocateProject(p.id)} style={{ color: '#f87171' }}>
                      <IFolder />  {tr("Folder nie istnieje, wskaż nowy")}
                    </div>
                  )}
                  <div className="sub-item" onClick={() => setUi({ modal: { kind: 'history', projectId: p.id } })}>
                    <IHistory />  {tr("Historia czatów i gridów")}
                  </div>
                </>
              )}
            </div>
          );
  };

  const folderMenu = (e: React.MouseEvent, folder: ProjectFolder) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { label: folder.collapsed ? tr("Rozwiń folder") : tr("Zwiń folder"), onClick: () => update((st) => updateFolder(st, folder.id, { collapsed: !folder.collapsed })) },
      { label: tr("Dodaj projekt") + '…', onClick: async () => {
        const path = await window.mc.pickFolder();
        if (!path) return;
        const id = addProjectFolder(path);
        if (id) update((st) => moveTreeItem(st, id, { kind: 'into', folderId: folder.id }));
      } },
      { sep: true },
      { label: tr("Zmień nazwę folderu…"), onClick: () => void renameFolder(folder) },
      { label: tr("Usuń folder (projekty zostają)"), danger: true, onClick: () => update((st) => removeFolder(st, folder.id)) },
    ]);
  };

  const renderFolder = ({ folder, projects: inside }: Extract<TreeItem, { kind: 'folder' }>) => {
    const holdsActive = inside.some((p) => p.id === activeProjectId);
    const counts = sumCounts(inside.map((p) => countsOf(projectCountsKey(p.id))));
    const zone = over?.id === folder.id && dragId !== folder.id ? over.zone : null;
    return (
      <div key={folder.id} data-folder-id={folder.id} className={`folder-group ${folder.collapsed ? 'collapsed' : 'open'} ${dragId === folder.id ? 'dragging' : ''}`}>
        <div className={`project-group folder-head ${zone ? `drop-${zone}` : ''} ${osOver === folder.id ? 'os-drop' : ''}`}
          onDragOver={(e) => {
            if (osDrag(e)) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
              setOsOver(folder.id);
              return;
            }
            if (!dragging(e)) return;
            e.preventDefault();
            e.stopPropagation();
            scrollDragList(e.currentTarget.closest('.side-list')!, e.clientY);
            setOver({ id: folder.id, zone: dropZone(e.currentTarget, e.clientY, !drag!.folder) });
          }}
          onDrop={(e) => {
            if (osDrag(e)) {
              e.preventDefault();
              e.stopPropagation();
              setOsOver(null);
              void addDroppedFolders(Array.from(e.dataTransfer.files), folder.id, tr);
              return;
            }
            if (!dragging(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (dragId !== folder.id) dropOn({ id: folder.id, folderId: null, isFolder: true }, dropZone(e.currentTarget, e.clientY, !drag!.folder));
            endDrag();
          }}
        >
          <div
            className={`project folder-row ${folder.collapsed && holdsActive ? 'holds-active' : ''}`}
            // 1.2.5: a click only folds it (a quick second click on the chevron no longer opens the rename); renaming is in its menu.
            onClick={() => update((st) => updateFolder(st, folder.id, { collapsed: !folder.collapsed }))}
            onContextMenu={(e) => folderMenu(e, folder)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(FOLDER_MIME, folder.id);
              e.dataTransfer.effectAllowed = 'move';
              setDrag({ id: folder.id, folder: true });
            }}
            onDragEnd={endDrag}
          >
            <FolderTile projects={inside} />
            <span className="name">{folder.name}</span>
            {folder.collapsed && <StatusBadges counts={counts} />}
            <span className="folder-chevron"><IChevron /></span>
          </div>
        </div>
        {!folder.collapsed && (
          <div className="folder-body">
            {inside.map((p) => renderProject(p, folder.id))}
            {!inside.length && <div className="folder-empty">{tr("Przeciągnij tu projekt")}</div>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`sidebar-content ${osOver === '' ? 'os-dragging' : ''}`} onContextMenu={backgroundMenu}>
    <div className="side-list"
        onDragOver={(e) => {
          if (osDrag(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!(e.target as HTMLElement).closest('.folder-head')) setOsOver('');
            return;
          }
          if (!dragging(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          scrollDragList(e.currentTarget, e.clientY);
          if (!(e.target as HTMLElement).closest('.project-group')) setOver({ id: null, zone: 'after' });
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOver(null); setOsOver(null); } }}
        onDrop={(e) => {
          if (osDrag(e)) {
            e.preventDefault();
            setOsOver(null);
            void addDroppedFolders(Array.from(e.dataTransfer.files), null, tr);
            return;
          }
          if (!dragging(e) || !drag) return;
          e.preventDefault();
          update((st) => moveTreeItem(st, drag.id, { kind: 'end' }));
          endDrag();
        }}
      >
        {tree.map((item) => item.kind === 'project' ? renderProject(item.project, null) : renderFolder(item))}
      {/* 1.2.5: adding lives in the panel header (+, new folder) and in dragging folders in from the file manager. */}
      {projects.length > 0 && <div className={`project-drop-space ${over?.id === null ? 'drop-end' : ''}`} aria-hidden="true" />}
      {osOver !== null && <div className="project-os-drop" aria-hidden="true">{osOver ? tr('Upuść, aby dodać do folderu') : tr('Upuść folder, aby dodać go jako projekt')}</div>}
      {!projects.length && (
        <PanelEmpty>
          <p>{tr("Nie masz jeszcze projektów.")} {tr("Projekt to folder, w którym będą pracować Twoi agenci.")}</p>
          <button className="btn primary" onClick={() => void createProject()}>{tr("Nowy projekt")}</button>
        </PanelEmpty>
      )}
      </div>
    </div>
  );
}
