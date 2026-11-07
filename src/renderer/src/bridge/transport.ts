// The Tauri transport of window.mc (1.2.0, PLAN F4): request/answer over `mc_invoke` (or `mc_invoke_raw` when an argument is
// a Uint8Array), ordered fire-and-forget over `mc_send`, push events over Tauri events scoped to this window, the three
// MessagePorts over Tauri channels (mc.ts). Kept free of the Tauri packages (they are injected) so test/tauri-bridge.test.ts
// drives it with fakes.
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
  /** `args` is the JSON object of a command, or the raw body (bytes) of `mc_invoke_raw` with its headers. */
  invoke(command: string, args: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }): Promise<unknown>;
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

/** An unpaired UTF-16 surrogate (half an emoji cut by `.slice()`, text pasted from a broken source). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g');

const isWellFormed = (s: string): boolean => {
  const native = (s as { isWellFormed?: () => boolean }).isWellFormed;
  return native ? native.call(s) : !LONE_SURROGATE.test(s);
};

/**
 * `value` with every unpaired surrogate (in strings and object keys) replaced by U+FFFD, copying only what changes.
 * JSON.stringify writes a lone surrogate as `\udXXX`, which serde_json rejects, so Tauri would refuse the whole call (a
 * state:edit with one broken note). Rust reads a state.json written by 1.1.x the same way (unimux_core::js_json::parse).
 */
export function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return isWellFormed(value) ? value : value.replace(LONE_SURROGATES, '\ufffd');
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    value.forEach((item, i) => {
      const next = wellFormed(item);
      if (next !== item) (out ??= value.slice())[i] = next;
    });
    return out ?? value;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value; // Uint8Array, Date ...: as they are
    const entries = Object.entries(value as Record<string, unknown>);
    const changed = entries.some(([k, item]) => !isWellFormed(k) || wellFormed(item) !== item);
    if (!changed) return value;
    return Object.fromEntries(entries.map(([k, item]) => [wellFormed(k) as string, wellFormed(item)]));
  }
  return value;
}

/**
 * Saves whose new text may hold an unpaired surrogate: the index of that text and of the marker. 1.1.4 refused such a text
 * ('Nieprawidłowa treść pliku.') only after its other checks (project, opened file, path, read errors, the conflict), so
 * the bridge does not answer itself: wellFormed turns the text into U+FFFD and a `true` after the last argument tells Rust
 * it was ill-formed; Rust refuses it at 1.1.4's place (unimux_files::save).
 */
const MARK_ILL_FORMED_TEXT = new Map<string, { text: number; flag: number }>([
  ['fs:writeProjectFile', { text: 2, flag: 4 }],
  ['local:writeFile', { text: 1, flag: 3 }],
]);

/** `args` of a save with the ill-formed marker in place (the same array when the text is fine). */
function markIllFormedText(channel: string, args: unknown[]): unknown[] {
  const at = MARK_ILL_FORMED_TEXT.get(channel);
  const text = at === undefined ? undefined : args[at.text];
  if (at === undefined || typeof text !== 'string' || isWellFormed(text)) return args;
  const marked = args.slice(0, at.flag);
  while (marked.length < at.flag) marked.push(undefined);
  marked.push(true);
  return marked;
}

/** JSON has no undefined: positional undefined arguments travel as null (Rust reads both as absent). */
const wireArgs = (args: unknown[]): unknown[] => args.map((a) => (a === undefined ? null : wellFormed(a)));

const isBytes = (a: unknown): a is Uint8Array | ArrayBuffer => a instanceof Uint8Array || a instanceof ArrayBuffer;

/** JSON with every non-ASCII character escaped: HTTP header values (`mc-args`) must be ISO-8859-1. */
export const asciiJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const FRAME_MAGIC = [0x4d, 0x43, 0x42, 0x31]; // "MCB1"

/**
 * A raw answer of Rust (unimux_ipc::binary): `MCB1`, a u32 LE header length, the header `{value, parts}` and the byte parts.
 * `{"$mcBytes": i}` inside the value becomes part i as a Uint8Array, so bytes can sit inside an object (sound:load's
 * `{ data: Uint8Array | null }`). A buffer without the magic is taken as plain bytes.
 */
