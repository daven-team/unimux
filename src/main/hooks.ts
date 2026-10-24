// Local endpoint for agent status hooks. Claude gets a per-cell settings file (passed with
// --settings, the user's own settings.json is untouched) whose hooks post to this server: Claude Code 2.1.63+ posts itself
// (`type: "http"` hooks, the token in a header), older versions run `curl` through their hook shell.
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { parseCodexNotify, type CodexNotice } from '../shared/codexHooks';
import { SESSION_ID } from '../shared/sessionTrack';
import type { HookEvent, HookInfo } from '../shared/status';

/**
 * URL events: the status events plus SubagentStop, which reaches the tracker as a "subagent" busy hook, and Codex's notify.
 * Claude Code 2.1.78+ also gets the precise ones (see claudeExtendedHooks): pre / post = Pre/PostToolUse with the tool name,
 * permission = PermissionRequest (the moment a permission dialog opens), subagentstart, compact / compacted = Pre/PostCompact,
 * elicit / elicited = an MCP server's input request and its answer.
 */
export type HookUrlEvent = HookEvent | 'subagent' | 'codex' | ToolUrlEvent;
type ToolUrlEvent = 'pre' | 'post' | 'permission' | 'subagentstart' | 'compact' | 'compacted' | 'elicit' | 'elicited';
const EVENTS: HookUrlEvent[] = ['prompt', 'stop', 'stopbg', 'notify', 'busy', 'fail', 'subagent', 'codex'];
const TOOL_EVENTS = new Set<string>(['pre', 'post', 'permission', 'subagentstart', 'compact', 'compacted', 'elicit', 'elicited']);
/** Notification types that do not mean "the agent needs you now"; idle_prompt is its own (quiet) event, see notificationEvent. */
const IGNORED_NOTIFICATIONS = new Set(['auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed', 'plugin_notification', 'quota_auto_resume_disabled']);
/** Notification types that are a question for the user, and what kind of question. */
const ATTENTION_NOTIFICATIONS: Record<string, NonNullable<HookInfo['need']>> = {
  permission_prompt: 'permission', elicitation_dialog: 'elicitation', elicitation_url_dialog: 'elicitation',
  agent_needs_input: 'input', quota_auto_resume_stale: 'input',
};
/** How much of a tool hook's payload is read: its head (tool name and ids come first) and its tail (tool_use_id after a large input). */
const TOOL_HEAD = 16 * 1024;
const TOOL_TAIL = 2 * 1024;
const MAX_BODY = 16 * 1024;
/** The Stop / StopFailure payload carries last_assistant_message, so it may be much larger. */
const MAX_STOP_BODY = 512 * 1024;
/** Codex appends its whole notify payload (user and assistant messages) to the command line; one that big still means "turn done". */
const MAX_CODEX_BODY = 1024 * 1024;
const DEBUG_LOG_MAX = 256 * 1024;
const MAX_STATUS_STRINGS = 8;
const FINISHED_TASK = new Set(['completed', 'complete', 'done', 'finished', 'failed', 'error', 'killed', 'stopped', 'cancelled', 'canceled', 'exited', 'timeout']);
/** Documented StopFailure error codes. */
const FAILURE_CODES = new Set([
  'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
  'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown',
]);

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const p: unknown = JSON.parse(body);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Long-lived plumbing (a dev server started with run_in_background...) never means "the agent is still working". */
const PLUMBING_TASK = /shell|bash|command|monitor|process|server/i;

function isRunning(t: unknown): boolean {
  const status = (t as { status?: unknown } | null)?.status;
  return typeof status !== 'string' || !FINISHED_TASK.has(status.trim().toLowerCase());
}

/** A running task holds the cell "working" unless its type says shell-like plumbing; unknown or missing types hold (conservative). */
function holdsCell(t: unknown): boolean {
  if (!isRunning(t)) return false;
  const type = (t as { type?: unknown } | null)?.type;
  return typeof type !== 'string' || !PLUMBING_TASK.test(type);
}

/** Task types that keep a session busy for a long time: the documented `workflow` and the raw `local_workflow`. */
export const LONG_TASK = /workflow/i;

function isWorkflow(t: unknown): boolean {
  if (!isRunning(t)) return false;
  const type = (t as { type?: unknown } | null)?.type;
  return typeof type === 'string' && LONG_TASK.test(type);
}

