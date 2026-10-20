import { describe, expect, it } from 'vitest';
import { anchorAtCursor, atBottom, cursorBelowLine, cursorOnLine, isClassicShellPrompt, isShellPrompt, readCommandLine, readSubmittedLine, relocateAnchor, stripRightPrompt, type BufferLike } from '../src/shared/commandLine';
import { captureCommand, COMMAND_HISTORY_LIMITS, frecency, historyCommand, normalizeCommandHistory, recordCommand, type CommandHistoryEntry } from '../src/shared/commandHistory';
import { classifyInput, completionKeys, fuzzyRanges, ghostText, popupKey, predictLine, suggestCommands, type KeyLike, type SuggestSource } from '../src/shared/commandSuggest';

/**
 * A terminal buffer of `cols` columns: one string per row (absolute rows), `wrapped` = rows that continue the row above,
 * `faint` = [row, from, to) cells drawn in bright black (a shell's own inline suggestion).
 */
function buffer(rows: string[], o: { cursor: [number, number]; cols?: number; wrapped?: number[]; type?: 'normal' | 'alternate'; baseY?: number; viewportY?: number; faint?: [number, number, number] }): BufferLike {
  const cols = o.cols ?? 40;
  const baseY = o.baseY ?? 0;
  const faint = (y: number, x: number) => !!o.faint && o.faint[0] === y && x >= o.faint[1] && x < o.faint[2];
  return {
    type: o.type ?? 'normal', cursorX: o.cursor[0], cursorY: o.cursor[1] - baseY, baseY, viewportY: o.viewportY ?? baseY,
    getLine: (y) => (y < 0 || y >= rows.length ? undefined : {
      isWrapped: (o.wrapped ?? []).includes(y),
      translateToString: (trimRight = false, start = 0, end = cols) => {
        const text = rows[y].padEnd(cols).slice(0, cols).slice(start, end);
        return trimRight ? text.trimEnd() : text;
      },
      getCell: (x) => (x < 0 || x >= cols ? undefined : {
        getChars: () => rows[y].padEnd(cols)[x].trim(), isDim: () => 0, isFgPalette: () => faint(y, x), getFgColor: () => (faint(y, x) ? 8 : 0),
      }),
    }),
  };
}

const PROMPT = 'u@web:~$ ';
const at = (row: number) => ({ row, col: PROMPT.length, prompt: PROMPT });

