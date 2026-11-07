// The hook server part of the golden corpus (1.2.0, PLAN H1), used by scripts/dump-goldens.mjs:
//
//   test/golden/hook-payloads.jsonl  {body} -> what every payload helper of src/main/hooks.ts (and parseCodexNotify of
//                                    src/shared/codexHooks.ts) answers for it; {event, head, tail} -> toolHookFacts and
//                                    toolHookEvent. The debug lines use a fixed clock (NOW).
//   test/golden/hook-server.jsonl    {request} -> the HTTP status of the real 1.1.4 HookServer and the events it emitted
//                                    (`[name, ...args]`, undefined as null), checked by
//                                    src-tauri/crates/unimux-agents/tests/hook_server.rs against the Rust server.
//
// Inputs are hand-picked cases (JS white space, Unicode case mapping, UTF-16 cuts, key order of index keys, oversized and
// malformed payloads, stale nonces, bad tokens) plus seeded random Stop payloads.
import { request } from 'node:http';
import { rng } from './goldens-normalize.mjs';

export const NOW = 1_767_225_600_123;
const ID = '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091';
const ID2 = 'a1b2c3d4-e5f6-4789-8abc-def012345678';

/** Stop / Notification / SessionStart / StopFailure / Codex payload texts. */
function bodies() {
  const out = [
    '', 'null', '[]', '5', '"x"', 'not json', '{', '{}', '{"background_tasks":"x"}', '{"background_tasks":null}',
    '{"background_tasks":[]}', '{"background_tasks":[null,5,"x",[],{}]}', ' {"a":1} ', '\ufeff{"a":1}',
    '{"b":1,"2":2,"1":3,"a":4,"10":5,"01":6,"4294967295":7,"4294967294":8}',
    '{"\\ud800x":1,"y":"\\udc00"}', '{"a":1,"a":2,"b":3}', '{"n":1e400}', '{"n":-0,"m":1.0}', '{"n":[-1e400,{"m":1E+999}],"notification_type":"idle_prompt"}',
    // Deeper than serde_json's 128 levels (V8 parses any depth).
    `{"background_tasks":[{"type":"agent","status":"running"}],"deep":${'['.repeat(200)}${']'.repeat(200)},"session_id":"${ID}"}`,
    `{"stop_hook_active":true,"deep":${'{"a":'.repeat(5000)}1${'}'.repeat(5000)},"background_tasks":[{"type":"agent","status":"done"}]}`,
    `{"background_tasks":[{"type":"agent"}],"deep":${'['.repeat(300)}${']'.repeat(299)}}`,
    '{"a":01}', '{"a":1.}', '{"a":"\t"}', '{"a":[1,]}', '{"a":1}x', '{"a":\'x\'}', '{"a":NaN}', '{"a":undefined}',
    JSON.stringify({ stop_hook_active: true, background_tasks: [{ type: 'local_agent', status: 'running', name: 'x' }] }),
    JSON.stringify({ stop_hook_active: 'true', background_tasks: [{ type: 'local_bash', status: 'running' }] }),
    JSON.stringify({ stop_hook_active: 1, background_tasks: [{ type: 'Workflow', status: 'Running' }, { type: 'local_workflow' }] }),
    JSON.stringify({ background_tasks: [{ type: 'agent', status: ' Completed ' }, { type: 'agent', status: '\u00a0done\u00a0' }] }),
    JSON.stringify({ background_tasks: [{ type: 'agent', status: '\ufeffdone' }, { type: 'agent', status: '\u0085done' }] }),
    JSON.stringify({ background_tasks: [{ type: 'agent', status: 'DON\u212A' }, { type: '\u212Aind', status: '\u0130DLE' }] }),
    JSON.stringify({ background_tasks: [{ type: 'SERVER', status: 'running' }, { type: 'mónitor', status: 'running' }, { type: 'monitor_x' }] }),
    JSON.stringify({ background_tasks: [{ type: 'ſhell', status: 'running' }, { type: 5, status: 5 }, { type: null, status: null }] }),
    JSON.stringify({ background_tasks: [{ type: 'a'.repeat(39) + '\u{1F600}', status: 'x'.repeat(50), name: '' }, { name: 7 }] }),
    JSON.stringify({ background_tasks: [{ type: 'ąę €!', status: 'ⓡunning' }, { type: '   ', status: '---' }, { status: 'ΣΑΣ' }] }),
    JSON.stringify({ background_tasks: Array.from({ length: 12 }, (_, i) => ({ type: `t${i}`, status: `s${i}` })) }),
    JSON.stringify({ error: 'rate_limit' }), JSON.stringify({ error: 'billing_error', extra: 1 }), JSON.stringify({ error: 'Rate_limit' }),
    JSON.stringify({ error: 'toString' }), JSON.stringify({ error: 5 }), JSON.stringify({ error: 'unknown' }), JSON.stringify({ error: 'nope' }),
    JSON.stringify({ notification_type: 'idle_prompt' }), JSON.stringify({ notification_type: 'permission_prompt', message: 'x' }),
    JSON.stringify({ notification_type: 'elicitation_dialog' }), JSON.stringify({ notification_type: 'elicitation_url_dialog' }),
    JSON.stringify({ notification_type: 'agent_needs_input' }), JSON.stringify({ notification_type: 'quota_auto_resume_stale' }),
    JSON.stringify({ notification_type: 'quota_auto_resume_fired' }), JSON.stringify({ notification_type: 'quota_auto_resume_disabled' }),
    JSON.stringify({ notification_type: 'auth_success' }), JSON.stringify({ notification_type: 'agent_completed' }),
    JSON.stringify({ notification_type: 'plugin_notification' }), JSON.stringify({ notification_type: 'elicitation_complete' }),
    JSON.stringify({ notification_type: 'elicitation_response' }), JSON.stringify({ notification_type: 'something_new' }),
    JSON.stringify({ notification_type: 'toString' }), JSON.stringify({ notification_type: 'hasOwnProperty' }),
    JSON.stringify({ notification_type: 5 }), JSON.stringify({ notification_type: null }), JSON.stringify({ message: 'x' }),
    JSON.stringify({ session_id: ID, source: 'resume' }), JSON.stringify({ session_id: ID, source: 'clear' }),
    JSON.stringify({ session_id: ID, source: 'weird' }), JSON.stringify({ session_id: ID, source: 5 }),
    JSON.stringify({ session_id: ID.toUpperCase(), source: 'startup' }), JSON.stringify({ session_id: 'a b c d e f g h' }),
    JSON.stringify({ session_id: 'abcdefgh-not-a-uuid' }), JSON.stringify({ session_id: '-' + ID.slice(1) }),
    JSON.stringify({ session_id: '../../etc/passwd-aaaa' }), JSON.stringify({ session_id: 42 }),
    JSON.stringify({ session_id: ID, agent_id: 'sub' }), JSON.stringify({ session_id: ID, agent_id: null, source: 'fork' }),
    JSON.stringify({ session_id: ID, agent_id: 0 }), JSON.stringify({ session_id: ID, agent_id: '' }),
    JSON.stringify({ session_id: ID, transcript_path: `C:\\Users\\a\\.claude\\projects\\x\\${ID}.jsonl` }),
    JSON.stringify({ session_id: ID, transcript_path: `/home/a/.claude/projects/x/${ID.toUpperCase()}.JSONL` }),
    JSON.stringify({ session_id: ID.toUpperCase(), transcript_path: `/p/${ID}.jsonl` }),
    JSON.stringify({ session_id: ID, transcript_path: `${ID}.jsonl` }), JSON.stringify({ session_id: ID, transcript_path: `/p/x${ID}.jsonl` }),
    JSON.stringify({ session_id: ID, transcript_path: `/${'d'.repeat(1024 - 43)}/${ID}.jsonl` }),
    JSON.stringify({ session_id: ID, transcript_path: `/${'d'.repeat(1024 - 42)}/${ID}.jsonl` }),
    JSON.stringify({ session_id: ID, transcript_path: `/${'\u{1F600}'.repeat(489)}/${ID}.jsonl` }),
    JSON.stringify({ session_id: ID, transcript_path: `/p/${ID}.jsonl`, agent_id: 'a1' }),
    JSON.stringify({ session_id: ID, transcript_path: 5 }), JSON.stringify({ session_id: ID, transcript_path: `/p/${ID}.jsonl`, stop_hook_active: true, background_tasks: [] }),
    JSON.stringify({ type: 'agent-turn-complete', 'thread-id': ID, 'turn-id': 'turn-1' }),
    JSON.stringify({ type: 'agent-turn-complete', 'thread-id': ID.toUpperCase(), 'turn-id': 'a.b:c-d_9' }),
    JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'nope', 'turn-id': 'bad turn' }),
    JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 't'.repeat(128) }), JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 't'.repeat(129) }),
    JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 5, 'turn-id': 5 }), JSON.stringify({ type: 'other', 'thread-id': ID }),
    JSON.stringify({ type: 'agent-turn-complete', 'last-assistant-message': 'y'.repeat(2000), 'input-messages': ['a'] }),
  ];
  const r = rng(4242);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const statuses = ['running', 'completed', 'Completed', ' done ', 'failed', 'KILLED', 'stopped', 'cancelled', 'canceled', 'exited', 'timeout',
    'error', 'finished', 'complete', 'pending', 'idle', '', '\tdone\n', '\u3000done', 'done\u2028', 'Ｄone', 5, null, undefined];
  const types = ['local_agent', 'agent', 'local_bash', 'shell', 'Shell', 'command', 'monitor', 'process', 'server', 'dev-server', 'cron',
    'workflow', 'local_workflow', 'WORKFLOW', 'remote_agent', 'Bash', '', 'ąę', 7, null, undefined];
  for (let i = 0; i < 300; i++) {
    const tasks = Array.from({ length: Math.floor(r() * 6) }, () => {
      const t = {};
      const status = pick(statuses);
      const type = pick(types);
      if (status !== undefined) t.status = status;
      if (type !== undefined) t.type = type;
      if (r() < 0.3) t.name = pick(['x', '', 3]);
      if (r() < 0.2) t.id = `t${i}`;
      return r() < 0.05 ? pick([null, 1, 'x']) : t;
    });
    const p = {};
    if (r() < 0.3) p.session_id = pick([ID, ID2, 'nope']);
    if (r() < 0.9) p.background_tasks = tasks;
    if (r() < 0.4) p.stop_hook_active = pick([true, false, 'true']);
    if (r() < 0.3) p.last_assistant_message = 'm'.repeat(Math.floor(r() * 50));
    if (r() < 0.2) p.transcript_path = `/p/${pick([ID, ID2])}.jsonl`;
    out.push(JSON.stringify(p));
  }
  return out;
}