type Payload = Record<string, unknown> | null;
/** A Stop body can be up to 512 KB: the helpers take it parsed once (or as text, then they parse it). */
const payload = (body: string | Payload): Payload => (typeof body === 'string' ? parseObject(body) : body);

/** True when a Stop payload lists a running background task of agent-like (or unknown) type; crons and shell tasks do not count. */
export function hasActiveBackgroundWork(body: string | Payload): boolean {
  const tasks = payload(body)?.background_tasks;
  return Array.isArray(tasks) && tasks.some(holdsCell);
}

/** Diagnostics for a Stop payload: task counts and the distinct status strings (never ids, names, commands or text). */
export function stopInfo(body: string | Payload): HookInfo {
  const parsed = payload(body);
  const tasks = parsed?.background_tasks;
  const continuation = parsed?.stop_hook_active === true;
  if (!Array.isArray(tasks)) return { tasks: 0, active: 0, statuses: [], types: [], continuation, workflows: 0, tasksUnknown: true };
  const statuses = new Set<string>();
  const types = new Set<string>();
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[^\w.-]/g, '').slice(0, 24) || '?' : '?');
  for (const t of tasks) {
    statuses.add(clean((t as { status?: unknown } | null)?.status));
    types.add(clean((t as { type?: unknown } | null)?.type));
  }
  return {
    tasks: tasks.length, active: tasks.filter(holdsCell).length,
    statuses: [...statuses].slice(0, MAX_STATUS_STRINGS), types: [...types].slice(0, MAX_STATUS_STRINGS), continuation,
    workflows: tasks.filter(isWorkflow).length,
  };
}

/** The StopFailure error code; anything not on the documented list (or malformed) is reported as "unknown". */
export function parseFailure(body: string): string {
  const error = parseObject(body)?.error;
  return typeof error === 'string' && FAILURE_CODES.has(error) ? error : 'unknown';
}

/** Opt-in diagnostics line for a Stop payload: key names plus each task's type and status only, never any text. */
export function stopDebugLine(cellId: string, body: string, now = new Date()): string {
  const p = parseObject(body);
  if (!p) return `${now.toISOString()} ${cellId} unparsable
`;
  const tasks = Array.isArray(p.background_tasks)
    ? p.background_tasks.map((t) => {
        const o = (t ?? {}) as { type?: unknown; status?: unknown; name?: unknown };
        const named = typeof o.name === 'string' && o.name ? '/named' : '';
        return `${typeof o.type === 'string' ? o.type.slice(0, 40) : '?'}/${typeof o.status === 'string' ? o.status.slice(0, 40) : '?'}${named}`;
      })
    : null;
  return `${now.toISOString()} ${cellId} keys=${Object.keys(p).join(',')} tasks=${tasks ? `[${tasks.join(' ')}]` : '?'} stop_hook_active=${p.stop_hook_active === true}
`;
}

const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);

/** Opt-in diagnostics line for StopFailure / SessionStart: the error code or the source, plus the payload's key names only. */
export function hookDebugLine(kind: 'fail' | 'session', cellId: string, body: string, now = new Date()): string {
  const p = parseObject(body);
  if (!p) return `${now.toISOString()} ${cellId} ${kind} unparsable\n`;
  const detail = kind === 'fail' ? `error=${parseFailure(body)}` : `source=${typeof p.source === 'string' && SESSION_SOURCES.has(p.source) ? p.source : '?'}`;
  return `${now.toISOString()} ${cellId} ${kind} ${detail} keys=${Object.keys(p).join(',')}\n`;
}

