# Agents and local MCP

MCP is optional. New grids default to **No MCP**, running ordinary terminals and agents with their original startup prompts. Existing grids do not acquire roles automatically.

## Enable selected cells

Choose a role for each agent in **New grid**:

| Role | Access |
| --- | --- |
| No MCP | Ordinary agent session without unimux tools |
| Worker | Its own tasks, result reporting, project messages and snippets |
| Coordinator | Worker tools, plus background grids, team presets and tasks assigned to other cells |

You can mix roles in one grid and save them in presets. Ordinary shell profiles do not use MCP. Claude Code and Codex receive local server configuration when a cell with a role starts.

Change a role later in **AI → Agents** or the cell's context menu. The app offers to apply it and restart the agent in the same action, resuming the saved conversation when a session is known. If no session is saved yet, it explains that a new conversation will start. You can also apply the role later and restart when ready. Choosing **No MCP** revokes tool access when the role is applied; restarting also removes the configuration from the client.

The Agents panel distinguishes **Restart required**, **MCP configured · waiting for agent** and **MCP connected**. A running local MCP server alone does not mean the selected agent has loaded its configuration or called a tool: **MCP connected** appears only once the agent's client listed or called the tools, and goes away after 10 minutes without such a request. When the MCP server cannot start (security software, for example), the app retries twice and the panel offers **Try again**.

## Work with a team

The **AI** button opens agents, tasks, messages and activity. Tasks move through queued, in-progress, blocked, completed and cancelled states. Completed results can include a summary, changed files, branch, commit and tests. Messages have read acknowledgements. The app persists these records with its local state.

Tasks and messages always enter a durable MCP inbox. Agents use `read_inbox` to retrieve their open tasks and unread messages together (`closed: true` adds closed tasks); `acknowledge: true` also marks the returned messages as read. A message longer than 8000 characters is returned clipped with a marker and stays unread; fetch it whole with `full: true` (which acknowledges it). When idle, agents call `wait_for` instead of polling: it blocks up to `timeoutSec` (max 45 s) and returns at once when an unread message or a startable task arrives that the agent has not been shown yet (items already returned by `read_inbox` or an earlier `wait_for` do not wake it again, so `read_inbox` followed by `wait_for` cannot spin; a blocked task counts as new once its prerequisites complete; a restart of the cell forgets what was shown). With `taskIds`, a coordinator waits until any (`all: true`: every) listed task is completed, blocked or cancelled, so it does not loop on `get_tasks`; a worker may only list its own tasks. Inbox delivery does not guarantee that a running model will wake up or begin work. Verified running Codex sessions can also receive content through `codex queue`, if their CLI supports it. Verification requires explicitly selecting a session from history; transcript timestamp matching alone is insufficient.

For Claude and unverified Codex sessions, use **Copy prompt** and paste into the terminal. A delivery failure does not delete the task; delivery can be retried. Cancelling a task changes its record but does not interrupt the model.

Each project holds up to 500 tasks and 500 messages. Finished tasks (completed or cancelled) and read messages older than 7 days are removed automatically, and when a project is full the oldest of them make room first. Open tasks, unread messages and completed tasks that an open task depends on always stay. Removing a project also removes its tasks, messages and activity. The **Tasks** and **Messages** tabs can remove one finished item or all of them (**Remove finished**, **Remove read**).

A startup prompt on a cell with a role becomes a tracked task with reporting instructions. Without a role, it stays ordinary prompt text. Agent-created grids run in the background without switching your active tab. Creating agents can consume model usage; the MCP instructions require an explicit user request to delegate work.

**Pause automation** blocks new agent mutations and automatic delivery. Agents can still read inboxes and report results for existing tasks. You can still create a grid directly in the UI.

## Example: implement, hand off, review

Use an existing grid and enable roles for selected cells, or start a new grid from a team preset. Give the cells recognizable names and colors, and choose a CLI profile per cell. Model choices come from that profile's CLI flags, not from the MCP role.

