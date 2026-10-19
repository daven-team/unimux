// Owns one xterm.js instance per cell for the app's lifetime. Hidden cells keep their terminal in
// an off-screen "parking" element so output keeps flowing; visible cells get a WebGL renderer.
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { unpackHostMessage, type HostToRenderer, type HostToRendererPort, type RendererToHost } from '../../../shared/ipc';
import type { BoundThread } from '../../../shared/codexHooks';
import { screenWaitsForBackground } from '../../../shared/backgroundWait';
import { AgentInference, keySequence, type InferredAgent, type ScreenLine, type ScreenState } from '../../../shared/agentInfer';
import { FailureScanner } from '../../../shared/outputFailure';
import { isFocusOrMouseReport, isUserInput, StatusTracker, type CellStatus, type HookEvent, type HookInfo, type StatusCause, type StatusReason } from '../../../shared/status';
import { hookDetail, StatusLog, type StatusTrigger } from '../../../shared/statusLog';
import { sshModeReset } from '../../../shared/ssh';
import { inputModesOff, isMouseReport, MouseFloodGuard, terminalModeReset } from '../../../shared/termReset';
import { encodeWin32Key } from '../../../shared/win32input';
import { tr } from '../i18n';
import { confirmTerminalLink } from '../terminalLinks';
import { DEFAULT_SCROLLBACK_LINES, MAX_WEBGL_CONTEXTS, normalizeScrollback, PENDING_OUTPUT_CHARS } from '../../../shared/terminalLimits';
import { nextLossCount, planWebgl, webglBackoff, WebglLimit } from '../../../shared/webglPool';
import { onWindowShown } from '../windowShown';

// Campbell (Windows Terminal / PowerShell default) on a Cursor-like background.
export const THEME: ITheme = {
  background: '#0d0d0d', foreground: '#cccccc', cursor: '#cccccc', cursorAccent: '#0d0d0d',
  selectionBackground: '#264f78', selectionInactiveBackground: '#264f7880',
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da',
  magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
};

const FONT = '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, "SFMono-Regular", "Courier New", monospace';

interface Entry {
  id: string;
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  /** When the terminal was last shown (LRU order of the WebGL contexts kept by parked terminals). */
  shownAt: number;
  /** Last live output (performance.now()): busy cells get a WebGL context before quiet ones. */
  outputAt: number | undefined;
  /** When the WebGL context was last created, given up or lost (hysteresis, webglPool.ts). */
  webglChangedAt: number | undefined;
  /** No new context before this time (back-off after a lost one). */
  webglBlockedUntil: number | undefined;
  /** The GL context of `webgl` (given back explicitly on release, so Chromium's count matches ours). */
  webglGl: WebGL2RenderingContext | null;
  /** When the current (or last) context was created. */
  webglGrantedAt: number;
  /** Lost contexts in a row (a context that lived WEBGL_HEALTHY_MS starts the count over). */
  webglLosses: number;
  host: HTMLDivElement;
  tracker: StatusTracker;
  win32: boolean;
  agent: boolean;
  /** Codex cell: approval OSC 9 is an attention signal and the output is scanned for a failed turn (usage limit). */
  codex: boolean;
  scanner: FailureScanner;
  /** Stops mouse reports that only a shell prompt is echoing (see termReset.ts). */
  guard: MouseFloodGuard;
  /** Which agent the user started by hand in this (shell) cell, guessed from the typed lines and the screen (see agentInfer.ts). */
  infer: AgentInference;
  attachedTo: HTMLElement | null;
  resizeObs: ResizeObserver | null;
  /** >0 while replayed history is being parsed: terminal query replies must not reach the pty. */
  replaying: number;
  lastSize: { cols: number; rows: number };
  /** Selection redraw that arrived while the terminal was parked (see `deferParkedSelection`). */
  parkedSelection: unknown[] | null;
  applySelection: ((args: unknown[]) => void) | null;
  /** An SSH session: no ConPTY hints, no win32-input-mode, no local exit line (spec 6.2). */
  remote: boolean;
}

/** `reason` is why the cell last became waiting (done / attention / error); `hooked` = precise hooks drive this cell; `info.turn` keys the alert of a turn. */
type StatusListener = (cellId: string, status: CellStatus, prev: CellStatus, cause: StatusCause, reason: StatusReason, hooked: boolean, info?: HookInfo) => void;

/** Recent status transitions of every cell, for bug reports (no message text). */
export const statusLog = new StatusLog();

export interface EnsureOptions {
  fontSize: number;
  agent: boolean;
  /** The profile runs Codex. */
  codex?: boolean;
  /** The cell is an SSH session (src/renderer/src/ssh.ts). */
  remote?: boolean;
  onFontSize?: (size: number) => void;
}