describe('reading the command line back from the buffer', () => {
  it('reads from the anchor to the cursor, the rest after it and the free cells', () => {
    const b = buffer([`${PROMPT}git status`], { cursor: [PROMPT.length + 7, 0] });
    expect(readCommandLine(b, at(0), 40)).toEqual({ ok: true, before: 'git sta', after: 'tus', atEnd: false, room: 0 });
    const end = buffer([`${PROMPT}git st`], { cursor: [PROMPT.length + 6, 0] });
    expect(readCommandLine(end, at(0), 40)).toEqual({ ok: true, before: 'git st', after: '', atEnd: true, room: 40 - PROMPT.length - 6 });
  });

  it('keeps blanks typed before the cursor (trailing space of "ls ")', () => {
    const b = buffer([`${PROMPT}ls `], { cursor: [PROMPT.length + 3, 0] });
    expect(readCommandLine(b, at(0), 40)).toMatchObject({ ok: true, before: 'ls ', atEnd: true });
  });

  it('follows a command wrapped over several rows', () => {
    const rows = [`${PROMPT}echo 0123456789012345678901234567890`, '0123456789end', ''];
    const b = buffer(rows, { cursor: [13, 1], wrapped: [1] });
    const read = readCommandLine(b, at(0), 40);
    expect(read).toMatchObject({ ok: true, atEnd: true });
    // The first row holds 40 columns: the rest of the command is on the wrapped row.
    expect(read.ok && read.before).toBe('echo 01234567890123456789012345' + '0123456789end');
  });

  it('refuses a line it cannot vouch for', () => {
    expect(readCommandLine(buffer([`${PROMPT}ls`], { cursor: [3, 0] }), at(0), 40)).toEqual({ ok: false, reason: 'moved' });
    expect(readCommandLine(buffer(['(reverse-i-search)`l\': ls -la'], { cursor: [20, 0] }), at(0), 40)).toEqual({ ok: false, reason: 'prompt' });
    expect(readCommandLine(buffer([`${PROMPT}ls`, 'a.txt b.txt'], { cursor: [11, 1] }), at(0), 40)).toEqual({ ok: false, reason: 'moved' });
    expect(readCommandLine(buffer([`${PROMPT}ls`], { cursor: [11, 0], type: 'alternate' }), at(0), 40)).toEqual({ ok: false, reason: 'alternate' });
    expect(readCommandLine(buffer([`${PROMPT}ls`], { cursor: [11, 0] }), at(-1), 40)).toEqual({ ok: false, reason: 'gone' });
  });

  it('cuts a right-hand prompt (zsh RPROMPT) off the line', () => {
    const row = `${PROMPT}git st`.padEnd(30) + '~/src 10:22';
    const b = buffer([row], { cursor: [PROMPT.length + 6, 0] });
    expect(readCommandLine(b, at(0), 41)).toEqual({ ok: true, before: 'git st', after: '', atEnd: true, room: 30 - PROMPT.length - 6 - 1 });
    expect(stripRightPrompt('tus      ~/src 10:22', true)).toBe('tus');
    expect(stripRightPrompt('tus      ~/src 10:22', false)).toBe('tus      ~/src 10:22');
    expect(stripRightPrompt(' --oneline   ', true)).toBe(' --oneline');
    // Two blanks inside a command are not a gap before a right-hand prompt.
    expect(stripRightPrompt(` '{print  $1}' file`, true)).toBe(` '{print  $1}' file`);
  });

  it('leaves out the shell\'s own faint inline suggestion (zsh-autosuggestions)', () => {
    const row = `${PROMPT}git status --short`;
    const b = buffer([row], { cursor: [PROMPT.length + 6, 0], faint: [0, PROMPT.length + 6, row.length] });
    expect(readCommandLine(b, at(0), 40)).toEqual({ ok: true, before: 'git st', after: '', atEnd: true, room: 0 });
    // Typed text after the cursor (moved left) is part of the line.
    expect(readCommandLine(buffer([row], { cursor: [PROMPT.length + 6, 0] }), at(0), 40)).toMatchObject({ after: 'atus --short', atEnd: false });
  });

  it('reads the submitted line once the cursor left it, and knows when it did', () => {
    const b = buffer([`${PROMPT}uptime   `, ' 10:01 up 3 days'], { cursor: [0, 1] });
    expect(cursorBelowLine(b, at(0))).toBe(true);
    expect(readSubmittedLine(b, at(0), 40)).toBe('uptime');
    const typing = buffer([`${PROMPT}upt`], { cursor: [PROMPT.length + 3, 0] });
    expect(cursorBelowLine(typing, at(0))).toBe(false);
    const wrapped = buffer([`${PROMPT}echo 0123456789012345678901234567890`, '0123456789end', ''], { cursor: [0, 2], wrapped: [1] });
    expect(cursorBelowLine(buffer([`${PROMPT}echo 0123456789012345678901234567890`, '0123456789end'], { cursor: [13, 1], wrapped: [1] }), at(0))).toBe(false);
    expect(readSubmittedLine(wrapped, at(0), 40)).toBe('echo 01234567890123456789012345' + '0123456789end');
    // The screen was cleared (`clear`, Ctrl+L): the line is gone, nothing is read.
    expect(readSubmittedLine(buffer(['', ''], { cursor: [0, 1] }), at(0), 40)).toBeNull();
  });

  it('knows whether the cursor is still on a line (not above it after `clear`, not below it after Enter)', () => {
    const rows = [`${PROMPT}echo 0123456789012345678901234567890`, '0123456789end', ''];
    expect(cursorOnLine(buffer(rows, { cursor: [PROMPT.length + 4, 0], wrapped: [1] }), at(0))).toBe(true);
    expect(cursorOnLine(buffer(rows, { cursor: [13, 1], wrapped: [1] }), at(0))).toBe(true);
    expect(cursorOnLine(buffer(rows, { cursor: [0, 2], wrapped: [1] }), at(0))).toBe(false);
    expect(cursorOnLine(buffer(['', PROMPT], { cursor: [0, 0] }), at(1))).toBe(false);
    expect(cursorOnLine(buffer([PROMPT], { cursor: [9, 0] }), at(-1))).toBe(false);
  });

  it('moves the anchor to the same prompt drawn again (a completion listing, Ctrl+L)', () => {
    const rows = [`${PROMPT}git ch`, 'checkout  cherry  cherry-pick', `${PROMPT}git ch`];
    const b = buffer(rows, { cursor: [PROMPT.length + 6, 2] });
    expect(readCommandLine(b, at(0), 40)).toEqual({ ok: false, reason: 'moved' });
    expect(relocateAnchor(b, at(0), 40)).toEqual(at(2));
    // Another prompt (the folder changed) is not the same line.
    expect(relocateAnchor(buffer([`${PROMPT}cd /tmp`, 'u@web:/tmp$ '], { cursor: [12, 1] }), at(0), 40)).toBeNull();
  });

  it('starts a line at the cursor and knows whether the view is scrolled back', () => {
    const b = buffer(['motd', PROMPT], { cursor: [PROMPT.length, 1] });
    expect(anchorAtCursor(b)).toEqual(at(1));
    expect(anchorAtCursor(buffer([PROMPT], { cursor: [9, 0], type: 'alternate' }))).toBeNull();
    expect(atBottom(buffer(['a', 'b', 'c'], { cursor: [0, 2], baseY: 1 }))).toBe(true);
    expect(atBottom(buffer(['a', 'b', 'c'], { cursor: [0, 2], baseY: 1, viewportY: 0 }))).toBe(false);
  });

  it('tells shell prompts from questions, secrets, continuations and REPLs', () => {
    for (const p of ['u@web:~$ ', 'root@web:/var/www# ', '[u@web ~]$ ', 'web% ', 'u@web ~ % ', '➜  repo git:(main) ✗ ', '➜  repo git:(main) ', '❯ ', '~/src/token-service ❯ ',
      'PS C:\\Users\\u> ', 'C:\\Users\\u>', 'u@web ~> ', 'u@web \uE0B0 ', 'u@passport:~$ ', '~/x ']) expect(isShellPrompt(p), p).toBe(true);
    for (const p of ['', '   ', '> ', '>>> ', '... ', 'mysql> ', 'MariaDB [(none)]> ', 'postgres=# ', 'app=> ', 'sqlite> ', 'irb(main):001:0> ', '127.0.0.1:6379> ', '(gdb) ', 'sftp> ',
      'Password: ', '[sudo] password for u: ', 'Enter passphrase for key \'/k\': ', 'Token> ', 'Do you want to continue? [Y/n] ', 'Are you sure (yes/no/[fingerprint])? ', 'Overwrite (y/n) ']) expect(isShellPrompt(p), p).toBe(false);
  });

  it('asks for a classic shell prompt when a program ended without Enter (a pager quit with q)', () => {
    for (const p of ['u@web:~$ ', 'root@web:/var/www# ', 'web% ', '➜  repo git:(main) ✗ ', '~/src ❯ ']) expect(isClassicShellPrompt(p), p).toBe(true);
    // A pager's search and `:` prompt, a REPL ending in `#`, an answer typed after a question, a line typed fast, nothing.
    for (const p of ['/', ':', 'postgres=# ', 'Do you want to continue? [Y/n] y', 'u@web:~$ l', '', 'PS C:\\> ']) expect(isClassicShellPrompt(p), p).toBe(false);
  });
});

