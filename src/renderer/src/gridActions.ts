// Actions on every agent of one grid (the grid tab's menu and the palette): interrupt the working ones, restart and resume
// them all, mute or unmute their alerts. Agents are the Claude and Codex cells; shell and SSH cells are never touched.
import { namesList, workingAgents } from '../../shared/agentWork';
import { getProfile, updateCell } from '../../shared/state';
import type { Cell } from '../../shared/types';
import { isStarted, restartAgentWithTasks, spawnCell } from './actions';
import { tr } from './i18n';
import { askChoice, getS, getUi, toast, update } from './store';
import { terminals } from './terminals/TerminalManager';
import { cellShownHere } from './windowRole';

/** The agent cells of a grid (none for a grid that is gone). */
function gridAgents(projectId: string, tabId: string): Cell[] {
  const s = getS();
  const tab = s.projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
  return tab ? tab.cells.filter((c) => !c.ssh && getProfile(s, c.profileId).cli !== 'shell') : [];
}

/** Agents this window runs (a detached window starts and drives its own cells). */
const runningHere = (cell: Cell): boolean => isStarted(cell.id) && cellShownHere(cell.id);

export interface GridAgentSummary {
  /** Agents in the middle of a turn (what "interrupt" would stop). */
  working: number;
  /** Agents this window started (what "restart" would restart). */
  running: number;
  muted: number;
  unmuted: number;
}

/** What the grid-wide actions would act on: the menu and the palette offer only the actions that apply. */
export function gridAgentSummary(projectId: string, tabId: string): GridAgentSummary {
  const agents = gridAgents(projectId, tabId);
  const here = agents.filter(runningHere);
  const ui = getUi();
  return {
    working: workingAgents(getS(), here.map((c) => c.id), ui.statuses, ui.sessionTitles).length,
    running: here.length,
    muted: agents.filter((c) => c.muted).length,
    unmuted: agents.filter((c) => !c.muted).length,
  };
}

/** Esc to every agent of the grid that is working, as if the user pressed it in each terminal. */
export function interruptGridAgents(projectId: string, tabId: string): void {
  const ui = getUi();
  const ids = gridAgents(projectId, tabId).filter(runningHere).map((c) => c.id);
  let sent = 0;
  for (const { cellId } of workingAgents(getS(), ids, ui.statuses, ui.sessionTitles)) {
    const term = terminals.xterm(cellId);
    if (!term) continue;
    // Typed input: the status tracker sees the Esc as an interrupt, the same as a key press in the cell.
    term.input('\x1b', true);
    sent++;
  }
  toast(sent ? tr('Przerwano agentów: {count}', { count: sent }) : tr('Żaden agent w tym gridzie nie pracuje.'));
}

/** Restarts every agent of the grid this window runs, resuming its conversation (a new one without any); asks first while some work. */
export async function restartGridAgents(projectId: string, tabId: string): Promise<void> {
  const ui = getUi();
  const ids = gridAgents(projectId, tabId).filter(runningHere).map((c) => c.id);
  if (!ids.length) return;
  const working = workingAgents(getS(), ids, ui.statuses, ui.sessionTitles);
  if (working.length) {
    const body = tr('Pracujący agenci ({count}): {names}. Ich bieżąca tura zostanie przerwana.', {
      count: working.length, names: namesList(working.map((w) => w.label)),
    });
    const choice = await askChoice(tr('Zrestartować agentów, którzy pracują?'), body, [
      { label: tr('Zrestartuj mimo to'), value: 'restart', danger: true },
    ]);
    if (choice !== 'restart') return;
  }
  let restarted = 0;
  for (const id of ids) {
    // Closed meanwhile (the question was open): skipped.
    const cell = gridAgents(projectId, tabId).find((c) => c.id === id);
    if (!cell) continue;
    // Like the cell menu's "restart and resume": an agent with an MCP role goes on with its open tasks.
    if (cell.role) void restartAgentWithTasks(id);
    else void spawnCell(id, cell.session ? 'resume' : 'new');
    restarted++;
  }
  toast(tr('Zrestartowano agentów: {count}', { count: restarted }));
}

export interface GridAgentAction { id: 'interrupt' | 'restart' | 'mute' | 'unmute'; title: string; run: () => void }

/** The grid-wide actions that apply right now (both mute and unmute when some agents are muted and some are not). */
export function gridAgentActions(projectId: string, tabId: string): GridAgentAction[] {
  const sum = gridAgentSummary(projectId, tabId);
  const out: GridAgentAction[] = [];
  if (sum.working) out.push({ id: 'interrupt', title: tr('Przerwij wszystkich agentów'), run: () => interruptGridAgents(projectId, tabId) });
  if (sum.running) out.push({ id: 'restart', title: tr('Zrestartuj i wznów wszystkich agentów'), run: () => void restartGridAgents(projectId, tabId) });
  if (sum.unmuted) out.push({ id: 'mute', title: tr('Wycisz alerty wszystkich agentów'), run: () => setGridAgentsMuted(projectId, tabId, true) });
  if (sum.muted) out.push({ id: 'unmute', title: tr('Włącz alerty wszystkich agentów'), run: () => setGridAgentsMuted(projectId, tabId, false) });
  return out;
}

/** Mutes (or unmutes) the alerts of every agent of the grid, like each cell's own menu item. */
export function setGridAgentsMuted(projectId: string, tabId: string, muted: boolean): void {
  const ids = gridAgents(projectId, tabId).map((c) => c.id);
  update((s) => ids.reduce((st, id) => updateCell(st, id, { muted: muted ? true : undefined }), s));
}
