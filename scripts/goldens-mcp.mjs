// The MCP tool layer part of the golden corpus (1.2.0, PLAN M2), used by scripts/dump-goldens.mjs:
//
//   test/golden/mcp-tools.json   the tools/list payload per role (toolsForRole), the task-capable and legacy names, and
//                                mcpInstructions for roles x callers x delegation settings (the raw settings value goes
//                                through delegationOf like the server does)
//   test/golden/mcp-zod.jsonl    {schema, input} -> the parsed output or the zod 4 issues {code, path, message} and the
//                                describeError text; `schema` is `tool:<name>` (the MCP tool schema) or `op:<operation>`
//                                (automationSchemas of src/shared/automation.ts)
//   test/golden/mcp-calls.jsonl  {scenario} -> what callTool of src/main/mcpTools.ts does over a scripted service: the
//                                service calls (operation, JSON.stringify of the arguments), the elicitations it asks and
//                                the result text (JSON.stringify) or the error text (describeError) or `unknown` (null)
//
// Long strings are written compactly: {"$repeat": "a", "n": 32001} is "a" 32001 times and {"$cat": [...]} joins parts;
// both sides expand inputs and compact outputs the same way (src-tauri/crates/unimux-mcp/tests/golden_tools.rs).

/** Inputs: {"$repeat"} and {"$cat"} markers to strings. */
export function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    if (typeof value.$repeat === 'string' && Object.keys(value).length === 2) return value.$repeat.repeat(value.n);
    if (Array.isArray(value.$cat) && Object.keys(value).length === 1) return value.$cat.map(expand).join('');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}
/** Outputs: a string of one repeated character longer than 40 units becomes {"$repeat"}; others stay. */
export function compactLong(value) {
  if (typeof value === 'string') {
    const chars = [...value];
    if (chars.length > 40 && chars.every((c) => c === chars[0])) return { $repeat: chars[0], n: chars.length };
    return value;
  }
  if (Array.isArray(value)) return value.map(compactLong);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compactLong(v)]));
  return value;
}
const rep = (ch, n) => ({ $repeat: ch, n });
const cat = (...parts) => ({ $cat: parts });

// --- tools/list and instructions ---
export function toolsGolden({ toolsForRole, supportsTask, LEGACY_OPERATIONS, MCP_TOOLS, mcpInstructions, delegationOf }) {
  const whos = [
    { cellId: 'c1' }, { cellId: 'c1', name: 'Lead', project: 'Proj' }, { cellId: 'w-2', name: '', project: '' },
    { cellId: 'x', name: 'Zażółć "gęślą"', project: 'Jaźń 😀' }, { cellId: 'x', name: 7, project: null },
  ];
  const delegations = [
    undefined, null, 5, [], {}, { mode: 'ask' }, { mode: 'auto' }, { mode: 'ASK' }, { mode: 'auto', maxAgents: 1 }, { mode: 'auto', maxAgents: 20 },
    { mode: 'auto', maxAgents: 0 }, { mode: 'auto', maxAgents: 21 }, { mode: 'auto', maxAgents: 2.5 }, { mode: 'auto', maxAgents: 3.49 },
    { mode: 'auto', maxAgents: '7' }, { mode: 'auto', maxAgents: ' 8 ' }, { mode: 'auto', maxAgents: '' }, { mode: 'auto', maxAgents: '  ' },
    { mode: 'auto', maxAgents: '0x10' }, { mode: 'auto', maxAgents: '1e1' }, { mode: 'auto', maxAgents: 'abc' }, { mode: 'auto', maxAgents: null },
    { mode: 'auto', maxAgents: true }, { mode: 'auto', maxAgents: -3 }, { mode: 'ask', maxAgents: 9 },
  ];
  const instructions = [];
  for (const role of [undefined, 'coordinator', 'worker']) {
    for (const who of whos) {
      for (const delegation of delegations) {
        const settings = delegation === undefined ? {} : { delegation };
        instructions.push({ role: role ?? null, who, delegation: delegation === undefined ? '$absent' : delegation,
          out: mcpInstructions(role, who, delegationOf({ settings })) });
      }
    }
  }
  return {
    coordinator: toolsForRole('coordinator'), worker: toolsForRole('worker'), none: toolsForRole(undefined),
    names: MCP_TOOLS.map((t) => t.name), unlisted: MCP_TOOLS.filter((t) => t.unlisted).map((t) => t.name),
    roles: Object.fromEntries(MCP_TOOLS.map((t) => [t.name, [...t.roles]])),
    taskCapable: MCP_TOOLS.map((t) => t.name).concat(['nope', 'read_inbox']).filter((n) => supportsTask(n)),
    legacy: [...LEGACY_OPERATIONS],
    instructions,
  };
}

// --- zod ---
const POOL = [
  '$absent', null, true, false, 0, -0, -1, 1, 1.5, 4, 5, 6, 19, 20, 21, 45, 50, 59, 60, 61, 100, 101, 128, 199, 200, 201, 500, 600, 601, 3600,
  1e6, 1000001, 2 ** 53 - 1, 2 ** 53, -(2 ** 53), 'x', '', '   ', ' a ', '\u00a0\ufeffb\u2028', rep('a', 32), rep('a', 128), rep('a', 129),
  rep('a', 140), cat(' ', rep('a', 140), ' '), rep('a', 141), rep('😀', 64), cat('x', rep('😀', 64)), rep('a', 200), rep('a', 201), rep('a', 1001),
  rep('a', 2000), rep('a', 2001), rep('a', 32000), rep('a', 32001), cat(rep(' ', 3), rep('a', 32000), rep(' ', 3)), '#aabbcc', '#AABBCC', '#aabbc', '#aabbccd', 'aabbcc',
  'gpt-5.1', 'a/b:c-d_e.f', '-bad', '.x', ' gpt ', 'coordinator', 'worker', 'queued', 'in_progress', 'blocked', 'completed', 'cancelled', 'bogus',
  'list', 'apply', 'task', 'message', 'cols', 'workflow', 'grids',
  [], ['a'], [1], [''], [0, 19], [1.5], [-1], [20], [null], [{}], {}, { summary: 's' }, { a: 1 },
];
const REPEAT_ARRAYS = [Array.from({ length: 19 }, (_, i) => i), Array.from({ length: 20 }, (_, i) => i % 19), Array.from({ length: 50 }, () => 'id'),
  Array.from({ length: 51 }, () => 'id'), Array.from({ length: 100 }, () => 'f'), Array.from({ length: 101 }, () => 't'), Array.from({ length: 200 }, () => 'f'),
  Array.from({ length: 201 }, () => 'f'), Array.from({ length: 60 }, () => 1), Array.from({ length: 61 }, () => 1), [1, 2, 3, 4], [1, 2, 3, 4, 5], [6], [0],
  Array.from({ length: 51 }, () => 5), [1, 'a', 2, null, 3, 4, 5]];

