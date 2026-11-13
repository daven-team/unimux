import { shortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { useMemo, useState } from 'react';
import { PROJECT_COLORS, renameTab, updateProject } from '../../../shared/state';
import { addFolder, dropOnProject, folderOf, moveTreeItem, projectTree, removeFolder, treeNeighbour, updateFolder, type TreeItem, type TreeTarget } from '../../../shared/projectFolders';
import { PANEL_LIMITS } from '../../../shared/panels';
import type { StatusCounts } from '../../../shared/status';
import { projectCountsKey } from '../../../shared/statusCounts';
import { useStatusCounts } from '../statusCounts';
import { describeLayout } from '../../../shared/layout';
import type { Project, ProjectFolder } from '../../../shared/types';
import { closeTab, createProject, relocateProject, removeProject, selectTab, switchProject } from '../actions';
import { askText, setUi, update, useStore } from '../store';
import { useSshStore } from '../sshStore';
import { openMenu } from './ContextMenu';
import { IChevron, IEdit, IFile, IFolder, IGrid, IHistory, IPlus, ISnippet, IX } from './icons';
import { ICodeEditor, IEye, IEyeOff, IMoveDown, IMoveUp, IWidth } from './menuIcons';
import { dropZone, scrollDragList, type DropZone } from './listDrag';
import { PanelEmpty } from './PanelEmpty';
import { StatusBadges } from './StatusBadges';
import type { PanelProps } from '../panelRegistry';
import { ProjectIconView } from './ProjectIcon';

const INACTIVE_TABS = 3;
const PROJECT_MIME = 'application/x-mc-project';
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
                { header: t.name },
                { label: tr("Zmień nazwę gridu…"), icon: <IEdit />, onClick: async () => {
                  const name = await askText(tr("Nazwa gridu"), t.name);
                  if (name?.trim()) update((s) => renameTab(s, project.id, t.id, name.trim()));
                } },
                { label: tr("Nowy grid") + '…', icon: <IGrid />, onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
                { sep: true },
                { label: tr("Zamknij grid"), icon: <IX />, onClick: () => void closeTab(project.id, t.id) },
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
  const dragId = drag?.id ?? null;
  const endDrag = () => { setDrag(null); setOver(null); };
  const dragging = (e: React.DragEvent) => !!drag && (e.dataTransfer.types.includes(PROJECT_MIME) || e.dataTransfer.types.includes(FOLDER_MIME));
  const renameFolder = async (folder: Pick<ProjectFolder, 'id' | 'name'>) => {
    const name = await askText(tr("Nazwa folderu"), folder.name);
    if (name?.trim()) update((st) => updateFolder(st, folder.id, { name: name.trim() }));
  };
  const newFolder = () => {
    let id = '';
    update((st) => { const r = addFolder(st, tr("Nowy folder")); id = r.folderId; return r.state; });
    if (id) void renameFolder({ id, name: tr("Nowy folder") });
  };
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
    openMenu(e.clientX, e.clientY, [
      { header: tr("Panel projektów") },
      { label: tr("Dodaj projekt") + '…', icon: <IPlus />, onClick: () => void createProject() },
      { label: tr("Nowy folder") + '…', icon: <IFolder />, onClick: newFolder },
      ...(project ? [
        { label: tr("Nowy grid") + '…', icon: <IGrid />, onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
        { label: tr("Przeglądaj pliki projektu"), icon: <IFile />, onClick: () => openFiles(project) },
      ] : []),
      { sep: true },
      { label: tr("Nowy snippet") + '…', icon: <ISnippet />, onClick: () => {
        update((st) => ({ ...st, snippetsOpen: true }));
        setUi({ modal: { kind: 'snippet', snippetId: null } });
      } },
      { label: snippetsOpen ? tr("Ukryj snippety") : tr("Pokaż snippety"), icon: snippetsOpen ? <IEyeOff /> : <IEye />, hint: shortcutText('snippets.toggle') || undefined, onClick: () => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen })) },
      { sep: true },
      { label: tr("Przywróć szerokość panelu"), icon: <IWidth />, onClick: () => resize.onFinish(PANEL_LIMITS.sidebar.default) },
    ]);
  };

  const menu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    e.stopPropagation();
    const up = treeNeighbour(tree, p.id, -1);
    const down = treeNeighbour(tree, p.id, 1);
    const holder = folderOf(tree, p.id);
    openMenu(e.clientX, e.clientY, [
      { header: p.name },
      // 1.0.7: no separate "Zmień nazwę" here: the project editor renames as well.
      { label: tr("Edytuj projekt (nazwa, ikona)…"), icon: <IEdit />, onClick: () => setUi({ modal: { kind: 'project', projectId: p.id } }) },
      { colors: PROJECT_COLORS, onPick: (color) => update((st) => updateProject(st, p.id, { color })) },
      ...(up ? [{ label: tr("Przesuń wyżej"), icon: <IMoveUp />, onClick: () => update((st) => moveTreeItem(st, p.id, { kind: 'before', id: up })) }] : []),
      ...(down ? [{ label: tr("Przesuń niżej"), icon: <IMoveDown />, onClick: () => update((st) => moveTreeItem(st, p.id, { kind: 'after', id: down })) }] : []),
      ...(holder ? [{ label: tr("Wyjmij z folderu"), icon: <IFolder />, onClick: () => update((st) => moveTreeItem(st, p.id, { kind: 'after', id: holder.id })) }] : []),
      { sep: true },
      { label: tr("Przeglądaj pliki projektu"), icon: <IFile />, onClick: () => openFiles(p) },
      { label: tr("Otwórz folder"), icon: <IFolder />, onClick: () => window.mc.openPath(p.path) },
      { label: tr("Otwórz w Cursorze"), icon: <ICodeEditor />, onClick: () => window.mc.openInEditor(p.path) },
      { label: tr("Historia"), icon: <IHistory />, onClick: () => setUi({ modal: { kind: 'history', projectId: p.id } }) },
      { label: tr("Zmień folder…"), icon: <IFolder />, onClick: () => void relocateProject(p.id) },
      { sep: true },
      { label: tr("Usuń z listy"), icon: <IX />, danger: true, onClick: () => void removeProject(p.id) },
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
                setOver({ id: p.id, zone: dropZone(row, e.clientY, !drag!.folder) });
              }}
              onDrop={(e) => {
                if (!dragging(e)) return;
                e.preventDefault();
                e.stopPropagation();
                const row = e.currentTarget.querySelector<HTMLElement>('.project')!;
                if (dragId !== p.id) dropOn({ id: p.id, folderId, isFolder: false }, dropZone(row, e.clientY, !drag!.folder));
                endDrag();
              }}
            >
              <div
                className={`project ${active ? 'active' : ''} ${missing[p.id] ? 'missing' : ''}`}
                title={`${p.name}\n${missing[p.id] ? tr('Folder nie istnieje: {path}', { path: p.path }) : p.path}\n${tr('Przeciągnij, aby zmienić kolejność')}`}
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
    const up = treeNeighbour(tree, folder.id, -1);
    const down = treeNeighbour(tree, folder.id, 1);
    openMenu(e.clientX, e.clientY, [
      { header: folder.name },
      { label: tr("Zmień nazwę folderu…"), icon: <IEdit />, onClick: () => void renameFolder(folder) },
      { label: folder.collapsed ? tr("Rozwiń folder") : tr("Zwiń folder"), icon: <IFolder />, onClick: () => update((st) => updateFolder(st, folder.id, { collapsed: !folder.collapsed })) },
      ...(up ? [{ label: tr("Przesuń wyżej"), icon: <IMoveUp />, onClick: () => update((st) => moveTreeItem(st, folder.id, { kind: 'before', id: up })) }] : []),
      ...(down ? [{ label: tr("Przesuń niżej"), icon: <IMoveDown />, onClick: () => update((st) => moveTreeItem(st, folder.id, { kind: 'after', id: down })) }] : []),
      { sep: true },
      { label: tr("Usuń folder (projekty zostają)"), icon: <IX />, danger: true, onClick: () => update((st) => removeFolder(st, folder.id)) },
    ]);
  };

  const renderFolder = ({ folder, projects: inside }: Extract<TreeItem, { kind: 'folder' }>) => {
    const holdsActive = inside.some((p) => p.id === activeProjectId);
    const counts = sumCounts(inside.map((p) => countsOf(projectCountsKey(p.id))));
    const zone = over?.id === folder.id && dragId !== folder.id ? over.zone : null;
    return (
      <div key={folder.id} data-folder-id={folder.id} className={`folder-group ${folder.collapsed ? 'collapsed' : 'open'} ${dragId === folder.id ? 'dragging' : ''}`}>
        <div className={`project-group folder-head ${zone ? `drop-${zone}` : ''}`}
          onDragOver={(e) => {
            if (!dragging(e)) return;
            e.preventDefault();
            e.stopPropagation();
            scrollDragList(e.currentTarget.closest('.side-list')!, e.clientY);
            setOver({ id: folder.id, zone: dropZone(e.currentTarget, e.clientY, !drag!.folder) });
          }}
          onDrop={(e) => {
            if (!dragging(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (dragId !== folder.id) dropOn({ id: folder.id, folderId: null, isFolder: true }, dropZone(e.currentTarget, e.clientY, !drag!.folder));
            endDrag();
          }}
        >
          <div
            className={`project folder-row ${folder.collapsed && holdsActive ? 'holds-active' : ''}`}
            title={`${folder.name}\n${tr('Kliknij, aby zwinąć lub rozwinąć. Przeciągnij projekt na folder, aby go dodać.')}`}
            onClick={() => update((st) => updateFolder(st, folder.id, { collapsed: !folder.collapsed }))}
            onDoubleClick={() => void renameFolder(folder)}
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
    <div className="sidebar-content" onContextMenu={backgroundMenu}>
    <div className="side-list"
        onDragOver={(e) => {
          if (!dragging(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          scrollDragList(e.currentTarget, e.clientY);
          if (!(e.target as HTMLElement).closest('.project-group')) setOver({ id: null, zone: 'after' });
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
        onDrop={(e) => {
          if (!dragging(e) || !drag) return;
          e.preventDefault();
          update((st) => moveTreeItem(st, drag.id, { kind: 'end' }));
          endDrag();
        }}
      >
        {tree.map((item) => item.kind === 'project' ? renderProject(item.project, null) : renderFolder(item))}
      {projects.length > 0 && (
        <div className="project-add-row">
          <button className="btn project-add-inline" onClick={() => void createProject()} title={tr('Dodaj projekt')} aria-label={tr('Dodaj projekt')}><IPlus />{tr('Dodaj projekt')}</button>
          <button className="btn project-add-inline folder-add" onClick={newFolder} title={tr('Nowy folder')} aria-label={tr('Nowy folder')}><IFolder />{tr('Nowy folder')}</button>
        </div>
      )}
      {projects.length > 0 && <div className={`project-drop-space ${over?.id === null ? 'drop-end' : ''}`} aria-hidden="true" />}
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
