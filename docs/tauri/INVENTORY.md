# unimux 1.1.4 inventory for the Tauri migration

Condensed from the per-unit analysis (2026-11-06). Line counts are TS source lines. "Moves in" names the release of the superseded staged plan; since the user's ALL-AT-ONCE decision (2026-11-06) every unit moves to Rust in 1.2.0 (see PLAN.md for the packages). Full API lists live in the source: `src/preload/api.d.ts` (window.mc contract), `src/shared/ipc.ts`, `src/shared/dbHostIpc.ts`, `src/shared/sftpHostIpc.ts`.

| Unit | LOC | Moves in | Port effort if fully Rust (days) |
|---|---|---|---|
| core (lifecycle, windows, IPC guard, state, gates, quit, data dir, detached, notifications) | 4,446 | shell in 1.2.0, state 1.6.0 | 27 |
| preload-ipc (window.mc bridge) | 617 | 1.2.0 | 9 |
| pty (Pty Host, ConPTY, flow control, SSH shell cells, launch line) | 2,456 | data plane 1.2.0, spawn/SSH 1.4.0 | 16 |
| agents-hooks (hook server, CLI detect/install, context, sessions, conv search) | 3,354 | 1.3.0 | 14 |
| mcp-automation | 2,503 | 1.6.0 | 14 |
| accounts-usage (accounts, logins, swaps, usage, auto-switch, cipher, GitHub) | 7,272 | cipher 1.2.0, rest 1.6.0 | 22 |
| git-files (git, files, file ops, search, monitor, changelog, notes) | 2,688 | 1.3.0 | 14 |
| ssh-sftp | 4,220 | 1.4.0 | 22 |
| db | 9,100 | 1.5.0 | 32 |
| update-packaging | 3,350 | 1.2.0 | 11 |
| renderer-electron-deps | 1,900 | 1.2.0 | 9 |
| shared-and-tests (src/shared 28,798; test/ 54,090; scripts 15,390) | 98,278 | per port | 28 |

---

## 1. core

Files: src/main/index.ts 2269, detachedWindows.ts 478, startupGate.ts 327, store.ts 193, dataDirMigration.ts 144, gateWindow.ts 124, taskbar.ts 103, limitAlerts.ts 89, safeWindow.ts 88, atomicWrite.ts 80, quitConfirm.ts 80, ipcGuard.ts 66, stateController.ts 66, stateBroadcast.ts 60, startupTiming.ts 55, stability.ts 53, quitWait.ts 44, alertSound.ts 40, startupGates.ts 31, appStartClaim.ts 21, notifyOptions.ts 20, appIcon.ts 15. Shared logic it relies on: shared/state.ts 572, statePatch.ts 200, stateEdits.ts 47, detached.ts 424, alerts.ts 349, limitAlerts.ts 149, taskbarState.ts 53.