Ask the coordinator to delegate a feature to a backend worker, a frontend worker and a reviewer. The backend worker reports a completed result with the API contract, changed files and tests, then messages the frontend worker. The frontend worker integrates the contract and reports its result. The reviewer receives a separate task referencing both results, checks the diff and tests, and messages the coordinator with any findings.

An example prompt for the coordinator:

> Add a Backend worker and a Reviewer to this grid. Give them distinct names and colors. Assign Backend the catalog validation change, and make Review depend on that task. Require changed files and test results in the completion report. Use the existing checkout, with separate file ownership. Do not create another grid.

For an existing backend change, create the review or frontend task in the current team instead of spawning another grid. Coordinators can use `create_grid` with `gridId` to expand an existing grid, or with `name` to open a new background team. It accepts per-cell names, colors, profiles, model identifiers and startup prompts. A whole team takes one `create_grid` call, with no `get_context`, `create_task` or `get_tasks` first: the default profiles are `claude` and `codex`, a cell with `count: N` is repeated N times (names get a number), and `after: [positions of earlier cells]` chains startup tasks (the cell needs `role` and `prompt`; only earlier cells may be referenced). The result carries `cellIds` and `tasks` (`{cellId: taskId}`) that go straight into `wait_for`. Example: three workers and a reviewer whose task waits for all of them: `cells: [{profileId: "codex", role: "worker", name: "Dev", count: 3, prompt: "..."}, {profileId: "claude", role: "worker", name: "Review", prompt: "...", after: [0, 1, 2]}]`. `update_grid` changes a grid's name (its color is only stored; the tab strip shows the project color); `update_agent` changes an agent's name/color/profile/model. Model identifiers must be supported by your installed CLI. Profile/model changes apply on launch; inspect `needsRestart` and `restartReason` in the result. A requested restart is attempted only when the runtime can do it safely.

Keep the handoff in the task result so another agent can continue without reconstructing the terminal conversation. In a shared checkout, agree on file ownership; use worktrees if the work should happen on independent branches.

Coordinators can close another finished grid with `close_grid({ "gridId": "..." })`. This stops its agents and archives the grid in History, preserving its conversations and worktrees. If unfinished tasks remain, closing requires `cancelTasks: true`; those tasks are cancelled. A coordinator cannot close its own grid through MCP.

## Task dependencies

Create prerequisite tasks first, then pass their IDs in `dependsOn` when creating downstream work. For example, the frontend task depends on the backend task, and the review task depends on both implementation tasks:

```json
{
  "cellId": "frontend-cell-id",
  "title": "Connect the catalog UI",
  "prompt": "Use the API contract from the backend task result. Report files and tests.",
  "dependsOn": ["backend-task-id"]
}
```

`get_tasks` returns `ready` and `blockedBy`; `get_tasks({ "readyOnly": true })` lists queued work whose prerequisites are all completed. A task cannot be claimed `in_progress` while prerequisites remain unfinished. A cancelled or blocked prerequisite does not count as completed. Dependencies govern readiness and delivery, not whether a model wakes up automatically. Use messages for clarification and task results for the durable handoff.

The worker should call `get_context` first, mark its assigned task `in_progress` before editing, and report `completed` with a summary and evidence. If it cannot proceed, it should report `blocked` with a reason. Workers call `read_inbox` when starting or finishing work and use `wait_for` while idle, rather than polling; `acknowledge: true` batches acknowledgements of the messages returned.

## Tool reference

| Tools | Purpose | Who |
| --- | --- | --- |
| `get_context`, `list_agents` | Cell identity and inbox counts; compact agent list (`verbose` adds details) | all |
| `read_inbox`, `wait_for` | Open tasks and unread messages together; bounded waiting instead of polling | all |
| `update_task`, `send_message` | Report a task result; message an agent | all |
| `snippets` | `action`: `list`, `get`, `save`, `apply` - prompt library and presets | all |
| `update_agent`, `help` | Name and color (own; workers), profile, model, restart and other agents (coordinator only); longer guidance on demand | all |
| `create_task`, `get_tasks`, `deliver` | Assign tasks, project task view (paged with `next`), retry delivery | coordinator |
| `create_grid`, `update_grid`, `close_grid`, `save_preset` | Background teams (`gridId` appends cells), grid name (color stored only), archive, presets | coordinator |

