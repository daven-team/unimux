// The top strip as one list (1.0.0): grids of every project, file tabs and Settings (the SSH view has no tab since 1.0.4: it
// is entered from the rail and stays open in the background). The order is AppState.workspaceOrder (kept up to date by
// WorkspaceTabs); the shortcuts walk and close what the strip shows.
import { activeWorkspaceKey, mergeWorkspaceOrder, parseWorkspaceKey, scopeWorkspaceKeys, stepWorkspace, stripKeyOwner, stripKeys } from '../../shared/workspaceOrder';
import { activeProject } from '../../shared/state';
import { detachedGridIds } from '../../shared/detached';
import { getS, getUi, setUi } from './store';
import { activateFile, closeFile, useFileStore } from './files';
import { useSshStore } from './sshStore';
import { closeTab, selectTab } from './actions';

/** The per-project orders of 0.9.x, read once for the migration into state.json. */
export const LEGACY_ORDER_KEY = 'mc-workspace-order-v1';
export function readLegacyOrders(): unknown {
  try { return JSON.parse(localStorage.getItem(LEGACY_ORDER_KEY) ?? '{}'); } catch { return {}; }
}

/** The strip as it is now: the keys it shows (only the active project's with the strip scope 'project'), in its order, and the one in front. */
export function currentStrip(): { shown: string[]; active: string | null } {
  const s = getS();
  const input = { settingsOpen: getUi().settingsTabOpen, projects: s.projects, files: useFileStore.getState().documents };
  const order = mergeWorkspaceOrder(s.workspaceOrder ?? [], stripKeys(input), null);
  // Grids in their own window (1.0.6) are not walked or closed from here.
  const away = detachedGridIds(s);
  const shown = scopeWorkspaceKeys(order, s.settings.stripScope, s.activeProjectId, stripKeyOwner(input)).filter((key) => !away.has(key.slice(5)) || !key.startsWith('grid:'));
  return { shown, active: frontKey() };
}

/** The key of the tab in front (cheap: it runs on every key press for the shortcut dispatch). */
export function frontKey(): string | null {
  const project = activeProject(getS());
  const files = useFileStore.getState();
  const ssh = useSshStore.getState();
  const fileId = files.activeFileId && files.documents.some((d) => d.id === files.activeFileId && (!d.projectId || d.projectId === project?.id)) ? files.activeFileId : null;
  return activeWorkspaceKey({ settingsActive: getUi().settingsActive, sshActive: ssh.viewActive, fileId, gridId: project?.activeTabId ?? null });
}

/** The project and grid of a grid id. */
function findGrid(id: string) {
  for (const project of getS().projects) {
    const tab = project.tabs.find((t) => t.id === id);
    if (tab) return { project, tab };
  }
  return null;
}

export function activateWorkspaceKey(key: string): void {
  const target = parseWorkspaceKey(key);
  if (target?.kind === 'settings') setUi({ settingsActive: true });
  else if (target?.kind === 'file') activateFile(target.id);
  else if (target?.kind === 'grid') {
    const grid = findGrid(target.id);
    if (grid) selectTab(grid.project.id, grid.tab);
  }
}

/** Closes one tab of the strip: Settings, a file (asks about unsaved edits) or a grid (asks about working agents). */
export function closeWorkspaceKey(key: string): void {
  const target = parseWorkspaceKey(key);
  if (target?.kind === 'settings') setUi({ settingsTabOpen: false, settingsActive: false });
  else if (target?.kind === 'file') void closeFile(target.id);
  else if (target?.kind === 'grid') {
    const grid = findGrid(target.id);
    if (grid) void closeTab(grid.project.id, grid.tab.id);
  }
}

/** Mod+Tab / Mod+Shift+Tab: the next or previous tab of the whole strip. */
export function cycleWorkspace(dir: 1 | -1): void {
  const { shown, active } = currentStrip();
  const next = stepWorkspace(shown, active, dir);
  if (next && next !== active) activateWorkspaceKey(next);
}

/** Mod+Shift+W: closes the tab in front, whatever kind it is (a file in front of a grid closes the file, not the grid). */
export function closeFrontTab(): void {
  const { active } = currentStrip();
  if (active) closeWorkspaceKey(active);
}