describe('the command history', () => {
  const entry = (command: string, count: number, lastUsed: number): CommandHistoryEntry => ({ command, count, lastUsed });

  it('keeps only lines that the shell would run as they are', () => {
    expect(historyCommand('git status  ')).toBe('git status');
    for (const line of ['', '   ', 'y', 'ż', ' secret --token x', '\tls', 'a\x1bb', '********', '••••', 'x'.repeat(COMMAND_HISTORY_LIMITS.command + 1),
      'echo "unclosed', "echo 'open", 'ls |', 'make && \\', 'a &&']) expect(historyCommand(line), line).toBeNull();
    expect(historyCommand(`echo "it's" 'a \\ b' \\"`)).toBe(`echo "it's" 'a \\ b' \\"`);
  });

  it('records a submitted line only when it was echoed, and not twice in a row', () => {
    expect(captureCommand('ls -la', { echoed: false })).toBeNull();
    expect(captureCommand(null, { echoed: true })).toBeNull();
    expect(captureCommand('ls -la', { echoed: true, last: 'ls -la' })).toBeNull();
    expect(captureCommand('ls -la', { echoed: true, last: 'ls' })).toBe('ls -la');
    expect(captureCommand(' ls -la', { echoed: true })).toBeNull();
  });

  it('puts a run first, counts repeats and ignores a repeat of the last line', () => {
    let h = recordCommand([], 'ls', 1);
    h = recordCommand(h, 'pwd', 2);
    expect(recordCommand(h, 'pwd', 3)).toBe(h);
    h = recordCommand(h, 'ls', 4);
    expect(h).toEqual([entry('ls', 2, 4), entry('pwd', 1, 2)]);
  });

  it('ranks recent and frequent commands higher and drops the lowest ranked one over the limit', () => {
    const now = 100 * 24 * 3_600_000;
    expect(frecency(entry('a', 1, now - 60_000), now)).toBeGreaterThan(frecency(entry('b', 1, now - 2 * 24 * 3_600_000), now));
    expect(frecency(entry('a', 20, now - 60_000), now)).toBeGreaterThan(frecency(entry('b', 1, now - 60_000), now));
    const old = [entry('frequent', 50, now - 40 * 24 * 3_600_000), entry('once', 1, now - 40 * 24 * 3_600_000)];
    expect(recordCommand(old, 'new', now, 2).map((e) => e.command)).toEqual(['new', 'frequent']);
    // The run just recorded is never the one dropped.
    expect(recordCommand([entry('a', 99, now)], 'b', now, 1).map((e) => e.command)).toEqual(['b']);
  });

  it('cleans a history file and refuses one it does not understand', () => {
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    const raw = {
      version: 1,
      hosts: {
        [A]: [entry('ls', 2, 5), { command: 'ls', count: 9, lastUsed: 1 }, { command: ' hidden', count: 1, lastUsed: 1 }, { command: 'pwd', count: -1, lastUsed: 9 }, 'junk'],
        [B]: [entry('uptime', 1, 50)],
        'not-a-uuid': [entry('x', 1, 1)],
      },
    };
    const parsed = normalizeCommandHistory(raw);
    expect(parsed.newer || parsed.invalid).toBe(false);
    expect([...parsed.hosts.keys()]).toEqual([A, B]); // the most recently used host last
    expect(parsed.hosts.get(A)).toEqual([entry('pwd', 1, 9), entry('ls', 2, 5)]);
    expect(normalizeCommandHistory({ version: 2, hosts: {} }).newer).toBe(true);
    expect(normalizeCommandHistory([]).invalid).toBe(true);
    expect(normalizeCommandHistory({ version: 1, hosts: [] }).invalid).toBe(true);
    expect(normalizeCommandHistory({ version: 1 })).toEqual({ hosts: new Map(), newer: false, invalid: false });
  });
});

