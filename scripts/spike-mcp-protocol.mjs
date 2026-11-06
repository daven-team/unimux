// SP8 spike: HTTP-level cases of the 1.1.4 MCP server (mcp.ts + SDK 1.32.2 transport), run against any server with the
// same small interface (url, issue, revoke, lead, worker). Each case returns a normalized outcome (status, content type,
// the headers that matter, the JSON-RPC messages with ids, tokens, ports and times masked), so outcomes of the TypeScript
// reference and the Rust candidates can be compared one to one. Used by scripts/spike-mcp-wire.mjs.
import { request as httpRequest } from 'node:http';

/** One HTTP exchange; `stopAfterMs` closes the connection early (a client that goes away). */
export function http(url, { method = 'POST', headers = {}, body, stopAfterMs, timeoutMs = 20000 } = {}) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const started = Date.now();
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started, aborted: true }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, text: String(e.code ?? e), ms: Date.now() - started }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (stopAfterMs) setTimeout(() => { req.destroy(); resolve({ status: 'closed', headers: {}, text: '', ms: Date.now() - started }); }, stopAfterMs);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const ACCEPT = 'application/json, text/event-stream';
const auth = (token) => ({ authorization: `Bearer ${token}` });
const post = (url, token, body, extra = {}) => http(url, { headers: { 'content-type': 'application/json', accept: ACCEPT, ...auth(token), ...extra }, body });

/** JSON-RPC messages of an answer: the JSON body or the `data:` lines of SSE `message` events (keepalives and rmcp priming events dropped). */
export function messages(res) {
  const type = String(res.headers['content-type'] ?? '');
  if (type.startsWith('text/event-stream')) {
    return res.text.split(/\n\n/).map((block) => block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))
      .filter((d) => d.trim()).map((d) => { try { return JSON.parse(d); } catch { return d; } });
  }
  if (!res.text) return [];
  try { return [JSON.parse(res.text)]; } catch { return [res.text]; }
}

const MASKS = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'],
  [/\b[0-9a-f]{32}\b/g, '<hex32>'],
  [/\b[0-9a-f]{64}\b/g, '<hex64>'],
  [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<iso>'],
  [/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>'],
];
const maskText = (s) => MASKS.reduce((t, [re, to]) => t.replace(re, to), s);
/** Recursively masks values; keys listed in `drop` become '<masked>' (tool-specific texts the fake cannot reproduce). */
function mask(value, drop) {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map((v) => mask(v, drop));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, drop.includes(k) ? '<masked>' : mask(v, drop)]));
  return value;
}
/** The comparable form of an answer. */
export function outcome(res, { drop = [], keepHeaders = [] } = {}) {
  const type = String(res.headers['content-type'] ?? '').split(';')[0] || null;
  const headers = Object.fromEntries(keepHeaders.map((h) => [h, res.headers[h] === undefined ? null : maskText(String(res.headers[h]))]));
  return { status: res.status, type, ...(keepHeaders.length ? { headers } : {}), messages: mask(messages(res), drop), ...(res.extra ? { extra: res.extra } : {}) };
}

