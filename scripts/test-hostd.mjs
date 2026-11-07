// `npm run test:hostd`: builds unimux-hostd (the B1 stdio test host, docs/tauri/HOSTD.md) and runs the `.int` suites that
// have a rust host against it. Extra arguments go to vitest (`npm run test:hostd -- --reporter=verbose`).
//
//   UNIMUX_HOST_TARGETS  hosts to run (default here: rust; `node,rust` runs both side by side)
//   UNIMUX_HOSTD         a prebuilt binary (skips the cargo build)
//   CARGO_TARGET_DIR     where cargo builds (the binary is taken from <dir>/debug)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The suites that run on the rust host; a package that ports a host domain adds its suite here. */
const HOSTD_SUITES = ['test/ptyhost.int.test.ts'];

function run(cmd, args, env = process.env) {
  // shell only for npx on Windows (a .cmd); arguments are fixed strings or the user's own vitest flags.
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env, shell: process.platform === 'win32' && cmd === 'npx' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

const env = { ...process.env };
if (!env.UNIMUX_HOSTD) {
  const status = run(process.execPath, [join(ROOT, 'scripts', 'msvc-run.mjs'), 'cargo', 'build', '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml'), '-p', 'unimux-hostd']);
  if (status !== 0) process.exit(status);
}
env.UNIMUX_HOST_TARGETS ??= 'rust';
process.exit(run('npx', ['vitest', 'run', ...HOSTD_SUITES, ...process.argv.slice(2)], env));
