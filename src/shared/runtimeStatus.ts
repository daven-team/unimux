import type { AgentRuntimeStatus } from './automation';
import type { CellStatus, StatusReason } from './status';

/**
 * Maps a status the renderer's StatusTracker decided to the status automation (MCP list_agents, the automation panel) sees.
 * `hooked` = Claude hooks drive the cell, so its "waiting / done" is precise. A cell judged by TUI heuristics (Codex, a
 * Claude cell before its first hook) may signal working or needs_attention, but never "ready".
 * Returns null when automation must keep what it has (exited is handled by the pty lifecycle).
 */
export function automationStatusFor(
  status: CellStatus | string,
  reason: StatusReason | string | undefined,
  hooked: boolean,
  current: AgentRuntimeStatus | undefined,
): AgentRuntimeStatus | null {
  if (status === 'working') return 'working';
  if (status === 'waiting') {
    if (hooked) return reason === 'attention' || reason === 'error' ? 'needs_attention' : 'ready';
    return current === 'ready' || current === 'exited' ? null : 'needs_attention';
  }
  // 1.1.4: an agent CLI that ended stays exited while its shell idles (until it works again or starts anew).
  if (status === 'idle') return current === 'ready' || current === 'exited' ? null : 'unknown';
  return null;
}

/**
 * Immediate automation hint for a hook event, written before the renderer tracker has judged it. Only events the tracker
 * always applies qualify; busy (tool / subagent activity) is not hinted because the tracker ignores late tool hooks after
 * a Stop and SubagentStop, and the tracker's verdict reaches automation through cell:runtime.
 */
export function automationHintForHook(event: string): AgentRuntimeStatus | null {
  if (event === 'prompt' || event === 'stopbg') return 'working';
  if (event === 'stop') return 'ready';
  if (event === 'notify' || event === 'fail') return 'needs_attention';
  return null;
}
