import { describe, expect, it } from 'vitest';
import {
  appendMessages, completeCommand, containsPattern, formatBytes, formatJson, formatTtl, hexDump, hitRatio, infoGroups, isJsonText, isMapReply,
  jsonError, mergeKeys, messageMatches, parseTtlInput, pushHistory, redisKeyRows, redisTabId, replyText, scanPattern, validNewStreamId,
  validRedisTabRef, validScore,
} from '../src/shared/redisView';
import type { RedisKeyInfo } from '../src/shared/dbRedis';

const C = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const key = (k: RedisKeyInfo['key'], type = 'string'): RedisKeyInfo => ({ key: k, type, ttlMs: null });

describe('redis tabs', () => {
  it('builds stable ids and validates references', () => {
    const ref = { kind: 'redis' as const, view: 'keys' as const, connectionId: C, db: 3, uid: U };
    expect(redisTabId(ref)).toBe(JSON.stringify(['redis', 'keys', C, U]));
    expect(validRedisTabRef(ref)).toBe(true);
    expect(validRedisTabRef({ ...ref, view: 'other' })).toBe(false);
    expect(validRedisTabRef({ ...ref, db: -1 })).toBe(false);
    expect(validRedisTabRef({ ...ref, connectionId: 'x' })).toBe(false);
  });
});

describe('key tree', () => {
  const keys = [key('user:1', 'hash'), key('user:2', 'hash'), key('user:admin:1'), key('queue', 'list'), key({ b64: 'AP8=' })];

  it('groups text keys by ":" with folder counts, folders first, binary keys at the top level', () => {
    const closed = redisKeyRows(keys, 'tree', new Set());
    expect(closed.map((r) => [r.kind, r.name])).toEqual([['folder', 'user'], ['key', '\\x00\\xff'], ['key', 'queue']]);
    expect(closed[0]).toMatchObject({ kind: 'folder', count: 3, open: false, depth: 0 });
    const open = redisKeyRows(keys, 'tree', new Set(['user:', 'user:admin:']));
    expect(open.map((r) => `${r.depth}${r.kind[0]}:${r.name}`)).toEqual(['0f:user', '1f:admin', '2k:1', '1k:1', '1k:2', '0k:\\x00\\xff', '0k:queue']);
  });

  it('lists every key by its full name in flat mode', () => {
    expect(redisKeyRows(keys, 'flat', new Set()).map((r) => r.name)).toEqual(['\\x00\\xff', 'queue', 'user:1', 'user:2', 'user:admin:1']);
  });

  it('keeps one row per key when pages overlap, with the newer details', () => {
    const merged = mergeKeys([key('a'), key('b')], [{ ...key('b'), ttlMs: 5000 }, key('c')]);
    expect(merged.map((k) => k.key)).toEqual(['a', 'b', 'c']);
    expect(merged[1].ttlMs).toBe(5000);
  });

  it('reads search fields', () => {
    expect(scanPattern('  ')).toBeUndefined();
    expect(scanPattern('*')).toBeUndefined();
    expect(scanPattern('user:*')).toBe('user:*');
    expect(containsPattern('name')).toBe('*name*');
    expect(containsPattern('na?e')).toBe('na?e');
    expect(containsPattern('')).toBeUndefined();
  });
});

describe('formatting', () => {
  it('formats sizes and TTLs', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatTtl(null)).toBeNull();
    expect(formatTtl(450)).toBe('450ms');
    expect(formatTtl(45_000)).toBe('45s');
    expect(formatTtl(725_000)).toBe('12m 5s');
    expect(formatTtl(3 * 3600_000 + 20 * 60_000)).toBe('3h 20m');
    expect(formatTtl(4 * 86400_000 + 2 * 3600_000 + 5000)).toBe('4d 2h');
  });

  it('parses typed TTLs', () => {
    expect(parseTtlInput('90')).toBe(90_000);
    expect(parseTtlInput('1.5')).toBe(1500);
    expect(parseTtlInput('500ms')).toBe(500);
    expect(parseTtlInput('5m')).toBe(300_000);
    expect(parseTtlInput('1h 30m')).toBe(5_400_000);
    expect(parseTtlInput('2d')).toBe(172_800_000);
    expect(parseTtlInput('0')).toBeNull();
    expect(parseTtlInput('abc')).toBeNull();
    expect(parseTtlInput('5x')).toBeNull();
  });

  it('checks scores and new stream ids', () => {
    for (const s of ['1', '-1.5', '+inf', '-inf', '3e10', '.5']) expect(validScore(s)).toBe(true);
    for (const s of ['', 'abc', '1.2.3', 'nan']) expect(validScore(s)).toBe(false);
    for (const id of ['*', '1-0', '17-*', '42']) expect(validNewStreamId(id)).toBe(true);
    for (const id of ['', 'a-b', '1-0-0']) expect(validNewStreamId(id)).toBe(false);
  });

  it('re-indents JSON without touching numbers or strings', () => {
    const text = '{"id":12345678901234567890,"s":"a, b: {c}","list":[1,2,{}],"e":[]}';
    expect(isJsonText(text)).toBe(true);
    expect(isJsonText('42')).toBe(false);
    const pretty = formatJson(text)!;
    expect(pretty).toBe('{\n  "id": 12345678901234567890,\n  "s": "a, b: {c}",\n  "list": [\n    1,\n    2,\n    {}\n  ],\n  "e": []\n}');
    expect(formatJson(pretty, 0)).toBe(text);
    expect(formatJson('{"a":"x\\"y"}', 0)).toBe('{"a":"x\\"y"}');
    expect(formatJson('{bad')).toBeNull();
    expect(jsonError('{"a":1}')).toBeNull();
    expect(jsonError('{a}')).toBeTypeOf('string');
  });

  it('dumps bytes as hex with offsets and printable text', () => {
    const lines = hexDump({ b64: Buffer.from('hello\u0000world, this is 20+').toString('base64') });
    expect(lines[0]).toBe('00000000  68 65 6c 6c 6f 00 77 6f  72 6c 64 2c 20 74 68 69  |hello.world, thi|');
    expect(lines[1].startsWith('00000010  73 20 69 73')).toBe(true);
    expect(hexDump('abc', 2)).toHaveLength(1);
  });
});

