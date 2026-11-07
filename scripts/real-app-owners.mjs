// Which work package of docs/tauri/PLAN.md implements each window.mc channel, port and test-bridge op of the Tauri build
// (PLAN X1). The real-app scripts use it to say "blocked by <package>" when the check build answers MC_NOT_YET.
// test/real-app-owners.test.ts checks that every channel of src-tauri/gen/ipc-contract.json has an owner here and that every
// owner is a package of PLAN.md.

/** Channel -> package. Exact names first, then the prefix rules below. */
const EXACT = {
  // state and app (wave 0)
  'state:edit': 'F9', 'state:load': 'F9', 'state:snapshot': 'F9',
  'app:reportError': 'F5', 'app:startupMark': 'F11', 'app:claimStart': 'F11',
  'app:quitAnswer': 'W6', 'app:quitGuard': 'W6',
  // OS integration
  'attention:flash': 'W4', 'notify': 'W4', 'notify:show': 'W4', 'dialog:pickFolder': 'W4',
  'clipboard:read': 'W4', 'clipboard:write': 'W4', 'clipboard:writeSecret': 'W4',
  'shell:openExternal': 'W4', 'shell:openInEditor': 'W4', 'shell:openPath': 'W4', 'shell:revealPath': 'W4',
  'sound:beep': 'W4', 'sound:load': 'W4', 'sound:pick': 'W4',
  'alerts:testLimit': 'A5',
  // accounts
  'accounts:dismissNotice': 'A1', 'accounts:remove': 'A1', 'accounts:removeCodex': 'A1',
  'accounts:makeMain': 'A2', 'accounts:makeMainCodex': 'A2', 'accounts:swapPending': 'A2', 'accounts:clearSwapPending': 'A2', 'accounts:adoptCopy': 'A2',
  'accounts:acceptSwitch': 'A5', 'accounts:dismissSwitch': 'A5', 'accounts:switchBest': 'A5',
  'auth:start': 'A4', 'auth:cancel': 'A4',
  'usage:get': 'A5', 'usage:refresh': 'A5',
  // agents
  'agents:prompt': 'H6', 'agents:prompt:done': 'H6',
  'cli:status': 'H3', 'cli:recheck': 'H3', 'cli:openDocs': 'H3',
  'codex:bind': 'H4', 'context:get': 'H4', 'sessions:list': 'H4',
  'conv:search': 'H5', 'conv:transcript': 'H5', 'conv:export': 'H5',
  'install:start': 'H6', 'install:cancel': 'H6', 'install:current': 'H6', 'install:options': 'H6',
  // MCP and automation
  'mcp:info': 'M1', 'mcp:retry': 'M1', 'automation:execute': 'M3',
  // terminals
  'cell:spawn': 'P4', 'cell:kill': 'P3', 'cell:killAndWait': 'P3', 'cell:alive': 'P3', 'cell:runtime': 'P3',
  // files
  'fs:listProjectDirectory': 'G5', 'fs:listProjectDirectories': 'G5', 'fs:listProjectDirectoryBatch': 'G5',
  'fs:readProjectFile': 'G5', 'fs:statProjectFile': 'G5', 'fs:writeProjectFile': 'G5',
  'fs:createEntry': 'G6', 'fs:deleteEntries': 'G6', 'fs:renameEntry': 'G6', 'fs:transfer': 'G6', 'fs:cancelOp': 'G6',
  'fs:searchProject': 'G7', 'fs:replaceInProject': 'G7',
  'fs:exists': 'G8', 'fs:pathKinds': 'G8', 'changelog:get': 'G8', 'monitor:sample': 'G8', 'monitor:kill': 'G8',
  'notes:export': 'G8', 'notes:image:read': 'G8', 'notes:image:save': 'G8',
  // git and GitHub
  'git:trust': 'G2', 'git:trustGrant': 'G2', 'git:trustRevoke': 'G2',
  'git:createWorktree': 'G4', 'git:inspectWorktree': 'G4', 'git:removeWorktree': 'G4', 'git:worktrees': 'G4',
  'git:clone': 'G4', 'git:init': 'G4', 'git:installGit': 'G4',
  'github:publish': 'G3',
  // SFTP
  'sftp:list': 'T2', 'sftp:realpath': 'T2', 'sftp:stat': 'T2', 'sftp:mkdir': 'T2', 'sftp:rename': 'T2',
  'sftp:enqueue': 'T3', 'sftp:answerConflict': 'T3', 'sftp:cancel': 'T3', 'sftp:retry': 'T3', 'sftp:clearFinished': 'T3',
  'sftp:delete': 'T4', 'sftp:deleteCount': 'T4', 'sftp:chmod': 'T4', 'sftp:chmodCount': 'T4',
  'sftp:readFile': 'T4', 'sftp:statFile': 'T4', 'sftp:writeFile': 'T4',
  // SSH
  'ssh:history:list': 'S1', 'ssh:history:record': 'S1', 'ssh:history:clear': 'S1', 'ssh:history:status': 'S1',
  'ssh:knownHosts:list': 'S1', 'ssh:knownHosts:remove': 'S1', 'ssh:vault:info': 'S1', 'ssh:storage:status': 'S1',
  'ssh:connect': 'S3', 'ssh:prompt:answer': 'S3', 'ssh:sessions': 'S3',
  // databases
  'db:pg': 'D5', 'db:redis': 'D9',
  // windows
  'detach:wait': 'W5', 'detach:waits': 'W5', 'detach:waitStep': 'W5',
  // updates
  'update:get': 'U1', 'update:check': 'U1', 'update:install': 'U1', 'update:open': 'U1', 'update:busy': 'U1',
};

/** Prefix rules, longest first: the rest of a domain. */
const PREFIXES = [
  ['git:', 'G3'], ['github:', 'A6'], ['sftp:', 'T1'], ['ssh:key:', 'S2'], ['ssh:', 'S4'], ['db:', 'D1'], ['local:', 'G6'],
  ['detach:', 'W5'], ['accounts:', 'A2'],
];

/** Ports of the bridge (`port:<kind>`, mc_port_attach) and the events the check build cannot emit yet. */
const PORTS = { 'port:pty': 'P2', 'port:sftp': 'T1', 'port:db': 'D12' };

/**
 * Test-bridge ops of the harness that a later package adds (an older check build answers "unknown op"): the fake toast sink
 * of the notifications (W4), the taskbar view (W7).
 */
export const BRIDGE_OP_OWNERS = { toasts: 'W4', toastAction: 'W4', taskbar: 'W7' };

/** The package that implements `command` (a channel, `port:<kind>`, `update-splash:*`), or null when nothing claims it. */
export function ownerOf(command) {
  if (EXACT[command]) return EXACT[command];
  if (PORTS[command]) return PORTS[command];
  if (command.startsWith('update-splash:')) return 'U1';
  for (const [prefix, owner] of PREFIXES) if (command.startsWith(prefix)) return owner;
  return null;
}

/** "W4 (notify, attention:flash), P4 (cell:spawn)": the packages a list of not-yet commands waits for, in PLAN order. */
export function blockedBy(commands) {
  const byOwner = new Map();
  for (const command of commands) {
    const owner = ownerOf(command) ?? `unowned`;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(command);
  }
  return [...byOwner.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([owner, list]) => ({ owner, commands: list }));
}

export const formatBlocked = (groups) => groups.map((g) => `${g.owner} (${g.commands.join(', ')})`).join(', ');
