// Compile check of the macOS code paths on a Windows machine without a Mac (PLAN W2): `cargo check` / `cargo clippy` for
// aarch64-apple-darwin (rustup target add aarch64-apple-darwin). Build scripts of objc2-exception-helper and friends call a C
// compiler for the Apple target, which Windows does not have; a check never links, so a stand-in compiler and archiver that
// write empty outputs are enough. Type checking of every Rust crate (incl. objc2, tao, wry, tauri macOS code) is real.
//
//   node scripts/mac-check.mjs                 cargo check -p unimux-app (features dev-overrides,test-bridge) + workspace
//   node scripts/mac-check.mjs clippy          the same with clippy -D warnings
//   node scripts/mac-check.mjs -- <cargo args> any cargo command for the macOS target
//
// Output in src-tauri/target/maccheck (own target dir). Never builds a binary: that needs a Mac (macos-latest in CI).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = join(root, 'src-tauri');
const target = join(tauri, 'target', 'maccheck');
const stubs = join(target, 'stubcc');
const TRIPLE = 'aarch64-apple-darwin';

function writeStubs() {
  mkdirSync(stubs, { recursive: true });
  mkdirSync(join(target, 'fake-sdk'), { recursive: true });
  writeFileSync(join(stubs, 'stub.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    'const [mode, ...args] = process.argv.slice(2);',
    "if (mode === 'cc') { const i = args.indexOf('-o'); if (i >= 0) writeFileSync(args[i + 1], ''); }",
    "else { const out = args.find((a) => a.endsWith('.a')); if (out) writeFileSync(out, '!<arch>\\n'); }",
    '',
  ].join('\n'));
  if (process.platform === 'win32') {
    writeFileSync(join(stubs, 'cc.cmd'), '@node "%~dp0stub.mjs" cc %*\r\n');
    writeFileSync(join(stubs, 'ar.cmd'), '@node "%~dp0stub.mjs" ar %*\r\n');
  } else {
    writeFileSync(join(stubs, 'cc'), `#!/bin/sh\nexec node "${join(stubs, 'stub.mjs')}" cc "$@"\n`, { mode: 0o755 });
    writeFileSync(join(stubs, 'ar'), `#!/bin/sh\nexec node "${join(stubs, 'stub.mjs')}" ar "$@"\n`, { mode: 0o755 });
  }
}

function cargo(args) {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const env = {
    ...process.env,
    PATH: `${join(homedir(), '.cargo', 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    CARGO_TARGET_DIR: target,
    CC_aarch64_apple_darwin: join(stubs, `cc${ext}`),
    AR_aarch64_apple_darwin: join(stubs, `ar${ext}`),
    SDKROOT: join(target, 'fake-sdk'),
  };
  console.log(`> cargo ${args.join(' ')}`);
  const r = spawnSync('cargo', args, { cwd: tauri, env, stdio: 'inherit', shell: false });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

writeStubs();
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
let code = 0;
if (dash >= 0) {
  // `--target` right after the subcommand: after a `--` it would go to rustc / clippy-driver instead of cargo.
  const [sub, ...rest] = argv.slice(dash + 1);
  code = cargo([sub, '--target', TRIPLE, ...rest]);
}
else {
  const tool = argv[0] === 'clippy' ? 'clippy' : 'check';
  const lint = tool === 'clippy' ? ['--', '-D', 'warnings'] : [];
  code ||= cargo([tool, '--target', TRIPLE, '--workspace', '--all-targets', ...lint]);
  code ||= cargo([tool, '--target', TRIPLE, '-p', 'unimux-app', '--all-targets', '--features', 'unimux-app/dev-overrides,unimux-app/test-bridge', ...lint]);
}
process.exit(code);
