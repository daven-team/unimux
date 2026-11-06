# SP8: MCP wire with the real CLIs

Status: **decided, green** (2026-11-06, Windows 11 26200). Package row: PLAN.md wave 0b.

**Decision: M1 builds a custom dispatcher on hyper 1.12 (+ axum 0.8.9 as the thin router), not rmcp 3.9 `StreamableHttpService`.** rmcp is not a dependency of the shipped app; it stays a dev-dependency of the spike only and M1 may drop it.

Why, in one line each:

- The custom prototype is byte-for-byte the 1.1.4 wire in **42 / 42** HTTP-level cases; rmcp 3.9 matches **6 / 42**, and several of its gaps cannot be closed with its public knobs.
- rmcp 3.9 targets protocol 2026-07-28: it has no 2025-11-25 MCP tasks (no `params.task`, no `tasks` server capability, no `tasks/result` / `tasks/list`), drops `execution.taskSupport` from tools, and its session mode is global (with sessions on, every stateless request gets `400 Bad Request: Session ID is required`).
- rmcp does not end a running call when the client goes away (measured: never within the test window); 1.1.4 and the custom dispatcher end it within 1-3 ms of the connection closing.
- rmcp sessions are not bound to tokens: another cell's token can use a session, revoking a token leaves its sessions open (19 and 20 sessions left after two CLI runs, 0 for 1.1.4 and custom), no 256 / 4-per-token limits.

## What was run