const HEAD = 16 * 1024;

/** Tool hook inputs: [event, head, tail]. */
function toolInputs() {
  const events = ['pre', 'post', 'permission', 'subagentstart', 'compact', 'compacted', 'elicit', 'elicited', 'busy', 'nope'];
  const heads = [
    ['', ''], ['not json', ''], ['{}', ''], ['[]', ''],
    [JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_01', tool_input: { command: 'ls' } }), ''],
    [JSON.stringify({ tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q' }), ''],
    [JSON.stringify({ tool_name: 'mcp__srv__do.it:x@y/z', tool_use_id: 'a'.repeat(100), agent_id: 'sub-1', agent_type: 'Explore' }), ''],
    [JSON.stringify({ tool_name: 'bad name', tool_use_id: 'a'.repeat(101), agent_id: '', agent_type: 'x'.repeat(81) }), ''],
    [JSON.stringify({ tool_name: 5, tool_use_id: null, agent_id: 3, trigger: 'manual' }), ''],
    [JSON.stringify({ trigger: 'auto' }), ''], [JSON.stringify({ trigger: 'Auto' }), ''],
    [JSON.stringify({ tool_name: 'Edit', tool_input: { tool_name: 'Nested', tool_use_id: 'inner' } }), ''],
    ['{"tool_name":"Bash","tool_input":{"x":1', '"tool_use_id":"toolu_tail"}'],
    ['{"tool_name":"Bash","tool_use_id":"first","tool_response":"', 'xx","tool_use_id":"last"}'],
    ['{"tool_name":"Bash","tool_use_id":"first"', 'garbage'],
    ['{ "tool_name" :\t"Read" , "agent_id":"s"', ',"tool_use_id"\n:\r"t9"}'],
    ['{\u00a0"tool_name"\u2028:\ufeff"Grep"', ''], ['{\u0085"tool_name":"Grep"', 'x'],
    ['x,"tool_name":"Glob","trigger":"manual","agent_type":"Plan"', 'y'],
    ['{"tool_name":"a\\"b","tool_use_id":"c\\\\d"', 'z'],
    ['{"tool_name":"' + 'n'.repeat(100) + '"', 'z'], ['{"tool_name":"' + 'n'.repeat(101) + '"', 'z'],
    ['{"tool_name":"' + 'n'.repeat(80) + '"', 'z'], ['{"tool_name":"ą"', 'z'], ['{"tool_name":"', 'Bash"}'],
    ['{"tool_name":"AskUserQuestion"', ',"tool_use_id":"q1"}'],
    ['{"agent_type":"general-purpose","agent_id":"x"', ''],
  ];
  const out = [];
  for (const [head, tail] of heads) for (const event of events) out.push([event, head, tail]);
  return out;
}

/** The pure helpers of hooks.ts for every input. */
export function hookPayloadRows({ hooks, codexHooks }) {
  const now = new Date(NOW);
  const parse = (body) => { try { const p = JSON.parse(body); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; } };
  const rows = bodies().map((body) => ({
    body,
    out: {
      stopInfo: hooks.stopInfo(body),
      active: hooks.hasActiveBackgroundWork(body),
      failure: hooks.parseFailure(body),
      stopLine: hooks.stopDebugLine('c1', body, now),
      failLine: hooks.hookDebugLine('fail', 'c1', body, now),
      sessionLine: hooks.hookDebugLine('session', 'c1', body, now),
      transcript: hooks.transcriptOf(parse(body)),
      notification: hooks.notificationEvent(body),
      attention: hooks.isAttentionNotification(body),
      sessionStart: hooks.parseSessionStart(body),
      codex: codexHooks.parseCodexNotify(body),
    },
  }));
  for (const [event, head, tail] of toolInputs()) {
    rows.push({ event, head, tail, out: { facts: hooks.toolHookFacts(head, tail), mapped: hooks.toolHookEvent(event, head, tail) } });
  }
  return rows;
}

// ── the HTTP server ──────────────────────────────────────────────────────────

/** `{repeat, count, prefix, suffix}` or a plain string. */
export function bodyText(spec) {
  if (spec === undefined) return '';
  if (typeof spec === 'string') return spec;
  return `${spec.prefix ?? ''}${spec.repeat.repeat(spec.count)}${spec.suffix ?? ''}`;
}

const big = (prefix, count, suffix, repeat = 'x') => ({ prefix, repeat, count, suffix });
/** A body of `units` UTF-16 code units (rounded down to whole `repeat` strings). */
const fit = (prefix, units, suffix, repeat = 'x') => big(prefix, Math.floor((units - prefix.length - suffix.length) / repeat.length), suffix, repeat);
const toolBody = (filler, tail) => big('{"tool_name":"Bash","tool_use_id":"head_id","tool_response":"', filler, `"${tail}}`);

/**
 * The requests. `route`: h (token in the path), k (bearer), x (exit code) or raw (`path` with {token} / {nonce} / {cell}).
 * `nonce`: current (default), stale (the previous spawn's), none (no nonce segment), forgotten (forget() after it was made).
 */
function serverRequests() {
  const rows = [];
  const add = (name, req) => rows.push({ name, request: { cell: 'c1', route: 'h', method: 'POST', nonce: 'current', ...req } });
  // Plain status events.
  for (const event of ['prompt', 'busy', 'stopbg', 'subagent', 'idle', 'compact', 'session', 'unknown', 'codex', 'notify', 'stop', 'fail']) {
    add(`${event} without a body`, { event });
    add(`${event} over http`, { event, route: 'k', auth: 'good', body: '{}' });
  }
  add('prompt with a 2 MB body is still a prompt', { event: 'prompt', body: big('', 2_000_000) });
  add('notify permission', { event: 'notify', body: JSON.stringify({ notification_type: 'permission_prompt' }) });
  add('notify idle', { event: 'notify', body: JSON.stringify({ notification_type: 'idle_prompt' }) });
  add('notify ignored', { event: 'notify', body: JSON.stringify({ notification_type: 'auth_success' }) });
  add('notify unparsable', { event: 'notify', body: 'not json' });
  add('notify oversized is dropped', { event: 'notify', body: big('', 200_000) });
  const idle = '{"notification_type":"idle_prompt","m":"';
  add('notify at the limit', { event: 'notify', body: fit(idle, 16 * 1024, '"}') });
  add('notify one unit over the limit', { event: 'notify', body: fit(idle, 16 * 1024 + 1, '"}') });
  add('notify limit counted in UTF-16 units (pairs, under)', { event: 'notify', body: fit(idle, 16 * 1024, '"}', '\u{1F600}') });
  add('notify limit counted in UTF-16 units (pairs, over)', { event: 'notify', body: fit(idle, 16 * 1024 + 2, '"}', '\u{1F600}') });
  add('notify limit with 2-byte characters', { event: 'notify', body: fit(idle, 16 * 1024, '"}', 'ą') });
  add('stop with background work', { event: 'stop', body: JSON.stringify({ background_tasks: [{ type: 'local_agent', status: 'running' }] }) });
  add('stop with shell work only', { event: 'stop', body: JSON.stringify({ background_tasks: [{ type: 'local_bash', status: 'running' }], stop_hook_active: true }) });
  add('stop names its transcript', { event: 'stop', body: JSON.stringify({ session_id: ID, transcript_path: `C:\\x\\${ID}.jsonl`, background_tasks: [] }) });
  add('subagent stop names no transcript', { event: 'stop', body: JSON.stringify({ session_id: ID, transcript_path: `/x/${ID}.jsonl`, agent_id: 'a' }) });
  add('stop of 500 KB is read', { event: 'stop', body: big('{"background_tasks":[{"type":"agent","status":"running"}],"last_assistant_message":"', 500_000, '"}') });
  add('stop of 2 MB counts as a plain stop', { event: 'stop', body: big('{"background_tasks":[{"type":"agent","status":"running"}],"last_assistant_message":"', 2_000_000, '"}') });
  const agentStop = '{"background_tasks":[{"type":"agent"}],"m":"';
  add('stop at the limit', { event: 'stop', body: fit(agentStop, 512 * 1024, '"}') });
  add('stop one unit over the limit', { event: 'stop', body: fit(agentStop, 512 * 1024 + 1, '"}') });
  add('stop limit in UTF-16 units', { event: 'stop', body: fit(agentStop, 512 * 1024, '"}', '\u{1F600}') });
  const turn = '{"type":"agent-turn-complete","turn-id":"t3","m":"';
  add('codex at the limit', { event: 'codex', body: fit(turn, 1024 * 1024, '"}') });
  add('codex one unit over the limit', { event: 'codex', body: fit(turn, 1024 * 1024 + 1, '"}') });
  add('fail with a code', { event: 'fail', body: JSON.stringify({ error: 'rate_limit' }) });
  add('fail with an unknown code', { event: 'fail', body: JSON.stringify({ error: 'weird' }) });
  add('fail of 2 MB is an unknown failure', { event: 'fail', body: big('{"error":"rate_limit","m":"', 2_000_000, '"}') });
  add('session resume', { event: 'session', body: JSON.stringify({ session_id: ID, source: 'resume', transcript_path: `/p/${ID}.jsonl` }) });
  add('session from a subagent', { event: 'session', body: JSON.stringify({ session_id: ID, agent_id: 'x' }) });
  add('session with a bad id', { event: 'session', body: JSON.stringify({ session_id: '../../etc/passwd-aaaa' }) });
  add('session not json', { event: 'session', body: 'not json' });
  add('session oversized', { event: 'session', body: big('', 200_000) });
  add('session over http (command only in practice)', { event: 'session', route: 'k', auth: 'good', body: JSON.stringify({ session_id: ID2, source: 'clear' }) });
  add('codex turn end', { event: 'codex', body: JSON.stringify({ type: 'agent-turn-complete', 'thread-id': ID.toUpperCase(), 'turn-id': 'turn-1' }) });
  add('codex other type', { event: 'codex', body: JSON.stringify({ type: 'other' }) });
  add('codex not json', { event: 'codex', body: 'not json' });
  add('codex 200 KB is read', { event: 'codex', body: big(`{"type":"agent-turn-complete","thread-id":"${ID}","turn-id":"t2","last-assistant-message":"`, 200_000, '"}', 'y') });
  add('codex 1.5 MB is a turn end without ids', { event: 'codex', body: big(`{"type":"agent-turn-complete","thread-id":"${ID}","m":"`, 1_500_000, '"}') });
  add('codex 1.2 MB of garbage is a turn end', { event: 'codex', body: big('', 1_200_000) });
  // Precise tool hooks: head and tail only.
  for (const event of ['pre', 'post', 'permission', 'subagentstart', 'compact', 'compacted', 'elicit', 'elicited']) {
    add(`${event} small`, { event, route: 'k', auth: 'good', body: JSON.stringify({ tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', agent_type: 'Plan', trigger: 'auto' }) });
  }
  add('post with a large output keeps the head and the tail', { event: 'post', route: 'k', auth: 'good', body: toolBody(300_000, ',"tool_use_id":"tail_id"') });
  const x1 = '{"tool_name":"Bash","tool_use_id":"x1","o":"';
  add('post exactly at the head', { event: 'post', route: 'k', auth: 'good', body: fit(x1, HEAD, '","trigger":"auto"}') });
  add('post one unit past the head', { event: 'post', route: 'k', auth: 'good', body: fit(x1, HEAD + 1, '","trigger":"auto"}') });
  add('post with a tail of exactly 2K', { event: 'post', route: 'k', auth: 'good', body: fit(x1, HEAD + 2048, '","tool_use_id":"y2"}') });
  add('post with a pair cut by the head', { event: 'post', route: 'k', auth: 'good', body: big('{"tool_name":"Bash","o":"' + 'a'.repeat(HEAD - 26), 1, ',"tool_use_id":"t"}', '\u{1F600}') });
  add('pre with the id beyond the tail', { event: 'pre', route: 'k', auth: 'good', body: big('{"tool_name":"Read","tool_input":"', 20_000, '","tool_use_id":"far"' + ',"x":"' + 'z'.repeat(3000) + '"}') });
  add('pre with 2 MB of input', { event: 'pre', route: 'k', auth: 'good', body: big('{"tool_name":"Write","tool_use_id":"w1","tool_input":"', 2_000_000, '"}', 'ą') });
  add('pre with bad UTF-8 is decoded lossily', { event: 'pre', route: 'k', auth: 'good', bytes: [0x7b, 0x22, 0x74, 0x6f, 0x6f, 0x6c, 0x5f, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d] });
  // Credentials and routing.
  add('stale nonce is answered and dropped', { event: 'stop', nonce: 'stale', body: '{}' });
  add('stale nonce of a session', { event: 'session', nonce: 'stale', body: JSON.stringify({ session_id: ID }) });
  add('missing nonce (old URL format)', { event: 'stop', nonce: 'none', body: '{}' });
  add('forgotten cell', { event: 'stop', nonce: 'forgotten', body: '{}' });
  add('nonce of another cell', { event: 'stop', nonce: 'other', body: '{}' });
  add('bad token', { route: 'raw', path: '/h/wrongtoken/c1/stop/{nonce}', body: '{}' });
  add('bad token with 2 MB', { route: 'raw', path: '/h/wrongtoken/c1/stop/{nonce}', body: big('', 2_000_000) });
  add('GET is refused', { event: 'stop', method: 'GET' });
  add('PUT is refused', { event: 'stop', method: 'PUT', body: '{}' });
  add('bearer missing', { event: 'stop', route: 'k', auth: 'none', body: '{}' });
  add('bearer wrong', { event: 'stop', route: 'k', auth: 'bad', body: '{}' });
  add('bearer lower-case scheme', { event: 'stop', route: 'k', auth: 'lower', body: '{}' });
  add('bearer with the token in the path too', { route: 'raw', path: '/k/{token}/c1/stop/{nonce}', auth: 'good', body: '{}' });
  add('k route GET', { event: 'stop', route: 'k', auth: 'good', method: 'GET' });
  add('unknown first segment', { route: 'raw', path: '/z/{token}/c1/stop/{nonce}' });
  add('root path', { route: 'raw', path: '/' });
  add('token only', { route: 'raw', path: '/h/{token}' });
  add('empty segments are skipped', { route: 'raw', path: '//h//{token}///c1//stop//{nonce}//', body: '{}' });
  add('a query string sticks to the nonce', { route: 'raw', path: '/h/{token}/c1/stop/{nonce}?x=1', body: '{}' });
  add('an extra segment is ignored', { route: 'raw', path: '/h/{token}/c1/stop/{nonce}/more', body: '{}' });
  add('a bad escape in the cell id', { route: 'raw', path: '/h/{token}/%E0%A4%A/stop' });
  add('a space in the cell id', { route: 'raw', path: '/h/{token}/a%20b/stop' });
  add('an escaped dash decodes', { cell: 'c-1', route: 'raw', path: '/h/{token}/c%2D1/stop/{nonce}', body: '{}' });
  add('an escaped slash', { route: 'raw', path: '/h/{token}/a%2Fb/stop/{nonce}' });
  add('a cell id of 64 characters', { cell: 'k'.repeat(64), event: 'prompt' });
  add('a cell id of 65 characters', { route: 'raw', path: `/h/{token}/${'k'.repeat(65)}/prompt/x` });
  add('no cell id', { route: 'raw', path: '/h/{token}' });
  add('no event', { route: 'raw', path: '/h/{token}/c1' });
  add('an encoded multibyte cell id', { route: 'raw', path: '/h/{token}/%C4%85/stop/x' });
  // The end of the agent CLI.
  add('exit code', { route: 'x', code: '0' });
  add('negative exit code', { route: 'x', code: '-1' });
  add('ten digits', { route: 'x', code: '9999999999' });
  add('eleven digits', { route: 'x', code: '12345678901' });
  add('not a number', { route: 'x', code: '1a' });
  add('no exit code', { route: 'x', code: null });
  add('exit with a body', { route: 'x', code: '3', body: 'x'.repeat(5000) });
  add('exit with a stale nonce', { route: 'x', code: '0', nonce: 'stale' });
  add('exit without a nonce', { route: 'raw', path: '/x/c1' });
  add('exit GET', { route: 'x', code: '0', method: 'GET' });
  add('exit for an encoded cell id', { route: 'raw', path: '/x/c%2D1/{nonce}/0' });
  add('exit for a bad cell id', { route: 'raw', path: '/x/a.b/{nonce}/0' });
  return rows;
}

/** The URL path, headers and body bytes of one request (`ids`: token, current / stale nonce, port). */
export function buildRequest(req, ids) {
  const nonce = { current: ids.nonce, stale: ids.stale, forgotten: ids.nonce, other: ids.other, none: null }[req.nonce];
  let path;
  if (req.route === 'raw') path = req.path.replaceAll('{token}', ids.token).replaceAll('{nonce}', ids.nonce);
  else if (req.route === 'x') path = `/x/${req.cell}/${nonce}${req.code === null ? '' : `/${req.code}`}`;
  else {
    const head = req.route === 'k' ? '/k' : `/h/${ids.token}`;
    path = `${head}/${encodeURIComponent(req.cell)}/${req.event}${nonce === null ? '' : `/${nonce}`}`;
  }
  const headers = {};
  if (req.auth === 'good') headers.Authorization = `Bearer ${ids.token}`;
  if (req.auth === 'bad') headers.Authorization = 'Bearer 00000000000000000000000000000000';
  if (req.auth === 'lower') headers.Authorization = `bearer ${ids.token}`;
  const body = req.bytes ? Buffer.from(req.bytes) : Buffer.from(bodyText(req.body), 'utf8');
  return { path, headers, body };
}

function send(port, method, path, headers, body) {
  return new Promise((resolve) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { ...headers, 'Content-Length': body.length, Connection: 'close' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', (e) => resolve(`error ${e.code}`));
    r.end(body);
  });
}

/** Runs every request against the real 1.1.4 HookServer. */
export async function hookServerRows({ HookServer }) {
  const s = new HookServer();
  await s.start();
  const events = [];
  for (const name of ['hook', 'session', 'sessionstart', 'transcript', 'codex', 'cliexit']) {
    s.on(name, (...args) => events.push([name, ...args.map((a) => (a === undefined ? null : a))]));
  }
  const nonceOf = (cell) => s.exitUrl(cell).split('/').pop();
  const rows = [];
  try {
    for (const { name, request: req } of serverRequests()) {
      s.prepareCodex(req.cell);
      const stale = nonceOf(req.cell);
      s.prepareCodex(req.cell);
      const ids = { token: s.token, nonce: nonceOf(req.cell), stale, other: nonceOf('other-cell') };
      if (req.nonce === 'forgotten') s.forget(req.cell);
      const { path, headers, body } = buildRequest(req, ids);
      events.length = 0;
      const status = await send(s.port, req.method, path, headers, body);
      await new Promise((r) => setTimeout(r, 5));
      rows.push({ name, request: req, status, events: JSON.parse(JSON.stringify(events)) });
    }
  } finally {
    s.stop();
  }
  return rows;
}