describe('suggestions', () => {
  const h = (text: string, weight = 1): SuggestSource => ({ text, kind: 'history', weight });

  it('lists prefix matches first (best ranked first), then fuzzy ones, without duplicates or the typed line', () => {
    const sources = [h('git status', 1), h('git stash', 5), h('docker ps'), h('git log --stat'), h('git st'), { text: 'git stash', kind: 'snippet' as const, weight: 3, label: 'stash' }];
    const items = suggestCommands('git st', sources);
    expect(items.map((s) => s.text)).toEqual(['git stash', 'git status', 'git log --stat']);
    expect(items[0]).toEqual({ text: 'git stash', kind: 'history', ranges: [[0, 6]], prefix: true });
    expect(items[2].prefix).toBe(false);
    expect(suggestCommands('   ', sources)).toEqual([]);
    expect(suggestCommands('  docker', sources).map((s) => s.text)).toEqual(['docker ps']);
  });

  it('needs two characters before matching fuzzily, and shows at most eight', () => {
    expect(suggestCommands('s', [h('ls -la'), h('ssh web')]).map((s) => s.text)).toEqual(['ssh web']);
    const many = Array.from({ length: 20 }, (_, i) => h(`ls ${i}`, i));
    const items = suggestCommands('ls', many);
    expect(items).toHaveLength(8);
    expect(items[0].text).toBe('ls 19');
  });

  it('marks the matched characters', () => {
    expect(fuzzyRanges('gst', 'git status')).toEqual([[0, 1], [4, 6]]);
    expect(fuzzyRanges('stat', 'git status')).toEqual([[4, 8]]);
    expect(fuzzyRanges('xyz', 'git status')).toBeNull();
    const snippet = suggestCommands('rst', [{ text: 'sudo systemctl restart nginx', kind: 'snippet', weight: 3, label: 'Restart nginx' }])[0];
    expect(snippet).toMatchObject({ kind: 'snippet', label: 'Restart nginx', prefix: false });
  });

  it('completes like fish: the ghost is the rest of a suggestion that starts with the typed line', () => {
    const [prefix] = suggestCommands('git st', [h('git status')]);
    expect(ghostText('git st', prefix)).toBe('atus');
    expect(ghostText('  git st', prefix)).toBe('atus');
    const [fuzzy] = suggestCommands('gst', [h('git status')]);
    expect(ghostText('gst', fuzzy)).toBe('');
    expect(ghostText('x', undefined)).toBe('');
  });

  it('inserts with the fewest keys: the missing part, or backspaces and the rest', () => {
    expect(completionKeys('git st', 'git status')).toBe('atus');
    expect(completionKeys('gst', 'git status')).toBe('\x7f\x7fit status');
    expect(completionKeys('ls -la', 'ls')).toBe('\x7f\x7f\x7f\x7f');
    expect(completionKeys('żółw', 'żółty')).toBe('\x7fty');
    expect(completionKeys('ls', 'ls')).toBe('');
  });

  it('foresees the line once typed text and backspaces are echoed, and nothing else', () => {
    expect(predictLine('git st', 'a')).toBe('git sta');
    expect(predictLine('git st', '\x1b[200~atus -s\x1b[201~')).toBe('git status -s');
    expect(predictLine('żółw', '\x7f')).toBe('żół');
    expect(predictLine('ls', '\b')).toBe('l');
    expect(predictLine('', '\x7f')).toBe('');
    for (const d of ['\t', '\x1b[A', '\x1b[D', '\x17', '\x1b[3~', '\x04']) expect(predictLine('git st', d), JSON.stringify(d)).toBeNull();
    expect(predictLine(null, 'a')).toBeNull();
  });
});

