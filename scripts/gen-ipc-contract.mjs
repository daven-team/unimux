// Generates src-tauri/gen/ipc-contract.json, the window.mc contract the Rust router is checked against (1.2.0, PLAN F3).
//
// Sources, read with a real TypeScript parser (rolldown's oxc parser; TypeScript 7 has no JS compiler API):
// - src/renderer/src/bridge/mcApi.ts: every method of window.mc and the channel it calls (`t.invoke('x', ...)` /
//   `t.send('x', ...)`);
// - src/renderer/src/bridge/api.d.ts (+ the *Api interfaces in src/shared): parameter names, TypeScript types, return types,
//   and the push events (the `on(channel: 'x', cb: (...) => void)` overloads);
// - test/contract/preload-channels.json: what the removed Electron preloads contributed (frozen at R1): the MessagePorts and
//   the separate window.updateSplash contract of the update windows.
//
// `--check` regenerates in memory and exits 1 when the committed file differs (CI drift check).
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'src-tauri/gen/ipc-contract.json');
const OUT_TS = resolve(root, 'src/renderer/src/bridge/contract.gen.ts');
const MC_API_FILE = 'src/renderer/src/bridge/mcApi.ts';
const API_FILE = 'src/renderer/src/bridge/api.d.ts';
const FROZEN_FILE = 'test/contract/preload-channels.json';
const frozen = JSON.parse(readFileSync(resolve(root, FROZEN_FILE), 'utf8'));

/** The domain (= the `unimux-app/src/commands/<domain>.rs` file that registers it) of a channel or event. */
export function domainOf(channel) {
  const prefix = channel.split(':')[0];
  const table = {
    state: 'state',
    app: 'app',
    window: 'window',
    detach: 'window',
    waiting: 'window',
    'focus-cell': 'pty',
    cell: 'pty',
    ptyhost: 'pty',
    mcp: 'mcp',
    automation: 'mcp',
    agents: 'agents',
    cli: 'agents',
    install: 'agents',
    codex: 'agents',
    context: 'agents',
    sessions: 'agents',
    conv: 'agents',
    fs: 'files',
    local: 'files',
    notes: 'files',
    monitor: 'files',
    changelog: 'files',
    git: 'git',
    github: 'github',
    ssh: 'ssh',
    sftp: 'sftp',
    db: 'db',
    update: 'update',
    usage: 'accounts',
    auth: 'accounts',
    accounts: 'accounts',
    dialog: 'os',
    sound: 'os',
    notify: 'os',
    alerts: 'os',
    attention: 'os',
    shell: 'os',
    clipboard: 'os',
  };
  const domain = table[prefix];
  if (!domain) throw new Error(`gen-ipc-contract: no domain for channel "${channel}" (add its prefix to domainOf)`);
  return domain;
}

const read = (file) => readFileSync(resolve(root, file), 'utf8');
const parse = (file) => {
  const source = read(file);
  return { source, ast: parseAst(source, { lang: 'ts' }, file) };
};
const text = (source, node) => (node ? source.slice(node.start, node.end).replace(/\s+/g, ' ').trim() : null);
const keyName = (key) => key?.name ?? key?.value;

// ── interfaces: McApi and the *Api interfaces it references ────────────────

/** Every `interface X` / `type X = {...}` in a file, with its source. */
function collectInterfaces(file, into) {
  const { source, ast } = parse(file);
  const visit = (node) => {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (decl?.type === 'TSInterfaceDeclaration') into.set(decl.id.name, { source, members: decl.body.body, file });
    if (decl?.type === 'TSTypeAliasDeclaration' && decl.typeAnnotation.type === 'TSTypeLiteral') into.set(decl.id.name, { source, members: decl.typeAnnotation.members, file });
  };
  for (const node of ast.body) visit(node);
}

const interfaces = new Map();
collectInterfaces(API_FILE, interfaces);
for (const name of readdirSync(resolve(root, 'src/shared'))) if (name.endsWith('.ts')) collectInterfaces(join('src/shared', name), interfaces);

