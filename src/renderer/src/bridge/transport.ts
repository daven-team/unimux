// The Tauri transport of window.mc (1.2.0, PLAN F4): request/answer over `mc_invoke`, ordered fire-and-forget over `mc_send`,
// push events over Tauri events scoped to this window, the three MessagePorts over Tauri channels. Kept free of the Tauri
// packages (they are injected) so test/tauri-bridge.test.ts drives it with fakes.
import type { McTransport } from '../../../preload/mcApi';
import type { AppPlatform } from '../../../shared/platform';
import { EVENT_OPTIONAL_ARGS } from './contract.gen';

/** A window.mc call whose Rust side has not been ported yet (the owning package of docs/tauri/PLAN.md has not landed). */
export class McNotYetError extends Error {
  readonly code = 'MC_NOT_YET';
  constructor(readonly command: string) {
    super(`${command} is not available yet in this build`);
    this.name = 'McNotYetError';
  }
}

/** What Rust rejects with (unimux_ipc::IpcError). */
interface WireError { code?: string; message?: string; command?: string }

export interface BootInfo {
  platform: AppPlatform;
  windowsBuild: number;
  label: string;
}

export interface TauriDeps {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  /** Listens to an event addressed to this window; resolves to the unlisten function. */
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>;
  /** Logs a problem once in a while (console in dev, crash.log through app:reportError later). */
  log(message: string): void;
  /** Survives a reload of this window (sessionStorage); null in tests without it. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** A fresh id per page load. */
  newSession(): string;
}

/** Commands whose in-flight calls are journaled: an edit sent right before `location.reload()` is replayed by the next page. */
const JOURNALED = new Set(['state:edit']);
const JOURNAL_KEY = 'mc:journal';

export function toError(error: unknown, channel: string): Error {
  const wire = (typeof error === 'object' && error !== null ? error : { message: String(error) }) as WireError;
  if (wire.code === 'MC_NOT_YET') return new McNotYetError(wire.command ?? channel);
  const e = new Error(wire.message ?? String(error));
  (e as Error & { code?: string }).code = wire.code;
  return e;
}

/** JSON has no undefined: positional undefined arguments travel as null (Rust reads both as absent). */
const wireArgs = (args: unknown[]): unknown[] => args.map((a) => (a === undefined ? null : a));

export function createTauriTransport(boot: BootInfo, deps: TauriDeps): McTransport & { replayJournal(): Promise<void>; notYetLogged: Set<string> } {
  const session = deps.newSession();
  let seq = 0;
  const notYetLogged = new Set<string>();
  const logOnce = (key: string, message: string) => {
    if (notYetLogged.has(key)) return;
    notYetLogged.add(key);
    deps.log(message);
  };

  const journal = {
    read(): Record<string, { channel: string; args: unknown[] }> {
      try { return JSON.parse(deps.storage?.getItem(JOURNAL_KEY) ?? '{}') ?? {}; } catch { return {}; }
    },
    write(entries: Record<string, { channel: string; args: unknown[] }>) {
      try { deps.storage?.setItem(JOURNAL_KEY, JSON.stringify(entries)); } catch { /* storage full or gone: nothing to keep */ }
    },
    add(key: string, channel: string, args: unknown[]) { const all = this.read(); all[key] = { channel, args }; this.write(all); },
    remove(key: string) { const all = this.read(); if (key in all) { delete all[key]; this.write(all); } },
  };

  async function rawInvoke(channel: string, args: unknown[]): Promise<unknown> {
    try {
      const result = await deps.invoke('mc_invoke', { cmd: channel, args: wireArgs(args) });
      return result instanceof ArrayBuffer ? new Uint8Array(result) : result;
    } catch (error) {
      throw toError(error, channel);
    }
  }

  return {
    platform: boot.platform,
    windowsBuild: boot.windowsBuild,
    // OS file drops get their paths through pathsForFiles (W3); the HTML5 File of WebView2 has none.
    pathForFile: () => '',
    notYetLogged,
    invoke(channel, ...args) {
      const key = JOURNALED.has(channel) ? `${channel}:${(args[0] as { id?: string } | undefined)?.id ?? ''}` : null;
      if (key) journal.add(key, channel, wireArgs(args));
      const call = rawInvoke(channel, args);
      if (key) void call.then(() => journal.remove(key), (error) => { if (error instanceof McNotYetError) journal.remove(key); });
      return call;
    },
    send(channel, ...args) {
      seq += 1;
      deps.invoke('mc_send', { session, seq, cmd: channel, args: wireArgs(args) }).catch((error) => {
        const e = toError(error, channel);
        logOnce(`send:${channel}`, e instanceof McNotYetError ? `window.mc send ${channel}: not available yet` : `window.mc send ${channel} failed: ${e.message}`);
      });
    },
    on(channel, cb) {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      const optional = EVENT_OPTIONAL_ARGS[channel] ?? [];
      deps.listen(channel, (payload) => {
        if (cancelled) return;
        const args = Array.isArray(payload) ? [...payload] : [payload];
        for (const i of optional) if (args[i] === null) args[i] = undefined;
        cb(...args);
      }).then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      }, (error) => logOnce(`listen:${channel}`, `window.mc.on(${channel}) failed: ${String(error)}`));
      // Synchronous, and safe before listen() resolved: the late unlisten runs as soon as it arrives.
      return () => {
        cancelled = true;
        unlisten?.();
        unlisten = null;
      };
    },
    /** Sends again what the previous page of this window left unanswered (its last edits before a reload). */
    async replayJournal() {
      const pending = journal.read();
      journal.write({});
      for (const { channel, args } of Object.values(pending)) {
        try { await rawInvoke(channel, args); } catch (error) { deps.log(`replayed ${channel} failed: ${String((error as Error)?.message ?? error)}`); }
      }
    },
  };
}
