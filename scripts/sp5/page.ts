// SP5 spike page (bundled by scripts/sp5/run.mjs, served into the Tauri check build over CDP): xterm cells with the
// options of TerminalManager.ts (theme, font, windowsPty conpty, reflowCursorLine, unicode 11, WebGL) fed by the Rust ConPTY
// data plane: binary frames over one Tauri Channel, byte acks after xterm parsed them, keys as win32-input-mode once ConPTY
// asked for it (?9001h). window.__mc.terminals.entries mirrors the app's TerminalManager for the latency probe of
// scripts/perf-latency.mjs.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Channel, invoke } from '@tauri-apps/api/core';
import { encodeWin32Key } from '../../src/shared/win32input';
import { DEFAULT_SSH_THEME, sshThemeById } from '../../src/shared/sshThemes';

const CARD_BG = '#131313';
const THEME = { ...sshThemeById(DEFAULT_SSH_THEME).colors, background: CARD_BG, cursorAccent: CARD_BG };
const FONT = '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, "SFMono-Regular", "Courier New", monospace';
const KIND_DATA = 1;
const KIND_EXIT = 2;

interface Cell {
  id: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  win32: boolean;
  /** Bytes received / parsed (acked). */
  received: number;
  parsed: number;
  exit: number | null;
  /** Everything the terminal sent to the pty (DA1 answer, focus reports, keys). */
  sent: string[];
  sending: Promise<unknown> | null;
  queued: string;
  webgl: WebglAddon | null;
}

const cells = new Map<string, Cell>();
const pendingAcks = new Map<string, number>();
let ackTimer: ReturnType<typeof setTimeout> | null = null;
const stats = { messages: 0, frames: 0, bytes: 0, maxMessage: 0, decodeMs: 0 };

function flushAcks(): void {
  ackTimer = null;
  if (!pendingAcks.size) return;
  const acks = [...pendingAcks];
  pendingAcks.clear();
  void invoke('spike_pty', { op: 'ack', args: { acks } });
}

function ack(id: string, n: number): void {
  pendingAcks.set(id, (pendingAcks.get(id) ?? 0) + n);
  ackTimer ??= setTimeout(flushAcks, 16);
}

function onMessage(message: unknown): void {
  const t0 = performance.now();
  const buf = message instanceof ArrayBuffer ? new Uint8Array(message) : message instanceof Uint8Array ? message : new Uint8Array(message as number[]);
  stats.messages++;
  stats.maxMessage = Math.max(stats.maxMessage, buf.byteLength);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  let at = 0;
  while (at < buf.byteLength) {
    const kind = buf[at];
    const idLen = view.getUint16(at + 1, true);
    const id = dec.decode(buf.subarray(at + 3, at + 3 + idLen));
    const len = view.getUint32(at + 3 + idLen, true);
    const payload = buf.subarray(at + 7 + idLen, at + 7 + idLen + len);
    at += 7 + idLen + len;
    stats.frames++;
    const cell = cells.get(id);
    if (!cell) continue;
    if (kind === KIND_DATA) {
      stats.bytes += len;
      cell.received += len;
      // xterm keeps the UTF-8 decoder state per terminal: a frame may end inside a character.
      cell.term.write(payload.slice(), () => { cell.parsed += len; ack(id, len); });
    } else if (kind === KIND_EXIT) {
      cell.exit = new DataView(payload.buffer, payload.byteOffset, 4).getInt32(0, true);
    }
  }
  stats.decodeMs += performance.now() - t0;
}

/** Input in order per terminal: one invoke in flight, what arrives meanwhile leaves with the next one. */
function send(cell: Cell, data: string): void {
  cell.sent.push(data);
  if (cell.sending) { cell.queued += data; return; }
  const go = (d: string): void => {
    cell.sending = invoke('spike_pty', { op: 'write', args: { id: cell.id, data: d } }).finally(() => {
      cell.sending = null;
      if (cell.queued) { const next = cell.queued; cell.queued = ''; go(next); }
    });
  };
  go(data);
}

const grid = document.createElement('div');
grid.id = 'grid';
document.body.appendChild(grid);

