import { mergeStateEdit, type StateEdit, type StateSnapshot } from '../shared/stateEdits';
import type { AppState } from '../shared/types';
import { layoutForCount, MAX_CELLS } from '../shared/layout';
import { normalizeAlerts } from '../shared/alerts';
import { normalizeSshHosts } from '../shared/ssh';
import { normalizeDbConnections } from '../shared/db';
import { normalizeSftpPlaces } from '../shared/sftpView';
import { normalizeScrollback } from '../shared/terminalLimits';
import { normalizeWorkspaceOrder, sameOrder } from '../shared/workspaceOrder';

/** Main is the single writer. Renderer edits rebase; MCP operations mutate the latest state. */
export class StateController {
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private state: AppState, private readonly changed: (snapshot: StateSnapshot) => void) {}
  get(): AppState { return this.state; }
  snapshot(): StateSnapshot { return { state: this.state, revision: this.revision }; }
  change(fn: (state: AppState) => AppState, editId?: string): StateSnapshot {
    this.state = fn(this.state);
    const snapshot = { state: this.state, revision: ++this.revision, editId };
    this.changed(snapshot);
    for (const listener of [...this.listeners]) listener();
    return snapshot;
  }
  /** Hears every change after it was applied (wait_for wakes on it instead of polling). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  apply(edit: StateEdit): StateSnapshot {
    return this.change((state) => {
      const next = mergeStateEdit(state, edit);
      // The renderer cannot store arbitrary alert values (unknown presets, relative or UNC sound paths): they are normalized here.
      // SSH hosts edited in the renderer are normalized the same way (R6), and so are the SFTP places and the scrollback setting.
      const sftp = normalizeSftpPlaces(next.sftp);
      // Database connections edited in the renderer (reordering, grouping) are normalized like SSH hosts.
      const db = normalizeDbConnections(next.dbConnections);
      const dbConnections = JSON.stringify(db) === JSON.stringify(next.dbConnections) ? next.dbConnections : db;
      const projects = next.projects.map((project) => {
        const tabs = project.tabs.map((tab) => {
          if (tab.cells.length < 1 || tab.cells.length > MAX_CELLS) throw new Error('Concurrent grid change exceeds the cell limit.');
          return tab.layout.areas.length === tab.cells.length ? tab : { ...tab, layout: layoutForCount(tab.cells.length) };
        });
        // Untouched projects keep their identity, so the change that is sent on is computed cheaply.
        return tabs.every((tab, i) => tab === project.tabs[i]) ? project : { ...project, tabs };
      });
      const out: AppState = { ...next, sshHosts: normalizeSshHosts(next.sshHosts), dbConnections, sftp: JSON.stringify(sftp) === JSON.stringify(next.sftp) ? next.sftp : sftp, settings: { ...next.settings, alerts: normalizeAlerts(next.settings.alerts), scrollbackLines: normalizeScrollback(next.settings.scrollbackLines) }, projects };
      // The strip order from the renderer is repaired like at load (known kinds of keys, open grids, no duplicates, a limit);
      // an order that needs no repair keeps its identity.
      const order = normalizeWorkspaceOrder(next.workspaceOrder, new Set(projects.flatMap((p) => p.tabs.map((t) => t.id))));
      if (order === undefined) delete out.workspaceOrder;
      else if (!sameOrder(order, next.workspaceOrder)) out.workspaceOrder = order;
      return out;
    }, edit.id);
  }
}