describe('console', () => {
  it('prints replies like redis-cli', () => {
    expect(replyText({ t: 'simple', v: 'OK' })).toBe('OK');
    expect(replyText({ t: 'error', v: 'ERR nope' })).toBe('(error) ERR nope');
    expect(replyText({ t: 'integer', v: '5' })).toBe('(integer) 5');
    expect(replyText({ t: 'null' })).toBe('(nil)');
    expect(replyText({ t: 'bulk', v: 'a "b"\n', bytes: 7 })).toBe('"a \\"b\\"\\n"');
    expect(replyText({ t: 'bulk', v: { b64: 'AP8=' }, bytes: 2 })).toBe('"\\x00\\xff"');
    expect(replyText({ t: 'array', items: [], length: 0 })).toBe('(empty array)');
    expect(replyText({ t: 'array', length: 2, items: [{ t: 'bulk', v: 'a', bytes: 1 }, { t: 'array', length: 2, items: [{ t: 'integer', v: '1' }, { t: 'null' }] }] }))
      .toBe('1) "a"\n2) 1) (integer) 1\n   2) (nil)');
    expect(replyText({ t: 'array', length: 5, items: [{ t: 'null' }] })).toBe('1) (nil)\n... (4)');
  });

  it('knows map replies', () => {
    const pairs = { t: 'array' as const, length: 2, items: [{ t: 'bulk' as const, v: 'f', bytes: 1 }, { t: 'bulk' as const, v: 'v', bytes: 1 }] };
    expect(isMapReply('HGETALL', pairs)).toBe(true);
    expect(isMapReply('LRANGE', pairs)).toBe(false);
    expect(isMapReply('HGETALL', { ...pairs, length: 3 })).toBe(false);
  });

  it('completes command names and container subcommands', () => {
    expect(completeCommand('hge')).toEqual(['HGET', 'HGETALL']);
    expect(completeCommand('config s')).toEqual(['CONFIG SET']);
    expect(completeCommand('get foo')).toEqual([]);
    expect(completeCommand('')).toEqual([]);
    expect(completeCommand('GET')).toEqual(['GETBIT', 'GETDEL', 'GETEX', 'GETRANGE', 'GETSET']);
  });

  it('keeps a bounded history without repeating the last line', () => {
    expect(pushHistory(['a'], 'a')).toEqual(['a']);
    expect(pushHistory(['a'], ' b ')).toEqual(['a', 'b']);
    expect(pushHistory(['a', 'b'], '', 5)).toEqual(['a', 'b']);
    expect(pushHistory(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
});

describe('pub/sub and info', () => {
  it('caps the message list and filters it', () => {
    const msg = (channel: string, payload: string) => ({ channel, time: 1, payload: { data: payload, bytes: payload.length } });
    const first = appendMessages([], [msg('a', '1'), msg('b', '2')], 0, 3);
    const second = appendMessages(first.list, [msg('c', '3'), msg('d', '{"x":1}')], first.nextSeq, 3);
    expect(second.list.map((m) => [m.channel, m.seq])).toEqual([['b', 1], ['c', 2], ['d', 3]]);
    expect(second.nextSeq).toBe(4);
    expect(messageMatches(second.list[2], 'X":')).toBe(true);
    expect(messageMatches(second.list[2], 'zzz')).toBe(false);
    expect(messageMatches({ ...msg('news', ''), pattern: 'ne*' }, 'ne*')).toBe(true);
  });

  it('orders the main INFO sections and computes the hit ratio', () => {
    const sections = [
      { name: 'Server', entries: [['redis_version', '7.2.4']] as Array<[string, string]> },
      { name: 'Stats', entries: [['keyspace_hits', '3'], ['keyspace_misses', '1']] as Array<[string, string]> },
      { name: 'Memory', entries: [['used_memory_human', '1M']] as Array<[string, string]> },
    ];
    const g = infoGroups(sections);
    expect(g.main.map((s) => s.name)).toEqual(['Memory', 'Stats']);
    expect(g.other.map((s) => s.name)).toEqual(['Server']);
    expect(hitRatio(sections)).toBe(75);
    expect(hitRatio([])).toBeNull();
  });
});
