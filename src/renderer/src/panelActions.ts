// Opening a panel of the left rail from outside the rail (command palette, shortcuts): the same rules as a click on its tile.
import { activeProject } from '../../shared/state';
import { panelOpenable, visiblePanels } from '../../shared/sidebarPanels';
import { getGitProbe } from './git/gitProbe';
import { tr } from './i18n';
import { SIDEBAR_PANELS } from './panelRegistry';
import { leaveSshMode } from './ssh';
import { getS, setUi, toast, update } from './store';

/** Shows the panel (ending SSH mode, unfolding the sidebar when it is folded); a panel that cannot be opened now says why in a toast. Returns whether it opened. */
export function openSidebarPanel(id: string): boolean {
  const project = activeProject(getS());
  const ctx = { hasProject: !!project, platform: window.mc.platform, git: getGitProbe(project?.id), optional: getS().settings.sidePanels };
  const panel = visiblePanels(SIDEBAR_PANELS, ctx).find((p) => p.id === id);
  if (!panel) return false;
  if (!panelOpenable(panel, ctx)) {
    const reason = panel.unavailableReason?.(ctx);
    if (reason) toast(tr(reason), 'error');
    return false;
  }
  if (getS().sidebarCollapsed) update((s) => ({ ...s, sidebarCollapsed: false }));
  // The side panel shows the SSH navigation while the SSH view is in front: opening a panel ends SSH mode.
  leaveSshMode();
  setUi({ sidebarView: id });
  return true;
}
