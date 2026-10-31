// One prompt to several agent cells at once (1.1.1): a window asks (agents:prompt), main splits the cells by the window that holds
// their terminal (the main window or a detached grid's window), sends each window its part (agents:prompt:run) and waits for the
// answers (agents:prompt:done). A window that does not answer in time leaves its cells `unreachable`. The rules live in
// shared/agentPrompt.ts, the sending in renderer/agentPrompt.ts.
import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import {
  AGENT_PROMPT_TIMEOUT_MS, cleanAgentPromptAnswer, cleanAgentPromptRequest, type AgentPromptItem, type AgentPromptOutcome,
} from '../shared/agentPrompt';
import type { IpcGuard } from './ipcGuard';
import { safeSend } from './safeWindow';

interface Pending { window: BrowserWindow; asked: string[]; resolve(answer: Record<string, AgentPromptOutcome>): void }

export function registerAgentPromptIpc({ guardedHandle, guardedOn }: Pick<IpcGuard, 'guardedHandle' | 'guardedOn'>, cellWindow: (cellId: string) => BrowserWindow | null): void {
  const pending = new Map<string, Pending>();

  const ask = (window: BrowserWindow, mode: 'probe' | 'send', queueBusy: boolean, items: AgentPromptItem[]): Promise<Record<string, AgentPromptOutcome>> =>
    new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); resolve({}); }, AGENT_PROMPT_TIMEOUT_MS);
      pending.set(id, { window, asked: items.map((i) => i.cellId), resolve: (answer) => { clearTimeout(timer); pending.delete(id); resolve(answer); } });
      if (!safeSend(window, 'agents:prompt:run', id, { mode, queueBusy, items })) pending.get(id)?.resolve({});
    });

  guardedHandle('agents:prompt', async (_e, raw: unknown) => {
    const req = cleanAgentPromptRequest(raw);
    if (!req) return {};
    const groups = new Map<BrowserWindow | null, AgentPromptItem[]>();
    for (const item of req.items) {
      const w = cellWindow(item.cellId);
      groups.set(w, [...(groups.get(w) ?? []), item]);
    }
    const out: Record<string, AgentPromptOutcome> = {};
    const answers = await Promise.all([...groups].map(([w, items]) => (w ? ask(w, req.mode, req.queueBusy, items) : Promise.resolve({}))));
    for (const answer of answers) Object.assign(out, answer);
    for (const item of req.items) {
      if (!out[item.cellId]) out[item.cellId] = req.mode === 'send' ? { state: 'unreachable', result: 'skipped' } : { state: 'unreachable' };
    }
    return out;
  }, () => ({}));

  // Only the window that was asked may answer, and only for the cells it was asked about.
  guardedOn('agents:prompt:done', (e, requestId: unknown, raw: unknown) => {
    if (typeof requestId !== 'string') return;
    const p = pending.get(requestId);
    if (!p) return;
    let same = false;
    try { same = e.sender === p.window.webContents; } catch { /* the window is gone */ }
    if (!same) return;
    p.resolve(cleanAgentPromptAnswer(raw, p.asked));
  });
}
