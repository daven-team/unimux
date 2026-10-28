// The panels the left rail can switch between. To add one (SSH terminal, Git ...): write its component and add one entry here;
// the rail, the keyboard handling and the resolving of a stored or unknown id come from shared/sidebarPanels.ts.
//   id               stable identifier (also what `ui.sidebarView` holds)
//   label            Polish translation key, shown as tile tooltip, accessible name and panel title
//   icon             tile icon (18px, 24px grid, see icons.tsx)
//   component        the panel content; it fills the column to the right of the rail (absent for a tile that opens a view)
//   opensView        optional: the tile opens a view in the main area instead of a panel; onActivate is what it does
//   available        optional: false hides the tile altogether (platform, feature switch)
//   unavailableReason optional: the tile is shown but disabled, with this reason as its tooltip
import type { ComponentType, ReactNode } from 'react';
import type { MessageKey } from '../../shared/i18n';
import { gitPanelReason, optionalPanelOn, type PanelContext, type PanelDef } from '../../shared/sidebarPanels';
import { FilesPanel } from './components/FilesPanel';
import { TDatabase, TFiles, TGit, TMonitor, TProjects, TTerminal, TWaiting } from './components/icons';
import { WaitingBadge, WaitingPanel } from './components/WaitingPanel';
import type { PanelResizeProps } from './components/PanelResizeHandle';
import { LazyScreen } from './components/LazyScreen';
import { ProjectsPanel } from './components/ProjectsPanel';
import { openSshView } from './ssh';
import './components/gitPanel.css';

export interface PanelProps { resize: PanelResizeProps }

// The Git panel (history, graph, changes) loads when it is first opened: it is not needed at startup. Its styles stay in
// the main bundle (imported above): the Files tree uses the same change letters (.git-letter).
const loadGitPanel = () => import('./components/GitPanel').then((m) => ({ default: m.GitPanel }));
function GitPanelLazy() { return <LazyScreen load={loadGitPanel} panel />; }
// The database panel (1.0.0) loads when it is first opened.
const loadDbPanel = () => import('./components/db/DbPanel').then((m) => ({ default: m.DbPanel }));
function DbPanelLazy() { return <LazyScreen load={loadDbPanel} panel />; }
// The Monitor panel (1.0.6) loads when it is first opened.
const loadMonitorPanel = () => import('./components/MonitorPanel').then((m) => ({ default: m.MonitorPanel }));
function MonitorPanelLazy() { return <LazyScreen load={loadMonitorPanel} panel />; }

export interface SidebarPanel extends Omit<PanelDef, 'unavailableReason'> {
  label: MessageKey;
  icon: () => ReactNode;
  /** The panel content next to the rail; absent for a tile that opens a view (`opensView`). */
  component?: ComponentType<PanelProps>;
  /** What a view tile does when clicked. */
  onActivate?: () => void;
  unavailableReason?: (ctx: PanelContext) => MessageKey | null;
  /** 1.0.9: a count on the tile (it follows the store itself, so the rail does not re-render for it). */
  badge?: ComponentType;
}

export const SIDEBAR_PANELS: readonly SidebarPanel[] = [
  { id: 'projects', label: 'Projekty', icon: TProjects, component: ProjectsPanel },
  { id: 'files', label: 'Pliki', icon: TFiles, component: FilesPanel, unavailableReason: (ctx) => (ctx.hasProject ? null : 'Najpierw dodaj projekt') },
  // Git needs a project that is a repository (the tile is disabled, with the reason as its tooltip, otherwise). SSH: opens the SSH view in the main area (W3).
  { id: 'git', label: 'Git', icon: TGit, component: GitPanelLazy, unavailableReason: gitPanelReason },
  { id: 'db', label: 'Bazy danych', icon: TDatabase, component: DbPanelLazy },
  { id: 'terminal', label: 'SSH', icon: TTerminal, opensView: true, onActivate: () => openSshView() },
  // What loads the computer: samples only while it is open (1.0.6).
  { id: 'monitor', label: 'Monitor', icon: TMonitor, component: MonitorPanelLazy, available: optionalPanelOn('monitor') },
  // Monitor and "Czeka na Ciebie" are off by default (1.0.9): Settings > Ogólne switches them on.
  // 1.0.9: every cell that needs you (a question, a permission, an error, a turn you have not seen), across grids and windows.
  { id: 'waiting', label: 'Czeka na Ciebie', icon: TWaiting, component: WaitingPanel, badge: WaitingBadge, available: optionalPanelOn('waiting') },
];
