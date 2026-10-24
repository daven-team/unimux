// Context window use of each agent cell's conversation (main's ContextTracker reads the transcripts; see shared/contextUsage.ts).
import { create } from 'zustand';
import type { ContextUsage } from '../../shared/contextUsage';

interface ContextStore {
  usage: Record<string, ContextUsage>;
  set(cellId: string, usage: ContextUsage | null): void;
}

export const useContextStore = create<ContextStore>((set) => ({
  usage: {},
  set: (cellId, usage) => set((st) => {
    if (usage) return { usage: { ...st.usage, [cellId]: usage } };
    if (!(cellId in st.usage)) return {};
    const { [cellId]: _gone, ...rest } = st.usage;
    return { usage: rest };
  }),
}));

// Every window (the main one and detached grids) listens: main sends a cell's changes to the window showing it.
window.mc.on('cell:context', (cellId, usage) => useContextStore.getState().set(cellId, usage));

/** Reads the cell's usage now (a cell that appears, or whose conversation changed). */
export function loadContext(cellId: string): void {
  void window.mc.contextUsage(cellId).then((usage) => useContextStore.getState().set(cellId, usage)).catch(() => undefined);
}
