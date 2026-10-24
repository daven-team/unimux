import { shortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { useState } from 'react';
import { moveProject, PROJECT_COLORS, renameTab, updateProject, type DropEdge } from '../../../shared/state';
import { PANEL_LIMITS } from '../../../shared/panels';
import type { StatusCounts } from '../../../shared/status';
import { projectCountsKey } from '../../../shared/statusCounts';
import { useStatusCounts } from '../statusCounts';
import { describeLayout } from '../../../shared/layout';
import type { Project } from '../../../shared/types';
import { closeTab, createProject, relocateProject, removeProject, selectTab, switchProject } from '../actions';
import { askText, setUi, update, useStore } from '../store';
import { useSshStore } from '../sshStore';
import { openMenu } from './ContextMenu';
import { IEdit, IFile, IFolder, IGrid, IHistory, IPlus, ISnippet, IX } from './icons';
import { ICodeEditor, IEye, IEyeOff, IMoveDown, IMoveUp, IWidth } from './menuIcons';
import { dropEdge, scrollDragList } from './listDrag';
import { PanelEmpty } from './PanelEmpty';
import { StatusBadges } from './StatusBadges';
import type { PanelProps } from '../panelRegistry';
import { ProjectIconView } from './ProjectIcon';

const INACTIVE_TABS = 3;
const PROJECT_MIME = 'application/x-mc-project';

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
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string | null; edge: DropEdge } | null>(null);
  const endDrag = () => { setDragId(null); setOver(null); };
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
    const index = projects.findIndex((item) => item.id === p.id);
    openMenu(e.clientX, e.clientY, [
      { header: p.name },
      // 1.0.7: no separate "Zmień nazwę" here: the project editor renames as well.
      { label: tr("Edytuj projekt (nazwa, ikona)…"), icon: <IEdit />, onClick: () => setUi({ modal: { kind: 'project', projectId: p.id } }) },
      { colors: PROJECT_COLORS, onPick: (color) => update((st) => updateProject(st, p.id, { color })) },
      ...(index > 0 ? [{ label: tr("Przesuń wyżej"), icon: <IMoveUp />, onClick: () => update((st) => moveProject(st, p.id, projects[index - 1].id, 'before')) }] : []),
      ...(index < projects.length - 1 ? [{ label: tr("Przesuń niżej"), icon: <IMoveDown />, onClick: () => update((st) => moveProject(st, p.id, projects[index + 1].id, 'after')) }] : []),
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

  return (
    <div className="sidebar-content" onContextMenu={backgroundMenu}>
    <div className="side-list"
        onDragOver={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(PROJECT_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          scrollDragList(e.currentTarget, e.clientY);
          if (!(e.target as HTMLElement).closest('.project-group')) setOver({ id: null, edge: 'after' });
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
        onDrop={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(PROJECT_MIME)) return;
          e.preventDefault();
          update((st) => moveProject(st, dragId, null));
          endDrag();
        }}
      >
        {projects.map((p) => {
          const counts = countsOf(projectCountsKey(p.id));
          const active = p.id === activeProjectId;
          return (
            <div key={p.id} data-project-id={p.id} className={`project-group ${dragId === p.id ? 'dragging' : ''} ${over?.id === p.id && dragId !== p.id ? `drop-${over.edge}` : ''}`}
              onDragOver={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(PROJECT_MIME)) return;
                e.preventDefault();
                const row = e.currentTarget.querySelector<HTMLElement>('.project')!;
                setOver({ id: p.id, edge: dropEdge(row, e.clientY) });
              }}
              onDrop={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(PROJECT_MIME)) return;
                e.preventDefault();
                e.stopPropagation();
                const row = e.currentTarget.querySelector<HTMLElement>('.project')!;
                update((st) => moveProject(st, dragId, p.id, dropEdge(row, e.clientY)));
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
                  setDragId(p.id);
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
        })}
      {projects.length > 0 && <button className="btn project-add-inline" onClick={() => void createProject()} title={tr('Dodaj projekt')} aria-label={tr('Dodaj projekt')}><IPlus />{tr('Dodaj projekt')}</button>}
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