Behaviour to keep:
- Crash handling: uncaughtException before module load -> localized startupFailed (special text for StateUnreadableError) -> exit(1); later decideUncaught ('Object has been destroyed' logged only, quiet phase logged only, else at most 3 dialogs 10 s apart). crash.log 200 KB rolling to crash.old.log, line `ISO level text`, describeError cut at 4000.
- Data dir: migrateDataDir before userData is touched (MC_DATA_DIR unpackaged only): ajzakomator -> unimux rename, migrated-from.json, junction/symlink left at old path, user-made link kept, busy case via update window alive, empty new dir moved to `unimux.pre-migration-<stamp>`, rename failure falls back to legacy, lost race, missing link re-created. One-time MultiCoding/state.json copy.
- Identity: AUMID com.unimux.app / com.unimux.app.dev; Chromium switches remote-debugging-port (dev), max-active-webgl-contexts=96.
- Single instance keyed by userData; packaged Windows also refuses while updateInstalling(START_BLOCK_MS); second-instance focuses or sets relaunchRequested.
- loadState: temp sweep `/^state\.json(\.bak)?(\.<pid>\.<id>)?\.tmp$/` except own pid; EPERM/EBUSY/EACCES retries (25 ms * 2^n up to 500 ms, total 4 s); unreadable -> copy to `state.json.bak-<ISO with :. -> ->[-n]` + StateUnreadableError; corrupt -> renamed backup -> state.json.bak -> defaultState; good read refreshes .bak; unlessRestoring strips SSH resume flags.
- Saver: 500 ms debounce, compact JSON, atomic write, retries 1..30 s, newest pending wins, .bak at most hourly, flushUntilSaved 3 s every 250 ms at quit, flush on session-end.
- atomicWriteFileSync: temp `<file>.<pid>.<base36 ms><counter>.tmp`, optional 0o600, fsync, rename with 5 retries (20 ms doubling) on EPERM/EBUSY/EACCES, temp removed on failure.
- StateController single writer: revision, change(fn, editId?, batch), subscribe; apply(edit) = mergeStateEdit + normalization (sftp places, db connections, ssh identities/hosts, dbGroupColors, alerts, scrollback, sshTheme, workspaceOrder, layout recompute, 1..MAX_CELLS per tab); detachedWindows always from main's previous state.
- Change hook: revokeCell, forgetCell (unless alive), cancelOrphans, ssh/db/detached stateChanged, taskbar invalidate, limitAlerts settingsChanged, usage reschedule on `${showAiUsage}:${usageIntervalMinutes}:${limitPollingWanted}`.
- Broadcast: non-batch immediate `state:changed {revision, base, editId, patch}` or `{full}`; batch coalesced 16 ms; flush before every other send.
- Sender guard: main or detached webContents, main frame only (null senderFrame accepted), fallback values, OPEN_IPC_CHANNELS; enforced by test/ipc-guard.test.ts.
- Main window: 1600x1000 (offscreen 1100x700 at x=-6000), min 800x500, #0d0d0d, titleBarOverlay {#0d0d0d, #8a8a8a, 36} on Windows, traffic lights {12,10}; sandbox, contextIsolation, backgroundThrottling false, spellcheck false; external http(s) only.
- Window events: minimize/hide -> usage inactive + window:shown false; focus -> registry invalidate + flash off; reload/crash -> install.dispose, quitConfirm.rendererGone, sftp/db/localFiles rendererGone; did-finish-load connects pty/sftp/db ports.
- Renderer resilience: auto reload 3 per 60 s, then Reload/Quit dialog; unresponsive 10 s grace -> Wait/Reload.
- Startup order: shutdown hook, dock icon, startup.log fallback flush 60 s, menu (null on Windows), initUpdater, previousMacUpdate, signalUpdateReady + waitForUpdateWindowGone(4000), runUpdateGate, startMainApp (window, ptyHost, ssh/sftp/db/history/sqlite/notes IPC, detached, cli refresh, update cleanup); parallel pruneCellFiles, hooks.start, startMcp (2 retries) -> cellServicesReady; recoverAccounts -> accountsRecovered/accountsReady -> usage.start.
- Startup gates: one-shot promises; non-shell cells wait cellServices, Claude cells also accountsRecovered; account IPC waits accountsReady.
- Startup timing marks (first wins): modules-loaded ... first-spawn, plus renderer-boot/first-output; startup.log 20 lines `ISO version platform name=ms ...`.
- Quit: quitConfirm.hold (exemptions: quitting, gating, superseded, session ending within 60 s, handoff started, renderer dead), app:confirm-quit, 'asking' within 3 s else proceed, bound 120 s; real quit sequence with 20 s hard limit: usage.stop, login/install dispose, app:before-quit, +150 ms closeAllDetached, saver.flush, swap waits 5 s / 3 s, host shutdowns, flushUntilSaved 3 s, mcp.stop, hooks.stop, exitNow.
- Cell lifecycle (spawnRequestUnsafe): fatal check, killCount snapshot, gates, cwd check, CLI decision 7 s, env (cleanEnv + MC_CELL_ID + detector PATH), claude version and hook form, resume downgrade when jsonl missing, startup/resume task prompts (delivery 'startup'), prompts/<cellId>-<seq36>.txt, bypassProxyForHooks, MCP config, Codex notify, coordinator rules unless Codex developer_instructions set, buildLaunchCommand, spawn.
- Routing: BROADCAST_CHANNELS to all windows, CELL_CHANNELS to the owner window, automation:start-cells split, rest to main.
- Detached windows: registry in AppState.detachedWindows written only by main; bounds/displayId/maximized saved 400 ms after change; close = attach back (detach:closing, 3 s, detach:stay); handoff docs max 4 and 64M chars; placement over workAreas.
- Notifications: silent, buttons Zezwól/Odrzuć/Pokaż when notificationActions on, 50 live max, limit notice -> usage:open, switch offer button.
- attention:flash, Dock badge (200 ms debounce), sound:pick/load/beep (local absolute regular file, size cap, key `${path}|${size}|${mtimeMs}`), LimitAlerter (limit-alerts.json {version:1, marks}, quiet hours).

Risks: no titleBarOverlay in Tauri; WebKit WebGL cap; localStorage origin change; no Tauri API for render-process-gone/unresponsive/session-end; DIP vs physical pixels and no getNormalBounds; concurrency once state is Rust; single-instance plugin keyed by identifier (we use our own lock).

Data: DATA_DIR, legacy ajzakomator junction, state.json(+.bak, .bak-<ISO>), crash/startup logs, update-gate.json, limit-alerts.json, Local State and Local Storage (Electron, never deleted), AUMID, detached bounds in DIPs with Electron display ids.

## 2. preload-ipc (window.mc)

