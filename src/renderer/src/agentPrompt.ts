// One prompt to several agent cells at once (1.1.1), renderer side. The dialog asks main, main asks the window that holds each
// cell's terminal (this window or a detached one), and that window decides from its own status tracker: an agent idle at its
// prompt gets the prompt now (one bracketed paste and Enter, like the prompt queue), a busy one is skipped or its prompt goes to
// the cell's prompt queue. shared/agentPrompt.ts has the rules.
import {
  targetAction, targetState, type AgentPromptOutcome, type AgentPromptRequest, type TargetState,
} from '../../shared/agentPrompt';
import { activeProject, findCell, getProfile } from '../../shared/state';
import { isStarted } from './actions';
import { addToQueue, deliverPrompt, promptPending, typedSinceSettled } from './promptQueue';
import { getS, getUi, setUi } from './store';
import { terminals } from './terminals/TerminalManager';

/** The state of one cell of this window for `text`. */
function stateHere(cellId: string, text: string): TargetState {
  const s = getS();
  const cell = findCell(s, cellId)?.cell;
  if (!cell || cell.ssh || getProfile(s, cell.profileId).cli === 'shell') return 'notStarted';
  const ui = getUi();
  const status = ui.statuses[cellId] ?? 'idle';
  const failure = ui.failures[cellId];
  return targetState({
    started: terminals.has(cellId) && isStarted(cellId),
    status,
    reason: status === 'waiting' && failure !== undefined ? 'error' : undefined,
    failure,
    detail: ui.statusDetails[cellId],
    typed: typedSinceSettled(cellId),
    queued: !!cell.promptQueue?.items.length,
    sent: promptPending(cellId),
    noPaste: /[\r\n]/.test(text) && !terminals.bracketedPaste(cellId),
  });
}

/** Runs a request for the cells this window holds (a cell held elsewhere answers `unreachable`; main never sends those here). */
export function runAgentPrompt(req: AgentPromptRequest): Record<string, AgentPromptOutcome> {
  const out: Record<string, AgentPromptOutcome> = {};
  for (const { cellId, text } of req.items) {
    if (!terminals.has(cellId)) { out[cellId] = req.mode === 'send' ? { state: 'notStarted', result: 'skipped' } : { state: 'notStarted' }; continue; }
    const state = stateHere(cellId, text);
    if (req.mode === 'probe') { out[cellId] = { state }; continue; }
    const action = targetAction(state, req.queueBusy);
    if (action === 'send') deliverPrompt(cellId, text);
    else if (action === 'queue') addToQueue(cellId, text);
    out[cellId] = { state, result: action === 'send' ? 'sent' : action === 'queue' ? 'queued' : 'skipped' };
  }
  return out;
}

let started = false;

/** Answers main's requests for this window's cells (the main window and every detached window). */
export function initAgentPrompt(): void {
  if (started) return;
  started = true;
  window.mc.on('agents:prompt:run', (requestId: string, req: AgentPromptRequest) => {
    let answer: Record<string, AgentPromptOutcome> = {};
    try { answer = runAgentPrompt(req); } catch { /* answered empty: the asking window shows the cells as unreachable */ }
    window.mc.agentPromptDone(requestId, answer);
  });
}

/** Asks main to probe or send; resolves with every asked cell's outcome (cells no window answered for are `unreachable`). */
export async function requestAgentPrompt(req: AgentPromptRequest): Promise<Record<string, AgentPromptOutcome>> {
  try { return await window.mc.agentPrompt(req); } catch { return {}; }
}

/** Opens the dialog; the agents of grid `tabId` (by default the active grid) are checked first. */
export function openAgentPrompt(tabId?: string): void {
  setUi({ modal: { kind: 'agentPrompt', tabId: tabId ?? activeProject(getS())?.activeTabId ?? undefined } });
}
