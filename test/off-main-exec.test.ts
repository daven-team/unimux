import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { queueCodexMessage } from '../src/main/agentDelivery';
import { execOffMain, type ExecCall, type ExecHostChild, type ExecHostReply, type ExecHostRequest } from '../src/main/offMainExec';

/** A fake utility process: records what main posts, answers or exits when the test says so. */
function fakeHost() {
  const posted: ExecHostRequest[] = [];
  const listeners: { message: ((m: ExecHostReply) => void)[]; exit: ((code: number) => void)[] } = { message: [], exit: [] };
  let killed = 0;
  const child: ExecHostChild = {
    postMessage: (m) => { posted.push(m); },
    on: ((event: 'message' | 'exit', l: never) => { (listeners[event] as unknown[]).push(l); return child; }) as ExecHostChild['on'],
    kill: () => { killed++; return true; },
  };
  return {
    child, posted, killed: () => killed,
    reply: (m: ExecHostReply) => listeners.message.forEach((l) => l(m)),
    exit: (code: number) => listeners.exit.forEach((l) => l(code)),
  };
}

const call: ExecCall = { file: 'C:\\codex\\codex.exe', args: ['queue', '--thread', 's1', '--message', 'a "b" & %PATH% $(x)'], env: { Path: 'x' }, timeout: 10000 };

describe('a program started outside the main process (1.0.9)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('posts the call with its argv untouched and resolves with the host answer, then ends the host', async () => {
    const host = fakeHost();
    const run = execOffMain(call, () => host.child);
    expect(host.posted).toEqual([{ t: 'run', call }]);
    host.reply({ t: 'done', ok: true });
    await expect(run).resolves.toBe(true);
    expect(host.killed()).toBe(1);

    const failing = fakeHost();
    const failed = execOffMain(call, () => failing.child);
    failing.reply({ t: 'done', ok: false });
    await expect(failed).resolves.toBe(false);
  });

  it('fails when the host ends without an answer, cannot start, or overruns the program timeout', async () => {
    const gone = fakeHost();
    const run = execOffMain(call, () => gone.child);
    gone.exit(1);
    await expect(run).resolves.toBe(false);

    await expect(execOffMain(call, () => { throw new Error('no fork'); })).resolves.toBe(false);

    vi.useFakeTimers();
    const hung = fakeHost();
    const slow = execOffMain(call, () => hung.child, 5000);
    await vi.advanceTimersByTimeAsync(call.timeout + 4999);
    hung.reply({ t: 'done', ok: true }); // still in time
    await expect(slow).resolves.toBe(true);
    const stuck = fakeHost();
    const late = execOffMain(call, () => stuck.child, 5000);
    await vi.advanceTimersByTimeAsync(call.timeout + 5000);
    await expect(late).resolves.toBe(false);
    expect(stuck.killed()).toBe(1);
    stuck.reply({ t: 'done', ok: true }); // too late: ignored
  });

  it('keeps the delivery error of a failed queue, whatever runs it', async () => {
    await expect(queueCodexMessage('s1', 'private prompt', { platform: 'win32', command: 'C:\\codex\\codex.exe', env: {} }, async () => false)).rejects.toThrow('item remains in the inbox');
    let seen: ExecCall | undefined;
    await queueCodexMessage('s1', 'hi', { platform: 'win32', command: 'C:\\codex\\codex.exe', env: {} }, async (c) => { seen = c; return true; });
    expect(seen).toEqual({ file: 'C:\\codex\\codex.exe', args: ['queue', '--thread', 's1', '--message', 'hi'], env: {}, timeout: 10000 });
  });

  it('main delivers through the Exec Host, and the host runs the program without a shell', () => {
    const main = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');
    expect(main).toMatch(/queueCodexMessage\([\s\S]*?\(call\) => execOffMain\(call, forkExecHost\)\)/);
    const runner = readFileSync(join(__dirname, '../src/main/offMainExec.ts'), 'utf8');
    expect(runner).not.toMatch(/shell:\s*true/);
    expect(readFileSync(join(__dirname, '../electron.vite.config.ts'), 'utf8')).toContain("exechost: resolve(__dirname, 'src/exechost/index.ts')");
  });
});