function paramInfo(source, param) {
  const node = param.type === 'TSParameterProperty' ? param.parameter : param;
  const id = node.type === 'AssignmentPattern' ? node.left : node.type === 'RestElement' ? node.argument : node;
  return { name: id.name ?? text(source, id), type: text(source, id.typeAnnotation?.typeAnnotation ?? node.typeAnnotation?.typeAnnotation), optional: !!id.optional || node.type === 'AssignmentPattern', ...(node.type === 'RestElement' ? { rest: true } : {}) };
}

/** Signatures of the members of an interface, nested object types flattened to dotted paths. */
function signatures(iface, prefix, out, events) {
  const { source, members } = iface;
  for (const m of members) {
    const name = keyName(m.key);
    if (!name) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (m.type === 'TSMethodSignature') {
      const params = m.params.map((p) => paramInfo(source, p));
      if (name === 'on' && !prefix && m.params[0]?.typeAnnotation?.typeAnnotation?.type === 'TSLiteralType') {
        const channel = m.params[0].typeAnnotation.typeAnnotation.literal.value;
        const cb = m.params[1]?.typeAnnotation?.typeAnnotation;
        events.push({ name: channel, domain: domainOf(channel), params: cb?.params ? cb.params.map((p) => paramInfo(source, p)) : [] });
        continue;
      }
      out.set(path, { params, returns: text(source, m.returnType?.typeAnnotation) });
    } else if (m.type === 'TSPropertySignature') {
      const t = m.typeAnnotation?.typeAnnotation;
      if (t?.type === 'TSTypeLiteral') signatures({ source, members: t.members }, path, out, events);
      else if (t?.type === 'TSTypeReference' && interfaces.has(t.typeName.name) && /Api$/.test(t.typeName.name)) signatures(interfaces.get(t.typeName.name), path, out, events);
      else if (t?.type === 'TSFunctionType') out.set(path, { params: t.params.map((p) => paramInfo(source, p)), returns: text(source, t.returnType?.typeAnnotation) });
      else out.set(path, { value: text(source, t) });
    }
  }
}

// ── mcApi.ts: the channel of every method ───────────────────────────────────

function implementation() {
  const { source, ast } = parse(MC_API_FILE);
  const fn = ast.body.map((n) => (n.type === 'ExportNamedDeclaration' ? n.declaration : n)).find((n) => n?.type === 'FunctionDeclaration' && n.id.name === 'createMcApi');
  const ret = fn.body.body.find((s) => s.type === 'ReturnStatement').argument;
  const methods = [];
  const walk = (object, prefix) => {
    for (const prop of object.properties) {
      const name = keyName(prop.key);
      const path = prefix ? `${prefix}.${name}` : name;
      const value = prop.value;
      if (value.type === 'ObjectExpression') { walk(value, path); continue; }
      if (value.type !== 'ArrowFunctionExpression') { methods.push({ path, kind: 'sync' }); continue; }
      const calls = [];
      const find = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(find); return; }
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.name === 't') calls.push(node);
        for (const k of Object.keys(node)) if (k !== 'start' && k !== 'end') find(node[k]);
      };
      find(value.body);
      const call = calls[0];
      const method = call?.callee.property.name;
      const params = value.params.map((p) => (p.type === 'AssignmentPattern' ? p.left.name : p.name));
      if (method === 'invoke' || method === 'send') {
        const channel = call.arguments[0].value;
        methods.push({ path, kind: method, channel, domain: domainOf(channel), params, shaping: text(source, value.body) });
      } else if (method === 'on') methods.push({ path, kind: 'event-subscribe' });
      else methods.push({ path, kind: 'sync', params });
    }
  };
  walk(ret, '');
  return methods;
}

/** window.updateSplash of the update windows, as 1.1.4's src/updatesplash/preload.ts exposed it (frozen at R1). */
function updateSplash() {
  return frozen.updateSplash.map(({ channel, kind }) => ({ channel, kind }));
}

