// SP5: keystroke-to-echo latency at the pty layer of 1.1.4 (node-pty 1.1.0, useConpty + useConptyDll, the same options as
// src/ptyhost/manager.ts), the Node side of src-tauri/crates/unimux-pty/examples/sp5_echo.rs (same method: cmd.exe, one
// character written, time until it comes back outside escape sequences; spaced = one key every 120 ms, burst = 6 keys
// 25 ms apart). node-pty runs in this Node process the way it ran in 1.1.4's pty host process.
//
//   node scripts/sp5/echo-node-pty.mjs [keys=60] [--shared]
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pty = require('node-pty');

// --shared: 1.1.4's pty host setup (src/ptyhost/manager.ts installs the shared conout thread before the first spawn).
if (process.argv.includes('--shared')) {
  const { installSharedConout } = (await runnerImport(resolve(root, 'src/ptyhost/sharedConout.ts'), { configFile: false, logLevel: 'silent', root })).module;
  installSharedConout(require('node-pty/lib/windowsConoutConnection.js'));
}

const keys = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = pty.spawn('cmd.exe', [], {
  name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'unimux' },
  useConpty: true, useConptyDll: true,
});
let all = '';
let vt = 0;
const queue = [];
const latencies = [];
proc.onData((d) => {
  const now = performance.now();
  all += d;
  for (const ch of d) {
    const b = ch.charCodeAt(0);
    if (vt === 0) {
      if (b === 0x1b) vt = 1;
      else if (queue.length && queue[0][0] === ch) latencies.push(now - queue.shift()[1]);
    } else if (vt === 1) vt = ch === '[' ? 2 : ch === ']' || ch === 'P' ? 3 : 0;
    else if (vt === 2) { if (b >= 0x40 && b <= 0x7e) vt = 0; }
    else if (vt === 3) { if (b === 0x07) vt = 0; else if (b === 0x1b) vt = 1; }
  }
});
const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(2); } return pred(); };
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.round((s.length - 1) * p)]; };

(async () => {
  if (await waitFor(() => all.includes('\x1b[c'), 4000)) proc.write('\x1b[?1;2c');
  if (!await waitFor(() => all.includes('>'), 10000)) throw new Error('no prompt');
  await sleep(1500);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let i = 0;
  const run = async (burst) => {
    latencies.length = 0;
    while (latencies.length < keys) {
      for (let k = 0; k < burst; k++) {
        const c = letters[i++ % letters.length];
        queue.push([c, performance.now()]);
        proc.write(c);
        if (k + 1 < burst) await sleep(25);
      }
      if (!await waitFor(() => queue.length === 0, 5000)) throw new Error('echo missing');
      await sleep(60);
      proc.write('\b'.repeat(burst));
      await sleep(120);
    }
    return latencies.slice(0, keys);
  };
  const spaced = await run(1);
  const burst = await run(6);
  console.log(JSON.stringify({ impl: 'node-pty', shared: process.argv.includes('--shared'), version: require('node-pty/package.json').version, spaced: { p50: pct(spaced, 0.5), p95: pct(spaced, 0.95) }, burst: { p50: pct(burst, 0.5), p95: pct(burst, 0.95) } }));
  proc.kill();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
