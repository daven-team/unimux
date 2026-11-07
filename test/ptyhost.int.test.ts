import { basename } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/shared/env';
import { createPtyManager, hostTargets, type PtyHost, type PtySinkLike } from './helpers/nodeHost';

function collect() {
  const out = new Map<string, string>();
  const exits = new Map<string, number>();
  const sink = {
    data: (id: string, d: string) => out.set(id, (out.get(id) ?? '') + d),
    exit: (id: string, code: number) => exits.set(id, code),
  };
  return { out, exits, sink };
}

async function waitFor(cond: () => boolean, ms = 15000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const env = cleanEnv(process.env);

const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
const alternateShell = process.platform === 'win32' ? 'cmd' : 'zsh';

// B1 dual host: the TS PtyManager in this process ("node") and the Rust port through unimux-hostd ("rust"); see
// test/helpers/nodeHost.ts for UNIMUX_HOST_TARGETS / UNIMUX_HOSTD.
describe.each(hostTargets())('PtyManager (real PTY, %s host)', (target) => {
  const open: PtyHost[] = [];
  afterEach(async () => {
    for (const m of open.splice(0)) await m.close();
  });
  async function manager(sink: PtySinkLike): Promise<PtyHost> {
    const m = await createPtyManager(target, sink);
    open.push(m);
    return m;
  }

  it('runs the startup command in the given cwd and reports exit', async () => {
    const { out, exits, sink } = collect();
    const m = await manager(sink);
    m.spawn({ id: 'a', cwd: process.cwd(), cols: 100, rows: 30, env, shell, command: process.platform === 'win32'
      ? 'echo "mc-$((1+1))-ok"; (Get-Location).Path'
      : 'printf "mc-%s-ok\\n" "$((1+1))"; pwd' });
    await waitFor(() => (out.get('a') ?? '').includes('mc-2-ok'));
    expect(out.get('a')).toContain(basename(process.cwd()));
    m.resize('a', 80, 20);
    m.write('a', 'exit\r');
    await waitFor(() => exits.has('a'));
    expect(await m.has('a')).toBe(false);
  });

  it('killAll resolves once all terminals are gone', async () => {
    const { out, sink } = collect();
    const m = await manager(sink);
    m.spawn({ id: 'x', cwd: process.cwd(), cols: 80, rows: 24, env, shell });
    m.spawn({ id: 'y', cwd: process.cwd(), cols: 80, rows: 24, env, shell: alternateShell });
    // Killing a ConPTY while its shell is still starting can crash the native module; wait until both shells are up.
    await waitFor(() => out.has('x') && out.has('y'));
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await m.killAll(5000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await m.has('x')) || (await m.has('y'))).toBe(false);
  });

  it('keeps a replay history per terminal', async () => {
    const { out, sink } = collect();
    const m = await manager(sink);
    m.spawn({ id: 'h', cwd: process.cwd(), cols: 80, rows: 24, env, shell: alternateShell, command: process.platform === 'win32' ? 'echo replay-me' : 'printf "replay-%s\\n" me' });
    await waitFor(() => (out.get('h') ?? '').includes('replay-me'));
    expect((await m.histories()).find((h) => h.id === 'h')!.data).toContain('replay-me');
    // The replay tail records the start size and every resize at the position the output had reached (TailBuffer.size).
    await m.resize('h', 100, 30);
    m.write('h', process.platform === 'win32' ? 'echo after-resize\r' : 'printf "after-%s\\n" resize\r');
    await waitFor(() => (out.get('h') ?? '').includes('after-resize'));
    const h = (await m.histories()).find((x) => x.id === 'h')!;
    expect(h.sizes?.[0]).toEqual({ at: 0, cols: 80, rows: 24 });
    const last = h.sizes![h.sizes!.length - 1];
    expect(last).toMatchObject({ cols: 100, rows: 30 });
    expect(last.at).toBeGreaterThan(h.data.indexOf('replay-me'));
    expect(last.at).toBeLessThanOrEqual(h.data.lastIndexOf('after-resize'));
    await m.killAll();
  });

  // node-pty 1.1.0 (unixTerminal.js DESTROY_SOCKET_TIMEOUT_MS): the exit comes at most 200 ms after the shell ended, even
  // when a background job still holds the terminal.
  it.skipIf(process.platform === 'win32')('reports the exit of a shell whose background job keeps the terminal open', async () => {
    const { exits, sink } = collect();
    const m = await manager(sink);
    m.spawn({ id: 'bg', cwd: process.cwd(), cols: 80, rows: 24, env, shell, command: 'sleep 30 & exit' });
    const t0 = Date.now();
    await waitFor(() => exits.has('bg'), 10000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await m.has('bg')).toBe(false);
  });

  // node-pty sets PWD to the cwd, so a shell started through a symlink keeps the logical path.
  it.skipIf(process.platform === 'win32')('starts the shell with PWD set to the cwd as given (symlinks kept)', async () => {
    const { mkdtempSync, symlinkSync, rmSync, realpathSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const dir = mkdtempSync(join(tmpdir(), 'unimux-pwd-'));
    const link = join(dir, 'link');
    symlinkSync(realpathSync(process.cwd()), link);
    try {
      const { out, sink } = collect();
      const m = await manager(sink);
      m.spawn({ id: 'p', cwd: link, cols: 200, rows: 24, env, shell, command: 'printf "pwd=[%s]\\n" "$(pwd)"' });
      await waitFor(() => (out.get('p') ?? '').includes(`pwd=[${link}]`));
      await m.killAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
