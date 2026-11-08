// The DB port's shared buffers (D12, Windows): the host batches its JSON messages into one buffer per post,
// `[u32 LE len][UTF-8 JSON]...`, with the additional data `{mcPort: 'db', a: <attach id>}`. The bridge parses them in order
// and hands each message to the page's MessagePort exactly like a Channel message (dbClient.ts and redisClient.ts unchanged).
import type { SharedBufferHost } from './ptyPort';

/** The JSON messages of one buffer, in order (a cut frame ends the batch, a frame that is not JSON is skipped). */
export function decodeDbFrames(bytes: Uint8Array, decoder = new TextDecoder('utf-8', { ignoreBOM: true })): unknown[] {
  const out: unknown[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = view.getUint32(at, true);
    at += 4;
    if (at + len > bytes.length) break;
    try { out.push(JSON.parse(decoder.decode(bytes.subarray(at, at + len)))); } catch { /* not a message */ }
    at += len;
  }
  return out;
}

/**
 * Routes the DB port's shared buffers into `deliver` (copied out first: the buffer is given back at once). Buffers of
 * another attach (an earlier page of this window) are released and dropped.
 */
export function listenDbBuffers(webview: SharedBufferHost, attach: string, deliver: (message: unknown) => void): void {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  webview.addEventListener('sharedbufferreceived', (e) => {
    if (e.additionalData?.mcPort !== 'db') return;
    const buffer = e.getBuffer();
    if (e.additionalData.a !== attach) { webview.releaseBuffer(buffer); return; }
    let copy: Uint8Array;
    try { copy = new Uint8Array(buffer).slice(); } finally { webview.releaseBuffer(buffer); }
    for (const m of decodeDbFrames(copy, decoder)) deliver(m);
  });
}
