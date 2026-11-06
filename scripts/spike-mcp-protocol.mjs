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
    req.end(body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
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

/**
 * A POST whose SSE answer is read as it arrives: `onFrame(message, stream)` sees every JSON-RPC message; the stream is
 * closed by the caller (or after `ms`), and the result lists the messages seen until then (not whether the server ended it).
 */
function stream(url, token, headers, body, { ms = 3000, onFrame = () => {} } = {}) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const seen = [];
    let text = '';
    let status = 0;
    let done = false;
    const finish = () => { if (done) return; done = true; req.destroy(); resolve({ status, messages: seen }); };
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, ...auth(token), ...headers } }, (res) => {
      status = res.statusCode;
      res.on('data', (c) => {
        text += c;
        let cut;
        while ((cut = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data.trim()) continue;
          const message = JSON.parse(data);
          seen.push(message);
          onFrame(message, { finish });
        }
      });
      res.on('end', () => setTimeout(finish, 50));
      res.on('error', finish);
    });
    req.on('error', finish);
    setTimeout(finish, ms);
    req.end(JSON.stringify(body));
  });
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
    // ----- added with the SP8 review fixes -----
    'tasks/list pages 10 at a time (nextCursor), unknown cursor -> -32602': async () => {
      const t = await lead();
      const ids = [];
      for (let i = 0; i < 12; i++) {
        const r = await post(srv.url, t, { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 30 }, task: {} } });
        ids.push(messages(r)[0]?.result?.task?.taskId);
      }
      const first = await post(srv.url, t, { jsonrpc: '2.0', id: 20, method: 'tasks/list', params: {} });
      const cursor = messages(first)[0]?.result?.nextCursor;
      const second = await post(srv.url, t, { jsonrpc: '2.0', id: 21, method: 'tasks/list', params: { cursor } });
      const bad = await post(srv.url, t, { jsonrpc: '2.0', id: 22, method: 'tasks/list', params: { cursor: 'nope' } });
      const badType = await post(srv.url, t, { jsonrpc: '2.0', id: 23, method: 'tasks/list', params: { cursor: 5 } });
      for (const [i, taskId] of ids.entries()) await post(srv.url, t, { jsonrpc: '2.0', id: 100 + i, method: 'tasks/cancel', params: { taskId } });
      const page = (r) => { const m = messages(r)[0]?.result; return { keys: Object.keys(m ?? {}), count: m?.tasks?.length, order: m?.tasks?.map((x) => ids.indexOf(x.taskId)) }; };
      return { first: page(first), cursorIsTenth: cursor === ids[9], second: page(second), bad: outcome(bad), badType: outcome(badType) };
    },
    'strict JSON-RPC messages (ids, params, extra keys, error responses)': async () => {
      const t = await lead();
      const send = async (raw) => outcome(await post(srv.url, t, raw));
      return {
        fractionId: await send({ jsonrpc: '2.0', id: 1.5, method: 'ping' }),
        wholeFloatId: await send('{"jsonrpc":"2.0","id":2.0,"method":"ping"}'),
        unsafeId: await send({ jsonrpc: '2.0', id: 2 ** 53, method: 'ping' }),
        paramsArray: await send({ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }),
        paramsNull: await send({ jsonrpc: '2.0', id: 1, method: 'ping', params: null }),
        extraKey: await send({ jsonrpc: '2.0', id: 1, method: 'ping', foo: 1 }),
        badProgressToken: await send({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { progressToken: 1.5 } } }),
        notificationWithParamsString: await send({ jsonrpc: '2.0', method: 'notifications/initialized', params: 'x' }),
        errorWithoutId: await send({ jsonrpc: '2.0', error: { code: -1, message: 'x' } }),
        errorWithNullId: await send({ jsonrpc: '2.0', id: null, error: { code: -1, message: 'x' } }),
        errorFractionCode: await send({ jsonrpc: '2.0', id: 1, error: { code: 1.5, message: 'x' } }),
        resultArray: await send({ jsonrpc: '2.0', id: 1, result: [] }),
        resultObject: await send({ jsonrpc: '2.0', id: 1, result: {} }),
      };
    },
    'invalid UTF-8 in the body becomes U+FFFD (not -32700)': async () => {
      const body = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"a'), Buffer.from([0xff, 0xc3]), Buffer.from('"}}')]);
      return outcome(await post(srv.url, await lead(), body));
    },
    'tasks/result after tasks/cancel -> -32603 without prefix': async () => {
      const t = await lead();
      const created = await post(srv.url, t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 30 }, task: {} } });
      const taskId = messages(created)[0]?.result?.task?.taskId;
      await post(srv.url, t, { jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { taskId } });
      return outcome(await post(srv.url, t, { jsonrpc: '2.0', id: 3, method: 'tasks/result', params: { taskId } }));
    },
    'request params failing the method schema -> -32603 zod issues': async () => {
      const t = await lead();
      const send = async (method, params) => outcome(await post(srv.url, t, { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }));
      return {
        callNoName: await send('tools/call', { arguments: {} }),
        callNameNumber: await send('tools/call', { name: 5 }),
        callNoParams: await send('tools/call'),
        callArgumentsArray: await send('tools/call', { name: 'get_context', arguments: [] }),
        callTaskString: await send('tools/call', { name: 'wait_for', task: 'x' }),
        callTtlString: await send('tools/call', { name: 'get_context', task: { ttl: 'x' } }),
        getNoTaskId: await send('tasks/get', {}),
        resultNoParams: await send('tasks/result'),
        cancelTaskIdNumber: await send('tasks/cancel', { taskId: 1 }),
      };
    },
    'MCP task ttl with a fraction is kept': async () => {
      const r = await post(srv.url, await lead(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 1 }, task: { ttl: 70000.5 } } });
      return outcome(r);
    },
    'session tools/call cancelled by notifications/cancelled gets no answer': async () => {
      const t = await lead(); const id = await session(t);
      await inSession(t, id, { jsonrpc: '2.0', method: 'notifications/initialized' });
      const headers = { 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
      let cancelStatus;
      const s = stream(srv.url, t, headers, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 20 }, _meta: { progressToken: 'p' } } }, { ms: 3500 });
      await new Promise((r) => setTimeout(r, 500));
      cancelStatus = (await inSession(t, id, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'user' } })).status;
      const { status, messages: seen } = await s;
      return { status, cancelStatus, messages: mask(seen, ['message']) };
    },
    'elicitation aborted by notifications/cancelled (with and without reason)': async () => {
      const run = async (grid, reason) => {
        const t = await lead(); const id = await session(t);
        await inSession(t, id, { jsonrpc: '2.0', method: 'notifications/initialized' });
        const headers = { 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
        const s = stream(srv.url, t, headers, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'close_grid', arguments: { gridId: grid } } }, {
          ms: 2500,
          onFrame: (m) => { if (m.method === 'elicitation/create') void inSession(t, id, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9, ...(reason ? { reason } : {}) } }); },
        });
        const { status, messages: seen } = await s;
        return { status, messages: mask(seen, ['message', 'title']) };
      };
      return { withReason: await run(srv.openGrid4, 'user closed'), withoutReason: await run(srv.openGrid4) };
    },
    'elicitation answers failing ElicitResultSchema or the requested schema count as cancel': async () => {
      const run = async (reply) => {
        const t = await lead(); const id = await session(t);
        await inSession(t, id, { jsonrpc: '2.0', method: 'notifications/initialized' });
        const headers = { 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
        const { status, messages: seen } = await stream(srv.url, t, headers, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'close_grid', arguments: { gridId: srv.openGrid4 } } }, {
          ms: 4000,
          onFrame: (m, s) => {
            if (m.method === 'elicitation/create') void inSession(t, id, { jsonrpc: '2.0', id: m.id, ...reply });
            if (m.id === 9) s.finish();
          },
        });
        const answer = seen.find((m) => m.id === 9);
        return { status, isError: answer?.result?.isError ?? null, text: answer?.result?.content?.[0]?.text?.slice(0, 40) ?? null };
      };
      return {
        contentNotMatchingSchema: await run({ result: { action: 'accept', content: { confirm: 'yes' } } }),
        missingRequired: await run({ result: { action: 'accept', content: {} } }),
        unknownAction: await run({ result: { action: 'yes', content: { confirm: true } } }),
        nestedContent: await run({ result: { action: 'accept', content: { confirm: { v: true } } } }),
        errorAnswer: await run({ error: { code: -1, message: 'no' } }),
        declineWithNullContent: await run({ result: { action: 'decline', content: null } }),
        // Accepted by the tool if passed through unchecked, so these two tell a validating server from one that is not.
        confirmPlusNestedValue: await run({ result: { action: 'accept', content: { confirm: true, extra: { a: 1 } } } }),
        confirmPlusNumberArray: await run({ result: { action: 'accept', content: { confirm: true, list: [1] } } }),
      };
    },
    'a task created in a session is hidden from other sessions of the token, not from stateless calls': async () => {
      const t = await lead();
      const a = await session(t); const b = await session(t);
      const first = (r) => messages(r)[0];
      const created = first(await inSession(t, a, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 30 }, task: {} } }));
      const taskId = created?.result?.task?.taskId;
      const stateless = first(await post(srv.url, t, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wait_for', arguments: { timeoutSec: 30 }, task: {} } }))?.result?.task?.taskId;
      const count = (r) => first(r)?.result?.tasks?.length ?? first(r);
      const out = {
        getFromB: mask(first(await inSession(t, b, { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { taskId } })), []),
        getFromA: first(await inSession(t, a, { jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { taskId } }))?.result?.status ?? null,
        getStateless: first(await post(srv.url, t, { jsonrpc: '2.0', id: 5, method: 'tasks/get', params: { taskId } }))?.result?.status ?? null,
        listA: count(await inSession(t, a, { jsonrpc: '2.0', id: 6, method: 'tasks/list', params: {} })),
        listB: count(await inSession(t, b, { jsonrpc: '2.0', id: 7, method: 'tasks/list', params: {} })),
        listStateless: count(await post(srv.url, t, { jsonrpc: '2.0', id: 8, method: 'tasks/list', params: {} })),
        cancelFromB: mask(first(await inSession(t, b, { jsonrpc: '2.0', id: 9, method: 'tasks/cancel', params: { taskId } })), []),
        resultFromB: mask(first(await inSession(t, b, { jsonrpc: '2.0', id: 10, method: 'tasks/result', params: { taskId } })), []),
      };
      await post(srv.url, t, { jsonrpc: '2.0', id: 11, method: 'tasks/cancel', params: { taskId } });
      await post(srv.url, t, { jsonrpc: '2.0', id: 12, method: 'tasks/cancel', params: { taskId: stateless } });
      return out;
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
