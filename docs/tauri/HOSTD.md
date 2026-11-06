# unimux-hostd: the dual host for the `.int` suites (B1)

`unimux-hostd` (src-tauri/crates/unimux-hostd) is a test binary, never shipped. It lets the existing Node integration
suites and the Node fake servers (pgFakeServer, mysqlFakeServer, respServer, sshServer, pglite-socket) drive the Rust
ports unchanged: a suite runs once against the TS code in the vitest process (the `node` host) and once against the Rust
code through hostd (the `rust` host). Both must pass; that is the parity check for every host domain package (P1/P2 pty,
P5 ssh, T2 sftp, D2 tunnels, D4/D7/D9 databases).

## Running

| command | what runs |
|---|---|
| `npm test` | every suite on the `node` host only (unless `UNIMUX_HOSTD` names a binary, then both) |
| `npm run test:hostd` | builds hostd (`cargo build -p unimux-hostd` through scripts/msvc-run.mjs) and runs the hostd suites on the `rust` host |
| `UNIMUX_HOST_TARGETS=node,rust npm run test:hostd` | both hosts side by side |
| `npm run test:hostd -- --reporter=verbose` | extra arguments go to vitest |

Environment:

- `UNIMUX_HOST_TARGETS` - comma list of `node`, `rust`. Unknown names fail the run.
- `UNIMUX_HOSTD` - a prebuilt binary (skips the build in `test:hostd`; in `npm test` it adds the `rust` host).
- `CARGO_TARGET_DIR` - where the debug binary is looked for (default `src-tauri/target`).
- `UNIMUX_CONPTY_DIR` - Windows: the folder with `conpty.dll` + `OpenConsole.exe`. The helper sets it to node-pty's bundled
  copy in node_modules (1.23, the one 1.1.4 ships), so both hosts run on the same ConPTY build.
- `UNIMUX_HOSTD_TRACE=1` - hostd logs every pty read to stderr; the client keeps the last 8 KB of stderr and adds it to the
  error when the host dies.

CI: `.github/workflows/tauri.yml` runs `npm run test:hostd` with `UNIMUX_HOST_TARGETS=rust` on Windows and macOS after
`cargo test --workspace`; the `node` host of the same suites runs in `npm test`.

## Wire

One JSON object per line in both directions (UTF-8, `\n`), src/protocol.rs:

- request: `{"id": 7, "op": "pty.spawn", "args": {...}}`
- answer: `{"id": 7, "ok": true, "result": ...}` or `{"id": 7, "ok": false, "error": "text"}`; exactly one per request, in
  any order (an op that waits, such as `pty.killAll`, answers from its own thread). A line that is not a request gets
  `{"id": null, "ok": false, "error": "bad request: ..."}`.
- event: `{"event": "pty.data", "args": {...}}` (never an `id`).

Requests are handled in arrival order, so a `pty.write` sent after a `pty.spawn` always finds the terminal even when the
Node side does not await the spawn (1.1.4's PtyManager calls are synchronous; the suites keep that shape).

Lifetime: when stdin closes (the test called `close()` or the test process died) hostd kills every terminal it started with
its process tree and exits 0. The Node child process handle is `unref()`ed. All three stdio
handles are pipes (never inherit mixed with pipe), the child is started with `windowsHide`.

Built-in ops: `ping` -> `"pong"`, `version`, `info` -> `{version, platform, pid, domains}`.

## Domains

### `pty.*` (B1)

The PtyManager surface (src/ptyhost/manager.ts) that test/ptyhost.int.test.ts drives:

| op | args | result |
|---|---|---|
| `pty.spawn` | SpawnRequest `{id, cwd, cols, rows, env, shell, command?}` | `{pid, source}` (`bundled:<dir>`, `inbox`, `openpty`) |
| `pty.write` | `{id, data}` | null (unknown id: no-op) |
| `pty.resize` | `{id, cols, rows}` | null |
| `pty.has` | `{id}` | boolean |
| `pty.histories` | | `[{id, data}]`, oldest spawn first, 512 Ki UTF-16 unit tail |
| `pty.kill` | `{id, timeoutMs?}` | null once the process ended or after the timeout (default 3000) |
| `pty.killAll` | `{timeoutMs?}` | null; terminals still running at the deadline get their tree killed |
| `pty.resolveShell` | `{shell, env, platform?}` | `{file, args}` (resolveShell port) |

Events: `pty.data {id, data}` (UTF-8 decoded like node-pty's onData: a split sequence is held back, invalid bytes become
U+FFFD) and `pty.exit {id, code}` (only for a terminal that ended by itself, after its output; a killed one is gone
without an exit, as in PtyManager).

Rules kept from 1.1.4: size clamped to at least 2 x 1, env plus `TERM=xterm-256color`, `COLORTERM=truecolor`,
`TERM_PROGRAM=unimux`, the startup command typed 150 ms after the first output, a respawned id kills the old terminal and
mutes its output and exit, `has` is false before the exit event.

Backends: Windows on `unimux_pty::conpty` (SP5: bundled conpty.dll + OpenConsole, flags 0, Job Object, node-pty's kill
order). Unix on a stand-in in `pty/unix.rs` (openpty, setsid + TIOCSCTTY, SIGHUP to the group on kill, SIGKILL for the
tree). OpenConsole 1.23 asks a new terminal for its device attributes (`ESC [ c`) and holds the output up to about 3 s;
with no xterm.js attached hostd answers `ESC [ ? 1 ; 2 c` once, like xterm.js (P2 must do the same while no renderer is
attached).

Not ported here (P1 / P2 scope; the suite does not check them): shell integration (`integratedLaunch`, prompt marks),
OutputChannel coalescing / FlowGate / ack back-pressure, the echo fast path, `setSink`, `setFlowControl`. When P1 / P2
land their production manager, `pty/mod.rs` switches to it and the same suite checks their code.

## Adding a domain (ssh, sftp, db, ...)

1. Add `src/<domain>/mod.rs` with a `handle(&self, op, args, reply)` like `pty::PtyHost`, built on the production crate
   (unimux-ssh, unimux-db, ...), and one arm in `Host::dispatch` in main.rs plus its name in `info.domains`.
2. Answer through `Reply` (`ok`, `err`, `send`); move it to a thread for anything that waits. Emit events with
   `Out::event("<domain>.<name>", args)`. Tear everything down in `Host::shutdown`.
3. Add the Node side to test/helpers/nodeHost.ts: an interface with the TS class's surface, a `node` implementation that
   wraps the TS class, a `rust` one over `HostdClient`, and a `create<Thing>(target, ...)` factory.
4. Change the suite to `describe.each(hostTargets())` over that factory (awaiting calls that are synchronous on the node
   host works for both) and add it to `HOSTD_SUITES` in scripts/test-hostd.mjs.
5. Cover the wire of the new ops in `tests/stdio.rs` (cargo test runs on every OS without Node).