/** Appends a Stop / StopFailure / SessionStart diagnostics line to <dir>/hook-debug.log (restarted when it exceeds 256 KB). No-op when disabled. */
export function logStopDebug(enabled: boolean, dir: string, cellId: string, body: string, kind: 'stop' | 'fail' | 'session' = 'stop'): void {
  if (!enabled) return;
  try {
    const file = join(dir, 'hook-debug.log');
    mkdirSync(dir, { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch { /* no file yet */ }
    if (size > DEBUG_LOG_MAX) writeFileSync(file, '');
    appendFileSync(file, kind === 'stop' ? stopDebugLine(cellId, body) : hookDebugLine(kind, cellId, body));
  } catch { /* diagnostics are optional */ }
}
const CELL_ID = /^[\w-]{1,64}$/;

/**
 * The transcript a Claude hook payload names (`transcript_path`, with its `session_id`): the context meter reads it. Only the
 * main conversation's (a subagent's payload carries agent_id); the path must be a `<session id>.jsonl` file.
 */
export function transcriptOf(p: Record<string, unknown> | null): { sessionId: string; path: string } | null {
  if (!p || (p.agent_id !== undefined && p.agent_id !== null)) return null;
  const { session_id: sessionId, transcript_path: path } = p;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof path !== 'string' || path.length > 1024) return null;
  return path.replace(/\\/g, '/').toLowerCase().endsWith(`/${sessionId.toLowerCase()}.jsonl`) ? { sessionId, path } : null;
}

function noteTranscript(server: EventEmitter, cellId: string, p: Record<string, unknown> | null): void {
  const t = transcriptOf(p);
  if (t) server.emit('transcript', cellId, t.sessionId, t.path);
}

/** True when a Notification hook payload (JSON on stdin) is a real request for the user. */
export function isAttentionNotification(body: string): boolean {
  try {
    const type = (JSON.parse(body) as { notification_type?: unknown }).notification_type;
    return typeof type !== 'string' || !IGNORED_NOTIFICATIONS.has(type);
  } catch {
    return true; // unknown payload: err on the side of telling the user
  }
}

/**
 * What a Notification hook means for the status: a question for the user (with its kind), idle_prompt (Claude has been idle
 * at its prompt for a minute: a quiet end of a turn whose Stop was lost), a usage-limit wait that resumed by itself, or nothing.
 * Unknown types (and unparsable payloads) stay a question for the user: better one alert too many than a missed one.
 */
export function notificationEvent(body: string): { event: HookEvent; info?: HookInfo } | null {
  let type: unknown;
  try {
    type = (JSON.parse(body) as { notification_type?: unknown }).notification_type;
  } catch {
    return { event: 'notify' };
  }
  if (typeof type !== 'string') return { event: 'notify' };
  if (IGNORED_NOTIFICATIONS.has(type)) return null;
  if (type === 'idle_prompt') return { event: 'idle' };
  if (type === 'quota_auto_resume_fired') return { event: 'prompt' };
  const need = Object.hasOwn(ATTENTION_NOTIFICATIONS, type) ? ATTENTION_NOTIFICATIONS[type] : undefined;
  return { event: 'notify', info: need ? { need } : {} };
}

const TOOL_NAME = /^[\w.:@/-]{1,80}$/;
const TOOL_USE_ID = /^[\w-]{1,100}$/;

/** A string field of the payload's top level read from raw text: a quote right after `{` or `,` is never inside a JSON string. */
function rawField(text: string, key: string, last = false): string | undefined {
  const re = new RegExp(`[{,]\\s*"${key}"\\s*:\\s*"([^"\\\\]{1,100})"`, 'g');
  let found: string | undefined;
  for (const m of text.matchAll(re)) {
    found = m[1];
    if (!last) break;
  }
  return found;
}

export interface ToolHookFacts {
  tool?: string;
  toolUseId?: string;
  agentType?: string;
  inSubagent?: boolean;
  trigger?: 'manual' | 'auto';
}

/**
 * The facts of a tool hook payload (tool name, tool_use_id, the subagent, the compaction trigger) from its head, plus its tail
 * when the payload was longer (a PostToolUse payload carries the tool's whole output). Never any input or output text.
 */
export function toolHookFacts(head: string, tail = ''): ToolHookFacts {
  const whole = tail ? null : parseObject(head);
  const get = (key: string, last = false): unknown => (whole ? whole[key] : rawField(last ? `${head}${tail}` : head, key, last));
  const tool = get('tool_name');
  const id = get('tool_use_id', true);
  const agentType = get('agent_type');
  const agentId = get('agent_id');
  const trigger = get('trigger');
  return {
    ...(typeof tool === 'string' && TOOL_NAME.test(tool) ? { tool } : {}),
    ...(typeof id === 'string' && TOOL_USE_ID.test(id) ? { toolUseId: id } : {}),
    ...(typeof agentType === 'string' && TOOL_NAME.test(agentType) ? { agentType } : {}),
    ...(typeof agentId === 'string' && agentId ? { inSubagent: true } : {}),
    ...(trigger === 'manual' || trigger === 'auto' ? { trigger } : {}),
  };
}

/** Tools that always open a question for the user before they run (their PreToolUse is the moment it opens). */
const QUESTION_TOOLS = new Set(['AskUserQuestion']);

/** The status event of one of the precise Claude hooks (see HookUrlEvent); null when it says nothing. */
export function toolHookEvent(event: string, head: string, tail = ''): { event: HookEvent; info: HookInfo } | null {
  const f = toolHookFacts(head, tail);
  const tool = f.tool ? { tool: f.tool } : {};
  const id = f.toolUseId ? { toolUseId: f.toolUseId } : {};
  switch (event) {
    case 'pre':
      if (f.tool && QUESTION_TOOLS.has(f.tool)) return { event: 'notify', info: { need: 'question', immediate: true, ...tool, ...id } };
      return { event: 'busy', info: { ...tool, ...id } };
    case 'post': return { event: 'busy', info: { ...tool, ...id, toolEnd: true } };
    case 'permission': return { event: 'notify', info: { need: 'permission', immediate: true, ...tool } };
    case 'subagentstart': return { event: 'busy', info: { subagent: true, subagentStart: true, ...(f.agentType ? { agentType: f.agentType } : {}) } };
    case 'compact': return { event: 'compact', info: f.trigger ? { trigger: f.trigger } : {} };
    case 'compacted': return { event: 'compacted', info: f.trigger ? { trigger: f.trigger } : {} };
    case 'elicit': return { event: 'notify', info: { need: 'elicitation', immediate: true } };
    case 'elicited': return { event: 'busy', info: { answered: true } };
    default: return null;
  }
}

/** Extracts the conversation id from a SessionStart payload; null for anything malformed. Never logs the body. */
export function parseSessionStart(body: string): { sessionId: string; source: string | undefined } | null {
  try {
    const p = JSON.parse(body) as { session_id?: unknown; source?: unknown; agent_id?: unknown };
    if (p?.agent_id !== undefined && p.agent_id !== null) return null; // subagent / teammate context, not the cell's conversation
    if (typeof p?.session_id !== 'string' || !SESSION_ID.test(p.session_id)) return null;
    const source = typeof p.source === 'string' && SESSION_SOURCES.has(p.source) ? p.source : undefined;
    return { sessionId: p.session_id, source };
  } catch {
    return null;
  }
}

export class HookServer extends EventEmitter {
  readonly token = randomBytes(16).toString('hex');
  private server: Server | null = null;
  port = 0;
  /** Current spawn nonce per cell; hook URLs carry it. */
  private nonces = new Map<string, string>();
  /** Set (from MC_HOOK_DEBUG=1) to the user data dir to log Stop / StopFailure / SessionStart payload shapes. */
  debugDir: string | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      // h/<token>/<cellId>/<event>/<nonce> (curl), or k/<cellId>/<event>/<nonce> with the token as a bearer header (http hooks).
      const parts = (req.url ?? '').split('/').filter(Boolean);
      if (parts[0] === 'k' && req.headers.authorization === `Bearer ${this.token}`) parts.splice(0, 1, 'h', this.token);
      if (req.method !== 'POST' || parts[0] !== 'h' || parts[1] !== this.token) {
        res.writeHead(403).end();
        return;
      }
      let cellId = '';
      try {
        cellId = decodeURIComponent(parts[2] ?? '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      const event = parts[3] as HookUrlEvent;
      if (!CELL_ID.test(cellId)) {
        res.writeHead(400).end();
        return;
      }
      // Each spawn gets a fresh nonce: late requests of a killed process (or old-format URLs without one) are dropped.
      const current = this.nonces.get(cellId) === parts[4] && parts[4] !== undefined;
      let body = '';
      // Precise tool hooks: only the head and the tail of the payload are kept (never "oversized", never dropped).
      const toolEvent = TOOL_EVENTS.has(event);
      let tail = '';
      const bigPayload = event === 'stop' || event === 'fail' || event === 'codex';
      const maxBody = event === 'codex' ? MAX_CODEX_BODY : bigPayload ? MAX_STOP_BODY : MAX_BODY;
      // An http hook always posts its whole payload (a PostToolUse one carries the tool's output, a prompt its whole text);
      // events whose status needs no payload never keep it.
      const keepBody = bigPayload || BODY_EVENTS.has(event);
      req.setEncoding('utf8');
      let oversized = false;
      req.on('data', (chunk: string) => {
        if (toolEvent) {
          const room = TOOL_HEAD - body.length;
          if (room > 0) body += chunk.slice(0, room);
          if (chunk.length > room) tail = (tail + chunk.slice(Math.max(0, room))).slice(-TOOL_TAIL);
          return;
        }
        if (oversized || !keepBody) return;
        body += chunk;
        if (body.length <= maxBody) return;
        // Only Stop / StopFailure may carry a large payload (last message). They must never be lost: an oversized one
        // counts as a plain Stop / an unknown failure; any other oversized request is dropped. It is still read to the end
        // and answered: an http hook whose connection breaks shows the user a hook error.
        oversized = true;
        body = '';
      });
      req.on('end', () => {
        // 204 without a body: hook stdout would otherwise be fed back to Claude as context.
        res.writeHead(204).end();
        if (!cellId || !current) return;
        if (oversized && !bigPayload) return;
        if (event === 'codex') {
          // An oversized payload (nothing parsed) still ends the turn, just without ids.
          const notice = oversized ? {} : parseCodexNotify(body);
          if (notice) this.emit('codex', cellId, notice satisfies CodexNotice);
          return;
        }
        if (event === 'session') {
          const parsed = parseSessionStart(body);
          noteTranscript(this, cellId, parseObject(body));
          if (parsed) {
            logStopDebug(!!this.debugDir, this.debugDir ?? '', cellId, body, 'session');
            this.emit('session', cellId, parsed.sessionId, parsed.source);
            // Separate from 'hook': it never changes the status by itself, it only ends background mode.
            this.emit('sessionstart', cellId, parsed.source);
          }
          return;
        }
        if (toolEvent) {
          const mapped = toolHookEvent(event, body, tail);
          if (mapped) this.emit('hook', cellId, mapped.event, mapped.info);
          return;
        }
        if (!EVENTS.includes(event)) return;
        if (event === 'notify') {
          const mapped = notificationEvent(body);
          if (mapped) this.emit('hook', cellId, mapped.event, mapped.info);
          return;
        }
        if (event === 'stop') {
          logStopDebug(!!this.debugDir, this.debugDir ?? '', cellId, body);
          const parsed = parseObject(body);
          noteTranscript(this, cellId, parsed);
          this.emit('hook', cellId, hasActiveBackgroundWork(parsed) ? 'stopbg' : 'stop', stopInfo(parsed));
          return;
        }
        if (event === 'fail') {
          logStopDebug(!!this.debugDir, this.debugDir ?? '', cellId, body, 'fail');
          this.emit('hook', cellId, 'fail', { error: parseFailure(body) } satisfies HookInfo);
          return;
        }
        if (event === 'stopbg') return; // internal event, only derived from Stop
        if (event === 'subagent') {
          this.emit('hook', cellId, 'busy', { subagent: true } satisfies HookInfo);
          return;
        }
        this.emit('hook', cellId, event);
      });
    });
    this.server.requestTimeout = 5000;
    // A listen that fails (loopback blocked by security software) rejects instead of never settling.
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      const timer = setTimeout(() => { server.off('error', fail); reject(new Error('hook server did not start listening in time')); }, 10_000);
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); server.off('error', fail); resolve(); });
    });
    // Later errors of a running server are not fatal for the app.
    server.on('error', () => undefined);
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop(): void {
    this.server?.close();
  }

  /** Hook URL for the cell's current spawn (a nonce is created on first use). */
  url(cellId: string, event: HookUrlEvent): string {
    let nonce = this.nonces.get(cellId);
    if (!nonce) this.nonces.set(cellId, (nonce = randomBytes(8).toString('hex')));
    return `http://127.0.0.1:${this.port}/h/${this.token}/${encodeURIComponent(cellId)}/${event}/${nonce}`;
  }

  /** Hook URL a Codex process of the cell posts its notify payload to; a fresh nonce invalidates the previous process. */
  prepareCodex(cellId: string): string {
    this.nonces.set(cellId, randomBytes(8).toString('hex'));
    return this.url(cellId, 'codex');
  }

  /** Hook URL of an http hook: the token travels in the Authorization header instead of the path. */
  headerUrl(cellId: string, event: HookUrlEvent): string {
    return this.url(cellId, event).replace(`/h/${this.token}/`, '/k/');
  }

  /**
   * Writes the per-cell Claude settings file and returns its path. `claudeVersion` (the detected `claude --version`) picks
   * the hook form; an unknown version keeps the curl commands every version runs. `form` overrides it (http hooks found blocked).
   */
  writeClaudeSettings(dir: string, cellId: string, claudeVersion?: string, form: ClaudeHookForm = claudeHookForm(claudeVersion)): string {
    mkdirSync(dir, { recursive: true });
    this.nonces.set(cellId, randomBytes(8).toString('hex')); // invalidates hooks of the previous process
    const path = join(dir, `claude-${cellId}.json`);
    const target: HookTarget = { url: (event) => this.url(cellId, event), headerUrl: (event) => this.headerUrl(cellId, event), token: this.token };
    writeFileSync(path, JSON.stringify(claudeHookSettings(target, form, claudeExtendedHooks(claudeVersion)), null, 2), { mode: 0o600 });
    return path;
  }

  /** The cell is gone for good: its nonce goes too (late hooks of its last process are dropped like unknown ones). */
  forget(cellId: string): void {
    this.nonces.delete(cellId);
  }
}

