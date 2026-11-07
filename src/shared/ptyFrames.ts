// The binary frames of the 1.2.0 pty data plane (unimux-pty frame.rs): what the Tauri host posts to a window's pty port.
// One message holds one or more frames `[u8 kind][u16 LE idLen][id UTF-8][u32 LE len][payload]`:
//   1 data    the terminal's output bytes as read (UTF-8 may be cut anywhere: a streaming decoder per terminal),
//   2 exit    the exit code (i32 LE),
//   3 replay  [u32 LE headerLen][header JSON {sizes: [{at, cols, rows}]} with byte offsets][tail bytes],
//   4 json    any other HostToRenderer message (sshListResult ...), UTF-8 JSON,
//   5 reset   empty: a new terminal starts under the id (its decoder starts clean, like node-pty's per process).
// PtyFrameDecoder turns them into the HostToRenderer messages TerminalManager handles. A data message carries `bytes`, the
// size of its payload: flow control counts bytes on this host (the Electron host counts characters), so the ack is in bytes.
import type { HostToRenderer } from './ipc';
import type { ReplaySize } from './replay';

export const FRAME_DATA = 1;
export const FRAME_EXIT = 2;
export const FRAME_REPLAY = 3;
export const FRAME_JSON = 4;
export const FRAME_RESET = 5;

export interface Frame { kind: number; id: string; payload: Uint8Array }

const utf8 = new TextDecoder('utf-8');
/** A terminal's output decoder: a leading BOM is kept as U+FEFF, as node-pty's StringDecoder did. */
const outputDecoder = () => new TextDecoder('utf-8', { ignoreBOM: true });

/** The frames of one message; null when it is malformed. */
export function decodeFrames(buf: Uint8Array): Frame[] | null {
  const frames: Frame[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 0;
  while (at < buf.length) {
    if (buf.length - at < 3) return null;
    const kind = buf[at];
    const idLen = view.getUint16(at + 1, true);
    at += 3;
    if (buf.length - at < idLen + 4) return null;
    const id = utf8.decode(buf.subarray(at, at + idLen));
    at += idLen;
    const len = view.getUint32(at, true);
    at += 4;
    if (buf.length - at < len) return null;
    frames.push({ kind, id, payload: buf.subarray(at, at + len) });
    at += len;
  }
  return frames;
}

/** Encodes frames (tests, and the format's reference next to frame.rs). */
export function encodeFrames(frames: Array<{ kind: number; id: string; payload: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const parts = frames.map((f) => ({ ...f, idBytes: enc.encode(f.id) }));
  const out = new Uint8Array(parts.reduce((n, f) => n + 7 + f.idBytes.length + f.payload.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of parts) {
    out[at] = f.kind;
    view.setUint16(at + 1, f.idBytes.length, true);
    out.set(f.idBytes, at + 3);
    at += 3 + f.idBytes.length;
    view.setUint32(at, f.payload.length, true);
    out.set(f.payload, at + 4);
    at += 4 + f.payload.length;
  }
  return out;
}

/** Turns frames into HostToRenderer messages, with one streaming UTF-8 decoder per terminal. */
export class PtyFrameDecoder {
  private decoders = new Map<string, TextDecoder>();

  private decoder(id: string): TextDecoder {
    let d = this.decoders.get(id);
    if (!d) { d = outputDecoder(); this.decoders.set(id, d); }
    return d;
  }

  /** The messages of one port message (a Uint8Array of frames). Malformed messages give none. */
  messages(buf: Uint8Array): HostToRenderer[] {
    const frames = decodeFrames(buf);
    if (!frames) return [];
    const out: HostToRenderer[] = [];
    for (const f of frames) {
      if (f.kind === FRAME_DATA) {
        out.push({ t: 'data', id: f.id, data: this.decoder(f.id).decode(f.payload, { stream: true }), bytes: f.payload.length });
      } else if (f.kind === FRAME_EXIT) {
        if (f.payload.length < 4) continue;
        // An incomplete character at the very end of the output is shown as U+FFFD, as a final decode does.
        const rest = this.decoders.get(f.id)?.decode();
        this.decoders.delete(f.id);
        if (rest) out.push({ t: 'data', id: f.id, data: rest, bytes: 0 });
        out.push({ t: 'exit', id: f.id, code: new DataView(f.payload.buffer, f.payload.byteOffset, 4).getInt32(0, true) });
      } else if (f.kind === FRAME_REPLAY) {
        const replay = this.replay(f.id, f.payload);
        if (replay) out.push(replay);
      } else if (f.kind === FRAME_RESET) {
        this.decoders.delete(f.id);
      } else if (f.kind === FRAME_JSON) {
        try { out.push(JSON.parse(utf8.decode(f.payload)) as HostToRenderer); } catch { /* not ours */ }
      }
    }
    return out;
  }

  /**
   * A replay tail: decoded with a fresh decoder (the tail starts at a character), its byte offsets turned into the
   * character offsets of shared/replay. Bytes of a character cut at the end stay in the decoder for the live output.
   */
  private replay(id: string, payload: Uint8Array): HostToRenderer | null {
    if (payload.length < 4) return null;
    const headerLen = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
    if (payload.length < 4 + headerLen) return null;
    let header: { sizes?: Array<{ at: number; cols: number; rows: number }> };
    try { header = JSON.parse(utf8.decode(payload.subarray(4, 4 + headerLen))); } catch { return null; }
    const bytes = payload.subarray(4 + headerLen);
    const decoder = outputDecoder();
    this.decoders.set(id, decoder);
    const raw = (header.sizes ?? []).filter((s) => Number.isFinite(s.at)).map((s) => ({ ...s, at: Math.max(0, Math.min(bytes.length, Math.floor(s.at))) }));
    raw.sort((a, b) => a.at - b.at);
    let text = '';
    let from = 0;
    const sizes: ReplaySize[] = [];
    for (const s of raw) {
      text += decoder.decode(bytes.subarray(from, s.at), { stream: true });
      from = s.at;
      sizes.push({ at: text.length, cols: s.cols, rows: s.rows });
    }
    text += decoder.decode(bytes.subarray(from), { stream: true });
    return { t: 'replay', id, data: text, sizes };
  }

  /** A terminal is gone or the port was replaced. */
  forget(id?: string): void {
    if (id === undefined) this.decoders.clear(); else this.decoders.delete(id);
  }
}