Everything is reproducible on a scratch home (scratch `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, temp dirs; mock model APIs, so no sign-in and no model usage; nothing touches `%APPDATA%\unimux`, `~/.claude` or `~/.codex`).

| piece | file |
|---|---|
| fake tool layer shared by both Rust candidates: the real 1.1.4 tool lists and instructions (dumped from `toolsForRole` / `mcpInstructions`), get_context, list_agents, update_task, close_grid with the 1.1.4 elicitation, wait_for with progress / tasks / cancellation | `src-tauri/crates/unimux-mcp/examples/sp8/fake.rs` |
| candidate B, custom dispatcher (the M1 prototype) | `src-tauri/crates/unimux-mcp/examples/sp8/custom.rs` |
| candidate A, rmcp 3.9 `StreamableHttpService` behind an axum middleware for the front checks | `src-tauri/crates/unimux-mcp/examples/sp8/rmcp_impl.rs` |
| server binary for the scripts (`--impl custom|rmcp`) | `src-tauri/crates/unimux-mcp/examples/sp8_server.rs` |
| cargo tests (raw HTTP/1.1 client) | `src-tauri/crates/unimux-mcp/tests/sp8_wire.rs` (7 tests) |
| 42 HTTP-level cases, normalized and compared with the 1.1.4 TS server; latency bench | `scripts/spike-mcp-protocol.mjs` |
| driver: TS reference (`test/helpers/mcpHarness.ts`, the real `UnimuxMcpServer`), both Rust servers, a tap proxy recording the wire, the real `claude` and `codex` CLIs against mock model APIs | `scripts/spike-mcp-wire.mjs` |

How to run:

```
cd src-tauri && node ../scripts/msvc-run.mjs cargo build -p unimux-mcp --examples --release
cd src-tauri && node ../scripts/msvc-run.mjs cargo test -p unimux-mcp --test sp8_wire
node scripts/spike-mcp-wire.mjs                 # ts, custom, rmcp: protocol cases + CLI scenarios
node scripts/spike-mcp-wire.mjs ts custom --protocol --bench
node scripts/spike-mcp-wire.mjs custom --cli
```

Output: PASS / FAIL lines (rmcp failures print as `GAP`, they are findings), `artifacts/sp8/wire-<server>.jsonl` (every request, response header and SSE frame with timestamps), `artifacts/sp8/protocol-<server>.json`, `protocol-summary.txt`, `results.json`. The exit code is non-zero when a ts or custom scenario fails or custom differs from 1.1.4 in any protocol case.

CLIs: Claude Code 2.1.319, codex-cli 0.162.1.

## What the real CLIs do (recorded from the 1.1.4 TS server)

| step | Claude Code 2.1.319 | Codex 0.162.1 |
|---|---|---|
| probe | `POST server/discover`, id `server-discover-probe-1`, header `MCP-Protocol-Version: 2026-07-28`. 1.1.4 answers `400 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"},"id":null}` and Claude falls back to `initialize` | none |
| initialize | protocol 2025-11-25, capabilities `{roots:{listChanged:true}, elicitation:{form:{},url:{}}}` | protocol 2025-06-18, capabilities `{elicitation:{form:{},url:{}}}` |
| mode | form elicitation -> **session** (SSE for every request) | form elicitation -> **session** |
| after initialize | `notifications/initialized` (202), `GET` standalone stream (405 Allow: POST), `tools/list` | same |
| tools/call | `_meta: {claudecode/toolUseId, progressToken}` | `_meta: {progressToken, callId, x-codex-turn-metadata, threadId, ...}` |
| elicitation | `elicitation/create` on the call's own SSE stream, answered by a separate POST of the session (202). `-p` answers `cancel`; an `Elicitation` hook (`hookSpecificOutput: {hookEventName:"Elicitation", action:"accept", content}`) answers `accept` | `codex exec` answers `decline`. A destructive tool (`close_grid`) needs Codex's own approval first: without `-c mcp_servers.unimux.tools.close_grid.approval_mode="approve"` exec refuses with "MCP tool call requires approval, but approval policy is never" before any MCP traffic |
| end | no DELETE (the process exits) | `DELETE` of the session (200) |
| MCP tasks | not declared, never used | not declared, never used |

Consequences for M1 / M4:

- With today's CLIs the session path (SSE + elicitation) is the main path; the stateless JSON path serves only clients without form elicitation (older CLIs, scripts). Both must stay.
- The `server/discover` refusal must stay exactly as 1.1.4 (400 / -32000 from the protocol-version header check). A server that accepts 2026-07-28 would move Claude to the stateless 2026-07-28 protocol (no sessions, elicitation as input-required results), a behaviour change; rmcp 3.9 accepts it unless its version list is restricted.
- MCP tasks for wait_for are reachable only by clients that send `params.task`; no installed CLI does. The task wire is therefore proven at protocol level (3 cases identical to 1.1.4 below), not with a CLI.

## CLI scenarios (release build, `node scripts/spike-mcp-wire.mjs --cli`)

| scenario | ts (1.1.4) | custom | rmcp |
|---|---|---|---|
| `claude mcp list`: initialize + tools/list, Connected | PASS | PASS | PASS |
| `claude mcp list` with a revoked token: 401, "Failed to connect" | PASS | PASS | PASS |
| `claude -p`: ToolSearch, get_context, list_agents, invalid update_task (error result), close_grid with elicitation (`-p` answers cancel, nothing closed), wait_for 5 s with 2 progress notifications | PASS | PASS | PASS |
| `claude -p` + Elicitation hook: close_grid accepted, grid archived | PASS | PASS | PASS |
| `claude -p` killed (taskkill /T /F) during a 120 s wait_for: the server aborts the call | PASS, 3 ms and 1 ms after the connection closed (two runs) | PASS, 1 ms and 1 ms after the connection closed | **GAP**: never aborted |
| `codex exec`: tools/list (8 worker tools), get_context, wait_for 5 s with 2 progress notifications, DELETE | PASS | PASS | PASS (DELETE answered 202) |
| `codex exec`: close_grid with elicitation, Codex answers decline, the tool reports "did not confirm" | PASS | PASS | PASS |
| sessions still open at the end | 0 | 0 | 19, 20 |

The recorded exchange sequence (method = status / content type, progress and elicitation frame counts) of every scenario is identical for ts and custom; rmcp differs in `GET=200/sse` (standalone stream opened) and `DELETE=202`.

## HTTP-level cases (`--protocol`)

Normalized outcome per case (status, content type, the headers that matter, JSON-RPC messages with uuids / hex ids / ISO times / ports masked; tool-specific texts masked where the fake cannot reproduce them). Identical to 1.1.4: **custom 42 / 42, rmcp 6 / 42.**

| case | custom | rmcp 3.9 (what it does instead) |
|---|---|---|
| Host other than 127.0.0.1 / localhost -> 403 | same | same (axum middleware) |
| foreign Origin -> 403 | same | 200, served (rmcp's Origin check is off by default) |
| other path -> 404; `/mcp?x=1` -> 404 | same | same; 406 |
| no / unknown bearer -> 401 | same | same (middleware) |
| GET -> 405 `Allow: POST` (also in a session) | same | 400 "Session ID is required"; in a session 200 standalone SSE |
| DELETE of an unknown session -> 404 | same | 202 |
| PUT -> 405 | same | 405 `Allow: GET, POST, DELETE`, text body |
| body over 256 KB -> 413 `-32000 Request body too large.` | same | 413, plain-text body |
| invalid JSON -> 400 `-32700 Parse error: invalid JSON.` | same | 415, text |
| Accept without SSE -> 406; Content-Type text/plain -> 415; not JSON-RPC -> 400 -32700 | same | status right, plain-text bodies; 415 for not JSON-RPC |
| stateless initialize -> JSON, no session id; unknown version -> 2025-11-25; 2025-06-18 echoed | same | SSE + session id; no `tasks` capability; key order differs |
| server/discover probe -> 400 -32000 | same | 400 -32602 "request _meta is missing ..." |
| stateless tools/list (lead, worker): verbatim tools incl. `execution.taskSupport` | same | 400 "Session ID is required" (typed `Tool` also drops `execution`) |
| ping, unknown method -32601, unknown tool -32602 (`MCP error -32602: Unknown tool: x`), notification-only 202, stateless tools/call JSON, tools/call with progressToken -> SSE + progress, batch -> JSON array | same | 400 / 415 |
| elicitation initialize -> SSE session; tools/list in it; DELETE 200; then 404 -32001 | same | different (no `tasks`, priming events) |
| `elicitation: {}` (old spelling) gets a session | same | same |
| url-only elicitation stays stateless | same | session |
| re-initialize inside a session -> 400 -32600 | same | 200, re-initialized |
| session of another token -> 404 -32001 | same | **200, served** |
| revoked token: its session answers 401 | same | same (middleware) |
| fifth session of a token closes the first | same | all five stay |
| elicitation round trip (accept) in a session | same | `elicitation/create` carries `_meta.progressToken` of the call, key order differs |
| MCP task: create (`ttl` clamped to 60 s..1 h, pollInterval 2000), tasks/get, tasks/list, tasks/result (blocks until done, `_meta["io.modelcontextprotocol/related-task"]`), get after, other token "not found" | same | not supported (400) |
| task for a tool without task support -> -32601 | same | 400 |
| tasks/cancel, then cancel again -> "Cannot cancel task in terminal status: cancelled" | same | 400 |
| in-flight cap: the 9th parallel call of a token -> 429 `Retry-After: 1` | same | 400 for all nine |
| client goes away during a stateless JSON call -> call aborted under 1 s | same | not noticed |
| client goes away during a session SSE call -> call aborted under 1 s | same | not noticed |

## Answers to the spike questions

1. **rmcp `StreamableHttpService` vs a custom dispatcher**: custom. rmcp would need a front that peeks every body to choose stateless vs session, a session manager bound to tokens with the 256 / 4 limits, custom request handlers for the whole 2025-11-25 task API and for `tasks` in the initialize result, its own error bodies replaced, its GET / DELETE / re-initialize behaviour overridden, and it still would not abort calls of vanished clients. At that point rmcp contributes only JSON-RPC routing, which is the small part.
2. **Stateless JSON**: prototype matches (JSON answer, no session id, SDK key order `result, jsonrpc, id`, errors `jsonrpc, id, error`, `MCP error <code>: ` prefix on McpError messages).
3. **SSE progress**: a stateless tools/call with a progressToken and an SSE Accept is answered as SSE (`event: message\ndata: <json>\n\n`); `notifications/progress` with JS numbers (no `.0`); `: keepalive\n\n` every 15 s (SDK 1.32.2 default, seen in the 120 s kill scenario); headers `cache-control: no-cache, no-transform`, `x-accel-buffering: no`.
4. **Elicitation sessions**: session only for an initialize with form elicitation (`form` key or the empty object), 256 total (above it the client is served stateless; implemented, not exercised), 4 per token (the oldest closed), bound to the token, closed on DELETE and on revoke; elicitation ids count from 0 per session; answer through a separate POST (202); 120 s timeout, cancel on failure.
5. **MCP tasks for wait_for**: the 2025-11-25 task wire of the SDK's InMemoryTaskStore is reproduced exactly (shapes above, private to the token, revoke ends the task). No CLI uses tasks today.
6. **Cancellation**: measured on hyper 1.12 http1 with its defaults (half-close off): when the client closes the connection, hyper drops the pending handler future (JSON mode: in `a_vanished_json_client_aborts_its_call` the client closes right after the call starts and the handler future is dropped 28 ms after the call started) or the response body (SSE mode), so a `DropGuard` / a guard in the body is enough to abort the call, release the in-flight slot and drop pending elicitations. No socket watcher is needed (one was tried and removed). With the real CLI killed: 1 ms from the connection close to the aborted wait_for in both runs (1.1.4: 3 ms and 1 ms).

## Latency (release build, `--protocol --bench`, 200 sequential requests, one connection per request, Windows 11, a loaded machine)

| server | stateless tools/list (9 KB) p50 / p95 / max ms | session ping p50 / p95 / max ms |
|---|---|---|
| 1.1.4 TS (in-process Node harness) | 1.88 / 12.62 / 57.41 (second run 1.75 / 29.29 / 50.31) | 0.77 / 3.37 / 12.38 (0.66 / 3.50 / 50.71) |
| custom | 0.54 / 1.06 / 4.21 (0.63 / 0.99 / 1.28) | 0.26 / 0.48 / 0.94 (0.36 / 0.78 / 0.96) |
| rmcp (stateless answers are its 400 errors, not comparable) | 0.34 / 2.45 / 8.79 (0.30 / 0.65 / 2.39) | 0.43 / 1.25 / 9.74 (0.39 / 0.97 / 3.49) |

CLI wall times (`claude mcp list` 2.5-6 s, `codex exec` 10-25 s) are dominated by CLI start-up and varied with machine load between runs for every server alike; they are not a server measurement.

## Notes for M1 / M2 / M4

- Copy from the prototype: check order, `json_error` bodies, the SDK transport checks (406 / 415 / batch > 100 / invalid JSON-RPC / already initialized / only one initialize / protocol-version header), session and task bookkeeping, `Release` + `SseBody` + `DropGuard`, hyper `header_read_timeout(10 s)` and the 30 s body deadline (408), constant-time token compare over all tokens.
- axum is used only as a fallback router; M1 may serve the hyper `service_fn` directly.
- M2: the fake's `cap_result` cuts with `String::from_utf16_lossy`; 1.1.4 `text.slice` can leave a lone surrogate that JSON.stringify writes as `\udXXX`. Use the F7 lone-surrogate handling when porting capResult.
- M4 / P4: Codex asks for its own approval of destructive MCP tools; 1.1.4 cells run interactive, so that prompt is unchanged, but scripted checks need `tools.<name>.approval_mode="approve"`.

## Open (not covered by this spike)

- Codex `accept` of an elicitation: `codex exec` always declines; the accept path needs the interactive TUI in a pty (M4 real-app checks). The server side of accept is proven with Claude.
- The long waits (Claude 600 s, Codex 170 s) through the Rust server: the 15 s keepalive is in place, but `MCP_CLI_WAIT` runs were not done (M4, verify-mcp-cli).
- 10 s header / 30 s body timeouts and the 120 / 60 per s bucket are implemented but not exercised by a test (M1 ports the mcp-protocol cases).
- macOS: not run (no Mac); the hyper drop behaviour should be the same, to be confirmed by CI / R3.
- rmcp with an unrestricted protocol list (would answer `server/discover`) was not exercised; not needed after the decision.
