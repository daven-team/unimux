// 1.1.4: what the "Zespół AI" panel needs to tell a stuck team (shared/teamPanel.ts taskStuck): when each agent last
// started, which agent CLIs ended (the terminal's cli-exited detail), and the restart that gives an agent its open tasks.
import { useEffect, useState } from 'react';
import { isClosedTask, taskPrompt, type AgentRuntimeStatus } from '../../shared/automation';
import { findCell, updateCell } from '../../shared/state';
import { restartCell } from './actions';
import { getS, update } from './store';
import { terminals } from './terminals/TerminalManager';

/** The earliest moment an agent could have connected: this window's start (agents start again with the app). */
export const HEALTH_BASELINE = Math.round(performance.timeOrigin);

const startedAt = new Map<string, number>();
/** When the agent last started, as far as this window saw it (main's "starting" status, a restart from the panel). */
export const agentStartedAt = (cellId: string): number | undefined => startedAt.get(cellId);
export const noteAgentStart = (cellId: string, at = Date.now()): void => { startedAt.set(cellId, at); };

/** Notes a start for every agent main reports as starting now (the runtime statuses the panel already follows). */
export function noteStatuses(previous: Record<string, AgentRuntimeStatus> | null, next: Record<string, AgentRuntimeStatus>): void {
  for (const [cellId, status] of Object.entries(next)) if (status === 'starting' && previous?.[cellId] !== 'starting') noteAgentStart(cellId);
}

export interface CliExit { code?: number }
const exitOf = (cellId: string): CliExit | undefined => {
  const detail = terminals.detail(cellId);
  return detail?.kind === 'cli-exited' ? (detail.code ? { code: detail.code } : {}) : undefined;
};

/**
 * The agents (of `cellIds`) whose CLI ended in this window, with the exit code. Renders again only when one ends or starts
 * again (a detail change of a working agent, a tool call, does not). The end of an exit counts as a new start.
 */
export function useCliExits(cellIds: readonly string[]): ReadonlyMap<string, CliExit> {
  const key = cellIds.join('\n');
  const read = () => new Map(cellIds.flatMap((id) => { const e = exitOf(id); return e ? [[id, e] as const] : []; }));
  const [exits, setExits] = useState<ReadonlyMap<string, CliExit>>(read);
  useEffect(() => {
    const ids = new Set(cellIds);
    setExits(read());
    return terminals.onDetail((cellId, detail) => {
      if (!ids.has(cellId)) return;
      setExits((current) => {
        const was = current.get(cellId);
        const now = detail?.kind === 'cli-exited' ? (detail.code ? { code: detail.code } : {}) : undefined;
        if (was?.code === now?.code && !!was === !!now) return current;
        if (was && !now) noteAgentStart(cellId);
        const next = new Map(current);
        if (now) next.set(cellId, now); else next.delete(cellId);
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return exits;
}

/**
 * "Uruchom ponownie z zadaniem": the agent starts again and gets its open tasks.
 *
 * Interim version until actions.ts has `restartAgentWithTasks(cellId)` (built in parallel with the launch changes, it returns a
 * Promise); then this body becomes `noteAgentStart(cellId); void restartAgentWithTasks(cellId);` (import it from './actions'
 * under another name, or rename this one). Until then: the open tasks go in the cell's
 * one-shot startup prompt and the cell starts again through the cells' own restart (restartCell): a new conversation when
 * none of the tasks was started (a CLI that failed at its first start has no conversation to resume), else the same one.
 */
export function restartAgentWithTasks(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found) return;
  const open = getS().automation.tasks.filter((t) => t.cellId === cellId && !isClosedTask(t)).sort((a, b) => a.createdAt - b.createdAt);
  if (open.length) update((s) => updateCell(s, cellId, { startupPrompt: open.map(taskPrompt).join('\n\n---\n\n') }));
  noteAgentStart(cellId);
  restartCell(cellId, open.some((t) => t.status !== 'queued') ? 'resume' : 'new');
}
