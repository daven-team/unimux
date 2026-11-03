// The `state:changed` broadcast (1.1.2). Agents' MCP calls change the state in bursts (a create_task is two changes, a team of
// agents reporting at once is dozens), and each change used to be one patch, one IPC message and one React render per window.
// Changes marked `batch` (an agent's MCP call) now wait up to `delayMs` and go out as one patch against the last state sent;
// every other change (the user's own edits, main's bookkeeping) is sent at once and takes any waiting batch with it, so an
// edit's acknowledgement and its patch keep their order. `flush` sends what waits (before any other message to the renderer,
// so a message that names new cells never overtakes the state that has them).
import { stateChange, type StateChange } from '../shared/statePatch';
import type { StateSnapshot } from '../shared/stateEdits';

export interface StateBroadcasterOptions {
  /** The state the windows start from (what `state:snapshot` answers before the first change). */
  initial: StateSnapshot;
  send(change: StateChange): void;
  /** How long a batched change may wait for the next one. */
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface StateBroadcaster {
  /** A change applied by the controller; `batch` lets it wait for the next ones. */
  changed(snapshot: StateSnapshot, batch?: boolean): void;
  /** Sends a waiting batch now (no-op when nothing waits). */
  flush(): void;
  /** Changes waiting to be sent (tests). */
  readonly waiting: number;
}

export const STATE_BATCH_MS = 16;

export function createStateBroadcaster(options: StateBroadcasterOptions): StateBroadcaster {
  const delayMs = options.delayMs ?? STATE_BATCH_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  /** What the windows have: the state of the last change sent. */
  let sent = options.initial;
  let pending: StateSnapshot | null = null;
  let waiting = 0;
  let timer: unknown;
  const sendUpTo = (snapshot: StateSnapshot) => {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    const base = sent;
    pending = null;
    waiting = 0;
    sent = snapshot;
    // One patch from the last state sent; its base is that revision, so a window that has it applies the whole batch at once.
    const change = stateChange(base.state, snapshot);
    options.send('full' in change ? change : { ...change, base: base.revision });
  };
  return {
    changed(snapshot, batch = false) {
      if (!batch) { sendUpTo(snapshot); return; }
      pending = snapshot;
      waiting++;
      timer ??= setTimer(() => { timer = undefined; if (pending) sendUpTo(pending); }, delayMs);
    },
    flush() { if (pending) sendUpTo(pending); },
    get waiting() { return waiting; },
  };
}
