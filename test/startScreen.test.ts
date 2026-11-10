// 1.1.5: the start card of an agent cell (shared/startScreen.ts) and the clear that starts the launch line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLaunchCommand, DEFAULT_PROFILES } from '../src/shared/profiles';
import {
  AGENT_START_OSC, AGENT_START_PAYLOAD, showsLaunchLine, START_FAIL_WINDOW_MS, START_SETTLE_MS, START_TAIL_LINES, START_TIMEOUT_MS, startClear, startOutput, StartWatch,
} from '../src/shared/startScreen';

const P = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.cli, p]));
const lines = (...l: string[]) => () => l;

describe('startClear (the clear in front of the launch line)', () => {
  it('clears the screen and the scrollback in the shell, before the CLI, for every shell', () => {
    expect(startClear('pwsh')).toBe('Clear-Host; ');
    expect(startClear('powershell')).toBe('Clear-Host; ');
    expect(startClear('cmd')).toBe('cls & ');
    for (const shell of ['zsh', 'bash'] as const) expect(startClear(shell)).toBe("printf '\\033[H\\033[2J\\033[3J'; ");
    expect(startClear()).toBe('Clear-Host; ');
  });
  it('opens every agent launch line, the reset tail still closes it', () => {
    for (const shell of ['pwsh', 'powershell', 'cmd', 'zsh', 'bash'] as const) {
      for (const profile of [P.claude, P.codex]) {
        const line = buildLaunchCommand(profile, { mode: 'new', shell })!;
        expect(line.startsWith(startClear(shell))).toBe(true);
        expect(line).toContain('1000;1002;1003;1005;1006;1015;');
        expect(line).not.toContain('\x1b');
        expect(line).not.toMatch(/[\r\n]/);
      }
    }
    expect(buildLaunchCommand(P.shell, { mode: 'new', shell: 'pwsh' })).toBeNull();
  });
  it('recognizes the launch line on screen in every shell, never a plain prompt', () => {
    for (const shell of ['pwsh', 'cmd', 'bash'] as const) expect(showsLaunchLine([`> ${buildLaunchCommand(P.claude, { mode: 'new', shell })}`])).toBe(true);
    expect(showsLaunchLine(['PS C:\\p>', 'C:\\p>', 'user@mac p %'])).toBe(false);
  });
});

describe('startOutput (what the error card shows)', () => {
  it('keeps the last non-empty lines as the error and a bounded tail without blank runs', () => {
    const out = startOutput(['', 'banner', '', '', 'Error: Invalid MCP configuration:', '  MCP config file not found: C:\\x.json   ', '', '']);
    expect(out.errorLines).toEqual(['banner', 'Error: Invalid MCP configuration:', '  MCP config file not found: C:\\x.json']);
    expect(out.tail).toEqual(['banner', '', 'Error: Invalid MCP configuration:', '  MCP config file not found: C:\\x.json']);
    const many = startOutput(Array.from({ length: 100 }, (_, i) => `line ${i}`));
    expect(many.tail).toHaveLength(START_TAIL_LINES);
    expect(many.tail.at(-1)).toBe('line 99');
    expect(many.errorLines).toEqual(['line 96', 'line 97', 'line 98', 'line 99']);
    expect(startOutput(['a\x07b\x1b'])).toEqual({ errorLines: ['ab'], tail: ['ab'] });
  });
});

