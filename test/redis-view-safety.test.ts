// The safety decisions of the Redis views (1.0.0 fix round 1): glob escaping of folder patterns, line endings of edited values,
// console history redaction, write outcomes, the pattern delete steps, console routing, the JSON save style and the Pub/Sub caps.
import { describe, expect, it } from 'vitest';
import {
  afterConsoleError, afterPatternCount, afterPatternDelete, appendMessages, capMessages, consoleRoute, editorText, folderPattern, globEscape,
  historyLine, jsonSaveText, lineEndings, messageMatches, savedText, writeOutcome,
} from '../src/shared/redisView';
import { parseRedisCommandLine, type RedisData } from '../src/shared/dbRedis';

/** A tiny glob matcher with Redis' rules (* ? [..] and backslash escapes) to prove what a pattern selects. */
function globMatch(pattern: string, text: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { re += `\\${pattern[++i]}`.replace(/\\([a-zA-Z0-9])/, '$1'); continue; }
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') { const end = pattern.indexOf(']', i); re += `[${pattern.slice(i + 1, end)}]`; i = end; }
    else re += c.replace(/[.+^${}()|]/g, '\\$&');
  }
  return new RegExp(`${re}$`).test(text);
}

const argv = (line: string): RedisData[] => { const r = parseRedisCommandLine(line); if (!r.ok) throw new Error(line); return r.argv; };

describe('folder patterns', () => {
  it('escapes glob characters so a folder selects only its own keys', () => {
    expect(globEscape('a[12]:*?\\')).toBe('a\\[12\\]:\\*\\?\\\\');
    const cases: Array<[string, string[], string[]]> = [
      ['a[12]:', ['a[12]:x'], ['a1:x', 'a2:x']],
      ['star*:', ['star*:x'], ['starfish:x']],
      ['q?:', ['q?:x'], ['qa:x']],
      ['back\\:', ['back\\:x'], ['back:x']],
    ];
    for (const [folder, yes, no] of cases) {
      const p = folderPattern(folder);
      for (const k of yes) expect(globMatch(p, k), `${p} ~ ${k}`).toBe(true);
      for (const k of no) expect(globMatch(p, k), `${p} !~ ${k}`).toBe(false);
    }
  });
});

describe('line endings', () => {
  it('keeps CRLF values CRLF and refuses mixed ones in the text editor', () => {
    expect(lineEndings('a\nb')).toBe('lf');
    expect(lineEndings('a\r\nb\r\n')).toBe('crlf');
    expect(lineEndings('a\r\nb\n')).toBe('mixed');
    expect(lineEndings('a\rb')).toBe('mixed');
    const crlf = 'GET / HTTP/1.1\r\nHost: x\r\n\r\n';
    expect(editorText(crlf)).toBe('GET / HTTP/1.1\nHost: x\n\n');
    expect(savedText(editorText(crlf), 'crlf')).toBe(crlf);
    expect(savedText('a\nb\nc', 'crlf')).toBe('a\r\nb\r\nc');
    expect(savedText('a\nb', 'lf')).toBe('a\nb');
    expect(savedText('a\nb', 'mixed')).toBeNull();
  });
});

describe('console history', () => {
  it('never keeps passwords', () => {
    expect(historyLine(argv('AUTH secret'))).toBeNull();
    expect(historyLine(argv('AUTH user secret'))).toBeNull();
    expect(historyLine(argv('HELLO 3 AUTH user secret'))).toBeNull();
    expect(historyLine(argv('CONFIG SET requirepass hunter2'))).toBe('CONFIG SET requirepass ***');
    expect(historyLine(argv('config set maxmemory 1gb masterauth pw'))).toBe('config set maxmemory 1gb masterauth ***');
    expect(historyLine(argv('ACL SETUSER bob on >pw1 #abcd ~* +@all'))).toBe('ACL SETUSER bob on >*** #*** ~* +@all');
    expect(historyLine(argv('MIGRATE h 6379 "" 0 5000 AUTH pw KEYS a'))).toBe('MIGRATE h 6379 "" 0 5000 AUTH *** KEYS a');
    expect(historyLine(argv('MIGRATE h 6379 k 0 5000 AUTH2 user pw'))).toBe('MIGRATE h 6379 k 0 5000 AUTH2 user ***');
    expect(historyLine(argv('SET "a b" 1'))).toBe('SET "a b" 1');
  });
});