/** The cases; each returns one outcome (or an object of named outcomes). */
export function cases(srv) {
  const init = (caps = {}) => ({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: caps, clientInfo: { name: 'sp8', version: '1' } } });
  const instr = ['instructions'];
  const lead = async () => srv.issue(srv.lead);
  const sessionOf = (res) => res.headers['mcp-session-id'];
  const session = async (token) => {
    const r = await post(srv.url, token, init({ elicitation: { form: {} } }));
    return sessionOf(r);
  };
  const inSession = (token, id, body) => post(srv.url, token, body, { 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' });
  const port = new URL(srv.url).port;
  return {
    'Host other than 127.0.0.1/localhost -> 403': async () => outcome(await http(srv.url, { headers: { host: `evil.example:${port}`, ...auth(await lead()) } })),
    'foreign Origin -> 403': async () => outcome(await http(srv.url, { headers: { origin: 'http://evil.example', ...auth(await lead()), 'content-type': 'application/json', accept: ACCEPT }, body: init() })),
    'other path -> 404': async () => outcome(await http(srv.url.replace('/mcp', '/mcp2'), { headers: auth(await lead()) })),
    'query string on /mcp -> 404': async () => outcome(await http(`${srv.url}?x=1`, { headers: auth(await lead()) })),
    'no bearer -> 401': async () => outcome(await http(srv.url, { headers: { 'content-type': 'application/json', accept: ACCEPT }, body: init() })),
    'unknown bearer -> 401': async () => outcome(await post(srv.url, 'f'.repeat(64), init())),
    'GET -> 405 Allow: POST': async () => outcome(await http(srv.url, { method: 'GET', headers: { accept: 'text/event-stream', ...auth(await lead()) } }), { keepHeaders: ['allow'] }),
    'GET in a session -> 405': async () => {
      const t = await lead(); const id = await session(t);
      return outcome(await http(srv.url, { method: 'GET', headers: { accept: 'text/event-stream', ...auth(t), 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' } }), { keepHeaders: ['allow'] });
    },
    'DELETE unknown session -> 404': async () => outcome(await http(srv.url, { method: 'DELETE', headers: { ...auth(await lead()), 'mcp-session-id': 'nope' } })),
    'PUT -> 405': async () => outcome(await http(srv.url, { method: 'PUT', headers: auth(await lead()) }), { keepHeaders: ['allow'] }),
    'body over 256 KB -> 413 -32000': async () => outcome(await post(srv.url, await lead(), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } }))),
    'invalid JSON -> 400 -32700': async () => outcome(await post(srv.url, await lead(), '{"jsonrpc":')),
    'Accept without SSE -> 406': async () => outcome(await http(srv.url, { headers: { 'content-type': 'application/json', accept: 'application/json', ...auth(await lead()) }, body: init() })),
    'Content-Type text/plain -> 415': async () => outcome(await http(srv.url, { headers: { 'content-type': 'text/plain', accept: ACCEPT, ...auth(await lead()) }, body: init() })),
    'not JSON-RPC -> 400 -32700': async () => outcome(await post(srv.url, await lead(), { hello: 1 })),
    'stateless initialize -> JSON, no session': async () => outcome(await post(srv.url, await lead(), init()), { drop: instr, keepHeaders: ['mcp-session-id'] }),
    'initialize with an unknown version -> 2025-11-25': async () => outcome(await post(srv.url, await lead(), { ...init(), params: { ...init().params, protocolVersion: '1999-01-01' } }), { drop: instr }),
    'initialize 2025-06-18 echoes it': async () => outcome(await post(srv.url, await lead(), { ...init(), params: { ...init().params, protocolVersion: '2025-06-18' } }), { drop: instr }),
    'server/discover (2026-07-28 probe) -> 400 -32000': async () => outcome(await post(srv.url, await lead(), { jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} }, { 'mcp-protocol-version': '2026-07-28' })),
    'stateless tools/list -> JSON, verbatim tools': async () => outcome(await post(srv.url, await lead(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })),
    'worker tools/list': async () => outcome(await post(srv.url, await srv.issue(srv.worker), { jsonrpc: '2.0', id: 1, method: 'tools/list' })),
    'stateless ping': async () => outcome(await post(srv.url, await lead(), { jsonrpc: '2.0', id: 7, method: 'ping' })),
    'unknown method -> -32601': async () => outcome(await post(srv.url, await lead(), { jsonrpc: '2.0', id: 2, method: 'nope/nope' })),
    'unknown tool -> -32602': async () => outcome(await post(srv.url, await lead(), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })),
    'notification only -> 202': async () => outcome(await post(srv.url, await lead(), { jsonrpc: '2.0', method: 'notifications/initialized' })),
    'stateless tools/call -> JSON': async () => outcome(await post(srv.url, await lead(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 1 } } }), { drop: ['text'] }),
    'stateless tools/call with progressToken -> SSE + progress': async () => {
      const res = await post(srv.url, await lead(), { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 3 }, _meta: { progressToken: 'p1' } } });
      return outcome(res, { drop: ['text'] });
    },
    'batch of two requests -> JSON array': async () => outcome(await post(srv.url, await lead(), [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'nope/nope' }])),
    'elicitation initialize -> SSE session; tools/list in it; DELETE; then 404 -32001': async () => {
      const t = await lead();
      const first = await post(srv.url, t, init({ elicitation: { form: {} } }));
      const id = sessionOf(first);
      const note = await inSession(t, id, { jsonrpc: '2.0', method: 'notifications/initialized' });
      const list = await inSession(t, id, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const del = await http(srv.url, { method: 'DELETE', headers: { ...auth(t), 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' } });
      const after = await inSession(t, id, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      return { initialize: outcome(first, { drop: instr, keepHeaders: ['mcp-session-id'] }), initialized: outcome(note), list: { status: list.status, type: list.headers['content-type'], tools: messages(list)[0]?.result?.tools?.length }, delete: outcome(del), after: outcome(after) };
    },
    'elicitation: {} (old spelling) also gets a session': async () => {
      const r = await post(srv.url, await lead(), init({ elicitation: {} }));
      return { status: r.status, type: r.headers['content-type']?.split(';')[0], session: !!sessionOf(r) };
    },
    'url-only elicitation stays stateless': async () => {
      const r = await post(srv.url, await lead(), init({ elicitation: { url: {} } }));
      return { status: r.status, type: r.headers['content-type']?.split(';')[0], session: !!sessionOf(r) };
    },
    're-initialize inside a session -> 400 -32600': async () => {
      const t = await lead(); const id = await session(t);
      return outcome(await inSession(t, id, init({ elicitation: { form: {} } })));
    },
    'session of another token -> 404 -32001': async () => {
      const id = await session(await lead());
      return outcome(await inSession(await srv.issue(srv.worker), id, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    },
    'revoked token: its session answers 401': async () => {
      const t = await srv.issue(srv.worker); const id = await session(t);
      await srv.revoke(srv.worker);
      return outcome(await inSession(t, id, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    },
    'fifth session of a token closes the first': async () => {
      const t = await lead();
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await session(t));
      const oldest = await inSession(t, ids[0], { jsonrpc: '2.0', id: 1, method: 'ping' });
      const newest = await inSession(t, ids[4], { jsonrpc: '2.0', id: 1, method: 'ping' });
      return { oldest: outcome(oldest), newest: outcome(newest) };
    },
    'elicitation round trip inside a session (accept)': async () => {
      const t = await lead(); const id = await session(t);
      await inSession(t, id, { jsonrpc: '2.0', method: 'notifications/initialized' });
      const pending = new Promise((resolve) => {
        const u = new URL(srv.url);
        const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, ...auth(t), 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' } }, (res) => {
          let text = '';
          let answered = false;
          res.on('data', async (c) => {
            text += c;
            const m = /data: (\{[^\n]*"elicitation\/create"[^\n]*\})/.exec(text);
            if (m && !answered) {
              answered = true;
              const ask = JSON.parse(m[1]);
              const reply = await inSession(t, id, { jsonrpc: '2.0', id: ask.id, result: { action: 'accept', content: { confirm: true } } });
              res.extra = { replyStatus: reply.status };
            }
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, extra: res.extra }));
        });
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'close_grid', arguments: { gridId: srv.openGrid3 } } }));
      });
      return outcome(await pending, { drop: ['text', 'message', 'title'] });
    },
    'MCP task: create, get, list, result, get after': async () => {
      const t = await lead();
      const created = await post(srv.url, t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 1 }, task: { ttl: 1000 } } });
      const taskId = messages(created)[0]?.result?.task?.taskId;
      const get = await post(srv.url, t, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId } });
      const list = await post(srv.url, t, { jsonrpc: '2.0', id: 3, method: 'tasks/list', params: {} });
      const result = await post(srv.url, t, { jsonrpc: '2.0', id: 4, method: 'tasks/result', params: { taskId } });
      const after = await post(srv.url, t, { jsonrpc: '2.0', id: 5, method: 'tasks/get', params: { taskId } });
      const other = await post(srv.url, await srv.issue(srv.worker), { jsonrpc: '2.0', id: 6, method: 'tasks/get', params: { taskId } });
      return { created: outcome(created), get: outcome(get), list: outcome(list), result: { ...outcome(result, { drop: ['text'] }), ms: result.ms > 500 ? 'blocked until done' : 'immediate' }, after: outcome(after), otherToken: outcome(other) };
    },
    'MCP task for a tool without task support -> error': async () => outcome(await post(srv.url, await lead(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {}, task: {} } })),
    'MCP task cancel, then cancel again': async () => {
      const t = await lead();
      const created = await post(srv.url, t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 30 }, task: {} } });
      const taskId = messages(created)[0]?.result?.task?.taskId;
      const cancel = await post(srv.url, t, { jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { taskId } });
      const again = await post(srv.url, t, { jsonrpc: '2.0', id: 3, method: 'tasks/cancel', params: { taskId } });
      return { created: outcome(created), cancel: outcome(cancel), again: outcome(again) };
    },
    'in-flight cap: the 9th parallel call of a token -> 429 Retry-After 1': async () => {
      const t = await lead();
      const calls = Array.from({ length: 9 }, (_, i) => post(srv.url, t, { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 2 } } }));
      const all = await Promise.all(calls);
      const statuses = all.map((r) => r.status).sort();
      const limited = all.find((r) => r.status === 429);
      return { statuses, retryAfter: limited?.headers['retry-after'] ?? null };
    },
    'client goes away during a stateless JSON call': async () => {
      const t = await lead();
      const before = (await srv.events()).length;
      const at = Date.now();
      await http(srv.url, { headers: { 'content-type': 'application/json', accept: ACCEPT, ...auth(t) }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 20 } } }, stopAfterMs: 500 });
      for (let i = 0; i < 40; i++) {
        const end = (await srv.events()).slice(before).find((e) => e.kind === 'call-end' && e.tool === 'wait_for');
        if (end) return { outcome: end.outcome, within: end.at - at - 500 < 1000 ? 'under 1 s' : `${end.at - at - 500} ms` };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { outcome: 'not noticed within 4 s' };
    },
    'client goes away during a session SSE call': async () => {
      const t = await lead(); const id = await session(t);
      const before = (await srv.events()).length;
      const at = Date.now();
      await http(srv.url, { headers: { 'content-type': 'application/json', accept: ACCEPT, ...auth(t), 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 20 } } }, stopAfterMs: 500 });
      for (let i = 0; i < 40; i++) {
        const end = (await srv.events()).slice(before).find((e) => e.kind === 'call-end' && e.tool === 'wait_for');
        if (end) return { outcome: end.outcome, within: end.at - at - 500 < 1000 ? 'under 1 s' : `${end.at - at - 500} ms` };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { outcome: 'not noticed within 4 s' };
    },
  };
}

/** Latency of the HTTP layer: sequential stateless tools/list (the ~9 KB list) and session pings, keep-alive off (as the CLIs' first requests). */
export async function bench(srv, n = 200) {
  const token = await srv.issue(srv.lead);
  const stats = (ms) => { const s = [...ms].sort((a, b) => a - b); return { p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] }; };
  const time = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const list = [];
  for (let i = 0; i < n; i++) list.push(await time(() => post(srv.url, token, { jsonrpc: '2.0', id: i, method: 'tools/list' })));
  const r = await post(srv.url, token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'bench', version: '1' } } });
  const id = r.headers['mcp-session-id'];
  const ping = [];
  for (let i = 0; i < n; i++) ping.push(await time(() => post(srv.url, token, { jsonrpc: '2.0', id: i + 1, method: 'ping' }, { 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' })));
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { statelessToolsList: round(stats(list)), sessionPing: round(stats(ping)) };
}