- 245 methods -> 215 channels (207 invoke, 38 send); multiplexers `db:pg` (14 ops, `{op}`) and `db:redis` (18 ops, `{kind}`); 43 push events; 3 ports (pty bidirectional, sftp and db host->renderer).
- Sync: `platform` (read 67x, at module load in App.tsx:343, DetachedApp.tsx:231, shortcuts.ts:23, templates.ts:17, pathDrop.ts:53, SftpView.tsx:309), `windowsBuild` (third segment of 10.0.26200), `pathForFile` (FilePane.tsx:352, NewKeyEditor.tsx:81, pathDrop.ts:77), `on()` with sync unsubscribe.
- Argument shaping in preload (see ARCHITECTURE section 3).
- Separate splash bridge `window.updateSplash` (init, onState, close, open).
- Main-side guard and routing (ipcGuard.ts, safeWindow.ts, detachedWindows.ts sendRouted, shared/detached.ts routeMessage, stateBroadcast.ts).
- Event groups: CELL_CHANNELS (cell:hook, cell:session, cell:context, cell:restarted, cell:spawnError, focus-cell, ssh:session, ssh:prompt, notify:answer); BROADCAST (state:changed, cli:changed, mcp:info, ptyhost:crashed, ptyhost:fatal, app:before-quit, ssh:vault:changed, db:session, db:prompt, db:hostCrashed, db:vault:changed, sftp:session, sftp:prompt, sftp:hostCrashed); main only (auth:state, install:state, app:notice, app:confirm-quit, update:state, usage:state, usage:open, accounts:swapPending, fs:progress, automation:statuses, agents:prompt:run, automation:start-cells, detach:*, waiting:step); per window (window:shown, detach:closing).
- Port messages: pty RendererToHost write/resize/ack/focus/sshList/sshStats, HostToRenderer data/dataBatch/exit/replay(sizes)/sshListResult/sshStatsResult; sftp snapshot/items/removed/opProgress; db statement/columns/rows/statementEnd/statementError/notice/queryEnd/resultClosed/redisPubSub/redisPubSubState.

Risks: send ordering (Tauri invokes are concurrent), throughput, sync surface, HTML5 DnD vs native drop, undefined vs null in payloads, Uint8Array args (sound:load, notes:image:save), error shapes, listen() async (attach handshake needed), beforeunload flushes (App.tsx:118, DetachedApp.tsx:99, NoteEditor.tsx:109), routing of detached windows, security of secret commands, 3.0 alpha pins, volume (generated contract test needed).

Data: none on disk; contract is api.d.ts + JSON shapes; 23 CDP scripts call window.mc directly (loadSnapshot 17x, db.redis.command 21x, getMcpInfo 9x).

## 3. pty

Files: ptyHostClient.ts 175, ptyhost/index.ts 173, router.ts 75, routes.ts 40, batch.ts 39, output.ts 201, flow.ts 235, manager.ts 256, sharedConout.ts 166, ssh.ts 406, sshErrors.ts 36, sshcore/login.ts 154, scripts/patch-node-pty.cjs 56, shared/shellIntegration.ts 125, termReset.ts 160, profiles.ts 159.

- Supervision: stdio ignore/pipe/pipe, 8 KB stderr tail, >5 crashes in 60 s fatal, restart 500*2^(n-1) ms, re-send routes then ports then queue (500 max); killAndWait 4000; shutdown 4000; forceKill.
- Main consumers: log rate 20/min, install:/auth: ids, spawned pid (Monitor), exit cleanup, spawnError, crashed -> forgetHostTerminals + ptyhost:crashed(resumes), fatal dialog.
- Host: one RendererLink per window; replay on attach; messages accepted only for owned terminals; route moves with replay; tap and \x03 interrupt for install ids.
- Router: early sizes LRU 200. Batcher: setImmediate per window, echo immediate, flush before exit.
- OutputChannel: TailBuffer 512K chars (UTF-16 today), FLUSH_NOW 128K, echo flush on nextTick within 4 flushes, 4/12/33 ms coalescing with aligned grid, FlowGate 1 MiB / 256 KiB, watchdog 3 s, exit drain 80 ms. EchoClock EWMA 0.25, window clamp 150..1000 ms.
- Local backend: resolveShell (zsh/bash -il; cmd; pwsh on the cell PATH else Windows PowerShell), shell integration files in tmp/unimux-shell-<uid> (0700/0600 checks), env TERM/COLORTERM/TERM_PROGRAM, useConptyDll (conpty.dll + OpenConsole.exe 1.23.251008001), command typed 150 ms after first output, serial kills, killAll with taskkill /T /F or kill(-pid).
- Shell integration: OSC 133/633; PowerShell -EncodedCommand script, cmd PROMPT, bash --init-file; UNIMUX_SHELL_INTEGRATION=0.
- Launch line: startClear + withResetTail(buildCliCommand) for claude/codex x 5 shells; exitUrl regex.
- SSH backend: ssh2 per cell, timers 20 s connect/auth/shell, auth order publickey -> saved password -> none -> prompt x3 -> kbd-int x3, keepalive 15 s x3, two UTF-8 decoders, startup text after 400 ms quiet or 5 s, list/stats over exec, error map (dns, refused, timeout, unreachable, reset, auth, protocol, unknown).

Risks: sideloaded ConPTY behaviour, ClosePseudoConsole deadlock, Job Object kill semantics, Windows timer resolution, UTF-16 vs bytes, Channel throughput, crash isolation, russh vs ssh2 (PPK v2, legacy algorithms, host key bytes, kbd-int timing), macOS login env, detached reload detection, TS/Rust drift.

Data: bash-init.sh byte-identical; prompts/, hooks/, mcp/ paths in the launch line; env contract (TERM, COLORTERM, TERM_PROGRAM, MC_CELL_ID); OSC 133 format; known_hosts key bytes.

## 4. agents-hooks

