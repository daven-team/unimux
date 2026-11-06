// The keystroke-to-echo probe of scripts/perf-latency.mjs, shared by the SP5 runs of both apps (scripts/sp5/run.mjs on the
// Tauri spike page, scripts/sp5/electron-grid.mjs on 1.1.4): keydown (capture) -> echo parsed by xterm -> next render.
// Works on window.__mc.terminals.entries (TerminalManager in 1.1.4, the spike page's mirror in Tauri).

export const PROBE = `(() => {
  const probe = window.__latency = { cell: null, queue: [], typed: '', echoed: 0, row: 0, col: 0, parsed: [], done: [] };
  window.addEventListener('keydown', (ev) => { if (probe.cell && ev.key.length === 1) { probe.queue.push(performance.now()); probe.typed += ev.key; } }, true);
  for (const [id, e] of window.__mc.terminals.entries) {
    e.term.onWriteParsed(() => {
      if (probe.cell !== id || probe.echoed >= probe.typed.length) return;
      const now = performance.now();
      const text = e.term.buffer.active.getLine(probe.row)?.translateToString(true, probe.col) ?? '';
      let n = 0;
      while (n < probe.typed.length && text[n] === probe.typed[n]) n++;
      for (; probe.echoed < n; probe.echoed++) probe.parsed.push([probe.queue.shift(), now]);
    });
    e.term.onRender(() => {
      if (probe.cell !== id || !probe.parsed.length) return;
      const now = performance.now();
      for (const [t0, t1] of probe.parsed.splice(0)) probe.done.push([t1 - t0, now - t0]);
    });
  }
  probe.arm = (id) => { const b = window.__mc.terminals.entries.get(id).term.buffer.active; Object.assign(probe, { cell: id, queue: [], typed: '', echoed: 0, parsed: [], row: b.cursorY + b.baseY, col: b.cursorX }); };
  return true;
})()`;

export const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};

/**
 * Types `keys` letters into `cell` per pace (spaced: one key, burst: 6 keys 25 ms apart) exactly like perf-latency.mjs.
 * `ev(expr)` evaluates in the page, `key(name)` sends one key over CDP ('Enter' or a letter), `focus(cell)` focuses it.
 */
export async function measureLatency({ ev, key, sleep, focus, cell, keys }) {
  const letters = 'asdfghjklqwertyuiop';
  const arm = () => ev(`window.__latency.arm(${JSON.stringify(cell)}), true`);
  const enter = async () => { await ev(`window.__latency.cell = null, true`); await key('Enter'); await sleep(700); await arm(); };
  const out = {};
  for (const pace of ['spaced', 'burst']) {
    await focus(cell);
    await sleep(300);
    await enter();
    await ev(`window.__latency.done = [], true`);
    let typed = 0, count = 0, stalled = 0;
    while (count < keys) {
      if (stalled > 10) throw new Error(`${cell} ${pace}: no echo recognized for 10 rounds (${count} of ${keys})`);
      if (typed >= 12) { await enter(); typed = 0; }
      const batch = pace === 'spaced' ? 1 : 6;
      for (let i = 0; i < batch; i++) { await key(letters[(count + i) % letters.length]); typed++; if (pace === 'burst') await sleep(25); }
      const t = Date.now();
      while (Date.now() - t < 2000 && (await ev(`window.__latency.queue.length + window.__latency.parsed.length`)) > 0) await sleep(2);
      const now = await ev(`window.__latency.done.length`);
      stalled = now > count ? 0 : stalled + 1;
      count = now;
      if (await ev(`window.__latency.queue.length > 0`)) { await enter(); typed = 0; }
      await sleep(80 + Math.random() * 60);
    }
    await ev(`window.__latency.cell = null, true`);
    const samples = (await ev(`window.__latency.done.splice(0)`)).slice(0, keys);
    out[`local/${pace}`] = { parsed: stats(samples.map((x) => x[0])), drawn: stats(samples.map((x) => x[1])) };
  }
  return out;
}

/** A letter or Enter as CDP key events (keyDown with text, keyUp). */
export async function cdpKey(send, ch) {
  if (ch === 'Enter') {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    return;
  }
  const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch === ' ' ? 'Space' : /\d/.test(ch) ? `Digit${ch}` : '';
  const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
