// OS notifications of agent events, named after the agent and combined in bursts: several agents that finish within about a
// second raise one notification ("3 agents finished in Project X: a, b, c") instead of a stack of toasts.
import { errorPhrase, type AlertEventId } from './alerts';
import { namesList } from './agentWork';
import type { MessageKey, MessageParams } from './i18n';

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export interface AlertItem {
  event: AlertEventId;
  cellId: string;
  /** The cell's own label (see cellLabel). */
  label: string;
  projectId: string;
  projectName: string;
  tabId: string;
  tabName: string;
  errorCode?: string;
}

export interface AlertNotice { title: string; body: string; cellId: string }

/** How long the first alert of a burst waits for the others. */
export const ALERT_BURST_MS = 1000;

/** Body of one agent's notification: what happened to it (and for an error, the human phrase of its code). */
export function alertBody(t: Translate, event: AlertEventId, name: string, errorCode?: string): string {
  if (event === 'attention') return t('{name} potrzebuje Ciebie', { name });
  if (event === 'error') return t('{name} - błąd: {detail}', { name, detail: t(errorPhrase(errorCode)) });
  return t('{name} skończył pracę', { name });
}

/** The alerts of one burst grouped by event (in the order they first came), each cell once (its latest alert counts). */
export function groupAlerts(items: readonly AlertItem[]): AlertItem[][] {
  const latest = new Map<string, AlertItem>();
  for (const item of items) { latest.delete(item.cellId); latest.set(item.cellId, item); }
  const groups = new Map<AlertEventId, AlertItem[]>();
  for (const item of items) {
    if (latest.get(item.cellId) !== item) continue;
    const group = groups.get(item.event);
    if (group) group.push(item); else groups.set(item.event, [item]);
  }
  return [...groups.values()];
}

const COMBINED: Record<AlertEventId, { inProject: MessageKey; anywhere: MessageKey }> = {
  done: { inProject: 'Zakończone tury w {project} ({count}): {names}', anywhere: 'Zakończone tury ({count}): {names}' },
  attention: { inProject: 'Czekają na Ciebie w {project} ({count}): {names}', anywhere: 'Czekają na Ciebie ({count}): {names}' },
  error: { inProject: 'Błędy agentów w {project} ({count}): {names}', anywhere: 'Błędy agentów ({count}): {names}' },
};

/**
 * One notification for a group of the same event. The title names the project and tab (never a slot number, which changes when
 * cells move); a click focuses the first cell of the group.
 */
export function alertNotice(t: Translate, group: readonly AlertItem[]): AlertNotice {
  const first = group[0];
  const oneProject = group.every((item) => item.projectId === first.projectId);
  const oneTab = oneProject && group.every((item) => item.tabId === first.tabId);
  const title = oneTab ? `${first.projectName} · ${first.tabName}` : oneProject ? first.projectName : 'unimux';
  if (group.length === 1) return { title, body: alertBody(t, first.event, first.label, first.errorCode), cellId: first.cellId };
  const keys = COMBINED[first.event];
  const params = { project: first.projectName, count: group.length, names: namesList(group.map((item) => item.label)) };
  return { title, body: t(oneProject ? keys.inProject : keys.anywhere, params), cellId: first.cellId };
}

export interface BurstTimers { setTimer(fn: () => void, ms: number): unknown; clearTimer(timer: unknown): void }

/**
 * Collects alerts for `windowMs` from the first one, then hands the whole burst over. The window is not extended by later
 * alerts, so no alert waits longer than `windowMs`.
 */
export function createAlertBurst<T>(emit: (items: T[]) => void, timers: BurstTimers, windowMs = ALERT_BURST_MS): { push(item: T): void; flush(): void } {
  let pending: T[] = [];
  let timer: unknown;
  const flush = (): void => {
    if (timer !== undefined) { timers.clearTimer(timer); timer = undefined; }
    const items = pending;
    pending = [];
    if (items.length) emit(items);
  };
  return {
    push(item) {
      pending.push(item);
      timer ??= timers.setTimer(flush, windowMs);
    },
    flush,
  };
}