describe('StartWatch', () => {
  /** A watch past the launch clear at t=100. */
  const launched = (resume = false) => {
    const w = new StartWatch();
    expect(w.begin(0, resume)).toBe(true);
    expect(w.screen).toEqual({ phase: 'starting', resume });
    w.cleared(100, true);
    return w;
  };

  it('shows the card from the spawn until the CLI drew and stayed up for the settle time', () => {
    const w = new StartWatch();
    expect(w.screen).toBeNull();
    w.begin(0, false);
    expect(w.awaitingClear).toBe(true);
    // A clear of the shell's own (a profile's Clear-Host) without the launch line on screen is not the launch.
    w.cleared(50, false);
    expect(w.awaitingClear).toBe(true);
    w.cleared(100, true);
    expect(w.awaitingOutput).toBe(true);
    // The blank screen after the clear is not the CLI yet.
    w.output(150, false);
    expect(w.awaitingOutput).toBe(true);
    w.output(1500, true);
    expect(w.screen?.phase).toBe('starting');
    expect(w.nextAt()).toBe(1500 + START_SETTLE_MS);
    expect(w.tick(1500 + START_SETTLE_MS - 1)).toBe(false);
    expect(w.tick(1500 + START_SETTLE_MS)).toBe(true);
    expect(w.screen).toBeNull();
  });

  it('goes at once on a hook of the CLI (SessionStart, a Codex notify)', () => {
    const w = launched();
    expect(w.hook(400)).toBe(true);
    expect(w.screen).toBeNull();
    expect(w.hook(500)).toBe(false);
  });

  it('turns into an error card when the CLI ends before it was up, with its code and its lines', () => {
    const w = launched();
    w.output(300, true);
    w.shellMark('D', 1, 400, lines());
    expect(w.shellMark('A', undefined, 400, lines('Error: Invalid MCP configuration:', 'MCP config file not found: C:\\m.json'))).toBe(true);
    expect(w.screen).toEqual({ phase: 'failed', code: 1, errorLines: ['Error: Invalid MCP configuration:', 'MCP config file not found: C:\\m.json'], tail: ['Error: Invalid MCP configuration:', 'MCP config file not found: C:\\m.json'] });
    // The error card stays (no timer takes it away) until the user acts.
    expect(w.nextAt()).toBeUndefined();
    expect(w.tick(START_TIMEOUT_MS * 2)).toBe(false);
    expect(w.screen?.phase).toBe('failed');
    expect(w.stop()).toBe(true);
    expect(w.screen).toBeNull();
  });

  it('fails without a code where the shell reports none (cmd), and also before any output', () => {
    const w = launched();
    w.shellMark('D', undefined, 200, lines());
    expect(w.shellMark('A', undefined, 200, lines('boom'))).toBe(true);
    expect(w.screen).toEqual({ phase: 'failed', errorLines: ['boom'], tail: ['boom'] });
  });

  it('brings the error card back for a non-zero end soon after the start, not for a clean or a late end', () => {
    const early = launched();
    early.hook(300);
    early.shellMark('D', 2, 2000, lines());
    expect(early.shellMark('A', undefined, 2000, lines('crash'))).toBe(true);
    expect(early.screen).toMatchObject({ phase: 'failed', code: 2 });

    const clean = launched();
    clean.hook(300);
    clean.shellMark('D', 0, 2000, lines());
    expect(clean.shellMark('A', undefined, 2000, lines('bye'))).toBe(false);
    expect(clean.screen).toBeNull();

    const late = launched();
    late.hook(300);
    expect(late.nextAt()).toBe(100 + START_FAIL_WINDOW_MS);
    late.tick(100 + START_FAIL_WINDOW_MS);
    late.shellMark('D', 1, 100 + START_FAIL_WINDOW_MS + 10, lines());
    expect(late.shellMark('A', undefined, 100 + START_FAIL_WINDOW_MS + 10, lines('x'))).toBe(false);
    expect(late.screen).toBeNull();
  });

  it('ignores prompt marks before the launch clear (the prompt the launch line is typed at)', () => {
    const w = new StartWatch();
    w.begin(0, false);
    w.shellMark('D', 1, 10, lines());
    expect(w.shellMark('A', undefined, 10, lines('PS C:\\p>'))).toBe(false);
    expect(w.screen?.phase).toBe('starting');
  });

  it('gives up after the safety timeout, whatever the terminal did', () => {
    for (const step of [(w: StartWatch) => w, (w: StartWatch) => { w.cleared(100, true); return w; }, (w: StartWatch) => { w.cleared(100, true); w.output(19_900, true); return w; }]) {
      const w = step((() => { const x = new StartWatch(); x.begin(0, true); return x; })());
      expect(w.nextAt()).toBeLessThanOrEqual(START_TIMEOUT_MS);
      expect(w.tick(START_TIMEOUT_MS)).toBe(true);
      expect(w.screen).toBeNull();
    }
  });

  it('starts over on every spawn (a restart) and keeps the screen object while nothing changes', () => {
    const w = launched(true);
    const shown = w.screen;
    w.output(200, true);
    expect(w.screen).toBe(shown);
    w.shellMark('A', undefined, 300, lines('err'));
    expect(w.screen?.phase).toBe('failed');
    expect(w.begin(1000, false)).toBe(true);
    expect(w.screen).toEqual({ phase: 'starting', resume: false });
    expect(w.awaitingClear).toBe(true);
    expect(w.stop()).toBe(true);
    expect(w.stop()).toBe(false);
  });
});

describe('an agent started without a shell (1.2.0, Windows)', () => {
  it('is announced by the mark the pty writes before the CLI, which this side knows by the same number and payload', () => {
    const rust = readFileSync(join(__dirname, '..', 'src-tauri', 'crates', 'unimux-pty', 'src', 'shell_integration.rs'), 'utf8');
    expect(rust).toContain(`b"\\x1b]${AGENT_START_OSC};${AGENT_START_PAYLOAD}\\x07"`);
  });

  it('goes from the mark (no launch line, no clear) to the CLI drawing, then up; a prompt back still ends it', () => {
    const w = new StartWatch();
    w.begin(0, false);
    // What the mark handler does: the screen is empty, the CLI comes next.
    w.cleared(5, true);
    expect(w.awaitingOutput).toBe(true);
    w.output(100, true);
    expect(w.tick(100 + START_SETTLE_MS)).toBe(true);
    expect(w.screen).toBeNull();
    const failed = new StartWatch();
    failed.begin(0, false);
    failed.cleared(5, true);
    failed.output(50, true);
    failed.shellMark('D', 1, 300, lines());
    failed.shellMark('A', undefined, 300, lines('Error: x'));
    expect(failed.screen).toMatchObject({ phase: 'failed', code: 1, errorLines: ['Error: x'] });
  });
});
