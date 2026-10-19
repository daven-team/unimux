// The top strip as one list (1.0.0): grids of every project, file tabs, Settings and the SSH view. The order is
// AppState.workspaceOrder (kept up to date by WorkspaceTabs); the shortcuts walk and close what the strip shows.
import { activeWorkspaceKey, mergeWorkspaceOrder, parseWorkspaceKey, stepWorkspace, stripKeys } from '../../shared/workspaceOrder';
import { activeProject } from '../../shared/state';
import { getS, getUi, setUi } from './store';
import { activateFile, closeFile, useFileStore } from './files';
import { useSshStore } from './sshStore';
import { activateSshView, closeSshView } from './ssh';
import { closeTab, selectTab } from './actions';

/** The per-project orders of 0.9.x, read once for the migration into state.json. */
export const LEGACY_ORDER_KEY = 'mc-workspace-order-v1';
export function readLegacyOrders(): unknown {
  try { return JSON.parse(localStorage.getItem(LEGACY_ORDER_KEY) ?? '{}'); } catch { return {}; }
}

/** The strip as it is now: its full order, the keys it shows (in that order) and the one in front. */
export function currentStrip(): { order: string[]; shown: string[]; active: string | null } {
  const s = getS();
  const files = useFileStore.getState();
  const ssh = useSshStore.getState();
  const project = activeProject(s);
  const keys = stripKeys({
    settingsOpen: getUi().settingsTabOpen, sshOpen: ssh.viewOpen, activeProjectId: project?.id ?? null,
    projects: s.projects, files: files.documents,
  });
  const order = mergeWorkspaceOrder(s.workspaceOrder ?? [], keys.all, null);
  const visible = new Set(keys.shown);
  const shown = order.filter((key) => visible.has(key));
  return { order, shown, active: frontKey() };
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
  else if (target?.kind === 'ssh') activateSshView();
  else if (target?.kind === 'file') activateFile(target.id);
  else if (target?.kind === 'grid') {
    const grid = findGrid(target.id);
    if (grid) selectTab(grid.project.id, grid.tab);
  }
}

/** Closes one tab of the strip: Settings, the SSH view, a file (asks about unsaved edits) or a grid (asks about working agents). */
export function closeWorkspaceKey(key: string): void {
  const target = parseWorkspaceKey(key);
  if (target?.kind === 'settings') setUi({ settingsTabOpen: false, settingsActive: false });
  else if (target?.kind === 'ssh') closeSshView();
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