Files: hooks.ts 585, hookFallback.ts 167, cellFiles.ts 64, cliDetect.ts 395, cliSystem.ts 85, cliInstall.ts 272, cliIpc.ts 61, contextUsage.ts 260, sessions.ts 497, agentDelivery.ts 52, offMainExec.ts 58 + exechost 17, agentPrompt.ts 53, convSearchClient.ts 126 + convsearch 662.

- HookServer: 127.0.0.1:0, token 16 bytes hex per run, nonce 8 bytes per spawn; POST /h/<token>/<cell>/<event>/<nonce>, /k/<cell>/<event>/<nonce> + Bearer, /x/<cell>/<nonce>/<exitCode>; 403/400/204 rules; answer 204 only after reading the whole body; body caps (tool head 16K + tail 2K; stop/fail 512K; codex 1M; notify/session 16K); oversized handling.
- Payload interpretation: notificationEvent, stopInfo (stop vs stopbg), parseFailure, parseSessionStart, transcriptOf, toolHookFacts, toolHookEvent; emitted hook/session/sessionstart/transcript/codex/cliexit.
- MC_HOOK_DEBUG -> hook-debug.log (256 KiB).
- Claude settings per version: <2.1.63 shell curl, >=2.1.63 http, >=2.1.139 exec; extended hooks >=2.1.78; 0600; bypassProxyForHooks.
- HttpHookWatch: 20 s grace -> shell fallback, claude-hook-fallback.json, one app:notice; allowedHttpHookUrls glob.
- Cell files: hooks/, mcp/, prompts/; PromptFiles FIFO; prune at startup.
- CliDetector: known dirs, PATH + registry (60 s), login-shell / PowerShell probes, --version via cmd /d /s /c verbatim, caches 10 min / 30 s, waitMs, cli:changed; runProgram cap 256 KiB, kill tree.
- InstallManager: pty `install:<uuid>`, allow-listed commands, marker `__AJZ_DONE__`, 5 s polls, 20 s grace, 3 s abort, 10 min timeout, failure classes.
- ContextTracker: throttle 800 ms, settle 2.5 s, incremental and backward scans (256 KiB doubling to 16 MiB, give up 64 MiB).
- Sessions listing (Claude head 256 KiB + tail 64 KiB, Codex newest 600), findRecentCodexSession (20 s window).
- Codex delivery `codex queue --thread --message` (env-var text on the PowerShell shim path), off-main exec.
- agents:prompt fan-out per window, 5 s timeout.
- Conversation search worker: idle 10 min, timeouts 60/120 s, concurrency 24/6, byte prefilter, limits, conversation-index.bin (v8.serialize), fold() same length, search caps.

Risks: loopback security semantics, byte-exact settings JSON, proxy, UTF-16 offsets, fold parity, big codex.exe CreateProcess stall, kill-tree, macOS probes, file identity, v8 index unreadable (new v2 file), CLAUDE_CONFIG_DIR inconsistency in sessions.ts, per-window prompts, concurrency.

