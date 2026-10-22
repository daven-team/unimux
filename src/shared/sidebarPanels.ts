// Logic of the left panel rail (the tiles that switch panels). The registry itself, with icons and components, lives in
// the renderer (panelRegistry.ts); this file holds what can be tested without a DOM.
import type { GitProbe } from './git';
import type { MessageKey } from './i18n';
import type { AppPlatform } from './platform';

/** `git`: what a probe of the active project found (null: not known yet, which never blocks the tile). */
export interface PanelContext { hasProject: boolean; platform: AppPlatform; git?: GitProbe | null }

/** What the rail needs to know about a panel. */
export interface PanelDef {
  id: string;
  /** False hides the tile altogether (a panel that does not exist on this platform or is switched off). Default: shown. */
  available?: (ctx: PanelContext) => boolean;
  /** A reason (translation key) when the tile is shown but cannot be opened right now; null/absent: it can. */
  unavailableReason?: (ctx: PanelContext) => string | null;
  /** The tile opens a workspace view in the main area (the SSH view) instead of a panel next to the rail. */
  opensView?: boolean;
}

export const DEFAULT_PANEL = 'projects';

/** The Git tile needs a project; without a repository (or without git) the panel itself offers `git init` / installing Git. */
export function gitPanelReason(ctx: PanelContext): MessageKey | null {
  return ctx.hasProject ? null : 'Najpierw dodaj projekt';
}

export function visiblePanels<T extends PanelDef>(defs: readonly T[], ctx: PanelContext): T[] {
  return defs.filter((def) => def.available?.(ctx) !== false);
}

export const panelOpenable = (def: PanelDef, ctx: PanelContext): boolean => !def.unavailableReason?.(ctx);

/**
 * The panel to show for a wanted id (a stored or older value, or one from a newer version): the wanted one when it exists,
 * is visible and can be opened, otherwise the default panel.
 */
export function resolvePanelId(defs: readonly PanelDef[], wanted: unknown, ctx: PanelContext): string {
  const found = typeof wanted === 'string' ? visiblePanels(defs, ctx).find((def) => def.id === wanted && !def.opensView) : undefined;
  return found && panelOpenable(found, ctx) ? found.id : DEFAULT_PANEL;
}

export interface RailState { collapsed: boolean; view: string }

/** A click on a tile: open that panel; clicking the open panel's tile again folds the panel away (only the rail stays). */
export function railClick(state: RailState, clicked: string): RailState {
  if (!state.collapsed && state.view === clicked) return { collapsed: true, view: clicked };
  return { collapsed: false, view: clicked };
}

export interface RailTileContext { collapsed: boolean; activeId: string; viewActive: boolean; settingsActive: boolean }

/**
 * Whether a tile looks selected: a panel tile while its panel is open, a view tile while its view is on screen (not behind
 * Settings). While the view is on screen the side panel shows the view's navigation (SSH mode), so no panel tile is selected.
 */
export function railTileShown(def: Pick<PanelDef, 'id' | 'opensView'>, ctx: RailTileContext): boolean {
  const viewMode = ctx.viewActive && !ctx.settingsActive;
  return def.opensView ? viewMode : !viewMode && !ctx.collapsed && def.id === ctx.activeId;
}

export interface RailAction extends RailState {
  /** Bring the tile's view to the front (SSH mode starts). */
  openView: boolean;
  /** Send the view to the background, so the normal side panel and the grid or file come back (SSH mode ends). */
  leaveView: boolean;
}

/**
 * A click on a tile, also in view mode (the SSH view in front, its navigation in the side panel):
 * - a view tile opens its view and leaves the fold of the side panel as it is (like the palette);
 *   in view mode it folds and unfolds the side panel like an open panel's tile;
 * - a panel tile in view mode leaves the view and shows that panel (never folds it); otherwise railClick, and a view that
 *   waits behind Settings goes to the background too (choosing a panel ends view mode).
 */
export function railTileAction(state: RailState & { viewActive: boolean; settingsActive: boolean }, def: Pick<PanelDef, 'id' | 'opensView'>): RailAction {
  const { collapsed, view, viewActive, settingsActive } = state;
  const viewMode = viewActive && !settingsActive;
  if (def.opensView) return viewMode ? { collapsed: !collapsed, view, openView: false, leaveView: false } : { collapsed, view, openView: true, leaveView: false };
  if (viewMode) return { collapsed: false, view: def.id, openView: false, leaveView: true };
  return { ...railClick({ collapsed, view }, def.id), openView: false, leaveView: viewActive };
}

/** What the side panel next to the rail shows: nothing when folded, the view's navigation in view mode, otherwise the panel. */
export function sidePanelContent(ctx: { collapsed: boolean; viewMode: boolean; panelId: string }): { kind: 'view' } | { kind: 'panel'; id: string } | null {
  if (ctx.collapsed) return null;
  return ctx.viewMode ? { kind: 'view' } : { kind: 'panel', id: ctx.panelId };
}

/** Roving focus along the rail: where the focus goes for an arrow / Home / End key (null: not a rail key). */
export function railFocusTarget(count: number, index: number, key: string): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
