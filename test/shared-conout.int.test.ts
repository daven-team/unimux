// 1.0.5 performance: every Windows terminal of the Pty Host shares one ConPTY output thread (src/ptyhost/sharedConout.ts)
// instead of a node-pty Worker (about 9 MB) each. Real cmd.exe shells in real ConPTY.
import { describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/shared/env';
import { PtyManager } from '../src/ptyhost/manager';
import { CONOUT_DRAIN_MS, sharedConoutStats } from '../src/ptyhost/sharedConout';

const windows = process.platform === 'win32';
const env = cleanEnv(process.env);

async function waitFor(cond: () => boolean, ms: number, what: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!windows || process.env.UNIMUX_CONOUT_PER_TERMINAL === '1')('shared ConPTY output thread (real cmd.exe)', () => {
  it('serves several terminals from one thread, keeps their output apart and goes once the last one closed', async () => {
    const out = new Map<string, string>();
    const exits: string[] = [];
    const m = new PtyManager({ data: (id, d) => (out.set(id, (out.get(id) ?? '') + d), true), exit: (id) => exits.push(id) });
    const ids = ['a', 'b', 'c', 'd'];
    const before = sharedConoutStats().started;
    for (const id of ids) m.spawn({ id, cwd: process.cwd(), cols: 120, rows: 30, env, shell: 'cmd', command: `echo MARK-${id}-%COMPUTERNAME:~0,0%DONE` });
    try {
      await waitFor(() => ids.every((id) => (out.get(id) ?? '').includes(`MARK-${id}-DONE`)), 15000, 'every terminal printed its marker');
      for (const id of ids) for (const other of ids) if (other !== id) expect(out.get(id)).not.toContain(`MARK-${other}-DONE`);
      expect(sharedConoutStats()).toMatchObject({ open: 4, running: true });
      expect(sharedConoutStats().started - before).toBe(1);

      // One terminal ends: the others keep their output.
      await m.kill('a', 3000);
      await new Promise((r) => setTimeout(r, CONOUT_DRAIN_MS + 300));
      expect(sharedConoutStats()).toMatchObject({ open: 3, running: true });
      m.write('b', 'echo AFTER-%COMPUTERNAME:~0,0%KILL\r');
      await waitFor(() => (out.get('b') ?? '').includes('AFTER-KILL'), 10000, 'terminal b still prints after a closes');
    } finally {
      await m.killAll(3000);
    }
    await waitFor(() => sharedConoutStats().open === 0 && !sharedConoutStats().running, CONOUT_DRAIN_MS + 5000, 'the thread goes with the last terminal');
  }, 40000);

  // node-pty's own Worker stayed after such an exit (with the ConPTY DLL nothing disposed it): about 9.8 MB and a thread each.
  it('lets go of the pipe of a terminal that exited by itself, after its last output arrived', async () => {
    let out = '';
    let exited = false;
    const m = new PtyManager({ data: (_id, d) => ((out += d), true), exit: () => { exited = true; } });
    m.spawn({ id: 'x', cwd: process.cwd(), cols: 120, rows: 30, env, shell: 'cmd', command: 'echo BYE-%COMPUTERNAME:~0,0%NOW & exit' });
    try {
      await waitFor(() => exited, 15000, 'the shell exited');
      expect(out).toContain('BYE-NOW');
      await waitFor(() => sharedConoutStats().open === 0 && !sharedConoutStats().running, 5000, 'the pipe and the thread are gone');
    } finally {
      await m.killAll(3000);
    }
  }, 30000);

  it('delivers the output of a process that ends at once, and lets go of its pipe', async () => {
    const pty = await import('node-pty');
    for (let i = 0; i < 5; i++) {
      let out = '';
      const p = pty.spawn('cmd.exe', ['/c', `echo QUICK-${i}`], { cols: 80, rows: 24, env, useConpty: true, useConptyDll: true });
      p.onData((d) => { out += d; });
      await new Promise<void>((resolve) => p.onExit(() => resolve()));
      await waitFor(() => out.includes(`QUICK-${i}`), 3000, `output of run ${i}`);
    }
    await waitFor(() => sharedConoutStats().open === 0 && !sharedConoutStats().running, 8000, 'every pipe and the thread are gone');
  }, 40000);
});