/** A valid base input per schema, so each row varies one key. */
const BASES = {
  'op:get_snippet': { snippetId: 's' }, 'op:apply_snippet': { snippetId: 's', cellId: 'c' }, 'op:create_grid': { name: 'G' },
  'op:close_grid': { gridId: 'g' }, 'op:add_agents': { gridId: 'g', cells: [{ profileId: 'p' }] }, 'op:update_grid': { gridId: 'g' },
  'op:update_agent': { cellId: 'c' }, 'op:save_snippet': { name: 'S', text: 'T' }, 'op:save_preset': { name: 'P', cells: [{ profileId: 'p' }] },
  'op:create_task': { cellId: 'c', title: 'T', prompt: 'P' }, 'op:update_task': { taskId: 't' }, 'op:send_message': { toCellId: 'c', text: 'hi' },
  'op:acknowledge_message': { messageId: 'm' }, 'op:set_paused': { paused: true }, 'op:set_role': { cellId: 'c', role: 'worker' },
  'op:deliver_task': { taskId: 't' }, 'op:deliver_message': { messageId: 'm' }, 'op:mark_pasted': { kind: 'task', id: 'i' },
  'op:remove_items': { projectId: 'p', kind: 'task' },
  'tool:update_grid': { gridId: 'g', name: 'N' }, 'tool:save_preset': { name: 'P', cells: [] },
};
const CELL_KEYS = ['profileId', 'name', 'role', 'color', 'model', 'prompt', 'worktree', 'dir', 'muted', 'after', 'count', 'extra'];
const LAYOUT = { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] };
const LAYOUT_KEYS = ['cols', 'rows', 'areas', 'rowCounts', 'rowSizes', 'colSizes', 'rowColSizes', 'colRowSizes', 'mode', 'extra'];
const AREA_KEYS = ['col', 'row', 'colSpan', 'rowSpan', 'extra'];
const RESULT_KEYS = ['summary', 'files', 'tests', 'branch', 'commit', 'extra'];
/** Nested objects whose keys are varied too: [schema, path to the object, its keys, the base object there]. */
const NESTED = [
  ['op:create_grid', ['cells', 0], CELL_KEYS, { profileId: 'p' }], ['op:add_agents', ['cells', 0], CELL_KEYS, { profileId: 'p' }],
  ['op:save_preset', ['cells', 0], CELL_KEYS, { profileId: 'p' }], ['op:create_grid', ['layout'], LAYOUT_KEYS, LAYOUT],
  ['op:create_grid', ['layout', 'areas', 0], AREA_KEYS, LAYOUT.areas[0]], ['op:add_agents', ['layout'], LAYOUT_KEYS, LAYOUT],
  ['op:update_task', ['result'], RESULT_KEYS, { summary: 's' }],
  ['op:create_grid', ['layout', 'rowColSizes', 0], [], null],
];
const setPath = (base, path, value) => {
  const root = structuredClone(base);
  let at = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (at[key] === undefined || at[key] === null || typeof at[key] !== 'object') at[key] = typeof path[i + 1] === 'number' ? [] : {};
    at = at[key];
  }
  const last = path[path.length - 1];
  if (value === '$absent') { if (Array.isArray(at)) at.splice(last, 1); else delete at[last]; } else at[last] = structuredClone(value);
  return root;
};