describe('keys while the popup is open', () => {
  const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
  const closed = { selected: -1, count: 3, ghost: true };
  const inList = { selected: 1, count: 3, ghost: false };

  it('leaves typing, Tab and ↑ to the shell until the list is entered', () => {
    expect(popupKey(key('a'), closed)).toEqual({ kind: 'pass', hide: false });
    expect(popupKey(key('Backspace'), closed)).toEqual({ kind: 'pass', hide: false });
    expect(popupKey(key('Tab'), closed)).toEqual({ kind: 'pass', hide: true });
    expect(popupKey(key('ArrowUp'), closed)).toEqual({ kind: 'pass', hide: true });
    expect(popupKey(key('Enter'), closed)).toEqual({ kind: 'pass', hide: true });
    expect(popupKey(key('c', { ctrlKey: true }), closed)).toEqual({ kind: 'pass', hide: true });
    expect(popupKey(key('ł', { ctrlKey: true, altKey: true }), closed)).toEqual({ kind: 'pass', hide: false });
    // AltGr itself (Windows: Control, then AltGraph with Ctrl+Alt) and other lone modifiers keep the popup and its choice.
    for (const k of ['Control', 'AltGraph', 'Shift', 'CapsLock', 'Meta']) {
      expect(popupKey(key(k, { ctrlKey: true, altKey: true }), inList), k).toEqual({ kind: 'pass', hide: false });
    }
    expect(popupKey(key('Enter', { isComposing: true }), inList)).toEqual({ kind: 'pass', hide: false });
  });

  it('walks the list with ↓ and ↑ (↑ on the first item leaves it)', () => {
    expect(popupKey(key('ArrowDown'), closed)).toEqual({ kind: 'select', index: 0 });
    expect(popupKey(key('ArrowDown'), inList)).toEqual({ kind: 'select', index: 2 });
    expect(popupKey(key('ArrowDown'), { ...inList, selected: 2 })).toEqual({ kind: 'select', index: 2 });
    expect(popupKey(key('ArrowUp'), inList)).toEqual({ kind: 'select', index: 0 });
    expect(popupKey(key('ArrowUp'), { ...inList, selected: 0 })).toEqual({ kind: 'select', index: -1 });
  });

  it('inserts with Enter (chosen item) and → (ghost or chosen item), closes with Esc', () => {
    expect(popupKey(key('Enter'), inList)).toEqual({ kind: 'accept', index: 1 });
    expect(popupKey(key('ArrowRight'), closed)).toEqual({ kind: 'accept', index: 0 });
    expect(popupKey(key('ArrowRight'), inList)).toEqual({ kind: 'accept', index: 1 });
    expect(popupKey(key('ArrowRight'), { ...closed, ghost: false })).toEqual({ kind: 'pass', hide: true });
    expect(popupKey(key('Escape'), closed)).toEqual({ kind: 'close' });
  });
});

