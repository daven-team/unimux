import { create } from 'zustand';
import { clampSplitRatio, rememberSplitFile, splitEndsAfterClose, splitSides, SPLIT_DEFAULT_RATIO, type SplitSides } from '../../shared/splitView';
import { activateFile, useFileStore } from './files';
import { getS, useStore } from './store';
import { tr } from './i18n';
import type { MenuItem } from './components/ContextMenu';

// The split view (shared/splitView.ts): on/off lives in this window only (a start shows the grid alone); the divider's place is kept.
const ratioKey = 'mc-split-ratio-v1';
function storedRatio(): number {
  try {
    const value = Number(localStorage.getItem(ratioKey));
    return value > 0 && value < 1 ? value : SPLIT_DEFAULT_RATIO;
  } catch { return SPLIT_DEFAULT_RATIO; }
}

const swappedKey = 'mc-split-swapped-v1';
function storedSwapped(): boolean {
  try { return localStorage.getItem(swappedKey) === '1'; } catch { return false; }
}

interface SplitState {
  on: boolean;
  /** The grid's share of the workspace width (0..1). */
  ratio: number;
  /** The tab on the left and the grid on the right ("Zamień strony"); kept like the ratio. */
  swapped: boolean;
  /** Per project: the tabs last shown beside its grid, the most recent first. */
  recent: Readonly<Record<string, readonly string[]>>;
}

export const useSplitStore = create<SplitState>(() => ({ on: false, ratio: storedRatio(), swapped: storedSwapped(), recent: {} }));

function sidesNow(): SplitSides {
  const { on, recent } = useSplitStore.getState();
  const { activeFileId, documents } = useFileStore.getState();
  const projectId = getS().activeProjectId;
  return splitSides({ on, activeFileId, projectId, recent: projectId ? recent[projectId] : undefined, documents });
}

let started = false;
/** The tab in front is remembered for its project; a closed tab that leaves nothing beside the grid ends the split. */
export function initSplitView(): void {
  if (started) return;
  started = true;
  useFileStore.subscribe(followFiles);
}
function followFiles(st: ReturnType<typeof useFileStore.getState>, prev: ReturnType<typeof useFileStore.getState>): void {
  if (st.activeFileId !== prev.activeFileId || st.documents !== prev.documents) {
    const recent = rememberSplitFile(useSplitStore.getState().recent, getS().activeProjectId, st.activeFileId, st.documents);
    if (recent !== useSplitStore.getState().recent) useSplitStore.setState({ recent });
  }
  if (st.documents !== prev.documents && useSplitStore.getState().on && splitEndsAfterClose(prev.documents, st.documents, sidesNow())) {
    useSplitStore.setState({ on: false });
  }
}

/** Shows the tab `id` (or the one in front) beside the grid. */
export function openBesideGrid(id?: string): void {
  initSplitView();
  useSplitStore.setState({ on: true });
  if (id && useFileStore.getState().activeFileId !== id) activateFile(id);
}

/** Ends the split: the tab in front (if any) covers the grid again, as before. */
export function closeSplit(): void { useSplitStore.setState({ on: false }); }

export function setSplitRatio(ratio: number, width: number): void {
  const value = Math.round(clampSplitRatio(ratio, width) * 1000) / 1000;
  useSplitStore.setState({ ratio: value });
  try { localStorage.setItem(ratioKey, String(value)); } catch { /* kept for this run only */ }
}

/** Puts the tab on the other side of the grid (the grid keeps its width). */
export function swapSplitSides(): void {
  const swapped = !useSplitStore.getState().swapped;
  useSplitStore.setState({ swapped });
  try { localStorage.setItem(swappedKey, swapped ? '1' : '0'); } catch { /* kept for this run only */ }
}

/** The grid is hidden behind another view (Settings, SSH, a tab in front without the split): SSH prompts then announce themselves. */
export function gridCovered(settingsActive: boolean, sshViewActive: boolean): boolean {
  return settingsActive || sshViewActive || !sidesNow().grid;
}

/** The tab on screen: the one in front, or in the split the one beside the grid. A string or null, so typing does not re-render. */
export function useShownFileId(): string | null {
  const projectId = useStore((st) => st.s.activeProjectId);
  const on = useSplitStore((st) => st.on);
  const recent = useSplitStore((st) => (projectId ? st.recent[projectId] : undefined));
  return useFileStore((st) => splitSides({ on, activeFileId: st.activeFileId, projectId, recent, documents: st.documents }).fileId);
}

/** The tab menu items: the tab beside the grid, or, when this tab already is there, the split turned off and the sides swapped. */
export function splitMenuItems(id: string): MenuItem[] {
  const besideNow = useSplitStore.getState().on && sidesNow().fileId === id;
  return besideNow
    ? [{ label: tr('Zamknij widok obok'), onClick: closeSplit }, { label: tr('Zamień strony'), onClick: swapSplitSides }]
    : [{ label: tr('Otwórz obok gridu'), onClick: () => openBesideGrid(id) }];
}

/** The keyboard follows a click: a click in the grid puts its tab in front, a click beside it the file tab. */
export function focusSplitSide(side: 'grid' | 'file', fileId: string | null): void {
  if (!useSplitStore.getState().on) return;
  const active = useFileStore.getState().activeFileId;
  if (side === 'grid' && active !== null) useFileStore.setState({ activeFileId: null });
  if (side === 'file' && fileId && active !== fileId) useFileStore.setState({ activeFileId: fileId });
}
