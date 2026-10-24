import { randomBytes, randomUUID } from 'crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { McpInfo } from '../shared/automation';
import { findCell } from '../shared/state';
import type { AutomationService } from './automation';
import { ELICIT_TIMEOUT_MS, callTool, describeError, mcpInstructions, supportsTask, toolsForRole, type Elicit, type McpToolContext } from './mcpTools';

export interface McpServerOptions {
  /** Per-token request budget: `burst` requests at once, refilled at `perSecond`. `false` disables it (benchmarks). */
  rateLimit?: { burst: number; perSecond: number } | false;
  /** Simultaneous requests: per token (a waiting agent holds one) and in total. */
  maxInFlightPerToken?: number;
  maxInFlight?: number;
  /** Monotonic millisecond clock; replaceable in tests. Wall-clock changes must never refill or drain the budget. */
  now?: () => number;
  /** Where internal failures are reported (the crash log); never gets tool arguments. */
  log?: (message: string) => void;
  /** Translates the texts the user reads in elicitations (the app language); English when absent. */
  tr?: McpToolContext['tr'];
}
const MAX_BODY = 256 * 1024;
/** Sessions (clients that can answer elicitations) per token and in total; the oldest of a token is closed for a new one. */
const MAX_SESSIONS_PER_TOKEN = 4;
const MAX_SESSIONS = 256;
/** MCP tasks per token that may run at once, and how long a task and its result are kept. */
const MAX_RUNNING_TASKS = 16;
const TASK_TTL_MS = 60 * 60_000;
const MIN_TASK_TTL_MS = 60_000;
const TASK_POLL_MS = 2000;

/**
 * The MCP SDK (with its zod/ajv graph, about 300 ms to load) is loaded on the first agent request, not at startup: listening
 * only needs Node's http, so the port is known at once and the window does not wait for the SDK (0.9.4).
 */
let sdkLoad: Promise<McpSdk> | undefined;
type McpSdk = Awaited<ReturnType<typeof importSdk>>;
async function importSdk() {
  const [server, http, types, tasks] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
    import('@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'),
  ]);
  return {
    Server: server.Server, StreamableHTTPServerTransport: http.StreamableHTTPServerTransport, InMemoryTaskStore: tasks.InMemoryTaskStore,
    CallToolRequestSchema: types.CallToolRequestSchema, ListToolsRequestSchema: types.ListToolsRequestSchema, ErrorCode: types.ErrorCode, McpError: types.McpError,
  };
}
/** Loads the SDK once (a failed load is tried again by the next request). */
export function loadMcpSdk(): Promise<McpSdk> {
  sdkLoad ??= importSdk().catch((error: unknown) => { sdkLoad = undefined; throw error; });
  return sdkLoad;
}
/** Safety net for a single tool result; the tools already shape and truncate their output. */
const MAX_RESULT_CHARS = 60000;
/** A cell counts as connected while its agent listed or called tools this recently. */
export const CONNECTED_WINDOW_MS = 10 * 60_000;

/** A result over the cap stays valid JSON: the beginning travels as a string, with a hint to narrow the request. */
export function capResult(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const hint = 'narrow the request (filters, limit/offset paging, verbose:false)';
  // JSON escaping can grow the partial text, so it is cut until the whole envelope fits.
  for (let room = max - 200; room > 0; room = Math.floor(room * 0.8)) {
    const out = JSON.stringify({ truncated: true, hint, partial: text.slice(0, room) });
    if (out.length <= max) return out;
  }
  return JSON.stringify({ truncated: true, hint });
}

/**
 * A client session. Requests without a session stay stateless (one SDK server per HTTP request, JSON answers). A client
 * whose `initialize` declares the elicitation capability (Claude Code 2.1.x) gets a session instead: its tool calls are
 * answered as SSE streams, so a call can ask the user a question on its own stream and the answer (a separate POST of the
 * same session) reaches the waiting call. A session belongs to one token; revoking the token closes it.
 */
interface Session {
  id: string;
  token: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** The HTTP request each JSON-RPC request id of this session arrived in (its abort ends a call whose client went away). */
  requests: Map<string | number, AbortController>;
}