describe('terminal input', () => {
  it('classifies what the user sends to the shell', () => {
    for (const d of ['\r', '\n', '\x1bOM']) expect(classifyInput(d), JSON.stringify(d)).toBe('submit');
    expect(classifyInput('\x03')).toBe('abort');
    expect(classifyInput('\x12')).toBe('lose');
    expect(classifyInput('\t')).toBe('complete');
    for (const d of ['\x7f', '\b', '\x1b[3~', '\x17', '\x15', '\x04']) expect(classifyInput(d), JSON.stringify(d)).toBe('erase');
    for (const d of ['\x1b[A', '\x1bOB', '\x10']) expect(classifyInput(d), JSON.stringify(d)).toBe('recall');
    for (const d of ['\x1b[D', '\x1bOC', '\x1b[1;5C', '\x1b[H', '\x1b[4~', '\x01', '\x05', '\x1bb']) expect(classifyInput(d), JSON.stringify(d)).toBe('move');
    expect(classifyInput('l')).toBe('text');
    expect(classifyInput('żółw')).toBe('text');
    expect(classifyInput('\x1b[200~git status\x1b[201~')).toBe('text');
    expect(classifyInput('\x1b[200~ls\nls -la\n\x1b[201~')).toBe('abort');
    expect(classifyInput('ls\npwd')).toBe('lose');
    expect(classifyInput('\x1b')).toBe('other');
    expect(classifyInput('\x0c')).toBe('other');
  });
});
