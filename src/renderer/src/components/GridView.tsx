import { useShortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { areaRects, type GridLayout } from '../../../shared/layout';
import { activeProject, activeTab, getProfile, setTabLayout } from '../../../shared/state';
import { createProject, quickTab, swapCellSlots } from '../actions';
import { playCellMotion } from '../gridMotion';
import { setUi, update, useStore } from '../store';
import { profileOptionLabel } from '../cliUi';
import { cellShell, shownProfileName } from '../../../shared/profiles';
import { sshHeaderName } from '../../../shared/ssh';
import { useCellDrag, type DragContext } from './useCellDrag';
import { CellView } from './CellView';
import { CellFallback, ErrorBoundary } from './ErrorBoundary';
import { areaStyle, FULL_AREA, GridDividers } from './GridDividers';
import { IHistory, IPlus, Logo } from './icons';
import { ProjectIconView } from './ProjectIcon';
import { requestAttach } from '../detach';
import { detachedId } from '../windowRole';
import type { AppState } from '../../../shared/types';

/** The detached window of a grid, seen from the main window (a detached window draws its own grid). */
const detachedOfGridIn = (s: AppState, tabId: string): string | null =>
  detachedId !== null ? null : (s.detachedWindows ?? []).find((w) => w.target.kind === 'grid' && w.target.tabId === tabId)?.id ?? null;

/** The key of an action as a chip; nothing while the shortcut is switched off. */
function Kbd({ id }: { id: string }) {
  const text = useShortcutText()(id); // follows a rebound shortcut (the grid is memoized)
  return text ? <span className="kbd">{text}</span> : null;
}

// Memoized and fed by narrow selectors: a change elsewhere in the state (snippets, settings, another project) or a
// re-render of the app (a side panel being resized) does not re-render the grid and its cells.
export const GridView = memo(function GridView() {
  const { tr } = useI18n();
  const project = useStore((st) => activeProject(st.s));
  const profiles = useStore((st) => st.s.profiles);
  const maximized = useStore((st) => st.ui.maximizedCellId);
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const tab = activeTab(project);
  const away = useStore((st) => (tab ? detachedOfGridIn(st.s, tab.id) : null));
  const [preview, setPreview] = useState<{ tabId: string; layout: GridLayout } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cellOrder = tab ? tab.cells.map((c) => c.id).join() : '';
  const { drag, ghostRef, onHeadPointerDown, cancel } = useCellDrag(
    (): DragContext | null => (tab && gridRef.current
      ? { grid: gridRef.current, ids: tab.cells.map((c) => c.id), rects: areaRects(tab.layout) }
      : null),
    swapCellSlots,
  );
  const dragProfile = useStore((st) => {
    const moving = drag && activeTab(activeProject(st.s))?.cells.find((c) => c.id === drag.id);
    return moving ? getProfile(st.s, moving.profileId) : undefined;
  });
  // The ghost names the cell as its header does: an SSH cell after its host, a shell after the shell it really runs.
  const dragName = useStore((st) => {
    const moving = drag && activeTab(activeProject(st.s))?.cells.find((c) => c.id === drag.id);
    if (!moving) return undefined;
    if (moving.ssh) return sshHeaderName(moving.name) || st.s.sshHosts.find((h) => h.id === moving.ssh!.hostId)?.label;
    return shownProfileName(getProfile(st.s, moving.profileId), cellShell(moving, st.s.settings.shell), tr);
  });
  const dragTitle = useStore((st) => {
    const moving = drag && activeTab(activeProject(st.s))?.cells.find((c) => c.id === drag.id);
    return moving?.session ? st.ui.sessionTitles[moving.session.id] : undefined;
  });

  // A drag belongs to one grid: leaving the tab or project, or maximizing a cell, aborts it.
  useEffect(() => { cancel(); }, [cancel, project?.id, tab?.id, maximized]);

  // Cells that changed slots slide from their old position (see gridMotion.ts).
  useLayoutEffect(() => { playCellMotion(); }, [cellOrder]);

  if (!project) {
    return (
      <div className="empty">
        <div className="welcome">
          <Logo size={56} />
          <h2>unimux</h2>
          <div className="sub">{tr("Dodaj projekt, otwórz w nim grid terminali i odpal tyle Claude i Codexów, ile potrzebujesz.")}</div>
          <button className="btn white lg" onClick={() => void createProject()}><IPlus />  {tr("Nowy projekt")}</button>
          <div className="keys">
            <span><Kbd id="palette.open" />  {tr("Szukaj")}</span>
            <span><Kbd id="grid.new" />  {tr("Nowy grid")}</span>
            <span><Kbd id="agent.add" />  {tr("Dodaj agenta")}</span>
          </div>
        </div>
      </div>
    );
  }

  if (!tab) {
    return (
      <div className="empty">
        <div className="welcome">
          <ProjectIconView project={project} size="xl" />
          <h2>{project.name}</h2>
          <div className="sub">{tr("Otwórz grid terminali albo pojedynczy terminal z wybranym agentem.")}</div>
          <button className="btn white lg" onClick={() => setUi({ modal: { kind: 'grid', projectId: project.id } })}><IPlus />  {tr("Nowy grid")}</button>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
            {profiles.map((p) => (
              <button key={p.id} className="btn" onClick={() => quickTab(p.id)} title={tr("Nowa zakładka z jednym terminalem")}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /> {profileOptionLabel(p, cliStatus, tr)}
              </button>
            ))}
          </div>
          <button className="btn ghost" onClick={() => setUi({ modal: { kind: 'history', projectId: project.id } })}>
            <IHistory />  {tr("Historia czatów i gridów")}
          </button>
          <div className="keys">
            <span><Kbd id="palette.open" />  {tr("Szukaj")}</span>
            <span><Kbd id="terminal.new" />  {tr("Terminal")}</span>
            <span><Kbd id="grid.new" />  {tr("Grid")}</span>
          </div>
        </div>
      </div>
    );
  }

  // 1.0.6: a grid in its own window is never drawn here (its terminals are that window's).
  if (away) {
    return (
      <div className="empty detached-placeholder">
        <div className="welcome">
          <h2>{tab.name}</h2>
          <div className="sub">{tr('Ten grid jest w osobnym oknie.')}</div>
          <div className="row">
            <button className="btn white" onClick={() => window.mc.detach.focus(away)}>{tr('Pokaż okno')}</button>
            <button className="btn" onClick={() => requestAttach(away)}>{tr('Przypnij z powrotem')}</button>
          </div>
        </div>
      </div>
    );
  }

  const maxCell = maximized ? tab.cells.find((c) => c.id === maximized) : undefined;
  const layout = preview?.tabId === tab.id ? preview.layout : tab.layout;
  const rects = areaRects(layout);
  const canDrag = !maxCell && tab.cells.length > 1;
  const dragged = drag ? tab.cells.find((c) => c.id === drag.id) : undefined;
  const targetIndex = drag?.target ? tab.cells.findIndex((c) => c.id === drag.target) : -1;
  const draggedLabel = dragged && (dragged.name ?? dragTitle ?? dragName);
  return (
    <div ref={gridRef} className={`grid ${preview ? 'resizing' : ''} ${drag ? 'dragging' : ''}`}>
      {tab.cells.map((cell, i) => {
        if (maxCell && cell.id !== maxCell.id) return null;
        const rect = rects[i] ?? rects[rects.length - 1];
        const style = maxCell || !rect ? FULL_AREA : areaStyle(rect);
        // One cell that fails to draw keeps its box with a retry; the other cells and its terminal are unaffected.
        return <ErrorBoundary key={cell.id} name="cell" fallback={(retry) => <CellFallback style={style} retry={retry} />}>
          <CellView cell={cell} index={i} style={style} maximized={!!maxCell}
            dragSource={drag?.id === cell.id} onHeadPointerDown={canDrag ? onHeadPointerDown : undefined} />
        </ErrorBoundary>;
      })}
      {targetIndex >= 0 && rects[targetIndex] && (
        <div className="cell-drop-target" style={areaStyle(rects[targetIndex])}><span>{tr('Zamień miejscami')}</span></div>
      )}
      {dragged && (
        <div className="cell-ghost" ref={ghostRef}>
          <span className="pchip" style={{ background: dragProfile?.color }} />
          <b>{tab.cells.indexOf(dragged) + 1}</b>
          <span className="name">{draggedLabel}</span>
        </div>
      )}
      {!maxCell && tab.cells.length > 1 && (
        <GridDividers
          layout={layout}
          onPreview={(next) => setPreview(next && { tabId: tab.id, layout: next })}
          onCommit={(next) => update((st) => setTabLayout(st, project.id, tab.id, next))}
        />
      )}
    </div>
  );
});