class TerminalManager {
  private entries = new Map<string, Entry>();
  private port: MessagePort | null = null;
  /** The first terminal output of this window was reported for startup.log. */
  private firstOutput = false;
  private pending = new Map<string, Array<{ data: string; replay: boolean }>>();
  private exited = new Set<string>();
  private disposed = new Set<string>();
  private statusListeners = new Set<StatusListener>();
  private exitListeners = new Set<(cellId: string) => void>();
  private bindListeners = new Set<(cellId: string, thread: BoundThread) => void>();
  private floodListeners = new Set<(cellId: string) => void>();
  /** Where a terminal is opened (xterm measures its glyphs there, so it has a real size). */
  private staging: HTMLDivElement;
  /** Where terminals wait while no cell shows them: `display: none` so the browser spends no style or layout work on them (xterm pauses its renderer by itself). */
  private parking: HTMLDivElement;
  private buildNumber = 0;
  private acks = new Map<string, number>();
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  /** False while the window is minimized or hidden: no terminal is drawn and no WebGL context is kept (output still buffers). */
  private windowShown = true;
  /** WebGL contexts handed out at most: lowered when Chromium turns out to allow fewer (see `contextLost`). */
  private webglLimit = new WebglLimit(MAX_WEBGL_CONTEXTS);
  /** When the last WebGL context was created. */
  private lastGrantAt = -Infinity;
  /** The 400 ms status tick runs only while there are terminals: an empty window (first run, no project) never wakes up for it. */
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.staging = document.createElement('div');
    this.staging.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:800px;overflow:hidden;visibility:hidden;';
    document.body.appendChild(this.staging);
    this.parking = document.createElement('div');
    this.parking.style.cssText = 'display:none;';
    document.body.appendChild(this.parking);
    window.addEventListener('message', (e) => {
      if (e.data === 'mc:pty-port' && e.ports[0]) this.setPort(e.ports[0]);
    });
    // Minimize / restore / hide / show / focus changes make agents redraw: that output is not work (see StatusTracker.environment).
    const environment = () => {
      const now = performance.now();
      for (const e of this.entries.values()) e.tracker.environment(now);
    };
    document.addEventListener('visibilitychange', environment);
    window.addEventListener('focus', environment);
    window.addEventListener('blur', environment);
    onWindowShown((shown) => { this.setWindowShown(shown); environment(); });
    // A shown terminal on the DOM renderer (the pool was short, or its context was lost) asks again once a second; the
    // plan itself limits how often a context moves between cells on screen.
    setInterval(() => {
      if (this.webglLimit.recover(performance.now())) console.warn(`WebGL contexts limit raised to ${this.webglLimit.limit}`);
      if (this.needsWebgl()) this.balanceWebgl();
    }, 1000);
    document.addEventListener('focusin', () => { if (this.needsWebgl()) this.balanceWebgl(); this.syncHostFocus(); });
    // During focusout the next element does not have the focus yet: look once the move is done.
    document.addEventListener('focusout', () => setTimeout(() => this.syncHostFocus(), 0));
    // Capture: the event does not bubble, and xterm reports a lost context only 3 s later (after waiting for a restore).
    document.addEventListener('webglcontextlost', (ev) => this.contextLost(ev.target), true);
  }

  /**
   * The window runs without background throttling (status ticks and output must not slow down while it is minimized), so
   * drawing stops here instead: every terminal box is taken out of the layout, which pauses xterm's renderer, and the WebGL
   * contexts are given back. xterm keeps writing into its buffer; showing the window again redraws and refits the cells.
   */
  private setWindowShown(shown: boolean): void {
    if (shown === this.windowShown) return;
    this.windowShown = shown;
    if (!shown) {
      for (const e of this.entries.values()) {
        if (e.host.contains(document.activeElement)) this.refocus = e.id;
        e.host.style.display = 'none';
        this.releaseWebgl(e);
      }
      return;
    }
    for (const e of this.entries.values()) {
      e.host.style.display = '';
      if (e.attachedTo) this.refit(e);
    }
    this.balanceWebgl();
    const refocus = this.refocus ? this.entries.get(this.refocus) : undefined;
    this.refocus = null;
    if (refocus?.attachedTo && (!document.activeElement || document.activeElement === document.body)) refocus.term.focus();
  }

  /** The terminal that had the keyboard focus when the window was minimized. */
  private refocus: string | null = null;

  /** ConPTY (and its win32-input-mode) applies only to local terminals on Windows. */
  private conpty(e: Entry): boolean {
    return window.mc.platform === 'win32' && !e.remote;
  }

  setWindowsBuild(n: number): void {
    this.buildNumber = n;
  }

  private setPort(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    // Acks owed to the previous host/port are meaningless for the new one.
    this.acks.clear();
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    port.onmessage = (e) => { for (const m of unpackHostMessage(e.data as HostToRendererPort)) this.onHostMessage(m); };
    port.start();
    // Tell the host about the sizes we already know (e.g. after a host restart).
    for (const e of this.entries.values()) this.post({ t: 'resize', id: e.id, cols: e.term.cols, rows: e.term.rows });
    this.syncHostFocus(true);
  }

  /** Lines of history a terminal keeps (Settings > Terminal, see setScrollback). */
  private scrollback = DEFAULT_SCROLLBACK_LINES;

  /** The terminal last reported to the pty host as focused (its output keeps the short coalescing window). */
  private hostFocus: string | null = null;

  private focusedTerminal(): string | null {
    const active = document.activeElement;
    if (!active) return null;
    for (const e of this.entries.values()) if (e.term.textarea === active) return e.id;
    return null;
  }

  private syncHostFocus(force = false): void {
    const id = this.focusedTerminal();
    if (id === this.hostFocus && !force) return;
    this.hostFocus = id;
    this.post({ t: 'focus', id });
  }

  private post(m: RendererToHost): void {
    this.port?.postMessage(m);
  }

  private onHostMessage(m: HostToRenderer): void {
    if (m.t === 'data' && !this.firstOutput) { this.firstOutput = true; window.mc?.startupMark?.('first-output'); }
    if (m.t === 'exit') {
      this.exited.add(m.id);
      const e = this.entries.get(m.id);
      if (e) {
        e.infer.exited();
        e.term.write(inputModesOff(this.conpty(e)));
        if (!e.remote) e.term.write(`\r\n\x1b[90m[${tr('Terminal')} · ${tr('zakończony')}]\x1b[0m\r\n`);
        this.setStatus(e, () => e.tracker.exited(), 'exit');
      }
      this.exitListeners.forEach((l) => l(m.id));
      return;
    }
    const e = this.entries.get(m.id);
    if (!e) {
      if (this.disposed.has(m.id)) {
        this.ack(m); // in-flight output of a closed cell
        return;
      }
      const q = this.pending.get(m.id) ?? [];
      this.ack(m); // queued output is bounded below, so the host need not wait for it
      if (m.t === 'replay') q.length = 0;
      q.push({ data: m.data, replay: m.t === 'replay' });
      // Bound memory for busy cells that are never shown: keep roughly the newest PENDING_OUTPUT_CHARS.
      let size = q.reduce((n, x) => n + x.data.length, 0);
      while (size > PENDING_OUTPUT_CHARS && q.length > 1) size -= q.shift()!.data.length;
      this.pending.set(m.id, q);
      return;
    }
    if (m.t === 'replay') {
      e.term.reset();
      e.guard.reset();
      this.writeReplay(e, m.data);
    } else {
      e.term.write(m.data, () => this.ack(m));
      e.outputAt = performance.now();
      if (!e.agent) e.infer.output(performance.now());
      if (e.guard.watching(performance.now())) e.guard.output(performance.now(), m.data, this.inAlternate(e));
      // Published right away: output alone can flip the status to "working" (it used to surface only later).
      this.setStatus(e, () => { e.tracker.output(performance.now()); return e.tracker.takeRenotify() ? 'renotify' : undefined; }, 'output');
      // Live output only (a replay never comes through here): a failed Codex turn prints a red error line and fires no hook.
      if (e.codex) {
        const failure = e.scanner.feed(m.data);
        if (failure) e.tracker.failure(failure);
      }
    }
  }

  /** Tells the pty host that this output was parsed (or dropped), so it can keep sending (flow control). */
  private ack(m: HostToRenderer): void {
    if (m.t !== 'data') return;
    // One message per cell per tick instead of one per output chunk.
    this.acks.set(m.id, (this.acks.get(m.id) ?? 0) + m.data.length);
    this.ackTimer ??= setTimeout(() => {
      this.ackTimer = null;
      for (const [id, chars] of this.acks) this.post({ t: 'ack', id, chars });
      this.acks.clear();
    }, 8);
  }

  private writeReplay(e: Entry, data: string): void {
    e.replaying++;
    e.term.write(data, () => e.replaying--);
  }

  has(cellId: string): boolean {
    return this.entries.has(cellId);
  }

  ensure(cellId: string, opts: EnsureOptions): Entry {
    const existing = this.entries.get(cellId);
    if (existing) {
      existing.agent = opts.agent;
      existing.codex = opts.codex === true;
      existing.tracker.setCodex(existing.codex);
      const remote = opts.remote === true;
      if (existing.remote !== remote) {
        existing.remote = remote;
        existing.term.options.windowsPty = remote || window.mc.platform !== 'win32' ? {} : { backend: 'conpty', buildNumber: this.buildNumber || 26100 };
      }
      return existing;
    }
    this.disposed.delete(cellId);
    const host = document.createElement('div');
    host.className = 'term-host';
    this.staging.appendChild(host);

    const term = new Terminal({
      theme: THEME,
      linkHandler: { activate: (event, address) => { event.preventDefault(); void confirmTerminalLink(address); } },
      fontFamily: FONT,
      fontSize: opts.fontSize,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: this.scrollback,
      allowProposedApi: true,
      ...(window.mc.platform === 'win32' && opts.remote !== true ? { windowsPty: { backend: 'conpty' as const, buildNumber: this.buildNumber || 26100 } } : {}),
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(host);
    // Measured and opened: from now on it waits out of the layout until a cell shows it.
    this.parking.appendChild(host);

    const entry: Entry = {
      id: cellId, term, fit, webgl: null, shownAt: 0, outputAt: undefined, webglChangedAt: undefined, webglBlockedUntil: undefined, webglGl: null, webglGrantedAt: -Infinity, webglLosses: 0, host, tracker: new StatusTracker(), win32: false, agent: opts.agent,
      codex: opts.codex === true, scanner: new FailureScanner(), guard: new MouseFloodGuard(), infer: new AgentInference(window.mc.platform === 'win32' && opts.remote !== true), attachedTo: null, resizeObs: null, replaying: 0, lastSize: { cols: term.cols, rows: term.rows },
      parkedSelection: null, applySelection: null, remote: opts.remote === true,
    };
    entry.tracker.setCodex(entry.codex);
    entry.tracker.onBind = (thread) => this.bindListeners.forEach((l) => l(cellId, thread));
    entry.tracker.bgGuard = () => this.screenWaits(entry);
    this.entries.set(cellId, entry);
    this.statusTimer ??= setInterval(() => this.tickStatuses(), 400);
    this.deferParkedSelection(entry);

    // ConPTY asks its host terminal for win32-input-mode with CSI ? 9001 h.
    const setW32 = (on: boolean) => (params: (number | number[])[]) => {
      if (this.conpty(entry) && params.includes(9001)) entry.win32 = on;
      return false; // let xterm process the remaining modes
    };
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, setW32(true));
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, setW32(false));
    // A program that switches mouse tracking on again is alive and wants the reports: lift a flood mute.
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.some((p) => typeof p === 'number' && p >= 1000 && p <= 1003)) entry.guard.reset();
      return false;
    });
    // Codex (tui.notifications) and others signal "needs attention" with OSC 9.
    term.parser.registerOscHandler(9, (payload) => {
      // 9;4;... = progress, 9;9;... = cwd reporting (oh-my-posh etc.) - not notifications.
      if (payload.startsWith('9;')) entry.infer.reportCwd(payload.slice(2));
      if (/^(4|9);/.test(payload)) return true;
      if (entry.agent && entry.replaying === 0) this.setStatus(entry, () => entry.tracker.osc9(), 'osc9');
      return true;
    });
    term.onBell(() => {
      if (entry.agent && entry.replaying === 0) this.setStatus(entry, () => entry.tracker.osc9(), 'osc9');
    });

    term.onTitleChange((title) => { if (!entry.agent) entry.infer.title(title, performance.now()); });
    term.attachCustomKeyEventHandler((ev) => this.handleKey(entry, ev));
    term.onData((d) => {
      if (entry.replaying > 0) return;
      // A shell that prints every mouse report (the CLI died and left tracking on) must not be fed more of them.
      if (isMouseReport(d)) {
        const wasTripped = entry.guard.tripped;
        if (entry.guard.report(performance.now(), d, this.inAlternate(entry))) {
          if (!wasTripped) this.mouseFlood(entry);
          return;
        }
      }
      // Focus / mouse reports (a click on the cell) and device replies are the terminal's, not the user's: they must not
      // count as typing, and the redraw they make the agent do must not count as work.
      if (isUserInput(d)) {
        this.inferInput(entry, d);
        this.userInput(entry, d.includes('\r'), d === '\x1b' || d === '\x03');
      }
      else if (isFocusOrMouseReport(d)) entry.tracker.terminalReply(performance.now());
      this.post({ t: 'write', id: cellId, data: d });
    });
    term.onBinary((d) => entry.replaying === 0 && this.post({ t: 'write', id: cellId, data: d }));

    // A wheel gesture sends many events: the size follows each one, the fit (reflow + pty resize) runs once per frame.
    let zoomFrame = 0;
    host.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !(window.mc.platform === 'darwin' && ev.metaKey)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const size = Math.max(8, Math.min(32, (term.options.fontSize ?? 13) + (ev.deltaY < 0 ? 1 : -1)));
      term.options.fontSize = size;
      if (!zoomFrame) zoomFrame = requestAnimationFrame(() => { zoomFrame = 0; this.refit(entry); });
      opts.onFontSize?.(size);
    }, { passive: false, capture: true });

    host.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (term.hasSelection()) {
        window.mc.clipboardWrite(term.getSelection());
        term.clearSelection();
      } else {
        this.pasteFromClipboard(entry);
      }
    });

    const queued = this.pending.get(cellId);
    if (queued) {
      this.pending.delete(cellId);
      for (const q of queued) {
        if (q.replay) this.writeReplay(entry, q.data);
        else term.write(q.data);
      }
    }
    return entry;
  }

  /**
   * xterm's DOM renderer (what a parked terminal falls back to) redraws every row on each selection refresh, which
   * output triggers on every scroll, and it ignores the "not visible" pause. A parked cell therefore burned CPU
   * rebuilding invisible DOM. While parked we keep only the newest selection state and apply it on attach.
   * Relies on xterm internals, so it quietly does nothing if they change.
   */
  private deferParkedSelection(entry: Entry): void {
    const rs = (entry.term as unknown as { _core?: { _renderService?: { handleSelectionChanged?: (...a: unknown[]) => void } } })._core?._renderService;
    const original = rs?.handleSelectionChanged;
    if (!rs || typeof original !== 'function') return;
    entry.applySelection = (args) => original.apply(rs, args);
    rs.handleSelectionChanged = (...args: unknown[]) => {
      if (entry.attachedTo) original.apply(rs, args);
      else entry.parkedSelection = args;
    };
  }

  private handleKey(entry: Entry, ev: KeyboardEvent): boolean {
    const { term } = entry;
    const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.getModifierState('AltGraph');
    const command = window.mc.platform === 'darwin' && ev.metaKey && !ev.ctrlKey && !ev.altKey;

    if (ev.type === 'keydown' && (ctrl || command)) {
      // Copy: Ctrl+C with a selection, Ctrl+Shift+C always.
      if (ev.code === 'KeyC' && (term.hasSelection() || ev.shiftKey || command)) {
        if (term.hasSelection()) window.mc.clipboardWrite(term.getSelection());
        term.clearSelection();
        ev.preventDefault();
        return false;
      }
      // Paste text; without text in the clipboard (e.g. an image) forward the key so the app
      // (Claude image paste) can handle it.
      if (ev.code === 'KeyV') {
        ev.preventDefault();
        const key = { type: 'keydown', code: ev.code, key: ev.key, ctrlKey: true, altKey: false, shiftKey: ev.shiftKey };
        void window.mc.clipboardRead().then((text) => {
          if (text) entry.term.paste(text);
          else if (entry.win32) this.post({ t: 'write', id: entry.id, data: encodeWin32Key(key)! + encodeWin32Key({ ...key, type: 'keyup' })! });
          else this.post({ t: 'write', id: entry.id, data: '\x16' });
        });
        return false;
      }
    }
    if (entry.win32) {
      if (ev.type !== 'keydown' && ev.type !== 'keyup') return false;
      if (ev.isComposing || ev.keyCode === 229) return true; // IME
      const seq = encodeWin32Key(ev);
      if (!seq) return true;
      ev.preventDefault();
      if (ev.type === 'keydown' && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(ev.key)) {
        this.inferInput(entry, keySequence(ev));
        this.userInput(entry, ev.code === 'Enter' || ev.code === 'NumpadEnter', ev.key === 'Escape' || (ctrl && ev.code === 'KeyC'));
      }
      this.post({ t: 'write', id: entry.id, data: seq });
      return false;
    }
    return true;
  }

  private pasteFromClipboard(entry: Entry): void {
    void window.mc.clipboardRead().then((text) => text && entry.term.paste(text));
  }

  /** Pastes text as one bracketed-paste block; `submit` presses Enter afterwards. */
  paste(cellId: string, text: string, submit: boolean, opts: { focus?: boolean } = {}): void {
    const e = this.entries.get(cellId);
    if (!e) return;
    e.term.paste(text);
    if (submit) {
      // Separate write so TUIs see Enter after the paste block, not inside it.
      setTimeout(() => {
        this.inferInput(e, '\r');
        this.userInput(e, true);
        this.post({ t: 'write', id: cellId, data: e.win32 ? '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_' : '\r' });
      }, 60);
    }
    if (opts.focus !== false) e.term.focus();
  }

  attach(cellId: string, el: HTMLElement): void {
    const e = this.entries.get(cellId);
    if (!e || e.attachedTo === el) return;
    el.appendChild(e.host);
    e.attachedTo = el;
    e.shownAt = performance.now();
    e.host.style.display = this.windowShown ? '' : 'none';
    if (!e.webgl) this.balanceWebgl();
    if (e.parkedSelection) {
      e.applySelection?.(e.parkedSelection);
      e.parkedSelection = null;
    }
    e.resizeObs?.disconnect();
    let t: number | undefined;
    e.resizeObs = new ResizeObserver(() => {
      clearTimeout(t);
      if (this.fitHolds > 0) { this.heldFits.add(e); return; }
      t = window.setTimeout(() => { if (this.fitHolds > 0) this.heldFits.add(e); else this.refit(e); }, 25);
    });
    e.resizeObs.observe(el);
    this.refit(e);
  }

  private fitHolds = 0;
  /** Terminals whose box changed while fits were held: each is fitted once when the last hold ends. */
  private heldFits = new Set<Entry>();

  /**
   * Holds the fitting of shown terminals while a panel edge or a grid divider is dragged: a fit reflows the whole
   * scrollback and makes the agent redraw, so it happens once when the drag ends instead of at every pause of the pointer.
   * Returns the release (calling it again does nothing).
   */
  holdFits(): () => void {
    this.fitHolds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.fitHolds = Math.max(0, this.fitHolds - 1);
      if (this.fitHolds > 0) return;
      const held = [...this.heldFits];
      this.heldFits.clear();
      for (const e of held) this.refit(e);
    };
  }

  /** A shown terminal draws through the DOM renderer and is not backing off. */
  private needsWebgl(): boolean {
    if (!this.windowShown) return false;
    const now = performance.now();
    for (const e of this.entries.values()) if (e.attachedTo && !e.webgl && !(e.webglBlockedUntil !== undefined && e.webglBlockedUntil > now)) return true;
    return false;
  }

  /**
   * Hands out the WebGL contexts within `webglLimit` (webglPool.ts): shown terminals first, the focused and busy ones before
   * quiet ones; a parked terminal keeps its context only while one is free. A shown terminal never thrashes: it keeps a new
   * context for a few seconds and at most one context per plan moves between cells on screen.
   */
  private balanceWebgl(): void {
    if (!this.windowShown) return;
    const now = performance.now();
    const focused = document.activeElement;
    const plan = planWebgl([...this.entries.values()].map((o) => ({
      id: o.id, hasWebgl: o.webgl !== null, attached: o.attachedTo !== null, shownAt: o.shownAt, focused: focused !== null && focused === o.term.textarea,
      outputAt: o.outputAt, changedAt: o.webglChangedAt, blockedUntil: o.webglBlockedUntil,
    })), this.webglLimit.limit, now);
    for (const id of plan.release) {
      const victim = this.entries.get(id);
      if (!victim?.webgl) continue;
      this.releaseWebgl(victim);
      victim.webglChangedAt = now;
    }
    for (const id of plan.grant) {
      const e = this.entries.get(id);
      if (e && !e.webgl) this.createWebgl(e, now);
    }
  }

  /**
   * Gives a terminal's context back. A disposed WebglAddon leaves its context to the garbage collector, and until then
   * Chromium still counts it (and may evict a live one for it): the context is lost explicitly first.
   */
  private releaseWebgl(e: Entry): void {
    const { webgl, webglGl } = e;
    if (!webgl) return;
    e.webgl = null;
    e.webglGl = null;
    try { if (webglGl && !webglGl.isContextLost()) webglGl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
    try { webgl.dispose(); } catch { /* the canvas is gone with the context */ }
  }

  /** The GL context the addon draws with: from xterm internals, else the new canvas in the terminal that has no 2D context. */
  private glOf(webgl: WebglAddon, before: Set<HTMLCanvasElement>, host: HTMLElement): WebGL2RenderingContext | null {
    const internal = (webgl as unknown as { _renderer?: { _gl?: unknown } })._renderer?._gl;
    if (typeof WebGL2RenderingContext !== 'undefined' && internal instanceof WebGL2RenderingContext) return internal;
    for (const canvas of host.querySelectorAll('canvas')) {
      if (before.has(canvas) || canvas.getContext('2d')) continue;
      const gl = canvas.getContext('webgl2');
      if (gl) return gl;
    }
    return null;
  }

  private createWebgl(e: Entry, now: number): void {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => this.webglGone(e, webgl));
      this.lastGrantAt = now;
      const before = new Set(e.host.querySelectorAll('canvas'));
      e.term.loadAddon(webgl);
      e.webgl = webgl;
      e.webglGl = this.glOf(webgl, before, e.host);
      e.webglGrantedAt = now;
      e.webglChangedAt = now;
    } catch {
      // No WebGL on this machine (or right now): the DOM renderer draws; ask again much later.
      e.webgl = null;
      e.webglBlockedUntil = now + 60_000;
    }
  }

  /** xterm gave up waiting for a lost context to come back: the DOM renderer takes over, a new context follows after a back-off. */
  private webglGone(e: Entry, webgl: WebglAddon): void {
    webgl.dispose();
    if (e.webgl !== webgl) return;
    const now = performance.now();
    e.webgl = null;
    e.webglGl = null;
    e.webglChangedAt = now;
    e.webglLosses = nextLossCount(e.webglLosses, e.webglGrantedAt, now);
    e.webglBlockedUntil = now + webglBackoff(e.webglLosses);
  }

  /**
   * Chromium loses its oldest context at once when a new one goes over its limit. Losses right after we created a context
   * therefore mean the limit is lower than CHROMIUM_WEBGL_CONTEXTS (the switch did not apply): the pool shrinks to what
   * Chromium allows (webglPool.ts WebglLimit), so contexts are never created only to push out another one. Only the contexts
   * of terminals that hold one count; a context we gave back ourselves is not a loss.
   */
  private contextLost(target: EventTarget | null): void {
    let held = 0;
    let ours = false;
    for (const e of this.entries.values()) {
      if (!e.webgl) continue;
      held++;
      if (e.webglGl && e.webglGl.canvas === target) ours = true;
    }
    if (ours && this.webglLimit.lost(performance.now(), held, this.lastGrantAt)) console.warn(`WebGL contexts limited to ${this.webglLimit.limit} by Chromium`);
  }

  detach(cellId: string, el: HTMLElement): void {
    const e = this.entries.get(cellId);
    if (!e || e.attachedTo !== el) return;
    e.resizeObs?.disconnect();
    e.resizeObs = null;
    this.heldFits.delete(e);
    e.shownAt = performance.now();
    // The WebGL context stays with the parked terminal (xterm pauses it while hidden), so showing the grid again is instant.
    this.parking.appendChild(e.host);
    e.attachedTo = null;
  }

  private refit(e: Entry): void {
    if (!e.attachedTo || !e.attachedTo.isConnected || !this.windowShown) return; // a hidden window refits on show
    const { clientWidth, clientHeight } = e.attachedTo;
    if (clientWidth < 20 || clientHeight < 20) return;
    try {
      e.fit.fit();
    } catch {
      return;
    }
    if (e.term.cols !== e.lastSize.cols || e.term.rows !== e.lastSize.rows) {
      e.lastSize = { cols: e.term.cols, rows: e.term.rows };
      e.tracker.environment(performance.now()); // the agent redraws after a resize

      this.post({ t: 'resize', id: e.id, cols: e.term.cols, rows: e.term.rows });
    }
  }

  /**
   * Fits a terminal that is not shown yet to the box its cell will get, so a background start spawns the pty at the right
   * size (no resize and redraw when the grid is opened later). Nothing is sent to the pty; the spawn reads `size()`.
   */
  presize(cellId: string, width: number, height: number): void {
    const e = this.entries.get(cellId);
    if (!e || e.attachedTo || width < 100 || height < 60) return;
    e.host.style.width = `${Math.floor(width)}px`;
    e.host.style.height = `${Math.floor(height)}px`;
    try {
      e.fit.fit();
      e.lastSize = { cols: e.term.cols, rows: e.term.rows };
    } catch {
      // keep the default size
    } finally {
      e.host.style.width = '';
      e.host.style.height = '';
    }
  }

  /** Re-sends the current size (e.g. right after a spawn that raced with a resize). */
  syncSize(cellId: string): void {
    const e = this.entries.get(cellId);
    if (e) this.post({ t: 'resize', id: cellId, cols: e.term.cols, rows: e.term.rows });
  }

  size(cellId: string): { cols: number; rows: number } {
    const e = this.entries.get(cellId);
    return e ? { cols: e.term.cols, rows: e.term.rows } : { cols: 120, rows: 30 };
  }

  focus(cellId: string): void {
    this.entries.get(cellId)?.term.focus();
  }

  isFocused(cellId: string): boolean {
    const e = this.entries.get(cellId);
    return !!e && document.activeElement === e.term.textarea;
  }

  /** Lines of history of every terminal (Settings > Terminal): new ones start with it, live ones change now (shrinking drops the oldest lines). */
  setScrollback(lines: number): void {
    const next = normalizeScrollback(lines);
    if (next === this.scrollback) return;
    this.scrollback = next;
    for (const e of this.entries.values()) e.term.options.scrollback = next;
  }

  setFontSize(cellId: string, size: number): void {
    const e = this.entries.get(cellId);
    if (!e) return;
    e.term.options.fontSize = size;
    this.refit(e);
  }

  /** The conversation a Codex process starts with (the saved session when resuming); its committed turn ends bind the cell's session. */
  beginCodex(cellId: string, session?: { id: string; confirmed?: boolean }): void {
    this.entries.get(cellId)?.tracker.threads.begin(session);
  }

  /** Manual reset: switches off mouse / focus / paste / application modes of the terminal; text and scrollback stay. */
  resetInput(cellId: string): void {
    const e = this.entries.get(cellId);
    if (!e) return;
    e.guard.reset();
    e.term.write(terminalModeReset(this.inAlternate(e), this.conpty(e)));
  }

  /** A full-screen program (a TUI) owns the terminal: it is not a shell prompt echoing mouse reports. */
  private inAlternate(e: Entry): boolean {
    return e.term.buffer.active.type === 'alternate';
  }

  private mouseFlood(e: Entry): void {
    e.term.write(inputModesOff(this.conpty(e)));
    this.floodListeners.forEach((l) => l(e.id));
  }

  /** The terminal stopped forwarding mouse reports that a shell was echoing (the modes were reset). */
  onMouseFlood(l: (cellId: string) => void): () => void {
    this.floodListeners.add(l);
    return () => this.floodListeners.delete(l);
  }

  /** A dim line written by the app (not part of the session output, not replayed). */
  writeNotice(cellId: string, text: string): void {
    this.entries.get(cellId)?.term.write(`\r\n\x1b[90m${text}\x1b[0m\r\n`);
  }

  /** An SSH session ended: the modes its remote programs switched on are switched off, the alternate screen is left (I2). */
  resetSshModes(cellId: string): void {
    const e = this.entries.get(cellId);
    if (e) e.term.write(sshModeReset(this.inAlternate(e)));
  }

  /** Before an SSH reconnect: like prepareSpawn, but the screen and scrollback stay (spec 6.1 step 9). */
  prepareReconnect(cellId: string): void {
    const e = this.entries.get(cellId);
    this.exited.delete(cellId);
    if (!e) return;
    e.win32 = false;
    e.guard.reset();
    // I2: a TUI that ran when the old session went away must not leave its modes in the new one.
    e.term.write(sshModeReset(this.inAlternate(e)));
    e.scanner.reset();
    e.infer.exited();
    this.setStatus(e, () => e.tracker.reset(), 'restore');
  }

  /** Called right before (re)spawning the pty for a cell. */
  prepareSpawn(cellId: string, session?: { id: string; confirmed?: boolean }): void {
    const e = this.entries.get(cellId);
    this.exited.delete(cellId);
    if (!e) return;
    e.win32 = false;
    e.guard.reset();
    e.scanner.reset();
    e.infer.exited();
    e.term.reset();
    this.setStatus(e, () => e.tracker.reset(), 'restore');
    e.tracker.threads.begin(session);
  }

  dispose(cellId: string): void {
    const e = this.entries.get(cellId);
    if (!e) return;
    e.resizeObs?.disconnect();
    this.heldFits.delete(e);
    this.releaseWebgl(e);
    e.term.dispose();
    e.host.remove();
    this.entries.delete(cellId);
    this.pending.delete(cellId);
    this.disposed.add(cellId);
    if (!this.entries.size && this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
  }

  // ── statuses ──────────────────────────────────────────────────────────────

  status(cellId: string): CellStatus {
    return this.entries.get(cellId)?.tracker.status ?? 'idle';
  }

  hook(cellId: string, event: HookEvent, info?: HookInfo): void {
    const e = this.entries.get(cellId);
    if (!e) return;
    this.setStatus(e, () => e.tracker.hook(event, performance.now(), info), event, info);
  }

  /** Claude Code's screen shows it waiting for background work (agent cells only, never a shell or SSH session); see bgGuard. */
  private screenWaits(e: Entry): boolean {
    return e.agent && !e.codex && screenWaitsForBackground(e.term.buffer.active, e.term.rows);
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  /** A Codex turn end was committed and names the thread the cell's stored session should become. */
  onCodexBind(l: (cellId: string, thread: BoundThread) => void): () => void {
    this.bindListeners.add(l);
    return () => this.bindListeners.delete(l);
  }

  onExit(l: (cellId: string) => void): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }

  /** User keystrokes can change the status (answering a prompt), so listeners must hear about it. */
  private userInput(e: Entry, submitted: boolean, interrupt = false): void {
    this.setStatus(e, () => {
      const now = performance.now();
      e.tracker.input(now, submitted);
      if (interrupt) e.tracker.interrupt(now);
    }, 'input');
  }

  private setStatus(e: Entry, change: () => unknown, trigger: StatusTrigger, info?: HookInfo): void {
    const prev = e.tracker.status;
    const result = change();
    const { status, lastCause, lastReason, lastError } = e.tracker;
    const hookEvent = trigger === 'stop' || trigger === 'stopbg' || trigger === 'notify' || trigger === 'busy' || trigger === 'fail' || trigger === 'prompt' || trigger === 'session';
    // Transitions are always logged; hook events that changed nothing only when they matter (busy spam would evict the history).
    const changed = status !== prev;
    if (changed || result === 'renotify' || (hookEvent && (trigger !== 'busy' || result === 'ignored'))) {
      const detail = [hookDetail(info ?? (status === 'waiting' && lastReason === 'error' && lastError ? { error: lastError } : undefined)), trigger === 'tick-stall' && e.tracker.lastStallKind ? `stall=${e.tracker.lastStallKind}` : ''].filter(Boolean).join(' ');
      statusLog.push({
        at: Date.now(), cellId: e.id, from: prev, to: status, cause: lastCause, trigger, reason: status === 'waiting' ? lastReason : undefined,
        note: result === 'ignored' ? 'ignored' : changed ? undefined : 'no-change', detail: detail || undefined,
      });
    }
    // A renotify (the real Stop after a continued turn) is reported as working -> waiting so the alert rules see a transition.
    if (changed || result === 'renotify') {
      // Failures learned from the output carry their code like a StopFailure hook does; every alert carries its turn key.
      const failure = status === 'waiting' && lastReason === 'error' && lastError ? { error: lastError } : undefined;
      const detailInfo: HookInfo = { ...failure, ...info, turn: e.tracker.turnKey };
      this.statusListeners.forEach((l) => l(e.id, status, changed ? prev : 'working', lastCause, lastReason, e.tracker.isHooked, detailInfo));
    }
  }

  // ── agent inference (shell cells) ─────────────────────────────────────────

  /** Feeds what the user typed into a shell cell to the inference; agent cells need none. */
  private inferInput(e: Entry, data: string): void {
    if (!e.agent && data) e.infer.input(data, performance.now(), () => this.screenLine(e));
  }

  /** The logical line of the cursor in the normal buffer (wrapped rows joined), null in a full-screen program. */
  private screenLine(e: Entry): ScreenLine | null {
    const buffer = e.term.buffer.active;
    if (buffer.type === 'alternate') return null;
    const cursorRow = buffer.baseY + buffer.cursorY;
    let row = cursorRow;
    let line = buffer.getLine(row);
    if (!line) return null;
    let text = line.translateToString(true);
    let beforeCursor = line.translateToString(true, 0, buffer.cursorX);
    for (let up = 0; line?.isWrapped && row > 0 && up < 20; up++) {
      row--;
      line = buffer.getLine(row);
      if (!line) break;
      const part = line.translateToString(false);
      text = part + text;
      beforeCursor = part + beforeCursor;
    }
    return { text, row, beforeCursor, above: row > 0 ? buffer.getLine(row - 1)?.translateToString(true) ?? null : null };
  }

  private screenState(e: Entry): ScreenState {
    return { line: this.screenLine(e), alternate: this.inAlternate(e), mouse: e.term.modes.mouseTrackingMode !== 'none' };
  }

  /** The agent the user started by hand in a shell cell (and the folder it started in, when known); null when none is believed to run. */
  inferredAgent(cellId: string): { agent: InferredAgent; cwd: string | null } | null {
    const e = this.entries.get(cellId);
    if (!e || e.agent) return null;
    e.infer.observe(performance.now(), this.screenState(e));
    return e.infer.agent ? { agent: e.infer.agent, cwd: e.infer.cwd } : null;
  }

  private tickStatuses(): void {
    const now = performance.now();
    for (const e of this.entries.values()) {
      if (e.infer.agent && !e.agent) e.infer.observe(now, this.screenState(e));
      // A committed Codex turn end on a cell that already waited changes no status but must alert: report it as a renotify.
      this.setStatus(e, () => { e.tracker.tick(now); return e.tracker.takeRenotify() ? 'renotify' : undefined; }, 'tick-stall');
    }
  }
}

export const terminals = new TerminalManager();