function relayout(): void {
  const n = Math.max(1, cells.size);
  const cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : n <= 9 ? 3 : n <= 12 ? 4 : 5;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${Math.ceil(n / cols)}, minmax(0, 1fr))`;
}

interface OpenOptions { synthetic?: { rate: number; seconds?: number }; file: string; args?: string[]; cwd?: string; env?: Record<string, string>; fontSize?: number; webgl?: boolean }

async function open(id: string, opts: OpenOptions): Promise<{ pid: number; cols: number; rows: number }> {
  const host = document.createElement('div');
  host.className = 'sp5-cell';
  host.dataset.id = id;
  grid.appendChild(host);
  const term = new Terminal({
    theme: THEME,
    fontFamily: FONT,
    fontSize: opts.fontSize ?? 13,
    lineHeight: 1.1,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    windowsPty: { backend: 'conpty', buildNumber: 26100 },
    reflowCursorLine: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(host);
  const cell: Cell = { id, term, fit, host, win32: false, received: 0, parsed: 0, exit: null, sent: [], sending: null, queued: '', webgl: null };
  if (opts.webgl !== false) {
    try { const gl = new WebglAddon(); term.loadAddon(gl); cell.webgl = gl; } catch { /* DOM renderer */ }
  }
  cells.set(id, cell);
  relayout();
  fit.fit();
  // ConPTY asks its host terminal for win32-input-mode with CSI ? 9001 h (TerminalManager.ts).
  const setW32 = (on: boolean) => (params: (number | number[])[]) => { if (params.includes(9001)) cell.win32 = on; return false; };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, setW32(true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, setW32(false));
  term.attachCustomKeyEventHandler((ev) => {
    if (!cell.win32) return true;
    if (ev.type !== 'keydown' && ev.type !== 'keyup') return false;
    if (ev.isComposing || ev.keyCode === 229) return true;
    const seq = encodeWin32Key(ev);
    if (!seq) return true;
    ev.preventDefault();
    send(cell, seq);
    return false;
  });
  term.onData((d) => send(cell, d));
  // The focused terminal gets the short output window (TerminalManager posts {t: 'focus'} the same way).
  term.textarea?.addEventListener('focus', () => void invoke('spike_pty', { op: 'focus', args: { id } }));
  term.textarea?.addEventListener('blur', () => void invoke('spike_pty', { op: 'focus', args: { id: null } }));
  term.onBinary((d) => send(cell, d));
  term.onResize(({ cols, rows }) => void invoke('spike_pty', { op: 'resize', args: { id, cols, rows } }));
  if (opts.synthetic) {
    await invoke('spike_pty', { op: 'synthetic', args: { id, rate: opts.synthetic.rate, seconds: opts.synthetic.seconds ?? 0 } });
    return { pid: 0, cols: term.cols, rows: term.rows };
  }
  const { pid } = await invoke<{ pid: number }>('spike_pty', { op: 'spawn', args: { id, file: opts.file, args: opts.args ?? [], cwd: opts.cwd, env: opts.env, cols: term.cols, rows: term.rows } });
  return { pid, cols: term.cols, rows: term.rows };
}

async function init(config: { batchMs?: number; focusMs?: number; timer1ms?: boolean; flow?: boolean } = {}): Promise<unknown> {
  for (const c of cells.values()) { c.webgl?.dispose(); c.term.dispose(); c.host.remove(); }
  cells.clear();
  const channel = new Channel<unknown>();
  channel.onmessage = onMessage;
  return invoke('spike_pty_attach', { config, channel });
}

/** rAF intervals over `ms`: fps, p95 / max frame interval, frames over 33 ms and 50 ms, bytes parsed per second. */
function frames(ms: number): Promise<unknown> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    const parsed0 = [...cells.values()].reduce((a, c) => a + c.parsed, 0);
    const recv0 = [...cells.values()].reduce((a, c) => a + c.received, 0);
    const start = performance.now();
    let last = start;
    const tick = (now: number): void => {
      intervals.push(now - last);
      last = now;
      if (now - start < ms) { requestAnimationFrame(tick); return; }
      const sorted = [...intervals].sort((a, b) => a - b);
      const secs = (now - start) / 1000;
      const parsed = [...cells.values()].reduce((a, c) => a + c.parsed, 0) - parsed0;
      const received = [...cells.values()].reduce((a, c) => a + c.received, 0) - recv0;
      resolve({
        fps: intervals.length / secs,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted[sorted.length - 1],
        over33: intervals.filter((x) => x > 33.4).length,
        over50: intervals.filter((x) => x > 50).length,
        parsedMBps: parsed / secs / 1e6,
        receivedMBps: received / secs / 1e6,
        backlogKB: ([...cells.values()].reduce((a, c) => a + c.received - c.parsed, 0)) / 1024,
        webgl: [...cells.values()].filter((c) => c.webgl).length,
      });
    };
    requestAnimationFrame(tick);
  });
}

function screen(id: string): string[] {
  const t = cells.get(id)?.term;
  if (!t) return [];
  const b = t.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < t.rows; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  return out;
}

const api = {
  init, open, frames, screen, stats,
  cell: (id: string) => { const c = cells.get(id); return c && { win32: c.win32, received: c.received, parsed: c.parsed, exit: c.exit, sent: c.sent, cols: c.term.cols, rows: c.term.rows, cursor: [c.term.buffer.active.cursorX, c.term.buffer.active.cursorY] }; },
  focus: (id: string) => { cells.get(id)?.term.focus(); },
  blur: () => { (document.activeElement as HTMLElement | null)?.blur(); },
  kill: (id: string) => invoke('spike_pty', { op: 'kill', args: { id } }),
  killAll: () => invoke('spike_pty', { op: 'killAll' }),
  rustStats: () => invoke('spike_pty', { op: 'stats' }),
  fitAll: () => { for (const c of cells.values()) c.fit.fit(); },
  remove: (id: string) => { const c = cells.get(id); if (!c) return; c.webgl?.dispose(); c.term.dispose(); c.host.remove(); cells.delete(id); relayout(); },
};
(window as unknown as { sp5: typeof api }).sp5 = api;
(window as unknown as { __mc: unknown }).__mc = { terminals: { entries: cells } };
window.addEventListener('resize', () => api.fitAll());
