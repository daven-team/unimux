// The SSH autocomplete's command line follower against a real xterm buffer (xterm runs headless here: the terminal is
// never opened, so a few browser globals are enough) and a small fake remote shell that echoes what it is sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Terminal as XTerminal } from '@xterm/xterm';
import { CommandLineFollower, SETTLE_MS, type AutocompleteView } from '../src/shared/commandFollower';
import type { KeyLike, SuggestSource } from '../src/shared/commandSuggest';

const g = globalThis as Record<string, unknown>;
const added: string[] = [];
let Terminal: typeof XTerminal;

beforeAll(async () => {
  const shim = (name: string, value: unknown) => { if (!(name in g)) { g[name] = value; added.push(name); } };
  shim('window', globalThis);
  shim('self', globalThis);
  shim('document', { createElement: () => ({ style: {}, getContext: () => null, classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, appendChild() {} }), addEventListener() {}, removeEventListener() {} });
  shim('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  shim('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  shim('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  ({ Terminal } = await import('@xterm/xterm'));
});
afterAll(() => { for (const name of added) delete g[name]; });

const PROMPT = 'u@web:~$ ';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A program that has the keyboard (a pager, a full-screen program): what each key prints, `done` = it quit. */
type Program = (key: string) => { out: string; done: boolean };
/** What a command prints; `prompt: false` = it waits for input (a question, a program) instead of the next prompt. */
type Run = (cmd: string) => { out: string; prompt: boolean; program?: Program };

/**
 * A remote shell with a line editor: echoes typing (unless echo is off), backspace, ↑ (last command), → (takes its own
 * faint suggestion, like zsh-autosuggestions), Tab and Enter. While a program runs, it gets the keys.
 */
class FakeShell {
  line = '';
  echo = true;
  history: string[] = [];
  /** The shell's own inline suggestion (drawn by the test), taken with →. */
  suggestion = '';
  program: Program | null = null;
  private queue = '';
  constructor(private readonly term: XTerminal, public prompt = PROMPT, private readonly run: Run = () => ({ out: '', prompt: true })) {}

  feed(data: string): void {
    for (let i = 0; i < data.length; i++) {
      if (this.program) {
        const result = this.program(data[i]);
        this.queue += result.out;
        if (result.done) {
          this.program = null;
          this.queue += this.prompt;
        }
      } else if (data.startsWith('\x1b[A', i)) {
        const recalled = this.history.at(-1) ?? '';
        this.queue += '\b \b'.repeat(this.line.length) + recalled;
        this.line = recalled;
        i += 2;
      } else if (data.startsWith('\x1b[C', i)) {
        this.line += this.suggestion;
        this.queue += this.suggestion;
        this.suggestion = '';
        i += 2;
      } else if (data[i] === '\x7f') {
        if (!this.line) continue;
        this.line = this.line.slice(0, -1);
        if (this.echo) this.queue += '\b \b';
      } else if (data[i] === '\r') {
        const cmd = this.line;
        this.line = '';
        this.echo = true;
        if (cmd.trim()) this.history.push(cmd);
        const result = this.run(cmd);
        this.queue += `\r\n${result.out}${result.prompt ? this.prompt : ''}`;
        this.program = result.program ?? null;
      } else if (data[i] === '\t') {
        // Several candidates: bash lists them and draws the prompt and the line again.
        this.queue += `\r\ncheckout  cherry-pick\r\n${this.prompt}${this.line}`;
      } else if (data[i] >= ' ') {
        this.line += data[i];
        if (this.echo) this.queue += data[i];
      }
    }
  }

  /** The remote end answers: the queued output arrives and is parsed. */
  async flush(): Promise<void> {
    const out = this.queue;
    this.queue = '';
    if (out) await new Promise<void>((resolve) => this.term.write(out, resolve));
    await tick();
  }
}

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
const KEY_DATA: Record<string, string> = { Enter: '\r', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', Escape: '\x1b', Tab: '\t', Backspace: '\x7f' };

async function setup(o: { history?: string[]; snippets?: SuggestSource[]; run?: Run; prompt?: string } = {}) {
  const term = new Terminal({ cols: 60, rows: 10, allowProposedApi: true });
  let clock = 10_000;
  const remembered: string[] = [];
  const sent: string[] = [];
  const sources: SuggestSource[] = [...(o.history ?? []).map((text, i) => ({ text, kind: 'history' as const, weight: 10 - i })), ...(o.snippets ?? [])];
  let view: AutocompleteView | null = null;
  const follower = new CommandLineFollower(term, {
    hostId: () => 'host', enabled: () => true, shown: () => true, sources: () => sources,
    lastCommand: () => remembered.at(-1), remember: (_host, command) => { remembered.push(command); },
    publish: (v) => { view = v; }, now: () => clock,
  });
  const shell = new FakeShell(term, o.prompt ?? PROMPT, o.run);
  term.onData((d) => { sent.push(d); follower.input(d); shell.feed(d); });
  term.onWriteParsed(() => follower.parsed());
  term.buffer.onBufferChange(() => follower.screenChanged());
  term.parser.registerOscHandler(133, (payload) => { follower.promptMark(payload); return false; });
  await new Promise<void>((resolve) => term.write(`Welcome\r\n${o.prompt ?? PROMPT}`, resolve));
  await tick();
  clock += 1000;
  /** A key as xterm handles it: the follower may take it, otherwise xterm sends its data. */
  const press = async (k: string, mods: Partial<KeyLike> = {}) => {
    clock += 150;
    if (!follower.key(key(k, mods))) term.input(KEY_DATA[k] ?? k, true);
    await shell.flush();
  };
  const type = async (text: string) => { for (const ch of text) await press(ch); };
  /** Output of the remote end that is not an answer to a key (the shell's own suggestion, a program printing). */
  const write = async (data: string) => { await new Promise<void>((resolve) => term.write(data, resolve)); await tick(); };
  return { term, follower, shell, remembered, sent, press, type, write, view: () => view, advance: (ms: number) => { clock += ms; } };
}

describe('the command line follower (real xterm buffer)', () => {
  it('suggests while typing, walks the list, inserts with Enter and records the line run with the next Enter', async () => {
    const t = await setup({ history: ['git status', 'git stash list', 'ls -la'] });
    await t.type('git st');
    expect(t.view()?.items.map((i) => i.text)).toEqual(['git status', 'git stash list']);
    expect(t.view()).toMatchObject({ selected: -1, ghost: 'atus', startCol: PROMPT.length, row: 1 });
    await t.press('ArrowDown');
    await t.press('ArrowDown');
    expect(t.view()).toMatchObject({ selected: 1, ghost: 'ash list' });
    await t.press('ArrowUp');
    expect(t.view()?.selected).toBe(0);
    await t.press('ArrowDown');
    await t.press('Enter');
    // Inserted, not run: the shell got the missing part only, no Enter.
    expect(t.sent.at(-1)).toBe('ash list');
    expect(t.shell.line).toBe('git stash list');
    expect(t.view()).toBeNull();
    expect(t.remembered).toEqual([]);
    await t.press('Enter');
    expect(t.sent.at(-1)).toBe('\r');
    expect(t.remembered).toEqual(['git stash list']);
  });

  it('completes the ghost text with → and replaces a fuzzy match with backspaces', async () => {
    const t = await setup({ history: ['docker compose up -d', 'git status'] });
    await t.type('docker c');
    await t.press('ArrowRight');
    expect(t.shell.line).toBe('docker compose up -d');
    await t.press('Enter');
    expect(t.remembered).toEqual(['docker compose up -d']);
    await t.type('gst');
    expect(t.view()?.items[0]).toMatchObject({ text: 'git status', prefix: false });
    expect(t.view()?.ghost).toBe('');
    await t.press('ArrowDown');
    await t.press('Enter');
    expect(t.sent.at(-1)).toBe('\x7f\x7fit status');
    expect(t.shell.line).toBe('git status');
  });

  it('keeps Tab, ↑ and Enter with the shell while the list was not entered; Esc closes until the next character', async () => {
    const t = await setup({ history: ['ls -la', 'uptime'] });
    await t.type('ls');
    expect(t.view()).not.toBeNull();
    await t.press('Escape');
    expect(t.view()).toBeNull();
    expect(t.sent.at(-1)).toBe('s');
    await t.type(' ');
    expect(t.view()?.items[0].text).toBe('ls -la');
    await t.press('ArrowUp');
    expect(t.sent.at(-1)).toBe('\x1b[A');
    expect(t.view()).toBeNull();
    await t.press('Enter');
    expect(t.sent.at(-1)).toBe('\r');
  });

  it('never records or suggests what is typed with echo off (a sudo password)', async () => {
    const questions: Record<string, string> = { 'sudo apt update': '[sudo] password for u: ', 'vault login': 'vault# ' };
    const t = await setup({ history: ['sudo apt update', 'hunter2-not-a-command'], run: (cmd) => ({ out: questions[cmd] ?? '', prompt: !questions[cmd] }) });
    await t.type('sudo apt update');
    await t.press('Enter');
    expect(t.remembered).toEqual(['sudo apt update']);
    t.shell.echo = false;
    t.advance(1000);
    await t.type('hunter2');
    expect(t.view()).toBeNull();
    await t.press('Enter');
    expect(t.remembered).toEqual(['sudo apt update']);
    // Even at a prompt that looks like a shell's, input that is not echoed never shows up, so it is never recorded.
    await t.type('vault login');
    await t.press('Enter');
    t.shell.echo = false;
    t.advance(1000);
    await t.type('hunter2');
    expect(t.view()).toBeNull();
    await t.press('Enter');
    expect(t.remembered).toEqual(['sudo apt update', 'vault login']);
  });

  it('does not record a line that starts with a space, nor answers to a program\'s question', async () => {
    const t = await setup({ history: ['yarn build'], run: (cmd) => (cmd === 'apt upgrade' ? { out: 'Do you want to continue? [Y/n] ', prompt: false } : { out: '', prompt: true }) });
    await t.type(' export TOKEN=abc');
    await t.press('Enter');
    expect(t.remembered).toEqual([]);
    await t.type('apt upgrade');
    await t.press('Enter');
    t.advance(1000);
    await t.type('yes');
    expect(t.view()).toBeNull();
    await t.press('Enter');
    expect(t.remembered).toEqual(['apt upgrade']);
  });

  it('does not follow a line started while a program was still printing', async () => {
    const t = await setup({ history: ['ls -la'] });
    await new Promise<void>((resolve) => t.term.write('building...\r\n', resolve));
    await tick();
    t.advance(SETTLE_MS - 30);
    t.follower.input('l');
    t.shell.feed('l');
    await t.shell.flush();
    await t.type('s');
    expect(t.view()).toBeNull();
    await t.press('Enter');
    expect(t.remembered).toEqual([]);
  });

  it('waits for late echoes after Enter and records the whole line', async () => {
    const t = await setup({ history: [] });
    await t.type('l');
    // Fast typing on a slow link: the rest is sent, Enter too, before any echo is back.
    for (const ch of 's -la') { t.term.input(ch, true); }
    t.term.input('\r', true);
    expect(t.remembered).toEqual([]);
    await t.shell.flush();
    expect(t.remembered).toEqual(['ls -la']);
  });

  it('follows the line when the shell draws the prompt again (a completion listing)', async () => {
    const t = await setup({ history: ['git checkout main', 'git cherry-pick abc'] });
    await t.type('git ch');
    await t.press('Tab');
    expect(t.view()).toBeNull();
    await t.type('e');
    expect(t.view()?.items.map((i) => i.text)).toEqual(['git checkout main', 'git cherry-pick abc']);
    expect(t.view()?.row).toBe(3);
    await t.press('ArrowRight');
    await t.press('Enter');
    expect(t.remembered).toEqual(['git checkout main']);
  });

  it('shows nothing in a full-screen program', async () => {
    const t = await setup({ history: ['ls -la'] });
    await new Promise<void>((resolve) => t.term.write('\x1b[?1049h', resolve));
    await tick();
    t.advance(1000);
    await t.type('ls');
    expect(t.view()).toBeNull();
  });

  it('takes the shell\'s own prompt mark (OSC 133) as the start of the line', async () => {
    const t = await setup({ history: ['make test'], prompt: 'λ: ' });
    await t.type('ma');
    expect(t.view()).toBeNull(); // "λ: " looks like a question without the mark
    t.shell.prompt = '\x1b]133;A\x07λ: \x1b]133;B\x07';
    await t.press('Enter');
    t.advance(1000);
    await t.type('ma');
    expect(t.view()?.items[0].text).toBe('make test');
  });

  it('leaves → to the shell while its own faint suggestion takes the cells after the cursor (zsh-autosuggestions)', async () => {
    const t = await setup({ history: ['git stash list', 'git status'] });
    await t.type('git st');
    expect(t.view()?.ghost).toBe('ash list');
    // The shell draws its suggestion in bright black and puts the cursor back.
    t.shell.suggestion = 'atus';
    await t.write('\x1b[90matus\x1b[0m\x1b[4D');
    expect(t.view()).toMatchObject({ ghost: '', room: 0 });
    expect(t.view()?.items.map((i) => i.text)).toEqual(['git stash list', 'git status']);
    await t.press('ArrowRight');
    expect(t.sent.at(-1)).toBe('\x1b[C');
    expect(t.shell.line).toBe('git status');
    await t.press('Enter');
    // Once the list is entered with ↓, → takes the chosen item even without room for its ghost.
    await t.type('git st');
    await t.write('\x1b[90matus\x1b[0m\x1b[4D');
    await t.press('ArrowDown');
    expect(t.view()).toMatchObject({ selected: 0, ghost: '' });
    await t.press('ArrowRight');
    expect(t.shell.line).toBe('git stash list');
  });

  it('inserts a suggestion accepted before the echo of the last key once that echo arrived, and not after more typing', async () => {
    const t = await setup({ history: ['git status'] });
    await t.type('git st');
    // A slow link: "a" is sent, its echo is not back yet when → is pressed.
    t.term.input('a', true);
    expect(t.follower.key(key('ArrowRight'))).toBe(true);
    expect(t.sent.at(-1)).toBe('a');
    await t.shell.flush();
    expect(t.sent.at(-1)).toBe('tus');
    await t.shell.flush();
    expect(t.shell.line).toBe('git status');
    await t.press('Enter');
    expect(t.remembered).toEqual(['git status']);
    // Typing on after the click: the insertion is dropped, the shell keeps what was typed.
    await t.type('git st');
    t.term.input('a', true);
    t.follower.accept(0);
    t.term.input('x', true);
    await t.shell.flush();
    await t.shell.flush();
    expect(t.shell.line).toBe('git stax');
  });

  it('starts over after a full-screen program quit with a single key (q in man)', async () => {
    const man: Program = (k) => (k === 'q' ? { out: '\x1b[?1049l', done: true } : { out: '', done: false });
    const t = await setup({ history: ['ls -la'], run: (cmd) => (cmd === 'man ls' ? { out: '\x1b[?1049h\x1b[HLS(1)\r\n:', prompt: false, program: man } : { out: '', prompt: true }) });
    await t.type('man ls');
    await t.press('Enter');
    t.advance(1000);
    await t.press(' ');
    await t.press('q');
    await t.type('ls');
    expect(t.view()?.items.map((i) => i.text)).toEqual(['ls -la']);
    await t.press('Enter');
    expect(t.remembered).toEqual(['man ls', 'ls']);
  });

  it('starts over after a pager without the alternate screen quit with q, but never in its search prompt', async () => {
    const pager: Program = (k) => (k === 'q' ? { out: '\r\x1b[K', done: true } : k === '/' ? { out: '\r\x1b[K/', done: false } : k === '\r' ? { out: '\r\x1b[K:', done: false } : { out: k, done: false });
    const t = await setup({ history: ['ls -la'], run: (cmd) => (cmd === 'git log' ? { out: 'commit 1a2b3c\r\nAuthor: u\r\n:', prompt: false, program: pager } : { out: '', prompt: true }) });
    await t.type('git log');
    await t.press('Enter');
    t.advance(1000);
    await t.press('/');
    await t.type('ls');
    expect(t.view()).toBeNull();
    await t.press('Enter');
    await t.press('q');
    await t.type('ls');
    expect(t.view()?.items.map((i) => i.text)).toEqual(['ls -la']);
    await t.press('Enter');
    expect(t.remembered).toEqual(['git log', 'ls']);
  });

  it('keeps the command run before the next one was typed ahead of its echo (slow link)', async () => {
    const t = await setup({ history: [] });
    await t.type('cd /var/log');
    // Enter, then the next command, all before any echo is back.
    for (const ch of '\rls\r') { t.advance(150); t.term.input(ch, true); }
    await t.shell.flush();
    // "ls" was typed while the cursor still sat on the line before: where it starts is not known, so it is not kept.
    expect(t.remembered).toEqual(['cd /var/log']);
  });
});