export function zodRows({ z, automationSchemas, MCP_TOOLS, describeError }) {
  const schemas = {};
  for (const [op, schema] of Object.entries(automationSchemas)) schemas[`op:${op}`] = schema;
  // A tool that validates with the operation's own schema (update_task, send_message, create_task, close_grid) is the same
  // object: its rows are the op: rows.
  const shared = new Set(Object.values(automationSchemas));
  for (const tool of MCP_TOOLS) if (!shared.has(tool.schema)) schemas[`tool:${tool.name}`] = tool.schema;
  const rows = [];
  const seen = new Set();
  const add = (schema, input) => {
    const key = `${schema}\u0000${JSON.stringify(input)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const r = schemas[schema].safeParse(expand(input));
    if (r.success) rows.push({ schema, input, out: compactLong(r.data) });
    else rows.push({ schema, input, issues: r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })), text: describeError(r.error) });
    if (!r.success && !(r.error instanceof z.ZodError)) throw new Error('not a ZodError');
  };
  for (const name of Object.keys(schemas)) {
    const base = BASES[name] ?? {};
    add(name, base);
    for (const root of [null, [], 'x', 5, true]) add(name, root);
    add(name, { ...base, extra: 1 });
    add(name, { ...base, b: 1, a: 2, '1': 3 });
    add(name, { ...base, __proto__x: 1, constructor: 1 });
    for (const key of [...Object.keys(schemas[name].shape), 'extra']) {
      for (const value of POOL) add(name, setPath(base, [key], value));
      for (const value of REPEAT_ARRAYS) add(name, setPath(base, [key], value));
    }
  }
  for (const [name, path, keys, nestedBase] of NESTED) {
    const base = setPath(BASES[name] ?? {}, path, nestedBase ?? []);
    for (const key of keys) {
      for (const value of POOL) add(name, setPath(base, [...path, key], value));
      for (const value of REPEAT_ARRAYS) add(name, setPath(base, [...path, key], value));
    }
    if (!keys.length) for (const value of POOL) add(name, setPath(base, path, value));
    for (const value of POOL) add(name, setPath(BASES[name] ?? {}, path, value));
  }
  // Many issues at once (describeError lists the first 5), nested paths, every key wrong.
  add('op:create_grid', { name: '', color: 'x', cells: [{ profileId: '', role: 'boss', after: [1.5, -1, 20], worktree: 'yes', extra: 1 }, 5], rows: [0, 6], layout: { cols: 0, rows: 9, areas: [] }, projectId: 7, more: 1 });
  add('op:update_task', { taskId: '', status: 'x', cellId: 5, blockedReason: '  ', result: { summary: '', files: [1], tests: 'x', branch: 5, commit: rep('c', 129), extra: 1 }, a: 1, b: 2 });
  add('op:wait_for', { taskIds: [], all: 1, timeoutSec: 0 });
  add('op:wait_for', { taskIds: [''], timeoutSec: 600 });
  add('op:read_inbox', { acknowledge: null, openOnly: 'x', ackMaxChars: 0, limit: 0, offset: -1 });
  add('op:get_tasks', { readyOnly: 1, ids: [], status: 'done', limit: 101, offset: 1.5, cellId: '' });
  add('op:save_snippet', { name: ' ', text: ' ', autoSend: 'x', icon: rep('i', 33), color: 'red', id: '', projectId: '' });
  add('tool:create_grid', { name: 'G', cells: [{ any: 1 }], layout: 'x' });
  add('tool:create_grid', { name: 'G', rows: [1.5, 'x'], cells: 'x' });
  add('tool:save_preset', { name: 5, cells: {}, rows: [0.5], id: 1 });
  add('tool:update_agent', { color: null, model: null, cellId: null });
  add('tool:get_tasks', { status: 5, ids: [1, 'a', null], limit: 1.5, offset: 'x', verbose: 0, readyOnly: null, cellId: 1, projectId: [] });
  add('tool:snippets', { action: 'delete', autoSend: 'yes' });
  add('tool:help', { topic: 'nope' });
  add('tool:read_inbox', { acknowledge: 1, closed: 1, openOnly: 1, full: 1, limit: 1.5, offset: 'x' });
  return rows;
}

// --- callTool over a scripted service ---
const D = (o) => o;
const prompt = (n) => rep('p', n);
const STATE = {
  projects: [{
    id: 'p1', name: 'Proj', path: 'D:/proj',
    tabs: [
      { id: 'g1', name: 'Team', cells: [
        { id: 'lead', name: 'Lead', profileId: 'claude', role: 'coordinator' }, { id: 'w1', name: 'Backend', profileId: 'codex', role: 'worker' },
        { id: 'w2', name: 'Twin', profileId: 'codex', role: 'worker' }, { id: 'w3', name: ' twin ', profileId: 'codex', role: 'worker' },
        { id: 'plain', name: 'Plain', profileId: 'claude' }, { id: 'odd', profileId: 'claude', role: 'worker' },
      ] },
      { id: 'g2', name: 'Side', cells: [{ id: 's1', name: 'Side worker', profileId: 'codex', role: 'worker' }, { id: 's2', name: 'Side two', profileId: 'codex', role: 'worker' }] },
      { id: 'g3', name: 'Done', cells: [{ id: 'd1', name: 'Done worker', profileId: 'codex', role: 'worker' }] },
    ],
  }],
  automation: {
    paused: false,
    tasks: [
      { id: 't1', cellId: 'w1', status: 'queued', title: 'A' }, { id: 't2', cellId: 'w1', status: 'completed', title: 'B' },
      { id: 't3', cellId: 'w1', status: 'in_progress', title: 'C' }, { id: 't4', cellId: 'lead', status: 'cancelled', title: 'D' },
      { id: 't5', cellId: 's1', status: 'blocked', title: 'E' }, { id: 't6', cellId: 's2', status: 'queued', title: 'F' }, { id: 't7', cellId: 'd1', status: 'completed', title: 'G' },
    ],
    messages: [
      { id: 'm1', toCellId: 'w1', text: 'x' }, { id: 'm2', toCellId: 'w1', text: 'y', readAt: 5 }, { id: 'm3', toCellId: 'lead', text: 'z' },
      { id: 'm4', toCellId: 'w1', text: 'z', readAt: 0 }, { id: 'm5', toCellId: 'w1', text: 'q', readAt: null },
    ],
    events: [],
  },
  settings: { delegation: { mode: 'auto', maxAgents: 4 } },
};
const AGENT_ROWS = [
  { cellId: 'lead', name: 'Lead', gridId: 'g1', gridName: 'Team', profileId: 'claude', role: 'coordinator', status: 'working', since: 12, mcp: 'connected', cwd: 'D:/proj', tasks: [] },
  { cellId: 'w1', name: 'Backend', gridId: 'g1', gridName: 'Team', profileId: 'codex', model: 'gpt-5.1', role: 'worker', status: 'ready', mcp: 'waiting', cwd: 'D:/proj', lastExitCode: 3, tasks: [{ id: 't1', title: 'A', status: 'queued' }, { id: 't3', title: 'C', status: 'in_progress' }] },
  { cellId: 'w2', name: 'Twin', gridId: 'g1', gridName: 'Team', profileId: 'codex', role: 'worker', status: 'unknown', mcp: 'off', cwd: 'D:/proj', tasks: [] },
  { cellId: 'w3', name: ' twin ', gridId: 'g1', gridName: 'Team', profileId: 'codex', role: 'worker', status: 'unknown', mcp: 'off', cwd: 'D:/proj', tasks: [] },
  { cellId: 'plain', name: 'Plain', gridId: 'g1', gridName: 'Team renamed', profileId: 'claude', role: null, status: 'exited', mcp: 'off', cwd: 'D:/proj', tasks: [] },
  { cellId: 's1', name: 'Side worker', gridId: 'g2', gridName: 'Side', profileId: 'codex', role: 'worker', status: 'working', since: 0, mcp: 'connected', cwd: 'D:/proj/wt', tasks: [{ id: 't5', title: 'E', status: 'blocked' }] },
];
const TWINS = [AGENT_ROWS[0], { ...AGENT_ROWS[2] }, { ...AGENT_ROWS[3], gridName: 'Team 2' }];
const ok = (value) => ({ value });
const fail = (error) => ({ error });
const task = (o) => ({ id: 'tn', projectId: 'p1', cellId: 'w1', title: 'T', prompt: 'P', status: 'queued', delivery: 'pending', createdAt: 1, updatedAt: 2, ...o });
const LONG = rep('s', 450);

/** The scenarios: steps run in order over one service (promptsShown carries over), `elicit` answers in order (absent: no elicitation). */
export const SCENARIOS = [
  // get_context
  { name: 'get_context coordinator', actor: 'lead', steps: [{ tool: 'get_context', args: {} }],
    responses: { get_context: ok({ cellId: 'lead', role: 'coordinator', projectId: 'p1', projectName: 'Proj', cwd: 'D:/proj', gridId: 'g1', profileId: 'claude', paused: false, profiles: [{ id: 'claude', name: 'Claude', cli: 'claude' }] }) } },
  { name: 'get_context profiles paused model', actor: 'w1', steps: [{ tool: 'get_context', args: { profiles: true } }, { tool: 'get_context' }, { tool: 'get_context', args: { profiles: false } }],
    responses: { get_context: [ok({ cellId: 'w1', role: 'worker', projectId: 'p1', projectName: 'Proj', cwd: 'D:/proj', gridId: 'g1', profileId: 'codex', model: 'gpt-5.1', paused: true, profiles: [{ id: 'claude', name: 'Claude', cli: 'claude' }, { id: 'codex', name: 'Codex', cli: 'codex' }] }),
      ok({ cellId: 'w1', role: 'worker', projectId: 'p1', projectName: 'Proj', cwd: 'D:/proj', gridId: 'g1', profileId: 'codex', model: null, paused: 0, profiles: [] }),
      ok({ cellId: 'w1', role: 'worker', projectId: 'p1', projectName: 'Proj', cwd: 'D:/proj', gridId: 'g1', profileId: 'codex', paused: false, profiles: [] })] } },
  { name: 'get_context unnamed cell and zod', actor: 'odd', steps: [{ tool: 'get_context', args: {} }, { tool: 'get_context', args: { profiles: 'yes' } }, { tool: 'get_context', args: { other: 1 } }],
    responses: { get_context: ok({ cellId: 'odd', role: 'worker', projectId: 'p1', projectName: 'Proj', cwd: 'D:/proj', gridId: 'g1', profileId: 'claude', paused: false, profiles: [] }) } },
  { name: 'get_context service error', actor: 'lead', steps: [{ tool: 'get_context', args: {} }], responses: { get_context: fail('Automation is paused by the user.') } },
  // list_agents
  { name: 'list_agents plain and verbose', actor: 'lead', steps: [{ tool: 'list_agents', args: {} }, { tool: 'list_agents', args: { verbose: true } }, { tool: 'list_agents', args: { projectId: 'p1' } }, { tool: 'list_agents', args: { projectId: '' } }],
    responses: { list_agents: [ok(AGENT_ROWS), ok(AGENT_ROWS), ok(AGENT_ROWS.slice(0, 2)), ok([])] } },
  { name: 'list_agents error', actor: 'w1', steps: [{ tool: 'list_agents', args: { projectId: 'other' } }], responses: { list_agents: fail('Project access denied.') } },
  // read_inbox
  { name: 'read_inbox prompts once', actor: 'w1', steps: [{ tool: 'read_inbox', args: {} }, { tool: 'read_inbox', args: {} }, { tool: 'read_inbox', args: { full: true } }, { tool: 'read_inbox', args: { acknowledge: true, limit: 5, closed: true } }, { tool: 'read_inbox', args: { openOnly: true, offset: 2 } }],
    responses: { read_inbox: [
      ok({ tasks: [task({ id: 'r1', prompt: 'short', fromCellId: 'lead', dependsOn: ['x'], blockedBy: [], delivery: 'pending', deliveryError: 'not running' }), task({ id: 'r2', prompt: prompt(12000), status: 'in_progress', delivery: 'native' }),
        task({ id: 'r3', prompt: prompt(12001) }), task({ id: 'r4', status: 'completed', prompt: 'closed one', result: { summary: LONG, files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], tests: ['1', '2', '3', '4'], branch: 'b', commit: 'c' } })],
        messages: [{ id: 'm1', fromCellId: 'lead', text: 'hello' }, { id: 'm9', text: rep('m', 8001) }], acknowledgedMessageIds: [], hasMoreTasks: false, hasMoreMessages: false }),
      ok({ tasks: [task({ id: 'r1', prompt: 'short' }), task({ id: 'r2', prompt: prompt(12000), status: 'in_progress' }), task({ id: 'r3', prompt: prompt(12001) })], messages: [], acknowledgedMessageIds: [], hasMoreTasks: true, hasMoreMessages: false }),
      ok({ tasks: [task({ id: 'r1', prompt: 'short' }), task({ id: 'r3', prompt: prompt(32001) })], messages: [{ id: 'm9', text: rep('m', 32001) }], acknowledgedMessageIds: [], hasMoreTasks: false, hasMoreMessages: true }),
      ok({ tasks: [task({ id: 'r1', prompt: 'short' }), task({ id: 'r5', status: 'cancelled', prompt: 'gone', result: { summary: 'sum', files: [], tests: [] } })], messages: [{ id: 'm9', text: rep('m', 8001) }, { id: 'm1', text: 'x' }], acknowledgedMessageIds: ['m1'], hasMoreTasks: false, hasMoreMessages: false }),
      ok({ tasks: [], messages: [], acknowledgedMessageIds: [], hasMoreTasks: 0, hasMoreMessages: null }),
    ] } },
  { name: 'read_inbox zod', actor: 'w1', steps: [{ tool: 'read_inbox', args: { limit: 2.5 } }, { tool: 'read_inbox', args: { limit: 0 } }], responses: { read_inbox: ok({ tasks: [], messages: [], acknowledgedMessageIds: [], hasMoreTasks: false, hasMoreMessages: false }) } },
  // wait_for
  { name: 'wait_for plain', actor: 'lead', steps: [{ tool: 'wait_for', args: { taskIds: ['t1'], all: true, timeoutSec: 30 } }, { tool: 'wait_for', args: {} }, { tool: 'wait_for', args: { timeoutSec: 1.5 } }],
    responses: { wait_for: [ok({ event: 'tasks', tasks: [{ id: 't1', status: 'completed', summary: rep('s', 301) }, { id: 't3', status: 'blocked', blockedReason: rep('b', 301) }, { id: 't9', status: 'cancelled', summary: 'ok' }] }), ok({ event: 'timeout' })] } },
  { name: 'wait_for task mode loops', actor: 'w1', task: true, steps: [{ tool: 'wait_for', args: { timeoutSec: 100 } }, { tool: 'wait_for', args: { taskIds: ['t1'] } }, { tool: 'wait_for', args: { timeoutSec: 30 } }],
    responses: { wait_for: [ok({ event: 'timeout' }), ok({ event: 'timeout' }), ok({ event: 'inbox', unreadMessages: 1 }), ok({ event: 'tasks', tasks: [{ id: 't1', status: 'completed', summary: rep('s', 400) }] }), ok({ event: 'exited', cells: ['s1'] })] } },
  { name: 'wait_for task bad timeouts', actor: 'w1', task: true, steps: [{ tool: 'wait_for', args: { timeoutSec: 0 } }, { tool: 'wait_for', args: { timeoutSec: 3601 } }, { tool: 'wait_for', args: { timeoutSec: 3600 } }],
    responses: { wait_for: [ok({ event: 'inbox' })] } },
  { name: 'wait_for service error', actor: 'w1', steps: [{ tool: 'wait_for', args: { timeoutSec: 601 } }], responses: { wait_for: fail('x') } },
  // update_task
  { name: 'update_task worker', actor: 'w1', steps: [{ tool: 'update_task', args: { taskId: 't1', status: 'in_progress' } }, { tool: 'update_task', args: { status: 'completed', taskId: 't1', result: { summary: '  done  ', tests: ['ok'] } } },
    { tool: 'update_task', args: { taskId: 'zz', status: 'blocked', blockedReason: 'stuck' } }, { tool: 'update_task', args: { taskId: 't1', status: 'blocked' } }, { tool: 'update_task', args: { taskId: 't1', status: 'completed', extra: 1 } },
    { tool: 'update_task', args: { taskId: 't1', status: 'cancelled' } }],
    responses: { update_task: [ok(task({ id: 't1', status: 'in_progress' })), ok(task({ id: 't1', status: 'completed' })), fail('Task not found.'), fail('blockedReason is required.'), ok(task({ id: 't1', status: 'cancelled' }))] } },
  { name: 'update_task coordinator reassign', actor: 'lead', elicit: [{ action: 'accept', content: { cellId: 'w3' } }, { action: 'decline' }, { action: 'accept', content: { cellId: 'nope' } }, { action: 'accept' }, { action: 'cancel' }],
    steps: [{ tool: 'update_task', args: { taskId: 't1', cellId: 'w1' } }, { tool: 'update_task', args: { taskId: 't1', cellId: 'backend' } }, { tool: 'update_task', args: { taskId: 't1', cellId: 'TWIN' } },
      { tool: 'update_task', args: { taskId: 't1', cellId: 'twin' } }, { tool: 'update_task', args: { cellId: 'twin', taskId: 't1' } }, { tool: 'update_task', args: { taskId: 't1', cellId: 'Twin' } }, { tool: 'update_task', args: { taskId: 'nope', status: 'cancelled' } },
      { tool: 'update_task', args: { taskId: 't1', cellId: 'Ghost' } }, { tool: 'update_task', args: { taskId: 't1', cellId: '   ' } }],
    responses: { list_agents: [ok(AGENT_ROWS), ok(TWINS), ok(TWINS), ok(TWINS), ok(TWINS), ok(TWINS), ok(AGENT_ROWS)],
      update_task: [ok(task({ id: 't1', cellId: 'w1', delivery: 'native' })), ok(task({ id: 't1', delivery: 'pasted', status: 'queued' })), ok(task({ id: 't8', delivery: 'startup' })), fail('Task not found.'), fail('Target must be an active agent cell with MCP enabled: see list_agents for cell IDs.'), fail('Target must be an active agent cell with MCP enabled: see list_agents for cell IDs.')] } },
  { name: 'update_task name lookup fails', actor: 'lead', steps: [{ tool: 'update_task', args: { taskId: 't1', cellId: 'Someone' } }], responses: { list_agents: fail('Project not found.') } },
  // send_message
  { name: 'send_message names', actor: 'lead', elicit: [{ action: 'accept', content: { cellId: 'w2' } }],
    steps: [{ tool: 'send_message', args: { toCellId: 'w1', text: ' hi ' } }, { tool: 'send_message', args: { toCellId: 'Backend', text: 'x' } }, { tool: 'send_message', args: { toCellId: 'twin', text: 'x' } },
      { tool: 'send_message', args: { toCellId: 'w1', text: '   ' } }, { tool: 'send_message', args: { text: 'x' } }, { tool: 'send_message', args: { toCellId: 'w1', text: rep('a', 32001) } }],
    responses: { list_agents: [ok(AGENT_ROWS), ok(TWINS)], send_message: [ok({ id: 'msg1', delivery: 'native' }), ok({ id: 'msg2', delivery: 'pending', deliveryError: 'Agent is not running.' }), ok({ id: 'msg3', delivery: 'pasted' })] } },
  { name: 'send_message ambiguous without elicitation', actor: 'w1', steps: [{ tool: 'send_message', args: { toCellId: 'TWIN', text: 'x' } }], responses: { list_agents: ok(TWINS) } },
  // create_task
  { name: 'create_task dependsOn', actor: 'lead', steps: [{ tool: 'create_task', args: { cellId: 'w1', title: ' T ', prompt: 'P', dependsOn: ['t1', 't2', 'nope', 't4'] } }, { tool: 'create_task', args: { cellId: 'w1', title: 'T', prompt: 'P', dependsOn: ['t2'] } },
    { tool: 'create_task', args: { cellId: 'w1', title: 'T', prompt: 'P' } }, { tool: 'create_task', args: { cellId: 'w1', title: 'T' } }, { tool: 'create_task', args: { cellId: 'w1', title: 'T', prompt: 'P', dependsOn: Array.from({ length: 51 }, () => 'x') } }],
    responses: { create_task: [ok(task({ id: 'n1', delivery: 'pending' })), ok(task({ id: 'n2', delivery: 'startup', status: 'queued' })), fail('Team limit: at most 4 agents at once.')] } },
  // get_tasks
  { name: 'get_tasks paging', actor: 'lead', steps: [{ tool: 'get_tasks', args: {} }, { tool: 'get_tasks', args: { limit: 2, offset: 4, verbose: true, cellId: 'w1', status: 'queued', readyOnly: true, ids: ['a'], projectId: 'p1' } },
    { tool: 'get_tasks', args: { limit: 0 } }, { tool: 'get_tasks', args: { limit: 500 } }, { tool: 'get_tasks', args: { limit: 100, offset: 100 } }, { tool: 'get_tasks', args: { limit: 99 } }, { tool: 'get_tasks', args: { status: 'nope' } }],
    responses: { get_tasks: [ok([task({ id: 'a', cellId: 'w1', fromCellId: 'lead', blockedBy: ['b'], blockedReason: 'r', deliveryError: rep('e', 201), result: { summary: LONG, files: ['1', '2', '3', '4', '5', '6'], tests: [], commit: 'abc' } })]),
      ok([task({ id: 'a', prompt: prompt(13000) }), task({ id: 'b', delivery: 'native', result: { summary: LONG, files: ['1', '2', '3', '4', '5', '6'], tests: ['1', '2', '3', '4'] } }), task({ id: 'c' })]),
      ok([task({ id: 'a' }), task({ id: 'b' })]), ok(Array.from({ length: 100 }, (_, i) => task({ id: `x${i}` }))), ok(Array.from({ length: 100 }, (_, i) => task({ id: `y${i}` }))), ok(Array.from({ length: 100 }, (_, i) => task({ id: `z${i}` }))), fail('Invalid status.')] } },
  { name: 'get_tasks empty', actor: 'lead', steps: [{ tool: 'get_tasks', args: {} }], responses: { get_tasks: ok([]) } },
  // snippets
  { name: 'snippets actions', actor: 'lead', steps: [{ tool: 'snippets', args: {} }, { tool: 'snippets', args: { action: 'list' } }, { tool: 'snippets', args: { action: 'get', snippetId: 's1' } }, { tool: 'snippets', args: { action: 'get' } },
    { tool: 'snippets', args: { action: 'save', name: 'N', text: 'T' } }, { tool: 'snippets', args: { action: 'save', snippetId: 's1', name: 'N', text: 'T', autoSend: true } }, { tool: 'snippets', args: { action: 'apply', snippetId: 's1', cellId: 'Backend' } },
    { tool: 'snippets', args: { action: 'apply', snippetId: 's1' } }, { tool: 'snippets', args: { action: 'save', name: 'N' } }, { tool: 'snippets', args: { action: 'remove' } }],
    responses: { list_library: [ok({ snippets: [{ id: 's1', name: 'One', autoSend: false, projectId: 'p1' }, { id: 's2', name: 'Global', autoSend: true }], presets: [{ id: 'pr1', name: 'Team', cells: [{}, {}] }] }), ok({ snippets: [], presets: [] })],
      get_snippet: [ok({ id: 's1', name: 'One', text: 'Body', autoSend: true, projectId: 'p1' }), ok({ id: 's1', name: 'One', text: 'Body', autoSend: false })],
      save_snippet: [ok({ id: 'new', name: 'N', text: 'T', autoSend: false, projectId: 'p1' }), ok({ id: 's1', name: 'N', text: 'T', autoSend: true, projectId: 'p1' })],
      list_agents: ok(AGENT_ROWS), apply_snippet: [ok(task({ id: 'ap', delivery: 'native' })), ok(task({ id: 'ap2' }))] } },
  // update_agent
  { name: 'update_agent worker own', actor: 'w1', steps: [{ tool: 'update_agent', args: { name: ' Me ' } }, { tool: 'update_agent', args: { color: '' } }, { tool: 'update_agent', args: { color: '#aabbcc', model: '' } },
    { tool: 'update_agent', args: { restart: true } }, { tool: 'update_agent', args: { restart: false, model: 'gpt-5.1', profileId: 'claude', cellId: 'w1' } }, { tool: 'update_agent', args: { cellId: 'Lead', name: 'X' } }, { tool: 'update_agent', args: { color: null } }],
    responses: { update_agent: [ok({ cellId: 'w1', restarted: false, needsRestart: false }), ok({ cellId: 'w1', restarted: false, needsRestart: true }), ok({ cellId: 'w1', restarted: true, needsRestart: false }),
      ok({ cellId: 'w1', restarted: false, needsRestart: true, restartReason: rep('r', 250) }), fail('This operation requires the coordinator role: ask your coordinator (send_message) instead.'), fail('Only coordinators may edit other agents.'), ok({ cellId: 'w1', restarted: false, needsRestart: false })],
      list_agents: ok(AGENT_ROWS) } },
  // create_grid
  { name: 'create_grid shapes', actor: 'lead', steps: [
    { tool: 'create_grid', args: { name: 'G', cells: [{ profileId: 'codex', role: 'worker', name: 'Dev', count: 3, prompt: 'x' }, { profileId: 'claude', role: 'worker', name: 'Review', prompt: 'r', after: [0, 1, 2] }] } },
    { tool: 'create_grid', args: { cells: [{ profileId: 'codex', count: 2 }, { profileId: 'codex', name: 'One', count: 1 }, 'raw', null, [1], { count: 2, name: 0 }, { count: 2, name: 5 }], projectId: 'p1', rows: [2, 2], layout: { cols: 1 }, color: '#aabbcc', name: 'N', presetId: 'pr' } },
    { tool: 'create_grid', args: { name: 'G', cells: [{ profileId: 'codex', count: 0 }] } }, { tool: 'create_grid', args: { name: 'G', cells: [{ profileId: 'codex', count: 1.5 }] } },
    { tool: 'create_grid', args: { name: 'G', cells: [{ profileId: 'codex', count: 21 }] } }, { tool: 'create_grid', args: { name: 'G', cells: [{ profileId: 'codex', count: 12 }, { profileId: 'codex', count: 9 }] } },
    { tool: 'create_grid', args: { name: 'G', cells: [{ profileId: 'codex', count: 20 }, { profileId: 'codex' }] } }, { tool: 'create_grid', args: { name: 'G', cells: [{ profileId: 'codex', count: '2' }] } },
    { tool: 'create_grid', args: { gridId: 'g1', cells: [{ profileId: 'codex', name: 'Add', count: 2 }], rows: [3, 2] } }, { tool: 'create_grid', args: { gridId: 'g1', presetId: 'pr' } }, { tool: 'create_grid', args: { gridId: 'g1', name: 'ignored', color: '#000000' } },
    { tool: 'create_grid', args: { presetId: 'pr' } }, { tool: 'create_grid', args: { name: 5 } }, { tool: 'create_grid', args: { name: 'G', cells: [{ profileId: 'codex', count: 2, name: { a: 1 } }, { profileId: 'p', count: 2, name: [1, null, 'x'] }] } }],
    responses: { create_grid: [ok({ gridId: 'gn', cellIds: ['a', 'b', 'c', 'd'], tasks: { a: 't1' } }), ok({ gridId: 'gm', cellIds: [] }), ok({ gridId: 'gx' }), ok({ gridId: 'gy' }), fail('Preset not found.'), ok({ gridId: 'gz' })],
      add_agents: [ok({ gridId: 'g1', cellIds: ['n1', 'n2'], unavailable: [] }), fail('cells: required')] } },
  // close_grid
  { name: 'close_grid elicitation', actor: 'lead', elicit: [{ action: 'decline' }, { action: 'accept', content: { confirm: false } }, { action: 'accept', content: { confirm: 'true' } }, { action: 'cancel' }, { action: 'accept', content: { confirm: true } }],
    steps: [{ tool: 'close_grid', args: { gridId: 'g2' } }, { tool: 'close_grid', args: { gridId: 'g2' } }, { tool: 'close_grid', args: { gridId: 'g2' } }, { tool: 'close_grid', args: { gridId: 'g2' } }, { tool: 'close_grid', args: { gridId: 'g2' } },
      { tool: 'close_grid', args: { gridId: 'g2', cancelTasks: true } }, { tool: 'close_grid', args: { gridId: 'g3' } }, { tool: 'close_grid', args: { gridId: 'nope' } }, { tool: 'close_grid', args: { gridId: 'g1', cancelTasks: false } }],
    responses: { close_grid: [ok({ archivedGridId: 'g2', stoppedCellIds: ['s1', 's2'] }), ok({ archivedGridId: 'g2', stoppedCellIds: [] }), ok({ archivedGridId: 'g3', stoppedCellIds: ['d1'] }), fail('Grid not found.'), fail('You cannot close your own grid.')] } },
  { name: 'close_grid without elicitation', actor: 'lead', steps: [{ tool: 'close_grid', args: { gridId: 'g2' } }], responses: { close_grid: fail('The grid has 2 unfinished tasks: pass cancelTasks:true to cancel them.') } },
  { name: 'close_grid polish', actor: 'lead', language: 'pl', elicit: [{ action: 'decline' }], steps: [{ tool: 'close_grid', args: { gridId: 'g2' } }], responses: {} },
  { name: 'close_grid german unnamed actor', actor: 'odd', language: 'de', elicit: [{ action: 'decline' }], steps: [{ tool: 'close_grid', args: { gridId: 'g2' } }], responses: {}, roles: { odd: 'coordinator' } },
  { name: 'resolve polish', actor: 'lead', language: 'pl', elicit: [{ action: 'cancel' }], steps: [{ tool: 'send_message', args: { toCellId: ' Twin ', text: 'x' } }], responses: { list_agents: ok(TWINS) } },
  // update_grid, save_preset, deliver, help
  { name: 'update_grid', actor: 'lead', steps: [{ tool: 'update_grid', args: { gridId: 'g1', name: ' N ' } }, { tool: 'update_grid', args: { gridId: 'g1', color: '' } }, { tool: 'update_grid', args: { gridId: 'g1', color: '#AABBCC' } }, { tool: 'update_grid', args: { gridId: 'g1', color: null } }, { tool: 'update_grid', args: { name: 'x' } }],
    responses: { update_grid: [ok({ gridId: 'g1', name: 'N' }), fail('Invalid arguments - color: bad'), ok({ gridId: 'g1' }), ok({ gridId: 'g1' })] } },
  { name: 'save_preset', actor: 'lead', steps: [{ tool: 'save_preset', args: { name: 'P', cells: [{ profileId: 'codex' }], rows: [1] } }, { tool: 'save_preset', args: { name: 'P', cells: [] } }, { tool: 'save_preset', args: { id: 'pr1', name: 'P', cells: [{ profileId: 'codex', extra: 1 }] } }],
    responses: { save_preset: [ok({ id: 'pr9', name: 'P', cells: [] })] } },
  { name: 'deliver', actor: 'lead', steps: [{ tool: 'deliver', args: {} }, { tool: 'deliver', args: { taskId: 't', messageId: 'm' } }, { tool: 'deliver', args: { taskId: 't1' } }, { tool: 'deliver', args: { messageId: 'm1' } }, { tool: 'deliver', args: { taskId: '' } }],
    responses: { deliver_task: [ok({ delivery: 'pending', deliveryError: rep('d', 300), blockedBy: ['t0'] })], deliver_message: [ok({ delivery: 'native', blockedBy: [] })] } },
  { name: 'help', actor: 'w1', steps: [{ tool: 'help' }, { tool: 'help', args: { topic: 'grids' } }, { tool: 'help', args: { topic: 'limits' } }, { tool: 'help', args: { topic: 'nope' } }, { tool: 'help', args: { topic: 'snippets' } }], responses: {} },
  // roles, legacy names, unknown names
  { name: 'worker and coordinator-only tools', actor: 'w1', steps: [{ tool: 'snippets', args: {} }, { tool: 'deliver', args: { taskId: 't' } }, { tool: 'create_grid', args: { name: 'X', cells: [{ profileId: 'codex' }] } }, { tool: 'get_tasks', args: { limit: 5 } },
    { tool: 'close_grid', args: { gridId: 'g2' } }, { tool: 'create_task', args: { cellId: 'w1', title: 'x' } }, { tool: 'save_preset', args: { name: 'x' } }, { tool: 'update_grid', args: {} }],
    responses: { create_grid: fail('This operation requires the coordinator role: ask your coordinator (send_message) instead.'), get_tasks: fail('This operation requires the coordinator role: ask your coordinator (send_message) instead.'),
      close_grid: fail('This operation requires the coordinator role: ask your coordinator (send_message) instead.'), create_task: fail('x'), save_preset: fail('y'), update_grid: fail('z') } },
  { name: 'no role', actor: 'plain', steps: [{ tool: 'help', args: {} }, { tool: 'snippets', args: {} }, { tool: 'get_context', args: {} }, { tool: 'nope', args: {} }, { tool: 'read_inbox', args: { full: 'x' } }],
    responses: { get_context: fail('Agent MCP integration is disabled or the cell is no longer available.'), read_inbox: fail('never') } },
  { name: 'unknown cell', actor: 'ghost', steps: [{ tool: 'wait_for', args: {} }, { tool: 'help' }], responses: { wait_for: fail('Agent MCP integration is disabled or the cell is no longer available.') } },
  { name: 'legacy names', actor: 'lead', steps: [{ tool: 'list_library', args: {} }, { tool: 'get_snippet', args: { snippetId: 's1' } }, { tool: 'apply_snippet', args: { snippetId: 's1', cellId: 'w1' } }, { tool: 'save_snippet', args: { name: 'N', text: 'T', icon: 'i' } },
    { tool: 'add_agents', args: { gridId: 'g1', cells: [{ profileId: 'codex' }] } }, { tool: 'get_messages', args: {} }, { tool: 'acknowledge_message', args: { messageId: 'm3' } }, { tool: 'deliver_task', args: { taskId: 't1' } }, { tool: 'deliver_message', args: { messageId: 'm1' } },
    { tool: 'get_messages', args: { unreadOnly: 'x' } }, { tool: 'save_snippet', args: { name: '', text: '' } }, { tool: 'add_agents', args: { gridId: 'g1' } }, { tool: 'get_snippet' }],
    responses: { list_library: ok({ snippets: [], presets: [] }), get_snippet: ok({ id: 's1', name: 'One', text: 'Body' }), apply_snippet: ok(task({ id: 'x1' })), save_snippet: ok({ id: 'n', name: 'N' }), add_agents: ok({ gridId: 'g1', cellIds: ['q'] }),
      get_messages: ok([{ id: 'm3', text: 'z' }]), acknowledge_message: ok({ id: 'm3' }), deliver_task: ok({ delivery: 'native' }), deliver_message: ok({ delivery: 'native' }) } },
  { name: 'not callable names', actor: 'lead', steps: [{ tool: 'set_role', args: { cellId: 'w1', role: null } }, { tool: 'set_paused', args: { paused: true } }, { tool: 'mark_pasted', args: {} }, { tool: 'remove_items', args: {} },
    { tool: 'toString', args: {} }, { tool: '__proto__', args: {} }, { tool: 'constructor' }, { tool: '', args: {} }, { tool: 'GET_CONTEXT', args: {} }, { tool: 'get_context ', args: {} }], responses: {} },
];

/** Runs every scenario through callTool with a scripted service; the service validates like AutomationService.execute does first. */
export async function callRows({ callTool, describeError, automationSchemas, translate }) {
  const rows = [];
  const findCell = (state, id) => {
    for (const project of state.projects) for (const tab of project.tabs) { const cell = tab.cells.find((c) => c.id === id); if (cell) return { project, tab, cell }; }
    return null;
  };
  for (const scenario of SCENARIOS) {
    const state = expand(structuredClone(scenario.state ?? STATE));
    const responses = expand(structuredClone(scenario.responses ?? {}));
    const shown = new Map();
    const answers = scenario.elicit ? expand(structuredClone(scenario.elicit)) : undefined;
    const out = [];
    for (const step of scenario.steps) {
      const calls = [], elicits = [];
      const service = {
        state: { get: () => state },
        roleOf: (id) => scenario.roles?.[id] ?? findCell(state, id)?.cell.role ?? undefined,
        promptsShown: (id) => { let s = shown.get(id); if (!s) shown.set(id, (s = new Set())); return s; },
        async execute(op, input, actorId, signal) {
          calls.push({ op, args: JSON.stringify(compactLong(input)) ?? null, actor: actorId ?? null, signal: !!signal });
          automationSchemas[op].parse(input);
          const queue = responses[op];
          const r = Array.isArray(queue) ? queue.shift() : queue;
          if (r === undefined) throw new Error(`no fake answer for ${op}`);
          if (r.error !== undefined) throw new Error(r.error);
          return structuredClone(r.value);
        },
      };
      const ctx = {
        // A live signal, as the MCP server gives every call: the recorded calls show which ones get it (signal: true).
        service, actorId: scenario.actor, task: scenario.task === true, signal: new AbortController().signal,
        ...(scenario.language ? { tr: (key, params) => translate(scenario.language, key, params) } : {}),
        ...(answers ? { elicit: async (message, requestedSchema) => { elicits.push({ message, schema: requestedSchema }); return answers.shift() ?? { action: 'cancel' }; } } : {}),
      };
      const row = { tool: step.tool, args: step.args ?? null };
      try {
        const value = await callTool(step.tool, step.args === undefined ? undefined : expand(step.args), ctx);
        if (value === null) row.unknown = true;
        else row.result = JSON.stringify(compactLong(value)) ?? 'null';
      } catch (error) {
        row.error = describeError(error);
      }
      row.calls = calls;
      row.elicits = elicits;
      out.push(row);
    }
    rows.push({ scenario: scenario.name, actor: scenario.actor, task: scenario.task === true, language: scenario.language ?? null, roles: scenario.roles ?? null,
      elicit: scenario.elicit ?? null, responses: scenario.responses ?? {}, state: scenario.state ?? STATE, steps: out });
  }
  return rows;
}

export async function mcpGoldens(load) {
  const m = await load('scripts/goldens-mcp-entry.ts');
  return {
    tools: toolsGolden(m),
    zod: zodRows(m),
    calls: await callRows(m),
  };
}