describe('outcomes', () => {
  it('maps write results without ever retrying', () => {
    expect(writeOutcome({ ok: true })).toEqual({ kind: 'done' });
    expect(writeOutcome({ ok: false, error: 'notFound' })).toEqual({ kind: 'reload', why: 'notFound' });
    expect(writeOutcome({ ok: false, error: 'wrongType' })).toEqual({ kind: 'reload', why: 'wrongType' });
    expect(writeOutcome({ ok: false, error: 'conflict' })).toEqual({ kind: 'reload', why: 'conflict' });
    expect(writeOutcome({ ok: false, error: 'dbTimeout' })).toEqual({ kind: 'timeout' });
    expect(writeOutcome({ ok: false, error: 'readOnly' })).toEqual({ kind: 'error' });
  });

  it('walks the pattern delete: count, confirm, more -> recount, staleToken -> new count', () => {
    expect(afterPatternCount({ ok: true, value: { token: 't', count: 3, complete: true } })).toEqual({ kind: 'confirm', token: 't', count: 3, complete: true });
    expect(afterPatternCount({ ok: true, value: { token: 't', count: 0, complete: true } })).toEqual({ kind: 'empty' });
    expect(afterPatternCount({ ok: false, error: 'dbTimeout' })).toEqual({ kind: 'error', recount: false });
    expect(afterPatternDelete({ ok: true, value: { deleted: 3, cancelled: false, more: false } }, 0)).toEqual({ kind: 'done', deleted: 3, cancelled: false });
    expect(afterPatternDelete({ ok: true, value: { deleted: 300, cancelled: false, more: true } }, 10)).toEqual({ kind: 'recount', deleted: 310 });
    expect(afterPatternDelete({ ok: true, value: { deleted: 5, cancelled: true, more: true } }, 0)).toEqual({ kind: 'done', deleted: 5, cancelled: true });
    expect(afterPatternDelete({ ok: false, error: 'staleToken' }, 0)).toEqual({ kind: 'error', recount: true });
  });

  it('routes console commands', () => {
    expect(consoleRoute(argv('GET a'))).toEqual({ kind: 'send' });
    expect(consoleRoute(argv('FLUSHDB'))).toEqual({ kind: 'confirm' });
    expect(consoleRoute(argv('SUBSCRIBE x'))).toEqual({ kind: 'refuse', why: 'subscribe' });
    expect(consoleRoute(argv('BLPOP q 0'))).toEqual({ kind: 'refuse', why: 'blocking' });
    expect(consoleRoute(argv('MULTI'))).toEqual({ kind: 'refuse', why: 'unsupported' });
    expect(afterConsoleError('readOnly', argv('SET a 1'), false)).toEqual({ kind: 'offerWrite' });
    expect(afterConsoleError('needsConfirm', argv('HGETALL big'), false)).toEqual({ kind: 'ask', why: 'big' });
    expect(afterConsoleError('needsConfirm', argv('FLUSHALL'), false)).toEqual({ kind: 'ask', why: 'danger' });
    expect(afterConsoleError('needsConfirm', argv('HGETALL big'), true)).toEqual({ kind: 'error' });
  });

  it('keeps the stored JSON style or asks', () => {
    expect(jsonSaveText('{"a":1}', '{\n  "a": 2\n}')).toEqual({ kind: 'save', text: '{"a":2}' });
    expect(jsonSaveText('{\n  "a": 1\n}', '{"a":2}')).toEqual({ kind: 'save', text: '{\n  "a": 2\n}' });
    expect(jsonSaveText('{"a": 1}', '{"a": 2}')).toEqual({ kind: 'ask', pretty: '{\n  "a": 2\n}', compact: '{"a":2}' });
    expect(jsonSaveText('{\n    "a": 1\n}', '{"a":2}').kind).toBe('ask');
    expect(jsonSaveText('{"a":1}', '{bad')).toEqual({ kind: 'invalid' });
  });
});

describe('pub/sub caps', () => {
  const msg = (n: number, bytes: number) => ({ channel: `c${n}`, time: n, payload: { data: 'x', bytes } });
  it('drops the oldest messages beyond the byte budget and caches the search text', () => {
    expect(capMessages([msg(1, 6), msg(2, 6), msg(3, 6)], 10, 12)).toEqual({ kept: [msg(2, 6), msg(3, 6)], dropped: 1 });
    const r = appendMessages([], [msg(1, 10), msg(2, 10), msg(3, 10)], 0, 100, 25);
    expect(r.list.map((m) => m.channel)).toEqual(['c2', 'c3']);
    expect(r.dropped).toBe(1);
    expect(r.list[0].search).toBe('c2\nx');
    expect(messageMatches(r.list[0], 'C2')).toBe(true);
  });
});