export function buildContract() {
  const sigs = new Map();
  const events = [];
  signatures(interfaces.get('McApi'), '', sigs, events);
  const impl = implementation();
  const methods = impl.filter((m) => m.kind !== 'event-subscribe').map((m) => {
    const sig = sigs.get(m.path);
    if (!sig) throw new Error(`gen-ipc-contract: ${m.path} is in mcApi.ts but not in api.d.ts`);
    return { path: m.path, kind: m.kind, ...(m.channel ? { channel: m.channel, domain: m.domain } : {}), params: sig.params ?? [], returns: sig.returns ?? sig.value ?? null, ...(m.shaping ? { call: m.shaping } : {}) };
  });
  for (const path of sigs.keys()) if (!impl.some((m) => m.path === path)) throw new Error(`gen-ipc-contract: ${path} is in api.d.ts but not in mcApi.ts`);
  const channels = {};
  for (const m of methods) {
    if (!m.channel) continue;
    const prev = channels[m.channel];
    if (prev && prev.kind !== m.kind) throw new Error(`gen-ipc-contract: ${m.channel} is used as ${prev.kind} and ${m.kind}`);
    channels[m.channel] = prev ? { ...prev, methods: [...prev.methods, m.path] } : { kind: m.kind, domain: m.domain, methods: [m.path] };
  }
  const sorted = Object.fromEntries(Object.entries(channels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const count = (kind) => methods.filter((m) => m.kind === kind).length;
  return {
    generatedBy: 'scripts/gen-ipc-contract.mjs',
    sources: [MC_API_FILE, API_FILE, FROZEN_FILE],
    summary: { methods: methods.length, invokeMethods: count('invoke'), sendMethods: count('send'), syncMembers: count('sync'), channels: Object.keys(sorted).length, invokeChannels: Object.values(sorted).filter((c) => c.kind === 'invoke').length, sendChannels: Object.values(sorted).filter((c) => c.kind === 'send').length, events: events.length },
    ports: frozen.ports.map((p) => p.page),
    channels: sorted,
    events,
    methods,
    updateSplash: updateSplash(),
  };
}

export const contractText = (contract) => `${JSON.stringify(contract, null, 1)}\n`;

/** The renderer's generated part of the bridge: the channel kinds and, per event, the arguments api.d.ts marks optional. */
export function contractTs(contract) {
  const optional = Object.fromEntries(contract.events.map((e) => [e.name, e.params.flatMap((p, i) => (p.optional ? [i] : []))]).filter(([, list]) => list.length));
  const kinds = Object.fromEntries(Object.entries(contract.channels).map(([name, c]) => [name, c.kind]));
  return [
    `// Generated by scripts/gen-ipc-contract.mjs from ${API_FILE} and ${MC_API_FILE}. Do not edit.`,
    `export const CHANNEL_KINDS: Readonly<Record<string, 'invoke' | 'send'>> = ${JSON.stringify(kinds, null, 2)};`,
    '/** Positions of the arguments an event callback declares optional: a null from Rust becomes undefined there. */',
    `export const EVENT_OPTIONAL_ARGS: Readonly<Record<string, readonly number[]>> = ${JSON.stringify(optional, null, 2)};`,
    `export const EVENTS: readonly string[] = ${JSON.stringify(contract.events.map((e) => e.name), null, 2)};`,
    '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contract = buildContract();
  const outputs = [[OUT, contractText(contract)], [OUT_TS, contractTs(contract)]];
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([file, text]) => {
      try { return readFileSync(file, 'utf8') !== text; } catch { return true; }
    });
    if (stale.length) {
      console.error(`${stale.map(([file]) => file).join(', ')} out of date: run \`npm run gen:contract\`.`);
      process.exit(1);
    }
    console.log(`ipc contract up to date (${JSON.stringify(contract.summary)})`);
  } else {
    for (const [file, text] of outputs) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    console.log(`wrote ${OUT} and ${OUT_TS}: ${JSON.stringify(contract.summary)}`);
  }
}