The tool list depends on the role: a worker receives neither the coordinator tools (`create_task`, `get_tasks`, `deliver`, `create_grid`, `update_grid`, `close_grid`, `save_preset`) nor their schemas, and its `update_agent` offers only name and color. Coordinators see all of them. The previous one-tool-per-operation names (`list_library`, `get_snippet`, `save_snippet`, `apply_snippet`, `add_agents`, `get_messages`, `acknowledge_message`, `deliver_task`, `deliver_message`) are never listed but stay callable with their original inputs and full output records, as do the coordinator tools for a worker (the service then enforces the role). Unlisted names cost no tokens. Permissions are enforced by the service, not by the tool list; only a coordinator may change profile, model or restart an agent, including its own.

Results are compact: creating a task or message returns only `id` and delivery state, `update_task` returns `id` and status, long texts end with a `...[truncated N chars; full:true for all]` marker, and lists page with `next`. A reply is a single JSON text block without `structuredContent`, so a client never counts it twice.

## Token cost

Every MCP-enabled agent pays for the tool definitions and instructions in every conversation. Estimate (characters / 3.6): coordinator about 2200 tokens (was 4425), worker about 1190 (was 4425). Measure it and the latencies with `node scripts/mcp-bench.mjs`.

Agents are scoped to their own project. Workers see their own tasks and inbox; coordinators see project tasks. Agents can read global snippets, but write snippets in their project. Only the user changes roles or pauses automation.

