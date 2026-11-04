import { describe, expect, it } from 'vitest';
import {
  echoCandidates, INPUT_MODE_PARAMS, INPUT_MODES_OFF, inputModesOff, isMouseReport, MOUSE_ECHO_PROOF, MOUSE_FLOOD_PER_SECOND, MouseFloodGuard,
  reportPosition, terminalModeReset, withResetTail,
} from '../src/shared/termReset';

const report = (x: number, y: number, cb = 35) => `\x1b[<${cb};${x};${y}M`;

describe('mode reset sequences', () => {
  it('switches off mouse, focus, paste and kitty keyboard modes and nothing else', () => {
    expect(INPUT_MODE_PARAMS).toEqual([1000, 1002, 1003, 1005, 1006, 1015, 1004, 2004]);
    expect(INPUT_MODES_OFF).toBe('\x1b[?1000;1002;1003;1005;1006;1015;1004;2004l\x1b[<u');
  });
  it('never clears ?1004 on Windows, where ConPTY owns focus reports, nor ?9001 anywhere', () => {
    expect(inputModesOff(true)).toBe('\x1b[?1000;1002;1003;1005;1006;1015;2004l\x1b[<u');
    expect(inputModesOff(false)).toContain('1004');
    expect(terminalModeReset(false, true)).not.toContain('1004');
    expect(terminalModeReset(true, true)).not.toContain('1004');
    expect(terminalModeReset(false, false)).toContain('1004');
    for (const win of [true, false]) expect(terminalModeReset(true, win)).not.toContain('9001');
  });
  it('the manual reset keeps the buffer and leaves the alternate screen only when needed', () => {
    expect(terminalModeReset(false)).not.toContain('1049');
    expect(terminalModeReset(true)).toContain('\x1b[?1049l');
    for (const reset of [terminalModeReset(false), terminalModeReset(true)]) {
      expect(reset).toContain(INPUT_MODES_OFF);
      expect(reset).not.toMatch(/\x1b\[[23]J|\x1bc/); // no erase of scrollback, no RIS
    }
  });
  it('wraps the CLI per shell and writes the escape character through the shell, not literally', () => {
    const cli = "claude --settings 'C:\\a b\\x.json'";
    const ps = `try { ${cli} } finally { $global:__unimuxExit = $LASTEXITCODE; [Console]::Write([char]27+'[?1000;1002;1003;1005;1006;1015;2004l'+[char]27+'[<u') }`;
    expect(withResetTail(cli, 'pwsh')).toBe(ps);
    expect(withResetTail(cli, 'powershell')).toBe(ps);
    expect(withResetTail(cli)).toBe(ps);
    expect(withResetTail(cli, 'cmd')).toBe(`${cli} & powershell -NoProfile -NonInteractive -Command "[Console]::Write([char]27+'[?1000;1002;1003;1005;1006;1015;2004l'+[char]27+'[<u')" 2>nul`);
    expect(withResetTail(cli, 'zsh')).toBe(withResetTail(cli, 'bash'));
    expect(withResetTail(cli, 'bash')).toBe(`trap : INT; ${cli}; printf '\\033[?1000;1002;1003;1005;1006;1015;1004;2004l\\033[<u'; trap - INT`);
    for (const shell of ['pwsh', 'powershell', 'cmd', 'zsh', 'bash'] as const) expect(withResetTail(cli, shell)).not.toMatch(/[\x00-\x1f]/);
  });
});

describe('mouse report parsing', () => {
  it('recognises SGR and X10 reports only', () => {
    for (const r of ['\x1b[<35;12;6M', '\x1b[<0;12;6m', '\x1b[M !!']) expect(isMouseReport(r)).toBe(true);
    for (const r of ['\x1b[I', '\x1b[A', 'a', '\x1b[<35;12;6Mx', '\x1b']) expect(isMouseReport(r)).toBe(false);
  });
  it('reads the position of SGR reports', () => {
    expect(reportPosition('\x1b[<35;12;6M')).toBe('12;6');
    expect(reportPosition('\x1b[M !!')).toBeNull();
    expect(reportPosition('\x1b[I')).toBeNull();
  });
  it('finds printed echoes (also coloured or mangled by PSReadLine) but not real escape sequences', () => {
    expect(echoCandidates('^[[<35;12;6M^[[<35;13;6M')).toEqual(['12;6', '13;6']);
    expect(echoCandidates('\x1b[5;32H\x1b[93m[555\x1b[37m;\x1b[97m12\x1b[37m;\x1b[93m6M\x1b[39;49m')).toEqual(['12;6']);
    expect(echoCandidates('\x1b[<35;12;6M plain text [1;2] ls -l')).toEqual([]);
  });
});

describe('MouseFloodGuard', () => {
  /** Sends `n` reports 10 ms apart moving across the row, each echoed by a shell as `^[[<35;x;yM`. */
  const flood = (g: MouseFloodGuard, from: number, n: number, opts: { echo?: boolean; alt?: boolean; text?: (x: number, y: number) => string } = {}) => {
    const dropped: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const t = from + i * 10;
      const x = 10 + i, y = 5 + Math.floor(i / 20);
      dropped.push(g.report(t, report(x, y), opts.alt));
      g.output(t + 2, opts.text ? opts.text(x, y) : opts.echo ? `^[[<35;${x};${y}M` : '', opts.alt);
    }
    return dropped;
  };

  it('trips on a real echo flood: positions that were just sent come back as text at several positions', () => {
    const g = new MouseFloodGuard();
    const dropped = flood(g, 1000, 60, { echo: true });
    expect(g.tripped).toBe(true);
    expect(dropped.slice(0, MOUSE_FLOOD_PER_SECOND)).not.toContain(true);
    expect(dropped.some(Boolean)).toBe(true);
    expect(g.report(9999, report(1, 1))).toBe(true); // stays muted until reset
    g.reset();
    expect(g.report(10_000, report(1, 1))).toBe(false);
  });
  it('trips on PSReadLine-mangled echoes (`[555;12;6M` with colour codes between the characters)', () => {
    const g = new MouseFloodGuard();
    flood(g, 0, 60, { text: (x, y) => `\x1b[93m[555\x1b[37m;\x1b[97m${x}\x1b[37m;\x1b[93m${y}M\x1b[39;49m` });
    expect(g.tripped).toBe(true);
  });
  it('never trips on a busy TUI (rate alone is no proof), however fast the reports come', () => {
    const g = new MouseFloodGuard();
    expect(flood(g, 0, 500).some(Boolean)).toBe(false);
    expect(g.tripped).toBe(false);
  });
  it('does not trip on colour codes split after ESC or on literal report text in the output of a TUI', () => {
    for (const text of [
      (_x: number, _y: number) => '[38;5;123m',
      (_x: number, _y: number) => '[<35;77;38M [<35;77;38m',        // a file/test showing a report: the position was never sent
      (_x: number, _y: number) => 'echo "[<0;1;1M" [1;2;3m [48;2;1;2;3m',
    ]) {
      const g = new MouseFloodGuard();
      flood(g, 0, 300, { text });
      expect(g.tripped).toBe(false);
    }
  });
  it('needs several distinct positions: one repeated literal that happens to match is no proof', () => {
    const g = new MouseFloodGuard();
    for (let i = 0; i < 100; i++) {
      g.report(i * 10, report(10 + i, 5));
      g.output(i * 10 + 2, '[<35;10;5M');
    }
    expect(g.tripped).toBe(false);
  });
  it('never trips while the terminal shows the alternate screen', () => {
    const g = new MouseFloodGuard();
    flood(g, 0, 200, { echo: true, alt: true });
    expect(g.tripped).toBe(false);
  });
  it('slow reports never trip, and old reports and echoes expire', () => {
    const g = new MouseFloodGuard();
    for (let i = 0; i < 100; i++) {
      g.report(i * 100, report(10 + i, 5));
      g.output(i * 100 + 2, `^[[<35;${10 + i};5M`);
    }
    expect(g.tripped).toBe(false); // 10 per second
    const h = new MouseFloodGuard();
    flood(h, 0, MOUSE_FLOOD_PER_SECOND, { echo: true });
    expect(MOUSE_ECHO_PROOF).toBeGreaterThan(1);
    expect(flood(h, 20_000, 5, { echo: true }).some(Boolean)).toBe(false);
  });
  it('only scans output while reports are being sent', () => {
    const g = new MouseFloodGuard();
    expect(g.watching(0)).toBe(false);
    g.report(0, report(1, 1));
    expect(g.watching(500)).toBe(true);
    expect(g.watching(10_000)).toBe(false);
  });
});