export function decodeBinaryReply(buffer: ArrayBuffer): unknown {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8 || FRAME_MAGIC.some((b, i) => bytes[i] !== b)) return bytes;
  const length = new DataView(buffer).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as { value: unknown; parts: number[] };
  const parts: Uint8Array[] = [];
  let at = 8 + length;
  for (const n of header.parts) { parts.push(bytes.slice(at, at + n)); at += n; }
  const revive = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(revive);
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === '$mcBytes' && typeof o.$mcBytes === 'number') return parts[o.$mcBytes] ?? null;
      return Object.fromEntries(keys.map((k) => [k, revive(o[k])]));
    }
    return v;
  };
  return revive(header.value);
}

export type TauriTransport = McTransport & {
  replayJournal(): Promise<void>;
  notYetLogged: Set<string>;
  /** Drops every event subscription of this page (pagehide). */
  dispose(): void;
  subscriptionCount(): number;
};

export function createTauriTransport(boot: BootInfo, deps: TauriDeps): TauriTransport {
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
    args = markIllFormedText(channel, args);
    try {
      const rawAt = args.findIndex(isBytes);
      let result: unknown;
      if (rawAt >= 0) {
        // A Uint8Array argument (notes:image:save): the bytes are the raw body, the rest travels in headers (no JSON number
        // array, no base64). One per call; a second one would go as JSON.
        const raw = args[rawAt] as Uint8Array | ArrayBuffer;
        const rest = wireArgs(args.map((a, i) => (i === rawAt ? null : a)));
        const headers = { 'mc-cmd': channel, 'mc-args': asciiJson(rest), 'mc-raw-index': String(rawAt) };
        result = await deps.invoke('mc_invoke_raw', raw instanceof Uint8Array ? raw : new Uint8Array(raw), { headers });
      } else {
        result = await deps.invoke('mc_invoke', { cmd: channel, args: wireArgs(args) });
      }
      return result instanceof ArrayBuffer ? decodeBinaryReply(result) : result;
    } catch (error) {
      throw toError(error, channel);
    }
  }

  /** Every live event subscription of this page, so a reload or navigation can drop them all (dispose). */
  const subscriptions = new Set<() => void>();

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
      // Every send takes a number, also one Rust refuses: Rust fills the slot (SendQueue::skip), so the next is not held.
      seq += 1;
      deps.invoke('mc_send', { session, seq, cmd: channel, args: wireArgs(args) }).catch((error) => {
        const e = toError(error, channel);
        logOnce(`send:${channel}`, e instanceof McNotYetError ? `window.mc send ${channel}: not available yet` : `window.mc send ${channel} failed: ${e.message}`);
      });
    },
    on(channel, cb) {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      const off = () => {
        cancelled = true;
        subscriptions.delete(off);
        unlisten?.();
        unlisten = null;
      };
      subscriptions.add(off);
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
      return off;
    },
    /**
     * Tauri keeps JS listeners per webview label until the window is destroyed, not per page: without this every reload
     * (Ctrl+R, the ErrorBoundary, the journaled reload) would leave a full set of dead listener ids that each later emit
     * carries along.
     */
    dispose() {
      for (const off of [...subscriptions]) off();
    },
    subscriptionCount: () => subscriptions.size,
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

/**
 * Renderer -> host messages of a port (pty: write, resize, ack...), in order. Every message of one task is batched into one
 * `mc_port_post` numbered per page load like sends (Tauri runs invokes concurrently; a MessagePort kept the order) and Rust
 * delivers the batches by number (SendQueue, lane `<label>\0port:<kind>`).
 */
export function createPortPoster(
  kind: string,
  session: string,
  post: (args: { session: string; seq: number; kind: string; messages: unknown[] }) => Promise<unknown>,
  schedule: (flush: () => void) => void = queueMicrotask,
): (message: unknown) => void {
  let seq = 0;
  let batch: unknown[] | null = null;
  return (message) => {
    if (!batch) {
      batch = [];
      schedule(() => {
        const messages = batch ?? [];
        batch = null;
        seq += 1;
        void post({ session, seq, kind, messages: wellFormed(messages) as unknown[] }).catch(() => undefined);
      });
    }
    batch.push(message);
  };
}