const jsonError = (code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
const messagesOf = (body: unknown): unknown[] => (Array.isArray(body) ? body : [body]);
/** Ids of the JSON-RPC requests (not responses or notifications) in a POST body. */
const requestIds = (body: unknown): Array<string | number> => messagesOf(body).flatMap((m) => {
  const msg = m as { id?: unknown; method?: unknown } | null;
  return msg && typeof msg.method === 'string' && (typeof msg.id === 'string' || typeof msg.id === 'number') ? [msg.id] : [];
});
/** An `initialize` from a client that can answer form elicitations (`elicitation: {}` is the older spelling of form support). */
function wantsSession(body: unknown): boolean {
  return messagesOf(body).some((m) => {
    const msg = m as { method?: unknown; params?: { capabilities?: { elicitation?: unknown } } } | null;
    const elicitation = msg?.method === 'initialize' ? msg.params?.capabilities?.elicitation : undefined;
    return !!elicitation && typeof elicitation === 'object' && ('form' in elicitation || Object.keys(elicitation).length === 0);
  });
}
/** The body as text, or null when it is larger than MAX_BODY (it is still read to the end, so the 413 reaches the client). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class UnimuxMcpServer {
  private http: HttpServer | null = null;
  private tokens = new Map<string, string>();
  private tokenOf = new Map<string, string>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private inFlightByToken = new Map<string, number>();
  /** Requests and MCP tasks in progress per token; revoking the token aborts them (a waiting wait_for ends at once). */
  private aborts = new Map<string, Set<AbortController>>();
  /** When each cell's agent last listed or called tools successfully (monotonic clock). */
  private lastSeen = new Map<string, number>();
  private connections = new Set<Server>();
  private sessions = new Map<string, Session>();
  /** MCP tasks per token: another cell's token never sees them. */
  private taskStores = new Map<string, InMemoryTaskStore>();
  private info: McpInfo = { running: false };
  private readonly limits: Required<Omit<McpServerOptions, 'log' | 'tr'>>;
  private readonly log: (message: string) => void;
  private readonly tr: McpToolContext['tr'];
  private readonly changeListeners = new Set<() => void>();
  constructor(private readonly service: AutomationService, options: McpServerOptions = {}) {
    const { log, tr, ...limits } = options;
    this.limits = { rateLimit: { burst: 120, perSecond: 60 }, maxInFlightPerToken: 8, maxInFlight: 256, now: () => performance.now(), ...limits };
    this.log = log ?? (() => undefined);
    this.tr = tr;
  }
  getInfo(): McpInfo {
    const now = this.limits.now();
    const connected = [...this.lastSeen].filter(([cellId, at]) => this.tokenOf.has(cellId) && now - at < CONNECTED_WINDOW_MS).map(([cellId]) => cellId);
    return { ...this.info, configuredCellIds: [...this.tokenOf.keys()], connectedCellIds: connected };
  }
  /** Open client sessions (diagnostics and tests). */
  get sessionCount(): number { return this.sessions.size; }
  /** Called when the info changes (a token issued or revoked, a cell seen for the first time, the server started). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }
  private changed(): void { for (const listener of this.changeListeners) listener(); }
  /** A successful tools/list or tools/call: the agent's MCP client really works. */
  private seen(cellId: string): void {
    const first = !this.lastSeen.has(cellId) || this.limits.now() - this.lastSeen.get(cellId)! >= CONNECTED_WINDOW_MS;
    this.lastSeen.set(cellId, this.limits.now());
    if (first) this.changed();
  }
  issueToken(cellId: string): string {
    this.revokeCell(cellId);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, cellId);
    this.tokenOf.set(cellId, token);
    this.changed();
    return token;
  }
  revokeCell(cellId: string): void {
    this.lastSeen.delete(cellId);
    const token = this.tokenOf.get(cellId);
    if (token === undefined) return;
    this.changed();
    this.tokenOf.delete(cellId);
    this.tokens.delete(token);
    this.buckets.delete(token);
    this.inFlightByToken.delete(token);
    for (const controller of this.aborts.get(token) ?? []) controller.abort();
    this.aborts.delete(token);
    for (const session of [...this.sessions.values()]) if (session.token === token) this.closeSession(session);
    this.taskStores.get(token)?.cleanup();
    this.taskStores.delete(token);
  }
  /** Starts listening; a call while a start is in progress joins it (one server, never two). */
  start(): Promise<void> {
    if (this.http?.listening) return Promise.resolve();
    this.starting ??= this.listen().finally(() => { this.starting = null; });
    return this.starting;
  }
  private starting: Promise<void> | null = null;
  private async listen(): Promise<void> {
    const http = createServer((req, res) => { void this.handle(req, res).catch((error: unknown) => {
      // Name and message only: never the request body (tool arguments may carry user text).
      this.log(`MCP request failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 300));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'MCP request failed.' }));
      else if (!res.writableEnded) res.end();
    }); });
    http.requestTimeout = 30000;
    http.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
    });
    http.on('error', (error) => this.log(`MCP server error: ${error.message}`.slice(0, 300)));
    this.http = http;
    const port = (http.address() as AddressInfo).port;
    this.info = { running: true, url: `http://127.0.0.1:${port}/mcp` };
    this.changed();
  }
  private allow(token: string): boolean {
    const limit = this.limits.rateLimit;
    if (!limit) return true;
    const now = this.limits.now();
    const bucket = this.buckets.get(token) ?? { tokens: limit.burst, at: now };
    // A clock that moved backwards refills nothing (never negative) and becomes the new reference point.
    bucket.tokens = Math.min(limit.burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * limit.perSecond);
    bucket.at = now;
    this.buckets.set(token, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = this.info.url!;
    const port = new URL(url).port;
    // DNS-rebinding hardening: only the literal local origins may talk to the server.
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host ?? '')) { res.writeHead(403).end(); return; }
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) { res.writeHead(403).end(); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const actorId = token ? this.tokens.get(token) : undefined;
    if (!token || !actorId) { res.writeHead(401).end(); return; }
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    // A session ends with DELETE (the client is done); a session of another token is unknown to this one.
    if (req.method === 'DELETE' && sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.token !== token) { res.writeHead(404).end(); return; }
      this.closeSession(session);
      res.writeHead(200).end();
      return;
    }
    // No standalone SSE stream (GET): everything a call sends travels on that call's own response.
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const inFlight = this.inFlightByToken.get(token) ?? 0;
    // Cheap concurrency checks first, so a rejected request does not also spend rate budget.
    if (inFlight >= this.limits.maxInFlightPerToken || this.connections.size >= this.limits.maxInFlight || !this.allow(token)) {
      res.writeHead(429, { 'Retry-After': '1' }).end(); return;
    }
    this.inFlightByToken.set(token, inFlight + 1);
    const abort = new AbortController();
    const controllers = this.aborts.get(token) ?? new Set<AbortController>();
    controllers.add(abort);
    this.aborts.set(token, controllers);
    let sdk: McpSdk;
    let raw: string | null;
    try {
      [sdk, raw] = await Promise.all([loadMcpSdk(), readBody(req)]);
    } catch (error) { this.release(token, abort, controllers); throw error; }
    if (raw === null) { this.release(token, abort, controllers); res.writeHead(413, { 'Content-Type': 'application/json' }).end(jsonError(-32000, 'Request body too large.')); return; }
    let body: unknown;
    try { body = JSON.parse(raw); } catch {
      this.release(token, abort, controllers);
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(jsonError(-32700, 'Parse error: invalid JSON.'));
      return;
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      // Unknown, closed (revoked) or another token's session: 404 tells the client to initialize again.
      if (!session || session.token !== token) {
        this.release(token, abort, controllers);
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(jsonError(-32001, 'Session not found.'));
        return;
      }
      const ids = requestIds(body);
      for (const id of ids) session.requests.set(id, abort);
      res.once('close', () => {
        for (const id of ids) if (session.requests.get(id) === abort) session.requests.delete(id);
        this.release(token, abort, controllers);
      });
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (wantsSession(body) && this.sessions.size < MAX_SESSIONS) {
      const session = { token, requests: new Map<string | number, AbortController>() } as Session;
      session.transport = new sdk.StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(), enableJsonResponse: false,
        onsessioninitialized: (id) => { session.id = id; this.sessions.set(id, session); this.trimSessions(token); },
      });
      session.server = this.buildServer(sdk, token, actorId, { session });
      session.server.onclose = () => { if (this.sessions.get(session.id) === session) this.sessions.delete(session.id); };
      res.once('close', () => this.release(token, abort, controllers));
      await session.server.connect(session.transport);
      // Revoked while the SDK loaded: the session must not outlive its token.
      if (this.tokens.get(token) !== actorId) { await session.server.close().catch(() => undefined); res.writeHead(401).end(); return; }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    const server = this.buildServer(sdk, token, actorId, { abort });
    const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    this.connections.add(server);
    res.once('close', () => {
      this.release(token, abort, controllers);
      this.connections.delete(server);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      this.connections.delete(server);
      await server.close().catch(() => undefined);
      throw error;
    }
  }
  /** The SDK server of one stateless request or one session; tools, tasks and elicitations run with the token's permissions. */
  private buildServer(sdk: McpSdk, token: string, actorId: string, mode: { session?: Session; abort?: AbortController }): Server {
    const { Server, CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } = sdk;
    const found = findCell(this.service.state.get(), actorId);
    const role = this.service.roleOf(actorId);
    const server = new Server({ name: 'unimux', version: '1.1.0' }, {
      capabilities: { tools: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
      instructions: mcpInstructions(role, { cellId: actorId, name: found?.cell.name, project: found?.project.name }),
      taskStore: this.taskStoreFor(sdk, token),
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = toolsForRole(this.service.roleOf(actorId));
      if (this.tokens.get(token) === actorId) this.seen(actorId);
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      // Recheck the token on every call, including calls racing with a cell restart.
      const live = () => this.tokens.get(token) === actorId;
      const requestAbort = mode.session ? mode.session.requests.get(extra.requestId) : mode.abort;
      const signal = requestAbort ? AbortSignal.any([extra.signal, requestAbort.signal]) : extra.signal;
      const base = { service: this.service, actorId, tr: this.tr };
      if (params.task) {
        if (!live()) throw new McpError(ErrorCode.InvalidRequest, 'Agent connection has expired.');
        if (!supportsTask(params.name)) throw new McpError(ErrorCode.MethodNotFound, `Tool ${params.name} does not run as a task.`);
        return this.startTask(sdk, token, actorId, params, base, extra.taskStore!, params.task.ttl);
      }
      const capabilities = server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
      const elicit = mode.session && capabilities && ('form' in capabilities || Object.keys(capabilities).length === 0) ? this.elicitFor(server, extra.requestId, signal) : undefined;
      let value: unknown;
      try {
        if (!live()) throw new Error('Agent connection has expired.');
        value = await callTool(params.name, params.arguments, { ...base, signal, elicit });
        // Revoked while the call was running (a waiting wait_for is aborted by revokeCell): do not hand out the result.
        if (!live()) throw new Error('Agent connection has expired.');
      } catch (error) {
        if (live()) this.seen(actorId); // an error answer still means the client works
        return { isError: true, content: [{ type: 'text' as const, text: describeError(error) }] };
      }
      if (value === null) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
      this.seen(actorId);
      return { content: [{ type: 'text' as const, text: capResult(JSON.stringify(value) ?? 'null') }] };
    });
    return server;
  }
  /** Asks the user through the client, on the stream of the tool call that asks; a failure or a timeout counts as cancel. */
  private elicitFor(server: Server, relatedRequestId: string | number, signal: AbortSignal): Elicit {
    return async (message, requestedSchema) => {
      try {
        const answer = await server.elicitInput({ mode: 'form', message, requestedSchema } as Parameters<Server['elicitInput']>[0], { relatedRequestId, timeout: ELICIT_TIMEOUT_MS, signal });
        return { action: answer.action, ...(answer.content ? { content: answer.content as Record<string, unknown> } : {}) };
      } catch {
        return { action: 'cancel' };
      }
    };
  }
  private taskStoreFor(sdk: McpSdk, token: string): InMemoryTaskStore {
    let store = this.taskStores.get(token);
    if (!store) this.taskStores.set(token, (store = new sdk.InMemoryTaskStore()));
    return store;
  }
  /**
   * A task-augmented tools/call (MCP tasks, 2025-11-25): the call is answered at once with a task the client polls
   * (tasks/get, tasks/result); the tool runs in the background with the token's permissions, ends when the token is revoked
   * or the client cancels the task, and its result is kept for the task's ttl (at most an hour).
   */
  private async startTask(sdk: McpSdk, token: string, actorId: string, params: { name: string; arguments?: unknown }, base: Omit<McpToolContext, 'signal'>,
    requestStore: { createTask(options: { ttl?: number | null; pollInterval?: number }): Promise<{ taskId: string }> }, ttl?: number | null) {
    const store = this.taskStoreFor(sdk, token);
    if (store.getAllTasks().filter((t) => t.status === 'working').length >= MAX_RUNNING_TASKS) {
      throw new sdk.McpError(sdk.ErrorCode.InvalidRequest, `At most ${MAX_RUNNING_TASKS} tasks may run at once; wait for one to finish.`);
    }
    const task = await requestStore.createTask({ ttl: Math.min(Math.max(ttl ?? TASK_TTL_MS, MIN_TASK_TTL_MS), TASK_TTL_MS), pollInterval: TASK_POLL_MS });
    const controller = new AbortController();
    const controllers = this.aborts.get(token) ?? new Set<AbortController>();
    controllers.add(controller);
    this.aborts.set(token, controllers);
    // tasks/cancel only marks the task; the running wait notices it here.
    const watch = setInterval(() => {
      void store.getTask(task.taskId).then((t) => { if (!t || t.status === 'cancelled') controller.abort(); });
    }, 1000);
    watch.unref?.();
    void (async () => {
      let result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
      try {
        const value = await callTool(params.name, params.arguments, { ...base, signal: controller.signal, task: true });
        if (this.tokens.get(token) !== actorId) throw new Error('Agent connection has expired.');
        if (value === null) throw new Error(`Unknown tool: ${params.name}`);
        this.seen(actorId);
        result = { content: [{ type: 'text', text: capResult(JSON.stringify(value) ?? 'null') }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: describeError(error) }] };
      } finally {
        clearInterval(watch);
        controllers.delete(controller);
      }
      const current = await store.getTask(task.taskId);
      if (current?.status === 'working') await store.storeTaskResult(task.taskId, 'completed', result).catch(() => undefined);
    })();
    return { task };
  }
  /** Closes the token's oldest sessions above MAX_SESSIONS_PER_TOKEN (a client that reconnects keeps opening new ones). */
  private trimSessions(token: string): void {
    const own = [...this.sessions.values()].filter((s) => s.token === token);
    for (const session of own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_TOKEN))) this.closeSession(session);
  }
  private closeSession(session: Session): void {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    for (const controller of session.requests.values()) controller.abort();
    void session.server.close().catch(() => undefined);
  }
  /** A request ended: its abort fires and its in-flight slot is given back. */
  private release(token: string, abort: AbortController, controllers: Set<AbortController>): void {
    abort.abort();
    controllers.delete(abort);
    const left = (this.inFlightByToken.get(token) ?? 1) - 1;
    if (this.tokens.has(token)) this.inFlightByToken.set(token, Math.max(0, left));
  }
  async stop(): Promise<void> {
    this.tokens.clear();
    this.tokenOf.clear();
    this.buckets.clear();
    this.inFlightByToken.clear();
    for (const set of this.aborts.values()) for (const controller of set) controller.abort();
    this.aborts.clear();
    this.lastSeen.clear();
    this.info = { running: false };
    for (const session of [...this.sessions.values()]) this.closeSession(session);
    for (const store of this.taskStores.values()) store.cleanup();
    this.taskStores.clear();
    await Promise.all([...this.connections].map((server) => server.close().catch(() => undefined)));
    this.connections.clear();
    this.http?.closeAllConnections();
    if (this.http?.listening) await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    this.http = null;
  }
}
