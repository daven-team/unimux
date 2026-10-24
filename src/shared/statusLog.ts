// In-memory diagnostics of cell status transitions: a bounded ring buffer that never holds message text or prompts.
import type { CellStatus, HookInfo, StatusCause, StatusReason } from './status';

export const STATUS_LOG_LIMIT = 300;

/** What moved the status: a hook event name or one of the local sources. */
export type StatusTrigger = 'prompt' | 'stop' | 'stopbg' | 'notify' | 'busy' | 'fail' | 'session' | 'idle' | 'compact' | 'compacted'
  | 'tick-stall' | 'output' | 'input' | 'osc9' | 'shell' | 'restore' | 'exit';

export interface StatusLogEntry {
  /** Epoch milliseconds. */
  at: number;
  cellId: string;
  from: CellStatus;
  to: CellStatus;
  cause: StatusCause;
  trigger: StatusTrigger;
  reason?: StatusReason;
  /** Hook event that did not change the status (or was ignored on purpose). */
  note?: 'no-change' | 'ignored';
  /** The app raised a notification / sound for this transition. */
  alert?: boolean;
  /** A real alert transition that was held back (focused, quiet-hours, disabled) or lost only its sound (sound-throttled). */
  suppressed?: string;
  /** Short key=value diagnostics (background task counts, error code, stall kind), never text. */
  detail?: string;
}

/** key=value pairs for the hook payload facts worth keeping. */
export function hookDetail(info?: HookInfo): string {
  if (!info) return '';
  const out: string[] = [];
  if (info.tasksUnknown) out.push('tasks=?');
  else {
    if (info.tasks !== undefined) out.push(`tasks=${info.tasks}`);
    if (info.active !== undefined) out.push(`active=${info.active}`);
  }
  if (info.workflows) out.push(`workflows=${info.workflows}`);
  if (info.statuses?.length) out.push(`task_status=${info.statuses.join(',')}`);
  if (info.types?.length) out.push(`task_type=${info.types.join(',')}`);
  if (info.continuation) out.push('continuation');
  if (info.subagent) out.push('subagent');
  if (info.error) out.push(`error=${info.error}`);
  if (info.source) out.push(`source=${info.source}`);
  if (info.need) out.push(`need=${info.need}`);
  if (info.tool) out.push(`tool=${info.tool.slice(0, 40)}`);
  if (info.toolEnd) out.push('tool_end');
  if (info.trigger) out.push(`trigger=${info.trigger}`);
  return out.join(' ');
}

export class StatusLog {
  private entries: StatusLogEntry[] = [];

  constructor(private readonly limit = STATUS_LOG_LIMIT) {}

  push(entry: StatusLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  get size(): number {
    return this.entries.length;
  }

  list(): readonly StatusLogEntry[] {
    return this.entries;
  }

  /** Marks the newest entry of the cell as one that raised an alert, or (with a reason) as one that was suppressed. */
  markAlert(cellId: string, suppressed?: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].cellId !== cellId) continue;
      if (suppressed) this.entries[i].suppressed = suppressed;
      else this.entries[i].alert = true;
      return;
    }
  }

  clear(): void {
    this.entries = [];
  }

  toText(): string {
    return this.entries.map(formatEntry).join('\n');
  }
}

export function formatEntry(e: StatusLogEntry): string {
  const move = e.from === e.to ? `${e.to} (unchanged)` : `${e.from}->${e.to}`;
  const parts = [new Date(e.at).toISOString(), `cell=${e.cellId}`, move, `cause=${e.cause}`, `trigger=${e.trigger}`];
  if (e.reason && e.to === 'waiting') parts.push(`reason=${e.reason}`);
  if (e.note) parts.push(e.note);
  if (e.alert) parts.push('alert');
  if (e.suppressed) parts.push(`alert=suppressed:${e.suppressed}`);
  if (e.detail) parts.push(e.detail);
  return parts.join(' ');
}
