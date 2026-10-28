import { useMemo, useRef } from 'react';
import { useI18n } from '../i18n';
import { activeProject } from '../../../shared/state';
import { useGitProbe, useGitProbeSync } from '../git/gitProbe';
import { panelOpenable, railFocusTarget, railTileAction, railTileShown, resolvePanelId, sidePanelContent, visiblePanels } from '../../../shared/sidebarPanels';
import { sshModeActive } from '../../../shared/sshView';
import { SIDEBAR_PANELS, type SidebarPanel } from '../panelRegistry';
import { leaveSshMode } from '../ssh';
import { useSshStore } from '../sshStore';
import { setUi, update, useStore } from '../store';
import { PanelResizeHandle, type PanelResizeProps } from './PanelResizeHandle';
import { SshNav } from './ssh/SshNav';
import { UsagePanel } from './UsagePanel';

/**
 * Left side: a rail of tiles (one per panel) and, next to it, the content of the selected panel with the resize handle.
 * Clicking the open panel's tile folds the content away; the rail stays (the collapsed state).
 * SSH mode: while the SSH view is in front, the side panel shows the SSH navigation (Hosty, Klucze, Znane hosty, SFTP) instead;
 * a panel tile, a grid or a file tab ends it.
 */
export function Sidebar({ resize }: { resize: PanelResizeProps }) {
  const { tr } = useI18n();
  const collapsed = useStore((st) => st.s.sidebarCollapsed);
  const wanted = useStore((st) => st.ui.sidebarView);
  const hasProject = useStore((st) => !!activeProject(st.s));
  const projectId = useStore((st) => activeProject(st.s)?.id);
  const projectPath = useStore((st) => activeProject(st.s)?.path);
  const sshActive = useSshStore((st) => st.viewActive);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  useGitProbeSync(projectId, projectPath);
  const git = useGitProbe(projectId);
  const rail = useRef<HTMLDivElement>(null);
  const optional = useStore((st) => st.s.settings.sidePanels);
  const ctx = { hasProject, platform: window.mc.platform, git, optional };
  const panels = visiblePanels(SIDEBAR_PANELS, ctx);
  const contentPanels = panels.filter((panel) => !panel.opensView);
  const view = resolvePanelId(panels, wanted, ctx);
  const active = contentPanels.find((panel) => panel.id === view) ?? contentPanels[0];
  const Content = active.component ?? (() => null);
  const sshMode = sshModeActive({ viewActive: sshActive, settingsActive });
  const content = sidePanelContent({ collapsed, viewMode: sshMode, panelId: active.id });
  // While the edge is dragged the app re-renders with a new width on every move; the panel content and the usage box
  // keep the same elements (the content reads the latest resize props through this stable object), so they are skipped.
  const latest = useRef(resize);
  latest.current = resize;
  const contentResize = useMemo<PanelResizeProps>(() => ({
    get panel() { return latest.current.panel; },
    get width() { return latest.current.width; },
    get maxWidth() { return latest.current.maxWidth; },
    onResize: (width) => latest.current.onResize(width),
    onFinish: (width) => latest.current.onFinish(width),
  }), []);
  const contentElement = useMemo(() => <Content resize={contentResize} />, [Content, contentResize]);
  const usage = useMemo(() => <UsagePanel />, []);

  const choose = (panel: SidebarPanel) => {
    const next = railTileAction({ collapsed, view, viewActive: sshActive, settingsActive }, panel);
    if (next.collapsed !== collapsed) update((st) => ({ ...st, sidebarCollapsed: next.collapsed }));
    if (next.openView) panel.onActivate?.();
    if (next.leaveView) leaveSshMode();
    if (!panel.opensView) setUi({ sidebarView: next.view });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const tiles = Array.from(rail.current?.querySelectorAll<HTMLButtonElement>('.rail-tile') ?? []);
    const target = railFocusTarget(tiles.length, tiles.indexOf(document.activeElement as HTMLButtonElement), e.key);
    if (target === null) return;
    e.preventDefault();
    tiles[target]?.focus();
  };

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label={tr("Panel projektów")}>
      <div className="rail">
        <div ref={rail} className="rail-tiles" role="tablist" aria-orientation="vertical" aria-label={tr("Panele boczne")} onKeyDown={onKeyDown}>
          {panels.map((panel) => {
            const reason = panel.unavailableReason?.(ctx) ?? null;
            const shown = railTileShown(panel, { collapsed, activeId: active.id, viewActive: sshActive, settingsActive });
            const Icon = panel.icon;
            const Badge = panel.badge;
            const label = tr(panel.label);
            return (
              <button
                key={panel.id}
                id={`${panel.id}-view`}
                type="button"
                // A view tile is a toggle button (aria-pressed), so only the open panel's tile is the selected tab of the rail.
                role={panel.opensView ? undefined : 'tab'}
                className={`rail-tile ${shown ? 'on' : ''}`}
                aria-selected={panel.opensView ? undefined : shown}
                aria-pressed={panel.opensView ? shown : undefined}
                aria-controls={shown && !panel.opensView ? `sidebar-${panel.id}` : undefined}
                aria-disabled={reason ? true : undefined}
                aria-label={label}
                tabIndex={(sshMode ? !!panel.opensView : panel.id === active.id) ? 0 : -1}
                title={reason ? tr(reason) : shown && (!panel.opensView || !collapsed) ? `${label} · ${tr("Kliknij ponownie, aby zwinąć panel")}` : label}
                onClick={() => { if (panelOpenable(panel, ctx)) choose(panel); }}
              ><Icon />{Badge && <Badge />}</button>
            );
          })}
        </div>
        {collapsed && <div className="rail-foot">{usage}</div>}
      </div>
      {content?.kind === 'view' && (
        <div className="side-panel" id="sidebar-ssh">
          <PanelResizeHandle {...resize} />
          <div className="side-panel-title">{tr('SSH')}</div>
          <SshNav />
          {usage}
        </div>
      )}
      {content?.kind === 'panel' && (
        <div className="side-panel" id={`sidebar-${active.id}`} role="tabpanel" aria-labelledby={`${active.id}-view`}>
          <PanelResizeHandle {...resize} />
          <div className="side-panel-title">{tr(active.label)}</div>
          {contentElement}
          {usage}
        </div>
      )}
    </aside>
  );
}