The Streamable HTTP server listens on `127.0.0.1` on a random port. Each cell receives its own token, invalidated when the cell ends, restarts or loses its role; revoking a token also aborts that token's requests in flight (a waiting `wait_for` ends with "Agent connection has expired."). Foreign Host and Origin headers are rejected (DNS-rebinding protection). Requests are limited per token by a monotonic-clock token bucket (burst 120, 60 per second, then 429 with Retry-After) and by simultaneous requests (8 per token, 256 in total, also 429; rejected requests do not spend rate budget). Bodies are limited to 256 KB. Tokens are not placed in process arguments or persisted app state. Claude gets its token only in the cell's private `--mcp-config` file (`mcp/<cell>.json` in the app's data folder, written atomically, 0600 in a 0700 folder on macOS and Linux, under the user profile on Windows), not in its environment, so the processes the agent starts (shell tools, scripts, dev servers, npm packages) do not inherit it. The file stays while the cell's process runs (Claude may read it again on a reconnect) and goes together with the token: when the process exits or is stopped, when a start fails, on a start without MCP or as Codex, and when the cell is removed; leftovers are pruned at the next app start. With a data folder set through `MC_DATA_DIR` (development and tests only) the file is protected by that folder's permissions. Codex can take an HTTP server token only from an environment variable (`bearer_token_env_var`) or from `http_headers` in its config, which would put the token into the command typed into the cell's shell and its history, so Codex cells still get `UNIMUX_MCP_TOKEN`; Codex's default `shell_environment_policy` leaves variables with `TOKEN` in their name out of the commands it runs, unless the user changed it in their config. A process of the same user that deliberately reads the app's files can still find the token; the protection is against accidental inheritance. Cells started by 0.9.3 keep their environment token until they are restarted. Inboxes hold 500 tasks and 500 messages per project (with automatic removal of finished ones, see above). A result longer than 60,000 characters comes back as valid JSON `{truncated, hint, partial}`. A retry of a `create_grid`, `add_agents` or `close_grid` call by the same agent (same arguments) while the first is still running, or after its client gave up before the answer (within 5 minutes), gets the first answer instead of creating a second team; a call whose answer arrived is never replayed; a `create_grid` whose client disconnects while worktrees are being created removes those worktrees and keeps nothing.

## Claude Code and Codex

Claude gets `--mcp-config` with a per-cell file (`type: http`, literal header `Authorization: Bearer <cell token>`); Codex gets `-c mcp_servers.unimux.url=...`, `bearer_token_env_var="UNIMUX_MCP_TOKEN"` and `tool_timeout_sec=180` (the default 60 s is too short for a `create_grid` with many worktrees). Both connect to the local server and see the same tools. The schemas are flat (no `$ref`, `anyOf` or `null` types) because Codex passes them to the model unchanged.

Only Codex honours the tool hints, and it asks the user before a call unless the tool is `readOnlyHint`, or both `destructiveHint` and `openWorldHint` are false (Claude Code asks according to its own permission rules). The hints are:

| Hints | Tools |
| --- | --- |
| read-only, never asks | `get_context`, `list_agents`, `wait_for`, `get_tasks`, `help` |
| quiet write (own work only) | `read_inbox` (acknowledging), `update_task` for workers, `update_grid`, `save_preset` |
| asks (`openWorldHint: true`) | `send_message`, `create_task`, `deliver` (reach other agents' sessions), `snippets` (a saved snippet can be auto-sent; `list` and `get` ask too because a hint covers the whole tool), `update_agent` (name, color; for coordinators also profile, model, restart), `create_grid` (starts agents and spends model usage) |
| asks (`destructiveHint: true`) | `close_grid`, and `update_task` for coordinators (it can cancel other cells' tasks) |

A user who trusts the team can pre-approve tools in Codex with `default_tools_approval_mode` or `tools.<name>.approval_mode` under `[mcp_servers.unimux]`.

You can check the connection without a model: `node scripts/mcp-serve.mjs` starts the server with fake dependencies, then `claude mcp add --transport http ...` / `codex mcp add --url ... --bearer-token-env-var ...` with a temporary `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and `claude mcp list`, show the connection state.

## Migration from 0.6.7

Intended changes for clients that called the old tools by name:

- Replies are one JSON text block; `structuredContent` (`{ "result": ... }`) is gone.
- Listed tools return compact shapes: `get_context` (`cellId`, `name`, `role`, `project`, `inbox` counts; profiles only with `profiles: true`), `list_agents` (`{ agents, grids }` instead of an array; details with `verbose`), `read_inbox` (open tasks only unless `closed: true`, no `hasMoreTasks`/`hasMoreMessages` but `more`, no `createdAt`/`projectId`; `acknowledgedMessageIds` is kept), `get_tasks` (coordinators: `{ tasks, next }` rows without prompts unless `verbose`), `create_task`, `send_message`, `update_task`, `update_agent`, `create_grid`, `close_grid`, `update_grid`, `save_preset`, `snippets` (compact acknowledgements instead of the stored record).
- `read_inbox` accepts the old inputs (`limit` up to 100, `offset`, `openOnly`); `get_tasks` accepts `limit` up to 100; the default page is 20 and 25 instead of 50.
- `read_inbox` with `acknowledge: true` leaves clipped long messages unread.
- A worker can no longer change its own profile, model or restart; `wait_for` is limited to a worker's own tasks.
- Unlisted names (`list_library`, `get_snippet`, `save_snippet`, `apply_snippet`, `add_agents`, `get_messages`, `acknowledge_message`, `deliver_task`, `deliver_message`, and coordinator tools called by workers) keep their previous inputs and outputs.

## Verify the integration

```sh
npm run typecheck
npm test
npm run test:automation
```

The Electron automation smoke test uses temporary data and stub agent executables, without model calls. It exercises the actual MCP connection, forms, tasks, results, messages, pause controls and persistence. It requires Node.js 22 or newer and an Electron desktop environment. For README captures with real shell output, see [screenshots](screenshots/README.md).

[Polski](MCP.md) · [README](../README.md)
