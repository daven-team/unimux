// The connect attempt of each SSH cell (1.0.4): steps and log of the connecting card, fed by ssh.ts. No imports of actions or terminals.
import { create } from 'zustand';
import { reduceConnectAttempt, type ConnectAttempt, type ConnectEvent } from '../../shared/sshConnect';

interface SshConnectStore {
  attempts: Record<string, ConnectAttempt>;
  /** Cells whose card shows its log ("Pokaż logi"); kept here so maximizing the cell (a remount) keeps it open. */
  logsOpen: Record<string, true>;
  apply(cellId: string, ev: ConnectEvent): void;
  toggleLogs(cellId: string): void;
}

export const useSshConnectStore = create<SshConnectStore>((set) => ({
  attempts: {},
  logsOpen: {},
  toggleLogs: (cellId) => set((st) => {
    const { [cellId]: open, ...rest } = st.logsOpen;
    return { logsOpen: open ? rest : { ...rest, [cellId]: true } };
  }),
  apply: (cellId, ev) => set((st) => {
    const prev = st.attempts[cellId];
    const next = reduceConnectAttempt(prev, ev);
    if (next === prev) return st;
    const { [cellId]: _old, ...rest } = st.attempts;
    return { attempts: next ? { ...rest, [cellId]: next } : rest };
  }),
}));
