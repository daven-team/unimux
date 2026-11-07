// Client of the eval bridge (PLAN W2, src-tauri/crates/unimux-app/src/eval_bridge.rs): the macOS stand-in for CDP's
// Runtime.evaluate. The check build listens on 127.0.0.1:<MC_EVAL_PORT>; every request is one JSON line
// `{id, expression, label?, timeoutMs?}`, every answer one JSON line `{id, ok, value | error}`. `connectEval` returns the same
// `{evaluate, close}` shape as `connectPage` in tauri-app.mjs, so `waitFor` and the verify scripts work over either.
import { connect } from 'node:net';
import { sleep } from './tauri-app.mjs';

/** Connects to the bridge (retrying until the app listens); `label` picks the window (default "main"). */
export async function connectEval(port, { timeoutMs = 30000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  let socket;
  while (!socket) {
    try {
      socket = await new Promise((res, rej) => {
        const s = connect({ host: '127.0.0.1', port });
        s.once('connect', () => { s.off('error', rej); res(s); });
        s.once('error', rej);
      });
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`no eval bridge on 127.0.0.1:${port}: ${error.message}`);
      await sleep(250);
    }
  }
  socket.setEncoding('utf8');
  let id = 0;
  let buffer = '';
  const pending = new Map();
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.ok) waiter.res(msg.value); else waiter.rej(new Error(String(msg.error)));
    }
  });
  const closed = () => { for (const { rej } of pending.values()) rej(new Error('eval bridge connection closed')); pending.clear(); };
  socket.on('close', closed);
  socket.on('error', closed);
  /** Runs `expression` in the page (awaited, result by value), like CDP Runtime.evaluate with awaitPromise. */
  const evaluate = (expression, { timeoutMs: ms } = {}) => new Promise((res, rej) => {
    if (socket.destroyed) { rej(new Error('eval bridge connection closed')); return; }
    const n = ++id;
    pending.set(n, { res, rej });
    socket.write(`${JSON.stringify({ id: n, expression, ...(label ? { label } : {}), ...(ms ? { timeoutMs: ms } : {}) })}\n`);
  });
  return { evaluate, close: () => socket.end() };
}