/**
 * The curl command of one Claude hook. `--noproxy '*'`: the cell keeps the user's proxy variables, and a proxy must never
 * see (or swallow) the request to 127.0.0.1 - the same as the Codex notify hook. The quoting is POSIX: Claude Code runs hook
 * commands with a POSIX shell (Git Bash on Windows).
 */
export function claudeHookCommand(url: string, withBody: boolean): string {
  return `curl -s --noproxy '*' -m 2 -X POST ${withBody ? '--data-binary @- ' : ''}${url}`;
}

/** Hooks that only say "still busy": fire-and-forget, so no tool call waits for a process start. */
const ASYNC_EVENTS = new Set<HookUrlEvent>(['busy', 'subagent']);
/** Only Notification, Stop (background_tasks), StopFailure (error) and SessionStart need their payload (JSON on stdin); tool hooks would upload whole files. */
const WITH_BODY = new Set<HookUrlEvent>(['notify', 'stop', 'fail', 'session']);

/** Small payloads the server keeps (Stop, StopFailure and Codex have their own, larger limits). */
const BODY_EVENTS = new Set<string>(['notify', 'session']);

/**
 * How a Claude cell's hooks reach the server:
 * - `shell`: a curl command through Claude Code's hook shell (Git Bash on Windows): two process starts per hook.
 * - `http` (Claude Code 2.1.63+, changelog "Added HTTP hooks"): Claude Code posts the payload itself, no process at all.
 *   SessionStart accepts only command hooks, so it stays a curl command.
 * - `exec` (2.1.139+, changelog "Added hook `args` field (exec form)"): as `http`, and SessionStart's curl starts without a shell.
 */
