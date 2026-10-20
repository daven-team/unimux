// Shared Redis helpers (1.0.0): binary-safe data, the console line parser (redis-cli quoting), command classes (dangerous,
// blocking, subscribe, status replies), INFO / keyspace / CLIENT LIST parsing, stream id steps and the error texts.
import { describe, expect, it } from 'vitest';
import { dbErrorText, type DbErrorCode } from '../src/shared/db';
import {
  classifyRedisCommand, parseRedisClientList, parseRedisCommandLine, parseRedisInfo, parseRedisKeyspace, quoteRedisArg, redisCommandName, redisDataBytes,
  redisDataDisplay, redisDataEquals, redisDataFromBytes, redisDataFromHex, redisDataHex, redisDataLength, streamIdStep, isStreamId,
} from '../src/shared/dbRedis';
import { messages } from '../src/shared/messages';

describe('Redis data', () => {
  it('keeps valid UTF-8 as text and anything else as base64, both ways', () => {
    expect(redisDataFromBytes(new TextEncoder().encode('zażółć 🙂'))).toBe('zażółć 🙂');
    const bin = redisDataFromBytes(Uint8Array.from([0, 255, 0xc3]));
    expect(bin).toEqual({ b64: 'AP/D' });
    expect([...redisDataBytes(bin)]).toEqual([0, 255, 0xc3]);
    expect(redisDataLength('ż')).toBe(2);
    expect(redisDataHex(bin)).toBe('00 ff c3');
    expect(redisDataFromHex('00 ff c3')).toEqual(bin);
    expect(redisDataFromHex('6869')).toBe('hi');
    expect(redisDataFromHex('6')).toBeNull();
    expect(redisDataFromHex('zz')).toBeNull();
    expect(redisDataDisplay({ b64: btoa('a\x00"\\\n\xff') })).toBe('a\\x00\\"\\\\\\n\\xff');
    expect(redisDataEquals('a', 'a')).toBe(true);
    expect(redisDataEquals('a', { b64: btoa('a') })).toBe(false);
  });
});

describe('parseRedisCommandLine', () => {
  const argv = (line: string) => { const r = parseRedisCommandLine(line); if (!r.ok) throw new Error(r.error); return r.argv; };
  it('splits words and handles double and single quotes like redis-cli', () => {
    expect(argv('  SET  key   value ')).toEqual(['SET', 'key', 'value']);
    expect(argv('SET "a b" \'c d\'')).toEqual(['SET', 'a b', 'c d']);
    expect(argv('SET k "line\\nnext\\t\\"q\\" \\\\"')).toEqual(['SET', 'k', 'line\nnext\t"q" \\']);
    expect(argv("SET k 'it\\'s \\n raw'")).toEqual(['SET', 'k', "it's \\n raw"]);
    expect(argv('SET k ""')).toEqual(['SET', 'k', '']);
    expect(argv('SET zażółć 🙂')).toEqual(['SET', 'zażółć', '🙂']);
    // As sdssplitargs: a quote inside a word starts a quoted part of the same word.
    expect(argv('SET k a"b c"')).toEqual(['SET', 'k', 'ab c']);
  });
  it('turns \\xHH into bytes (binary when not UTF-8)', () => {
    expect(argv('SET k "\\x68\\x69"')).toEqual(['SET', 'k', 'hi']);
    expect(argv('SET k "\\x00\\xff"')).toEqual(['SET', 'k', { b64: 'AP8=' }]);
    expect(argv('SET k "\\xc5\\xbc"')).toEqual(['SET', 'k', 'ż']);
  });
  it('refuses unbalanced quotes and a quote followed by a character; an empty line is empty', () => {
    expect(parseRedisCommandLine('SET "abc')).toEqual({ ok: false, error: 'unbalancedQuotes' });
    expect(parseRedisCommandLine("SET 'abc")).toEqual({ ok: false, error: 'unbalancedQuotes' });
    expect(parseRedisCommandLine('SET "a"b')).toEqual({ ok: false, error: 'unbalancedQuotes' });
    expect(parseRedisCommandLine('   ')).toEqual({ ok: false, error: 'empty' });
  });
  it('quotes arguments back so the line parses to the same argv', () => {
    for (const a of ['plain', 'a b', 'q"x', 'back\\slash', 'nl\nx', '', 'ż']) {
      expect(argv(`SET ${quoteRedisArg(a)}`)).toEqual(['SET', a]);
    }
    expect(argv(`SET ${quoteRedisArg({ b64: 'AP8=' })}`)).toEqual(['SET', { b64: 'AP8=' }]);
  });
});