Data: hooks/claude-<cell>.json, prompts/*.txt, mcp/<cell>.json, claude-hook-fallback.json, hook-debug.log, conversation-index.bin; read-only ~/.claude/projects, ~/.codex/sessions, config.toml, Claude settings files.

## 5. mcp-automation

Files: mcp.ts 486, mcpTools.ts 429, mcpCellConfig.ts 68, automation.ts 929, shared delegation.ts 85, teamPrompts.ts 55, promptQueue.ts 198.

- Server: Streamable HTTP on 127.0.0.1:<port>/mcp, SDK 1.32.2 lazy-loaded, McpInfo with 'starting'.
- Tokens: 32 bytes hex per cell, revokeCell aborts waits and sessions.
- Check order: Host/Origin 403, path 404, Bearer 401, DELETE session, 405 Allow: POST, in-flight 8/token 256 global + bucket 120/60 per s -> 429 Retry-After 1, 256 KB body -> 413 -32000, bad JSON -32700, session 404 -32001, timeouts 30 s / 10 s, 500 without echo.
- Modes: stateless JSON (SSE only for tools/call with progressToken and SSE Accept), sessions only for elicitation-capable initialize (256 total, 4 per token), MCP tasks (16 per token, ttl 60 s..1 h, poll 2000, wait_for only).
- Tools: 13 + 22 legacy names, verbatim schemas, annotations, role overrides, capResult 60000, describeError zod format, elicitation 120 s, progress every 10 s, instructions per role/delegation.
- Cell config: mcp/<cell>.json 0600 for Claude; UNIMUX_MCP_TOKEN + -c overrides for Codex; endCellMcp on every exit path.
- Automation: 27 operations, paused rules, permissions, task model and transitions, create_grid/add_agents (20 per grid, 100 per project, after chains, worktrees with rollback), idempotent 5 min, close_grid, update_agent, wait_for (inbox/tasks/alreadyClosed/exited/stalled 90 s and 120 s/timeout/cancelled, caps claude 600 codex 170 else 45), cancelOrphans, delivery notices, StatusMap 250 ms.

Risks: rmcp tasks/elicitation support, wire compatibility with Claude Code and Codex, byte-level texts, zod-to-serde drift, concurrency, disconnect detection, DNS-rebinding checks, Windows spawning, persisted shape, dependencies on other units.

Data: state.json automation {paused, tasks, messages, events(200)}, cell role/startupPrompt/promptQueue/session, settings.delegation, snippets, presets, mcp/<cell>.json, prompts/.

## 6. accounts-usage

Files: accounts/* 2785, auth/* 823, usage/* 1136, autoSwitch.ts 226, accountsIpc.ts 87, github/* 515, ssh/vault.ts electronCipher; shared accounts 162, codexAccounts 128, usage 257, autoSwitch 411, github 141. 37 test files, about 7,650 lines.

- AccountsStore accounts/accounts.json v2 (custody, family, heldTokens/deadTokens sha256, appSwap, notices max 20, read-only rules, .bak-<ISO>, 2-space).
- CodexAccountsStore (1-space, 0600, profiles/<uuid>/auth.json).
- Set as main (activate.ts): refusals (darwin, envToken, noMain, pending, busy), renew if expires within 5 min, profile + Claude Code locks, v2 journal phases with backups in accounts/swap-backup, verify, guarded rollback.
- Recovery at startup (3 tries), legacy v1 journal, 30 s retry, single swap slot.
- Claude Code lock protocol (proper-lockfile compatible, stale 60/10 s, touch 3 s, timeout 9 s, jitter, release retries).
- Reconcile on every poll; resync with two identical sha256 signatures; backupLiveBeforeLogin.
- Token renewal: platform.claude.com/v1/oauth/token, exact headers, Connection: close, direct then proxy, 10 s, no redirects, 1 MB cap, invalid_grant -> dead, 429 backoff in refresh-limits.json.
- cswap read-only integration; Codex make-main with emergency copy.
- Login flows (claude auth login --claudeai, codex login) with snapshots, fingerprint polling 1.5 s, timeout 10 min.
- Usage: Claude oauth/usage, Codex wham/usage + session log fallback, macOS Keychain creds with 30 min failure cache; UsageService spacing 20 s / 180 s, backoff 60 s to 30 min, usage-cache.json v2.
- AutoSwitcher (auto-switch.json), accounts IPC guarded behind accountsReady.
- Cipher: Electron safeStorage (dpapi/keychain/unavailable).
- GitHub: token.json, gh fallback, device flow, publish with extraheader env, refusal regexes.

Risks: safeStorage compatibility, Local State ownership, macOS Keychain ACL, JSON byte compatibility of ~/.claude.json, lock interop, TOCTOU in multi-threaded code, Windows rename semantics, token endpoint fingerprint and headers, PAC proxies, notification buttons, hidden polling, legacy formats, login timing, downgrade safety.

Data: Local State, accounts/ (claude/<uuid>/.credentials.json and .claude.json, swap-backup/), codex-accounts/, refresh-limits.json, usage-cache.json, auto-switch.json, github/token.json, ssh and db vaults; external ~/.claude/.credentials.json, ~/.claude.json, lock dirs, $CODEX_HOME/auth.json, ~/.claude-swap-backup, Keychain 'Claude Code-credentials'.

## 7. git-files

Files: git.ts 867, gitHandler.ts 61, gitIpc.ts 107, gitPaths.ts 79, worktree.ts 186, files.ts 311, fileOps.ts 329, filesIpc.ts 62, localFiles.ts 204, noteFiles.ts 52, fsProbe.ts 13, search.ts 147, monitor.ts 222, changelog.ts 48.

- Git runner: system git, no shell, global safety args, scrubbed env, caps and timeouts, kill tree, stale index.lock release.
- Caches with TTLs, generation counter, in-flight dedupe.
- Trust model: config/attribute drivers/hooks fingerprint sha256(JSON.stringify(sorted)); git-trust.json; trust required for status/diff working/mutations; parent-repo write refusal.
- Mutations: requestId once per 10 min, one per commonDir, push target re-check, commit via stdin, checkout refused when dirty, network auth retry with GitHub token.
- canonicalPath (realpath native, forward slashes, lowercase on Windows).
- Worktrees `<base>-wt-<slug>`, branch `mc/<slug>`, inspect/remove safety.
- Files: containment, listing with pl numeric collator (2000 entries), preview 256 KiB / 8 MiB / images 20 MiB / parquet 1000 rows, text detection, optimistic save (line endings, BOM, `.mc-save-<uuid>`).
- File ops: case-only rename, trash, transfer with conflicts, 500 MiB / 20000 entry large copy limit, EXDEV, progress 120 ms, cancel.
- Local files for the SFTP pane (forbidden roots, opened set of 500).
- Notes images, export; pathExists 4 s timeout.
- Search: DFS, globs, 6 readers, budgets 20000 files / 10 s / 5000 matches, UTF-16 previews, replace with $1/$&/$<name>/$$.
- Monitor: resident PowerShell NtQuerySystemInformation helper / ps; killablePid.
- Changelog: GitHub releases API, 10 min cache, changelog.json offline fallback.

Risks: security parity, trust hash compatibility (JS sort order, JSON.stringify escaping), JS RegExp vs fancy-regex, collator, TextDecoder semantics, kill-tree, canonicalize on mapped/subst drives, trash behaviour, symlink privileges, monitor process kinds, parquet type naming, byte IPC, blocking FS on offline shares, renderer reload detection, cross-unit callers.

Data: git-trust.json, changelog.json, note-images/, state.json worktree objects, temp names `.mc-save-<uuid>` / `.mc-rename-<uuid>`, renderer TS contracts and Polish error strings.

## 8. ssh-sftp

Files: ssh/coordinator.ts 387, sshcore/login.ts 154, ssh/vault.ts 329, knownHosts.ts 107, fingerprint.ts, keys.ts 208, ssh/ipc.ts 260, commandHistory.ts 117, files.ts, sftp/service.ts 225, sftp/ipc.ts 152, sftpHostClient.ts 142, sftphost/host.ts 567, sudo.ts + execSftp.ts, queue.ts 638, sides.ts 432, editFile.ts 178, throttle.ts.

- Coordinator is the only decrypter; sessions by cell id, `sftp:` and `db:` prefixes; passphrase flow with bcrypt verify once; prompt groups (`hk:` / `pp:`), 5 min timeout; host key judge (match, unknown, newType, changed); password/keyboard/sudo prompts; pendingSave on connect.
- Vault ssh/vault.json (version 1/2, read-only rules, ephemeral mode, eager DPAPI decrypt, field caps); known_hosts.json (app-own); keys parse/generate/cert/drafts; IPC with fixed error codes; command_history.json.
- SFTP service: deferred start, sudo decided once, idle 2 min with view/queue/pins, local queue id.
- SFTP host: ssh2 + sftp channel, timers, list 20,000 cap, delete/chmod walks, editor read/stat/save with stamps, sudo SFTP over exec (`sudo -n`, `sudo -S -p` marker, classifySudo incl. Polish), transfer queue (3 concurrent, part files, conflicts, moves), RemoteSide 16 x 32 KB pipeline, ItemThrottle 100 ms.

Risks: safeStorage blobs and Local State location, russh key coverage (PPK v2, legacy encrypted PEM), legacy algorithms, russh-sftp API gaps and sequential I/O, stderr separation for sudo, auth flow differences, loss of process isolation, error-code parity, local FS semantics, event ordering.

Data: ssh/vault.json, known_hosts.json, command_history.json, db/vault.json (shared cipher), backups `.bak-<ISO>[-n]`, remote `.unimux-part` / `.unimux-old[n]`, state.json sshHosts/sshIdentities/cell.ssh, POSIX 0700/0600.

## 9. db

Files: src/main/db/* (service.ts 483, vault.ts 114, history.ts 131, sqliteFiles.ts 44, ipc.ts 251), dbHostClient.ts 148, dbhost/* (host.ts 802, pgSession.ts 715, pgMeta.ts 202, mysqlSession.ts 796, mysqlMeta.ts 156, redisSession.ts 1187, sqliteSession.ts 627, sqliteWorker.ts 201, sqliteMeta.ts 129), shared db helpers.

- Saved connections with strictConnection, limits (500 connections etc.), vault db/vault.json, test connection (7 min), sessions `db:<uuid>` (32 per connection, 128 total), prompts, idle 5 min with pins per window, SSH tunnel sharing without local ports (owner/riders/handOver, 6 min wait), DB host supervision and per-op timeouts, results streamed over a per-window port routed by queryId (LRU 4096) and sessionId.
- Postgres: raw text types, read-only via default_transaction_read_only, statement timeouts with restore, pg-cursor adaptive batches, one open result (2 min idle), truncation 64K chars, bytea hex, pg_cancel_backend then CancelRequest, error mapping, table pages, edits in one transaction with exact-1-row checks, metadata.
- MySQL/MariaDB: typeCast false, streaming with backpressure, KILL QUERY side connection, CALL multi results, tx from OK packets, SHOW WARNINGS, USE tracking, flavour timeouts.
- Redis: 3 connections RESP2 binary, reconnect x3 no resend, 60 s browse watchdog, scan/read/write (WATCH/MULTI), pattern count/delete tokens, console classification and caps, info/slowlog/clients, pub/sub buffer.
- SQLite: worker per session, never create, read-only fallback, query_only, cursors, interrupt and terminate/reopen, value formatting, BEGIN IMMEDIATE edits.
- Query history (1000 per connection, 500 stars, redaction, 1.5 s writes); SQLite pick/create.
- zod IPC validation with fixed fallbacks.

Risks: PG text-value parity (no tokio-postgres), PG 18 protocol 3.2 cancel keys, MySQL custom stream (no mysql_async), redis crate reconnect behaviour, safeStorage, process isolation for FFI, SQLite cancel, UTF-16 semantics, SQL logic drift (read-only is a security boundary), integration test infrastructure, Channel throughput, multi-window routing.

Data: state.json dbConnections/dbGroupColors, db/vault.json, db/query_history.json, backups, shared SSH stores.

## 10. update-packaging

Files: updater.ts 307, updateCoordinator.ts 323, updateRuntime.ts 152, updateSplash.ts 99, updateUiGuard.ts 26, updaterLog.ts 28, macUpdate/* (engine 512, feed 94, netFetch 95, runtime 56, script 138, target 60), src/updatesplash 188, startupGate.ts 327, gateWindow.ts 124, shared/updateProgress.ts 148, resources/update-splash, package.json build, resources/installer.nsh 33, ci.yml 208, release.yml 61, release scripts.

- UpdateCoordinator: newest target wins, single download, lockHandover, block, refuseInstall, stall 2 min, lookup 90 s.
- Scheduling: first check 8 s after start, then every 30 min; MC_UPDATE_FEED unpackaged; portable detection.
- Windows: electron-updater lazy, autoDownload false, no-cache headers, updater.log; handOver -> detached splash -> install(silent, forceRun) -> quit.
- Detached splash runtime and file signals in <userData>/update (installer-done, ready, work/shown, abort, heartbeat); installInProgress; cleanup after 30 s; `-e` cleanup call with ELECTRON_RUN_AS_NODE.
- Startup gate flow (8 s check, 800 ms, ask, 60 s stall, 3/10 min, recheck, 20 s handoff, 6 h cooldown, update-gate.json, 15 s quit watchdog).
- macOS engine: latest-mac.yml, trusted hosts, sha512, ditto, verifyBundle, install script with rollback, finishPrevious/markReady.
- NSIS packaging: appId com.unimux.app, guid 214279c4-b798-5d4e-848f-0b9245114cd1, per-user, custom dir, AUMID stamping; mac ad-hoc signed dmg/zip.
- CI/release: check-release-tag, 3 named build jobs, verify-release-build, prepare-release-assets (exact asset list, SHA256SUMS), release.mjs.

Risks: install directory mismatch, `-e` cleanup hitting the new exe, RmForceShutdown cutting the wind-down, --force-run ignored, old uninstaller timing, install() exit(0), signing key loss, macOS engine expectations, no end-to-end mac test path, data dir and WebView storage continuity, GitHub latest semantics, proxy/AppleScript prompt differences, WebView2 bootstrapper.

Data: <userData>/update/*, update-gate.json, updater.log, updates/mac/*, state settings.updateMode, %LOCALAPPDATA%\unimux-updater, registry keys, shortcuts, release asset names forever, mac bundle identity.

## 11. renderer-electron-deps

- 540 window.mc references in 111 files; sync props; on() for 37 channels; 3 ports; `window.__mc` handle used by 21 CDP scripts.
- MC_OFFSCREEN window placement; WebGL pool (96 Chromium contexts, 64 WebglAddon, WebglLimit learning, prewarm via requestIdleCallback).
- backgroundThrottling false + window:shown -> html[data-window-shown], terminals released while hidden.
- Window chrome (titleBarOverlay, 140 px reserve, -webkit-app-region), OS file drop via pathForFile, internal HTML5 DnD MIME types, clipboard through main (incl. writeSecret, image paste forwarding), notifications and Web Audio sounds, Chromium-only APIs (requestIdleCallback, randomUUID, localStorage/sessionStorage, getModifierState, IME guard), Electron defaults (no context menu, no accelerators, spellcheck off, external links), font stack.

Risks: pty throughput, identical WebView2 args, IsVisible(false) on minimize, WKWebView WebGL cap, no CDP on macOS, file drop, Windows chrome, localStorage loss, macOS key equivalents and IME, text substitutions (em dashes), autoplay, default WebView behaviours, secure-context APIs, crash recovery.

Data: Local Storage leveldb keys (file drafts, detached drafts, Redis console history, DB tree, layout sizes, Git panel keys, split view, fileZoom, notes sort, SSH folds, right panel order); Electron files never overwritten.

## 12. shared-and-tests

- src/shared: 194 files. RENDERER-ONLY 61 modules / 7,955 lines (stay TS; some normalizers feed normalizeState). BOTH 56 / 15,085 (the real Rust port scope). MAIN-ONLY 15 / 1,580 (env.cleanEnv, gitTrust, limitAlerts, codexAccounts, taskbarState, teamPrompts, runtimeStatus, sshClipboard, sound, dbHostIpc, sftpHostIpc, dbMysql, dbSqlite, dbPortRoutes, updateProgress). TEST-ONLY 3. Messages tables 59 files + messages.ts = 4,129 lines.
- Bit-for-bit behaviours: normalizeState (version 1, spread keeps unknown keys, RETIRED_PROFILES, language rule), mergeStateEdit (JSON.stringify equality, no resurrection), diffState Patch shapes, translate fallbacks, locale date/time notice formatting, UTF-16 length limits, MCP inputSchema JSON.
- Tests: vitest node env, 20 s timeout. Shared-only 104 files / 1,489 tests; main+shared 69 / 1,167; main-only 45 / 648; ptyhost 17 / 175; dbhost 3 / 33; sftphost 4 / 84; convsearch 2 / 31; renderer/other 14 / 106. Source-scanning tests (ipc-guard, off-main-exec, git-shared, tree-rows, webgl-pool). 3 vi.mock('electron'). Helpers: mcpHarness, automationFixture, dbHarness, pgFakeServer, mysqlFakeServer, respServer, sshServer, sshKeys. Fixtures: convsearch, convexport, pg-tls.
- Real-app: 44 verify-*.mjs; launchApp (`electron .`, MC_DATA_DIR, MC_OFFSCREEN, MC_DEBUG_PORT, scratch home, CDP target filter); mainInspector in 12 scripts uses Electron main inspector (needs the sidecar --inspect or the test bridge); dev env switches MC_* listed in ARCHITECTURE; Electron-specific scripts (smoke-pty, smoke-start, measure-startup, perf-profile, verify-release-build, prepare-release-assets, release, check-release-tag, patch-node-pty, fix-pty-permissions).

Risks: drift between TS and Rust copies, state.json key order and number formatting, UTF-16 vs UTF-8, regex dialects, locale formatting, zod messages, specta RC, test isolation (Rust path APIs ignore env overrides), MC_OFFSCREEN occlusion, browser args replacing defaults, Browser.close semantics, mainInspector coverage gap, no macOS CDP, test count parity, i18n generation step, embedded NUL in src/main/db/ipc.ts.

Data: state.json (full AppState), state.json.bak and temp files, other data files listed above, agent-visible formats, test fixtures and the new golden corpus.

---

## Critic review (2026-11-06)

Additions and corrections found by checking the source (nothing above was removed):

- **preload-ipc counts**: src/preload/index.ts (298 lines) has 177 `invoke` channels + 38 `send` channels = 215, plus 3 port listeners (`pty-port`, `sftp-port`, `db-port`) and the generic `on()`. "207 invoke" in section 2 counts methods, not channels (db:pg / db:redis multiplex).
- **Second preload missed**: src/updatesplash/preload.ts exposes `window.updateSplash` (init, onState, close, open) on 4 channels `update-splash:init|state|close|open`. It is used by BOTH the detached update splash (deleted in 1.2.0) and the in-app startup gate window (gateWindow.ts:81, kept). The gate page is resources/update-splash/index.html (own meta CSP). The contract test must include these channels.
- **Eval'd workers read from disk**: convSearchClient.ts:39 and dbhost/index.ts:31 run `new Worker(readFileSync(<file>), { eval: true })` with `out/main/convsearch.js` and `sqliteworker.js`. Bundle entries in electron.vite.config.ts: index, ptyhost, sftphost, dbhost, exechost, sqliteworker, updatesplash, convsearch. The SEA build must ship the two worker sources as assets.
- **app.getAppPath() users**: appIcon.ts:13 (Dock icon in dev), gateWindow.ts:104 (gate page), index.ts:1671 (localFiles forbidden roots: DATA_DIR, userData, exe dir, app path).
- **Detached spawns that must outlive the app**: index.ts:1971 (`open -a` on macOS) and index.ts:1976 (Cursor/VS Code with `detached: true`), macUpdate/runtime.ts:24, updateRuntime.ts:92 (both deleted in 1.2.0).
- **Window events used** (index.ts): close, focus, hide, minimize, restore, show, responsive, unresponsive, query-session-end, session-end, ready-to-show; webContents: did-finish-load, did-start-loading, render-process-gone, console-message (dev only, forwards renderer console to stdout; Tauri dev has no equivalent, the WebView2 CDP console is the replacement); app: before-quit (x4), will-quit (x4), second-instance, window-all-closed (quits unless `gating`, index.ts:2265); powerMonitor 'shutdown'. Main shows on ready-to-show (index.ts:961) which also triggers signalUpdateReady, signalMacUpdateReady and clearGateFailureIfUpdated.
- **Dev switches** (all behind `!app.isPackaged`): MC_DATA_DIR, MC_DEBUG_PORT, MC_OFFSCREEN, MC_HOOK_DEBUG, MC_SSH_DEBUG, MC_SSH_NO_SAFESTORAGE, MC_TRASH_DIR, MC_DB_EXPORT_DIR, MC_NOTES_EXPORT_DIR, MC_CLI_NO_REGISTRY, MC_CLI_PROBE_PROFILE, MC_INSTALL_COMMAND_OVERRIDE, MC_USAGE_CLAUDE_URL, MC_USAGE_CODEX_URL, MC_USAGE_CLAUDE_TOKEN_URL, MC_UPDATE_FEED. Section 12 referred to a list in ARCHITECTURE that did not exist; it is now ARCHITECTURE section 11.
- **Renderer CSP**: src/renderer/index.html:6 meta CSP (`default-src 'self'`) blocks ws://127.0.0.1, the Tauri IPC protocol and unimux-blob; must change in 1.2.0.
- **beforeunload flushes**: App.tsx:118, DetachedApp.tsx:99, NoteEditor.tsx:109 send state edits during unload; ErrorBoundary.tsx:64 calls `location.reload()`.
- **OS integrations not used by 1.1.4** (grep, 2026-11-06): Tray, globalShortcut, setAsDefaultProtocolClient / open-url, open-file, setLoginItemSettings, setUserTasks / jump lists, thumbar / overlay / progress, powerSaveBlocker, nativeTheme, systemPreferences, crashReporter, IndexedDB / service workers in the renderer. No parity work needed for them.
- **No main-window bounds persistence** in 1.1.4 (only detached windows save bounds, detachedWindows.ts:274 getNormalBounds); the Rust state mirror is needed for detached bounds and routing, not for the main window.
- **Electron singleton** on the data dir (ProcessSingleton: `Chrome_MessageWindow` on Windows, `SingletonLock` on macOS) is invisible to the new fs4 lock; see ARCHITECTURE section 11.
