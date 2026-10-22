export const PANEL_LIMITS = {
  sidebar: { default: 228, min: 200, max: 480 },
  snippets: { default: 280, min: 220, max: 520 },
} as const;

export type Panel = keyof typeof PANEL_LIMITS;
/** The tile rail at the left edge of the sidebar; the panel's own width (PANEL_LIMITS.sidebar) comes on top of it. */
export const RAIL_WIDTH = 48;
/** Collapsed sidebar: the rail alone. */
export const COLLAPSED_SIDEBAR_WIDTH = RAIL_WIDTH;
export const MIN_WORKSPACE_WIDTH = 320;

export function normalizePanelWidth(value: unknown, panel: Panel): number {
  const limits = PANEL_LIMITS[panel];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(limits.min, Math.min(limits.max, value)))
    : limits.default;
}

/**
 * Fit saved preferences to the window without overwriting them when the window shrinks. `sidebar` goes in as the width of the
 * panel content and comes out as the width of the whole sidebar (rail included). `snippetsOpen`: the right column is open (the
 * snippets, the notes or both; they share its width).
 */
export function fitPanelWidths(
  available: number, sidebar: number, snippets: number, collapsed: boolean, snippetsOpen: boolean,
): { sidebar: number; snippets: number } {
  const left = collapsed ? COLLAPSED_SIDEBAR_WIDTH : RAIL_WIDTH + normalizePanelWidth(sidebar, 'sidebar');
  const right = snippetsOpen ? normalizePanelWidth(snippets, 'snippets') : 0;
  const leftMin = collapsed ? COLLAPSED_SIDEBAR_WIDTH : RAIL_WIDTH + PANEL_LIMITS.sidebar.min;
  const rightMin = snippetsOpen ? PANEL_LIMITS.snippets.min : 0;
  const budget = Math.max(leftMin + rightMin, available - MIN_WORKSPACE_WIDTH);
  const excess = Math.max(0, left + right - budget);
  const flexible = left + right - leftMin - rightMin;
  const ratio = flexible ? Math.min(1, excess / flexible) : 0;
  const fittedLeft = Math.round(left - (left - leftMin) * ratio);
  return {
    sidebar: fittedLeft,
    snippets: Math.min(Math.round(right - (right - rightMin) * ratio), Math.floor(budget - fittedLeft)),
  };
}
