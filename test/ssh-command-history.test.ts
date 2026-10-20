import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIpcGuard, type IpcSenderEvent } from '../src/main/ipcGuard';
import { CommandHistoryStore, registerCommandHistoryIpc } from '../src/main/ssh/commandHistory';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const GONE = '00000000-0000-4000-8000-0000000000ff';

let dir: string;
let file: string;
let hosts: Set<string>;
let clock: number;
const open = () => new CommandHistoryStore(file, { hostExists: (id) => hosts.has(id), now: () => clock, writeDelayMs: 60_000 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unimux-history-'));
  file = join(dir, 'ssh', 'command_history.json');
  hosts = new Set([A, B]);
  clock = 1000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CommandHistoryStore (main)', () => {
  it('records per host, most recent first, and writes the file on flush', () => {
    const store = open();
    expect(store.record(A, 'ls -la')).toBe(true);
    clock = 2000;
    expect(store.record(A, 'uptime')).toBe(true);
    expect(store.record(B, 'df -h')).toBe(true);
    expect(store.list(A).map((e) => e.command)).toEqual(['uptime', 'ls -la']);
    expect(store.counts()).toEqual({ [A]: 2, [B]: 1 });
    expect(existsSync(file)).toBe(false); // batched
    store.flush();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.hosts[A]).toEqual([{ command: 'uptime', count: 1, lastUsed: 2000 }, { command: 'ls -la', count: 1, lastUsed: 1000 }]);
    expect(open().list(B)).toEqual([{ command: 'df -h', count: 1, lastUsed: 2000 }]);
  });

  it('refuses unknown hosts and lines that are never kept', () => {
    const store = open();
    for (const [host, command] of [[GONE, 'ls'], ['nope', 'ls'], [A, ' secret'], [A, ''], [A, 'a\x1bb'], [A, 'ls   '], [A, 42], [A, '****']] as const) {
      expect(store.record(host, command), `${host} ${JSON.stringify(command)}`).toBe(false);
    }
    expect(store.list(GONE)).toEqual([]);
    expect(store.list(undefined)).toEqual([]);
    expect(store.counts()).toEqual({});
  });

  it('clears one host or every host and writes that at once', () => {
    const store = open();
    store.record(A, 'ls');
    store.record(B, 'pwd');
    expect(store.clear(A)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).hosts).toEqual({ [B]: [{ command: 'pwd', count: 1, lastUsed: 1000 }] });
    expect(store.clear(null)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).hosts).toEqual({});
    expect(store.clear('bad')).toBe(false);
  });

  it('drops the history of a deleted host when it writes', () => {
    const store = open();
    store.record(A, 'ls');
    store.record(B, 'pwd');
    hosts.delete(B);
    expect(store.counts()).toEqual({ [A]: 1 });
    store.flush();
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).hosts)).toEqual([A]);
  });

  it('never writes over a file from a newer version or one it does not understand', () => {
    mkdirSync(join(dir, 'ssh'), { recursive: true });
    const newer = JSON.stringify({ version: 9, hosts: { [A]: [{ command: 'ls', count: 1, lastUsed: 1 }] } });
    writeFileSync(file, newer);
    const store = open();
    expect(store.list(A).map((e) => e.command)).toEqual(['ls']);
    expect(store.readOnly()).toBe(true);
    // Settings > SSH explains it with the file path.
    expect(store.status()).toEqual({ counts: { [A]: 1 }, readOnly: true, file });
    expect(store.record(A, 'pwd')).toBe(false);
    expect(store.clear(null)).toBe(false);
    store.flush();
    expect(readFileSync(file, 'utf8')).toBe(newer);
    writeFileSync(file, JSON.stringify([1, 2]));
    expect(open().record(A, 'pwd')).toBe(false);
  });

  it('keeps an unparsable file as a backup and starts empty', () => {
    mkdirSync(join(dir, 'ssh'), { recursive: true });
    writeFileSync(file, '{ broken');
    const store = open();
    expect(store.list(A)).toEqual([]);
    expect(store.record(A, 'ls')).toBe(true);
    store.flush();
    expect(readdirSync(join(dir, 'ssh')).some((name) => name.startsWith('command_history.json.bak-'))).toBe(true);
    expect(open().list(A).map((e) => e.command)).toEqual(['ls']);
  });

  it('answers the app window only, through the IPC guard', async () => {
    const invokes = new Map<string, (event: IpcSenderEvent, ...args: unknown[]) => unknown>();
    const sends = new Map<string, (event: IpcSenderEvent, ...args: unknown[]) => void>();
    const ipc = {
      handle: (channel: string, fn: (event: IpcSenderEvent, ...args: unknown[]) => unknown) => { invokes.set(channel, fn); },
      on: (channel: string, fn: (event: IpcSenderEvent, ...args: unknown[]) => void) => { sends.set(channel, fn); },
    };
    const store = open();
    registerCommandHistoryIpc(createIpcGuard(ipc as never, (event) => event.sender === 'app'), store);
    const app = { sender: 'app' };
    const foreign = { sender: 'other' };
    sends.get('ssh:history:record')!(foreign, A, 'whoami');
    sends.get('ssh:history:record')!(app, A, 'id');
    expect(await invokes.get('ssh:history:list')!(foreign, A)).toEqual([]);
    expect(await invokes.get('ssh:history:list')!(app, A)).toEqual([{ command: 'id', count: 1, lastUsed: 1000 }]);
    expect(await invokes.get('ssh:history:status')!(app)).toEqual({ counts: { [A]: 1 }, readOnly: false, file });
    expect(await invokes.get('ssh:history:status')!(foreign)).toEqual({ counts: {}, readOnly: false, file: '' });
    expect(await invokes.get('ssh:history:clear')!(foreign, A)).toEqual({ ok: false });
    expect(await invokes.get('ssh:history:clear')!(app, A)).toEqual({ ok: true });
    expect(store.list(A)).toEqual([]);
  });
});
