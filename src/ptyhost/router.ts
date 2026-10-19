// Dispatches renderer data messages and kills to the backend that owns a terminal id (PtyManager or SshManager).
// Ids are cell ids, unique across backends. Sizes that arrive before the terminal exists are kept here for both backends.

export interface TerminalBackend {
  has(id: string): boolean;
  /** `reply`: a terminal reply, not typing (see RendererToHost). */
  write(id: string, data: string, reply?: boolean): void;
  resize(id: string, cols: number, rows: number): void;
  ack(id: string, chars: number): void;
  setFlowControl(on: boolean): void;
  histories(): Array<{ id: string; data: string }>;
  kill(id: string, timeoutMs?: number): Promise<void>;
  killAll(timeoutMs?: number): Promise<void>;
}

import type { RendererToHost } from '../shared/ipc';
import { setFocusedTerminal } from './output';

const EARLY_SIZES_MAX = 200;

export class HostRouter {
  /** Sizes that arrived before their spawn or connect request (the renderer's port is faster than main). */
  private earlySizes = new Map<string, { cols: number; rows: number }>();

  constructor(private readonly backends: TerminalBackend[]) {}

  private owner(id: string): TerminalBackend | undefined {
    return this.backends.find((b) => b.has(id));
  }

  write(id: string, data: string, reply = false): void { this.owner(id)?.write(id, data, reply); }

  /** One message from the renderer's port. */
  message(m: RendererToHost): void {
    if (m.t === 'write') this.write(m.id, m.data, m.reply === true);
    else if (m.t === 'resize') this.resize(m.id, m.cols, m.rows);
    else if (m.t === 'ack') this.ack(m.id, m.chars);
    else if (m.t === 'focus') setFocusedTerminal(typeof m.id === 'string' ? m.id : null);
  }

  /** A renderer (re)connected: it reports its focused terminal itself, the old one's report is forgotten. */
  rendererAttached(): void {
    setFocusedTerminal(null);
  }
  ack(id: string, chars: number): void { this.owner(id)?.ack(id, chars); }

  resize(id: string, cols: number, rows: number): void {
    const owner = this.owner(id);
    if (owner) { owner.resize(id, cols, rows); return; }
    this.earlySizes.delete(id);
    this.earlySizes.set(id, { cols, rows });
    if (this.earlySizes.size > EARLY_SIZES_MAX) this.earlySizes.delete(this.earlySizes.keys().next().value!);
  }

  takeEarlySize(id: string): { cols: number; rows: number } | undefined {
    const size = this.earlySizes.get(id);
    this.earlySizes.delete(id);
    return size;
  }

  setFlowControl(on: boolean): void { for (const b of this.backends) b.setFlowControl(on); }
  histories(): Array<{ id: string; data: string }> { return this.backends.flatMap((b) => b.histories()); }
  kill(id: string): Promise<void> { return this.owner(id)?.kill(id) ?? Promise.resolve(); }
  /** Settles every backend: one that rejects must not stop the others or the `killedAll` reply. */
  async killAll(): Promise<void> { await Promise.allSettled(this.backends.map((b) => b.killAll())); }
}