describe('classifyRedisCommand', () => {
  it('names container commands with their subcommand and flags the dangerous ones', () => {
    expect(redisCommandName(['config', 'set', 'x', 'y'])).toBe('CONFIG SET');
    expect(redisCommandName(['get', 'k'])).toBe('GET');
    for (const line of ['FLUSHALL', 'flushdb', 'KEYS *', 'CONFIG SET maxmemory 1', 'config rewrite', 'CONFIG RESETSTAT', 'SHUTDOWN', 'DEBUG SLEEP 1', 'SAVE', 'BGREWRITEAOF', 'REPLICAOF a 1', 'SLAVEOF NO ONE', 'CLIENT KILL ID 3', 'SCRIPT FLUSH', 'FUNCTION FLUSH', 'MIGRATE h 1 k 0 1', 'MODULE LIST']) {
      const r = parseRedisCommandLine(line);
      if (!r.ok) throw new Error(line);
      expect(classifyRedisCommand(r.argv).dangerous, line).toBe(true);
    }
    expect(classifyRedisCommand(['CONFIG', 'GET', 'x']).dangerous).toBe(false);
    expect(classifyRedisCommand(['CLIENT', 'LIST']).dangerous).toBe(false);
    expect(classifyRedisCommand(['GET', 'k'])).toEqual({ name: 'GET', dangerous: false, status: false });
  });
  it('refuses blocking, subscribe, transaction and connection commands in the console', () => {
    expect(classifyRedisCommand(['BLPOP', 'k', '0']).refused).toBe('blocking');
    expect(classifyRedisCommand(['monitor']).refused).toBe('blocking');
    expect(classifyRedisCommand(['XREAD', 'BLOCK', '0', 'STREAMS', 's', '$']).refused).toBe('blocking');
    expect(classifyRedisCommand(['XREAD', 'STREAMS', 's', '0']).refused).toBeUndefined();
    expect(classifyRedisCommand(['SUBSCRIBE', 'c']).refused).toBe('subscribe');
    expect(classifyRedisCommand(['psubscribe', 'c*']).refused).toBe('subscribe');
    expect(classifyRedisCommand(['MULTI']).refused).toBe('transaction');
    expect(classifyRedisCommand(['WATCH', 'k']).refused).toBe('transaction');
    expect(classifyRedisCommand(['AUTH', 'pw']).refused).toBe('connection');
    expect(classifyRedisCommand(['CLIENT', 'REPLY', 'OFF']).refused).toBe('connection');
    expect(classifyRedisCommand(['HELLO', '3']).refused).toBe('connection');
  });
  it('marks status replies (SET without GET, TYPE, PING)', () => {
    expect(classifyRedisCommand(['SET', 'k', 'v']).status).toBe(true);
    expect(classifyRedisCommand(['SET', 'k', 'v', 'GET']).status).toBe(false);
    expect(classifyRedisCommand(['TYPE', 'k']).status).toBe(true);
    expect(classifyRedisCommand(['GET', 'k']).status).toBe(false);
  });
});

describe('server views', () => {
  it('parses INFO sections, the keyspace and CLIENT LIST', () => {
    const info = parseRedisInfo('# Server\r\nredis_version:7.2.4\r\nos:Linux\r\n\r\n# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=500\r\ndb5:keys=1,expires=0,avg_ttl=0\r\n');
    expect(info).toEqual([
      { name: 'Server', entries: [['redis_version', '7.2.4'], ['os', 'Linux']] },
      { name: 'Keyspace', entries: [['db0', 'keys=3,expires=1,avg_ttl=500'], ['db5', 'keys=1,expires=0,avg_ttl=0']] },
    ]);
    expect(parseRedisKeyspace(info)).toEqual([{ index: 0, keys: 3, expires: 1, avgTtlMs: 500 }, { index: 5, keys: 1, expires: 0, avgTtlMs: 0 }]);
    expect(parseRedisClientList('id=3 addr=127.0.0.1:5000 name=unimux db=0 cmd=client|list\nid=4 addr=x name= db=2\n')).toEqual([
      { id: '3', addr: '127.0.0.1:5000', name: 'unimux', db: '0', cmd: 'client|list' }, { id: '4', addr: 'x', name: '', db: '2' },
    ]);
  });
  it('steps stream ids for paging both ways', () => {
    expect(streamIdStep('5-1', 1)).toBe('5-2');
    expect(streamIdStep('5-0', -1)).toBe('4-18446744073709551615');
    expect(streamIdStep('5-18446744073709551615', 1)).toBe('6-0');
    expect(streamIdStep('0-0', -1)).toBeNull();
    expect(streamIdStep('x', 1)).toBeNull();
    expect(isStreamId('1-2')).toBe(true);
    expect(isStreamId('1')).toBe(false);
  });
  it('every new Redis error code has a translated text', () => {
    const codes: DbErrorCode[] = ['keyExists', 'wrongType', 'needsConfirm', 'blockingCommand', 'subscribeCommand', 'consoleUnsupported', 'staleToken'];
    for (const c of codes) {
      const key = dbErrorText(c).key;
      expect(key in messages, c).toBe(true);
    }
  });
});