export type ClaudeHookForm = 'shell' | 'http' | 'exec';
const HTTP_HOOKS_SINCE = [2, 1, 63];
const EXEC_HOOKS_SINCE = [2, 1, 139];

function atLeast(version: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
}

/**
 * 2.1.78 is the first version with every event of the precise set (changelog: SubagentStart 2.0.43, PermissionRequest 2.0.45,
 * Elicitation / ElicitationResult / PostCompact 2.1.76, StopFailure 2.1.78). Older or unknown versions keep the basic set.
 */
const EXTENDED_HOOKS_SINCE = [2, 1, 78];

/** True when the Claude Code version gets the precise status hooks (PermissionRequest, tool names, compaction...). */
export function claudeExtendedHooks(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? '');
  return !!m && atLeast([Number(m[1]), Number(m[2]), Number(m[3])], EXTENDED_HOOKS_SINCE);
}

/** The hook form a Claude Code version supports; an unknown or unparsable version gets the curl commands. */
export function claudeHookForm(version: string | undefined): ClaudeHookForm {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? '');
  if (!m) return 'shell';
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  return atLeast(v, EXEC_HOOKS_SINCE) ? 'exec' : atLeast(v, HTTP_HOOKS_SINCE) ? 'http' : 'shell';
}

/** Where a cell's hooks post: the curl URL (token in the path) and the http hook URL (token in a header). */
export interface HookTarget {
  url: (event: HookUrlEvent) => string;
  headerUrl: (event: HookUrlEvent) => string;
  token: string;
}

const PROXY_VARS = /^(https?|all)_proxy$/i;

/**
 * Claude Code sends http hooks through the proxy of HTTP(S)_PROXY even to 127.0.0.1 (checked with 2.1.309: a dead proxy lost
 * every hook); curl's `--noproxy '*'` has no http hook counterpart. A cell with a proxy therefore gets 127.0.0.1 in NO_PROXY
 * (in every spelling it already has, else NO_PROXY; on macOS also no_proxy). Mutates and returns `env`.
 */
export function bypassProxyForHooks(env: Record<string, string>, platform: string = process.platform): Record<string, string> {
  if (!Object.keys(env).some((key) => PROXY_VARS.test(key) && env[key].trim())) return env;
  const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'no_proxy');
  if (!keys.length) keys.push(...(platform === 'win32' ? ['NO_PROXY'] : ['NO_PROXY', 'no_proxy']));
  for (const key of keys) {
    const list = (env[key] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    if (!list.includes('127.0.0.1') && !list.includes('*')) env[key] = [...list, '127.0.0.1'].join(',');
  }
  return env;
}

/** Seconds an http hook may take; the server answers at once, so this only bounds a hung app (curl has `-m 2`). */
const HTTP_HOOK_TIMEOUT = 5;

/** The `hooks` settings of a Claude cell (pure, for the tests). A bare URL function means the curl form. */
export function claudeHookSettings(target: HookTarget | ((event: HookUrlEvent) => string), form: ClaudeHookForm = 'shell', extended = false): { hooks: Record<string, unknown[]> } {
  const t: HookTarget = typeof target === 'function' ? { url: target, headerUrl: target, token: '' } : target;
  const command = (event: HookUrlEvent): Record<string, unknown> => {
    const body = WITH_BODY.has(event);
    if (form === 'exec') return { type: 'command', command: 'curl', args: ['-s', '--noproxy', '*', '-m', '2', '-X', 'POST', ...(body ? ['--data-binary', '@-'] : []), t.url(event)] };
    return { type: 'command', command: claudeHookCommand(t.url(event), body), ...(ASYNC_EVENTS.has(event) ? { async: true } : {}) };
  };
  const http = (event: HookUrlEvent): Record<string, unknown> =>
    ({ type: 'http', url: t.headerUrl(event), headers: { Authorization: `Bearer ${t.token}` }, timeout: HTTP_HOOK_TIMEOUT });
  const hook = (event: HookUrlEvent) => [{ hooks: [form === 'shell' || event === 'session' ? command(event) : http(event)] }];
  // PreToolUse/PostToolUse/SubagentStop mark "still busy": the agent keeps working after a Stop that only ended a turn
  // (background tasks) or after a permission prompt was answered. As curl commands they run in the background (`async`): the
  // tracker already ignores a busy that trails a Stop or a permission prompt, so their order relative to the other hooks does
  // not matter. An http hook cannot be async, but the local server answers within a millisecond.
  // Prompt, Stop, Notification, StopFailure and SessionStart stay synchronous: they carry the status and their order counts.
  const basic = {
    UserPromptSubmit: hook('prompt'), Stop: hook('stop'), Notification: hook('notify'),
    PreToolUse: hook('busy'), PostToolUse: hook('busy'), SubagentStop: hook('subagent'),
    // /resume and /clear start a different conversation; the payload carries its session_id.
    SessionStart: hook('session'),
    // A turn that ends with an API error (rate limit, billing, auth...) fires StopFailure, never Stop.
    StopFailure: hook('fail'),
  };
  if (!extended || form === 'shell') return { hooks: basic };
  // The precise set (http hooks: Claude Code posts the payload itself, the server keeps only its head and tail).
  // PermissionRequest fires the moment a permission dialog opens; the Notification `permission_prompt` only after about six
  // seconds without a keystroke (hooks docs), so it stays as the fallback. The server answers 204: no decision, the dialog shows.
  return { hooks: {
    ...basic,
    PreToolUse: hook('pre'), PostToolUse: hook('post'), PostToolUseFailure: hook('post'), PermissionDenied: hook('post'),
    PermissionRequest: hook('permission'), SubagentStart: hook('subagentstart'),
    PreCompact: hook('compact'), PostCompact: hook('compacted'), Elicitation: hook('elicit'), ElicitationResult: hook('elicited'),
  } };
}
